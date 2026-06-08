// ---------------------------------------------------------------------------
// Station — hardware definition, shared across all programs
// ---------------------------------------------------------------------------
export interface Station {
  id: string
  name: string
  baselineGpm?: number // measured during seasonal audit
}

// ---------------------------------------------------------------------------
// Program — one scheduling program (A, B, or C) within a timer
// ---------------------------------------------------------------------------
export interface ProgramStation {
  durationMin: number
  enabled: boolean
}

export type ProgramId = "A" | "B" | "C"

export interface ProgramConfig {
  enabled: boolean                          // B and C are off by default
  start: string                             // "HH:MM:SS"
  days: number[]                            // 0=Mon … 6=Sun
  stations: Record<string, ProgramStation>  // keyed by Station.id
}

export interface TimerConfig {
  stations: Station[]   // ordered; defines run order shared across all programs
  programs: { A: ProgramConfig; B: ProgramConfig; C: ProgramConfig }
}

// ---------------------------------------------------------------------------
// ConfigWindow — a config that took effect on a specific date and stays active
// until the next window. The timeline of windows is contiguous: window i covers
// [effectiveFrom_i, effectiveFrom_{i+1}). The earliest window also covers all
// data before it. `effectiveFrom` is the real-world date the change took effect
// on the timer — decoupled from when it was entered in the app (createdAt).
// ---------------------------------------------------------------------------
export interface ConfigWindow {
  id: string           // stable unique id
  effectiveFrom: string // "YYYY-MM-DD" — when this config took effect (editable)
  notes: string        // user-entered change notes
  config: AppConfig
  createdAt: string    // ISO — when this window was created in the app (bookkeeping)
  updatedAt: string    // ISO — last edit (bookkeeping)
}

// Legacy snapshot shape (pre-windows). Kept only for migration / import.
export interface LegacyConfigVersion {
  id: string
  savedAt: string
  notes: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: any
}

export interface AppConfig {
  timer1: TimerConfig
  timer2: TimerConfig
  sprinklerOnThreshold: number // gallons
  gallonsPerUnit: number
  costPerUnit: number
}

// Raw row from Flume CSV after parsing
export interface FlumeRow {
  datetime: string // ISO string
  gallons: number
}

// Enriched row used for analysis
export interface EnrichedRow {
  datetime: string
  date: string        // "YYYY-MM-DD"
  timeMin: number     // minutes since midnight
  gallons: number
  station: string     // station id or "house"
  timer: string       // "timer1" | "timer2" | "house"
  isSprinklerDay: boolean
}

// Chart / aggregation types
export type TimeWindow = "2w" | "1m" | "3m" | "6m" | "1y" | "all"
export type TimeBucket = "day" | "week" | "month"
export type Breakdown  = "simple" | "timer" | "station"

export interface ChartBar {
  label: string       // X-axis display label ("Apr 3", "W22", "Jun 2023")
  dateStart: string   // first date in bucket  "YYYY-MM-DD"
  dateEnd: string     // last date in bucket   "YYYY-MM-DD"
  total: number       // sum of all gallons in bucket
  isAnomaly: boolean
  [key: string]: string | number | boolean  // house, sprinkler, timer1, timer2, or stationId keys
}

export interface StationStats {
  id: string
  name: string
  totalGallons: number
  avgGpm: number
  minGpm: number
  maxGpm: number
  stdGpm: number
  costEstimate: number
  pctOfSprinkler: number
}

// One entry per ISO week (YYYY-Www), for the weekly consumption chart
export interface WeeklyRow {
  weekKey: string   // e.g. "2023-W22"
  weekStart: string // "YYYY-MM-DD" of that Monday
  totalGallons: number
  sprinklerGallons: number
  houseGallons: number
}

// One entry per day, keyed by station id (or "house")
export interface DailyRow {
  date: string
  isSprinklerDay: boolean
  totalGallons: number
  byStation: Record<string, number>
}

