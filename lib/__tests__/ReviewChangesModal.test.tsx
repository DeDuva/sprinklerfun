// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import "@testing-library/jest-dom/vitest"
import ReviewChangesModal, { type StagedItem } from "@/components/ReviewChangesModal"

// The last thing standing between a staged edit and a config write. Its whole
// promise is "nothing is saved until you confirm here", so what matters is that
// it shows every change, lets any of them be dropped, and calls onSave exactly
// once and only on purpose.

const items: StagedItem[] = [
  { key: "t1:A:T1-01:baseline", area: "T1 · Program A", field: "Front baseline gpm", fromText: "6.00", toText: "6.42" },
  { key: "t1:A:T1-02:duration", area: "T1 · Program A", field: "Back duration", fromText: "15m", toText: "17m" },
  {
    key: "timer2:stationDelay",
    area: "T2 · hardware",
    field: "Station delay",
    fromText: "0s",
    toText: "60s",
    note: "from 20 of 26 days · re-attributes stored rollups on save",
  },
]

const props = {
  open: true,
  windowDateLabel: "Jul 1, 2026",
  items,
  onRemove: () => {},
  onSave: () => {},
  onCancel: () => {},
}

describe("ReviewChangesModal", () => {
  it("renders nothing when closed", () => {
    const { container } = render(<ReviewChangesModal {...props} open={false} />)
    expect(container).toBeEmptyDOMElement()
    cleanup()
  })

  it("shows every staged change, grouped by area", () => {
    render(<ReviewChangesModal {...props} />)
    for (const it of items) {
      expect(screen.getByText(it.field)).toBeInTheDocument()
    }
    expect(screen.getByText("T1 · Program A")).toBeInTheDocument()
    expect(screen.getByText("T2 · hardware")).toBeInTheDocument()
    cleanup()
  })

  it("surfaces the note, including the warning that rollups get rewritten", () => {
    render(<ReviewChangesModal {...props} />)
    expect(screen.getByText(/re-attributes stored rollups on save/)).toBeInTheDocument()
    cleanup()
  })

  it("names the window being written to, so it is not a mystery target", () => {
    render(<ReviewChangesModal {...props} />)
    expect(screen.getByText(/Jul 1, 2026/)).toBeInTheDocument()
    cleanup()
  })

  it("removes an individual change by its key", async () => {
    const onRemove = vi.fn()
    render(<ReviewChangesModal {...props} onRemove={onRemove} />)
    const buttons = screen.getAllByRole("button")
    // The per-item remove controls; the save/cancel pair are the last two.
    await userEvent.click(buttons[0])
    expect(onRemove).toHaveBeenCalledOnce()
    expect(items.map((i) => i.key)).toContain(onRemove.mock.calls[0][0])
    cleanup()
  })

  it("saves only when the save control is used", async () => {
    const onSave = vi.fn()
    const onCancel = vi.fn()
    render(<ReviewChangesModal {...props} onSave={onSave} onCancel={onCancel} />)

    await userEvent.click(screen.getByRole("button", { name: /save/i }))
    expect(onSave).toHaveBeenCalledOnce()
    expect(onCancel).not.toHaveBeenCalled()
    cleanup()
  })

  it("cancels without saving", async () => {
    const onSave = vi.fn()
    const onCancel = vi.fn()
    render(<ReviewChangesModal {...props} onSave={onSave} onCancel={onCancel} />)

    await userEvent.click(screen.getByRole("button", { name: /cancel/i }))
    expect(onCancel).toHaveBeenCalled()
    expect(onSave).not.toHaveBeenCalled()
    cleanup()
  })
})
