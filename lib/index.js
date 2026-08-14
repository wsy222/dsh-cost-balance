// dsh-cost-balance — Host half
// 会话花费计算 + DeepSeek 账户余额抓取，经 webServer 路由提供给客户端。
//
// 花费 = 会话累计 token × 模型单价。token 桶由客户端从 tokenUsage 投影读取后随请求传入；
// 余额走 DeepSeek 官方 /user/balance 接口，API Key 通过官方凭据服务（DEEPSEEK_API_KEY）解析。

export const name = 'dsh-cost-balance'

// webServer 行声明了 inject: [webStartup]，其注册是异步的；声明硬依赖让本插件
// 等待服务出现后再 apply，避免启动时序下取不到路由注册点。
export const inject = ['webServer']

// 官方定价（USD / 1M tokens）。来源：https://api-docs.deepseek.com/quick_start/pricing
// 注：DeepSeek 于 2026-08-16 16:00 UTC 起切换峰谷计费（off-peak 为 peak 一半），届时可在
// profile 的 cordis.patch.yml 里用 config.prices 覆盖，无需改代码。
const DEFAULT_PRICES = {
  'deepseek-v4-flash': { cacheHit: 0.0028, cacheMiss: 0.14, output: 0.28 },
  'deepseek-v4-pro': { cacheHit: 0.003625, cacheMiss: 0.435, output: 0.87 },
}

const BALANCE_URL = 'https://api.deepseek.com/user/balance'

function sendJson(res, code, value) {
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

export function apply(ctx, config = {}) {
  const prices = { ...DEFAULT_PRICES, ...(config.prices ?? {}) }
  let balanceCache = null
  let failureAt = 0

  const computeCost = (usage) => {
    const model = ctx.get('agentDefaultModel')?.currentSelection()?.model || 'deepseek-v4-flash'
    const p = prices[model] ?? prices['deepseek-v4-flash']
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
        command: 'curl -sS --max-time 15 -H "Authorization: Bearer $DSH_CB_KEY" "' + BALANCE_URL + '"',
        env: { DSH_CB_KEY: hit.value },
        timeoutMs: 20000,
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
