"use client"

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
  LabelList,
} from "recharts"
import type { AppConfig, StationStats } from "@/lib/types"

interface Props {
  stats: StationStats[]
  config: AppConfig
  selectedDay: string | null
  sprinklerDates: string[]
  onDayChange: (date: string) => void
  configVersionLabel?: string | null
}

const WARN_THRESHOLD = 0.20

// Custom bar shape: draws the bar + a per-row orange tick at the baseline x-position.
const BarWithBaselineTick = (props: any) => {
  const { x, y, width, height, fill, baseline, gpm } = props
  if (!width || width <= 0) return null

  const tickX =
    baseline != null && gpm > 0
      ? x + Math.round((baseline / gpm) * width)
      : null

  return (
    <g>
      <rect
        x={x}
        y={y}
        width={Math.max(0, width)}
        height={height}
        fill={fill}
        rx={2}
      />
      {tickX != null && (
        <line
          x1={tickX}
          x2={tickX}
          y1={y + 2}
          y2={y + height - 2}
          stroke="#f97316"
          strokeWidth={2.5}
          strokeLinecap="round"
        />
      )}
    </g>
  )
}

function DateNav({
  selectedDay,
  sprinklerDates,
  onDayChange,
}: {
  selectedDay: string | null
  sprinklerDates: string[]
  onDayChange: (d: string) => void
}) {
  if (!selectedDay) return null

  // Works whether selectedDay is a sprinkler day or not
  const prevDay = sprinklerDates.filter((d) => d < selectedDay).pop() ?? null
  const nextDay = sprinklerDates.find((d) => d > selectedDay) ?? null

  const fmtDate = (d: string) =>
    new Date(d + "T12:00:00").toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    })

  return (
    <div className="flex items-center gap-2 mb-3">
      <button
        onClick={() => prevDay && onDayChange(prevDay)}
        disabled={!prevDay}
        className="px-2 py-0.5 rounded border text-sm text-gray-600 disabled:opacity-30 hover:border-gray-400 transition-colors"
        title={prevDay ? `Previous sprinkler day: ${prevDay}` : "No earlier sprinkler day"}
      >
        ←
      </button>
      <span className="text-sm font-medium text-gray-700 flex-1 text-center">
        {fmtDate(selectedDay)}
      </span>
      <button
        onClick={() => nextDay && onDayChange(nextDay)}
        disabled={!nextDay}
        className="px-2 py-0.5 rounded border text-sm text-gray-600 disabled:opacity-30 hover:border-gray-400 transition-colors"
        title={nextDay ? `Next sprinkler day: ${nextDay}` : "No later sprinkler day"}
      >
        →
      </button>
    </div>
  )
}

// Custom tooltip — shows avg gpm, baseline gpm + delta, and config version date
function FlowTooltip({
  active,
  payload,
  configVersionLabel,
  baselineLookup,
}: {
  active?: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload?: any[]
  configVersionLabel?: string | null
  baselineLookup: Record<string, number>
}) {
  if (!active || !payload?.length) return null
  const entry = payload[0]?.payload as { name: string; gpm: number; baseline: number | null; isAbove: boolean }
  if (!entry) return null

  const { name, gpm, baseline } = entry
  const delta = baseline != null && baseline > 0 ? ((gpm - baseline) / baseline) * 100 : null

  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-md px-3 py-2 text-xs space-y-1 min-w-[160px]">
      <p className="font-semibold text-gray-800 border-b border-gray-100 pb-1 mb-1">{name}</p>
      <div className="flex justify-between gap-4">
        <span className="text-gray-500">Avg GPM</span>
        <span className="font-medium text-gray-900">{gpm.toFixed(3)}</span>
      </div>
      {baseline != null ? (
        <>
          <div className="flex justify-between gap-4">
            <span className="text-gray-500">Baseline</span>
            <span className="font-medium text-orange-500">{baseline.toFixed(3)}</span>
          </div>
          {delta != null && (
            <div className="flex justify-between gap-4">
              <span className="text-gray-500">vs baseline</span>
              <span className={`font-medium ${delta > 20 ? "text-red-500" : delta < -5 ? "text-blue-500" : "text-green-600"}`}>
                {delta >= 0 ? "+" : ""}{delta.toFixed(1)}%
              </span>
            </div>
          )}
        </>
      ) : (
        <div className="text-gray-400 italic">No baseline set</div>
      )}
      {configVersionLabel && (
        <div className="flex justify-between gap-4 border-t border-gray-100 pt-1 mt-1">
          <span className="text-gray-400">Config from</span>
          <span className="text-gray-500">{configVersionLabel}</span>
        </div>
      )}
    </div>
  )
}

export default function StationFlowChart({ stats, config, selectedDay, sprinklerDates, onDayChange, configVersionLabel }: Props) {
  // Build baseline lookup
  const baselineLookup: Record<string, number> = {}
  for (const s of [...config.timer1.stations, ...config.timer2.stations]) {
    if (s.baselineGpm && s.baselineGpm > 0) baselineLookup[s.id] = s.baselineGpm
  }

  const hasBaselines = Object.keys(baselineLookup).length > 0

  if (stats.length === 0) {
    return (
      <div>
        <DateNav selectedDay={selectedDay} sprinklerDates={sprinklerDates} onDayChange={onDayChange} />
        <div className="flex items-center justify-center h-40 text-gray-400">
          No station data for this day
        </div>
      </div>
    )
  }

  const data = stats.map((s) => {
    const baseline = baselineLookup[s.id]
    const isAbove = baseline ? s.avgGpm > baseline * (1 + WARN_THRESHOLD) : false
    return {
      name: s.name,
      gpm: +s.avgGpm.toFixed(3),
      baseline: baseline ?? null,
      isAbove,
    }
  })

  return (
    <div className="space-y-2">
      <DateNav selectedDay={selectedDay} sprinklerDates={sprinklerDates} onDayChange={onDayChange} />
      {hasBaselines && (
        <p className="text-xs text-gray-400 flex items-center gap-1.5">
          <svg width="10" height="14" className="shrink-0">
            <line x1="5" y1="1" x2="5" y2="13" stroke="#f97316" strokeWidth="2.5" strokeLinecap="round" />
          </svg>
          Orange tick = baseline gpm (per station).{" "}
          <span className="text-red-500">Red bars</span> are &gt;20% above baseline.
        </p>
      )}
      <ResponsiveContainer width="100%" height={Math.max(220, data.length * 28)}>
        <BarChart data={data} layout="vertical" margin={{ left: 8, right: 40 }}>
          <XAxis type="number" tick={{ fontSize: 11 }} />
          <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={52} />
          <Tooltip
            content={
              <FlowTooltip
                configVersionLabel={configVersionLabel}
                baselineLookup={baselineLookup}
              />
            }
          />
          <Bar dataKey="gpm" name="Avg gpm" shape={<BarWithBaselineTick />}>
            {data.map((entry, i) => (
              <Cell key={i} fill={entry.isAbove ? "#ef4444" : "#3b82f6"} />
            ))}
            <LabelList
              dataKey="gpm"
              position="right"
              style={{ fontSize: 10, fill: "#64748b" }}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              formatter={(v: any) => Number(v).toFixed(3)}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
