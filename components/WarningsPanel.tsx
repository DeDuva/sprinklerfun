"use client"

import type { StationWarning } from "@/lib/types"
import Flo from "@/components/design/Flo"

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
        <div className="rounded-xl border-2 border-[#FFC24B]/50 bg-[#FFF6E2] px-4 py-2.5">
          <div className="flex items-center gap-2 text-sm font-medium text-[#8A5A12]">
            <span className="text-[#D99A1F]">⚠</span>
            {maintenance.length} station{maintenance.length !== 1 ? "s" : ""} flagged for maintenance
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1.5 ml-6">
            {maintenance.map((m) => (
              <span key={m.stationId} className="text-xs text-[#A5731F]">
                <span className="font-medium">{m.name}</span>
                {m.note && <span className="text-[#D99A1F]"> — {m.note}</span>}
              </span>
            ))}
          </div>
          <p className="text-[11px] text-[#D99A1F] mt-1.5 ml-6">
            Clear flags in <a href="/analysis" className="underline">Analysis</a>
          </p>
        </div>
      )}

      {warnings.map((w) => (
        <div
          key={w.stationId}
          className="rounded-xl border-2 border-[#FF6B5C]/40 bg-[#FFEFEC] px-4 py-2.5 flex items-start gap-2"
        >
          <span className="text-[#FF6B5C] mt-0.5">⚠</span>
          <div>
            <p className="text-sm font-medium text-[#B33B2E]">
              {w.stationName} — {(w.pctAboveBaseline * 100).toFixed(0)}% above baseline
            </p>
            <p className="text-xs text-[#C9584A]">
              Avg {w.recentAvgGpm.toFixed(3)} vs baseline {w.baselineGpm.toFixed(3)} gpm
              {" · "}{w.consecutiveDaysAbove} day{w.consecutiveDaysAbove > 1 ? "s" : ""} running
            </p>
          </div>
        </div>
      ))}

      {!hasBaselines && !hasIssues && (
        <div className="rounded-xl border-2 border-dashed border-[#EADFC6] bg-white px-4 py-2.5 text-sm text-[#4A6076]">
          No baseline GPM values set. Add them in{" "}
          <a href="/config" className="underline text-[#1B6FA8]">Config</a> to enable deviation alerts.
        </div>
      )}

      {hasBaselines && !hasIssues && (
        <div className="rounded-xl border-2 border-[#4FB05A]/40 bg-[#EEF8EE] px-4 py-2.5 flex items-center gap-2.5">
          <Flo size={28} mood="happy" />
          <span className="text-sm text-[#2E7D4F] font-medium">All stations within normal range — nice and flat 🌿</span>
        </div>
      )}
    </div>
  )
}
