import { test, expect, type APIRequestContext } from "@playwright/test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// A smoke test, not a UI-behaviour suite — the component tests cover behaviour.
// What this proves is the thing nothing else does: that the real production
// bundle boots, that the pages render against a real database through the real
// route handlers, and that the whole stack agrees with itself.
//
// It seeds through the API rather than writing SQL, so the ingest path gets
// exercised too. The server runs with APP_PASSWORD set (playwright.config.ts),
// so these tests log in exactly as a person does — which also means the guard
// itself is under test rather than switched off for convenience.

const FIXTURE = join(process.cwd(), "data", "fixture-sprinkler-day.json")
const CONFIG = join(process.cwd(), "data", "sprinkler-config-2026-08-31.json")

const PASSWORD = "e2e-password"

// Playwright gives each test a fresh request context, and `page.request` shares
// its cookie jar with the page. So logging in through the context a test is
// about to use is what puts the session cookie where that test needs it — and a
// test that does not call this one is genuinely anonymous.
async function login(request: APIRequestContext) {
  const res = await request.post("/api/login", { data: { password: PASSWORD } })
  expect(res.status(), await res.text()).toBe(200)
}

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

test.describe("the login", () => {
  test("the health probe answers without one — it is the post-deploy check", async ({ request }) => {
    const res = await request.get("/api/health")
    expect(res.status()).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, database: "reachable" })
  })

  test("an anonymous API request is refused", async ({ request }) => {
    for (const path of ["/api/rollup", "/api/stats", "/api/delay", "/api/day/2026-08-28"]) {
      expect((await request.get(path)).status(), path).toBe(401)
    }
    expect((await request.post("/api/rows", { data: { rows: [] } })).status()).toBe(401)
  })

  test("an anonymous page request lands on the login, with a way back", async ({ page }) => {
    await page.goto("/analysis")
    await expect(page).toHaveURL(/\/login\?next=%2Fanalysis$/)
    await expect(page.getByLabel("Password")).toBeVisible()
  })

  test("the wrong password does not let you in", async ({ request }) => {
    const res = await request.post("/api/login", { data: { password: "not-it" } })
    expect(res.status()).toBe(401)
    expect((await request.get("/api/rollup")).status()).toBe(401)
  })

  test("logging in through the form reaches the app", async ({ page, request }) => {
    await login(request)
    await seed(request)

    await page.goto("/login")
    await page.getByLabel("Password").fill(PASSWORD)
    await page.getByRole("button", { name: "Log in" }).click()

    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByRole("button", { name: /log out/i })).toBeVisible()
  })

  test("logging out ends the session", async ({ page }) => {
    await login(page.request)
    expect((await page.request.get("/api/rollup")).status()).toBe(200)

    await page.request.delete("/api/login")
    expect((await page.request.get("/api/rollup")).status()).toBe(401)
  })
})

