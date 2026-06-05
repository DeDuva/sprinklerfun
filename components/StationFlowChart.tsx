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
}

const WARN_THRESHOLD = 0.20

// Custom bar shape: draws the bar + a per-row orange tick at the baseline x-position.
// Recharts passes all data-item fields (gpm, baseline, …) plus computed layout props
// (x, y, width, height, fill) into this component via React.cloneElement.
const BarWithBaselineTick = (props: any) => {
  const { x, y, width, height, fill, baseline, gpm } = props
  if (!width || width <= 0) return null

  // Convert baseline gpm → pixel x offset proportionally:
  // `x` = pixel position of value 0 on the x-axis
  // `width` pixels corresponds to `gpm` gpm, so baseline maps linearly
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

export default function StationFlowChart({ stats, config }: Props) {
  if (stats.length === 0) {
    return <div className="flex items-center justify-center h-56 text-gray-400">No data</div>
  }

  // Build baseline lookup
  const baselineLookup: Record<string, number> = {}
  for (const s of [...config.timer1.stations, ...config.timer2.stations]) {
    if (s.baselineGpm && s.baselineGpm > 0) baselineLookup[s.id] = s.baselineGpm
  }

  const hasBaselines = Object.keys(baselineLookup).length > 0

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
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            formatter={(v: any, name: any) => [
              `${Number(v).toFixed(3)} gpm`,
              name === "gpm" ? "Avg gpm" : name,
            ]}
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
