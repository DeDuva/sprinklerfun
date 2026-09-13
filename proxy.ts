import { NextResponse, type NextRequest } from "next/server"
import { COOKIE, authMode, sessionEmail } from "@/lib/server/session"

// ---------------------------------------------------------------------------
// The request guard.
//
// `proxy.ts`, not `middleware.ts`: Next 16 renamed the convention and deprecated
// the old name. It always runs on the Node.js runtime — exporting `runtime` from
// this file throws — which is what lets it use node:crypto through
// lib/server/session.
//
// This is the whole of the app's access control. Every page and every API route
// is behind it except the exclusions in the matcher below, so a new route is
// protected by default rather than by remembering to protect it. The repo has
// no Server Functions ("use server"), which would otherwise need their own check
// — they are POSTs to the page's own path and a matcher that skips that path
// would skip them too.
// ---------------------------------------------------------------------------

export function proxy(req: NextRequest) {
  const mode = authMode()
  if (mode === "open") return NextResponse.next()

  const isApi = req.nextUrl.pathname.startsWith("/api/")

  // A deployment with no Google credentials serves nothing. The alternative —
  // falling back to open — is how a lost env var turns into an anonymously
  // writable database with no symptom at all.
  if (mode === "refuse") {
    console.error("[proxy] Google sign-in is not configured — refusing every request")
    return isApi
      ? Response.json({ error: "Google sign-in is not configured on this deployment" }, { status: 503 })
      : new Response("Google sign-in is not configured on this deployment.", {
          status: 503,
          headers: { "content-type": "text/plain; charset=utf-8" },
        })
  }

  // sessionEmail() checks the signature, the expiry, AND the allow-list. The
  // last one is why removing an address revokes access on the next request
  // rather than whenever that person's cookie happens to run out.
  if (sessionEmail(req.cookies.get(COOKIE)?.value)) return NextResponse.next()

  // An expired session should look different to a fetch than it does to a
  // person: JSON for the former (lib/backend.ts turns a 401 into a trip to the
  // sign-in page), the sign-in page itself for the latter.
  if (isApi) return Response.json({ error: "unauthorized" }, { status: 401 })

  const login = new URL("/login", req.nextUrl)
  login.searchParams.set("next", req.nextUrl.pathname + req.nextUrl.search)
  return NextResponse.redirect(login)
}

// Everything except Next's own static output, the sign-in page, the OAuth
// endpoints (the way in — the callback in particular MUST be reachable
// anonymously, or Google's redirect back would be bounced by this guard), the
// health probe (the deploy check, which reveals only a row count and has to
// answer before anyone can sign in), and the cron path.
//
// /api/cron is excluded because Vercel invokes cron jobs with a plain GET
// carrying no session — this guard would turn every scheduled run into a 401.
// It is not unguarded: it requires CRON_SECRET as a bearer token and fails
// closed when that is unset. See app/api/cron/route.ts.
//
// Matchers must be static so they can be analysed at build time — no variables.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|login|api/auth|api/health|api/cron).*)"],
}
