"use client"

import { Suspense, useState } from "react"
import { useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import Flo from "@/components/design/Flo"

/**
 * Where to go after logging in.
 *
 * Only a path within this app is allowed. `next` arrives in the URL, so without
 * this check a crafted link — `/login?next=//somewhere.else` — would turn the
 * login form into an open redirect, and one that looks trustworthy precisely
 * because the victim really did just log in.
 */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/"
  return raw
}

function LoginForm() {
  const next = safeNext(useSearchParams().get("next"))

  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      })
      if (res.ok) {
        // A full document load, not router.replace().
        //
        // Next prefetches the links a page renders, and this page renders the
        // nav's link to "/". That prefetch ran while we were still anonymous, so
        // what the router cached for "/" is the proxy's redirect back to
        // /login. A client-side navigation then replays that cached redirect and
        // lands back here, valid cookie and all. Reloading the document skips
        // the router cache and asks the server fresh.
        //
        // The E2E suite caught this; it is invisible in dev, where the cache is
        // usually cold by the time you get to typing a password.
        window.location.assign(new URL(next, window.location.origin).toString())
        return
      }
      const body = await res.json().catch(() => ({}))
      setError(res.status === 503 ? body.error : "That is not the password.")
    } catch {
      setError("Could not reach the server.")
    } finally {
      setBusy(false)
    }
  }

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
          <p className="text-sm text-[#4A6076] mt-1">This one is password-protected.</p>
        </div>

        <form
          onSubmit={submit}
          className="rounded-2xl border-2 border-[#143049] bg-white p-6 shadow-[6px_6px_0_rgba(20,48,73,0.08)] space-y-4"
        >
          <div>
            <Label htmlFor="password" className="text-sm">
              Password
            </Label>
            <Input
              id="password"
              type="password"
              autoFocus
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1"
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}

          <Button type="submit" className="w-full" disabled={busy || password === ""}>
            {busy ? "Checking…" : "Log in"}
          </Button>
        </form>
      </div>
    </div>
  )
}

// useSearchParams needs a Suspense boundary or the build fails on this page.
export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-[70vh]" />}>
      <LoginForm />
    </Suspense>
  )
}
