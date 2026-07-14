import type { NextRequest } from "next/server"
import { readDayRows } from "@/lib/server/data"

// Reads the DB per request → Node runtime, uncached.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// GET /api/day/[date] — raw per-minute rows for one day (YYYY-MM-DD). The
// day-detail / flow / reconciliation views enrich this single day client-side
// (cheap) instead of loading the whole series.
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ date: string }> }
) {
  const { date } = await ctx.params
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json({ error: "date must be YYYY-MM-DD" }, { status: 400 })
  }
  try {
    const rows = await readDayRows(date)
    return Response.json({ rows })
  } catch (err) {
    console.error("[api/day] failed:", err)
    return Response.json({ error: "server error" }, { status: 500 })
  }
}
