"use client"

import { useEffect } from "react"
import { useStore } from "@/lib/store"
import { toWindows } from "@/lib/types"

export default function StoreProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    // 1. Rehydrate from localStorage (migration runs in migrate/onRehydrateStorage)
    useStore.persist.rehydrate()

    // 2. If this is a fresh install (no windows yet), try to load the baked-in
    //    default from /default-config.json. Commit that file to your repo to
    //    pre-populate config on new installs. Accepts the new ({ windows }) or
    //    legacy ({ config, configHistory }) bundle shape.
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
          .catch(() => {
            // No default-config.json — that's fine, just use built-in defaults
          })
      }
    }

    // Give rehydrate a tick to complete before checking state
    setTimeout(afterRehydrate, 0)
  }, [])

  return <>{children}</>
}
