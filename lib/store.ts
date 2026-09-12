import { create } from "zustand"
import type { AppConfig, ConfigWindow, MaintenanceFlag, TimerConfig } from "./types"
import { DEFAULT_CONFIG, newId, sortWindows } from "./types"
import { activeWindowForDate } from "./analyze"
import { saveConfig } from "./backend"

// ---------------------------------------------------------------------------
// The client's in-memory view of the server's configuration.
//
// This store used to be the source of truth, persisted to localStorage and
// mirrored to a Turso table that nothing ever read back. That arrangement is
// what broke the config: a fresh browser seeded itself from a stale bundled
// snapshot, and its first edit pushed that snapshot over the real timeline.
//
// Now the server owns the config and this holds a copy of it. Nothing here is
// persisted; `loaded` is false until StoreProvider has fetched, and every
// mutation goes through `commit`, which writes to the server and then adopts
// whatever the server says it stored. There is exactly one writer and exactly
// one copy.
//
// Actions are async and REJECT on failure, leaving state untouched. They do not
// toast: the store stays free of UI dependencies so it can be unit-tested
// without a DOM, and every call site already sits behind an explicit save
// button where an error belongs anyway.
// ---------------------------------------------------------------------------

interface ConfigDoc {
  windows: ConfigWindow[]
  maintenance: Record<string, MaintenanceFlag>
}

interface AppState extends ConfigDoc {
  // False until the first successful fetch. Pages gate on this rather than
  // rendering against an empty window list — an empty list is indistinguishable
  // from "no config yet", and acting on that mistake is what would overwrite a
  // real timeline with a brand-new one.
  loaded: boolean

  // Set when the initial fetch fails. Pages must show this rather than the
  // "no config yet" empty state: offering "create your first config" after a
  // transient read failure invites the user to replace their real config.
  loadError: string | null

  // Reported by GET /api/config so the UI knows whether a logout control makes
  // sense. Null until loaded.
  authMode: "open" | "enforced" | null

  // Bumped whenever the server's data changes, so pages refetch their
  // server-derived views (rollups, stats, day detail).
  serverVersion: number

  rowCount: number
  lastRowDate: string | null

  // Adopt a freshly fetched config document (StoreProvider, on mount).
  hydrate: (doc: ConfigDoc & { authMode: "open" | "enforced" }) => void
  setLoadError: (message: string) => void

  addWindowFromDate: (effectiveFrom: string, notes: string) => Promise<string>
  updateWindow: (
    id: string,
    patch: { config?: AppConfig; notes?: string; effectiveFrom?: string }
  ) => Promise<void>
  deleteWindow: (id: string) => Promise<void>
  copyBaselinesForward: (id: string) => Promise<void>
  setStationMaintenance: (stationId: string, flag: MaintenanceFlag | null) => Promise<void>
  // Whole-document replace, for config import.
  replaceAll: (windows: ConfigWindow[], maintenance: Record<string, MaintenanceFlag>) => Promise<void>

  bumpServerVersion: () => void
  setRowCount: (n: number) => void
  setLastRowDate: (d: string | null) => void
}

const deepClone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))

export const useStore = create<AppState>()((set, get) => {
  // The single write path. Saves to the server, then adopts the server's own
  // response rather than the optimistic local value — so what is on screen is
  // what is stored, including any normalisation the server applied. Throws on
  // failure without touching state.
  const commit = async (next: ConfigDoc): Promise<void> => {
    const saved = await saveConfig(next)
    set({
      windows: saved.windows,
      maintenance: saved.maintenance,
      serverVersion: get().serverVersion + 1,
    })
  }

  const doc = (): ConfigDoc => ({ windows: get().windows, maintenance: get().maintenance })

  return {
    windows: [],
    maintenance: {},
    loaded: false,
    loadError: null,
    authMode: null,
    serverVersion: 0,
    rowCount: 0,
    lastRowDate: null,

    hydrate: ({ windows, maintenance, authMode }) =>
      set({ windows, maintenance, authMode, loaded: true, loadError: null }),

    setLoadError: (message) => set({ loadError: message, loaded: false }),

    addWindowFromDate: async (effectiveFrom, notes) => {
      const { windows } = get()
      const base =
        activeWindowForDate(windows, effectiveFrom)?.config ??
        windows[windows.length - 1]?.config ??
        DEFAULT_CONFIG
      const now = new Date().toISOString()
      const id = newId()
      const win: ConfigWindow = {
        id,
        effectiveFrom,
        notes,
        config: deepClone(base),
        createdAt: now,
        updatedAt: now,
      }
      await commit({ ...doc(), windows: sortWindows([...windows, win]) })
      return id
    },

    updateWindow: async (id, patch) => {
      const now = new Date().toISOString()
      let windows = get().windows.map((w) =>
        w.id === id
          ? {
              ...w,
              ...(patch.config !== undefined ? { config: patch.config } : {}),
              ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
              ...(patch.effectiveFrom !== undefined ? { effectiveFrom: patch.effectiveFrom } : {}),
              updatedAt: now,
            }
          : w
      )
      if (patch.effectiveFrom !== undefined) windows = sortWindows(windows)
      await commit({ ...doc(), windows })
    },

    deleteWindow: async (id) => {
      const { windows } = get()
      // The earliest window also covers every row before it, so an empty
      // timeline leaves stored data unattributable. The server enforces this
      // too; refusing here just avoids a pointless round trip.
      if (windows.length <= 1) return
      await commit({ ...doc(), windows: windows.filter((w) => w.id !== id) })
    },

    copyBaselinesForward: async (id) => {
      const sorted = sortWindows(get().windows)
      const idx = sorted.findIndex((w) => w.id === id)
      if (idx < 0) return
      const src = sorted[idx]
      const baselineById = new Map<string, number | undefined>()
      for (const s of [...src.config.timer1.stations, ...src.config.timer2.stations]) {
        baselineById.set(s.id, s.baselineGpm)
      }
      const applyTimer = (t: TimerConfig): TimerConfig => ({
        ...t,
        stations: t.stations.map((s) =>
          baselineById.has(s.id) ? { ...s, baselineGpm: baselineById.get(s.id) } : s
        ),
      })
      const now = new Date().toISOString()
      const windows = sorted.map((w, i) =>
        i > idx
          ? {
              ...w,
              config: {
                ...w.config,
                timer1: applyTimer(w.config.timer1),
                timer2: applyTimer(w.config.timer2),
              },
              updatedAt: now,
            }
          : w
      )
      await commit({ ...doc(), windows })
    },

    setStationMaintenance: async (stationId, flag) => {
      const next = { ...get().maintenance }
      if (flag) next[stationId] = flag
      else delete next[stationId]
      await commit({ ...doc(), maintenance: next })
    },

    replaceAll: async (windows, maintenance) => {
      await commit({ windows, maintenance })
    },

    bumpServerVersion: () => set({ serverVersion: get().serverVersion + 1 }),

    setRowCount: (n) => set({ rowCount: n }),

    setLastRowDate: (d) => set({ lastRowDate: d }),
  }
})
