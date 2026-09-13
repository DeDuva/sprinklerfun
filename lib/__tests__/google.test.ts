import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { authorizationUrl, redirectUri, exchangeCodeForUser } from "../server/google"
import { challengeFor } from "../server/session"

// The Google half of sign-in. Every branch here is a way the flow can go wrong
// in production and nowhere else — a bad token response, a userinfo call that
// returns something unexpected — so they are worth pinning even though the happy
// path is also covered end to end.

const saved = { ...process.env }

beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = "client-id.apps.googleusercontent.com"
  process.env.GOOGLE_CLIENT_SECRET = "client-secret"
})

afterEach(() => {
  process.env = { ...saved }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("redirectUri", () => {
  it("is the callback on the caller's own origin", () => {
    expect(redirectUri("https://sprinklerfun.vercel.app")).toBe(
      "https://sprinklerfun.vercel.app/api/auth/callback"
    )
  })
})

describe("authorizationUrl", () => {
  const build = () =>
    new URL(
      authorizationUrl({
        origin: "https://sprinklerfun.test",
        state: "the-state",
        verifier: "the-verifier",
      })
    )

  it("points at Google's consent endpoint", () => {
    const url = build()
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth")
  })

  it("carries the client id, redirect and an email scope", () => {
    const p = build().searchParams
    expect(p.get("client_id")).toBe("client-id.apps.googleusercontent.com")
    expect(p.get("redirect_uri")).toBe("https://sprinklerfun.test/api/auth/callback")
    expect(p.get("response_type")).toBe("code")
    expect(p.get("scope")).toContain("email")
  })

  it("sends the PKCE challenge, never the verifier", () => {
    const p = build().searchParams
    expect(p.get("code_challenge_method")).toBe("S256")
    expect(p.get("code_challenge")).toBe(challengeFor("the-verifier"))
    // The whole point of PKCE: the secret half stays on the server.
    expect(build().toString()).not.toContain("the-verifier")
  })

  it("carries the CSRF state", () => {
    expect(build().searchParams.get("state")).toBe("the-state")
  })

  it("asks for online access and always shows the account chooser", () => {
    const p = build().searchParams
    // No refresh token: we want to know who someone is once, not to act for
    // them later. A household shares devices, so silently reusing whichever
    // account is signed in is how the wrong person ends up logged in.
    expect(p.get("access_type")).toBe("online")
    expect(p.get("prompt")).toBe("select_account")
  })
})

describe("exchangeCodeForUser", () => {
  const call = () =>
    exchangeCodeForUser({
      code: "the-code",
      verifier: "the-verifier",
      origin: "https://sprinklerfun.test",
    })

  /** Queue responses for the two fetches: token, then userinfo. */
  function stubFetch(...responses: Array<{ ok: boolean; status?: number; body?: unknown }>) {
    const fetchMock = vi.fn()
    for (const r of responses) {
      fetchMock.mockResolvedValueOnce({
        ok: r.ok,
        status: r.status ?? (r.ok ? 200 : 500),
        json: async () => r.body,
      })
    }
    vi.stubGlobal("fetch", fetchMock)
    return fetchMock
  }

  it("returns the verified address, lower-cased", async () => {
    stubFetch(
      { ok: true, body: { access_token: "at" } },
      { ok: true, body: { email: "Someone@Gmail.com", email_verified: true, name: "Someone" } }
    )
    await expect(call()).resolves.toEqual({
      email: "someone@gmail.com",
      emailVerified: true,
      name: "Someone",
    })
  })

  it("sends the PKCE verifier in the token exchange", async () => {
    const fetchMock = stubFetch(
      { ok: true, body: { access_token: "at" } },
      { ok: true, body: { email: "a@b.test", email_verified: true } }
    )
    await call()
    const body = String(fetchMock.mock.calls[0][1].body)
    expect(body).toContain("code_verifier=the-verifier")
    expect(body).toContain("grant_type=authorization_code")
  })

  it("presents the access token to userinfo", async () => {
    const fetchMock = stubFetch(
      { ok: true, body: { access_token: "at" } },
      { ok: true, body: { email: "a@b.test", email_verified: true } }
    )
    await call()
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer at")
  })

  it("reports an unverified address as unverified rather than dropping it", async () => {
    // The caller refuses it; this function's job is only to say so truthfully.
    // The app this was modelled on declared this field and never read it.
    stubFetch(
      { ok: true, body: { access_token: "at" } },
      { ok: true, body: { email: "a@b.test", email_verified: false } }
    )
    await expect(call()).resolves.toMatchObject({ emailVerified: false })

    stubFetch(
      { ok: true, body: { access_token: "at" } },
      { ok: true, body: { email: "a@b.test" } } // absent entirely
    )
    await expect(call()).resolves.toMatchObject({ emailVerified: false })
  })

  it("throws when the token exchange fails", async () => {
    stubFetch({ ok: false, status: 400 })
    await expect(call()).rejects.toThrow(/token exchange failed: HTTP 400/)
  })

  it("throws when the token response carries no access token", async () => {
    stubFetch({ ok: true, body: {} })
    await expect(call()).rejects.toThrow(/no access_token/)
  })

  it("throws when userinfo fails", async () => {
    stubFetch({ ok: true, body: { access_token: "at" } }, { ok: false, status: 401 })
    await expect(call()).rejects.toThrow(/userinfo failed: HTTP 401/)
  })

  it("throws when userinfo returns no email", async () => {
    stubFetch(
      { ok: true, body: { access_token: "at" } },
      { ok: true, body: { email_verified: true } }
    )
    await expect(call()).rejects.toThrow(/no email/)
  })
})
