// dsh-cost-balance — Host half
// 会话花费计算 + DeepSeek 账户余额抓取，经 webServer 路由提供给客户端。
//
// 花费口径（从准到粗，自动回退）：
//   ① 权威：按 sessionId 读完整会话日志（ctx.sessionQuery），每个 assistant/message 事件
//      按其自身发生时刻的峰谷价逐笔计费 —— 客户端看不到的步骤在这里也能算到。
//   ② 回退：客户端随请求送来的逐笔 steps（聊天树已物化的那部分）。
//   ③ 兜底：只有聚合 usage 时，全部 token 按当前时刻价计。
// 余额走 DeepSeek 官方 /user/balance 接口，API Key 通过官方凭据服务（DEEPSEEK_API_KEY）解析。

export const name = 'dsh-cost-balance'

// webServer 行声明了 inject: [webStartup]，其注册是异步的；声明硬依赖让本插件
// 等待服务出现后再 apply，避免启动时序下取不到路由注册点。
// ⚠️ inject 只接受「服务名字符串」数组；sessionQuery 是可选服务，只能按需 ctx.get() 探测。
// 曾误写成 { required: [...], optional: [...] } 对象元素 —— Cordis 会把对象当作服务名，
// 插件永久 pending（waiting for service: [object Object]），导致整个 profile 启动失败。
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
// 2026-08-23 00:00 北京时间起：周末（周六/周日）全天不再区分峰谷，统一按低谷价（高峰半价）收取
// 来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/ 脚注(1)
const WEEKEND_OFFPEAK_AT_BEIJING = Date.UTC(2026, 7, 23, 0, 0, 0)
// 2026-09-10 12:00 北京时间起 flash 系列调价（官方平台公告，降幅最高 60%）：
// 空闲时段 缓存命中 0.02 / 未命中 1 / 输出 4（元/1M tokens），高峰为空闲的 2 倍 → 0.04 / 2 / 8。
// 注：下列常量与 priceOf 的 beijingNow（Date.now() + 8h）同坐标系，直接写北京墙上时刻。
const FLASH_REPRICE_AT_BEIJING = Date.UTC(2026, 8, 10, 12, 0, 0)
const FLASH_PEAK_PRICES_V2 = { cacheHit: 0.04, cacheMiss: 2.0, output: 8.0 }
// 2026-09-14 12:00 北京时间起 V4 Pro 下线：请求路由至 V4.1 Flash，按 Flash 计费。
const PRO_RETIRE_AT_BEIJING = Date.UTC(2026, 8, 14, 12, 0, 0)

const BALANCE_URL = 'https://api.deepseek.com/user/balance'
// 会话日志读取结果的短缓存：统计条每 60 秒刷一次，4 秒 TTL 足以吸收同页多标签页的并发请求。
const LOG_COST_TTL_MS = 4000

