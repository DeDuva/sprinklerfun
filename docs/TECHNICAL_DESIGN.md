# SprinklerFun — Technical Design

## Stack

| Layer | Choice | Rationale |
|---|---|---|
| Framework | Next.js 16 (App Router) | First-class Vercel support, file-based routing |
| Language | TypeScript | Type-safe data shapes across the analysis pipeline |
| Styling | Tailwind CSS | Utility-first, no CSS files |
| Charts | Recharts 3 | React-native, good enough for this data scale |
| CSV parsing | Papa Parse | Handles Flume's datetime format, browser-native |
| State | Zustand (in-memory) | Simple global store; holds a copy of the server's config, persists nothing |
| Auth | Google sign-in + email allow-list → signed cookie, checked in `proxy.ts` | Identity from Google, authorisation from `ALLOWED_EMAILS`; every route behind it by default |
| Database | Turso (libSQL / SQLite) via `@libsql/client` | Durable, multi-device time-series store; SQL-native aggregation |
| Backend | Next.js Route Handlers (`app/api/*`, Node runtime) | Config, ingest, Flume sync and aggregate endpoints; reuse the pure `analyze.ts` functions server-side |
| Data in | Flume Personal API via a daily Vercel cron; CSV upload as the fallback | Data arrives without anyone downloading anything; the CSV path covers history the API no longer serves |
| UI components | shadcn/ui | Accessible, unstyled-first components |
| Testing | Vitest (unit, with coverage thresholds) + Playwright (e2e against a real build) | Fast unit feedback; the e2e suite catches what only a built, served app shows |
| Hosting | Vercel | Zero-config Next.js deploy; Turso env vars for the DB |

