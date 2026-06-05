export interface Station {
  id: string
  name: string
  durationMin: number
  enabled: boolean
  baselineGpm?: number // measured during seasonal audit
}

// A saved snapshot of the config, stored in history
export interface ConfigVersion {
  id: string           // uuid-ish timestamp key
  savedAt: string      // ISO timestamp
  notes: string        // user-entered change notes
  config: AppConfig
}

export interface TimerConfig {
  start: string // "HH:MM:SS"
  stations: Station[]
}

export interface AppConfig {
  timer1: TimerConfig
  timer2: TimerConfig
  sprinklerDays: number[] // 0=Mon … 6=Sun
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

export const DEFAULT_CONFIG: AppConfig = {
  timer1: {
    start: "02:01:00",
    stations: [
      { id: "T1-01", name: "T1-01", durationMin: 10, enabled: true },
      { id: "T1-02", name: "T1-02", durationMin: 15, enabled: true },
      { id: "T1-03", name: "T1-03", durationMin: 15, enabled: true },
      { id: "T1-04", name: "T1-04", durationMin: 15, enabled: true },
      { id: "T1-05", name: "T1-05", durationMin: 15, enabled: true },
      { id: "T1-06", name: "T1-06", durationMin: 15, enabled: true },
      { id: "T1-07", name: "T1-07", durationMin: 15, enabled: true },
      { id: "T1-08", name: "T1-08", durationMin: 15, enabled: true },
      { id: "T1-09", name: "T1-09", durationMin: 10, enabled: true },
      { id: "T1-10", name: "T1-10", durationMin: 15, enabled: true },
      { id: "T1-11", name: "T1-11", durationMin: 15, enabled: true },
      { id: "T1-12", name: "T1-12", durationMin: 6, enabled: true },
    ],
  },
  timer2: {
    start: "06:30:00",
    stations: [
      { id: "T2-01", name: "T2-01", durationMin: 0, enabled: false },
      { id: "T2-02", name: "T2-02", durationMin: 0, enabled: false },
      { id: "T2-03", name: "T2-03", durationMin: 6, enabled: true },
      { id: "T2-04", name: "T2-04", durationMin: 15, enabled: true },
      { id: "T2-05", name: "T2-05", durationMin: 0, enabled: false },
      { id: "T2-06", name: "T2-06", durationMin: 0, enabled: false },
      { id: "T2-07", name: "T2-07", durationMin: 5, enabled: true },
      { id: "T2-08", name: "T2-08", durationMin: 5, enabled: true },
      { id: "T2-09", name: "T2-09", durationMin: 5, enabled: true },
      { id: "T2-10", name: "T2-10", durationMin: 0, enabled: false },
      { id: "T2-11", name: "T2-11", durationMin: 0, enabled: false },
      { id: "T2-12", name: "T2-12", durationMin: 3, enabled: true },
      { id: "T2-13", name: "T2-13", durationMin: 0, enabled: false },
      { id: "T2-14", name: "T2-14", durationMin: 0, enabled: false },
      { id: "T2-15", name: "T2-15", durationMin: 0, enabled: false },
      { id: "T2-16", name: "T2-16", durationMin: 0, enabled: false },
      { id: "T2-17", name: "T2-17", durationMin: 0, enabled: false },
      { id: "T2-18", name: "T2-18", durationMin: 0, enabled: false },
      { id: "T2-19", name: "T2-19", durationMin: 3, enabled: true },
      { id: "T2-20", name: "T2-20", durationMin: 3, enabled: true },
      { id: "T2-21", name: "T2-21", durationMin: 3, enabled: true },
      { id: "T2-22", name: "T2-22", durationMin: 3, enabled: true },
      { id: "T2-23", name: "T2-23", durationMin: 3, enabled: true },
      { id: "T2-24", name: "T2-24", durationMin: 3, enabled: true },
      { id: "T2-25", name: "T2-25", durationMin: 3, enabled: true },
    ],
  },
  sprinklerDays: [0, 2, 4], // Mon, Wed, Fri
  sprinklerOnThreshold: 500,
  gallonsPerUnit: 748,
  costPerUnit: 10.47,
}
