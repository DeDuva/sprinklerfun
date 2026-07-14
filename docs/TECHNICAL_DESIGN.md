# SprinklerFun — Technical Design

## Stack

| Layer | Choice | Rationale |
|---|---|---|
| Framework | Next.js 16 (App Router) | First-class Vercel support, file-based routing |
| Language | TypeScript | Type-safe data shapes across the analysis pipeline |
| Styling | Tailwind CSS | Utility-first, no CSS files |
| Charts | Recharts 3 | React-native, good enough for this data scale |
| CSV parsing | Papa Parse | Handles Flume's datetime format, browser-native |
| State | Zustand + `persist` | Simple global store; client cache during the DB migration |
| Database | Turso (libSQL / SQLite) via `@libsql/client` | Durable, multi-device time-series store; SQL-native aggregation |
| Backend | Next.js Route Handlers (`app/api/*`, Node runtime) | Ingest + rollup endpoints; reuse the pure `analyze.ts` functions server-side |
| UI components | shadcn/ui | Accessible, unstyled-first components |
| Testing | Vitest | Zero-config, fast, works with TypeScript path aliases |
| Hosting | Vercel | Zero-config Next.js deploy; Turso env vars for the DB |

**Storage is migrating from browser-only to a Turso backend** (see
[Storage & Backend Architecture](#storage--backend-architecture)). The original
design kept all data and computation in the browser via `localStorage`; at
per-minute resolution over multiple years the row series exceeded the ~5MB
`localStorage` quota, so raw rows and derived rollups now live in Turso. The
analysis functions in `lib/analyze.ts` remain pure and are reused **verbatim**
on the server to compute rollups — the browser no longer enriches the full
dataset.

---

## Project Structure

```
sprinkler-app/
├── app/
│   ├── layout.tsx              # Root layout: Navbar + StoreProvider + Toaster
│   ├── page.tsx                # Dashboard
│   ├── analysis/page.tsx       # Per-station analysis
│   ├── config/page.tsx         # Configuration editor + history
│   ├── day/[date]/page.tsx     # Minute-by-minute day detail
│   └── api/                    # Route Handlers (Node runtime) — the backend
│       ├── rows/route.ts       # POST ingest · GET all rows · DELETE clear
│       ├── day/[date]/route.ts # GET one day's raw per-minute rows
│       └── rollup/route.ts     # GET per-day/per-station aggregates
├── components/
│   ├── Navbar.tsx
│   ├── StoreProvider.tsx       # Client-only Zustand rehydration + default-config.json load
│   ├── UploadModal.tsx         # CSV file + URL loader
│   ├── SummaryCards.tsx
│   ├── ConsumptionChart.tsx    # Unified time-series chart
│   ├── StationFlowChart.tsx    # Horizontal bar chart for a single day with nav, day tiles, and enriched tooltip
│   ├── FlowTimelineChart.tsx   # Analysis: per-minute actual vs configured-baseline overlay + brush/station zoom
│   ├── ReconciliationTable.tsx # Analysis: per-station cfg→actual table; buttons STAGE config edits (don't write)
│   ├── ReviewChangesModal.tsx  # Analysis: review staged config changes (old→new, removable) before saving
│   └── WarningsPanel.tsx       # Baseline-deviation warnings + maintenance-flag surfacing
├── lib/
│   ├── types.ts                # All shared TypeScript interfaces, DEFAULT_CONFIG, migrateConfig
│   ├── analyze.ts              # Pure analysis functions (no React) — reused server-side
│   ├── staging.ts              # Pure staged-config-edit logic for the Analysis tab
│   ├── store.ts                # Zustand store with migration on rehydrate
│   ├── db.ts                   # server-only: libSQL client + idempotent schema bootstrap
│   ├── backend.ts              # client-only: dual-write bridge to /api/rows
│   ├── server/
│   │   ├── data.ts             # server data access + recomputeRollups (reuses analyze.ts)
│   │   └── auth.ts             # single-user shared-secret guard for writes
│   └── __tests__/
│       ├── analyze.test.ts     # Vitest unit tests
│       └── staging.test.ts     # Staged-edit logic tests
├── .env.example                # TURSO_*, APP_TIMEZONE, APP_SHARED_SECRET
├── vitest.config.ts
└── vercel.json
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

```
FlumeRow[]  +  ConfigWindow[]  (stored in localStorage via Zustand)
    │
    ▼  enrichRowsMultiConfig(rows, windows)
       ┌─ for each date range, find the active ConfigWindow (by effectiveFrom)
       └─ call enrichRows(batchRows, activeConfig) per segment
EnrichedRow[]    (each minute: station id, timer "timer1"/"timer2"/"house", isSprinklerDay)
    │
    ├──▶ aggregateForChart(enriched, bucket, breakdown)
    │        → ChartBar[]   (daily / weekly / monthly bars with per-breakdown stacks)
    │
    ├──▶ buildDailyRows()   → DailyRow[]
    │        └──▶ computeSummary()
    │
    ├──▶ buildStationStats()  → StationStats[]
    │
    ├──▶ computeStationWarnings()  → StationWarning[]
    │
    └──▶ (Analysis tab, per selected day)
             buildDaySchedule(dayConfig, dow)            → ExpectedSegment[]
             buildDayMinuteSeries(enriched for the day)  → MinutePoint[]
             reconcileDay(series, schedule)              → SegmentReconciliation[]
```

All functions are **pure** (no side effects, no React). They live in `lib/analyze.ts`.

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
| Raw minute rows | `flume_rows (datetime PK, gallons)` | CSV parse | on upload |
| Config windows | `config_windows (id, effective_from, notes, config JSON, …)` | client edits | on upload / edit |
| Daily rollups | `daily_rollup (date, station, gallons, is_sprinkler_day)` PK `(date, station)` | server, from enriched rows | on upload / config edit |
| Maintenance flags | `maintenance (station_id PK, flagged_at, note)` | client edits | on edit |

Schema is bootstrapped idempotently (`CREATE … IF NOT EXISTS`) by
`ensureSchema()` in `lib/db.ts`, memoized once per process.

### Route Handlers (`app/api/*`, Node runtime)

- **`POST /api/rows`** — body `{ rows, windows }`. Mirrors the window set,
  `INSERT OR IGNORE`s rows (the `datetime` PK does the dedupe `appendRows` used
  to do by hand), then recomputes rollups. Returns `{ inserted, rollupDays }`.
- **`GET /api/rows`** — the full row series, ascending by datetime. Hydrates the
  in-memory store on load now that rows aren't persisted in localStorage.
- **`DELETE /api/rows`** — clears all rows + rollups ("Clear all data").
- **`GET /api/day/[date]`** — one day's raw per-minute rows; detail/flow views
  enrich a single day client-side instead of loading the whole series.
- **`GET /api/rollup?from=&to=`** — the small aggregate feed for the dashboard
  chart/summary. Bounds optional.

All pin `runtime = "nodejs"` (the libSQL node client uses native bindings —
not edge-compatible) and `dynamic = "force-dynamic"` (never cached).

`recomputeRollups(from, to)` in `lib/server/data.ts` fetches raw rows for the
range plus the **full** window set (a date's active window may be defined
earlier), runs `enrichRowsMultiConfig` + `buildDailyRows` — the same pure
functions the browser used — and upserts one rollup row per `(date, station)`.

### ⚠️ Timezone constraint (critical)

`enrichRows` intentionally converts Flume's UTC timestamps to **local** time so
minute-of-day aligns with the configured start times (`lib/analyze.ts`, the
`localDateAndMin` path). Because rollups are now computed **server-side**, the
server process must run in the homeowner's timezone or its rollups won't match
what the browser computes (Vercel defaults to UTC). Set **`APP_TIMEZONE`** (e.g.
`America/Los_Angeles`) in the deployment env — `lib/db.ts` applies it to
`process.env.TZ` at startup. We can't use `TZ` directly because Vercel reserves
that env var; Node honors a runtime `TZ` assignment for subsequent `Date` calls.
A future refactor may thread an explicit timezone through the pure functions
instead of relying on process `TZ`.

### Auth (single-user)

Writes are gated by a shared secret (`x-sprinkler-secret` vs `APP_SHARED_SECRET`)
in `lib/server/auth.ts`. Unset ⇒ allowed (local dev). Reads are open at the app
layer; production relies on Vercel deployment protection. This is deliberately
minimal — it's a single-house personal app, not multi-tenant.

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
vercel env add APP_TIMEZONE production             # e.g. America/Los_Angeles (NOT `TZ` — reserved)
vercel env add APP_SHARED_SECRET production
vercel env add NEXT_PUBLIC_APP_SHARED_SECRET production   # same value as APP_SHARED_SECRET
```

- Run these in the same shell/working directory the app builds from (for WSL
  checkouts, inside WSL at the repo path) so the link binds correctly.
- Verify the binding with `cat .vercel/project.json` or `vercel project ls`.
- `--scope <team-slug>` selects the team/account when you belong to several; it
  does **not** make a var global.
- Repeat per environment you need (`production`, `preview`, `development`), or
  run `vercel env add NAME` with no environment to get the checkbox prompt.
- Also enable Vercel **deployment protection** for read-side gating (the app's
  shared secret only guards writes).
- Local dev needs none of this — the `./.data/sprinkler.db` fallback covers it;
  optionally copy `.env.example` → `.env.local`.

**Gotchas (learned the hard way):**
- The value is **not** a positional arg to `vercel env add` — positionals are
  `[name] [environment] [gitBranch]`. Passing the value as a 4th token makes
  Vercel read it as a git branch and fail. Enter it at the `? Value?` prompt, or
  pipe it: `printf '%s' '<value>' | vercel env add NAME production`.
- Use **`APP_TIMEZONE`**, never `TZ` — `TZ` is a Vercel-reserved variable and is
  rejected.
- `vercel link` creating the project and **connecting the Git repo are separate
  steps**; Git-connect can fail (e.g. the Vercel GitHub app lacks access to the
  repo's owner) without affecting env setup or CLI deploys. Wire Git later via
  the dashboard or `vercel git connect`.

> **`APP_TIMEZONE` is not optional in production.** Rollups are computed
> server-side and enrichment is timezone-local (see the timezone constraint
> above). Vercel defaults to UTC; set `APP_TIMEZONE` to the property's zone or
> rollups will be wrong.

### Migration rollout (incremental, each phase shippable)

1. **Turso + schema + `/api/rows` + `/api/rollup`, client dual-writes.** ← *implemented (Phase 1).* localStorage was still the source of truth; the client mirrored every upload to the DB (`lib/backend.ts`). This stood up the backend but did **not** relieve the quota error (the localStorage write still ran first).
2. **Rows become server-authoritative — the quota fix.** ← *implemented (Phase 2).* `persist` is `partialize`d to store only `windows` + `maintenance`, so the per-minute series never touches localStorage (the `QuotaExceededError` is gone at the root). Rows live in Turso and hydrate into memory on load via `GET /api/rows`; uploads `POST` straight to the server; "Clear all data" issues `DELETE /api/rows`; `GET /api/day/[date]` added. The dashboard still *derives* from the in-memory rows this phase.
3. **Dashboard/analysis read rollups; stop loading the full series in the browser.** The consumption chart + monthly summary read `/api/rollup`; per-day views fetch `GET /api/day/[date]`. Requires new rollups for the per-minute-dependent widgets (per-station gpm stats, baseline warnings) that daily gallon sums can't reconstruct.
4. Window/maintenance CRUD via API; targeted rollup recompute on window edits (replace the Phase 1 full-range recompute).
5. Remove the `useDeferredValue` scaffolding and delete dead client code once nothing enriches the full series client-side.

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
2. **Run detection** — scan `[progStart − driftSearch, progEnd + driftSearch]` (default `driftSearch = 10`) for contiguous "on" stretches (flow ≥ threshold); pick the one with the greatest overlap with the configured span (else the longest). Its first on-minute − 1 = the run's start boundary; its last on-minute = the end boundary. `progDrift = runStartBoundary − progStart`.
3. **Interior boundary refinement** — for each station boundary, search ±4 min around its drift-shifted configured position for the minute with the largest flow step (max `|mean(left window) − mean(right window)|`, window = 3 min, clamped monotonic inside the run). If the best step `< minStepGpm` (default `0.5`) the adjacent levels are indistinguishable: fall back to the shifted configured boundary and mark the boundary **low-confidence**.
4. **Sustained gpm** — mean over each station's interval **excluding its first and last minute** (adjacent-station bleed). Runs ≤ 3 min have no clean interior → full mean, **low-confidence**.
5. Emit per station: `actualStart/End/Duration`, trimmed `actualGpm`, `startDriftMin`, `durationDriftMin`, `gpmDeltaPct`, and a `confidence` (`low` if a run was missing, ≤3 min, or sat on an ambiguous boundary).

A program with no detected run yields all-null actuals (low-confidence). Two enabled programs on the same timer/day produce two independent runs for the same station — reconciled separately (the reconciliation table shows both; the chart's station chips dedupe by id).

The Analysis tab's per-row / bulk actions translate a `SegmentReconciliation` into a config edit on the **window active on the selected day** (`activeWindowForDate`) via `updateWindow`: baseline → `station.baselineGpm`; start → shift `program.start` by `startDriftMin` (per-station starts derive from program start + upstream durations); duration → `programStation.durationMin`. "Calibrate from this day" applies all three across every detected station at once.

---

## State Management

### Zustand Store
```ts
{
  windows: ConfigWindow[]       // sorted ascending by effectiveFrom; the active
                                // window for today is the "current" config
  rows: FlumeRow[]              // all CSV rows, sorted by datetime
  maintenance: Record<string, MaintenanceFlag>  // station id → flag (top-level)

  addWindowFromDate(date, notes)  // clone the config active on `date` → new window
  updateWindow(id, patch)         // edit config/notes/effectiveFrom in place (no new
                                  // window; changing effectiveFrom moves only this boundary)
  deleteWindow(id)                // remove a window (last one cannot be deleted)
  copyBaselinesForward(id)        // apply this window's baselines to all later windows
  setStationMaintenance(id, flag) // set (or clear, with null) a station's maintenance flag
  appendRows(newRows)             // merge + deduplicate by datetime key, re-sort (in-memory)
  setRows(rows)                   // replace all rows (hydration from the server)
  clearRows()
}
```

**Persistence (`version: 3`).** `persist` is `partialize`d to write only
`{ windows, maintenance }` to localStorage — small, client-owned state. `rows`
stays in the store **in memory** but is **not persisted**; keeping the per-minute
series out of localStorage is what fixes the `QuotaExceededError`. Existing users'
large legacy row blobs are read once on rehydrate and then dropped the first time
the partialized state is written back. The Analysis tab's config-edit actions
reuse `updateWindow`; only maintenance flags need `setStationMaintenance`.

**Rows are server-authoritative (Phase 2 of the Turso migration).** On load,
`StoreProvider` calls `GET /api/rows` and `setRows()` the result into memory
(falling back to a fresh install's `default-data.csv`, which it also seeds to the
server). Uploads `POST /api/rows` as the durable write (`appendRows` still updates
the in-memory view for immediate reactivity, but no longer persists locally).
"Clear all data" issues `DELETE /api/rows`. The pages still enrich the in-memory
rows via `deriveData`; a later phase moves those reads onto rollup/day endpoints
so the full series no longer loads in the browser
entirely (see [Migration rollout](#migration-rollout-incremental-each-phase-shippable)).

### SSR Safety
- Storage adapter no-ops when `typeof window === "undefined"`
- `skipHydration: true` + `StoreProvider` calls `rehydrate()` in `useEffect` after mount
- Server renders with empty/default state; browser loads persisted data after hydration

### Performance: `useDeferredValue`
`enrichRowsMultiConfig` is O(n) over all rows. All three analysis pages wrap `rows` and `config` in `useDeferredValue` before the heavy `useMemo`. React commits UI updates (e.g. navigation) first, then runs computation in background. Skeleton loaders shown while stale. This prevents the main thread from blocking on navigation.

The Dashboard splits computation into two memos:
- **`derived`** (expensive, deferred) — runs `enrichRowsMultiConfig` + `buildDailyRows` + warnings once per data/config change; memoises `enriched`, `allDaily`, `sprinklerDates`, `defaultFlowDay`.
- **`monthlySummary`** (cheap) — filters `allDaily` by the selected month and calls `computeSummary`; reruns only when the month selector changes, not when data changes.
- **`flowDayStats`** (cheap) — filters `enriched` and `allDaily` by the selected day, calls `buildStationStats` + `computeSummary` with that day's config, and resolves the active window for that day via `activeWindowForDate`. Reruns only when the selected day changes.

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
- In `store.ts` persist `migrate` (v1→v2) and `onRehydrateStorage` — for localStorage data
- In `StoreProvider.tsx` — when loading `public/default-config.json` on fresh install
- In `ExportImportCard.applyBundle` — when importing a JSON file or URL (old exports still load)

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

## Upload & CSV Parsing

Two input paths in `UploadModal`:
- **File**: Papa Parse reads `File` directly (no full string copy)
- **URL**: `fetch(url)` → text → Papa Parse. GitHub blob URLs auto-rewritten to `raw.githubusercontent.com`

Column matching: `datetime | Datetime | DateTime`, `gallons | Gallons`. Invalid rows silently dropped.

`appendRows` deduplicates by `datetime` string and re-sorts. Overlapping uploads are safe.

---

## Testing

**Runner**: Vitest (`npm test` = `vitest run`, `npm run test:watch` = `vitest`)

### Test Coverage (`lib/__tests__/analyze.test.ts`)

| Test | What it verifies |
|---|---|
| `buildDaySchedule` — reconstruction | Back-to-back windows from start + durations; baseline lookup; disabled/zero-duration omitted; inactive day → empty |
| `buildDayMinuteSeries` | One point per minute, gpm = that minute's gallons, sorted |
| `reconcileDay` — clean run | Zero drift; trimmed gpm equals baseline; high confidence |
| `reconcileDay` — late start | Program start shift → positive `startDriftMin` |
| `reconcileDay` — off baseline | Above-baseline flow → positive `gpmDeltaPct` |
| `reconcileDay` — short run | Run ≤3 min → low confidence |
| `reconcileDay` — no flow | No detected run → null actuals, low confidence |
| `reconcileDay` — ambiguous boundary | Equal adjacent baselines → low confidence, still measures gpm |
| `reconcileDay` — boundary refinement | Late inter-station boundary detected from the flow step |
| `staging` — stageKey | Per-station baseline/duration keys; shared per-program start key |
| `staging` — wouldChange | No-op detection for baseline (2dp) / duration / start drift |
| `staging` — buildStagedChange | `apply` mutates baseline / duration / shifts program start (±) |
| `staging` — programStartStations | First station per program, order-independent |
| `staging` — proposeAllChanges | Only changed fields; one start per program; skips no-run rows |
| `staging` — applyStagedChanges | Composes all changes; input config left untouched |
| Station assignment on sprinkler day (Program A) | Correct station id assigned for each time window |
| House assignment outside station window | Minutes between stations → "house" |
| House assignment on non-scheduled day | Day not in program.days → no windows → not a sprinkler day |
| Sprinkler day threshold | Just-below threshold → not a sprinkler day |
| Program B active on different days | B and A can have non-overlapping day sets |
| `enrichRowsMultiConfig` — no windows | Uses DEFAULT_CONFIG when there are no windows |
| `enrichRowsMultiConfig` — single window | Uses a window's config from its effectiveFrom onward |
| `enrichRowsMultiConfig` — multi-window | Each date range uses the active window (even if passed out of order) |
| `enrichRowsMultiConfig` — pre-history data | Data before the earliest window uses that window's config |
| `activeWindowForDate` / `windowDateRange` | Boundary inclusivity, range derivation, input-order independence |
| `diffConfigs` | Detects start/days/duration/baseline/station add-remove/billing changes |
| `toWindows` / `normalizeTime` | Legacy→windows migration; malformed `HH:MM:SS:SS` normalized |
| `buildWeeklyRows` — bucketing | Rows on same ISO week aggregate together |
| `buildWeeklyRows` — week boundaries | Mon/Sun split into correct weeks |
| `computeStationWarnings` — fires | >20% above baseline for 2+ days → warning |
| `computeStationWarnings` — no fire (1 day) | Single day above → no warning |
| `computeStationWarnings` — no fire (no baseline) | Stations without baseline → no warning |
| `aggregateForChart` — simple breakdown | house vs sprinkler sums correct |
| `aggregateForChart` — timer breakdown | timer1 vs timer2 split correct |
| `aggregateForChart` — anomaly detection | IQR outlier correctly flagged |

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
A lightweight overlay (same pattern as `UploadModal`) listing staged `StagedItem[]` grouped by area, each with a `remove` action, plus **Save to config** / **Cancel**. Purely presentational — all state lives in the Analysis page.

---

## Routing

| Route | Type | Notes |
|---|---|---|
| `/` | Static client component | Dashboard |
| `/analysis` | Static client component | Timing & flow calibration |
| `/config` | Static client component | Config editor |
| `/day/[date]` | Dynamic client component | `date` = `YYYY-MM-DD` |

---

## Known Limitations & Future Work

| Issue | Notes |
|---|---|
| `enrichRows` is O(n) synchronous | OK to ~1M rows; now runs server-side at ingest, off the browser's main thread |
| ~~localStorage ~5MB limit~~ | **Resolved (Phase 2).** Rows are no longer persisted in localStorage (`partialize` keeps only `windows`+`maintenance`); the per-minute series lives in Turso and hydrates into memory on load. See [Storage & Backend Architecture](#storage--backend-architecture) |
| Full row series still loads into browser memory | The quota (write) issue is fixed, but pages still fetch all rows and enrich client-side. Phase 3 moves reads onto rollup/day endpoints to avoid loading the whole series |
| Server rollups depend on process `TZ` | Enrichment is timezone-local; set `APP_TIMEZONE` (applied to `process.env.TZ` in `lib/db.ts`, since Vercel reserves `TZ`). A future refactor may thread tz explicitly |
| Phase 1 recomputes all rollups per upload | A config-window change can affect any date, so the whole range is recomputed. Phase 4 makes this targeted |
| No row validation beyond column names | Malformed timestamps silently dropped |
| Config `effectiveFrom` resolution is 1 day | Two windows can't share a date (enforced in the editor); sub-day changes aren't representable |
| IQR anomaly detection is naive | No seasonal adjustment; many weeks of data needed before IQR is meaningful |
| Programs A and B on same timer same day | Both programs' windows are merged; if they overlap in time, first-match wins |
