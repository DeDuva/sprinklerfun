import { describe, it, expect, beforeEach, afterEach } from "vitest"
import {
  allowedEmails,
  authMode,
  challengeFor,
  cookieOptions,
  googleConfigured,
  isAllowed,
  issueSession,
  newState,
  newVerifier,
  readSession,
  safeNext,
  sessionEmail,
  stateMatches,
} from "../server/session"

// The module that decides whether this deployment is readable and writable by
// strangers. It takes no database and no Next runtime — just process.env — so
// there is no excuse for it to be untested, and an inverted check here would
// have no visible symptom at all.

const saved = { ...process.env }

/** The three variables that together mean "Google is wired up". */
function configureGoogle() {
  process.env.GOOGLE_CLIENT_ID = "client-id"
  process.env.GOOGLE_CLIENT_SECRET = "client-secret"
  process.env.SESSION_SECRET = "a-long-random-signing-secret"
}

beforeEach(() => {
  delete process.env.GOOGLE_CLIENT_ID
  delete process.env.GOOGLE_CLIENT_SECRET
  delete process.env.SESSION_SECRET
  delete process.env.ALLOWED_EMAILS
  delete process.env.VERCEL
  delete process.env.VERCEL_ENV
})

afterEach(() => {
  process.env = { ...saved }
})

describe("authMode", () => {
  it("is open locally with no credentials — zero-config dev and tests", () => {
    expect(authMode()).toBe("open")
  })

  it("is enforced wherever Google is configured", () => {
    configureGoogle()
    expect(authMode()).toBe("enforced")
    process.env.VERCEL = "1"
    expect(authMode()).toBe("enforced")
  })

  it("refuses on a deployment with no credentials, rather than falling open", () => {
    // The failure this encodes: an env var lost in a migration used to leave the
    // database anonymously writable with nothing logged and nothing 500ing.
    process.env.VERCEL = "1"
    expect(authMode()).toBe("refuse")
  })

  it("needs all three variables — a partial configuration is not 'enforced'", () => {
    process.env.VERCEL = "1"
    process.env.GOOGLE_CLIENT_ID = "client-id"
    expect(authMode()).toBe("refuse")
    process.env.GOOGLE_CLIENT_SECRET = "client-secret"
    expect(authMode()).toBe("refuse")
    // Without SESSION_SECRET no cookie could be signed, so "enforced" would mean
    // a login nobody could ever complete. Refusing is the honest answer.
    expect(googleConfigured()).toBe(false)
    process.env.SESSION_SECRET = "s"
    expect(authMode()).toBe("enforced")
  })

  it("treats empty strings as unset", () => {
    process.env.VERCEL = "1"
    process.env.GOOGLE_CLIENT_ID = ""
    process.env.GOOGLE_CLIENT_SECRET = ""
    process.env.SESSION_SECRET = ""
    expect(authMode()).toBe("refuse")
  })
})

describe("the allow-list", () => {
  it("parses, trims and lower-cases", () => {
    process.env.ALLOWED_EMAILS = " Someone@Gmail.com , other@gmail.com ,,"
    expect(allowedEmails()).toEqual(["someone@gmail.com", "other@gmail.com"])
  })

  it("matches regardless of case or surrounding space", () => {
    process.env.ALLOWED_EMAILS = "someone@gmail.com"
    expect(isAllowed("SOMEONE@GMAIL.COM")).toBe(true)
    expect(isAllowed("  someone@gmail.com  ")).toBe(true)
  })

  it("denies everyone when the list is empty or missing", () => {
    // The dangerous reading would be "no list configured, so allow all" — which
    // hands the database to any Google account the moment the variable goes
    // missing. Fail closed.
    expect(isAllowed("someone@gmail.com")).toBe(false)
    process.env.ALLOWED_EMAILS = "   "
    expect(isAllowed("someone@gmail.com")).toBe(false)
  })

  it("rejects a near miss rather than a prefix or a substring", () => {
    process.env.ALLOWED_EMAILS = "someone@gmail.com"
    expect(isAllowed("someone@gmail.com.evil.test")).toBe(false)
    expect(isAllowed("evilsomeone@gmail.com")).toBe(false)
    expect(isAllowed("someone@gmail.co")).toBe(false)
    expect(isAllowed("")).toBe(false)
    expect(isAllowed(null)).toBe(false)
  })
})

