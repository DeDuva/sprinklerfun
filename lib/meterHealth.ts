import type { FlumeDeviceStatus } from "@/lib/types"

// ---------------------------------------------------------------------------
// Is the meter still reporting? Pure, so the dashboard and the Config page agree
// and the thresholds are tested rather than eyeballed.
//
// A Flume sensor that stops reporting produces no error anywhere. Flume answers
// queries for its silent minutes with zeros, the sync stores them, and the
// dashboard charts a household that stopped using water. That is exactly how a
// dead battery went unnoticed for a day in September 2026. The device record is
// the only place the truth shows up, so it is checked on every sync and turned
// into these alerts.
// ---------------------------------------------------------------------------

/**
 * How long since the sensor's last contact, as of the check, before it counts as
 * offline. A healthy sensor is in touch every few minutes; three hours rides out
 * a Wi-Fi blip without crying wolf.
 */
export const OFFLINE_AFTER_MS = 3 * 3_600_000

/**
 * How old the last check can be before the status itself is untrustworthy. The
 * cron runs daily, so anything past a day and a half means syncs are failing.
 */
export const STALE_CHECK_AFTER_MS = 36 * 3_600_000

export type MeterAlert =
  | { kind: "offline"; level: "critical"; lastSeen: string | null; disconnected: boolean; batteryLevel: string | null }
  | { kind: "battery"; level: "warning" | "critical"; batteryLevel: string }
  | { kind: "stale"; level: "warning"; checkedAt: string }

const LOW = new Set(["low"])
const EMPTY = new Set(["critical", "empty", "dead"])

export function meterAlerts(status: FlumeDeviceStatus | null, now: Date = new Date()): MeterAlert[] {
  if (!status) return []
  const alerts: MeterAlert[] = []
  const checkedAt = Date.parse(status.checkedAt)
  const lastSeen = status.lastSeen ? Date.parse(status.lastSeen) : NaN
  const battery = status.batteryLevel?.trim().toLowerCase() ?? null

  const silent = Number.isFinite(lastSeen) && Number.isFinite(checkedAt) && checkedAt - lastSeen > OFFLINE_AFTER_MS
  const disconnected = status.connected === false

  if (silent || disconnected) {
    // One notice, not two: when the meter is offline a low battery is the likely
    // reason, so it belongs in that notice rather than beside it.
    alerts.push({
      kind: "offline",
      level: "critical",
      lastSeen: status.lastSeen,
      disconnected,
      batteryLevel: status.batteryLevel,
    })
  } else if (battery && (LOW.has(battery) || EMPTY.has(battery))) {
    alerts.push({
      kind: "battery",
      level: EMPTY.has(battery) ? "critical" : "warning",
      batteryLevel: status.batteryLevel as string,
    })
  }

  if (Number.isFinite(checkedAt) && now.getTime() - checkedAt > STALE_CHECK_AFTER_MS) {
    alerts.push({ kind: "stale", level: "warning", checkedAt: status.checkedAt })
  }
  return alerts
}
