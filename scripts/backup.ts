/**
 * Dump the database to a restorable SQL file.
 *
 * Run with:  npm run backup            (writes backup/sprinklerfun-<date>.sql.gz)
 *
 * Why this exists
 * ---------------
 * The deployed app is publicly writable by choice (see SECURITY.md), which makes
 * recovery the primary control rather than a backstop. Turso's free plan gives a
 * 1-day point-in-time-restore window, so an unnoticed wipe is unrecoverable after
 * 24 hours. These dumps are what turn that into 90 days of recovery points.
 *
 * Why SQL rather than JSON: a .sql file restores with `turso db shell <db> <
 * file.sql` and needs no tooling from this repo. A JSON dump would need a restore
 * script to exist and still work, which is one more thing to be broken at exactly
 * the wrong moment.
 *
 * Why not `turso db export`: it authenticates with a PLATFORM token, which can
 * create and destroy every database in the account. This uses a read-only
 * DATABASE token — the same kind of credential the app already holds, scoped to
 * one database and unable to write.
 */
import { createGzip } from "node:zlib"
import { createWriteStream, mkdirSync, statSync } from "node:fs"
import { pipeline } from "node:stream/promises"
import { Readable } from "node:stream"
import { createClient } from "@libsql/client"

const url = process.env.TURSO_DATABASE_URL
const authToken = process.env.TURSO_AUTH_TOKEN
if (!url) {
  console.error("TURSO_DATABASE_URL is not set — nothing to back up.")
  process.exit(1)
}

// Only these three matter. flume_rows is the irreplaceable one; config_windows
// and maintenance are the hand-tuned ones. daily_rollup, station_stats and
// station_warnings are all derived and rebuild from a single write, so backing
// them up would be storing a cache.
//
// `maintenance` joined this list when the flags stopped living in a browser's
// localStorage and became server-owned state. Until then the database copy was
// a table nothing wrote; now it is the only copy, which is exactly the property
// that makes something worth backing up.
// `flume_state` is deliberately absent. It holds a live Flume refresh token,
// these dumps become 90-day GitHub artifacts, and the token can be re-minted in
// a minute with `npm run flume:connect`. There is nothing in it worth
// preserving and something in it worth not copying into an archive.
const TABLES = ["flume_rows", "config_windows", "maintenance"] as const

const ROWS_PER_INSERT = 500

const sqlLiteral = (v: unknown): string => {
  if (v === null || v === undefined) return "NULL"
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL"
  if (typeof v === "bigint") return String(v)
  return `'${String(v).replace(/'/g, "''")}'`
}

async function* dump() {
  const db = createClient(url!.startsWith("file:") ? { url: url! } : { url: url!, authToken })

  yield `-- sprinklerfun backup ${new Date().toISOString()}\n`
  yield `-- Restore with: turso db shell <database> < this-file.sql\n`
  yield "PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n"

  let grandTotal = 0

  for (const table of TABLES) {
    const res = await db.execute(`SELECT * FROM ${table}`)
    const cols = res.columns
    yield `\n-- ${table}: ${res.rows.length} rows\n`
    // Not DROP: a restore should be able to land in an empty database without
    // assuming the schema exists, and ensureSchema() creates these anyway.
    yield `DELETE FROM ${table};\n`

    for (let i = 0; i < res.rows.length; i += ROWS_PER_INSERT) {
      const chunk = res.rows.slice(i, i + ROWS_PER_INSERT)
      const values = chunk
        .map((r) => `(${cols.map((c) => sqlLiteral((r as Record<string, unknown>)[c])).join(",")})`)
        .join(",\n  ")
      yield `INSERT INTO ${table} (${cols.join(",")}) VALUES\n  ${values};\n`
    }

    grandTotal += res.rows.length
    console.error(`  ${table}: ${res.rows.length.toLocaleString()} rows`)
  }

  yield "COMMIT;\n"

  // A backup that silently contains nothing is worse than a failure, because it
  // looks like success right up until the restore.
  if (grandTotal === 0) {
    throw new Error("Refusing to write an empty backup: the database returned no rows.")
  }
}

async function main() {
  const stamp = new Date().toISOString().slice(0, 10)
  mkdirSync("backup", { recursive: true })
  const out = `backup/sprinklerfun-${stamp}.sql.gz`

  console.error(`Backing up ${url!.replace(/\/\/.*@/, "//")}`)
  await pipeline(Readable.from(dump()), createGzip(), createWriteStream(out))

  const bytes = statSync(out).size
  console.error(`\nwrote ${out} (${(bytes / 1024).toFixed(0)} KB gzipped)`)

  // A few hundred bytes means headers and no data. Fail loudly rather than
  // upload a file that will disappoint someone during an incident.
  if (bytes < 1024) {
    console.error("Backup is implausibly small — treating as a failure.")
    process.exit(1)
  }

  // Consumed by the workflow for its summary line.
  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import("node:fs")
    appendFileSync(process.env.GITHUB_OUTPUT, `file=${out}\nbytes=${bytes}\n`)
  }
}

main().catch((err) => {
  console.error(`Backup failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
