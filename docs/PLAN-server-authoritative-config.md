# Plan: server-authoritative config, real login, fewer moving parts

Status: **approved** 2026-09-11; PR 0 is the pull request that adds this file.
Delete it when the last PR merges — by then its durable parts live in `README.md`,
`docs/RUNBOOK.md`, `docs/TECHNICAL_DESIGN.md` and `SECURITY.md`.

The first draft was written against a checkout that was two merges behind, and
#44 (backups) and #47 (local dates, audit gate) had already landed. This version
accounts for both: PR 4 turned out to be done already, and PR 3 is half the size.

## Why

The config keeps breaking because it has two owners. `localStorage` is the source
of truth (`lib/store.ts` `partialize`), Turso's `config_windows` is a write-only
mirror fed by a debounced, fire-and-forget subscription in
`components/StoreProvider.tsx`, and nothing ever reads the mirror back — there is
no `GET` for windows. A new browser therefore starts from `public/default-config.json`
(a July snapshot), and the first edit pushes that stale set over the real timeline
via `replaceWindows` (delete-all + insert). Everything downstream — rollups, stats,
warnings — is then recomputed against the wrong config.

Most of the rest is what the hosted layer costs *because* writes are effectively
public: a `NEXT_PUBLIC_` "secret" inlined into the bundle, blast-radius patches in
place of a login, no clear-data button, previews with no database, and a bot
commenting on every PR.

## End state