function sendJson(res, code, value) {
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

export function apply(ctx, config = {}) {
  const userPrices = config.prices ?? {}
  const basePrices = { ...DEFAULT_PRICES, ...userPrices }
  let balanceCache = null
  let failureAt = 0
  const logCostCache = new Map()

  /** 按北京时间返回该时刻生效的高峰价表：8-17 表为基线；9-10 12:00 起 flash 系列换新价；
   *  9-14 12:00 起 V4 Pro 下线，按 Flash 计费。config.prices 覆盖优先级最高（显式配置压过时间表）。 */
  const peakTableAt = (beijingNow) => {
    const table = { ...PEAK_PRICES }
    if (beijingNow >= FLASH_REPRICE_AT_BEIJING) {
      table['deepseek-v4-flash'] = FLASH_PEAK_PRICES_V2
      table['deepseek-v4-flash-vision-exp'] = FLASH_PEAK_PRICES_V2
    }
    if (beijingNow >= PRO_RETIRE_AT_BEIJING) table['deepseek-v4-pro'] = FLASH_PEAK_PRICES_V2
    return { ...table, ...userPrices }
  }

  /** 按给定时刻（epoch ms）返回生效价格与价格段：峰谷切换前 flat（无峰谷概念）；
   *  切换后高峰 peak、空闲 offpeak（谷）；2026-08-23 起周末全天 offpeak。 */
  const priceAt = (model, atMs) => {
    const beijingNow = atMs + 8 * 3600e3
    if (beijingNow < PEAK_CHANGE_AT_BEIJING) {
      return { price: basePrices[model] ?? basePrices['deepseek-v4-flash'], band: 'flat' }
    }
    const table = peakTableAt(beijingNow)
    const p = table[model] ?? table['deepseek-v4-flash']
    const half = { cacheHit: p.cacheHit / 2, cacheMiss: p.cacheMiss / 2, output: p.output / 2 }
    const d = new Date(beijingNow)
    const hour = d.getUTCHours()
    const weekendOffpeak = beijingNow >= WEEKEND_OFFPEAK_AT_BEIJING && (d.getUTCDay() === 0 || d.getUTCDay() === 6)
    if (weekendOffpeak) return { price: half, band: 'offpeak' }
    const peak = (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
    if (peak) return { price: p, band: 'peak' }
    return { price: half, band: 'offpeak' }
  }

  const defaultModel = () => ctx.get('agentDefaultModel')?.currentSelection()?.model || 'deepseek-v4-flash'

  const num = (v) => Math.max(0, Number(v) || 0)

  /** 单笔 token 花费：按该笔发生时刻的价计（历史花费不随当前时段漂移）。 */
  const tokenCost = (model, atMs, tok) => {
    const { price } = priceAt(model, atMs)
    const perMillion = (n, p) => (num(n) / 1e6) * p
    return perMillion(tok.uncached, price.cacheMiss)
      + perMillion(tok.cacheRead, price.cacheHit)
      + perMillion(tok.cacheWrite, price.cacheMiss)
      + perMillion(tok.output, price.output)
  }

  /** 聚合回退（无逐笔数据时）：全部 token 按当前时刻价计。 */
  const computeCost = (usage) => {
    const model = defaultModel()
    const now = Date.now()
    return { cost: tokenCost(model, now, usage), model, band: priceAt(model, now).band }
  }

  /** 逐笔计价：每笔按发生时刻价累加；投影与逐笔的差额（进行中的 step）按当前时刻价补算。
   *  steps 元素形如 [atMs, uncached, cacheRead, cacheWrite, output, model]。 */
  const computeFromSteps = (steps, usage) => {
    const model = defaultModel()
    const now = Date.now()
    let cost = 0
    const sum = { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
    for (const s of steps) {
      if (!Array.isArray(s)) continue
      const at = Number(s[0]) || now
      const tok = { uncached: num(s[1]), cacheRead: num(s[2]), cacheWrite: num(s[3]), output: num(s[4]) }
      const m = typeof s[5] === 'string' && s[5].length > 0 ? s[5] : model
      cost += tokenCost(m, at, tok)
      sum.uncached += tok.uncached
      sum.cacheRead += tok.cacheRead
      sum.cacheWrite += tok.cacheWrite
      sum.output += tok.output
    }
    if (usage !== void 0) {
      const rest = {
        uncached: Math.max(0, num(usage.uncached) - sum.uncached),
        cacheRead: Math.max(0, num(usage.cacheRead) - sum.cacheRead),
        cacheWrite: Math.max(0, num(usage.cacheWrite) - sum.cacheWrite),
        output: Math.max(0, num(usage.output) - sum.output),
      }
      if (rest.uncached + rest.cacheRead + rest.cacheWrite + rest.output > 0) cost += tokenCost(model, now, rest)
    }
    return { cost, model, band: priceAt(model, now).band }
  }

  /** 从会话事件里取出逐笔 usage：每个 assistant/message 事件即一步，时间取事件自身时刻。 */
  const stepsFromEvents = (events, model) => {
    const steps = []
    for (const event of events ?? []) {
      if (event === null || typeof event !== 'object' || event.type !== 'assistant/message') continue
      const usage = event.data?.usage
      if (usage === null || typeof usage !== 'object') continue
      const tok = {
        uncached: num(usage.uncachedInputTokens ?? usage.inputTokens),
        cacheRead: num(usage.cacheReadTokens),
        cacheWrite: num(usage.cacheWriteTokens),
        output: num(usage.outputTokens),
      }
      if (tok.uncached + tok.cacheRead + tok.cacheWrite + tok.output <= 0) continue
      const source = event.data?.message?.source
      const m = typeof source?.model === 'string' && source.model.length > 0 ? source.model : model
      steps.push([Number(event.time) || Date.now(), tok.uncached, tok.cacheRead, tok.cacheWrite, tok.output, m])
    }
    return steps
  }

  /** 权威计价：按 sessionId 读完整会话日志逐笔计费。
   *  长会话（数百步）在客户端聊天树里往往只物化了一部分节点；仅靠客户端 steps 会把大量历史
   *  token 挤进"差额"并按当前时刻价计（实测 361 步会话只送到 49 步、79.6M cacheRead 中 87%
   *  无时间戳，界面因此稳定少报约 45%）。读日志可彻底避免。
   *  无 sessionQuery 服务（老版本 DSH）或读取失败时返回 void，由调用方回退。 */
  const sessionLogCost = async (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return void 0
    const now = Date.now()
    const hit = logCostCache.get(sessionId)
    if (hit !== void 0 && now - hit.at < LOG_COST_TTL_MS) return hit.value
    const query = ctx.get('sessionQuery')
    if (query === void 0 || typeof query.readSession !== 'function') return void 0
    try {
      const snapshot = await query.readSession(sessionId)
      const steps = stepsFromEvents(snapshot?.events, defaultModel())
      const value = steps.length === 0 ? void 0 : computeFromSteps(steps)
      logCostCache.set(sessionId, { at: now, value })
      return value
    } catch (error) {
      console.error('[dsh-cost-balance] session log read failed', sessionId, String((error && error.message) || error))
      logCostCache.set(sessionId, { at: now, value: void 0 })
      return void 0
    }
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
      let usageProvided = false
      let steps
      let sessionId
      let force = false
      const method = String(req.method ?? 'GET').toUpperCase()
      const readUsage = (src) => ({
        uncached: num(src.uncached ?? src.uncachedInputTokens),
        cacheRead: num(src.cacheRead ?? src.cacheReadTokens),
        cacheWrite: num(src.cacheWrite ?? src.cacheWriteTokens),
        output: num(src.output ?? src.outputTokens),
      })
      try {
        const url = new URL(req.url ?? '/', 'http://x')
        force = url.searchParams.get('force') === '1'
      } catch {
        // URL 异常按无参处理
      }
      if (method === 'POST') {
        // 逐笔数据：{ sessionId?, steps: [[atMs, uncached, cacheRead, cacheWrite, output, model], ...], usage: {...} }
        let raw = ''
        try {
          for await (const chunk of req) {
            raw += chunk
            if (raw.length > 4e6) break
          }
          const body = raw === '' ? {} : JSON.parse(raw)
          if (Array.isArray(body.steps)) steps = body.steps
          if (typeof body.sessionId === 'string' && body.sessionId.length > 0) sessionId = body.sessionId
          if (body.usage !== void 0 && body.usage !== null) {
            usage = readUsage(body.usage)
            usageProvided = true
          }
          if (body.force === true) force = true
        } catch (error) {
          console.error('[dsh-cost-balance] bad POST body', error)
        }
      } else {
        try {
          const url = new URL(req.url ?? '/', 'http://x')
          usage = readUsage({
            uncached: url.searchParams.get('uncached') ?? 0,
            cacheRead: url.searchParams.get('cacheRead') ?? 0,
            cacheWrite: url.searchParams.get('cacheWrite') ?? 0,
            output: url.searchParams.get('output') ?? 0,
          })
          usageProvided = url.searchParams.has('output') || url.searchParams.has('uncached')
        } catch {
          // 参数缺省按全零处理
        }
      }
      // 口径优先级：会话日志（权威）→ 客户端逐笔 → 客户端聚合。
      const fromClient = steps !== void 0 && steps.length > 0
        ? computeFromSteps(steps, usageProvided ? usage : void 0)
        : computeCost(usage)
      const authoritative = await sessionLogCost(sessionId)
      const result = authoritative ?? fromClient
      // source 让界面能标注口径：session-log=权威；client-* = 回退估算。
      const source = authoritative === void 0
        ? (steps !== void 0 && steps.length > 0 ? 'client-steps' : 'client-aggregate')
        : 'session-log'
      const balance = await fetchBalance(force)
      sendJson(res, 200, { cost: result.cost, model: result.model, band: result.band, source, balance })
    },
  }))
}
