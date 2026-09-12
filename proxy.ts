import { NextResponse, type NextRequest } from "next/server"
import { COOKIE, authMode, tokenIsValid } from "@/lib/server/session"

// ---------------------------------------------------------------------------
// The request guard.
//
// `proxy.ts`, not `middleware.ts`: Next 16 renamed the convention and deprecated
// the old name. It always runs on the Node.js runtime — exporting `runtime` from
// this file throws — which is what lets it use node:crypto through
// lib/server/session.
//
// This is the whole of the app's access control. Every page and every API route
// is behind it except the four exclusions in the matcher below, so a new route
// is protected by default rather than by remembering to protect it. The repo has
// no Server Functions ("use server"), which would otherwise need their own check
// — they are POSTs to the page's own path and a matcher that skips that path
// would skip them too.
// ---------------------------------------------------------------------------

export function proxy(req: NextRequest) {
  const mode = authMode()
  if (mode === "open") return NextResponse.next()

  const isApi = req.nextUrl.pathname.startsWith("/api/")

  // A deployment with no APP_PASSWORD serves nothing. The alternative — falling
  // back to open — is how the previous guard turned a lost env var into an
  // anonymously writable database with no symptom at all.
  if (mode === "refuse") {
    console.error("[proxy] APP_PASSWORD is not set on this deployment — refusing every request")
    return isApi
      ? Response.json({ error: "APP_PASSWORD is not set on this deployment" }, { status: 503 })
      : new Response("APP_PASSWORD is not set on this deployment.", {
          status: 503,
          headers: { "content-type": "text/plain; charset=utf-8" },
        })
  }

  if (tokenIsValid(req.cookies.get(COOKIE)?.value)) return NextResponse.next()

  // An expired or missing cookie should look different to a fetch than it does
  // to a person: JSON for the former (lib/backend.ts turns a 401 into a trip to
  // the login page), the login page itself for the latter.
  if (isApi) return Response.json({ error: "unauthorized" }, { status: 401 })

  const login = new URL("/login", req.nextUrl)
  login.searchParams.set("next", req.nextUrl.pathname + req.nextUrl.search)
  return NextResponse.redirect(login)
}

// Everything except Next's own static output, the login page and its route (the
// way in), and the health probe (the deploy check, which reveals only a row
// count and must answer before anyone can log in).
//
// Matchers must be static so they can be analysed at build time — no variables.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|login|api/login|api/health).*)"],
}
