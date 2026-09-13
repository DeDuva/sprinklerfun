import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { isDeployed } from "./env"

// ---------------------------------------------------------------------------
// Session and access control, backed by Google sign-in.
//
// This replaced a single shared password. The password was fine as far as it
// went, but it had no notion of *who*: one credential everyone shared, no way to
// remove one person, and no record of anything. Google owns identity now, and
// this module owns two much smaller questions — is this session real, and is
// that person still allowed in.
//
// No JWT library. What is needed here is a signed cookie, not a JWT: one
// audience (us), one issuer (us), no key rotation, no third party parsing it.
// `node:crypto` already does HMAC and constant-time comparison, so adding a
// dependency would buy a spec we do not use and a supply-chain edge we do not
// need. The format is deliberately boring: base64url(JSON) "." hex-HMAC.
//
// The password version derived the cookie from the password itself, so rotating
// the password logged everyone out. There is no such lever here, and that is
// why `sessionEmail()` re-checks the allow-list on EVERY request rather than
// trusting what the cookie said at sign-in: removing an address from
// ALLOWED_EMAILS revokes that person on their next request, not in seven days.
// ---------------------------------------------------------------------------

export const COOKIE = "sf_session"

// Short-lived cookies that carry the OAuth handshake across the redirect to
// Google and back. They exist only between /api/auth/login and the callback.
export const STATE_COOKIE = "sf_oauth_state"
export const VERIFIER_COOKIE = "sf_oauth_verifier"
export const NEXT_COOKIE = "sf_oauth_next"

const MAX_AGE = 60 * 60 * 24 * 7 // 7 days
const HANDSHAKE_MAX_AGE = 60 * 10 // 10 minutes is plenty to click "allow"

function secret(): string | undefined {
  return process.env.SESSION_SECRET || undefined
}

/** Is this deployment wired up to Google at all? */
export function googleConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && secret()
  )
}

/**
 * How the guard should behave here.
 *
 * - `enforced` — Google is configured: require a valid session for everything.
 * - `open`     — not configured and NOT a deployment: local dev and the E2E
 *                suite, which cannot drive a Google consent screen.
 * - `refuse`   — not configured ON a deployment: refuse every request.
 *
 * The third case is the one that matters. It keys off `isDeployed()` (the
 * VERCEL env var) rather than NODE_ENV, because `next start` sets NODE_ENV to
 * production for a local build too — which is exactly how the E2E suite runs.
 *
 * The failure being encoded: the guard this replaced twice returned "allowed"
 * when its secret was missing, which left the database anonymously writable
 * with nothing logged, nothing 500ing, and the app looking perfectly healthy.
 * "Open" must never be reachable on a deployment, whatever else is misconfigured.
 */
export function authMode(): "open" | "enforced" | "refuse" {
  if (googleConfigured()) return "enforced"
  return isDeployed() ? "refuse" : "open"
}

// ---------------------------------------------------------------------------
// The allow-list
// ---------------------------------------------------------------------------

/**
 * Addresses permitted to sign in, from ALLOWED_EMAILS (comma-separated).
 *
 * It lives in the environment rather than a committed file because this
 * repository is public, and a checked-in list of household email addresses is
 * published permanently, including in history.
 */
export function allowedEmails(): string[] {
  return (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
}

/**
 * Is this address allowed in?
 *
 * An empty list denies everyone. That is deliberate: the alternative reading —
 * "no list configured, so let everyone in" — is the same fail-open shape that
 * has already bitten this app once, and it would hand the database to anyone
 * with a Google account the moment a variable went missing.
 */
export function isAllowed(email: string | null | undefined): boolean {
  if (!email) return false
  const list = allowedEmails()
  if (list.length === 0) return false
  return list.includes(email.trim().toLowerCase())
}

// ---------------------------------------------------------------------------
// The session cookie
// ---------------------------------------------------------------------------

export interface SessionPayload {
  email: string
  /** Unix seconds. */
  exp: number
}

const signature = (body: string): Buffer =>
  createHmac("sha256", secret()!).update(body).digest()

const safeEqual = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b)

/** Mint a session cookie value for an address that has already been checked. */
export function issueSession(email: string, nowMs: number = Date.now()): string {
  if (!secret()) throw new Error("issueSession() called with no SESSION_SECRET set")
  const payload: SessionPayload = {
    email: email.trim().toLowerCase(),
    exp: Math.floor(nowMs / 1000) + MAX_AGE,
  }
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${body}.${signature(body).toString("hex")}`
}

/**
 * Verify the signature and the expiry. Says nothing about the allow-list —
 * `sessionEmail()` is the function the guard should call.
 */
export function readSession(
  token: string | undefined,
  nowMs: number = Date.now()
): SessionPayload | null {
  if (!token || !secret()) return null

  const dot = token.lastIndexOf(".")
  if (dot <= 0 || dot === token.length - 1) return null
  const body = token.slice(0, dot)
  const provided = Buffer.from(token.slice(dot + 1), "hex")

  // Signature first, always: nothing inside the payload is trusted — not even
  // enough to parse — until it has been shown to be ours.
  if (!safeEqual(provided, signature(body))) return null

  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"))
  } catch {
    return null
  }
  const p = payload as SessionPayload
  if (typeof p?.email !== "string" || typeof p?.exp !== "number") return null
  if (!Number.isFinite(p.exp) || p.exp * 1000 <= nowMs) return null
  return p
}

/**
 * The whole check the guard makes: a real, unexpired session belonging to
 * someone who is STILL on the allow-list.
 *
 * The allow-list is re-read here on every request on purpose. Checking it only
 * at sign-in — which is what the app this was modelled on does — means removing
 * someone does nothing until their cookie expires a week later. Revocation
 * should not be something you wait out.
 */
export function sessionEmail(
  token: string | undefined,
  nowMs: number = Date.now()
): string | null {
  const payload = readSession(token, nowMs)
  if (!payload) return null
  return isAllowed(payload.email) ? payload.email : null
}

export function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: MAX_AGE,
    // Secure follows isDeployed(): local dev and the E2E suite serve plain
    // http, where a Secure cookie is dropped silently and the login appears to
    // succeed while never sticking.
    secure: isDeployed(),
  }
}

/** Flags for the handshake cookies: same shape, far shorter life. */
export function handshakeCookieOptions() {
  return { ...cookieOptions(), maxAge: HANDSHAKE_MAX_AGE }
}

/** Flags that expire a cookie immediately. */
export function clearedCookieOptions() {
  return { ...cookieOptions(), maxAge: 0 }
}

// ---------------------------------------------------------------------------
// CSRF state and PKCE
// ---------------------------------------------------------------------------

/**
 * An opaque value echoed by Google and compared against a cookie we set.
 *
 * Without it the callback accepts any code anyone sends it, which lets an
 * attacker complete the flow in a victim's browser and leave them logged in as
 * someone else — quietly, since the victim really did just visit the site.
 */
export function newState(): string {
  return randomBytes(16).toString("hex")
}

/** PKCE verifier: high-entropy, kept in an httpOnly cookie, never sent to Google. */
export function newVerifier(): string {
  return randomBytes(32).toString("base64url")
}

/** PKCE challenge: the S256 hash of the verifier, which IS sent to Google. */
export function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url")
}

/** Constant-time compare for the state echo. */
export function stateMatches(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  return safeEqual(Buffer.from(a), Buffer.from(b))
}

/**
 * Where to go after signing in. Only a path within this app is allowed: without
 * the check, `/login?next=//somewhere.else` turns the sign-in into an open
 * redirect, and one that looks trustworthy precisely because the victim really
 * did just authenticate.
 */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/"
  return raw
}
