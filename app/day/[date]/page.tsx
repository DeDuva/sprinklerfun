"use client"

import { use, useEffect, useMemo, useState } from "react"
import { useStore } from "@/lib/store"
import { enrichRows, activeWindowForDate, currentConfig } from "@/lib/analyze"
import { fetchDayRows } from "@/lib/backend"
import type { FlumeRow } from "@/lib/types"
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
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
import Link from "next/link"

const STATION_COLORS: Record<string, string> = {}
const PALETTE = [
  "#35A7E4","#4FB05A","#FFC24B","#FF6B5C","#8B6FD9",
  "#FF9F3E","#2FB8A6","#E85D75","#7BC96F","#5EA8D8",
]
let colorIdx = 0
function getColor(id: string) {
  if (!STATION_COLORS[id]) {
    STATION_COLORS[id] = PALETTE[colorIdx++ % PALETTE.length]
  }
  return STATION_COLORS[id]
}

export default function DayDetailPage({ params }: { params: Promise<{ date: string }> }) {
  const { date } = use(params)
  const windows       = useStore((s) => s.windows)
  const serverVersion = useStore((s) => s.serverVersion)

  // Billing comes from the config window active on this day.
  const dayConfig = useMemo(
    () => activeWindowForDate(windows, date)?.config ?? currentConfig(windows),
    [windows, date]
  )

  // Phase 3: fetch just this ONE day's raw rows and enrich them client-side,
  // instead of loading (and enriching) the entire per-minute series.
  const [dayRows, setDayRows] = useState<FlumeRow[] | null>(null)
  useEffect(() => {
    let cancelled = false
    fetchDayRows(date)
      .then((rows) => { if (!cancelled) setDayRows(rows) })
      .catch(() => { if (!cancelled) setDayRows([]) })
    return () => { cancelled = true }
  }, [date, serverVersion])

  const { chartData, stationIds, stationTotals, totalGallons } = useMemo(() => {
    if (!dayRows || dayRows.length === 0) return { chartData: [], stationIds: [], stationTotals: {}, totalGallons: 0 }

    const enriched = enrichRows(dayRows, dayConfig)
    const dayRowsEnriched = enriched.filter((r) => r.date === date)

    const stationSet = new Set<string>()
    for (const r of dayRowsEnriched) stationSet.add(r.station)
    const stationIds = Array.from(stationSet).sort()

    // Build minute-level chart data
    const minuteMap: Record<number, Record<string, number>> = {}
    for (const r of dayRowsEnriched) {
      if (!minuteMap[r.timeMin]) minuteMap[r.timeMin] = {}
      minuteMap[r.timeMin][r.station] = (minuteMap[r.timeMin][r.station] ?? 0) + r.gallons
    }

    const chartData = Object.entries(minuteMap)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([minStr, vals]) => {
        const min = Number(minStr)
        const h = Math.floor(min / 60).toString().padStart(2, "0")
        const m = (min % 60).toString().padStart(2, "0")
        return { time: `${h}:${m}`, ...vals }
      })

    const stationTotals: Record<string, number> = {}
    for (const r of dayRowsEnriched) {
      stationTotals[r.station] = (stationTotals[r.station] ?? 0) + r.gallons
    }
    const totalGallons = dayRowsEnriched.reduce((s, r) => s + r.gallons, 0)

    return { chartData, stationIds, stationTotals, totalGallons }
  }, [dayRows, dayConfig, date])

  const fmt = new Date(date + "T12:00:00").toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  })

  if (dayRows === null) {
    return <div className="text-center py-24 text-gray-400 animate-pulse">Loading…</div>
  }

  if (chartData.length === 0) {
    return (
      <div className="text-center py-24 text-gray-400">
        No data for {date}.{" "}
        <Link href="/" className="text-[#1B6FA8] underline">
          Back to dashboard
        </Link>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/" className="text-gray-400 hover:text-gray-600 text-sm">
          ← Dashboard
        </Link>
        <h1 className="text-2xl font-semibold text-[#143049]" style={{ fontFamily: "var(--font-fredoka)" }}>{fmt}</h1>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
        <div className="bg-white rounded-lg border p-3">
          <p className="text-gray-500">Total Gallons</p>
          <p className="text-xl font-bold">{totalGallons.toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
        </div>
        <div className="bg-white rounded-lg border p-3">
          <p className="text-gray-500">Sprinkler Gallons</p>
          <p className="text-xl font-bold text-[#1B6FA8]">
            {Object.entries(stationTotals)
              .filter(([k]) => k !== "house")
              .reduce((s, [, v]) => s + v, 0)
              .toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </p>
        </div>
        <div className="bg-white rounded-lg border p-3">
          <p className="text-gray-500">House Gallons</p>
          <p className="text-xl font-bold text-[#B9822F]">
            {(stationTotals["house"] ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </p>
        </div>
        <div className="bg-white rounded-lg border p-3">
          <p className="text-gray-500">Est. Cost (day)</p>
          <p className="text-xl font-bold text-[#2E7D4F]">
            ${((totalGallons / dayConfig.gallonsPerUnit) * dayConfig.costPerUnit).toFixed(2)}
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Minute-by-Minute Flow</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={320}>
            <AreaChart data={chartData} margin={{ left: 8, right: 8 }}>
              <XAxis dataKey="time" tick={{ fontSize: 10 }} interval={59} />
              <YAxis tick={{ fontSize: 11 }} />
              {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
              <Tooltip formatter={(v: any, n: any) => [`${Number(v).toFixed(3)} gal`, n]} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {stationIds.map((sid) => (
                <Area
                  key={sid}
                  type="monotone"
                  dataKey={sid}
                  stackId="1"
                  stroke={getColor(sid)}
                  fill={getColor(sid)}
                  fillOpacity={0.7}
                  name={sid}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Station Summary</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Station</TableHead>
                <TableHead>Total Gallons</TableHead>
                <TableHead>% of Day</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Object.entries(stationTotals)
                .sort(([, a], [, b]) => b - a)
                .map(([id, gal]) => (
                  <TableRow key={id}>
                    <TableCell className="font-medium">{id}</TableCell>
                    <TableCell>{gal.toLocaleString(undefined, { maximumFractionDigits: 1 })}</TableCell>
                    <TableCell>{totalGallons > 0 ? ((gal / totalGallons) * 100).toFixed(1) : 0}%</TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