// ---------------------------------------------------------------------------
// Helpers for building a default ProgramConfig
// ---------------------------------------------------------------------------

function emptyProgram(start: string): ProgramConfig {
  return { enabled: false, start, days: [], stations: {} }
}

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG: AppConfig = {
  timer1: {
    stations: [
      { id: "T1-01", name: "T1-01" },
      { id: "T1-02", name: "T1-02" },
      { id: "T1-03", name: "T1-03" },
      { id: "T1-04", name: "T1-04" },
      { id: "T1-05", name: "T1-05" },
      { id: "T1-06", name: "T1-06" },
      { id: "T1-07", name: "T1-07" },
      { id: "T1-08", name: "T1-08" },
      { id: "T1-09", name: "T1-09" },
      { id: "T1-10", name: "T1-10" },
      { id: "T1-11", name: "T1-11" },
      { id: "T1-12", name: "T1-12" },
    ],
    programs: {
      A: {
        enabled: true,
        start: "02:01:00",
        days: [0, 2, 4], // Mon, Wed, Fri
        stations: {
          "T1-01": { durationMin: 10, enabled: true },
          "T1-02": { durationMin: 15, enabled: true },
          "T1-03": { durationMin: 15, enabled: true },
          "T1-04": { durationMin: 15, enabled: true },
          "T1-05": { durationMin: 15, enabled: true },
          "T1-06": { durationMin: 15, enabled: true },
          "T1-07": { durationMin: 15, enabled: true },
          "T1-08": { durationMin: 15, enabled: true },
          "T1-09": { durationMin: 10, enabled: true },
          "T1-10": { durationMin: 15, enabled: true },
          "T1-11": { durationMin: 15, enabled: true },
          "T1-12": { durationMin: 6,  enabled: true },
        },
      },
      B: emptyProgram("02:01:00"),
      C: emptyProgram("02:01:00"),
    },
  },
  timer2: {
    stations: [
      { id: "T2-01", name: "T2-01" },
      { id: "T2-02", name: "T2-02" },
      { id: "T2-03", name: "T2-03" },
      { id: "T2-04", name: "T2-04" },
      { id: "T2-05", name: "T2-05" },
      { id: "T2-06", name: "T2-06" },
      { id: "T2-07", name: "T2-07" },
      { id: "T2-08", name: "T2-08" },
      { id: "T2-09", name: "T2-09" },
      { id: "T2-10", name: "T2-10" },
      { id: "T2-11", name: "T2-11" },
      { id: "T2-12", name: "T2-12" },
      { id: "T2-13", name: "T2-13" },
      { id: "T2-14", name: "T2-14" },
      { id: "T2-15", name: "T2-15" },
      { id: "T2-16", name: "T2-16" },
      { id: "T2-17", name: "T2-17" },
      { id: "T2-18", name: "T2-18" },
      { id: "T2-19", name: "T2-19" },
      { id: "T2-20", name: "T2-20" },
      { id: "T2-21", name: "T2-21" },
      { id: "T2-22", name: "T2-22" },
      { id: "T2-23", name: "T2-23" },
      { id: "T2-24", name: "T2-24" },
      { id: "T2-25", name: "T2-25" },
    ],
    programs: {
      A: {
        enabled: true,
        start: "06:30:00",
        days: [0, 2, 4],
        stations: {
          "T2-01": { durationMin: 0,  enabled: false },
          "T2-02": { durationMin: 0,  enabled: false },
          "T2-03": { durationMin: 6,  enabled: true },
          "T2-04": { durationMin: 15, enabled: true },
          "T2-05": { durationMin: 0,  enabled: false },
          "T2-06": { durationMin: 0,  enabled: false },
          "T2-07": { durationMin: 5,  enabled: true },
          "T2-08": { durationMin: 5,  enabled: true },
          "T2-09": { durationMin: 5,  enabled: true },
          "T2-10": { durationMin: 0,  enabled: false },
          "T2-11": { durationMin: 0,  enabled: false },
          "T2-12": { durationMin: 3,  enabled: true },
          "T2-13": { durationMin: 0,  enabled: false },
          "T2-14": { durationMin: 0,  enabled: false },
          "T2-15": { durationMin: 0,  enabled: false },
          "T2-16": { durationMin: 0,  enabled: false },
          "T2-17": { durationMin: 0,  enabled: false },
          "T2-18": { durationMin: 0,  enabled: false },
          "T2-19": { durationMin: 3,  enabled: true },
          "T2-20": { durationMin: 3,  enabled: true },
          "T2-21": { durationMin: 3,  enabled: true },
          "T2-22": { durationMin: 3,  enabled: true },
          "T2-23": { durationMin: 3,  enabled: true },
          "T2-24": { durationMin: 3,  enabled: true },
          "T2-25": { durationMin: 3,  enabled: true },
        },
      },
      B: emptyProgram("06:30:00"),
      C: emptyProgram("06:30:00"),
    },
  },
  sprinklerOnThreshold: 500,
  gallonsPerUnit: 748,
  costPerUnit: 10.47,
}

