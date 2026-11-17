import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertNoPowerShellScriptPaths,
  checkRepositoryScriptPolicy,
} from "./no-powershell-scripts.mjs";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("repository ships no tracked PowerShell script files", () => {
  const output = execFileSync("git", ["ls-files", "*.ps1"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(output.trim(), "");
});

test("package and CI lifecycle commands do not invoke PowerShell script files", () => {
  const packageJson = readFileSync(path.join(repoRoot, "package.json"), "utf8");
  const workflow = readFileSync(
    path.join(repoRoot, ".github", "workflows", "check-upstream-updates.yml"),
    "utf8",
  );
  assert.doesNotMatch(
    `${packageJson}\n${workflow}`,
    /(?:pwsh|powershell)\b[^\r\n]*-File\b/iu,
  );
  assert.doesNotMatch(
    `${packageJson}\n${workflow}`,
    /scripts\/[^\r\n"']+\.ps1\b/iu,
  );
});

test("script policy rejects mixed-case PowerShell extensions including untracked sources", () => {
  for (const filename of [
    "scripts/New-Task.PS1",
    "nested/module.psm1",
    "nested/module.PSD1",
  ]) {
    assert.throws(
      () => assertNoPowerShellScriptPaths([filename]),
      /PowerShell script files/iu,
    );
  }
  assert.doesNotThrow(() =>
    assertNoPowerShellScriptPaths(["scripts/lifecycle.mjs", "src/main.rs"]),
  );
});

test("repository policy inspects non-ignored untracked inventory and bundle entrypoints", () => {
  assert.throws(
    () =>
      checkRepositoryScriptPolicy({
        repoRoot,
        listFiles: () => ["scripts/forgotten.Ps1"],
      }),
    /forgotten.Ps1/iu,
  );
  assert.throws(
    () =>
      checkRepositoryScriptPolicy({
        repoRoot,
        listFiles: () => [".github/workflows/fixture.yml"],
        readText: () => "run: pwsh -File scripts/forgotten.ps1",
      }),
    /PowerShell script entrypoint/iu,
  );
  assert.throws(
    () =>
      checkRepositoryScriptPolicy({
        repoRoot,
        listFiles: () => ["src-tauri/wix/fixture.wxs"],
        readText: () => '<File Source="generated.PS1"/>',
      }),
    /PowerShell script entrypoint/iu,
  );
});

test("repository policy passes for the current source tree", () => {
  assert.doesNotThrow(() => checkRepositoryScriptPolicy({ repoRoot }));
});
