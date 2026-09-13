import type { FlumeRow } from "@/lib/types"
import {
  insertRows,
  recomputeRollups,
  recomputeStats,
  rowDateBounds,
} from "@/lib/server/data"
import {
  FlumeError,
  decodeJwtUserId,
  fetchAccessToken,
  flumeConfigured,
  listWaterSensors,
  queryUsage,
} from "@/lib/server/flume"

// ---------------------------------------------------------------------------
// One sync entry point, shared by the daily cron and the "Sync now" button.
//
// Pulls usage from Flume and feeds it through the SAME server write path as a
// CSV upload: insertRows (dedupe on the datetime primary key) → recompute
// rollups → recompute stats. It calls those functions directly rather than
// POSTing to /api/rows, so the route's 200,000-row body cap does not apply.
//
// Idempotent by construction, which Vercel requires rather than suggests: cron
// delivery is best effort and can both miss a run and deliver the same run
// twice. Re-querying an overlapping range inserts nothing new, and a missed day
// is picked up by the next run because the window starts from the last stored
// row rather than from "yesterday".
// ---------------------------------------------------------------------------

export interface SyncResult {
  ok: boolean
  inserted: number
  rollupDays: number
  windowFrom?: string
  windowTo?: string
  error?: string
  rateLimited?: boolean
}

/** How far back to reach when there is nothing stored at all. */
const INITIAL_BACKFILL_DAYS = 365

/**
 * Query Flume in slices rather than one enormous range.
 *
 * At per-minute resolution a year is ~525,000 samples. Asking for that in a
 * single request risks a response large enough to blow the function's memory or
 * its time limit, and Vercel does not retry a failed cron. Slices keep each
 * request small; rows dedupe, so a slice boundary landing mid-minute is free.
 */
const SLICE_DAYS = 14

/**
 * Padding on both ends of the window, in days.
 *
 * Flume reads the query datetimes as ACCOUNT-local time while we build them from
 * UTC (see fmtFlumeDatetime), so the window can be off by the account's offset.
 * A day of slack on each side absorbs that, plus any daylight-saving shift. The
 * cost of over-fetching is zero — rows dedupe on their primary key — while the
 * cost of under-fetching is a silently missing day.
 */
const PAD_MS = 86_400_000

const dayMs = (n: number) => n * 86_400_000

export async function syncFlumeData(opts: { since?: Date } = {}): Promise<SyncResult> {
  if (!flumeConfigured()) {
    return { ok: false, inserted: 0, rollupDays: 0, error: "Flume is not configured" }
  }

  try {
    const accessToken = await fetchAccessToken()
    const userId = decodeJwtUserId(accessToken)

    // One env var fewer: pick the account's water sensor unless told otherwise.
    // Most households have exactly one, and FLUME_DEVICE_ID overrides when not.
    let deviceId = process.env.FLUME_DEVICE_ID
    if (!deviceId) {
      const devices = await listWaterSensors(userId, accessToken)
      if (devices.length === 0) {
        throw new FlumeError("No Flume water sensor found on this account")
      }
      deviceId = devices[0].id
    }

    // Incremental from the last stored day, so a missed run self-heals; the
    // full backfill only applies to an empty database.
    const bounds = await rowDateBounds()
    const start =
      opts.since ??
      (bounds ? new Date(`${bounds.max}T00:00:00Z`) : new Date(Date.now() - dayMs(INITIAL_BACKFILL_DAYS)))

    const from = new Date(start.getTime() - PAD_MS)
    const to = new Date(Date.now() + PAD_MS)

    let inserted = 0
    for (let cursor = from.getTime(); cursor < to.getTime(); cursor += dayMs(SLICE_DAYS)) {
      const sliceFrom = new Date(cursor)
      const sliceTo = new Date(Math.min(cursor + dayMs(SLICE_DAYS), to.getTime()))
      const rows: FlumeRow[] = await queryUsage({
        userId,
        deviceId,
        accessToken,
        since: sliceFrom,
        until: sliceTo,
      })
      inserted += await insertRows(rows)
    }

    // Recompute once at the end rather than per slice: recomputeStats re-reads
    // the whole table, so doing it inside the loop would be quadratic for
    // nothing.
    const after = await rowDateBounds()
    const rollupDays = after ? await recomputeRollups(after.min, after.max) : 0
    await recomputeStats()

    return {
      ok: true,
      inserted,
      rollupDays,
      windowFrom: from.toISOString().slice(0, 10),
      windowTo: to.toISOString().slice(0, 10),
    }
  } catch (err) {
    const rateLimited = err instanceof FlumeError && err.rateLimited
    const error = err instanceof Error ? err.message : String(err)
    console.error("[sync] Flume sync failed:", error)
    return { ok: false, inserted: 0, rollupDays: 0, error, rateLimited }
  }
}
