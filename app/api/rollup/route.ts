import type { NextRequest } from "next/server"
import { readRollups } from "@/lib/server/data"

// Reads the DB per request → Node runtime, uncached.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// GET /api/rollup?from=YYYY-MM-DD&to=YYYY-MM-DD
// Returns the per-day/per-station aggregates the dashboard reads. Both bounds
// are optional; omit them for the full history. Read-only, so no auth guard
// (Phase 1). Deployment-level protection covers read access in production.
export async function GET(req: NextRequest) {
  const from = req.nextUrl.searchParams.get("from") ?? undefined
  const to = req.nextUrl.searchParams.get("to") ?? undefined
  try {
    const rollups = await readRollups(from, to)
    return Response.json({ rollups })
  } catch (err) {
    console.error("[api/rollup] failed:", err)
    return Response.json({ error: "server error" }, { status: 500 })
  }
}
