import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfigFromFile } from "vite";
import { configDefaults } from "vitest/config";

const root = fileURLToPath(new URL("../", import.meta.url));
const loaded = await loadConfigFromFile(
  { command: "serve", mode: "test" },
  path.join(root, "vitest.config.ts"),
  root,
);
const exclusions = loaded?.config.test?.exclude ?? [];

test("Vitest bounds concurrent UI suites without extending test timeouts", () => {
  assert.equal(loaded?.config.test?.maxWorkers, 4);
  assert.equal(loaded?.config.test?.minWorkers, 1);
  assert.equal(loaded?.config.test?.testTimeout, undefined);
});

test("Vitest discovery retains its default exclusions", () => {
  for (const exclusion of configDefaults.exclude) {
    assert.ok(exclusions.includes(exclusion), `${exclusion} must be excluded`);
  }
});

for (const directory of [".kilo", ".local", ".worktrees", ".tmp"]) {
  test(`Vitest discovery excludes copied test trees under ${directory}`, () => {
    assert.ok(exclusions.includes(`**/${directory}/**`));
  });
}
