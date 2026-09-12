/**
 * Seed a LOCAL development database through the running app's own API.
 *
 * Run with:  npm run dev        (in one terminal)
 *            npm run seed:dev   (in another)
 *
 * Why this exists
 * ---------------
 * The app used to seed itself on first load: StoreProvider fetched a bundled
 * `public/default-config.json` and a bundled CSV and POSTed them back to the
 * server. That is what made a fresh browser overwrite a real config with a
 * months-old snapshot — the bug this whole change removes. Seeding is now an
 * explicit thing a developer runs, never something the app does to itself.
 *
 * It goes through HTTP rather than writing the database directly, so it
 * exercises the same validation and recompute path a real save does. If this
 * script works, the API works.
 */
const BASE = process.env.SEED_BASE_URL ?? "http://127.0.0.1:3000"
const PASSWORD = process.env.APP_PASSWORD

const CONFIG_FILE = "data/sprinkler-config-2026-08-31.json"
const ROWS_FILE = "data/fixture-sprinkler-day.json"

async function main() {
  const { readFileSync } = await import("node:fs")

  // A session cookie, only if the local server is enforcing one. Local dev
  // leaves APP_PASSWORD unset and runs open, so this is usually skipped.
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (PASSWORD) {
    const res = await fetch(`${BASE}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    })
    if (!res.ok) throw new Error(`login failed: HTTP ${res.status}`)
    const cookie = res.headers.get("set-cookie")
    if (!cookie) throw new Error("login succeeded but set no cookie")
    headers.cookie = cookie.split(";")[0]
  }

  const { windows } = JSON.parse(readFileSync(CONFIG_FILE, "utf8"))
  const { rows } = JSON.parse(readFileSync(ROWS_FILE, "utf8"))

  // Config first: rows are attributed to stations using the active window, so
  // ingesting before the timeline exists would roll everything up as "house".
  const cfg = await fetch(`${BASE}/api/config`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ windows, maintenance: {} }),
  })
  if (!cfg.ok) throw new Error(`PUT /api/config failed: HTTP ${cfg.status} ${await cfg.text()}`)
  console.log(`seeded ${windows.length} config window(s)`)

  const ingest = await fetch(`${BASE}/api/rows`, {
    method: "POST",
    headers,
    body: JSON.stringify({ rows }),
  })
  if (!ingest.ok) throw new Error(`POST /api/rows failed: HTTP ${ingest.status} ${await ingest.text()}`)
  const { inserted } = (await ingest.json()) as { inserted: number }
  console.log(`seeded ${inserted.toLocaleString()} row(s) from ${ROWS_FILE}`)
}

main().catch((err) => {
  console.error(`Seed failed: ${err instanceof Error ? err.message : String(err)}`)
  console.error(`Is the dev server running at ${BASE}?`)
  process.exit(1)
})
