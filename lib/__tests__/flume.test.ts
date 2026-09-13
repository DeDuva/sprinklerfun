import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { decodeJwtUserId, fmtFlumeLocal, queryUsage, getValidAccessToken } from "../server/flume"
import { encryptSecret, decryptSecret } from "../server/crypto"
import type { FlumeConnection } from "../types"

// Build a fake JWT: header.payload.signature with a base64url-encoded payload.
function makeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url")
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.sig`
}

// Minimal Response stand-in for mocking global.fetch (queryUsage only reads
// .ok, .status, and .text()).
function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, text: async () => JSON.stringify(body) } as unknown as Response
}

describe("decodeJwtUserId", () => {
  it("extracts user_id from the token payload", () => {
    expect(decodeJwtUserId(makeJwt({ user_id: 12345 }))).toBe("12345")
  })
  it("throws on a malformed token", () => {
    expect(() => decodeJwtUserId("not-a-jwt")).toThrow()
  })
  it("throws when user_id is absent", () => {
    expect(() => decodeJwtUserId(makeJwt({ sub: "x" }))).toThrow()
  })
})

describe("fmtFlumeLocal", () => {
  it("formats a local date as 'YYYY-MM-DD HH:MM:SS'", () => {
    // Constructed with local components, read back with local getters → stable.
    const d = new Date(2026, 4, 1, 2, 30, 5)
    expect(fmtFlumeLocal(d)).toBe("2026-05-01 02:30:05")
  })
})

describe("crypto round-trip", () => {
  const KEY = "test-encryption-key"
  afterEach(() => { delete process.env.APP_ENCRYPTION_KEY })

  it("encrypts then decrypts back to the original when a key is set", () => {
    process.env.APP_ENCRYPTION_KEY = KEY
    const secret = "super-secret-refresh-token"
    const enc = encryptSecret(secret)
    expect(enc).not.toBe(secret)
    expect(enc.startsWith("enc:v1:")).toBe(true)
    expect(decryptSecret(enc)).toBe(secret)
  })

  it("is a no-op (plaintext) when no key is set", () => {
    const secret = "plaintext-value"
    expect(encryptSecret(secret)).toBe(secret)
    expect(decryptSecret(secret)).toBe(secret)
  })
})

describe("queryUsage", () => {
  beforeEach(() => { vi.restoreAllMocks() })
  afterEach(() => { vi.restoreAllMocks() })

  it("maps Flume samples (datetime/value) to FlumeRow (datetime ISO / gallons)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        success: true,
        data: [
          {
            sprinklerfun: [
              { datetime: "2026-05-01 00:00:00", value: 12.5 },
              { datetime: "2026-05-01 01:00:00", value: 3 },
            ],
          },
        ],
      })
    )
    vi.stubGlobal("fetch", fetchMock)

    const rows = await queryUsage({
      userId: "1",
      deviceId: "dev1",
      accessToken: "tok",
      since: new Date(2026, 4, 1),
      until: new Date(2026, 4, 2),
    })

    expect(rows).toHaveLength(2)
    expect(rows[0].gallons).toBe(12.5)
    expect(rows[1].gallons).toBe(3)
    // Normalized to a UTC ISO string (matches CSV-imported rows).
    expect(rows[0].datetime).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/)

    // One batched query; hourly bucket to match the manual CSV export.
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.queries).toHaveLength(1)
    expect(body.queries[0].bucket).toBe("HR")
    expect(body.queries[0].units).toBe("GALLONS")
  })

  it("throws a rate-limit error on HTTP 429", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ message: "slow down" }, false, 429)))
    await expect(
      queryUsage({ userId: "1", deviceId: "d", accessToken: "t", since: new Date(), until: new Date() })
    ).rejects.toMatchObject({ rateLimited: true, status: 429 })
  })
})

describe("getValidAccessToken", () => {
  it("returns the cached token without refreshing when not expired", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const conn: FlumeConnection = {
      dataSource: "flume_api",
      clientId: "c",
      clientSecret: "s",
      refreshToken: "r",
      accessToken: "still-good",
      accessExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      flumeUserId: "1",
      deviceId: "d",
      deviceName: "Sensor",
      lastSyncAt: null,
      lastSyncStatus: null,
      lastSyncError: null,
    }
    const token = await getValidAccessToken(conn)
    expect(token).toBe("still-good")
    expect(fetchMock).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })
})
