# SprinklerFun

A client-side web app for analyzing [Flume smart meter](https://flumewater.com) data to understand and optimize residential sprinkler water usage. No backend, no accounts — everything runs in the browser.

## What it does

Upload a Flume CSV export and the app shows you:

- **Dashboard** — station alerts (red if a zone is running >20% above its baseline for 2+ days); monthly summary cards (total / sprinkler / house gallons, estimated cost) with ← month → navigation; a unified consumption chart with configurable time windows (2W–All) and breakdown levels (simple / by timer / by station); and a per-station flow rate chart for a single day with prev/next navigation, day-scoped summary tiles, and a hover tooltip showing avg gpm, baseline gpm, % delta, and active config version. Clicking a bar in the 2W or 1M chart jumps the per-station chart to that day.
- **Analysis** — *Timing & Flow Calibration*. Pick a sprinkler day and see its per-minute actual flow charted against the configured schedule: a blue actual-gpm area overlaid with the orange configured-baseline step, so timing drift (x-axis) and flow-rate drift (y-axis) are visible at a glance. Zoom with the brush or click a station to focus its window (with configured-vs-detected start markers). A reconciliation table lists, per station, configured→actual start, duration, and gpm (with % delta and a low-confidence marker), and lets you push the measured actuals back into the active config window — set a station's baseline, shift a program's start, set a station's duration, or **Calibrate config from this day** in one click — or flag a station for maintenance (surfaced on the dashboard). A **Fleet Overview** section keeps the cross-day per-station averages (total gallons, avg/std gpm, % of sprinkler, cost).
- **Day Detail** — minute-by-minute stacked area chart for any single sprinkler day.
- **Configuration** — organized as a **timeline of config windows**. Each window has an explicit *effective date* (when the change took effect on the timer) and stays active until the next window. Tune a window in place without moving its boundary; start a new window on the date you actually changed settings (it inherits the prior config); or adjust a window's dates. Each timer still supports three independent programs (A, B, C) with their own start time, days, and per-station duration; baseline gpm and run order are shared hardware properties. Window effective dates appear as markers on the consumption chart — distinguishing "usage jumped because I changed the schedule" from "usage jumped for no obvious reason."

## Getting started

```bash
npm install
npm run dev        # http://localhost:3000
```

### First-time setup
1. Open the app → click **Upload CSV** and load your Flume export.
2. Go to **Config** → **Create first config** (or **＋ New config**), set its effective date, and verify your timer start times and station list.
3. Enter baseline gpm per station (or skip until your next seasonal audit).
4. **Save window** → return to Dashboard.

### Weekly check-in (< 2 min)
1. Upload your new CSV → data appends, duplicates skipped.
2. Scan **Station Alerts** for red warnings.
3. Review the **Consumption Chart** (1M window) for anomaly markers (⚠) or unexpected step-changes.
4. Click a suspicious bar → **Per-Station Flow Rate** chart updates to that day; hover a bar to see gpm vs. baseline and the active config version.

## Project layout

```
├── app/                    # Next.js App Router pages
│   ├── page.tsx            # Dashboard (/)
│   ├── analysis/           # Per-station analysis (/analysis)
│   ├── config/             # Configuration editor (/config)
│   └── day/[date]/         # Day detail (/day/YYYY-MM-DD)
├── components/             # React components
├── lib/
│   ├── types.ts            # Shared interfaces (ConfigWindow), DEFAULT_CONFIG, migrateConfig, toWindows
│   ├── analyze.ts          # Core analysis logic (pure functions)
│   ├── store.ts            # Zustand store with localStorage persistence
│   └── __tests__/          # Vitest unit tests
├── docs/
│   ├── PRODUCT_DESIGN.md   # Feature spec, user flows, design principles
│   ├── TECHNICAL_DESIGN.md # Stack choices, architecture decisions
│   └── SprinklerFun-20241019.ipynb  # Original Jupyter prototype
└── data/                   # Exported config snapshots (JSON) for version control
```

## Saving your config to git

The app stores config in `localStorage`. To back it up, export it from the Config page and save the JSON to `data/`. Naming convention: `config-YYYY-MM-DD-notes.json`. Commit after each seasonal audit so your baseline gpm history is version-controlled alongside the code.

## Tech stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router) |
| Language | TypeScript |
| Styling | Tailwind CSS v4 |
| Charts | Recharts 3 |
| State | Zustand + `persist` (localStorage) |
| UI components | shadcn/ui |
| CSV parsing | Papa Parse |
| Testing | Vitest |
| Hosting | Vercel |

## Running tests

```bash
npm test           # run once
npm run test:watch # watch mode
npm run test:ui    # Vitest UI
```

## Deploying

The app is configured for zero-config Vercel deployment (`vercel.json` at root). Push to main → Vercel builds and deploys automatically.

## Docs

- [Product Design](docs/PRODUCT_DESIGN.md) — user persona, feature spec, user flows, design principles, V1 scope
- [Technical Design](docs/TECHNICAL_DESIGN.md) — architecture, data model, key design decisions
