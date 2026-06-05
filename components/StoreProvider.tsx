"use client"

import { useEffect } from "react"
import { useStore } from "@/lib/store"
import type { AppConfig, ConfigVersion } from "@/lib/types"

interface ConfigBundle {
  version: 1
  config: AppConfig
  configHistory: ConfigVersion[]
}

export default function StoreProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    // 1. Rehydrate from localStorage
    useStore.persist.rehydrate()

    // 2. If this is a fresh install (no saved history), try to load the
    //    baked-in default from /default-config.json.
    //    Commit that file to your repo to pre-populate config on new installs.
    const afterRehydrate = () => {
      const state = useStore.getState()
      if (state.configHistory.length === 0) {
        fetch("/default-config.json")
          .then((r) => (r.ok ? r.json() : null))
          .then((bundle: ConfigBundle | null) => {
            if (!bundle || bundle.version !== 1 || !bundle.config) return
            useStore.setState({
              config: bundle.config,
              configHistory: bundle.configHistory ?? [],
            })
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
