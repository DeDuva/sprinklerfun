import type {
  AppConfig,
  Breakdown,
  ChartBar,
  ConfigVersion,
  DailyRow,
  EnrichedRow,
  FlumeRow,
  ProgramConfig,
  StationStats,
  TimeBucket,
  TimeWindow,
  WeeklyRow,
} from "./types"
import { DEFAULT_CONFIG } from "./types"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseTimeToMinutes(timeStr: string): number {
  const [h, m] = timeStr.split(":").map(Number)
  return h * 60 + m
}

// Returns ISO week key "YYYY-Www" and Monday date for a given date string
function isoWeek(dateStr: string): { weekKey: string; weekStart: string } {
  const d = new Date(dateStr + "T12:00:00")
  const dow = (d.getDay() + 6) % 7 // 0=Mon
  const monday = new Date(d)
  monday.setDate(d.getDate() - dow)
  const y = monday.getFullYear()
  const jan4 = new Date(y, 0, 4)
  const weekNum = Math.ceil(
    ((monday.getTime() - jan4.getTime()) / 86400000 + jan4.getDay() + 1) / 7
  )
  const weekKey = `${y}-W${String(weekNum).padStart(2, "0")}`
  const weekStart = monday.toISOString().slice(0, 10)
  return { weekKey, weekStart }
}

function monthKey(dateStr: string): string {
  return dateStr.slice(0, 7) // "YYYY-MM"
}

// ---------------------------------------------------------------------------
// Core enrichment (single config)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Local-time helpers
// ---------------------------------------------------------------------------

/**
 * Extract local-time date string ("YYYY-MM-DD") and minutes-since-midnight from
 * a datetime string. Using new Date() and getFullYear/getMonth/getDate/getHours/
 * getMinutes ensures UTC-stamped Flume data (e.g. "2024-05-22T10:45:00Z") is
 * converted to the browser's local timezone before comparing against configured
 * times (which the user enters in their local timezone).
 *
 * For timezone-naive strings (no Z/offset), JS treats them as local time —
 * so test data and manually-entered datetimes are handled correctly too.
 */
function localDateAndMin(datetime: string): { date: string; rowMin: number } {
  const d = new Date(datetime)
  const y  = d.getFullYear()
  const mo = d.getMonth() + 1
  const dy = d.getDate()
  const date = `${y}-${String(mo).padStart(2, "0")}-${String(dy).padStart(2, "0")}`
  const rowMin = d.getHours() * 60 + d.getMinutes()
  return { date, rowMin }
}

export function enrichRows(rows: FlumeRow[], config: AppConfig): EnrichedRow[] {
  if (rows.length === 0) return []

  // Group rows by LOCAL date and precompute local rowMin — one Date object per row.
  // Flume exports UTC timestamps; using new Date() converts them to local time so
  // the computed minutes align with the user's configured start times.
  const byDate = new Map<string, { rows: Array<{ row: FlumeRow; rowMin: number }>; dow: number }>()
  for (const row of rows) {
    const { date, rowMin } = localDateAndMin(row.datetime)
    if (!byDate.has(date)) {
      // Use noon on the local date for DOW to avoid any midnight-boundary ambiguity
      const d = new Date(date + "T12:00:00")
      const dow = (d.getDay() + 6) % 7 // 0=Mon
      byDate.set(date, { rows: [], dow })
    }
    byDate.get(date)!.rows.push({ row, rowMin })
  }

  const results: EnrichedRow[] = []

  for (const [date, { rows: dateRows, dow }] of byDate) {
    // Build ordered station windows for this date by scanning all enabled programs
    // on both timers whose days array includes today's DOW.
    const allWindows: Array<{
      stationId: string
      timer: string
      startMin: number
      endMin: number
    }> = []
    let windowMin = Infinity
    let windowMax = -Infinity

    for (const [timerKey, timer] of [
      ["timer1", config.timer1],
      ["timer2", config.timer2],
    ] as const) {
      for (const prog of Object.values(timer.programs) as ProgramConfig[]) {
        if (!prog.enabled || !prog.days.includes(dow)) continue

        const progStartMin = parseTimeToMinutes(prog.start)
        let cursor = progStartMin

        for (const station of timer.stations) {
          const ps = prog.stations[station.id]
          const dur = ps?.durationMin ?? 0
          const ena = ps?.enabled ?? false
          const end = cursor + dur
          if (ena && dur > 0) {
            allWindows.push({ stationId: station.id, timer: timerKey, startMin: cursor, endMin: end })
            if (cursor < windowMin) windowMin = cursor
            if (end > windowMax) windowMax = end
          }
          cursor = end
        }
      }
    }

    // Detect sprinkler day: sum gallons within the full span of all windows
    let windowGallons = 0
    if (windowMin !== Infinity) {
      for (const { row, rowMin } of dateRows) {
        if (rowMin >= windowMin && rowMin <= windowMax) {
          windowGallons += row.gallons
        }
      }
    }
    const isSprinklerDay = windowGallons > config.sprinklerOnThreshold

    // Tag each row with its station and timer
    for (const { row, rowMin } of dateRows) {
      let station = "house"
      let timer = "house"
      if (isSprinklerDay) {
        for (const w of allWindows) {
          if (rowMin > w.startMin && rowMin <= w.endMin) {
            station = w.stationId
            timer = w.timer
            break
          }
        }
      }

      results.push({
        datetime: row.datetime,
        date,
        timeMin: rowMin,  // local minutes — aligns with configured times
        gallons: row.gallons,
        station,
        timer,
        isSprinklerDay,
      })
    }
  }

  return results.sort((a, b) => a.datetime.localeCompare(b.datetime))
}

