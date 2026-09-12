import type { ConfigWindow, DelayRecommendation, FlumeRow, RollupRow, StatsPayload } from "./types"

// ---------------------------------------------------------------------------
// Client-side bridge to the Turso backend.
//
// Nothing here carries a credential. The session is an httpOnly cookie set by
// POST /api/login and checked in proxy.ts, so the browser attaches it to these
// requests automatically and JavaScript cannot read it. That is the whole point
// of the change: the previous version shipped the write secret to the client as
// NEXT_PUBLIC_APP_SHARED_SECRET, which Next inlined into a static chunk.
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

export async function pushRows(
  rows: FlumeRow[],
  windows: ConfigWindow[]
): Promise<PushResult> {
  try {
    const res = await fetch("/api/rows", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rows, windows }),
    })
    if (res.status === 401) toLogin()
    const data = (await res.json()) as PushResult
    if (!res.ok) return { ok: false, error: data.error ?? `HTTP ${res.status}` }
    return { ...data, ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Mirror the current window set to the server and trigger a rollup + stats
// recompute, WITHOUT ingesting any new rows. Config windows are client-owned
// (localStorage), but the server computes rollups/stats from its own mirror of
// them — so every window edit must resync or the dashboard's server-derived
// reads go stale. Reuses POST /api/rows (rows: []), which already mirrors
// windows + recomputes. Best-effort; returns the same PushResult shape.
export async function syncWindows(windows: ConfigWindow[]): Promise<PushResult> {
  return pushRows([], windows)
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

// Log out: expire the session cookie. The session is not stored server-side, so
// this is the whole of it.
export async function logout(): Promise<void> {
  await fetch("/api/login", { method: "DELETE" })
}

// There is deliberately no clearAllRows(). DELETE /api/rows was removed: it
// dropped four tables in one batch behind a header whose value was published in
// the client bundle. Now that there is a real login, restoring it is a decision
// to make on its own merits rather than a leftover. See SECURITY.md and
// docs/RUNBOOK.md.
