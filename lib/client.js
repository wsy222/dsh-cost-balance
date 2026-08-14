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
      '.cbPill{position:relative;display:flex;flex-direction:column;align-items:center;padding:2px 0 4px}' +
      '.cbPill_bar{width:120px;height:5px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 38%,transparent);cursor:pointer;border:none;padding:0;transition:opacity .15s ease}' +
      '.cbPill_bar:hover{opacity:.7}' +
      '.cbPill_panel{position:absolute;bottom:calc(100% + 12px);left:50%;transform:translateX(-50%);z-index:50;box-sizing:border-box;min-width:280px;max-width:min(420px,calc(100vw - 48px));background:color-mix(in srgb,var(--dsw-specific-menu) 80%,transparent);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;box-shadow:var(--dsw-shadow-lv3);padding:10px 14px;font-size:12px;line-height:22px}' +
      '.cbPill_row{justify-content:space-between;align-items:center;gap:12px;display:flex}' +
      '.cbPill_label{color:var(--dsw-alias-label-tertiary);flex:none}' +
      '.cbPill_value{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);font-weight:500;text-align:right;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.cbPill_hint{color:var(--dsw-alias-label-caption);text-align:center;margin-top:4px}'
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
      const settledNodes = props.useSession((s) => s.chat.legacy.nodes)
      const usage = props.useProjection('tokenUsage')
      const projected = props.useProjection('sessionStats')
      const stats = React.useMemo(() => projected ?? deriveStats(settledNodes), [projected, settledNodes])
      const [open, setOpen] = React.useState(false)
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
      React.useEffect(() => ctx.interval(() => {
        refresh()
      }, 60000), [refresh])

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
        if (cost !== null) rows.push(['花费', '$' + formatCost(cost)])
        const balance = readout.balance !== null && typeof readout.balance === 'object' && readout.balance.available
          ? readout.balance
          : null
        rows.push(['余额', balance !== null ? currencySymbol(balance.currency) + balance.balance : '--'])
      }

      return React.createElement('div', { className: 'cbPill' }, [
        open
          ? React.createElement('div', { className: 'cbPill_panel', key: 'panel' },
            rows.length === 0
              ? React.createElement('div', { className: 'cbPill_hint' }, '暂无数据')
              : rows.map((row, i) => React.createElement('div', { className: 'cbPill_row', key: i }, [
                React.createElement('span', { className: 'cbPill_label', key: 'l' }, row[0]),
                React.createElement('span', { className: 'cbPill_value', key: 'v' }, row[1]),
              ])))
          : null,
        React.createElement('button', {
          key: 'bar',
          type: 'button',
          className: 'cbPill_bar',
          'aria-label': open ? '收起会话统计' : '展开会话统计',
          'aria-expanded': open,
          onClick: () => setOpen(!open),
        }),
      ])
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('conversation.composer.dock', () => slots.register(
        { name: 'conversation.composer.dock', id: 'stats', order: 0 },
        (props) => React.createElement(StatsPill, props),
      ))
    }

    exports.apply = apply
    exports.inject = ['timer']
    return module.exports
  },
})
