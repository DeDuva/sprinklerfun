import type { ConfigWindow, MaintenanceFlag } from "@/lib/types"

// ---------------------------------------------------------------------------
// Shape validation for anything that arrives over the wire.
//
// This is not authentication — proxy.ts does that before a handler runs. It is
// blast-radius reduction: the caller being logged in says nothing about the body
// being well formed, and this config is now the only copy there is. A malformed
// window that gets stored is not a rejected request, it is a corrupted timeline.
//
// isConfigWindow used to live inside app/api/rows/route.ts, where it guarded the
// only writer. Config writes now have their own route, so the check moved here
// rather than being duplicated — one definition, two callers.
// ---------------------------------------------------------------------------

export function isConfigWindow(v: unknown): v is ConfigWindow {
  if (typeof v !== "object" || v === null) return false
  const w = v as ConfigWindow
  return (
    typeof w.id === "string" && w.id.length > 0 &&
    typeof w.effectiveFrom === "string" && /^\d{4}-\d{2}-\d{2}$/.test(w.effectiveFrom) &&
    typeof w.createdAt === "string" &&
    typeof w.updatedAt === "string" &&
    typeof w.config === "object" && w.config !== null
  )
}

// A maintenance map: { [stationId]: { flaggedAt, note? } }. Rejects the whole
// map on one bad entry rather than silently dropping it — a flag that vanishes
// on save is worse than a save that fails loudly.
export function isMaintenanceMap(v: unknown): v is Record<string, MaintenanceFlag> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false
  for (const [stationId, flag] of Object.entries(v)) {
    if (stationId.length === 0) return false
    if (typeof flag !== "object" || flag === null) return false
    const f = flag as MaintenanceFlag
    if (typeof f.flaggedAt !== "string" || f.flaggedAt.length === 0) return false
    if (f.note !== undefined && typeof f.note !== "string") return false
  }
  return true
}
