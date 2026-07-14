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
  "#35A7E4","#4FB05A","#FFC24B","#FF6B5C","#8B6FD9",
  "#FF9F3E","#2FB8A6","#E85D75","#7BC96F","#5EA8D8",
  "#C77DD9","#F2A65A","#4A90D9","#3EC1A3","#D9754F",
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
        <Bar dataKey="house" stackId="a" name="house" fill="#E3A857">
          {chartData.map((entry, i) => (
            <Cell
              key={i}
              fill={(entry as Record<string, unknown>).isSprinklerDay ? "#E3D6B8" : "#E3A857"}
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
