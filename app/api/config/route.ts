import type { NextRequest } from "next/server"
import {
  readWindows,
  readMaintenance,
  replaceConfig,
  recomputeRollups,
  recomputeStats,
  rowDateBounds,
} from "@/lib/server/data"
import { isConfigWindow, isMaintenanceMap } from "@/lib/server/validate"
import { authMode } from "@/lib/server/session"
import type { ConfigPayload, ConfigWindow, MaintenanceFlag } from "@/lib/types"

// libSQL's node client uses native bindings — Node runtime, not edge.
//
// Route Handlers are not cached by default in this version of Next, so a GET
// here is already dynamic. `force-dynamic` says so out loud: this route reads
// the single source of truth for the app's configuration, and a cached answer
// would be a stale config presented as the current one — the exact failure this
// whole change exists to remove.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Authentication happens in proxy.ts before this handler runs. What is left here
// is validation, which is a different job: being logged in says nothing about
// the body being well formed, and this is now the ONLY copy of the config. A
// malformed window that gets stored is not a rejected request — it is a
// corrupted timeline with no second copy to restore from.

async function currentPayload(): Promise<ConfigPayload> {
  const [windows, maintenance] = await Promise.all([readWindows(), readMaintenance()])
  // The guard 503s a deployment in "refuse" mode before any handler runs, so a
  // caller that reached this line is on a deployment that is either open or
  // enforcing. Narrow rather than widen the wire type.
  return { windows, maintenance, authMode: authMode() === "open" ? "open" : "enforced" }
}

// GET /api/config → the whole config document.
export async function GET() {
  try {
    return Response.json(await currentPayload())
  } catch (err) {
    console.error("[api/config] GET failed:", err)
    return Response.json({ error: "server error" }, { status: 500 })
  }
}

// PUT /api/config
// Body: { windows: ConfigWindow[], maintenance: Record<string, MaintenanceFlag> }
//
// Whole-document replace, deliberately: the config is a few KB, it is edited as
// a unit, and a partial update of a contiguous timeline has no clear meaning.
export async function PUT(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 })
  }

  const rawWindows = (body as { windows?: unknown }).windows
  const rawMaintenance = (body as { maintenance?: unknown }).maintenance

  if (!Array.isArray(rawWindows)) {
    return Response.json({ error: "body.windows must be an array" }, { status: 400 })
  }

  // There is no legitimate "delete every window": the earliest window also
  // covers all data before it, so an empty timeline leaves every stored row
  // unattributable. POST /api/rows learned this the hard way — a body that read
  // as a no-op wiped the history — and the rule travels with the data, not with
  // the route that used to own it.
  if (rawWindows.length === 0) {
    return Response.json(
      { error: "body.windows must contain at least one window; the timeline cannot be emptied" },
      { status: 400 }
    )
  }

  const badWindow = rawWindows.findIndex((w) => !isConfigWindow(w))
  if (badWindow !== -1) {
    return Response.json(
      { error: `body.windows[${badWindow}] is not a valid config window` },
      { status: 400 }
    )
  }

  // Required, not defaulted. Treating an absent key as {} would mean a client
  // that forgot the field silently cleared every maintenance flag — a
  // destructive edit that looks like an omission.
  if (rawMaintenance === undefined || !isMaintenanceMap(rawMaintenance)) {
    return Response.json(
      { error: "body.maintenance must be an object of { [stationId]: { flaggedAt, note? } }" },
      { status: 400 }
    )
  }

  const windows = rawWindows as ConfigWindow[]
  const maintenance = rawMaintenance as Record<string, MaintenanceFlag>

  try {
    // One batch: the document is written whole or not at all.
    await replaceConfig({ windows, maintenance })

    // A window edit can change how ANY date is attributed — a boundary moving
    // re-assigns every row on either side of it — so the recompute spans the
    // full range of stored rows rather than a guessed subset.
    const bounds = await rowDateBounds()
    if (bounds) await recomputeRollups(bounds.min, bounds.max)
    await recomputeStats()

    // Return the stored document, not the submitted one: the response is what
    // the server actually holds, so the client's in-memory copy is set from the
    // database rather than from its own optimistic guess.
    return Response.json(await currentPayload())
  } catch (err) {
    console.error("[api/config] PUT failed:", err)
    return Response.json({ error: "server error" }, { status: 500 })
  }
}
