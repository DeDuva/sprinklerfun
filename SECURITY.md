# Security

SprinklerFun is a single-household hobby app, deployed publicly and protected by a
single shared password. This file records what that does and does not buy, so
nobody — including a future version of the author — has to infer it from the code.

## Reporting

Open a GitHub issue. There is no bounty and no SLA.

## The password

Every page and every API route sits behind `proxy.ts`, which requires a session
cookie. The only exclusions are the login page, `POST /api/login`, `GET /api/health`
and Next's static output. Because the guard is one matcher rather than a check
inside each handler, a new route is protected by virtue of being new — the failure
mode where someone adds an endpoint and forgets the credential check is not
available.

**The password never reaches the browser.** `APP_PASSWORD` is server-side only; the
cookie carries an HMAC of a fixed string under it, is `httpOnly` so page scripts
cannot read it, and is `SameSite=Lax`.

This replaced an `x-sprinkler-secret` header compared against a value that had to
ship to the client as `NEXT_PUBLIC_APP_SHARED_SECRET` — inlined into a static chunk
at build time, readable by anyone who loaded the site, and replayable. That was
obfuscation, and this file used to say so. This is not.

A deployment with no `APP_PASSWORD` serves nothing: every request is refused with a
503, rather than falling open to the internet.

## What is not protected

These are accepted risks, not oversights.

- **One password, no accounts.** Everyone who has it has everything, and there is
  no record of who did what, because there is no "who".
- **A stolen cookie stays valid until the password changes.** Sessions are not
  tracked server-side, so an individual one cannot be revoked. Rotating
  `APP_PASSWORD` invalidates all of them at once — that is the log-out-everywhere
  lever, and the answer to a lost phone. See `docs/RUNBOOK.md`.
- **No rate limiting on the login.** Per-instance counters are meaningless on
  serverless (each cold start gets its own memory), and a shared store means
  adding infrastructure. The mitigation is a long random password rather than a
  lockout; Vercel's edge firewall is the realistic control if that ever changes.
- **No CSP.** See `next.config.ts` for why a permissive one would be worse than
  none.

## What is protected

The password is the front door. The controls below are what stands behind it:
blast-radius reduction and recovery, because a single credential is one mistake
away from being someone else's.

| Control | Why |
|---|---|
| One guard, applied by default | `proxy.ts` covers every route except four explicit exclusions, so protection is not a thing each new handler has to remember. |
| `DELETE /api/rows` removed | Dropped `flume_rows`, `daily_rollup`, `station_stats` and `station_warnings` in one batch. One request from unrecoverable loss, for a convenience button. |
| `GET /api/rows` removed | An unauthenticated full-database export with no date range, no limit, and no caller in the app. |
| `windows: []` no longer wipes the config timeline | `replaceWindows` is delete-all-then-insert, so `{"rows":[],"windows":[]}` destroyed months of tuning via a request that looked like a no-op. An empty array now means "no window update". |
| Ingest validated and bounded | `datetime` must match the date format the `flume_rows` index and `rowDateBounds()` depend on; `gallons` is range-checked; `rows` is capped at 200,000. Uncapped bodies amplified the full-table statistics recompute. |
| Auth fails closed on a deployment | No `APP_PASSWORD` means every request gets a 503. The previous guard returned `true` when its secret was unset, making the database anonymously writable with no symptom at all — nothing logged, nothing 500ing, the app looking perfectly healthy. |
| Missing `TURSO_DATABASE_URL` throws in production | It used to fall back to an ephemeral local file, serving an empty dataset as if it were real and discarding writes on recycle. |
| Security headers | `frame-ancestors 'none'`, `nosniff`, `strict-origin-when-cross-origin`, HSTS, `Permissions-Policy`. No CSP yet — see `next.config.ts` for why a permissive one would be worse than none. |
| Dependency scanning | Dependabot alerts, security updates, secret scanning and push protection are enabled. Actions are pinned by commit SHA. `npm audit` is at 0. |
| Daily backups | `flume_rows` and `config_windows` dumped to a 90-day artifact. Turso's free plan gives only a 24-hour PITR window, so for anything older this is the only recovery path — which is why it fails loudly on an empty or undersized dump rather than reporting success. See `docs/RUNBOOK.md`. |

## Historical data in git

Roughly fifty days of minute-resolution household water usage **were** committed to
this public repository, and `public/default-data.csv` served a copy publicly as a
static asset. At minute resolution that reveals occupancy: sleep and wake times,
showers, and multi-day absences.

The working tree no longer contains any real metered data. The fixtures and the demo
seed are generated by `scripts/make-fixtures.ts` and reproduce the *phenomena* the
tests need — a timer with no dead time, a timer with 60 s of it plus six minutes of
overrun — without reproducing anyone's household.

History has **not** been rewritten. On an already-public repository that offers
partial protection at best: clones, forks and cached objects persist. The past data
should be treated as public.

Please do not add more real data. Config snapshots are fine — they hold station names,
durations and baseline gpm, none of which identify anything.
