import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { createClient, type Client } from "@libsql/client"

// ---------------------------------------------------------------------------
// libSQL / Turso client (server-only)
//
// Phase 1 of the localStorage → Turso migration. This module is imported only
// by route handlers and server-side data-access code — never by client
// components (it reads secrets from the environment).
//
// Configuration (see .env.example):
//   TURSO_DATABASE_URL  libsql://<db>.turso.io  (or file:… for local dev)
//   TURSO_AUTH_TOKEN    auth token for the remote DB (omit for file: URLs)
//
// When no URL is set we fall back to a local SQLite file so `npm run dev` and
// tests work with zero cloud dependency. The remote DB is used in production
// via Vercel env vars.
// ---------------------------------------------------------------------------

// Pin the process timezone from APP_TIMEZONE. Enrichment converts Flume's UTC
// timestamps to LOCAL time (see lib/analyze.ts), and rollups are computed
// server-side, so the server must run in the homeowner's zone or rollups won't
// match the browser. We can't use the `TZ` env var directly — Vercel reserves
// it — so we read a non-reserved var and assign process.env.TZ at module load
// (before any Date is constructed during enrichment). Node honors a runtime TZ
// assignment for subsequent Date operations. This module is imported on every
// server data path, so the assignment runs once per cold start.
if (process.env.APP_TIMEZONE) {
  process.env.TZ = process.env.APP_TIMEZONE
}

const LOCAL_FALLBACK_URL = "file:.data/sprinkler.db"

// Reuse a single client across HMR reloads / serverless warm invocations.
const globalForDb = globalThis as unknown as {
  __sprinklerDb?: Client
  __sprinklerSchemaReady?: Promise<void>
}

export function getDb(): Client {
  if (globalForDb.__sprinklerDb) return globalForDb.__sprinklerDb

  const url = process.env.TURSO_DATABASE_URL ?? LOCAL_FALLBACK_URL
  const authToken = process.env.TURSO_AUTH_TOKEN

  // libSQL won't create the parent directory for a local file DB — do it here so
  // the dev fallback (file:.data/sprinkler.db) works on a fresh checkout.
  if (url.startsWith("file:")) {
    const path = url.slice("file:".length)
    if (path && path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
  }

  const client = createClient(url.startsWith("file:") ? { url } : { url, authToken })

  globalForDb.__sprinklerDb = client
  return client
}

// Idempotent schema bootstrap. Runs at most once per process (the promise is
// memoized), and every statement is CREATE … IF NOT EXISTS so it is safe to run
// against an already-provisioned database.
export function ensureSchema(): Promise<void> {
  if (globalForDb.__sprinklerSchemaReady) return globalForDb.__sprinklerSchemaReady

  const db = getDb()
  globalForDb.__sprinklerSchemaReady = (async () => {
    await db.batch(
      [
        `CREATE TABLE IF NOT EXISTS flume_rows (
           datetime TEXT PRIMARY KEY,
           gallons  REAL NOT NULL
         )`,
        // Per-day lookups for the day-detail view.
        `CREATE INDEX IF NOT EXISTS idx_flume_date
           ON flume_rows (substr(datetime, 1, 10))`,
        `CREATE TABLE IF NOT EXISTS config_windows (
           id             TEXT PRIMARY KEY,
           effective_from TEXT NOT NULL,
           notes          TEXT NOT NULL DEFAULT '',
           config         TEXT NOT NULL,
           created_at     TEXT NOT NULL,
           updated_at     TEXT NOT NULL
         )`,
        `CREATE TABLE IF NOT EXISTS daily_rollup (
           date             TEXT NOT NULL,
           station          TEXT NOT NULL,
           gallons          REAL NOT NULL,
           is_sprinkler_day INTEGER NOT NULL,
           PRIMARY KEY (date, station)
         )`,
        `CREATE TABLE IF NOT EXISTS maintenance (
           station_id TEXT PRIMARY KEY,
           flagged_at TEXT NOT NULL,
           note       TEXT
         )`,
        // Per-minute-only aggregates that daily gallon sums can't reconstruct
        // (fleet-wide gpm stats + baseline warnings). Recomputed over the full
        // enriched series whenever rows or windows change; read via /api/stats.
        `CREATE TABLE IF NOT EXISTS station_stats (
           id               TEXT PRIMARY KEY,
           name             TEXT NOT NULL,
           total_gallons    REAL NOT NULL,
           avg_gpm          REAL NOT NULL,
           min_gpm          REAL NOT NULL,
           max_gpm          REAL NOT NULL,
           std_gpm          REAL NOT NULL,
           cost_estimate    REAL NOT NULL,
           pct_of_sprinkler REAL NOT NULL
         )`,
        `CREATE TABLE IF NOT EXISTS station_warnings (
           station_id             TEXT PRIMARY KEY,
           station_name           TEXT NOT NULL,
           baseline_gpm           REAL NOT NULL,
           recent_avg_gpm         REAL NOT NULL,
           pct_above_baseline     REAL NOT NULL,
           consecutive_days_above INTEGER NOT NULL
         )`,
      ],
      "write"
    )
  })()

  return globalForDb.__sprinklerSchemaReady
}
