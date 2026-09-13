import type { FlumeRow } from "@/lib/types"

// ---------------------------------------------------------------------------
// Flume Personal API client (server-only).
//
// The deployment never sees your Flume account password. Flume's OAuth2
// password grant is needed exactly once, to mint a refresh token, and that
// happens on your own machine via `npm run flume:connect` — see
// scripts/flume-connect.ts. The server only ever uses grant_type=refresh_token
// with the client id and secret.
//
// That distinction is the point: a refresh token is scoped to API access, can
// be revoked by itself, and is useless anywhere else. An account password is a
// personal credential that may be reused elsewhere and cannot be revoked
// without changing it everywhere.
//
// Rate limit: 120 requests/hour → HTTP 429. A sync makes at most three calls
// (refresh, devices, query), so it stays far under.
// ---------------------------------------------------------------------------

const BASE = "https://api.flumewater.com"

export class FlumeError extends Error {
  constructor(message: string, readonly status?: number, readonly rateLimited = false) {
    super(message)
    this.name = "FlumeError"
  }
}

/**
 * Are the client credentials present?
 *
 * Deliberately does not consider the refresh token: that lives in the database
 * and this has to stay synchronous. "Configured but not connected" is a real
 * state with its own message — see syncFlumeData.
 */
export function flumeConfigured(): boolean {
  return Boolean(process.env.FLUME_CLIENT_ID && process.env.FLUME_CLIENT_SECRET)
}

interface FlumeBody {
  data?: unknown[]
  message?: string
  detailed?: unknown
}

// Flume wraps most responses as { success, data: [...] }. Unwrap defensively.
async function parseJson(res: Response): Promise<FlumeBody> {
  const text = await res.text()
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    return { message: text }
  }
}

/**
 * Flume's `detailed` field, flattened to one line.
 *
 * On a 400 it names the fields that failed validation and why — the only part
 * of the response that says WHAT was wrong; `message` alone is a generic "A
 * provided parameter failed validation". Otherwise it is an array of strings.
 * Handled as either shape, since the docs give no example.
 *
 * Validation messages describe fields, not echo their values, and the token
 * endpoint's is a plain sentence ("Refresh token is invalid") — but the result
 * is still capped so an unexpected response cannot flood the log.
 */
function describeDetail(detailed: unknown): string {
  if (!Array.isArray(detailed)) return ""
  const parts = detailed
    .map((d) => {
      if (typeof d === "string") return d
      if (d && typeof d === "object") {
        const { field, message } = d as { field?: unknown; message?: unknown }
        if (field != null || message != null) {
          return [field, message].filter((x) => x != null).map(String).join(": ")
        }
        return JSON.stringify(d)
      }
      return ""
    })
    .filter(Boolean)
  return parts.join("; ").slice(0, 300)
}

function raise(res: Response, body: FlumeBody, context: string): never {
  if (res.status === 429) {
    throw new FlumeError(
      "Flume API rate limit reached (120 requests/hour). Try again later.",
      429,
      true
    )
  }
  // This string reaches the logs, so it must never carry the request body.
  const why = describeDetail(body.detailed)
  const detail = (body.message ? `: ${body.message}` : "") + (why ? ` (${why})` : "")
  throw new FlumeError(`Flume ${context} failed (HTTP ${res.status})${detail}`, res.status)
}

export interface FlumeTokens {
  accessToken: string
  /** Flume returns one on every grant. It may or may not differ from the last. */
  refreshToken: string
}

function unwrapTokens(body: { data?: unknown[] }): FlumeTokens {
  const t = (body.data?.[0] ?? body) as { access_token?: string; refresh_token?: string }
  if (!t.access_token) throw new FlumeError("Flume token response contained no access_token")
  if (!t.refresh_token) throw new FlumeError("Flume token response contained no refresh_token")
  return { accessToken: t.access_token, refreshToken: t.refresh_token }
}

/**
 * Exchange an account password for tokens. **Local bootstrap only.**
 *
 * Nothing on the server calls this — it exists for scripts/flume-connect.ts,
 * which runs on your machine, keeps the password in memory for one request, and
 * writes only the refresh token to stdout for you to paste into Vercel.
 */
