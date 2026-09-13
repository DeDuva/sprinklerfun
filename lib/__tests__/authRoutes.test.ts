import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest, type NextResponse } from "next/server"
import {
  COOKIE,
  STATE_COOKIE,
  VERIFIER_COOKIE,
  NEXT_COOKIE,
  readSession,
} from "../server/session"

// Keep authorizationUrl real — it is worth asserting that the redirect really
// does carry state and PKCE — and replace only the network call.
vi.mock("@/lib/server/google", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/google")>()
  return { ...actual, exchangeCodeForUser: vi.fn() }
})

const { exchangeCodeForUser } = await import("@/lib/server/google")
const exchange = vi.mocked(exchangeCodeForUser)

const { GET: login } = await import("@/app/api/auth/login/route")
const { GET: callback } = await import("@/app/api/auth/callback/route")

// The sign-in endpoints are the only routes reachable without a session, which
// makes them the ones worth being thorough about: everything else is behind the
// guard, and these are the guard's front door.

const saved = { ...process.env }

function configureGoogle() {
  process.env.GOOGLE_CLIENT_ID = "client-id"
  process.env.GOOGLE_CLIENT_SECRET = "client-secret"
  process.env.SESSION_SECRET = "a-long-random-signing-secret"
  process.env.ALLOWED_EMAILS = "someone@gmail.com"
}

