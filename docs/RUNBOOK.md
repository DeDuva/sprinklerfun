# Runbook

Operational procedures for the deployed app. See `SECURITY.md` for the threat model
this assumes.

## The thing to internalise

**A code rollback does not restore data.**

Deploys and data are independent. Vercel's Instant Rollback swaps which build serves
traffic; it does not touch Turso. Every write path in this app rewrites derived tables
wholesale:

- `POST /api/rows` deletes and rebuilds `daily_rollup` for the full date range, then
  wipes and rebuilds `station_stats` and `station_warnings` — on every write.
- `replaceWindows` deletes every row in `config_windows` before inserting the new set.

So a bad deploy that corrupts data leaves corrupt data behind after the rollback. The
only fix is a restore.

## Rolling back a bad deploy

1. Vercel dashboard → the project → **Deployments**
2. Find the last known-good production deployment → **⋯** → **Instant Rollback**
3. Confirm with `curl -s https://sprinklerfun.vercel.app/api/health` → expect
   `{"ok":true,"database":"reachable","rows":…}`
4. Fix forward on a branch. `main` is protected: PR, green `types + tests`, `lint`
   and `e2e`, and an up-to-date branch. There is no bypass, deliberately.

If the rollback itself is what you need to undo, redeploy `main` with
`vercel --prod` from a linked checkout.

## Restoring data

Two independent paths, with very different reach:

| | Window | Good for |
|---|---|---|
| **Turso PITR** (free plan) | **24 hours** | An incident you catch the same day |
| **Backup artifacts** | **90 days** | Everything else |

The free plan's 24-hour window is the reason the artifacts exist. An unnoticed
wipe is unrecoverable through PITR after a day, so for anything older the
artifact is the only path.

### From a backup artifact (the usual case)

1. **Actions → Backup →** pick a run → download the artifact → `gunzip` it.
2. Restore into a **new** database, never over the live one:
   ```bash
   turso db create sprinklerfun-restore
   turso db shell sprinklerfun-restore < sprinklerfun-<date>.sql
   ```
3. Compare before switching anything:
   ```bash
   turso db shell sprinklerfun-restore "SELECT COUNT(*), MIN(datetime), MAX(datetime) FROM flume_rows"
   ```
4. Repoint `TURSO_DATABASE_URL` in Vercel → **Production** → redeploy.
5. Save any config change in the app to force a rollup and stats recompute — the
   dump deliberately carries only `flume_rows` and `config_windows`.

The dump is plain SQL, so it restores with `turso db shell` and needs nothing
from this repository. That is the point: recovery tooling that depends on the
thing being recovered is a bad trade.

### From Turso PITR (same-day only)

```bash
turso db create sprinklerfun-restore --from-db sprinklerfun --timestamp <ISO>
```

Then compare and repoint exactly as above.

`flume_rows` is the only irreplaceable table. Everything else — `daily_rollup`,
`station_stats`, `station_warnings` — is derived and rebuilds from a single write, so
a restore only needs to get the raw rows back.

## Backups

`.github/workflows/backup.yml` runs daily at 09:15 UTC (≈02:15 local) and on
demand via **Actions → Backup → Run workflow**. It dumps `flume_rows` and
`config_windows` to gzipped SQL and uploads it as an artifact kept for 90 days.

Deliberately **not** committed: this is the household water data the fixtures were
scrubbed of in #41, and the repository is public.

**Only two tables are dumped.** `flume_rows` is irreplaceable and
`config_windows` is hand-tuned; `daily_rollup`, `station_stats` and
`station_warnings` are derived and rebuild from a single write, so backing them up
would be archiving a cache.

**It fails loudly rather than quietly succeeding.** `scripts/backup.ts` exits
non-zero if the database returns no rows or the file comes out implausibly small,
and the upload is set to `if-no-files-found: error`. A backup that silently
contains nothing is worse than one that failed, because it looks like success
right up until someone needs it.

Run it locally against production with:

```bash
TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... npm run backup
```

### Credentials

The workflow uses two repository secrets. The token is a **read-only database
token**, scoped to the one database:

```bash
turso db tokens create <database> --read-only
```

Not a platform token. `turso db export` would produce a truer SNAPSHOT, but it
authenticates with a credential that can create and destroy every database in the
account — far too much reach for a job that only reads one table. The read-only
database token also grants nothing an anonymous visitor does not already have,
since reads are public by choice.

Expiration is `never` on purpose: a dated token means the backup stops silently
when it lapses, which is the worst possible failure for the thing that *is* the
recovery plan.

## Clearing data deliberately

There is no longer an endpoint or a button for this — see `SECURITY.md`. Do it against
the database:

```bash
turso db shell sprinklerfun "DELETE FROM flume_rows"
```

Then trigger a recompute by saving any config change in the app, or the derived tables
will keep describing rows that no longer exist.

## Schema changes

There are **no migrations**. `ensureSchema()` in `lib/db.ts` is `CREATE TABLE IF NOT
EXISTS` only, so on a database where the table already exists it is a no-op — adding
a column to a live deployment silently does nothing, and the code then reads a column
that isn't there.

Any schema change therefore needs an explicit `ALTER TABLE` run against the live
database as part of the deploy, and a rolled-back build will still be running against
the forward-migrated schema. Treat schema changes as one-way.

## Known operational limits

- **No rate limiting.** Per-instance counters are meaningless on serverless. The
  realistic control is Vercel's edge firewall, configured in the dashboard.
- **`recomputeStats()` re-reads the entire `flume_rows` table on every write.** This
  is the scaling cliff. At the current ~175k rows it is fine; it is superlinear in
  accumulated history.
- **Preview deployments have no database.** No `TURSO_*` variables are set for the
  preview environment, so preview API routes now fail loudly (they previously failed
  silently against an ephemeral file). Previews are for UI review only.
- **`APP_TIMEZONE` is not set in production.** Currently harmless only because Flume
  timestamps are timezone-naive and are parsed as local time either way. If the export
  format ever gains an offset or a `Z`, every rollup shifts. `.env.example` and
  `TECHNICAL_DESIGN.md` both describe it as mandatory; that drift is unresolved.
