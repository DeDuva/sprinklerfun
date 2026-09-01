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

  it("spans from the given date to now", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-28T12:00:00"))
    const url = buildFlumeExportUrl("2026-08-01")
    expect(url).toContain("2026-08-01")
    expect(url).toMatch(/2026-08-28/)
  })

  it("uses a hardcoded -07:00 offset, which is wrong for half the year", () => {
    // Pinned deliberately, as a bug this test documents rather than endorses.
    // -07:00 is PDT; the property is on PST (-08:00) from roughly November to
    // March, so a winter export requests a window shifted by an hour. Fixing it
    // means deriving the offset from the date, which is a behaviour change and
    // belongs in its own commit.
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-15T12:00:00"))
    expect(buildFlumeExportUrl("2026-01-01")).toContain("-07:00")
  })
})
