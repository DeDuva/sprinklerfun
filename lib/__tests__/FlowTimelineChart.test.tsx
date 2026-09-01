// @vitest-environment jsdom
import { describe, it, expect, beforeAll, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import FlowTimelineChart from "@/components/FlowTimelineChart"
import type { ExpectedSegment, MinutePoint, SegmentReconciliation } from "../types"

// Recharts measures its container, which jsdom reports as 0×0 and which needs a
// ResizeObserver that jsdom does not implement. The charts therefore render an
// empty SVG here — which is fine, because what these tests are about is the
// component's hook and state behaviour across prop changes, not its pixels.
beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

const seg = (id: string, startMin: number, durationMin: number, gpm: number): ExpectedSegment => ({
  stationId: id,
  name: id,
  timer: "timer1",
  programId: "A",
  startMin,
  endMin: startMin + durationMin,
  durationMin,
  baselineGpm: gpm,
})

const recon = (s: ExpectedSegment): SegmentReconciliation => ({
  stationId: s.stationId,
  name: s.name,
  timer: s.timer,
  programId: s.programId,
  cfgStartMin: s.startMin,
  cfgEndMin: s.endMin,
  cfgDurationMin: s.durationMin,
  baselineGpm: s.baselineGpm,
  actualStartMin: s.startMin,
  actualEndMin: s.endMin,
  actualDurationMin: s.durationMin,
  actualGpm: s.baselineGpm,
  startDriftMin: 0,
  durationDriftMin: 0,
  gpmDeltaPct: 0,
  gapBeforeMin: null,
  confidence: "high",
})

const schedule = [seg("T1-01", 360, 10, 6), seg("T1-02", 370, 10, 3)]
const recons = schedule.map(recon)

const series: MinutePoint[] = Array.from({ length: 60 }, (_, i) => ({
  timeMin: 350 + i,
  gpm: 350 + i > 360 && 350 + i <= 370 ? 6 : 350 + i > 370 && 350 + i <= 380 ? 3 : 0,
}))

const props = {
  series,
  schedule,
  recon: recons,
  selectedStation: null,
  onSelectStation: () => {},
}

describe("FlowTimelineChart", () => {
  it("renders a day that has flow", () => {
    const { container } = render(<FlowTimelineChart {...props} />)
    expect(container.textContent).toContain("actual gpm")
    cleanup()
  })

  it("renders the empty state for a day with no flow", () => {
    const { container } = render(<FlowTimelineChart {...props} series={[]} />)
    expect(container.textContent).toContain("No flow data for this day")
    cleanup()
  })

  it("survives switching from a day with flow to a day without", () => {
    // THE regression. The empty-series early return used to sit above two hooks
    // (stationGroups' useMemo and expandedGroups' useState), so a day with flow
    // rendered two more hooks than a day without. React cannot survive that
    // transition — and the Analysis tab crosses it constantly, because the ← →
    // day navigation steps straight from a watered day to a dry one.
    //
    // Before the fix this threw "Rendered fewer hooks than expected". It is
    // exactly the class of bug that never shows up at build time and only ever
    // appears as a crash under someone's hands.
    const { rerender, container } = render(<FlowTimelineChart {...props} />)
    expect(() => rerender(<FlowTimelineChart {...props} series={[]} />)).not.toThrow()
    expect(container.textContent).toContain("No flow data for this day")

    // And back again, which is the other half of the same navigation.
    expect(() => rerender(<FlowTimelineChart {...props} />)).not.toThrow()
    expect(container.textContent).toContain("actual gpm")
    cleanup()
  })

  it("survives the series changing length, which resets the brush zoom", () => {
    // The zoom is a range of indices into `data`, so it is meaningless once the
    // series changes. That reset happens during render — it used to write a ref
    // while rendering, which is unsound under concurrent rendering.
    const { rerender } = render(<FlowTimelineChart {...props} />)
    const shorter = series.slice(0, 30)
    expect(() => rerender(<FlowTimelineChart {...props} series={shorter} />)).not.toThrow()
    expect(() => rerender(<FlowTimelineChart {...props} />)).not.toThrow()
    cleanup()
  })

  it("does not warn about hook order or ref access across those transitions", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const { rerender } = render(<FlowTimelineChart {...props} />)
    rerender(<FlowTimelineChart {...props} series={[]} />)
    rerender(<FlowTimelineChart {...props} />)
    const messages = err.mock.calls.map((c) => String(c[0])).join("\n")
    expect(messages).not.toMatch(/hook/i)
    expect(messages).not.toMatch(/ref/i)
    err.mockRestore()
    cleanup()
  })
})
