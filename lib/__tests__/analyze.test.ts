import { describe, it, expect } from "vitest"
import {
  enrichRows,
  enrichRowsMultiConfig,
  buildDailyRows,
  buildWeeklyRows,
  aggregateForChart,
  computeStationWarnings,
} from "../analyze"
import type { AppConfig, ConfigVersion, FlumeRow } from "../types"
import { DEFAULT_CONFIG } from "../types"

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
  it("uses DEFAULT_CONFIG when history is empty", () => {
    const rows = sprinklerDayRows("2024-01-01")
    const enriched = enrichRowsMultiConfig(rows, [])
    expect(enriched.length).toBe(rows.length)
  })

  it("uses the saved config after its savedAt date", () => {
    const customConfig = makeConfig({ sprinklerOnThreshold: 50 })
    const history: ConfigVersion[] = [
      {
        id: "v1",
        savedAt: "2024-01-01T00:00:00.000Z",
        notes: "test",
        config: customConfig,
      },
    ]
    const rows = sprinklerDayRows("2024-01-01")
    const enriched = enrichRowsMultiConfig(rows, history)
    expect(enriched.some((r) => r.isSprinklerDay)).toBe(true)
  })

  it("uses the oldest saved config for dates before the first saved config", () => {
    // The oldest saved config is the best proxy for what the system looked like
    // before the user started tracking changes. DEFAULT_CONFIG (generic placeholder)
    // is NOT used — it has wrong timer start times for real installations.
    const customConfig = makeConfig({ sprinklerOnThreshold: 50 })
    const history: ConfigVersion[] = [
      {
        id: "v1",
        savedAt: "2024-06-01T00:00:00.000Z", // much later than the Jan data
        notes: "test",
        config: customConfig,
      },
    ]
    // Jan row predates the config save — oldest config (threshold=50) applies
    const rows = sprinklerDayRows("2024-01-01")
    const enriched = enrichRowsMultiConfig(rows, history)
    // With threshold=50, sprinklerDayRows (high-flow Monday) triggers detection
    expect(enriched.some((r) => r.isSprinklerDay)).toBe(true)
  })

  it("applies different configs to different date ranges", () => {
    const configA = makeConfig({ sprinklerOnThreshold: 50 })   // low threshold = easy to trigger
    const configB = makeConfig({ sprinklerOnThreshold: 9999 }) // high threshold = never triggers

    const history: ConfigVersion[] = [
      { id: "v1", savedAt: "2024-01-01T00:00:00.000Z", notes: "A", config: configA },
      { id: "v2", savedAt: "2024-02-01T00:00:00.000Z", notes: "B", config: configB },
    ]

    const rowsJan = sprinklerDayRows("2024-01-08") // Monday in Jan → configA
    const rowsFeb = sprinklerDayRows("2024-02-05") // Monday in Feb → configB
    const allRows = [...rowsJan, ...rowsFeb]

    const enriched = enrichRowsMultiConfig(allRows, history)

    expect(enriched.filter((r) => r.date === "2024-01-08").some((r) => r.isSprinklerDay)).toBe(true)
    expect(enriched.filter((r) => r.date === "2024-02-05").every((r) => r.isSprinklerDay === false)).toBe(true)
  })

  it("returns rows sorted by datetime after merging segments", () => {
    const configA = makeConfig({ sprinklerOnThreshold: 50 })
    const configB = makeConfig({ sprinklerOnThreshold: 50 })
    const history: ConfigVersion[] = [
      { id: "v1", savedAt: "2024-01-01T00:00:00.000Z", notes: "A", config: configA },
      { id: "v2", savedAt: "2024-02-01T00:00:00.000Z", notes: "B", config: configB },
    ]
    const rows = [
      ...sprinklerDayRows("2024-02-05"),
      ...sprinklerDayRows("2024-01-08"),
    ]
    const enriched = enrichRowsMultiConfig(rows, history)
    for (let i = 1; i < enriched.length; i++) {
      expect(enriched[i].datetime >= enriched[i - 1].datetime).toBe(true)
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
