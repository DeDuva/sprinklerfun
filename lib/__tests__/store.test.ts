import { describe, it, expect, beforeEach, vi } from "vitest"
import type { AppConfig, ConfigDocument, ConfigPayload } from "../types"

// Every mutating action now writes through PUT /api/config before it touches
// local state, so the store cannot be tested without deciding what the server
// says. saveConfig is mocked to echo the document back, which is what the real
// route does on success — the store adopts the server's copy, not its own.
//
// The echo also makes the failure test meaningful: when saveConfig rejects, the
// assertion is that state did NOT move, which is the whole contract of commit().
const saveConfig = vi.fn(
  async (doc: ConfigDocument): Promise<ConfigPayload> => ({ ...doc, authMode: "open" })
)

vi.mock("../backend", () => ({
  saveConfig: (doc: ConfigDocument) => saveConfig(doc),
}))

const { useStore } = await import("../store")

const s = () => useStore.getState()

describe("store: window actions", () => {
  beforeEach(() => {
    saveConfig.mockClear()
    saveConfig.mockImplementation(async (doc) => ({ ...doc, authMode: "open" }))
    useStore.setState({ windows: [], maintenance: {}, loaded: true, loadError: null, serverVersion: 0 })
  })

  it("addWindowFromDate seeds from DEFAULT_CONFIG when empty and returns the id", async () => {
    const id = await s().addWindowFromDate("2024-01-01", "first")
    const ws = s().windows
    expect(ws.length).toBe(1)
    expect(ws[0].id).toBe(id)
    expect(ws[0].effectiveFrom).toBe("2024-01-01")
    expect(ws[0].notes).toBe("first")
  })

  it("addWindowFromDate clones (deep) the config active on the chosen date", async () => {
    const a = await s().addWindowFromDate("2024-01-01", "A")
    // tune window A so it differs from DEFAULT
    await s().updateWindow(a, { config: { ...s().windows[0].config, sprinklerOnThreshold: 123 } })
    // a later window clones A's config
    await s().addWindowFromDate("2024-03-01", "B")
    const wA = s().windows.find((w) => w.effectiveFrom === "2024-01-01")!
    const wB = s().windows.find((w) => w.effectiveFrom === "2024-03-01")!
    expect(wB.config.sprinklerOnThreshold).toBe(123)
    expect(wB.config).not.toBe(wA.config) // deep clone, not shared reference
  })

  it("updateWindow re-sorts when effectiveFrom changes", async () => {
    await s().addWindowFromDate("2024-01-01", "A")
    const b = await s().addWindowFromDate("2024-02-01", "B")
    await s().updateWindow(b, { effectiveFrom: "2023-12-01" }) // move B before A
    const ws = s().windows
    expect(ws.map((w) => w.effectiveFrom)).toEqual(["2023-12-01", "2024-01-01"])
    expect(ws[0].id).toBe(b)
  })

  it("updateWindow edits notes in place without moving the boundary", async () => {
    const a = await s().addWindowFromDate("2024-01-01", "A")
    const before = s().windows[0]
    await s().updateWindow(a, { notes: "tuned" })
    const after = s().windows[0]
    expect(after.effectiveFrom).toBe(before.effectiveFrom)
    expect(after.notes).toBe("tuned")
  })

  it("deleteWindow removes a window but refuses to delete the last one", async () => {
    const a = await s().addWindowFromDate("2024-01-01", "A")
    const b = await s().addWindowFromDate("2024-02-01", "B")
    await s().deleteWindow(a)
    expect(s().windows.map((w) => w.id)).toEqual([b])

    // The last window is refused locally, without a round trip — the server
    // rejects it too, but there is no reason to ask.
    saveConfig.mockClear()
    await s().deleteWindow(b)
    expect(s().windows.length).toBe(1)
    expect(saveConfig).not.toHaveBeenCalled()
  })

  it("copyBaselinesForward applies baselines to later windows only", async () => {
    const a = await s().addWindowFromDate("2024-01-01", "A")
    const b = await s().addWindowFromDate("2024-02-01", "B")
    const wA = s().windows.find((w) => w.id === a)!
    const firstId = wA.config.timer1.stations[0].id
    const cfg: AppConfig = JSON.parse(JSON.stringify(wA.config))
    cfg.timer1.stations[0] = { ...cfg.timer1.stations[0], baselineGpm: 9.9 }
    await s().updateWindow(a, { config: cfg })

    await s().copyBaselinesForward(a)
    const wB = s().windows.find((w) => w.id === b)!
    expect(wB.config.timer1.stations.find((st) => st.id === firstId)!.baselineGpm).toBe(9.9)
  })
})

describe("store: maintenance flags", () => {
  beforeEach(() => {
    saveConfig.mockClear()
    saveConfig.mockImplementation(async (doc) => ({ ...doc, authMode: "open" }))
    useStore.setState({ windows: [], maintenance: {}, loaded: true, loadError: null, serverVersion: 0 })
  })

  it("sets and clears a flag, and sends the whole map each time", async () => {
    await s().setStationMaintenance("T1-01", { flaggedAt: "2026-01-01T00:00:00.000Z" })
    expect(s().maintenance["T1-01"]).toEqual({ flaggedAt: "2026-01-01T00:00:00.000Z" })

    await s().setStationMaintenance("T1-02", { flaggedAt: "2026-01-02T00:00:00.000Z" })
    expect(Object.keys(s().maintenance).sort()).toEqual(["T1-01", "T1-02"])

    await s().setStationMaintenance("T1-01", null)
    expect(s().maintenance["T1-01"]).toBeUndefined()
    expect(saveConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({ maintenance: { "T1-02": { flaggedAt: "2026-01-02T00:00:00.000Z" } } })
    )
  })
})

describe("store: the write path", () => {
  beforeEach(() => {
    saveConfig.mockClear()
    saveConfig.mockImplementation(async (doc) => ({ ...doc, authMode: "open" }))
    useStore.setState({ windows: [], maintenance: {}, loaded: true, loadError: null, serverVersion: 0 })
  })

  it("adopts what the server returns, not what was sent", async () => {
    // The server normalises; the store must show the stored truth rather than
    // its own optimistic value, or the two drift apart again — which is the bug
    // this whole change exists to remove.
    saveConfig.mockImplementation(async (doc) => ({
      windows: doc.windows.map((w) => ({ ...w, notes: "normalised by the server" })),
      maintenance: doc.maintenance,
      authMode: "open",
    }))
    await s().addWindowFromDate("2024-01-01", "what the client typed")
    expect(s().windows[0].notes).toBe("normalised by the server")
  })

  it("leaves state untouched when the save fails", async () => {
    await s().addWindowFromDate("2024-01-01", "A")
    const before = s().windows

    saveConfig.mockRejectedValueOnce(new Error("server error"))
    await expect(s().addWindowFromDate("2024-06-01", "doomed")).rejects.toThrow("server error")

    // No optimistic write survived the failure: one window, the original one.
    expect(s().windows).toBe(before)
    expect(s().windows.map((w) => w.effectiveFrom)).toEqual(["2024-01-01"])
  })

  it("bumps serverVersion on each successful write so pages refetch", async () => {
    const v0 = s().serverVersion
    await s().addWindowFromDate("2024-01-01", "A")
    expect(s().serverVersion).toBe(v0 + 1)
    await s().updateWindow(s().windows[0].id, { notes: "again" })
    expect(s().serverVersion).toBe(v0 + 2)
  })
})
