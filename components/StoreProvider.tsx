"use client"

import { useEffect } from "react"
import { useStore } from "@/lib/store"
import { fetchConfig, fetchStats } from "@/lib/backend"

// ---------------------------------------------------------------------------
// Load the server's config and row stats once, on mount.
//
// This used to be the most complicated file in the app: rehydrate localStorage,
// seed windows from a bundled default-config.json, seed rows from a bundled CSV
// in 20k-row batches, then subscribe to the store and debounce a fire-and-forget
// mirror of every window change back to a table nothing read. All of it existed
// to keep two copies of the config in step, and none of it succeeded — which is
// why the config kept coming back wrong on a second device.
//
// There is one copy now, so this is two fetches and nothing else. No seeding: a
// fresh install shows its empty state and the user creates a window, or runs
// `npm run seed:dev` locally.
// ---------------------------------------------------------------------------

export default function StoreProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    // The login page renders inside this layout but outside the session, so both
    // fetches would 401 and bounce the visitor back to where they already are.
    if (window.location.pathname === "/login") return

    let cancelled = false

    void (async () => {
      try {
        // Both are independent reads; there is no reason to serialise them.
        const [config, stats] = await Promise.all([fetchConfig(), fetchStats()])
        if (cancelled) return
        useStore.getState().hydrate(config)
        useStore.setState({ rowCount: stats.rowCount, lastRowDate: stats.lastDate })
      } catch (err) {
        if (cancelled) return
        // A 401 has already redirected to /login inside the fetch helpers, so
        // reaching here means something else went wrong. Record it instead of
        // leaving `loaded` false forever: the pages show the error, and
        // crucially do NOT show the "no config yet" empty state, which would
        // invite the user to create a window that replaces their real timeline.
        useStore.getState().setLoadError(err instanceof Error ? err.message : String(err))
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  return <>{children}</>
}