const req = (path: string, cookies?: Record<string, string>) =>
  new NextRequest(`https://sprinklerfun.test${path}`, {
    headers: cookies
      ? { cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ") }
      : {},
  })

/**
 * The handlers' return type widens to plain `Response` because their 503 branch
 * returns one, and only `NextResponse` carries a `cookies` accessor. Every
 * branch these tests inspect cookies on is a redirect, which is a NextResponse.
 */
const cookiesOf = (res: Response) => (res as NextResponse).cookies

beforeEach(() => {
  delete process.env.GOOGLE_CLIENT_ID
  delete process.env.GOOGLE_CLIENT_SECRET
  delete process.env.SESSION_SECRET
  delete process.env.ALLOWED_EMAILS
  delete process.env.VERCEL
  exchange.mockReset()
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  process.env = { ...saved }
  vi.restoreAllMocks()
})

describe("GET /api/auth/login", () => {
  it("503s on a deployment with no credentials", async () => {
    process.env.VERCEL = "1"
    expect((await login(req("/api/auth/login"))).status).toBe(503)
  })

  it("just goes where you were going in open mode — there is nothing to sign in to", async () => {
    const res = await login(req("/api/auth/login?next=%2Fconfig"))
    expect(res.status).toBe(307)
    expect(new URL(res.headers.get("location")!).pathname).toBe("/config")
  })

  it("redirects to Google and stashes state, verifier and next", async () => {
    configureGoogle()
    const res = await login(req("/api/auth/login?next=%2Fanalysis"))
    expect(res.status).toBe(307)

    const target = new URL(res.headers.get("location")!)
    expect(target.origin).toBe("https://accounts.google.com")
    expect(target.searchParams.get("state")).toBeTruthy()
    expect(target.searchParams.get("code_challenge")).toBeTruthy()

    // The state that went to Google must be the one we can check on return.
    expect(cookiesOf(res).get(STATE_COOKIE)?.value).toBe(target.searchParams.get("state"))
    expect(cookiesOf(res).get(VERIFIER_COOKIE)?.value).toBeTruthy()
    expect(cookiesOf(res).get(NEXT_COOKIE)?.value).toBe("/analysis")

    // The verifier is the half Google must never see.
    expect(target.toString()).not.toContain(cookiesOf(res).get(VERIFIER_COOKIE)!.value)
  })

  it("refuses to remember an off-site destination", async () => {
    configureGoogle()
    const res = await login(req("/api/auth/login?next=%2F%2Fevil.test"))
    expect(cookiesOf(res).get(NEXT_COOKIE)?.value).toBe("/")
  })
})

describe("GET /api/auth/callback", () => {
  const errorCode = (res: Response) =>
    new URL(res.headers.get("location")!).searchParams.get("error")

  it("503s on a deployment with no credentials", async () => {
    process.env.VERCEL = "1"
    expect((await callback(req("/api/auth/callback"))).status).toBe(503)
  })

  it("refuses a code when no flow was started in this browser", async () => {
    // No state cookie: the CSRF check must reject rather than exchange whatever
    // code an attacker supplies. Without this, someone can complete sign-in
    // inside a victim's browser and leave them authenticated as someone else.
    configureGoogle()
    const res = await callback(req("/api/auth/callback?code=stolen&state=made-up"))
    expect(errorCode(res)).toBe("handshake_expired")
    expect(exchange).not.toHaveBeenCalled()
  })

  it("refuses a mismatched state even when the handshake cookies exist", async () => {
    configureGoogle()
    const res = await callback(
      req("/api/auth/callback?code=c&state=not-the-one", {
        [STATE_COOKIE]: "the-real-state",
        [VERIFIER_COOKIE]: "v",
      })
    )
    expect(errorCode(res)).toBe("bad_state")
    expect(exchange).not.toHaveBeenCalled()
  })

  it("passes through a refusal at Google", async () => {
    configureGoogle()
    const res = await callback(req("/api/auth/callback?error=access_denied"))
    expect(errorCode(res)).toBe("cancelled")
  })

  it("reports an exchange failure without saying why", async () => {
    configureGoogle()
    exchange.mockRejectedValueOnce(new Error("token exchange failed: HTTP 400"))
    const res = await callback(
      req("/api/auth/callback?code=c&state=s", { [STATE_COOKIE]: "s", [VERIFIER_COOKIE]: "v" })
    )
    expect(errorCode(res)).toBe("exchange_failed")
  })

  it("refuses an unverified Google address", async () => {
    // Otherwise someone can be admitted by claiming an allow-listed address on
    // an account they never proved they own.
    configureGoogle()
    exchange.mockResolvedValueOnce({ email: "someone@gmail.com", emailVerified: false })
    const res = await callback(
      req("/api/auth/callback?code=c&state=s", { [STATE_COOKIE]: "s", [VERIFIER_COOKIE]: "v" })
    )
    expect(errorCode(res)).toBe("unauthorized")
    expect(cookiesOf(res).get(COOKIE)?.value).toBeFalsy()
  })

  it("refuses an address that is not on the allow-list", async () => {
    configureGoogle()
    exchange.mockResolvedValueOnce({ email: "stranger@gmail.com", emailVerified: true })
    const res = await callback(
      req("/api/auth/callback?code=c&state=s", { [STATE_COOKIE]: "s", [VERIFIER_COOKIE]: "v" })
    )
    expect(errorCode(res)).toBe("unauthorized")
    expect(cookiesOf(res).get(COOKIE)?.value).toBeFalsy()
  })

  it("uses the same opaque code for 'not allowed' as for a broken exchange", async () => {
    // The difference is useful only to someone probing which addresses are
    // permitted; the specific reason goes to the server log instead.
    configureGoogle()
    exchange.mockResolvedValueOnce({ email: "stranger@gmail.com", emailVerified: true })
    const refused = errorCode(
      await callback(
        req("/api/auth/callback?code=c&state=s", { [STATE_COOKIE]: "s", [VERIFIER_COOKIE]: "v" })
      )
    )
    exchange.mockResolvedValueOnce({ email: "someone@gmail.com", emailVerified: false })
    const unverified = errorCode(
      await callback(
        req("/api/auth/callback?code=c&state=s", { [STATE_COOKIE]: "s", [VERIFIER_COOKIE]: "v" })
      )
    )
    expect(refused).toBe(unverified)
  })

  it("signs an allow-listed visitor in and sends them where they were going", async () => {
    configureGoogle()
    exchange.mockResolvedValueOnce({ email: "someone@gmail.com", emailVerified: true })
    const res = await callback(
      req("/api/auth/callback?code=c&state=s", {
        [STATE_COOKIE]: "s",
        [VERIFIER_COOKIE]: "v",
        [NEXT_COOKIE]: "/analysis",
      })
    )

    expect(res.status).toBe(307)
    expect(new URL(res.headers.get("location")!).pathname).toBe("/analysis")

    const session = cookiesOf(res).get(COOKIE)?.value
    expect(readSession(session)?.email).toBe("someone@gmail.com")

    // The handshake is over; its cookies must not linger to be replayed.
    expect(cookiesOf(res).get(STATE_COOKIE)?.value).toBe("")
    expect(cookiesOf(res).get(VERIFIER_COOKIE)?.value).toBe("")
  })

  it("will not be talked into redirecting off-site after sign-in", async () => {
    configureGoogle()
    exchange.mockResolvedValueOnce({ email: "someone@gmail.com", emailVerified: true })
    const res = await callback(
      req("/api/auth/callback?code=c&state=s", {
        [STATE_COOKIE]: "s",
        [VERIFIER_COOKIE]: "v",
        [NEXT_COOKIE]: "//evil.test",
      })
    )
    const location = new URL(res.headers.get("location")!)
    expect(location.origin).toBe("https://sprinklerfun.test")
    expect(location.pathname).toBe("/")
  })
})
