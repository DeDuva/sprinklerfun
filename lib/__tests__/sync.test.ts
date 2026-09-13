import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { resetDbForTests } from "../db"
import { insertRows, countRows, replaceWindows, readRollups, readDayRows, recomputeRollups } from "../server/data"
import { readRefreshToken, saveRefreshToken } from "../server/flumeState"
import type { ConfigWindow } from "../types"

// Replace only the network-facing half of the Flume client. The token
// bookkeeping, window arithmetic, slicing and write path are the things worth
// testing for real — against a real in-memory database and the real
// flumeState module, so persistence is actually exercised.
vi.mock("@/lib/server/flume", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/flume")>()
  return {
    ...actual,
    refreshAccessToken: vi.fn(),
    listWaterSensors: vi.fn(),
    queryUsage: vi.fn(),
  }
})

const flume = await import("@/lib/server/flume")
const refreshAccessToken = vi.mocked(flume.refreshAccessToken)
const listWaterSensors = vi.mocked(flume.listWaterSensors)
const queryUsage = vi.mocked(flume.queryUsage)

const { syncFlumeData } = await import("@/lib/server/sync")

const saved = { ...process.env }

function configure() {
  process.env.FLUME_CLIENT_ID = "c"
  process.env.FLUME_CLIENT_SECRET = "s"
}

/** A JWT whose payload carries user_id, which is where the client reads it from. */
function jwt(userId: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url")
  return `${b64({ alg: "HS256" })}.${b64({ user_id: userId })}.sig`
}

const win = (id: string): ConfigWindow => ({
  id,
  effectiveFrom: "2026-01-01",
  notes: "",
  config: {
    timer1: {
      stations: [{ id: "T1-01", name: "Front", baselineGpm: 6 }],
      programs: {
        A: { enabled: true, start: "06:00:00", days: [0, 1, 2, 3, 4, 5, 6], stations: { "T1-01": { durationMin: 10, enabled: true } } },
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
  },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
})

beforeEach(() => {
  resetDbForTests()
  for (const k of ["FLUME_CLIENT_ID", "FLUME_CLIENT_SECRET", "FLUME_REFRESH_TOKEN", "FLUME_DEVICE_ID"]) {
    delete process.env[k]
  }
  refreshAccessToken.mockReset()
  listWaterSensors.mockReset()
  queryUsage.mockReset()
  // The device list is always read — it carries the timezone. UTC keeps "now"
  // in the tests equal to the process clock.
  listWaterSensors.mockResolvedValue([{ id: "d", name: "House", timezone: "UTC" }])
  vi.spyOn(console, "error").mockImplementation(() => {})
  vi.spyOn(console, "log").mockImplementation(() => {})
})

afterEach(() => {
  process.env = { ...saved }
  vi.restoreAllMocks()
})

describe("syncFlumeData: prerequisites", () => {
  it("refuses, without calling out, when the client credentials are missing", async () => {
    process.env.FLUME_REFRESH_TOKEN = "t"
    const res = await syncFlumeData()
    expect(res).toMatchObject({ ok: false, error: "Flume is not configured" })
    expect(refreshAccessToken).not.toHaveBeenCalled()
  })

  it("says how to connect when there is no refresh token anywhere", async () => {
    configure()
    const res = await syncFlumeData()
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/not connected/)
    expect(res.error).toMatch(/flume:connect/)
    expect(refreshAccessToken).not.toHaveBeenCalled()
  })

  it("uses the env seed when the database has no token yet", async () => {
    configure()
    process.env.FLUME_REFRESH_TOKEN = "seed-token"
    refreshAccessToken.mockResolvedValue({ accessToken: jwt(1), refreshToken: "seed-token" })
    queryUsage.mockResolvedValue([])
    process.env.FLUME_DEVICE_ID = "d"

    await syncFlumeData()
    expect(refreshAccessToken).toHaveBeenCalledWith("seed-token")
  })
})

describe("syncFlumeData: refresh token rotation", () => {
  beforeEach(() => {
    configure()
    process.env.FLUME_DEVICE_ID = "d"
    process.env.FLUME_REFRESH_TOKEN = "original"
    queryUsage.mockResolvedValue([])
  })

  it("persists a rotated token and reports it", async () => {
    refreshAccessToken.mockResolvedValue({ accessToken: jwt(1), refreshToken: "rotated" })
    const res = await syncFlumeData()
    expect(res.tokenRotated).toBe(true)
    expect(await readRefreshToken()).toBe("rotated")
  })

  it("writes nothing when Flume hands back the same token", async () => {
    refreshAccessToken.mockResolvedValue({ accessToken: jwt(1), refreshToken: "original" })
    const res = await syncFlumeData()
    expect(res.tokenRotated).toBe(false)
    // Still the env seed — nothing was stored, so the table stays empty.
    expect(await readRefreshToken()).toBe("original")
  })

  it("persists the rotated token BEFORE the query work, so a later failure cannot strand it", async () => {
    // The token just sent may already be spent. If the query fails and the new
    // one was not written first, the next run would authenticate with a dead
    // token and the sync would stay broken until someone re-ran the connect
    // script. This is the ordering that prevents that.
    refreshAccessToken.mockResolvedValue({ accessToken: jwt(1), refreshToken: "rotated" })
    queryUsage.mockRejectedValue(new Error("network died mid-sync"))

    const res = await syncFlumeData()

    expect(res.ok).toBe(false)
    expect(res.tokenRotated).toBe(true)
    expect(await readRefreshToken()).toBe("rotated")
  })

  it("prefers a previously stored token over a stale env seed", async () => {
    await saveRefreshToken("stored-newer")
    refreshAccessToken.mockResolvedValue({ accessToken: jwt(1), refreshToken: "stored-newer" })
    await syncFlumeData()
    expect(refreshAccessToken).toHaveBeenCalledWith("stored-newer")
  })
})

describe("syncFlumeData: device selection", () => {
  beforeEach(() => {
    configure()
    process.env.FLUME_REFRESH_TOKEN = "t"
    refreshAccessToken.mockResolvedValue({ accessToken: jwt(4242), refreshToken: "t" })
    queryUsage.mockResolvedValue([])
  })

  it("picks the account's only water sensor when no device is pinned", async () => {
    listWaterSensors.mockResolvedValue([{ id: "dev-9", name: "House" }])
    await syncFlumeData()
    expect(listWaterSensors).toHaveBeenCalledWith("4242", jwt(4242))
    expect(queryUsage.mock.calls[0][0].deviceId).toBe("dev-9")
  })

  it("uses FLUME_DEVICE_ID to choose among the account's sensors", async () => {
    // Still lists them: the list is where the location's timezone comes from.
    listWaterSensors.mockResolvedValue([
      { id: "first", name: "House" },
      { id: "pinned", name: "Garden", timezone: "UTC" },
    ])
    process.env.FLUME_DEVICE_ID = "pinned"
    await syncFlumeData()
    expect(queryUsage.mock.calls[0][0].deviceId).toBe("pinned")
  })

  it("fails clearly when FLUME_DEVICE_ID names no sensor on the account", async () => {
    listWaterSensors.mockResolvedValue([{ id: "dev-9", name: "House" }])
    process.env.FLUME_DEVICE_ID = "typo"
    const res = await syncFlumeData()
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/FLUME_DEVICE_ID typo is not a water sensor/)
    expect(queryUsage).not.toHaveBeenCalled()
  })

  it("fails clearly when the account has no water sensor", async () => {
    listWaterSensors.mockResolvedValue([])
    const res = await syncFlumeData()
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/No Flume water sensor/)
  })
})

