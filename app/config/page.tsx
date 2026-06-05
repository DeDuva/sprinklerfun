"use client"

import { useRef, useState } from "react"
import { useStore } from "@/lib/store"
import type { AppConfig, ConfigVersion, Station, TimerConfig } from "@/lib/types"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { toast } from "sonner"

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

// ---- Station editor -------------------------------------------------------

function StationEditor({
  stations,
  onChange,
}: {
  stations: Station[]
  onChange: (stations: Station[]) => void
}) {
  const [showDisabled, setShowDisabled] = useState(false)

  const update = (idx: number, field: keyof Station, value: string | number | boolean | undefined) =>
    onChange(stations.map((s, i) => (i === idx ? { ...s, [field]: value } : s)))

  const add = () => {
    const id = `S-${Date.now()}`
    onChange([...stations, { id, name: "", durationMin: 0, enabled: false }])
  }

  const remove = (idx: number) => onChange(stations.filter((_, i) => i !== idx))

  const active   = stations.filter((s) => s.enabled && s.durationMin > 0)
  const inactive = stations.filter((s) => !s.enabled || s.durationMin === 0)
  const visible  = showDisabled ? stations : active
  const visibleIndexes = showDisabled
    ? stations.map((_, i) => i)
    : stations.map((s, i) => (s.enabled && s.durationMin > 0 ? i : -1)).filter((i) => i !== -1)

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
              <th className="pb-1 w-6"></th>
            </tr>
          </thead>
          <tbody>
            {visibleIndexes.map((realIdx) => {
              const s = stations[realIdx]
              const dim = !s.enabled || s.durationMin === 0
              return (
                <tr key={s.id} className={`align-middle ${dim ? "opacity-40" : ""}`}>
                  <td className="py-0.5 pr-2">
                    <Checkbox
                      checked={s.enabled}
                      onCheckedChange={(v) => update(realIdx, "enabled", Boolean(v))}
                    />
                  </td>
                  <td className="py-0.5 pr-2">
                    <Input
                      value={s.name}
                      onChange={(e) => update(realIdx, "name", e.target.value)}
                      className="h-7 text-sm"
                    />
                  </td>
                  <td className="py-0.5 pr-2">
                    <Input
                      type="number"
                      min={0}
                      value={s.durationMin}
                      onChange={(e) => update(realIdx, "durationMin", Number(e.target.value))}
                      className="h-7 text-sm text-right w-16"
                    />
                  </td>
                  <td className="py-0.5 pr-2">
                    <Input
                      type="number"
                      min={0}
                      step="0.001"
                      placeholder="—"
                      value={s.baselineGpm ?? ""}
                      onChange={(e) =>
                        update(realIdx, "baselineGpm", e.target.value === "" ? undefined : Number(e.target.value))
                      }
                      className="h-7 text-sm text-right w-24"
                    />
                  </td>
                  <td className="py-0.5">
                    <button
                      onClick={() => remove(realIdx)}
                      className="text-gray-300 hover:text-red-500 text-lg leading-none px-1"
                      title="Remove"
                    >
                      ×
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-3 pt-1">
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={add}>
          + Add station
        </Button>
        {inactive.length > 0 && (
          <button
            className="text-xs text-gray-400 hover:text-gray-600"
            onClick={() => setShowDisabled((v) => !v)}
          >
            {showDisabled
              ? `Hide ${inactive.length} disabled`
              : `Show ${inactive.length} disabled`}
          </button>
        )}
      </div>
    </div>
  )
}

// ---- Timer section --------------------------------------------------------

function TimerSection({
  label,
  timer,
  onChange,
}: {
  label: string
  timer: TimerConfig
  onChange: (t: TimerConfig) => void
}) {
  const active = timer.stations.filter((s) => s.enabled && s.durationMin > 0)
  const totalMin = active.reduce((s, st) => s + st.durationMin, 0)

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">{label}</CardTitle>
          <span className="text-xs text-gray-400">{active.length} active · {totalMin} min total</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3">
          <Label className="w-24 shrink-0 text-sm">Start time</Label>
          <Input
            type="time"
            step="1"
            value={timer.start}
            onChange={(e) => onChange({ ...timer, start: e.target.value || timer.start })}
            className="w-36 h-8"
          />
        </div>
        <div>
          <Label className="text-sm mb-2 block">Stations (run in order)</Label>
          <StationEditor
            stations={timer.stations}
            onChange={(stations) => onChange({ ...timer, stations })}
          />
        </div>
      </CardContent>
    </Card>
  )
}

// ---- Save dialog ----------------------------------------------------------

function SaveDialog({ onSave, onCancel }: { onSave: (notes: string) => void; onCancel: () => void }) {
  const [notes, setNotes] = useState("")
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md space-y-4">
        <h2 className="text-lg font-semibold">Save Configuration</h2>
        <div>
          <Label className="text-sm">Change notes</Label>
          <p className="text-xs text-gray-400 mb-1">What changed and why?</p>
          <textarea
            className="w-full border rounded-md p-2 text-sm h-24 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="e.g. Spring startup — re-enabled T2-04, updated baselines"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            autoFocus
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button onClick={() => onSave(notes)}>Save</Button>
        </div>
      </div>
    </div>
  )
}

// ---- History panel --------------------------------------------------------

function HistoryPanel({ history, onRestore }: { history: ConfigVersion[]; onRestore: (v: ConfigVersion) => void }) {
  const [expanded, setExpanded] = useState<string | null>(null)

  if (history.length === 0) {
    return <p className="text-sm text-gray-400">No saved versions yet. Save your first config above.</p>
  }

  return (
    <div className="space-y-2">
      {history.map((v) => {
        const dt = new Date(v.savedAt)
        const label = dt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
          + " " + dt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
        const baselineCount = [...v.config.timer1.stations, ...v.config.timer2.stations]
          .filter((s) => s.enabled && s.durationMin > 0 && s.baselineGpm).length

        return (
          <div key={v.id} className="border rounded-lg overflow-hidden">
            <button
              className="w-full flex items-start gap-3 p-3 text-left hover:bg-gray-50 transition-colors"
              onClick={() => setExpanded(expanded === v.id ? null : v.id)}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium">{label}</span>
                  {baselineCount > 0 && (
                    <Badge variant="secondary" className="text-xs">{baselineCount} baselines</Badge>
                  )}
                </div>
                {v.notes && <p className="text-sm text-gray-500 mt-0.5 truncate">{v.notes}</p>}
              </div>
              <span className="text-gray-400 text-xs shrink-0">{expanded === v.id ? "▲" : "▼"}</span>
            </button>

            {expanded === v.id && (
              <div className="border-t px-3 pb-3 pt-2 space-y-3 bg-gray-50">
                {v.notes && <p className="text-sm text-gray-700">{v.notes}</p>}
                <div className="grid grid-cols-2 gap-4">
                  {[
                    { label: `T1 — ${v.config.timer1.start.slice(0, 5)}`, stations: v.config.timer1.stations },
                    { label: `T2 — ${v.config.timer2.start.slice(0, 5)}`, stations: v.config.timer2.stations },
                  ].map((t) => (
                    <div key={t.label}>
                      <p className="text-xs text-gray-500 font-medium uppercase tracking-wide mb-1">{t.label}</p>
                      {t.stations.filter((s) => s.enabled && s.durationMin > 0).map((s) => (
                        <div key={s.id} className="flex justify-between text-xs py-0.5">
                          <span>{s.name}</span>
                          <span className="text-gray-400">
                            {s.durationMin}m{s.baselineGpm ? <span className="text-blue-600 ml-1">@{s.baselineGpm}</span> : ""}
                          </span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
                <Button size="sm" variant="outline" className="h-7 text-xs"
                  onClick={() => { onRestore(v); toast.success("Restored — review and Save to make permanent") }}>
                  Restore this version
                </Button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ---- Export / Import ------------------------------------------------------

interface ConfigBundle {
  version: 1
  exportedAt: string
  config: AppConfig
  configHistory: ConfigVersion[]
}

function ExportImportCard() {
  const { config, configHistory, saveConfig } = useStore()
  const fileRef = useRef<HTMLInputElement>(null)
  const [urlInput, setUrlInput] = useState("")
  const [loadingUrl, setLoadingUrl] = useState(false)

  function doExport() {
    const bundle: ConfigBundle = {
      version: 1,
      exportedAt: new Date().toISOString(),
      config,
      configHistory,
    }
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" })
    const a = document.createElement("a")
    a.href = URL.createObjectURL(blob)
    a.download = `sprinkler-config-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(a.href)
    toast.success("Config exported")
  }

  function applyBundle(bundle: ConfigBundle) {
    if (bundle.version !== 1 || !bundle.config || !Array.isArray(bundle.configHistory)) {
      toast.error("Invalid config file")
      return
    }
    useStore.setState({
      config: bundle.config,
      configHistory: bundle.configHistory,
    })
    toast.success(`Config loaded — ${bundle.configHistory.length} version${bundle.configHistory.length !== 1 ? "s" : ""} in history`)
  }

  function handleFile(file: File) {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const bundle = JSON.parse(e.target?.result as string) as ConfigBundle
        applyBundle(bundle)
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
      const bundle = await res.json() as ConfigBundle
      applyBundle(bundle)
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
        {/* Export */}
        <div className="flex items-start gap-4 flex-wrap">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">Export</p>
            <p className="text-xs text-gray-400 mt-0.5">
              Downloads a JSON file with your current config and full version history.
              Commit it to your repo as{" "}
              <code className="bg-gray-100 px-1 rounded text-xs">public/default-config.json</code>{" "}
              to make it the default for new installs.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={doExport} className="shrink-0">
            Export JSON
          </Button>
        </div>

        <hr />

        {/* Import from file */}
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

        {/* Import from URL */}
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

export default function ConfigPage() {
  const { config, configHistory, saveConfig, restoreConfig, rows, clearRows } = useStore()
  const [local, setLocal] = useState<AppConfig>(() => JSON.parse(JSON.stringify(config)))
  const [showSaveDialog, setShowSaveDialog] = useState(false)

  const handleSave = (notes: string) => {
    saveConfig(local, notes)
    setShowSaveDialog(false)
    toast.success("Configuration saved")
  }

  const handleRestore = (v: ConfigVersion) => {
    restoreConfig(v)
    setLocal(JSON.parse(JSON.stringify(v.config)))
  }

  const toggleDay = (day: number) => {
    const days = local.sprinklerDays.includes(day)
      ? local.sprinklerDays.filter((d) => d !== day)
      : [...local.sprinklerDays, day].sort()
    setLocal({ ...local, sprinklerDays: days })
  }

  return (
    <div className="space-y-6 max-w-3xl">
      {showSaveDialog && <SaveDialog onSave={handleSave} onCancel={() => setShowSaveDialog(false)} />}

      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Configuration</h1>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setLocal(JSON.parse(JSON.stringify(config)))}>
            Reset
          </Button>
          <Button onClick={() => setShowSaveDialog(true)}>Save…</Button>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <TimerSection label="Timer 1" timer={local.timer1} onChange={(t) => setLocal({ ...local, timer1: t })} />
        <TimerSection label="Timer 2" timer={local.timer2} onChange={(t) => setLocal({ ...local, timer2: t })} />
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Watering Schedule</CardTitle></CardHeader>
        <CardContent>
          <div className="flex gap-3 flex-wrap">
            {DAY_LABELS.map((label, i) => (
              <label key={i} className="flex items-center gap-1.5 cursor-pointer text-sm">
                <Checkbox checked={local.sprinklerDays.includes(i)} onCheckedChange={() => toggleDay(i)} />
                {label}
              </label>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Detection &amp; Billing</CardTitle></CardHeader>
        <CardContent className="grid sm:grid-cols-2 gap-4">
          <div>
            <Label className="text-sm">Sprinkler-on threshold (gal)</Label>
            <p className="text-xs text-gray-400 mb-1">Gallons in the sprinkler window to count as a sprinkler day</p>
            <Input type="number" value={local.sprinklerOnThreshold}
              onChange={(e) => setLocal({ ...local, sprinklerOnThreshold: Number(e.target.value) })}
              className="w-40 h-8" />
          </div>
          <div>
            <Label className="text-sm">Gallons per billing unit</Label>
            <p className="text-xs text-gray-400 mb-1">EBMUD: 748 gal = 1 unit</p>
            <Input type="number" value={local.gallonsPerUnit}
              onChange={(e) => setLocal({ ...local, gallonsPerUnit: Number(e.target.value) })}
              className="w-40 h-8" />
          </div>
          <div>
            <Label className="text-sm">Cost per unit ($/unit)</Label>
            <p className="text-xs text-gray-400 mb-1">From your last water bill</p>
            <Input type="number" step="0.01" value={local.costPerUnit}
              onChange={(e) => setLocal({ ...local, costPerUnit: Number(e.target.value) })}
              className="w-40 h-8" />
          </div>
        </CardContent>
      </Card>

      <ExportImportCard />

      <Card>
        <CardHeader><CardTitle className="text-base">Configuration History</CardTitle></CardHeader>
        <CardContent>
          <HistoryPanel history={configHistory} onRestore={handleRestore} />
        </CardContent>
      </Card>

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
