import type { FlumeRow } from "@/lib/types"

// ---------------------------------------------------------------------------
// Flume Personal API client (server-only).
//
// Auth is OAuth2 "password" grant: client_id/secret + account email/password in
// exchange for an access token. See https://flumetech.readme.io/docs/authentication.
//
// There is deliberately no refresh-token handling and nothing persisted. The
// original version of this file stored a rotating refresh token in an encrypted
// database column, which needed a table, an encryption key, a settings UI and a
// connect/disconnect flow — several hundred lines to avoid re-sending a password
// this server already holds. A sync runs once a day and Flume allows 120
// requests an hour, so doing the password grant each time costs one request and
// deletes all of that machinery.
//
// Rate limit: 120 requests/hour → HTTP 429. A sync makes at most three calls
// (token, devices, query), so it stays far under.
// ---------------------------------------------------------------------------

const BASE = "https://api.flumewater.com"

export class FlumeError extends Error {
  constructor(message: string, readonly status?: number, readonly rateLimited = false) {
    super(message)
    this.name = "FlumeError"
  }
}

/** All four variables must be present; a partial configuration is not "nearly working". */
export function flumeConfigured(): boolean {
  return Boolean(
    process.env.FLUME_CLIENT_ID &&
      process.env.FLUME_CLIENT_SECRET &&
      process.env.FLUME_USERNAME &&
      process.env.FLUME_PASSWORD
  )
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
  // Deliberately not including the request body or credentials in the message:
  // this string ends up in logs.
  const detail = body.message ? `: ${body.message}` : ""
  throw new FlumeError(`Flume ${context} failed (HTTP ${res.status})${detail}`, res.status)
}

interface TokenResponse {
  access_token: string
  expires_in: number
}

/** Exchange the account credentials for an access token. */
export async function fetchAccessToken(): Promise<string> {
  if (!flumeConfigured()) throw new FlumeError("Flume is not configured")

  const res = await fetch(`${BASE}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "password",
      client_id: process.env.FLUME_CLIENT_ID,
      client_secret: process.env.FLUME_CLIENT_SECRET,
      username: process.env.FLUME_USERNAME,
      password: process.env.FLUME_PASSWORD,
    }),
  })
  const body = await parseJson(res)
  if (!res.ok) raise(res, body, "authentication")

  const t = (body.data?.[0] ?? body) as Partial<TokenResponse>
  if (!t.access_token) throw new FlumeError("Flume token response contained no access_token")
  return t.access_token
}

/** The numeric user_id lives in the access token's JWT payload, not in a separate call. */
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
 * Built from UTC components on purpose. The previous version used local getters
 * and a comment saying the server timezone was pinned by APP_TIMEZONE — that pin
 * was deleted, production never set the variable, and on Vercel the process runs
 * UTC anyway. Reading the process timezone would make the query window depend on
 * where the code happens to run, which is the class of bug this codebase spent a
 * PR removing.
 *
 * Flume interprets these as ACCOUNT-local time, so a UTC-built window can be off
 * by the account's offset. That is why syncFlumeData pads both ends by a day:
 * the overlap absorbs any offset, and rows dedupe on their datetime primary key,
 * so over-fetching costs nothing but under-fetching would silently lose a day.
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
 * water to sprinkler stations by minute of day: `localDateAndMin` in lib/analyze
 * turns a timestamp into a minute offset, and the schedule reconstruction lines
 * station run windows up against it. The previous version defaulted to "HR" on
 * the stated grounds that it matched the manual CSV export; the real exports are
 * per-minute (56,041 rows for five weeks), and hourly totals would make station
 * attribution meaningless.
 *
 * The datetime is returned EXACTLY as Flume sends it. The previous version ran
 * it through `new Date(...).toISOString()`, producing a UTC string with a `Z` —
 * which POST /api/rows now rejects with a 400, deliberately, because everything
 * downstream reads these as naive wall-clock time. Flume's own format,
 * "YYYY-MM-DD HH:MM:SS", is already precisely what the ingest accepts.
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
