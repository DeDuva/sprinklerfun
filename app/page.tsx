"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { useStore } from "@/lib/store"
import {
  enrichRows,
  buildDailyRows,
  buildStationStats,
  computeSummary,
  rollupsToDailyRows,
  rollupsToEnriched,
  stationTimerMap,
  activeWindowForDate,
  currentConfig,
} from "@/lib/analyze"
import { fetchRollups, fetchStats, fetchDayRows } from "@/lib/backend"
import type { FlumeRow, RollupRow, StatsPayload } from "@/lib/types"
import SummaryCards from "@/components/SummaryCards"
import ConsumptionChart from "@/components/ConsumptionChart"
import StationFlowChart from "@/components/StationFlowChart"
import WarningsPanel from "@/components/WarningsPanel"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import Flo from "@/components/design/Flo"
import RefreshDataCard from "@/components/RefreshDataCard"

function ymKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
}

function addMonth(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number)
  const d = new Date(y, m - 1 + delta, 1)
  return ymKey(d)
}

function fmt(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export default function DashboardPage() {
  const router        = useRouter()
  const windows       = useStore((s) => s.windows)
  const serverVersion = useStore((s) => s.serverVersion)
  const maintenance   = useStore((s) => s.maintenance)

  // "Current" config (today's window) — for billing, names, and warning baselines.
  const config = useMemo(() => currentConfig(windows), [windows])

  // ---- Server-derived data (rollups + precomputed stats) -----------------
  // Phase 3: the browser no longer loads the full per-minute series. The chart
  // and monthly summary come from GET /api/rollup; the warnings come from the
  // precomputed GET /api/stats feed. Refetched whenever the server data changes.
  const [rollups, setRollups] = useState<RollupRow[] | null>(null)
  const [stats, setStats] = useState<StatsPayload | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([fetchRollups(), fetchStats()])
      .then(([r, s]) => {
        if (cancelled) return
        setRollups(r)
        setStats(s)
      })
      .catch(() => {
        if (cancelled) return
        setRollups([])
        setStats(null)
      })
    return () => { cancelled = true }
  }, [serverVersion])

  const [selectedFlowDay, setSelectedFlowDay] = useState<string | null>(null)

  // Month selector — default to current month
  const today = new Date()
  const currentMonth = ymKey(today)
  const [selectedMonth, setSelectedMonth] = useState(currentMonth)

  // ---- Reconstruct DailyRow[] + synthetic EnrichedRow[] from rollups ------
  const derived = useMemo(() => {
    if (!rollups || rollups.length === 0) return null

    const allDaily = rollupsToDailyRows(rollups)
    const enriched = rollupsToEnriched(rollups, stationTimerMap(windows))

    const hasBaselines = [
      ...config.timer1.stations,
      ...config.timer2.stations,
    ].some((s) => s.baselineGpm && s.baselineGpm > 0)

    const first = allDaily[0]?.date
    const last  = allDaily[allDaily.length - 1]?.date
    const dateRange = first && last ? { first, last } : null

    const sprinklerDates = allDaily.filter((d) => d.isSprinklerDay).map((d) => d.date)
    const defaultFlowDay = sprinklerDates.length > 0
      ? sprinklerDates[sprinklerDates.length - 1]
      : (last ?? null)

    return { enriched, allDaily, hasBaselines, dateRange, sprinklerDates, defaultFlowDay }
  }, [rollups, windows, config])

  const warnings = stats?.warnings ?? []

  // ---- Monthly summary (cheap filter — reruns only when month changes) ---
  const monthlySummary = useMemo(() => {
    if (!derived) return null

    const [y, m] = selectedMonth.split("-").map(Number)
    const monthStart   = `${selectedMonth}-01`
    const monthLastDay = new Date(y, m, 0).toISOString().slice(0, 10)
    const todayStr     = today.toISOString().slice(0, 10)
    const effectiveEnd = selectedMonth === currentMonth ? todayStr : monthLastDay

    const monthly  = derived.allDaily.filter((d) => d.date >= monthStart && d.date <= effectiveEnd)
    const summary  = computeSummary(monthly, config)

    const fmtOpts = (year?: "numeric"): Intl.DateTimeFormatOptions =>
      ({ month: "short", day: "numeric", ...(year ? { year } : {}) })
    const startFmt = new Date(monthStart  + "T12:00:00").toLocaleDateString(undefined, fmtOpts())
    const endFmt   = new Date(effectiveEnd + "T12:00:00").toLocaleDateString(undefined, fmtOpts("numeric"))
    const monthFmt = new Date(monthStart  + "T12:00:00").toLocaleDateString(undefined, { month: "long", year: "numeric" })

    return { summary, rangeLabel: `${startFmt} – ${endFmt}`, monthFmt }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [derived, selectedMonth, config])

  // ---- Per-station flow for the selected day (single-day fetch + enrich) --
  // Fetch just ONE day's raw rows and enrich them client-side (cheap) — the
  // per-station gpm chart needs the per-minute series, but only for this day.
  const flowDay = selectedFlowDay ?? derived?.defaultFlowDay ?? null
  const [dayData, setDayData] = useState<{ day: string; rows: FlumeRow[] } | null>(null)

  useEffect(() => {
    if (!flowDay) return
    let cancelled = false
    fetchDayRows(flowDay)
      .then((rows) => { if (!cancelled) setDayData({ day: flowDay, rows }) })
      .catch(() => { if (!cancelled) setDayData({ day: flowDay, rows: [] }) })
    return () => { cancelled = true }
  }, [flowDay, serverVersion])

  const flowDayStats = useMemo(() => {
    // Ignore a stale fetch for a different day (e.g. mid day-switch).
    if (!derived || !dayData || dayData.day !== flowDay) return null
    const { day, rows } = dayData

    // Use the config window active on this day (matches enrichRowsMultiConfig)
    const activeWin = activeWindowForDate(windows, day)
    const dayConfig = activeWin?.config ?? config
    const enriched = enrichRows(rows, dayConfig)
    const dayDaily = buildDailyRows(enriched)
    const daySummary = computeSummary(dayDaily, dayConfig)
    const configVersionLabel = activeWin
      ? new Date(activeWin.effectiveFrom + "T12:00:00").toLocaleDateString(undefined, {
          month: "short", day: "numeric", year: "numeric",
        })
      : null

    return { stats: buildStationStats(enriched, dayConfig), day, dayConfig, daySummary, configVersionLabel }
  }, [derived, dayData, flowDay, windows, config])

  // Month nav bounds
  const firstMonth = derived?.dateRange?.first.slice(0, 7) ?? currentMonth
  const prevMonth  = addMonth(selectedMonth, -1)
  const nextMonth  = addMonth(selectedMonth,  1)
  const canGoPrev  = derived ? prevMonth >= firstMonth : false
  const canGoNext  = derived ? nextMonth <= currentMonth : false

  // Maintenance flags → dashboard entries (resolve names from current config).
  const maintenanceEntries = useMemo(() => {
    const ids = Object.keys(maintenance)
    if (ids.length === 0) return []
    const nameById: Record<string, string> = {}
    for (const s of [...config.timer1.stations, ...config.timer2.stations]) {
      nameById[s.id] = s.name
    }
    return ids.map((id) => ({
      stationId: id,
      name: nameById[id] ?? id,
      note: maintenance[id].note,
      flaggedAt: maintenance[id].flaggedAt,
    }))
  }, [maintenance, config])

  const fmtDate = (d: string) =>
    new Date(d + "T12:00:00").toLocaleDateString(undefined, {
      month: "short", day: "numeric", year: "numeric",
    })

  // Empty state only once we've loaded and confirmed there's genuinely no data.
  if (rollups !== null && rollups.length === 0) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold text-[#143049]" style={{ fontFamily: "var(--font-fredoka)" }}>
          Dashboard
        </h1>
        <div className="rounded-2xl border-2 border-dashed border-[#EADFC6] bg-white p-10 text-center flex flex-col items-center gap-3">
          <Flo mood="watching" size={72} />
          <p className="text-[#143049] text-lg font-medium">No data yet</p>
          <p className="text-[#4A6076] text-sm mb-2">Load your latest Flume export to get started.</p>
          <div className="w-full max-w-xl">
            <RefreshDataCard />
          </div>
        </div>
      </div>
    )
  }

  // Flo's plain-English headline for this month.
  const floMood = warnings.length > 0 ? "alert" : "happy"
  const floHeadline = monthlySummary
    ? `Your yard used ${fmt(monthlySummary.summary.totalGallons)} gal in ${monthlySummary.monthFmt}${
        monthlySummary.summary.totalGallons > 0
          ? ` — about $${monthlySummary.summary.estimatedCost.toLocaleString(undefined, { maximumFractionDigits: 2 })} so far.`
          : "."
      }`
    : "Crunching the numbers…"
  const floNote = warnings.length > 0
    ? `Worth a look: ${warnings.map((w) => w.stationName).join(", ")} running above baseline.`
    : derived && derived.hasBaselines
      ? "Everything's tracking within baseline. 🌿"
      : null

  return (
    <div className="space-y-6">
      <RefreshDataCard />

      {/* Flo's headline */}
      <div className="rounded-2xl border-2 border-[#143049] bg-gradient-to-b from-white to-[#FFFDF8] p-5 shadow-[4px_4px_0_rgba(20,48,73,0.08)] flex items-center gap-4 flex-wrap">
        <Flo mood={floMood} size={64} idle />
        <div className="flex-1 min-w-[220px]">
          <p className="text-lg sm:text-xl font-semibold text-[#143049] leading-snug" style={{ fontFamily: "var(--font-fredoka)" }}>
            {floHeadline}
          </p>
          {floNote && (
            <p className={`text-sm mt-0.5 ${warnings.length > 0 ? "text-[#B33B2E]" : "text-[#4A6076]"}`}>
              {floNote}
            </p>
          )}
          {derived?.dateRange && (
            <p className="text-xs text-gray-400 mt-1">
              Data: {fmtDate(derived.dateRange.first)} – {fmtDate(derived.dateRange.last)}
            </p>
          )}
        </div>
      </div>

      {/* Warnings */}
      <div>
        <h2 className="text-sm font-semibold text-gray-600 uppercase tracking-wide mb-2">
          Station Alerts
        </h2>
        {derived ? (
          <WarningsPanel warnings={warnings} hasBaselines={derived.hasBaselines} maintenance={maintenanceEntries} />
        ) : (
          <div className="h-10 rounded-lg bg-gray-100 animate-pulse" />
        )}
      </div>

      {/* Summary cards — selected month */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-sm font-semibold text-gray-600 uppercase tracking-wide">
            Monthly Summary
          </h2>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setSelectedMonth(prevMonth)}
              disabled={!canGoPrev}
              className="px-1.5 py-0.5 rounded text-gray-500 disabled:opacity-25 hover:bg-gray-100 transition-colors text-sm"
              aria-label="Previous month"
            >
              ←
            </button>
            <span className="text-sm font-medium text-gray-700 w-28 text-center">
              {monthlySummary?.monthFmt ?? "—"}
            </span>
            <button
              onClick={() => setSelectedMonth(nextMonth)}
              disabled={!canGoNext}
              className="px-1.5 py-0.5 rounded text-gray-500 disabled:opacity-25 hover:bg-gray-100 transition-colors text-sm"
              aria-label="Next month"
            >
              →
            </button>
          </div>
        </div>

        {monthlySummary?.rangeLabel && (
          <p className="text-xs text-gray-400 mb-2">{monthlySummary.rangeLabel}</p>
        )}

        {monthlySummary ? (
          <SummaryCards {...monthlySummary.summary} />
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-24 rounded-lg bg-gray-100 animate-pulse" />
            ))}
          </div>
        )}
      </div>

      {/* Unified consumption chart */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Consumption Over Time
            <span className="ml-2 text-xs font-normal text-gray-400">
              Flat = healthy · steps up = investigate
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {derived ? (
            <ConsumptionChart
              enriched={derived.enriched}
              windows={windows}
              onDaySelect={setSelectedFlowDay}
              selectedDay={selectedFlowDay ?? derived.defaultFlowDay}
              onConfigClick={(id) => router.push(`/config?window=${id}`)}
            />
          ) : (
            <div className="h-80 rounded bg-gray-100 animate-pulse" />
          )}
        </CardContent>
      </Card>

      {/* Per-station flow — selected day */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-base">
              Per-Station Flow Rate
              <span className="ml-2 text-xs font-normal text-gray-400">
                orange dashes = your baseline
              </span>
            </CardTitle>
            {flowDayStats && (
              <Link
                href={`/config?date=${flowDayStats.day}`}
                className="text-xs text-violet-600 hover:text-violet-800 hover:underline shrink-0"
                title="Edit the config that was active on this day"
              >
                ⚙ Tune config for this day →
              </Link>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {flowDayStats ? (
            <>
              {/* Day summary tiles */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="bg-gray-50 rounded-lg px-4 py-3">
                  <p className="text-xs text-gray-500 font-medium">Total</p>
                  <p className="text-xl font-bold mt-0.5">
                    {fmt(flowDayStats.daySummary.totalGallons)}
                    <span className="text-xs font-normal text-gray-400 ml-1">gal</span>
                  </p>
                </div>
                <div className="bg-sky-50 rounded-lg px-4 py-3">
                  <p className="text-xs text-gray-500 font-medium">Sprinkler</p>
                  <p className="text-xl font-bold text-sky-600 mt-0.5">
                    {fmt(flowDayStats.daySummary.sprinklerGallons)}
                    <span className="text-xs font-normal text-gray-400 ml-1">gal</span>
                  </p>
                  {flowDayStats.daySummary.totalGallons > 0 && (
                    <p className="text-xs text-gray-400">
                      {Math.round(
                        (flowDayStats.daySummary.sprinklerGallons /
                          flowDayStats.daySummary.totalGallons) * 100
                      )}% of total
                    </p>
                  )}
                </div>
                <div className="bg-[#FBF0DC] rounded-lg px-4 py-3">
                  <p className="text-xs text-gray-500 font-medium">House</p>
                  <p className="text-xl font-bold text-[#B9822F] mt-0.5">
                    {fmt(flowDayStats.daySummary.houseGallons)}
                    <span className="text-xs font-normal text-gray-400 ml-1">gal</span>
                  </p>
                </div>
                <div className="bg-[#EEF8EE] rounded-lg px-4 py-3">
                  <p className="text-xs text-gray-500 font-medium">Est. Cost</p>
                  <p className="text-xl font-bold text-[#2E7D4F] mt-0.5">
                    ${flowDayStats.daySummary.estimatedCost.toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </p>
                </div>
              </div>

              {/* Station flow chart */}
              <StationFlowChart
                stats={flowDayStats.stats}
                config={flowDayStats.dayConfig}
                selectedDay={flowDayStats.day}
                sprinklerDates={derived?.sprinklerDates ?? []}
                onDayChange={setSelectedFlowDay}
                configVersionLabel={flowDayStats.configVersionLabel}
              />
            </>
          ) : (
            <div className="h-56 rounded bg-gray-100 animate-pulse" />
          )}
        </CardContent>
      </Card>
    </div>
  )
}
