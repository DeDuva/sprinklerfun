"use client"

import { useDeferredValue, useMemo, useState } from "react"
import { useStore } from "@/lib/store"
import {
  enrichRowsMultiConfig,
  buildDailyRows,
  buildStationStats,
  computeSummary,
  computeStationWarnings,
} from "@/lib/analyze"
import SummaryCards from "@/components/SummaryCards"
import ConsumptionChart from "@/components/ConsumptionChart"
import StationFlowChart from "@/components/StationFlowChart"
import WarningsPanel from "@/components/WarningsPanel"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

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
  const rows          = useStore((s) => s.rows)
  const config        = useStore((s) => s.config)
  const configHistory = useStore((s) => s.configHistory)

  const deferredRows    = useDeferredValue(rows)
  const deferredConfig  = useDeferredValue(config)
  const deferredHistory = useDeferredValue(configHistory)

  const isStale = deferredRows !== rows

  const [selectedFlowDay, setSelectedFlowDay] = useState<string | null>(null)

  // Month selector — default to current month
  const today = new Date()
  const currentMonth = ymKey(today)
  const [selectedMonth, setSelectedMonth] = useState(currentMonth)

  // ---- Expensive enrichment (deferred) -----------------------------------
  const derived = useMemo(() => {
    if (deferredRows.length === 0) return null

    const enriched = enrichRowsMultiConfig(deferredRows, deferredHistory)
    const allDaily  = buildDailyRows(enriched)

    const warnings = computeStationWarnings(enriched, deferredConfig, 21)

    const hasBaselines = [
      ...deferredConfig.timer1.stations,
      ...deferredConfig.timer2.stations,
    ].some((s) => s.baselineGpm && s.baselineGpm > 0)

    const first = allDaily[0]?.date
    const last  = allDaily[allDaily.length - 1]?.date
    const dateRange = first && last ? { first, last } : null

    const sprinklerDates = allDaily.filter((d) => d.isSprinklerDay).map((d) => d.date)
    const defaultFlowDay = sprinklerDates.length > 0
      ? sprinklerDates[sprinklerDates.length - 1]
      : (last ?? null)

    return { enriched, allDaily, warnings, hasBaselines, dateRange, sprinklerDates, defaultFlowDay }
  }, [deferredRows, deferredConfig, deferredHistory])

  // ---- Monthly summary (cheap filter — reruns only when month changes) ---
  const monthlySummary = useMemo(() => {
    if (!derived) return null

    const [y, m] = selectedMonth.split("-").map(Number)
    const monthStart   = `${selectedMonth}-01`
    const monthLastDay = new Date(y, m, 0).toISOString().slice(0, 10)
    const todayStr     = today.toISOString().slice(0, 10)
    const effectiveEnd = selectedMonth === currentMonth ? todayStr : monthLastDay

    const monthly  = derived.allDaily.filter((d) => d.date >= monthStart && d.date <= effectiveEnd)
    const summary  = computeSummary(monthly, deferredConfig)

    const fmtOpts = (year?: "numeric"): Intl.DateTimeFormatOptions =>
      ({ month: "short", day: "numeric", ...(year ? { year } : {}) })
    const startFmt = new Date(monthStart  + "T12:00:00").toLocaleDateString(undefined, fmtOpts())
    const endFmt   = new Date(effectiveEnd + "T12:00:00").toLocaleDateString(undefined, fmtOpts("numeric"))
    const monthFmt = new Date(monthStart  + "T12:00:00").toLocaleDateString(undefined, { month: "long", year: "numeric" })

    return { summary, rangeLabel: `${startFmt} – ${endFmt}`, monthFmt }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [derived, selectedMonth, deferredConfig])

  // ---- Per-station stats + day summary for selected flow day -------------
  const flowDayStats = useMemo(() => {
    if (!derived) return null
    const day = selectedFlowDay ?? derived.defaultFlowDay
    if (!day) return null
    const dayRows  = derived.enriched.filter((r) => r.date === day)
    const dayDaily = derived.allDaily.filter((d) => d.date === day)
    const daySummary = computeSummary(dayDaily, deferredConfig)

    // Find the config version that was active on this day (same logic as enrichRowsMultiConfig)
    const sorted = [...deferredHistory].sort((a, b) => a.savedAt.localeCompare(b.savedAt))
    let activeVersion = sorted.findLast((v) => v.savedAt.slice(0, 10) <= day) ?? sorted[0] ?? null
    const configVersionLabel = activeVersion
      ? new Date(activeVersion.savedAt).toLocaleDateString(undefined, {
          month: "short", day: "numeric", year: "numeric",
        })
      : null

    return { stats: buildStationStats(dayRows, deferredConfig), day, daySummary, configVersionLabel }
  }, [derived, selectedFlowDay, deferredConfig, deferredHistory])

  // Month nav bounds
  const firstMonth = derived?.dateRange?.first.slice(0, 7) ?? currentMonth
  const prevMonth  = addMonth(selectedMonth, -1)
  const nextMonth  = addMonth(selectedMonth,  1)
  const canGoPrev  = derived ? prevMonth >= firstMonth : false
  const canGoNext  = derived ? nextMonth <= currentMonth : false

  const fmtDate = (d: string) =>
    new Date(d + "T12:00:00").toLocaleDateString(undefined, {
      month: "short", day: "numeric", year: "numeric",
    })

  if (rows.length === 0) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <div className="rounded-lg border-2 border-dashed border-gray-200 p-16 text-center">
          <p className="text-gray-500 text-lg font-medium">No data yet</p>
          <p className="text-gray-400 text-sm mt-1">
            Click <strong>Upload CSV</strong> in the top nav to load your Flume export.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className={`space-y-6 transition-opacity duration-200 ${isStale ? "opacity-60" : ""}`}>
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          {derived?.dateRange ? (
            <p className="text-sm text-gray-500 mt-0.5">
              Data: {fmtDate(derived.dateRange.first)} – {fmtDate(derived.dateRange.last)}
            </p>
          ) : (
            <p className="text-sm text-gray-500 mt-0.5 animate-pulse">Computing…</p>
          )}
        </div>
      </div>

      {/* Warnings */}
      <div>
        <h2 className="text-sm font-semibold text-gray-600 uppercase tracking-wide mb-2">
          Station Alerts
        </h2>
        {derived ? (
          <WarningsPanel warnings={derived.warnings} hasBaselines={derived.hasBaselines} />
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
              configHistory={deferredHistory}
              onDaySelect={setSelectedFlowDay}
              selectedDay={selectedFlowDay ?? derived.defaultFlowDay}
            />
          ) : (
            <div className="h-80 rounded bg-gray-100 animate-pulse" />
          )}
        </CardContent>
      </Card>

      {/* Per-station flow — selected day */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Per-Station Flow Rate
            <span className="ml-2 text-xs font-normal text-gray-400">
              orange dashes = your baseline
            </span>
          </CardTitle>
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
                <div className="bg-blue-50 rounded-lg px-4 py-3">
                  <p className="text-xs text-gray-500 font-medium">Sprinkler</p>
                  <p className="text-xl font-bold text-blue-600 mt-0.5">
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
                <div className="bg-orange-50 rounded-lg px-4 py-3">
                  <p className="text-xs text-gray-500 font-medium">House</p>
                  <p className="text-xl font-bold text-orange-500 mt-0.5">
                    {fmt(flowDayStats.daySummary.houseGallons)}
                    <span className="text-xs font-normal text-gray-400 ml-1">gal</span>
                  </p>
                </div>
                <div className="bg-green-50 rounded-lg px-4 py-3">
                  <p className="text-xs text-gray-500 font-medium">Est. Cost</p>
                  <p className="text-xl font-bold text-green-600 mt-0.5">
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
                config={deferredConfig}
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
