import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Agent scratch space. Gitignored locally, but ESLint has no idea about that
    // and was linting throwaway scripts here — noise at best, and a plugin crash
    // in one of them looks exactly like a real config failure.
    ".claude/**",
  ]),
]);

export default eslintConfig;