describe("the session cookie", () => {
  beforeEach(() => {
    configureGoogle()
    process.env.ALLOWED_EMAILS = "someone@gmail.com"
  })

  it("round-trips the address it was issued for", () => {
    const token = issueSession("someone@gmail.com")
    expect(readSession(token)?.email).toBe("someone@gmail.com")
    expect(sessionEmail(token)).toBe("someone@gmail.com")
  })

  it("stores the address lower-cased, whatever Google reported", () => {
    expect(readSession(issueSession("SomeOne@Gmail.com"))?.email).toBe("someone@gmail.com")
  })

  it("rejects a tampered payload", () => {
    // Re-signing is the only way to change the address, and that needs the
    // secret. Swapping the body alone must not survive.
    const token = issueSession("someone@gmail.com")
    const [, sig] = token.split(".")
    const forged = Buffer.from(JSON.stringify({ email: "attacker@evil.test", exp: 4102444800 }))
      .toString("base64url")
    expect(readSession(`${forged}.${sig}`)).toBeNull()
  })

  it("rejects a token signed with a different secret", () => {
    const token = issueSession("someone@gmail.com")
    process.env.SESSION_SECRET = "a-different-secret"
    expect(readSession(token)).toBeNull()
  })

  it("rejects an expired token", () => {
    const issuedAt = Date.parse("2026-01-01T00:00:00Z")
    const token = issueSession("someone@gmail.com", issuedAt)
    // One second before the 7-day expiry, and one second after.
    expect(readSession(token, issuedAt + 7 * 24 * 60 * 60 * 1000 - 1000)).not.toBeNull()
    expect(readSession(token, issuedAt + 7 * 24 * 60 * 60 * 1000 + 1000)).toBeNull()
  })

  it("rejects missing, empty, malformed and foreign tokens", () => {
    expect(readSession(undefined)).toBeNull()
    expect(readSession("")).toBeNull()
    expect(readSession("no-dot-at-all")).toBeNull()
    expect(readSession("body.")).toBeNull()
    expect(readSession(".sig")).toBeNull()
    expect(readSession("not-base64.not-hex")).toBeNull()
  })

  it("never contains the signing secret", () => {
    expect(issueSession("someone@gmail.com")).not.toContain("a-long-random-signing-secret")
  })

  it("throws rather than issuing a token with no secret configured", () => {
    delete process.env.SESSION_SECRET
    expect(() => issueSession("someone@gmail.com")).toThrow(/SESSION_SECRET/)
  })
})

describe("sessionEmail re-checks the allow-list", () => {
  beforeEach(() => {
    configureGoogle()
    process.env.ALLOWED_EMAILS = "someone@gmail.com"
  })

  it("stops accepting a still-valid cookie once the address is removed", () => {
    // This is the whole reason sessionEmail exists rather than readSession
    // being the guard's entry point. Checking the list only at sign-in means
    // removing someone does nothing for up to seven days.
    const token = issueSession("someone@gmail.com")
    expect(sessionEmail(token)).toBe("someone@gmail.com")

    process.env.ALLOWED_EMAILS = "other@gmail.com"
    expect(sessionEmail(token)).toBeNull()
    // The cookie itself is still perfectly valid — it is the permission that is gone.
    expect(readSession(token)).not.toBeNull()
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

describe("CSRF state and PKCE", () => {
  it("generates distinct, non-trivial values", () => {
    expect(newState()).not.toBe(newState())
    expect(newVerifier()).not.toBe(newVerifier())
    expect(newState().length).toBeGreaterThanOrEqual(32)
    expect(newVerifier().length).toBeGreaterThanOrEqual(32)
  })

  it("derives a stable S256 challenge that is not the verifier", () => {
    const verifier = newVerifier()
    expect(challengeFor(verifier)).toBe(challengeFor(verifier))
    expect(challengeFor(verifier)).not.toBe(verifier)
    // base64url: no padding, no + or /
    expect(challengeFor(verifier)).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it("matches state only when both sides are present and identical", () => {
    expect(stateMatches("abc", "abc")).toBe(true)
    expect(stateMatches("abc", "abd")).toBe(false)
    expect(stateMatches("abc", "abcd")).toBe(false)
    expect(stateMatches(undefined, "abc")).toBe(false)
    expect(stateMatches("abc", undefined)).toBe(false)
    expect(stateMatches(undefined, undefined)).toBe(false)
  })
})

describe("safeNext", () => {
  it("keeps an in-app path", () => {
    expect(safeNext("/analysis?day=2026-08-28")).toBe("/analysis?day=2026-08-28")
  })

  it("refuses anything that could leave this origin", () => {
    // A post-sign-in open redirect is unusually effective, because the victim
    // really did just authenticate.
    expect(safeNext("//evil.test")).toBe("/")
    expect(safeNext("https://evil.test")).toBe("/")
    expect(safeNext("evil.test")).toBe("/")
    expect(safeNext(null)).toBe("/")
    expect(safeNext("")).toBe("/")
  })
})