// ---------------------------------------------------------------------------
// Migration: convert old-format configs (pre-programs) to the current format.
// Safe to call on already-migrated configs — passes through unchanged.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function migrateConfig(raw: any): AppConfig {
  if (!raw || typeof raw !== "object") return DEFAULT_CONFIG

  // Detect old format: timer1 has a top-level `start` string
  const isOldFormat = typeof raw.timer1?.start === "string"
  if (!isOldFormat) {
    // Already new format — return as-is (trust the shape)
    return raw as AppConfig
  }

  const globalDays: number[] = Array.isArray(raw.sprinklerDays) ? raw.sprinklerDays : [0, 2, 4]

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function migrateTimer(oldTimer: any): TimerConfig {
    const start: string = oldTimer.start ?? "06:00:00"
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const oldStations: any[] = Array.isArray(oldTimer.stations) ? oldTimer.stations : []

    const stations: Station[] = oldStations.map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (s: any) => ({
        id: s.id,
        name: s.name,
        ...(s.baselineGpm != null ? { baselineGpm: s.baselineGpm } : {}),
      })
    )

    const programAStations: Record<string, ProgramStation> = {}
    for (const s of oldStations) {
      programAStations[s.id] = {
        durationMin: s.durationMin ?? 0,
        enabled: s.enabled ?? false,
      }
    }

    return {
      stations,
      programs: {
        A: { enabled: true, start, days: globalDays, stations: programAStations },
        B: emptyProgram(start),
        C: emptyProgram(start),
      },
    }
  }

  return {
    timer1: migrateTimer(raw.timer1),
    timer2: migrateTimer(raw.timer2),
    sprinklerOnThreshold: raw.sprinklerOnThreshold ?? 500,
    gallonsPerUnit: raw.gallonsPerUnit ?? 748,
    costPerUnit: raw.costPerUnit ?? 10.47,
  }
}

// ---------------------------------------------------------------------------
// Window helpers — time normalization, id generation, and migration to the
// ConfigWindow model. Used by the store (persist migrate / rehydrate), the
// config import flow, and the StoreProvider default-config loader.
// ---------------------------------------------------------------------------

/** Normalize a time string to "HH:MM:SS". Fixes malformed values like
 *  "03:45:00:00" (an old data bug) by keeping only the first three parts. */
export function normalizeTime(t: string): string {
  if (typeof t !== "string" || t.trim() === "") return "00:00:00"
  const parts = t.split(":")
  const h = (parts[0] ?? "0").padStart(2, "0").slice(0, 2)
  const m = (parts[1] ?? "0").padStart(2, "0").slice(0, 2)
  const s = (parts[2] ?? "0").padStart(2, "0").slice(0, 2)
  return `${h}:${m}:${s}`
}

