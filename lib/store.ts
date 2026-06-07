import { create } from "zustand"
import { persist, createJSONStorage } from "zustand/middleware"
import type { AppConfig, ConfigVersion, FlumeRow } from "./types"
import { DEFAULT_CONFIG, migrateConfig } from "./types"

interface AppState {
  config: AppConfig
  configHistory: ConfigVersion[]
  rows: FlumeRow[]
  // Save config + push to history with notes
  saveConfig: (config: AppConfig, notes: string) => void
  // Restore a historical config version as current (without adding another history entry)
  restoreConfig: (version: ConfigVersion) => void
  appendRows: (newRows: FlumeRow[]) => void
  clearRows: () => void
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      config: DEFAULT_CONFIG,
      configHistory: [],
      rows: [],

      saveConfig: (config, notes) => {
        const version: ConfigVersion = {
          id: Date.now().toString(),
          savedAt: new Date().toISOString(),
          notes,
          config: JSON.parse(JSON.stringify(config)),
        }
        set({
          config,
          configHistory: [version, ...get().configHistory],
        })
      },

      restoreConfig: (version) => {
        set({ config: JSON.parse(JSON.stringify(version.config)) })
      },

      appendRows: (newRows) => {
        const existing = get().rows
        const existingSet = new Set(existing.map((r) => r.datetime))
        const merged = [
          ...existing,
          ...newRows.filter((r) => !existingSet.has(r.datetime)),
        ]
        merged.sort((a, b) => a.datetime.localeCompare(b.datetime))
        set({ rows: merged })
      },

      clearRows: () => set({ rows: [] }),
    }),
    {
      name: "sprinkler-store",
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
      // Run migration on every rehydration so old localStorage data is transparently upgraded.
      onRehydrateStorage: () => (state) => {
        if (!state) return
        state.config = migrateConfig(state.config)
        state.configHistory = state.configHistory.map((v) => ({
          ...v,
          config: migrateConfig(v.config),
        }))
      },
    }
  )
)
