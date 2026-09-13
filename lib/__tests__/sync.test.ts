import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { resetDbForTests } from "../db"
import { insertRows, countRows, replaceWindows, readRollups } from "../server/data"
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

  it("reaches a year back when the database is empty", async () => {
    await syncFlumeData()
    const daysBack = (Date.now() - queryUsage.mock.calls[0][0].since.getTime()) / 86_400_000
    expect(daysBack).toBeGreaterThan(360)
    expect(daysBack).toBeLessThan(370)
  })

  it("slices a long backfill rather than asking for it all at once", async () => {
    await syncFlumeData()
    expect(queryUsage.mock.calls.length).toBeGreaterThan(20)
    for (const [args] of queryUsage.mock.calls) {
      expect((args.until.getTime() - args.since.getTime()) / 86_400_000).toBeLessThanOrEqual(14.01)
    }
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