/** Normalize every program start time in a config (defensive against old data). */
export function normalizeConfigTimes(config: AppConfig): AppConfig {
  if (!config?.timer1 || !config?.timer2) return config
  const fixProg = (p: ProgramConfig): ProgramConfig =>
    p ? { ...p, start: normalizeTime(p.start) } : p
  const fixTimer = (t: TimerConfig): TimerConfig =>
    t?.programs
      ? { ...t, programs: { A: fixProg(t.programs.A), B: fixProg(t.programs.B), C: fixProg(t.programs.C) } }
      : t
  return { ...config, timer1: fixTimer(config.timer1), timer2: fixTimer(config.timer2) }
}

/** Stable unique id (crypto.randomUUID when available, else timestamp+random). */
export function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

/** Windows sorted ascending by effectiveFrom (timeline order). */
export function sortWindows(windows: ConfigWindow[]): ConfigWindow[] {
  return [...windows].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
}

/** Map a legacy { savedAt } version to a ConfigWindow (effectiveFrom = save date). */
export function legacyVersionToWindow(v: LegacyConfigVersion): ConfigWindow {
  const savedAt = v?.savedAt ?? new Date().toISOString()
  return {
    id: v?.id ?? newId(),
    effectiveFrom: savedAt.slice(0, 10),
    notes: v?.notes ?? "",
    config: normalizeConfigTimes(migrateConfig(v?.config)),
    createdAt: savedAt,
    updatedAt: savedAt,
  }
}

/** Coerce a possibly-partial window object into a valid ConfigWindow. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeWindow(w: any): ConfigWindow {
  const fallback = new Date().toISOString()
  const effectiveFrom = (w?.effectiveFrom ?? w?.savedAt ?? fallback).slice(0, 10)
  return {
    id: w?.id ?? newId(),
    effectiveFrom,
    notes: w?.notes ?? "",
    config: normalizeConfigTimes(migrateConfig(w?.config)),
    createdAt: w?.createdAt ?? w?.savedAt ?? fallback,
    updatedAt: w?.updatedAt ?? w?.createdAt ?? w?.savedAt ?? fallback,
  }
}

/**
 * Collapse windows that share an effectiveFrom date, keeping the most recently
 * created one. The window model is day-resolution and contiguous, so only one
 * config can be active per date. Legacy data often has several saves on the same
 * day; old analysis already used only the last save per day, so keeping the
 * latest is behavior-preserving. Returns the result sorted ascending.
 */
export function dedupeByEffectiveFrom(windows: ConfigWindow[]): ConfigWindow[] {
  const byDate = new Map<string, ConfigWindow>()
  for (const w of windows) {
    const existing = byDate.get(w.effectiveFrom)
    if (!existing || w.createdAt > existing.createdAt) byDate.set(w.effectiveFrom, w)
  }
  return sortWindows([...byDate.values()])
}

/**
 * Build a sorted, de-duplicated ConfigWindow[] from any persisted/bundle shape —
 * new ({ windows }) or legacy ({ config, configHistory }). Always normalizes
 * config times and collapses same-day entries. Returns [] only when there is
 * genuinely nothing to seed from.
 */
export function toWindows(input: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  windows?: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config?: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  configHistory?: any
}): ConfigWindow[] {
  if (Array.isArray(input?.windows) && input.windows.length > 0) {
    return dedupeByEffectiveFrom(input.windows.map(normalizeWindow))
  }
  const history = Array.isArray(input?.configHistory) ? input.configHistory : []
  if (history.length > 0) {
    return dedupeByEffectiveFrom(history.map(legacyVersionToWindow))
  }
  if (input?.config) {
    const now = new Date().toISOString()
    return [
      {
        id: newId(),
        effectiveFrom: now.slice(0, 10),
        notes: "Initial config",
        config: normalizeConfigTimes(migrateConfig(input.config)),
        createdAt: now,
        updatedAt: now,
      },
    ]
  }
  return []
}
