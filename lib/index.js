/**
 * DeepSeek status monitor — Host half.
 *
 * Fetches https://status.deepseek.com/ on a timer, parses the RSC flight
 * payload embedded in the HTML (flashcat status page, Next.js App Router),
 * and projects { components, overall, fetchedAt } over a same-origin JSON
 * API at /api-status-float/api/state. The browser float window polls that
 * endpoint; nothing else talks to the Platform.
 *
 * No @deepseek-ai/* imports: only Cordis services and Node built-ins, so the
 * plugin survives runtime upgrades. Same contract discipline as
 * dsh-account-switcher, whose webServer.register shape this follows.
 *
 * @module dsh-status-monitor
 */

/** Credentials-adjacent record replaced when switching. Not used here. */

const STATUS_URL_DEFAULT = 'https://status.deepseek.com/'
const REFRESH_MS_DEFAULT = 60_000
const MAX_BODY_BYTES = 512 * 1024
const REQUEST_TIMEOUT_MS = 20_000

/** Plugin identity used by the Loader and the client module table. */
export const name = 'dsh-api-status-float'
/** No required services: the web server is resolved lazily. */
export const inject = []

/** Business status values the flashcat page emits. */
const STATUSES = new Set(['operational', 'degraded', 'partial_outage', 'full_outage', 'maintenance'])

/** Rank used to derive the overall badge; higher is worse. */
const SEVERITY = { operational: 0, maintenance: 1, degraded: 2, partial_outage: 3, full_outage: 4 }

/**
 * Fetch the status page and extract per-component state.
 * @param {string} url - status page base URL.
 * @param {number} timeoutMs - per-request deadline.
 * @returns {Promise<{overall: string, components: Array<{id: string, name: string, status: string}>, fetchedAt: number}>}
 */
export async function fetchStatus(url = STATUS_URL_DEFAULT, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let html
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml',
      },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const text = await response.text()
    if (text.length > MAX_BODY_BYTES) throw new Error('page too large')
    html = text
  } finally {
    clearTimeout(timer)
  }
  return parseHtml(html)
}

/**
 * Parse the flight payload inside one status page.
 *
 * The page embeds `\"component_id\":\"…\",\"name\":\"…\"` definitions and
 * `\"component_id\":\"…\",\"status\":\"…\"` event rows, all double-escaped
 * inside the RSC stream. Unescape once, then pair definitions with the latest
 * event per component; a component with no event rows is operational.
 * @param {string} html - raw HTML.
 */
export function parseHtml(html) {
  const raw = html.replaceAll('\\"', '"')
  const nowSeconds = Math.floor(Date.now() / 1000)
  /** id -> display name, from component definitions. */
  const names = new Map()
  const defRe = /\{"component_id":"([A-Z0-9]+)"[^{}]*?"name":"([^"]+)"[^{}]*?\}/g
  for (const m of raw.matchAll(defRe)) {
    if (!names.has(m[1])) names.set(m[1], m[2])
  }
  /**
   * id -> ongoing event status, if any.
   *
   * Every row on the page is a status-change window with both start_at and
   * end_at. Rows whose end_at has passed are history; a component is only
   * non-operational RIGHT NOW when it has a window that has not ended yet
   * (end_at is 0/absent, or lies in the future). The page banner "All Systems
   * Operational" corresponds exactly to "no ongoing windows".
   */
  const ongoing = new Map()
  const eventRe = /\{"component_id":"([A-Z0-9]+)"[^{}]*?"start_at_seconds":(\d+),"end_at_seconds":(\d+),"status":"([a-z_]+)"[^{}]*?\}/g
  for (const m of raw.matchAll(eventRe)) {
    const [, id, start, end, status] = m
    if (!STATUSES.has(status)) continue
    const endAt = Number(end)
    if (endAt !== 0 && endAt <= nowSeconds) continue
    const prev = ongoing.get(id)
    if (prev === undefined || Number(start) > prev.at) ongoing.set(id, { at: Number(start), status })
  }
  const components = [...names.entries()].map(([id, name]) => {
    const event = ongoing.get(id)
    return { id, name, status: event ? event.status : 'operational' }
  })
  components.sort((a, b) => a.name.localeCompare(b.name))
  let overall = 'operational'
  for (const c of components) {
    if (SEVERITY[c.status] > SEVERITY[overall]) overall = c.status
  }
  return { overall, components, fetchedAt: Date.now() }
}

