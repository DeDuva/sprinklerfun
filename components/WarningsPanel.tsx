"use client"

import type { StationWarning } from "@/lib/analyze"

export interface MaintenanceEntry {
  stationId: string
  name: string
  note?: string
  flaggedAt: string
}

interface Props {
  warnings: StationWarning[]
  hasBaselines: boolean
  maintenance?: MaintenanceEntry[]
}

export default function WarningsPanel({ warnings, hasBaselines, maintenance = [] }: Props) {
  const hasIssues = warnings.length > 0 || maintenance.length > 0

  return (
    <div className="space-y-2">
      {maintenance.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5">
          <div className="flex items-center gap-2 text-sm font-medium text-amber-700">
            <span className="text-amber-500">⚠</span>
            {maintenance.length} station{maintenance.length !== 1 ? "s" : ""} flagged for maintenance
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1.5 ml-6">
            {maintenance.map((m) => (
              <span key={m.stationId} className="text-xs text-amber-600">
                <span className="font-medium">{m.name}</span>
                {m.note && <span className="text-amber-500"> — {m.note}</span>}
              </span>
            ))}
          </div>
          <p className="text-[11px] text-amber-500 mt-1.5 ml-6">
            Clear flags in <a href="/analysis" className="underline">Analysis</a>
          </p>
        </div>
      )}

      {warnings.map((w) => (
        <div
          key={w.stationId}
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 flex items-start gap-2"
        >
          <span className="text-red-500 mt-0.5">⚠</span>
          <div>
            <p className="text-sm font-medium text-red-700">
              {w.stationName} — {(w.pctAboveBaseline * 100).toFixed(0)}% above baseline
            </p>
            <p className="text-xs text-red-500">
              Avg {w.recentAvgGpm.toFixed(3)} vs baseline {w.baselineGpm.toFixed(3)} gpm
              {" · "}{w.consecutiveDaysAbove} day{w.consecutiveDaysAbove > 1 ? "s" : ""} running
            </p>
          </div>
        </div>
      ))}

      {!hasBaselines && !hasIssues && (
        <div className="rounded-lg border border-dashed border-gray-200 px-4 py-2.5 text-sm text-gray-400">
          No baseline GPM values set. Add them in{" "}
          <a href="/config" className="underline text-blue-500">Config</a> to enable deviation alerts.
        </div>
      )}

      {hasBaselines && !hasIssues && (
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 flex items-center gap-2">
          <span className="text-green-600">✓</span>
          <span className="text-sm text-green-700 font-medium">All stations within normal range</span>
        </div>
      )}
    </div>
  )
}
