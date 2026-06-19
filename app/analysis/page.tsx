"use client"

import { useDeferredValue, useMemo, useState } from "react"
import { toast } from "sonner"
import { useStore } from "@/lib/store"
import {
  deriveData,
  buildStationStats,
  buildDaySchedule,
  buildDayMinuteSeries,
  reconcileDay,
  activeWindowForDate,
  currentConfig,
} from "@/lib/analyze"
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ErrorBar,
} from "recharts"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import FlowTimelineChart from "@/components/FlowTimelineChart"
import ReconciliationTable from "@/components/ReconciliationTable"
import type { AppConfig, SegmentReconciliation, StationStats } from "@/lib/types"

type SortKey = keyof StationStats

const deepClone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))

const minToTime = (min: number) => {
  const clamped = Math.max(0, Math.min(1439, Math.round(min)))
  const h = Math.floor(clamped / 60)
  const m = clamped % 60
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`
}
const parseTime = (t: string) => {
  const [h, m] = t.split(":").map(Number)
  return h * 60 + m
}
const fmtDay = (d: string) =>
  new Date(d + "T12:00:00").toLocaleDateString(undefined, {
    weekday: "short", month: "short", day: "numeric", year: "numeric",
  })

function SortHeader({
  k, label, sortKey, sortDir, onSort,
}: {
  k: SortKey
  label: string
  sortKey: SortKey
  sortDir: "asc" | "desc"
  onSort: (k: SortKey) => void
}) {
  return (
    <TableHead className="cursor-pointer select-none hover:text-blue-600" onClick={() => onSort(k)}>
      {label} {sortKey === k ? (sortDir === "desc" ? "↓" : "↑") : ""}
    </TableHead>
  )
}

export default function AnalysisPage() {
  const rows         = useStore((s) => s.rows)
  const windows      = useStore((s) => s.windows)
  const rowsVersion  = useStore((s) => s.rowsVersion)
  const maintenance  = useStore((s) => s.maintenance)
  const updateWindow = useStore((s) => s.updateWindow)
  const setStationMaintenance = useStore((s) => s.setStationMaintenance)

  const deferredRows    = useDeferredValue(rows)
  const deferredWindows = useDeferredValue(windows)
  const deferredVersion = useDeferredValue(rowsVersion)

  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  const [selectedStation, setSelectedStation] = useState<string | null>(null)

  // ---- Expensive enrichment (deferred, memoized) -------------------------
  const derived = useMemo(() => {
    if (deferredRows.length === 0) return null
    const { enriched } = deriveData(deferredRows, deferredWindows, deferredVersion)
    const allDates = [...new Set(enriched.map((r) => r.date))].sort()
    const sprinklerDates = [...new Set(enriched.filter((r) => r.isSprinklerDay).map((r) => r.date))].sort()
    return { enriched, allDates, sprinklerDates }
  }, [deferredRows, deferredWindows, deferredVersion])

  const day = selectedDay ?? derived?.sprinklerDates[derived.sprinklerDates.length - 1] ?? null

  // ---- Per-day calibration (cheap — reruns on day change) ----------------
  const dayCalc = useMemo(() => {
    if (!derived || !day) return null
    const activeWin = activeWindowForDate(deferredWindows, day)
    const dayConfig = activeWin?.config ?? currentConfig(deferredWindows)
    const dow = (new Date(day + "T12:00:00").getDay() + 6) % 7
    const schedule = buildDaySchedule(dayConfig, dow)
    const series = buildDayMinuteSeries(derived.enriched.filter((r) => r.date === day))
    const recon = reconcileDay(series, schedule)
    return { activeWin, dayConfig, schedule, series, recon }
  }, [derived, day, deferredWindows])

  // ---- Fleet overview (all data) -----------------------------------------
  const [sortKey, setSortKey] = useState<SortKey>("totalGallons")
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc")
  const fleetStats = useMemo(() => {
    if (!derived) return []
    return buildStationStats(derived.enriched, currentConfig(deferredWindows))
  }, [derived, deferredWindows])

  const sorted = useMemo(
    () =>
      [...fleetStats].sort((a, b) => {
        const av = a[sortKey] as number
        const bv = b[sortKey] as number
        return sortDir === "desc" ? bv - av : av - bv
      }),
    [fleetStats, sortKey, sortDir]
  )
  const handleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === "desc" ? "asc" : "desc"))
    else { setSortKey(key); setSortDir("desc") }
  }
  const chartData = [...fleetStats]
    .sort((a, b) => b.avgGpm - a.avgGpm)
    .map((s) => ({ name: s.name, gpm: +s.avgGpm.toFixed(3), err: +s.stdGpm.toFixed(3) }))

  // ---- Config-edit handlers (patch the active day's window) --------------
  const winId = dayCalc?.activeWin?.id ?? null
  const patchConfig = (mutate: (cfg: AppConfig) => void) => {
    if (!dayCalc?.activeWin) {
      toast.error("No config window active for this day — create one in Config first.")
      return
    }
    const next = deepClone(dayCalc.activeWin.config)
    mutate(next)
    updateWindow(dayCalc.activeWin.id, { config: next })
  }
  const findStation = (cfg: AppConfig, timer: "timer1" | "timer2", id: string) =>
    cfg[timer].stations.find((s) => s.id === id)

  const applyBaseline = (r: SegmentReconciliation) => {
    if (r.actualGpm == null) return
    const val = +r.actualGpm.toFixed(2)
    patchConfig((cfg) => {
      const st = findStation(cfg, r.timer, r.stationId)
      if (st) st.baselineGpm = val
    })
    toast.success(`${r.name} baseline → ${val} gpm`)
  }
  const applyStart = (r: SegmentReconciliation) => {
    if (r.startDriftMin == null) return
    patchConfig((cfg) => {
      const prog = cfg[r.timer].programs[r.programId]
      prog.start = minToTime(parseTime(prog.start) + r.startDriftMin!)
    })
    toast.success(`${r.timer === "timer1" ? "T1" : "T2"} · Program ${r.programId} start shifted ${r.startDriftMin >= 0 ? "+" : ""}${r.startDriftMin}m`)
  }
  const applyDuration = (r: SegmentReconciliation) => {
    if (r.actualDurationMin == null) return
    patchConfig((cfg) => {
      const prog = cfg[r.timer].programs[r.programId]
      const ps = prog.stations[r.stationId]
      if (ps) ps.durationMin = r.actualDurationMin!
    })
    toast.success(`${r.name} duration → ${r.actualDurationMin}m`)
  }
  const toggleMaintenance = (r: SegmentReconciliation) => {
    if (maintenance[r.stationId]) {
      setStationMaintenance(r.stationId, null)
      toast.success(`${r.name} maintenance flag cleared`)
    } else {
      const note = window.prompt(`Flag ${r.name} for maintenance — optional note:`, "") ?? undefined
      setStationMaintenance(r.stationId, { flaggedAt: new Date().toISOString(), note: note || undefined })
      toast.success(`${r.name} flagged for maintenance`)
    }
  }

  const calibrateAll = () => {
    if (!dayCalc?.activeWin) {
      toast.error("No config window active for this day — create one in Config first.")
      return
    }
    const usable = dayCalc.recon.filter((r) => r.actualStartMin != null)
    if (usable.length === 0) {
      toast.error("No detected runs to calibrate from.")
      return
    }
    if (!window.confirm(
      `Calibrate ${usable.length} station(s) from ${fmtDay(day!)}? This sets program start times, durations, and baselines to the measured actuals in the config window active on this day.`
    )) return

    // First station (lowest cfg start) per program drives that program's start shift.
    const firstByProgram = new Map<string, SegmentReconciliation>()
    for (const r of usable) {
      const key = `${r.timer}:${r.programId}`
      const cur = firstByProgram.get(key)
      if (!cur || r.cfgStartMin < cur.cfgStartMin) firstByProgram.set(key, r)
    }
    patchConfig((cfg) => {
      for (const [key, r] of firstByProgram) {
        if (r.startDriftMin == null) continue
        const [timer, pid] = key.split(":") as ["timer1" | "timer2", "A" | "B" | "C"]
        const prog = cfg[timer].programs[pid]
        prog.start = minToTime(parseTime(prog.start) + r.startDriftMin)
      }
      for (const r of usable) {
        const prog = cfg[r.timer].programs[r.programId]
        const ps = prog.stations[r.stationId]
        if (ps && r.actualDurationMin != null) ps.durationMin = r.actualDurationMin
        const st = findStation(cfg, r.timer, r.stationId)
        if (st && r.actualGpm != null) st.baselineGpm = +r.actualGpm.toFixed(2)
      }
    })
    toast.success(`Calibrated ${usable.length} station(s) from ${fmtDay(day!)}`)
  }

  // ---- Day navigation -----------------------------------------------------
  const sprinklerDates = derived?.sprinklerDates ?? []
  const prevDay = day ? [...sprinklerDates].filter((d) => d < day).pop() ?? null : null
  const nextDay = day ? sprinklerDates.find((d) => d > day) ?? null : null

  if (rows.length === 0) {
    return <div className="text-center py-24 text-gray-400">No data — upload a CSV to get started</div>
  }

  const configLabel = dayCalc?.activeWin
    ? new Date(dayCalc.activeWin.effectiveFrom + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
    : null

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Timing & Flow Calibration</h1>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <CardTitle className="text-base">Actual vs. Configured — per minute</CardTitle>
            <div className="flex items-center gap-2">
              <button
                onClick={() => prevDay && setSelectedDay(prevDay)}
                disabled={!prevDay}
                className="px-2 py-0.5 rounded border text-sm text-gray-600 disabled:opacity-30 hover:border-gray-400 transition-colors"
                title="Previous sprinkler day"
              >←</button>
              <span className="text-sm font-medium text-gray-700 min-w-[160px] text-center">
                {day ? fmtDay(day) : "—"}
              </span>
              <button
                onClick={() => nextDay && setSelectedDay(nextDay)}
                disabled={!nextDay}
                className="px-2 py-0.5 rounded border text-sm text-gray-600 disabled:opacity-30 hover:border-gray-400 transition-colors"
                title="Next sprinkler day"
              >→</button>
            </div>
          </div>
          {configLabel && (
            <p className="text-xs text-gray-400 mt-1">⚙ Config active on this day: effective {configLabel}</p>
          )}
        </CardHeader>
        <CardContent>
          {dayCalc ? (
            <FlowTimelineChart
              series={dayCalc.series}
              schedule={dayCalc.schedule}
              recon={dayCalc.recon}
              selectedStation={selectedStation}
              onSelectStation={setSelectedStation}
            />
          ) : (
            <div className="h-80 rounded bg-gray-100 animate-pulse" />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <CardTitle className="text-base">
              Reconciliation
              <span className="ml-2 text-xs font-normal text-gray-400">
                ≈ = low confidence · click a row to highlight on the chart
              </span>
            </CardTitle>
            <button
              onClick={calibrateAll}
              disabled={!winId}
              className="text-xs px-2.5 py-1 rounded border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 transition-colors disabled:opacity-40"
              title="Apply program starts, durations, and baselines from this day to the active config window"
            >
              ⤓ Calibrate config from this day
            </button>
          </div>
        </CardHeader>
        <CardContent>
          {dayCalc ? (
            <ReconciliationTable
              recon={dayCalc.recon}
              maintenance={maintenance}
              selectedStation={selectedStation}
              onSelectStation={setSelectedStation}
              onApplyBaseline={applyBaseline}
              onApplyStart={applyStart}
              onApplyDuration={applyDuration}
              onToggleMaintenance={toggleMaintenance}
            />
          ) : (
            <div className="h-40 rounded bg-gray-100 animate-pulse" />
          )}
        </CardContent>
      </Card>

      {/* Fleet overview — cross-day aggregate (existing analysis) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Fleet Overview
            <span className="ml-2 text-xs font-normal text-gray-400">average flow across all loaded data</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={chartData} layout="vertical" margin={{ left: 16, right: 24 }}>
              <XAxis type="number" tick={{ fontSize: 11 }} />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={52} />
              {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
              <Tooltip formatter={(v: any) => [`${Number(v).toFixed(3)} gpm`]} />
              <Bar dataKey="gpm" fill="#3b82f6" name="avg gpm">
                <ErrorBar dataKey="err" width={4} strokeWidth={1} stroke="#1d4ed8" />
              </Bar>
            </BarChart>
          </ResponsiveContainer>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Station</TableHead>
                <SortHeader k="totalGallons" label="Total Gal" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                <SortHeader k="avgGpm" label="Avg gpm" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                <SortHeader k="stdGpm" label="Std gpm" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                <SortHeader k="pctOfSprinkler" label="% Sprinkler" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                <SortHeader k="costEstimate" label="Est. Cost" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{s.name}</TableCell>
                  <TableCell>{s.totalGallons.toLocaleString(undefined, { maximumFractionDigits: 0 })}</TableCell>
                  <TableCell>{s.avgGpm.toFixed(3)}</TableCell>
                  <TableCell>{s.stdGpm.toFixed(3)}</TableCell>
                  <TableCell>{(s.pctOfSprinkler * 100).toFixed(1)}%</TableCell>
                  <TableCell>${s.costEstimate.toFixed(2)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
