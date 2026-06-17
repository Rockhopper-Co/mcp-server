import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["**/node_modules/**", "dist/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "lcov"],
      include: ["src/**"],
      exclude: [
        "src/__tests__/**",
        "src/types.ts",
        // Non-JS resources: vitest 4's Rolldown-based coverage instrumentation
        // tries to parse every `src/**` file. The orchestration-guide markdown
        // resource (loaded at runtime via readFileSync, not imported) is not JS
        // and triggers `RolldownError: Parse failed`. Exclude all markdown.
        "src/**/*.md",
      ],
      // Re-baselined for vitest 4: the v8 coverage provider's accounting
      // changed (AST-aware statement/function/branch mapping), shifting
      // reported numbers down a fraction with no code or test change. CI's
      // exact accounting lands statements at ~97.93 (locally ~98.15); this
      // floor sits just under the CI actual with margin and stays well above
      // the CI meta-gate minimums (statements 95 / branches 70 / functions 90
      // / lines 95 — see .github/workflows/coverage.yml).
      thresholds: {
        statements: 97,
        branches: 75,
        functions: 98,
        lines: 98,
      },
    },
  },
});
