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
      ],
      // Re-baselined for vitest 4: the v8 coverage provider's accounting
      // changed (AST-aware function/branch mapping), shifting reported
      // numbers down a fraction with no code or test change. New actuals are
      // ~98.2/77/98.2/98.6; these floors sit just under them and stay well
      // above the CI meta-gate minimums (statements 95 / branches 70 /
      // functions 90 / lines 95 — see .github/workflows/coverage.yml).
      thresholds: {
        statements: 98,
        branches: 75,
        functions: 98,
        lines: 98,
      },
    },
  },
});
