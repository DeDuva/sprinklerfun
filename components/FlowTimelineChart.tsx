"use client"

import { useMemo, useRef, useState } from "react"
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceArea,
  ReferenceLine,
  Brush,
} from "recharts"
import type { ExpectedSegment, MinutePoint, SegmentReconciliation } from "@/lib/types"
import { cn } from "@/lib/utils"

interface Props {
  series: MinutePoint[]
  schedule: ExpectedSegment[]
  recon: SegmentReconciliation[]
  selectedStation: string | null
  onSelectStation: (id: string | null) => void
}

const PALETTE = [
  "#3b82f6", "#6366f1", "#8b5cf6", "#ec4899", "#f97316",
  "#eab308", "#22c55e", "#14b8a6", "#06b6d4", "#0ea5e9",
  "#a855f7", "#f43f5e", "#84cc16", "#f59e0b", "#10b981",
]

const fmtTime = (min: number) => {
  const h = Math.floor(min / 60) % 24
  const m = ((min % 60) + 60) % 60
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`
}

interface Row {
  t: number
  label: string
  actual: number
  configured: number | null
  cfgStation: string | null
}

export default function FlowTimelineChart({
  series,
  schedule,
  recon,
  selectedStation,
  onSelectStation,
}: Props) {
  const colorOf = useMemo(() => {
    const map: Record<string, string> = {}
    schedule.forEach((s, i) => {
      if (!map[s.stationId]) map[s.stationId] = PALETTE[i % PALETTE.length]
    })
    return map
  }, [schedule])

  // Viewable minute range: span of configured + detected runs, padded.
  const { lo, data } = useMemo(() => {
    let lo = Infinity
    let hi = -Infinity
    for (const s of schedule) {
      lo = Math.min(lo, s.startMin)
      hi = Math.max(hi, s.endMin)
    }
    for (const r of recon) {
      if (r.actualStartMin != null) lo = Math.min(lo, r.actualStartMin)
      if (r.actualEndMin != null) hi = Math.max(hi, r.actualEndMin)
    }
    if (lo === Infinity) {
      // No schedule — fall back to the actual data span.
      lo = series[0]?.timeMin ?? 0
      hi = series[series.length - 1]?.timeMin ?? 1439
    }
    lo = Math.max(0, lo - 15)
    hi = Math.min(1439, hi + 15)

    // Per-minute configured baseline (level of whichever station's window covers it).
    const gpmAt = new Map<number, number>()
    for (const p of series) gpmAt.set(p.timeMin, p.gpm)

    const data: Row[] = []
    for (let m = lo; m <= hi; m++) {
      let configured: number | null = null
      let cfgStation: string | null = null
      for (const s of schedule) {
        if (m > s.startMin && m <= s.endMin) {
          configured = s.baselineGpm
          cfgStation = s.stationId
          break
        }
      }
      data.push({
        t: m,
        label: fmtTime(m),
        actual: gpmAt.get(m) ?? 0,
        configured,
        cfgStation,
      })
    }
    return { lo, data }
  }, [series, schedule, recon])

  // Brush-controlled zoom window (indices into `data`).
  const [zoom, setZoom] = useState<{ start: number; end: number } | null>(null)
  const prevDataLen = useRef(data.length)
  if (data.length !== prevDataLen.current) {
    prevDataLen.current = data.length
    if (zoom) setZoom(null)
  }

  const zoomToStation = (id: string) => {
    const segs = schedule.filter((s) => s.stationId === id)
    const r = recon.filter((x) => x.stationId === id)
    if (segs.length === 0) return
    let s = Math.min(...segs.map((x) => x.startMin))
    let e = Math.max(...segs.map((x) => x.endMin))
    for (const x of r) {
      if (x.actualStartMin != null) s = Math.min(s, x.actualStartMin)
      if (x.actualEndMin != null) e = Math.max(e, x.actualEndMin)
    }
    const pad = 6
    const startIdx = Math.max(0, s - pad - lo)
    const endIdx = Math.min(data.length - 1, e + pad - lo)
    setZoom({ start: startIdx, end: endIdx })
  }

  const handleChip = (id: string) => {
    if (selectedStation === id) {
      onSelectStation(null)
      setZoom(null)
    } else {
      onSelectStation(id)
      zoomToStation(id)
    }
  }

  const reset = () => {
    onSelectStation(null)
    setZoom(null)
  }

  if (series.length === 0) {
    return <div className="flex items-center justify-center h-64 text-gray-400">No flow data for this day</div>
  }

  // Group stations by timer → program, deduped within each group.
  const stationGroups = useMemo(() => {
    const groups: Array<{
      key: string
      label: string
      stations: Array<{ id: string; name: string; color: string }>
    }> = []
    const seen = new Map<string, Set<string>>()
    for (const s of schedule) {
      const gk = `${s.timer}:${s.programId}`
      if (!seen.has(gk)) {
        seen.set(gk, new Set())
        const timerLabel = s.timer === "timer1" ? "T1" : "T2"
        groups.push({ key: gk, label: `${timerLabel} · Prog ${s.programId}`, stations: [] })
      }
      const ids = seen.get(gk)!
      if (!ids.has(s.stationId)) {
        ids.add(s.stationId)
        groups.find((g) => g.key === gk)!.stations.push({
          id: s.stationId,
          name: s.name,
          color: colorOf[s.stationId],
        })
      }
    }
    return groups
  }, [schedule, colorOf])

  // Expand the group that contains the selected station; collapse all by default.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const toggleGroup = (key: string) =>
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })

  const reconById = Object.fromEntries(recon.map((r) => [r.stationId, r]))

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-xs text-gray-400">
          <span className="text-blue-500 font-medium">Blue area</span> = actual gpm ·{" "}
          <span className="text-orange-500 font-medium">orange step</span> = configured baseline ·
          drag the bar below or click a station to zoom.
        </p>
        {(zoom || selectedStation) && (
          <button
            onClick={reset}
            className="text-xs px-2 py-0.5 rounded border text-gray-600 hover:border-gray-400 transition-colors"
          >
            Reset zoom
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {stationGroups.map((g) => {
          const isOpen = expandedGroups.has(g.key)
          const hasSelected = g.stations.some((s) => s.id === selectedStation)
          return (
            <div key={g.key} className="flex flex-wrap items-center gap-1">
              <button
                onClick={() => toggleGroup(g.key)}
                className={cn(
                  "text-[11px] font-medium px-1.5 py-0.5 rounded border transition-colors select-none",
                  hasSelected
                    ? "border-blue-300 bg-blue-50 text-blue-700"
                    : "border-gray-200 text-gray-500 hover:border-gray-400"
                )}
              >
                {isOpen ? "▾" : "▸"} {g.label}
                {!isOpen && hasSelected && selectedStation && (
                  <span className="ml-1 text-blue-600">
                    ({g.stations.find((s) => s.id === selectedStation)?.name})
                  </span>
                )}
              </button>
              {isOpen &&
                g.stations.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => handleChip(c.id)}
                    className={cn(
                      "text-xs px-2 py-0.5 rounded-full border transition-colors",
                      selectedStation === c.id
                        ? "border-transparent text-white"
                        : "border-gray-200 text-gray-600 hover:border-gray-400"
                    )}
                    style={selectedStation === c.id ? { backgroundColor: c.color } : undefined}
                  >
                    {c.name}
                  </button>
                ))}
            </div>
          )
        })}
      </div>

      <ResponsiveContainer width="100%" height={340}>
        <ComposedChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          <XAxis
            dataKey="label"
            tick={{ fontSize: 10 }}
            interval="preserveStartEnd"
            minTickGap={40}
          />
          <YAxis tick={{ fontSize: 11 }} width={36} label={{ value: "gpm", angle: -90, position: "insideLeft", fontSize: 11, fill: "#94a3b8" }} />
          <Tooltip content={<FlowTooltip />} />

          {/* Configured station bands — only render the selected one to avoid clutter */}
          {selectedStation &&
            schedule
              .filter((s) => s.stationId === selectedStation)
              .map((s, i) => (
                <ReferenceArea
                  key={`band-${i}`}
                  x1={fmtTime(s.startMin + 1)}
                  x2={fmtTime(s.endMin)}
                  fill={colorOf[s.stationId]}
                  fillOpacity={0.08}
                />
              ))}

          {/* Configured start ticks (solid) + detected start (dashed) for the selected station */}
          {selectedStation &&
            schedule
              .filter((s) => s.stationId === selectedStation)
              .map((s, i) => (
                <ReferenceLine
                  key={`cfg-${i}`}
                  x={fmtTime(s.startMin)}
                  stroke={colorOf[s.stationId]}
                  strokeWidth={1.5}
                  label={{ value: "cfg start", fontSize: 9, fill: colorOf[s.stationId], position: "top" }}
                />
              ))}
          {selectedStation && reconById[selectedStation]?.actualStartMin != null && (
            <ReferenceLine
              x={fmtTime(reconById[selectedStation].actualStartMin!)}
              stroke={colorOf[selectedStation]}
              strokeDasharray="4 3"
              strokeWidth={1.5}
              label={{ value: "actual", fontSize: 9, fill: colorOf[selectedStation], position: "insideTopRight" }}
            />
          )}

          <Area
            type="monotone"
            dataKey="actual"
            stroke="#3b82f6"
            fill="#3b82f6"
            fillOpacity={0.25}
            strokeWidth={1.5}
            isAnimationActive={false}
            name="actual gpm"
          />
          <Line
            type="stepAfter"
            dataKey="configured"
            stroke="#f97316"
            strokeWidth={2}
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
            name="configured baseline"
          />

          <Brush
            dataKey="label"
            height={22}
            travellerWidth={8}
            stroke="#cbd5e1"
            startIndex={Math.min(zoom?.start ?? 0, data.length - 1)}
            endIndex={Math.min(zoom?.end ?? data.length - 1, data.length - 1)}
            onChange={(r: { startIndex?: number; endIndex?: number }) => {
              if (r.startIndex != null && r.endIndex != null) setZoom({ start: r.startIndex, end: r.endIndex })
            }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

function FlowTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload?: any[]
  label?: string
}) {
  if (!active || !payload?.length) return null
  const row = payload[0]?.payload as Row | undefined
  if (!row) return null
  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-md px-3 py-2 text-xs space-y-1 min-w-[150px]">
      <p className="font-semibold text-gray-800 border-b border-gray-100 pb-1 mb-1">{label}</p>
      <div className="flex justify-between gap-4">
        <span className="text-gray-500">Actual</span>
        <span className="font-medium text-blue-600">{row.actual.toFixed(3)} gpm</span>
      </div>
      <div className="flex justify-between gap-4">
        <span className="text-gray-500">Configured</span>
        <span className="font-medium text-orange-500">
          {row.configured != null ? `${row.configured.toFixed(3)} gpm` : "—"}
        </span>
      </div>
      <div className="flex justify-between gap-4 border-t border-gray-100 pt-1 mt-1">
        <span className="text-gray-400">Station</span>
        <span className="text-gray-600">{row.cfgStation ?? "house / idle"}</span>
      </div>
    </div>
  )
}
