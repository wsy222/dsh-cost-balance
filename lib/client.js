// dsh-cost-balance — Client half (web)
// 输入框下方（conversation.composer.dock）的 iOS 风格小黑条：默认折叠，
// 点击展开为半透明毛玻璃多行面板，展示轮次/耗时/缓存命中/Token/花费/余额。
// 数据经同源 /api/cost-balance 路由从 Host 读取。
window.__ModuleLoader__.load({
  id: 'dsh-cost-balance',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')

    const CSS =
      '.cbPill{display:flex;flex-wrap:wrap;justify-content:center;align-items:baseline;gap:3px 16px;padding:3px 12px;font-size:12px;line-height:18px}' +
      '.cbPill_row{display:inline-flex;gap:6px;align-items:baseline;white-space:nowrap}' +
      '.cbPill_label{color:var(--dsw-alias-label-tertiary, rgba(140,145,155,.9));flex:none}' +
      '.cbPill_value{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary, #fff);font-weight:500}' +
      '.cbPill_hint{color:var(--dsw-alias-label-caption, rgba(140,145,155,.8));text-align:center}'
    const CSS_TAG = 'dsh-cost-balance/stats'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="' + CSS_TAG + '"]') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-cost-balance'
      tag.dataset.pluginCss = CSS_TAG
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    function formatTokens(n) {
      const scaled = (v) => (v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10))
      if (n < 1e3) return String(n)
      if (n < 1e6) return scaled(n / 1e3) + 'K'
      return scaled(n / 1e6) + 'M'
    }
    function formatDuration(ms) {
      const s = ms / 1e3
      if (s < 60) return String(Math.round(s * 10) / 10) + 's'
      const whole = Math.round(s)
      return Math.floor(whole / 60) + 'm' + (whole % 60) + 's'
    }
    function formatTokensPerSecond(tps) {
      const clamped = Math.max(0, tps)
      return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10)
    }
    function usageOutputTokens(usage) {
      if (typeof usage !== 'object' || usage === null) return null
      const value = usage.outputTokens
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
    }
    function assistantStepReading(node) {
      const timing = node.timing
      return {
        ttftMs: timing !== void 0 && timing.stepStartTime !== null && timing.firstTokenTime !== null
          ? Math.max(0, timing.firstTokenTime - timing.stepStartTime)
          : null,
        decodeMs: timing !== void 0 && timing.firstTokenTime !== null
          ? Math.max(0, timing.completedTime - timing.firstTokenTime)
          : null,
        outputTokens: usageOutputTokens(node.usage),
      }
    }
    function deriveStats(nodes) {
      const turns = new Set()
      let steps = 0
      let llmMs = 0
      let toolMs = 0
      let ttftMs = 0
      let ttftSteps = 0
      let decodeMs = 0
      let decodeTokens = 0
      for (const node of nodes) {
        if (node.kind === 'tool-result') {
          if (node.callTime !== null) toolMs += Math.max(0, node.time - node.callTime)
          continue
        }
        if (node.kind !== 'assistant') continue
        turns.add(node.turn)
        steps += 1
        if (node.timing !== void 0 && node.timing.stepStartTime !== null) {
          llmMs += Math.max(0, node.timing.completedTime - node.timing.stepStartTime)
        }
        const reading = assistantStepReading(node)
        if (reading.ttftMs !== null) {
          ttftMs += reading.ttftMs
          ttftSteps += 1
        }
        if (reading.decodeMs !== null && reading.outputTokens !== null) {
          decodeMs += reading.decodeMs
          decodeTokens += reading.outputTokens
        }
      }
      return { turns: turns.size, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens }
    }
    function billedInputTokens(usage) {
      return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
    }
    function cacheHitPercent(usage) {
      const denominator = billedInputTokens(usage)
      return denominator === 0 ? null : Math.round((usage.cacheReadTokens / denominator) * 100)
    }
    function formatCost(cost) {
      return cost >= 1 ? cost.toFixed(2) : cost.toFixed(4)
    }
    function currencySymbol(currency) {
      if (currency === 'CNY') return '¥'
      if (currency === 'USD') return '$'
      return currency + ' '
    }
    function fetchReadout(usage) {
      const q = new URLSearchParams({
        uncached: String(usage.uncachedInputTokens ?? 0),
        cacheRead: String(usage.cacheReadTokens ?? 0),
        cacheWrite: String(usage.cacheWriteTokens ?? 0),
        output: String(usage.outputTokens ?? 0),
      })
      return fetch('/api/cost-balance?' + q.toString(), {
        headers: { accept: 'application/json' },
      }).then((r) => r.json())
    }

    function StatsPill(props) {
      // 0.1.2 起聊天树从 session store 迁到 chat store（useChat）；旧版读 useSession((s) => s.chat.legacy.nodes)。
      // 双路径都调用（hooks 顺序稳定），取非空者：新版 useSession(s.chat) 已不存在返回 undefined，回退 useChat。
      const nodesFromChat = props.useChat !== void 0 ? props.useChat((s) => s.legacy.nodes) : void 0
      const nodesFromSession = props.useSession((s) => s.chat?.legacy?.nodes)
      const settledNodes = nodesFromChat !== void 0 ? nodesFromChat : nodesFromSession
      const usage = props.useProjection('tokenUsage')
      const projected = props.useProjection('sessionStats')
      const stats = React.useMemo(() => projected ?? deriveStats(settledNodes ?? []), [projected, settledNodes])
      const [readout, setReadout] = React.useState(null)
      const usageKey = usage === void 0
        ? ''
        : [usage.uncachedInputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.outputTokens].join(',')
      const refresh = React.useCallback(() => {
        if (usage === void 0) return
        fetchReadout(usage).then((result) => {
          setReadout(result !== null && typeof result === 'object' ? result : null)
        }).catch(() => {
          setReadout(null)
        })
      }, [usageKey])
      React.useEffect(() => {
        refresh()
      }, [refresh])
      // 修复：原代码在组件作用域引用 ctx.interval（ctx 只存在于 apply 闭包），
      // 组件一挂载即 ReferenceError → 整个槽位条目崩溃不可见。改用标准定时器。
      React.useEffect(() => {
        const timer = window.setInterval(() => {
          refresh()
        }, 60000)
        return () => window.clearInterval(timer)
      }, [refresh])

      const rows = []
      if (stats.steps > 0) {
        rows.push(['轮次 · 步数', stats.turns + ' 轮 · ' + stats.steps + ' 步'])
        if (stats.llmMs > 0) rows.push(['LLM 耗时', formatDuration(stats.llmMs)])
        if (stats.toolMs > 0) rows.push(['工具调用', formatDuration(stats.toolMs)])
        if (stats.ttftSteps > 0) rows.push(['首 token 平均', formatDuration(stats.ttftMs / stats.ttftSteps)])
        if (stats.decodeMs > 0) rows.push(['吞吐', formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1e3)) + ' tok/s'])
      }
      if (usage !== void 0 && (billedInputTokens(usage) > 0 || usage.outputTokens > 0)) {
        const cacheHit = cacheHitPercent(usage)
        if (cacheHit !== null) rows.push(['缓存命中', cacheHit + '%'])
        rows.push(['Token', '输入 ' + formatTokens(billedInputTokens(usage)) + ' · 输出 ' + formatTokens(usage.outputTokens)])
      }
      if (readout !== null) {
        const cost = typeof readout.cost === 'number' ? readout.cost : null
        // 官方中文站以人民币计价（元/百万 tokens），花费直接显示 ¥。
        // band 标注当前价格段：peak=峰、offpeak=谷（flat=峰谷切换前，不标注）。
        if (cost !== null) {
          const band = readout.band === 'peak' ? '峰' : readout.band === 'offpeak' ? '谷' : ''
          rows.push(['花费', '¥' + formatCost(cost) + (band !== '' ? '(' + band + ')' : '')])
        }
        const balance = readout.balance !== null && typeof readout.balance === 'object' && readout.balance.available
          ? readout.balance
          : null
        rows.push(['余额', balance !== null ? currencySymbol(balance.currency) + balance.balance : '--'])
      }

      // 内联常驻样式（本地改造）：与官方统计行同款横向一行，无需点击。
      return React.createElement('div', { className: 'cbPill' },
        rows.length === 0
          ? React.createElement('div', { className: 'cbPill_hint' }, '暂无数据')
          : rows.map((row, i) => React.createElement('div', { className: 'cbPill_row', key: i }, [
            React.createElement('span', { className: 'cbPill_label', key: 'l' }, row[0]),
            React.createElement('span', { className: 'cbPill_value', key: 'v' }, row[1]),
          ])))
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('conversation.composer.dock', () => slots.register(
        { name: 'conversation.composer.dock', id: 'stats', order: -1, priority: -1 },
        (props) => React.createElement(StatsPill, props),
      ))
    }

    exports.apply = apply
    exports.inject = ['timer']
    return module.exports
  },
})
