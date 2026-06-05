"use client"

import { useDeferredValue, useMemo } from "react"
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

export default function DashboardPage() {
  const rows          = useStore((s) => s.rows)
  const config        = useStore((s) => s.config)
  const configHistory = useStore((s) => s.configHistory)

  const deferredRows    = useDeferredValue(rows)
  const deferredConfig  = useDeferredValue(config)
  const deferredHistory = useDeferredValue(configHistory)

  const isStale = deferredRows !== rows

  const derived = useMemo(() => {
    if (deferredRows.length === 0) return null

    // Use multi-config enrichment — each date gets the right config version
    const enriched = enrichRowsMultiConfig(deferredRows, deferredHistory)
    const allDaily  = buildDailyRows(enriched)
    const summary   = computeSummary(allDaily, deferredConfig)

    // Station stats and warnings always use all data
    const stationStats = buildStationStats(enriched, deferredConfig)
    const warnings     = computeStationWarnings(enriched, deferredConfig, 21)

    const hasBaselines = [
      ...deferredConfig.timer1.stations,
      ...deferredConfig.timer2.stations,
    ].some((s) => s.baselineGpm && s.baselineGpm > 0)

    const first = allDaily[0]?.date
    const last  = allDaily[allDaily.length - 1]?.date
    const dateRange = first && last ? { first, last } : null

    return { enriched, summary, stationStats, warnings, hasBaselines, dateRange }
  }, [deferredRows, deferredConfig, deferredHistory])

  const fmt = (d: string) =>
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
              Data: {fmt(derived.dateRange.first)} – {fmt(derived.dateRange.last)}
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

      {/* Summary cards — scoped to all data (window filtering is in the chart) */}
      {derived?.summary && <SummaryCards {...derived.summary} />}

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
            />
          ) : (
            <div className="h-80 rounded bg-gray-100 animate-pulse" />
          )}
        </CardContent>
      </Card>

      {/* Per-station flow with baselines */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Per-Station Flow Rate
            <span className="ml-2 text-xs font-normal text-gray-400">
              All data · orange dashes = your baseline
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {derived ? (
            <StationFlowChart stats={derived.stationStats} config={deferredConfig} />
          ) : (
            <div className="h-56 rounded bg-gray-100 animate-pulse" />
          )}
        </CardContent>
      </Card>
    </div>
  )
}
