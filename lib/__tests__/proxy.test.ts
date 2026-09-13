import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { proxy, config } from "../../proxy"
import { COOKIE, issueSession } from "../server/session"

// proxy.ts is the entire access control for this app: every route is behind it
// except the handful the matcher excludes. These cover the decisions it makes,
// because the ones that matter are all invisible when wrong — a guard that lets
// everyone through looks exactly like a guard that works.

const saved = { ...process.env }

const req = (path: string, cookie?: string) =>
  new NextRequest(`https://sprinklerfun.test${path}`, {
    headers: cookie ? { cookie: `${COOKIE}=${cookie}` } : {},
  })

function configureGoogle() {
  process.env.GOOGLE_CLIENT_ID = "client-id"
  process.env.GOOGLE_CLIENT_SECRET = "client-secret"
  process.env.SESSION_SECRET = "a-long-random-signing-secret"
  process.env.ALLOWED_EMAILS = "someone@gmail.com"
}

beforeEach(() => {
  delete process.env.GOOGLE_CLIENT_ID
  delete process.env.GOOGLE_CLIENT_SECRET
  delete process.env.SESSION_SECRET
  delete process.env.ALLOWED_EMAILS
  delete process.env.VERCEL
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  process.env = { ...saved }
  vi.restoreAllMocks()
})

describe("open mode (local dev, no credentials)", () => {
  it("lets everything through", () => {
    for (const path of ["/", "/config", "/api/rows", "/api/rollup"]) {
      expect(proxy(req(path))?.status, path).toBe(200)
    }
  })
})

describe("refuse mode (deployed with no credentials)", () => {
  beforeEach(() => {
    process.env.VERCEL = "1"
  })

  it("503s an API route", async () => {
    const res = proxy(req("/api/rollup"))!
    expect(res.status).toBe(503)
    expect((await res.json()).error).toMatch(/not configured/i)
  })

  it("503s a page rather than redirecting to a sign-in that cannot work", () => {
    expect(proxy(req("/")).status).toBe(503)
  })

  it("does not serve the app to someone holding an old cookie", () => {
    expect(proxy(req("/", "ab.cd")).status).toBe(503)
  })

  it("stays closed even with a partial configuration", () => {
    // Half-configured is not "nearly working", it is "cannot authenticate
    // anyone" — and falling open there is the exact failure this app has
    // already shipped once.
    process.env.GOOGLE_CLIENT_ID = "client-id"
    process.env.ALLOWED_EMAILS = "someone@gmail.com"
    expect(proxy(req("/api/rollup")).status).toBe(503)
  })
})

describe("enforced mode", () => {
  beforeEach(configureGoogle)

  it("passes a request carrying a valid session", () => {
    expect(proxy(req("/api/rollup", issueSession("someone@gmail.com"))).status).toBe(200)
  })

  it("401s an API request with no cookie, a junk cookie, or a forged one", () => {
    expect(proxy(req("/api/rollup")).status).toBe(401)
    expect(proxy(req("/api/rollup", "not-a-token")).status).toBe(401)
    expect(proxy(req("/api/rollup", "ab.cd")).status).toBe(401)
  })

  it("401s a session whose address has been taken off the allow-list", () => {
    // Revocation must not wait for the cookie to expire.
    const token = issueSession("someone@gmail.com")
    expect(proxy(req("/api/rollup", token)).status).toBe(200)
    process.env.ALLOWED_EMAILS = "other@gmail.com"
    expect(proxy(req("/api/rollup", token)).status).toBe(401)
  })

  it("401s a session signed with a different secret", () => {
    const token = issueSession("someone@gmail.com")
    process.env.SESSION_SECRET = "rotated"
    expect(proxy(req("/api/rollup", token)).status).toBe(401)
  })

  it("redirects a page request to the sign-in, remembering where it was going", () => {
    const res = proxy(req("/analysis?day=2026-08-28"))
    expect(res.status).toBe(307)
    const location = new URL(res.headers.get("location")!)
    expect(location.pathname).toBe("/login")
    expect(location.searchParams.get("next")).toBe("/analysis?day=2026-08-28")
  })

  it("sends the browser to a path, never to another origin", () => {
    const location = new URL(proxy(req("/config")).headers.get("location")!)
    expect(location.origin).toBe("https://sprinklerfun.test")
  })
})

describe("matcher", () => {
  // Anchored, because Next matches a matcher against the WHOLE path. An
  // unanchored RegExp matches anywhere, which makes "/_next/static/chunk.js"
  // look included — it matches from its second slash — and would have had this
  // test disagreeing with the thing it is testing.
  const matches = (path: string) => new RegExp(`^${config.matcher[0]}$`).test(path)

  it("covers the app and the API", () => {
    for (const path of ["/", "/config", "/analysis", "/day/2026-08-28", "/api/rows", "/api/rollup"]) {
      expect(matches(path), path).toBe(true)
    }
  })

  it("excludes the whole OAuth flow, the sign-in page and the health probe", () => {
    // The callback in particular MUST be anonymous: it is where Google sends
    // the browser back, and nobody holds a session yet at that moment. Guarding
    // it would bounce every sign-in attempt to the page it just came from.
    for (const path of ["/login", "/api/auth/login", "/api/auth/callback", "/api/auth/logout", "/api/health"]) {
      expect(matches(path), path).toBe(false)
    }
  })

  it("no longer excludes the retired password endpoint", () => {
    // /api/login is gone; if something re-adds it, it must be guarded like any
    // other route rather than inheriting the old hole.
    expect(matches("/api/login")).toBe(true)
  })

  it("excludes Next's static output", () => {
    for (const path of ["/_next/static/chunk.js", "/_next/image", "/favicon.ico"]) {
      expect(matches(path), path).toBe(false)
    }
  })
})
