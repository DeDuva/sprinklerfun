import type { NextRequest } from "next/server"
import { readRollups } from "@/lib/server/data"

// Reads the DB per request → Node runtime, uncached.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// GET /api/rollup?from=YYYY-MM-DD&to=YYYY-MM-DD
// Returns the per-day/per-station aggregates the dashboard reads. Both bounds
// are optional; omit them for the full history.
//
// There is no auth check in this file because there is one in front of it:
// proxy.ts guards every route except the sign-in page, the /api/auth endpoints
// and GET /api/health. A new route is protected by default rather than by
// someone remembering to protect it.
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