describe("syncFlumeData: the query window", () => {
  beforeEach(() => {
    configure()
    process.env.FLUME_DEVICE_ID = "d"
    process.env.FLUME_REFRESH_TOKEN = "t"
    refreshAccessToken.mockResolvedValue({ accessToken: jwt(1), refreshToken: "t" })
    queryUsage.mockResolvedValue([])
  })

  it("starts from the last stored day, so a missed run self-heals", async () => {
    await replaceWindows([win("w1")])
    await insertRows([{ datetime: "2026-08-28 00:00:00", gallons: 1 }])
    await syncFlumeData()
    expect(queryUsage.mock.calls[0][0].since.toISOString().slice(0, 10)).toBe("2026-08-27")
  })

  it("backfills about three weeks when the database is empty, in a single run", async () => {
    const res = await syncFlumeData()
    const daysBack = (Date.now() - queryUsage.mock.calls[0][0].since.getTime()) / 86_400_000
    expect(daysBack).toBeGreaterThan(20)
    expect(daysBack).toBeLessThan(22)
    // The empty-database backfill must fit the budget, or it would be fetched
    // over several runs and could stall on slices that hold no data.
    expect(res.truncated).toBe(false)
  })

  it("asks for at most 12 hours of per-minute data per query", async () => {
    // Production rejected 14-day MIN queries with "A provided parameter failed
    // validation".
    await syncFlumeData()
    expect(queryUsage.mock.calls.length).toBeGreaterThan(20)
    for (const [args] of queryUsage.mock.calls) {
      expect(args.until.getTime() - args.since.getTime()).toBeLessThanOrEqual(12 * 3_600_000)
    }
  })

  it("stays inside Flume's hourly rate limit on a long gap, fetching the oldest part first", async () => {
    await replaceWindows([win("w1")])
    const old = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10)
    await insertRows([{ datetime: `${old} 00:00:00`, gallons: 1 }])

    const res = await syncFlumeData()

    // 120 requests/hour, less the refresh and the device lookup, less room
    // for a manual "Sync now" in the same hour.
    expect(queryUsage.mock.calls.length).toBe(50)
    expect(res).toMatchObject({ ok: true, truncated: true })
    // Oldest first: the next run resumes from the last stored row, so starting
    // at the old end is what keeps the catch-up free of holes.
    const firstSince = queryUsage.mock.calls[0][0].since.toISOString().slice(0, 10)
    expect(firstSince < old).toBe(true)
    const lastUntil = queryUsage.mock.calls.at(-1)![0].until.getTime()
    expect(lastUntil).toBeLessThan(Date.now() - 30 * 86_400_000)
  })

  it("reports an ordinary daily window as complete", async () => {
    await replaceWindows([win("w1")])
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
    await insertRows([{ datetime: `${yesterday} 00:00:00`, gallons: 1 }])
    const res = await syncFlumeData()
    expect(res.truncated).toBe(false)
    // Three days of lookback plus a day of padding each side, in 12-hour slices.
    expect(queryUsage.mock.calls.length).toBeLessThanOrEqual(12)
  })

  it("re-reads the last three days even when stored rows are newer than that", async () => {
    // Recent minutes can be stored as zeros Flume later fills in; the window must
    // come back for them rather than starting at the newest stored row.
    await replaceWindows([win("w1")])
    const today = new Date().toISOString().slice(0, 10)
    await insertRows([{ datetime: `${today} 00:00:00`, gallons: 1 }])
    await syncFlumeData()
    const daysBack = (Date.now() - queryUsage.mock.calls[0][0].since.getTime()) / 86_400_000
    // LOOKBACK_DAYS (3) + the one-day pad.
    expect(daysBack).toBeGreaterThan(3.9)
    expect(daysBack).toBeLessThan(4.1)
  })

  it("covers the window contiguously, with no gap between slices", async () => {
    await syncFlumeData()
    const calls = queryUsage.mock.calls.map(([a]) => a)
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i].since.getTime()).toBe(calls[i - 1].until.getTime())
    }
  })
})

