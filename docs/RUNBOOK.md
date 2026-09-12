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

## Logging in, and rotating the password

The app is behind one password, `APP_PASSWORD`, set in Vercel → Production. Every
page and API route needs a session cookie obtained by logging in with it; only the
login page and `GET /api/health` are open.

To rotate it — after a lost phone, or on principle:

```bash
vercel env rm APP_PASSWORD production
vercel env add APP_PASSWORD production   # paste a long random value; do not invent one
vercel --prod                            # a redeploy is required to pick it up
```

**Rotating logs every device out, including the one you are holding.** The session
cookie is an HMAC of the password, so changing the password invalidates every
cookie ever issued. It is also the *only* revocation there is: individual sessions
cannot be cancelled, because none are stored. Log back in on each device after.

If `APP_PASSWORD` is ever missing from the deployment, every request returns 503
while `/api/health` keeps answering normally. That exact combination means the
variable is gone, not that the database is down.

## Rolling back a bad deploy

1. Vercel dashboard → the project → **Deployments**
2. Find the last known-good production deployment → **⋯** → **Instant Rollback**
3. Confirm with `curl -s https://sprinklerfun.vercel.app/api/health` → expect
   `{"ok":true,"database":"reachable","rows":…}`
4. Fix forward on a branch. `main` is protected: PR, green `types + tests`, `lint`,
   `e2e` and `audit`, and an up-to-date branch. There is no bypass, deliberately.

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
account — far too much reach for a job that only reads one table. Read-only is the
property that matters: the backup job never needs to change anything.

Note that this token became a real secret when the login landed. The original
argument for it was that it granted nothing an anonymous visitor did not already
have, because reads were public; reads now require the password, so this token is
the one remaining way to read the data without it. It lives only in Actions
secrets.

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

## Settings that live outside this repository

Some of how this project behaves is set in a dashboard, not a file, and a dashboard
setting has no diff and no review. When you change one of these, change this table
in the same sitting.

| Where | Setting | Why |
|---|---|---|
| Vercel → project → Settings → Git | Under *Connected Git Repository*: **Pull Request Comments** off, **Commit Comments** off | The bot commented on every PR, including every Dependabot PR. Vercel has replaced the single *Silence GitHub comments* switch with these two toggles, so look for them by name — the old one no longer exists. The `github.silent` key in `vercel.json` does the same thing but is deprecated; if it was ever set, Vercel migrates it to these toggles for you. |
| Vercel → project → Settings → Environment Variables | Production only: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `APP_PASSWORD` | Nothing is set for Preview or Development. `APP_TIMEZONE` is not set — see *Known operational limits*. Check with `vercel env ls production` from a linked checkout. |
| GitHub → Settings → Rules → ruleset `main` | PR required, squash only, branch up to date; required checks `types + tests`, `lint`, `e2e`, `audit` | Rename a CI job without renaming it here and the gate silently stops requiring it. |
| GitHub → Settings → Secrets → Actions | `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` (read-only database token) | Used only by `backup.yml`. |
| GitHub → Settings → Advanced Security | Dependabot alerts and security updates, secret scanning, push protection | Security updates open as soon as an advisory lands, whatever the schedule in `.github/dependabot.yml` — but they do obey its `ignore` rules, which is why majors there are grouped, not ignored. |

**Preview deployments are off, and that one *is* in the repo.** `vercel.json` sets
`git.deploymentEnabled` so only `main` deploys. Previews never had database
variables, so each one was a build whose API routes failed, announced by a bot
comment. The `e2e` job, which runs a real `next build` against a throwaway SQLite
file, checks the built app before merge instead. To get previews back for one
branch, add `"<branch>": true` under `deploymentEnabled` in that branch's commit.

## Known operational limits

- **No rate limiting, including on the login.** Per-instance counters are
  meaningless on serverless. The mitigation is a long random password; the
  realistic control beyond that is Vercel's edge firewall, configured in the
  dashboard.
- **`recomputeStats()` re-reads the entire `flume_rows` table on every write.** This
  is the scaling cliff. At the current ~175k rows it is fine; it is superlinear in
  accumulated history.
- **`APP_TIMEZONE` is not set in production.** Currently harmless only because Flume
  timestamps are timezone-naive and are parsed as local time either way. If the export
  format ever gains an offset or a `Z`, every rollup shifts. `.env.example` and
  `TECHNICAL_DESIGN.md` both describe it as mandatory; that drift is unresolved.
