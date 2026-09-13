// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import MeterAlerts, { MeterStatusLine, timeAgo } from "@/components/MeterAlerts"
import type { FlumeDeviceStatus } from "../types"

afterEach(cleanup)

const now = new Date("2026-09-13T22:00:00.000Z")
const status = (over: Partial<FlumeDeviceStatus> = {}): FlumeDeviceStatus => ({
  deviceId: "d",
  name: "House",
  batteryLevel: "high",
  connected: true,
  lastSeen: "2026-09-13T21:50:00.000Z",
  checkedAt: "2026-09-13T21:55:00.000Z",
  ...over,
})

describe("MeterAlerts", () => {
  it("renders nothing for a healthy meter", () => {
    const { container } = render(<MeterAlerts status={status()} now={now} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders an offline meter as an alert that says the zeros are not real", () => {
    render(<MeterAlerts status={status({ batteryLevel: "low", lastSeen: "2026-09-12T18:43:00.000Z" })} now={now} />)
    const alert = screen.getByRole("alert")
    expect(alert).toHaveTextContent(/Flume meter is offline/)
    expect(alert).toHaveTextContent(/not being recorded/)
    expect(alert).toHaveTextContent(/Last battery reading: low/)
    expect(alert).toHaveTextContent(/27 hours ago/)
  })

  it("renders a low battery as a status notice, not an alarm", () => {
    render(<MeterAlerts status={status({ batteryLevel: "low" })} now={now} />)
    expect(screen.queryByRole("alert")).toBeNull()
    expect(screen.getByRole("status")).toHaveTextContent(/battery is low/)
  })
})

describe("MeterStatusLine", () => {
  it("summarises the reading and when it was taken", () => {
    render(<MeterStatusLine status={status({ batteryLevel: "medium" })} now={now} />)
    expect(screen.getByText(/House: Battery medium · connected · last contact/)).toBeInTheDocument()
    expect(screen.getByText(/checked 5 minutes ago/)).toBeInTheDocument()
  })

  it("explains the empty state before any sync", () => {
    render(<MeterStatusLine status={null} now={now} />)
    expect(screen.getByText(/after the first sync/)).toBeInTheDocument()
  })
})

describe("timeAgo", () => {
  it("reads naturally at each scale", () => {
    expect(timeAgo("2026-09-13T21:59:40.000Z", now)).toBe("just now")
    expect(timeAgo("2026-09-13T21:59:00.000Z", now)).toBe("1 minute ago")
    expect(timeAgo("2026-09-13T19:00:00.000Z", now)).toBe("3 hours ago")
    expect(timeAgo("2026-09-10T22:00:00.000Z", now)).toBe("3 days ago")
    expect(timeAgo("not a date", now)).toBe("at an unknown time")
  })
})
