"use client"

import { useDeferredValue, useMemo, useState } from "react"
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
  Rectangle,
} from "recharts"
import type { Breakdown, ChartBar, ConfigWindow, TimeBucket, TimeWindow } from "@/lib/types"
import { aggregateForChart, windowCutoff } from "@/lib/analyze"
import type { EnrichedRow } from "@/lib/types"

// ---- Colour palette -------------------------------------------------------
const STACK_COLORS: Record<string, string> = {
  house:    "#fb923c",
  sprinkler:"#3b82f6",
  timer1:   "#3b82f6",
  timer2:   "#6366f1",
}
const STATION_PALETTE = [
  "#3b82f6","#6366f1","#8b5cf6","#ec4899","#f43f5e",
  "#f97316","#eab308","#22c55e","#14b8a6","#06b6d4",
  "#0ea5e9","#a855f7","#84cc16","#f59e0b","#10b981",
]

// ---- Sub-components -------------------------------------------------------

const TIME_WINDOWS: { key: TimeWindow; label: string }[] = [
  { key: "2w",  label: "2W" },
  { key: "1m",  label: "1M" },
  { key: "3m",  label: "3M" },
  { key: "6m",  label: "6M" },
  { key: "1y",  label: "1Y" },
  { key: "all", label: "All" },
]
const BREAKDOWNS: { key: Breakdown; label: string }[] = [
  { key: "simple",  label: "Home vs Sprinkler" },
  { key: "timer",   label: "By Timer" },
  { key: "station", label: "By Station" },
]

