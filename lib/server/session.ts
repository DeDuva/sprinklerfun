import { createHmac, timingSafeEqual } from "node:crypto"
import { isDeployed } from "./env"

// ---------------------------------------------------------------------------
// Single-user session, derived from one password.
//
// This replaces the shared header that used to guard writes. That header was
// obfuscation and said so: the browser had to send it, so it shipped as
// NEXT_PUBLIC_APP_SHARED_SECRET and Next inlined it into a static chunk that
// anyone could read. The password here never reaches the client — only an HMAC
// of a fixed string under it, stored in an httpOnly cookie the browser cannot
// read from JavaScript either.
//
// There is no session table and no user model, because there is one household.
// The consequence worth knowing: the cookie's value is a pure function of the
// password, so changing APP_PASSWORD invalidates every existing session — that
// IS the logout-everywhere mechanism — and conversely a stolen cookie stays
// valid until the password changes. For a single-home app behind one password,
// that trade is deliberate.
// ---------------------------------------------------------------------------

export const COOKIE = "sf_session"

const MAX_AGE = 60 * 60 * 24 * 30 // 30 days

/**
 * How the guard should behave here.
 *
 * - `enforced` — APP_PASSWORD is set: require a valid cookie.
 * - `open`     — no password, not a deployment: local dev and tests, zero setup.
 * - `refuse`   — no password ON a deployment: refuse everything.
 *
 * The third case is the fail-closed one, and it keys off VERCEL rather than
 * NODE_ENV for the same reason lib/server/env.ts exists: `next start` sets
 * NODE_ENV=production for a local production build too, which would make the
 * E2E suite and `npm start` demand a password that local use has no need for.
 */
export function authMode(): "open" | "enforced" | "refuse" {
  if (process.env.APP_PASSWORD) return "enforced"
  return isDeployed() ? "refuse" : "open"
}

const hmac = (key: string, msg: string) => createHmac("sha256", key).update(msg).digest()

// timingSafeEqual throws on a length mismatch, so guard it. Both callers below
// compare fixed-length digests, which makes the length check a formality rather
// than the thing that decides the answer.
const safeEqual = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b)

/** The cookie value for the current password. */
export function sessionToken(): string {
  const password = process.env.APP_PASSWORD
  if (!password) throw new Error("sessionToken() called with no APP_PASSWORD set")
  return hmac(password, "sprinklerfun-session-v1").toString("hex")
}

/**
 * Is this the configured password?
 *
 * Both sides are hashed under a fixed key before comparison so the comparison
 * is over equal-length digests — a direct `===` on the raw strings would return
 * early on the first differing character and leak length and prefix through
 * timing.
 */
export function passwordMatches(candidate: string): boolean {
  const expected = process.env.APP_PASSWORD
  // Without this, an unset password made `passwordMatches("")` true — both sides
  // hashed the empty string. Nothing reaches it in that state today (the login
  // route checks authMode first), but "returns true when unconfigured" is the
  // exact shape of the bug this whole change exists to remove.
  if (!expected) return false
  return safeEqual(hmac("compare", candidate), hmac("compare", expected))
}

/** Is this cookie value the one the current password produces? */
export function tokenIsValid(token: string | undefined): boolean {
  if (!token || !process.env.APP_PASSWORD) return false
  // Buffer.from(…, "hex") stops at the first non-hex character rather than
  // throwing, so a malformed cookie simply yields a short buffer and fails the
  // length check below.
  return safeEqual(Buffer.from(token, "hex"), Buffer.from(sessionToken(), "hex"))
}

/**
 * Cookie flags. `secure` follows isDeployed() because the E2E suite and local
 * dev serve plain http, where a Secure cookie would be dropped silently and the
 * login would appear to succeed while never sticking.
 */
export function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: MAX_AGE,
    secure: isDeployed(),
  }
}
