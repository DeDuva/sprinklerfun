import { countRows } from "@/lib/server/data"

// Reads the DB per request → Node runtime, uncached.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// GET /api/health — liveness probe for the post-deploy smoke check.
//
// It deliberately touches the database rather than returning a static 200. The
// failure this needs to catch is a deploy that boots fine but cannot reach
// Turso — which, before the guard in lib/db.ts, presented as a silently empty
// but perfectly healthy-looking app.
//
// Read-only and reveals only a row count, so it stays unauthenticated like the
// other reads.
export async function GET() {
  const startedAt = Date.now()
  try {
    const rows = await countRows()
    return Response.json({
      ok: true,
      database: "reachable",
      rows,
      latencyMs: Date.now() - startedAt,
    })
  } catch (err) {
    console.error("[api/health] failed:", err)
    return Response.json(
      { ok: false, database: "unreachable", latencyMs: Date.now() - startedAt },
      { status: 503 }
    )
  }
}
