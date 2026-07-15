"use client"

import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { useStore } from "@/lib/store"
import {
  enrichRows,
  buildDaySchedule,
  buildDayMinuteSeries,
  reconcileDay,
  rollupsToDailyRows,
  activeWindowForDate,
  currentConfig,
} from "@/lib/analyze"
import { fetchRollups, fetchStats, fetchDayRows } from "@/lib/backend"
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
import { Button } from "@/components/ui/button"
import DayPicker from "@/components/DayPicker"
import FlowTimelineChart from "@/components/FlowTimelineChart"
import ReconciliationTable from "@/components/ReconciliationTable"
import ReviewChangesModal from "@/components/ReviewChangesModal"
import {
  type StageKind,
  type StagedChange,
  stageKey,
  buildStagedChange,
  proposeAllChanges,
  applyStagedChanges,
} from "@/lib/staging"
import type { FlumeRow, RollupRow, SegmentReconciliation, StationStats } from "@/lib/types"

type SortKey = keyof StationStats

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
    <TableHead className="cursor-pointer select-none hover:text-sky-600" onClick={() => onSort(k)}>
      {label} {sortKey === k ? (sortDir === "desc" ? "↓" : "↑") : ""}
    </TableHead>
  )
}

export default function AnalysisPage() {
  const windows      = useStore((s) => s.windows)
  const serverVersion = useStore((s) => s.serverVersion)
  const maintenance  = useStore((s) => s.maintenance)
  const updateWindow = useStore((s) => s.updateWindow)
  const setStationMaintenance = useStore((s) => s.setStationMaintenance)

  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  const [selectedStation, setSelectedStation] = useState<string | null>(null)

  // ---- Server-derived data ------------------------------------------------
  // Sprinkler-day list comes from the rollup feed; the cross-day fleet gpm
  // stats come precomputed from /api/stats (they need the full per-minute
  // series, which the browser no longer holds).
  const [rollups, setRollups] = useState<RollupRow[] | null>(null)
  const [fleetStats, setFleetStats] = useState<StationStats[]>([])

  useEffect(() => {
    let cancelled = false
    Promise.all([fetchRollups(), fetchStats()])
      .then(([r, s]) => {
        if (cancelled) return
        setRollups(r)
        setFleetStats(s.stationStats)
      })
      .catch(() => {
        if (cancelled) return
        setRollups([])
        setFleetStats([])
      })
    return () => { cancelled = true }
  }, [serverVersion])

  const derived = useMemo(() => {
    if (!rollups || rollups.length === 0) return null
    const daily = rollupsToDailyRows(rollups)
    const allDates = daily.map((d) => d.date)
    const sprinklerDates = daily.filter((d) => d.isSprinklerDay).map((d) => d.date)
    return { allDates, sprinklerDates }
  }, [rollups])

  const day = selectedDay ?? derived?.sprinklerDates[derived.sprinklerDates.length - 1] ?? null

  // ---- Per-day calibration (single-day fetch + client-side enrich) --------
  const [dayData, setDayData] = useState<{ day: string; rows: FlumeRow[] } | null>(null)
  useEffect(() => {
    if (!day) return
    let cancelled = false
    fetchDayRows(day)
      .then((rows) => { if (!cancelled) setDayData({ day, rows }) })
      .catch(() => { if (!cancelled) setDayData({ day, rows: [] }) })
    return () => { cancelled = true }
  }, [day, serverVersion])

  const dayCalc = useMemo(() => {
    // Ignore a stale fetch for a different day (e.g. mid day-switch).
    if (!dayData || dayData.day !== day) return null
    const { day: d, rows } = dayData
    const activeWin = activeWindowForDate(windows, d)
    const dayConfig = activeWin?.config ?? currentConfig(windows)
    const dow = (new Date(d + "T12:00:00").getDay() + 6) % 7
    const schedule = buildDaySchedule(dayConfig, dow)
    const enriched = enrichRows(rows, dayConfig)
    const series = buildDayMinuteSeries(enriched.filter((r) => r.date === d))
    const recon = reconcileDay(series, schedule)
    return { activeWin, dayConfig, schedule, series, recon }
  }, [dayData, day, windows])

  // ---- Fleet overview (precomputed, all data) ----------------------------
  const [sortKey, setSortKey] = useState<SortKey>("totalGallons")
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc")

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

  // ---- Staged config changes (propose → review → save) -------------------
  const winId = dayCalc?.activeWin?.id ?? null
  const stageCtx = `${day ?? ""}|${winId ?? ""}`
  const [stage, setStage] = useState<{ ctx: string; map: Map<string, StagedChange>; review: boolean }>(
    () => ({ ctx: stageCtx, map: new Map(), review: false })
  )
  if (stage.ctx !== stageCtx) setStage({ ctx: stageCtx, map: new Map(), review: false })
  const staged = stage.map
  const reviewOpen = stage.review
  const setReviewOpen = (v: boolean) => setStage((s) => ({ ...s, review: v }))
  const mutateStaged = (fn: (m: Map<string, StagedChange>) => Map<string, StagedChange>) =>
    setStage((s) => ({ ...s, map: fn(s.map) }))
  const discardStaged = () => setStage((s) => ({ ...s, map: new Map(), review: false }))

  const isStaged = (r: SegmentReconciliation, kind: StageKind) => staged.has(stageKey(r, kind))
  const toggleStage = (r: SegmentReconciliation, kind: StageKind) => {
    if (!winId) { toast.error("No config window active for this day — create one in Config first."); return }
    mutateStaged((prev) => {
      const next = new Map(prev)
      const k = stageKey(r, kind)
      if (next.has(k)) next.delete(k)
      else next.set(k, buildStagedChange(r, kind))
      return next
    })
  }

  const stageAll = () => {
    if (!winId || !dayCalc) { toast.error("No config window active for this day — create one in Config first."); return }
    const proposed = proposeAllChanges(dayCalc.recon)
    if (proposed.length === 0) { toast("Nothing to change — actuals already match config."); return }
    setStage((s) => ({ ...s, map: new Map(proposed.map((c) => [c.key, c])), review: true }))
  }

  const saveStaged = () => {
    if (!dayCalc?.activeWin || staged.size === 0) return
    const next = applyStagedChanges(dayCalc.activeWin.config, staged.values())
    updateWindow(dayCalc.activeWin.id, { config: next })
    const n = staged.size
    discardStaged()
    toast.success(`Saved ${n} config change${n !== 1 ? "s" : ""} to the ${configLabel ?? "active"} window`)
  }

  const toggleMaintenance = (r: SegmentReconciliation) => {
    if (maintenance[r.stationId]) {
      setStationMaintenance(r.stationId, null)
      toast.success(`${r.name} maintenance flag cleared`)
    } else {
      setStationMaintenance(r.stationId, { flaggedAt: new Date().toISOString() })
      toast.success(`${r.name} flagged for maintenance`)
    }
  }

  // ---- Day navigation -----------------------------------------------------
  const sprinklerDates = derived?.sprinklerDates ?? []
  const prevDay = day ? [...sprinklerDates].filter((d) => d < day).pop() ?? null : null
  const nextDay = day ? sprinklerDates.find((d) => d > day) ?? null : null

  if (rollups !== null && rollups.length === 0) {
    return <div className="text-center py-24 text-gray-400">No data — go to Config to upload a CSV</div>
  }

  const configLabel = dayCalc?.activeWin
    ? new Date(dayCalc.activeWin.effectiveFrom + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
    : null

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-[#143049]" style={{ fontFamily: "var(--font-fredoka)" }}>Timing & Flow Calibration</h1>

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
              <DayPicker
                sprinklerDates={sprinklerDates}
                selected={day}
                onSelect={setSelectedDay}
              />
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
            <Button
              variant="outline"
              size="sm"
              onClick={stageAll}
              disabled={!winId}
              title="Stage every detected duration/baseline change from this day for review"
            >
              ⤓ Stage all changes from this day
            </Button>
          </div>
          <p className="text-xs text-gray-400 mt-1">
            Buttons below <span className="font-medium text-gray-500">propose</span> config edits — they’re staged for review and{" "}
            <span className="font-medium text-gray-500">nothing is saved</span> until you review &amp; save.
          </p>
        </CardHeader>
        <CardContent>
          {dayCalc ? (
            <ReconciliationTable
              recon={dayCalc.recon}
              maintenance={maintenance}
              selectedStation={selectedStation}
              onSelectStation={setSelectedStation}
              isStaged={isStaged}
              onToggleStage={toggleStage}
              onToggleMaintenance={toggleMaintenance}
            />
          ) : (
            <div className="h-40 rounded bg-gray-100 animate-pulse" />
          )}

          {staged.size > 0 && (
            <div className="sticky bottom-3 mt-4 flex items-center justify-between gap-3 flex-wrap rounded-lg border border-sky-300 bg-sky-50 px-4 py-2.5 shadow-sm">
              <span className="text-sm text-sky-800">
                <span className="font-semibold">{staged.size}</span> proposed config change{staged.size !== 1 ? "s" : ""}
                <span className="text-sky-600"> · not saved yet</span>
              </span>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={discardStaged}>Discard</Button>
                <Button size="sm" onClick={() => setReviewOpen(true)}>Review &amp; Save…</Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Fleet overview — cross-day aggregate (precomputed server-side) */}
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
              <Bar dataKey="gpm" fill="#35A7E4" name="avg gpm">
                <ErrorBar dataKey="err" width={4} strokeWidth={1} stroke="#1B6FA8" />
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

      <ReviewChangesModal
        open={reviewOpen}
        windowDateLabel={configLabel}
        items={[...staged.values()].map((c) => ({
          key: c.key, area: c.area, field: c.field, fromText: c.fromText, toText: c.toText, note: c.note,
        }))}
        onRemove={(key) => mutateStaged((prev) => { const next = new Map(prev); next.delete(key); return next })}
        onSave={saveStaged}
        onCancel={() => setReviewOpen(false)}
      />
    </div>
  )
}
