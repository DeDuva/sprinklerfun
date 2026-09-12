import type {
  AppConfig,
  Breakdown,
  ChartBar,
  ConfigWindow,
  DailyRow,
  DelayFit,
  DelayRecommendation,
  EnrichedRow,
  ExpectedSegment,
  FlumeRow,
  MinutePoint,
  ProgramId,
  RollupRow,
  SegmentReconciliation,
  StationStats,
  StationWarning,
  TimeBucket,
  TimerConfig,
  TimeWindow,
  WeeklyRow,
} from "./types"
import { DEFAULT_CONFIG, normalizeTime } from "./types"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseTimeToMinutes(timeStr: string): number {
  const [h, m] = timeStr.split(":").map(Number)
  return h * 60 + m
}

/**
 * "YYYY-MM-DD" for a Date, in LOCAL time.
 *
 * `toISOString().slice(0, 10)` looks like it does this and does not: it converts
 * to UTC first. Every date in this app is a local calendar day — a sprinkler day,
 * a rollup key, "today" — so the UTC conversion is wrong in both directions.
 *
 * West of UTC it is wrong every evening: at 17:00 in America/Los_Angeles it is
 * already tomorrow in UTC, so "today" silently became the next day for the rest
 * of the night. East of UTC+12 it is wrong the other way — the noon anchor these
 * helpers use to dodge DST lands on the previous UTC day, which is why the suite
 * failed under Pacific/Kiritimati while passing under UTC by luck.
 */
export function localDateKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
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
  const weekStart = localDateKey(monday)
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
// Flume's export is timezone-naive ("2026-08-22 00:00:00") and everything
// downstream wants "minute of the local day", so parse the string rather than
// round-tripping it through Date.
//
// The round trip was not merely wasteful, it was wrong in two ways. The server
// runs UTC on Vercel and the browser runs Pacific, so the same row could land on
// different days depending on who parsed it. And on the spring-forward day a
// naive 02:30 does not exist locally — `new Date()` silently moves it to 03:30,
// so the client's day view attributed that hour differently from the server's
// rollups. A lexical parse is identical everywhere, on every date.
function localDateAndMin(datetime: string): { date: string; rowMin: number } {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/.exec(datetime)
  // Ingest rejects anything this cannot match (app/api/rows/route.ts), so this
  // is a floor rather than a path: take the date prefix and midnight instead of
  // the NaN cascade the old Date parse produced for malformed input.
  if (!m) return { date: datetime.slice(0, 10), rowMin: 0 }
  return { date: m[1], rowMin: Number(m[2]) * 60 + Number(m[3]) }
}

/**
 * Reconstruct the configured station schedule for a single day-of-week.
 *
 * Walks every enabled program on both timers whose `days` include `dow`, and for
 * each lays out its stations in run order from the program start: station i runs
 * for `[cursor, cursor + durationMin]`, then the cursor advances by that duration
 * plus the timer's `stationDelaySec`. Only enabled stations with a positive
 * duration produce a segment. With no delay configured (the default, and every
 * config written before the field existed) the layout is back-to-back and
 * byte-identical to what this produced before.
 *
 * Segments are returned in iteration order — timer1 programs A/B/C, then timer2 —
 * which is the order `enrichRows` relies on for first-match station assignment.
 * `dow` is 0=Mon … 6=Sun.
 */
