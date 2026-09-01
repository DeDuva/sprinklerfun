/**
 * Re-run the delay estimator against LIVE production data.
 *
 * Run with:  npm run verify:prod
 *
 * Why this exists
 * ---------------
 * The regression test in lib/__tests__/analyze.test.ts used to read a real
 * metered day, which meant a green suite genuinely proved "the estimator still
 * says what the meter says". That fixture is now synthetic (see
 * scripts/make-fixtures.ts), so the suite proves something narrower: that a known
 * signature still decomposes the same way.
 *
 * This script restores the missing half, on demand. It is deliberately NOT in CI:
 * it depends on the network, on live data that changes under it, and on a
 * deployment being up — all reasons for a human to run it and read the output,
 * and none of them reasons to fail someone's pull request.
 *
 * Everything it does is a read.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  buildDaySchedule,
  buildDayMinuteSeries,
  enrichRows,
  activeWindowForDate,
  currentConfig,
  inferStationDelay,
  recommendStationDelays,
} from "../lib/analyze"
import type { ConfigWindow, DelayFit, FlumeRow, RollupRow } from "../lib/types"

const BASE = process.env.SPRINKLER_URL ?? "https://sprinklerfun.vercel.app"
const DAYS = Number(process.env.DAYS ?? 12)

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`)
  if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}`)
  return (await res.json()) as T
}

const show = (v: unknown) => (v === null ? "no delay" : v === undefined ? "missing" : `${v}s`)

const fmt = (r: Record<string, unknown>) =>
  `  ${r.timer}: ${r.delaySec === null ? "no delay" : r.delaySec + "s"}` +
  ` (configured ${r.configuredSec}s) · fit ${r.daysFit}/${r.daysTotal}` +
  ` · overrun ${r.medianElongationMin ?? "-"}m = delay ${r.medianExplainedMin ?? "-"}m` +
  ` + duration ${r.medianResidualMin ?? "-"}m`

async function main() {
  console.log(`Verifying against ${BASE}\n`)

  const health = await getJson<{ ok: boolean; rows: number }>("/api/health")
  console.log(`health: ${health.ok ? "ok" : "DEGRADED"}, ${health.rows.toLocaleString()} rows\n`)

  console.log("What production reports:")
  const { recommendations } = await getJson<{ recommendations: Record<string, unknown>[] }>(
    `/api/delay?days=${DAYS}`
  )
  for (const r of recommendations) console.log(fmt(r))

  // Recompute locally from raw rows, so a server-side regression cannot agree
  // with itself. Config comes from the committed snapshot rather than an API —
  // there is deliberately no endpoint exposing the window set, and if that
  // snapshot has drifted from what production runs, a disagreement here is
  // itself the useful signal.
  const windows: ConfigWindow[] = JSON.parse(
    readFileSync(join(process.cwd(), "data", "sprinkler-config-2026-08-31.json"), "utf8")
  ).windows

  const { rollups } = await getJson<{ rollups: RollupRow[] }>("/api/rollup")
  const dates = [...new Set(rollups.filter((r) => r.isSprinklerDay).map((r) => r.date))]
    .sort()
    .slice(-DAYS)

  const fits: DelayFit[] = []
  for (const date of dates) {
    const cfg = activeWindowForDate(windows, date)?.config ?? currentConfig(windows)
    const dow = (new Date(date + "T12:00:00").getDay() + 6) % 7
    const { rows } = await getJson<{ rows: FlumeRow[] }>(`/api/day/${date}`)
    const series = buildDayMinuteSeries(enrichRows(rows, cfg).filter((r) => r.date === date))
    fits.push(...inferStationDelay(series, buildDaySchedule(cfg, dow), date))
  }

  const local = recommendStationDelays(fits, currentConfig(windows))
  console.log(`\nRecomputed locally from raw rows (${dates.length} days, committed config):`)
  for (const r of local) console.log(fmt(r as unknown as Record<string, unknown>))

  // Compare only the recommended delay. The other columns legitimately differ
  // whenever the committed config snapshot predates a config change made in the
  // app: production measures elongation against a schedule that already contains
  // the delay, the snapshot against one that does not. The delay each arrives at
  // is the invariant, and it is what the estimator actually claims.
  console.log("\nAgreement on the inferred delay:")
  let ok = true
  for (const l of local) {
    const p = recommendations.find((r) => r.timer === l.timer)
    const same = (p?.delaySec ?? null) === l.delaySec
    if (!same) ok = false
    console.log(
      `  ${same ? "✅" : "❌"} ${l.timer}: production ${show(p?.delaySec)} vs local ${show(l.delaySec)}`
    )
    if (p && p.configuredSec !== l.configuredSec) {
      console.log(
        `     note: configured differs (${p.configuredSec}s live vs ${l.configuredSec}s in the` +
          ` committed snapshot) — export the config again to refresh it`
      )
    }
  }
  if (!ok) {
    console.log("\nThe deployed build and this checkout disagree about the analysis.")
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error(String(err))
  process.exitCode = 1
})
