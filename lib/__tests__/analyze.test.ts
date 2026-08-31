import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import {
  enrichRows,
  enrichRowsMultiConfig,
  buildDailyRows,
  buildWeeklyRows,
  aggregateForChart,
  computeStationWarnings,
  activeWindowForDate,
  windowDateRange,
  diffConfigs,
  addDays,
  buildDaySchedule,
  buildDayMinuteSeries,
  reconcileDay,
  inferStationDelay,
  recommendStationDelays,
  findProgramRun,
  seriesMap,
  rollupsToDailyRows,
  rollupsToEnriched,
  stationTimerMap,
} from "../analyze"
import type { AppConfig, ConfigWindow, EnrichedRow, ExpectedSegment, FlumeRow, MinutePoint, RollupRow } from "../types"
import { DEFAULT_CONFIG, normalizeTime, toWindows } from "../types"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<Omit<AppConfig, "timer1" | "timer2">> = {}): AppConfig {
  return {
    timer1: {
      stations: [
        { id: "T1-01", name: "Front Lawn" },
        { id: "T1-02", name: "Back Garden" },
      ],
      programs: {
        A: {
          enabled: true,
          start: "06:00:00",
          days: [0, 2, 4], // Mon Wed Fri
          stations: {
            "T1-01": { durationMin: 10, enabled: true },
            "T1-02": { durationMin: 5,  enabled: true },
          },
        },
        B: { enabled: false, start: "06:00:00", days: [], stations: {} },
        C: { enabled: false, start: "06:00:00", days: [], stations: {} },
      },
    },
    timer2: {
      stations: [
        { id: "T2-01", name: "Side Yard" },
      ],
      programs: {
        A: {
          enabled: true,
          start: "08:00:00",
          days: [0, 2, 4],
          stations: {
            "T2-01": { durationMin: 8, enabled: true },
          },
        },
        B: { enabled: false, start: "08:00:00", days: [], stations: {} },
        C: { enabled: false, start: "08:00:00", days: [], stations: {} },
      },
    },
    sprinklerOnThreshold: 50,
    gallonsPerUnit: 748,
    costPerUnit: 10.47,
    ...overrides,
  }
}

/** Build a ConfigWindow with effectiveFrom = the given date. */
function win(effectiveFrom: string, config: AppConfig, notes = ""): ConfigWindow {
  return {
    id: effectiveFrom,
    effectiveFrom,
    notes,
    config,
    createdAt: effectiveFrom + "T00:00:00.000Z",
    updatedAt: effectiveFrom + "T00:00:00.000Z",
  }
}

/** Build one minute's worth of rows for a full day (00:00 – 23:59) with uniform gallons */
function dayRows(date: string, gallonsPerMinute = 0.1): FlumeRow[] {
  const rows: FlumeRow[] = []
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m++) {
      const hh = String(h).padStart(2, "0")
      const mm = String(m).padStart(2, "0")
      rows.push({ datetime: `${date}T${hh}:${mm}:00`, gallons: gallonsPerMinute })
    }
  }
  return rows
}

/**
 * Build rows for a single sprinkler day with:
 * - 0.1 gal/min background usage (house)
 * - 2 gal/min during T1-01 window (06:01–06:10)
 * - 3 gal/min during T1-02 window (06:11–06:15)
 * - 4 gal/min during T2-01 window (08:01–08:08)
 */
function sprinklerDayRows(date: string): FlumeRow[] {
  return dayRows(date, 0.1).map((r) => {
    const timePart = r.datetime.slice(11, 16)
    const [h, m] = timePart.split(":").map(Number)
    const min = h * 60 + m
    // T1 starts at 06:00 → T1-01 is 360→370, T1-02 is 370→375
    if (min > 360 && min <= 370) return { ...r, gallons: 2 }
    if (min > 370 && min <= 375) return { ...r, gallons: 3 }
    // T2 starts at 08:00 → T2-01 is 480→488
    if (min > 480 && min <= 488) return { ...r, gallons: 4 }
    return r
  })
}

/** makeConfig with baselines wired so reconcile tests can compute deltas. */
function makeConfigWithBaselines(): AppConfig {
  const cfg = makeConfig()
  cfg.timer1.stations = [
    { id: "T1-01", name: "Front Lawn", baselineGpm: 2 },
    { id: "T1-02", name: "Back Garden", baselineGpm: 3 },
  ]
  cfg.timer2.stations = [{ id: "T2-01", name: "Side Yard", baselineGpm: 4 }]
  return cfg
}

/**
 * Build a per-minute MinutePoint series over [from, to] with `bg` background gpm,
 * overlaying each segment's gpm on minutes (start, end] (matching enrichRows'
 * `start < minute ≤ end` convention).
 */
function minuteSeries(
  segments: Array<{ start: number; end: number; gpm: number }>,
  opts: { from?: number; to?: number; bg?: number } = {}
): MinutePoint[] {
  const from = opts.from ?? 0
  const to = opts.to ?? 1439
  const bg = opts.bg ?? 0.1
  const pts: MinutePoint[] = []
  for (let m = from; m <= to; m++) {
    let g = bg
    for (const s of segments) if (m > s.start && m <= s.end) g = s.gpm
    pts.push({ timeMin: m, gpm: g })
  }
  return pts
}

/** Hand-built ExpectedSegment for reconcile tests in isolation. */
function seg(o: {
  stationId: string
  startMin: number
  durationMin: number
  baselineGpm?: number | null
  programId?: "A" | "B" | "C"
  timer?: "timer1" | "timer2"
}): ExpectedSegment {
  return {
    stationId: o.stationId,
    name: o.stationId,
    timer: o.timer ?? "timer1",
    programId: o.programId ?? "A",
    startMin: o.startMin,
    endMin: o.startMin + o.durationMin,
    durationMin: o.durationMin,
    baselineGpm: o.baselineGpm ?? null,
  }
}

// ---------------------------------------------------------------------------
// buildDaySchedule
// ---------------------------------------------------------------------------