/**
 * Plugin entry. Wires the timer cache and the JSON routes.
 * @param {object} ctx - Cordis plugin context.
 * @param {object} config - bundle patch config.
 */
export function apply(ctx, config = {}) {
  const logger = ctx.logger
  const statusUrl = String(config.statusUrl ?? STATUS_URL_DEFAULT)
  const refreshMs = Math.max(15_000, Number(config.refreshMs) || REFRESH_MS_DEFAULT)

  let snapshot = null
  let fetching = null
  let disposed = false

  /** Refresh once; concurrent callers share one flight. */
  function refresh() {
    if (fetching !== null) return fetching
    fetching = fetchStatus(statusUrl)
      .then((next) => {
        snapshot = next
        logger.info?.(`api-status-float: ${next.overall} (${next.components.length} components)`)
      })
      .catch((error) => {
        logger.warn?.(`api-status-float: fetch failed: ${String(error?.message ?? error)}`)
        if (snapshot !== null) snapshot = { ...snapshot, stale: true }
      })
      .finally(() => {
        fetching = null
      })
    return fetching
  }

  ctx.effect(() => {
    void refresh()
    const timer = setInterval(() => {
      if (!disposed) void refresh()
    }, refreshMs)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  })

  const handlers = {
    /** Current snapshot; fetches on first call if the timer has not run yet. */
    state: async () => {
      if (snapshot === null) await refresh()
      return {
        ok: true,
        overall: snapshot?.overall ?? 'unknown',
        stale: snapshot?.stale === true,
        components: snapshot?.components ?? [],
        fetchedAt: snapshot?.fetchedAt ?? 0,
        version: '0.1.0',
      }
    },
    /** Force one refresh now. */
    refresh: async () => {
      await refresh()
      return {
        ok: true,
        overall: snapshot?.overall ?? 'unknown',
        stale: false,
        components: snapshot?.components ?? [],
        fetchedAt: snapshot?.fetchedAt ?? 0,
        version: '0.1.0',
      }
    },
  }

  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => scope.webServer.register({
      kind: 'prefix',
      path: '/api-status-float/api',
      handler: router(handlers, logger),
    }))
  })

  ctx.effect(() => () => {
    disposed = true
  })
}

/** Same-origin JSON API with the loopback + marker guard, as account-switcher. */
function router(handlers, logger) {
  /** @param {import('node:http').IncomingMessage} req */
  function guard(req) {
    const address = String(req.socket?.remoteAddress ?? '')
    const loopback = address === '::1' || address === '127.0.0.1' || address.startsWith('127.') || address.startsWith('::ffff:127.')
    if (!loopback) return { status: 403, body: { ok: false, error: 'forbidden' } }
    if (req.headers['x-api-status-float'] !== '1') return { status: 403, body: { ok: false, error: 'forbidden' } }
    return null
  }

  return async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const route = url.pathname.replace(/^\/api-status-float\/api/, '') || '/'
    const reject = guard(req)
    if (reject !== null) {
      res.writeHead(reject.status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(reject.body))
      return
    }
    try {
      if (req.method !== 'GET') throw new Error('method not allowed')
      const handler = handlers[route.replace(/^\//, '').replace(/\/$/, '') || 'state']
      if (typeof handler !== 'function') throw new Error('not found')
      const body = await handler()
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    } catch (error) {
      logger.warn?.(`api-status-float: api ${route} failed: ${String(error?.message ?? error)}`)
      res.writeHead(error?.message === 'not found' ? 404 : 500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
    }
  }
}
