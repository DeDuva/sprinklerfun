import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// The sync itself is covered in sync.test.ts against a real database; what
// these cover is the part unique to the routes — who is allowed to trigger it.
vi.mock("@/lib/server/sync", () => ({ syncFlumeData: vi.fn() }))

const { syncFlumeData } = await import("@/lib/server/sync")
const sync = vi.mocked(syncFlumeData)

const { GET: cron } = await import("@/app/api/cron/route")
const { POST: manualSync } = await import("@/app/api/sync/route")

const saved = { ...process.env }

const req = (auth?: string) =>
  new NextRequest("https://sprinklerfun.test/api/cron", {
    headers: auth ? { authorization: auth } : {},
  })

beforeEach(() => {
  delete process.env.CRON_SECRET
  for (const k of ["FLUME_CLIENT_ID", "FLUME_CLIENT_SECRET", "FLUME_USERNAME", "FLUME_PASSWORD"]) {
    delete process.env[k]
  }
  sync.mockReset()
  sync.mockResolvedValue({ ok: true, inserted: 3, rollupDays: 1 })
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  process.env = { ...saved }
  vi.restoreAllMocks()
})

function configureFlume() {
  process.env.FLUME_CLIENT_ID = "c"
  process.env.FLUME_CLIENT_SECRET = "s"
  process.env.FLUME_USERNAME = "u"
  process.env.FLUME_PASSWORD = "p"
}

describe("GET /api/cron", () => {
  it("refuses everything when CRON_SECRET is unset", async () => {
    // This path is excluded from the proxy guard, so an unset secret would
    // leave a public endpoint that triggers a full ingest and a whole-table
    // recompute on demand. Fail closed.
    const res = await cron(req("Bearer anything"))
    expect(res.status).toBe(401)
    expect(sync).not.toHaveBeenCalled()
  })

  it("refuses a missing, malformed or wrong bearer token", async () => {
    process.env.CRON_SECRET = "the-secret"
    for (const auth of [undefined, "the-secret", "Bearer wrong", "bearer the-secret", "Basic the-secret"]) {
      const res = await cron(req(auth))
      expect(res.status, String(auth)).toBe(401)
    }
    expect(sync).not.toHaveBeenCalled()
  })

  it("gives the same answer for 'not configured' and 'wrong secret'", async () => {
    const unconfigured = await cron(req("Bearer x"))
    process.env.CRON_SECRET = "the-secret"
    const wrong = await cron(req("Bearer nope"))
    expect(unconfigured.status).toBe(wrong.status)
    expect(await unconfigured.json()).toEqual(await wrong.json())
  })

  it("runs the sync on a correct bearer token", async () => {
    process.env.CRON_SECRET = "the-secret"
    const res = await cron(req("Bearer the-secret"))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, inserted: 3 })
    expect(sync).toHaveBeenCalledTimes(1)
  })

  it("answers 200 even when the sync fails, because Vercel does not retry", async () => {
    process.env.CRON_SECRET = "the-secret"
    sync.mockResolvedValue({ ok: false, inserted: 0, rollupDays: 0, error: "Flume is down" })
    const res = await cron(req("Bearer the-secret"))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: false, error: "Flume is down" })
  })

  it("does not treat the cron user agent or schedule header as authentication", async () => {
    // Both are ordinary request headers; anyone can send them.
    process.env.CRON_SECRET = "the-secret"
    const spoofed = new NextRequest("https://sprinklerfun.test/api/cron", {
      headers: { "user-agent": "vercel-cron/1.0", "x-vercel-cron-schedule": "0 17 * * *" },
    })
    expect((await cron(spoofed)).status).toBe(401)
    expect(sync).not.toHaveBeenCalled()
  })
})

describe("POST /api/sync", () => {
  it("503s when Flume is not configured, rather than reporting a failed sync", async () => {
    const res = await manualSync()
    expect(res.status).toBe(503)
    expect(sync).not.toHaveBeenCalled()
  })

  it("runs the sync when configured", async () => {
    configureFlume()
    const res = await manualSync()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, inserted: 3 })
  })

  it("surfaces a rate limit as 429 so the UI can say 'try later'", async () => {
    configureFlume()
    sync.mockResolvedValue({ ok: false, inserted: 0, rollupDays: 0, error: "rate limit", rateLimited: true })
    expect((await manualSync()).status).toBe(429)
  })

  it("reports an ordinary failure as 200 with ok:false", async () => {
    configureFlume()
    sync.mockResolvedValue({ ok: false, inserted: 0, rollupDays: 0, error: "boom" })
    const res = await manualSync()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: false, error: "boom" })
  })
})
