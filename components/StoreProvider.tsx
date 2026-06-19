"use client"

import { useEffect } from "react"
import Papa from "papaparse"
import { useStore } from "@/lib/store"
import { toWindows } from "@/lib/types"
import type { FlumeRow } from "@/lib/types"

export default function StoreProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    // 1. Rehydrate from localStorage (migration runs in migrate/onRehydrateStorage)
    useStore.persist.rehydrate()

    // 2. If this is a fresh install (no windows/rows yet), try to load the baked-in
    //    defaults from /default-config.json and /default-data.csv. Commit those files
    //    to your repo to pre-populate config and data on new installs.
    const afterRehydrate = () => {
      const state = useStore.getState()

      if (state.windows.length === 0) {
        fetch("/default-config.json")
          .then((r) => (r.ok ? r.json() : null))
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .then((bundle: any | null) => {
            if (!bundle) return
            const windows = toWindows({
              windows: bundle.windows,
              config: bundle.config,
              configHistory: bundle.configHistory,
            })
            if (windows.length > 0) useStore.setState({ windows })
          })
          .catch(() => {})
      }

      if (state.rows.length === 0) {
        fetch("/default-data.csv")
          .then((r) => (r.ok ? r.text() : null))
          .then((text) => {
            if (!text) return
            Papa.parse<Record<string, string>>(text, {
              header: true,
              skipEmptyLines: true,
              complete: (results) => {
                const rows: FlumeRow[] = []
                for (const row of results.data) {
                  const dt = row["datetime"] ?? row["Datetime"] ?? row["DateTime"]
                  const g = parseFloat(row["gallons"] ?? row["Gallons"] ?? "0")
                  if (dt && !isNaN(g)) rows.push({ datetime: dt.trim(), gallons: g })
                }
                if (rows.length > 0) useStore.getState().appendRows(rows)
              },
            })
          })
          .catch(() => {})
      }
    }

    // Give rehydrate a tick to complete before checking state
    setTimeout(afterRehydrate, 0)
  }, [])

  return <>{children}</>
}
