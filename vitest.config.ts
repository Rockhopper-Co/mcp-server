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
      thresholds: {
        statements: 99,
        branches: 80,
        functions: 100,
        lines: 99,
      },
    },
  },
});
