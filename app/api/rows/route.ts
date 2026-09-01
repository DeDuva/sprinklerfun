import type { NextRequest } from "next/server"
import { isAuthorized } from "@/lib/server/auth"
import {
  insertRows,
  replaceWindows,
  recomputeRollups,
  recomputeStats,
  rowDateBounds,
} from "@/lib/server/data"
import type { ConfigWindow, FlumeRow } from "@/lib/types"

// libSQL's node client uses native bindings — must run on the Node.js runtime,
// not edge. Never cache: this is a write endpoint.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// This deployment is public and, by decision, writable — see SECURITY.md. The
// header check is obfuscation, not authentication, because the value is
// published in the client bundle. Everything below is therefore blast-radius
// reduction: bound what a single request can do, and refuse the shapes that
// destroy data rather than add it.

// One upload is a CSV export, not a firehose. At 1-minute resolution 200k rows
// is ~139 days. The cap matters because recomputeStats() re-reads and re-enriches
// the ENTIRE table on every write, so an unbounded body is a cheap amplification
// lever against the Turso read quota.
const MAX_ROWS = 200_000

// Flume reports gallons-per-minute. Anything outside this is a meter fault or a
// hostile payload, and either way it would poison avg/std/warnings downstream.
const MAX_GALLONS_PER_MINUTE = 1_000

// "YYYY-MM-DD HH:MM:SS" or ISO. The date prefix is what matters: `flume_rows`
// is indexed on substr(datetime, 1, 10) and rowDateBounds() takes a lexicographic
// MIN/MAX over the raw string, so a malformed prefix silently corrupts both.
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?/

function isFlumeRow(v: unknown): v is FlumeRow {
  if (typeof v !== "object" || v === null) return false
  const r = v as FlumeRow
  return (
    typeof r.datetime === "string" &&
    DATETIME_RE.test(r.datetime) &&
    typeof r.gallons === "number" &&
    Number.isFinite(r.gallons) &&
    r.gallons >= 0 &&
    r.gallons <= MAX_GALLONS_PER_MINUTE
  )
}

function isConfigWindow(v: unknown): v is ConfigWindow {
  if (typeof v !== "object" || v === null) return false
  const w = v as ConfigWindow
  return (
    typeof w.id === "string" && w.id.length > 0 &&
    typeof w.effectiveFrom === "string" && /^\d{4}-\d{2}-\d{2}$/.test(w.effectiveFrom) &&
    typeof w.createdAt === "string" &&
    typeof w.updatedAt === "string" &&
    typeof w.config === "object" && w.config !== null
  )
}

// POST /api/rows
// Body: { rows: FlumeRow[], windows?: ConfigWindow[] }
// Ingests raw rows (dedup by datetime), mirrors the client's window set, and
// recomputes daily rollups.
export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return Response.json({ error: "unauthorized" }, { status: 401 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 })
  }

  const rawRows = (body as { rows?: unknown }).rows
  const rawWindows = (body as { windows?: unknown }).windows

  if (!Array.isArray(rawRows)) {
    return Response.json({ error: "body.rows must be an array" }, { status: 400 })
  }
  if (rawRows.length > MAX_ROWS) {
    return Response.json(
      { error: `body.rows exceeds the ${MAX_ROWS} row limit; upload in smaller batches` },
      { status: 413 }
    )
  }
  const badRow = rawRows.findIndex((r) => !isFlumeRow(r))
  if (badRow !== -1) {
    return Response.json(
      {
        error:
          `body.rows[${badRow}] is invalid — expected { datetime: "YYYY-MM-DD HH:MM", ` +
          `gallons: number between 0 and ${MAX_GALLONS_PER_MINUTE} }`,
      },
      { status: 400 }
    )
  }
  const rows = rawRows as FlumeRow[]

  // An empty array used to mean "delete every config window": replaceWindows is
  // DELETE-all-then-insert, so `{"rows":[],"windows":[]}` destroyed the entire
  // config timeline through a request that looked like a no-op. It now means
  // "no window update", which is the only reading that isn't a footgun — and it
  // leaves no way to wipe the timeline through this API at all.
  let windows: ConfigWindow[] | null = null
  if (Array.isArray(rawWindows) && rawWindows.length > 0) {
    const badWindow = rawWindows.findIndex((w) => !isConfigWindow(w))
    if (badWindow !== -1) {
      return Response.json(
        { error: `body.windows[${badWindow}] is not a valid config window` },
        { status: 400 }
      )
    }
    windows = rawWindows as ConfigWindow[]
  }

  try {
    // Mirror windows first so rollup recompute uses the current config timeline.
    if (windows) await replaceWindows(windows)
    const inserted = await insertRows(rows)

    // Phase 1 simplification: a config-window change can affect any date, so we
    // recompute the whole range rather than just the newly-inserted dates. A
    // later phase makes this targeted to the affected span.
    const bounds = await rowDateBounds()
    const days = bounds ? await recomputeRollups(bounds.min, bounds.max) : 0

    // The per-minute-only aggregates (fleet gpm stats + baseline warnings) also
    // depend on rows + the active config, so refresh them on the same write.
    await recomputeStats()

    return Response.json({ ok: true, received: rows.length, inserted, rollupDays: days })
  } catch (err) {
    console.error("[api/rows] POST failed:", err)
    return Response.json({ error: "server error" }, { status: 500 })
  }
}

// GET and DELETE used to live here and are deliberately gone.
//
// GET returned every row in the database — an unauthenticated bulk export of the
// full metered history, with no date range, no limit and no caller anywhere in
// the app. The dashboard reads /api/rollup, /api/stats and /api/day/[date].
//
// DELETE dropped flume_rows, daily_rollup, station_stats and station_warnings in
// a single batch, guarded only by a header whose value is published in the client
// bundle. On a public deployment that is one request away from unrecoverable
// data loss, in exchange for a convenience button. Clearing data is now a
// deliberate action against the database itself; see docs/RUNBOOK.md.
