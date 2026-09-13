import { describe, it, expect } from "vitest"
import { meterAlerts, OFFLINE_AFTER_MS, STALE_CHECK_AFTER_MS } from "../meterHealth"
import type { FlumeDeviceStatus } from "../types"

// A dead sensor battery in September 2026 produced a day of stored zeros and no
// error anywhere. These thresholds are what turn the device record into a
// notice, so they are pinned here rather than trusted.

const checkedAt = "2026-09-13T21:42:00.000Z"
const now = new Date("2026-09-13T22:00:00.000Z")
const status = (over: Partial<FlumeDeviceStatus> = {}): FlumeDeviceStatus => ({
  deviceId: "d",
  name: "House",
  batteryLevel: "high",
  connected: true,
  lastSeen: "2026-09-13T21:40:00.000Z",
  checkedAt,
  ...over,
})
const minus = (iso: string, ms: number) => new Date(Date.parse(iso) - ms).toISOString()

describe("meterAlerts", () => {
  it("says nothing about a healthy, recently checked meter", () => {
    expect(meterAlerts(status(), now)).toEqual([])
  })

  it("says nothing before any sync has recorded a status", () => {
    expect(meterAlerts(null, now)).toEqual([])
  })

  it("calls the meter offline once its last contact is more than three hours before the check", () => {
    expect(meterAlerts(status({ lastSeen: minus(checkedAt, OFFLINE_AFTER_MS - 60_000) }), now)).toEqual([])
    const [alert] = meterAlerts(status({ lastSeen: minus(checkedAt, OFFLINE_AFTER_MS + 60_000) }), now)
    expect(alert).toMatchObject({ kind: "offline", level: "critical", disconnected: false })
  })

  it("measures silence against the check, not the viewer's clock", () => {
    // Viewed a week later, a meter that was fine when checked is not "offline" —
    // that staleness is its own, separate notice.
    const later = new Date(Date.parse(checkedAt) + 7 * 86_400_000)
    expect(meterAlerts(status(), later).map((a) => a.kind)).toEqual(["stale"])
  })

  it("calls the meter offline when Flume reports it disconnected, however recent its contact", () => {
    const [alert] = meterAlerts(status({ connected: false }), now)
    expect(alert).toMatchObject({ kind: "offline", disconnected: true })
  })

  it("folds the battery reading into the offline notice instead of adding a second one", () => {
    // The September case: dead battery, days of silence. One notice, naming the likely cause.
    const alerts = meterAlerts(
      status({ batteryLevel: "low", lastSeen: "2026-09-12T18:43:00.000Z" }),
      now
    )
    expect(alerts).toEqual([
      { kind: "offline", level: "critical", lastSeen: "2026-09-12T18:43:00.000Z", disconnected: false, batteryLevel: "low" },
    ])
  })

  it("warns about a low battery on a meter that is still reporting", () => {
    expect(meterAlerts(status({ batteryLevel: "low" }), now)).toEqual([
      { kind: "battery", level: "warning", batteryLevel: "low" },
    ])
    expect(meterAlerts(status({ batteryLevel: " LOW " }), now)[0]).toMatchObject({ kind: "battery" })
  })

  it("treats an empty or critical battery as critical", () => {
    expect(meterAlerts(status({ batteryLevel: "critical" }), now)[0]).toMatchObject({ kind: "battery", level: "critical" })
    expect(meterAlerts(status({ batteryLevel: "empty" }), now)[0]).toMatchObject({ level: "critical" })
  })

  it("ignores battery words it does not know rather than guessing", () => {
    expect(meterAlerts(status({ batteryLevel: "medium" }), now)).toEqual([])
    expect(meterAlerts(status({ batteryLevel: "42%" }), now)).toEqual([])
    expect(meterAlerts(status({ batteryLevel: null }), now)).toEqual([])
  })

  it("does not call a meter offline when Flume reports no last contact or connection", () => {
    expect(meterAlerts(status({ lastSeen: null, connected: null }), now)).toEqual([])
  })

  it("flags a status older than a day and a half, since syncs must be failing", () => {
    const stale = new Date(Date.parse(checkedAt) + STALE_CHECK_AFTER_MS + 60_000)
    expect(meterAlerts(status(), stale)).toEqual([{ kind: "stale", level: "warning", checkedAt }])
    const fresh = new Date(Date.parse(checkedAt) + STALE_CHECK_AFTER_MS - 60_000)
    expect(meterAlerts(status(), fresh)).toEqual([])
  })
})