// ---------------------------------------------------------------------------
// Multi-config enrichment (time-aware)
// ---------------------------------------------------------------------------

/**
 * Enrich rows using the correct config version for each date.
 *
 * A config saved on date D applies to all data from D onward, until the next
 * config version. Data before the first saved config uses that OLDEST saved
 * config (not the built-in DEFAULT_CONFIG), because the oldest saved config
 * is the best approximation of what the system looked like before the user
 * started tracking changes. DEFAULT_CONFIG is a generic placeholder that
 * almost never matches a real installation's timer start times.
 */
export function enrichRowsMultiConfig(
  rows: FlumeRow[],
  configHistory: ConfigVersion[]
): EnrichedRow[] {
  if (rows.length === 0) return []
  if (configHistory.length === 0) return enrichRows(rows, DEFAULT_CONFIG)

  // Oldest-first segments: [{ fromDate, config }]
  const sorted = [...configHistory].sort((a, b) => a.savedAt.localeCompare(b.savedAt))
  const segments: Array<{ fromDate: string; config: AppConfig }> = [
    // Use the oldest saved config for all data that predates it.
    // This correctly handles historical data loaded before the user first saved.
    { fromDate: "0000-00-00", config: sorted[0].config },
    ...sorted.map((v) => ({ fromDate: v.savedAt.slice(0, 10), config: v.config })),
  ]

  // Which segment index applies to a given date?
  function segmentIdx(date: string): number {
    let idx = 0
    for (let i = 0; i < segments.length; i++) {
      if (segments[i].fromDate <= date) idx = i
      else break
    }
    return idx
  }

  // Group rows by segment
  const groups = new Map<number, FlumeRow[]>()
  for (const row of rows) {
    const idx = segmentIdx(row.datetime.slice(0, 10))
    if (!groups.has(idx)) groups.set(idx, [])
    groups.get(idx)!.push(row)
  }

  // Enrich each group and merge
  const results: EnrichedRow[] = []
  for (const [idx, batch] of groups) {
    results.push(...enrichRows(batch, segments[idx].config))
  }
  return results.sort((a, b) => a.datetime.localeCompare(b.datetime))
}

// ---------------------------------------------------------------------------
// Daily / Weekly aggregations
// ---------------------------------------------------------------------------

export function buildDailyRows(enriched: EnrichedRow[]): DailyRow[] {
  const byDate: Record<string, DailyRow> = {}
  for (const row of enriched) {
    if (!byDate[row.date]) {
      byDate[row.date] = { date: row.date, isSprinklerDay: false, totalGallons: 0, byStation: {} }
    }
    const day = byDate[row.date]
    day.totalGallons += row.gallons
    day.byStation[row.station] = (day.byStation[row.station] ?? 0) + row.gallons
    if (row.isSprinklerDay) day.isSprinklerDay = true
  }
  return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date))
}

