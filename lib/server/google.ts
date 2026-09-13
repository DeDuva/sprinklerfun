import { challengeFor } from "./session"

// ---------------------------------------------------------------------------
// The Google half of the sign-in flow.
//
// A hand-rolled authorization-code exchange with PKCE. There is no provider SDK
// here for the same reason there is no JWT library: three HTTPS calls against a
// stable, well-documented API is less code than configuring a framework around
// it, and it keeps the dependency surface of an app that guards a household's
// water meter at zero new packages.
//
// Everything in this file is a pure function of its inputs plus two env vars,
// so it is testable without a network.
// ---------------------------------------------------------------------------

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
const USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v3/userinfo"

/** The redirect URI Google sends the browser back to. Must match the console exactly. */
export function redirectUri(origin: string): string {
  return new URL("/api/auth/callback", origin).toString()
}

/** The consent URL to send the browser to. */
export function authorizationUrl(opts: {
  origin: string
  state: string
  verifier: string
}): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri(opts.origin),
    response_type: "code",
    scope: "openid email profile",
    // Online access only: we want to know who someone is once, not to act on
    // their behalf later. Asking for a refresh token we would never use is a
    // permission we would have to store and protect for no benefit.
    access_type: "online",
    // Always show the chooser. A household shares devices, and silently
    // reusing whichever Google account happens to be signed in is how the wrong
    // person ends up logged in without noticing.
    prompt: "select_account",
    state: opts.state,
    code_challenge: challengeFor(opts.verifier),
    code_challenge_method: "S256",
  })
  return `${AUTH_ENDPOINT}?${params}`
}

export interface GoogleUser {
  email: string
  emailVerified: boolean
  name?: string
}

/**
 * Exchange the authorization code for an access token, then resolve the user.
 *
 * Throws on any failure, with a message safe to log but never shown to the
 * browser — the callback maps failures to an opaque `?error=` code, because the
 * difference between "bad code" and "not allowed" is information the person at
 * the keyboard does not need and an attacker would like.
 */
export async function exchangeCodeForUser(opts: {
  code: string
  verifier: string
  origin: string
}): Promise<GoogleUser> {
  const tokenRes = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: opts.code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: redirectUri(opts.origin),
      grant_type: "authorization_code",
      code_verifier: opts.verifier,
    }),
  })
  if (!tokenRes.ok) {
    throw new Error(`token exchange failed: HTTP ${tokenRes.status}`)
  }
  const token = (await tokenRes.json()) as { access_token?: string }
  if (!token.access_token) throw new Error("token exchange returned no access_token")

  const userRes = await fetch(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  })
  if (!userRes.ok) throw new Error(`userinfo failed: HTTP ${userRes.status}`)

  const user = (await userRes.json()) as {
    email?: string
    email_verified?: boolean
    name?: string
  }
  if (!user.email) throw new Error("userinfo returned no email")

  return {
    email: user.email.trim().toLowerCase(),
    // Checked by the caller, not ignored. An unverified Google account can
    // carry an address its owner never proved they control, so matching it
    // against the allow-list would let someone in by claiming a name.
    emailVerified: user.email_verified === true,
    name: user.name,
  }
}
