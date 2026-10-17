import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setupGlobals.ts", "./tests/setupTests.ts"],
    globals: true,
    // Keep large jsdom suites from exhausting CPU and memory in parallel.
    maxWorkers: 4,
    minWorkers: 1,
    // Linked worktrees and local task snapshots carry copied test trees. They
    // are evidence/artifacts, not additional suites for the active checkout.
    exclude: [
      ...configDefaults.exclude,
      "**/.kilo/**",
      "**/.local/**",
      "**/.worktrees/**",
      "**/.tmp/**",
    ],
    coverage: {
      reporter: ["text", "lcov"],
    },
  },
});
