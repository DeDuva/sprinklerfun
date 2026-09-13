import type {
  ConfigDocument,
  ConfigPayload,
  DelayRecommendation,
  FlumeRow,
  RollupRow,
  StatsPayload,
} from "./types"

// ---------------------------------------------------------------------------
// Client-side bridge to the Turso backend.
//
// Nothing here carries a credential. The session is an httpOnly cookie set by
// the Google callback (/api/auth/callback) and checked in proxy.ts, so the
// browser attaches it to these requests automatically and JavaScript cannot
// read it. Two versions ago this app shipped its write secret to the client as
// NEXT_PUBLIC_APP_SHARED_SECRET, which Next inlined into a static chunk — the
// credential was in the bundle, readable by anyone who loaded the page.
//
// What every helper does have to handle is a 401, which here means the cookie
// expired or the password was rotated. Half a dozen empty charts and a console
// error is a bad way to learn that; `toLogin()` sends the browser to the login
// page with a way back instead.
// ---------------------------------------------------------------------------

export interface PushResult {
  ok: boolean
  received?: number
  inserted?: number
  rollupDays?: number
  error?: string
}

function toLogin(): never {
  if (typeof window !== "undefined") {
    const login = new URL("/login", window.location.origin)
    login.searchParams.set("next", window.location.pathname + window.location.search)
    // A full document load rather than a router push: this is not a component,
    // there is no router here, and every page's data has just been refused —
    // starting over is what is wanted. Absolute URL because assign() with a
    // relative one is ambiguous under a basePath (and ESLint says so).
    window.location.assign(login.toString())
  }
  throw new Error("unauthorized — session expired")
}

// Ingest raw rows. Rows only: config travels through PUT /api/config now, and
// sending `windows` here is rejected with a 400 rather than ignored, so an old
// client fails loudly instead of appearing to save a config that went nowhere.
export async function pushRows(rows: FlumeRow[]): Promise<PushResult> {
  try {
    const res = await fetch("/api/rows", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rows }),
    })
    if (res.status === 401) toLogin()
    const data = (await res.json()) as PushResult
    if (!res.ok) return { ok: false, error: data.error ?? `HTTP ${res.status}` }
    return { ...data, ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// ---------------------------------------------------------------------------
// Config: read and write the server's copy, which is now the only copy.
//
// syncWindows() used to live here — a best-effort, debounced mirror of
// localStorage into a table nothing read back. It is gone along with the second
// source of truth. These two are ordinary request/response instead: the page
// cannot render config it has not fetched, and a failed save is an error the
// user sees rather than a silent divergence between two devices.
// ---------------------------------------------------------------------------

export async function fetchConfig(): Promise<ConfigPayload> {
  const res = await fetch("/api/config")
  if (res.status === 401) toLogin()
  if (!res.ok) throw new Error(`GET /api/config → HTTP ${res.status}`)
  return (await res.json()) as ConfigPayload
}

// Throws on failure — deliberately. Every caller is a user action with a save
// button behind it, and the store leaves its state untouched when this rejects,
// so a failed write shows the previous config rather than a local edit that
// exists nowhere but this tab.
export async function saveConfig(doc: ConfigDocument): Promise<ConfigPayload> {
  const res = await fetch("/api/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(doc),
  })
  if (res.status === 401) toLogin()
  if (!res.ok) {
    const detail = await res
      .json()
      .then((d: { error?: string }) => d.error)
      .catch(() => null)
    throw new Error(detail ?? `PUT /api/config → HTTP ${res.status}`)
  }
  return (await res.json()) as ConfigPayload
}

// The dashboard's consumption chart + monthly summary read these per-day/
// per-station aggregates instead of the full per-minute series.
export async function fetchRollups(from?: string, to?: string): Promise<RollupRow[]> {
  const qs = new URLSearchParams()
  if (from) qs.set("from", from)
  if (to) qs.set("to", to)
  const suffix = qs.toString() ? `?${qs}` : ""
  const res = await fetch(`/api/rollup${suffix}`)
  if (res.status === 401) toLogin()
  if (!res.ok) throw new Error(`GET /api/rollup → HTTP ${res.status}`)
  const data = (await res.json()) as { rollups: RollupRow[] }
  return data.rollups
}

// The precomputed per-minute-only aggregates: fleet gpm stats + baseline
// warnings + total row count.
export async function fetchStats(): Promise<StatsPayload> {
  const res = await fetch("/api/stats")
  if (res.status === 401) toLogin()
  if (!res.ok) throw new Error(`GET /api/stats → HTTP ${res.status}`)
  return (await res.json()) as StatsPayload
}

// The inferred inter-station delay per timer, fitted server-side across several
// recent sprinkler days (the browser only ever holds one day of per-minute flow).
export async function fetchDelayRecommendations(days?: number): Promise<DelayRecommendation[]> {
  const suffix = days ? `?days=${days}` : ""
  const res = await fetch(`/api/delay${suffix}`)
  if (res.status === 401) toLogin()
  if (!res.ok) throw new Error(`GET /api/delay → HTTP ${res.status}`)
  const data = (await res.json()) as { recommendations: DelayRecommendation[] }
  return data.recommendations
}

// Fetch one day's raw rows (for the day-detail / flow / reconciliation views).
export async function fetchDayRows(date: string): Promise<FlumeRow[]> {
  const res = await fetch(`/api/day/${date}`)
  if (res.status === 401) toLogin()
  if (!res.ok) throw new Error(`GET /api/day/${date} → HTTP ${res.status}`)
  const data = (await res.json()) as { rows: FlumeRow[] }
  return data.rows
}

// Sign out: expire the session cookie. The session is not stored server-side,
// so this is the whole of it. It deliberately does not sign the person out of
// Google — leaving this app should not log you out of your mail.
export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "DELETE" })
}

export interface SyncResponse {
  ok: boolean
  inserted: number
  corrected: number
  rollupDays: number
  error?: string
  rateLimited?: boolean
}

// Ask the server to pull new readings from Flume now. The same job the daily
// cron runs; this is the "I want it now" path. A 503 means no Flume credentials
// are configured on this deployment, which is a normal state, not an error.
export async function syncFlumeNow(): Promise<SyncResponse> {
  const res = await fetch("/api/sync", { method: "POST" })
  if (res.status === 401) toLogin()
  const body = (await res.json().catch(() => ({}))) as Partial<SyncResponse>
  if (res.status === 503) {
    return { ok: false, inserted: 0, corrected: 0, rollupDays: 0, error: body.error ?? "Flume is not configured" }
  }
  return {
    ok: body.ok ?? false,
    inserted: body.inserted ?? 0,
    corrected: body.corrected ?? 0,
    rollupDays: body.rollupDays ?? 0,
    error: body.error,
    rateLimited: body.rateLimited,
  }
}

// Clear the metered data (rows + the three derived tables). The config timeline
// and maintenance flags are untouched — see the route for why.
//
// This helper was removed when the endpoint was, because the endpoint was
// guarded by a secret published in this very bundle. It comes back now that the
// guard is a real session rather than a decoration. The typed confirmation in
// the UI is the second lock, not the first.
export async function clearAllRows(): Promise<void> {
  const res = await fetch("/api/rows", { method: "DELETE" })
  if (res.status === 401) toLogin()
  if (!res.ok) throw new Error(`DELETE /api/rows → HTTP ${res.status}`)
}
