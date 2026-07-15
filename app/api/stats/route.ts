import { readStationStats, readStationWarnings, countRows, rowDateBounds } from "@/lib/server/data"
import type { StatsPayload } from "@/lib/types"

// Reads the DB per request → Node runtime, uncached.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// GET /api/stats — the precomputed per-minute-only aggregates that daily gallon
// sums can't reconstruct: fleet-wide station gpm stats (avg/std/min/max) and
// baseline-drift warnings, plus the total row count (for status display). These
// are recomputed server-side on every write, so this read is cheap. Read-only,
// so no auth guard (Phase 1 convention) — deployment protection covers reads.
export async function GET() {
  try {
    const [stationStats, warnings, rowCount, bounds] = await Promise.all([
      readStationStats(),
      readStationWarnings(),
      countRows(),
      rowDateBounds(),
    ])
    const payload: StatsPayload = { stationStats, warnings, rowCount, lastDate: bounds?.max ?? null }
    return Response.json(payload)
  } catch (err) {
    console.error("[api/stats] failed:", err)
    return Response.json({ error: "server error" }, { status: 500 })
  }
}