export async function exchangePassword(args: {
  username: string
  password: string
  clientId: string
  clientSecret: string
}): Promise<FlumeTokens> {
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
  return unwrapTokens(body)
}

/**
 * Trade the stored refresh token for a fresh access token.
 *
 * This is the only token call the deployment makes. The returned refreshToken
 * must be compared against the one sent and persisted when it differs — Flume
 * returns one every time and does not document whether it rotates, so the
 * caller handles both cases rather than assuming either.
 */
export async function refreshAccessToken(refreshToken: string): Promise<FlumeTokens> {
  if (!flumeConfigured()) throw new FlumeError("Flume client credentials are not configured")

  const res = await fetch(`${BASE}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: process.env.FLUME_CLIENT_ID,
      client_secret: process.env.FLUME_CLIENT_SECRET,
      refresh_token: refreshToken,
    }),
  })
  const body = await parseJson(res)
  if (!res.ok) raise(res, body, "token refresh")
  return unwrapTokens(body)
}

/** The numeric user_id lives in the access token's JWT payload, not a separate call. */
export function decodeJwtUserId(accessToken: string): string {
  const parts = accessToken.split(".")
  if (parts.length < 2) throw new FlumeError("Malformed access token")
  let payload: { user_id?: unknown }
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
  } catch {
    throw new FlumeError("Access token payload is not JSON")
  }
  if (payload?.user_id == null) throw new FlumeError("Access token payload has no user_id")
  return String(payload.user_id)
}

export interface FlumeDevice {
  id: string
  name: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deviceName(d: any): string {
  return d?.location?.name ?? d?.name ?? d?.product ?? `Flume device ${d?.id ?? "?"}`
}

/**
 * The account's Water Sensor devices (type 2). Bridges (type 1) are skipped —
 * they relay, they do not meter.
 */
export async function listWaterSensors(userId: string, accessToken: string): Promise<FlumeDevice[]> {
  const res = await fetch(`${BASE}/users/${userId}/devices?location=true`, {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  const body = await parseJson(res)
  if (!res.ok) raise(res, body, "device list")
  return ((body.data ?? []) as Record<string, unknown>[])
    .filter((d) => Number(d.type) === 2)
    .map((d) => ({ id: String(d.id), name: deviceName(d) }))
}

/**
 * Format a datetime the way Flume's query endpoint wants it: "YYYY-MM-DD HH:MM:SS".
 *
 * Built from UTC components on purpose. An earlier version used local getters
 * and a comment citing an APP_TIMEZONE pin in lib/db.ts — that pin was deleted,
 * production never set the variable, and on Vercel the process runs UTC anyway.
 * Reading the process timezone would make the query window depend on where the
 * code happens to run.
 *
 * Flume interprets these as ACCOUNT-local time, so a UTC-built window can be off
 * by the account's offset. That is why syncFlumeData pads both ends by a day:
 * the overlap absorbs it, rows dedupe on their datetime primary key, and
 * over-fetching is free while under-fetching would silently lose a day.
 */
export function fmtFlumeDatetime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0")
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  )
}

/**
 * Query water usage and return rows in the app's shape.
 *
 * `bucket` is MIN — per-minute — and that is not a detail. This app attributes
 * water to sprinkler stations by minute of day, so hourly totals would make the
 * attribution meaningless. The real CSV exports are per-minute too.
 *
 * The datetime is returned EXACTLY as Flume sends it. Running it through
 * `new Date(...).toISOString()` produces a UTC string with a `Z`, which
 * POST /api/rows rejects with a 400 by design — everything downstream reads
 * these as naive wall-clock time, and Flume's own "YYYY-MM-DD HH:MM:SS" is
 * already precisely what ingest accepts.
 */
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
          bucket: args.bucket ?? "MIN",
          since_datetime: fmtFlumeDatetime(args.since),
          until_datetime: fmtFlumeDatetime(args.until),
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
  return (first[requestId] ?? []).map((s) => ({
    datetime: s.datetime,
    gallons: Number(s.value) || 0,
  }))
}
