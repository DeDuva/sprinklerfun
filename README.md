# SprinklerFun

A web app for analyzing [Flume smart meter](https://flumewater.com) data to understand and optimize residential sprinkler water usage. It runs on Vercel, keeps its data in Turso, and is behind Google sign-in limited to a short list of approved accounts — so the same numbers and the same config show up on every device you open it on.

## What it does

Meter data arrives on its own: a Vercel cron pulls the latest readings from the Flume Personal API once a day, and **Config → Flume sync → Sync now** fetches them on demand. A Flume CSV export can still be uploaded, for history older than the API serves. From that data the app shows you:

- **Dashboard** — a red notice if the Flume meter goes offline and an amber one when its battery is low (a silent meter otherwise looks like zero usage); Flo's plain-English headline for the month; station alerts (red if a zone is running >20% above its baseline for 2+ days); monthly summary cards (total / sprinkler / house gallons, estimated cost) with ← month → navigation; a unified consumption chart showing the last two weeks by default, with wider windows up to All and breakdown levels (simple / by timer / by station); and a per-station flow rate chart for a single day with prev/next navigation, day-scoped summary tiles, and a hover tooltip showing avg gpm, baseline gpm, % delta, and active config version. Clicking a bar in the 2W or 1M chart jumps the per-station chart to that day.
- **Analysis** — *Timing & Flow Calibration*. Pick a sprinkler day and see its per-minute actual flow charted against the configured schedule: a blue actual-gpm area overlaid with the orange configured-baseline step, so timing drift (x-axis) and flow-rate drift (y-axis) are visible at a glance. Zoom with the brush or click a station to focus its window (with configured-vs-detected start markers). A reconciliation table lists, per station, configured→actual start, duration, and gpm (with % delta and a low-confidence marker). Its buttons **propose** config edits (baseline / program start / duration) rather than writing them: they stage changes for review, and **nothing is saved until you Review & Save** — a dialog shows every change as `old → new`, individually removable, written to the active config window only on confirm. **Stage all changes from this day** proposes everything at once. A **Station Delay** card infers, per timer, the dead time the controller inserts between stations — measured from the gaps in your meter data across recent sprinkler days — and splits a program's overrun into the part the delay explains and the part that is stations running long, so the two get fixed separately rather than the delay being absorbed into run times. Stations can also be flagged for maintenance (surfaced on the dashboard). A **Fleet Overview** section keeps the cross-day per-station averages (total gallons, avg/std gpm, % of sprinkler, cost).
- **Day Detail** — minute-by-minute stacked area chart for any single sprinkler day.
- **Configuration** — organized as a **timeline of config windows**. Each window has an explicit *effective date* (when the change took effect on the timer) and stays active until the next window. Tune a window in place without moving its boundary; start a new window on the date you actually changed settings (it inherits the prior config); or adjust a window's dates. Each timer still supports three independent programs (A, B, C) with their own start time, days, and per-station duration; baseline gpm, run order and station delay are shared hardware properties. Window effective dates appear as markers on the consumption chart — distinguishing "usage jumped because I changed the schedule" from "usage jumped for no obvious reason." The page also holds the data controls: **Flume sync**, **Upload CSV Data**, config export/import, and **Stored data** (clear everything behind a typed confirmation).
- **About** — what the app is and where its data comes from, with a link to the design system page.

## Getting started

```bash
npm ci
npm run dev        # http://localhost:3000
npm run seed:dev   # in another terminal: a config and one fixture day, through the API
```

Locally no environment variables are needed: the database falls back to `./.data/sprinkler.db` and, with no Google credentials set, sign-in is skipped. `.env.example` documents every variable production uses.

### First-time setup
1. Connect Flume once, from your own machine: `npm run flume:connect` prints a refresh token, and the Flume variables go into Vercel. [`docs/RUNBOOK.md`](docs/RUNBOOK.md#connecting-flume-and-what-to-do-when-it-stops) has the steps. Your Flume password is never stored anywhere.
2. Sign in with Google, go to **Config → Flume sync → Sync now**. The first sync backfills the last 20 days. For older history, upload a Flume CSV export under **Upload CSV Data**.
3. **Config → Create first config** (or **＋ New config**), set its effective date, and verify your timer start times and station list.
4. Enter baseline gpm per station (or skip until your next seasonal audit).
5. **Save window** → return to Dashboard.

### Weekly check-in (< 2 min)
1. Open the app. Yesterday's readings are already there. **Sync now** on Config fetches anything since.
2. Scan **Station Alerts** for red warnings.
3. Review the **Consumption Chart** (it opens on the last two weeks) for anomaly markers (⚠) or unexpected step-changes.
4. Click a suspicious bar → **Per-Station Flow Rate** chart updates to that day; hover a bar to see gpm vs. baseline and the active config version.

## Project layout

```
├── .github/workflows/      # ci.yml (types + tests, lint, e2e, audit) · backup.yml (daily dump)
├── proxy.ts                # The sign-in guard in front of every route
├── vercel.json             # main-only deploys + the daily /api/cron schedule
├── scripts/                # flume:connect, seed:dev, backup, fixtures, verify:prod (none run in CI)
├── app/                    # Next.js App Router
│   ├── page.tsx            # Dashboard (/)
│   ├── analysis/           # Timing & flow calibration (/analysis)
│   ├── config/             # Config timeline, Flume sync, CSV upload, stored data (/config)
│   ├── day/[date]/         # Day detail (/day/YYYY-MM-DD)
│   ├── about/  login/      # About page · Google sign-in page
│   ├── design/             # Design-system showcase (/design)
│   └── api/                # Route handlers: config, rows, rollup, stats, day, delay, sync, cron, health, auth
├── components/             # React components
├── lib/
│   ├── types.ts            # Shared interfaces (ConfigWindow), DEFAULT_CONFIG, migrateConfig, toWindows
│   ├── analyze.ts          # Core analysis logic (pure functions, shared by server and browser)
│   ├── store.ts            # Zustand store — in-memory copy of the server's config
│   ├── server/             # Server-only: data access, Flume client + sync, sessions, Google OAuth
│   └── __tests__/          # Vitest unit tests
├── e2e/                    # Playwright smoke tests against a real build
├── docs/
│   ├── PRODUCT_DESIGN.md   # Feature spec, user flows, design principles
│   ├── TECHNICAL_DESIGN.md # Architecture, data model, key design decisions
│   ├── RUNBOOK.md          # Operating the deployment: access, Flume, backups, restores
│   └── SprinklerFun-20241019.ipynb  # Original Jupyter prototype
└── data/                   # Config snapshots + generated (synthetic) flow fixtures
```

## Saving your config to git

The app stores config on the server, in Turso — not in your browser. It is read back by every device, so there is nothing to keep in sync and nothing to commit for the app's benefit. Exporting from the Config page is for *your* records: a file to keep before a big change, and the way back if the stored config ever looks wrong. Daily backups cover the same ground automatically (see `docs/RUNBOOK.md`).

**Config only — never metered data.** The config snapshots hold station names, durations and baseline gpm, none of which identify anything. A CSV export is different: at one-minute resolution it reveals when the house wakes, showers and sits empty, and this repository is public. The fixtures under `data/` are generated:

```bash
npm run fixtures     # regenerate the synthetic fixtures
npm run verify:prod  # check the analysis against live data (local only, read-only)
```

See [SECURITY.md](SECURITY.md) for what is and isn't protected.

## Tech stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router) |
| Language | TypeScript |
| Styling | Tailwind CSS v4 |
| Charts | Recharts 3 |
| State | Zustand (in-memory; the server owns the data) |
| Database | Turso (libSQL / SQLite) |
| Data in | Flume Personal API, pulled daily by a Vercel cron; CSV upload for older history |
| Auth | Google sign-in + email allow-list → signed httpOnly cookie, enforced in `proxy.ts` |
| UI components | shadcn/ui |
| CSV parsing | Papa Parse |
| Testing | Vitest + Playwright |
| Hosting | Vercel |

## Running tests

```bash
npm run test:coverage  # unit tests with coverage thresholds — what CI runs
npm run test:e2e       # Playwright against a production build (npm run build first;
                       # npx playwright install chromium once)
npm run test:watch     # watch mode
npm run test:ui        # Vitest UI
```

`npm test` runs the same unit tests without coverage, so it can pass where CI fails on a threshold. CI also runs the unit tests under four timezones.

## Deploying

Zero-config Vercel deployment (`vercel.json` at root). Vercel builds production from `main` on every merge.

The gate is at the **merge**, not the deploy — Vercel has no "wait for CI" setting, so a branch ruleset on `main` requires the `types + tests`, `lint`, `e2e` and `audit` checks, requires a PR, and requires the branch to be up to date. Nothing red reaches `main`, and production only ever builds from `main`:

```
PR ──→ types + tests, lint, e2e, audit ──→ [ruleset] ──→ merge ──→ Vercel deploys production
              │
              └─ red ⇒ merge blocked ⇒ nothing deploys
```

That is why there is no deploy job in CI and no Vercel token in repo secrets — branch protection provides the guarantee a token would have bought. See [Technical Design](docs/TECHNICAL_DESIGN.md) for details.

## Docs

- [Product Design](docs/PRODUCT_DESIGN.md) — user persona, feature spec, user flows, design principles, V1 scope
- [Technical Design](docs/TECHNICAL_DESIGN.md) — architecture, data model, key design decisions
- [Runbook](docs/RUNBOOK.md) — access, connecting Flume, backups, restores, settings that live outside the repo
- [Security](SECURITY.md) — what sign-in protects, and what it deliberately does not
