import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { authMode, cookieOptions, passwordMatches, sessionToken, tokenIsValid } from "../server/session"

// The module that decides whether this deployment is readable and writable by
// strangers. It takes no database and no Next runtime — just process.env — so
// there is no excuse for it to be untested, and an inverted check here would
// have no visible symptom at all.

const saved = { ...process.env }

beforeEach(() => {
  delete process.env.APP_PASSWORD
  delete process.env.VERCEL
  delete process.env.VERCEL_ENV
})

afterEach(() => {
  process.env = { ...saved }
})

describe("authMode", () => {
  it("is open locally with no password — zero-config dev and tests", () => {
    expect(authMode()).toBe("open")
  })

  it("is enforced wherever a password is set", () => {
    process.env.APP_PASSWORD = "correct-horse"
    expect(authMode()).toBe("enforced")
    process.env.VERCEL = "1"
    expect(authMode()).toBe("enforced")
  })

  it("refuses on a deployment with no password, rather than falling open", () => {
    // The failure this encodes: an env var lost in a migration used to leave the
    // database anonymously writable with nothing logged and nothing 500ing.
    process.env.VERCEL = "1"
    expect(authMode()).toBe("refuse")
  })

  it("treats an empty password as no password", () => {
    process.env.APP_PASSWORD = ""
    expect(authMode()).toBe("open")
    process.env.VERCEL = "1"
    expect(authMode()).toBe("refuse")
  })
})

describe("passwordMatches", () => {
  beforeEach(() => {
    process.env.APP_PASSWORD = "correct-horse"
  })

  it("accepts the password", () => {
    expect(passwordMatches("correct-horse")).toBe(true)
  })

  it("rejects a wrong one, including a prefix, an extension, and a case change", () => {
    expect(passwordMatches("wrong")).toBe(false)
    expect(passwordMatches("correct")).toBe(false)
    expect(passwordMatches("correct-horse-battery")).toBe(false)
    expect(passwordMatches("CORRECT-HORSE")).toBe(false)
    expect(passwordMatches("")).toBe(false)
  })

  it("rejects everything when no password is configured", () => {
    delete process.env.APP_PASSWORD
    expect(passwordMatches("")).toBe(false)
    expect(passwordMatches("anything")).toBe(false)
  })
})

describe("sessionToken / tokenIsValid", () => {
  it("round-trips the token it issues", () => {
    process.env.APP_PASSWORD = "correct-horse"
    expect(tokenIsValid(sessionToken())).toBe(true)
  })

  it("never contains the password", () => {
    process.env.APP_PASSWORD = "correct-horse"
    expect(sessionToken()).not.toContain("correct-horse")
    expect(sessionToken()).toMatch(/^[0-9a-f]{64}$/)
  })

  it("changes when the password changes — this is the log-out-everywhere lever", () => {
    process.env.APP_PASSWORD = "first"
    const before = sessionToken()
    process.env.APP_PASSWORD = "second"
    expect(sessionToken()).not.toBe(before)
    expect(tokenIsValid(before)).toBe(false)
  })

  it("rejects missing, empty, malformed and foreign tokens", () => {
    process.env.APP_PASSWORD = "correct-horse"
    expect(tokenIsValid(undefined)).toBe(false)
    expect(tokenIsValid("")).toBe(false)
    expect(tokenIsValid("not-hex-at-all")).toBe(false)
    expect(tokenIsValid("ab".repeat(32))).toBe(false)
  })

  it("rejects any token when no password is configured, instead of throwing", () => {
    expect(tokenIsValid("ab".repeat(32))).toBe(false)
  })

  it("throws rather than issuing a token with no password", () => {
    expect(() => sessionToken()).toThrow(/APP_PASSWORD/)
  })
})

describe("cookieOptions", () => {
  it("is httpOnly and lax, so script cannot read it and a link still carries it", () => {
    expect(cookieOptions()).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" })
  })

  it("is Secure only on a deployment — local and E2E serve plain http", () => {
    expect(cookieOptions().secure).toBe(false)
    process.env.VERCEL = "1"
    expect(cookieOptions().secure).toBe(true)
  })
})
