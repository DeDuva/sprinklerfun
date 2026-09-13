import type { FlumeConnection, FlumeDevice, FlumeRow } from "@/lib/types"
import { readFlumeConnection, updateFlumeConnection } from "@/lib/server/settings"

// ---------------------------------------------------------------------------
// Flume Personal API client (server-only).
//
// Auth is OAuth2 "password" grant: exchange client_id/secret + account
// email/password for an access token (JWT) + refresh token. The account password
// is used ONLY here for the initial exchange and never stored; all later calls
// use the refresh token. See https://flumetech.readme.io/docs/authentication.
//
// Rate limit: 120 requests/hour → HTTP 429. We make at most a couple of requests
// per sync (token refresh + one batched usage query), so we stay well under it.
// ---------------------------------------------------------------------------

const BASE = "https://api.flumewater.com"

// Refresh the access token when it is within this window of expiring.
const EXPIRY_SKEW_MS = 60_000

export class FlumeError extends Error {
  constructor(message: string, readonly status?: number, readonly rateLimited = false) {
    super(message)
    this.name = "FlumeError"
  }
}

// Flume wraps most responses as { success, data: [...] }. Unwrap defensively.
async function parseJson(res: Response): Promise<{ data?: unknown[]; message?: string }> {
  const text = await res.text()
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    return { message: text }
  }
}

function raise(res: Response, body: { message?: string }, context: string): never {
  if (res.status === 429) {
    throw new FlumeError(
      "Flume API rate limit reached (120 requests/hour). Try again later.",
      429,
      true
    )
  }
  const detail = body.message ? `: ${body.message}` : ""
  throw new FlumeError(`Flume ${context} failed (HTTP ${res.status})${detail}`, res.status)
}

interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number // seconds
}

function unwrapToken(body: { data?: unknown[] }): TokenResponse {
  const t = (body.data?.[0] ?? body) as Partial<TokenResponse>
  if (!t.access_token || !t.refresh_token) {
    throw new FlumeError("Flume token response missing tokens")
  }
  return {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_in: typeof t.expires_in === "number" ? t.expires_in : 3600,
  }
}

// Decode the numeric user_id from an access-token JWT payload.
export function decodeJwtUserId(accessToken: string): string {
  const parts = accessToken.split(".")
  if (parts.length < 2) throw new FlumeError("Malformed access token")
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
  const userId = payload?.user_id
  if (userId == null) throw new FlumeError("Access token payload has no user_id")
  return String(userId)
}

// Initial token exchange with the account password (never persisted).
export async function exchangePassword(args: {
  clientId: string
  clientSecret: string
  username: string
  password: string
}): Promise<TokenResponse> {
  const res = await fetch(`${BASE}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "password",
      client_id: args.clientId,
      client_secret: args.clientSecret,
      username: args.username,
      password: args.password,
    }),
  })
  const body = await parseJson(res)
  if (!res.ok) raise(res, body, "authentication")
  return unwrapToken(body)
}

// Mint a fresh access token from the stored refresh token.
async function refreshAccessToken(conn: FlumeConnection): Promise<TokenResponse> {
  if (!conn.clientId || !conn.clientSecret || !conn.refreshToken) {
    throw new FlumeError("Flume is not connected")
  }
  const res = await fetch(`${BASE}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: conn.clientId,
      client_secret: conn.clientSecret,
      refresh_token: conn.refreshToken,
    }),
  })
  const body = await parseJson(res)
  if (!res.ok) raise(res, body, "token refresh")
  return unwrapToken(body)
}

// Return a valid access token, refreshing + persisting it when expired/near-expiry.
export async function getValidAccessToken(conn: FlumeConnection): Promise<string> {
  const notExpired =
    conn.accessToken &&
    conn.accessExpiresAt &&
    new Date(conn.accessExpiresAt).getTime() - Date.now() > EXPIRY_SKEW_MS
  if (notExpired) return conn.accessToken!

  const t = await refreshAccessToken(conn)
  const accessExpiresAt = new Date(Date.now() + t.expires_in * 1000).toISOString()
  await updateFlumeConnection({
    accessToken: t.access_token,
    refreshToken: t.refresh_token, // Flume may rotate the refresh token
    accessExpiresAt,
  })
  // Keep the in-memory copy consistent for the rest of this request.
  conn.accessToken = t.access_token
  conn.refreshToken = t.refresh_token
  conn.accessExpiresAt = accessExpiresAt
  return t.access_token
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deviceName(d: any): string {
  return (
    d?.location?.name ??
    d?.name ??
    d?.product ??
    `Flume device ${d?.id ?? "?"}`
  )
}

// List the account's Water Sensor devices (type 2). Bridges (type 1) are skipped.
export async function listWaterSensors(userId: string, accessToken: string): Promise<FlumeDevice[]> {
  const res = await fetch(`${BASE}/users/${userId}/devices?location=true`, {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  const body = await parseJson(res)
  if (!res.ok) raise(res, body, "device list")
  const devices = (body.data ?? []) as Record<string, unknown>[]
  return devices
    .filter((d) => Number(d.type) === 2)
    .map((d) => ({ id: String(d.id), type: Number(d.type), name: deviceName(d) }))
}

// Format a Date as Flume's local-time query format "YYYY-MM-DD HH:MM:SS". The
// server TZ is pinned to APP_TIMEZONE (see lib/db.ts) so this is the account's
// local time, which is what the Flume query endpoint expects.
export function fmtFlumeLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0")
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  )
}

// Query water usage between two datetimes and return rows in the app's shape.
// `bucket` defaults to "HR" to match the manual CSV export (scale=hour) so
// API-sourced rows are identical in granularity to manually-imported ones.
// Flume returns datetimes in account-local time ("YYYY-MM-DD HH:MM:SS"); we
// normalize each to a UTC ISO string via Date so it matches CSV-imported rows,
// which the enrichment (lib/analyze.ts) converts back to local.
export async function queryUsage(args: {
  userId: string
  deviceId: string
  accessToken: string
  since: Date
  until: Date
  bucket?: "MIN" | "HR" | "DAY"
}): Promise<FlumeRow[]> {
  const requestId = "sprinklerfun"
  const res = await fetch(`${BASE}/users/${args.userId}/devices/${args.deviceId}/query`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${args.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      queries: [
        {
          request_id: requestId,
          bucket: args.bucket ?? "HR",
          since_datetime: fmtFlumeLocal(args.since),
          until_datetime: fmtFlumeLocal(args.until),
          operation: "SUM",
          units: "GALLONS",
          sort_direction: "ASC",
        },
      ],
    }),
  })
  const body = await parseJson(res)
  if (!res.ok) raise(res, body, "usage query")

  // data: [ { "<request_id>": [ { datetime, value } ] } ]
  const first = (body.data?.[0] ?? {}) as Record<string, { datetime: string; value: number }[]>
  const samples = first[requestId] ?? []
  return samples.map((s) => ({
    // Local "YYYY-MM-DD HH:MM:SS" → UTC ISO, matching CSV-imported rows.
    datetime: new Date(s.datetime.replace(" ", "T")).toISOString(),
    gallons: Number(s.value) || 0,
  }))
}

// Convenience for callers that just have the stored connection.
export async function loadConnection(): Promise<FlumeConnection> {
  return readFlumeConnection()
}
