import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { resetDbForTests } from "../db"
import {
  readRefreshToken,
  saveRefreshToken,
  refreshTokenUpdatedAt,
  clearRefreshToken,
  saveDeviceStatus,
  readDeviceStatus,
} from "../server/flumeState"

// The refresh token is the one Flume credential the deployment holds, and the
// seed/stored precedence is the part that decides whether a rotation survives.
// Getting it backwards would look fine for exactly one sync.

const saved = { ...process.env }

beforeEach(() => {
  resetDbForTests()
  delete process.env.FLUME_REFRESH_TOKEN
})

afterEach(() => {
  process.env = { ...saved }
})

describe("readRefreshToken", () => {
  it("is null when nothing is stored and nothing seeds it", async () => {
    expect(await readRefreshToken()).toBeNull()
  })

  it("falls back to the env seed on a fresh database", async () => {
    process.env.FLUME_REFRESH_TOKEN = "seed-token"
    expect(await readRefreshToken()).toBe("seed-token")
  })

  it("prefers the STORED token over the env seed", async () => {
    // The stored one is the result of a later rotation, so the env var that
    // seeded it is stale. Preferring the seed would re-send a spent token on
    // every run after the first rotation.
    process.env.FLUME_REFRESH_TOKEN = "seed-token"
    await saveRefreshToken("rotated-token")
    expect(await readRefreshToken()).toBe("rotated-token")
  })

  it("treats an empty seed as absent", async () => {
    process.env.FLUME_REFRESH_TOKEN = ""
    expect(await readRefreshToken()).toBeNull()
  })
})

describe("saveRefreshToken", () => {
  it("round-trips", async () => {
    await saveRefreshToken("token-1")
    expect(await readRefreshToken()).toBe("token-1")
  })

  it("replaces rather than accumulating — the table holds exactly one row", async () => {
    await saveRefreshToken("token-1")
    await saveRefreshToken("token-2")
    await saveRefreshToken("token-3")
    expect(await readRefreshToken()).toBe("token-3")
  })

  it("records when it was written", async () => {
    expect(await refreshTokenUpdatedAt()).toBeNull()
    await saveRefreshToken("token-1")
    const at = await refreshTokenUpdatedAt()
    expect(at).toBeTruthy()
    expect(Number.isNaN(Date.parse(at!))).toBe(false)
  })
})

describe("clearRefreshToken", () => {
  it("forgets the stored token and falls back to the seed again", async () => {
    process.env.FLUME_REFRESH_TOKEN = "seed-token"
    await saveRefreshToken("rotated-token")
    await clearRefreshToken()
    expect(await readRefreshToken()).toBe("seed-token")
  })

  it("leaves nothing behind when there is no seed", async () => {
    await saveRefreshToken("rotated-token")
    await clearRefreshToken()
    expect(await readRefreshToken()).toBeNull()
  })
})

describe("device status", () => {
  const status = {
    deviceId: "d1",
    name: "House",
    batteryLevel: "low",
    connected: false,
    lastSeen: "2026-09-12T18:43:00.000Z",
    checkedAt: "2026-09-13T21:42:00.000Z",
  }

  it("is null before any sync has recorded one", async () => {
    expect(await readDeviceStatus()).toBeNull()
  })

  it("round-trips, including a false connection (not just truthy values)", async () => {
    await saveDeviceStatus(status)
    expect(await readDeviceStatus()).toEqual(status)
  })

  it("keeps unreported fields null rather than inventing values", async () => {
    await saveDeviceStatus({ ...status, batteryLevel: null, connected: null, lastSeen: null })
    expect(await readDeviceStatus()).toMatchObject({ batteryLevel: null, connected: null, lastSeen: null })
  })

  it("replaces the previous reading — it is a reading, not a history", async () => {
    await saveDeviceStatus(status)
    await saveDeviceStatus({ ...status, batteryLevel: "high", connected: true, checkedAt: "2026-09-20T17:00:00.000Z" })
    expect(await readDeviceStatus()).toMatchObject({ batteryLevel: "high", connected: true, checkedAt: "2026-09-20T17:00:00.000Z" })
  })
})
