/**
 * dsh-status-monitor — browser float window.
 *
 * A draggable, always-on-top-ish pill that shows DeepSeek API service status.
 * It registers into the 'app.overlay' slot when available so it floats above
 * the workspace; if that slot is absent it falls back to 'settings.section'
 * so the page is still reachable from Settings.
 *
 * Data comes from the Host half over the same-origin JSON API
 * /status-monitor/api/state (marker header required), polled every 60s.
 * No token leaves the page; the API returns aggregated state only.
 *
 * Hand-written lazy-CJS bundle in the window.__ModuleLoader__ format, no
 * build step, react.createElement only — same shape as dsh-account-switcher.
 *
 * @module dsh-status-monitor/client
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-status-monitor',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const API = '/status-monitor/api'
    const UI_BUILD = 'f4'
    const POLL_MS = 60_000

    const zh = {
      title: 'DeepSeek 服务状态',
      settingsNav: '服务状态',
      operational: '全部正常',
      degraded: '性能下降',
      partial_outage: '部分故障',
      full_outage: '严重故障',
      maintenance: '维护中',
      unknown: '状态未知',
      stale: '（数据延迟）',
      loading: '正在获取状态…',
      refresh: '刷新',
      openPage: '打开状态页',
      collapse: '收起',
      expand: '展开',
      lastUpdate: '更新于',
      error: '获取失败',
    }
    const t = (key) => zh[key] ?? key

    const STATUS_COLOR = {
      operational: '#22c55e',
      degraded: '#eab308',
      partial_outage: '#f97316',
      full_outage: '#ef4444',
      maintenance: '#3b82f6',
      unknown: '#9ca3af',
    }

    const styles = {
      root: { display: 'flex', flexDirection: 'column', gap: 12, padding: '8px 0 24px', fontSize: 13, lineHeight: 1.5 },
      card: { border: '1px solid var(--dsw-alias-border-secondary, #ddd)', borderRadius: 8, padding: 12, background: 'var(--dsw-alias-surface-primary, transparent)' },
      cardTitle: { fontWeight: 600, marginBottom: 6 },
      row: { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' },
      dot: { width: 9, height: 9, borderRadius: '50%', flexShrink: 0 },
      name: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      statusText: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #888)' },
      hint: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #888)' },
      button: { padding: '4px 10px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-secondary, #ccc)', background: 'transparent', cursor: 'pointer', fontSize: 12 },
      muted: { color: 'var(--dsw-alias-label-tertiary, #888)' },
      // Float window styles
      floatRoot: {
        position: 'fixed', zIndex: 9999,
        width: 240,
        background: 'var(--dsw-alias-surface-primary, rgba(30,30,30,0.92))',
        color: 'var(--dsw-alias-text-primary, #eee)',
        border: '1px solid var(--dsw-alias-border-secondary, #555)',
        borderRadius: 10,
        boxShadow: '0 6px 24px rgba(0,0,0,0.35)',
        backdropFilter: 'blur(8px)',
        userSelect: 'none',
        fontSize: 12,
      },
      floatHeader: { display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', cursor: 'move', borderBottom: '1px solid var(--dsw-alias-border-secondary, #444)' },
      floatTitle: { flex: 1, fontWeight: 600, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      floatBody: { padding: '6px 10px 8px' },
      floatRow: { display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0' },
      floatDot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
      floatName: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      floatFooter: { display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px 8px', fontSize: 11 },
      floatBtn: { padding: '2px 8px', borderRadius: 5, border: '1px solid var(--dsw-alias-border-secondary, #555)', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 11 },
      overallPill: { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '1px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600 },
    }

    function formatTime(ts) {
      if (!ts) return ''
      try { return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }) } catch { return '' }
    }

    /** One data fetch. */
    async function api(path) {
      const response = await fetch(`${API}${path}`, { headers: { 'x-status-monitor': '1' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }

    /**
     * The float window itself: fixed-position, draggable by its header,
     * collapsible to a pill. Position persists in localStorage per origin.
     */
    function FloatWindow(props) {
      const { data, loading, error, onRefresh } = props
      const [collapsed, setCollapsed] = useState(() => localStorage.getItem('dsh-status-collapsed') === '1')
      const [pos, setPos] = useState(() => {
        try {
          const saved = JSON.parse(localStorage.getItem('dsh-status-pos') ?? 'null')
          if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) return saved
        } catch { /* fallthrough */ }
        return { x: window.innerWidth - 268, y: Math.max(60, Number(getComputedStyle(document.documentElement).getPropertyValue('--dsh-frame-overlay-top')) || 64) }
      })
      const drag = useRef(null)

      useEffect(() => {
        localStorage.setItem('dsh-status-pos', JSON.stringify(pos))
      }, [pos])

      const headerRef = useRef(null)
      const onPointerDown = useCallback((event) => {
        if (event.button !== 0) return
        // 不拦按钮：点「—」收起时不应触发拖拽
        if (event.target?.closest?.('button')) return
        event.preventDefault()
        const startX = event.clientX - pos.x
        const startY = event.clientY - pos.y
        const el = headerRef.current
        // Pointer capture：指针移出 header 也照样收到 move/up，快速拖拽不丢
        try { el?.setPointerCapture?.(event.pointerId) } catch { /* older engines */ }
        drag.current = { startX, startY }
        const onMove = (moveEvent) => {
          if (drag.current === null) return
          const nx = Math.min(Math.max(0, moveEvent.clientX - drag.current.startX), window.innerWidth - 80)
          const ny = Math.min(Math.max(0, moveEvent.clientY - drag.current.startY), window.innerHeight - 40)
          setPos({ x: nx, y: ny })
        }
        const onUp = () => {
          drag.current = null
          try { el?.releasePointerCapture?.(event.pointerId) } catch { /* noop */ }
          el?.removeEventListener('pointermove', onMove)
          el?.removeEventListener('pointerup', onUp)
          el?.removeEventListener('pointercancel', onUp)
        }
        el?.addEventListener('pointermove', onMove)
        el?.addEventListener('pointerup', onUp)
        el?.addEventListener('pointercancel', onUp)
      }, [pos])

      const overallColor = STATUS_COLOR[data?.overall] ?? STATUS_COLOR.unknown
      const overallText = data ? t(data.overall) : (error ? t('error') : t('loading'))

      if (collapsed) {
        return h('div', {
          style: { ...styles.floatRoot, width: 'auto', left: pos.x, top: pos.y },
          onDoubleClick: () => { setCollapsed(false); localStorage.setItem('dsh-status-collapsed', '0') },
          title: '双击展开',
        },
        h('div', { ref: headerRef, style: { ...styles.floatHeader, cursor: 'pointer', borderBottom: 'none', touchAction: 'none' }, onPointerDown },
          h('span', { style: { ...styles.floatDot, background: overallColor, width: 10, height: 10 } }),
          h('span', { style: styles.floatTitle }, `DS接口监视 · ` + overallText),
        ))
      }

      return h('div', { style: { ...styles.floatRoot, left: pos.x, top: pos.y } },
        h('div', { ref: headerRef, style: { ...styles.floatHeader, touchAction: 'none' }, onPointerDown },
          h('span', { style: { ...styles.floatDot, background: overallColor, width: 10, height: 10 } }),
          h('span', { style: styles.floatTitle }, `DS接口监视 · ` + overallText + (data?.stale ? ` ${t('stale')}` : '') + ` · ${UI_BUILD}`),
          h('button', { style: styles.floatBtn, onClick: () => { setCollapsed(true); localStorage.setItem('dsh-status-collapsed', '1') }, title: t('collapse') }, '—'),
        ),
        h('div', { style: styles.floatBody },
          error !== null
            ? h('div', { style: { ...styles.muted, color: 'var(--dsw-alias-state-error-primary, #f66)' } }, `${t('error')}: ${error}`)
            : data === null
              ? h('div', { style: styles.muted }, t('loading'))
              : data.components.map((c) => h('div', { key: c.id, style: styles.floatRow },
                h('span', { style: { ...styles.floatDot, background: STATUS_COLOR[c.status] ?? STATUS_COLOR.unknown } }),
                h('span', { style: styles.floatName, title: c.name }, c.name),
              )),
        ),
        h('div', { style: styles.floatFooter },
          h('span', { style: styles.muted }, data?.fetchedAt ? `${t('lastUpdate')} ${formatTime(data.fetchedAt)}` : ''),
          h('span', { style: { flex: 1 } }),
          h('button', { style: styles.floatBtn, onClick: onRefresh, disabled: loading }, t('refresh')),
          h('button', { style: styles.floatBtn, onClick: () => window.open('https://status.deepseek.com/', '_blank', 'noopener,noreferrer') }, '↗'),
        ),
      )
    }

    /** Full settings page (fallback surface; also useful for details). */
    function StatusSection() {
      const [data, setData] = useState(null)
      const [loading, setLoading] = useState(false)
      const [err, setErr] = useState(null)

      const refresh = useCallback(async () => {
        setLoading(true)
        try {
          setData(await api('/state'))
          setErr(null)
        } catch (cause) {
          setErr(String(cause?.message ?? cause))
        } finally {
          setLoading(false)
        }
      }, [])

      useEffect(() => {
        refresh()
        const timer = setInterval(refresh, POLL_MS)
        return () => clearInterval(timer)
      }, [refresh])

      const error = err
      const call = refresh
      return h('div', { style: styles.root },
        h('h2', { style: { fontSize: 15, margin: 0 } }, t('title')),
        data === null
          ? h('p', { style: styles.hint }, (error ?? '') + t('loading'))
          : h('div', { style: styles.card },
            h('div', { style: styles.cardTitle },
              h('span', { style: { ...styles.dot, background: STATUS_COLOR[data.overall] ?? '#999', display: 'inline-block', marginRight: 8 } }),
              t(data.overall),
              data.stale ? h('span', { style: styles.hint }, ` ${t('stale')}`) : null,
            ),
            data.components.map((c) => h('div', { key: c.id, style: styles.row },
              h('span', { style: { ...styles.dot, background: STATUS_COLOR[c.status] ?? '#999' } }),
              h('span', { style: styles.name }, c.name),
              h('span', { style: styles.statusText }, t(c.status)),
            )),
            h('div', { style: { ...styles.hint, marginTop: 8 } },
              `${t('lastUpdate')} ${formatTime(data.fetchedAt)} · 每 60 秒自动刷新`),
          ),
        h('div', null,
          h('button', { style: styles.button, onClick: call }, t('refresh')),
          ' ',
          h('button', { style: styles.button, onClick: () => window.open('https://status.deepseek.com/', '_blank', 'noopener,noreferrer') }, t('openPage')),
        ),
      )
    }

    let error = null

    exports.inject = ['slots']
    exports.apply = function apply(ctx) {
      // Register the settings page so the plugin is reachable even if the
      // overlay slot is unavailable in some host revision.
      ctx.slots.inject('settings.section', () => ctx.slots.register(
        { name: 'settings.section', id: 'status-monitor', order: 25, label: () => t('settingsNav') },
        StatusSection,
      ))

      // The float window overlays the whole app frame: shell.overlay is the
      // frame-wide list slot rendered inside AppFrame's overlayLayer
      // (dsh-client-ui-layout), the same seat quota notices use.
      ctx.slots.inject('shell.overlay', () => ctx.slots.register(
        { name: 'shell.overlay', id: 'status-monitor-float' },
        FloatHost,
      ))

      function FloatHost() {
        const [data, setData] = useState(null)
        const [loading, setLoading] = useState(false)
        const [err, setErr] = useState(null)

        const refresh = useCallback(async () => {
          setLoading(true)
          try {
            const next = await api('/state')
            setData(next)
            setErr(null)
          } catch (cause) {
            setErr(String(cause?.message ?? cause))
          } finally {
            setLoading(false)
          }
        }, [])

        useEffect(() => {
          refresh()
          const timer = setInterval(refresh, POLL_MS)
          return () => clearInterval(timer)
        }, [refresh])

        return h(FloatWindow, { data, loading, error: err, onRefresh: refresh })
      }
    }

    return module.exports
  },
})
