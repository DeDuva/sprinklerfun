import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { resetDbForTests } from "../db"
import { insertRows, replaceWindows, readWindows, readRollups, countRows } from "../server/data"
import type { ConfigWindow, FlumeRow } from "../types"

import { POST, DELETE as deleteRows } from "@/app/api/rows/route"
import { GET as getConfig, PUT as putConfig } from "@/app/api/config/route"
import { POST as login } from "@/app/api/login/route"
import { GET as getDay } from "@/app/api/day/[date]/route"
import { GET as getRollup } from "@/app/api/rollup/route"
import { GET as getStats } from "@/app/api/stats/route"
import { GET as getDelay } from "@/app/api/delay/route"
import { GET as getHealth } from "@/app/api/health/route"

// Route handlers are plain functions over a Request, so they need no Next server
// to test — only a real database, which lib/__tests__/setup.ts makes in-memory.
// These cover the validation and status codes that stand between a public
// deployment and its data.

beforeEach(() => resetDbForTests())
afterEach(() => {
  delete process.env.APP_PASSWORD
  delete process.env.VERCEL
  vi.restoreAllMocks()
})

// No credential anywhere in here any more: authentication happens in proxy.ts,
// before a handler is reached, and is covered by lib/__tests__/proxy.test.ts and
// end to end in e2e/smoke.spec.ts. What is left for these tests is the part that
// stays the handler's job — validating the body.
const post = (body: unknown) =>
  POST(
    new NextRequest("https://x.test/api/rows", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  )

const loginReq = (body: unknown) =>
  new Request("https://x.test/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })

const row = (min: number, gallons = 1): FlumeRow => {
  const hh = String(Math.floor(min / 60)).padStart(2, "0")
  const mm = String(min % 60).padStart(2, "0")
  return { datetime: `2026-08-28 ${hh}:${mm}:00`, gallons }
}

const win = (id: string): ConfigWindow => ({
  id,
  effectiveFrom: "2026-07-01",
  notes: "",
  config: {
    timer1: {
      stations: [{ id: "T1-01", name: "Front", baselineGpm: 6 }],
      programs: {
        A: {
          enabled: true,
          start: "06:00:00",
          days: [0, 1, 2, 3, 4, 5, 6],
          stations: { "T1-01": { durationMin: 10, enabled: true } },
        },
        B: { enabled: false, start: "06:00:00", days: [], stations: {} },
        C: { enabled: false, start: "06:00:00", days: [], stations: {} },
      },
    },
    timer2: {
      stations: [],
      programs: {
        A: { enabled: false, start: "08:00:00", days: [], stations: {} },
        B: { enabled: false, start: "08:00:00", days: [], stations: {} },
        C: { enabled: false, start: "08:00:00", days: [], stations: {} },
      },
    },
    sprinklerOnThreshold: 50,
    gallonsPerUnit: 748,
    costPerUnit: 10,
  },
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
})

// ---------------------------------------------------------------------------

describe("POST /api/login", () => {
  // The success path sets a cookie through next/headers, which needs a real
  // request scope that a bare handler call does not provide. It is covered end
  // to end in e2e/smoke.spec.ts, against the built app, where it also proves the
  // cookie is actually accepted afterwards — which is the part that matters.

  it("reports open mode rather than rejecting, when no password is configured", async () => {
    const res = await login(loginReq({ password: "anything" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ authMode: "open" })
  })

  it("503s on a deployment with no password, instead of letting anyone in", async () => {
    process.env.VERCEL = "1"
    expect((await login(loginReq({ password: "anything" }))).status).toBe(503)
  })

  it("401s a wrong password", async () => {
    process.env.APP_PASSWORD = "correct-horse"
    const res = await login(loginReq({ password: "wrong" }))
    expect(res.status).toBe(401)
    // One message for every kind of failure: a caller should not be able to tell
    // "no such field" from "wrong value" by reading the response.
    expect(await res.json()).toEqual({ error: "wrong password" })
  })

  it("401s a missing, empty or non-string password", async () => {
    process.env.APP_PASSWORD = "correct-horse"
    expect((await login(loginReq({}))).status).toBe(401)
    expect((await login(loginReq({ password: "" }))).status).toBe(401)
    expect((await login(loginReq({ password: 123 }))).status).toBe(401)
    expect((await login(loginReq({ password: null }))).status).toBe(401)
  })

  it("400s on malformed JSON", async () => {
    process.env.APP_PASSWORD = "correct-horse"
    expect((await login(loginReq("{not json"))).status).toBe(400)
  })
})

describe("POST /api/rows — body validation", () => {
  it("400s on malformed JSON", async () => {
    expect((await post("{nope")).status).toBe(400)
  })

  it("400s when rows is missing or not an array", async () => {
    expect((await post({})).status).toBe(400)
    expect((await post({ rows: "no" })).status).toBe(400)
  })

  it("413s past the row cap, without touching the database", async () => {
    const rows = Array.from({ length: 200_001 }, () => row(1))
    const res = await post({ rows })
    expect(res.status).toBe(413)
    expect(await countRows()).toBe(0)
  })

  it("rejects a malformed datetime and names the offending index", async () => {
    // flume_rows is indexed on substr(datetime,1,10) and rowDateBounds takes a
    // lexicographic MIN/MAX over the raw string, so a bad prefix corrupts both.
    const res = await post({ rows: [row(1), { datetime: "banana", gallons: 1 }] })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("body.rows[1]")
    expect(await countRows()).toBe(0)
  })

  it("rejects out-of-range gallons", async () => {
    expect((await post({ rows: [row(1, -1)] })).status).toBe(400)
    expect((await post({ rows: [row(1, 1e308)] })).status).toBe(400)
    expect((await post({ rows: [row(1, Number.NaN)] })).status).toBe(400)
  })

})

describe("POST /api/rows — config no longer rides along", () => {
  it("rejects a windows field instead of silently ignoring it", async () => {
    // A tab left open across the deploy that moved config to the server would
    // otherwise keep sending windows and keep appearing to save them. Failing
    // loudly is what stops two sources of truth re-establishing themselves.
    await replaceWindows([win("keep-me")])
    const res = await post({ rows: [], windows: [win("new")] })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("PUT /api/config")
    expect((await readWindows()).map((w) => w.id)).toEqual(["keep-me"])
  })

  it("rejects even an empty windows array", async () => {
    // The shape that used to wipe the whole timeline. It is not a no-op here,
    // it is a 400 — there is no reading of it that this route should accept.
    await replaceWindows([win("keep-me")])
    expect((await post({ rows: [], windows: [] })).status).toBe(400)
    expect((await readWindows()).map((w) => w.id)).toEqual(["keep-me"])
  })

  it("leaves windows alone on an ordinary ingest", async () => {
    await replaceWindows([win("keep-me")])
    expect((await post({ rows: [row(1)] })).status).toBe(200)
    expect(await readWindows()).toHaveLength(1)
  })
})

describe("POST /api/rows — success", () => {
  it("reports received and inserted separately, and dedupes on re-post", async () => {
    await replaceWindows([win("w1")])
    const rows = [row(1), row(2), row(3)]
    const first = await (await post({ rows })).json()
    expect(first).toMatchObject({ ok: true, received: 3, inserted: 3 })

    const second = await (await post({ rows })).json()
    expect(second).toMatchObject({ received: 3, inserted: 0 })
    expect(await countRows()).toBe(3)
  })
})

describe("DELETE /api/rows", () => {
  it("clears the metered data but keeps the config", async () => {
    await replaceWindows([win("keep-me")])
    await insertRows([row(1), row(2)])

    const res = await deleteRows()
    expect(res.status).toBe(200)

    expect(await countRows()).toBe(0)
    // The button that calls this is one typed word away from irreversible; the
    // config surviving it is the property that makes that acceptable.
    expect((await readWindows()).map((w) => w.id)).toEqual(["keep-me"])
  })
})

describe("GET/PUT /api/config", () => {
  const put = (body: unknown) =>
    putConfig(
      new NextRequest("https://x.test/api/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      })
    )

  const doc = (windows = [win("w1")], maintenance: Record<string, unknown> = {}) => ({
    windows,
    maintenance,
  })

  it("round-trips a config document", async () => {
    expect((await put(doc())).status).toBe(200)
    const body = await (await getConfig()).json()
    expect(body.windows.map((w: { id: string }) => w.id)).toEqual(["w1"])
    expect(body.maintenance).toEqual({})
    expect(body.authMode).toBe("open")
  })

  it("stores maintenance flags alongside the windows", async () => {
    const flags = { "T1-01": { flaggedAt: "2026-05-01T00:00:00.000Z", note: "leak" } }
    expect((await put(doc([win("w1")], flags))).status).toBe(200)
    expect((await (await getConfig()).json()).maintenance).toEqual(flags)
  })

  it("returns what was stored, not what was sent", async () => {
    const res = await put(doc())
    const returned = await res.json()
    const fetched = await (await getConfig()).json()
    expect(returned.windows).toEqual(fetched.windows)
  })

  it("refuses to empty the timeline", async () => {
    await put(doc())
    const res = await put(doc([]))
    expect(res.status).toBe(400)
    // Refused means unchanged, not partially applied.
    expect((await readWindows()).map((w) => w.id)).toEqual(["w1"])
  })

  it("rejects a malformed window and names the offending index", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await put(doc([win("ok"), { id: "x" } as any]))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("body.windows[1]")
  })

  it("requires maintenance rather than defaulting it, so a forgotten key cannot clear flags", async () => {
    await put(doc([win("w1")], { "T1-01": { flaggedAt: "2026-05-01T00:00:00.000Z" } }))
    // Omitted entirely.
    expect((await put({ windows: [win("w2")] })).status).toBe(400)
    // Present but wrong shape.
    expect((await put(doc([win("w2")], { "T1-01": { note: "no timestamp" } }))).status).toBe(400)
    // The flags survived both refusals.
    expect(Object.keys((await (await getConfig()).json()).maintenance)).toEqual(["T1-01"])
  })

  it("400s on malformed JSON", async () => {
    expect((await put("{nope")).status).toBe(400)
  })

  it("recomputes the rollups against the new config", async () => {
    // A config write changes how stored rows are attributed, so the derived
    // tables have to move with it — otherwise the dashboard keeps showing
    // numbers computed under the previous timeline.
    await replaceWindows([win("w1")])
    await insertRows([row(360), row(361), row(362)])
    await put(doc([win("w1")]))
    expect((await readRollups()).length).toBeGreaterThan(0)
  })
})

describe("GET /api/day/[date]", () => {
  const call = (date: string) =>
    getDay(new NextRequest(`https://x.test/api/day/${date}`), {
      params: Promise.resolve({ date }),
    })

  it("returns that day's rows", async () => {
    await insertRows([row(1), row(2)])
    const body = await (await call("2026-08-28")).json()
    expect(body.rows).toHaveLength(2)
  })

  it("400s on anything that is not YYYY-MM-DD", async () => {
    for (const bad of ["2026-8-28", "banana", "2026-08-28' OR 1=1", ""]) {
      expect((await call(bad)).status, bad).toBe(400)
    }
  })

  it("returns an empty array for a valid date with no data", async () => {
    expect((await (await call("2026-01-01")).json()).rows).toEqual([])
  })
})

describe("GET /api/rollup, /api/stats, /api/health", () => {
  it("rollup returns an empty set on an empty database rather than failing", async () => {
    const res = await getRollup(new NextRequest("https://x.test/api/rollup"))
    expect(res.status).toBe(200)
    expect((await res.json()).rollups).toEqual([])
  })

  it("stats reports a row count and a null last date when empty", async () => {
    const body = await (await getStats()).json()
    expect(body.rowCount).toBe(0)
    expect(body.lastDate).toBeNull()
  })

  it("health reports the database as reachable, with a row count", async () => {
    await insertRows([row(1)])
    const res = await getHealth()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, database: "reachable", rows: 1 })
  })
})

describe("GET /api/delay", () => {
  const call = (qs = "") =>
    getDelay(new NextRequest(`https://x.test/api/delay${qs}`))

  it("returns nothing rather than erroring when no config exists", async () => {
    const body = await (await call()).json()
    expect(body.recommendations).toEqual([])
  })

  it("clamps the days parameter", async () => {
    await replaceWindows([win("w1")])
    for (const qs of ["?days=0", "?days=-5", "?days=banana", "?days=99999"]) {
      expect((await call(qs)).status, qs).toBe(200)
    }
  })
})
