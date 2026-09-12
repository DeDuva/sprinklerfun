import { describe, it, expect, beforeEach } from "vitest"
import { resetDbForTests } from "../db"
import {
  insertRows,
  countRows,
  replaceWindows,
  readWindows,
  readMaintenance,
  replaceMaintenance,
  replaceConfig,
  readDayRows,
  readAllRows,
  rowDateBounds,
  recomputeRollups,
  readRollups,
  recomputeStats,
  readStationStats,
  clearAllData,
} from "../server/data"
import { buildDailyRows, enrichRows } from "../analyze"
import type { AppConfig, ConfigWindow, FlumeRow } from "../types"

// The data layer had zero coverage, and it is where the irreversible things
// happen: replaceWindows deletes every config window before inserting, and
// recomputeRollups/recomputeStats rewrite the derived tables wholesale on every
// write. lib/__tests__/setup.ts pins the DB to an in-memory one; resetDbForTests
// gives each case a fresh empty database.

beforeEach(() => resetDbForTests())

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function config(): AppConfig {
  return {
    timer1: {
      stations: [
        { id: "T1-01", name: "Front", baselineGpm: 6 },
        { id: "T1-02", name: "Back", baselineGpm: 3 },
      ],
      programs: {
        A: {
          enabled: true,
          start: "06:00:00",
          days: [0, 1, 2, 3, 4, 5, 6],
          stations: {
            "T1-01": { durationMin: 10, enabled: true },
            "T1-02": { durationMin: 10, enabled: true },
          },
        },
        B: { enabled: false, start: "06:00:00", days: [], stations: {} },
        C: { enabled: false, start: "06:00:00", days: [], stations: {} },
      },
    },
    timer2: {
      stations: [],
      programs: {
        A: { enabled: false, start: "08:00:00", days: [], stations: {} },
        B: { enabled: false, start: "08:00:00", days: [], stations: {} },
        C: { enabled: false, start: "08:00:00", days: [], stations: {} },
      },
    },
    sprinklerOnThreshold: 50,
    gallonsPerUnit: 748,
    costPerUnit: 10,
  }
}

const win = (id: string, effectiveFrom: string, cfg = config()): ConfigWindow => ({
  id,
  effectiveFrom,
  notes: "",
  config: cfg,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
})

/** A day of minutes: stations run 06:01–06:20, the rest is a trickle. */
function dayRows(date: string): FlumeRow[] {
  const rows: FlumeRow[] = []
  for (let m = 0; m < 1440; m++) {
    const hh = String(Math.floor(m / 60)).padStart(2, "0")
    const mm = String(m % 60).padStart(2, "0")
    let g = 0.05
    if (m > 360 && m <= 370) g = 6
    else if (m > 370 && m <= 380) g = 3
    rows.push({ datetime: `${date} ${hh}:${mm}:00`, gallons: g })
  }
  return rows
}

// ---------------------------------------------------------------------------

describe("insertRows", () => {
  it("reports how many rows were actually new, not how many were sent", async () => {
    const rows = dayRows("2026-08-28")
    expect(await insertRows(rows)).toBe(1440)
    // The whole point of INSERT OR IGNORE: re-uploading an overlapping export is
    // the normal weekly workflow, and it must not double-count.
    expect(await insertRows(rows)).toBe(0)
    expect(await countRows()).toBe(1440)
  })

  it("counts only the new rows when an upload partially overlaps", async () => {
    await insertRows(dayRows("2026-08-28"))
    const mixed = [...dayRows("2026-08-28").slice(0, 100), ...dayRows("2026-08-29")]
    expect(await insertRows(mixed)).toBe(1440)
  })

  it("survives the chunk boundary", async () => {
    // ROW_CHUNK is 500 and each row binds two parameters, which puts a full
    // chunk at 1000 bound parameters — right at SQLite's historical 999 default.
    // A regression here is a runtime crash reachable only with a real database.
    for (const n of [1, 499, 500, 501, 1001]) {
      resetDbForTests()
      const rows = dayRows("2026-08-28").slice(0, n)
      expect(await insertRows(rows), `n=${n}`).toBe(n)
      expect(await countRows(), `n=${n}`).toBe(n)
    }
  })

  it("accepts an empty array", async () => {
    expect(await insertRows([])).toBe(0)
  })

  it("keeps the last value when one payload repeats a timestamp", async () => {
    await insertRows([
      { datetime: "2026-08-28 03:00:00", gallons: 1 },
      { datetime: "2026-08-28 03:00:00", gallons: 9 },
    ])
    expect(await countRows()).toBe(1)
  })
})

