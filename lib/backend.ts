import type { ConfigWindow, FlumeRow, RollupRow, StatsPayload } from "./types"

// ---------------------------------------------------------------------------
// Client-side bridge to the Turso backend (Phase 1 dual-write).
//
// During Phase 1, localStorage remains the source of truth and the UI reads
// from it as before. On every CSV upload the client also POSTs the rows (plus
// the current window set) to /api/rows so the server DB is populated in
// parallel. This is best-effort: a backend failure must never block the local
// flow, so callers fire-and-forget and we surface only a soft warning.
//
// Note: exposing a secret to the browser isn't real auth — the client is still
// the source of truth in Phase 1, so this is intentionally lightweight. Real
// write protection lands once the server becomes authoritative (later phase),
// via deployment protection / a server-side session rather than this header.
// ---------------------------------------------------------------------------

const SECRET = process.env.NEXT_PUBLIC_APP_SHARED_SECRET

export interface PushResult {
  ok: boolean
  received?: number
  inserted?: number
  rollupDays?: number
  error?: string
}

function authHeaders(): Record<string, string> {
  return SECRET ? { "x-sprinkler-secret": SECRET } : {}
}

export async function pushRows(
  rows: FlumeRow[],
  windows: ConfigWindow[]
): Promise<PushResult> {
  try {
    const res = await fetch("/api/rows", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ rows, windows }),
    })
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
  if (!res.ok) throw new Error(`GET /api/rollup → HTTP ${res.status}`)
  const data = (await res.json()) as { rollups: RollupRow[] }
  return data.rollups
}

// The precomputed per-minute-only aggregates: fleet gpm stats + baseline
// warnings + total row count.
export async function fetchStats(): Promise<StatsPayload> {
  const res = await fetch("/api/stats")
  if (!res.ok) throw new Error(`GET /api/stats → HTTP ${res.status}`)
  return (await res.json()) as StatsPayload
}

// Fetch one day's raw rows (for the day-detail / flow / reconciliation views).
export async function fetchDayRows(date: string): Promise<FlumeRow[]> {
  const res = await fetch(`/api/day/${date}`)
  if (!res.ok) throw new Error(`GET /api/day/${date} → HTTP ${res.status}`)
  const data = (await res.json()) as { rows: FlumeRow[] }
  return data.rows
}

// Clear all rows + rollups on the server.
export async function clearAllRows(): Promise<PushResult> {
  try {
    const res = await fetch("/api/rows", { method: "DELETE", headers: authHeaders() })
    const data = (await res.json()) as PushResult
    if (!res.ok) return { ok: false, error: data.error ?? `HTTP ${res.status}` }
    return { ...data, ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
