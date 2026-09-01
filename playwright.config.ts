import { defineConfig, devices } from "@playwright/test"

// End-to-end against a LOCALLY BUILT app, not against a Vercel preview.
//
// Testing the preview URL would be more "real", but it would also mean the suite
// depends on a deployment existing, on the network, and on whatever data the
// shared database happens to hold — none of which should decide whether a pull
// request can merge. Building here keeps it hermetic and still exercises the
// real production bundle, which `next dev` does not.
//
// The database is the local-file fallback (lib/db.ts). Vitest is pinned to
// in-memory; this one deliberately uses a file so the server keeps state across
// requests within a run. It lives under .data/, which is gitignored.
const PORT = Number(process.env.E2E_PORT ?? 3210)

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false, // one server, one database
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  timeout: 30_000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // `npm run build` runs as a separate CI step so a build failure is reported
    // as a build failure rather than as a mysterious server timeout.
    command: `npx next start --port ${PORT}`,
    port: PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      E2E_DB: "1",
      TURSO_DATABASE_URL: `file:.data/e2e-${PORT}.db`,
    },
  },
})