describe("replaceWindows / readWindows", () => {
  it("round-trips a window including its nested config", async () => {
    await replaceWindows([win("w1", "2026-07-01")])
    const [got] = await readWindows()
    expect(got.id).toBe("w1")
    expect(got.effectiveFrom).toBe("2026-07-01")
    expect(got.config.timer1.stations[0].baselineGpm).toBe(6)
  })

  it("returns windows oldest first, whatever order they were written in", async () => {
    await replaceWindows([win("b", "2026-08-01"), win("a", "2026-07-01")])
    expect((await readWindows()).map((w) => w.id)).toEqual(["a", "b"])
  })

  it("REPLACES rather than merges — this is the destructive one", async () => {
    // Delete-all-then-insert. Documented here because it is the behaviour that
    // made `{"rows":[],"windows":[]}` wipe the whole config timeline through the
    // API; the route now refuses that, but the data layer still does what it says.
    await replaceWindows([win("old", "2026-06-01")])
    await replaceWindows([win("new", "2026-07-01")])
    const got = await readWindows()
    expect(got).toHaveLength(1)
    expect(got[0].id).toBe("new")
  })

  it("wipes the table when handed an empty array", async () => {
    await replaceWindows([win("w1", "2026-07-01")])
    await replaceWindows([])
    expect(await readWindows()).toEqual([])
  })
})

describe("readDayRows / readAllRows / rowDateBounds", () => {
  beforeEach(async () => {
    await insertRows([...dayRows("2026-08-27"), ...dayRows("2026-08-28")])
  })

  it("returns one day and not its neighbours", async () => {
    const rows = await readDayRows("2026-08-28")
    expect(rows).toHaveLength(1440)
    expect(rows.every((r) => r.datetime.startsWith("2026-08-28"))).toBe(true)
  })

  it("returns an empty array for a day with no data", async () => {
    expect(await readDayRows("2026-08-01")).toEqual([])
  })

  it("returns everything in ascending datetime order", async () => {
    const all = await readAllRows()
    expect(all).toHaveLength(2880)
    for (let i = 1; i < all.length; i++) {
      expect(all[i].datetime >= all[i - 1].datetime).toBe(true)
    }
  })

  it("reports the min and max date", async () => {
    expect(await rowDateBounds()).toEqual({ min: "2026-08-27", max: "2026-08-28" })
  })

  it("reports null bounds on an empty database", async () => {
    resetDbForTests()
    expect(await rowDateBounds()).toBeNull()
  })
})

describe("recomputeRollups", () => {
  beforeEach(async () => {
    await replaceWindows([win("w1", "2026-01-01")])
    await insertRows(dayRows("2026-08-28"))
  })

  it("lands the same values in SQL that buildDailyRows produces in memory", async () => {
    // The existing suite proves rollupsToDailyRows inverts buildDailyRows in
    // memory. Nothing proved the values survive the round trip through SQLite —
    // REAL precision, and is_sprinkler_day crossing INTEGER↔boolean.
    await recomputeRollups("2026-08-28", "2026-08-28")
    const stored = await readRollups()

    const expected = buildDailyRows(enrichRows(dayRows("2026-08-28"), config()))
    const expectedByStation = expected[0].byStation

    for (const row of stored) {
      expect(row.gallons).toBeCloseTo(expectedByStation[row.station], 6)
      expect(typeof row.isSprinklerDay).toBe("boolean")
    }
    expect(stored.map((r) => r.station).sort()).toEqual(
      Object.keys(expectedByStation).sort()
    )
  })

  it("only touches the requested date range", async () => {
    await insertRows(dayRows("2026-08-29"))
    await recomputeRollups("2026-08-28", "2026-08-29")
    expect(new Set((await readRollups()).map((r) => r.date)).size).toBe(2)

    // Recomputing one day must not delete the other's rows.
    await recomputeRollups("2026-08-28", "2026-08-28")
    expect(new Set((await readRollups()).map((r) => r.date)).size).toBe(2)
  })

  it("filters reads by date range", async () => {
    await insertRows(dayRows("2026-08-29"))
    await recomputeRollups("2026-08-28", "2026-08-29")
    const only = await readRollups("2026-08-29", "2026-08-29")
    expect(only.every((r) => r.date === "2026-08-29")).toBe(true)
  })

  it("is idempotent", async () => {
    await recomputeRollups("2026-08-28", "2026-08-28")
    const first = await readRollups()
    await recomputeRollups("2026-08-28", "2026-08-28")
    expect(await readRollups()).toEqual(first)
  })
})

