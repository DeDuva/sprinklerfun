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
4. Fix forward on a branch. `main` is protected: PR, green `types + tests` and `lint`,
   and an up-to-date branch. There is no bypass, deliberately.

If the rollback itself is what you need to undo, redeploy `main` with
`vercel --prod` from a linked checkout.

## Restoring data

**Verify these before you need them.** *(⚠️ The retention window and PITR
availability depend on the Turso plan and have not yet been confirmed for this
project — do that and fill in the blanks below.)*

- Turso point-in-time restore window: `TODO — confirm on the current plan`
- Latest logical backup: `TODO — see "Backups" below`

Procedure once confirmed:

1. `turso db shell <db> ".tables"` — confirm you are pointed at the right database.
2. Restore to a **new** database, never over the live one:
   `turso db create sprinklerfun-restore --from-db sprinklerfun --timestamp <ISO>`
3. Compare before switching: row count, min/max date, and per-station totals for a
   known day (`GET /api/day/2026-08-28` against each).
4. Repoint `TURSO_DATABASE_URL` in Vercel → **Production** → redeploy.

`flume_rows` is the only irreplaceable table. Everything else — `daily_rollup`,
`station_stats`, `station_warnings` — is derived and rebuilds from a single write, so
a restore only needs to get the raw rows back.

## Backups

**Not yet implemented.** This is the highest-priority operational gap: the app is
publicly writable by design, so recovery is the primary control, and it currently
rests entirely on whatever Turso's plan provides.

Planned: a scheduled GitHub Actions job dumping the DB via the Turso HTTP API and
uploading it as a workflow artifact with 90-day retention. Deliberately **not**
committed to the repo — it is the same household data the fixtures were scrubbed of.

Blocked on: a Turso token stored as a repo secret, and confirmation of the PITR window.

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
