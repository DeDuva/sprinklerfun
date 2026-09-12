import type { NextRequest } from "next/server"
import {
  clearAllData,
  insertRows,
  recomputeRollups,
  recomputeStats,
  rowDateBounds,
} from "@/lib/server/data"
import type { FlumeRow } from "@/lib/types"

// libSQL's node client uses native bindings — must run on the Node.js runtime,
// not edge. Never cache: this is a write endpoint.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Authentication happens in proxy.ts, before this handler runs, for every route
// that is not explicitly excluded there — so there is no auth check in this file
// and no way to add a route that forgets one.
//
// The validation below is not authentication and never was. It is blast-radius
// reduction: bound what a single request can do, and refuse the shapes that
// destroy data rather than add it. It stays because the caller being logged in
// says nothing about the body being well formed.

// One upload is a CSV export, not a firehose. At 1-minute resolution 200k rows
// is ~139 days. The cap matters because recomputeStats() re-reads and re-enriches
// the ENTIRE table on every write, so an unbounded body is a cheap amplification
// lever against the Turso read quota.
const MAX_ROWS = 200_000

// Flume reports gallons-per-minute. Anything outside this is a meter fault or a
// hostile payload, and either way it would poison avg/std/warnings downstream.
const MAX_GALLONS_PER_MINUTE = 1_000

// "YYYY-MM-DD HH:MM[:SS]", timezone-NAIVE. The date prefix is what matters:
// `flume_rows` is indexed on substr(datetime, 1, 10) and rowDateBounds() takes a
// lexicographic MIN/MAX over the raw string, so a malformed prefix silently
// corrupts both.
//
// Anchored at the end on purpose, which is what rejects a `Z` or a `±HH:MM`
// offset. Everything downstream reads these strings as local wall-clock time
// (lib/analyze.ts parses them lexically), so an offset would not be honoured —
// it would be ignored, and every rollup would shift by that offset with nothing
// to indicate why. If Flume ever changes its export format, ingest says so
// instead.
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/

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

// isConfigWindow moved to lib/server/validate.ts when config got its own route.
// This handler no longer accepts windows at all, so the check is not duplicated
// here — it lives where the only writer of config now is.

// POST /api/rows
// Body: { rows: FlumeRow[] }
// Ingests raw rows (dedup by datetime) and recomputes daily rollups + stats
// against whatever config timeline the server already holds.
export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 })
  }

  const rawRows = (body as { rows?: unknown }).rows

  // Config no longer travels with an ingest. It is rejected rather than ignored
  // so that a stale client — a tab left open across the deploy that moved config
  // to the server — fails visibly instead of appearing to save a config that
  // went nowhere. Silently dropping the field is how two sources of truth get
  // re-established by accident.
  if ("windows" in (body as object)) {
    return Response.json(
      { error: "body.windows is no longer accepted here — use PUT /api/config" },
      { status: 400 }
    )
  }

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
          `body.rows[${badRow}] is invalid — expected { datetime: "YYYY-MM-DD HH:MM" ` +
          `with no timezone suffix (a trailing "Z" or "+HH:MM" is rejected: these ` +
          `timestamps are read as local wall-clock time), ` +
          `gallons: number between 0 and ${MAX_GALLONS_PER_MINUTE} }`,
      },
      { status: 400 }
    )
  }
  const rows = rawRows as FlumeRow[]

  try {
    const inserted = await insertRows(rows)

    // A config-window change can affect any date, so we recompute the whole
    // range rather than just the newly-inserted dates. Making this targeted to
    // the affected span is deferred deliberately — see the plan's "Deferred".
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

// DELETE /api/rows — clear the metered data.
//
// This was removed once, and for a good reason: it dropped four tables in one
// batch behind a header whose value shipped inside the client bundle, which on a
// public deployment is one request away from unrecoverable loss. What changed is
// not the blast radius but who can reach it — the guard in proxy.ts now requires
// a real session, and the UI puts a typed confirmation in front of it. That is
// what the login bought, and this is the feature that was being held hostage.
//
// It clears rows and the three derived tables. It deliberately does NOT touch
// config_windows or maintenance: "I want to re-upload my meter history" should
// not silently discard a hand-tuned config timeline that took a season to build.
export async function DELETE() {
  try {
    await clearAllData()
    return Response.json({ ok: true })
  } catch (err) {
    console.error("[api/rows] DELETE failed:", err)
    return Response.json({ error: "server error" }, { status: 500 })
  }
}

// GET used to live here and is deliberately gone: it returned every row in the
// database — a bulk export of the full metered history, with no date range, no
// limit and no caller anywhere in the app. The dashboard reads /api/rollup,
// /api/stats and /api/day/[date].
