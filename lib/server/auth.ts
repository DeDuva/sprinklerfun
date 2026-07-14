// ---------------------------------------------------------------------------
// Minimal single-user auth for the write API.
//
// This is a personal, single-house app — no user accounts. Writes are gated by
// a shared secret sent in the `x-sprinkler-secret` header and compared against
// APP_SHARED_SECRET. When the secret is unset (local dev), the guard is a no-op
// so the app works with zero configuration. In production, set the env var (and
// ideally also enable Vercel deployment protection) so the DB is never writable
// by anonymous callers.
// ---------------------------------------------------------------------------

export function isAuthorized(req: Request): boolean {
  const expected = process.env.APP_SHARED_SECRET
  if (!expected) return true // unconfigured (local dev) → allow
  return req.headers.get("x-sprinkler-secret") === expected
}
