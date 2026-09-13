import type { NextRequest } from "next/server"
import { syncFlumeData } from "@/lib/server/sync"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// ---------------------------------------------------------------------------
// GET /api/cron — the daily Flume sync.
//
// Vercel invokes cron jobs with a plain GET to the production URL, carrying no
// session, so this path is excluded from the guard in proxy.ts the same way
// /api/health is. That means it needs its own door: CRON_SECRET, which Vercel
// sends as `Authorization: Bearer <CRON_SECRET>`.
//
// It fails CLOSED when CRON_SECRET is unset. The alternative — "no secret
// configured, so allow it" — would leave a public endpoint that triggers a full
// ingest and a whole-table recompute on demand, which is a denial-of-wallet
// lever as much as a data one. This app has shipped an unset-secret-means-allow
// guard before and is not doing it again.
//
// The user agent (`vercel-cron/1.0`) and the `x-vercel-cron-schedule` header are
// deliberately NOT used as authentication: both are just request headers, and
// anyone can send them.
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  const provided = req.headers.get("authorization")

  if (!secret || provided !== `Bearer ${secret}`) {
    // One response for "not configured" and "wrong secret" alike; a caller
    // should not be able to tell which by probing.
    return Response.json({ error: "unauthorized" }, { status: 401 })
  }

  const result = await syncFlumeData()

  // 200 even on a sync failure, with ok:false in the body. Vercel does not
  // retry a failed cron, so a non-2xx buys nothing operationally, and the
  // details are more useful in the logs than in a status code. A rate-limit is
  // the one case worth distinguishing, because it means "try later", not
  // "something is broken".
  console.log(
    `[cron] sync ${result.ok ? "ok" : "failed"}: inserted=${result.inserted} ` +
      `corrected=${result.corrected ?? 0} removed=${result.removed ?? 0} ` +
      `rollupDays=${result.rollupDays}${result.error ? ` error=${result.error}` : ""}`
  )
  return Response.json(result)
}
