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

export function buildFlumeExportUrl(lastDate: string | null): string {
  const tz = "-07:00"
  let since = "2026-05-01T00:00:00.000"
  if (lastDate) {
    // Start the export from the last stored day so only new data is fetched.
    since = `${lastDate}T00:00:00.000`
  }
  const now = new Date()
  const until = now.toISOString().replace("Z", "").slice(0, 23)
  return `https://portal.flumewater.com/dashboard?since=${since}${tz}&until=${until}${tz}&scale=hour`
}
