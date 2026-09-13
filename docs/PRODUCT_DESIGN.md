# SprinklerFun — Product Design

## Overview
A web application that helps a homeowner analyze Flume smart meter data to understand and optimize sprinkler water usage. Data is stored in a durable database (Turso) so it survives a browser wipe and is reachable from any device; the analysis experience stays fast and simple. (Originally browser-only via `localStorage` — that hit the browser's storage quota at multi-year, per-minute resolution, prompting the move to a backend. See the migration status in TECHNICAL_DESIGN.md.)

## User Persona
**Primary User**: Homeowner with a Flume smart meter and a two-timer, multi-zone sprinkler system (EBMUD service area).
- Wants to spot broken or wasteful sprinklers quickly
- Checks in weekly; the meter data is already there, pulled from Flume every day
- Makes seasonal schedule adjustments a few times a year; keeps notes on what changed and why
- Does a seasonal audit: physically measures each station's flow rate and records the baseline gpm
- May run multiple programs on a timer (e.g., full summer schedule on Mon/Wed/Fri, a lighter drought schedule on Sat)
- Comfortable with web apps, not with Jupyter notebooks

---

## Core Data Model

### Input Data
One row per minute: a timezone-naive `datetime` and the `gallons` used in that minute. It arrives two ways, and both land in the same table, one row per `datetime`. A sync overwrites the minutes it re-reads, because Flume reports a minute it has not received yet as 0; an upload never overwrites:
- **The Flume Personal API** (primary) — pulled once a day by a scheduled job, or on demand with **Sync now**.
- **A Flume CSV export** (fallback) — the same `datetime` and `gallons` columns, uploaded from the Config page. Useful for history older than the API serves.

### Configuration (windowed)
```
timers:
  T1:
    stations: [{ id, name, baselineGpm }]   # hardware — order defines run order
    programs:
      A: { enabled: true,  start, days, stations: { id → { durationMin, enabled } } }
      B: { enabled: false, start, days, stations: { ... } }
      C: { enabled: false, start, days, stations: { ... } }
  T2: (same structure)

sprinklerOnThreshold: number   # gallons during station windows → counts as sprinkler day
gallonsPerUnit: 748            # EBMUD billing unit
costPerUnit: 10.47             # $/unit
```

#### Programs
Each timer supports three independent programs: **A**, **B**, and **C**.

- **Program A** is always enabled. It is the primary schedule.
- **Programs B and C** are off by default. Enable them to run a parallel schedule (e.g., a seasonal short cycle).
- Each program has its own **start time** and **days of week**.
- Station **run order** (id, name) is shared across all programs for a timer.
- Station **duration and on/off** are per-program.
- Station **baseline gpm** is a hardware property — set on Program A, displayed read-only on B/C.

Analytics always aggregate by timer and station, ignoring the program dimension.

**Config is time-aware — a timeline of windows.** The config is a list of `ConfigWindow { id, effectiveFrom, notes, config, createdAt, updatedAt }` entries. Each window's `effectiveFrom` is the **real-world date the change took effect on the timer** — explicitly set by the user, decoupled from when it was entered in the app. Windows are contiguous: window *i* is active for `[effectiveFrom_i, effectiveFrom_{i+1})`, so exactly one config is active on any date. When analyzing data, the window active on each date is used — not the current config. This means:
- A window effective June 1 applies to all data from June 1 onward, until the next window.
- Data before the earliest window uses that **earliest window's config** (not a generic default — it's the best proxy for what the system looked like before change tracking began).
- **Tuning** a window edits it in place; the boundary never moves (only `updatedAt` bumps).
- **Establishing** a change at a past date sets `effectiveFrom` explicitly; the new window starts as a copy of the config that was active on that date.
- **Adjusting** a window's range means editing one boundary date — the previous window's end follows automatically.

---

## Features

### Consumption Chart (primary visualization)

