"use client"

import { useMemo, useState } from "react"
import { cn } from "@/lib/utils"

interface Props {
  sprinklerDates: string[]
  selected: string | null
  onSelect: (date: string) => void
}

const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"]

function monthLabel(year: number, month: number) {
  return new Date(year, month, 1).toLocaleDateString(undefined, { month: "short", year: "numeric" })
}

function pad2(n: number) { return String(n).padStart(2, "0") }

function toKey(y: number, m: number, d: number) {
  return `${y}-${pad2(m + 1)}-${pad2(d)}`
}

export default function DayPicker({ sprinklerDates, selected, onSelect }: Props) {
  const dateSet = useMemo(() => new Set(sprinklerDates), [sprinklerDates])

  const initMonth = useMemo(() => {
    const d = selected ?? sprinklerDates[sprinklerDates.length - 1]
    if (!d) return { year: new Date().getFullYear(), month: new Date().getMonth() }
    const [y, m] = d.split("-").map(Number)
    return { year: y, month: m - 1 }
  }, [selected, sprinklerDates])

  const [viewYear, setViewYear] = useState(initMonth.year)
  const [viewMonth, setViewMonth] = useState(initMonth.month)
  const [open, setOpen] = useState(false)

  const prev = () => {
    if (viewMonth === 0) { setViewYear(viewYear - 1); setViewMonth(11) }
    else setViewMonth(viewMonth - 1)
  }
  const next = () => {
    if (viewMonth === 11) { setViewYear(viewYear + 1); setViewMonth(0) }
    else setViewMonth(viewMonth + 1)
  }

  const days = useMemo(() => {
    const first = new Date(viewYear, viewMonth, 1)
    const startDow = (first.getDay() + 6) % 7
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate()
    const cells: Array<{ day: number; key: string } | null> = []
    for (let i = 0; i < startDow; i++) cells.push(null)
    for (let d = 1; d <= daysInMonth; d++) cells.push({ day: d, key: toKey(viewYear, viewMonth, d) })
    return cells
  }, [viewYear, viewMonth])

  const fmtSelected = selected
    ? new Date(selected + "T12:00:00").toLocaleDateString(undefined, {
        weekday: "short", month: "short", day: "numeric", year: "numeric",
      })
    : "—"

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="text-sm font-medium text-gray-700 min-w-[160px] text-center bg-white border rounded px-2 py-0.5 cursor-pointer hover:border-gray-400 transition-colors"
      >
        {fmtSelected}
        <span className="ml-1 text-gray-400 text-xs">▾</span>
      </button>

      {open && (
        <div className="absolute top-full mt-1 right-0 z-50 bg-white border border-gray-200 rounded-lg shadow-lg p-3 w-[260px]">
          <div className="flex items-center justify-between mb-2">
            <button onClick={prev} className="text-gray-400 hover:text-gray-700 px-1">←</button>
            <span className="text-sm font-medium text-gray-700">{monthLabel(viewYear, viewMonth)}</span>
            <button onClick={next} className="text-gray-400 hover:text-gray-700 px-1">→</button>
          </div>

          <div className="grid grid-cols-7 gap-0.5 text-center">
            {WEEKDAYS.map((w, i) => (
              <div key={i} className="text-[10px] font-medium text-gray-400 py-0.5">{w}</div>
            ))}
            {days.map((cell, i) => {
              if (!cell) return <div key={`e-${i}`} />
              const isSprinkler = dateSet.has(cell.key)
              const isSel = cell.key === selected
              return (
                <button
                  key={cell.key}
                  disabled={!isSprinkler}
                  onClick={() => { onSelect(cell.key); setOpen(false) }}
                  className={cn(
                    "text-xs rounded-full w-7 h-7 flex items-center justify-center transition-colors",
                    isSel
                      ? "bg-blue-600 text-white"
                      : isSprinkler
                      ? "text-gray-800 hover:bg-blue-100 font-medium"
                      : "text-gray-300 cursor-default"
                  )}
                >
                  {cell.day}
                  {isSprinkler && !isSel && (
                    <span className="absolute mt-5 w-1 h-1 rounded-full bg-blue-400" />
                  )}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
