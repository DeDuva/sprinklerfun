import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  FlumeError,
  decodeJwtUserId,
  fetchAccessToken,
  flumeConfigured,
  fmtFlumeDatetime,
  listWaterSensors,
  queryUsage,
} from "../server/flume"

// The Flume client talks to a third party we cannot reach from a test, so every
// case here stubs fetch. What is worth pinning is the shape of what we send and
// how we read what comes back — the two places where a wrong assumption is
// invisible until months of data are silently wrong.

const saved = { ...process.env }

function configure() {
  process.env.FLUME_CLIENT_ID = "client-id"
  process.env.FLUME_CLIENT_SECRET = "client-secret"
  process.env.FLUME_USERNAME = "someone@example.test"
  process.env.FLUME_PASSWORD = "hunter2"
}

/** Flume wraps responses as { success, data: [...] }; parseJson only reads text(). */
function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, text: async () => JSON.stringify(body) } as unknown as Response
}

function makeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url")
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.sig`
}

beforeEach(() => {
  for (const k of [
    "FLUME_CLIENT_ID",
    "FLUME_CLIENT_SECRET",
    "FLUME_USERNAME",
    "FLUME_PASSWORD",
    "FLUME_DEVICE_ID",
  ]) {
    delete process.env[k]
  }
})

afterEach(() => {
  process.env = { ...saved }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("flumeConfigured", () => {
  it("needs all four variables — a partial configuration is not 'nearly working'", () => {
    expect(flumeConfigured()).toBe(false)
    process.env.FLUME_CLIENT_ID = "c"
    expect(flumeConfigured()).toBe(false)
    process.env.FLUME_CLIENT_SECRET = "s"
    expect(flumeConfigured()).toBe(false)
    process.env.FLUME_USERNAME = "u"
    expect(flumeConfigured()).toBe(false)
    process.env.FLUME_PASSWORD = "p"
    expect(flumeConfigured()).toBe(true)
  })

  it("treats empty strings as unset", () => {
    configure()
    process.env.FLUME_PASSWORD = ""
    expect(flumeConfigured()).toBe(false)
  })
})

describe("decodeJwtUserId", () => {
  it("extracts user_id from the token payload", () => {
    expect(decodeJwtUserId(makeJwt({ user_id: 12345 }))).toBe("12345")
  })

  it("throws on a malformed token, a non-JSON payload, or a missing user_id", () => {
    expect(() => decodeJwtUserId("not-a-jwt")).toThrow()
    expect(() => decodeJwtUserId("a.@@@.c")).toThrow()
    expect(() => decodeJwtUserId(makeJwt({ sub: "x" }))).toThrow(/user_id/)
  })
})

describe("fmtFlumeDatetime", () => {
  it("formats as 'YYYY-MM-DD HH:MM:SS'", () => {
    expect(fmtFlumeDatetime(new Date("2026-05-01T02:30:05Z"))).toBe("2026-05-01 02:30:05")
  })

  it("does not depend on the process timezone", () => {
    // The whole point. The previous version read local getters and relied on an
    // APP_TIMEZONE pin that no longer exists, so the query window moved
    // depending on where the code ran.
    const d = new Date("2026-05-01T02:30:05Z")
    const before = process.env.TZ
    try {
      process.env.TZ = "Pacific/Kiritimati" // UTC+14
      const plus14 = fmtFlumeDatetime(d)
      process.env.TZ = "Pacific/Midway" // UTC-11
      expect(fmtFlumeDatetime(d)).toBe(plus14)
      expect(plus14).toBe("2026-05-01 02:30:05")
    } finally {
      process.env.TZ = before
    }
  })
})

describe("fetchAccessToken", () => {
  it("refuses to call out when unconfigured", async () => {
    await expect(fetchAccessToken()).rejects.toThrow(/not configured/)
  })

  it("sends the password grant and returns the token", async () => {
    configure()
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ data: [{ access_token: "tok", expires_in: 3600 }] })
    )
    vi.stubGlobal("fetch", fetchMock)

    expect(await fetchAccessToken()).toBe("tok")
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.grant_type).toBe("password")
    expect(body.client_id).toBe("client-id")
    expect(body.username).toBe("someone@example.test")
  })

  it("throws when the response carries no token", async () => {
    configure()
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ data: [{}] })))
    await expect(fetchAccessToken()).rejects.toThrow(/no access_token/)
  })

  it("surfaces an auth failure without echoing the credentials", async () => {
    configure()
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ message: "bad creds" }, false, 401))
    )
    await expect(fetchAccessToken()).rejects.toThrow(/authentication failed \(HTTP 401\)/)
    // The message reaches the logs; the password must not travel with it.
    await expect(fetchAccessToken()).rejects.not.toThrow(/hunter2/)
  })
})

describe("listWaterSensors", () => {
  it("keeps water sensors (type 2) and drops bridges (type 1)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          data: [
            { id: 1, type: 1, name: "Bridge" },
            { id: 2, type: 2, location: { name: "House" } },
          ],
        })
      )
    )
    const devices = await listWaterSensors("u1", "tok")
    expect(devices).toEqual([{ id: "2", name: "House" }])
  })

  it("raises a rate-limit error on HTTP 429", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, false, 429)))
    await expect(listWaterSensors("u1", "tok")).rejects.toMatchObject({ rateLimited: true })
  })
})

describe("queryUsage", () => {
  const sample = () =>
    jsonResponse({
      data: [
        {
          sprinklerfun: [
            { datetime: "2026-05-01 00:00:00", value: 12.5 },
            { datetime: "2026-05-01 00:01:00", value: 3 },
          ],
        },
      ],
    })

  it("asks for per-MINUTE buckets", async () => {
    // Not a detail: this app attributes water to stations by minute of day.
    // The previous version defaulted to "HR" on the stated grounds that it
    // matched the manual CSV export — the real exports are per-minute, and
    // hourly totals would make station attribution meaningless.
    const fetchMock = vi.fn().mockResolvedValue(sample())
    vi.stubGlobal("fetch", fetchMock)
    await queryUsage({
      userId: "1",
      deviceId: "d",
      accessToken: "t",
      since: new Date("2026-05-01T00:00:00Z"),
      until: new Date("2026-05-02T00:00:00Z"),
    })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.queries[0].bucket).toBe("MIN")
    expect(body.queries[0].units).toBe("GALLONS")
    expect(body.queries[0].since_datetime).toBe("2026-05-01 00:00:00")
  })

  it("returns Flume's datetime UNCHANGED, with no timezone suffix", async () => {
    // The regression that would have made every synced row fail ingest. The
    // previous version ran the value through new Date(...).toISOString(),
    // producing a trailing Z — which POST /api/rows rejects with a 400 by
    // design, because everything downstream reads naive wall-clock time.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sample()))
    const rows = await queryUsage({
      userId: "1",
      deviceId: "d",
      accessToken: "t",
      since: new Date(),
      until: new Date(),
    })
    expect(rows[0].datetime).toBe("2026-05-01 00:00:00")
    expect(rows[0].datetime).not.toMatch(/[Zz]|[+-]\d{2}:\d{2}$/)
    // And it matches the ingest contract exactly.
    expect(rows[0].datetime).toMatch(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/)
    expect(rows[1]).toEqual({ datetime: "2026-05-01 00:01:00", gallons: 3 })
  })

  it("returns an empty array when the device reported nothing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ data: [{}] })))
    await expect(
      queryUsage({ userId: "1", deviceId: "d", accessToken: "t", since: new Date(), until: new Date() })
    ).resolves.toEqual([])
  })

  it("throws a rate-limit error on HTTP 429", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ message: "slow down" }, false, 429)))
    await expect(
      queryUsage({ userId: "1", deviceId: "d", accessToken: "t", since: new Date(), until: new Date() })
    ).rejects.toMatchObject({ rateLimited: true, status: 429 })
  })

  it("wraps other failures as FlumeError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ message: "boom" }, false, 500)))
    await expect(
      queryUsage({ userId: "1", deviceId: "d", accessToken: "t", since: new Date(), until: new Date() })
    ).rejects.toBeInstanceOf(FlumeError)
  })
})
