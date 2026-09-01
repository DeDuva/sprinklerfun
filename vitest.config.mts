import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    // Points the DB at an in-memory database before anything imports lib/db.
    // See the file — without it a server test writes .data/sprinkler.db.
    setupFiles: ["./lib/__tests__/setup.ts"],
    // Playwright also claims *.spec.ts, and Vitest's default glob would happily
    // load e2e/ and fail on the @playwright/test import. Each runner owns a
    // directory: Vitest lib/__tests__, Playwright e2e.
    exclude: ["**/node_modules/**", "**/dist/**", "e2e/**"],
    // A config change that matched zero test files would otherwise pass silently.
    passWithNoTests: false,
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "html", "lcov"],
      // Scoped to the logic and the API deliberately. components/ is ~2,100
      // lines of mostly chart rendering, and including it would turn the number
      // into a target — the incentive becomes rendering every component once to
      // move a percentage, rather than testing the handful of behaviours that
      // actually break. The component tests that exist pin specific regressions
      // (hook ordering across day switches, the delay/residual split, the save
      // confirmation) and are none the worse for not counting here.
      include: ["lib/**/*.ts", "app/api/**/*.ts"],
      exclude: ["lib/__tests__/**", "lib/types.ts", "**/*.d.ts"],
      // A floor, not a target. Set just under the current numbers so it catches
      // a regression without inviting tests written to move a percentage. Raise
      // it as coverage genuinely improves; do not lower it to make CI pass.
      thresholds: {
        statements: 85, // actual 87.9
        branches: 75,   // actual 78.5
        functions: 82,  // actual 84.2
        lines: 87,      // actual 90.2
      },
    },
  },
  resolve: {
    alias: {
      "@": import.meta.dirname,
    },
  },
})
