# sprinklerfun — Roadmap

**This file is the repo's status ledger.** A PR that completes, starts, pauses, or
supersedes a milestone updates it in the same PR. Product scope lives in
[`docs/PRODUCT_DESIGN.md`](docs/PRODUCT_DESIGN.md), architecture and known limitations in
[`docs/TECHNICAL_DESIGN.md`](docs/TECHNICAL_DESIGN.md), operations in
[`docs/RUNBOOK.md`](docs/RUNBOOK.md).

## Mission

See what the sprinklers actually use: Flume water-meter data, synced daily, attributed to
irrigation stations and programs, with anomalies flagged.

## Where this fits

The one live app in the DeDuva portfolio that the owner depends on day to day (registry:
`PORTFOLIO.md` in the private `DeDuva/duva-lab-tpm`). Runs on Vercel Hobby + Turso. What
runs unattended: the daily Flume sync (Vercel cron, 17:00 UTC), the daily backup
(`backup.yml`, 09:15 UTC), and Dependabot (monthly, grouped).

## Now / Next / Later

- **Now — stopped here 2026-11-15.** Dependency hygiene only; no feature work in flight.
  - #86 rolled up every high advisory the `audit` gate had started failing on (all in dev
    tooling — production was never exposed) and retired the `braces` exception;
    superseded Dependabot #81–#85.
  - #48 moved checkout / setup-node / upload-artifact to v7; a manual `backup.yml` run
    on the new versions succeeded (artifact uploaded, 734 KB).
  - The major-version Dependabot PRs were closed: vitest 5 (#50), @vitest/ui 5 (#53),
    eslint 10 (#52), @types/node 26 (#51). Zero open PRs.
- **eslint 10 — done 2026-11-15.** `eslint` ^10.15 with `eslint-config-next` ^16.4.6; no code
  or config changes were needed (#52's 2026-09 failure was the older eslint-config-next).
  Three plugins bundled by eslint-config-next — `eslint-plugin-import` 2.32,
  `eslint-plugin-jsx-a11y` 6.10.2, `eslint-plugin-react` 7.37.5 — do not yet declare eslint
  10 in their peer range, so npm installs with "overriding peer dependency" warnings. A rule
  from each was checked to still fire. When they publish eslint-10 ranges, the warnings go.
  #52 was reopened so Dependabot's ignore of eslint 10.x is lifted, per `dependabot.yml`'s
  group-don't-ignore rule.
- **Next — deferred:** **vitest 5 + @vitest/ui 5** (#50/#53 failed every check) — migrate
  together. Dependabot will propose them again in its monthly grouped `majors` PR.
  - Keep `@types/node` on 24 while the runtime is Node 24 (`.nvmrc`, Vercel) — newer
    type majors describe APIs that don't exist at runtime.
- **Later:** the V2+ list in `docs/PRODUCT_DESIGN.md` § Future — seasonal comparison
  (self-contained); anomaly email (needs an email provider, and would be a new
  unattended sender — it needs a cost row in the portfolio registry); weather-adjusted
  baselines (needs a data-source decision); PWA. Incremental recompute stays deferred on
  the condition `docs/TECHNICAL_DESIGN.md` states: until a write takes more than a few
  seconds.