export function buildWeeklyRows(dailyRows: DailyRow[]): WeeklyRow[] {
  const byWeek: Record<string, WeeklyRow> = {}
  for (const day of dailyRows) {
    const { weekKey, weekStart } = isoWeek(day.date)
    if (!byWeek[weekKey]) {
      byWeek[weekKey] = { weekKey, weekStart, totalGallons: 0, sprinklerGallons: 0, houseGallons: 0 }
    }
    const w = byWeek[weekKey]
    w.totalGallons += day.totalGallons
    const sprinkler = Object.entries(day.byStation)
      .filter(([k]) => k !== "house")
      .reduce((s, [, v]) => s + v, 0)
    w.sprinklerGallons += sprinkler
    w.houseGallons += day.byStation["house"] ?? 0
  }
  return Object.values(byWeek).sort((a, b) => a.weekKey.localeCompare(b.weekKey))
}

// ---------------------------------------------------------------------------
// Chart aggregation
// ---------------------------------------------------------------------------

export function windowToBucket(w: TimeWindow): TimeBucket {
  if (w === "2w" || w === "1m") return "day"
  if (w === "3m" || w === "6m") return "week"
  return "month"
}

export function windowCutoff(w: TimeWindow, lastDate: string): string {
  if (w === "all") return "0000-00-00"
  const d = new Date(lastDate + "T12:00:00")
  const days = { "2w": 14, "1m": 30, "3m": 90, "6m": 180, "1y": 365 }[w]!
  d.setDate(d.getDate() - days)
  return d.toISOString().slice(0, 10)
}

function detectAnomalies(values: number[]): boolean[] {
  if (values.length < 4) return values.map(() => false)
  const sorted = [...values].sort((a, b) => a - b)
  const q1 = sorted[Math.floor(sorted.length * 0.25)]
  const q3 = sorted[Math.floor(sorted.length * 0.75)]
  const iqr = q3 - q1
  const upper = q3 + 1.5 * iqr
  return values.map((v) => v > upper)
}

export function aggregateForChart(
  enriched: EnrichedRow[],
  bucket: TimeBucket,
  breakdown: Breakdown
): ChartBar[] {
  if (enriched.length === 0) return []

  function bucketOf(date: string): { key: string; label: string; start: string } {
    if (bucket === "day") {
      const d = new Date(date + "T12:00:00")
      const label = d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
      return { key: date, label, start: date }
    }
    if (bucket === "week") {
      const { weekKey, weekStart } = isoWeek(date)
      const d = new Date(weekStart + "T12:00:00")
      const label = d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
      return { key: weekKey, label, start: weekStart }
    }
    // month
    const key = monthKey(date)
    const d = new Date(key + "-01T12:00:00")
    const label = d.toLocaleDateString(undefined, { month: "short", year: "2-digit" })
    return { key, label, start: key + "-01" }
  }

  const buckets = new Map<
    string,
    { label: string; start: string; end: string; stacks: Record<string, number>; total: number }
  >()

  for (const row of enriched) {
    const { key, label, start } = bucketOf(row.date)
    if (!buckets.has(key)) {
      buckets.set(key, { label, start, end: row.date, stacks: {}, total: 0 })
    }
    const b = buckets.get(key)!
    if (row.date > b.end) b.end = row.date
    b.total += row.gallons

    let stackKey: string
    if (breakdown === "simple") {
      stackKey = row.timer === "house" ? "house" : "sprinkler"
    } else if (breakdown === "timer") {
      stackKey = row.timer
    } else {
      stackKey = row.station
    }
    b.stacks[stackKey] = (b.stacks[stackKey] ?? 0) + row.gallons
  }

  const sorted = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b))
  const totals = sorted.map(([, b]) => b.total)
  const anomalyFlags = detectAnomalies(totals)

  return sorted.map(([, b], i) => ({
    label: b.label,
    dateStart: b.start,
    dateEnd: b.end,
    total: b.total,
    isAnomaly: anomalyFlags[i],
    ...b.stacks,
  }))
}

// ---------------------------------------------------------------------------
// Station stats
// ---------------------------------------------------------------------------

