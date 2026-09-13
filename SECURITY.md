# Security

SprinklerFun is a single-household hobby app, deployed publicly and protected by
Google sign-in restricted to an allow-list of addresses. This file records what
that does and does not buy, so nobody — including a future version of the author
— has to infer it from the code.

## Reporting

Open a GitHub issue. There is no bounty and no SLA.

## Signing in

Every page and every API route sits behind `proxy.ts`, which requires a session
cookie. The only exclusions are the sign-in page, the `/api/auth` endpoints,
`GET /api/health`, `/api/cron` (which requires its own bearer token — see the
table below) and Next's static output. Because the guard is one matcher
rather than a check inside each handler, a new route is protected by virtue of
being new — the failure mode where someone adds an endpoint and forgets the
credential check is not available.

The `/api/auth` endpoints have to be anonymous: the callback is where Google
sends the browser back, and nobody holds a session at that moment.

**Identity and authorisation are separate.** Google says *who* you are;
`ALLOWED_EMAILS` decides whether that person gets in. Anyone with a Google
account can complete the sign-in and still be refused, which is the normal case
for a household app on the public internet.

**Nothing secret reaches the browser.** The client ID is public by design, the
client secret and `SESSION_SECRET` are server-side only, and the cookie carries
a signed `{ email, exp }` — `httpOnly`, `SameSite=Lax`, seven days. It is a
signed cookie rather than a JWT because there is one issuer, one audience and no
third party parsing it; `node:crypto` covers that without a dependency.

**The allow-list is re-checked on every request**, not just at sign-in. Removing
an address revokes that person on their next click. The app this flow was
modelled on checks only at sign-in, which means a removed user keeps access
until their cookie expires a week later.

**CSRF and code interception are handled.** The flow carries a `state` value in
an httpOnly cookie and compares it on return, so the callback will not accept a
code from a flow this browser did not start — without it, an attacker can
complete sign-in inside a victim's browser and leave them authenticated as
someone else. PKCE (S256) means an intercepted authorization code is useless
without the verifier, which never leaves the server. Unverified Google addresses
are refused outright.

Two credentials ago this app compared an `x-sprinkler-secret` header against a
value that had to ship to the client as `NEXT_PUBLIC_APP_SHARED_SECRET` —
inlined into a static chunk at build time, readable by anyone who loaded the
site, and replayable. Then it was one shared password. Each step removed a thing
that had to be known by everyone who needed access.

