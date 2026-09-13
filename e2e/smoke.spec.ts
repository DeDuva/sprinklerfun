import { test, expect, type APIRequestContext } from "@playwright/test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { COOKIE, issueSession } from "../lib/server/session"

// These must match playwright.config.ts's webServer.env.
//
// A static import is what is wanted here: lib/server/session reads process.env
// at CALL time, not at import time, so all that matters is that these are set
// before issueSession() runs a few lines below. A dynamic `await import()` would
// be top-level await, which Playwright's transform rejects outright — the spec
// then fails to parse and the run reports "No tests found", which is a far
// quieter failure than it sounds.
process.env.SESSION_SECRET ??= "e2e-session-secret-not-used-anywhere-real"
process.env.ALLOWED_EMAILS ??= "e2e@sprinklerfun.test"

// A smoke test, not a UI-behaviour suite — the component tests cover behaviour.
// What this proves is the thing nothing else does: that the real production
// bundle boots, that the pages render against a real database through the real
// route handlers, and that the whole stack agrees with itself.
//
// On authentication: the server runs with Google sign-in ENFORCED, because a
// suite that runs the guard in open mode tests nothing about the only thing
// protecting this deployment. A headless browser cannot complete a Google
// consent screen, so the tests do not pretend to — they present a session
// cookie signed with the same SESSION_SECRET the server is using.
//
// That is deliberately NOT a test-only bypass in the product: there is no
// special header, no magic value, no branch in the app that exists for tests.
// Holding the signing key is simply what being the server means. The anonymous
// describe below runs without that cookie, so the guard is exercised for real.

const FIXTURE = join(process.cwd(), "data", "fixture-sprinkler-day.json")
const CONFIG = join(process.cwd(), "data", "sprinkler-config-2026-08-31.json")

const SESSION = issueSession("e2e@sprinklerfun.test")
const AUTHENTICATED = { cookie: `${COOKIE}=${SESSION}` }

async function seedConfig(request: APIRequestContext) {
  const { windows } = JSON.parse(readFileSync(CONFIG, "utf8"))
  const res = await request.put("/api/config", { data: { windows, maintenance: {} } })
  expect(res.status(), await res.text()).toBe(200)
}

// Config first, then rows: a row is attributed to a station using the window
// active on its date, so ingesting before the timeline exists would roll the
// whole day up as "house".
async function seed(request: APIRequestContext) {
  const { rows } = JSON.parse(readFileSync(FIXTURE, "utf8"))
  await seedConfig(request)
  const res = await request.post("/api/rows", { data: { rows } })
  expect(res.status(), await res.text()).toBe(200)
  return (await res.json()) as { inserted: number }
}

test.describe("the guard, without a session", () => {
  test("the health probe answers anyway — it is the post-deploy check", async ({ request }) => {
    const res = await request.get("/api/health")
    expect(res.status()).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, database: "reachable" })
  })

  test("an anonymous API request is refused", async ({ request }) => {
    for (const path of ["/api/rollup", "/api/stats", "/api/delay", "/api/config", "/api/day/2026-08-28"]) {
      expect((await request.get(path)).status(), path).toBe(401)
    }
    expect((await request.post("/api/rows", { data: { rows: [] } })).status()).toBe(401)
    // "Sync now" triggers an ingest and a whole-table recompute, so it stays
    // behind the guard like everything else a person reaches.
    expect((await request.post("/api/sync")).status()).toBe(401)
  })

  test("the cron path is outside the guard but still refuses everyone", async ({ request }) => {
    // /api/cron has to be reachable without a session — Vercel invokes it with a
    // plain GET. That makes its own check the only thing standing in front of a
    // full ingest, so this proves the fail-closed behaviour against the real
    // built app: CRON_SECRET is unset here, and it refuses regardless of what
    // the caller claims to be.
    expect((await request.get("/api/cron")).status()).toBe(401)
    expect((await request.get("/api/cron", { headers: { authorization: "Bearer guess" } })).status()).toBe(401)
    expect(
      (
        await request.get("/api/cron", {
          headers: { "user-agent": "vercel-cron/1.0", "x-vercel-cron-schedule": "0 17 * * *" },
        })
      ).status()
    ).toBe(401)
  })

  test("an anonymous page request lands on the sign-in, with a way back", async ({ page }) => {
    await page.goto("/analysis")
    await expect(page).toHaveURL(/\/login\?next=%2Fanalysis$/)
    await expect(page.getByRole("link", { name: /continue with google/i })).toBeVisible()
  })

  test("a forged or junk session is refused", async ({ request }) => {
    for (const value of ["not-a-token", "ab.cd", `${"a".repeat(40)}.${"b".repeat(64)}`]) {
      const res = await request.get("/api/rollup", { headers: { cookie: `${COOKIE}=${value}` } })
      expect(res.status(), value).toBe(401)
    }
  })

  test("the retired password endpoint is gone and guarded", async ({ request }) => {
    // It must not have kept its old matcher exemption: whatever answers here,
    // it is not an unauthenticated way in.
    expect([401, 404, 405]).toContain((await request.post("/api/login", { data: {} })).status())
  })

  test("starting the flow redirects to Google with state and PKCE", async ({ request }) => {
    const res = await request.get("/api/auth/login?next=%2Fconfig", { maxRedirects: 0 })
    expect(res.status()).toBe(307)
    const location = new URL(res.headers()["location"])
    expect(location.origin + location.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth")
    expect(location.searchParams.get("code_challenge_method")).toBe("S256")
    expect(location.searchParams.get("code_challenge")).toBeTruthy()
    expect(location.searchParams.get("state")).toBeTruthy()
    expect(location.searchParams.get("redirect_uri")).toMatch(/\/api\/auth\/callback$/)
  })

  test("the callback refuses a code that did not come from a flow we started", async ({ request }) => {
    // No state cookie, so the CSRF check must reject it rather than exchanging
    // whatever code an attacker supplies.
    const res = await request.get("/api/auth/callback?code=stolen&state=made-up", { maxRedirects: 0 })
    expect(res.status()).toBe(307)
    expect(res.headers()["location"]).toMatch(/\/login\?error=/)
  })
})

