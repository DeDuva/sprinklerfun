"use client"

import { useCallback, useEffect, useState } from "react"
import { fetchFlumeStatus } from "@/lib/backend"
import type { FlumeStatus } from "@/lib/types"

// Client hook for the non-secret Flume connection status. Used to hide the
// manual upload CTAs when the data source is the Flume API, and to drive the
// settings page. `status` is null until the first fetch resolves.
export function useFlumeStatus() {
  const [status, setStatus] = useState<FlumeStatus | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const s = await fetchFlumeStatus()
      setStatus(s)
      return s
    } catch {
      setStatus(null)
      return null
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    fetchFlumeStatus()
      .then((s) => { if (!cancelled) setStatus(s) })
      .catch(() => { if (!cancelled) setStatus(null) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  // Optimistic local update after connect/disconnect/toggle without a round-trip.
  const patch = useCallback((s: FlumeStatus) => setStatus(s), [])

  return { status, loading, refresh, patch }
}
