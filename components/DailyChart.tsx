"use client"

import { useMemo } from "react"
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  Cell,
} from "recharts"
import type { DailyRow } from "@/lib/types"
import { useRouter } from "next/navigation"

interface Props {
  dailyRows: DailyRow[]
}

const STATION_COLORS = [
  "#3b82f6", "#6366f1", "#8b5cf6", "#ec4899", "#f97316",
  "#eab308", "#22c55e", "#14b8a6", "#06b6d4", "#0ea5e9",
  "#a855f7", "#f43f5e", "#84cc16", "#f59e0b", "#10b981",
]

export default function DailyChart({ dailyRows }: Props) {
  const router = useRouter()

  const { chartData, stationIds } = useMemo(() => {
    const stationSet = new Set<string>()
    for (const row of dailyRows) {
      for (const k of Object.keys(row.byStation)) {
        if (k !== "house") stationSet.add(k)
      }
    }
    const stationIds = Array.from(stationSet).sort()

    const chartData = dailyRows.map((row) => {
      const entry: Record<string, unknown> = {
        date: row.date,
        isSprinklerDay: row.isSprinklerDay,
        house: row.byStation["house"] ?? 0,
      }
      for (const sid of stationIds) {
        entry[sid] = row.byStation[sid] ?? 0
      }
      return entry
    })

    return { chartData, stationIds }
  }, [dailyRows])

  const formatDate = (d: string) => {
    const dt = new Date(d + "T12:00:00")
    return dt.toLocaleDateString(undefined, { month: "short", day: "numeric" })
  }

  const handleClick = (data: Record<string, unknown>) => {
    if (data?.isSprinklerDay) {
      router.push(`/day/${data.date}`)
    }
  }

  if (dailyRows.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-400">
        No data — go to Config to upload a CSV
      </div>
    )
  }

  return (
    <ResponsiveContainer width="100%" height={320}>
      <BarChart
        data={chartData}
        margin={{ top: 4, right: 8, left: 8, bottom: 4 }}
        onClick={(e) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const payload = (e as any)?.activePayload?.[0]?.payload
          if (payload) handleClick(payload)
        }}
        style={{ cursor: "pointer" }}
      >
        <XAxis
          dataKey="date"
          tickFormatter={formatDate}
          tick={{ fontSize: 11 }}
          interval="preserveStartEnd"
        />
        <YAxis tick={{ fontSize: 11 }} />
        <Tooltip
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          formatter={(value: any, name: any) => [`${Number(value).toFixed(1)} gal`, name]}
          labelFormatter={(label) => formatDate(label)}
        />
        <Legend wrapperStyle={{ fontSize: 11 }} />

        {/* House usage (non-sprinkler visual) */}
        <Bar dataKey="house" stackId="a" name="house" fill="#f97316">
          {chartData.map((entry, i) => (
            <Cell
              key={i}
              fill={(entry as Record<string, unknown>).isSprinklerDay ? "#cbd5e1" : "#f97316"}
            />
          ))}
        </Bar>

        {stationIds.map((sid, i) => (
          <Bar
            key={sid}
            dataKey={sid}
            stackId="a"
            name={sid}
            fill={STATION_COLORS[i % STATION_COLORS.length]}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  )
}