test.describe("signed in", () => {
  test.use({ extraHTTPHeaders: AUTHENTICATED })

  test("seeding through the API drives the whole derived pipeline", async ({ request }) => {
    await seed(request)

    // Asserted on stored state, not on the write's return value: insertRows is
    // INSERT OR IGNORE, so `inserted` is 0 whenever another test seeded first.
    const rollups = await (await request.get("/api/rollup")).json()
    expect(rollups.rollups.length).toBeGreaterThan(0)

    const stats = await (await request.get("/api/stats")).json()
    expect(stats.rowCount).toBeGreaterThan(1000)

    const delay = await (await request.get("/api/delay")).json()
    const t2 = delay.recommendations.find((r: { timer: string }) => r.timer === "timer2")
    expect(t2.delaySec).toBe(60)
  })

  test("the bulk export stays removed", async ({ request }) => {
    // Signed in, so a 405 here is the route saying the method is gone rather
    // than the guard turning everyone away.
    expect((await request.get("/api/rows")).status()).toBe(405)
  })

  test("clearing data removes rows but keeps the config timeline", async ({ request }) => {
    await seed(request)
    expect((await (await request.get("/api/stats")).json()).rowCount).toBeGreaterThan(0)

    expect((await request.delete("/api/rows")).status()).toBe(200)

    expect((await (await request.get("/api/stats")).json()).rowCount).toBe(0)
    const config = await (await request.get("/api/config")).json()
    expect(config.windows.length).toBeGreaterThan(0)
  })

  test("the config timeline cannot be emptied, or smuggled in through an ingest", async ({ request }) => {
    await seed(request)
    const before = await (await request.get("/api/config")).json()
    expect(before.windows.length).toBeGreaterThan(0)

    const emptied = await request.put("/api/config", { data: { windows: [], maintenance: {} } })
    expect(emptied.status()).toBe(400)

    const smuggled = await request.post("/api/rows", { data: { rows: [], windows: [] } })
    expect(smuggled.status()).toBe(400)

    const after = await (await request.get("/api/config")).json()
    expect(after.windows.length).toBe(before.windows.length)
  })

  test("a second browser sees the config the first one saved", async ({ browser, request }) => {
    // The bug the server-authoritative change exists to fix. Config used to live
    // in localStorage, so a config saved on one device was simply absent on the
    // next — and that browser would then push its own stale snapshot over the
    // real timeline. A fresh context shares no storage with anything.
    await seedConfig(request)

    const context = await browser.newContext({ extraHTTPHeaders: AUTHENTICATED })
    try {
      const page = await context.newPage()
      const config = await (await page.request.get("/api/config")).json()
      expect(config.windows.length).toBeGreaterThan(0)

      await page.goto("/config")
      await expect(page.getByText(/Timer 1/i).first()).toBeVisible({ timeout: 15_000 })
    } finally {
      await context.close()
    }
  })

  test("signing out clears the session cookie", async ({ request }) => {
    const res = await request.delete("/api/auth/logout")
    expect(res.status()).toBe(200)
    const cleared = res.headers()["set-cookie"] ?? ""
    expect(cleared).toContain(`${COOKIE}=`)
    expect(cleared).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i)
  })

  test("security headers are served", async ({ request }) => {
    const res = await request.get("/")
    const headers = res.headers()
    expect(headers["x-frame-options"]).toBe("DENY")
    expect(headers["x-content-type-options"]).toBe("nosniff")
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin")
  })

  test("the dashboard renders with data", async ({ page, request }) => {
    await seed(request)
    await page.goto("/")
    await expect(page.getByText(/Your yard used .* gal/)).toBeVisible({ timeout: 20_000 })
    await expect(page.locator("svg").first()).toBeVisible({ timeout: 15_000 })
  })

  test("analysis renders the calibration view", async ({ page, request }) => {
    await seed(request)
    await page.goto("/analysis")
    await expect(page.getByText(/Timing & Flow Calibration/i)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(/Station Delay/i).first()).toBeVisible()
  })

  test("config renders from the server, and the clear button is armed by typing", async ({ page, request }) => {
    await seedConfig(request)
    await page.goto("/config")
    await expect(page.getByText(/Timer 1/i).first()).toBeVisible({ timeout: 15_000 })

    const clear = page.getByRole("button", { name: /clear all data/i })
    await expect(clear).toBeDisabled()
    await page.getByLabel("Type DELETE to confirm").fill("DELETE")
    await expect(clear).toBeEnabled()
  })

  test("the signed-in app offers a way out", async ({ page }) => {
    await page.goto("/")
    await expect(page.getByRole("button", { name: /log out/i })).toBeVisible()
  })
})
