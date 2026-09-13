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
  flumeConfigured,
  listWaterSensors,
  queryUsage,
  refreshAccessToken,
} from "@/lib/server/flume"
import { readRefreshToken, saveRefreshToken } from "@/lib/server/flumeState"

// ---------------------------------------------------------------------------
// One sync entry point, shared by the daily cron and the "Sync now" button.
//
// Pulls usage from Flume and feeds it through the SAME server write path as a
// CSV upload: insertRows (dedupe on the datetime primary key) → recompute
// rollups → recompute stats. It calls those directly rather than POSTing to
// /api/rows, so the route's 200,000-row body cap does not apply.
//
// Idempotent by construction, which Vercel requires rather than suggests: cron
// delivery is best effort and can both miss a run and deliver the same one
// twice. Re-querying inserts nothing new, and a missed day is picked up next
// time because the window starts from the last stored row, not from "yesterday".
// ---------------------------------------------------------------------------

export interface SyncResult {
  ok: boolean
  inserted: number
  rollupDays: number
  windowFrom?: string
  windowTo?: string
  /**
   * True when the window was longer than one sync's query budget and only its
   * oldest part was fetched. The next run carries on from there by itself.
   */
  truncated?: boolean
  /** True when Flume handed back a different refresh token than the one sent. */
  tokenRotated?: boolean
  error?: string
  rateLimited?: boolean
}

/**
 * How far back to reach when there is nothing stored at all.
 *
 * Kept inside one sync's query budget (below), so an empty database fills in a
 * single run. Older history comes from the CSV uploader. A longer backfill
 * would be fetched over several runs — and could stall if its oldest slices
 * held no data, because the next run starts from the last stored row.
 */
const INITIAL_BACKFILL_DAYS = 20

/**
 * Hours of per-minute data per query.
 *
 * Production rejected a 14-day MIN query with "A provided parameter failed
 * validation". Flume documents no maximum range per bucket size, so this is
 * deliberately well under a day (720 buckets) rather than tuned to a limit
 * nobody has written down. Each slice is also a small response, which matters
 * because Vercel does not retry a failed cron.
 */
const SLICE_HOURS = 12

/**
 * Most queries one sync may make. Flume allows 120 requests an hour, and a
 * sync also spends one on the token refresh and one on the device list — so
 * this leaves room for a "Sync now" click inside the same hour. A daily run
 * needs about six; a long gap is caught up over several runs.
 */
const MAX_QUERIES_PER_SYNC = 50

/**
 * Padding on both ends of the window. Flume reads the query datetimes as
 * ACCOUNT-local while we build them from UTC, so a day of slack each side
 * absorbs the offset and any daylight-saving shift. Over-fetching is free —
 * rows dedupe — while under-fetching silently loses a day.
 */
const PAD_MS = 86_400_000

const dayMs = (n: number) => n * 86_400_000
const SLICE_MS = SLICE_HOURS * 3_600_000

export async function syncFlumeData(opts: { since?: Date } = {}): Promise<SyncResult> {
  if (!flumeConfigured()) {
    return { ok: false, inserted: 0, rollupDays: 0, error: "Flume is not configured" }
  }

  const stored = await readRefreshToken()
  if (!stored) {
    return {
      ok: false,
      inserted: 0,
      rollupDays: 0,
      error: "Flume is not connected — run `npm run flume:connect` and set FLUME_REFRESH_TOKEN",
    }
  }

  let tokenRotated = false

  try {
    const tokens = await refreshAccessToken(stored)

    // Persist a rotated token IMMEDIATELY, before the long query work.
    //
    // Flume returns a refresh_token on every refresh and does not document
    // whether it rotates. If it does, the token we just sent may already be
    // dead — so if the query below then failed and we had not written the new
    // one yet, the next run would authenticate with a spent token and the sync
    // would be permanently broken until someone re-ran the connect script.
    if (tokens.refreshToken !== stored) {
      await saveRefreshToken(tokens.refreshToken)
      tokenRotated = true
      console.log("[sync] Flume rotated the refresh token; stored the new one")
    } else {
      console.log("[sync] Flume returned the same refresh token")
    }

    const accessToken = tokens.accessToken
    const userId = decodeJwtUserId(accessToken)

    // One env var fewer: pick the account's water sensor unless told otherwise.
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
    const wantedTo = Date.now() + PAD_MS

    // Over budget: take the OLDEST part. The next run starts from the last row
    // stored, so it continues exactly where this one stopped. Taking the newest
    // part instead would leave a hole that no later run ever revisits.
    const budgetTo = from.getTime() + MAX_QUERIES_PER_SYNC * SLICE_MS
    const truncated = wantedTo > budgetTo
    const to = new Date(Math.min(wantedTo, budgetTo))
    if (truncated) {
      console.log(`[sync] window exceeds ${MAX_QUERIES_PER_SYNC} queries; fetching the oldest part only`)
    }

    let inserted = 0
    for (let cursor = from.getTime(); cursor < to.getTime(); cursor += SLICE_MS) {
      const sliceFrom = new Date(cursor)
      const sliceTo = new Date(Math.min(cursor + SLICE_MS, to.getTime()))
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
    // the whole table, so doing it in the loop would be quadratic for nothing.
    const after = await rowDateBounds()
    const rollupDays = after ? await recomputeRollups(after.min, after.max) : 0
    await recomputeStats()

    return {
      ok: true,
      inserted,
      rollupDays,
      tokenRotated,
      truncated,
      windowFrom: from.toISOString().slice(0, 10),
      windowTo: to.toISOString().slice(0, 10),
    }
  } catch (err) {
    const rateLimited = err instanceof FlumeError && err.rateLimited
    const error = err instanceof Error ? err.message : String(err)
    console.error("[sync] Flume sync failed:", error)
    return { ok: false, inserted: 0, rollupDays: 0, tokenRotated, error, rateLimited }
  }
}
