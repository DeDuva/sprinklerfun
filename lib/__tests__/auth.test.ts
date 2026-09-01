import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { isAuthorized } from "../server/auth"

// Sixteen lines of code that decide whether the database is writable by
// strangers. It takes a plain Request and reads process.env — no DB, no Next
// runtime, no mocking — so there was never a reason for it to be untested, and
// a regression that inverted it would have had no visible symptom at all.

const req = (secret?: string) =>
  new Request("https://example.test/api/rows", {
    method: "POST",
    headers: secret === undefined ? {} : { "x-sprinkler-secret": secret },
  })

describe("isAuthorized", () => {
  const saved = { ...process.env }

  beforeEach(() => {
    delete process.env.APP_SHARED_SECRET
    delete process.env.VERCEL
    delete process.env.VERCEL_ENV
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    process.env = { ...saved }
    vi.restoreAllMocks()
  })

  describe("with a secret configured", () => {
    beforeEach(() => {
      process.env.APP_SHARED_SECRET = "correct-horse"
    })

    it("accepts the matching header", () => {
      expect(isAuthorized(req("correct-horse"))).toBe(true)
    })

    it("rejects a wrong, absent, or empty header", () => {
      expect(isAuthorized(req("wrong"))).toBe(false)
      expect(isAuthorized(req())).toBe(false)
      expect(isAuthorized(req(""))).toBe(false)
    })

    it("does not accept a prefix, a suffix, or different case", () => {
      expect(isAuthorized(req("correct-horse-battery"))).toBe(false)
      expect(isAuthorized(req("correct"))).toBe(false)
      expect(isAuthorized(req("CORRECT-HORSE"))).toBe(false)
    })
  })

  describe("with no secret configured", () => {
    it("allows writes locally, so the app runs with zero config", () => {
      expect(isAuthorized(req())).toBe(true)
    })

    it("REFUSES writes on a deployment", () => {
      // The regression that matters. This returned true, so a secret that was
      // unset, blank, or lost in an env migration left the database anonymously
      // writable — and nothing logged, nothing 500'd, the app looked healthy.
      process.env.VERCEL = "1"
      expect(isAuthorized(req())).toBe(false)
      expect(isAuthorized(req("anything"))).toBe(false)
    })

    it("refuses on preview deployments too, not just production", () => {
      process.env.VERCEL = "1"
      process.env.VERCEL_ENV = "preview"
      expect(isAuthorized(req())).toBe(false)
    })

    it("says so in the log rather than failing silently", () => {
      process.env.VERCEL = "1"
      isAuthorized(req())
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("APP_SHARED_SECRET is not set")
      )
    })
  })

  it("treats a blank secret as unconfigured rather than as a valid value", () => {
    // "" is falsy, so it takes the unconfigured branch. The failure mode worth
    // pinning: a blank env var must not become a secret that an empty header
    // matches.
    process.env.APP_SHARED_SECRET = ""
    process.env.VERCEL = "1"
    expect(isAuthorized(req(""))).toBe(false)
  })
})
