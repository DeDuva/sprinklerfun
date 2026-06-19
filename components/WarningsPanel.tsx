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

function MaintenanceFlags({ maintenance }: { maintenance: MaintenanceEntry[] }) {
  if (maintenance.length === 0) return null
  return (
    <div className="space-y-2">
      {maintenance.map((m) => (
        <div
          key={m.stationId}
          className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 flex items-start gap-3"
        >
          <span className="text-amber-500 text-lg mt-0.5">⚠</span>
          <div>
            <p className="text-sm font-semibold text-amber-700">
              {m.name} — flagged for maintenance
            </p>
            <p className="text-xs text-amber-600 mt-0.5">
              {m.note ? `${m.note} · ` : ""}
              flagged {new Date(m.flaggedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
              {" · clear it in "}
              <a href="/analysis" className="underline">Analysis</a>.
            </p>
          </div>
        </div>
      ))}
    </div>
  )
}

export default function WarningsPanel({ warnings, hasBaselines, maintenance = [] }: Props) {
  if (!hasBaselines) {
    return (
      <div className="space-y-2">
        <MaintenanceFlags maintenance={maintenance} />
        <div className="rounded-lg border border-dashed border-gray-200 px-4 py-3 text-sm text-gray-400">
          No baseline GPM values set. Add them in{" "}
          <a href="/config" className="underline text-blue-500">Config → station editor</a> to enable deviation alerts.
        </div>
      </div>
    )
  }

  if (warnings.length === 0) {
    return (
      <div className="space-y-2">
        <MaintenanceFlags maintenance={maintenance} />
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 flex items-center gap-2">
          <span className="text-green-600 text-lg">✓</span>
          <span className="text-sm text-green-700 font-medium">All stations within normal range</span>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <MaintenanceFlags maintenance={maintenance} />
      {warnings.map((w) => (
        <div
          key={w.stationId}
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 flex items-start gap-3"
        >
          <span className="text-red-500 text-lg mt-0.5">⚠</span>
          <div>
            <p className="text-sm font-semibold text-red-700">
              {w.stationName} — {(w.pctAboveBaseline * 100).toFixed(0)}% above baseline
            </p>
            <p className="text-xs text-red-600 mt-0.5">
              Avg {w.recentAvgGpm.toFixed(3)} gpm vs baseline {w.baselineGpm.toFixed(3)} gpm
              {" · "}
              {w.consecutiveDaysAbove} consecutive sprinkler day{w.consecutiveDaysAbove > 1 ? "s" : ""} above threshold.
              Check this station.
            </p>
          </div>
        </div>
      ))}
    </div>
  )
}