test.describe("smoke", () => {
  test("seeding through the API drives the whole derived pipeline", async ({ request }) => {
    await login(request)
    await seed(request)

    // Asserted on stored state, not on the write's return value: insertRows is
    // INSERT OR IGNORE, so `inserted` is 0 whenever another test seeded first —
    // an assertion that passes or fails depending on ordering.
    // Rollups and stats are recomputed by the same request that ingested rows.
    const rollups = await (await request.get("/api/rollup")).json()
    expect(rollups.rollups.length).toBeGreaterThan(0)

    const stats = await (await request.get("/api/stats")).json()
    expect(stats.rowCount).toBeGreaterThan(1000)

    // And the delay estimator runs end to end against what was just stored.
    const delay = await (await request.get("/api/delay")).json()
    const t2 = delay.recommendations.find((r: { timer: string }) => r.timer === "timer2")
    expect(t2.delaySec).toBe(60)
  })

  test("the bulk export stays removed", async ({ request }) => {
    await login(request)
    // Logged in, so a 405 here is the route saying the method is gone rather
    // than the guard turning everyone away. DELETE is deliberately NOT in this
    // list any more — it came back behind the login, with a typed confirmation.
    expect((await request.get("/api/rows")).status()).toBe(405)
  })

  test("clearing data removes rows but keeps the config timeline", async ({ request }) => {
    await login(request)
    await seed(request)
    expect((await (await request.get("/api/stats")).json()).rowCount).toBeGreaterThan(0)

    expect((await request.delete("/api/rows")).status()).toBe(200)

    expect((await (await request.get("/api/stats")).json()).rowCount).toBe(0)
    // The part that matters: a season of hand-tuned config is not collateral
    // damage of "I want to re-upload my meter history".
    const config = await (await request.get("/api/config")).json()
    expect(config.windows.length).toBeGreaterThan(0)
  })

  test("the config timeline cannot be emptied, or smuggled in through an ingest", async ({ request }) => {
    await login(request)
    await seed(request)
    const before = await (await request.get("/api/config")).json()
    expect(before.windows.length).toBeGreaterThan(0)

    // An empty timeline leaves every stored row unattributable, so it is refused
    // outright rather than accepted as a no-op.
    const emptied = await request.put("/api/config", { data: { windows: [], maintenance: {} } })
    expect(emptied.status()).toBe(400)

    // And config no longer rides along with an ingest: a stale client that still
    // sends windows here is told so, rather than having them silently dropped.
    const smuggled = await request.post("/api/rows", { data: { rows: [], windows: [] } })
    expect(smuggled.status()).toBe(400)

    const after = await (await request.get("/api/config")).json()
    expect(after.windows.length).toBe(before.windows.length)
  })

  test("a second browser sees the config the first one saved", async ({ browser, request }) => {
    // This is the bug this whole change exists to fix. Config used to live in
    // localStorage, so a config saved on one device was simply absent on the
    // next one — and that browser would then push its own stale snapshot over
    // the real timeline. A fresh context shares no storage with anything.
    await login(request)
    await seedConfig(request)

    const context = await browser.newContext()
    try {
      const page = await context.newPage()
      await page.request.post("/api/login", { data: { password: PASSWORD } })
      const config = await (await page.request.get("/api/config")).json()
      expect(config.windows.length).toBeGreaterThan(0)

      await page.goto("/config")
      await expect(page.getByText(/Timer 1/i).first()).toBeVisible({ timeout: 15_000 })
    } finally {
      await context.close()
    }
  })

  test("security headers are served", async ({ request }) => {
    await login(request)
    const res = await request.get("/")
    const headers = res.headers()
    expect(headers["x-frame-options"]).toBe("DENY")
    expect(headers["x-content-type-options"]).toBe("nosniff")
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin")
  })

  test("the dashboard renders with data", async ({ page }) => {
    await login(page.request)
    await seed(page.request)
    await page.goto("/")
    // The computed headline, not a static title: it renders only once rollups
    // have loaded and the monthly summary has been derived from them, so it
    // proves data reached the page rather than that the page exists. (There is
    // no "Dashboard" heading in this branch — that one belongs to the empty
    // state, which is exactly what made it the wrong thing to assert on.)
    await expect(page.getByText(/Your yard used .* gal/)).toBeVisible({ timeout: 20_000 })
    // The consumption chart is the dashboard's centrepiece; an SVG means Recharts
    // received a series rather than an empty one.
    await expect(page.locator("svg").first()).toBeVisible({ timeout: 15_000 })
  })

  test("analysis renders the calibration view", async ({ page }) => {
    await login(page.request)
    await seed(page.request)
    await page.goto("/analysis")
    await expect(page.getByText(/Timing & Flow Calibration/i)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(/Station Delay/i).first()).toBeVisible()
  })

  test("config renders from the server, and the clear button is armed by typing", async ({ page }) => {
    await login(page.request)
    await seedConfig(page.request)
    await page.goto("/config")
    // Rendered from GET /api/config — nothing was seeded into this browser.
    await expect(page.getByText(/Timer 1/i).first()).toBeVisible({ timeout: 15_000 })

    // The button is back, but inert until the word is typed. That is the whole
    // safety property, so it is what gets asserted.
    const clear = page.getByRole("button", { name: /clear all data/i })
    await expect(clear).toBeDisabled()
    await page.getByLabel("Type DELETE to confirm").fill("DELETE")
    await expect(clear).toBeEnabled()
  })
})
