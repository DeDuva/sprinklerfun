/**
 * The CI `audit` gate: `npm audit` at high severity, with named, expiring exceptions.
 *
 * Run with:  npm run audit
 *
 * Why this exists
 * ---------------
 * `npm audit --audit-level=high` has no way to accept one advisory. When an advisory
 * has no fixed version anywhere (GHSA-vfj7-8cjw-p6xm: `braces <= 3.0.3`, and 3.0.3 is
 * the latest release), the plain command blocks every PR until upstream ships, and
 * the only other lever, `--omit=dev`, stops checking dev tooling altogether.
 *
 * The rules
 * ---------
 * 1. Production dependencies get no exceptions: any high or critical advisory in
 *    `npm audit --omit=dev` fails.
 * 2. In the full tree, every high or critical *advisory* fails unless it is listed in
 *    EXCEPTIONS. Packages that are only flagged because they depend on an excepted
 *    advisory (micromatch, fast-glob, ...) are not advisories and are not counted.
 * 3. An exception past its `reviewBy` date fails, so it cannot outlive the reason
 *    for it unnoticed.
 * 4. An exception that no longer matches anything prints a warning: delete it.
 */
import { execFileSync } from "node:child_process"

type Exception = { id: string; reason: string; reviewBy: string }

const EXCEPTIONS: Exception[] = [
  {
    id: "GHSA-vfj7-8cjw-p6xm",
    reason:
      "braces <= 3.0.3 stack-exhaustion DoS; no patched version exists. Reaches us only " +
      "through dev tooling (eslint-config-next, shadcn CLI) via micromatch/fast-glob.",
    reviewBy: "2027-01-18",
  },
]

const BLOCKING = new Set(["high", "critical"])

type Advisory = { url: string; title: string; name: string; severity: string; range: string }
type AuditJson = { vulnerabilities?: Record<string, { via: Array<string | Advisory> }> }

function audit(args: string[]): AuditJson {
  // npm audit exits non-zero whenever it finds anything; the JSON is still on stdout.
  try {
    return JSON.parse(execFileSync("npm", ["audit", "--json", ...args], { encoding: "utf8" }))
  } catch (err) {
    const stdout = (err as { stdout?: string }).stdout
    if (!stdout) throw err
    return JSON.parse(stdout)
  }
}

function blockingAdvisories(report: AuditJson): Map<string, Advisory> {
  const found = new Map<string, Advisory>()
  for (const vuln of Object.values(report.vulnerabilities ?? {})) {
    for (const via of vuln.via) {
      if (typeof via === "string") continue // propagated through another package
      if (BLOCKING.has(via.severity)) found.set(via.url.split("/").pop()!, via)
    }
  }
  return found
}

const describe = (id: string, a: Advisory) => `${id} ${a.severity} ${a.name} ${a.range}: ${a.title}`

let failed = false
const today = new Date().toISOString().slice(0, 10)

const prod = blockingAdvisories(audit(["--omit=dev"]))
for (const [id, a] of prod) {
  console.error(`::error::production dependency, no exceptions: ${describe(id, a)}`)
  failed = true
}

const full = blockingAdvisories(audit([]))
const excepted = new Map(EXCEPTIONS.map((e) => [e.id, e]))
for (const [id, a] of full) {
  const exception = excepted.get(id)
  if (!exception) {
    console.error(`::error::${describe(id, a)}`)
    failed = true
  } else if (today > exception.reviewBy) {
    console.error(`::error::exception for ${id} passed its review date ${exception.reviewBy}; re-check it`)
    failed = true
  } else {
    console.log(`accepted until ${exception.reviewBy}: ${describe(id, a)}`)
  }
}

for (const e of EXCEPTIONS) {
  if (!full.has(e.id)) console.log(`::warning::exception ${e.id} no longer matches anything; delete it`)
}

if (failed) process.exit(1)
console.log(`audit ok: ${prod.size} production, ${full.size} total high/critical advisories, all accounted for`)
