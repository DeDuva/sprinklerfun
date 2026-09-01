/**
 * Generate the metered-flow fixtures.
 *
 * Run with:  npx jiti scripts/make-fixtures.ts
 *
 * Why this exists
 * ---------------
 * The fixtures used to be real exports: ~50 continuous days of one household's
 * water use at one-minute resolution, committed to a public repo and served at
 * /default-data.csv. At that resolution the data is an occupancy signal — sleep
 * and wake times, showers, and multi-day absences are all legible. This script
 * replaces it with data that encodes the same *phenomena* and none of the
 * household.
 *
 * What the output has to preserve
 * -------------------------------
 * The delay-estimator regression test pins the values measured from the real
 * meter, so the generated sprinkler day must reproduce them exactly:
 *
 *   timer 1 — stations run back to back, no dead time      → no delay detected
 *   timer 2 — 60 s of dead time between stations           → 60 s
 *             plus 6 min of stations running long          → 16 min overrun,
 *                                                             10 explained, 6 residual
 *
 * Those numbers are not arbitrary — see docs/TECHNICAL_DESIGN.md §7. What the
 * synthetic fixture can no longer prove is that the estimator still agrees with
 * the physical meter; `npm run verify:prod` does that against live data, locally.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { buildDaySchedule } from "../lib/analyze"
import type { AppConfig, ExpectedSegment } from "../lib/types"

const ROOT = process.cwd()
const CONFIG = join(ROOT, "data", "sprinkler-config-2026-08-31.json")

/** The day the regression test reads. A Friday, so program A (days [0,2,4]) runs. */
const FIXTURE_DATE = "2026-08-28"

/** Dead time timer 2's controller inserts between stations, in minutes. */
const T2_GAP_MIN = 1

/** Total minutes timer 2's stations overrun their configured durations. */
const T2_OVERRUN_MIN = 6

/** Background household draw, so a "quiet" minute isn't implausibly zero. */
const HOUSE_GPM = 0.08

// Deterministic jitter: fixtures must be byte-reproducible, so no Math.random.
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x1_0000_0000
  }
}

const dowOf = (date: string) => (new Date(date + "T12:00:00").getDay() + 6) % 7

/**
 * Lay a program's stations onto a minute map.
 *
 * `gapMin` is dead time inserted before every station after the first;
 * `overrunMin` is spread one minute at a time across the longest stations, which
 * is how it presented in the real data (the short tail stations kept their time).
 */
function layProgram(
  minutes: Map<number, number>,
  segs: ExpectedSegment[],
  rand: () => number,
  gapMin: number,
  overrunMin: number
) {
  const ordered = [...segs].sort((a, b) => a.startMin - b.startMin)

  const overrun = new Array(ordered.length).fill(0)
  const byLongest = ordered
    .map((s, i) => ({ i, dur: s.durationMin }))
    .sort((a, b) => b.dur - a.dur || a.i - b.i)
  for (let n = 0; n < overrunMin; n++) overrun[byLongest[n % byLongest.length].i] += 1

  let cursor = ordered[0].startMin
  for (let i = 0; i < ordered.length; i++) {
    if (i > 0) cursor += gapMin // dead time: nothing but house draw
    const gpm = ordered[i].baselineGpm ?? 5
    const runFor = ordered[i].durationMin + overrun[i]
    for (let m = cursor + 1; m <= cursor + runFor; m++) {
      // ±2% so the series isn't suspiciously flat. Small enough that no station
      // crosses the on-threshold, which derives from the lowest baseline.
      minutes.set(m, +(gpm * (0.98 + rand() * 0.04)).toFixed(3))
    }
    cursor += runFor
  }
}

/** One full day of minutes. Dry days are house draw only. */
function buildDay(cfg: AppConfig, date: string, seed: number): Array<{ datetime: string; gallons: number }> {
  const rand = lcg(seed)
  const minutes = new Map<number, number>()

  const schedule = buildDaySchedule(cfg, dowOf(date))
  const byProgram = new Map<string, ExpectedSegment[]>()
  for (const s of schedule) {
    const k = `${s.timer}:${s.programId}`
    if (!byProgram.has(k)) byProgram.set(k, [])
    byProgram.get(k)!.push(s)
  }

  for (const [key, segs] of byProgram) {
    const isTimer2 = key.startsWith("timer2")
    layProgram(minutes, segs, rand, isTimer2 ? T2_GAP_MIN : 0, isTimer2 ? T2_OVERRUN_MIN : 0)
  }

  const rows: Array<{ datetime: string; gallons: number }> = []
  for (let m = 0; m < 1440; m++) {
    const hh = String(Math.floor(m / 60)).padStart(2, "0")
    const mm = String(m % 60).padStart(2, "0")
    const flow = minutes.get(m) ?? +(HOUSE_GPM * (0.5 + rand())).toFixed(3)
    rows.push({ datetime: `${date} ${hh}:${mm}:00`, gallons: flow })
  }
  return rows
}

const addDays = (date: string, n: number) => {
  const d = new Date(date + "T12:00:00")
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

function main() {
  const cfg: AppConfig = JSON.parse(readFileSync(CONFIG, "utf8")).windows[0].config

  // 1. The single-day regression fixture.
  const day = buildDay(cfg, FIXTURE_DATE, 20260828)
  const dayPath = join(ROOT, "data", "fixture-sprinkler-day.json")
  writeFileSync(dayPath, JSON.stringify({ date: FIXTURE_DATE, synthetic: true, rows: day }))
  console.log(`wrote ${dayPath}  (${day.length} minutes)`)

  // 2. A week of demo seed data, so a fresh install has something to render.
  const seedRows: Array<{ datetime: string; gallons: number }> = []
  const start = addDays(FIXTURE_DATE, -6)
  for (let i = 0; i < 7; i++) {
    const d = addDays(start, i)
    seedRows.push(...buildDay(cfg, d, 1000 + i))
  }
  const csv = ["datetime,gallons", ...seedRows.map((r) => `${r.datetime},${r.gallons}`)].join("\n") + "\n"
  const csvPath = join(ROOT, "public", "default-data.csv")
  writeFileSync(csvPath, csv)
  const sprinklerDays = new Set(
    seedRows.filter((r) => r.gallons > 1).map((r) => r.datetime.slice(0, 10))
  )
  console.log(`wrote ${csvPath}  (${seedRows.length} minutes, ${sprinklerDays.size} sprinkler days)`)
}

main()
