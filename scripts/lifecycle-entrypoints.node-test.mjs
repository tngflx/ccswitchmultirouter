import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptsRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptsRoot);

test("normal build, legacy cleanup, and release commands launch JavaScript directly", () => {
  const { scripts } = JSON.parse(
    readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  );
  assert.equal(scripts.build, "node scripts/local-build-pipeline.mjs");
  assert.equal(
    scripts["watchdog:uninstall"],
    "node scripts/install-ccswitchmulti-watchdog.mjs --uninstall",
  );
  for (const name of [
    "release:export",
    "release:local",
    "cache:clean",
    "release:hook:install",
  ]) {
    assert.match(scripts[name], /^node scripts\/.*\.mjs(?: --[a-z-]+)?$/u);
    assert.doesNotMatch(scripts[name], /\.ps1|pwsh|powershell/iu);
  }
});

for (const scriptName of [
  "local-build-pipeline.mjs",
  "watch-ccswitchmulti.mjs",
  "install-ccswitchmulti-watchdog.mjs",
  "local-release-pipeline.mjs",
  "cleanup-cargo-targets.mjs",
  "codex-oauth-diagnostics.mjs",
]) {
  test(`${scriptName} exposes a side-effect-free help command`, () => {
    const result = spawnSync(
      process.execPath,
      [path.join(scriptsRoot, scriptName), "--help"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        windowsHide: true,
        timeout: 30_000,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:/u);
    assert.doesNotMatch(result.stdout + result.stderr, /\.ps1|pwsh\s+-File/iu);
  });
}

test("all tracked lifecycle entry points are JavaScript files", () => {
  const source = readFileSync(path.join(repoRoot, "package.json"), "utf8");
  assert.doesNotMatch(source, /scripts\/[^"\r\n]*\.ps1/iu);
});

test("retired production run and install package aliases cannot advertise another recovery owner", () => {
  const { scripts } = JSON.parse(
    readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  );
  assert.equal(Object.hasOwn(scripts, "watchdog:run"), false);
  assert.equal(Object.hasOwn(scripts, "watchdog:install"), false);
  assert.equal(
    scripts["watchdog:legacy:inspect"],
    "node scripts/install-ccswitchmulti-watchdog.mjs --uninstall --dry-run",
  );
});
