import type { NextRequest } from "next/server"
import { readWindows, readRollups, readDayRows } from "@/lib/server/data"
import {
  activeWindowForDate,
  buildDaySchedule,
  buildDayMinuteSeries,
  currentConfig,
  enrichRows,
  inferStationDelay,
  recommendStationDelays,
} from "@/lib/analyze"
import type { DelayFit } from "@/lib/types"

// Reads the DB per request → Node runtime, uncached.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const DEFAULT_DAYS = 12
const MAX_DAYS = 40

// GET /api/delay?days=N — the inferred inter-station delay per timer.
//
// Server-side because a trustworthy estimate needs many days of per-minute flow
// and the browser deliberately holds one at a time (the Analysis page fetches a
// single day). Each day is fitted against the config window that was actually
// active on it, so a fit is never scored against settings that had not taken
// effect yet. Read-only, so no auth guard (Phase 1 convention).
export async function GET(req: NextRequest) {
  const raw = Number(req.nextUrl.searchParams.get("days"))
  const days = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), MAX_DAYS) : DEFAULT_DAYS

  try {
    const [windows, rollups] = await Promise.all([readWindows(), readRollups()])
    if (windows.length === 0) {
      return Response.json({ recommendations: [], daysExamined: [] })
    }

    // Most recent sprinkler days first — a delay is a property of the hardware
    // as it is set now, so old cycles are the least relevant evidence.
    const sprinklerDates = [...new Set(rollups.filter((r) => r.isSprinklerDay).map((r) => r.date))]
      .sort()
      .slice(-days)

    const fits: DelayFit[] = []
    for (const date of sprinklerDates) {
      const cfg = activeWindowForDate(windows, date)?.config ?? currentConfig(windows)
      const dow = (new Date(date + "T12:00:00").getDay() + 6) % 7
      const schedule = buildDaySchedule(cfg, dow)
      if (schedule.length === 0) continue
      const rows = await readDayRows(date)
      const enriched = enrichRows(rows, cfg)
      const series = buildDayMinuteSeries(enriched.filter((r) => r.date === date))
      fits.push(...inferStationDelay(series, schedule, date))
    }

    return Response.json({
      recommendations: recommendStationDelays(fits, currentConfig(windows)),
      daysExamined: sprinklerDates,
    })
  } catch (err) {
    console.error("[api/delay] failed:", err)
    return Response.json({ error: "server error" }, { status: 500 })
  }
}
