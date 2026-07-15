import type { NextRequest } from "next/server"
import { isAuthorized } from "@/lib/server/auth"
import {
  insertRows,
  replaceWindows,
  recomputeRollups,
  recomputeStats,
  rowDateBounds,
  readAllRows,
  clearAllData,
} from "@/lib/server/data"
import type { ConfigWindow, FlumeRow } from "@/lib/types"

// libSQL's node client uses native bindings — must run on the Node.js runtime,
// not edge. Never cache: this is a write endpoint.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function isFlumeRow(v: unknown): v is FlumeRow {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as FlumeRow).datetime === "string" &&
    typeof (v as FlumeRow).gallons === "number"
  )
}

// POST /api/rows
// Body: { rows: FlumeRow[], windows?: ConfigWindow[] }
// Ingests raw rows (dedup by datetime), mirrors the client's window set, and
// recomputes daily rollups. During Phase 1 the client dual-writes here on every
// CSV upload while localStorage remains the source of truth.
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

  if (!Array.isArray(rawRows) || !rawRows.every(isFlumeRow)) {
    return Response.json(
      { error: "body.rows must be an array of { datetime: string, gallons: number }" },
      { status: 400 }
    )
  }
  const rows = rawRows as FlumeRow[]
  const windows = Array.isArray(rawWindows) ? (rawWindows as ConfigWindow[]) : null

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

// GET /api/rows — all raw rows, ascending by datetime. Hydrates the in-memory
// store on load (rows are no longer persisted in localStorage).
export async function GET() {
  try {
    const rows = await readAllRows()
    return Response.json({ rows })
  } catch (err) {
    console.error("[api/rows] GET failed:", err)
    return Response.json({ error: "server error" }, { status: 500 })
  }
}

// DELETE /api/rows — clear all rows + rollups (the "Clear all CSV data" action).
export async function DELETE(req: NextRequest) {
  if (!isAuthorized(req)) {
    return Response.json({ error: "unauthorized" }, { status: 401 })
  }
  try {
    await clearAllData()
    return Response.json({ ok: true })
  } catch (err) {
    console.error("[api/rows] DELETE failed:", err)
    return Response.json({ error: "server error" }, { status: 500 })
  }
}
