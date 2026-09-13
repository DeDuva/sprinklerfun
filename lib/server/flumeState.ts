import { getDb, ensureSchema } from "@/lib/db"
import type { FlumeDeviceStatus } from "@/lib/types"

// ---------------------------------------------------------------------------
// The one piece of Flume state that has to persist: the current refresh token.
//
// Your Flume ACCOUNT PASSWORD is never stored, anywhere. It is used exactly
// once, on your own machine, by `npm run flume:connect`, to mint a refresh
// token — and that token is what the deployment holds. A refresh token is the
// better thing to keep: it is scoped to API access, it can be revoked on its
// own, and it is worthless on any other site. An account password is none of
// those things.
//
// FLUME_REFRESH_TOKEN seeds this on a fresh database. After that the stored
// value wins, because Flume may hand back a different token on each refresh and
// the stored one is then newer than the env var that seeded it.
// ---------------------------------------------------------------------------

/**
 * The refresh token to use, or null if Flume has never been connected.
 *
 * Prefers the stored value over the env seed: if they differ, the stored one is
 * the result of a later rotation and the env var is stale.
 */
export async function readRefreshToken(): Promise<string | null> {
  await ensureSchema()
  const db = getDb()
  const res = await db.execute("SELECT refresh_token FROM flume_state WHERE id = 1")
  const stored = res.rows[0]?.refresh_token
  if (stored != null && String(stored).length > 0) return String(stored)

  const seed = process.env.FLUME_REFRESH_TOKEN
  return seed && seed.length > 0 ? seed : null
}

/** Persist a refresh token, replacing whatever was there. */
export async function saveRefreshToken(token: string): Promise<void> {
  await ensureSchema()
  const db = getDb()
  await db.execute({
    sql: `INSERT INTO flume_state (id, refresh_token, updated_at)
          VALUES (1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET refresh_token = excluded.refresh_token,
                                        updated_at    = excluded.updated_at`,
    args: [token, new Date().toISOString()],
  })
}

/** When the stored token was last written — for the runbook, not for logic. */
export async function refreshTokenUpdatedAt(): Promise<string | null> {
  await ensureSchema()
  const db = getDb()
  const res = await db.execute("SELECT updated_at FROM flume_state WHERE id = 1")
  const v = res.rows[0]?.updated_at
  return v != null ? String(v) : null
}

/** Forget the stored token. Disconnecting, or recovering from a bad one. */
export async function clearRefreshToken(): Promise<void> {
  await ensureSchema()
  await getDb().execute("DELETE FROM flume_state WHERE id = 1")
}

/** Record the water sensor's health, replacing the previous reading. */
export async function saveDeviceStatus(status: FlumeDeviceStatus): Promise<void> {
  await ensureSchema()
  await getDb().execute({
    sql: `INSERT INTO flume_device (id, device_id, name, battery_level, connected, last_seen, checked_at)
          VALUES (1, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET device_id = excluded.device_id, name = excluded.name,
            battery_level = excluded.battery_level, connected = excluded.connected,
            last_seen = excluded.last_seen, checked_at = excluded.checked_at`,
    args: [
      status.deviceId,
      status.name,
      status.batteryLevel,
      status.connected === null ? null : status.connected ? 1 : 0,
      status.lastSeen,
      status.checkedAt,
    ],
  })
}

/** The last recorded sensor health, or null if no sync has recorded one. */
export async function readDeviceStatus(): Promise<FlumeDeviceStatus | null> {
  await ensureSchema()
  const res = await getDb().execute(
    "SELECT device_id, name, battery_level, connected, last_seen, checked_at FROM flume_device WHERE id = 1"
  )
  const r = res.rows[0]
  if (!r) return null
  return {
    deviceId: String(r.device_id),
    name: String(r.name),
    batteryLevel: r.battery_level == null ? null : String(r.battery_level),
    connected: r.connected == null ? null : Number(r.connected) === 1,
    lastSeen: r.last_seen == null ? null : String(r.last_seen),
    checkedAt: String(r.checked_at),
  }
}
