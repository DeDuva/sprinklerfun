"use client"

import { useEffect } from "react"
import Papa from "papaparse"
import { useStore } from "@/lib/store"
import { toWindows } from "@/lib/types"
import type { FlumeRow } from "@/lib/types"
import { fetchAllRows, pushRows } from "@/lib/backend"

export default function StoreProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    // 1. Rehydrate the small client state (windows + maintenance) from localStorage.
    //    Migration runs in migrate/onRehydrateStorage.
    useStore.persist.rehydrate()

    const afterRehydrate = async () => {
      const state = useStore.getState()

      // 2. Fresh install: seed config windows from the baked-in defaults.
      if (state.windows.length === 0) {
        try {
          const bundle = await fetch("/default-config.json").then((r) => (r.ok ? r.json() : null))
          if (bundle) {
            const windows = toWindows({
              windows: bundle.windows,
              config: bundle.config,
              configHistory: bundle.configHistory,
            })
            if (windows.length > 0) useStore.setState({ windows })
          }
        } catch {
          /* no defaults bundled — fine */
        }
      }

      // 3. Rows now live on the server. Hydrate the in-memory store from it. This
      //    replaces the old localStorage-backed rows entirely.
      try {
        const rows = await fetchAllRows()
        if (rows.length > 0) {
          useStore.getState().setRows(rows)
          return
        }
      } catch {
        // Server unreachable (e.g. offline / DB not configured). Leave whatever
        // rows rehydrated from a legacy localStorage blob as a soft fallback.
        return
      }

      // 4. Server is empty. On a fresh install, seed it from the baked-in
      //    default-data.csv (if present) so the demo experience still works.
      try {
        const text = await fetch("/default-data.csv").then((r) => (r.ok ? r.text() : null))
        if (!text) return
        Papa.parse<Record<string, string>>(text, {
          header: true,
          skipEmptyLines: true,
          complete: async (results) => {
            const rows: FlumeRow[] = []
            for (const row of results.data) {
              const dt = row["datetime"] ?? row["Datetime"] ?? row["DateTime"]
              const g = parseFloat(row["gallons"] ?? row["Gallons"] ?? "0")
              if (dt && !isNaN(g)) rows.push({ datetime: dt.trim(), gallons: g })
            }
            if (rows.length === 0) return
            useStore.getState().setRows(rows)
            // Persist the seed to the server so it survives reloads.
            await pushRows(rows, useStore.getState().windows)
          },
        })
      } catch {
        /* no default data — fine */
      }
    }

    // Give rehydrate a tick to complete before checking state.
    setTimeout(afterRehydrate, 0)
  }, [])

  return <>{children}</>
}