export function buildDaySchedule(config: AppConfig, dow: number): ExpectedSegment[] {
  const segments: ExpectedSegment[] = []

  for (const [timerKey, timer] of [
    ["timer1", config.timer1],
    ["timer2", config.timer2],
  ] as const) {
    const baselineById = new Map<string, number | null>()
    for (const s of timer.stations) {
      baselineById.set(s.id, s.baselineGpm != null && s.baselineGpm > 0 ? s.baselineGpm : null)
    }
    const nameById = new Map(timer.stations.map((s) => [s.id, s.name]))

    for (const pid of ["A", "B", "C"] as ProgramId[]) {
      const prog = timer.programs[pid]
      if (!prog || !prog.enabled || !prog.days.includes(dow)) continue

      // Dead time the controller inserts between stations. Held as a fraction of
      // a minute and accumulated on a fractional cursor — a 30 s delay is real
      // and compounds across a run, but never resolves as a gap in 1-minute
      // meter bins, so rounding it away per-station would lose it entirely.
      const delayMin = Math.max(0, timer.stationDelaySec ?? 0) / 60

      let cursor = parseTimeToMinutes(prog.start)
      let emitted = 0
      for (const station of timer.stations) {
        const ps = prog.stations[station.id]
        const dur = ps?.durationMin ?? 0
        const ena = ps?.enabled ?? false
        if (ena && dur > 0) {
          // The delay falls BEFORE every station after the first, so the program
          // start stays exact and the offset accumulates down the run. Nothing is
          // added after the last station — the delay is a gap between stations,
          // not a tail on the program.
          if (emitted > 0) cursor += delayMin
          // Round both ends off the same fractional cursor, so the emitted span
          // is always exactly durationMin and every downstream consumer
          // (enrichRows' `startMin < rowMin <= endMin`, reconcileDay's boundary
          // space, the chart's step line) keeps working in whole minutes.
          const start = Math.round(cursor)
          const end = Math.round(cursor + dur)
          segments.push({
            stationId: station.id,
            name: nameById.get(station.id) ?? station.id,
            timer: timerKey,
            programId: pid,
            startMin: start,
            endMin: end,
            durationMin: dur,
            baselineGpm: baselineById.get(station.id) ?? null,
          })
          cursor += dur
          emitted++
        }
      }
    }
  }

  return segments
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
    // Build ordered station windows for this date from the configured schedule.
    const allWindows = buildDaySchedule(config, dow)
    let windowMin = Infinity
    let windowMax = -Infinity
    for (const w of allWindows) {
      if (w.startMin < windowMin) windowMin = w.startMin
      if (w.endMin > windowMax) windowMax = w.endMin
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
 * Enrich rows using the config window active on each date.
 *
 * A window with effectiveFrom = D applies to all data from D onward, until the
 * next window. Data before the earliest window uses that EARLIEST window's
 * config (not the built-in DEFAULT_CONFIG), because the earliest window is the
 * best approximation of what the system looked like before the user started
 * tracking changes. DEFAULT_CONFIG is a generic placeholder that almost never
 * matches a real installation's timer start times.
 */
export function enrichRowsMultiConfig(
  rows: FlumeRow[],
  windows: ConfigWindow[]
): EnrichedRow[] {
  if (rows.length === 0) return []
  if (windows.length === 0) return enrichRows(rows, DEFAULT_CONFIG)

  // Oldest-first segments: [{ fromDate, config }]
  const sorted = [...windows].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
  const segments: Array<{ fromDate: string; config: AppConfig }> = [
    // Use the earliest window's config for all data that predates it.
    // This correctly handles historical data loaded before the first window.
    { fromDate: "0000-00-00", config: sorted[0].config },
    ...sorted.map((w) => ({ fromDate: w.effectiveFrom, config: w.config })),
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
// Rollup reconstruction (Phase 3)
//
// The dashboard no longer loads the full per-minute series. Instead it reads the
// server's `daily_rollup` (one gallon sum per date+station) via GET /api/rollup
// and reconstructs the two shapes the pure aggregations expect:
//   • DailyRow[]      — for computeSummary / date-range / sprinkler-day lists
//   • EnrichedRow[]   — a SYNTHETIC one-row-per-(date,station) series for
//                       aggregateForChart (which only reads date/station/timer/
//                       gallons — never timeMin — so pre-summed rows are exact).
// ---------------------------------------------------------------------------

/** Rebuild DailyRow[] from persisted rollup rows (inverse of buildDailyRows). */
export function rollupsToDailyRows(rollups: RollupRow[]): DailyRow[] {
  const byDate: Record<string, DailyRow> = {}
  for (const r of rollups) {
    if (!byDate[r.date]) {
      byDate[r.date] = { date: r.date, isSprinklerDay: false, totalGallons: 0, byStation: {} }
    }
    const day = byDate[r.date]
    day.totalGallons += r.gallons
    day.byStation[r.station] = (day.byStation[r.station] ?? 0) + r.gallons
    if (r.isSprinklerDay) day.isSprinklerDay = true
  }
  return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * Map each station id → its timer ("timer1"/"timer2"), unioned across every
 * window's config (station ids are stable across windows). "house" maps to
 * "house". Used to tag synthetic rollup-derived rows so aggregateForChart's
 * timer/simple breakdowns match the client's old per-minute output.
 */
export function stationTimerMap(windows: ConfigWindow[]): Record<string, string> {
  const map: Record<string, string> = { house: "house" }
  for (const w of windows) {
    for (const s of w.config.timer1.stations) map[s.id] = "timer1"
    for (const s of w.config.timer2.stations) map[s.id] = "timer2"
  }
  return map
}

/**
 * Build a SYNTHETIC EnrichedRow[] from rollup rows — one row per (date, station)
 * carrying the day's summed gallons. `aggregateForChart` groups by date bucket
 * and sums gallons per stack key (derived from station/timer), so feeding it
 * these pre-summed rows yields bucket totals identical to enriching the full
 * per-minute series. `timeMin`/`datetime` are placeholders (unused by the chart).
 */
export function rollupsToEnriched(
  rollups: RollupRow[],
  timerOf: Record<string, string>
): EnrichedRow[] {
  return rollups.map((r) => ({
    datetime: `${r.date}T00:00:00`,
    date: r.date,
    timeMin: 0,
    gallons: r.gallons,
    station: r.station,
    timer: timerOf[r.station] ?? "house",
    isSprinklerDay: r.isSprinklerDay,
  }))
}

// ---------------------------------------------------------------------------
// Window selection / ranges / diffing — shared by the config page, dashboard,
// and chart so the "which config was active when" logic lives in one place.
// ---------------------------------------------------------------------------

/** Add (or subtract) whole days to a "YYYY-MM-DD" date string. */
export function addDays(dateStr: string, delta: number): string {
  const d = new Date(dateStr + "T12:00:00")
  d.setDate(d.getDate() + delta)
  return localDateKey(d)
}

/**
 * The config window active on a given date. The earliest window also covers
 * all dates before it (matches enrichRowsMultiConfig). Returns null only when
 * there are no windows.
 */
export function activeWindowForDate(windows: ConfigWindow[], date: string): ConfigWindow | null {
  if (windows.length === 0) return null
  const sorted = [...windows].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
  let active = sorted[0] // earliest covers the past
  for (const w of sorted) {
    if (w.effectiveFrom <= date) active = w
    else break
  }
  return active
}

export interface WindowRange {
  id: string
  effectiveFrom: string
  effectiveTo: string | null // null = open (current / "now")
}

/**
 * Derive each window's [effectiveFrom, effectiveTo] from contiguous boundaries:
 * a window ends the day before the next window starts; the last window is open.
 */
export function windowDateRange(windows: ConfigWindow[]): WindowRange[] {
  const sorted = [...windows].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
  return sorted.map((w, i) => {
    const next = sorted[i + 1]
    return {
      id: w.id,
      effectiveFrom: w.effectiveFrom,
      effectiveTo: next ? addDays(next.effectiveFrom, -1) : null,
    }
  })
}

/** The config in effect today (for "current" displays: names, billing). */
export function currentConfig(windows: ConfigWindow[]): AppConfig {
  const today = localDateKey(new Date())
  return activeWindowForDate(windows, today)?.config ?? DEFAULT_CONFIG
}

// ---- Config diffing -------------------------------------------------------

export interface ConfigChange {
  area: string  // e.g. "Timer 1 · Program A", "Detection & Billing"
  field: string // e.g. "Start time", "Front Lawn duration"
  from: string
  to: string
}

const DIFF_DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
function fmtDays(days: number[]): string {
  if (!days || days.length === 0) return "none"
  return [...days].sort((a, b) => a - b).map((d) => DIFF_DAY_NAMES[d] ?? String(d)).join(" ")
}
const hm = (t: string) => normalizeTime(t).slice(0, 5)

/**
 * Human-readable diff of two configs (previous window → this window). Powers the
 * "changed vs. previous window" panel and richer chart-marker context.
 */
export function diffConfigs(prev: AppConfig, next: AppConfig): ConfigChange[] {
  const changes: ConfigChange[] = []
  if (!prev || !next) return changes

  for (const [tk, tlabel] of [["timer1", "Timer 1"], ["timer2", "Timer 2"]] as const) {
    const pt: TimerConfig = prev[tk]
    const nt: TimerConfig = next[tk]
    if (!pt || !nt) continue

    // Hardware: inter-station delay, station add/remove, name + baseline changes
    const pDelay = pt.stationDelaySec ?? 0
    const nDelay = nt.stationDelaySec ?? 0
    if (pDelay !== nDelay) {
      changes.push({ area: tlabel, field: "Station delay", from: `${pDelay}s`, to: `${nDelay}s` })
    }

    const pById = new Map(pt.stations.map((s) => [s.id, s]))
    const nById = new Map(nt.stations.map((s) => [s.id, s]))
    for (const s of nt.stations) if (!pById.has(s.id)) changes.push({ area: tlabel, field: "Station added", from: "—", to: s.name || s.id })
    for (const s of pt.stations) if (!nById.has(s.id)) changes.push({ area: tlabel, field: "Station removed", from: s.name || s.id, to: "—" })
    for (const s of nt.stations) {
      const ps = pById.get(s.id)
      if (!ps) continue
      if (ps.name !== s.name) changes.push({ area: tlabel, field: `${s.id} name`, from: ps.name, to: s.name })
      const pb = ps.baselineGpm ?? null
      const nb = s.baselineGpm ?? null
      if (pb !== nb) changes.push({ area: tlabel, field: `${s.name || s.id} baseline gpm`, from: pb == null ? "—" : String(pb), to: nb == null ? "—" : String(nb) })
    }

    // Schedule: per-program start / days / enabled / station durations
    for (const pid of ["A", "B", "C"] as ProgramId[]) {
      const pp = pt.programs[pid]
      const np = nt.programs[pid]
      if (!pp || !np) continue
      const area = `${tlabel} · Program ${pid}`
      if (pp.enabled !== np.enabled) changes.push({ area, field: "Enabled", from: pp.enabled ? "on" : "off", to: np.enabled ? "on" : "off" })
      if (hm(pp.start) !== hm(np.start)) changes.push({ area, field: "Start time", from: hm(pp.start), to: hm(np.start) })
      if (fmtDays(pp.days) !== fmtDays(np.days)) changes.push({ area, field: "Days", from: fmtDays(pp.days), to: fmtDays(np.days) })

      const ids = new Set([...Object.keys(pp.stations), ...Object.keys(np.stations)])
      const nameOf = (id: string) => nById.get(id)?.name ?? pById.get(id)?.name ?? id
      for (const id of ids) {
        const a = pp.stations[id] ?? { durationMin: 0, enabled: false }
        const b = np.stations[id] ?? { durationMin: 0, enabled: false }
        const aOn = a.enabled && a.durationMin > 0
        const bOn = b.enabled && b.durationMin > 0
        if (aOn !== bOn) changes.push({ area, field: nameOf(id), from: aOn ? `${a.durationMin}m` : "off", to: bOn ? `${b.durationMin}m` : "off" })
        else if (bOn && a.durationMin !== b.durationMin) changes.push({ area, field: `${nameOf(id)} duration`, from: `${a.durationMin}m`, to: `${b.durationMin}m` })
      }
    }
  }

  // Detection & billing
  if (prev.sprinklerOnThreshold !== next.sprinklerOnThreshold) changes.push({ area: "Detection & Billing", field: "Sprinkler-on threshold", from: String(prev.sprinklerOnThreshold), to: String(next.sprinklerOnThreshold) })
  if (prev.gallonsPerUnit !== next.gallonsPerUnit) changes.push({ area: "Detection & Billing", field: "Gallons per unit", from: String(prev.gallonsPerUnit), to: String(next.gallonsPerUnit) })
  if (prev.costPerUnit !== next.costPerUnit) changes.push({ area: "Detection & Billing", field: "Cost per unit", from: String(prev.costPerUnit), to: String(next.costPerUnit) })

  return changes
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
  return localDateKey(d)
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
// Timing & flow calibration (Analysis tab)
// ---------------------------------------------------------------------------

/**
 * Per-minute actual flow for a single day. Each Flume row is a 1-minute bin, so
 * gallons-in-the-minute == gpm. Rows sharing a minute are summed (defensive).
 * Returns points sorted by minute.
 */
export function buildDayMinuteSeries(dayRows: EnrichedRow[]): MinutePoint[] {
  const byMin = new Map<number, number>()
  for (const r of dayRows) byMin.set(r.timeMin, (byMin.get(r.timeMin) ?? 0) + r.gallons)
  return [...byMin.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([timeMin, gpm]) => ({ timeMin, gpm }))
}

export interface ReconcileOptions {
  /** Flow at/above this gpm counts as "on". Default derives from baselines. */
  onThresholdGpm?: number
  /** How many minutes around the configured start to search for the actual run. */
  driftSearchMin?: number
  /** Minimum gpm step for an interior station boundary to be unambiguous. */
  minStepGpm?: number
  /**
   * Longest off-gap still treated as dead time between two stations of the same
   * program rather than the end of the program. Above this, a quiet stretch
   * separates two different programs.
   */
  maxDelayMin?: number
}

// ---------------------------------------------------------------------------
// Program run detection
// ---------------------------------------------------------------------------

/** One program's metered run: its span, the on-fragments inside it, and the gaps. */
export interface ProgramRun {
  start: number   // first on-minute
  end: number     // last on-minute
  onThreshold: number
  /** Contiguous on-stretches. More than one means dead time is visible. */
  fragments: Array<{ start: number; end: number }>
  /** Off-minutes between consecutive fragments — the measured dead times. */
  gaps: number[]
}

/** Build the minute→gpm lookup both the reconciler and the estimator read. */
export function seriesMap(series: MinutePoint[]): Map<number, number> {
  const m = new Map<number, number>()
  for (const p of series) m.set(p.timeMin, p.gpm)
  return m
}

/**
 * Locate one program's actual run in the metered series.
 *
 * A program with an inter-station delay does NOT produce one continuous run —
 * it fragments into a stretch per station, separated by the dead time. Picking
 * the single longest fragment (which is what this logic did when it was inline
 * in `reconcileDay`) truncates the program at its first delay and mis-assigns
 * everything after it. So fragments separated by no more than `maxDelayMin` are
 * merged into one run, and the gaps between them are kept — they are the direct
 * measurement `inferStationDelay` needs.
 */
export function findProgramRun(
  gpmAt: Map<number, number>,
  ordered: ExpectedSegment[],
  opts: ReconcileOptions = {}
): ProgramRun | null {
  if (ordered.length === 0) return null
  const at = (m: number) => gpmAt.get(m) ?? 0
  const driftSearch = opts.driftSearchMin ?? 10
  const maxDelay = opts.maxDelayMin ?? 5

  const progStart = ordered[0].startMin
  const progEnd = ordered[ordered.length - 1].endMin

  const baselines = ordered
    .map((s) => s.baselineGpm)
    .filter((b): b is number => b != null && b > 0)
  const onThreshold =
    opts.onThresholdGpm ?? (baselines.length ? Math.max(0.5, 0.4 * Math.min(...baselines)) : 0.5)

  // Search wide enough to contain a run that has stretched by the largest delay
  // we would still call a delay, not just the configured span plus drift.
  const lo = progStart - driftSearch
  const hi = progEnd + driftSearch + maxDelay * ordered.length

  const frags: Array<{ start: number; end: number }> = []
  let cur: { start: number; end: number } | null = null
  for (let m = lo; m <= hi; m++) {
    if (at(m) >= onThreshold) {
      if (!cur) cur = { start: m, end: m }
      else cur.end = m
    } else if (cur) {
      frags.push(cur)
      cur = null
    }
  }
  if (cur) frags.push(cur)
  if (frags.length === 0) return null

  // Merge fragments separated by dead time into candidate runs.
  const runs: ProgramRun[] = []
  let acc: ProgramRun | null = null
  for (const f of frags) {
    if (acc && f.start - acc.end - 1 <= maxDelay) {
      acc.gaps.push(f.start - acc.end - 1)
      acc.fragments.push(f)
      acc.end = f.end
    } else {
      if (acc) runs.push(acc)
      acc = { start: f.start, end: f.end, onThreshold, fragments: [f], gaps: [] }
    }
  }
  if (acc) runs.push(acc)

  // Pick the run overlapping the configured span most; else the longest.
  let best: ProgramRun | null = null
  let bestOverlap = 0
  for (const r of runs) {
    const ov = Math.min(r.end, progEnd) - Math.max(r.start, progStart) + 1
    if (ov > bestOverlap) {
      bestOverlap = ov
      best = r
    }
  }
  if (!best) best = runs.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a))
  return best
}

/**
 * Reconcile a day's configured schedule against its actual per-minute flow.
 *
 * Stations run back-to-back within a program, so flow is one continuous run whose
 * level steps between stations. For each program we:
 *   1. Detect the actual run — the contiguous "on" stretch (flow ≥ threshold) that
 *      best overlaps the configured span — giving the program's start drift.
 *   2. Refine each interior station boundary by searching ±a few minutes around its
 *      drift-shifted configured position for the minute with the largest flow step.
 *      When adjacent baselines are too close to separate (step < minStepGpm) the
 *      boundary falls back to its shifted configured position and is marked low-confidence.
 *   3. Measure each station's sustained gpm as the mean over its interval EXCLUDING
 *      the first and last minute (those sample the adjacent station). Runs ≤3 min
 *      have no clean interior, so they use the full mean and are low-confidence.
 *
 * Boundaries are tracked in "boundary space": boundary b sits between minute b and
 * b+1, and a station occupies on-minutes (bPrev, bThis]. This matches enrichRows'
 * `startMin < rowMin ≤ endMin` convention, so drifts compare directly to config.
 */
export function reconcileDay(
  series: MinutePoint[],
  schedule: ExpectedSegment[],
  opts: ReconcileOptions = {}
): SegmentReconciliation[] {
  const minStep = opts.minStepGpm ?? 0.5
  const REFINE_WIN = 3 // minutes each side when scoring a boundary step

  const gpmAt = seriesMap(series)
  const at = (m: number) => gpmAt.get(m) ?? 0
  const meanRange = (from: number, to: number): number | null => {
    if (to < from) return null
    let sum = 0
    let n = 0
    for (let m = from; m <= to; m++) {
      sum += at(m)
      n++
    }
    return n > 0 ? sum / n : null
  }

  // Group by program run (timer + programId).
  const groups = new Map<string, ExpectedSegment[]>()
  for (const seg of schedule) {
    const key = `${seg.timer}:${seg.programId}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(seg)
  }

  const out: SegmentReconciliation[] = []

  for (const segs of groups.values()) {
    const ordered = [...segs].sort((a, b) => a.startMin - b.startMin)
    const progStart = ordered[0].startMin

    const best = findProgramRun(gpmAt, ordered, opts)

    const baseRecon = (seg: ExpectedSegment): SegmentReconciliation => ({
      stationId: seg.stationId,
      name: seg.name,
      timer: seg.timer,
      programId: seg.programId,
      cfgStartMin: seg.startMin,
      cfgEndMin: seg.endMin,
      cfgDurationMin: seg.durationMin,
      baselineGpm: seg.baselineGpm,
      actualStartMin: null,
      actualEndMin: null,
      actualDurationMin: null,
      actualGpm: null,
      startDriftMin: null,
      durationDriftMin: null,
      gpmDeltaPct: null,
      gapBeforeMin: null,
      confidence: "low",
      confidenceReason: "No flow detected for this program",
    })

    if (!best) {
      for (const seg of ordered) out.push(baseRecon(seg))
      continue
    }

    // Program boundaries in boundary space: the run's first on-minute is the
    // minute AFTER the start boundary; its last on-minute IS the end boundary.
    const runStartBoundary = best.start - 1
    const runEndBoundary = best.end
    const progDrift = runStartBoundary - progStart

    // Build the N+1 station boundaries. boundary[0] = run start, boundary[N] = run end.
    const N = ordered.length
    const boundaries: number[] = new Array(N + 1)
    const boundaryAmbiguous: boolean[] = new Array(N + 1).fill(false)
    boundaries[0] = runStartBoundary
    boundaries[N] = runEndBoundary

    // A program shifts as a whole (progDrift) but it also STRETCHES — from dead
    // time between stations, from stations running long, or both. Boundary i is
    // displaced by roughly i x (stretch per transition) on top of the shift.
    // Anchoring on progDrift alone, as this did before, puts a late boundary far
    // outside the +-4 min refinement window below: with 11 stations and a minute
    // of stretch per transition the last one sits 10 minutes out, gets pinned to
    // a wrong position, and its duration and gpm are then reported as measured
    // fact. Spreading the observed stretch evenly puts every boundary within
    // reach; the refinement still moves each one to its true edge, so genuine
    // per-station duration error is preserved rather than smeared.
    const cfgSpan = ordered[N - 1].endMin - progStart
    const obsSpan = runEndBoundary - runStartBoundary
    const stretchPerTransition = N > 1 ? (obsSpan - cfgSpan) / (N - 1) : 0

    for (let i = 1; i < N; i++) {
      const center = Math.round(ordered[i].startMin + progDrift + i * stretchPerTransition)
      // keep boundaries monotonic and strictly inside the run
      const searchLo = Math.max(boundaries[i - 1] + 1, center - 4)
      const searchHi = Math.min(runEndBoundary - (N - i), center + 4)
      let bestB = Math.min(Math.max(center, searchLo), searchHi)
      let bestStepVal = -1
      for (let b = searchLo; b <= searchHi; b++) {
        const left = meanRange(Math.max(b - REFINE_WIN + 1, runStartBoundary + 1), b)
        const right = meanRange(b + 1, Math.min(b + REFINE_WIN, runEndBoundary))
        if (left == null || right == null) continue
        const step = Math.abs(left - right)
        if (step > bestStepVal) {
          bestStepVal = step
          bestB = b
        }
      }
      if (bestStepVal < minStep) {
        // Ambiguous — adjacent levels too similar to separate. Fall back to shifted config.
        bestB = Math.min(Math.max(center, searchLo), searchHi)
        boundaryAmbiguous[i] = true
      }
      boundaries[i] = bestB
    }

    for (let i = 0; i < N; i++) {
      const seg = ordered[i]
      const startB = boundaries[i]
      const endB = boundaries[i + 1]
      const duration = endB - startB
      const reasons: string[] = []

      // Trimmed mean: drop first & last on-minute (adjacent-station bleed).
      let actualGpm: number | null
      if (duration > 3) {
        actualGpm = meanRange(startB + 2, endB - 1)
      } else {
        actualGpm = meanRange(startB + 1, endB)
        reasons.push("Run ≤3 min — first/last minute can't be trimmed")
      }
      if (boundaryAmbiguous[i] || boundaryAmbiguous[i + 1]) {
        reasons.push("Adjacent baselines too close to pinpoint boundary")
      }

      const startDrift = startB - seg.startMin
      const durationDrift = duration - seg.durationMin
      // Dead time immediately before this station: consecutive off-minutes
      // ending at its start boundary. The first station of a program has
      // nothing before it to measure.
      let gapBeforeMin: number | null = null
      if (i > 0) {
        let n = 0
        while (n < 30 && at(startB - n) < best.onThreshold) n++
        gapBeforeMin = n
      }
      const gpmDeltaPct =
        seg.baselineGpm != null && seg.baselineGpm > 0 && actualGpm != null
          ? (actualGpm - seg.baselineGpm) / seg.baselineGpm
          : null

      out.push({
        stationId: seg.stationId,
        name: seg.name,
        timer: seg.timer,
        programId: seg.programId,
        cfgStartMin: seg.startMin,
        cfgEndMin: seg.endMin,
        cfgDurationMin: seg.durationMin,
        baselineGpm: seg.baselineGpm,
        actualStartMin: startB,
        actualEndMin: endB,
        actualDurationMin: duration,
        actualGpm,
        startDriftMin: startDrift,
        durationDriftMin: durationDrift,
        gpmDeltaPct,
        gapBeforeMin,
        confidence: reasons.length > 0 ? "low" : "high",
        confidenceReason: reasons.length > 0 ? reasons.join("; ") : undefined,
      })
    }
  }

  return out
}

// ---------------------------------------------------------------------------
// Inter-station delay inference
// ---------------------------------------------------------------------------

export interface DelayOptions extends ReconcileOptions {
  /** Below this, an inferred delay is noise rather than a controller setting. */
  minDelaySec?: number
  /** Largest delay worth fitting. */
  maxDelaySec?: number
  /** Minimum RSS improvement over a zero-delay model to trust a fit. */
  minRssImprovement?: number
}

const DELAY_STEP_SEC = 5

/** Most common value in a list, with the count that backs it. */
function mode(values: number[]): { value: number; share: number } | null {
  if (values.length === 0) return null
  const counts = new Map<number, number>()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  let bestV = values[0]
  let bestN = 0
  for (const [v, n] of counts) {
    if (n > bestN || (n === bestN && v < bestV)) {
      bestN = n
      bestV = v
    }
  }
  return { value: bestV, share: bestN / values.length }
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * Residual sum of squares of a piecewise-constant model: lay the stations out
 * from `runStart` with `delayMin` between them, then score every minute against
 * the mean of the segment it lands in. Minutes falling in a delay gap are pooled
 * separately, so a delay that correctly lines gaps up with quiet minutes scores
 * better than one that does not.
 *
 * Deliberately baseline-free. Once a run has drifted, the configured baselines
 * are being compared against the wrong stations — which is exactly the state
 * this function has to work in — so a model that leaned on them would be scoring
 * against numbers the drift has already invalidated.
 */
function piecewiseRss(
  at: (m: number) => number,
  durations: number[],
  runStart: number,
  runEnd: number,
  delayMin: number
): number {
  const buckets = new Map<number, number[]>()
  let cursor = runStart
  const push = (key: number, m: number) => {
    const b = buckets.get(key)
    if (b) b.push(at(m))
    else buckets.set(key, [at(m)])
  }
  for (let i = 0; i < durations.length; i++) {
    if (i > 0) {
      const gapEnd = Math.round(cursor + delayMin)
      for (let m = Math.round(cursor); m < gapEnd; m++) push(-1, m)
      cursor += delayMin
    }
    const a = Math.round(cursor)
    const b = Math.round(cursor + durations[i])
    for (let m = a; m < b; m++) push(i, m)
    cursor += durations[i]
  }
  // Anything past the modelled span still belongs to the run and must be scored,
  // or a too-short delay would win simply by ignoring the tail it fails to cover.
  for (let m = Math.round(cursor); m <= runEnd; m++) push(-2, m)

  let rss = 0
  for (const vals of buckets.values()) {
    if (vals.length === 0) continue
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length
    for (const v of vals) rss += (v - mean) ** 2
  }
  return rss
}

/**
 * Infer the per-transition dead time for each program run in a day.
 *
 * The estimate comes from measuring gaps, not from dividing elongation. Those
 * are different quantities and conflating them over-corrects: on the reference
 * data one timer's run stretched 16 minutes over 10 transitions, which divides
 * to 96 s, while the gaps between its stations measured a clean 60 s. The other
 * ~36 s per transition was stations running long — a duration problem that a
 * delay setting must not absorb, or the fix quietly over-waters those zones.
 *
 * So: take the modal measured gap as the delay, and report the leftover
 * elongation as `residualMin` for the duration proposals to handle. The RSS grid
 * search is the confidence gate, not the estimator — it answers "does a delay
 * model explain this run better than no delay at all", which is what separates a
 * timer with real dead time from one that is simply running long.
 *
 * When the delay is too short to blank a whole meter bin no gaps are visible at
 * all, so the elongation estimate is the only signal left; it is used, but held
 * to the `minDelaySec` floor so a rounding artifact never becomes a config edit.
 */
export function inferStationDelay(
  series: MinutePoint[],
  schedule: ExpectedSegment[],
  date: string,
  opts: DelayOptions = {}
): DelayFit[] {
  const minDelaySec = opts.minDelaySec ?? 15
  const maxDelaySec = opts.maxDelaySec ?? 180
  const minImprovement = opts.minRssImprovement ?? 0.1

  const gpmAt = seriesMap(series)
  const at = (m: number) => gpmAt.get(m) ?? 0

  const groups = new Map<string, ExpectedSegment[]>()
  for (const seg of schedule) {
    const key = `${seg.timer}:${seg.programId}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(seg)
  }

  const out: DelayFit[] = []

  for (const segs of groups.values()) {
    const ordered = [...segs].sort((a, b) => a.startMin - b.startMin)
    const N = ordered.length
    const transitions = N - 1
    const base: Omit<DelayFit, "delayMin" | "modalGapMin" | "elongationMin" |
      "delayExplainedMin" | "residualMin" | "rssImprovement" | "confidence" | "confidenceReason"> = {
      date,
      timer: ordered[0].timer,
      programId: ordered[0].programId,
      stationCount: N,
      transitions,
    }
    const unfit = (reason: string): DelayFit => ({
      ...base,
      delayMin: 0,
      modalGapMin: null,
      elongationMin: 0,
      delayExplainedMin: 0,
      residualMin: 0,
      rssImprovement: 0,
      confidence: "low",
      confidenceReason: reason,
    })

    if (transitions < 1) {
      out.push(unfit("Single-station program — nothing to transition between"))
      continue
    }

    const run = findProgramRun(gpmAt, ordered, opts)
    if (!run) {
      out.push(unfit("No flow detected for this program"))
      continue
    }

    const progStart = ordered[0].startMin
    // The configured span already carries whatever delay is configured today, so
    // measuring against it makes the estimate additive and the whole thing
    // idempotent: once the right delay is saved, elongation goes to zero and the
    // next run recommends the same value rather than stacking another one on.
    const cfgSpan = ordered[N - 1].endMin - progStart
    const cfgTotal = ordered.reduce((s, x) => s + x.durationMin, 0)
    const configuredDelayMin = (cfgSpan - cfgTotal) / transitions

    const runStartBoundary = run.start - 1
    const obsSpan = run.end - runStartBoundary
    const elongationMin = obsSpan - cfgSpan

    const durations = ordered.map((s) => s.durationMin)
    const rssZero = piecewiseRss(at, durations, run.start, run.end, 0)
    const stepMin = DELAY_STEP_SEC / 60
    const maxMin = maxDelaySec / 60

    // Only the best achievable score matters here, not which delay achieved it:
    // this is the gate ("does any delay model beat no delay at all"), while the
    // measured gaps are what actually set the value.
    let bestRss = rssZero
    for (let d = stepMin; d <= maxMin + 1e-9; d += stepMin) {
      const rss = piecewiseRss(at, durations, run.start, run.end, d)
      if (rss < bestRss) bestRss = rss
    }
    const rssImprovement = rssZero > 0 ? (rssZero - bestRss) / rssZero : 0

    // Measured gaps are the estimator when there are any; the grid search only
    // decides whether to believe them.
    const usableGaps = run.gaps.filter((g) => g > 0)
    const m = mode(usableGaps)
    let delayMin: number
    let modalGapMin: number | null = null
    const reasons: string[] = []

    if (m && usableGaps.length >= 2) {
      modalGapMin = m.value
      // A measured gap is the absolute dead time, whatever the config currently
      // says — nothing to add to it.
      // A clear mode is a repeated physical measurement. A scattered one usually
      // means dry stations breaking the run into pieces that are not delays, so
      // the median is the safer summary.
      delayMin = m.share >= 0.5 ? m.value : median(usableGaps)
      if (m.share < 0.5) reasons.push("Measured gaps are inconsistent")
    } else {
      // No gap ever blanked a whole bin. Fall back to spreading the elongation —
      // which is measured against a configured span that already contains
      // whatever delay is set today, so it yields the ADDITIONAL delay and has to
      // be added to the current one. It also cannot separate dead time from long
      // runs, hence the noise floor below.
      delayMin = Math.max(0, configuredDelayMin + elongationMin / transitions)
      reasons.push("No measurable gaps — estimated from run elongation")
    }

    const delaySec = Math.round((delayMin * 60) / DELAY_STEP_SEC) * DELAY_STEP_SEC
    delayMin = delaySec / 60

    // Both figures are stated relative to the configured span, so the card can
    // say "explains N of the M minutes this program overran".
    const delayExplainedMin = (delayMin - configuredDelayMin) * transitions
    const residualMin = elongationMin - delayExplainedMin

    if (delaySec < minDelaySec) reasons.push("Below the noise floor — no delay worth setting")
    if (rssImprovement < minImprovement) {
      reasons.push("A delay model does not explain this run better than no delay")
    }
    // A run shorter than its configured span never completed — a rain-sensor
    // abort, a manual stop, a meter dropout. The gaps it does show are still
    // real, but its residual is meaningless (it reads as tens of minutes of
    // negative duration drift), so it must not vote on the aggregate.
    const ranShort = elongationMin < 0
    if (ranShort) reasons.push("Program ran shorter than configured — likely cut short")

    const confident = delaySec >= minDelaySec && rssImprovement >= minImprovement &&
      !ranShort && !reasons.includes("Measured gaps are inconsistent")

    out.push({
      ...base,
      delayMin,
      modalGapMin,
      elongationMin,
      delayExplainedMin,
      residualMin,
      rssImprovement,
      confidence: confident ? "high" : "low",
      confidenceReason: reasons.length ? reasons.join("; ") : undefined,
    })
  }

  return out
}

/**
 * Aggregate per-day fits into one recommendation per timer.
 *
 * A single day can be wrecked by a rain-sensor abort, a manual run, or a meter
 * dropout, so only fits that passed their own confidence gate vote, and the
 * median (not the mean) decides — on the reference data 6 of 26 days had a timer
 * cut short, and they were all correctly excluded here.
 */
export function recommendStationDelays(
  fits: DelayFit[],
  config: AppConfig
): DelayRecommendation[] {
  const out: DelayRecommendation[] = []

  for (const timer of ["timer1", "timer2"] as const) {
    const mine = fits.filter((f) => f.timer === timer)
    const good = mine.filter((f) => f.confidence === "high")
    const configuredSec = Math.max(0, config[timer].stationDelaySec ?? 0)

    const days = new Set(mine.map((f) => f.date)).size
    const daysFit = new Set(good.map((f) => f.date)).size

    if (good.length === 0) {
      out.push({
        timer,
        delaySec: null,
        configuredSec,
        daysFit: 0,
        daysTotal: days,
        minSec: null,
        maxSec: null,
        medianElongationMin: mine.length ? median(mine.map((f) => f.elongationMin)) : null,
        medianExplainedMin: null,
        medianResidualMin: null,
        reason: days === 0
          ? "No runs found for this timer in the days examined."
          : "No inter-station delay detected — stations run back to back.",
      })
      continue
    }

    const secs = good.map((f) => Math.round(f.delayMin * 60))
    const delaySec = Math.round(median(secs) / DELAY_STEP_SEC) * DELAY_STEP_SEC
    const medianElongationMin = median(good.map((f) => f.elongationMin))
    const medianResidualMin = median(good.map((f) => f.residualMin))
    const medianExplainedMin = median(good.map((f) => f.delayExplainedMin))

    const residual = Math.round(medianResidualMin)
    const reason = residual > 1
      ? `Also running about ${residual} min long per cycle beyond the delay — that part is station duration, not dead time.`
      : "The delay accounts for essentially all of this program's overrun."

    out.push({
      timer,
      delaySec,
      configuredSec,
      daysFit,
      daysTotal: days,
      minSec: Math.min(...secs),
      maxSec: Math.max(...secs),
      medianElongationMin,
      medianExplainedMin,
      medianResidualMin,
      reason,
    })
  }

  return out
}

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

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
