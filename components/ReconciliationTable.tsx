"use client"

import type { MaintenanceFlag, SegmentReconciliation } from "@/lib/types"
import { type StageKind, wouldChange, programStartStations } from "@/lib/staging"
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

// A button that stages (proposes) a single config change. Toggles on re-click.
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
          ? "border-blue-500 bg-blue-600 text-white hover:bg-blue-700"
          : "border-gray-300 text-gray-700 hover:border-blue-400 hover:text-blue-600"
      )}
    >
      <span className="text-[10px]">{staged ? "✓" : "+"}</span>
      {label}
    </button>
  )
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
  if (recon.length === 0) {
    return <div className="text-sm text-gray-400 py-6 text-center">No configured stations ran on this day.</div>
  }

  // The program start is a single shared knob, so the "start" proposal is offered
  // only on each program's first station (downstream timing is fixed via duration).
  const firstOfProgram = programStartStations(recon)

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Station</TableHead>
            <TableHead>Start (cfg → act)</TableHead>
            <TableHead>Duration (cfg → act)</TableHead>
            <TableHead>gpm (base → act)</TableHead>
            <TableHead>
              Propose config change
              <span className="block text-[10px] font-normal text-gray-400 normal-case">
                staged, not saved — review below
              </span>
            </TableHead>
            <TableHead className="text-right">Maint.</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {recon.map((r) => {
            const flagged = !!maintenance[r.stationId]
            const isSel = selectedStation === r.stationId
            const deltaPct = r.gpmDeltaPct
            const deltaCls =
              deltaPct == null
                ? "text-gray-300"
                : deltaPct > 0.2
                ? "text-red-500"
                : deltaPct < -0.05
                ? "text-blue-500"
                : "text-green-600"

            // "Would change" guards — disable staging buttons that are no-ops.
            const baselineTarget = r.actualGpm != null ? +r.actualGpm.toFixed(2) : null
            const baselineWouldChange = wouldChange(r, "baseline")
            const startWouldChange = wouldChange(r, "start")
            const durationWouldChange = wouldChange(r, "duration")

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

                <TableCell onClick={(e) => e.stopPropagation()}>
                  <div className="inline-flex flex-wrap gap-1">
                    <StageButton
                      staged={isStaged(r, "baseline")}
                      disabled={!baselineWouldChange}
                      label={`baseline → ${baselineTarget != null ? baselineTarget.toFixed(2) : "—"}`}
                      onClick={() => onToggleStage(r, "baseline")}
                    />
                    {firstOfProgram.has(`${r.timer}:${r.programId}:${r.stationId}`) && (
                      <StageButton
                        staged={isStaged(r, "start")}
                        disabled={!startWouldChange}
                        label={`start → ${fmtTime(r.actualStartMin)}`}
                        onClick={() => onToggleStage(r, "start")}
                      />
                    )}
                    <StageButton
                      staged={isStaged(r, "duration")}
                      disabled={!durationWouldChange}
                      label={`duration → ${r.actualDurationMin != null ? `${r.actualDurationMin}m` : "—"}`}
                      onClick={() => onToggleStage(r, "duration")}
                    />
                  </div>
                </TableCell>

                <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
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
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}
