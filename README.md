# SprinklerFun

A client-side web app for analyzing [Flume smart meter](https://flumewater.com) data to understand and optimize residential sprinkler water usage. No backend, no accounts — everything runs in the browser.

## What it does

Upload a Flume CSV export and the app shows you:

- **Dashboard** — station alerts (red if a zone is running >20% above its baseline for 2+ days), summary cards (total / sprinkler / house gallons, estimated cost), a unified consumption chart with configurable time windows (2W–All) and breakdown levels (simple / by timer / by station), and per-station flow rates vs. baselines.
- **Analysis** — sortable table of per-station totals, average gpm, std deviation, and estimated cost across all loaded data.
- **Day Detail** — minute-by-minute stacked area chart for any single sprinkler day.
- **Configuration** — timer start times, station durations, baseline gpm values, watering days, and EBMUD billing constants. Config is **versioned with timestamps and required notes** so that schedule changes appear as markers on the consumption chart — distinguishing "usage jumped because I changed the schedule" from "usage jumped for no obvious reason."

## Getting started

```bash
npm install
npm run dev        # http://localhost:3000
```

### First-time setup
1. Open the app → click **Upload CSV** and load your Flume export.
2. Go to **Config** → verify your timer start times and station list.
3. Enter baseline gpm per station (or skip until your next seasonal audit).
4. **Save** with a note → return to Dashboard.

### Weekly check-in (< 2 min)
1. Upload your new CSV → data appends, duplicates skipped.
2. Scan **Station Alerts** for red warnings.
3. Review the **Consumption Chart** (1M window) for anomaly markers (⚠) or unexpected step-changes.
4. Click a suspicious day → **Day Detail** to see minute-by-minute flow.

## Project layout

```
├── app/                    # Next.js App Router pages
│   ├── page.tsx            # Dashboard (/)
│   ├── analysis/           # Per-station analysis (/analysis)
│   ├── config/             # Configuration editor (/config)
│   └── day/[date]/         # Day detail (/day/YYYY-MM-DD)
├── components/             # React components
├── lib/
│   ├── types.ts            # Shared TypeScript interfaces + DEFAULT_CONFIG
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
