import { readDeviceStatus } from "@/lib/server/flumeState"

// Reads the DB per request → Node runtime, uncached.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// GET /api/flume — the water sensor's health as of the last sync: battery,
// connection, last contact. The dashboard and Config page turn it into alerts
// (lib/meterHealth.ts).
//
// It reads what the last sync recorded rather than asking Flume live. A live
// check would need a token refresh, and Flume rotates the token on every
// refresh: two page loads racing each other could leave the stored token spent
// and break the sync. Sync now refreshes this record on demand instead.
//
// Behind the session guard like every other read (proxy.ts).
export async function GET() {
  try {
    return Response.json({ status: await readDeviceStatus() })
  } catch (err) {
    console.error("[api/flume] failed:", err)
    return Response.json({ error: "server error" }, { status: 500 })
  }
}
