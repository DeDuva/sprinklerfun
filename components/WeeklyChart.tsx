"use client"

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
} from "recharts"
import type { WeeklyRow } from "@/lib/types"

interface Props {
  weeklyRows: WeeklyRow[]
}

export default function WeeklyChart({ weeklyRows }: Props) {
  if (weeklyRows.length === 0) {
    return <div className="flex items-center justify-center h-56 text-gray-400">No data</div>
  }

  // Compute median total to draw a reference line for "normal"
  const sorted = [...weeklyRows].map((w) => w.totalGallons).sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]

  const data = weeklyRows.map((w) => ({
    week: w.weekStart.slice(5), // "MM-DD"
    weekFull: w.weekStart,
    Sprinkler: Math.round(w.sprinklerGallons),
    House: Math.round(w.houseGallons),
    Total: Math.round(w.totalGallons),
  }))

  return (
    <ResponsiveContainer width="100%" height={280}>
      <ComposedChart data={data} margin={{ left: 8, right: 8, top: 4 }}>
        <XAxis dataKey="week" tick={{ fontSize: 11 }} />
        <YAxis tick={{ fontSize: 11 }} />
        <Tooltip
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          formatter={(v: any, name: any) => [`${Number(v).toLocaleString()} gal`, name]}
          labelFormatter={(l) => `Week of ${l}`}
        />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <ReferenceLine
          y={median}
          stroke="#94a3b8"
          strokeDasharray="4 3"
          label={{ value: `median ${Math.round(median).toLocaleString()}`, position: "insideTopRight", fontSize: 10, fill: "#94a3b8" }}
        />
        <Bar dataKey="Sprinkler" stackId="a" fill="#3b82f6" />
        <Bar dataKey="House" stackId="a" fill="#fb923c" />
        <Line type="monotone" dataKey="Total" stroke="#1e293b" dot={false} strokeWidth={1.5} />
      </ComposedChart>
    </ResponsiveContainer>
  )
}
