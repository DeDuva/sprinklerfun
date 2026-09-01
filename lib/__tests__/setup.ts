// Vitest global setup. Runs before any test module is imported, which is the
// only window in which this is useful: lib/db.ts reads TURSO_DATABASE_URL on the
// first getDb() call and then memoizes the client on globalThis, so setting it
// from inside a test is too late.
//
// The danger this exists to remove: lib/db.ts falls back to
// `file:.data/sprinkler.db`, RELATIVE TO process.cwd(). A server test written
// without an override would quietly open — and write — the developer's actual
// dev database. Pointing at an in-memory DB here means that cannot happen by
// accident, and the assertion below means it cannot happen by misconfiguration
// either.

process.env.TURSO_DATABASE_URL = "file::memory:"
delete process.env.TURSO_AUTH_TOKEN

// Neither VERCEL nor VERCEL_ENV should be set in a test run; if a developer has
// them exported, the fail-closed guards in lib/server/auth.ts and lib/db.ts
// would change behaviour under test for no good reason.
delete process.env.VERCEL
delete process.env.VERCEL_ENV

if (!process.env.TURSO_DATABASE_URL.includes(":memory:")) {
  throw new Error(
    `Refusing to run tests against ${process.env.TURSO_DATABASE_URL}. ` +
      "The suite writes to the database it is pointed at."
  )
}
