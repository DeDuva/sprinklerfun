import { describe, it, expect, afterEach, vi } from "vitest"
import { parseFlumeCsvRows, buildFlumeExportUrl } from "../csvImport"

// The app's only ingest path, and it drops malformed rows without telling anyone.
// Two pure functions, no DOM and no DB — testable in the existing node
// environment with nothing new installed, which makes the previous zero coverage
// hard to justify.

describe("parseFlumeCsvRows", () => {
  it("accepts the header spellings Flume has actually emitted", () => {
    expect(parseFlumeCsvRows([{ datetime: "2026-08-28 03:00:00", gallons: "1.5" }]))
      .toEqual([{ datetime: "2026-08-28 03:00:00", gallons: 1.5 }])
    expect(parseFlumeCsvRows([{ Datetime: "2026-08-28 03:00:00", Gallons: "1.5" }]))
      .toEqual([{ datetime: "2026-08-28 03:00:00", gallons: 1.5 }])
    expect(parseFlumeCsvRows([{ DateTime: "2026-08-28 03:00:00", gallons: "1.5" }]))
      .toEqual([{ datetime: "2026-08-28 03:00:00", gallons: 1.5 }])
  })

  it("trims surrounding whitespace on the timestamp", () => {
    const [row] = parseFlumeCsvRows([{ datetime: "  2026-08-28 03:00:00  ", gallons: "1" }])
    expect(row.datetime).toBe("2026-08-28 03:00:00")
  })

  it("keeps a zero reading — most minutes of most days are zero", () => {
    expect(parseFlumeCsvRows([{ datetime: "2026-08-28 03:00:00", gallons: "0" }]))
      .toHaveLength(1)
  })

  it("defaults a missing gallons column to zero rather than dropping the row", () => {
    const [row] = parseFlumeCsvRows([{ datetime: "2026-08-28 03:00:00" }])
    expect(row.gallons).toBe(0)
  })

  it("drops rows with no recognised timestamp column", () => {
    expect(parseFlumeCsvRows([{ when: "2026-08-28 03:00:00", gallons: "1" }])).toEqual([])
  })

  it("drops rows whose gallons cannot be parsed at all", () => {
    expect(parseFlumeCsvRows([{ datetime: "2026-08-28 03:00:00", gallons: "abc" }])).toEqual([])
  })

  it("documents that parseFloat accepts a numeric prefix", () => {
    // "12abc" → 12. This is parseFloat's behaviour, not a decision made here,
    // and it is the reason the API-side validator in app/api/rows/route.ts does
    // not trust this function's output. Pinned so a future change to either side
    // is a deliberate one.
    const [row] = parseFlumeCsvRows([{ datetime: "2026-08-28 03:00:00", gallons: "12abc" }])
    expect(row.gallons).toBe(12)
  })

  it("does NOT validate the timestamp format — that is the API's job", () => {
    // A garbage timestamp survives parsing. It is rejected at POST /api/rows,
    // because flume_rows is indexed on substr(datetime, 1, 10) and rowDateBounds
    // takes a lexicographic MIN/MAX over the raw string.
    expect(parseFlumeCsvRows([{ datetime: "banana", gallons: "1" }]))
      .toEqual([{ datetime: "banana", gallons: 1 }])
  })

  it("handles an empty input without throwing", () => {
    expect(parseFlumeCsvRows([])).toEqual([])
  })
})

describe("buildFlumeExportUrl", () => {
  afterEach(() => vi.useRealTimers())

  // "±HH:MM" at the very end of a bound.
  const offsetOf = (url: string, param: "since" | "until") =>
    new URL(url).searchParams.get(param)!.slice(-6)

  it("spans from the given date to now, in local wall-clock time", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 28, 12, 0, 0)) // local noon, 28 Aug
    const url = buildFlumeExportUrl("2026-08-01")
    const params = new URL(url).searchParams
    expect(params.get("since")).toContain("2026-08-01T00:00:00.000")
    // The upper bound is the local date, not whatever UTC says it is. This
    // previously used toISOString(), so east or west of UTC it named a different
    // day than the one the user is actually looking at.
    expect(params.get("until")).toContain("2026-08-28T12:00:00.000")
  })

  it("derives the offset from the date instead of hardcoding one", () => {
    // Was pinned at "-07:00" — Pacific *daylight* time — so a winter export
    // asked for a window shifted by an hour. Worse, `until` was a UTC
    // wall-clock wearing that label, which was seven hours out all year.
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 0)) // January
    const winter = buildFlumeExportUrl("2026-01-01")
    vi.setSystemTime(new Date(2026, 6, 15, 12, 0, 0)) // July
    const summer = buildFlumeExportUrl("2026-07-01")

    for (const url of [winter, summer]) {
      expect(offsetOf(url, "since")).toMatch(/^[+-]\d{2}:\d{2}$/)
      expect(offsetOf(url, "until")).toMatch(/^[+-]\d{2}:\d{2}$/)
    }

    // In a zone with DST the two seasons must differ; in a zone without one they
    // must agree. Asserting the relationship keeps this true in any timezone,
    // which is the whole point — the old test only held in Pacific time.
    const hasDst =
      new Date(2026, 0, 15).getTimezoneOffset() !== new Date(2026, 6, 15).getTimezoneOffset()
    expect(offsetOf(winter, "until") !== offsetOf(summer, "until")).toBe(hasDst)
  })

  it("falls back to the epoch date when nothing is stored yet", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 28, 12, 0, 0))
    const since = new URL(buildFlumeExportUrl(null)).searchParams.get("since")!
    expect(since).toContain("2026-05-01T00:00:00.000")
  })
})
