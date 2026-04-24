import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/__tests__/e2e/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "lcov"],
      include: ["src/**"],
      exclude: [
        "src/__tests__/**",
        "src/types.ts",
      ],
      thresholds: {
        statements: 95,
        branches: 75,
        functions: 90,
        lines: 95,
      },
    },
  },
});
