"use client"

import Link from "next/link"
import type { FlumeDeviceStatus } from "@/lib/types"
import { meterAlerts, type MeterAlert } from "@/lib/meterHealth"

// Notices about the Flume sensor itself — offline, battery low, status gone
// stale. Shown on the dashboard and on Config's Flume sync card. They matter
// because a silent meter looks like zero usage everywhere else in the app.

export function timeAgo(iso: string, now: Date = new Date()): string {
  const ms = now.getTime() - Date.parse(iso)
  if (!Number.isFinite(ms)) return "at an unknown time"
  const min = Math.round(ms / 60_000)
  if (min < 1) return "just now"
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`
  const hr = Math.round(min / 60)
  if (hr < 48) return `${hr} hour${hr === 1 ? "" : "s"} ago`
  const d = Math.round(hr / 24)
  return `${d} days ago`
}

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  })
}

function Notice({ alert, now }: { alert: MeterAlert; now: Date }) {
  if (alert.kind === "offline") {
    return (
      <div role="alert" className="rounded-xl border-2 border-[#FF6B5C] bg-[#FFEFEC] px-4 py-3">
        <p className="text-sm font-semibold text-[#B33B2E]">⛔ Your Flume meter is offline</p>
        <p className="text-sm text-[#B33B2E] mt-0.5">
          {alert.lastSeen
            ? <>No readings since {when(alert.lastSeen)} ({timeAgo(alert.lastSeen, now)}).</>
            : <>Flume reports the sensor as disconnected.</>}
          {" "}Water used since then is not being recorded, so charts show it as zero until the meter reports again.
        </p>
        <p className="text-xs text-[#C9584A] mt-1">
          {alert.batteryLevel
            ? <>Last battery reading: <b>{alert.batteryLevel}</b>. A dead sensor battery is the usual cause; </>
            : <>Check the sensor battery first; </>}
          also make sure the Flume bridge is plugged in and on Wi-Fi. Once it reports again, the next sync fills in the last three days on its own.
        </p>
      </div>
    )
  }
  if (alert.kind === "battery") {
    const empty = alert.level === "critical"
    return (
      <div
        role={empty ? "alert" : "status"}
        className={empty
          ? "rounded-xl border-2 border-[#FF6B5C] bg-[#FFEFEC] px-4 py-3"
          : "rounded-xl border-2 border-[#FFC24B]/60 bg-[#FFF6E2] px-4 py-3"}
      >
        <p className={`text-sm font-semibold ${empty ? "text-[#B33B2E]" : "text-[#8A5A12]"}`}>
          🔋 Flume sensor battery is {empty ? "empty" : "low"}
        </p>
        <p className={`text-xs mt-0.5 ${empty ? "text-[#C9584A]" : "text-[#A5731F]"}`}>
          Replace it soon. When it dies the meter stops reporting, and water use goes unrecorded until it is replaced.
        </p>
      </div>
    )
  }
  return (
    <div role="status" className="rounded-xl border-2 border-[#FFC24B]/60 bg-[#FFF6E2] px-4 py-3">
      <p className="text-sm font-semibold text-[#8A5A12]">Meter status last checked {timeAgo(alert.checkedAt, now)}</p>
      <p className="text-xs text-[#A5731F] mt-0.5">
        The daily sync may be failing, so the meter could be offline without this page knowing. See{" "}
        <Link href="/config" className="underline">Config → Flume sync</Link>.
      </p>
    </div>
  )
}

export default function MeterAlerts({ status, now = new Date() }: { status: FlumeDeviceStatus | null; now?: Date }) {
  const alerts = meterAlerts(status, now)
  if (alerts.length === 0) return null
  return (
    <div className="space-y-2">
      {alerts.map((a) => <Notice key={a.kind} alert={a} now={now} />)}
    </div>
  )
}

/** One line of plain status for the Config page, whatever the alerts say. */
export function MeterStatusLine({ status, now = new Date() }: { status: FlumeDeviceStatus | null; now?: Date }) {
  if (!status) {
    return <p className="text-xs text-gray-400">Meter status appears after the first sync.</p>
  }
  const parts = [
    `Battery ${status.batteryLevel ?? "unknown"}`,
    status.connected === null ? null : status.connected ? "connected" : "disconnected",
    status.lastSeen ? `last contact ${when(status.lastSeen)}` : null,
  ].filter(Boolean)
  return (
    <p className="text-xs text-gray-500">
      {status.name}: {parts.join(" · ")}
      <span className="text-gray-400"> (checked {timeAgo(status.checkedAt, now)})</span>
    </p>
  )
}
