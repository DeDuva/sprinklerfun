import type { InArgs } from "@libsql/client"
import { getDb, ensureSchema } from "@/lib/db"
import type {
  ConfigWindow,
  FlumeRow,
  DailyRow,
  MaintenanceFlag,
  RollupRow,
  StationStats,
  StationWarning,
} from "@/lib/types"
import {
  enrichRowsMultiConfig,
  buildDailyRows,
  buildStationStats,
  computeStationWarnings,
  currentConfig,
} from "@/lib/analyze"

// ---------------------------------------------------------------------------
// Server-side data access for the Turso backend.
//
// The raw + rollup model: raw minute rows live in `flume_rows`, and the derived
// per-day/per-station aggregates the dashboard reads live in `daily_rollup`,
// recomputed from the raw rows whenever data or config changes. Enrichment (the
// minute→station attribution) reuses the exact pure functions from lib/analyze,
// so server rollups match what the client used to compute in-browser.
// ---------------------------------------------------------------------------

const ROW_CHUNK = 500 // rows per multi-value INSERT statement

// Insert raw rows, ignoring duplicates by datetime PK (the server-side
// equivalent of appendRows' dedupe). Returns how many were newly inserted.
export async function insertRows(rows: FlumeRow[]): Promise<number> {
  if (rows.length === 0) return 0
  await ensureSchema()
  const db = getDb()

  const before = await countRows()
  for (let i = 0; i < rows.length; i += ROW_CHUNK) {
    const chunk = rows.slice(i, i + ROW_CHUNK)
    const placeholders = chunk.map(() => "(?, ?)").join(", ")
    const args: InArgs = []
    for (const r of chunk) args.push(r.datetime, r.gallons)
    await db.execute({
      sql: `INSERT OR IGNORE INTO flume_rows (datetime, gallons) VALUES ${placeholders}`,
      args,
    })
  }
  const after = await countRows()
  return after - before
}

/**
 * Write rows from the Flume API, OVERWRITING any stored value for the same minute.
 *
 * insertRows keeps the first value it sees, which is right for a CSV upload and
 * wrong for the API: Flume answers a per-minute query with a bucket for every
 * minute in the range, and a minute it has not received yet comes back as 0. Kept
 * forever, those zeros replaced real usage — so a later sync must be able to
 * correct them.
 *
 * `corrected` counts only rows whose value actually changed (the WHERE on the
 * update), so re-reading an unchanged day reports nothing.
 */
export async function upsertRows(rows: FlumeRow[]): Promise<{ inserted: number; corrected: number }> {
  if (rows.length === 0) return { inserted: 0, corrected: 0 }
  await ensureSchema()
  const db = getDb()

  const before = await countRows()
  let changed = 0
  for (let i = 0; i < rows.length; i += ROW_CHUNK) {
    const chunk = rows.slice(i, i + ROW_CHUNK)
    const placeholders = chunk.map(() => "(?, ?)").join(", ")
    const args: InArgs = []
    for (const r of chunk) args.push(r.datetime, r.gallons)
    const res = await db.execute({
      sql: `INSERT INTO flume_rows (datetime, gallons) VALUES ${placeholders}
            ON CONFLICT(datetime) DO UPDATE SET gallons = excluded.gallons
            WHERE flume_rows.gallons <> excluded.gallons`,
      args,
    })
    changed += res.rowsAffected
  }
  const inserted = (await countRows()) - before
  return { inserted, corrected: changed - inserted }
}

/**
 * Delete rows stamped at or after `cutoff` ("YYYY-MM-DD HH:MM:SS", local wall-clock
 * time) — minutes that have not finished happening, so anything stored for them
 * came from a query that reached past "now". Rollups for days after the cutoff's
 * date go too: recomputeRollups only rewrites the range rows still cover, so
 * those would otherwise outlive their rows.
 */
export async function deleteRowsFrom(cutoff: string): Promise<number> {
  await ensureSchema()
  const db = getDb()
  const [rowsRes] = await db.batch(
    [
      { sql: "DELETE FROM flume_rows WHERE datetime >= ?", args: [cutoff] },
      { sql: "DELETE FROM daily_rollup WHERE date > ?", args: [cutoff.slice(0, 10)] },
    ],
    "write"
  )
  return rowsRes.rowsAffected
}

