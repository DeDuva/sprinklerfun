# SprinklerFun — Technical Design

## Stack

| Layer | Choice | Rationale |
|---|---|---|
| Framework | Next.js 16 (App Router) | First-class Vercel support, file-based routing |
| Language | TypeScript | Type-safe data shapes across the analysis pipeline |
| Styling | Tailwind CSS | Utility-first, no CSS files |
| Charts | Recharts 3 | React-native, good enough for this data scale |
| CSV parsing | Papa Parse | Handles Flume's datetime format, browser-native |
| State | Zustand + `persist` | Simple global store with localStorage persistence |
| UI components | shadcn/ui | Accessible, unstyled-first components |
| Testing | Vitest | Zero-config, fast, works with TypeScript path aliases |
| Hosting | Vercel | Zero-config Next.js deploy |

**No backend.** All computation runs in the browser.

---

## Project Structure

```
sprinkler-app/
├── app/
│   ├── layout.tsx              # Root layout: Navbar + StoreProvider + Toaster
│   ├── page.tsx                # Dashboard
│   ├── analysis/page.tsx       # Per-station analysis
│   ├── config/page.tsx         # Configuration editor + history
│   └── day/[date]/page.tsx     # Minute-by-minute day detail
├── components/
│   ├── Navbar.tsx
│   ├── StoreProvider.tsx       # Client-only Zustand rehydration + default-config.json load
│   ├── UploadModal.tsx         # CSV file + URL loader
│   ├── SummaryCards.tsx
│   ├── ConsumptionChart.tsx    # Unified time-series chart
│   ├── StationFlowChart.tsx    # Horizontal bar chart for a single day with nav, day tiles, and enriched tooltip
│   ├── FlowTimelineChart.tsx   # Analysis: per-minute actual vs configured-baseline overlay + brush/station zoom
│   ├── ReconciliationTable.tsx # Analysis: per-station cfg→actual table with config-edit + maintenance actions
│   └── WarningsPanel.tsx       # Baseline-deviation warnings + maintenance-flag surfacing
├── lib/
│   ├── types.ts                # All shared TypeScript interfaces, DEFAULT_CONFIG, migrateConfig
│   ├── analyze.ts              # Pure analysis functions (no React)
│   ├── store.ts                # Zustand store with migration on rehydrate
│   └── __tests__/
│       └── analyze.test.ts     # Vitest unit tests
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
  appendRows(newRows)             // merge + deduplicate by datetime key, re-sort
  clearRows()
}
```

Persisted under `"sprinkler-store"` (persist `version: 2`) in localStorage. `maintenance` defaults to `{}`; persist's shallow merge fills it in for stores saved before it existed, so no version bump is required. The Analysis tab's config-edit actions reuse `updateWindow` (deep-cloning the active window's config and patching the targeted field); only maintenance flags need the dedicated `setStationMaintenance` action.

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

### `ReconciliationTable` (Analysis)
Renders `SegmentReconciliation[]` with cfg→actual start / duration / gpm columns, drift badges, a `≈` low-confidence marker, and a maintenance badge. Row click toggles the chart's selected station. Action buttons are disabled when the relevant actual is missing; the page wires them to `updateWindow` (baseline / start / duration) and `setStationMaintenance` (flag, with an optional `window.prompt` note). Edits are blocked with a toast when no config window is active for the day.

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
| `enrichRows` is O(n) synchronous | OK to ~1M rows; beyond that, move to Web Worker |
| localStorage ~5MB limit | ~1 year Flume data ≈ 15MB uncompressed. May need `lz-string` compression or IndexedDB |
| No row validation beyond column names | Malformed timestamps silently dropped |
| Config `effectiveFrom` resolution is 1 day | Two windows can't share a date (enforced in the editor); sub-day changes aren't representable |
| IQR anomaly detection is naive | No seasonal adjustment; many weeks of data needed before IQR is meaningful |
| Programs A and B on same timer same day | Both programs' windows are merged; if they overlap in time, first-match wins |
