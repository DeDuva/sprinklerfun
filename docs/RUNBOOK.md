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

## Signing in, granting and revoking access

The app is behind Google sign-in. Every page and API route needs a session; only
the sign-in page, the `/api/auth` endpoints and `GET /api/health` are open.

**To give someone access**, add their Google address to `ALLOWED_EMAILS`:

```bash
vercel env rm ALLOWED_EMAILS production
vercel env add ALLOWED_EMAILS production   # the full comma-separated list
vercel --prod                              # a redeploy is required to pick it up
```

**To revoke someone**, remove their address the same way. It takes effect on
their next request — the allow-list is re-read on every one, not just at sign-in
— so there is no waiting for a cookie to expire.

**To sign every device out at once** (a lost laptop, or on principle), rotate the
cookie signing key:

```bash
vercel env rm SESSION_SECRET production
vercel env add SESSION_SECRET production   # openssl rand -base64 32
vercel --prod
```

Everyone signs back in with Google afterwards, including you.

If the Google credentials are ever missing — or only partly set — every request
returns 503 while `/api/health` keeps answering normally. That exact combination
means a variable is gone, not that the database is down.

Signing out of the app does not sign you out of Google, deliberately.

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
have, because reads were public; reads now require a session, so this token is
the one remaining way to read the data without signing in. It lives only in
Actions secrets.

Expiration is `never` on purpose: a dated token means the backup stops silently
when it lapses, which is the worst possible failure for the thing that *is* the
recovery plan.

## Clearing data deliberately

**Config → Stored data → type `DELETE` → Clear all data.** The button is behind the
login, and inert until the word is typed; it clears the metered rows and the three
derived tables in one request and recomputes nothing, because there is nothing left
to compute.

**It does not touch your config windows or maintenance flags.** "I want to re-upload
my meter history" should not cost you a season of hand-tuned config, so clearing is
deliberately the narrower of the two things it could mean.

There is no undo. Recovery is a restore from the daily backup (see *Restoring data*),
so if you are unsure, take an export from the same card first.

Against the database directly, if the app is not reachable:

```bash
turso db shell sprinklerfun "DELETE FROM flume_rows"
```

Then trigger a recompute by saving any config change in the app, or the derived tables
will keep describing rows that no longer exist.

## When the config looks wrong

The server holds the only copy of the config, so "wrong on this device" is no longer
a thing that can happen — if it looks wrong, it *is* wrong, for everyone.

1. **Export what you see.** Config → Export JSON. Do this first, even if it is the
   bad version: it costs nothing and it is the only record of what the app currently
   believes.
2. **Compare against the latest backup.** Download the most recent artifact (Actions
   → Backup), `gunzip` it, and read the `config_windows` inserts. That is what the
   config looked like at 09:15 UTC on that day.
3. **Import the good one.** Config → Import from file. An import is a whole-document
   replace written straight to the server, so it takes effect everywhere at once.

An empty timeline is refused by the API: the earliest window also covers every row
before it, so a config with no windows would leave the entire history unattributable.

## Local development

No environment variables are needed. `lib/db.ts` falls back to a local SQLite file
and no Google credentials are set, so the guard runs in open mode — which is also
how the E2E suite's server would run if it did not set them deliberately:

```bash
npm run dev       # http://localhost:3000
npm run seed:dev  # in another terminal: seeds config + one fixture day through the API
```

`seed:dev` goes through HTTP rather than writing the database, so it exercises the
same validation and recompute path a real save does. Nothing seeds itself any more —
a fresh install shows its empty state until you seed it or create a window.

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
| Vercel → project → Settings → Environment Variables | Required: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, `ALLOWED_EMAILS`. Optional, for automatic data: `FLUME_CLIENT_ID`, `FLUME_CLIENT_SECRET`, `FLUME_USERNAME`, `FLUME_PASSWORD`, `CRON_SECRET` (and `FLUME_DEVICE_ID` only if the account has more than one sensor) | Nothing is set for Preview or Development. Without the Flume set the app still works — it just waits for a CSV upload. `CRON_SECRET` is what stops `/api/cron` being a public ingest trigger; unset means that route refuses everything. Check with `vercel env ls production` from a linked checkout. |
| Vercel → project → Settings → Cron Jobs | One job: `/api/cron`, `0 17 * * *` | Declared in `vercel.json`, so it deploys with the code — the dashboard is where you confirm it fired and read its logs. On the Hobby plan cron is capped at **once per day** and fires anywhere within the hour, so 17:00–17:59 UTC. That lands mid-morning Pacific, deliberately after both timers have finished their night. |
| Google Cloud console → APIs & Services → Credentials | OAuth 2.0 Client ID (Web application). Authorised redirect URI must be exactly `https://sprinklerfun.vercel.app/api/auth/callback` | A mismatch here fails the sign-in with `redirect_uri_mismatch` at Google, before any of our code runs. The consent screen's test-user list matters too if the app is still in "testing" mode. |
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

- **No rate limiting of our own.** Per-instance counters are meaningless on
  serverless. Google rate-limits the sign-in itself, which is where guessing
  would happen; the realistic control beyond that is Vercel's edge firewall,
  configured in the dashboard.
- **Sign-in depends on Google being reachable.** Existing sessions keep working
  during an outage — they are verified locally against `SESSION_SECRET` — but
  nobody new can sign in until Google is back.
- **`recomputeStats()` re-reads the entire `flume_rows` table on every write.** This
  is the scaling cliff. At the current ~175k rows it is fine; it is superlinear in
  accumulated history.
- **Ingest refuses any timestamp carrying a timezone.** Flume's export is
  timezone-naive and is read as local wall-clock time, so a trailing `Z` or
  `+HH:MM` would be ignored rather than honoured and every rollup would shift
  silently. `app/api/rows/route.ts` rejects it instead, which turns a format
  change at Flume's end into a failed upload with a message rather than months of
  quietly wrong numbers.
