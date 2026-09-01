// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import "@testing-library/jest-dom/vitest"
import StationDelayCard from "@/components/StationDelayCard"
import type { DelayRecommendation } from "../types"

// This card's own header comment states a correctness requirement: showing only
// the delay "invites the residual to be corrected by inflating run times, which
// over-waters". That is a claim about what the UI must not hide, and it is worth
// a test rather than a comment.

const rec = (over: Partial<DelayRecommendation> = {}): DelayRecommendation => ({
  timer: "timer2",
  delaySec: 60,
  configuredSec: 0,
  daysFit: 20,
  daysTotal: 26,
  minSec: 60,
  maxSec: 60,
  medianElongationMin: 16,
  medianExplainedMin: 10,
  medianResidualMin: 6,
  reason: "Also running about 6 min long per cycle beyond the delay.",
  ...over,
})

const noDelay = rec({
  timer: "timer1",
  delaySec: null,
  medianElongationMin: 1,
  medianExplainedMin: null,
  medianResidualMin: null,
  reason: "No inter-station delay detected — stations run back to back.",
})

const noop = () => {}

describe("StationDelayCard", () => {
  it("shows a skeleton while the fit is loading", () => {
    const { container } = render(
      <StationDelayCard recommendations={null} loading isStaged={() => false} onToggle={noop} />
    )
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0)
    cleanup()
  })

  it("shows the delay AND the leftover duration drift, never just the delay", () => {
    render(
      <StationDelayCard
        recommendations={[rec()]}
        loading={false}
        isStaged={() => false}
        onToggle={noop}
      />
    )
    expect(screen.getByText("60s")).toBeInTheDocument()
    expect(screen.getByText("16 min")).toBeInTheDocument() // overrun
    expect(screen.getByText("10 min")).toBeInTheDocument() // explained by delay
    expect(screen.getByText("6 min")).toBeInTheDocument() // residual duration drift
    cleanup()
  })

  it("warns to fix the delay before trusting the reconciliation below", () => {
    render(
      <StationDelayCard
        recommendations={[rec()]}
        loading={false}
        isStaged={() => false}
        onToggle={noop}
      />
    )
    expect(screen.getByText(/Fix the delay first/i)).toBeInTheDocument()
    cleanup()
  })

  it("says so plainly when there is no delay, instead of proposing 0s", () => {
    render(
      <StationDelayCard
        recommendations={[noDelay]}
        loading={false}
        isStaged={() => false}
        onToggle={noop}
      />
    )
    expect(screen.getByText("—")).toBeInTheDocument()
    expect(screen.getByText(/No inter-station delay detected/)).toBeInTheDocument()
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
    cleanup()
  })

  it("offers no proposal when the config already matches", () => {
    render(
      <StationDelayCard
        recommendations={[rec({ configuredSec: 60 })]}
        loading={false}
        isStaged={() => false}
        onToggle={noop}
      />
    )
    expect(screen.getByText(/Config already matches/i)).toBeInTheDocument()
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
    cleanup()
  })

  it("proposes the change, and reflects that it is staged", async () => {
    const onToggle = vi.fn()
    const { rerender } = render(
      <StationDelayCard
        recommendations={[rec()]}
        loading={false}
        isStaged={() => false}
        onToggle={onToggle}
      />
    )
    await userEvent.click(screen.getByRole("button", { name: /Propose 0s → 60s/ }))
    expect(onToggle).toHaveBeenCalledOnce()
    expect(onToggle.mock.calls[0][0].timer).toBe("timer2")

    rerender(
      <StationDelayCard
        recommendations={[rec()]}
        loading={false}
        isStaged={() => true}
        onToggle={onToggle}
      />
    )
    expect(screen.getByRole("button", { name: /review to save/i })).toBeInTheDocument()
    cleanup()
  })

  it("renders both timers independently", () => {
    render(
      <StationDelayCard
        recommendations={[noDelay, rec()]}
        loading={false}
        isStaged={() => false}
        onToggle={noop}
      />
    )
    expect(screen.getByText("Timer 1")).toBeInTheDocument()
    expect(screen.getByText("Timer 2")).toBeInTheDocument()
    // Only the timer with a delay offers a proposal.
    expect(screen.getAllByRole("button")).toHaveLength(1)
    cleanup()
  })
})
