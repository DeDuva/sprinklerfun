"use client"

import { useDeferredValue, useMemo, useState } from "react"
import { useStore } from "@/lib/store"
import { deriveData, buildStationStats, currentConfig } from "@/lib/analyze"
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ErrorBar,
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
import type { StationStats } from "@/lib/types"

type SortKey = keyof StationStats

export default function AnalysisPage() {
  const rows          = useStore((s) => s.rows)
  const windows       = useStore((s) => s.windows)
  const rowsVersion   = useStore((s) => s.rowsVersion)
  const [sortKey, setSortKey] = useState<SortKey>("totalGallons")
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc")

  const deferredRows    = useDeferredValue(rows)
  const deferredWindows = useDeferredValue(windows)
  const deferredVersion = useDeferredValue(rowsVersion)

  const stats = useMemo(() => {
    if (deferredRows.length === 0) return []
    const { enriched } = deriveData(deferredRows, deferredWindows, deferredVersion)
    return buildStationStats(enriched, currentConfig(deferredWindows))
  }, [deferredRows, deferredWindows, deferredVersion])

  const sorted = useMemo(() => {
    return [...stats].sort((a, b) => {
      const av = a[sortKey] as number
      const bv = b[sortKey] as number
      return sortDir === "desc" ? bv - av : av - bv
    })
  }, [stats, sortKey, sortDir])

  const handleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"))
    } else {
      setSortKey(key)
      setSortDir("desc")
    }
  }

  const chartData = [...stats]
    .sort((a, b) => b.avgGpm - a.avgGpm)
    .map((s) => ({ name: s.name, gpm: +s.avgGpm.toFixed(3), err: +s.stdGpm.toFixed(3) }))

  if (rows.length === 0) {
    return (
      <div className="text-center py-24 text-gray-400">
        No data — upload a CSV to get started
      </div>
    )
  }

  const SortHeader = ({ k, label }: { k: SortKey; label: string }) => (
    <TableHead
      className="cursor-pointer select-none hover:text-blue-600"
      onClick={() => handleSort(k)}
    >
      {label} {sortKey === k ? (sortDir === "desc" ? "↓" : "↑") : ""}
    </TableHead>
  )

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Sprinkler Analysis</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Average Flow Rate (gal/min)</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={chartData} layout="vertical" margin={{ left: 16, right: 24 }}>
              <XAxis type="number" tick={{ fontSize: 11 }} />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={52} />
              {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
              <Tooltip formatter={(v: any) => [`${Number(v).toFixed(3)} gpm`]} />
              <Bar dataKey="gpm" fill="#3b82f6" name="avg gpm">
                <ErrorBar dataKey="err" width={4} strokeWidth={1} stroke="#1d4ed8" />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Per-Station Summary</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Station</TableHead>
                <SortHeader k="totalGallons" label="Total Gal" />
                <SortHeader k="avgGpm" label="Avg gpm" />
                <SortHeader k="stdGpm" label="Std gpm" />
                <SortHeader k="pctOfSprinkler" label="% Sprinkler" />
                <SortHeader k="costEstimate" label="Est. Cost" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{s.name}</TableCell>
                  <TableCell>{s.totalGallons.toLocaleString(undefined, { maximumFractionDigits: 0 })}</TableCell>
                  <TableCell>{s.avgGpm.toFixed(3)}</TableCell>
                  <TableCell>{s.stdGpm.toFixed(3)}</TableCell>
                  <TableCell>{(s.pctOfSprinkler * 100).toFixed(1)}%</TableCell>
                  <TableCell>${s.costEstimate.toFixed(2)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
