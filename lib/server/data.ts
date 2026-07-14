import type { InArgs } from "@libsql/client"
import { getDb, ensureSchema } from "@/lib/db"
import type { ConfigWindow, FlumeRow, DailyRow } from "@/lib/types"
import { enrichRowsMultiConfig, buildDailyRows } from "@/lib/analyze"

// ---------------------------------------------------------------------------
// Server-side data access for the Turso backend (Phase 1).
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

export async function countRows(): Promise<number> {
  await ensureSchema()
  const db = getDb()
  const res = await db.execute("SELECT COUNT(*) AS n FROM flume_rows")
  return Number(res.rows[0]?.n ?? 0)
}

// Replace the stored window set with the client's current windows. Windows are
// small and edited as a whole; a delete-all + insert keeps the server an exact
// mirror of the client during Phase 1 dual-write (no orphaned windows).
export async function replaceWindows(windows: ConfigWindow[]): Promise<void> {
  await ensureSchema()
  const db = getDb()
  const stmts = [
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
  await db.batch(stmts, "write")
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

// Clear all data (rows + rollups). Windows/maintenance are untouched — they are
// still client-owned in this phase.
export async function clearAllData(): Promise<void> {
  await ensureSchema()
  const db = getDb()
  await db.batch(
    ["DELETE FROM flume_rows", "DELETE FROM daily_rollup"],
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

export interface RollupRow {
  date: string
  station: string
  gallons: number
  isSprinklerDay: boolean
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
