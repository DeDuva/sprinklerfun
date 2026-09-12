import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { createClient, type Client } from "@libsql/client"
import { isDeployed } from "./server/env"

// ---------------------------------------------------------------------------
// libSQL / Turso client (server-only)
//
// Imported only by route handlers and server-side data-access code — never by
// client components, since it reads secrets from the environment.
//
// Configuration (see .env.example):
//   TURSO_DATABASE_URL  libsql://<db>.turso.io  (or file:… for local dev)
//   TURSO_AUTH_TOKEN    auth token for the remote DB (omit for file: URLs)
//
// When no URL is set we fall back to a local SQLite file so `npm run dev` and
// tests work with zero cloud dependency. The remote DB is used in production
// via Vercel env vars.
// ---------------------------------------------------------------------------

// This module used to mutate `process.env.TZ` from an `APP_TIMEZONE` variable at
// import time, so that enrichment's `new Date()` calls would resolve to the
// homeowner's zone. Both halves are gone: timestamps are now parsed lexically
// (lib/analyze.ts `localDateAndMin`), so nothing downstream depends on the
// process timezone at all, and production never set the variable anyway — the
// behaviour it was supposed to guarantee was never actually in effect.

const LOCAL_FALLBACK_URL = "file:.data/sprinkler.db"

// Reuse a single client across HMR reloads / serverless warm invocations.
const globalForDb = globalThis as unknown as {
  __sprinklerDb?: Client
  __sprinklerSchemaReady?: Promise<void>
}

export function getDb(): Client {
  if (globalForDb.__sprinklerDb) return globalForDb.__sprinklerDb

  // The local-file fallback is a dev convenience that used to double as a
  // production failure mode: with TURSO_DATABASE_URL missing, the app did not
  // error — it opened a file DB on an ephemeral serverless filesystem,
  // bootstrapped an empty schema, served zero rows as though that were the
  // truth, and discarded every write when the instance recycled. Refusing to
  // start is the only honest behaviour, and it is what makes /api/health
  // meaningful.
  if (isDeployed() && !process.env.TURSO_DATABASE_URL) {
    throw new Error(
      "TURSO_DATABASE_URL is not set on a Vercel deployment. Refusing to fall back " +
        "to an ephemeral local file database, which would silently serve an empty " +
        "dataset and discard every write when the instance recycles."
    )
  }

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
  const ready = (async () => {
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

  globalForDb.__sprinklerSchemaReady = ready

  // Do not memoize a REJECTION. This used to cache the promise unconditionally,
  // so one transient failure — bad credentials during a rollout, a read-only
  // filesystem, a network blip — was permanent for the life of the process:
  // every later request re-awaited the same rejection and no retry was possible
  // short of a cold start. Clearing on failure makes the next call try again.
  ready.catch(() => {
    if (globalForDb.__sprinklerSchemaReady === ready) {
      delete globalForDb.__sprinklerSchemaReady
    }
  })

  return ready
}

/**
 * Drop the memoized client and schema promise.
 *
 * Tests only. `getDb()` caches on globalThis, which survives `vi.resetModules()`
 * — so without this a test file gets whichever database the previous one opened,
 * and the URL is read once at first call, making a per-test env override useless.
 * Calling this between tests is what makes each one start from an empty DB.
 */
export function resetDbForTests(): void {
  delete globalForDb.__sprinklerDb
  delete globalForDb.__sprinklerSchemaReady
}
