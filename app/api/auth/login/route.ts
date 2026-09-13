import { NextResponse, type NextRequest } from "next/server"
import {
  STATE_COOKIE,
  VERIFIER_COOKIE,
  NEXT_COOKIE,
  authMode,
  handshakeCookieOptions,
  newState,
  newVerifier,
  safeNext,
} from "@/lib/server/session"
import { authorizationUrl } from "@/lib/server/google"

// Reached before the guard: proxy.ts excludes /api/auth, because this is the
// way in. libSQL is not involved, but node:crypto is, so Node runtime.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// GET /api/auth/login — start the Google flow.
//
// A GET that mutates nothing except two short-lived cookies, so it can be a
// plain link on the sign-in page. The CSRF concern people usually raise about
// GET does not apply to *starting* a flow; it applies to the callback, which is
// exactly what the `state` cookie set here defends.
export async function GET(req: NextRequest) {
  const mode = authMode()
  const next = safeNext(req.nextUrl.searchParams.get("next"))

  if (mode === "refuse") {
    return new Response("Google sign-in is not configured on this deployment.", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    })
  }

  // Local dev and the E2E suite run with no Google credentials. There is
  // nothing to sign in to, and the guard is letting everything through anyway,
  // so send the visitor where they were going rather than to a consent screen
  // that cannot exist.
  if (mode === "open") {
    return NextResponse.redirect(new URL(next, req.nextUrl.origin))
  }

  const state = newState()
  const verifier = newVerifier()

  const res = NextResponse.redirect(
    authorizationUrl({ origin: req.nextUrl.origin, state, verifier })
  )

  // Both halves of the handshake live in httpOnly cookies: the state so the
  // callback can prove this browser started the flow, and the PKCE verifier so
  // an intercepted authorization code is useless without it. Neither is ever
  // exposed to JavaScript, and both expire in minutes.
  res.cookies.set(STATE_COOKIE, state, handshakeCookieOptions())
  res.cookies.set(VERIFIER_COOKIE, verifier, handshakeCookieOptions())
  res.cookies.set(NEXT_COOKIE, next, handshakeCookieOptions())
  return res
}
