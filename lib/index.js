// dsh-cost-balance — Host half
// 会话花费计算 + DeepSeek 账户余额抓取，经 webServer 路由提供给客户端。
//
// 花费 = 会话累计 token × 模型单价。token 桶由客户端从 tokenUsage 投影读取后随请求传入；
// 余额走 DeepSeek 官方 /user/balance 接口，API Key 通过官方凭据服务（DEEPSEEK_API_KEY）解析。

export const name = 'dsh-cost-balance'

// webServer 行声明了 inject: [webStartup]，其注册是异步的；声明硬依赖让本插件
// 等待服务出现后再 apply，避免启动时序下取不到路由注册点。
export const inject = ['webServer']

// 官方定价（人民币元 / 1M tokens，中文站口径）。
// 来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing
// 注：DeepSeek 于北京时间 2026-08-17 00:00 起切换峰谷计费：
// 高峰（9-12、14-18 时）按下方价格，空闲时段为高峰一半；生效前用旧价格表。
// 可在 profile 的 cordis.patch.yml 里用 config.prices 覆盖（新表口径），无需改代码。
const DEFAULT_PRICES = {
  'deepseek-v4-flash': { cacheHit: 0.02, cacheMiss: 1, output: 2 },
  'deepseek-v4-pro': { cacheHit: 0.025, cacheMiss: 3, output: 6 },
}
// 2026-08-17 起的高峰价格（空闲 = 高峰 × 0.5）
const PEAK_PRICES = {
  'deepseek-v4-flash': { cacheHit: 0.10, cacheMiss: 3.0, output: 9.0 },
  'deepseek-v4-pro': { cacheHit: 0.30, cacheMiss: 9.0, output: 27.0 },
}
const PEAK_CHANGE_AT_BEIJING = Date.UTC(2026, 7, 17, 0, 0, 0) // 2026-08-17 00:00 北京时间

const BALANCE_URL = 'https://api.deepseek.com/user/balance'

function sendJson(res, code, value) {
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

export function apply(ctx, config = {}) {
  const basePrices = { ...DEFAULT_PRICES, ...(config.prices ?? {}) }
  // 峰谷切换后生效的高峰价表：默认取官方 PEAK_PRICES，config.prices 覆盖（新表口径）同样适用
  const peakPrices = { ...PEAK_PRICES, ...(config.prices ?? {}) }
  let balanceCache = null
  let failureAt = 0

  /** 按当前北京时间返回生效价格：峰谷切换前用旧表，切换后高峰取 peakPrices、空闲取其半价。 */
  const priceOf = (model) => {
    const beijingNow = Date.now() + 8 * 3600e3
    const table = beijingNow < PEAK_CHANGE_AT_BEIJING ? basePrices : peakPrices
    const p = table[model] ?? table['deepseek-v4-flash']
    const hour = new Date(beijingNow).getUTCHours()
    const peak = (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
    if (beijingNow < PEAK_CHANGE_AT_BEIJING || peak) return p
    return { cacheHit: p.cacheHit / 2, cacheMiss: p.cacheMiss / 2, output: p.output / 2 }
  }

  const computeCost = (usage) => {
    const model = ctx.get('agentDefaultModel')?.currentSelection()?.model || 'deepseek-v4-flash'
    const p = priceOf(model)
    const perMillion = (n, price) => (Math.max(0, Number(n) || 0) / 1e6) * price
    const cost = perMillion(usage.uncached, p.cacheMiss)
      + perMillion(usage.cacheRead, p.cacheHit)
      + perMillion(usage.cacheWrite, p.cacheMiss)
      + perMillion(usage.output, p.output)
    return { cost, model }
  }

  const fetchBalance = async (force = false) => {
    const now = Date.now()
    if (!force && balanceCache !== null && now - balanceCache.at < 60000) return balanceCache.data
    if (now - failureAt < 30000) return { available: false, reason: 'throttled' }
    try {
      const credentials = ctx.get('credentials')
      if (credentials === undefined) return { available: false, reason: 'no-credentials-service' }
      const hit = await credentials.resolve('DEEPSEEK_API_KEY')
      if (hit === undefined) return { available: false, reason: 'no-api-key' }
      const shell = ctx.get('shell')
      if (shell === undefined) return { available: false, reason: 'no-shell-service' }
      const result = await shell.run(shell.resolve({
        command: 'curl.exe -sS --max-time 15 -H "Authorization: Bearer $env:DSH_CB_KEY" "' + BALANCE_URL + '"',
        env: { DSH_CB_KEY: hit.value },
        timeoutMs: 20000,
        // Windows 上 ACL 沙箱因 temp 位于 workspace（用户主目录）内而无法启动；
        // 余额查询只访问 DeepSeek 官方接口，按错误指引切到不加壳模式。
        sandboxPolicy: { mode: 'danger-full-access' },
      }))
      if (result.exitCode !== 0) throw new Error('curl exit ' + result.exitCode)
      const parsed = JSON.parse(result.stdout.text)
      const info = parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.balance_infos)
        ? parsed.balance_infos[0]
        : undefined
      if (info === undefined) throw new Error('unexpected balance response')
      const data = {
        available: true,
        balance: String(info.total_balance),
        currency: String(info.currency),
      }
      balanceCache = { at: now, data }
      return data
    } catch (error) {
      failureAt = Date.now()
      console.error('[dsh-cost-balance] balance fetch failed', error)
      return { available: false, reason: 'error', message: String((error && error.message) || error) }
    }
  }

  const webServer = ctx.get('webServer')
  if (webServer === undefined) return

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/cost-balance',
    handler: async (req, res) => {
      let usage = { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
      let force = false
      try {
        const url = new URL(req.url ?? '/', 'http://x')
        usage = {
          uncached: Number(url.searchParams.get('uncached') ?? 0),
          cacheRead: Number(url.searchParams.get('cacheRead') ?? 0),
          cacheWrite: Number(url.searchParams.get('cacheWrite') ?? 0),
          output: Number(url.searchParams.get('output') ?? 0),
        }
        force = url.searchParams.get('force') === '1'
      } catch {
        // 参数缺省按全零处理
      }
      const { cost, model } = computeCost(usage)
      const balance = await fetchBalance(force)
      sendJson(res, 200, { cost, model, balance })
    },
  }))
}
