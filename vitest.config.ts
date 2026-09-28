import path from "node:path";
import { defineConfig } from "vitest/config";
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
    // Linked worktrees carry their own tests and dependencies; keep the main
    // checkout's test run isolated from both worktree locations.
    exclude: [
      "**/.worktrees/**",
      "**/.kilo/worktrees/**",
      "**/node_modules/**",
      "**/dist/**",
    ],
    coverage: {
      reporter: ["text", "lcov"],
    },
  },
});