The main chart is a unified time-series visualization that answers three questions simultaneously:
1. How much water have we used, and is it stable over time?
2. What changed — schedule, config, or hardware failure?
3. Which part of the system is responsible?

**Time Window** (top-right button group):
`2W | 1M | 3M | 6M | 1Y | All` — **2W is the default.** With data arriving daily, the recent run of days is what a visit is for, and 2W's daily bars are clickable into the per-station chart.

The bar granularity follows how many days of data the window actually holds, not the window's name: up to 60 days → daily bars, up to 270 → weekly, beyond that → monthly. In practice 2W and 1M are daily, 3M and 6M weekly, 1Y and All monthly — but a 6M window over three weeks of data stays daily rather than collapsing into three bars.

**Breakdown** (segmented control below window selector):
- **Simple** (default): House vs. Sprinkler — two stacks, easy to read
- **By Timer**: House · Timer 1 · Timer 2 — isolates which timer runs more
- **By Station**: House + one color per station — most granular, useful for diagnosing a specific zone

The breakdown level is independent of the time window. Users can combine any window with any breakdown.

**Config-change markers:**
Vertical dashed lines on the chart at every date a config was saved within the visible window. On hover, shows the config notes. This makes it easy to distinguish "usage jumped because I changed the schedule" from "usage jumped for no obvious reason."

**Anomaly markers:**
Bars that fall outside the normal range (IQR-based outlier detection) get a small warning indicator (⚠ above the bar). This surfaces leaks and blockages at a glance without requiring the user to compute anything.

**Click-to-drill (2W / 1M views):**
In daily-bar mode, clicking a bar sets the selected day for the Per-Station Flow Rate chart on the dashboard. A cyan vertical line marks the selected day.

**Design rationale:**
- One chart, not four. The user should not have to navigate between views to understand a trend.
- Config changes as first-class visual objects. Without them, a step-change in consumption looks alarming; with them, the user immediately sees "oh, that's when I adjusted the schedule."
- Progressive breakdown. Start coarse (Simple), drill in when something looks wrong.
- Anomaly marks are non-intrusive. They don't yell; they whisper. The user can scan for ⚠ without being overwhelmed.

---

### Dashboard (/)
The primary landing page. There is no data-loading control on it: data arrives on its own, and the fetch-now and upload controls live on Config. Top-to-bottom layout:

1. **Flo's headline** — a plain-English sentence for the month selected in the summary below (the current month by default) ("Your yard used N gal in September — about $X so far."), a note naming any station running above baseline, and the date range of stored data. Empty state (no data at all) points to Config.
2. **Station Alerts panel** — red warning per station running >20% above baseline for 2+ consecutive days; green all-clear otherwise; prompt to add baselines if none set.
3. **Monthly Summary Cards** — Total gallons · Sprinkler gallons · House gallons · Estimated cost. Scoped to a selected calendar month (1st → last day, or today for the current month). ← month → arrows let the user page backward through historical months, defaulting to the current month.
4. **Consumption Chart** — the unified chart described above. In 2W / 1M (daily-bar) views, clicking a bar sets the selected day for the Per-Station Flow Rate chart.
5. **Per-Station Flow Rate** — inside a single card:
   - **Day summary tiles** (Total · Sprinkler · House · Est. Cost) scoped to the selected day, updated whenever the day changes.
   - **Date navigation** (← prev sprinkler day · date label · next sprinkler day →).
   - **Horizontal bar chart** — one bar per active station; bars >20% above baseline turn red; orange tick marks the baseline.
   - **Hover tooltip** — shows avg gpm, baseline gpm (with % delta above/below), and the date of the config version that was active on the selected day.

### Analysis (/analysis) — Timing & Flow Calibration

The Analysis tab answers a focused operational question: **is each station starting when the config says it should, and flowing at the rate the config expects?** — and lets the user reconcile config to reality in one place.

