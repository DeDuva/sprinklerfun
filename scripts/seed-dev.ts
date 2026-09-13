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

/**
 * A session cookie value, only needed if you point this at a server that has
 * Google sign-in configured. Local `npm run dev` has no credentials set, so the
 * guard runs open and this is unnecessary — which is the normal case.
 */
const SESSION_VALUE = process.env.SEED_COOKIE

const CONFIG_FILE = "data/sprinkler-config-2026-08-31.json"
const ROWS_FILE = "data/fixture-sprinkler-day.json"

async function main() {
  const { readFileSync } = await import("node:fs")

  // Local dev has no Google credentials set, so the guard runs open and no
  // session is needed. Against an enforced server, pass SEED_COOKIE.
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (SESSION_VALUE) headers.cookie = `sf_session=${SESSION_VALUE}`

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
