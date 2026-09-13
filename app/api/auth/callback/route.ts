import { NextResponse, type NextRequest } from "next/server"
import {
  COOKIE,
  STATE_COOKIE,
  VERIFIER_COOKIE,
  NEXT_COOKIE,
  authMode,
  clearedCookieOptions,
  cookieOptions,
  isAllowed,
  issueSession,
  safeNext,
  stateMatches,
} from "@/lib/server/session"
import { exchangeCodeForUser } from "@/lib/server/google"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// GET /api/auth/callback — where Google sends the browser back.
//
// Every failure lands on /login?error=<code> with a generic code. The person at
// the keyboard cannot act on "token exchange failed" vs "not on the list", and
// an attacker probing which addresses are permitted would very much like to
// know the difference. The specific reason is logged server-side instead.
function fail(req: NextRequest, code: string) {
  const url = new URL("/login", req.nextUrl.origin)
  url.searchParams.set("error", code)
  const res = NextResponse.redirect(url)
  // The handshake is over either way; do not leave its cookies lying around to
  // be replayed against a later attempt.
  res.cookies.set(STATE_COOKIE, "", clearedCookieOptions())
  res.cookies.set(VERIFIER_COOKIE, "", clearedCookieOptions())
  res.cookies.set(NEXT_COOKIE, "", clearedCookieOptions())
  return res
}

export async function GET(req: NextRequest) {
  const mode = authMode()
  if (mode === "refuse") {
    return new Response("Google sign-in is not configured on this deployment.", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    })
  }
  if (mode === "open") {
    return NextResponse.redirect(new URL("/", req.nextUrl.origin))
  }

  // Google reports user-facing refusals (someone clicking "cancel") in the URL.
  if (req.nextUrl.searchParams.get("error")) return fail(req, "cancelled")

  const code = req.nextUrl.searchParams.get("code")
  const state = req.nextUrl.searchParams.get("state")
  const expectedState = req.cookies.get(STATE_COOKIE)?.value
  const verifier = req.cookies.get(VERIFIER_COOKIE)?.value

  if (!code || !verifier) return fail(req, "handshake_expired")

  // The CSRF check. Without it this endpoint accepts any code anyone sends it,
  // which lets an attacker complete the flow inside a victim's browser and
  // leave them signed in as someone else — silently, because the victim really
  // did just arrive from Google.
  if (!stateMatches(state ?? undefined, expectedState)) return fail(req, "bad_state")

  let user
  try {
    user = await exchangeCodeForUser({ code, verifier, origin: req.nextUrl.origin })
  } catch (err) {
    console.error("[auth/callback] exchange failed:", err)
    return fail(req, "exchange_failed")
  }

  // An unverified Google account can carry an address its owner never proved
  // they control, so matching it against the allow-list would let someone in by
  // simply claiming a name.
  if (!user.emailVerified) {
    console.error(`[auth/callback] refused unverified address: ${user.email}`)
    return fail(req, "unauthorized")
  }

  if (!isAllowed(user.email)) {
    console.error(`[auth/callback] refused address not on the allow-list: ${user.email}`)
    return fail(req, "unauthorized")
  }

  const next = safeNext(req.cookies.get(NEXT_COOKIE)?.value)
  const res = NextResponse.redirect(new URL(next, req.nextUrl.origin))
  res.cookies.set(COOKIE, issueSession(user.email), cookieOptions())
  res.cookies.set(STATE_COOKIE, "", clearedCookieOptions())
  res.cookies.set(VERIFIER_COOKIE, "", clearedCookieOptions())
  res.cookies.set(NEXT_COOKIE, "", clearedCookieOptions())
  return res
}
