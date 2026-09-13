import type { FlumeRow } from "@/lib/types"
import {
  deleteRowsFrom,
  recomputeRollups,
  recomputeStats,
  rowDateBounds,
  upsertRows,
} from "@/lib/server/data"
import {
  FlumeError,
  decodeJwtUserId,
  flumeConfigured,
  listWaterSensors,
  localMinute,
  queryUsage,
  refreshAccessToken,
} from "@/lib/server/flume"
import { readRefreshToken, saveRefreshToken } from "@/lib/server/flumeState"

// ---------------------------------------------------------------------------
// One sync entry point, shared by the daily cron and the "Sync now" button.
//
// Pulls usage from Flume and feeds it through the same derived-table path as a
// CSV upload: write rows → recompute rollups → recompute stats. The write
// differs in one way: synced rows OVERWRITE what is stored (upsertRows), where
// an upload keeps the first value (insertRows). It calls those directly rather than POSTing to
// /api/rows, so the route's 200,000-row body cap does not apply.
//
// Idempotent by construction, which Vercel requires rather than suggests: cron
// delivery is best effort and can both miss a run and deliver the same one
// twice. Re-querying writes the same values again, and a missed day is picked up
// next time because the window reaches back to the last stored row.
//
// Why synced rows overwrite: Flume answers a per-minute query with a bucket for
// EVERY minute in the range — including minutes it has not received yet, and
// minutes that have not happened — and those come back as 0. The first version
// kept whatever it stored first and started each window at the last stored row.
// Together that made the zeros permanent and pushed the window past them, so
// real usage was never asked for again. Three things now prevent it: rows at or
// after the location's current minute are dropped (and any already stored are
// deleted), every sync re-reads the last LOOKBACK_DAYS, and those re-read rows
// overwrite what is there.
// ---------------------------------------------------------------------------

export interface SyncResult {
  ok: boolean
  /** Minutes stored that were not stored before. */
  inserted: number
  /** Stored minutes whose value Flume now reports differently — usually a 0 filled in. */
  corrected?: number
  /** Stored minutes deleted because they are at or after the current local minute. */
  removed?: number
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

/**
 * Every sync re-reads at least this many days back from now, whatever is stored.
 *
 * Flume reports recent minutes as 0 until the readings reach it, so the newest
 * part of any sync can be zeros that are not real. Re-reading — and overwriting —
 * the last few days replaces them once the readings arrive. Three days rides out
 * a bridge that is offline over a weekend, for about ten queries a day.
 */
const LOOKBACK_DAYS = 3

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

    // Listed even when FLUME_DEVICE_ID pins one: the list is where the location's
    // timezone comes from, and without it there is no telling which minutes
    // have happened yet.
    const devices = await listWaterSensors(userId, accessToken)
    const pinned = process.env.FLUME_DEVICE_ID
    const device = pinned ? devices.find((d) => d.id === pinned) : devices[0]
    if (!device) {
      throw new FlumeError(
        pinned
          ? `FLUME_DEVICE_ID ${pinned} is not a water sensor on this Flume account`
          : "No Flume water sensor found on this account"
      )
    }
    const deviceId = device.id

    // The first minute that has not finished happening where the meter is.
    const cutoff = device.timezone ? localMinute(new Date(), device.timezone) : null
    let removed = 0
    if (cutoff) {
      removed = await deleteRowsFrom(cutoff)
      if (removed > 0) console.log(`[sync] removed ${removed} rows stamped at or after ${cutoff} (${device.timezone})`)
    } else {
      // Not fatal: the lookback still overwrites any zeros once real readings
      // arrive. But future minutes can be stored in the meantime, so say so.
      console.warn(
        `[sync] no usable timezone on the Flume location (${device.timezone ?? "none"}); ` +
          "cannot exclude minutes that have not happened yet"
      )
    }

    // From the last stored day, so a missed run self-heals — but never later than
    // LOOKBACK_DAYS ago, so recent zeros are always re-read. The backfill only
    // applies to an empty database.
    const bounds = await rowDateBounds()
    const lookbackStart = Date.now() - dayMs(LOOKBACK_DAYS)
    const start =
      opts.since ??
      (bounds
        ? new Date(Math.min(new Date(`${bounds.max}T00:00:00Z`).getTime(), lookbackStart))
        : new Date(Date.now() - dayMs(INITIAL_BACKFILL_DAYS)))

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
    let corrected = 0
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
      const written = await upsertRows(cutoff ? rows.filter((r) => r.datetime < cutoff) : rows)
      inserted += written.inserted
      corrected += written.corrected
    }

    // Recompute once at the end rather than per slice: recomputeStats re-reads
    // the whole table, so doing it in the loop would be quadratic for nothing.
    const after = await rowDateBounds()
    const rollupDays = after ? await recomputeRollups(after.min, after.max) : 0
    await recomputeStats()

    return {
      ok: true,
      inserted,
      corrected,
      removed,
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
