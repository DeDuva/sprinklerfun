"use client"

import { useMemo } from "react"
import type { MaintenanceFlag, SegmentReconciliation } from "@/lib/types"
import { type StageKind, wouldChange } from "@/lib/staging"
import { cn } from "@/lib/utils"

interface Props {
  recon: SegmentReconciliation[]
  maintenance: Record<string, MaintenanceFlag>
  selectedStation: string | null
  onSelectStation: (id: string | null) => void
  isStaged: (r: SegmentReconciliation, kind: StageKind) => boolean
  onToggleStage: (r: SegmentReconciliation, kind: StageKind) => void
  onToggleMaintenance: (r: SegmentReconciliation) => void
}

const fmtTime = (min: number | null) => {
  if (min == null) return "—"
  const h = Math.floor(min / 60) % 24
  const m = ((min % 60) + 60) % 60
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`
}

const signed = (n: number | null, unit = "m") =>
  n == null ? "" : `${n >= 0 ? "+" : ""}${n}${unit}`

function DriftBadge({ value, unit = "m" }: { value: number | null; unit?: string }) {
  if (value == null) return <span className="text-gray-300">—</span>
  const cls = value === 0 ? "text-gray-400" : Math.abs(value) >= 2 ? "text-red-500" : "text-amber-500"
  return <span className={cn("font-medium", cls)}>{signed(value, unit)}</span>
}

function StageButton({
  staged,
  disabled,
  label,
  onClick,
}: {
  staged: boolean
  disabled: boolean
  label: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={
        disabled
          ? "No change to propose (already matches, or no run detected)"
          : staged
          ? "Staged — click to remove from the proposal"
          : "Propose this config change (review before it's saved)"
      }
      aria-pressed={staged}
      className={cn(
        "text-xs px-2 py-0.5 rounded border transition-colors inline-flex items-center gap-1",
        disabled
          ? "border-gray-100 text-gray-300 cursor-not-allowed"
          : staged
          ? "border-sky-500 bg-sky-600 text-white hover:bg-sky-700"
          : "border-gray-300 text-gray-700 hover:border-sky-400 hover:text-sky-600"
      )}
    >
      <span className="text-[10px]">{staged ? "✓" : "+"}</span>
      {label}
    </button>
  )
}

interface ProgramGroup {
  key: string
  label: string
  cfgStart: string
  actualStart: string
  startDrift: number | null
  stations: SegmentReconciliation[]
}

export default function ReconciliationTable({
  recon,
  maintenance,
  selectedStation,
  onSelectStation,
  isStaged,
  onToggleStage,
  onToggleMaintenance,
}: Props) {
  const groups = useMemo(() => {
    const map = new Map<string, ProgramGroup>()
    for (const r of recon) {
      const gk = `${r.timer}:${r.programId}`
      if (!map.has(gk)) {
        const timerLabel = r.timer === "timer1" ? "T1" : "T2"
        map.set(gk, {
          key: gk,
          label: `${timerLabel} · Program ${r.programId}`,
          cfgStart: fmtTime(r.cfgStartMin),
          actualStart: fmtTime(r.actualStartMin),
          startDrift: r.startDriftMin,
          stations: [],
        })
      }
      map.get(gk)!.stations.push(r)
    }
    return [...map.values()]
  }, [recon])

  if (recon.length === 0) {
    return <div className="text-sm text-gray-400 py-6 text-center">No configured stations ran on this day.</div>
  }

  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <div key={g.key} className="rounded-lg border border-gray-200">
          {/* Program header */}
          <div className="flex items-center justify-between gap-3 px-4 py-2.5 bg-gray-50 rounded-t-lg border-b border-gray-200">
            <div className="text-sm font-medium text-gray-700">{g.label}</div>
            <div className="text-xs text-gray-500">
              Start {g.cfgStart}
              {g.startDrift != null && g.startDrift !== 0 && (
                <span className="ml-1">
                  (actual {g.actualStart} <DriftBadge value={g.startDrift} />)
                </span>
              )}
            </div>
          </div>

          {/* Station rows */}
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-400 border-b border-gray-100">
                <th className="text-left font-normal px-4 py-1.5">Station</th>
                <th className="text-left font-normal px-3 py-1.5">Duration (cfg → act)</th>
                <th className="text-left font-normal px-3 py-1.5">gpm (base → act)</th>
                <th className="text-left font-normal px-3 py-1.5">
                  Propose change
                  <span className="ml-1 text-gray-300">· staged, not saved</span>
                </th>
                <th className="text-right font-normal px-4 py-1.5">Maint.</th>
              </tr>
            </thead>
            <tbody>
              {g.stations.map((r) => {
                const flagged = !!maintenance[r.stationId]
                const isSel = selectedStation === r.stationId
                const deltaPct = r.gpmDeltaPct
                const deltaCls =
                  deltaPct == null
                    ? "text-gray-300"
                    : deltaPct > 0.2
                    ? "text-red-500"
                    : deltaPct < -0.05
                    ? "text-sky-500"
                    : "text-green-600"

                const baselineTarget = r.actualGpm != null ? +r.actualGpm.toFixed(2) : null

                return (
                  <tr
                    key={r.stationId}
                    className={cn(
                      "border-b border-gray-50 last:border-0 cursor-pointer hover:bg-gray-50/50 transition-colors",
                      isSel && "bg-sky-50/60"
                    )}
                    onClick={() => onSelectStation(isSel ? null : r.stationId)}
                  >
                    <td className="px-4 py-2 font-medium whitespace-nowrap">
                      <span className="inline-flex items-center gap-1.5">
                        {r.name}
                        {r.confidence === "low" && (
                          <span title={r.confidenceReason} className="text-amber-400 text-xs">≈</span>
                        )}
                        {flagged && (
                          <span title={maintenance[r.stationId].note || "Flagged for maintenance"} className="text-red-500">⚠</span>
                        )}
                      </span>
                    </td>

                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className="text-gray-500">{r.cfgDurationMin}m</span>
                      <span className="text-gray-300 mx-1">→</span>
                      <span className="text-gray-800">{r.actualDurationMin != null ? `${r.actualDurationMin}m` : "—"}</span>{" "}
                      <DriftBadge value={r.durationDriftMin} />
                    </td>

                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className="text-orange-500">{r.baselineGpm != null ? r.baselineGpm.toFixed(2) : "—"}</span>
                      <span className="text-gray-300 mx-1">→</span>
                      <span className="text-gray-800">{r.actualGpm != null ? r.actualGpm.toFixed(2) : "—"}</span>{" "}
                      {deltaPct != null && (
                        <span className={cn("font-medium", deltaCls)}>
                          {deltaPct >= 0 ? "+" : ""}{(deltaPct * 100).toFixed(0)}%
                        </span>
                      )}
                    </td>

                    <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                      <div className="inline-flex flex-wrap gap-1">
                        <StageButton
                          staged={isStaged(r, "baseline")}
                          disabled={!wouldChange(r, "baseline")}
                          label={`baseline → ${baselineTarget != null ? baselineTarget.toFixed(2) : "—"}`}
                          onClick={() => onToggleStage(r, "baseline")}
                        />
                        <StageButton
                          staged={isStaged(r, "duration")}
                          disabled={!wouldChange(r, "duration")}
                          label={`duration → ${r.actualDurationMin != null ? `${r.actualDurationMin}m` : "—"}`}
                          onClick={() => onToggleStage(r, "duration")}
                        />
                      </div>
                    </td>

                    <td className="px-4 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => onToggleMaintenance(r)}
                        title={flagged ? "Clear maintenance flag" : "Flag this station for maintenance"}
                        className={cn(
                          "text-xs px-1.5 py-0.5 rounded border transition-colors whitespace-nowrap",
                          flagged
                            ? "border-red-200 bg-red-50 text-red-600 hover:bg-red-100"
                            : "border-gray-200 text-gray-500 hover:border-gray-400"
                        )}
                      >
                        {flagged ? "⚠ flagged" : "⚠ flag"}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}