describe("buildDaySchedule", () => {
  it("reconstructs back-to-back station windows from program start + durations", () => {
    const schedule = buildDaySchedule(makeConfigWithBaselines(), 0) // Monday
    expect(schedule.map((s) => [s.stationId, s.startMin, s.endMin, s.baselineGpm])).toEqual([
      ["T1-01", 360, 370, 2],
      ["T1-02", 370, 375, 3],
      ["T2-01", 480, 488, 4],
    ])
  })

  it("returns nothing for a day with no active programs", () => {
    expect(buildDaySchedule(makeConfig(), 1)).toEqual([]) // Tuesday not in [0,2,4]
  })

  it("omits disabled / zero-duration stations", () => {
    const cfg = makeConfig()
    cfg.timer1.programs.A.stations["T1-01"] = { durationMin: 10, enabled: false }
    const schedule = buildDaySchedule(cfg, 0)
    expect(schedule.some((s) => s.stationId === "T1-01")).toBe(false)
    // T1-02 slides up to the program start — timer skips disabled stations
    expect(schedule.find((s) => s.stationId === "T1-02")?.startMin).toBe(360)
  })

  it("maps a null baseline when none is set", () => {
    const schedule = buildDaySchedule(makeConfig(), 0)
    expect(schedule[0].baselineGpm).toBeNull()
  })

  it("inserts stationDelaySec between stations but not after the last one", () => {
    const cfg = makeConfigWithBaselines()
    cfg.timer1.stationDelaySec = 60
    const schedule = buildDaySchedule(cfg, 0)
    expect(schedule.map((s) => [s.stationId, s.startMin, s.endMin])).toEqual([
      ["T1-01", 360, 370],
      ["T1-02", 371, 376], // one minute of dead time, then the full 5 min run
      ["T2-01", 480, 488], // timer2 has no delay set — untouched
    ])
  })

  it("accumulates a sub-minute delay instead of rounding it away per station", () => {
    // 30 s is invisible in any single 1-minute bin, but over ten transitions it
    // is five minutes — the whole reason the cursor is kept fractional.
    const cfg = makeConfig()
    cfg.timer1.stationDelaySec = 30
    cfg.timer1.stations = Array.from({ length: 11 }, (_, i) => ({ id: `S${i}`, name: `S${i}` }))
    cfg.timer1.programs.A.stations = Object.fromEntries(
      cfg.timer1.stations.map((s) => [s.id, { durationMin: 10, enabled: true }])
    )
    const schedule = buildDaySchedule(cfg, 0).filter((s) => s.timer === "timer1")
    expect(schedule[0].startMin).toBe(360)
    expect(schedule[schedule.length - 1].endMin).toBe(360 + 11 * 10 + 5)
    // Every emitted span is still exactly the configured duration.
    for (const s of schedule) expect(s.endMin - s.startMin).toBe(s.durationMin)
  })

  it("is unchanged when no delay is configured", () => {
    const cfg = makeConfigWithBaselines()
    const withUndefined = buildDaySchedule(cfg, 0)
    cfg.timer1.stationDelaySec = 0
    cfg.timer2.stationDelaySec = 0
    expect(buildDaySchedule(cfg, 0)).toEqual(withUndefined)
  })
})

// ---------------------------------------------------------------------------
// buildDayMinuteSeries
// ---------------------------------------------------------------------------

describe("buildDayMinuteSeries", () => {
  it("yields one point per minute with gpm = that minute's gallons", () => {
    const enriched = enrichRows(sprinklerDayRows("2024-01-01"), makeConfig())
    const day = enriched.filter((r) => r.date === "2024-01-01")
    const series = buildDayMinuteSeries(day)
    expect(series.length).toBe(1440)
    // minute 365 is inside T1-01 (06:01–06:10) → 2 gpm
    expect(series.find((p) => p.timeMin === 365)?.gpm).toBeCloseTo(2, 5)
    // sorted ascending
    for (let i = 1; i < series.length; i++) expect(series[i].timeMin).toBeGreaterThan(series[i - 1].timeMin)
  })
})

// ---------------------------------------------------------------------------
// reconcileDay
// ---------------------------------------------------------------------------

