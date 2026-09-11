/**
 * Probes Hermes services to detect which API groups are available.
 *
 * Zero-fork architecture:
 *   - Gateway (:8642 by default): /health, /v1/chat/completions, /v1/models
 *   - Dashboard (:9119 by default): sessions, skills, config, cron, env, analytics
 *
 * Legacy enhanced-fork compatibility remains for users still running the
 * older all-in-one web API on the gateway port.
 *
 * Precedence for gateway/dashboard URLs:
 *   1. process.env.HERMES_API_URL / HERMES_DASHBOARD_URL (from switchui .env or shell).
 *   2. Runtime override via setGatewayUrl() / setDashboardUrl() — mutates the
 *      in-process let AND persists to switchui .env so the value survives restarts.
 *      Pass empty/null to clear the override and fall back to env/default.
 *   3. Default localhost (8642 / 9119).
 *
 * NOTE: the legacy ~/.hermes/workspace-overrides.json config layer has been
 * removed. On first startup after upgrade, any stale overrides file is renamed
 * to workspace-overrides.json.bak automatically.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

function hermesHome(): string {
  return (
    process.env.HERMES_HOME ??
    process.env.CLAUDE_HOME ??
    path.join(os.homedir(), '.hermes')
  )
}

function normalizeUrl(u: string): string {
  return u.trim().replace(/\/+$/, '')
}

// ── .env persistence helpers ──────────────────────────────────────────────────
// The switchui project .env lives at <projectRoot>/.env (process.cwd() when
// the server runs via pnpm start / pnpm dev from the project root).
// Writing here does NOT update the live process.env — the in-process `let`
// mutation in setGatewayUrl/setDashboardUrl covers the current session.
// The .env write is only for the value to survive a restart.

function switchuiEnvPath(): string {
  return path.join(process.cwd(), '.env')
}

function readSwitchuiEnv(): string {
  try {
    return fs.readFileSync(switchuiEnvPath(), 'utf-8')
  } catch {
    return ''
  }
}

/**
 * Upsert or delete a single key in the switchui project .env file.
 * Preserves all other lines and comments. Warn-only on failure — must
 * not throw because the in-process mutation already handled the live session.
 */
function persistEnvUrl(key: string, value: string | null): void {
  try {
    const envPath = switchuiEnvPath()
    const raw = readSwitchuiEnv()
    const lines = raw.length ? raw.split('\n') : []
    const keyPattern = new RegExp(`^${key}\\s*=`)
    const existingIdx = lines.findIndex((l) => keyPattern.test(l))

    if (value === null || value === '') {
      // Remove the key if present.
      if (existingIdx >= 0) lines.splice(existingIdx, 1)
    } else {
      const entry = `${key}=${value}`
      if (existingIdx >= 0) {
        lines[existingIdx] = entry
      } else {
        lines.push(entry)
      }
    }

    // Trim trailing blank lines added by splice/push, keep one trailing newline.
    const content = lines.join('\n').replace(/\n+$/, '') + '\n'
    fs.writeFileSync(envPath, content, { encoding: 'utf-8', mode: 0o600 })
  } catch (err) {
    console.warn(`[gateway] failed to persist ${key} to switchui .env:`, err)
  }
}

// ── One-time migration: rename stale workspace-overrides.json ─────────────────
// Upstream-Workspace remnant: if the file exists it silently outranks .env,
// sending gateway/dashboard calls to the wrong host on a fresh local install.
// Rename it once at module load so it no longer poisons URL resolution.
;(function migrateStaleOverrides() {
  try {
    const legacyPath = path.join(hermesHome(), 'workspace-overrides.json')
    if (fs.existsSync(legacyPath)) {
      fs.renameSync(legacyPath, legacyPath + '.bak')
      console.warn(
        '[gateway] Removed legacy workspace-overrides.json (now using .env). Backed up to workspace-overrides.json.bak',
      )
    }
  } catch {
    // warn-only — never block startup
  }
})()

export let CLAUDE_API = normalizeUrl(
  process.env.HERMES_API_URL ||
    process.env.CLAUDE_API_URL ||
    'http://127.0.0.1:8642',
)
export let CLAUDE_DASHBOARD_URL = normalizeUrl(
  process.env.HERMES_DASHBOARD_URL ||
    process.env.CLAUDE_DASHBOARD_URL ||
    'http://127.0.0.1:9119',
)

/**
 * Update the gateway URL at runtime, persist it to switchui .env, and reset
 * the probe cache so the next call to ensureGatewayProbed() re-detects
 * capabilities. Returns the saved URL (normalized). Pass an empty string or
 * null to clear the override and fall back to env/default.
 */
export function setGatewayUrl(input: string | null | undefined): string {
  const normalized = input ? normalizeUrl(input) : ''
  if (normalized) {
    CLAUDE_API = normalized
    persistEnvUrl('HERMES_API_URL', normalized)
  } else {
    CLAUDE_API = normalizeUrl(
      process.env.HERMES_API_URL ||
        process.env.CLAUDE_API_URL ||
        'http://127.0.0.1:8642',
    )
    persistEnvUrl('HERMES_API_URL', null)
  }
  // Force reprobe on the next capability check.
  probePromise = null
  lastProbeAt = 0
  return CLAUDE_API
}

/**
 * Same as setGatewayUrl() but for the dashboard service.
 */
export function setDashboardUrl(input: string | null | undefined): string {
  const normalized = input ? normalizeUrl(input) : ''
  if (normalized) {
    CLAUDE_DASHBOARD_URL = normalized
    persistEnvUrl('HERMES_DASHBOARD_URL', normalized)
  } else {
    CLAUDE_DASHBOARD_URL = normalizeUrl(
      process.env.HERMES_DASHBOARD_URL ||
        process.env.CLAUDE_DASHBOARD_URL ||
        'http://127.0.0.1:9119',
    )
    persistEnvUrl('HERMES_DASHBOARD_URL', null)
  }
  probePromise = null
  lastProbeAt = 0
  return CLAUDE_DASHBOARD_URL
}

/** Current resolved URLs (after any runtime override). */
export function getResolvedUrls(): {
  gateway: string
  dashboard: string
  source: 'override' | 'env' | 'default'
} {
  const source =
    process.env.HERMES_API_URL || process.env.CLAUDE_API_URL ? 'env' : 'default'
  return { gateway: CLAUDE_API, dashboard: CLAUDE_DASHBOARD_URL, source }
}