A deployment without `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and
`SESSION_SECRET` serves nothing: every request is refused with a 503, rather
than falling open to the internet. A partial configuration counts as none.

## What is not protected

These are accepted risks, not oversights.

- **No per-user identity inside the app.** Sign-in knows who you are, but
  everyone admitted sees and edits the same household data, and nothing records
  who changed what. The allow-list is an access decision, not an audit trail.
- **A stolen cookie is valid until it expires or the address is removed.**
  Sessions are not tracked server-side, so a single one cannot be cancelled.
  There are two levers: take the address out of `ALLOWED_EMAILS`, which takes
  effect on that person's next request, or rotate `SESSION_SECRET`, which signs
  everyone out at once. A lost phone is the first one.
- **Trust is delegated to Google.** Whoever controls an allow-listed Google
  account controls that access, so those accounts' own 2FA is part of this app's
  security. If Google is down, nobody can sign in — existing sessions keep
  working, since they are verified locally.
- **No rate limiting of our own.** Google rate-limits the sign-in itself, which
  is where the guessing would happen; per-instance counters are meaningless on
  serverless anyway. Vercel's edge firewall is the realistic control beyond that.
- **No CSP.** See `next.config.ts` for why a permissive one would be worse than
  none.

## What is protected

Google sign-in is the front door. The controls below are what stands behind it:
blast-radius reduction and recovery, because a single credential is one mistake
away from being someone else's.

| Control | Why |
|---|---|
| One guard, applied by default | `proxy.ts` covers every route except the sign-in page, the `/api/auth` endpoints, `GET /api/health` and `/api/cron`, so protection is not a thing each new handler has to remember. Reads are guarded exactly as writes are. |
| The cron path has its own door | `/api/cron` is outside the session guard because Vercel invokes it with a plain GET carrying no session. It requires `CRON_SECRET` as a bearer token and **fails closed** when that is unset — an unauthenticated one would be a public trigger for a full ingest and a whole-table recompute, which is a cost lever as much as a data one. The `vercel-cron/1.0` user agent and `x-vercel-cron-schedule` header are deliberately *not* treated as proof: both are ordinary headers anyone can send. |
| The Flume account password never reaches the deployment | Flume needs it for exactly one thing: the initial OAuth2 password grant that mints a refresh token. That runs on the operator's own machine (`npm run flume:connect`), which prints the token and writes nothing. The server only ever uses `grant_type=refresh_token` with the client id and secret. A refresh token is the better credential to hold: scoped to API access, revocable on its own, and worthless on any other site — whereas an account password may be reused elsewhere and cannot be revoked without changing it everywhere. |
| The stored refresh token is kept out of the backups | It lives in a one-row `flume_state` table that `scripts/backup.ts` deliberately omits. The dumps become 90-day GitHub artifacts, and a live credential has no business in an archive — especially one that can be re-minted in a minute. |
| The config has one owner | It lives in Turso and is read and written only through `GET`/`PUT /api/config`. It used to live in `localStorage` with a write-only mirror nothing read back, so a second browser could overwrite the real timeline with a stale bundled snapshot. |
| `DELETE /api/rows` is behind the login **and** a typed confirmation | It drops `flume_rows` and the three derived tables in one batch. It was removed outright while the only thing guarding it was a secret published in this page's own JavaScript; it came back once the guard was a real session, and the button stays inert until you type `DELETE`. It leaves `config_windows` and `maintenance` alone — re-uploading meter history should not cost a season of tuning. |
| `GET /api/rows` removed | An unauthenticated full-database export with no date range, no limit, and no caller in the app. |
| The config timeline cannot be emptied through the API | `replaceWindows` is delete-all-then-insert, so `{"rows":[],"windows":[]}` once destroyed months of tuning through a request that read as a no-op. `POST /api/rows` now rejects a `windows` field outright, and `PUT /api/config` refuses an empty timeline: the earliest window also covers every row before it, so an empty one would leave the entire history unattributable. |
| Ingest validated and bounded | `datetime` must match the date format the `flume_rows` index and `rowDateBounds()` depend on; `gallons` is range-checked; `rows` is capped at 200,000. Uncapped bodies amplified the full-table statistics recompute. |
| Auth fails closed on a deployment | Missing — or partially set — Google credentials mean every request gets a 503. An early guard returned `true` when its secret was unset, making the database anonymously writable with no symptom at all: nothing logged, nothing 500ing, the app looking perfectly healthy. |
| An empty allow-list admits nobody | The tempting reading of "no list configured" is "allow everyone", which would hand the database to any Google account the moment one variable went missing. It denies instead. |
| Missing `TURSO_DATABASE_URL` throws in production | It used to fall back to an ephemeral local file, serving an empty dataset as if it were real and discarding writes on recycle. |
| Security headers | `frame-ancestors 'none'`, `nosniff`, `strict-origin-when-cross-origin`, HSTS, `Permissions-Policy`. No CSP yet — see `next.config.ts` for why a permissive one would be worse than none. |
| Dependency scanning | Dependabot alerts, security updates, secret scanning and push protection are enabled. Actions are pinned by commit SHA. `npm audit` is at 0. |
| Daily backups | `flume_rows`, `config_windows` and `maintenance` dumped to a 90-day artifact. Turso's free plan gives only a 24-hour PITR window, so for anything older this is the only recovery path — which is why it fails loudly on an empty or undersized dump rather than reporting success. See `docs/RUNBOOK.md`. |

## Historical data in git

Roughly fifty days of minute-resolution household water usage **were** committed to
this public repository, and a copy was served publicly as a static asset from
`public/`. At minute resolution that reveals occupancy: sleep and wake times,
showers, and multi-day absences.

Nothing is served from `public/` any more: the app no longer seeds itself from a
bundled config or CSV, because the server is now the only place either lives.

The working tree no longer contains any real metered data. The fixtures and the demo
seed are generated by `scripts/make-fixtures.ts` and reproduce the *phenomena* the
tests need — a timer with no dead time, a timer with 60 s of it plus six minutes of
overrun — without reproducing anyone's household.

History has **not** been rewritten. On an already-public repository that offers
partial protection at best: clones, forks and cached objects persist. The past data
should be treated as public.

Please do not add more real data. Config snapshots are fine — they hold station names,
durations and baseline gpm, none of which identify anything.
