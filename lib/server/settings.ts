import type { InArgs } from "@libsql/client"
import { getDb, ensureSchema } from "@/lib/db"
import { encryptSecret, decryptSecret } from "@/lib/server/crypto"
import type { DataSource, FlumeConnection, FlumeStatus } from "@/lib/types"

// ---------------------------------------------------------------------------
// Read/write the singleton `flume_connection` row (id = 1). Secret columns are
// encrypted at rest via lib/server/crypto and decrypted on read here, so the
// rest of the server works with plain values. The client never sees this row —
// only the non-secret subset from readFlumeStatus().
// ---------------------------------------------------------------------------

// Columns whose stored value is encrypted (see crypto.ts).
const SECRET_FIELDS = ["client_secret", "refresh_token", "access_token"] as const

function decMaybe(v: unknown): string | null {
  if (v == null) return null
  return decryptSecret(String(v))
}

export async function readFlumeConnection(): Promise<FlumeConnection> {
  await ensureSchema()
  const db = getDb()
  const res = await db.execute("SELECT * FROM flume_connection WHERE id = 1")
  const r = res.rows[0]
  // ensureSchema seeds the row, but be defensive if it is somehow missing.
  if (!r) {
    return {
      dataSource: "manual",
      clientId: null,
      clientSecret: null,
      refreshToken: null,
      accessToken: null,
      accessExpiresAt: null,
      flumeUserId: null,
      deviceId: null,
      deviceName: null,
      lastSyncAt: null,
      lastSyncStatus: null,
      lastSyncError: null,
    }
  }
  return {
    dataSource: (String(r.data_source) as DataSource) ?? "manual",
    clientId: r.client_id != null ? String(r.client_id) : null,
    clientSecret: decMaybe(r.client_secret),
    refreshToken: decMaybe(r.refresh_token),
    accessToken: decMaybe(r.access_token),
    accessExpiresAt: r.access_expires_at != null ? String(r.access_expires_at) : null,
    flumeUserId: r.flume_user_id != null ? String(r.flume_user_id) : null,
    deviceId: r.device_id != null ? String(r.device_id) : null,
    deviceName: r.device_name != null ? String(r.device_name) : null,
    lastSyncAt: r.last_sync_at != null ? String(r.last_sync_at) : null,
    lastSyncStatus: (r.last_sync_status as "ok" | "error" | null) ?? null,
    lastSyncError: r.last_sync_error != null ? String(r.last_sync_error) : null,
  }
}

// Column name for each patchable field, and whether it is a secret.
const COLUMN_MAP: Record<keyof FlumeConnection, string> = {
  dataSource: "data_source",
  clientId: "client_id",
  clientSecret: "client_secret",
  refreshToken: "refresh_token",
  accessToken: "access_token",
  accessExpiresAt: "access_expires_at",
  flumeUserId: "flume_user_id",
  deviceId: "device_id",
  deviceName: "device_name",
  lastSyncAt: "last_sync_at",
  lastSyncStatus: "last_sync_status",
  lastSyncError: "last_sync_error",
}

// Patch any subset of the connection row. Secret fields are encrypted here.
export async function updateFlumeConnection(patch: Partial<FlumeConnection>): Promise<void> {
  await ensureSchema()
  const db = getDb()
  const sets: string[] = []
  const args: InArgs = []
  for (const [k, v] of Object.entries(patch) as [keyof FlumeConnection, unknown][]) {
    const col = COLUMN_MAP[k]
    if (!col) continue
    sets.push(`${col} = ?`)
    if (v == null) {
      args.push(null)
    } else if ((SECRET_FIELDS as readonly string[]).includes(col)) {
      args.push(encryptSecret(String(v)))
    } else {
      args.push(String(v))
    }
  }
  if (sets.length === 0) return
  await db.execute({ sql: `UPDATE flume_connection SET ${sets.join(", ")} WHERE id = 1`, args })
}

// Clear all credentials/tokens and revert to manual data loading (disconnect).
export async function clearFlumeConnection(): Promise<void> {
  await updateFlumeConnection({
    dataSource: "manual",
    clientId: null,
    clientSecret: null,
    refreshToken: null,
    accessToken: null,
    accessExpiresAt: null,
    flumeUserId: null,
    deviceId: null,
    deviceName: null,
    lastSyncStatus: null,
    lastSyncError: null,
  })
}

// The non-secret subset safe to send to the browser. Never includes tokens.
export async function readFlumeStatus(): Promise<FlumeStatus> {
  const c = await readFlumeConnection()
  return {
    dataSource: c.dataSource,
    connected: Boolean(c.refreshToken && c.deviceId),
    deviceName: c.deviceName,
    lastSyncAt: c.lastSyncAt,
    lastSyncStatus: c.lastSyncStatus,
    lastSyncError: c.lastSyncError,
  }
}