export const CLAUDE_UPGRADE_INSTRUCTIONS =
  'For full features, install Hermes Agent (`curl -fsSL https://raw.githubusercontent.com/Interstellar-code/hermes-agent/main/scripts/install.sh | bash`), then start the gateway on :8642 (`hermes gateway run`). For the extended APIs (Sessions, Skills, Config, Jobs) also start the dashboard on :9119 (`hermes dashboard`).'

export const SESSIONS_API_UNAVAILABLE_MESSAGE = `Your Hermes backend does not support the sessions API. ${CLAUDE_UPGRADE_INSTRUCTIONS}`

// 8s, not 3s: the dashboard's /api/status is cold on the first hit after a
// (re)boot — measured ~3s — which raced the old 3s abort and intermittently
// flipped dashboard.available to false, marking every extended API "missing"
// until a full restart. 15s clears cold/loaded hits; warm hits return in <1s.
const PROBE_TIMEOUT_MS = 15_000
// Probe TTL: 120s when fully healthy, 15s otherwise. The shorter window
// applies both when the gateway is unreachable (Docker boot race, see #275)
// AND when the gateway is up but the dashboard (port 9119) is missing — so
// starting the dashboard is reflected within ~15s instead of being stuck on a
// stale 'healthy' probe for two minutes. Recovery of a partial state must be
// dynamic.
const PROBE_TTL_MS = 120_000
const PROBE_TTL_DISCONNECTED_MS = 15_000

