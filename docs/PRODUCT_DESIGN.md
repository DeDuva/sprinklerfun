# SprinklerFun — Product Design

## Overview
A client-side web application that helps a homeowner analyze Flume smart meter data to understand and optimize sprinkler water usage. All data and computation lives in the browser — no accounts, no backend, no server costs.

## User Persona
**Primary User**: Homeowner with a Flume smart meter and a two-timer, multi-zone sprinkler system (EBMUD service area).
- Wants to spot broken or wasteful sprinklers quickly
- Checks in weekly after downloading a new Flume CSV export
- Makes seasonal schedule adjustments a few times a year; keeps notes on what changed and why
- Does a seasonal audit: physically measures each station's flow rate and records the baseline gpm
- Comfortable with web apps, not with Jupyter notebooks

---

## Core Data Model

### Input Data
Flume exports a CSV with a `datetime` column and `gallons` column (one row per minute).

### Configuration (versioned)
```
timers:
  T1: { start: "HH:MM:SS", stations: [{ id, name, durationMin, enabled, baselineGpm }] }
  T2: { start: "HH:MM:SS", stations: [...] }
sprinklerDays: number[]          # 0=Mon … 6=Sun
sprinklerOnThreshold: number     # gallons during sprinkler window → counts as sprinkler day
gallonsPerUnit: 748              # EBMUD billing unit
costPerUnit: 10.47               # $/unit
```

**Config is time-aware.** Each `ConfigVersion { id, savedAt, notes, config }` has an effective date. When analyzing data, the config version active on each date is used — not the current config. This means:
- A config saved on June 1 applies to all data from June 1 onward, until the next config change.
- Data before the first saved config uses the built-in default.
- Changing the config today does not retroactively change how past data is interpreted.

---

## Features

### Consumption Chart (primary visualization)

The main chart is a unified time-series visualization that answers three questions simultaneously:
1. How much water have we used, and is it stable over time?
2. What changed — schedule, config, or hardware failure?
3. Which part of the system is responsible?

**Time Window** (top-right button group):
`2W | 1M | 3M | 6M | 1Y | All`

The bar granularity adapts to the window:
- 2W, 1M → daily bars
- 3M, 6M → weekly bars
- 1Y, All → monthly bars

**Breakdown** (segmented control below window selector):
- **Simple** (default): House vs. Sprinkler — two stacks, easy to read
- **By Timer**: House · Timer 1 · Timer 2 — isolates which timer runs more
- **By Station**: House + one color per station — most granular, useful for diagnosing a specific zone

The breakdown level is independent of the time window. Users can combine any window with any breakdown.

**Config-change markers:**
Vertical dashed lines on the chart at every date a config was saved within the visible window. On hover, shows the config notes. This makes it easy to distinguish "usage jumped because I changed the schedule" from "usage jumped for no obvious reason."

**Anomaly markers:**
Bars that fall outside the normal range (IQR-based outlier detection) get a small warning indicator (⚠ above the bar). This surfaces leaks and blockages at a glance without requiring the user to compute anything.

**Design rationale:**
- One chart, not four. The user should not have to navigate between views to understand a trend.
- Config changes as first-class visual objects. Without them, a step-change in consumption looks alarming; with them, the user immediately sees "oh, that's when I adjusted the schedule."
- Progressive breakdown. Start coarse (Simple), drill in when something looks wrong.
- Anomaly marks are non-intrusive. They don't yell; they whisper. The user can scan for ⚠ without being overwhelmed.

---

### Dashboard (/)
The primary landing page. Top-to-bottom layout:

1. **Station Alerts panel** — red warning per station running >20% above baseline for 2+ consecutive days; green all-clear otherwise; prompt to add baselines if none set.
2. **Summary Cards** — Total gallons · Sprinkler gallons · House gallons · Estimated cost, scoped to the selected window.
3. **Consumption Chart** — the unified chart described above.
4. **Per-Station Flow Rate** — horizontal bar chart with baseline reference lines; bars >20% above baseline turn red.

### Analysis (/analysis)
Deep-dive into station performance across all loaded data:
- Sortable table: station name, total gallons, avg gpm, std gpm, % of sprinkler total, estimated cost
- Horizontal bar chart with error bars (avg ± std)
- Data is analyzed using the time-appropriate config version for each date range

### Day Detail (/day/[date])
Minute-by-minute view for a single sprinkler day, using the config version active on that date:
- Stacked area chart: each station's contribution by minute
- Summary cards: total, sprinkler, house, day cost
- Station summary table

### Configuration (/config)

**Timer Editor**
- Start time pickers for Timer 1 and Timer 2
- Station table (one row per station): On | Name | Duration (min) | Baseline gpm
- Baseline gpm entered after physical seasonal audit

**Watering Schedule**: day-of-week checkboxes

**Detection & Billing**: sprinkler-on threshold, gallons/unit, $/unit

**Save flow**: clicking Save opens a dialog requiring change notes (enforces a change log).

**Configuration History**
- Collapsible list of all saved versions: date/time, notes, baseline count
- Expand to see full station list; click Restore to load into editor
- History is never pruned
- Config versions are shown as markers on the Consumption Chart

**Data management**: row count; clear-all button.

### Upload (modal, accessible from nav)
- Drag-and-drop or click-to-browse
- URL input: paste a GitHub blob URL; auto-converted to raw
- New rows merged; duplicates skipped

---

## User Flows

### First-Time Setup
1. Land on Dashboard → empty state → click Upload CSV
2. Upload or URL-load Flume CSV → toast confirms row count
3. Navigate to Config → verify timers, stations
4. Enter baseline gpm per station (or skip until seasonal audit)
5. Save config with notes → return to Dashboard

### Weekly Check-In (< 2 min)
1. Open app → Dashboard
2. Upload new CSV → data appends
3. Scan Station Alerts for red warnings
4. Review Consumption Chart (1M window) for anomaly markers or unexpected steps
5. If something looks off — check whether it coincides with a config-change marker
6. Click suspicious day → Day Detail

### Seasonal Config Update
1. Do physical audit: measure each station's gpm
2. Navigate to Config
3. Update durations and baseline gpm values
4. Save → enter notes (e.g. "Spring 2025 — reduced T1-03 to 12 min, updated all baselines")
5. Config change marker appears on the chart going forward

### Anomaly Investigation
1. Anomaly marker (⚠) on chart — not coinciding with a config-change marker
2. Narrow the window to 2W to see daily detail
3. Station Alerts: identify which station is high
4. Day Detail: check minute chart for that station
5. Fix hardware; confirm next watering cycle looks normal

---

## Design Principles
1. **Zero friction**: Upload → see charts immediately.
2. **Config is time-aware**: Analysis uses the right config for each date — changing today's config never distorts history.
3. **Context on the chart**: Config changes and anomalies are visible directly on the time series, not in a separate panel.
4. **Progressive breakdown**: Simple → Timer → Station. Coarse first, drill when needed.
5. **Flat is healthy**: Weekly chart should be flat; anything else demands attention.
6. **Notes are mandatory on config save**: Enforces a lightweight change log.

---

## Out of Scope (V1)
- Multi-user / auth
- Direct Flume API integration
- Email / SMS alerts
- Weather data integration
- Multi-property support

## Future (V2+)
- Automated anomaly email
- Weather-adjusted baselines (ET-based)
- Seasonal comparison (this spring vs last spring)
- PWA / offline support
