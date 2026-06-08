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
│   └── WarningsPanel.tsx
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
    └──▶ computeStationWarnings()  → StationWarning[]
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
2. For each timer (T1, T2), iterate over programs A, B, C. A program is **active** for this date if `program.enabled && program.days.includes(dow)`.
3. For each active program, build ordered station windows:
   - `cursor = parseTimeToMinutes(program.start)`
   - For each station in `timer.stations` order: `end = cursor + programStation.durationMin`. If `enabled && durationMin > 0`, push `{ stationId, timer, startMin: cursor, endMin: end }`.
4. Compute the detection window as `[min(all startMins), max(all endMins)]`.
5. Sum gallons within that window. If > `sprinklerOnThreshold` → `isSprinklerDay = true`.
6. Tag each row: walk windows in order; if `startMin < rowMin ≤ endMin`, assign that station/timer. Otherwise: `house`.

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

---

## State Management

### Zustand Store
```ts
{
  windows: ConfigWindow[]       // sorted ascending by effectiveFrom; the active
                                // window for today is the "current" config
  rows: FlumeRow[]              // all CSV rows, sorted by datetime

  addWindowFromDate(date, notes)  // clone the config active on `date` → new window
  updateWindow(id, patch)         // edit config/notes/effectiveFrom in place (no new
                                  // window; changing effectiveFrom moves only this boundary)
  deleteWindow(id)                // remove a window (last one cannot be deleted)
  copyBaselinesForward(id)        // apply this window's baselines to all later windows
  appendRows(newRows)             // merge + deduplicate by datetime key, re-sort
  clearRows()
}
```

Persisted under `"sprinkler-store"` (persist `version: 2`) in localStorage.

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

---

## Routing

| Route | Type | Notes |
|---|---|---|
| `/` | Static client component | Dashboard |
| `/analysis` | Static client component | Station analysis |
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
