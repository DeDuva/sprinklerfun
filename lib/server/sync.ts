import type { FlumeRow } from "@/lib/types"
import {
  insertRows,
  recomputeRollups,
  recomputeStats,
  rowDateBounds,
} from "@/lib/server/data"
import { readFlumeConnection, updateFlumeConnection } from "@/lib/server/settings"
import { getValidAccessToken, queryUsage, FlumeError } from "@/lib/server/flume"

// ---------------------------------------------------------------------------
// One sync entry point shared by the "Sync now" button and the Vercel cron job.
//
// Pulls water usage from the Flume API and feeds it through the SAME server
// write path as a CSV upload: insertRows (dedupe by datetime PK) → recompute
// rollups → recompute stats. Because rows dedupe on their datetime primary key,
// re-querying an overlapping range is safe and idempotent.
// ---------------------------------------------------------------------------

export interface SyncResult {
  ok: boolean
  inserted: number
  rollupDays: number
  error?: string
  rateLimited?: boolean
}

// How far back to pull on the very first sync (no rows stored yet). Bounds the
// initial payload while still capturing a full watering season. Later syncs are
// incremental from the last stored day.
const INITIAL_BACKFILL_DAYS = 365

export async function syncFlumeData(opts: { since?: Date } = {}): Promise<SyncResult> {
  const conn = await readFlumeConnection()
  if (!conn.refreshToken || !conn.flumeUserId || !conn.deviceId) {
    return { ok: false, inserted: 0, rollupDays: 0, error: "Flume is not connected" }
  }

  try {
    const accessToken = await getValidAccessToken(conn)

    // Incremental window: from the last stored day (small overlap is deduped),
    // else the initial backfill window. `until` is now.
    const until = new Date()
    let since = opts.since
    if (!since) {
      const bounds = await rowDateBounds()
      since = bounds
        ? new Date(`${bounds.max}T00:00:00`)
        : new Date(Date.now() - INITIAL_BACKFILL_DAYS * 86_400_000)
    }

    const rows: FlumeRow[] = await queryUsage({
      userId: conn.flumeUserId,
      deviceId: conn.deviceId,
      accessToken,
      since,
      until,
    })

    const inserted = await insertRows(rows)
    const bounds = await rowDateBounds()
    const rollupDays = bounds ? await recomputeRollups(bounds.min, bounds.max) : 0
    await recomputeStats()

    await updateFlumeConnection({
      lastSyncAt: new Date().toISOString(),
      lastSyncStatus: "ok",
      lastSyncError: null,
    })
    return { ok: true, inserted, rollupDays }
  } catch (err) {
    const rateLimited = err instanceof FlumeError && err.rateLimited
    const message = err instanceof Error ? err.message : String(err)
    await updateFlumeConnection({
      lastSyncAt: new Date().toISOString(),
      lastSyncStatus: "error",
      lastSyncError: message,
    })
    return { ok: false, inserted: 0, rollupDays: 0, error: message, rateLimited }
  }
}
