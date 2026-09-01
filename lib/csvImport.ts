import type { FlumeRow } from "@/lib/types"

export function parseFlumeCsvRows(data: Record<string, string>[]): FlumeRow[] {
  const rows: FlumeRow[] = []
  for (const row of data) {
    const dt = row["datetime"] ?? row["Datetime"] ?? row["DateTime"]
    const g = parseFloat(row["gallons"] ?? row["Gallons"] ?? "0")
    if (dt && !isNaN(g)) rows.push({ datetime: dt.trim(), gallons: g })
  }
  return rows
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0")

/** The local UTC offset for a given instant, as "+HH:MM" / "-HH:MM". */
function localOffset(d: Date): string {
  const mins = -d.getTimezoneOffset() // getTimezoneOffset is minutes WEST of UTC
  const sign = mins >= 0 ? "+" : "-"
  const abs = Math.abs(mins)
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

/** Local wall-clock time as "YYYY-MM-DDTHH:MM:SS.mmm" — no timezone conversion. */
function localWallClock(d: Date): string {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  )
}

/**
 * A Flume portal URL covering everything since the last stored day.
 *
 * The offsets are derived from the dates rather than hardcoded. The previous
 * version pinned "-07:00" and, worse, built `until` from `toISOString()` — a UTC
 * wall-clock labelled as Pacific time, so the requested window was off by seven
 * hours all year, not merely during standard time. Deriving each bound's offset
 * separately also means an export spanning a DST change gets both halves right.
 */
export function buildFlumeExportUrl(lastDate: string | null): string {
  // Anchored at noon so the offset lookup is never taken during a DST transition.
  const sinceDate = new Date((lastDate ?? "2026-05-01") + "T12:00:00")
  const since = `${lastDate ?? "2026-05-01"}T00:00:00.000${localOffset(sinceDate)}`

  const now = new Date()
  const until = `${localWallClock(now)}${localOffset(now)}`

  // Encoded, because an offset east of UTC starts with "+" and a bare "+" in a
  // query string decodes to a space — so an un-encoded "+14:00" would reach the
  // portal as " 14:00". The previous hardcoded "-07:00" hid this by never being
  // positive.
  const qs = new URLSearchParams({ since, until, scale: "hour" })
  return `https://portal.flumewater.com/dashboard?${qs}`
}
