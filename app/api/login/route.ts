import { cookies } from "next/headers"
import { COOKIE, authMode, cookieOptions, passwordMatches, sessionToken } from "@/lib/server/session"

// Reached before the guard: proxy.ts excludes this path, because it is the way
// in. No `runtime` or `dynamic` export — nodejs is the default, and a handler
// that reads or writes cookies is dynamic by definition.

// POST /api/login — body { password }. Sets the session cookie on a match.
export async function POST(req: Request) {
  const mode = authMode()

  // Local dev and tests run with no password. Report that plainly instead of
  // rejecting a login that cannot be performed, so the login page can say so.
  if (mode === "open") return Response.json({ ok: true, authMode: "open" })
  if (mode === "refuse") {
    return Response.json({ error: "APP_PASSWORD is not set on this deployment" }, { status: 503 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 })
  }

  const password = (body as { password?: unknown }).password
  if (typeof password !== "string" || !passwordMatches(password)) {
    // One message for "wrong password" and "no password field": a caller
    // learning which is which learns something about the form, not the secret,
    // but there is no reason to tell them either.
    return Response.json({ error: "wrong password" }, { status: 401 })
  }

  const jar = await cookies()
  jar.set(COOKIE, sessionToken(), cookieOptions())
  return Response.json({ ok: true })
}

// DELETE /api/login — log out. Expiring the cookie is all there is to undo,
// since the session is not stored anywhere on the server.
export async function DELETE() {
  const jar = await cookies()
  jar.set(COOKIE, "", { ...cookieOptions(), maxAge: 0 })
  return Response.json({ ok: true })
}
