import { cookies } from "next/headers"
import { COOKIE, clearedCookieOptions } from "@/lib/server/session"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// DELETE /api/auth/logout — end the session.
//
// Expiring the cookie is the whole of it: sessions are not stored server-side,
// so there is nothing to invalidate. Note what this does NOT do — it does not
// sign the person out of Google, deliberately. Logging out of this app should
// not log someone out of their mail.
//
// The way to revoke someone who should no longer have access at all is to take
// their address out of ALLOWED_EMAILS; that is re-checked on every request, so
// it takes effect on their next click rather than when their cookie expires.
export async function DELETE() {
  const jar = await cookies()
  jar.set(COOKIE, "", clearedCookieOptions())
  return Response.json({ ok: true })
}
