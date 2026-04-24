import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["**/node_modules/**", "dist/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "lcov"],
      include: ["src/api-client.ts", "src/index.ts", "src/server.ts"],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
});