export function buildStationStats(enriched: EnrichedRow[], config: AppConfig): StationStats[] {
  const sprinklerRows = enriched.filter((r) => r.station !== "house")
  if (sprinklerRows.length === 0) return []

  const grouped: Record<string, number[]> = {}
  for (const row of sprinklerRows) {
    if (!grouped[row.station]) grouped[row.station] = []
    grouped[row.station].push(row.gallons)
  }

  const totalSprinklerGallons = sprinklerRows.reduce((s, r) => s + r.gallons, 0)

  const nameLookup: Record<string, string> = {}
  for (const s of [...config.timer1.stations, ...config.timer2.stations]) {
    nameLookup[s.id] = s.name
  }

  const stats: StationStats[] = Object.entries(grouped).map(([id, values]) => {
    const total = values.reduce((s, v) => s + v, 0)
    const avg = total / values.length
    const min = Math.min(...values)
    const max = Math.max(...values)
    const std = Math.sqrt(values.reduce((s, v) => s + (v - avg) ** 2, 0) / values.length)
    return {
      id,
      name: nameLookup[id] ?? id,
      totalGallons: total,
      avgGpm: avg,
      minGpm: min,
      maxGpm: max,
      stdGpm: std,
      costEstimate: (total / config.gallonsPerUnit) * config.costPerUnit,
      pctOfSprinkler: totalSprinklerGallons > 0 ? total / totalSprinklerGallons : 0,
    }
  })

  return stats.sort((a, b) => b.totalGallons - a.totalGallons)
}

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

export interface StationWarning {
  stationId: string
  stationName: string
  baselineGpm: number
  recentAvgGpm: number
  pctAboveBaseline: number
  consecutiveDaysAbove: number
}

const WARN_THRESHOLD = 0.2
const WARN_MIN_DAYS = 2

export function computeStationWarnings(
  enriched: EnrichedRow[],
  config: AppConfig,
  lookbackDays = 21
): StationWarning[] {
  if (enriched.length === 0) return []

  const allDates = [...new Set(enriched.map((r) => r.date))].sort()
  const cutoff = allDates[Math.max(0, allDates.length - lookbackDays)]
  const recent = enriched.filter((r) => r.date >= cutoff && r.station !== "house")

  const stationLookup: Record<string, { name: string; baselineGpm: number }> = {}
  for (const s of [...config.timer1.stations, ...config.timer2.stations]) {
    if (s.baselineGpm && s.baselineGpm > 0) {
      stationLookup[s.id] = { name: s.name, baselineGpm: s.baselineGpm }
    }
  }
  if (Object.keys(stationLookup).length === 0) return []

  const grouped: Record<string, Record<string, number[]>> = {}
  for (const row of recent) {
    if (!stationLookup[row.station]) continue
    if (!grouped[row.station]) grouped[row.station] = {}
    if (!grouped[row.station][row.date]) grouped[row.station][row.date] = []
    grouped[row.station][row.date].push(row.gallons)
  }

  const warnings: StationWarning[] = []
  for (const [stationId, byDate] of Object.entries(grouped)) {
    const { name, baselineGpm } = stationLookup[stationId]
    const sortedDates = Object.keys(byDate).sort()
    const allValues = sortedDates.flatMap((d) => byDate[d])
    const recentAvgGpm = allValues.reduce((s, v) => s + v, 0) / allValues.length

    const limit = baselineGpm * (1 + WARN_THRESHOLD)
    let consecutive = 0
    for (let i = sortedDates.length - 1; i >= 0; i--) {
      const vals = byDate[sortedDates[i]]
      const dayAvg = vals.reduce((s, v) => s + v, 0) / vals.length
      if (dayAvg > limit) consecutive++
      else break
    }

    const pctAbove = (recentAvgGpm - baselineGpm) / baselineGpm
    if (consecutive >= WARN_MIN_DAYS && pctAbove > WARN_THRESHOLD) {
      warnings.push({ stationId, stationName: name, baselineGpm, recentAvgGpm, pctAboveBaseline: pctAbove, consecutiveDaysAbove: consecutive })
    }
  }
  return warnings.sort((a, b) => b.pctAboveBaseline - a.pctAboveBaseline)
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export function computeSummary(dailyRows: DailyRow[], config: AppConfig) {
  const totalGallons = dailyRows.reduce((s, d) => s + d.totalGallons, 0)
  const sprinklerGallons = dailyRows.reduce(
    (s, d) =>
      s + Object.entries(d.byStation).filter(([k]) => k !== "house").reduce((ss, [, v]) => ss + v, 0),
    0
  )
  const houseGallons = totalGallons - sprinklerGallons
  const estimatedCost = (totalGallons / config.gallonsPerUnit) * config.costPerUnit
  return { totalGallons, sprinklerGallons, houseGallons, estimatedCost }
}