| | Today | After |
|---|---|---|
| Config source of truth | localStorage, mirrored to Turso | Turso only; browser holds an in-memory copy |
| Config reads | none from server | `GET /api/config` |
| Config writes | debounced subscription → `POST /api/rows { rows: [], windows }` | explicit `PUT /api/config` from each save action |
| Auth | shared header whose value is inlined in the bundle | single password → signed httpOnly cookie, enforced in `proxy.ts` on every page and API route |
| Vercel env vars (production) | `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `APP_SHARED_SECRET`, `NEXT_PUBLIC_APP_SHARED_SECRET` | `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `APP_PASSWORD` |
| Timezone | date keys fixed in #47, but `localDateAndMin` still parses through `new Date()`, `lib/db.ts` mutates `process.env.TZ` from an `APP_TIMEZONE` production never set, and CI pins `TZ` | timestamps parsed lexically; no `APP_TIMEZONE`; CI keeps #47's four-timezone loop and drops the pin |
| Demo seeding on boot | `default-config.json` + `default-data.csv` | none; `npm run seed:dev` for local |
| Backups | daily SQL dump of `flume_rows` + `config_windows`, 90-day artifacts (#44) | the same, plus `maintenance` |
| Previews | built for every branch, no DB, bot comment on each | off (PR 0) |
| Dependabot | weekly; one PR per major | monthly; one grouped PR for minor + patch, one for majors; security updates unchanged |

PRs are numbered as first planned; PR 4 is kept as a heading so the numbers in
older notes still line up. Auth goes before config so the new write path is
protected the day it exists.

---

## PR 0 — Turn the noise down (no app code) — *this PR*

**Vercel dashboard** — Project → Settings → Git → **Silence GitHub comments** → on.
Not expressible in the repo any more (`"github": { "silent": true }` still works but
is documented as deprecated), so it is recorded in RUNBOOK's new *Settings that live
outside this repository* table, alongside the env vars, the ruleset's required
checks, and the Actions secrets.

**`vercel.json`** — stop building previews:
```json
"git": { "deploymentEnabled": { "**": false, "main": true } }
```
Patterns are minimatch and a branch matching any `true` rule deploys, so only `main`
does. Validated against `https://openapi.vercel.sh/vercel.json`. Previews never had
database variables, so each one was a build whose API routes failed; the `e2e` job
(a real `next build` against a throwaway SQLite file) already checks the built app
before merge. Verify on this PR itself: no new Vercel deployment for its head commit.

**`.github/dependabot.yml`** — npm and actions move to `monthly`. npm gains a
`majors` group next to `minor-and-patch`, so there are at most two version PRs a
month. Majors are grouped, **not ignored**: `ignore` is honoured by security updates
too, so ignoring majors would also block a security fix that needs one. #50–#53 can
be closed; the next monthly run folds whatever is still outstanding into one PR.

**Docs** — RUNBOOK gains the settings table, loses the "previews have no database"
limit, and lists `audit` among the required checks; TECHNICAL_DESIGN's ruleset
paragraph and preview paragraph are corrected.

**Housekeeping** — `data/sprinkler-config-2026-06-03.json` deleted (unreferenced;
`…06-06.json` is a test fixture, `…08-31.json` is the E2E seed).

**Not done, deliberately:** the leftover directories under `.claude/worktrees/`.
Three point at a `//wsl.localhost/...` gitdir that git cannot resolve, so there is
no way to confirm they hold no uncommitted work; the fourth is a live worktree for
the merged #47. They are the owner's call.

---

## PR 1 — A real login

One env var, no session table, no user model. The cookie value is derived from the
password, so rotating the password logs every device out.

### New files

**`lib/server/session.ts`**
```ts
import { createHmac, timingSafeEqual } from "node:crypto"
import { isDeployed } from "./env"

export const COOKIE = "sf_session"
const MAX_AGE = 60 * 60 * 24 * 30 // 30 days

// Auth is enforced whenever APP_PASSWORD is set, and refused outright on a
// deployment where it is not. Local dev and tests leave it unset and stay open,
// which is the same fail-closed shape lib/server/auth.ts had.
export function authMode(): "open" | "enforced" | "refuse" {
  if (process.env.APP_PASSWORD) return "enforced"
  return isDeployed() ? "refuse" : "open"
}

const digest = (secret: string, msg: string) => createHmac("sha256", secret).update(msg).digest()
const safeEq = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b)

export function sessionToken(): string {
  return digest(process.env.APP_PASSWORD!, "sprinklerfun-session-v1").toString("hex")
}
export function passwordMatches(candidate: string): boolean {
  // Hash both sides so the comparison is constant-time regardless of length.
  return safeEq(digest("pw", candidate), digest("pw", process.env.APP_PASSWORD ?? ""))
}
export function tokenIsValid(token: string | undefined): boolean {
  if (!token) return false
  return safeEq(Buffer.from(token, "hex"), Buffer.from(sessionToken(), "hex"))
}
export const cookieOptions = () => ({
  httpOnly: true, sameSite: "lax" as const, path: "/", maxAge: MAX_AGE,
  secure: isDeployed(),
})
```

**`proxy.ts`** (project root — Next 16 renamed `middleware` to `proxy`; it always
runs on the Node runtime, and a `runtime` export there throws):
```ts
import { NextResponse, type NextRequest } from "next/server"
import { authMode, tokenIsValid, COOKIE } from "@/lib/server/session"

export function proxy(req: NextRequest) {
  const mode = authMode()
  if (mode === "open") return NextResponse.next()
  const isApi = req.nextUrl.pathname.startsWith("/api/")
  if (mode === "refuse") {
    return isApi
      ? Response.json({ error: "APP_PASSWORD is not set" }, { status: 503 })
      : new Response("APP_PASSWORD is not set on this deployment", { status: 503 })
  }
  if (tokenIsValid(req.cookies.get(COOKIE)?.value)) return NextResponse.next()
  if (isApi) return Response.json({ error: "unauthorized" }, { status: 401 })
  const login = new URL("/login", req.nextUrl)
  login.searchParams.set("next", req.nextUrl.pathname)
  return NextResponse.redirect(login)
}

// Everything except: static assets, the login page + route, and the health probe.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|login|api/login|api/health).*)"],
}
```

**`app/api/login/route.ts`** — `POST { password }` → `passwordMatches` →
`(await cookies()).set(COOKIE, sessionToken(), cookieOptions())` → `{ ok: true }`;
wrong password → 401. **`DELETE`** clears the cookie (`maxAge: 0`). `cookies()` is
async in this Next version.

**`app/login/page.tsx`** — one password field, posts to `/api/login`, on success
`router.replace(searchParams.next ?? "/")`. Reuse `Input`/`Button`/`Card`.

**`components/Navbar.tsx`** — a "Log out" item that `DELETE`s `/api/login` and goes
to `/login`. Hidden when `GET /api/config` (PR 2) reports `authMode === "open"`; until
then, always shown.

### Removed
- `lib/server/auth.ts`, `lib/__tests__/auth.test.ts` (replaced by `session.test.ts`).
- `x-sprinkler-secret` handling in `app/api/rows/route.ts` (the proxy now guards it).
- `SECRET` / `authHeaders()` in `lib/backend.ts`.
- `APP_SHARED_SECRET`, `NEXT_PUBLIC_APP_SHARED_SECRET` from `.env.example`, Vercel,
  RUNBOOK's settings table, and all docs.

### Tests
- `lib/__tests__/session.test.ts`: open/enforced/refuse matrix; token round-trip;
  wrong password rejected; `tokenIsValid(undefined)` false.
- `lib/__tests__/routes.test.ts`: drop the secret-header cases (auth is no longer
  the route's job); add `api/login` cases.
- E2E: `playwright.config.ts` `webServer.env` sets `APP_PASSWORD: "e2e"`. Add a
  `login(page)` helper that `page.request.post("/api/login", …)` so the page and its
  request context share the cookie jar. Add: unauthenticated `/` → redirect to
  `/login`; unauthenticated `/api/rollup` → 401; `/api/health` → 200 without a cookie.
- `scripts/verify-prod.ts`: read `SPRINKLER_PASSWORD`, log in, send the cookie.
- `backup.yml` is unaffected — it reads the database directly, not through the app.

### Deploy steps (runbook)
1. `vercel env add APP_PASSWORD production` — a long random string from a password
   manager, not something typed.
2. `vercel env rm APP_SHARED_SECRET production`, same for `NEXT_PUBLIC_APP_SHARED_SECRET`.
3. Merge. Confirm `/` redirects to `/login`, `/api/health` is 200, log in from the
   phone and the desktop.

---

## PR 2 — Config lives on the server

### API

**`app/api/config/route.ts`**
- `GET` → `{ windows, maintenance, authMode }`. `windows` from `readWindows()`,
  `maintenance` from a new `readMaintenance()`.
- `PUT { windows, maintenance }` → validate every window with the existing
  `isConfigWindow` (move it to `lib/server/validate.ts`), require `windows.length ≥ 1`
  (there is no legitimate "delete every window" — keep the footgun closed),
  `replaceWindows` + `replaceMaintenance` in **one** `db.batch`, then
  `recomputeRollups(bounds)` + `recomputeStats()`, then return the same shape as `GET`.
  Whole-document replace is deliberate: the config is a few KB, it is edited as a
  unit, and it matches what `replaceWindows` already does.

**`app/api/rows/route.ts`** — body is `{ rows }` only; a `windows` field is rejected
with 400 so an old client fails loudly rather than silently. Ingest reads windows
from the DB for the recompute (it already does, via `recomputeRollups`).

**`lib/server/data.ts`** — add `readMaintenance()` / `replaceMaintenance()` against
the `maintenance` table that `ensureSchema` already creates. No schema change.

**`scripts/backup.ts`** — add `maintenance` to `TABLES`. It becomes server-owned
state in this PR, so it becomes something worth restoring.

### Client

**`lib/backend.ts`** — add `fetchConfig()` and `saveConfig(doc)`; delete
`syncWindows`. Every fetch helper: on a 401, `location.assign("/login?next=…")` so
an expired cookie is one redirect, not a page of empty charts.

**`lib/store.ts`** — remove `persist`, `createJSONStorage`, `partialize`, `migrate`,
`onRehydrateStorage`, `skipHydration`. State:
```ts
{ windows, maintenance, loaded: boolean, serverVersion, rowCount, lastRowDate }
```
Every mutating action (`addWindowFromDate`, `updateWindow`, `deleteWindow`,
`copyBaselinesForward`, `setStationMaintenance`, `replaceAll` for import) computes
`next` exactly as today, then goes through one helper:
```ts
async function commit(next: { windows; maintenance }) {
  const saved = await saveConfig(next)        // PUT; throws on !ok
  set({ ...saved, serverVersion: get().serverVersion + 1 })
}
```
On failure: `toast.error`, state unchanged. The actions become `async` and return
the promise; callers already treat save as an explicit step (Config page "Save
window", "Review & Save" modal), so the UI change is a spinner on those buttons.
`toWindows`/`migrateConfig` stay in `lib/types.ts` — still needed by import and by
`readWindows` (defensive normalisation of whatever is in the table).

**`components/StoreProvider.tsx`** shrinks to: on mount, `fetchConfig()` +
`fetchStats()` → `set({ windows, maintenance, loaded: true, rowCount, lastRowDate })`.
No seeding, no subscription, no debounce, no `setTimeout(…, 0)`.

**`app/config/page.tsx`**
- `hydrated` (`useSyncExternalStore` on `persist`) → `useStore(s => s.loaded)`.
- `ExportImportCard.applyBundle` → `replaceAll(toWindows(bundle), bundle.maintenance ?? {})`.
  Export bundle becomes `{ version: 3, exportedAt, windows, maintenance }`; import
  still accepts v1/v2 through `toWindows`.
- Drop the copy that tells the user to commit `public/default-config.json`.
- The "Stored data" card gets a **Clear all data** button back: `DELETE /api/rows`
  returns, behind the login, with a typed confirmation ("type DELETE"). This is
  what the login buys.

**Pages** (`app/page.tsx`, `analysis`, `day/[date]`): no change to how they read
`windows`; they gate on `loaded` instead of rendering against `[]` first.

### Delete
- `public/default-config.json`, `public/default-data.csv`, and the `csvPath` write
  in `scripts/make-fixtures.ts`.
- `lib/__tests__/store.test.ts` persist-migration cases; the action tests mock
  `saveConfig` to echo its input.

### Add
- `scripts/seed-dev.ts` (`npm run seed:dev`): logs in if `APP_PASSWORD` is set,
  `PUT /api/config` from `data/sprinkler-config-2026-08-31.json`, `POST /api/rows`
  from `data/fixture-sprinkler-day.json`. E2E's `seed()` does the same two calls.

### Tests
- `routes.test.ts`: `GET/PUT /api/config` (round-trip, rejects `windows: []`,
  rejects a malformed window, recomputes rollups after a PUT), `POST /api/rows`
  rejects a `windows` field.
- E2E: after `seed()`, open the Config page in a **fresh browser context** and assert
  it shows the seeded window — this is the exact bug class being fixed.

### Migrating the live config (runbook, one time)
1. Before merging, in the browser that has the *good* config: Config → Export JSON.
   Keep the file.
2. Merge and deploy. Log in. If the Config page already shows the right windows,
   Turso's copy was good — done. If not: Config → Import from file.
3. Verify: open the app in a second browser; the same windows appear without
   touching anything.

---

## PR 3 — Finish the timezone work

#47 fixed the date *keys* (`localDateKey` replaced six UTC `toISOString()` slices)
and runs the suite under UTC, UTC+14, UTC−11 and UTC+5:30. What is left is the
parsing side and the machinery that was meant to paper over it.

**`lib/analyze.ts`** `localDateAndMin` — Flume's export is timezone-naive
(`2026-08-22 00:00:00`) and everything downstream wants "minute of the local day",
so parse the string instead of round-tripping it through `new Date()`:
```ts
const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/.exec(datetime)
return { date: m[1], rowMin: Number(m[2]) * 60 + Number(m[3]) }
```
Today the server (UTC on Vercel) and the browser (Pacific) can disagree: on the
spring-forward day a naive `02:30` does not exist locally, and the browser's
`new Date()` moves it to 03:30, so the client-side day views attribute that hour
differently from the server's rollups. A lexical parse is identical everywhere.

**`app/api/rows/route.ts`** — `DATETIME_RE` rejects a `Z` or `±HH:MM` suffix with a
message saying why. If Flume ever changes format, ingest says so instead of every
rollup silently shifting.

**Delete** the `APP_TIMEZONE` → `process.env.TZ` block in `lib/db.ts`, the top-level
`TZ: America/Los_Angeles` in `.github/workflows/ci.yml` (keep #47's loop — it is the
proof), the timezone section of `.env.example`, RUNBOOK's `APP_TIMEZONE` limit, and
TECHNICAL_DESIGN's timezone section.

`currentConfig()` still takes "today" from the server clock, which on Vercel is UTC
— up to eight hours ahead of Pacific in the evening. Acceptable; record it in
TECHNICAL_DESIGN's limitations table.

---

## PR 4 — Backups — *already done in #44*

Daily at 09:15 UTC, `scripts/backup.ts` dumps `flume_rows` and `config_windows` to
gzipped SQL, uploaded as a 90-day artifact, using a read-only database token. It
fails loudly on an empty or undersized dump, a restore drill was recorded in the PR,
and the job has succeeded every day since. RUNBOOK documents both recovery paths.

SQL was chosen over JSON on purpose — a `.sql` file restores with
`turso db shell <db> < file.sql` and needs nothing from this repository. The first
draft of this plan proposed JSON plus a restore script; that is worse, because it
makes recovery depend on the thing being recovered.

Remaining: `maintenance` joins `TABLES` in PR 2. One caveat for RUNBOOK: in a public
repository, GitHub disables scheduled workflows after 60 days with no repository
activity. Dependabot's monthly PRs probably keep it alive, but if nothing has merged
for two months, check **Actions → Backup**.

---

## PR 5 — Docs that match the code

- **`README.md`**: line 3 ("No backend, no accounts — everything runs in the
  browser") and the tech-stack table are wrong today. Rewrite the top to: hosted on
  Vercel, data in Turso, one password. Keep the weekly check-in. Turn "Saving your
  config to git" into a note that export is for your own records, not for the app.
- **`docs/TECHNICAL_DESIGN.md`**: remove the phase narrative, the `GET`/`DELETE
  /api/rows` entries, the `useDeferredValue` section, the localStorage/persist
  material, and the deployment gotchas that no longer apply. Describe the routes as
  they are. Target: half the length.
- **`SECURITY.md`**: reads and writes now require a login. Say what the password
  protects and what it does not (no rate limiting beyond Vercel's firewall; a long
  random password is the mitigation). Keep the backups row and the "historical data
  in git" section.
- **`docs/RUNBOOK.md`**: extend rather than replace — #44's backup and restore
  sections and PR 0's settings table stay. Add the sections marked *new* below.
- **Comments** that say "Phase 1", "dual-write", "Phase 3" (`lib/backend.ts`,
  `lib/db.ts`, `lib/server/data.ts`, `lib/store.ts`, pages): delete the history, keep
  the invariant. `backup.ts` and `backup.yml` justify themselves with "publicly
  writable by choice"; after PR 1 the reason is "recovery beyond Turso's 24-hour PITR".
- **`.env.example`**: three variables.

### `docs/RUNBOOK.md` — target outline

```
# Runbook
## The thing to internalise                (code rollback ≠ data restore — keep)
## Weekly check-in                          new: log in → Config → Upload CSV → Dashboard
## Logging in / rotating the password       new: vercel env add APP_PASSWORD → redeploy;
                                                 every device is logged out
## Rolling back a bad deploy                (keep)
## Restoring data                           (keep, from #44)
## Backups                                  (keep, from #44; add the 60-day caveat)
## Clearing data                            rewrite: the button, and what it does not touch
## When the config looks wrong              new: Export what you see; compare with the
                                                 latest backup; Import the good one. The
                                                 server is the only copy.
## Schema changes                           (keep)
## Local development                        new: npm run dev; npm run seed:dev; no env vars
## Settings that live outside this repo     (from PR 0)
## Known operational limits                 (keep; drop APP_TIMEZONE after PR 3)
```

---

## Deferred, deliberately

- **Incremental recompute.** `recomputeStats()` re-enriches the whole table per
  write. At ~175k rows it is fast and the code is simple; making it incremental adds
  state to get wrong. Revisit when a write takes more than a few seconds.
- **`app/design/page.tsx`** (672 lines, linked from About). Behind the login after
  PR 1; harmless. Delete if it ever needs maintenance.
- **CSP.** Still needs a nonce; still a separate change.

## Order and effort

| PR | Risk | Size |
|---|---|---|
| 0 noise | none | this PR + one dashboard toggle |
| 1 login | low — fail-closed; E2E covers it | ~250 lines, mostly new |
| 2 config | **the one that matters**; migration is manual and reversible via export | ~400 changed, ~300 deleted |
| 3 timezone | low — pure function; the four-timezone loop proves it | ~40 changed, ~40 deleted |
| 4 backups | — | done in #44 |
| 5 docs | none | prose |