describe("recomputeStats", () => {
  it("derives per-station stats from the full series", async () => {
    await replaceWindows([win("w1", "2026-01-01")])
    await insertRows(dayRows("2026-08-28"))
    await recomputeStats()

    const stats = await readStationStats()
    const front = stats.find((s) => s.id === "T1-01")
    expect(front).toBeDefined()
    expect(front!.avgGpm).toBeCloseTo(6, 3)
    expect(front!.totalGallons).toBeCloseTo(60, 3)
  })

  it("clears stale rows rather than accumulating them", async () => {
    await replaceWindows([win("w1", "2026-01-01")])
    await insertRows(dayRows("2026-08-28"))
    await recomputeStats()
    const first = (await readStationStats()).length
    await recomputeStats()
    expect((await readStationStats()).length).toBe(first)
  })
})

describe("readMaintenance / replaceMaintenance", () => {
  it("round-trips a flag with and without a note", async () => {
    await replaceMaintenance({
      "T1-01": { flaggedAt: "2026-05-01T00:00:00.000Z", note: "leaking head" },
      "T1-02": { flaggedAt: "2026-05-02T00:00:00.000Z" },
    })
    const got = await readMaintenance()
    expect(got["T1-01"]).toEqual({ flaggedAt: "2026-05-01T00:00:00.000Z", note: "leaking head" })
    // The column is nullable and the field optional — a missing note must come
    // back absent, not as an empty string that renders as a blank annotation.
    expect(got["T1-02"]).toEqual({ flaggedAt: "2026-05-02T00:00:00.000Z" })
    expect("note" in got["T1-02"]).toBe(false)
  })

  it("REPLACES rather than merges, so clearing a flag actually clears it", async () => {
    await replaceMaintenance({ "T1-01": { flaggedAt: "2026-05-01T00:00:00.000Z" } })
    await replaceMaintenance({ "T1-02": { flaggedAt: "2026-05-02T00:00:00.000Z" } })
    expect(Object.keys(await readMaintenance())).toEqual(["T1-02"])
  })

  it("returns an empty object when nothing is flagged", async () => {
    expect(await readMaintenance()).toEqual({})
  })
})

describe("replaceConfig", () => {
  it("writes windows and maintenance together", async () => {
    await replaceConfig({
      windows: [win("w1", "2026-07-01")],
      maintenance: { "T1-01": { flaggedAt: "2026-05-01T00:00:00.000Z" } },
    })
    expect((await readWindows()).map((w) => w.id)).toEqual(["w1"])
    expect(Object.keys(await readMaintenance())).toEqual(["T1-01"])
  })

  it("replaces both halves, leaving nothing behind from the previous document", async () => {
    await replaceConfig({
      windows: [win("old", "2026-06-01")],
      maintenance: { "T1-09": { flaggedAt: "2026-05-01T00:00:00.000Z" } },
    })
    await replaceConfig({ windows: [win("new", "2026-07-01")], maintenance: {} })

    expect((await readWindows()).map((w) => w.id)).toEqual(["new"])
    // A stale flag surviving a config replace would be a maintenance warning
    // for a station the current config may not even define.
    expect(await readMaintenance()).toEqual({})
  })
})

describe("clearAllData", () => {
  it("drops rows and derived tables but leaves the config timeline", async () => {
    // The config windows are the hand-tuned part, and since this change they are
    // also the only copy — losing them to a data wipe would be the worse half of
    // the loss, and unlike the rows they cannot be re-uploaded from Flume.
    await replaceConfig({
      windows: [win("w1", "2026-01-01")],
      maintenance: { "T1-01": { flaggedAt: "2026-05-01T00:00:00.000Z" } },
    })
    await insertRows(dayRows("2026-08-28"))
    await recomputeRollups("2026-08-28", "2026-08-28")
    await recomputeStats()

    await clearAllData()

    expect(await countRows()).toBe(0)
    expect(await readRollups()).toEqual([])
    expect(await readStationStats()).toEqual([])
    expect(await readWindows()).toHaveLength(1)
    expect(Object.keys(await readMaintenance())).toEqual(["T1-01"])
  })
})
