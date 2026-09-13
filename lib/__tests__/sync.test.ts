import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { resetDbForTests } from "../db"
import { insertRows, countRows, replaceWindows, readRollups } from "../server/data"
import type { ConfigWindow } from "../types"

// Replace only the network-facing half of the Flume client; the window
// arithmetic, slicing and write path are the things worth testing for real,
// against a real in-memory database.
vi.mock("@/lib/server/flume", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/flume")>()
  return {
    ...actual,
    fetchAccessToken: vi.fn(),
    listWaterSensors: vi.fn(),
    queryUsage: vi.fn(),
  }
})

const flume = await import("@/lib/server/flume")
const fetchAccessToken = vi.mocked(flume.fetchAccessToken)
const listWaterSensors = vi.mocked(flume.listWaterSensors)
const queryUsage = vi.mocked(flume.queryUsage)

const { syncFlumeData } = await import("@/lib/server/sync")

const saved = { ...process.env }

function configure() {
  process.env.FLUME_CLIENT_ID = "c"
  process.env.FLUME_CLIENT_SECRET = "s"
  process.env.FLUME_USERNAME = "u"
  process.env.FLUME_PASSWORD = "p"
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
  for (const k of ["FLUME_CLIENT_ID", "FLUME_CLIENT_SECRET", "FLUME_USERNAME", "FLUME_PASSWORD", "FLUME_DEVICE_ID"]) {
    delete process.env[k]
  }
  fetchAccessToken.mockReset()
  listWaterSensors.mockReset()
  queryUsage.mockReset()
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  process.env = { ...saved }
  vi.restoreAllMocks()
})

describe("syncFlumeData: configuration", () => {
  it("refuses, without calling out, when Flume is not configured", async () => {
    const res = await syncFlumeData()
    expect(res).toMatchObject({ ok: false, inserted: 0, error: "Flume is not configured" })
    expect(fetchAccessToken).not.toHaveBeenCalled()
  })
})

describe("syncFlumeData: device selection", () => {
  beforeEach(() => {
    configure()
    fetchAccessToken.mockResolvedValue(jwt(4242))
    queryUsage.mockResolvedValue([])
  })

  it("picks the account's only water sensor when no device is pinned", async () => {
    listWaterSensors.mockResolvedValue([{ id: "dev-9", name: "House" }])
    await syncFlumeData()
    expect(listWaterSensors).toHaveBeenCalledWith("4242", jwt(4242))
    expect(queryUsage.mock.calls[0][0].deviceId).toBe("dev-9")
  })

  it("uses FLUME_DEVICE_ID without listing devices at all", async () => {
    process.env.FLUME_DEVICE_ID = "pinned"
    await syncFlumeData()
    expect(listWaterSensors).not.toHaveBeenCalled()
    expect(queryUsage.mock.calls[0][0].deviceId).toBe("pinned")
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
    fetchAccessToken.mockResolvedValue(jwt(1))
    queryUsage.mockResolvedValue([])
  })

  it("starts from the last stored day, so a missed run self-heals", async () => {
    await replaceWindows([win("w1")])
    await insertRows([{ datetime: "2026-08-28 00:00:00", gallons: 1 }])

    await syncFlumeData()

    // Padded a day back from the last stored day: Flume reads the window as
    // account-local while we build it from UTC, and over-fetching is free
    // because rows dedupe.
    const first = queryUsage.mock.calls[0][0]
    expect(first.since.toISOString().slice(0, 10)).toBe("2026-08-27")
  })

  it("reaches a year back when the database is empty", async () => {
    await syncFlumeData()
    const first = queryUsage.mock.calls[0][0]
    const daysBack = (Date.now() - first.since.getTime()) / 86_400_000
    expect(daysBack).toBeGreaterThan(360)
    expect(daysBack).toBeLessThan(370)
  })

  it("slices a long backfill into several requests rather than one huge one", async () => {
    // A year at per-minute resolution is ~525,000 samples; one request risks
    // the function's memory or time limit, and Vercel does not retry a cron.
    await syncFlumeData()
    expect(queryUsage.mock.calls.length).toBeGreaterThan(20)
    for (const [args] of queryUsage.mock.calls) {
      const spanDays = (args.until.getTime() - args.since.getTime()) / 86_400_000
      expect(spanDays).toBeLessThanOrEqual(14.01)
    }
  })

  it("covers the window contiguously, with no gap between slices", async () => {
    await syncFlumeData()
    const calls = queryUsage.mock.calls.map(([a]) => a)
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i].since.getTime()).toBe(calls[i - 1].until.getTime())
    }
  })

  it("honours an explicit since", async () => {
    await syncFlumeData({ since: new Date("2026-08-01T00:00:00Z") })
    expect(queryUsage.mock.calls[0][0].since.toISOString().slice(0, 10)).toBe("2026-07-31")
  })
})

describe("syncFlumeData: writing", () => {
  beforeEach(() => {
    configure()
    process.env.FLUME_DEVICE_ID = "d"
    fetchAccessToken.mockResolvedValue(jwt(1))
  })

  it("ingests rows and recomputes the derived tables once", async () => {
    await replaceWindows([win("w1")])
    queryUsage.mockResolvedValue([])
    queryUsage.mockResolvedValueOnce([
      { datetime: "2026-08-28 06:01:00", gallons: 6 },
      { datetime: "2026-08-28 06:02:00", gallons: 6 },
    ])

    const res = await syncFlumeData({ since: new Date("2026-08-27T00:00:00Z") })

    expect(res.ok).toBe(true)
    expect(res.inserted).toBe(2)
    expect(await countRows()).toBe(2)
    // The rollups were rebuilt from what was just written.
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

describe("syncFlumeData: failures", () => {
  beforeEach(() => {
    configure()
    process.env.FLUME_DEVICE_ID = "d"
  })

  it("reports an auth failure rather than throwing", async () => {
    fetchAccessToken.mockRejectedValue(new flume.FlumeError("authentication failed (HTTP 401)", 401))
    const res = await syncFlumeData()
    expect(res).toMatchObject({ ok: false, inserted: 0 })
    expect(res.error).toMatch(/authentication failed/)
  })

  it("flags a rate limit distinctly, because it means 'try later'", async () => {
    fetchAccessToken.mockResolvedValue(jwt(1))
    queryUsage.mockRejectedValue(new flume.FlumeError("rate limit", 429, true))
    const res = await syncFlumeData()
    expect(res).toMatchObject({ ok: false, rateLimited: true })
  })

  it("leaves the database untouched when the very first slice fails", async () => {
    fetchAccessToken.mockResolvedValue(jwt(1))
    queryUsage.mockRejectedValue(new Error("network down"))
    await syncFlumeData()
    expect(await countRows()).toBe(0)
  })
})
