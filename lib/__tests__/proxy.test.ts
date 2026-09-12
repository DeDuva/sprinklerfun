import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { proxy, config } from "../../proxy"
import { COOKIE, sessionToken } from "../server/session"

// proxy.ts is the entire access control for this app: every route is behind it
// except the handful the matcher excludes. These cover the decisions it makes,
// because the ones that matter are all invisible when wrong — a guard that lets
// everyone through looks exactly like a guard that works.

const saved = { ...process.env }

const req = (path: string, cookie?: string) =>
  new NextRequest(`https://sprinklerfun.test${path}`, {
    headers: cookie ? { cookie: `${COOKIE}=${cookie}` } : {},
  })

beforeEach(() => {
  delete process.env.APP_PASSWORD
  delete process.env.VERCEL
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  process.env = { ...saved }
  vi.restoreAllMocks()
})

describe("open mode (local dev, no password)", () => {
  it("lets everything through", () => {
    for (const path of ["/", "/config", "/api/rows", "/api/rollup"]) {
      expect(proxy(req(path))?.status, path).toBe(200)
    }
  })
})

describe("refuse mode (deployed with no password)", () => {
  beforeEach(() => {
    process.env.VERCEL = "1"
  })

  it("503s an API route", async () => {
    const res = proxy(req("/api/rollup"))!
    expect(res.status).toBe(503)
    expect((await res.json()).error).toMatch(/APP_PASSWORD/)
  })

  it("503s a page rather than redirecting to a login that cannot work", () => {
    expect(proxy(req("/")).status).toBe(503)
  })

  it("does not serve the app to someone holding an old cookie", () => {
    expect(proxy(req("/", "ab".repeat(32))).status).toBe(503)
  })
})

describe("enforced mode", () => {
  beforeEach(() => {
    process.env.APP_PASSWORD = "correct-horse"
  })

  it("passes a request carrying the right cookie", () => {
    expect(proxy(req("/api/rollup", sessionToken())).status).toBe(200)
  })

  it("401s an API request with no cookie, a wrong cookie, or a stale one", () => {
    expect(proxy(req("/api/rollup")).status).toBe(401)
    expect(proxy(req("/api/rollup", "ab".repeat(32))).status).toBe(401)

    const stale = sessionToken()
    process.env.APP_PASSWORD = "rotated"
    expect(proxy(req("/api/rollup", stale)).status).toBe(401)
  })

  it("redirects a page request to the login, remembering where it was going", () => {
    const res = proxy(req("/analysis?day=2026-08-28"))
    expect(res.status).toBe(307)
    const location = new URL(res.headers.get("location")!)
    expect(location.pathname).toBe("/login")
    expect(location.searchParams.get("next")).toBe("/analysis?day=2026-08-28")
  })

  it("sends the browser to a path, never to another origin", () => {
    // The `next` value is echoed into the login page, so it must stay a path.
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

  it("excludes the way in and the health probe", () => {
    // /api/health has to answer before anyone can log in — it is what the
    // post-deploy check and the runbook use.
    for (const path of ["/login", "/api/login", "/api/health"]) {
      expect(matches(path), path).toBe(false)
    }
  })

  it("excludes Next's static output", () => {
    for (const path of ["/_next/static/chunk.js", "/_next/image", "/favicon.ico"]) {
      expect(matches(path), path).toBe(false)
    }
  })
})