function effectiveProbeTtl(caps: {
  health: boolean
  chatCompletions: boolean
  authError: boolean
  dashboard: { available: boolean }
}): number {
  // Gateway down → re-probe often so we notice it come back.
  if (!caps.health && !caps.chatCompletions) return PROBE_TTL_DISCONNECTED_MS
  // Token mismatch → also a broken state worth re-checking often, so fixing
  // HERMES_API_TOKEN / API_SERVER_KEY is picked up within seconds, not up to
  // two minutes.
  if (caps.authError) return PROBE_TTL_DISCONNECTED_MS
  // Gateway up but dashboard down → still a partial state; re-probe often so
  // the "Limited mode" banner clears quickly once the dashboard is started.
  if (!caps.dashboard.available) return PROBE_TTL_DISCONNECTED_MS
  return PROBE_TTL_MS
}
const DASHBOARD_TOKEN_REGEX =
  /window\.__(?:CLAUDE|HERMES)_SESSION_TOKEN__\s*=\s*["'](.+?)["']/

// ── Types ─────────────────────────────────────────────────────────

export type CoreCapabilities = {
  health: boolean
  /**
   * True when `/v1/chat/completions` is registered AND usable — i.e. the
   * route exists and this workspace's bearer token was accepted (no 401).
   * This is the field `chat-mode.ts`'s `getChatMode()` / `resolveChatBackend()`
   * read to decide whether the OpenAI-compatible transport is safe to use;
   * see `chatCompletionsRouteExists` below for the weaker "route is
   * registered" signal on its own. See W3 audit item 5 follow-up.
   */
  chatCompletions: boolean
  /**
   * True when `/v1/chat/completions` answered with anything other than 404
   * — i.e. the route is registered, regardless of whether THIS workspace's
   * token was accepted. A 401 proves the route exists (a vanilla/
   * unauthenticated gateway 404s instead) but does not make the route
   * usable; `chatCompletions` above is the usable signal transport
   * selection must key off. Kept for callers that only care about
   * route-presence (mirrors the `exists`/`authError` split in
   * `probeChatCompletions()`).
   */
  chatCompletionsRouteExists?: boolean
  models: boolean
  streaming: boolean
  probed: boolean
  /**
   * True when `/health` OR `/v1/chat/completions` answered 401 — this
   * workspace's own bearer token (`HERMES_API_TOKEN` / `API_SERVER_KEY`)
   * does not match what THIS gateway process expects. Distinct from
   * `!health`: a token mismatch means the gateway IS up and reachable —
   * every authenticated request will simply keep failing until the tokens
   * agree. Conflating the two used to render a mismatch as "Connected" (the
   * generic `probe()` below treats any non-404/403 status, 401 included, as
   * "capability present" — correct for capability-presence probes, wrong
   * for the health/availability signal users see). See W3 audit item 5.
   */
  authError: boolean
}

export type EnhancedCapabilities = {
  sessions: boolean
  enhancedChat: boolean
  skills: boolean
  memory: boolean
  config: boolean
  jobs: boolean
  mcp: boolean
  /**
   * Phase 1.5 — local-only fallback. True when the agent does NOT yet expose
   * the `/api/mcp*` runtime endpoints but the dashboard `/api/config` route
   * exposes a `mcp_servers` map AND the deployment is loopback-only. The
   * workspace then performs CRUD against `config.mcp_servers` directly while
   * disabling Test/Discover/Logs (which require runtime probing). Removed
   * once hermes-agent ships native `/api/mcp*` endpoints.
   */
  mcpFallback: boolean
  /**
   * True when the dashboard exposes `/api/conductor/missions`. The Conductor
   * UI requires this; if false, the screen renders an 'upstream not ready'
   * placeholder instead of failing mid-action. See #262.
   */
  conductor: boolean
  /**
   * True when the Hermes Agent Dashboard Kanban plugin is available at
   * `/api/plugins/kanban/*`. The Tasks board requires this; degrades
   * gracefully to a BackendUnavailableState when absent.
   */
  kanban: boolean
  /**
   * True when the Hermes Agent Dashboard Projects plugin is available at
   * `/api/plugins/projects*`. The Projects screen requires this; degrades
   * gracefully to a BackendUnavailableState when absent.
   */
  projects: boolean
  /**
   * True when the agent's live command catalog is reachable — the dashboard is
   * up AND the `commands.catalog` JSON-RPC over `/api/ws` actually answered.
   *
   * Deliberately NOT a route-presence probe: unlike `probeConductor()` /
   * `probeEnhancedChatStream()` below, there is no HTTP status to read here
   * and a 401 equivalent (WS close 4401) means the credential was rejected,
   * so nothing would work at runtime either. The only honest signal is a
   * successful round trip, which is what `probeAgentCommands()` requires.
   * Everything degrades to `false` when the dashboard is absent — the slash
   * menu then falls back to its hardcoded local commands. See
   * `docs/plans/hermes-slash-commands-in-switchui.md` §5 step 9.
   */
  agentCommands: boolean
}

export type DashboardCapabilities = {
  dashboard: {
    available: boolean
    url: string
  }
}

/** Full capabilities — backward compat with existing code */
export type GatewayCapabilities = CoreCapabilities &
  EnhancedCapabilities &
  DashboardCapabilities

export type GatewayMode =
  | 'zero-fork'
  | 'enhanced-fork'
  | 'portable'
  | 'disconnected'

export type ChatMode = 'enhanced-claude' | 'portable' | 'disconnected'

export type ConnectionStatus =
  | 'connected'
  | 'enhanced'
  | 'partial'
  | 'disconnected'

// ── State ─────────────────────────────────────────────────────────

let capabilities: GatewayCapabilities = {
  health: false,
  chatCompletions: false,
  chatCompletionsRouteExists: false,
  models: false,
  streaming: false,
  authError: false,
  sessions: false,
  enhancedChat: false,
  skills: false,
  memory: false,
  config: false,
  jobs: false,
  mcp: false,
  mcpFallback: false,
  conductor: false,
  kanban: false,
  projects: false,
  agentCommands: false,
  dashboard: {
    available: false,
    url: CLAUDE_DASHBOARD_URL,
  },
  probed: false,
}

let probePromise: Promise<GatewayCapabilities> | null = null
let lastProbeAt = 0
let lastLoggedSummary = ''
let dashboardTokenPromise: Promise<string> | null = null
let dashboardTokenCache = ''

/** Optional bearer token for authenticated gateway endpoints. */
function readHermesEnvValue(name: string): string {
  try {
    const envPath = path.join(hermesHome(), '.env')
    if (!fs.existsSync(envPath)) return ''
    const raw = fs.readFileSync(envPath, 'utf-8')
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq <= 0) continue
      if (trimmed.slice(0, eq).trim() !== name) continue
      return trimmed
        .slice(eq + 1)
        .trim()
        .replace(/^['"]|['"]$/g, '')
    }
  } catch {
    // Missing/unreadable ~/.hermes/.env is valid for unauthenticated gateways.
  }
  return ''
}

export const BEARER_TOKEN =
  process.env.HERMES_API_TOKEN ||
  process.env.CLAUDE_API_TOKEN ||
  readHermesEnvValue('API_SERVER_KEY')

/**
 * Optional explicit bearer token for dashboard API calls.
 *
 * Preferred over scraping the dashboard's root HTML for an inline token
 * (the legacy path, which creates a brittle trust boundary — see #124).
 * When set, the workspace uses this directly and never parses HTML.
 *
 * NOTE: do NOT fall back to CLAUDE_API_TOKEN here. The gateway and the
 * upstream Hermes Agent dashboard use independent token schemes — the gateway
 * accepts a long-lived bearer (CLAUDE_API_TOKEN), while the dashboard
 * issues an ephemeral session token at boot (web_server.py:_SESSION_TOKEN).
 * Treating them as interchangeable wedges the workspace into 401 loops on
 * /api/sessions, /api/skills, etc. against the official dashboard. If
 * CLAUDE_DASHBOARD_TOKEN isn't set, leave this empty and let
 * fetchDashboardToken() fall through to the HTML-scrape legacy path.
 */
const DASHBOARD_BEARER_TOKEN =
  process.env.HERMES_DASHBOARD_TOKEN || process.env.CLAUDE_DASHBOARD_TOKEN || ''

function authHeaders(): Record<string, string> {
  return BEARER_TOKEN ? { Authorization: `Bearer ${BEARER_TOKEN}` } : {}
}

let loggedHtmlScrapeFallback = false

/**
 * Resolve a bearer token for dashboard API calls.
 *
 * Lookup order:
 *   1. CLAUDE_DASHBOARD_TOKEN / CLAUDE_API_TOKEN env (preferred)
 *   2. Inline token injected into the dashboard's root HTML (legacy
 *      fallback — logs a deprecation warning; to be removed once all
 *      supported dashboards expose a first-class token endpoint). See #124.
 */
export async function fetchDashboardToken(options?: {
  force?: boolean
}): Promise<string> {
  const force = options?.force === true

  // Prefer the explicit service-to-service token — no HTML scrape at all.
  if (DASHBOARD_BEARER_TOKEN) {
    dashboardTokenCache = DASHBOARD_BEARER_TOKEN
    return DASHBOARD_BEARER_TOKEN
  }

  if (!force && dashboardTokenCache) return dashboardTokenCache
  if (!force && dashboardTokenPromise) return dashboardTokenPromise

  dashboardTokenPromise = (async () => {
    if (!loggedHtmlScrapeFallback) {
      loggedHtmlScrapeFallback = true
      console.warn(
        '[gateway] CLAUDE_DASHBOARD_TOKEN is not set — falling back to the legacy ' +
          'HTML-scrape token flow. This fallback will be removed in a future release. ' +
          'Set CLAUDE_DASHBOARD_TOKEN (or CLAUDE_API_TOKEN) to a dashboard bearer ' +
          'token to migrate. See #124.',
      )
    }
    // Dashboard injects the session token inline on `/` (root), not on
    // `/index.html` which serves the raw Vite-built HTML without the token.
    const res = await fetch(`${CLAUDE_DASHBOARD_URL}/`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (!res.ok) {
      throw new Error(`Dashboard index failed: ${res.status}`)
    }
    const html = await res.text()
    const token = html.match(DASHBOARD_TOKEN_REGEX)?.[1]?.trim() || ''
    if (!token) {
      throw new Error('Dashboard session token not found in root HTML')
    }
    dashboardTokenCache = token
    return token
  })()

  try {
    return await dashboardTokenPromise
  } finally {
    dashboardTokenPromise = null
  }
}

export async function getDashboardToken(options?: {
  force?: boolean
}): Promise<string> {
  return fetchDashboardToken(options)
}

export async function dashboardAuthHeaders(options?: {
  force?: boolean
}): Promise<Record<string, string>> {
  const token = await getDashboardToken(options)
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function withDashboardBase(requestPath: string): string {
  if (/^https?:\/\//i.test(requestPath)) return requestPath
  return `${CLAUDE_DASHBOARD_URL}${requestPath.startsWith('/') ? requestPath : `/${requestPath}`}`
}

function dashboardFailureReason(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError')
    return 'aborted'
  if (error instanceof Error && error.name === 'TimeoutError') return 'timeout'
  return 'network-or-auth'
}

function dashboardUnavailableResponse(error: unknown): Response {
  const reason = dashboardFailureReason(error)
  return new Response(
    JSON.stringify({
      ok: false,
      error: 'Dashboard unavailable',
      mode: 'dashboard-unavailable',
      reason,
      dashboardUrl: CLAUDE_DASHBOARD_URL,
    }),
    {
      status: 503,
      headers: {
        'content-type': 'application/json',
        'x-hermes-dashboard-error': reason,
      },
    },
  )
}

export async function dashboardFetch(
  requestPath: string,
  init: RequestInit = {},
): Promise<Response> {
  const dashboardPath = withDashboardBase(requestPath)
  const method = (init.method || 'GET').toUpperCase()
  const hasCallerAuthorization = new Headers(init.headers).has('Authorization')
  const doFetch = async (forceToken = false) => {
    try {
      const headers = new Headers(init.headers)
      const isProtected =
        dashboardPath.includes('/api/') &&
        !dashboardPath.endsWith('/api/status') &&
        !dashboardPath.endsWith('/api/config/defaults') &&
        !dashboardPath.endsWith('/api/config/schema') &&
        !dashboardPath.endsWith('/api/model/info') &&
        !dashboardPath.endsWith('/api/dashboard/themes') &&
        !dashboardPath.endsWith('/api/dashboard/plugins') &&
        !dashboardPath.endsWith('/api/dashboard/plugins/rescan')

      if (isProtected && !headers.has('Authorization')) {
        const auth = await dashboardAuthHeaders({ force: forceToken })
        for (const [key, value] of Object.entries(auth)) {
          headers.set(key, value)
        }
      }

      return await fetch(dashboardPath, {
        ...init,
        method,
        headers,
      })
    } catch (error) {
      return dashboardUnavailableResponse(error)
    }
  }

  let res = await doFetch(false)
  if (res.status === 401 && !hasCallerAuthorization) {
    dashboardTokenCache = ''
    res = await doFetch(true)
  }
  return res
}

/**
 * Lightweight fetch helper that targets the gateway base URL
 * (`CLAUDE_API`, e.g. http://127.0.0.1:8645). Used for endpoints that
 * live on the gateway runtime rather than the dashboard, like
 * `/health/detailed`.
 */
export async function gatewayFetch(
  requestPath: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = /^https?:\/\//i.test(requestPath)
    ? requestPath
    : `${CLAUDE_API}${requestPath.startsWith('/') ? requestPath : `/${requestPath}`}`
  const headers = new Headers(init.headers)
  for (const [k, v] of Object.entries(authHeaders())) {
    if (!headers.has(k)) headers.set(k, v)
  }
  return fetch(url, { ...init, headers })
}

// ── Probing ───────────────────────────────────────────────────────

async function probe(requestPath: string): Promise<boolean> {
  try {
    const res = await fetch(`${CLAUDE_API}${requestPath}`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (res.status === 404 || res.status === 403) return false
    return true
  } catch {
    return false
  }
}

/**
 * Health probe backing the user-facing "gateway available" / connected
 * status (`gateway-status.ts`'s `gateway.available`, the restart banner, the
 * dashboard-unavailable banner). Deliberately NOT built on the generic
 * capability-PRESENCE `probe()` above.
 *
 * `probe()`'s "401 counts as available" is correct for capability-presence
 * probes like `probeEnhancedChatStream()` / `probeConductor()` below, where a
 * 401 PROVES the route is registered (a vanilla/unauthenticated gateway
 * would 404 instead) — the caller only cares whether the surface exists.
 * Here a 401 means something different and worse: THIS workspace's own
 * bearer token (`HERMES_API_TOKEN` / `API_SERVER_KEY`) does not match what
 * THIS gateway process expects. The gateway is up, but every authenticated
 * request will also 401 — that is not "connected". Reusing `probe()` here is
 * exactly what let a token mismatch render as "Connected" while the user was
 * pointed at "check your API key in Settings" (the wrong secret — that's the
 * provider key, not the gateway token — on a screen that doesn't even exist
 * for this). See W3 audit item 5.
 */
async function probeHealth(): Promise<{ healthy: boolean; authError: boolean }> {
  try {
    const res = await fetch(`${CLAUDE_API}/health`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (res.status === 401) return { healthy: false, authError: true }
    if (res.status === 404 || res.status === 403) {
      return { healthy: false, authError: false }
    }
    return { healthy: true, authError: false }
  } catch {
    return { healthy: false, authError: false }
  }
}

/**
 * Stricter probe for the legacy enhanced chat-stream endpoint.
 *
 * The previous probe used a generic GET and treated any non-404/403 status
 * as "available". That misclassified vanilla hermes-agent (which serves a
 * router-level handler that 405s/400s GETs to that path) as having the
 * enhanced fork's session-stream capability. Workspace then fell through
 * to streamChat() which posts to /api/sessions/{id}/chat/stream — vanilla
 * agent returns 404 there at runtime and chat appears to fail with
 * "Authentication error" because the bundle's error mapper is overly
 * generous about what it interprets as auth failures. See #261.
 *
 * Real enhanced-fork gateways respond to GET on the probe path with one
 * of: 405 Method Not Allowed (it's POST-only there too) but also expose
 * the path in their router; we cannot distinguish reliably from a generic
 * status code on GET, so we POST a tiny no-op body and look for a
 * structured error shape that only the fork emits.
 */
async function probeEnhancedChatStream(): Promise<boolean> {
  // Preferred signal: the gateway advertises its stable API surface at
  // GET /v1/capabilities. `features.session_chat_streaming` and the
  // `endpoints.session_chat_stream` entry authoritatively declare that the
  // enhanced session chat-stream path is registered — the ONLY path that
  // injects the interactive `clarify` tool. We trust this over the legacy
  // POST probe below.
  //
  // Why the legacy probe alone is wrong (the clarify-card bug): the probe
  // POSTs to a non-existent session `__probe__`, but the chat-stream handler
  // validates session existence FIRST and returns 404 *session-not-found*
  // before any other logic. The old code mapped that 404 to "route absent",
  // misclassifying a fully-capable gateway as vanilla → portable chat mode →
  // clarify never injected. See #261 and the clarify transport-path trace.
  try {
    const caps = await fetch(`${CLAUDE_API}/v1/capabilities`, {
      method: 'GET',
      headers: authHeaders(),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (caps.ok) {
      const body = (await caps.json().catch(() => null)) as {
        features?: Record<string, unknown>
        endpoints?: Record<string, unknown>
      } | null
      if (body && typeof body === 'object') {
        const featureOn = body.features?.session_chat_streaming === true
        const endpointListed =
          !!body.endpoints && 'session_chat_stream' in body.endpoints
        // Capabilities present and explicit: trust it either way (a gateway
        // that advertises caps but omits the session-stream surface is
        // genuinely vanilla).
        return featureOn || endpointListed
      }
    }
    // Non-OK (e.g. 401 auth-gated, 404 no caps endpoint on older gateways):
    // fall through to the legacy POST probe rather than downgrading here.
  } catch {
    // Network/timeout — fall through to the legacy probe.
  }

  // Fallback for gateways without /v1/capabilities: POST to the chat-stream
  // path and distinguish a structured fork 404 (session-not-found JSON, which
  // proves the ROUTE is registered) from a plain aiohttp router 404 (route
  // absent → vanilla).
  try {
    const res = await fetch(
      `${CLAUDE_API}/api/sessions/__probe__/chat/stream`,
      {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      },
    )
    if (res.status === 404) {
      // Route-not-found → plain-text "404: Not Found". Session-not-found →
      // JSON {error:{...}} emitted by the registered handler, which proves the
      // route exists. Discriminate on the body shape.
      const contentType = res.headers.get('content-type') || ''
      if (contentType.includes('application/json')) {
        const body = (await res.json().catch(() => null)) as {
          error?: unknown
        } | null
        return !!body && typeof body === 'object' && 'error' in body
      }
      return false
    }
    // 403 = forbidden (no such surface for this caller). 405 = path exists but
    // POST is wrong — no enhanced gateway 405s its own chat/stream endpoint.
    if (res.status === 403 || res.status === 405) return false
    // 401 means the auth gate is wired (surface exists); treat as available so
    // token-gated setups aren't downgraded by a missing token at probe time.
    return true
  } catch {
    return false
  }
}

/**
 * Probe for `/v1/chat/completions`.
 *
 * Distinguishes *route exists* from *usable*, mirroring `probeHealth()`
 * above (W3 audit item 5) — a 401 here proves the route is registered (a
 * vanilla/unauthenticated gateway would 404 instead), which is the correct
 * read for a capability-presence probe. But it does NOT mean this
 * workspace's bearer token (`HERMES_API_TOKEN` / `API_SERVER_KEY`) is
 * actually accepted: every real request will also 401 until the tokens
 * agree. The old code returned a single boolean and fell through to `true`
 * on 401, so `capabilities.chatCompletions` — which `chat-mode.ts`'s
 * `resolveChatBackend()` reads (via `getChatMode()`) to decide whether to
 * use the OpenAI-compatible transport — could read `true` under a token
 * mismatch and route chat traffic at a backend that will reject every
 * message. `exists` records the route-presence signal for anyone who wants
 * it; `authError` lets the caller gate usability on it separately.
 */
async function probeChatCompletions(): Promise<{
  exists: boolean
  authError: boolean
}> {
  try {
    const getRes = await fetch(`${CLAUDE_API}/v1/chat/completions`, {
      method: 'GET',
      headers: authHeaders(),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (getRes.status === 401) return { exists: true, authError: true }
    if (getRes.status === 405) return { exists: true, authError: false }
    if (getRes.ok) return { exists: true, authError: false }
    if (getRes.status === 400 || getRes.status === 422) {
      return { exists: true, authError: false }
    }
    if (getRes.status === 404) return { exists: false, authError: false }
    return { exists: true, authError: false }
  } catch {
    return { exists: false, authError: false }
  }
}

/**
 * Strict MCP capability probe.
 *
 * Per plan §Open Questions #4: probing `dashboard.available || /api/mcp` is
 * insufficient. The probe must hit `GET /api/mcp` directly and verify both:
 *   1. 200 OK
 *   2. Body parses through normalizeMcpList (i.e. shape is recognizable)
 * If the dashboard is up but `/api/mcp/servers` is absent (404) or returns a
 * malformed body, capability is `false`.
 */
async function probeMcp(): Promise<boolean> {
  const { normalizeMcpList } = await import('./mcp-normalize')
  const validate = async (res: Response): Promise<boolean> => {
    if (!res.ok) return false
    const body = (await res.json().catch(() => null)) as unknown
    if (body === null) return false
    // Empty list is a valid configured-zero state — still indicates the
    // endpoint is real. The shape check is "does the normalizer accept it
    // without throwing", which it does for `{servers: []}`, `[]`, etc.
    void normalizeMcpList(body)
    return true
  }
  // Use dashboardFetch so the probe goes through the same authenticated path
  // workspace routes use at runtime — otherwise an auth-protected dashboard
  // /api/mcp/servers would falsely report capability=false (Codex MAJOR finding).
  try {
    const res = await dashboardFetch('/api/mcp/servers', {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (await validate(res)) return true
  } catch {
    // fall through to gateway path
  }
  try {
    const res = await fetch(`${CLAUDE_API}/api/mcp/servers`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    return await validate(res)
  } catch {
    return false
  }
}

/**
 * Conservative loopback check. Returns true ONLY when:
 *   1. Both `CLAUDE_API` and `CLAUDE_DASHBOARD_URL` resolve to a loopback host
 *      (`127.0.0.1`, `::1`, or `localhost`).
 *   2. Workspace `HOST` env is unset OR loopback. Any non-loopback `HOST`
 *      (including `0.0.0.0`) disables fallback so we never silently expose a
 *      remote-deploy to plaintext config.yaml writes.
 *
 * On any parse failure we return false. Better to under-enable than to
 * silently enable on a remote deployment.
 */
export function isLocalhostDeployment(): boolean {
  const isLoopbackHost = (host: string): boolean => {
    const h = host.trim().toLowerCase()
    if (!h) return false
    return (
      h === '127.0.0.1' || h === '::1' || h === 'localhost' || h === '[::1]'
    )
  }
  const isLoopbackUrl = (raw: string): boolean => {
    try {
      const u = new URL(raw)
      return isLoopbackHost(u.hostname)
    } catch {
      return false
    }
  }
  const host = (process.env.HOST || '').trim()
  if (host && !isLoopbackHost(host)) return false
  return isLoopbackUrl(CLAUDE_API) && isLoopbackUrl(CLAUDE_DASHBOARD_URL)
}

/**
 * Probe whether the dashboard's `/api/config` payload is reachable and
 * parseable. We deliberately do NOT require an `mcp_servers` key to already
 * exist: a fresh install has no `mcp_servers` entry yet, and requiring it
 * locked the user out of the MCP page entirely (issue #185 — chicken-and-egg:
 * you can't add a server because the key is missing, and the key is missing
 * because you've never added a server). The config-fallback write path
 * (`readConfigServersMap` in routes/api/mcp.ts) creates `mcp_servers: {}` on
 * first write, so a reachable config is sufficient to safely expose CRUD.
 *
 * Used as part of the `mcpFallback` capability gate (still guarded by
 * `isLocalhostDeployment()` so remote deploys never get plaintext config writes).
 */
async function probeMcpConfigKey(): Promise<boolean> {
  try {
    const { getConfig } = await import('./claude-dashboard-api')
    // Reachable + parseable config is enough; the key is created on first write.
    await getConfig()
    return true
  } catch {
    return false
  }
}

async function probeDashboard(): Promise<{ available: boolean; url: string }> {
  // Fast path: probe root HTML first (<10ms). Avoids waiting 15s for /api/status
  // when Python SQLite locks or cold loads are active.
  try {
    const res = await fetch(`${CLAUDE_DASHBOARD_URL}/`, {
      signal: AbortSignal.timeout(3000),
    })
    if (res.ok) {
      const html = await res.text()
      const token = html.match(DASHBOARD_TOKEN_REGEX)?.[1]?.trim()
      if (token) {
        dashboardTokenCache = token
        return { available: true, url: CLAUDE_DASHBOARD_URL }
      }
      if (
        html.includes('__HERMES_SESSION_TOKEN__') ||
        html.includes('__CLAUDE_SESSION_TOKEN__') ||
        html.includes('Hermes Agent')
      ) {
        return { available: true, url: CLAUDE_DASHBOARD_URL }
      }
    }
  } catch {
    // Fall through to api/status below
  }

  try {
    const res = await fetch(`${CLAUDE_DASHBOARD_URL}/api/status`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { version?: string }
      if (body.version) {
        await fetchDashboardToken().catch(() => '')
        return { available: true, url: CLAUDE_DASHBOARD_URL }
      }
    }
  } catch {
    // Dashboard unavailable
  }

  return { available: false, url: CLAUDE_DASHBOARD_URL }
}

/**
 * Probe for the Hermes Agent Kanban plugin. Some deployments ship without
 * the Kanban plugin; those should show a BackendUnavailableState on /tasks.
 */
async function probeKanban(dashboardAvailable: boolean): Promise<boolean> {
  if (!dashboardAvailable) return false
  try {
    const res = await dashboardFetch('/api/plugins/kanban/board', {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (res.status === 404 || res.status === 405) return false
    return true
  } catch {
    return false
  }
}

/**
 * Lightweight probe for the Conductor mission endpoint. Some dashboard builds
 * ship without it; those deployments should show a graceful placeholder
 * instead of letting the Conductor UI 500. See #262.
 */
/**
 * Probe for the Hermes Agent Dashboard Projects plugin. Some deployments ship
 * without it; the Projects screen should show a BackendUnavailableState when
 * absent, same treatment as Kanban.
 */
async function probeProjects(dashboardAvailable: boolean): Promise<boolean> {
  if (!dashboardAvailable) return false
  try {
    const res = await dashboardFetch('/api/plugins/projects', {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (res.status === 404 || res.status === 405) return false
    return true
  } catch {
    return false
  }
}

/**
 * Probe for the agent's live command catalog over the dashboard's `/api/ws`
 * JSON-RPC sidecar.
 *
 * Strictly a round-trip probe — see the `agentCommands` field's doc comment
 * for why the "401 proves the route exists" shortcut the HTTP probes above use
 * is wrong here. Warming the shared 60s catalog cache is a deliberate side
 * effect: `GET /api/hermes-commands` then answers from cache on the first hit.
 *
 * The import is dynamic because `hermes-rpc` imports this module for
 * `CLAUDE_DASHBOARD_URL` / `dashboardFetch` / `getDashboardToken`; a static
 * import here would close the cycle at module-init time.
 */
async function probeAgentCommands(dashboardAvailable: boolean): Promise<boolean> {
  if (!dashboardAvailable) return false
  try {
    const { getHermesCommandCatalog } = await import('./hermes-commands')
    const catalog = await getHermesCommandCatalog({ force: true })
    return catalog.commands.length > 0
  } catch {
    return false
  }
}

async function probeConductor(dashboardAvailable: boolean): Promise<boolean> {
  if (!dashboardAvailable) return false
  try {
    const res = await dashboardFetch('/api/conductor/missions', {
      method: 'GET',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (res.status === 404 || res.status === 405) return false
    // 401 means the path exists but the auth token isn't accepted yet —
    // treat as available so token-gated setups don't hide the feature.
    return true
  } catch {
    return false
  }
}

// Vanilla hermes-agent 0.10.0 satisfies: health, chatCompletions, models, streaming,
// sessions, skills, config, jobs. Dashboard-only endpoints (themes/plugins) and the
// legacy enhanced-fork chat stream are optional — their absence should not emit the
// "Missing Hermes APIs detected" warning, which only applies to critical gaps.
/**
 * Capabilities whose absence is a degraded feature rather than a broken
 * install. Exported so the classification is testable: a capability missing
 * from this set makes the upgrade warning fire, and that warning tells the
 * user to reinstall the agent — useless advice when the agent is healthy and
 * merely lacks an optional plugin.
 */
export const OPTIONAL_APIS = new Set([
  'jobs',
  'chatCompletions',
  'streaming',
  'memory',
  'dashboard',
  'enhancedChat',
  'mcp',
  'mcpFallback',
  'kanban', // task board degrades gracefully when Agent Kanban plugin is absent
  'projects', // projects screen degrades gracefully when Projects plugin is absent
  // The slash menu falls back to its hardcoded local commands when the
  // dashboard's /api/ws catalog is unreachable — a degraded feature, not a
  // broken install, so it must not trigger "reinstall the agent".
  'agentCommands',
  // Conductor renders an 'upstream not ready' placeholder when the dashboard
  // does not expose /api/conductor/missions (see the `conductor` field's doc
  // comment and #262), so its absence is a degraded feature, not a broken
  // install. Omitting it here made the upgrade warning fire on a fully
  // healthy setup and tell the user to reinstall an agent that was already
  // running — the one thing they could do that would not help.
  'conductor',
])

function logCapabilities(next: GatewayCapabilities): void {
  const core: Array<string> = []
  const enhanced: Array<string> = []
  const missing: Array<string> = []

  const coreKeys: Array<keyof CoreCapabilities> = [
    'health',
    'chatCompletions',
    'models',
    'streaming',
  ]
  const enhancedKeys: Array<keyof EnhancedCapabilities> = [
    'sessions',
    'enhancedChat',
    'skills',
    'memory',
    'config',
    'jobs',
    'mcp',
    'mcpFallback',
    'conductor',
    'kanban',
    'projects',
    'agentCommands',
  ]

  for (const key of coreKeys) {
    ;(next[key] ? core : missing).push(key)
  }
  for (const key of enhancedKeys) {
    ;(next[key] ? enhanced : missing).push(key)
  }
  if (next.dashboard.available) core.push('dashboard')
  else missing.push('dashboard')

  const mode = getGatewayMode()
  const summary = `[gateway] gateway=${CLAUDE_API} dashboard=${next.dashboard.url} mode=${mode} core=[${core.join(', ')}] enhanced=[${enhanced.join(', ')}] missing=[${missing.join(', ')}]`
  if (summary === lastLoggedSummary) return
  lastLoggedSummary = summary
  console.log(summary)

  const criticalMissing = missing.filter((key) => !OPTIONAL_APIS.has(key))
  if (criticalMissing.length > 0 && (next.health || next.dashboard.available)) {
    console.warn(
      // Name the gaps. The bare form sent users to reinstall a healthy agent
      // without telling them which capability was actually absent.
      `[gateway] Missing Hermes APIs detected: ${criticalMissing.join(', ')}. ${CLAUDE_UPGRADE_INSTRUCTIONS}`,
    )
  }
}

async function autoDetectGatewayUrl(): Promise<void> {
  if (process.env.HERMES_API_URL || process.env.CLAUDE_API_URL) return

  const candidates = [
    'http://127.0.0.1:8642',
    'http://127.0.0.1:8643',
    'http://127.0.0.1:8645',
  ]

  for (const candidate of candidates) {
    try {
      const res = await fetch(`${candidate}/health`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
      if (res.ok) {
        CLAUDE_API = candidate
        console.log(`[gateway] Connected to Hermes gateway at ${CLAUDE_API}`)
        return
      }
    } catch {
      // continue
    }
  }

  console.warn(
    '[gateway] Could not reach Hermes gateway on 8645, 8642, or 8643. ' +
      'If you run the workspace on a different machine (Tailscale / VPN / LAN), ' +
      'set HERMES_API_URL=http://<reachable-host>:8642 in .env and restart. ' +
      'Also set API_SERVER_HOST=0.0.0.0 on the gateway so remote peers can connect.',
  )
}

async function autoDetectDashboardUrl(): Promise<void> {
  if (process.env.HERMES_DASHBOARD_URL || process.env.CLAUDE_DASHBOARD_URL) return

  const candidates = ['http://127.0.0.1:9119']
  for (const candidate of candidates) {
    try {
      const res = await fetch(`${candidate}/api/status`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
      if (res.ok) {
        CLAUDE_DASHBOARD_URL = candidate
        return
      }
    } catch {
      // continue
    }
  }
}

export async function probeGateway(options?: {
  force?: boolean
}): Promise<GatewayCapabilities> {
  if (probePromise) {
    return probePromise
  }
  const force = options?.force === true
  if (!force && capabilities.probed) {
    return capabilities
  }

  probePromise = (async () => {
    await Promise.all([autoDetectGatewayUrl(), autoDetectDashboardUrl()])

    // A re-probe is the moment we already suspect the agent changed under us —
    // it is what the UI's "Reconnect" runs, and what the stale-TTL path runs
    // after a restart. Drop the cached agent version here so the slash-command
    // floor (`hermes-slash-policy.ts`) re-reads it instead of carrying a
    // version from the previous process for up to its own TTL. Dynamic import
    // because `hermes-agent-version` imports `CLAUDE_DASHBOARD_URL` from this
    // module — the same cycle `probeAgentCommands` avoids the same way.
    await import('./hermes-agent-version')
      .then((mod) => mod.invalidateAgentVersion())
      .catch(() => {})

    const dashboard = await probeDashboard()

    const [
      healthResult,
      chatCompletionsResult,
      models,
      legacySessions,
      enhancedChat,
      legacySkills,
      legacyConfig,
      legacyJobs,
    ] = await Promise.all([
      probeHealth(),
      probeChatCompletions(),
      probe('/v1/models'),
      dashboard.available ? Promise.resolve(false) : probe('/api/sessions'),
      probeEnhancedChatStream(),
      dashboard.available ? Promise.resolve(false) : probe('/api/skills'),
      dashboard.available ? Promise.resolve(false) : probe('/api/config'),
      dashboard.available ? Promise.resolve(false) : probe('/api/jobs'),
    ])
    const health = healthResult.healthy
    const chatCompletionsRouteExists = chatCompletionsResult.exists
    // Usable, not merely present: a 401 proves the route is registered but
    // must not mark chat completions usable, or transport selection
    // (chat-mode.ts's resolveChatBackend()) will route traffic at a backend
    // that rejects every request under a token mismatch.
    const chatCompletions =
      chatCompletionsResult.exists && !chatCompletionsResult.authError
    const authError = healthResult.authError || chatCompletionsResult.authError

    // Strict MCP probe runs after dashboard probe so dashboard token
    // resolution (in-page HTML scrape fallback) has had a chance to populate
    // the cache when the dashboard is up.
    const mcp = await probeMcp()

    // Conductor and Kanban probes run after dashboard probe.
    const conductor = await probeConductor(dashboard.available)
    const kanban = await probeKanban(dashboard.available)
    const projects = await probeProjects(dashboard.available)
    const agentCommands = await probeAgentCommands(dashboard.available)

    // Phase 1.5 fallback: when native /api/mcp is missing but the dashboard
    // exposes `config.mcp_servers` AND we are loopback-only, allow a config
    // -backed CRUD path. Test/Discover/Logs remain disabled in this mode.
    const dashboardConfigAvailable = dashboard.available || legacyConfig
    const mcpFallback =
      !mcp &&
      dashboard.available &&
      dashboardConfigAvailable &&
      isLocalhostDeployment() &&
      (await probeMcpConfigKey())

    capabilities = {
      health,
      chatCompletions,
      chatCompletionsRouteExists,
      models,
      streaming: chatCompletions,
      probed: true,
      authError,
      sessions: dashboard.available || legacySessions,
      enhancedChat,
      skills: dashboard.available || legacySkills,
      // Memory is always available: workspace reads $HERMES_HOME/MEMORY.md +
      // memory/*.md + memories/*.md directly from the local filesystem.
      // No remote gateway endpoint is required.
      memory: true,
      config: dashboard.available || legacyConfig,
      jobs: dashboard.available || legacyJobs,
      mcp,
      mcpFallback,
      conductor,
      kanban,
      projects,
      agentCommands,
      dashboard,
    }
    lastProbeAt = Date.now()
    logCapabilities(capabilities)
    return capabilities
  })()

  try {
    return await probePromise
  } finally {
    probePromise = null
  }
}

export async function ensureGatewayProbed(): Promise<GatewayCapabilities> {
  const isStale = Date.now() - lastProbeAt > effectiveProbeTtl(capabilities)
  if (!capabilities.probed || isStale) {
    return probeGateway({ force: isStale })
  }
  return capabilities
}

/**
 * Force-reprobe regardless of TTL. Used by the UI 'Reconnect' action
 * and by any tool that wants to validate the current state immediately
 * (for example after a docker compose restart). See #275.
 */
export async function forceReprobeGateway(): Promise<GatewayCapabilities> {
  return probeGateway({ force: true })
}

// ── Accessors ─────────────────────────────────────────────────────

export function getCapabilities(): GatewayCapabilities {
  return capabilities
}

export function getCoreCapabilities(): CoreCapabilities {
  return {
    health: capabilities.health,
    chatCompletions: capabilities.chatCompletions,
    chatCompletionsRouteExists: capabilities.chatCompletionsRouteExists,
    models: capabilities.models,
    streaming: capabilities.streaming,
    probed: capabilities.probed,
    authError: capabilities.authError,
  }
}

export function getEnhancedCapabilities(): EnhancedCapabilities {
  return {
    sessions: capabilities.sessions,
    enhancedChat: capabilities.enhancedChat,
    skills: capabilities.skills,
    memory: capabilities.memory,
    config: capabilities.config,
    jobs: capabilities.jobs,
    mcp: capabilities.mcp,
    mcpFallback: capabilities.mcpFallback,
    conductor: capabilities.conductor,
    kanban: capabilities.kanban,
    projects: capabilities.projects,
    agentCommands: capabilities.agentCommands,
  }
}

export function getGatewayMode(): GatewayMode {
  // 'zero-fork' requires the optional dashboard plugin bundle; 'enhanced' is
  // granted whenever the core enhanced-chat endpoints are present — which
  // vanilla hermes-agent (≥0.10) satisfies. The label 'enhanced-fork' is
  // legacy copy from the 2025-era fork and does NOT imply an actual fork is
  // required. We keep the value for backwards compatibility with UI code.
  if (capabilities.dashboard.available && capabilities.chatCompletions) {
    return 'zero-fork'
  }
  if (capabilities.sessions && capabilities.enhancedChat) {
    return 'enhanced-fork'
  }
  if (capabilities.chatCompletions || capabilities.health) return 'portable'
  return 'disconnected'
}

/**
 * UI-facing chat transport mode:
 * - enhanced-claude: legacy fork session streaming API available
 * - portable: OpenAI-compatible /v1/chat/completions transport
 * - disconnected: no usable chat backend
 */
export function getChatMode(): ChatMode {
  if (capabilities.enhancedChat) return 'enhanced-claude'
  if (capabilities.chatCompletions || capabilities.health) return 'portable'
  return 'disconnected'
}

export function getConnectionStatus(): ConnectionStatus {
  if (!capabilities.health && !capabilities.chatCompletions) {
    return capabilities.dashboard.available ? 'partial' : 'disconnected'
  }
  const enhanced =
    (capabilities.dashboard.available || capabilities.sessions) &&
    capabilities.skills &&
    capabilities.config
  if (enhanced) return 'enhanced'
  if (capabilities.chatCompletions || capabilities.sessions) return 'partial'
  return 'connected'
}

export function isClaudeConnected(): boolean {
  return capabilities.health || capabilities.dashboard.available
}

// Skip the gateway probe + plugin-sync heartbeat during build/prerender.
// ensureHermesPluginSync() starts a setInterval heartbeat that keeps the
// process alive, so at build time (TanStack prerender) the build never exits —
// it hangs, hardest in CI where no gateway is reachable. Runtime (`pnpm start`,
// dev) leaves the flag unset and boots these normally.
if (!process.env.HERMES_SKIP_GATEWAY_BOOT) {
  void ensureGatewayProbed().catch((err) => {
    console.error('[gateway] boot probe failed:', err)
  })
  void import('./hermes-plugin-sync')
    .then(({ ensureHermesPluginSync }) => {
      ensureHermesPluginSync()
    })
    .catch((err) => {
      // Includes the TDZ ReferenceError from the gateway-capabilities ⇄
      // hermes-plugin-sync import cycle (#354). Logged, not swallowed —
      // without this it surfaces as an unhandled rejection attributed to
      // whatever module happened to be evaluating nearby.
      console.error('[gateway] plugin-sync boot failed:', err)
    })
}