export async function countRows(): Promise<number> {
  await ensureSchema()
  const db = getDb()
  const res = await db.execute("SELECT COUNT(*) AS n FROM flume_rows")
  return Number(res.rows[0]?.n ?? 0)
}

// Replace the stored window set. Windows are small and edited as a whole, so a
// delete-all + insert expresses the edit exactly; there is no partial update of
// a timeline that would mean anything.
function windowStatements(windows: ConfigWindow[]): { sql: string; args: InArgs }[] {
  return [
    { sql: "DELETE FROM config_windows", args: [] as InArgs },
    ...windows.map((w) => ({
      sql: `INSERT INTO config_windows
              (id, effective_from, notes, config, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        w.id,
        w.effectiveFrom,
        w.notes,
        JSON.stringify(w.config),
        w.createdAt,
        w.updatedAt,
      ] as InArgs,
    })),
  ]
}

export async function replaceWindows(windows: ConfigWindow[]): Promise<void> {
  await ensureSchema()
  await getDb().batch(windowStatements(windows), "write")
}

export async function readWindows(): Promise<ConfigWindow[]> {
  await ensureSchema()
  const db = getDb()
  const res = await db.execute(
    "SELECT id, effective_from, notes, config, created_at, updated_at FROM config_windows ORDER BY effective_from ASC"
  )
  return res.rows.map((r) => ({
    id: String(r.id),
    effectiveFrom: String(r.effective_from),
    notes: String(r.notes ?? ""),
    config: JSON.parse(String(r.config)),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  }))
}

// ---------------------------------------------------------------------------
// Maintenance flags
//
// The `maintenance` table has existed in ensureSchema since the schema was first
// written, but nothing ever read or wrote it: the flags lived in localStorage
// alongside the windows. They move here for the same reason the windows did —
// a flag raised on the phone was invisible on the laptop, which is the whole
// bug class this change exists to close.
//
// Stored as one row per station rather than a JSON blob so a single flag can be
// cleared without rewriting the set, and so a backup of this table is legible.
// ---------------------------------------------------------------------------

export async function readMaintenance(): Promise<Record<string, MaintenanceFlag>> {
  await ensureSchema()
  const db = getDb()
  const res = await db.execute("SELECT station_id, flagged_at, note FROM maintenance")
  const out: Record<string, MaintenanceFlag> = {}
  for (const r of res.rows) {
    const note = r.note
    out[String(r.station_id)] = {
      flaggedAt: String(r.flagged_at),
      // The column is nullable and the field is optional; don't invent a "" note.
      ...(note === null || note === undefined ? {} : { note: String(note) }),
    }
  }
  return out
}

// Whole-map replace, mirroring replaceWindows. The map is a handful of entries
// edited as a unit, and an absent key means "not flagged" — so a partial update
// has no meaning here that a replace doesn't express more simply.
function maintenanceStatements(
  maintenance: Record<string, MaintenanceFlag>
): { sql: string; args: InArgs }[] {
  return [
    { sql: "DELETE FROM maintenance", args: [] as InArgs },
    ...Object.entries(maintenance).map(([stationId, flag]) => ({
      sql: "INSERT INTO maintenance (station_id, flagged_at, note) VALUES (?, ?, ?)",
      args: [stationId, flag.flaggedAt, flag.note ?? null] as InArgs,
    })),
  ]
}

export async function replaceMaintenance(
  maintenance: Record<string, MaintenanceFlag>
): Promise<void> {
  await ensureSchema()
  await getDb().batch(maintenanceStatements(maintenance), "write")
}

// Write the whole config document in ONE batch.
//
// The two halves are saved together or not at all. Doing them as two batches
// leaves a window in which the windows are new and the maintenance flags are
// still the old ones — and since a config write also triggers a full rollup and
// stats recompute, a recompute landing inside that window would derive its
// numbers from a config that never existed.
export async function replaceConfig(doc: {
  windows: ConfigWindow[]
  maintenance: Record<string, MaintenanceFlag>
}): Promise<void> {
  await ensureSchema()
  await getDb().batch(
    [...windowStatements(doc.windows), ...maintenanceStatements(doc.maintenance)],
    "write"
  )
}

// All raw rows, ascending by datetime. Used to hydrate the in-memory store on
// load now that rows are no longer persisted in localStorage.
export async function readAllRows(): Promise<FlumeRow[]> {
  await ensureSchema()
  const db = getDb()
  const res = await db.execute(
    "SELECT datetime, gallons FROM flume_rows ORDER BY datetime ASC"
  )
  return res.rows.map((r) => ({ datetime: String(r.datetime), gallons: Number(r.gallons) }))
}

// Clear all data (rows + rollups + precomputed stats/warnings). Windows and
// maintenance are untouched on purpose: "I want to re-upload my meter history"
// should not cost a season of hand-tuned config, and unlike the rows, the config
// cannot be re-downloaded from Flume.
export async function clearAllData(): Promise<void> {
  await ensureSchema()
  const db = getDb()
  await db.batch(
    [
      "DELETE FROM flume_rows",
      "DELETE FROM daily_rollup",
      "DELETE FROM station_stats",
      "DELETE FROM station_warnings",
    ],
    "write"
  )
}

// Raw rows for a single day (used by the day-detail view).
export async function readDayRows(date: string): Promise<FlumeRow[]> {
  await ensureSchema()
  const db = getDb()
  const res = await db.execute({
    sql: "SELECT datetime, gallons FROM flume_rows WHERE substr(datetime, 1, 10) = ? ORDER BY datetime ASC",
    args: [date],
  })
  return res.rows.map((r) => ({ datetime: String(r.datetime), gallons: Number(r.gallons) }))
}

// Raw rows across a date range, inclusive (for rollup recompute).
async function readRowsInRange(fromDate: string, toDate: string): Promise<FlumeRow[]> {
  const db = getDb()
  const res = await db.execute({
    sql: `SELECT datetime, gallons FROM flume_rows
          WHERE substr(datetime, 1, 10) >= ? AND substr(datetime, 1, 10) <= ?
          ORDER BY datetime ASC`,
    args: [fromDate, toDate],
  })
  return res.rows.map((r) => ({ datetime: String(r.datetime), gallons: Number(r.gallons) }))
}

// Recompute daily rollups for [fromDate, toDate] from raw rows, using the full
// window set so each date resolves to its active config (a row's active window
// may be defined before `fromDate`). Reuses enrichRowsMultiConfig + buildDailyRows
// verbatim, then upserts one row per (date, station).
export async function recomputeRollups(fromDate: string, toDate: string): Promise<number> {
  await ensureSchema()
  const db = getDb()

  const [rows, windows] = await Promise.all([
    readRowsInRange(fromDate, toDate),
    readWindows(),
  ])
  const enriched = enrichRowsMultiConfig(rows, windows)
  const daily: DailyRow[] = buildDailyRows(enriched)

  const stmts: { sql: string; args: InArgs }[] = [
    {
      sql: "DELETE FROM daily_rollup WHERE date >= ? AND date <= ?",
      args: [fromDate, toDate],
    },
  ]
  for (const day of daily) {
    for (const [station, gallons] of Object.entries(day.byStation)) {
      stmts.push({
        sql: `INSERT OR REPLACE INTO daily_rollup (date, station, gallons, is_sprinkler_day)
              VALUES (?, ?, ?, ?)`,
        args: [day.date, station, gallons, day.isSprinklerDay ? 1 : 0],
      })
    }
  }
  await db.batch(stmts, "write")
  return daily.length
}

export async function readRollups(fromDate?: string, toDate?: string): Promise<RollupRow[]> {
  await ensureSchema()
  const db = getDb()
  const clauses: string[] = []
  const args: InArgs = []
  if (fromDate) {
    clauses.push("date >= ?")
    args.push(fromDate)
  }
  if (toDate) {
    clauses.push("date <= ?")
    args.push(toDate)
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""
  const res = await db.execute({
    sql: `SELECT date, station, gallons, is_sprinkler_day FROM daily_rollup ${where} ORDER BY date ASC`,
    args,
  })
  return res.rows.map((r) => ({
    date: String(r.date),
    station: String(r.station),
    gallons: Number(r.gallons),
    isSprinklerDay: Number(r.is_sprinkler_day) === 1,
  }))
}

// ---------------------------------------------------------------------------
// Station stats + warnings (the per-minute-only aggregates)
//
// buildStationStats (fleet-wide avg/std/min/max gpm) and computeStationWarnings
// (baseline-drift alerts) both need the full per-minute enriched series and the
// "current" config, so they can't be derived from the daily gallon sums in
// daily_rollup. We compute them once here — over the whole series — and store
// the results so the dashboard/analysis can read them cheaply via /api/stats.
// Recompute is triggered on every write (upload / window edit / clear).
// ---------------------------------------------------------------------------
export async function recomputeStats(): Promise<{ stations: number; warnings: number }> {
  await ensureSchema()
  const db = getDb()

  const [rows, windows] = await Promise.all([readAllRows(), readWindows()])
  const enriched = enrichRowsMultiConfig(rows, windows)
  const config = currentConfig(windows)
  const stats = buildStationStats(enriched, config)
  const warnings = computeStationWarnings(enriched, config, 21)

  const stmts: { sql: string; args: InArgs }[] = [
    { sql: "DELETE FROM station_stats", args: [] },
    { sql: "DELETE FROM station_warnings", args: [] },
  ]
  for (const s of stats) {
    stmts.push({
      sql: `INSERT OR REPLACE INTO station_stats
              (id, name, total_gallons, avg_gpm, min_gpm, max_gpm, std_gpm, cost_estimate, pct_of_sprinkler)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [s.id, s.name, s.totalGallons, s.avgGpm, s.minGpm, s.maxGpm, s.stdGpm, s.costEstimate, s.pctOfSprinkler],
    })
  }
  for (const w of warnings) {
    stmts.push({
      sql: `INSERT OR REPLACE INTO station_warnings
              (station_id, station_name, baseline_gpm, recent_avg_gpm, pct_above_baseline, consecutive_days_above)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [w.stationId, w.stationName, w.baselineGpm, w.recentAvgGpm, w.pctAboveBaseline, w.consecutiveDaysAbove],
    })
  }
  await db.batch(stmts, "write")
  return { stations: stats.length, warnings: warnings.length }
}

export async function readStationStats(): Promise<StationStats[]> {
  await ensureSchema()
  const db = getDb()
  const res = await db.execute(
    "SELECT id, name, total_gallons, avg_gpm, min_gpm, max_gpm, std_gpm, cost_estimate, pct_of_sprinkler FROM station_stats ORDER BY total_gallons DESC"
  )
  return res.rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    totalGallons: Number(r.total_gallons),
    avgGpm: Number(r.avg_gpm),
    minGpm: Number(r.min_gpm),
    maxGpm: Number(r.max_gpm),
    stdGpm: Number(r.std_gpm),
    costEstimate: Number(r.cost_estimate),
    pctOfSprinkler: Number(r.pct_of_sprinkler),
  }))
}

export async function readStationWarnings(): Promise<StationWarning[]> {
  await ensureSchema()
  const db = getDb()
  const res = await db.execute(
    "SELECT station_id, station_name, baseline_gpm, recent_avg_gpm, pct_above_baseline, consecutive_days_above FROM station_warnings ORDER BY pct_above_baseline DESC"
  )
  return res.rows.map((r) => ({
    stationId: String(r.station_id),
    stationName: String(r.station_name),
    baselineGpm: Number(r.baseline_gpm),
    recentAvgGpm: Number(r.recent_avg_gpm),
    pctAboveBaseline: Number(r.pct_above_baseline),
    consecutiveDaysAbove: Number(r.consecutive_days_above),
  }))
}

// The earliest and latest row dates present, for a full rollup recompute.
export async function rowDateBounds(): Promise<{ min: string; max: string } | null> {
  await ensureSchema()
  const db = getDb()
  const res = await db.execute(
    "SELECT substr(MIN(datetime),1,10) AS mn, substr(MAX(datetime),1,10) AS mx FROM flume_rows"
  )
  const mn = res.rows[0]?.mn
  const mx = res.rows[0]?.mx
  if (!mn || !mx) return null
  return { min: String(mn), max: String(mx) }
}
