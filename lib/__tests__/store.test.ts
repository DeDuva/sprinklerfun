import { describe, it, expect, beforeEach } from "vitest"
import { useStore } from "../store"
import type { AppConfig } from "../types"

const s = () => useStore.getState()

describe("store: window actions", () => {
  beforeEach(() => useStore.setState({ windows: [] }))

  it("addWindowFromDate seeds from DEFAULT_CONFIG when empty and returns the id", () => {
    const id = s().addWindowFromDate("2024-01-01", "first")
    const ws = s().windows
    expect(ws.length).toBe(1)
    expect(ws[0].id).toBe(id)
    expect(ws[0].effectiveFrom).toBe("2024-01-01")
    expect(ws[0].notes).toBe("first")
  })

  it("addWindowFromDate clones (deep) the config active on the chosen date", () => {
    const a = s().addWindowFromDate("2024-01-01", "A")
    // tune window A so it differs from DEFAULT
    s().updateWindow(a, { config: { ...s().windows[0].config, sprinklerOnThreshold: 123 } })
    // a later window clones A's config
    s().addWindowFromDate("2024-03-01", "B")
    const wA = s().windows.find((w) => w.effectiveFrom === "2024-01-01")!
    const wB = s().windows.find((w) => w.effectiveFrom === "2024-03-01")!
    expect(wB.config.sprinklerOnThreshold).toBe(123)
    expect(wB.config).not.toBe(wA.config) // deep clone, not shared reference
  })

  it("updateWindow re-sorts when effectiveFrom changes", () => {
    s().addWindowFromDate("2024-01-01", "A")
    const b = s().addWindowFromDate("2024-02-01", "B")
    s().updateWindow(b, { effectiveFrom: "2023-12-01" }) // move B before A
    const ws = s().windows
    expect(ws.map((w) => w.effectiveFrom)).toEqual(["2023-12-01", "2024-01-01"])
    expect(ws[0].id).toBe(b)
  })

  it("updateWindow edits notes in place without moving the boundary", () => {
    const a = s().addWindowFromDate("2024-01-01", "A")
    const before = s().windows[0]
    s().updateWindow(a, { notes: "tuned" })
    const after = s().windows[0]
    expect(after.effectiveFrom).toBe(before.effectiveFrom)
    expect(after.notes).toBe("tuned")
  })

  it("deleteWindow removes a window but refuses to delete the last one", () => {
    const a = s().addWindowFromDate("2024-01-01", "A")
    const b = s().addWindowFromDate("2024-02-01", "B")
    s().deleteWindow(a)
    expect(s().windows.map((w) => w.id)).toEqual([b])
    s().deleteWindow(b)
    expect(s().windows.length).toBe(1) // last window kept
  })

  it("copyBaselinesForward applies baselines to later windows only", () => {
    const a = s().addWindowFromDate("2024-01-01", "A")
    const b = s().addWindowFromDate("2024-02-01", "B")
    const wA = s().windows.find((w) => w.id === a)!
    const firstId = wA.config.timer1.stations[0].id
    const cfg: AppConfig = JSON.parse(JSON.stringify(wA.config))
    cfg.timer1.stations[0] = { ...cfg.timer1.stations[0], baselineGpm: 9.9 }
    s().updateWindow(a, { config: cfg })

    s().copyBaselinesForward(a)
    const wB = s().windows.find((w) => w.id === b)!
    expect(wB.config.timer1.stations.find((st) => st.id === firstId)!.baselineGpm).toBe(9.9)
  })
})
