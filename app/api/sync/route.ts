import { syncFlumeData } from "@/lib/server/sync"
import { flumeConfigured } from "@/lib/server/flume"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// ---------------------------------------------------------------------------
// POST /api/sync — "Sync now", the manual trigger for the same job the daily
// cron runs.
//
// Deliberately NOT excluded from proxy.ts: this one is reached by a person in a
// browser, so it sits behind the session guard like every other route. The cron
// gets its own path (/api/cron) precisely because it cannot present a session
// and therefore needs a different door.
//
// GET is not implemented: this triggers an ingest and a whole-table recompute,
// which is not something a link, a prefetch or a crawler should be able to set
// off.
// ---------------------------------------------------------------------------

export async function POST() {
  if (!flumeConfigured()) {
    return Response.json(
      { ok: false, error: "Flume is not configured on this deployment" },
      { status: 503 }
    )
  }

  const result = await syncFlumeData()
  // 200 with ok:false for a sync that ran and failed; the caller shows the
  // message. A rate-limit is worth its own status so the UI can say "try later"
  // rather than "something is broken".
  return Response.json(result, { status: result.rateLimited ? 429 : 200 })
}
