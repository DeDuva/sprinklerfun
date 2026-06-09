import { create } from "zustand"
import { persist, createJSONStorage } from "zustand/middleware"
import type { AppConfig, ConfigWindow, FlumeRow, TimerConfig } from "./types"
import { DEFAULT_CONFIG, newId, sortWindows, toWindows } from "./types"
import { activeWindowForDate } from "./analyze"

interface AppState {
  // Config windows, sorted ascending by effectiveFrom. Window i is active for
  // [effectiveFrom_i, effectiveFrom_{i+1}); the earliest also covers earlier data.
  windows: ConfigWindow[]
  rows: FlumeRow[]
  // Bumped whenever `rows` is replaced (upload / clear). Used as a cheap cache
  // key for the expensive enrichment so derived data is reused across renders
  // and page navigations until the data actually changes.
  rowsVersion: number

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

  appendRows: (newRows: FlumeRow[]) => void
  clearRows: () => void
}

const deepClone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      windows: [],
      rows: [],
      rowsVersion: 0,

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

      appendRows: (newRows) => {
        const existing = get().rows
        const existingSet = new Set(existing.map((r) => r.datetime))
        const merged = [
          ...existing,
          ...newRows.filter((r) => !existingSet.has(r.datetime)),
        ]
        merged.sort((a, b) => a.datetime.localeCompare(b.datetime))
        set({ rows: merged, rowsVersion: get().rowsVersion + 1 })
      },

      clearRows: () => set({ rows: [], rowsVersion: get().rowsVersion + 1 }),
    }),
    {
      name: "sprinkler-store",
      version: 2,
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
      // v1 persisted { config, configHistory, rows }; v2 persists { windows, rows }.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      migrate: (persisted: any, fromVersion: number) => {
        if (!persisted) return persisted
        if (fromVersion < 2) {
          return {
            windows: toWindows({ config: persisted.config, configHistory: persisted.configHistory }),
            rows: persisted.rows ?? [],
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
