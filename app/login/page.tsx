"use client"

import { Suspense } from "react"
import { useSearchParams } from "next/navigation"
import Flo from "@/components/design/Flo"

/**
 * Where to go after signing in.
 *
 * Only a path within this app is allowed. `next` arrives in the URL, so without
 * this check a crafted link — `/login?next=//somewhere.else` — would turn the
 * sign-in into an open redirect, and one that looks trustworthy precisely
 * because the victim really did just authenticate. The server enforces the same
 * rule in lib/server/session.ts; this is the belt to that pair of braces.
 */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/"
  return raw
}

// Deliberately vague. "Not on the allow-list" and "Google rejected the code"
// are the same sentence to the person reading it, because the difference is
// only useful to someone probing which addresses are permitted. The specific
// reason is in the server logs.
const MESSAGES: Record<string, string> = {
  unauthorized: "That Google account is not allowed to use this app.",
  cancelled: "Sign-in was cancelled.",
  bad_state: "That sign-in attempt expired or did not start here. Please try again.",
  handshake_expired: "That sign-in attempt expired. Please try again.",
  exchange_failed: "Google could not complete the sign-in. Please try again.",
}

function LoginScreen() {
  const params = useSearchParams()
  const next = safeNext(params.get("next"))
  const errorCode = params.get("error")
  const error = errorCode ? (MESSAGES[errorCode] ?? MESSAGES.exchange_failed) : null

  const href = `/api/auth/login?next=${encodeURIComponent(next)}`

  return (
    <div className="min-h-[70vh] flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center text-center mb-6">
          <Flo size={72} mood="wave" idle />
          <h1
            className="text-2xl font-semibold text-[#143049] mt-3"
            style={{ fontFamily: "var(--font-fredoka)" }}
          >
            Sprinkler<span className="text-[#1B6FA8]">Fun</span>
          </h1>
          <p className="text-sm text-[#4A6076] mt-1">Sign in to see your water data.</p>
        </div>

        <div className="rounded-2xl border-2 border-[#143049] bg-white p-6 shadow-[6px_6px_0_rgba(20,48,73,0.08)] space-y-4">
          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}

          {/* A plain link, not a fetch: the whole point is to hand the browser
              to Google and let it come back. */}
          <a
            href={href}
            className="flex w-full items-center justify-center gap-2 rounded-full border-2 border-[#143049] bg-white px-4 py-2.5 text-sm font-medium text-[#143049] transition-colors hover:bg-[#EAF6FC]"
          >
            <svg aria-hidden="true" viewBox="0 0 18 18" className="h-4 w-4">
              <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z" />
              <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.34A9 9 0 0 0 9 18Z" />
              <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.94H.96a9 9 0 0 0 0 8.12l3.01-2.34Z" />
              <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.94l3.01 2.34C4.68 5.16 6.66 3.58 9 3.58Z" />
            </svg>
            Continue with Google
          </a>

          <p className="text-xs text-[#4A6076]">
            Only approved accounts can sign in. Signing out of this app does not
            sign you out of Google.
          </p>
        </div>
      </div>
    </div>
  )
}

// useSearchParams needs a Suspense boundary or the build fails on this page.
export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-[70vh]" />}>
      <LoginScreen />
    </Suspense>
  )
}
