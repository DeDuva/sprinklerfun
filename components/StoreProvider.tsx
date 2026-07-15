"use client"

import { useEffect } from "react"
import Papa from "papaparse"
import { useStore } from "@/lib/store"
import { toWindows } from "@/lib/types"
import type { FlumeRow } from "@/lib/types"
import { fetchStats, pushRows, syncWindows } from "@/lib/backend"

export default function StoreProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    // 1. Rehydrate the small client state (windows + maintenance) from localStorage.
    //    Migration runs in migrate/onRehydrateStorage.
    useStore.persist.rehydrate()

    // Guards the windows→server sync (below) so it never fires during the initial
    // hydration/seed — only on genuine user edits after we've settled.
    let ready = false

    const refreshRowCount = async () => {
      try {
        const stats = await fetchStats()
        useStore.getState().setRowCount(stats.rowCount)
        useStore.getState().setLastRowDate(stats.lastDate)
      } catch {
        /* server unreachable — leave rowCount at 0 */
      }
    }

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

      // 3. Rows live entirely on the server now (Phase 3). The pages read
      //    rollups + precomputed stats + single days on demand — we no longer
      //    pull the full per-minute series into the browser. Hydrate only the
      //    lightweight row count for status labels.
      await refreshRowCount()

      // 4. Fresh-install demo seed: if the server has no rows yet, seed it from
      //    the baked-in default-data.csv (if present) so the demo works. The
      //    POST recomputes rollups + stats server-side; bump serverVersion so
      //    the pages fetch the freshly-derived data.
      if (useStore.getState().rowCount === 0) {
        try {
          const text = await fetch("/default-data.csv").then((r) => (r.ok ? r.text() : null))
          if (text) {
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
                const r = await pushRows(rows, useStore.getState().windows)
                if (r.ok) {
                  await refreshRowCount()
                  useStore.getState().bumpServerVersion()
                }
              },
            })
          }
        } catch {
          /* no default data — fine */
        }
      }

      ready = true
    }

    // Give rehydrate a tick to complete before checking state.
    setTimeout(afterRehydrate, 0)

    // 5. Windows are client-owned but the server computes rollups/stats from its
    //    own mirror of them, so every window edit must resync the server (else
    //    the dashboard's server-derived views go stale). Subscribe once and
    //    debounce; bump serverVersion after each successful resync so the pages
    //    refetch. Skipped until `ready` so it doesn't fire on the initial seed.
    let debounce: ReturnType<typeof setTimeout> | null = null
    const unsub = useStore.subscribe((s, prev) => {
      if (!ready || s.windows === prev.windows) return
      if (debounce) clearTimeout(debounce)
      const windows = s.windows
      debounce = setTimeout(async () => {
        const r = await syncWindows(windows)
        if (r.ok) useStore.getState().bumpServerVersion()
      }, 400)
    })

    return () => {
      unsub()
      if (debounce) clearTimeout(debounce)
    }
  }, [])

  return <>{children}</>
}
