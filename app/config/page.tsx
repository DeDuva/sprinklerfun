"use client"

import { Suspense, useEffect, useMemo, useRef, useState } from "react"
import { useSearchParams } from "next/navigation"
import { useStore } from "@/lib/store"
import { sortWindows, toWindows } from "@/lib/types"
import type { AppConfig, ConfigWindow, ProgramConfig, ProgramId, Station, TimerConfig } from "@/lib/types"
import {
  enrichRowsMultiConfig,
  buildDailyRows,
  activeWindowForDate,
  windowDateRange,
  diffConfigs,
} from "@/lib/analyze"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { toast } from "sonner"
import Papa from "papaparse"
import type { FlumeRow } from "@/lib/types"

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
const PROGRAM_IDS: ProgramId[] = ["A", "B", "C"]

const fmtDate = (d: string) =>
  new Date(d + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })

const todayStr = () => new Date().toISOString().slice(0, 10)

// ---- Program station table ------------------------------------------------

function ProgramStationEditor({
  stations,
  programStations,
  isBaseProgram,
  onProgramStationsChange,
  onStationUpdate,
  onStationRemove,
}: {
  stations: Station[]
  programStations: ProgramConfig["stations"]
  isBaseProgram: boolean
  onProgramStationsChange: (ps: ProgramConfig["stations"]) => void
  onStationUpdate: (id: string, field: keyof Station, value: string | number | undefined) => void
  onStationRemove: (id: string) => void
}) {
  const [showDisabled, setShowDisabled] = useState(false)

  const getPs = (id: string) => programStations[id] ?? { durationMin: 0, enabled: false }

  const updatePs = (id: string, field: "durationMin" | "enabled", value: number | boolean) => {
    const current = getPs(id)
    onProgramStationsChange({ ...programStations, [id]: { ...current, [field]: value } })
  }

  // Entering a duration > 0 implicitly enables the station
  const handleDurationChange = (id: string, value: number) => {
    const current = getPs(id)
    const next = { ...current, durationMin: value }
    if (value > 0 && !current.enabled) next.enabled = true
    onProgramStationsChange({ ...programStations, [id]: next })
  }

  const active   = stations.filter((s) => { const ps = getPs(s.id); return ps.enabled && ps.durationMin > 0 })
  const inactive = stations.filter((s) => { const ps = getPs(s.id); return !ps.enabled || ps.durationMin === 0 })
  // When no stations are active yet (e.g. freshly enabled program B/C), show all so the
  // user can see them and start entering durations without hunting for a toggle first.
  const visible  = (showDisabled || active.length === 0) ? stations : active

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-xs text-gray-400 text-left">
              <th className="pb-1 pr-2 font-normal w-8">On</th>
              <th className="pb-1 pr-2 font-normal">Name</th>
              <th className="pb-1 pr-2 font-normal w-16 text-right">Min</th>
              <th className="pb-1 pr-2 font-normal w-24 text-right">Baseline gpm</th>
              {isBaseProgram && <th className="pb-1 w-6"></th>}
            </tr>
          </thead>
          <tbody>
            {visible.map((s) => {
              const ps = getPs(s.id)
              const dim = !ps.enabled || ps.durationMin === 0
              return (
                <tr key={s.id} className={`align-middle ${dim ? "opacity-40" : ""}`}>
                  <td className="py-0.5 pr-2">
                    <Checkbox
                      checked={ps.enabled}
                      onCheckedChange={(v) => updatePs(s.id, "enabled", Boolean(v))}
                    />
                  </td>
                  <td className="py-0.5 pr-2">
                    {isBaseProgram ? (
                      <Input
                        value={s.name}
                        onChange={(e) => onStationUpdate(s.id, "name", e.target.value)}
                        className="h-7 text-sm"
                      />
                    ) : (
                      <span className="text-sm text-gray-600 px-1">{s.name}</span>
                    )}
                  </td>
                  <td className="py-0.5 pr-2">
                    <Input
                      type="number"
                      min={0}
                      value={ps.durationMin}
                      onChange={(e) => handleDurationChange(s.id, Number(e.target.value))}
                      onFocus={(e) => e.target.select()}
                      className="h-7 text-sm text-right w-16"
                    />
                  </td>
                  <td className="py-0.5 pr-2">
                    {isBaseProgram ? (
                      <Input
                        type="number"
                        min={0}
                        step="0.001"
                        placeholder="—"
                        value={s.baselineGpm ?? ""}
                        onChange={(e) =>
                          onStationUpdate(s.id, "baselineGpm", e.target.value === "" ? undefined : Number(e.target.value))
                        }
                        className="h-7 text-sm text-right w-24"
                      />
                    ) : (
                      <span className="text-xs text-gray-400 flex items-center justify-end gap-1 pr-1 h-7">
                        <svg width="10" height="10" viewBox="0 0 10 10" className="shrink-0 opacity-50">
                          <rect x="2" y="4" width="6" height="5" rx="1" fill="currentColor" />
                          <path d="M3 4V3a2 2 0 0 1 4 0v1" stroke="currentColor" strokeWidth="1.2" fill="none" />
                        </svg>
                        {s.baselineGpm != null ? s.baselineGpm.toFixed(3) : "—"}
                      </span>
                    )}
                  </td>
                  {isBaseProgram && (
                    <td className="py-0.5">
                      <button
                        onClick={() => onStationRemove(s.id)}
                        className="text-gray-300 hover:text-red-500 text-lg leading-none px-1"
                        title="Remove"
                      >
                        ×
                      </button>
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-3 pt-1">
        {inactive.length > 0 && (
          <button
            className="text-xs text-gray-400 hover:text-gray-600"
            onClick={() => setShowDisabled((v) => !v)}
          >
            {showDisabled ? `Hide ${inactive.length} disabled` : `Show ${inactive.length} disabled`}
          </button>
        )}
      </div>
    </div>
  )
}

// ---- Timer section with program tabs -------------------------------------

function TimerSection({
  label,
  timer,
  onChange,
}: {
  label: string
  timer: TimerConfig
  onChange: (t: TimerConfig) => void
}) {
  const [activeProgram, setActiveProgram] = useState<ProgramId>("A")

  const prog = timer.programs[activeProgram]

  // Derived stats for the active program
  const activeStations = timer.stations.filter((s) => {
    const ps = prog.stations[s.id]
    return ps?.enabled && (ps?.durationMin ?? 0) > 0
  })
  const totalMin = activeStations.reduce((sum, s) => sum + (prog.stations[s.id]?.durationMin ?? 0), 0)

  const updateProgram = (pid: ProgramId, update: Partial<ProgramConfig>) => {
    onChange({
      ...timer,
      programs: { ...timer.programs, [pid]: { ...timer.programs[pid], ...update } },
    })
  }

  const toggleProgramEnabled = (pid: ProgramId) => {
    if (pid === "A") return
    updateProgram(pid, { enabled: !timer.programs[pid].enabled })
  }

  const toggleDay = (pid: ProgramId, day: number) => {
    const days = timer.programs[pid].days.includes(day)
      ? timer.programs[pid].days.filter((d) => d !== day)
      : [...timer.programs[pid].days, day].sort()
    updateProgram(pid, { days })
  }

  const addStation = () => {
    const id = `S-${Date.now()}`
    const newStation: Station = { id, name: "", }
    const newPs = { durationMin: 0, enabled: false }
    // Add to global station list
    const stations = [...timer.stations, newStation]
    // Add default settings to every program
    const programs = { ...timer.programs } as typeof timer.programs
    for (const pid of PROGRAM_IDS) {
      programs[pid] = { ...programs[pid], stations: { ...programs[pid].stations, [id]: newPs } }
    }
    onChange({ ...timer, stations, programs })
  }

  const removeStation = (id: string) => {
    const stations = timer.stations.filter((s) => s.id !== id)
    const programs = { ...timer.programs } as typeof timer.programs
    for (const pid of PROGRAM_IDS) {
      const { [id]: _, ...rest } = programs[pid].stations
      programs[pid] = { ...programs[pid], stations: rest }
    }
    onChange({ ...timer, stations, programs })
  }

  const updateStationField = (id: string, field: keyof Station, value: string | number | undefined) => {
    onChange({
      ...timer,
      stations: timer.stations.map((s) => (s.id === id ? { ...s, [field]: value } : s)),
    })
  }

  const updateProgramStations = (pid: ProgramId, ps: ProgramConfig["stations"]) => {
    updateProgram(pid, { stations: ps })
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">{label}</CardTitle>
          <span className="text-xs text-gray-400">{activeStations.length} active · {totalMin} min</span>
        </div>

        {/* Program tab bar */}
        <div className="flex gap-0.5 mt-2 border-b border-gray-100">
          {PROGRAM_IDS.map((pid) => {
            const p = timer.programs[pid]
            const isActive = activeProgram === pid
            return (
              <button
                key={pid}
                onClick={() => setActiveProgram(pid)}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-t transition-colors relative -mb-px ${
                  isActive
                    ? "bg-white border border-b-white border-gray-200 text-gray-800 font-medium z-10"
                    : "text-gray-400 hover:text-gray-600"
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    p.enabled ? "bg-green-400" : "bg-gray-300"
                  }`}
                />
                Program {pid}
                {pid !== "A" && !p.enabled && (
                  <span className="text-xs text-gray-300 ml-0.5">off</span>
                )}
              </button>
            )
          })}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* B/C: show enable prompt if off */}
        {activeProgram !== "A" && !prog.enabled ? (
          <div className="text-center py-10 space-y-3">
            <p className="text-sm text-gray-400">
              Program {activeProgram} is off. Enable it to add a parallel watering schedule
              with different days or durations.
            </p>
            <Button size="sm" onClick={() => toggleProgramEnabled(activeProgram)}>
              Enable Program {activeProgram}
            </Button>
          </div>
        ) : (
          <>
            {/* Days */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <Label className="text-sm">Days</Label>
                {activeProgram !== "A" && (
                  <button
                    onClick={() => toggleProgramEnabled(activeProgram)}
                    className="text-xs text-gray-400 hover:text-red-500 transition-colors"
                  >
                    Disable Program {activeProgram}
                  </button>
                )}
              </div>
              <div className="flex gap-3 flex-wrap">
                {DAY_LABELS.map((dayLabel, i) => (
                  <label key={i} className="flex items-center gap-1.5 cursor-pointer text-sm">
                    <Checkbox
                      checked={prog.days.includes(i)}
                      onCheckedChange={() => toggleDay(activeProgram, i)}
                    />
                    {dayLabel}
                  </label>
                ))}
              </div>
            </div>

            {/* Start time */}
            <div className="flex items-center gap-3">
              <Label className="w-20 shrink-0 text-sm">Start time</Label>
              <Input
                type="time"
                step="1"
                value={prog.start}
                onChange={(e) => updateProgram(activeProgram, { start: e.target.value || prog.start })}
                className="w-36 h-8"
              />
            </div>

            {/* Stations */}
            <div>
              <Label className="text-sm mb-2 block">
                Stations (run in order)
                {activeProgram !== "A" && (
                  <span className="ml-2 text-xs font-normal text-gray-400">
                    — names &amp; GPM set on Program A
                  </span>
                )}
              </Label>
              <ProgramStationEditor
                stations={timer.stations}
                programStations={prog.stations}
                isBaseProgram={activeProgram === "A"}
                onProgramStationsChange={(ps) => updateProgramStations(activeProgram, ps)}
                onStationUpdate={updateStationField}
                onStationRemove={removeStation}
              />
              {activeProgram === "A" && (
                <Button variant="outline" size="sm" className="h-7 text-xs mt-2" onClick={addStation}>
                  + Add station
                </Button>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

// ---- Detection & billing --------------------------------------------------

function BillingCard({ config, onChange }: { config: AppConfig; onChange: (c: AppConfig) => void }) {
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Detection &amp; Billing</CardTitle></CardHeader>
      <CardContent className="grid sm:grid-cols-2 gap-4">
        <div>
          <Label className="text-sm">Sprinkler-on threshold (gal)</Label>
          <p className="text-xs text-gray-400 mb-1">Gallons in the sprinkler window to count as a sprinkler day</p>
          <Input type="number" value={config.sprinklerOnThreshold}
            onChange={(e) => onChange({ ...config, sprinklerOnThreshold: Number(e.target.value) })}
            className="w-40 h-8" />
        </div>
        <div>
          <Label className="text-sm">Gallons per billing unit</Label>
          <p className="text-xs text-gray-400 mb-1">EBMUD: 748 gal = 1 unit</p>
          <Input type="number" value={config.gallonsPerUnit}
            onChange={(e) => onChange({ ...config, gallonsPerUnit: Number(e.target.value) })}
            className="w-40 h-8" />
        </div>
        <div>
          <Label className="text-sm">Cost per unit ($/unit)</Label>
          <p className="text-xs text-gray-400 mb-1">From your last water bill</p>
          <Input type="number" step="0.01" value={config.costPerUnit}
            onChange={(e) => onChange({ ...config, costPerUnit: Number(e.target.value) })}
            className="w-40 h-8" />
        </div>
      </CardContent>
    </Card>
  )
}

// ---- Window timeline rail -------------------------------------------------

function WindowTimeline({
  windows,
  counts,
  selectedId,
  currentId,
  onSelect,
  onNew,
}: {
  windows: ConfigWindow[] // sorted ascending
  counts: Record<string, { days: number; sprinklerDays: number }>
  selectedId: string | null
  currentId: string | null
  onSelect: (id: string) => void
  onNew: () => void
}) {
  const ranges = windowDateRange(windows)
  const rangeById = Object.fromEntries(ranges.map((r) => [r.id, r]))

  return (
    <div className="flex gap-2 overflow-x-auto pb-2">
      {windows.map((w, i) => {
        const r = rangeById[w.id]
        const c = counts[w.id]
        const isSel = w.id === selectedId
        const isCurrent = w.id === currentId
        const isEarliest = i === 0
        return (
          <button
            key={w.id}
            onClick={() => onSelect(w.id)}
            className={`shrink-0 w-48 text-left rounded-lg border p-3 transition-colors ${
              isSel ? "border-blue-500 ring-1 ring-blue-500 bg-blue-50/40" : "border-gray-200 hover:border-gray-300"
            }`}
          >
            <div className="flex items-center gap-1.5 mb-1 flex-wrap">
              {isCurrent && <Badge className="text-[10px] px-1.5 py-0">current</Badge>}
              {isEarliest && <Badge variant="secondary" className="text-[10px] px-1.5 py-0">earliest</Badge>}
            </div>
            <div className="text-sm font-medium leading-tight">
              {fmtDate(w.effectiveFrom)}
              <span className="text-gray-400 font-normal"> → {r?.effectiveTo ? fmtDate(r.effectiveTo) : "now"}</span>
            </div>
            <p className="text-xs text-gray-500 mt-1 line-clamp-2 min-h-[2rem]">{w.notes || <span className="italic text-gray-300">no notes</span>}</p>
            <p className="text-[11px] text-gray-400 mt-1">
              {c ? `${c.days} day${c.days !== 1 ? "s" : ""} · ${c.sprinklerDays} sprinkler` : "no data in range"}
            </p>
          </button>
        )
      })}
      <button
        onClick={onNew}
        className="shrink-0 w-36 rounded-lg border border-dashed border-gray-300 text-gray-500 hover:border-blue-400 hover:text-blue-600 transition-colors flex items-center justify-center text-sm"
      >
        ＋ New config
      </button>
    </div>
  )
}

// ---- New window form ------------------------------------------------------

function NewWindowForm({
  existingDates,
  onCreate,
  onCancel,
}: {
  existingDates: string[]
  onCreate: (effectiveFrom: string, notes: string) => void
  onCancel: () => void
}) {
  const [date, setDate] = useState(todayStr())
  const [notes, setNotes] = useState("")

  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date)
  const dup = existingDates.includes(date)
  const canCreate = validDate && !dup

  return (
    <Card className="border-blue-200">
      <CardHeader className="pb-2"><CardTitle className="text-base">New config window</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-gray-500">
          Starts as a copy of the config active on the chosen date. Set the date to when the change took
          effect on your timer — analysis from that date forward uses the new settings.
        </p>
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <Label className="text-sm">Effective from</Label>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-44 h-8 mt-1" />
            {dup && <p className="text-xs text-red-500 mt-1">A window already starts on this date</p>}
          </div>
          <div className="flex-1 min-w-[12rem]">
            <Label className="text-sm">Notes</Label>
            <Input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. Reduced T1-03 to 12 min; new spring baselines"
              className="h-8 mt-1"
            />
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
          <Button size="sm" disabled={!canCreate} onClick={() => onCreate(date, notes)}>Create window</Button>
        </div>
      </CardContent>
    </Card>
  )
}

// ---- Changed-vs-previous diff --------------------------------------------

function WindowDiff({ prev, next }: { prev: ConfigWindow | null; next: AppConfig }) {
  if (!prev) {
    return (
      <p className="text-sm text-gray-400">
        This is the earliest window — it also applies to all data before its start date. Nothing to compare against.
      </p>
    )
  }
  const changes = diffConfigs(prev.config, next)
  if (changes.length === 0) {
    return <p className="text-sm text-gray-400">No differences from the previous window ({fmtDate(prev.effectiveFrom)}).</p>
  }
  // Group by area
  const byArea = new Map<string, typeof changes>()
  for (const c of changes) {
    if (!byArea.has(c.area)) byArea.set(c.area, [])
    byArea.get(c.area)!.push(c)
  }
  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-400">Compared with the previous window ({fmtDate(prev.effectiveFrom)})</p>
      {[...byArea.entries()].map(([area, items]) => (
        <div key={area}>
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">{area}</p>
          <div className="space-y-0.5">
            {items.map((c, i) => (
              <div key={i} className="flex items-baseline gap-2 text-sm">
                <span className="text-gray-600 min-w-[10rem]">{c.field}</span>
                <span className="text-gray-400 line-through">{c.from}</span>
                <span className="text-gray-300">→</span>
                <span className="font-medium text-gray-800">{c.to}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// ---- Export / Import ------------------------------------------------------

function parseRows(data: Record<string, string>[]): FlumeRow[] {
  const rows: FlumeRow[] = []
  for (const row of data) {
    const dt = row["datetime"] ?? row["Datetime"] ?? row["DateTime"]
    const g = parseFloat(row["gallons"] ?? row["Gallons"] ?? "0")
    if (dt && !isNaN(g)) rows.push({ datetime: dt.trim(), gallons: g })
  }
  return rows
}

function buildFlumeUrl(rows: FlumeRow[]): string {
  const tz = "-07:00"
  let since = "2026-05-01T00:00:00.000"
  if (rows.length > 0) {
    const latest = rows.reduce((a, b) => (a.datetime > b.datetime ? a : b)).datetime
    const d = new Date(latest)
    d.setMinutes(d.getMinutes() - 1)
    since = d.toISOString().replace("Z", "").slice(0, 23)
  }
  const now = new Date()
  const until = now.toISOString().replace("Z", "").slice(0, 23)
  return `https://portal.flumewater.com/dashboard?since=${since}${tz}&until=${until}${tz}&scale=hour`
}

function UploadCsvCard() {
  const appendRows = useStore((s) => s.appendRows)
  const rows = useStore((s) => s.rows)
  const fileRef = useRef<HTMLInputElement>(null)
  const [urlInput, setUrlInput] = useState("")
  const [loadingUrl, setLoadingUrl] = useState(false)
  const [dragging, setDragging] = useState(false)

  function finish(parsed: FlumeRow[], label: string) {
    if (parsed.length === 0) {
      toast.error("No valid rows found. Expected columns: datetime, gallons")
      return
    }
    appendRows(parsed)
    toast.success(`Loaded ${parsed.length.toLocaleString()} rows from ${label}`)
  }

  function processFile(file: File) {
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => finish(parseRows(results.data), file.name),
      error: () => toast.error("Failed to parse CSV"),
    })
  }

  async function loadFromUrl() {
    if (!urlInput.trim()) return
    setLoadingUrl(true)
    const rawUrl = urlInput
      .replace("https://github.com/", "https://raw.githubusercontent.com/")
      .replace("/blob/", "/")
    try {
      const res = await fetch(rawUrl)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      Papa.parse<Record<string, string>>(text, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => finish(parseRows(results.data), rawUrl.split("/").pop() ?? "URL"),
        error: () => toast.error("Failed to parse CSV"),
      })
      setUrlInput("")
    } catch (e) {
      toast.error(`Could not fetch URL: ${e instanceof Error ? e.message : e}`)
    } finally {
      setLoadingUrl(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          Upload CSV Data
          <span className="ml-2 text-xs font-normal text-gray-400">
            {rows.length.toLocaleString()} rows loaded
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="text-sm">
            <span className="font-medium text-gray-700">1.</span>{" "}
            <a
              href={buildFlumeUrl(rows)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:text-blue-700 underline underline-offset-2"
            >
              Open Flume export →
            </a>
            <span className="text-xs text-gray-400 ml-2">
              {rows.length > 0
                ? `from ${rows.reduce((a, b) => (a.datetime > b.datetime ? a : b)).datetime.slice(0, 10)}`
                : "full range"}
            </span>
          </div>
          <span className="text-sm text-gray-400">
            <span className="font-medium text-gray-700">2.</span> Download CSV, then drop it below
          </span>
        </div>

        <div
          className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${
            dragging ? "border-blue-500 bg-blue-50" : "border-gray-300 hover:border-gray-400"
          }`}
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            if (e.dataTransfer.files?.[0]) processFile(e.dataTransfer.files[0])
          }}
        >
          <p className="text-gray-600 font-medium">Drop CSV here or click to browse</p>
          <p className="text-xs text-gray-400 mt-1">New rows are merged with existing data. Duplicates are skipped.</p>
          <input
            ref={fileRef}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && processFile(e.target.files[0])}
          />
        </div>

        <div>
          <p className="text-sm font-medium mb-1">Load from URL</p>
          <p className="text-xs text-gray-400 mb-1.5">GitHub blob URLs are converted to raw automatically.</p>
          <div className="flex gap-2">
            <Input
              placeholder="https://github.com/user/repo/blob/main/data.csv"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && loadFromUrl()}
              className="text-sm h-8"
            />
            <Button size="sm" className="h-8 shrink-0" onClick={loadFromUrl} disabled={loadingUrl || !urlInput.trim()}>
              {loadingUrl ? "Loading…" : "Load"}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function ExportImportCard() {
  const windows = useStore((s) => s.windows)
  const fileRef = useRef<HTMLInputElement>(null)
  const [urlInput, setUrlInput] = useState("")
  const [loadingUrl, setLoadingUrl] = useState(false)

  function doExport() {
    const bundle = { version: 2, exportedAt: new Date().toISOString(), windows }
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" })
    const a = document.createElement("a")
    a.href = URL.createObjectURL(blob)
    a.download = `sprinkler-config-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(a.href)
    toast.success("Config exported")
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function applyBundle(bundle: any) {
    const next = toWindows({
      windows: bundle?.windows,
      config: bundle?.config,
      configHistory: bundle?.configHistory,
    })
    if (next.length === 0) {
      toast.error("No config found in this file")
      return
    }
    useStore.setState({ windows: next })
    toast.success(`Config loaded — ${next.length} window${next.length !== 1 ? "s" : ""}`)
  }

  function handleFile(file: File) {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        applyBundle(JSON.parse(e.target?.result as string))
      } catch {
        toast.error("Could not parse config file")
      }
    }
    reader.readAsText(file)
  }

  async function loadFromUrl() {
    if (!urlInput.trim()) return
    setLoadingUrl(true)
    const rawUrl = urlInput
      .replace("https://github.com/", "https://raw.githubusercontent.com/")
      .replace("/blob/", "/")
    try {
      const res = await fetch(rawUrl)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      applyBundle(await res.json())
      setUrlInput("")
    } catch (e) {
      toast.error(`Could not load: ${e instanceof Error ? e.message : e}`)
    } finally {
      setLoadingUrl(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Export / Import</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-start gap-4 flex-wrap">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">Export</p>
            <p className="text-xs text-gray-400 mt-0.5">
              Downloads a JSON file with all your config windows. Commit it to your repo as{" "}
              <code className="bg-gray-100 px-1 rounded text-xs">public/default-config.json</code>{" "}
              to make it the default for new installs. Old-format exports still import fine.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={doExport} className="shrink-0">
            Export JSON
          </Button>
        </div>

        <hr />

        <div>
          <p className="text-sm font-medium mb-1">Import from file</p>
          <input
            ref={fileRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
          />
          <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
            Choose JSON file
          </Button>
        </div>

        <div>
          <p className="text-sm font-medium mb-1">Import from URL</p>
          <p className="text-xs text-gray-400 mb-1.5">Paste a GitHub URL to your config file</p>
          <div className="flex gap-2">
            <Input
              placeholder="https://github.com/you/repo/blob/main/public/default-config.json"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && loadFromUrl()}
              className="text-sm h-8"
            />
            <Button size="sm" className="h-8 shrink-0" onClick={loadFromUrl} disabled={loadingUrl || !urlInput.trim()}>
              {loadingUrl ? "Loading…" : "Load"}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ---- Main page ------------------------------------------------------------

function ConfigPageInner() {
  const searchParams = useSearchParams()
  const windows = useStore((s) => s.windows)
  const rows = useStore((s) => s.rows)
  const addWindowFromDate = useStore((s) => s.addWindowFromDate)
  const updateWindow = useStore((s) => s.updateWindow)
  const deleteWindow = useStore((s) => s.deleteWindow)
  const copyBaselinesForward = useStore((s) => s.copyBaselinesForward)
  const clearRows = useStore((s) => s.clearRows)

  // Track persist hydration so we can distinguish "loading" from "no config yet".
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => {
    setHydrated(useStore.persist.hasHydrated())
    return useStore.persist.onFinishHydration(() => setHydrated(true))
  }, [])

  const sorted = useMemo(() => sortWindows(windows), [windows])
  const currentId = useMemo(() => activeWindowForDate(windows, todayStr())?.id ?? null, [windows])

  // Resolve the selected window: explicit click → URL ?window / ?date → current window.
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const resolvedId = useMemo(() => {
    if (selectedId && windows.some((w) => w.id === selectedId)) return selectedId
    const wParam = searchParams.get("window")
    if (wParam && windows.some((w) => w.id === wParam)) return wParam
    const dParam = searchParams.get("date")
    if (dParam) {
      const w = activeWindowForDate(windows, dParam)
      if (w) return w.id
    }
    return currentId ?? sorted[sorted.length - 1]?.id ?? null
  }, [selectedId, windows, searchParams, currentId, sorted])

  const selectedWindow = windows.find((w) => w.id === resolvedId) ?? null

  // Local editable draft of the selected window. Reset when the selection or the
  // underlying stored window changes (id + updatedAt), never while editing.
  const makeDraft = (w: ConfigWindow | null) =>
    w
      ? { config: JSON.parse(JSON.stringify(w.config)) as AppConfig, notes: w.notes, effectiveFrom: w.effectiveFrom }
      : { config: null as AppConfig | null, notes: "", effectiveFrom: "" }
  const [draft, setDraft] = useState(() => makeDraft(selectedWindow))
  const loadedKey = useRef<string>("")
  useEffect(() => {
    const key = selectedWindow ? `${selectedWindow.id}:${selectedWindow.updatedAt}` : ""
    if (key !== loadedKey.current) {
      loadedKey.current = key
      setDraft(makeDraft(selectedWindow))
    }
  }, [selectedWindow])

  // Enriched data for per-window day counts.
  const counts = useMemo(() => {
    if (rows.length === 0 || windows.length === 0) return {}
    const daily = buildDailyRows(enrichRowsMultiConfig(rows, windows))
    const m: Record<string, { days: number; sprinklerDays: number }> = {}
    for (const d of daily) {
      const w = activeWindowForDate(windows, d.date)
      if (!w) continue
      if (!m[w.id]) m[w.id] = { days: 0, sprinklerDays: 0 }
      m[w.id].days++
      if (d.isSprinklerDay) m[w.id].sprinklerDays++
    }
    return m
  }, [rows, windows])

  const [showNew, setShowNew] = useState(false)

  // ---- Empty / loading states ----
  if (!hydrated) {
    return <div className="max-w-3xl"><div className="h-40 rounded-lg bg-gray-100 animate-pulse" /></div>
  }
  if (windows.length === 0) {
    return (
      <div className="space-y-6 max-w-3xl">
        <h1 className="text-2xl font-bold">Configuration</h1>
        <Card>
          <CardContent className="py-10 text-center space-y-3">
            <p className="text-gray-500">No config yet. Create your first config window to start tracking schedule changes over time.</p>
            <Button onClick={() => { const id = addWindowFromDate(todayStr(), "Initial config"); setSelectedId(id); toast.success("First config created") }}>
              Create first config
            </Button>
          </CardContent>
        </Card>
        <UploadCsvCard />
        <ExportImportCard />
      </div>
    )
  }

  // ---- Derived editor state ----
  const selIdx = sorted.findIndex((w) => w.id === resolvedId)
  const prevWindow = selIdx > 0 ? sorted[selIdx - 1] : null
  const isEarliest = selIdx === 0
  const range = windowDateRange(windows).find((r) => r.id === resolvedId)

  const dirty =
    !!selectedWindow && !!draft.config &&
    (draft.notes !== selectedWindow.notes ||
      draft.effectiveFrom !== selectedWindow.effectiveFrom ||
      JSON.stringify(draft.config) !== JSON.stringify(selectedWindow.config))

  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(draft.effectiveFrom)
  const dupDate = !!selectedWindow && windows.some((w) => w.id !== selectedWindow.id && w.effectiveFrom === draft.effectiveFrom)
  const canSave = dirty && validDate && !dupDate

  const handleSave = () => {
    if (!selectedWindow || !draft.config || !canSave) return
    updateWindow(selectedWindow.id, { config: draft.config, notes: draft.notes, effectiveFrom: draft.effectiveFrom })
    toast.success("Window saved")
  }

  const handleDelete = () => {
    if (!selectedWindow || windows.length <= 1) return
    if (!confirm(`Delete the config window starting ${fmtDate(selectedWindow.effectiveFrom)}? Data in its range will fall back to the adjacent window.`)) return
    deleteWindow(selectedWindow.id)
    setSelectedId(null)
    toast.success("Window deleted")
  }

  const setConfig = (c: AppConfig) => setDraft((d) => ({ ...d, config: c }))

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Configuration</h1>
      </div>

      {/* Timeline rail */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <h2 className="text-sm font-semibold text-gray-600 uppercase tracking-wide">Config Windows</h2>
          <span className="text-xs text-gray-400">{windows.length} window{windows.length !== 1 ? "s" : ""}</span>
        </div>
        <WindowTimeline
          windows={sorted}
          counts={counts}
          selectedId={resolvedId}
          currentId={currentId}
          onSelect={(id) => { setSelectedId(id); setShowNew(false) }}
          onNew={() => setShowNew(true)}
        />
      </div>

      {showNew && (
        <NewWindowForm
          existingDates={windows.map((w) => w.effectiveFrom)}
          onCreate={(date, notes) => {
            const id = addWindowFromDate(date, notes)
            setSelectedId(id)
            setShowNew(false)
            toast.success(`New window effective ${fmtDate(date)}`)
          }}
          onCancel={() => setShowNew(false)}
        />
      )}

      {selectedWindow && draft.config && (
        <>
          {/* Window header: dates, notes, actions */}
          <Card>
            <CardContent className="pt-6 space-y-4">
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div className="flex flex-wrap items-end gap-4">
                  <div>
                    <Label className="text-sm">Effective from</Label>
                    <Input
                      type="date"
                      value={draft.effectiveFrom}
                      onChange={(e) => setDraft((d) => ({ ...d, effectiveFrom: e.target.value }))}
                      className="w-44 h-8 mt-1"
                    />
                  </div>
                  <div className="text-sm text-gray-500 pb-1.5">
                    Active {fmtDate(draft.effectiveFrom)} → {range?.effectiveTo ? fmtDate(range.effectiveTo) : "now"}
                    {(() => { const c = counts[selectedWindow.id]; return c ? ` · ${c.days} days, ${c.sprinklerDays} sprinkler` : "" })()}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-gray-400 hover:text-red-500"
                  disabled={windows.length <= 1}
                  onClick={handleDelete}
                  title={windows.length <= 1 ? "Can't delete the only window" : "Delete this window"}
                >
                  Delete window
                </Button>
              </div>

              {dupDate && <p className="text-xs text-red-500">Another window already starts on this date — pick a different one.</p>}
              {isEarliest && (
                <p className="text-xs text-gray-400">
                  This is the earliest window — its config also applies to all data before {fmtDate(draft.effectiveFrom)}.
                </p>
              )}

              <div>
                <Label className="text-sm">Notes</Label>
                <Input
                  value={draft.notes}
                  onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
                  placeholder="What changed and why?"
                  className="h-8 mt-1"
                />
              </div>

              <div className="flex items-center justify-between gap-2 pt-1">
                <span className={`text-xs ${dirty ? "text-amber-600" : "text-gray-400"}`}>
                  {dirty ? "Unsaved changes" : "All changes saved"}
                </span>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" disabled={!dirty} onClick={() => setDraft(makeDraft(selectedWindow))}>
                    Reset
                  </Button>
                  <Button size="sm" disabled={!canSave} onClick={handleSave}>Save window</Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Timer editors */}
          <div className="grid md:grid-cols-2 gap-4">
            <TimerSection
              label="Timer 1"
              timer={draft.config.timer1}
              onChange={(t) => setConfig({ ...draft.config!, timer1: t })}
            />
            <TimerSection
              label="Timer 2"
              timer={draft.config.timer2}
              onChange={(t) => setConfig({ ...draft.config!, timer2: t })}
            />
          </div>

          {/* Baseline helper */}
          {selIdx < sorted.length - 1 && (
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                disabled={dirty}
                onClick={() => { copyBaselinesForward(selectedWindow.id); toast.success("Baselines copied to later windows") }}
                title={dirty ? "Save changes first" : "Apply this window's baselines to all later windows"}
              >
                Copy baselines to later windows
              </Button>
              {dirty && <span className="text-xs text-gray-400">Save first to copy baselines</span>}
            </div>
          )}

          <BillingCard config={draft.config} onChange={setConfig} />

          {/* Changed vs previous window */}
          <Card>
            <CardHeader><CardTitle className="text-base">Changed vs. previous window</CardTitle></CardHeader>
            <CardContent>
              <WindowDiff prev={prevWindow} next={draft.config} />
            </CardContent>
          </Card>
        </>
      )}

      <UploadCsvCard />

      <ExportImportCard />

      <Card className="border-red-200">
        <CardHeader><CardTitle className="text-base text-red-600">Danger Zone</CardTitle></CardHeader>
        <CardContent>
          <p className="text-sm text-gray-500 mb-3">{rows.length.toLocaleString()} rows currently loaded.</p>
          <Button variant="destructive" size="sm"
            onClick={() => { if (confirm("Clear all CSV data?")) { clearRows(); toast.success("Data cleared") } }}>
            Clear all data
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}

export default function ConfigPage() {
  return (
    <Suspense fallback={<div className="max-w-3xl"><div className="h-40 rounded-lg bg-gray-100 animate-pulse" /></div>}>
      <ConfigPageInner />
    </Suspense>
  )
}