describe("syncFlumeData: writing", () => {
  beforeEach(() => {
    configure()
    process.env.FLUME_DEVICE_ID = "d"
    process.env.FLUME_REFRESH_TOKEN = "t"
    refreshAccessToken.mockResolvedValue({ accessToken: jwt(1), refreshToken: "t" })
  })

  it("ingests rows and recomputes the derived tables", async () => {
    await replaceWindows([win("w1")])
    queryUsage.mockResolvedValue([])
    queryUsage.mockResolvedValueOnce([
      { datetime: "2026-08-28 06:01:00", gallons: 6 },
      { datetime: "2026-08-28 06:02:00", gallons: 6 },
    ])

    const res = await syncFlumeData({ since: new Date("2026-08-27T00:00:00Z") })

    expect(res).toMatchObject({ ok: true, inserted: 2 })
    expect(await countRows()).toBe(2)
    expect((await readRollups()).length).toBeGreaterThan(0)
  })

  it("is idempotent — a duplicate cron delivery inserts nothing new", async () => {
    // Vercel states cron delivery is best effort and may invoke the same run
    // twice, so this is a requirement rather than a nicety.
    await replaceWindows([win("w1")])
    queryUsage.mockResolvedValue([])
    const rows = [{ datetime: "2026-08-28 06:01:00", gallons: 6 }]
    queryUsage.mockResolvedValueOnce(rows)
    const first = await syncFlumeData({ since: new Date("2026-08-27T00:00:00Z") })
    queryUsage.mockResolvedValueOnce(rows)
    const second = await syncFlumeData({ since: new Date("2026-08-27T00:00:00Z") })

    expect(first.inserted).toBe(1)
    expect(second.inserted).toBe(0)
    expect(await countRows()).toBe(1)
  })
})

