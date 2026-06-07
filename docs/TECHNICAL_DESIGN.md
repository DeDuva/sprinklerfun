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
│   ├── StationFlowChart.tsx    # Horizontal bar chart for a single day with nav
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
FlumeRow[]  +  ConfigVersion[]  (stored in localStorage via Zustand)
    │
    ▼  enrichRowsMultiConfig(rows, configHistory)
       ┌─ for each date range, find the active ConfigVersion
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

**Problem**: A config saved on date D should apply to all data from D onward (and not retroactively change earlier data). This means analysis must use the correct config version for each date, not just the current config.

**Algorithm**:
1. Sort `configHistory` oldest-first (by `savedAt`)
2. Build a list of segments: `[{ fromDate: "0000-00-00", config: oldest_saved }, { fromDate: v1.savedAt, config: v1.config }, ...]`
3. For each row date, find its segment (the last segment whose `fromDate ≤ row.date`)
4. Group rows by segment index; call `enrichRows(batch, segment.config)` on each batch
5. Merge and sort all results by datetime

This means: changing today's config has no effect on how past data is analyzed. History is immutable.

**Pre-history fallback**: data before the first saved config uses the **oldest saved config**, not `DEFAULT_CONFIG`. `DEFAULT_CONFIG` is a generic placeholder with wrong timer start times for real installations; the oldest saved config is always a better proxy for what the system looked like before the user started tracking changes.

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
`configHistory` entries whose `savedAt` falls within the visible date range are mapped to their nearest bar label. Rendered as Recharts `ReferenceLine x={label}` with a custom label component. Tooltip on hover shows change notes.

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
  config: AppConfig             // active / current config
  configHistory: ConfigVersion[] // ordered newest-first
  rows: FlumeRow[]              // all CSV rows, sorted by datetime

  saveConfig(config, notes)     // deep-copies config → ConfigVersion → prepends to history
  restoreConfig(version)        // loads historical config into active (no history entry)
  appendRows(newRows)           // merge + deduplicate by datetime key, re-sort
  clearRows()
}
```

Persisted under `"sprinkler-store"` in localStorage.

### SSR Safety
- Storage adapter no-ops when `typeof window === "undefined"`
- `skipHydration: true` + `StoreProvider` calls `rehydrate()` in `useEffect` after mount
- Server renders with empty/default state; browser loads persisted data after hydration

### Performance: `useDeferredValue`
`enrichRowsMultiConfig` is O(n) over all rows. All three analysis pages wrap `rows` and `config` in `useDeferredValue` before the heavy `useMemo`. React commits UI updates (e.g. navigation) first, then runs computation in background. Skeleton loaders shown while stale. This prevents the main thread from blocking on navigation.

---

## Config Migration

Old configs (before multi-program support) stored `start` and station `durationMin`/`enabled` directly on the timer. The migration function `migrateConfig(rawConfig)` in `lib/types.ts` detects old format (presence of `timer1.start`) and converts:

1. `timer1.start` + `sprinklerDays` → `timer1.programs.A.{ start, days }`
2. `station.{ durationMin, enabled }` → `programs.A.stations[id].{ durationMin, enabled }`
3. `station.{ id, name, baselineGpm }` → `timer1.stations[id].{ id, name, baselineGpm }`
4. Programs B and C initialized as `{ enabled: false, start: timer.start, days: [], stations: {} }`
5. Top-level `sprinklerDays` removed

Migration is applied:
- In `store.ts` `onRehydrateStorage` — for configs persisted in localStorage
- In `StoreProvider.tsx` — when loading `public/default-config.json` on fresh install
- In `ExportImportCard.applyBundle` — when importing a JSON file or URL

Migration is idempotent: new-format configs pass through unchanged.

---

## Config Versioning

```ts
interface ConfigVersion {
  id: string        // Date.now().toString()
  savedAt: string   // ISO timestamp
  notes: string     // user change notes
  config: AppConfig // deep copy at save time
}
```

`saveConfig` deep-copies before storing so in-progress edits don't corrupt history.

History is never pruned. `restoreConfig` loads into the editor's local state only; the user must Save to commit.

**Time-aware analysis**: all analysis functions accept `configHistory` and use `enrichRowsMultiConfig` to apply the correct config per date range.

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
| `enrichRowsMultiConfig` — default config | Uses DEFAULT_CONFIG when no history |
| `enrichRowsMultiConfig` — single version | Uses saved config after its savedAt date |
| `enrichRowsMultiConfig` — multi-version | Each date range uses the correct version |
| `enrichRowsMultiConfig` — pre-history data | Data before first version uses oldest saved config |
| `buildWeeklyRows` — bucketing | Rows on same ISO week aggregate together |
| `buildWeeklyRows` — week boundaries | Mon/Sun split into correct weeks |
| `computeStationWarnings` — fires | >20% above baseline for 2+ days → warning |
| `computeStationWarnings` — no fire (1 day) | Single day above → no warning |
| `computeStationWarnings` — no fire (no baseline) | Stations without baseline → no warning |
| `aggregateForChart` — simple breakdown | house vs sprinkler sums correct |
| `aggregateForChart` — timer breakdown | timer1 vs timer2 split correct |
| `aggregateForChart` — anomaly detection | IQR outlier correctly flagged |

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
| Config savedAt resolution is 1 day | Two configs saved on the same day: last one wins |
| IQR anomaly detection is naive | No seasonal adjustment; many weeks of data needed before IQR is meaningful |
| Programs A and B on same timer same day | Both programs' windows are merged; if they overlap in time, first-match wins |
