import type { ConfigWindow, FlumeRow } from "./types"

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

export async function pushRows(
  rows: FlumeRow[],
  windows: ConfigWindow[]
): Promise<PushResult> {
  try {
    const res = await fetch("/api/rows", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(SECRET ? { "x-sprinkler-secret": SECRET } : {}),
      },
      body: JSON.stringify({ rows, windows }),
    })
    const data = (await res.json()) as PushResult
    if (!res.ok) return { ok: false, error: data.error ?? `HTTP ${res.status}` }
    return { ...data, ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