describe("syncFlumeData: minutes Flume has not reported, or that have not happened", () => {
  // The production bug: Flume answers a per-minute query with a 0 for every
  // minute it has no reading for yet, including future ones. Stored first-wins
  // and followed by a window starting at the newest row, those zeros became
  // permanent and the real readings were never requested.
  const minute = (msFromNow: number) =>
    new Date(Date.now() + msFromNow).toISOString().slice(0, 16).replace("T", " ") + ":00"

  beforeEach(async () => {
    configure()
    process.env.FLUME_REFRESH_TOKEN = "t"
    refreshAccessToken.mockResolvedValue({ accessToken: jwt(1), refreshToken: "t" })
    queryUsage.mockResolvedValue([])
    await replaceWindows([win("w1")])
  })

  it("does not store minutes at or after the location's current minute", async () => {
    const past = minute(-2 * 3_600_000)
    const future = minute(2 * 3_600_000)
    queryUsage.mockResolvedValueOnce([
      { datetime: past, gallons: 2 },
      { datetime: future, gallons: 0 },
    ])
    const res = await syncFlumeData()
    expect(res).toMatchObject({ ok: true, inserted: 1 })
    expect(await readDayRows(future.slice(0, 10))).not.toContainEqual({ datetime: future, gallons: 0 })
    expect(await countRows()).toBe(1)
  })

  it("deletes future rows an earlier sync stored, and their rollups", async () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
    await insertRows([
      { datetime: minute(-3_600_000), gallons: 3 },
      { datetime: `${tomorrow} 06:00:00`, gallons: 0 },
    ])
    await recomputeRollups("2000-01-01", tomorrow)
    expect((await readRollups()).some((r) => r.date === tomorrow)).toBe(true)

    const res = await syncFlumeData()

    expect(res).toMatchObject({ ok: true, removed: 1 })
    expect(await countRows()).toBe(1)
    expect((await readRollups()).some((r) => r.date === tomorrow)).toBe(false)
  })

  it("overwrites a stored zero when Flume later reports the real reading", async () => {
    const m = minute(-5 * 3_600_000)
    await insertRows([{ datetime: m, gallons: 0 }])
    queryUsage.mockResolvedValueOnce([{ datetime: m, gallons: 6.5 }])

    const res = await syncFlumeData()

    expect(res).toMatchObject({ ok: true, inserted: 0, corrected: 1 })
    expect(await readDayRows(m.slice(0, 10))).toContainEqual({ datetime: m, gallons: 6.5 })
  })

  it("uses the location's timezone, not the server's, to decide what 'now' is", async () => {
    // UTC+14: a minute an hour from now in UTC is already past there.
    listWaterSensors.mockResolvedValue([{ id: "d", name: "House", timezone: "Pacific/Kiritimati" }])
    // Fifteen hours ahead of UTC is still in the future there. Read with the
    // server's UTC clock instead, the first would be dropped as well.
    const utcSoon = minute(3_600_000)
    const beyondLocalNow = minute(15 * 3_600_000)
    queryUsage.mockResolvedValueOnce([
      { datetime: utcSoon, gallons: 4 },
      { datetime: beyondLocalNow, gallons: 0 },
    ])
    const res = await syncFlumeData()
    expect(res.inserted).toBe(1)
    expect(await readDayRows(utcSoon.slice(0, 10))).toContainEqual({ datetime: utcSoon, gallons: 4 })
  })

  it("still syncs without a timezone, and says it cannot exclude future minutes", async () => {
    listWaterSensors.mockResolvedValue([{ id: "d", name: "House" }])
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    queryUsage.mockResolvedValueOnce([{ datetime: minute(-3_600_000), gallons: 1 }])
    const res = await syncFlumeData()
    expect(res).toMatchObject({ ok: true, inserted: 1, removed: 0 })
    expect(warn.mock.calls.flat().join(" ")).toMatch(/cannot exclude minutes that have not happened/)
  })
})

describe("syncFlumeData: failures", () => {
  beforeEach(() => {
    configure()
    process.env.FLUME_DEVICE_ID = "d"
    process.env.FLUME_REFRESH_TOKEN = "t"
  })

  it("reports a refused refresh token rather than throwing", async () => {
    refreshAccessToken.mockRejectedValue(
      new flume.FlumeError("token refresh failed (HTTP 400): invalid_grant", 400)
    )
    const res = await syncFlumeData()
    expect(res).toMatchObject({ ok: false, inserted: 0 })
    expect(res.error).toMatch(/token refresh failed/)
  })

  it("flags a rate limit distinctly, because it means 'try later'", async () => {
    refreshAccessToken.mockResolvedValue({ accessToken: jwt(1), refreshToken: "t" })
    queryUsage.mockRejectedValue(new flume.FlumeError("rate limit", 429, true))
    expect(await syncFlumeData()).toMatchObject({ ok: false, rateLimited: true })
  })

  it("leaves the database untouched when the very first slice fails", async () => {
    refreshAccessToken.mockResolvedValue({ accessToken: jwt(1), refreshToken: "t" })
    queryUsage.mockRejectedValue(new Error("network down"))
    await syncFlumeData()
    expect(await countRows()).toBe(0)
  })
})
