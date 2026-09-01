import { rmSync } from "node:fs"

// Each run starts from an empty database.
//
// The suite shares one server and one SQLite file across tests, so without this
// a second run sees the previous run's rows — and any assertion about what a
// write actually inserted becomes order-dependent. That is precisely the bug
// this file was added to fix: `insertRows` is INSERT OR IGNORE, so re-seeding
// returned 0 and a passing test started failing on the second run.
export default function globalSetup() {
  const port = process.env.E2E_PORT ?? "3210"
  for (const suffix of ["", "-shm", "-wal"]) {
    rmSync(`.data/e2e-${port}.db${suffix}`, { force: true })
  }
}
