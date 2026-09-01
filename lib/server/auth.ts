import { isDeployed } from "./env"

// ---------------------------------------------------------------------------
// Shared-secret check for the write API.
//
// This is OBFUSCATION, NOT AUTHENTICATION, and the distinction matters enough to
// say plainly. The browser has to send the header to use the app, so the value
// ships to the client as NEXT_PUBLIC_APP_SHARED_SECRET, which Next.js inlines
// into the JavaScript bundle at build time. Anyone who loads the public site can
// read it out of a static chunk and replay it. It stops a drive-by script that
// has not read the bundle. It stops nothing else. See SECURITY.md.
//
// It is kept anyway because it costs nothing and does raise the floor, and
// because it is the hook a real credential would plug into later.
// ---------------------------------------------------------------------------

export function isAuthorized(req: Request): boolean {
  const expected = process.env.APP_SHARED_SECRET

  if (!expected) {
    // Fail CLOSED in production. This used to `return true`, so a secret that was
    // unset, blank, or lost in an env migration made the database anonymously
    // writable with no symptom at all — nothing logged, nothing 500'd, the app
    // looked perfectly healthy. A missing secret is now a loud failure instead of
    // a silent opening.
    if (isDeployed()) {
      console.error("[auth] APP_SHARED_SECRET is not set — refusing writes")
      return false
    }
    return true // local dev and tests: zero-config
  }

  return req.headers.get("x-sprinkler-secret") === expected
}