function ButtonGroup<T extends string>({
  options, value, onChange, size = "sm",
}: {
  options: { key: T; label: string }[]
  value: T
  onChange: (v: T) => void
  size?: "sm" | "xs"
}) {
  const cls = size === "xs"
    ? "px-2 py-0.5 text-xs"
    : "px-3 py-1 text-sm"
  return (
    <div className="flex gap-1 flex-wrap">
      {options.map((o) => (
        <button
          key={o.key}
          onClick={() => onChange(o.key)}
          className={`${cls} rounded border transition-colors ${
            value === o.key
              ? "bg-blue-600 text-white border-blue-600"
              : "border-gray-300 text-gray-600 hover:border-gray-400"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// Custom bar shape — adds ⚠ indicator above anomalous bars
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function AnomalyBar(props: any) {
  const { x, y, width, height, isAnomaly, fill } = props
  return (
    <g>
      <Rectangle x={x} y={y} width={width} height={height} fill={fill} />
      {isAnomaly && (
        <text x={x + width / 2} y={y - 4} textAnchor="middle" fontSize={10} fill="#ef4444">
          ⚠
        </text>
      )}
    </g>
  )
}

// Label + (optional) click target for config-change reference lines
function ConfigLabel({ viewBox, notes, onClick }: { viewBox?: { x: number; y: number }; notes: string; onClick?: () => void }) {
  if (!viewBox) return null
  const { x, y } = viewBox
  return (
    <g onClick={onClick} style={{ cursor: onClick ? "pointer" : undefined }}>
      <rect x={x - 1} y={y} width={2} height={200} fill="#6366f1" opacity={0.4} />
      {/* wider transparent hit area so the marker is easy to click */}
      {onClick && <rect x={x - 4} y={y} width={150} height={16} fill="transparent" />}
      <text x={x + 4} y={y + 12} fontSize={9} fill="#6366f1" style={{ pointerEvents: "none" }}>
        ⚙ {notes.length > 24 ? notes.slice(0, 24) + "…" : notes}
      </text>
    </g>
  )
}

// ---- Main component -------------------------------------------------------

interface Props {
  enriched: EnrichedRow[]
  windows: ConfigWindow[]
  onDaySelect?: (date: string) => void
  selectedDay?: string | null
  onConfigClick?: (windowId: string) => void
}

export default function ConsumptionChart({ enriched, windows, onDaySelect, selectedDay, onConfigClick }: Props) {
  const [timeWindow, setTimeWindow] = useState<TimeWindow>("3m")
  const [breakdown, setBreakdown] = useState<Breakdown>("simple")

  // Defer heavy recomputation so button highlights update instantly
  const deferredWindow    = useDeferredValue(timeWindow)
  const deferredBreakdown = useDeferredValue(breakdown)
  const deferredEnriched  = useDeferredValue(enriched)
  const isStale = deferredWindow !== timeWindow || deferredBreakdown !== breakdown

  // Only daily (2w/1m) windows support click-to-drill
  const isClickable = (timeWindow === "2w" || timeWindow === "1m") && !!onDaySelect

  const { bars, stackKeys, configMarkers, bucketLabel, rangeLabel } = useMemo(() => {
    if (deferredEnriched.length === 0) return { bars: [], stackKeys: [], configMarkers: [] }

    const lastDate = deferredEnriched[deferredEnriched.length - 1].date
    const cutoff = windowCutoff(deferredWindow, lastDate)
    const filtered = deferredEnriched.filter((r) => r.date > cutoff)

    // Choose bucket size based on how many unique days are actually in the filtered
    // data — not blindly from the selected window. This prevents "6m" with only
    // 3 weeks of data collapsing everything into a single weekly bar.
    const uniqueDays = new Set(filtered.map((r) => r.date)).size
    const bucket: TimeBucket =
      uniqueDays <= 60  ? "day" :
      uniqueDays <= 270 ? "week" :
      "month"

    const bars: ChartBar[] = aggregateForChart(filtered, bucket, deferredBreakdown)

    // Collect stack keys (all numeric keys except total/isAnomaly/label/dateStart/dateEnd)
    const skipKeys = new Set(["label", "dateStart", "dateEnd", "total", "isAnomaly"])
    const keySet = new Set<string>()
    for (const bar of bars) {
      for (const k of Object.keys(bar)) {
        if (!skipKeys.has(k)) keySet.add(k)
      }
    }
    const stackOrder =
      deferredBreakdown === "simple"  ? ["house", "sprinkler"] :
      deferredBreakdown === "timer"   ? ["house", "timer1", "timer2"] :
      ["house", ...Array.from(keySet).filter((k) => k !== "house").sort()]
    const stackKeys = stackOrder.filter((k) => keySet.has(k))

    // Config change markers — find which bar label each window's effectiveFrom maps to
    const sortedWindows = [...windows].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
    const visibleWindows = sortedWindows.filter((w) => w.effectiveFrom >= cutoff)
    const configMarkers: Array<{ label: string; notes: string; windowId: string }> = []
    for (const w of visibleWindows) {
      const changeDate = w.effectiveFrom
      const bar = bars.find((b) => b.dateStart <= changeDate && b.dateEnd >= changeDate)
        ?? bars.find((b) => b.dateStart >= changeDate)
      if (bar && !configMarkers.find((m) => m.label === bar.label)) {
        configMarkers.push({ label: bar.label, notes: w.notes || "Config changed", windowId: w.id })
      }
    }

    const bucketLabel = bucket === "day" ? "daily" : bucket === "week" ? "weekly" : "monthly"
    const rangeLabel = bars.length > 0
      ? `${bars[0].dateStart} → ${bars[bars.length - 1].dateEnd}`
      : ""

    return { bars, stackKeys, configMarkers, bucketLabel, rangeLabel }
  }, [deferredEnriched, deferredWindow, deferredBreakdown, windows])

  // Label of the currently selected bar (for the ReferenceLine highlight)
  const selectedBarLabel = isClickable && selectedDay
    ? (bars.find((b) => b.dateStart === selectedDay)?.label ?? null)
    : null

  if (enriched.length === 0) {
    return <div className="flex items-center justify-center h-64 text-gray-400">No data</div>
  }

  function colorFor(key: string, idx: number): string {
    if (STACK_COLORS[key]) return STACK_COLORS[key]
    return STATION_PALETTE[idx % STATION_PALETTE.length]
  }

  function labelFor(key: string): string {
    const map: Record<string, string> = {
      house: "House", sprinkler: "Sprinkler", timer1: "Timer 1", timer2: "Timer 2",
    }
    return map[key] ?? key
  }

  // Bar-level click handler: receives the bar's data object directly, which is
  // more reliable than ComposedChart.onClick (that depends on hover activePayload).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function handleBarClick(barData: any) {
    if (!isClickable) return
    const dateStart = barData?.dateStart as string | undefined
    if (dateStart) onDaySelect?.(dateStart)
  }

  return (
    <div className={`space-y-3 transition-opacity duration-150 ${isStale ? "opacity-50" : ""}`}>
      {/* Controls row */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="space-y-1.5">
          <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">Breakdown</p>
          <ButtonGroup options={BREAKDOWNS} value={breakdown} onChange={setBreakdown} size="xs" />
        </div>
        <div className="space-y-1.5">
          <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">Window</p>
          <ButtonGroup options={TIME_WINDOWS} value={timeWindow} onChange={setTimeWindow} size="xs" />
        </div>
      </div>

      {/* Config change legend */}
      {configMarkers.length > 0 && (
        <div className="flex items-center gap-1.5 text-xs text-indigo-600">
          <span className="font-medium">⚙</span>
          <span>Purple lines = config changes</span>
          <span className="text-gray-300 mx-1">·</span>
          <span className="text-red-500 font-medium">⚠</span>
          <span className="text-gray-600">= unusually high usage</span>
        </div>
      )}
      {configMarkers.length === 0 && (
        <div className="flex items-center gap-1.5 text-xs text-gray-400">
          <span className="text-red-500">⚠</span>
          <span>= unusually high usage (IQR-based)</span>
        </div>
      )}

      <div className="flex items-center justify-between flex-wrap gap-2">
        {rangeLabel && (
          <p className="text-xs text-gray-400">
            {bucketLabel} bars · {rangeLabel}
          </p>
        )}
        {isClickable && (
          <p className="text-xs text-sky-500">
            Click a bar to view that day&apos;s station flow ↓
          </p>
        )}
      </div>

      <div>
        <ResponsiveContainer width="100%" height={320}>
          <ComposedChart data={bars} margin={{ top: 16, right: 8, left: 8, bottom: 4 }}>
            <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              formatter={(v: any, name: any) => [
                `${Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })} gal`,
                labelFor(String(name)),
              ]}
            />
            <Legend
              formatter={(value) => labelFor(String(value))}
              wrapperStyle={{ fontSize: 11 }}
            />

            {/* Stacked bars */}
            {stackKeys.map((key, i) => (
              <Bar
                key={key}
                dataKey={key}
                stackId="stack"
                fill={colorFor(key, i)}
                cursor={isClickable ? "pointer" : undefined}
                onClick={handleBarClick}
                // Pass anomaly flag to custom shape on the last (top) bar only
                shape={i === stackKeys.length - 1
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  ? (props: any) => <AnomalyBar {...props} fill={colorFor(key, i)} />
                  : undefined
                }
              />
            ))}

            {/* Total line */}
            <Line
              type="monotone"
              dataKey="total"
              stroke="#1e293b"
              dot={false}
              strokeWidth={1.5}
              name="Total"
            />

            {/* Config change markers */}
            {configMarkers.map((m) => (
              <ReferenceLine
                key={m.label}
                x={m.label}
                stroke="#6366f1"
                strokeDasharray="4 3"
                strokeWidth={1.5}
                label={(props: { viewBox?: { x: number; y: number } }) => (
                  <ConfigLabel
                    {...props}
                    notes={m.notes}
                    onClick={onConfigClick ? () => onConfigClick(m.windowId) : undefined}
                  />
                )}
              />
            ))}

            {/* Selected day highlight */}
            {selectedBarLabel && (
              <ReferenceLine
                x={selectedBarLabel}
                stroke="#0ea5e9"
                strokeWidth={2}
                strokeDasharray="0"
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