**1. Actual vs. Configured chart (hero)** — pick a sprinkler day (← / → step through sprinkler days). For that day it plots:
- **Actual flow** — a blue per-minute gpm area built straight from the meter.
- **Configured baseline** — an orange step line at each station's `baselineGpm` across its configured window. Where the blue sits above/below the orange = flow-rate drift; where the actual rise/fall is left/right of a window edge = timing drift.
- **Zoom** — a brush below the chart selects any time range; clicking a station chip zooms to that station's window and overlays its configured-start (solid) and detected-actual-start (dashed) markers plus a translucent band. **Reset zoom** clears both.

**2. Reconciliation table** — one row per configured station run on the day (a station in two programs shows twice). Columns: **start** (cfg → actual, with drift), **duration** (cfg → actual, with drift), **gpm** (baseline → measured, with % delta). A `≈` marks low-confidence rows.

Config edits use a **propose → review → save** model so nothing changes by accident. The buttons in the **Propose config change** column *stage* an edit (they don't write); each is labeled with its concrete target value so the intent is unmistakable:
- **baseline → 1.71** — set the station's `baselineGpm` to the measured actual.
- **start → 03:44** — shift the station's *program* start so it lines up with the actual start. Per-station starts aren't independently configurable (they're `programStart + Σ upstream durations`), so this is a program-level knob and is offered **only on each program's first station**; downstream timing is corrected via duration.
- **duration → 11m** — set the station's per-program `durationMin` to the measured run length.

Buttons that would be a no-op (value already matches, or no run detected) are disabled. A staged button flips to a filled ✓ state; clicking it again un-stages. Maintenance is a separate column so it reads as distinct from config edits: **⚠ flag** flags the station for maintenance (optional note) and writes immediately (it's a reversible toggle, not a config-window edit).

**3. Stage all changes from this day** — a bulk action that stages every detected change at once (each program's start from its first station, plus every station's duration and baseline) and opens the review dialog.

**4. Review & Save** — once anything is staged, a **review bar** ("N proposed config changes · not saved yet") appears with **Discard** and **Review & Save**. Review opens a dialog that lists every staged change grouped by program as `old → new`, each individually removable. The config window active on that day is written **once**, only when the user clicks **Save to config** — until then nothing persists. Staging is scoped to the selected day/window and clears when either changes.

**5. Fleet Overview** — the cross-day aggregate retained from the previous Analysis tab: per-station total gallons, avg/std gpm, % of sprinkler total, estimated cost, plus an avg-gpm bar chart with error bars. Analyzed using the time-appropriate config window for each date range.

**Measurement note — adjacent-station bleed:** stations run back-to-back, so the meter's first and last minute of any station's run partially sample the neighbouring station. The measured "actual gpm" therefore **excludes the first and last minute** of each detected run (the trimmed mean). Runs of 3 minutes or fewer have no clean interior to trim and are marked low-confidence.

### Maintenance flags
A station can be flagged for maintenance from the Analysis reconciliation table. Flags are stored top-level (keyed by station id), independent of the config-window timeline — they describe the **current physical state of the hardware**, not a config version. Active flags surface in the dashboard **Station Alerts** panel (amber) alongside the baseline-deviation warnings (red), and are informational (they do not suppress warnings). Cleared from the Analysis tab.

### Day Detail (/day/[date])
Minute-by-minute view for a single sprinkler day, using the config version active on that date:
- Stacked area chart: each station's contribution by minute
- Summary cards: total, sprinkler, house, day cost
- Station summary table

### Configuration (/config)

The page is organized around a **timeline of config windows**.

**Window timeline rail** (top)
- A horizontal strip of windows, oldest → newest. Each chip shows its date range (`effectiveFrom → effectiveTo`, or "now"), notes, and how many days / sprinkler days fall in that range. The window active today is badged **current**; the first is badged **earliest** (it also covers all data before it).
- Click a chip to load that window into the editor below.
- **＋ New config** opens a small form: pick the **effective date** (when the change took effect on the timer) and add notes. The new window starts as a copy of the config active on that date — so by default it inherits all existing values.

**Selected-window editor**
- **Effective from** date — editing it moves this window's boundary (the previous window's end follows automatically). Two windows can't share a date.
- **Notes** field, plus a live range readout (e.g. "Active May 15 → Jun 1 · 18 days, 8 sprinkler").
- **Timer editor** — each timer card has a **program tab bar** (A / B / C):
  - **Program A** is always active and enabled. **B / C** show a green/gray dot; clicking a disabled tab shows an "Enable Program X" prompt — no accidental activations.
  - Per active program: **days of week**, **start time**, and a **station table** (run in order) with On/Off toggle and minutes per program; name + baseline gpm are editable on Program A (read-only with a lock on B/C, since they're hardware properties). **Add Station** / Remove on Program A; **Show/hide disabled** collapses off stations.
- **Detection & Billing**: sprinkler-on threshold, gallons/unit, $/unit.
- **Copy baselines to later windows** — applies this window's baselines to every later window (for when you re-measure or change heads).
- **Changed vs. previous window** — a diff of exactly what differs from the chronologically previous window (start times, days, durations, baselines, station add/remove, billing), so each window's notes are backed by a real changelog.
- **Save window** commits edits **in place** — no new window, and the boundary only moves if you changed the date. **Reset** reverts unsaved edits. **Delete window** removes it (the last window can't be deleted).

**Chart integration**: each window's `effectiveFrom` is a marker on the Consumption Chart; clicking a marker jumps to that window. From the dashboard's per-day view, **Tune config for this day** deep-links to the window active on that day.

**Getting data in**, below the editor:
- **Flume sync** — shows how current the stored data is ("Data stored through …") and a **Sync now** button that runs the daily sync immediately. Re-running is harmless.
- **Upload CSV Data** — a link that opens Flume's export page starting from the last stored date, then drag-and-drop or click-to-browse for the downloaded CSV, or paste a URL (GitHub blob URLs are rewritten to raw). New rows merge; duplicates are skipped.

**Export / import**: download the whole config as JSON, or replace it from a file or URL.

**Stored data**: row count and **Clear all data** — inert until `DELETE` is typed. It clears metered rows and derived tables, never the config windows or maintenance flags.

### About (/about)
What the app is, where its data comes from (daily Flume sync, Sync now, CSV for older history), who can sign in, and a link to the design-system page.

---

## User Flows

### First-Time Setup
1. The operator connects Flume once (`npm run flume:connect` locally, then the Flume variables in Vercel — see `docs/RUNBOOK.md`)
2. Sign in with Google → Dashboard empty state → **Go to Config**
3. **Sync now** → toast confirms how many rows arrived (the first sync backfills 20 days); optionally upload a CSV export for older history
4. **Create first config** → verify timers, stations, Program A schedule
5. Enter baseline gpm per station (or skip until seasonal audit)
6. Save config with notes → return to Dashboard

### Weekly Check-In (< 2 min)
1. Open app → Dashboard; data through yesterday is already there
2. Scan Station Alerts for red warnings
3. Review Consumption Chart (opens on 2W) for anomaly markers or unexpected steps; widen to 1M or 3M for context
4. If something looks off — check whether it coincides with a config-change marker
5. Click suspicious day → day's station flow shown in the Per-Station chart below

### Seasonal Config Update (establish a new window)
1. Do physical audit: measure each station's gpm
2. Navigate to Config → **＋ New config**, set **effective date** to when the change took effect on the timer
3. The new window opens as a copy of the prior config — adjust Program A durations and baseline gpm values
4. Optionally add a Program B for a shorter drought schedule
5. Edit notes (e.g. "Spring 2025 — reduced T1-03 to 12 min, updated all baselines") → **Save window**
6. A config-change marker appears on the chart at the effective date; analysis from that date forward uses the new settings

### Tune & Troubleshoot Across Windows
1. Spot a step-change or anomaly on the chart; click the day → per-station flow
2. **Tune config for this day** jumps to the window active then. Adjust start time / baseline / durations and **Save** — the edit stays in place, the window boundary doesn't move
3. Realize the real change happened on a different date? Edit the window's **Effective from** (or create a new window at the right date) — adjacent boundaries follow automatically
4. Use **Changed vs. previous window** to confirm exactly what differs between configs

### Calibrate Timing & Flow from a Real Day
1. Open **Analysis**, step to a representative sprinkler day
2. Read the chart: does actual flow (blue) line up with the configured windows (orange) in time and height?
3. Scan the reconciliation table for rows with large start/duration drift or a big gpm % delta
4. Propose targeted fixes — **start → …** to correct a drifted program, **baseline → …** after a re-measure, **duration → …** to match the real run — or **Stage all changes from this day** to propose everything at once
5. Click **Review & Save**, check the `old → new` list (remove anything you don't want), then **Save to config** — only now is the config written
6. If a zone is broken rather than mis-configured (e.g. flow far below baseline), **⚠ flag** it for maintenance; it shows on the dashboard until cleared

### Anomaly Investigation
1. Anomaly marker (⚠) on chart — not coinciding with a config-change marker
2. Narrow the window to 2W to see daily detail
3. Station Alerts: identify which station is high
4. Click the anomaly bar → Per-Station chart jumps to that day
5. Day Detail: check minute chart for that station
6. Fix hardware; confirm next watering cycle looks normal

---

## Design Principles
1. **Zero friction**: The data is already there when you open the app; nothing to download or upload.
2. **Config is time-aware**: Analysis uses the window active on each date. Each window's effective date is the real-world change date, set explicitly — so tuning a window never distorts history, and you can establish a change on the date it actually happened.
3. **Context on the chart**: Config changes and anomalies are visible directly on the time series, not in a separate panel.
4. **Progressive breakdown**: Simple → Timer → Station. Coarse first, drill when needed.
5. **Flat is healthy**: Weekly chart should be flat; anything else demands attention.
6. **Every window carries notes + a diff**: Each window has change notes and an auto-computed diff vs. the previous window — a lightweight, verifiable change log.
7. **Programs are opt-in**: Program A is the default path. B and C require an explicit enable step; most users never need them.

---

## Storage & Durability
Data lives in a Turso (libSQL/SQLite) database behind a small API, replacing the
original browser-only `localStorage` store (which capped at ~5MB and couldn't
hold multi-year, per-minute data). Benefits: durability across browser resets,
access from multiple devices, and set-based SQL aggregation. The database is now
the source of truth: raw minutes and all derived aggregates (daily rollups, fleet
gpm stats, baseline warnings) live server-side, and **the browser no longer loads
the full per-minute series** — it reads compact aggregate feeds and fetches a
single day only when a minute-level view needs it. **Nothing persists in the
browser at all** — the config windows and maintenance flags moved to the server
too, which is what makes every device show the same settings instead of whatever
that particular browser last remembered. It remains a single-user,
single-property app.

## Out of Scope (V1)
- Multi-user / multi-tenant accounts. Google sign-in identifies *who* is at the door and an allow-list decides who gets in, but there is still no per-user identity inside the app: everyone admitted sees and edits the same single-household data
- Email / SMS alerts
- Weather data integration
- Multi-property support

## Future (V2+)
- Automated anomaly email
- Weather-adjusted baselines (ET-based)
- Seasonal comparison (this spring vs last spring)
- PWA / offline support
- Targeted (incremental) rollup/stats recompute — the last piece of the migration. Everything else is done: config and maintenance are server-owned through `GET`/`PUT /api/config`, and nothing persists in the browser