**The server owns everything; the browser owns nothing** (see
[Storage & Backend Architecture](#storage--backend-architecture)). Rows, config
windows, maintenance flags and every derived table live in Turso. The browser
persists nothing at all — no `localStorage`, no seeding from the bundle — and
holds only an in-memory copy of what it last fetched.

The analysis functions in `lib/analyze.ts` remain pure and are reused
**verbatim** on the server to compute rollups and stats. The browser never loads
the full per-minute series: the dashboard and analysis pages read the aggregate
feeds (`/api/rollup`, `/api/stats`) and fetch a single day (`/api/day/[date]`)
only when a per-minute view needs it.

This is the end state of a migration that ran in stages — browser-only, then
rows on the server, then aggregates, then config. Each stage is described where
it still matters; the stage numbers themselves have been removed, because "Phase
3" tells a reader nothing they can act on.

---

## Project Structure

```
sprinklerfun/
├── proxy.ts                    # The session guard in front of every route (Next 16's `middleware`)
├── app/
│   ├── layout.tsx              # Root layout: Navbar + StoreProvider + Toaster; reads the session cookie
│   ├── page.tsx                # Dashboard
│   ├── analysis/page.tsx       # Timing & flow calibration
│   ├── config/page.tsx         # Config timeline editor + Flume sync, CSV upload, export/import, stored data
│   ├── day/[date]/page.tsx     # Minute-by-minute day detail
│   ├── about/page.tsx          # What the app is and where its data comes from
│   ├── login/page.tsx          # Google sign-in
│   ├── design/page.tsx         # Design-system showcase
│   └── api/                    # Route Handlers (Node runtime) — the backend
│       ├── config/route.ts     # GET/PUT the config document (windows + maintenance)
│       ├── rows/route.ts       # POST ingest (+recompute) · DELETE clear
│       ├── sync/route.ts       # POST "Sync now" — runs the Flume sync (session required)
│       ├── cron/route.ts       # GET daily Flume sync from Vercel cron (CRON_SECRET required)
│       ├── day/[date]/route.ts # GET one day's raw per-minute rows
│       ├── rollup/route.ts     # GET per-day/per-station aggregates
│       ├── stats/route.ts      # GET precomputed fleet gpm stats + baseline warnings
│       ├── delay/route.ts      # GET inferred inter-station delay per timer
│       ├── health/route.ts     # GET database reachability + row count (unauthenticated)
│       └── auth/               # login · callback · logout (Google OAuth, PKCE)
├── components/
│   ├── Navbar.tsx
│   ├── StoreProvider.tsx       # Client-only: fetches /api/config + /api/stats once on mount
│   ├── SummaryCards.tsx
│   ├── WarningsPanel.tsx       # Baseline-deviation warnings + maintenance-flag surfacing
│   ├── ConsumptionChart.tsx    # Unified time-series chart (opens on 2W)
│   ├── StationFlowChart.tsx    # Horizontal bar chart for a single day with nav, day tiles, and enriched tooltip
│   ├── FlowTimelineChart.tsx   # Analysis: per-minute actual vs configured-baseline overlay + brush/station zoom
│   ├── ReconciliationTable.tsx # Analysis: per-station cfg→actual table; buttons STAGE config edits (don't write)
│   ├── ReviewChangesModal.tsx  # Analysis: review staged config changes (old→new, removable) before saving
│   ├── StationDelayCard.tsx    # Analysis: inferred station delay, staged like any other proposal
│   ├── DayPicker.tsx
│   ├── design/  ui/            # Flo + design-system pieces · shadcn/ui primitives
│   └── UploadModal.tsx, DailyChart.tsx, WeeklyChart.tsx  # not referenced by any page
├── lib/
│   ├── types.ts                # All shared TypeScript interfaces, DEFAULT_CONFIG, migrateConfig, toWindows
│   ├── analyze.ts              # Pure analysis functions (no React) — reused server-side
│   ├── staging.ts              # Pure staged-config-edit logic for the Analysis tab
│   ├── csvImport.ts            # Flume CSV row parsing + the Flume export link
│   ├── store.ts                # Zustand store — in-memory copy of the server's config, persists nothing
│   ├── db.ts                   # server-only: libSQL client + idempotent schema bootstrap
│   ├── backend.ts              # client-only: fetch config/rollups/stats/day, push rows, sync now
│   ├── server/
│   │   ├── data.ts             # data access + recomputeRollups/recomputeStats (reuses analyze.ts)
│   │   ├── validate.ts         # config and row validation for the write routes
│   │   ├── flume.ts            # Flume Personal API client (refresh grant, devices, usage query)
│   │   ├── flumeState.ts       # the stored, rotating refresh token
│   │   ├── sync.ts             # syncFlumeData: window, slicing, query budget, ingest
│   │   ├── session.ts          # auth mode, signed session cookie, allow-list
│   │   ├── google.ts           # authorization URL + code exchange (PKCE S256)
│   │   └── env.ts              # "is this a deployment?"
│   └── __tests__/              # Vitest unit + component tests
├── e2e/                        # Playwright smoke suite
├── scripts/                    # flume-connect, seed-dev, backup, make-fixtures, verify-prod
├── .github/workflows/          # ci.yml (types + tests, lint, e2e, audit) · backup.yml
├── .env.example                # every variable, with what happens when it is unset
├── vitest.config.mts
├── playwright.config.ts
└── vercel.json                 # main-only deploys + the /api/cron schedule
```

---

## Data Types

### Station (hardware — shared across programs)
```ts
interface Station {
  id: string
  name: string
  baselineGpm?: number   // physical measurement from seasonal audit
}
```

### ProgramStation (per-program schedule settings for one station)
```ts
interface ProgramStation {
  durationMin: number
  enabled: boolean
}
```

### ProgramConfig (one scheduling program — A, B, or C)
```ts
type ProgramId = "A" | "B" | "C"

interface ProgramConfig {
  enabled: boolean                          // B and C are off by default
  start: string                             // "HH:MM:SS"
  days: number[]                            // 0=Mon … 6=Sun
  stations: Record<string, ProgramStation>  // keyed by Station.id
}
```

### TimerConfig
```ts
interface TimerConfig {
  stations: Station[]                                     // ordered; defines run order
  stationDelaySec?: number                                // dead time between stations
  programs: { A: ProgramConfig; B: ProgramConfig; C: ProgramConfig }
}
```

### AppConfig
```ts
interface AppConfig {
  timer1: TimerConfig
  timer2: TimerConfig
  sprinklerOnThreshold: number   // gallons during any station window → sprinkler day
  gallonsPerUnit: number
  costPerUnit: number
}
```

Note: `sprinklerDays` (formerly a top-level array) has been removed. Each program now carries its own `days` array.

### MaintenanceFlag (physical-state flag, not a config snapshot)
```ts
interface MaintenanceFlag {
  flaggedAt: string   // ISO timestamp
  note?: string
}
```
Stored in the store as `maintenance: Record<stationId, MaintenanceFlag>` — top-level, **not** inside a `ConfigWindow`, because it describes the current hardware state independent of config history.

### Calibration types (Analysis tab)
```ts
// Configured station run for a day, reconstructed from program start + durations.
interface ExpectedSegment {
  stationId: string
  name: string
  timer: "timer1" | "timer2"
  programId: ProgramId
  startMin: number; endMin: number; durationMin: number
  baselineGpm: number | null
}

// One minute of actual metered flow (gallons-in-the-minute == gpm).
interface MinutePoint { timeMin: number; gpm: number }

// An ExpectedSegment reconciled against the actual per-minute flow.
interface SegmentReconciliation {
  stationId: string; name: string
  timer: "timer1" | "timer2"; programId: ProgramId
  cfgStartMin: number; cfgEndMin: number; cfgDurationMin: number; baselineGpm: number | null
  actualStartMin: number | null; actualEndMin: number | null
  actualDurationMin: number | null; actualGpm: number | null   // trimmed mean
  startDriftMin: number | null; durationDriftMin: number | null; gpmDeltaPct: number | null
  confidence: "high" | "low"; confidenceReason?: string
}
```

---

## Data Flow

The same pure `lib/analyze.ts` functions run in two places now. **Server-side**
(at write time) they compute the persisted aggregates from the full per-minute
series; **client-side** they run only over reconstructed rollups or a single
fetched day.

```
SERVER (recompute on every write — POST /api/rows, each Flume sync, PUT /api/config)
  flume_rows (raw minutes)  +  config_windows
      │  enrichRowsMultiConfig(rows, windows)   → EnrichedRow[]  (full series)
      ├─▶ buildDailyRows()                       → daily_rollup   (date, station, gallons, isSprinklerDay)
      ├─▶ buildStationStats(enriched, current)   → station_stats
      └─▶ computeStationWarnings(enriched, current) → station_warnings

CLIENT (per page load / serverVersion bump)
  GET /api/rollup  → RollupRow[]
      ├─▶ rollupsToDailyRows()   → DailyRow[]   ──▶ computeSummary()          (monthly cards)
      └─▶ rollupsToEnriched(_, stationTimerMap(windows)) → synthetic EnrichedRow[]
                                                 ──▶ aggregateForChart()      (consumption chart)
  GET /api/stats   → { stationStats, warnings, rowCount, lastDate }
      ├─▶ stationStats  ──▶ analysis Fleet Overview
      └─▶ warnings      ──▶ dashboard Station Alerts
  GET /api/day/[date] → FlumeRow[]  (one day)
      └─▶ enrichRows(dayRows, activeWindowConfig)  → EnrichedRow[] (one day)
              ├─▶ buildStationStats() / buildDailyRows() / computeSummary()   (per-day flow)
              └─▶ buildDaySchedule() + buildDayMinuteSeries() + reconcileDay() (Analysis calibration)
```

All analysis functions are **pure** (no side effects, no React). They live in
`lib/analyze.ts`. The rollup-reconstruction helpers (`rollupsToDailyRows`,
`rollupsToEnriched`, `stationTimerMap`) are pure too and unit-tested to
reproduce the old client-side outputs bit-for-bit (within float tolerance).

---

## Storage & Backend Architecture

### Why it changed

The original design persisted the entire Zustand store — including the full
`FlumeRow[]` minute series — into `localStorage`. At 1-minute resolution that is
~525K rows/year (~25–30MB/year serialized), and `appendRows` re-serialized and
rewrote the **whole** blob on every upload. `localStorage` caps at ~5MB per
origin, so multi-year data threw `QuotaExceededError`. `localStorage` is the
wrong tier for a growing time-series.

### Model: raw + rollup

The bulk data (raw minutes) lives in Turso. Only the day-detail view ever needs
raw minutes, and only one day at a time. Everything else consumes *aggregates*
that are `GROUP BY date/station, SUM(gallons)` — so those are precomputed once
at ingest and stored as rollups.

| Data | Table | Computed by | When |
|---|---|---|---|
| Raw minute rows | `flume_rows (datetime PK, gallons)` | Flume sync, or CSV parse | daily cron, Sync now, or upload |
| Config windows | `config_windows (id, effective_from, notes, config JSON, …)` | client edits | on edit / import |
| Daily rollups | `daily_rollup (date, station, gallons, is_sprinkler_day)` PK `(date, station)` | server, from enriched rows | on every ingest / config edit |
| Station stats | `station_stats (id PK, name, total_gallons, avg/min/max/std_gpm, cost_estimate, pct_of_sprinkler)` | server, `buildStationStats` over full enriched series | on every ingest / config edit |
| Station warnings | `station_warnings (station_id PK, station_name, baseline_gpm, recent_avg_gpm, pct_above_baseline, consecutive_days_above)` | server, `computeStationWarnings` over full enriched series | on every ingest / config edit |
| Maintenance flags | `maintenance (station_id PK, flagged_at, note)` | client edits | on edit |
| Flume token | `flume_state (id = 1, refresh_token, updated_at)` | Flume, on each refresh | every sync (it rotates) |

The two `station_*` tables hold the per-minute-only
aggregates the dashboard/analysis need but that daily gallon sums **cannot**
reconstruct: fleet-wide per-station gpm statistics (avg/std/min/max) and
baseline-drift warnings. They are recomputed by `recomputeStats()` over the
whole enriched series (using `currentConfig(windows)`) on every write, and read
back via `GET /api/stats`.

Schema is bootstrapped idempotently (`CREATE … IF NOT EXISTS`) by
`ensureSchema()` in `lib/db.ts`, memoized once per process.

### Route Handlers (`app/api/*`, Node runtime)

- **`GET` / `PUT /api/config`** — the config document
  `{ windows, maintenance, authMode }`. `PUT` validates every window, refuses an
  empty timeline, requires `maintenance` explicitly, writes both halves in a
  single `db.batch`, recomputes rollups + stats, and returns what it stored.
  This is the only writer of config.
- **`POST /api/rows`** — body `{ rows }`. `INSERT OR IGNORE`s rows (the
  `datetime` PK does the dedupe `appendRows` used to do by hand), then recomputes
  rollups **and** the station stats/warnings. Returns `{ inserted, rollupDays }`.
  A `windows` field is rejected with a 400 rather than ignored, so a stale client
  fails loudly instead of appearing to save a config that went nowhere.
- **`GET /api/rows`** — **gone.** It returned the entire metered history with no
  range and no limit, and nothing in the app called it. Requesting it now gets a
  405.
- **`DELETE /api/rows`** — clears rows + rollups + station stats/warnings
  ("Clear all data"), behind the login and a typed confirmation. It deliberately
  leaves `config_windows` and `maintenance` alone.
- **`GET /api/day/[date]`** — one day's raw per-minute rows; detail/flow views
  enrich a single day client-side instead of loading the whole series.
- **`GET /api/cron`** — the daily Flume sync. Excluded from `proxy.ts` because a
  cron request carries no session; guarded by `CRON_SECRET` as a bearer token
  and refuses everything when that is unset. Always answers 200, with `ok:false`
  in the body on failure — Vercel does not retry a failed cron, so a non-2xx
  buys nothing.
- **`POST /api/sync`** — the same job, triggered by the "Sync now" button. Stays
  *behind* the session guard, because this one is reached by a person. There is
  no `GET`: an ingest plus a whole-table recompute is not something a link or a
  prefetch should set off.
- **`GET /api/delay?days=N`** — the inferred inter-station delay per timer (see
  *Inter-Station Delay Inference*). Server-side because the fit needs many days of
  per-minute flow.
- **`GET /api/health`** — database reachability and row count. Unauthenticated, so
  it still answers when sign-in is misconfigured — which is what makes "503 on `/`,
  200 here" a diagnosis rather than an outage.
- **`/api/auth/login`, `/callback`, `/logout`** — the Google sign-in flow; see *Auth*.
- **`GET /api/rollup?from=&to=`** — the small aggregate feed for the dashboard
  chart/summary + per-window day counts. Bounds optional.
- **`GET /api/stats`** — the precomputed per-minute-only aggregates:
  `{ stationStats, warnings, rowCount, lastDate }`. Powers the dashboard station
  alerts, the analysis Fleet Overview, and status labels. Read-only, uncached.

All pin `runtime = "nodejs"` (the libSQL node client uses native bindings —
not edge-compatible) and `dynamic = "force-dynamic"` (never cached).

`recomputeRollups(from, to)` in `lib/server/data.ts` fetches raw rows for the
range plus the **full** window set (a date's active window may be defined
earlier), runs `enrichRowsMultiConfig` + `buildDailyRows` — the same pure
functions the browser used — and upserts one rollup row per `(date, station)`.
`recomputeStats()` (same module) enriches the **whole** series once and stores
`buildStationStats` + `computeStationWarnings` output (both keyed on
`currentConfig(windows)`) into the `station_*` tables. The client reconstructs
`DailyRow[]` and a synthetic `EnrichedRow[]` from the rollup feed via
`rollupsToDailyRows` / `rollupsToEnriched` / `stationTimerMap` (in
`lib/analyze.ts`) — the synthetic rows carry each day's summed gallons and feed
`aggregateForChart` unchanged (it reads only date/station/timer/gallons, never
`timeMin`, so pre-summed rows yield identical bucket totals).

### ⚠️ Timezone constraint (critical)

Flume's export is **timezone-naive** (`2026-08-22 00:00:00`) and everything
downstream wants "minute of the local day", so `localDateAndMin` in
`lib/analyze.ts` parses the string with a regex rather than constructing a
`Date`. The result does not depend on the process timezone, so the server (UTC on
Vercel) and the browser (Pacific) cannot disagree about which day a row belongs
to.

This replaced a `new Date()` round trip plus an `APP_TIMEZONE` variable that
`lib/db.ts` assigned to `process.env.TZ` at import. That arrangement was wrong in
two ways. It was never actually in effect — production never set the variable —
and even when set it could not fix the spring-forward case: a naive `02:30` does
not exist locally, so `new Date()` moved it to `03:30` and the browser's day view
attributed that hour differently from the server's rollups. A lexical parse is
identical in every zone and on every date.

Ingest enforces the assumption: `DATETIME_RE` in `app/api/rows/route.ts` is
anchored at both ends, so a `Z` or `±HH:MM` suffix is a 400. An offset would be
ignored rather than honoured, and a silent shift in every rollup is a worse
outcome than a rejected upload.

### Auth (Google sign-in, one household)

One guard: `proxy.ts` (Next 16's renamed `middleware`, which always runs on the
Node runtime). It requires a session cookie on every route except the sign-in
page, the `/api/auth` endpoints, `GET /api/health`, `/api/cron` (which checks
`CRON_SECRET` itself) and static output — so a route is protected by existing, not
by remembering. The `/api/auth` exclusion is not
optional: the callback is where Google returns the browser, and nobody holds a
session at that moment.

`lib/server/session.ts` holds the three decisions:

| Mode | When | Behaviour |
|---|---|---|
| `open` | no Google credentials, not a deployment | everything allowed — local dev and both test suites, zero setup |
| `enforced` | `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` + `SESSION_SECRET` all set | valid session required; API gets 401, pages redirect to `/login?next=…` |
| `refuse` | credentials missing or partial, on a deployment | every request 503s |

The mode keys off `VERCEL`, not `NODE_ENV`, for the reason in
`lib/server/env.ts` — `next start` sets `NODE_ENV=production` locally too, which
is exactly how the E2E suite runs.

**Identity vs authorisation.** Google answers *who*; `ALLOWED_EMAILS` answers
*whether*. `sessionEmail()` is what the guard calls, and it checks three things:
signature, expiry, and that the address is **still** on the list. That last check
runs on every request, so removing someone revokes them on their next click
rather than whenever their cookie runs out.

**The cookie** is `base64url({ email, exp }) . hex HMAC-SHA256` — httpOnly,
SameSite=Lax, seven days, signed with `SESSION_SECRET`. A signed cookie, not a
JWT: one issuer, one audience, no third party parsing it, so a JWT library would
buy a spec we do not use. Rotating `SESSION_SECRET` invalidates every session at
once.

**The flow** is a hand-rolled authorization-code exchange with PKCE
(`lib/server/google.ts`), three endpoints under `app/api/auth/`:
`login` mints `state` + a PKCE verifier into short-lived httpOnly cookies and
redirects to Google; `callback` compares `state`, exchanges the code with the
verifier, requires `email_verified`, checks the allow-list, and sets the session;
`logout` expires the cookie. It does not sign anyone out of Google, deliberately.

Every failure lands on `/login?error=<code>` with a generic message, because
"not on the allow-list" versus "bad code" is useful only to someone probing which
addresses are permitted. The specific reason goes to the server log.

This replaced a shared header whose value shipped to the browser as
`NEXT_PUBLIC_APP_SHARED_SECRET`; see `SECURITY.md`.

### Getting data in (Flume API, or a CSV)

Data arrives one of two ways, and the second still works when the first is not
configured. Production has used the first since 2026-09-12.

**The Flume Personal API**, pulled by a Vercel cron once a day (`0 17 * * *`).
`lib/server/flume.ts` is a small hand-rolled client: `grant_type=refresh_token`
for an access token, the numeric `user_id` decoded out of that token's JWT
payload, the account's water sensors listed (type 2 — bridges relay, they do not
meter), then a usage query. `lib/server/sync.ts` feeds the result through the
**same** write path as an upload — `insertRows` → `recomputeRollups` →
`recomputeStats` — calling those functions directly, so the route's 200,000-row
body cap does not apply.

**The Flume account password never reaches the deployment.** Flume needs it for
exactly one thing: the initial password grant that mints a refresh token. That
runs on the operator's machine via `npm run flume:connect`, which prints the
token and writes nothing. What production holds is `FLUME_CLIENT_ID`,
`FLUME_CLIENT_SECRET` and a refresh token — a credential scoped to API access,
revocable by itself, and worthless anywhere else, which an account password is
not.

The refresh token lives in a one-row `flume_state` table, seeded by
`FLUME_REFRESH_TOKEN` on a fresh database, with the stored value winning
thereafter. It is stored rather than kept in the env var because **Flume rotates the
refresh token on every refresh.** Its docs never said so. The code was written to
handle either case, and every production sync since has logged a rotation. A static
env var would have gone stale after the first sync, and the daily sync would have
died on the next one — the worst failure shape available, since the symptom is data
simply stopping. `syncFlumeData` compares the returned token against the one it sent and
persists any difference **before** doing the query work, because the token it
just spent may already be dead: writing afterwards would mean a mid-sync failure
stranded the new token and left the next run authenticating with a spent one.

That table is deliberately absent from `scripts/backup.ts`. The dumps become
90-day GitHub artifacts, and a live credential that can be re-minted in a minute
does not belong in an archive.

Four details that are load-bearing rather than incidental:

- **The bucket is `MIN`.** Station attribution works on minute-of-day
  (`localDateAndMin`), so hourly totals would make it meaningless. The real CSV
  exports are per-minute too — 56,041 rows for five weeks. The query sets **no
  `operation`**: with one, Flume collapses the range into a single value with no
  datetimes.
- **Flume's datetime is passed through untouched.** Its format,
  `YYYY-MM-DD HH:MM:SS`, is exactly what ingest accepts. Converting it to an ISO
  string with a `Z` — which an earlier version did — is rejected with a 400 by
  design, because everything downstream reads naive wall-clock time.
- **The window is padded a day at each end and queried in slices.** Flume reads
  the query datetimes as *account*-local while we build them from UTC, so the
  padding absorbs the offset; rows dedupe on their primary key, so over-fetching
  is free and under-fetching would silently lose a day. Each query covers at most
  12 hours: production rejected 14-day `MIN` queries as failing validation, and
  Flume documents no maximum range.
- **One sync makes at most 50 queries.** Flume allows 120 requests an hour. A
  longer window fetches its *oldest* part and the next run carries on from the
  last stored row; an empty database backfills 20 days, and older history comes
  from a CSV upload.

The sync is idempotent by construction, which Vercel's cron contract requires
rather than suggests: delivery is best effort, may skip a run, and may deliver
the same one twice. Re-querying inserts nothing new, and a missed day is picked
up by the next run because the window starts from the last stored row rather
than from "yesterday".

**A CSV upload** remains the fallback, unchanged: it is the recovery path when
credentials lapse, the API changes, or a gap needs filling that Flume will no
longer serve.

### Local development

With no `TURSO_DATABASE_URL` set, `lib/db.ts` falls back to a local SQLite file
at `./.data/sprinkler.db` (gitignored, parent dir auto-created), so `npm run dev`
and tests need zero cloud setup. Production points `TURSO_DATABASE_URL` /
`TURSO_AUTH_TOKEN` at a Turso database.

### Deployment & environment setup

Provision the database (once):

```bash
turso db create sprinklerfun
turso db show sprinklerfun --url         # → TURSO_DATABASE_URL
turso db tokens create sprinklerfun      # → TURSO_AUTH_TOKEN
```

Configure Vercel. Env vars are **per-project** — Vercel has no account-global
env store — and the target project is whichever one the current directory is
linked to. Link first, then add:

```bash
vercel link                              # select the "sprinklerfun" project
                                         # (writes .vercel/project.json, gitignored)

# 2nd arg is the ENVIRONMENT (production | preview | development), not the project:
vercel env add TURSO_DATABASE_URL production
vercel env add TURSO_AUTH_TOKEN production
vercel env add GOOGLE_CLIENT_ID production         # from the Google Cloud console
vercel env add GOOGLE_CLIENT_SECRET production
vercel env add SESSION_SECRET production           # openssl rand -base64 32
vercel env add ALLOWED_EMAILS production           # comma-separated addresses

# Optional — automatic data (see docs/RUNBOOK.md, "Connecting Flume"):
vercel env add FLUME_CLIENT_ID production
vercel env add FLUME_CLIENT_SECRET production
vercel env add FLUME_REFRESH_TOKEN production      # from `npm run flume:connect`
vercel env add CRON_SECRET production              # openssl rand -base64 32
```

- Run these in the same shell/working directory the app builds from (for WSL
  checkouts, inside WSL at the repo path) so the link binds correctly.
- Verify the binding with `cat .vercel/project.json` or `vercel project ls`.
- `--scope <team-slug>` selects the team/account when you belong to several; it
  does **not** make a var global.
- Repeat per environment you need (`production`, `preview`, `development`), or
  run `vercel env add NAME` with no environment to get the checkbox prompt.
- Local dev needs none of this — the `./.data/sprinkler.db` fallback covers it;
  optionally copy `.env.example` → `.env.local`.

**Gotchas (learned the hard way):**
- The value is **not** a positional arg to `vercel env add` — positionals are
  `[name] [environment] [gitBranch]`. Passing the value as a 4th token makes
  Vercel read it as a git branch and fail. Enter it at the `? Value?` prompt, or
  pipe it: `printf '%s' '<value>' | vercel env add NAME production`.
- There is **no timezone variable at all** any more. Timestamps are parsed
  lexically, so the process timezone is irrelevant and there is nothing to set.
- `vercel link` creating the project and **connecting the Git repo are separate
  steps**; Git-connect can fail (e.g. the Vercel GitHub app lacks access to the
  repo's owner) without affecting env setup or CLI deploys. Wire Git later via
  the dashboard or `vercel git connect`.

> **No timezone configuration is required.** This used to warn that
> `APP_TIMEZONE` was mandatory in production. It never was set there, and the
> warning mattered only because enrichment parsed through `Date`. It parses
> lexically now, so there is nothing to configure and nothing to get wrong.

### CI/CD — where the gate actually is

`.github/workflows/ci.yml` runs four jobs on every PR and every push to `main`:
`types + tests` (typecheck, unit tests with coverage thresholds, then the unit
tests again under four timezones), `lint`, `e2e` (a real `next build` served
locally, driven by Playwright) and `audit` (`npm audit --audit-level=high`). **It does not deploy.** Vercel's Git integration builds production from
`main` on every merge, and Vercel has no native "wait for CI checks" setting for
production deployments — so the gate is placed at the **merge**, not the deploy:

```
PR ──→ types + tests, lint, e2e, audit ──→ [ruleset on main] ──→ merge ──→ Vercel deploys production
            │
            └─ red ⇒ merge blocked ⇒ main unchanged ⇒ nothing deploys
```

A repository ruleset on `main` requires the `types + tests`, `lint`, `e2e` and
`audit` checks, requires a PR, requires the branch to be up to date before merging, and forbids
deletion and force-pushes. Since production only ever builds from `main`, and nothing red can
reach `main`, production only ever runs green code.

Two consequences worth knowing:

- **No Vercel token exists, deliberately.** Deploying from Actions would need a
  long-lived credential in GitHub secrets to buy a guarantee branch protection
  already provides for free. The one exception is a manual `vercel --prod` from a
  linked checkout, which is how the project was deployed before Git integration.
- **"Up to date before merging" is not optional.** Without it, two PRs can each
  pass CI independently and then merge in sequence, leaving `main` in a state
  neither one tested.
- `lint` is a required check. `react-hooks/rules-of-hooks` is the only thing in
  the suite that catches an early return drifting back above a hook — a bug that
  surfaces as a crash on a user interaction, not at build time.

If any of those jobs is ever renamed, the ruleset's required checks must be
renamed with it, or the gate silently stops requiring anything.

Preview deployments are **off**: `vercel.json` sets `git.deploymentEnabled` so
only `main` deploys. Previews never had `TURSO_*` env vars (those are set only
for `production`), so every one was a build whose API routes errored, and each
arrived with a bot comment. The `e2e` job — a real `next build` served locally
against a throwaway SQLite file — is the pre-merge check of the built app.

### How it got here

The migration off browser-only storage ran in stages, each one shippable: stand
up Turso and the ingest endpoint; move rows to the server so the per-minute
series stopped touching `localStorage`; move the derived aggregates so the
browser stopped loading the full series; and finally move the config itself, so
there was one owner rather than two.

The last stage was the one that mattered most, and the one that was overdue.
Until it landed, `localStorage` was the source of truth for config while Turso
held a write-only mirror that nothing read back — so a second browser seeded
itself from a stale bundled snapshot and its first edit overwrote the real
timeline. Everything derived from config was then computed against a config that
had never existed.

Still deferred, deliberately: **targeted recompute.** A config change can affect
any date, so rollups are recomputed over the whole range and stats over the whole
series on every write — including the daily sync. At ~196k rows that is fast, and making it incremental adds
state to get wrong. Revisit when a write takes more than a few seconds.

---

## Key Algorithms

### 1. Config-Aware Enrichment (`enrichRowsMultiConfig`)

**Problem**: A config window with `effectiveFrom = D` should apply to all data from D onward (and not retroactively change earlier data). This means analysis must use the config window active on each date, not just the current config. Crucially, `effectiveFrom` is the **real-world date the change took effect on the timer** — decoupled from when the user entered it in the app (`createdAt`). Editing a window's settings does not move its boundary.

**Algorithm**:
1. Sort `windows` oldest-first (by `effectiveFrom`)
2. Build a list of segments: `[{ fromDate: "0000-00-00", config: earliest }, { fromDate: w1.effectiveFrom, config: w1.config }, ...]`
3. For each row date, find its segment (the last segment whose `fromDate ≤ row.date`)
4. Group rows by segment index; call `enrichRows(batch, segment.config)` on each batch
5. Merge and sort all results by datetime

Windows are **contiguous**: window i covers `[effectiveFrom_i, effectiveFrom_{i+1})`, so exactly one config is active on any date — no gaps or overlaps are representable.

**Pre-history fallback**: data before the earliest window uses that **earliest window's config**, not `DEFAULT_CONFIG`. `DEFAULT_CONFIG` is a generic placeholder with wrong timer start times for real installations; the earliest window is always a better proxy for what the system looked like before the user started tracking changes.

**Shared helpers** (also in `lib/analyze.ts`, single source of truth for "which config when"):
- `activeWindowForDate(windows, date)` — the window active on a date (earliest covers the past).
- `windowDateRange(windows)` — derives each window's `effectiveTo` (day before the next start; last is open).
- `currentConfig(windows)` — the config active today, for "current" displays (names, billing).
- `diffConfigs(prev, next)` — structured human-readable diff powering the "changed vs. previous window" panel.

### 2. Multi-Program Enrichment (`enrichRows`)

For each date:
1. Compute the day-of-week (0=Mon … 6=Sun).
2. Build the day's ordered station windows via **`buildDaySchedule(config, dow)`** (extracted so the Analysis tab reuses the exact same reconstruction): for each timer, for each program A/B/C active that day (`enabled && days.includes(dow)`), walk `timer.stations` from `cursor = parseTimeToMinutes(program.start)`, emitting `{ stationId, name, timer, programId, startMin, endMin, durationMin, baselineGpm }` for each enabled, positive-duration station and advancing the cursor. Segments are returned in iteration order (timer1 A/B/C, then timer2) — the order enrichment relies on for first-match assignment.
3. Compute the detection window as `[min(all startMins), max(all endMins)]`.
4. Sum gallons within that window. If > `sprinklerOnThreshold` → `isSprinklerDay = true`.
5. Tag each row: walk windows in order; if `startMin < rowMin ≤ endMin`, assign that station/timer. Otherwise: `house`.

**Key properties:**
- Multiple programs from the same timer can be active on the same day (if their `days` overlap). Their windows are merged into a single ordered window list.
- A day with no active programs for either timer → `windowGallons = 0` → never a sprinkler day.
- Analytics (timer, station) are oblivious to the program dimension — a station watered by Program A or Program B looks identical in the output.

### 3. Chart Aggregation (`aggregateForChart`)
Groups `EnrichedRow[]` into time buckets (`day` / `week` / `month`), then sums gallons per breakdown level:
- **simple**: `{ house, sprinkler }` where sprinkler = sum of all non-house rows
- **timer**: `{ house, timer1, timer2 }`
- **station**: `{ house, [stationId]: gallons, ... }` — one key per active station

Anomaly detection runs on the totals: IQR method (`Q3 + 1.5 × IQR`). Bars above the upper fence get `isAnomaly: true`.

Time window → bucket mapping:
| Window | Bucket |
|---|---|
| 2W, 1M | day |
| 3M, 6M | week |
| 1Y, All | month |

### 4. Config-Change Markers on Chart
Config windows whose `effectiveFrom` falls within the visible date range are mapped to their nearest bar label. Rendered as Recharts `ReferenceLine x={label}` with a custom label component. The label shows change notes and is clickable — it deep-links to `/config?window=<id>` to edit that window.

### 5. Baseline Warning (`computeStationWarnings`)
- Lookback: last 21 calendar days of data
- Per station: compute daily avg gpm for each sprinkler day in window
- Walk from most-recent day backward, count consecutive days where daily avg > `baseline × 1.20`
- Fire if consecutive days ≥ 2 **and** recent overall avg > baseline by >20%
- Constants: `WARN_THRESHOLD = 0.20`, `WARN_MIN_DAYS = 2`

### 6. Timing & Flow Reconciliation (`reconcileDay`)

Reconciles a day's `ExpectedSegment[]` (from `buildDaySchedule`) against its actual `MinutePoint[]` (from `buildDayMinuteSeries`). Stations run back-to-back within a program, so a program's flow is one continuous run whose level steps between stations. Everything is tracked in **boundary space** — boundary `b` sits between minute `b` and `b+1`, and a station occupies on-minutes `(bPrev, bThis]`, matching enrichment's `startMin < rowMin ≤ endMin` convention so drifts compare directly to config.

Per program (grouped by `timer:programId`):
1. **On-threshold** — `onThresholdGpm` option, else `max(0.5, 0.4 × min baseline in the program)`, else `0.5`.
2. **Run detection** (`findProgramRun`) — scan `[progStart − driftSearch, progEnd + driftSearch + maxDelay·n]` (default `driftSearch = 10`) for contiguous "on" stretches (flow ≥ threshold), then **merge stretches separated by ≤ `maxDelayMin` (default 5)** — an inter-station delay fragments a program into one stretch per station, and picking a single fragment would truncate the program at its first delay. Pick the merged run with the greatest overlap with the configured span (else the longest). Its first on-minute − 1 = the run's start boundary; its last on-minute = the end boundary. `progDrift = runStartBoundary − progStart`. The gaps between fragments are retained — they are what `inferStationDelay` measures.
3. **Interior boundary refinement** — anchor boundary `i` at `configStart + progDrift + i × (observed stretch / transitions)`, then search ±4 min around it for the minute with the largest flow step (max `|mean(left window) − mean(right window)|`, window = 3 min, clamped monotonic inside the run). If the best step `< minStepGpm` (default `0.5`) the adjacent levels are indistinguishable: fall back to the shifted configured boundary and mark the boundary **low-confidence**.
4. **Sustained gpm** — mean over each station's interval **excluding its first and last minute** (adjacent-station bleed). Runs ≤ 3 min have no clean interior → full mean, **low-confidence**.
5. Emit per station: `actualStart/End/Duration`, trimmed `actualGpm`, `startDriftMin`, `durationDriftMin`, `gpmDeltaPct`, `gapBeforeMin` (measured dead time before this station), and a `confidence` (`low` if a run was missing, ≤3 min, or sat on an ambiguous boundary).

A program with no detected run yields all-null actuals (low-confidence). Two enabled programs on the same timer/day produce two independent runs for the same station — reconciled separately (the reconciliation table shows both; the chart's station chips dedupe by id).

The Analysis tab's per-row / bulk actions translate a `SegmentReconciliation` into a config edit on the **window active on the selected day** (`activeWindowForDate`) via `updateWindow`: baseline → `station.baselineGpm`; start → shift `program.start` by `startDriftMin` (per-station starts derive from program start + upstream durations); duration → `programStation.durationMin`. "Calibrate from this day" applies all three across every detected station at once.

### 7. Inter-Station Delay Inference (`inferStationDelay` / `recommendStationDelays`)

**Problem**: controllers insert dead time between closing one station's valve and opening the next. It is vendor-specific, invisible in the config model, and it accumulates — station *i* starts ~*i × delay* late and the program overruns by *(n−1) × delay*. Left unmodelled, the only tool the app offered for that drift was the per-station duration proposal, which would bake a hardware delay into run times and over-water every zone.

**Why elongation ÷ transitions is the wrong estimator**: a program's overrun has two causes — dead time *and* stations running longer than configured — and they need opposite fixes. On the reference data (26 sprinkler days, config window effective 2026‑07‑01) timer 2 overran by exactly 16 min over 10 transitions on 20 of 26 days. Dividing gives 96 s; a residual-sum-of-squares grid search over the delay converges on 95 s. Both over-attribute. The **gaps between detected on-runs measure a clean 60 s** (modal gap 1 min, 105 of 114 observations). The other ~36 s per transition is duration overrun.

**Algorithm** (per `timer:programId`, per day):
1. `findProgramRun` — the merged run plus the gaps between its fragments.
2. **Elongation** — `observedSpan − configuredSpan`. Measured against the configured span, which already contains whatever delay is currently set, so the estimate is additive and the whole thing is idempotent: once the right delay is saved, elongation goes to zero and the next fit recommends the same value rather than stacking another one on.
3. **Estimate** — the **modal measured gap** when at least two gaps are visible (median if the mode holds < 50%, which usually means dry stations are fragmenting the run rather than delays). When no gap ever blanks a whole 1-minute bin, fall back to `configuredDelay + elongation / transitions`, held to a `minDelaySec` floor (default 15 s) so a rounding artifact never becomes a config edit.
4. **Confidence gate** — a baseline-free piecewise-constant RSS fit (`piecewiseRss`: score every minute against the mean of the segment it lands in, gap minutes pooled separately) must beat a zero-delay model by ≥ 10%. Deliberately baseline-free: once a run has drifted, the configured baselines are being compared against the wrong stations. A run *shorter* than its configured span never completed (rain-sensor abort, manual stop) and is excluded — its gaps are real but its residual is meaningless.
5. **Decomposition** — `delayExplainedMin = (delay − configuredDelay) × transitions`, `residualMin = elongation − delayExplained`. Both are surfaced; the residual stays visible as duration drift for the per-station proposals.
6. `recommendStationDelays` — median across the days that passed the gate, rounded to 5 s, with the day count and spread.

Served by `GET /api/delay?days=N` (server-side: the fit needs many days of per-minute flow and the browser holds one), rendered by `StationDelayCard`, staged via `buildDelayChange` through the same review-and-save path as every other proposal. Saving re-attributes stored rollups, since `buildDaySchedule` feeds `enrichRows` — already handled by the recompute that `PUT /api/config` runs on every save.

On the reference data this yields **timer 1: no delay** (0 of 26 days; its run tracks configuration to within a minute) and **timer 2: 60 s** (20 of 26 days, range 60–60 s), which pulls timer 2's last station from 16 min of start drift down to 6 min — the remaining 6 min being genuine duration drift. `lib/__tests__/analyze.test.ts` asserts this against committed fixtures (`data/sprinkler-config-2026-08-31.json`, `data/day-2026-08-28.json`).

---

## State Management

### Zustand Store
```ts
{
  windows: ConfigWindow[]       // sorted ascending by effectiveFrom; the active
                                // window for today is the "current" config
  maintenance: Record<string, MaintenanceFlag>  // station id → flag (top-level)
  serverVersion: number         // bumped after any server write → pages refetch
  rowCount: number              // cosmetic total row count (status labels)
  lastRowDate: string | null    // latest stored date (Sync card, incremental Flume export link)

  addWindowFromDate(date, notes)  // clone the config active on `date` → new window
  updateWindow(id, patch)         // edit config/notes/effectiveFrom in place (no new
                                  // window; changing effectiveFrom moves only this boundary)
  deleteWindow(id)                // remove a window (last one cannot be deleted)
  copyBaselinesForward(id)        // apply this window's baselines to all later windows
  setStationMaintenance(id, flag) // set (or clear, with null) a station's maintenance flag
  bumpServerVersion()             // signal server data changed → pages refetch
  setRowCount(n) / setLastRowDate(d)
}
```

**No `rows` in the store.** The per-minute series is not held in the browser at
all — `rows`, `rowsVersion`, `appendRows`, `setRows`, `clearRows` and the
`deriveData` memo cache are gone. Pages read the server aggregates instead; a
single day is fetched on demand. That is what fixed the `QuotaExceededError` at
the root.

**No persistence at all.** `persist`, `createJSONStorage`, `partialize`,
`migrate`, `onRehydrateStorage` and `skipHydration` were all removed with the
second source of truth. The store starts empty, `StoreProvider` fills it from
`/api/config` + `/api/stats`, and `loaded` says whether that has happened.
Nothing survives a refresh, because nothing needs to. The Analysis tab's
config-edit actions reuse `updateWindow`; only maintenance flags need
`setStationMaintenance`.

**The server owns the config; the browser holds a copy.** On mount,
`StoreProvider` fetches `/api/config` (windows + maintenance + authMode) and
`/api/stats` (`rowCount`/`lastDate`) and sets `loaded`. Nothing is persisted in
the browser and nothing is seeded from the bundle. Each page fetches
`/api/rollup` + `/api/stats` (and `/api/day/[date]` for per-minute views) in an
effect keyed on `serverVersion`, and every page gates on `loaded` rather than
rendering against an empty window list.

Every config mutation goes through one path: the store's `commit` helper calls
`PUT /api/config`, which validates the document, writes windows and maintenance
in a **single** `db.batch`, recomputes rollups and stats, and returns what it
stored — which the store then adopts in place of its own optimistic value. A
failed save rejects and leaves state untouched. Uploads `POST /api/rows` (rows
only; a `windows` field is a 400), and "Clear all data" issues `DELETE
/api/rows`, which clears rows and derived tables but never the config.

This replaced a debounced `useStore.subscribe` that mirrored localStorage into a
`config_windows` table nothing ever read back. That arrangement is what broke the
config: a second browser started from a stale bundled snapshot and its first edit
pushed that snapshot over the real timeline. There is one copy now, and one
writer.

### SSR safety
There is no persisted client state to rehydrate, so the class of hydration
mismatch this section used to describe cannot occur: the server and the browser
both start from an empty store. `StoreProvider` fetches after mount and flips
`loaded`; every page renders a skeleton until then rather than rendering against
an empty window list, which would silently use `DEFAULT_CONFIG` for billing and
station names.

One SSR detail does still matter: `app/layout.tsx` reads the session cookie per
request to decide whether to show "Log out". Asking the session module alone
baked the answer in at **build** time, when no credentials are set — so the deployed
app showed a logged-in user no way to log out. The e2e suite caught that; nothing
about the source would have.

### Performance
Enrichment runs server-side at write time, and the pages read precomputed
aggregates keyed on `serverVersion`. The heavy client-side work that used to block
navigation — `enrichRowsMultiConfig` over the entire series, in the browser — is
gone.

`ConsumptionChart` still uses `useDeferredValue` for its window and breakdown
buttons, so the highlight moves at once while the bars re-aggregate. That is
cheap now, and deferring it keeps it off the click.

The Dashboard splits its computation into three memos:
- **`derived`** — reconstructs `DailyRow[]` and a synthetic `EnrichedRow[]` from the rollup feed (`rollupsToDailyRows`, `rollupsToEnriched`), plus the date range, `sprinklerDates` and `defaultFlowDay`. Reruns when rollups or config change.
- **`monthlySummary`** — filters `allDaily` by the selected month and calls `computeSummary`; reruns when the month selector changes.
- **`flowDayStats`** — enriches the one fetched day (`/api/day/[date]`) with that day's config, calls `buildStationStats` + `computeSummary`, and resolves the active window via `activeWindowForDate`. Reruns when the selected day or its rows change.

---

## Config Migration

Old configs (before multi-program support) stored `start` and station `durationMin`/`enabled` directly on the timer. The migration function `migrateConfig(rawConfig)` in `lib/types.ts` detects old format (presence of `timer1.start`) and converts:

1. `timer1.start` + `sprinklerDays` → `timer1.programs.A.{ start, days }`
2. `station.{ durationMin, enabled }` → `programs.A.stations[id].{ durationMin, enabled }`
3. `station.{ id, name, baselineGpm }` → `timer1.stations[id].{ id, name, baselineGpm }`
4. Programs B and C initialized as `{ enabled: false, start: timer.start, days: [], stations: {} }`
5. Top-level `sprinklerDays` removed

Migration is idempotent: new-format configs pass through unchanged.

### Windows migration (`toWindows`)

A second migration converts the legacy store shape (`{ config, configHistory }`, where each
`ConfigVersion.savedAt` implicitly defined a boundary) into the `ConfigWindow[]` model. `toWindows`
in `lib/types.ts` accepts any of: new `{ windows }`, legacy `{ config, configHistory }`, or a lone
`{ config }`. Each legacy version's `savedAt` date becomes a window's `effectiveFrom`. It also runs
`migrateConfig` and `normalizeTime` on every config (the latter fixes the old malformed
`"03:45:00:00"` start-time bug).

Both migrations are applied:
- In `readWindows()` — defensive normalisation of whatever shape is already stored
- In `ExportImportCard.applyBundle` — when importing a JSON file or URL (old exports still load)

The localStorage paths that used to apply them (`store.ts` persist `migrate` and
`onRehydrateStorage`, and the `default-config.json` load in `StoreProvider.tsx`)
are gone with the persistence itself.

---

## Config Windows

```ts
interface ConfigWindow {
  id: string          // stable unique id (crypto.randomUUID)
  effectiveFrom: string // "YYYY-MM-DD" — when this took effect on the timer (editable)
  notes: string       // user change notes
  config: AppConfig   // full snapshot (timers + billing)
  createdAt: string   // ISO — when created in the app (bookkeeping)
  updatedAt: string   // ISO — last edit (bookkeeping)
}
```

The key design decision: **`effectiveFrom` (real-world change date) is decoupled from `createdAt`/
`updatedAt` (when it was entered/edited in the app)**. Tuning a window edits it in place and only
bumps `updatedAt` — the boundary never moves. Establishing a change at a past date sets
`effectiveFrom` explicitly. Adjusting a window's range edits `effectiveFrom` (contiguity makes the
previous window's end follow automatically).

Windows are never auto-pruned; the user deletes them explicitly (the last one cannot be deleted).

**Time-aware analysis**: all analysis functions accept `windows` and use `enrichRowsMultiConfig` to apply the active window's config per date range.

---

## Getting data in: sync and CSV

**Flume sync** (`SyncCard` on the Config page) calls `POST /api/sync`, which runs
`syncFlumeData` — the same function the daily cron calls. See
*Getting data in (Flume API, or a CSV)* above for how it works.

**CSV upload** (`UploadCsvCard` on the Config page) has two inputs:
- **File**: Papa Parse reads the `File` directly (no full string copy)
- **URL**: `fetch(url)` → text → Papa Parse. GitHub blob URLs are rewritten to `raw.githubusercontent.com`

`parseFlumeCsvRows` (`lib/csvImport.ts`) matches `datetime | Datetime | DateTime`
and `gallons | Gallons`, and drops rows it cannot read. `POST /api/rows` then
validates what is left — a malformed or timezone-suffixed datetime is a 400, not a
silent skip — and `INSERT OR IGNORE` on the `datetime` primary key makes an
overlapping upload safe.

The card also links to Flume's export page, starting from the last stored date
(`buildFlumeExportUrl`), so a CSV only needs to cover the gap.

---

## Testing

| Command | What runs |
|---|---|
| `npm run test:coverage` | Vitest, with coverage thresholds enforced over `lib/**` and `app/api/**` (statements 85, branches 75, functions 82, lines 87). **This is CI's gate** — `npm test` runs the same tests without the thresholds, so it can pass where CI fails |
| `TZ=<zone> npx vitest run` | CI repeats the unit suite under `UTC`, `Pacific/Kiritimati` (UTC+14), `Pacific/Midway` (UTC−11) and `Asia/Kolkata` (UTC+5:30), so "identical in every zone" is tested rather than assumed |
| `npm run test:e2e` | Playwright against `next start` on a throwaway SQLite database. Build first (`npm run build`) and install the browser once (`npx playwright install chromium`) |

### Unit and component tests (`lib/__tests__/`)

| File | Covers |
|---|---|
| `analyze.test.ts` | Enrichment (programs, multi-window, pre-history), schedule reconstruction, reconciliation, run detection and delay inference, warnings, chart aggregation and anomalies, rollup reconstruction, date helpers, config diff and migration |
| `staging.test.ts` | Staged-edit keys, no-op detection, applying and proposing changes |
| `csvImport.test.ts` | CSV column matching and the Flume export link |
| `store.test.ts` | Window actions, maintenance flags, and the write path through `PUT /api/config` |
| `serverData.test.ts` | Data access, rollup and stats recompute against an in-memory database |
| `routes.test.ts` | `/api/rows` (validation, the rejected `windows` field, delete), `/api/config`, `/api/day`, `/api/rollup`, `/api/stats`, `/api/health`, `/api/delay` |
| `flume.test.ts` | Flume client: refresh grant, device list, usage query shape (per-minute, no `operation`), error detail |
| `flumeState.test.ts` | Reading, saving and clearing the stored token; its precedence over the env seed |
| `sync.test.ts` | Token rotation persisted before queries, device selection, the query window, 12-hour slices, the 50-query budget, idempotent ingest |
| `syncRoutes.test.ts` | `/api/sync` and `/api/cron`, including `CRON_SECRET` failing closed |
| `session.test.ts`, `google.test.ts`, `authRoutes.test.ts`, `proxy.test.ts` | Auth modes, cookie signing and allow-list, the OAuth flow, and the guard's matcher |
| `FlowTimelineChart`, `ReviewChangesModal`, `StationDelayCard` `.test.tsx` | Component rendering and interaction |

### End-to-end (`e2e/smoke.spec.ts`)

The server runs with fake Google credentials and a test `SESSION_SECRET`, so the
guard is genuinely enforced: the suite signs its own session cookie for the
signed-in tests, and an anonymous group checks that pages redirect and API routes
return 401 — including `/api/cron`, which sits outside the guard but refuses
without `CRON_SECRET`. Signed in, it seeds through the API and checks the derived
pipeline, that clearing data keeps the config timeline, that a second browser sees
the config the first one saved, security headers, sign-out, and that the dashboard,
analysis and config pages render.

---

## Component Notes

### `StationFlowChart` props
```ts
interface Props {
  stats: StationStats[]
  config: AppConfig
  selectedDay: string | null
  sprinklerDates: string[]
  onDayChange: (date: string) => void
  configVersionLabel?: string | null   // e.g. "Jun 3, 2026" — date of the config active on selectedDay
}
```

`configVersionLabel` is resolved in `page.tsx`'s `flowDayStats` memo via `activeWindowForDate(windows, day)` (the same lookup `enrichRowsMultiConfig` uses), formatting that window's `effectiveFrom`. It is passed into a custom Recharts `<Tooltip content={…}>` that renders:
- Avg GPM (measured)
- Baseline GPM (orange) + % delta (green / red / blue)
- "Config from [date]" footer row (hidden when no history exists)

### `FlowTimelineChart` (Analysis hero)
A Recharts `ComposedChart` over minute-of-day for one selected day: a blue `Area` of actual gpm plus an orange `stepAfter` `Line` of the configured baseline (`connectNulls={false}`, so it draws only over configured windows). Viewable range is the union of configured + detected spans, padded 15 min. A `<Brush>` controls zoom (its `startIndex/endIndex` are state); station chips set those indices to a station's window and, when a station is selected, the chart overlays a `ReferenceArea` band plus configured-start (solid) and detected-start (dashed) `ReferenceLine`s. Chips dedupe by station id (a station can appear in multiple programs). Selection state is lifted to the page so the reconciliation table row highlights in sync.

### `ReconciliationTable` (Analysis) — staged edits
Renders `SegmentReconciliation[]` with cfg→actual start / duration / gpm columns, drift badges, a `≈` low-confidence marker, and a separate maintenance column. Row click toggles the chart's selected station.

The "Propose config change" buttons **do not write** — they call `onToggleStage(r, kind)` to add/remove a proposed edit from the page's staged set (button labels carry the concrete target value; staged buttons render filled with a ✓). Buttons are disabled when the change would be a no-op (value already matches, or no run detected). The **start** proposal is a program-level knob, so it is rendered only on each program's first station (lowest `cfgStartMin`). Maintenance (`onToggleMaintenance`) writes immediately via `setStationMaintenance` (reversible toggle, optional `window.prompt` note).

### Staged-changes model (`lib/staging.ts` + Analysis page)
The decision logic is a **pure module** (`lib/staging.ts`, no React, unit-tested):
- `stageKey(r, kind)` — stable key; `start` is per-program (`timer:program:start`, last write wins), baseline/duration per-station.
- `wouldChange(r, kind)` — is this edit a no-op? (used to disable buttons and filter "stage all").
- `buildStagedChange(r, kind)` — a `{ key, area, field, fromText, toText, note?, apply(cfg) }`; `apply` mutates a config (baseline → station, duration → program-station, start → shift `program.start` by drift).
- `programStartStations(recon)` — first station per program (where the start proposal is offered).
- `proposeAllChanges(recon)` — all meaningful changes (one start per program) for "stage all".
- `applyStagedChanges(config, changes)` — deep-clones and applies; input untouched.

The page is the thin UI shell: it holds staged edits in a single state object `{ ctx, map, review }` where `ctx = "${day}|${winId}"`, and resets it **during render** when `ctx` changes (the React "reset on prop change" pattern — no effect). `ReviewChangesModal` lists the staged entries grouped by area as `old → new` (removable). **Save** calls `applyStagedChanges` then `updateWindow` **once**, and clears the set. Nothing is persisted until Save.

### `ReviewChangesModal`
A lightweight overlay listing staged `StagedItem[]` grouped by area, each with a `remove` action, plus **Save to config** / **Cancel**. Purely presentational — all state lives in the Analysis page.

---

## Routing

Every route renders dynamically: `app/layout.tsx` reads the session cookie per
request (see *SSR safety*). The pages themselves are client components.

| Route | Notes |
|---|---|
| `/` | Dashboard |
| `/analysis` | Timing & flow calibration |
| `/config` | Config editor, Flume sync, CSV upload, export/import, stored data |
| `/day/[date]` | `date` = `YYYY-MM-DD` |
| `/about` | What the app is and where its data comes from |
| `/design` | Design-system showcase |
| `/login` | Google sign-in; the only page outside the guard |

---

## Known Limitations & Future Work

| Issue | Notes |
|---|---|
| `enrichRows` is O(n) synchronous | OK to ~1M rows; now runs server-side at ingest, off the browser's main thread |
| ~~localStorage ~5MB limit~~ | **Resolved.** The browser persists nothing at all now — `persist` and its machinery are gone, and every byte lives in Turso. See [Storage & Backend Architecture](#storage--backend-architecture) |
| ~~Full row series loads into browser memory~~ | **Resolved.** The browser never loads the full series: dashboard/analysis read `/api/rollup` + `/api/stats`, and per-minute views fetch a single day via `/api/day/[date]`. `GET /api/rows` was removed outright |
| ~~Config has two sources of truth~~ | **Resolved.** The server owns config; `GET`/`PUT /api/config` are the only reader and writer, and the browser holds an in-memory copy it re-fetches on load |
| Precomputed stats freeze `currentConfig`/"today" at last write | `station_stats` / `station_warnings` (and the warning 21-day lookback) are computed with `currentConfig(windows)` at recompute time. Recompute runs on every ingest — which now includes the daily Flume sync — and every window edit, so they are at most a day old. The remaining drift is a sync that fails for several days running while "today" crosses into a future-dated window |
| Stats recompute over the whole series on every write | `recomputeStats()` re-enriches all rows each write (in addition to `recomputeRollups`), so two full enrichment passes per upload. Fine for a single-home dataset; making both incremental is deferred until a write takes more than a few seconds |
| ~~Server rollups depend on process `TZ`~~ | **Resolved.** `localDateAndMin` parses Flume's naive timestamps lexically, so enrichment never reads the process timezone. `APP_TIMEZONE` and the `process.env.TZ` assignment are gone, and CI's four-timezone loop proves the output is identical in every zone rather than assuming it |
| Full-range recompute per write | A config-window change can affect any date, so the whole range is recomputed (rollups) / whole series re-enriched (stats). Targeting it adds state to get wrong, and is deliberately deferred |
| The CSV parser drops rows it cannot read | `parseFlumeCsvRows` skips them in the browser without counting them. What reaches the server is validated, and a bad datetime there is a 400 |
| Config `effectiveFrom` resolution is 1 day | Two windows can't share a date (enforced in the editor); sub-day changes aren't representable |
| IQR anomaly detection is naive | No seasonal adjustment; many weeks of data needed before IQR is meaningful |
| Programs A and B on same timer same day | Both programs' windows are merged; if they overlap in time, first-match wins |
