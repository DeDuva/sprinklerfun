import { test, expect, type APIRequestContext } from "@playwright/test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// A smoke test, not a UI-behaviour suite — the component tests cover behaviour.
// What this proves is the thing nothing else does: that the real production
// bundle boots, that the pages render against a real database through the real
// route handlers, and that the whole stack agrees with itself.
//
// It seeds through the public API rather than writing SQL, so the ingest path
// gets exercised too. Writes need no secret here because APP_SHARED_SECRET is
// unset and this is not a Vercel deployment (see lib/server/auth.ts).

const FIXTURE = join(process.cwd(), "data", "fixture-sprinkler-day.json")
const CONFIG = join(process.cwd(), "data", "sprinkler-config-2026-08-31.json")

async function seed(request: APIRequestContext) {
  const { rows } = JSON.parse(readFileSync(FIXTURE, "utf8"))
  const { windows } = JSON.parse(readFileSync(CONFIG, "utf8"))
  const res = await request.post("/api/rows", { data: { rows, windows } })
  expect(res.status(), await res.text()).toBe(200)
  return (await res.json()) as { inserted: number }
}

test.describe("smoke", () => {
  test("the app boots and serves a healthy database", async ({ request }) => {
    const res = await request.get("/api/health")
    expect(res.status()).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, database: "reachable" })
  })

  test("seeding through the API drives the whole derived pipeline", async ({ request }) => {
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

  test("the removed endpoints stay removed", async ({ request }) => {
    expect((await request.get("/api/rows")).status()).toBe(405)
    expect((await request.delete("/api/rows")).status()).toBe(405)
  })

  test("an empty windows array does not wipe the config timeline", async ({ request }) => {
    await seed(request)
    const before = await (await request.get("/api/delay")).json()
    expect(before.recommendations.length).toBeGreaterThan(0)

    const res = await request.post("/api/rows", { data: { rows: [], windows: [] } })
    expect(res.status()).toBe(200)

    const after = await (await request.get("/api/delay")).json()
    expect(after.recommendations.length).toBe(before.recommendations.length)
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

  test("analysis renders the calibration view", async ({ page, request }) => {
    await seed(request)
    await page.goto("/analysis")
    await expect(page.getByText(/Timing & Flow Calibration/i)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(/Station Delay/i).first()).toBeVisible()
  })

  test("config renders and no longer offers a clear-all button", async ({ page }) => {
    await page.goto("/config")
    await expect(page.getByText(/Timer 1/i).first()).toBeVisible({ timeout: 15_000 })
    // Removed in the attack-surface work; this is the assertion that keeps it gone.
    await expect(page.getByRole("button", { name: /clear all data/i })).toHaveCount(0)
  })
})