describe("reconcileDay", () => {
  it("matches a clean run: zero drift, measured gpm equals baseline", () => {
    const cfg = makeConfigWithBaselines()
    const schedule = buildDaySchedule(cfg, 0)
    const series = minuteSeries([
      { start: 360, end: 370, gpm: 2 }, // T1-01
      { start: 370, end: 375, gpm: 3 }, // T1-02
      { start: 480, end: 488, gpm: 4 }, // T2-01
    ])
    const recon = reconcileDay(series, schedule)
    const byId = Object.fromEntries(recon.map((r) => [r.stationId, r]))

    expect(byId["T1-01"].startDriftMin).toBe(0)
    expect(byId["T1-01"].actualGpm).toBeCloseTo(2, 5)
    expect(byId["T1-01"].gpmDeltaPct).toBeCloseTo(0, 5)
    expect(byId["T1-01"].confidence).toBe("high")
    expect(byId["T1-02"].actualGpm).toBeCloseTo(3, 5)
    expect(byId["T1-02"].confidence).toBe("high")
    expect(byId["T2-01"].actualGpm).toBeCloseTo(4, 5)
    expect(byId["T2-01"].durationDriftMin).toBe(0)
  })

  it("detects a late program start as positive start drift", () => {
    const cfg = makeConfigWithBaselines()
    const schedule = buildDaySchedule(cfg, 0)
    // Shift the whole T1 run +3 minutes
    const series = minuteSeries([
      { start: 363, end: 373, gpm: 2 }, // T1-01 (was 360–370)
      { start: 373, end: 378, gpm: 3 }, // T1-02
      { start: 480, end: 488, gpm: 4 }, // T2-01 on time
    ])
    const recon = reconcileDay(series, schedule)
    const byId = Object.fromEntries(recon.map((r) => [r.stationId, r]))
    expect(byId["T1-01"].startDriftMin).toBe(3)
    expect(byId["T1-01"].actualGpm).toBeCloseTo(2, 5)
    expect(byId["T2-01"].startDriftMin).toBe(0)
  })

  it("reports flow rate above baseline as a positive gpm delta", () => {
    const cfg = makeConfigWithBaselines()
    const schedule = buildDaySchedule(cfg, 0)
    const series = minuteSeries([
      { start: 360, end: 370, gpm: 2 },
      { start: 370, end: 375, gpm: 3 },
      { start: 480, end: 488, gpm: 5 }, // T2-01 actual 5 vs baseline 4 → +25%
    ])
    const recon = reconcileDay(series, schedule)
    const t2 = recon.find((r) => r.stationId === "T2-01")!
    expect(t2.actualGpm).toBeCloseTo(5, 5)
    expect(t2.gpmDeltaPct).toBeCloseTo(0.25, 5)
  })

  it("flags a run ≤3 minutes as low confidence", () => {
    const schedule = [seg({ stationId: "T1-01", startMin: 360, durationMin: 2, baselineGpm: 2 })]
    const series = minuteSeries([{ start: 360, end: 362, gpm: 2 }])
    const recon = reconcileDay(series, schedule)
    expect(recon[0].confidence).toBe("low")
    expect(recon[0].confidenceReason).toMatch(/3 min/)
    expect(recon[0].actualGpm).toBeCloseTo(2, 5)
  })

  it("returns null actuals when no flow is detected", () => {
    const schedule = [seg({ stationId: "T1-01", startMin: 360, durationMin: 10, baselineGpm: 2 })]
    const series = minuteSeries([], { from: 340, to: 400, bg: 0.1 }) // all background
    const recon = reconcileDay(series, schedule)
    expect(recon[0].actualGpm).toBeNull()
    expect(recon[0].actualStartMin).toBeNull()
    expect(recon[0].confidence).toBe("low")
    expect(recon[0].confidenceReason).toMatch(/No flow/)
  })

  it("marks a boundary low-confidence when adjacent baselines are indistinguishable", () => {
    const schedule = [
      seg({ stationId: "T1-01", startMin: 360, durationMin: 10, baselineGpm: 2 }),
      seg({ stationId: "T1-02", startMin: 370, durationMin: 5, baselineGpm: 2 }),
    ]
    // Both run at the same 2 gpm — no detectable step between them.
    const series = minuteSeries([{ start: 360, end: 375, gpm: 2 }])
    const recon = reconcileDay(series, schedule)
    expect(recon.every((r) => r.confidence === "low")).toBe(true)
    expect(recon.some((r) => /Adjacent baselines/.test(r.confidenceReason ?? ""))).toBe(true)
    // still produces actual gpm for both
    expect(recon[0].actualGpm).toBeCloseTo(2, 5)
    expect(recon[1].actualGpm).toBeCloseTo(2, 5)
  })

  it("refines the boundary between two stations of different flow", () => {
    const schedule = [
      seg({ stationId: "T1-01", startMin: 360, durationMin: 10, baselineGpm: 2 }),
      seg({ stationId: "T1-02", startMin: 370, durationMin: 10, baselineGpm: 5 }),
    ]
    // Actual boundary is 2 min late (T1-01 ran to 372), step from 2→5 gpm.
    const series = minuteSeries([
      { start: 360, end: 372, gpm: 2 },
      { start: 372, end: 380, gpm: 5 },
    ])
    const recon = reconcileDay(series, schedule)
    const t1 = recon.find((r) => r.stationId === "T1-01")!
    const t2 = recon.find((r) => r.stationId === "T1-02")!
    expect(t1.actualEndMin).toBe(372)
    expect(t1.durationDriftMin).toBe(2)
    expect(t2.actualStartMin).toBe(372)
    expect(t2.actualGpm).toBeCloseTo(5, 5)
  })

  it("reaches a boundary that has drifted far outside the ±4 min refinement window", () => {
    // 11 stations of 10 min from 06:00, each transition losing a minute of dead
    // time — so the last station starts 10 min after where the config puts it.
    // Anchoring every boundary on the program's start drift alone cannot reach
    // that far, and the last station would be pinned to a wrong position and its
    // duration and gpm reported as measured fact.
    const schedule: ExpectedSegment[] = []
    const actual: Array<{ start: number; end: number; gpm: number }> = []
    let cfg = 360
    let act = 360
    for (let i = 0; i < 11; i++) {
      const gpm = i % 2 === 0 ? 8 : 3 // alternate so every boundary is a real step
      schedule.push(seg({ stationId: `S${i}`, startMin: cfg, durationMin: 10, baselineGpm: gpm }))
      actual.push({ start: act, end: act + 10, gpm })
      cfg += 10
      act += 11 // 10 min of watering + 1 min of dead time
    }
    const series = minuteSeries(actual, { from: 340, to: 520, bg: 0 })
    const recon = reconcileDay(series, schedule)

    const last = recon[recon.length - 1]
    expect(last.actualStartMin).toBe(360 + 10 * 11)
    expect(last.startDriftMin).toBe(10)
    // The real duration is intact — the stretch was attributed to dead time, not
    // smeared into the run times.
    expect(last.actualDurationMin).toBe(10)
    expect(last.actualGpm).toBeCloseTo(8, 5) // station 10 is even → the 8 gpm level
    expect(last.gapBeforeMin).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Inter-station delay inference
// ---------------------------------------------------------------------------

/**
 * A program of `n` stations, each `dur` minutes, starting at `start`, with
 * `gapMin` of dead time between them and each run `overrunMin` longer than
 * configured. Returns the configured schedule and the matching actual series.
 */
function delayScenario(o: {
  n: number
  dur: number
  start?: number
  gapMin?: number
  overrunMin?: number
}) {
  const start = o.start ?? 360
  const gap = o.gapMin ?? 0
  const overrun = o.overrunMin ?? 0
  const schedule: ExpectedSegment[] = []
  const actual: Array<{ start: number; end: number; gpm: number }> = []
  let cfg = start
  let act = start
  for (let i = 0; i < o.n; i++) {
    const gpm = i % 2 === 0 ? 8 : 3
    schedule.push(seg({ stationId: `S${i}`, startMin: cfg, durationMin: o.dur, baselineGpm: gpm }))
    actual.push({ start: act, end: act + o.dur + overrun, gpm })
    cfg += o.dur
    act += o.dur + overrun + gap
  }
  const series = minuteSeries(actual, { from: start - 20, to: act + 40, bg: 0 })
  return { schedule, series }
}

describe("inferStationDelay", () => {
  it("recovers a 60 s delay from the gaps it leaves between stations", () => {
    const { schedule, series } = delayScenario({ n: 11, dur: 10, gapMin: 1 })
    const [fit] = inferStationDelay(series, schedule, "2026-08-28")

    expect(fit.modalGapMin).toBe(1)
    expect(Math.round(fit.delayMin * 60)).toBe(60)
    expect(fit.transitions).toBe(10)
    expect(fit.elongationMin).toBe(10)
    expect(fit.delayExplainedMin).toBeCloseTo(10, 5)
    expect(fit.residualMin).toBeCloseTo(0, 5)
    expect(fit.confidence).toBe("high")
  })

  it("reports no delay for stations that run back to back", () => {
    const { schedule, series } = delayScenario({ n: 11, dur: 10, gapMin: 0 })
    const [fit] = inferStationDelay(series, schedule, "2026-08-28")

    expect(fit.modalGapMin).toBeNull()
    expect(fit.elongationMin).toBe(0)
    // Below the noise floor, so it must not become a config edit.
    expect(fit.confidence).toBe("low")
  })

  it("separates dead time from stations running long instead of folding them together", () => {
    // 1 min of dead time AND every station running 1 min over. Total elongation
    // is 2 min per transition; only half of it is delay. Dividing elongation by
    // transitions would report ~120 s and over-water every zone.
    const { schedule, series } = delayScenario({ n: 11, dur: 10, gapMin: 1, overrunMin: 1 })
    const [fit] = inferStationDelay(series, schedule, "2026-08-28")

    expect(Math.round(fit.delayMin * 60)).toBe(60)
    expect(fit.elongationMin).toBe(21)
    expect(fit.delayExplainedMin).toBeCloseTo(10, 5)
    // The rest stays visible as duration drift for the per-station proposals.
    expect(fit.residualMin).toBeCloseTo(11, 5)
    expect(fit.confidence).toBe("high")
  })

  it("is idempotent — once the delay is configured it recommends the same value", () => {
    const cfg = makeConfigWithBaselines()
    cfg.timer1.stationDelaySec = 60
    const schedule = buildDaySchedule(cfg, 0).filter((s) => s.timer === "timer1")
    // Actual flow matching that schedule exactly.
    const series = minuteSeries(
      schedule.map((s, i) => ({ start: s.startMin, end: s.endMin, gpm: i === 0 ? 2 : 3 })),
      { from: 340, to: 400, bg: 0 }
    )
    const [fit] = inferStationDelay(series, schedule, "2026-08-28")
    expect(fit.elongationMin).toBe(0)
    expect(Math.round(fit.delayMin * 60)).toBe(60)
  })

  it("does not let a program that was cut short vote on the delay", () => {
    const { schedule } = delayScenario({ n: 11, dur: 10, gapMin: 1 })
    // Flow stops a third of the way through — a rain-sensor abort.
    const truncated = minuteSeries(
      schedule.slice(0, 4).map((s, i) => ({ start: s.startMin, end: s.endMin, gpm: i % 2 === 0 ? 8 : 3 })),
      { from: 340, to: 520, bg: 0 }
    )
    const [fit] = inferStationDelay(truncated, schedule, "2026-08-28")
    expect(fit.elongationMin).toBeLessThan(0)
    expect(fit.confidence).toBe("low")
    expect(fit.confidenceReason).toMatch(/cut short/)
  })
})

describe("findProgramRun", () => {
  it("merges fragments split by dead time rather than truncating at the first gap", () => {
    const { schedule, series } = delayScenario({ n: 5, dur: 10, gapMin: 1 })
    const run = findProgramRun(seriesMap(series), schedule)!
    expect(run.fragments).toHaveLength(5)
    expect(run.gaps).toEqual([1, 1, 1, 1])
    // The whole program, not just its longest piece.
    expect(run.end - run.start + 1).toBe(5 * 10 + 4)
  })

  it("does not merge across the quiet stretch between two programs", () => {
    const { schedule, series } = delayScenario({ n: 3, dur: 10, gapMin: 1 })
    // A second, unrelated run well after this program ends.
    const withNext = series.map((p) =>
      p.timeMin > 500 && p.timeMin <= 530 ? { ...p, gpm: 6 } : p
    )
    const run = findProgramRun(seriesMap(withNext), schedule)!
    expect(run.end).toBeLessThan(500)
  })
})

describe("recommendStationDelays", () => {
  const cfg = makeConfigWithBaselines()

  it("takes the median across days and ignores the ones that failed to fit", () => {
    const { schedule, series } = delayScenario({ n: 11, dur: 10, gapMin: 1 })
    const good = ["2026-08-19", "2026-08-21", "2026-08-24"].flatMap((d) =>
      inferStationDelay(series, schedule, d)
    )
    const { series: flat } = delayScenario({ n: 11, dur: 10, gapMin: 0 })
    const bad = inferStationDelay(flat, schedule, "2026-08-26")

    const [t1] = recommendStationDelays([...good, ...bad], cfg)
    expect(t1.delaySec).toBe(60)
    expect(t1.daysFit).toBe(3)
    expect(t1.daysTotal).toBe(4)
    expect(t1.reason).toMatch(/delay accounts for/)
  })

  it("says so plainly when a timer has no delay rather than proposing zero", () => {
    const { schedule, series } = delayScenario({ n: 11, dur: 10, gapMin: 0 })
    const fits = inferStationDelay(series, schedule, "2026-08-28")
    const [t1] = recommendStationDelays(fits, cfg)
    expect(t1.delaySec).toBeNull()
    expect(t1.reason).toMatch(/No inter-station delay detected/)
  })

  it("reproduces the measured production result on a real metered day", () => {
    // The day from the report that prompted this work, with the config window
    // that was active on it. Two different controllers: one runs its stations
    // back to back, the other inserts a minute between them. Synthetic fixtures
    // can only confirm the estimator does what it was written to do — this
    // confirms it still says what the meter actually said.
    const cfg: AppConfig = JSON.parse(
      readFileSync(join(process.cwd(), "data", "sprinkler-config-2026-08-31.json"), "utf8")
    ).windows[0].config
    const rows: FlumeRow[] = JSON.parse(
      readFileSync(join(process.cwd(), "data", "day-2026-08-28.json"), "utf8")
    ).rows

    const date = "2026-08-28" // a Friday
    const dow = (new Date(date + "T12:00:00").getDay() + 6) % 7
    const schedule = buildDaySchedule(cfg, dow)
    const series = buildDayMinuteSeries(enrichRows(rows, cfg).filter((r) => r.date === date))
    const fits = inferStationDelay(series, schedule, date)
    const [t1, t2] = recommendStationDelays(fits, cfg)

    expect(t1.delaySec).toBeNull() // timer 1 is already aligned
    expect(t2.delaySec).toBe(60)
    expect(t2.medianElongationMin).toBe(16)
    expect(t2.medianExplainedMin).toBe(10)
    expect(t2.medianResidualMin).toBe(6) // duration drift, not dead time

    // And applying it pulls the far end of timer 2's run back into place.
    const before = reconcileDay(series, schedule).filter((r) => r.timer === "timer2")
    const withDelay: AppConfig = JSON.parse(JSON.stringify(cfg))
    withDelay.timer2.stationDelaySec = 60
    const after = reconcileDay(series, buildDaySchedule(withDelay, dow)).filter(
      (r) => r.timer === "timer2"
    )
    expect(before[before.length - 1].startDriftMin).toBe(16)
    expect(after[after.length - 1].startDriftMin).toBe(6)
  })

  it("names the leftover duration drift so it is not hidden inside the delay", () => {
    const { schedule, series } = delayScenario({ n: 11, dur: 10, gapMin: 1, overrunMin: 1 })
    const fits = inferStationDelay(series, schedule, "2026-08-28")
    const [t1] = recommendStationDelays(fits, cfg)
    expect(t1.delaySec).toBe(60)
    expect(Math.round(t1.medianResidualMin!)).toBe(11)
    expect(t1.reason).toMatch(/station duration, not dead time/)
  })
})

// ---------------------------------------------------------------------------
// enrichRows — station assignment
// ---------------------------------------------------------------------------

describe("enrichRows", () => {
  const config = makeConfig()

  it("assigns correct station during T1-01 window on a sprinkler day", () => {
    const rows = sprinklerDayRows("2024-01-01") // Monday = in program.days
    const enriched = enrichRows(rows, config)
    const t1_01 = enriched.filter((r) => r.station === "T1-01")
    expect(t1_01.length).toBe(10) // minutes 361–370
    expect(t1_01.every((r) => r.timer === "timer1")).toBe(true)
  })

  it("assigns correct station during T2-01 window on a sprinkler day", () => {
    const rows = sprinklerDayRows("2024-01-01")
    const enriched = enrichRows(rows, config)
    const t2_01 = enriched.filter((r) => r.station === "T2-01")
    expect(t2_01.length).toBe(8) // minutes 481–488
    expect(t2_01.every((r) => r.timer === "timer2")).toBe(true)
  })

  it("assigns 'house' between station windows on a sprinkler day", () => {
    const rows = sprinklerDayRows("2024-01-01")
    const enriched = enrichRows(rows, config)
    // Minute 376 is after T1-02 ends (375) and before T2-01 starts (480)
    const row376 = enriched.find((r) => r.timeMin === 376)
    expect(row376?.station).toBe("house")
    expect(row376?.timer).toBe("house")
  })

  it("assigns 'house' for ALL minutes on a day not in program.days", () => {
    // Tuesday (dow=1) is not in [0,2,4], so no programs are active → not a sprinkler day
    const rows = dayRows("2024-01-02", 0.1)
    const enriched = enrichRows(rows, config)
    expect(enriched.every((r) => r.station === "house")).toBe(true)
    expect(enriched.every((r) => r.isSprinklerDay === false)).toBe(true)
  })

  it("does NOT flag as sprinkler day when total gallons < threshold", () => {
    // Low flow on a scheduled day — won't exceed threshold of 50
    const rows = dayRows("2024-01-01", 0.01) // Monday, very low flow
    const enriched = enrichRows(rows, config)
    expect(enriched.every((r) => r.isSprinklerDay === false)).toBe(true)
  })

  it("flags as sprinkler day when total gallons in window exceeds threshold", () => {
    const rows = sprinklerDayRows("2024-01-01")
    const enriched = enrichRows(rows, config)
    expect(enriched.filter((r) => r.date === "2024-01-01").every((r) => r.isSprinklerDay)).toBe(true)
  })

  it("skips disabled stations (enabled: false in programStations)", () => {
    const cfg: AppConfig = {
      ...makeConfig(),
      timer1: {
        ...makeConfig().timer1,
        programs: {
          ...makeConfig().timer1.programs,
          A: {
            ...makeConfig().timer1.programs.A,
            stations: {
              "T1-01": { durationMin: 10, enabled: false }, // disabled
              "T1-02": { durationMin: 5,  enabled: true },
            },
          },
        },
      },
    }
    const rows = sprinklerDayRows("2024-01-01")
    const enriched = enrichRows(rows, cfg)
    const t1_01 = enriched.filter((r) => r.station === "T1-01")
    expect(t1_01.length).toBe(0)
  })

  it("Program B active on its own days, Program A on different days", () => {
    const cfg: AppConfig = {
      ...makeConfig(),
      timer1: {
        ...makeConfig().timer1,
        programs: {
          A: { enabled: true,  start: "06:00:00", days: [0],    stations: { "T1-01": { durationMin: 10, enabled: true }, "T1-02": { durationMin: 5, enabled: true } } },
          B: { enabled: true,  start: "06:00:00", days: [2],    stations: { "T1-01": { durationMin: 5,  enabled: true }, "T1-02": { durationMin: 3, enabled: false } } },
          C: { enabled: false, start: "06:00:00", days: [],      stations: {} },
        },
      },
      timer2: {
        ...makeConfig().timer2,
        programs: {
          A: { enabled: true,  start: "08:00:00", days: [0, 2], stations: { "T2-01": { durationMin: 8, enabled: true } } },
          B: { enabled: false, start: "08:00:00", days: [],      stations: {} },
          C: { enabled: false, start: "08:00:00", days: [],      stations: {} },
        },
      },
    }

    // Monday (dow=0): Program A for T1 is active. T1-01 window = 360→370
    const monRows = sprinklerDayRows("2024-01-01")
    const monEnriched = enrichRows(monRows, cfg)
    const monT101 = monEnriched.filter((r) => r.station === "T1-01")
    expect(monT101.length).toBe(10) // Program A duration

    // Wednesday (dow=2): Program B for T1 is active. T1-01 window = 360→365 (5 min)
    const wedRows = sprinklerDayRows("2024-01-03")
    const wedEnriched = enrichRows(wedRows, cfg)
    const wedT101 = wedEnriched.filter((r) => r.station === "T1-01")
    expect(wedT101.length).toBe(5) // Program B duration
  })
})

// ---------------------------------------------------------------------------
// enrichRowsMultiConfig — config selection by date
// ---------------------------------------------------------------------------

describe("enrichRowsMultiConfig", () => {
  it("uses DEFAULT_CONFIG when there are no windows", () => {
    const rows = sprinklerDayRows("2024-01-01")
    const enriched = enrichRowsMultiConfig(rows, [])
    expect(enriched.length).toBe(rows.length)
  })

  it("uses a window's config from its effectiveFrom date onward", () => {
    const customConfig = makeConfig({ sprinklerOnThreshold: 50 })
    const windows = [win("2024-01-01", customConfig, "test")]
    const rows = sprinklerDayRows("2024-01-01")
    const enriched = enrichRowsMultiConfig(rows, windows)
    expect(enriched.some((r) => r.isSprinklerDay)).toBe(true)
  })

  it("uses the earliest window's config for dates before it", () => {
    // The earliest window is the best proxy for what the system looked like
    // before the user started tracking changes. DEFAULT_CONFIG (generic placeholder)
    // is NOT used — it has wrong timer start times for real installations.
    const customConfig = makeConfig({ sprinklerOnThreshold: 50 })
    const windows = [win("2024-06-01", customConfig, "test")] // much later than the Jan data
    // Jan row predates the window — earliest config (threshold=50) applies
    const rows = sprinklerDayRows("2024-01-01")
    const enriched = enrichRowsMultiConfig(rows, windows)
    expect(enriched.some((r) => r.isSprinklerDay)).toBe(true)
  })

  it("applies different configs to different date ranges", () => {
    const configA = makeConfig({ sprinklerOnThreshold: 50 })   // low threshold = easy to trigger
    const configB = makeConfig({ sprinklerOnThreshold: 9999 }) // high threshold = never triggers

    const windows = [
      win("2024-01-01", configA, "A"),
      win("2024-02-01", configB, "B"),
    ]

    const rowsJan = sprinklerDayRows("2024-01-08") // Monday in Jan → configA
    const rowsFeb = sprinklerDayRows("2024-02-05") // Monday in Feb → configB
    const allRows = [...rowsJan, ...rowsFeb]

    const enriched = enrichRowsMultiConfig(allRows, windows)

    expect(enriched.filter((r) => r.date === "2024-01-08").some((r) => r.isSprinklerDay)).toBe(true)
    expect(enriched.filter((r) => r.date === "2024-02-05").every((r) => r.isSprinklerDay === false)).toBe(true)
  })

  it("segments correctly even when windows are passed out of order", () => {
    const configA = makeConfig({ sprinklerOnThreshold: 50 })
    const configB = makeConfig({ sprinklerOnThreshold: 9999 })
    // Newest first — function must sort by effectiveFrom internally
    const windows = [
      win("2024-02-01", configB, "B"),
      win("2024-01-01", configA, "A"),
    ]
    const enriched = enrichRowsMultiConfig(
      [...sprinklerDayRows("2024-01-08"), ...sprinklerDayRows("2024-02-05")],
      windows
    )
    expect(enriched.filter((r) => r.date === "2024-01-08").some((r) => r.isSprinklerDay)).toBe(true)
    expect(enriched.filter((r) => r.date === "2024-02-05").every((r) => r.isSprinklerDay === false)).toBe(true)
  })

  it("returns rows sorted by datetime after merging segments", () => {
    const windows = [
      win("2024-01-01", makeConfig({ sprinklerOnThreshold: 50 }), "A"),
      win("2024-02-01", makeConfig({ sprinklerOnThreshold: 50 }), "B"),
    ]
    const rows = [
      ...sprinklerDayRows("2024-02-05"),
      ...sprinklerDayRows("2024-01-08"),
    ]
    const enriched = enrichRowsMultiConfig(rows, windows)
    for (let i = 1; i < enriched.length; i++) {
      expect(enriched[i].datetime >= enriched[i - 1].datetime).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// activeWindowForDate / windowDateRange
// ---------------------------------------------------------------------------

describe("activeWindowForDate", () => {
  const windows = [
    win("2024-01-01", makeConfig(), "A"),
    win("2024-03-01", makeConfig(), "B"),
    win("2024-06-01", makeConfig(), "C"),
  ]

  it("returns null when there are no windows", () => {
    expect(activeWindowForDate([], "2024-01-15")).toBeNull()
  })

  it("returns the earliest window for dates before the first boundary", () => {
    expect(activeWindowForDate(windows, "2023-12-31")?.notes).toBe("A")
  })

  it("is inclusive of the effectiveFrom boundary", () => {
    expect(activeWindowForDate(windows, "2024-03-01")?.notes).toBe("B")
  })

  it("returns the window whose range contains the date", () => {
    expect(activeWindowForDate(windows, "2024-02-15")?.notes).toBe("A")
    expect(activeWindowForDate(windows, "2024-05-31")?.notes).toBe("B")
    expect(activeWindowForDate(windows, "2024-09-01")?.notes).toBe("C")
  })

  it("works regardless of input order", () => {
    const shuffled = [windows[2], windows[0], windows[1]]
    expect(activeWindowForDate(shuffled, "2024-04-01")?.notes).toBe("B")
  })
})

describe("windowDateRange", () => {
  it("derives contiguous ranges; last window is open", () => {
    const windows = [
      win("2024-01-01", makeConfig()),
      win("2024-03-01", makeConfig()),
    ]
    const ranges = windowDateRange(windows)
    expect(ranges[0].effectiveFrom).toBe("2024-01-01")
    expect(ranges[0].effectiveTo).toBe("2024-02-29") // day before next start (leap year)
    expect(ranges[1].effectiveTo).toBeNull()
  })

  it("addDays handles month/year boundaries", () => {
    expect(addDays("2024-03-01", -1)).toBe("2024-02-29")
    expect(addDays("2025-01-01", -1)).toBe("2024-12-31")
    expect(addDays("2024-01-31", 1)).toBe("2024-02-01")
  })
})

// ---------------------------------------------------------------------------
// diffConfigs
// ---------------------------------------------------------------------------

describe("diffConfigs", () => {
  it("returns no changes for identical configs", () => {
    expect(diffConfigs(makeConfig(), makeConfig())).toEqual([])
  })

  it("detects a start-time change", () => {
    const a = makeConfig()
    const b = makeConfig()
    b.timer1.programs.A.start = "07:30:00"
    const changes = diffConfigs(a, b)
    const c = changes.find((x) => x.field === "Start time")
    expect(c).toBeDefined()
    expect(c!.from).toBe("06:00")
    expect(c!.to).toBe("07:30")
  })

  it("detects a days change", () => {
    const a = makeConfig()
    const b = makeConfig()
    b.timer1.programs.A.days = [0, 2, 4, 5]
    expect(diffConfigs(a, b).some((x) => x.field === "Days")).toBe(true)
  })

  it("detects a station duration change", () => {
    const a = makeConfig()
    const b = makeConfig()
    b.timer1.programs.A.stations["T1-01"].durationMin = 20
    const c = diffConfigs(a, b).find((x) => x.field === "Front Lawn duration")
    expect(c).toBeDefined()
    expect(c!.from).toBe("10m")
    expect(c!.to).toBe("20m")
  })

  it("detects a baseline gpm change", () => {
    const a = makeConfig()
    const b = makeConfig()
    b.timer1.stations[0] = { ...b.timer1.stations[0], baselineGpm: 2.5 }
    expect(diffConfigs(a, b).some((x) => x.field.includes("baseline gpm"))).toBe(true)
  })

  it("detects station add / remove", () => {
    const a = makeConfig()
    const b = makeConfig()
    b.timer1.stations = [...b.timer1.stations, { id: "T1-03", name: "New Zone" }]
    const changes = diffConfigs(a, b)
    expect(changes.some((x) => x.field === "Station added" && x.to === "New Zone")).toBe(true)
    // reverse direction → removed
    expect(diffConfigs(b, a).some((x) => x.field === "Station removed" && x.from === "New Zone")).toBe(true)
  })

  it("detects billing changes", () => {
    const a = makeConfig()
    const b = makeConfig({ costPerUnit: 12.5 })
    expect(diffConfigs(a, b).some((x) => x.field === "Cost per unit")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Migration helpers (toWindows / normalizeTime)
// ---------------------------------------------------------------------------

describe("normalizeTime", () => {
  it("fixes the malformed HH:MM:SS:SS bug", () => {
    expect(normalizeTime("03:45:00:00")).toBe("03:45:00")
  })
  it("pads and passes through valid times", () => {
    expect(normalizeTime("6:5")).toBe("06:05:00")
    expect(normalizeTime("06:30:00")).toBe("06:30:00")
  })
})

describe("toWindows", () => {
  it("migrates legacy { config, configHistory } to sorted windows", () => {
    const legacy = {
      config: makeConfig(),
      configHistory: [
        { id: "b", savedAt: "2024-02-01T10:00:00.000Z", notes: "B", config: makeConfig() },
        { id: "a", savedAt: "2024-01-01T10:00:00.000Z", notes: "A", config: makeConfig() },
      ],
    }
    const windows = toWindows(legacy)
    expect(windows.length).toBe(2)
    expect(windows[0].effectiveFrom).toBe("2024-01-01") // sorted ascending
    expect(windows[1].effectiveFrom).toBe("2024-02-01")
    expect(windows[0].notes).toBe("A")
  })

  it("normalizes malformed start times during migration", () => {
    const cfg = makeConfig()
    cfg.timer1.programs.A.start = "03:45:00:00"
    const windows = toWindows({ configHistory: [{ id: "x", savedAt: "2024-01-01T00:00:00.000Z", notes: "", config: cfg }] })
    expect(windows[0].config.timer1.programs.A.start).toBe("03:45:00")
  })

  it("seeds a single window from a lone config", () => {
    const windows = toWindows({ config: makeConfig() })
    expect(windows.length).toBe(1)
  })

  it("passes through new-format windows", () => {
    const existing = [win("2024-01-01", makeConfig(), "A")]
    const windows = toWindows({ windows: existing })
    expect(windows.length).toBe(1)
    expect(windows[0].effectiveFrom).toBe("2024-01-01")
  })

  it("returns [] when there is nothing to migrate", () => {
    expect(toWindows({})).toEqual([])
  })

  it("collapses multiple same-day saves to the latest one (behavior-preserving)", () => {
    const windows = toWindows({
      configHistory: [
        { id: "1", savedAt: "2026-06-06T18:20:33.000Z", notes: "early", config: makeConfig() },
        { id: "2", savedAt: "2026-06-06T18:33:46.000Z", notes: "late",  config: makeConfig() },
        { id: "3", savedAt: "2026-06-03T21:37:38.000Z", notes: "init",  config: makeConfig() },
      ],
    })
    expect(windows.length).toBe(2)
    expect(windows[0].effectiveFrom).toBe("2026-06-03")
    expect(windows[1].effectiveFrom).toBe("2026-06-06")
    expect(windows[1].notes).toBe("late") // latest save that day wins
  })

  it("migrates the committed repo config snapshot into contiguous windows", () => {
    // Back-compat: the repo's exported bundle is the legacy { config, configHistory }
    // shape with several same-day saves. It must migrate to unique, sorted windows
    // with malformed start times ("03:45:00:00") normalized.
    const bundle = JSON.parse(
      readFileSync(join(process.cwd(), "data", "sprinkler-config-2026-06-06.json"), "utf-8")
    )
    const windows = toWindows(bundle)
    // 6 saves on 2 distinct days → 2 windows
    expect(windows.map((w) => w.effectiveFrom)).toEqual(["2026-06-03", "2026-06-06"])
    // every effectiveFrom is unique (contiguous-window invariant)
    expect(new Set(windows.map((w) => w.effectiveFrom)).size).toBe(windows.length)
    // no malformed "HH:MM:SS:SS" start times survive
    for (const w of windows) {
      for (const t of [w.config.timer1, w.config.timer2] as const) {
        for (const pid of ["A", "B", "C"] as const) {
          expect(t.programs[pid].start).toMatch(/^\d{2}:\d{2}:\d{2}$/)
        }
      }
    }
  })
})

// ---------------------------------------------------------------------------
// buildWeeklyRows
// ---------------------------------------------------------------------------

describe("buildWeeklyRows", () => {
  it("groups days in the same ISO week together", () => {
    // 2024-01-01 (Mon) and 2024-01-07 (Sun) are in the same ISO week
    const cfg = makeConfig({ sprinklerOnThreshold: 9999 })
    const daily = buildDailyRows(
      enrichRows([...dayRows("2024-01-01", 1), ...dayRows("2024-01-07", 1)], cfg)
    )
    const weekly = buildWeeklyRows(daily)
    expect(weekly.length).toBe(1)
    expect(weekly[0].weekStart).toBe("2024-01-01")
  })

  it("puts days in different weeks into separate buckets", () => {
    const cfg = makeConfig({ sprinklerOnThreshold: 9999 })
    const daily = buildDailyRows(
      enrichRows([...dayRows("2024-01-01", 1), ...dayRows("2024-01-08", 1)], cfg)
    )
    const weekly = buildWeeklyRows(daily)
    expect(weekly.length).toBe(2)
  })

  it("correctly totals sprinkler and house gallons per week", () => {
    const config = makeConfig()
    const rows = sprinklerDayRows("2024-01-01")
    const daily = buildDailyRows(enrichRows(rows, config))
    const weekly = buildWeeklyRows(daily)
    expect(weekly[0].sprinklerGallons).toBeGreaterThan(0)
    expect(weekly[0].houseGallons).toBeGreaterThan(0)
    expect(weekly[0].totalGallons).toBeCloseTo(
      weekly[0].sprinklerGallons + weekly[0].houseGallons, 1
    )
  })
})

// ---------------------------------------------------------------------------
// aggregateForChart
// ---------------------------------------------------------------------------

describe("aggregateForChart", () => {
  const config = makeConfig()

  it("simple breakdown has house and sprinkler keys", () => {
    const enriched = enrichRows(sprinklerDayRows("2024-01-01"), config)
    const bars = aggregateForChart(enriched, "day", "simple")
    expect(bars.length).toBe(1)
    expect(typeof bars[0].house).toBe("number")
    expect(typeof bars[0].sprinkler).toBe("number")
    expect(bars[0].total).toBeCloseTo((bars[0].house as number) + (bars[0].sprinkler as number), 1)
  })

  it("timer breakdown splits timer1 and timer2", () => {
    const enriched = enrichRows(sprinklerDayRows("2024-01-01"), config)
    const bars = aggregateForChart(enriched, "day", "timer")
    expect(bars[0].timer1).toBeGreaterThan(0)
    expect(bars[0].timer2).toBeGreaterThan(0)
  })

  it("station breakdown has individual station keys", () => {
    const enriched = enrichRows(sprinklerDayRows("2024-01-01"), config)
    const bars = aggregateForChart(enriched, "day", "station")
    expect(bars[0]["T1-01"]).toBeGreaterThan(0)
    expect(bars[0]["T1-02"]).toBeGreaterThan(0)
    expect(bars[0]["T2-01"]).toBeGreaterThan(0)
  })

  it("groups multiple days into one week bucket", () => {
    const rows = [
      ...sprinklerDayRows("2024-01-01"),  // Mon
      ...sprinklerDayRows("2024-01-03"),  // Wed
    ]
    const enriched = enrichRows(rows, config)
    const bars = aggregateForChart(enriched, "week", "simple")
    expect(bars.length).toBe(1)
  })

  it("flags anomaly bar when total is far above the rest", () => {
    const normalDays = [
      "2024-01-08", "2024-01-09", "2024-01-10",
      "2024-01-11", "2024-01-12", "2024-01-13",
    ].flatMap((d) => dayRows(d, 0.1))
    const spikeDay = dayRows("2024-01-14", 10)

    const cfg = makeConfig({ sprinklerOnThreshold: 9999 }) // all house
    const enriched = enrichRows([...normalDays, ...spikeDay], cfg)
    const bars = aggregateForChart(enriched, "day", "simple")

    const spikebar = bars.find((b) => b.dateStart === "2024-01-14")
    expect(spikebar?.isAnomaly).toBe(true)

    const normalBars = bars.filter((b) => b.dateStart !== "2024-01-14")
    expect(normalBars.every((b) => !b.isAnomaly)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Rollup reconstruction (Phase 3): DailyRow[] and synthetic EnrichedRow[]
// rebuilt from persisted rollup rows must reproduce the client's old outputs.
// ---------------------------------------------------------------------------

/** Serialize enriched → DailyRow → the flat RollupRow[] the server persists. */
function toRollupRows(enriched: EnrichedRow[]): RollupRow[] {
  const daily = buildDailyRows(enriched)
  const out: RollupRow[] = []
  for (const d of daily) {
    for (const [station, gallons] of Object.entries(d.byStation)) {
      out.push({ date: d.date, station, gallons, isSprinklerDay: d.isSprinklerDay })
    }
  }
  return out
}

describe("rollup reconstruction", () => {
  const config = makeConfig()

  it("rollupsToDailyRows inverts buildDailyRows (within float tolerance)", () => {
    const enriched = enrichRows(
      [...sprinklerDayRows("2024-01-01"), ...dayRows("2024-01-02", 0.1)],
      config
    )
    const expected = buildDailyRows(enriched)
    const got = rollupsToDailyRows(toRollupRows(enriched))
    expect(got.length).toBe(expected.length)
    got.forEach((d, i) => {
      expect(d.date).toBe(expected[i].date)
      expect(d.isSprinklerDay).toBe(expected[i].isSprinklerDay)
      expect(d.totalGallons).toBeCloseTo(expected[i].totalGallons, 6)
      // byStation keys + values match (float-tolerant on the sums)
      expect(Object.keys(d.byStation).sort()).toEqual(Object.keys(expected[i].byStation).sort())
      for (const k of Object.keys(d.byStation)) {
        expect(d.byStation[k]).toBeCloseTo(expected[i].byStation[k], 6)
      }
    })
  })

  it("stationTimerMap maps each station to its timer (house → house)", () => {
    const windows = [win("2024-01-01", config)]
    const map = stationTimerMap(windows)
    expect(map["T1-01"]).toBe("timer1")
    expect(map["T1-02"]).toBe("timer1")
    expect(map["T2-01"]).toBe("timer2")
    expect(map["house"]).toBe("house")
  })

  it("synthetic enriched from rollups yields identical chart bars (all breakdowns)", () => {
    const rows = [
      ...sprinklerDayRows("2024-01-01"),
      ...sprinklerDayRows("2024-01-03"),
      ...dayRows("2024-01-05", 0.2),
    ]
    const enriched = enrichRows(rows, config)
    const timerOf = stationTimerMap([win("2024-01-01", config)])
    const synthetic = rollupsToEnriched(toRollupRows(enriched), timerOf)

    for (const breakdown of ["simple", "timer", "station"] as const) {
      for (const bucket of ["day", "week", "month"] as const) {
        const real = aggregateForChart(enriched, bucket, breakdown)
        const fromRollup = aggregateForChart(synthetic, bucket, breakdown)
        expect(fromRollup.length).toBe(real.length)
        real.forEach((bar, i) => {
          const got = fromRollup[i]
          // Non-numeric structure is bit-identical; numeric sums match within
          // float tolerance (synthetic sums pre-aggregated daily gallons).
          expect(got.label).toBe(bar.label)
          expect(got.dateStart).toBe(bar.dateStart)
          expect(got.dateEnd).toBe(bar.dateEnd)
          expect(got.isAnomaly).toBe(bar.isAnomaly)
          for (const [k, v] of Object.entries(bar)) {
            if (typeof v === "number") expect(got[k] as number).toBeCloseTo(v, 6)
          }
        })
      }
    }
  })
})

// ---------------------------------------------------------------------------
// computeStationWarnings
// ---------------------------------------------------------------------------

describe("computeStationWarnings", () => {
  function configWithBaseline(): AppConfig {
    const cfg = makeConfig()
    return {
      ...cfg,
      timer1: {
        ...cfg.timer1,
        stations: [
          { id: "T1-01", name: "Front Lawn", baselineGpm: 2.0 },
          { id: "T1-02", name: "Back Garden" },
        ],
      },
    }
  }

  it("fires warning when station is >20% above baseline for 2+ consecutive days", () => {
    const config = configWithBaseline()
    // Build on sprinklerDayRows so the detection window is already crossed, then
    // boost T1-01 to 3 gpm (50% above its baseline of 2).
    function highFlowDay(date: string): FlumeRow[] {
      return sprinklerDayRows(date).map((r) => {
        const min = Number(r.datetime.slice(11, 13)) * 60 + Number(r.datetime.slice(14, 16))
        if (min > 360 && min <= 370) return { ...r, gallons: 3 } // T1-01 window, 3 gpm (50% above)
        return r
      })
    }
    const rows = [...highFlowDay("2024-01-01"), ...highFlowDay("2024-01-03")]
    const enriched = enrichRows(rows, config)
    const warnings = computeStationWarnings(enriched, config, 21)
    const w = warnings.find((w) => w.stationId === "T1-01")
    expect(w).toBeDefined()
    expect(w!.consecutiveDaysAbove).toBeGreaterThanOrEqual(2)
    expect(w!.pctAboveBaseline).toBeGreaterThan(0.2)
  })

  it("does NOT fire when only one day is above threshold", () => {
    const config = configWithBaseline()
    function highFlowDay(date: string): FlumeRow[] {
      return sprinklerDayRows(date).map((r) => {
        const min = Number(r.datetime.slice(11, 13)) * 60 + Number(r.datetime.slice(14, 16))
        if (min > 360 && min <= 370) return { ...r, gallons: 3 }
        return r
      })
    }
    const rows = [
      ...highFlowDay("2024-01-01"),       // above
      ...sprinklerDayRows("2024-01-03"),  // normal (2 gpm = at baseline)
    ]
    const enriched = enrichRows(rows, config)
    const warnings = computeStationWarnings(enriched, config, 21)
    const w = warnings.find((w) => w.stationId === "T1-01")
    expect(w).toBeUndefined()
  })

  it("does NOT fire when no baseline is set", () => {
    const config = makeConfig()
    const rows = sprinklerDayRows("2024-01-01")
    const enriched = enrichRows(rows, config)
    const warnings = computeStationWarnings(enriched, config, 21)
    expect(warnings.length).toBe(0)
  })
})
