import { create } from "zustand"
import { persist, createJSONStorage } from "zustand/middleware"
import type { AppConfig, ConfigWindow, MaintenanceFlag, TimerConfig } from "./types"
import { DEFAULT_CONFIG, newId, sortWindows, toWindows } from "./types"
import { activeWindowForDate } from "./analyze"

interface AppState {
  // Config windows, sorted ascending by effectiveFrom. Window i is active for
  // [effectiveFrom_i, effectiveFrom_{i+1}); the earliest also covers earlier data.
  windows: ConfigWindow[]

  // Bumped whenever the server's data changes (upload, window edit, clear). The
  // pages key their rollup/stats/day fetches off this so a client-side write
  // (which resyncs the server) triggers a refetch of the server-derived views.
  // Phase 3: the per-minute row series is no longer held in the browser — the
  // dashboard/analysis read rollups + precomputed stats from the server, and
  // per-day views fetch a single day on demand.
  serverVersion: number

  // Cosmetic count of raw rows stored on the server (for status labels). Kept
  // out of persistence; hydrated from /api/stats and updated after writes.
  rowCount: number

  // Latest stored row date ("YYYY-MM-DD"), for the incremental Flume export link.
  lastRowDate: string | null

  // Stations flagged for physical maintenance, keyed by station id. Top-level
  // (not inside a ConfigWindow) because it describes the current hardware state,
  // independent of config history; surfaced on the dashboard and analysis tab.
  maintenance: Record<string, MaintenanceFlag>

  // Create a new window effective on `effectiveFrom`, cloning the config active
  // on that date (else the latest window, else DEFAULT_CONFIG). Returns its id.
  addWindowFromDate: (effectiveFrom: string, notes: string) => string
  // Edit a window in place. Changing effectiveFrom moves only this boundary and
  // re-sorts; it never creates a new window. Bumps updatedAt.
  updateWindow: (
    id: string,
    patch: { config?: AppConfig; notes?: string; effectiveFrom?: string }
  ) => void
  // Remove a window (boundaries of neighbours re-derive automatically). The last
  // remaining window cannot be deleted.
  deleteWindow: (id: string) => void
  // Apply this window's station baselines to every later window (re-measure case).
  copyBaselinesForward: (id: string) => void

  // Flag or clear a station for maintenance. Pass null to clear.
  setStationMaintenance: (stationId: string, flag: MaintenanceFlag | null) => void

  // Signal that the server's data changed → pages refetch their derived views.
  bumpServerVersion: () => void
  setRowCount: (n: number) => void
  setLastRowDate: (d: string | null) => void
}

const deepClone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      windows: [],
      serverVersion: 0,
      rowCount: 0,
      lastRowDate: null,
      maintenance: {},

      addWindowFromDate: (effectiveFrom, notes) => {
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
        set({ windows: sortWindows([...windows, win]) })
        return id
      },

      updateWindow: (id, patch) => {
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
        set({ windows })
      },

      deleteWindow: (id) => {
        const { windows } = get()
        if (windows.length <= 1) return
        set({ windows: windows.filter((w) => w.id !== id) })
      },

      copyBaselinesForward: (id) => {
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
            ? { ...w, config: { ...w.config, timer1: applyTimer(w.config.timer1), timer2: applyTimer(w.config.timer2) }, updatedAt: now }
            : w
        )
        set({ windows })
      },

      setStationMaintenance: (stationId, flag) => {
        const next = { ...get().maintenance }
        if (flag) next[stationId] = flag
        else delete next[stationId]
        set({ maintenance: next })
      },

      bumpServerVersion: () => set({ serverVersion: get().serverVersion + 1 }),

      setRowCount: (n) => set({ rowCount: n }),

      setLastRowDate: (d) => set({ lastRowDate: d }),
    }),
    {
      name: "sprinkler-store",
      version: 3,
      storage: createJSONStorage(() => {
        if (typeof window === "undefined") {
          return {
            getItem: () => null,
            setItem: () => {},
            removeItem: () => {},
          }
        }
        return localStorage
      }),
      skipHydration: true,
      // Persist only the small, client-owned state. `rows` (the per-minute
      // series) now lives in Turso and is hydrated into memory on load — keeping
      // it out of localStorage is what fixes the QuotaExceededError. Existing
      // users' large row blobs are harmlessly read on the next rehydrate and
      // then dropped the first time this partialized state is written back.
      partialize: (state) => ({ windows: state.windows, maintenance: state.maintenance }),
      // v1 persisted { config, configHistory, rows }; v2 persisted { windows, rows };
      // v3 persists { windows, maintenance } (rows moved to the server).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      migrate: (persisted: any, fromVersion: number) => {
        if (!persisted) return persisted
        if (fromVersion < 2) {
          return {
            windows: toWindows({ config: persisted.config, configHistory: persisted.configHistory }),
          }
        }
        return persisted
      },
      // Normalize + sort on every rehydration (also upgrades any legacy shape that
      // slips through, and fixes malformed times in already-saved windows).
      onRehydrateStorage: () => (state) => {
        if (!state) return
        state.windows = toWindows({
          windows: state.windows,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          config: (state as any).config,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          configHistory: (state as any).configHistory,
        })
      },
    }
  )
)
