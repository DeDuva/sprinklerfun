"use client"

import type { MaintenanceFlag, SegmentReconciliation } from "@/lib/types"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"

interface Props {
  recon: SegmentReconciliation[]
  maintenance: Record<string, MaintenanceFlag>
  selectedStation: string | null
  onSelectStation: (id: string | null) => void
  onApplyBaseline: (r: SegmentReconciliation) => void
  onApplyStart: (r: SegmentReconciliation) => void
  onApplyDuration: (r: SegmentReconciliation) => void
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

export default function ReconciliationTable({
  recon,
  maintenance,
  selectedStation,
  onSelectStation,
  onApplyBaseline,
  onApplyStart,
  onApplyDuration,
  onToggleMaintenance,
}: Props) {
  if (recon.length === 0) {
    return <div className="text-sm text-gray-400 py-6 text-center">No configured stations ran on this day.</div>
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Station</TableHead>
            <TableHead>Start (cfg → act)</TableHead>
            <TableHead>Duration (cfg → act)</TableHead>
            <TableHead>gpm (base → act)</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {recon.map((r) => {
            const flagged = !!maintenance[r.stationId]
            const isSel = selectedStation === r.stationId
            const hasActual = r.actualGpm != null || r.actualStartMin != null
            const deltaPct = r.gpmDeltaPct
            const deltaCls =
              deltaPct == null
                ? "text-gray-300"
                : deltaPct > 0.2
                ? "text-red-500"
                : deltaPct < -0.05
                ? "text-blue-500"
                : "text-green-600"
            return (
              <TableRow
                key={`${r.timer}:${r.programId}:${r.stationId}`}
                className={cn("cursor-pointer", isSel && "bg-blue-50/60")}
                onClick={() => onSelectStation(isSel ? null : r.stationId)}
              >
                <TableCell className="font-medium whitespace-nowrap">
                  <span className="inline-flex items-center gap-1.5">
                    {r.name}
                    {r.confidence === "low" && (
                      <span title={r.confidenceReason} className="text-amber-400 text-xs">≈</span>
                    )}
                    {flagged && (
                      <span title={maintenance[r.stationId].note || "Flagged for maintenance"} className="text-red-500">⚠</span>
                    )}
                  </span>
                  <span className="block text-[10px] text-gray-400">
                    {r.timer === "timer1" ? "T1" : "T2"} · {r.programId}
                  </span>
                </TableCell>

                <TableCell className="whitespace-nowrap">
                  <span className="text-gray-500">{fmtTime(r.cfgStartMin)}</span>
                  <span className="text-gray-300 mx-1">→</span>
                  <span className="text-gray-800">{fmtTime(r.actualStartMin)}</span>{" "}
                  <DriftBadge value={r.startDriftMin} />
                </TableCell>

                <TableCell className="whitespace-nowrap">
                  <span className="text-gray-500">{r.cfgDurationMin}m</span>
                  <span className="text-gray-300 mx-1">→</span>
                  <span className="text-gray-800">{r.actualDurationMin != null ? `${r.actualDurationMin}m` : "—"}</span>{" "}
                  <DriftBadge value={r.durationDriftMin} />
                </TableCell>

                <TableCell className="whitespace-nowrap">
                  <span className="text-orange-500">{r.baselineGpm != null ? r.baselineGpm.toFixed(2) : "—"}</span>
                  <span className="text-gray-300 mx-1">→</span>
                  <span className="text-gray-800">{r.actualGpm != null ? r.actualGpm.toFixed(2) : "—"}</span>{" "}
                  {deltaPct != null && (
                    <span className={cn("font-medium", deltaCls)}>
                      {deltaPct >= 0 ? "+" : ""}{(deltaPct * 100).toFixed(0)}%
                    </span>
                  )}
                </TableCell>

                <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                  <div className="inline-flex flex-wrap gap-1 justify-end">
                    <ActionBtn
                      disabled={r.actualGpm == null}
                      title="Set this station's baseline gpm to the measured actual (active day's config window)"
                      onClick={() => onApplyBaseline(r)}
                    >
                      ↳ baseline
                    </ActionBtn>
                    <ActionBtn
                      disabled={r.actualStartMin == null}
                      title="Set this program's start time so this station lines up with its actual start"
                      onClick={() => onApplyStart(r)}
                    >
                      ↳ start
                    </ActionBtn>
                    <ActionBtn
                      disabled={r.actualDurationMin == null}
                      title="Set this station's duration to the measured actual run length"
                      onClick={() => onApplyDuration(r)}
                    >
                      ↳ duration
                    </ActionBtn>
                    <button
                      onClick={() => onToggleMaintenance(r)}
                      title={flagged ? "Clear maintenance flag" : "Flag this station for maintenance"}
                      className={cn(
                        "text-xs px-1.5 py-0.5 rounded border transition-colors",
                        flagged
                          ? "border-red-200 bg-red-50 text-red-600 hover:bg-red-100"
                          : "border-gray-200 text-gray-500 hover:border-gray-400"
                      )}
                    >
                      {flagged ? "⚠ flagged" : "⚠ flag"}
                    </button>
                  </div>
                  {!hasActual && (
                    <p className="text-[10px] text-gray-400 mt-0.5">no run detected</p>
                  )}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

function ActionBtn({
  children,
  onClick,
  disabled,
  title,
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
  title?: string
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="text-xs px-1.5 py-0.5 rounded border border-gray-200 text-gray-600 hover:border-blue-400 hover:text-blue-600 transition-colors disabled:opacity-30 disabled:hover:border-gray-200 disabled:hover:text-gray-600"
    >
      {children}
    </button>
  )
}
