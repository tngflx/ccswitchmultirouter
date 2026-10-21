import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptsRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptsRoot);

test("normal build and watchdog commands launch JavaScript directly", () => {
  const { scripts } = JSON.parse(
    readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  );
  assert.equal(scripts.build, "node scripts/local-build-pipeline.mjs");
  assert.equal(scripts["watchdog:run"], "node scripts/watch-ccswitchmulti.mjs");
  assert.equal(
    scripts["watchdog:install"],
    "node scripts/install-ccswitchmulti-watchdog.mjs",
  );
  assert.equal(
    scripts["watchdog:uninstall"],
    "node scripts/install-ccswitchmulti-watchdog.mjs --uninstall",
  );
});

const wrapperCases = [
  {
    name: "local-build-pipeline",
    arguments: ["-OutputDir", "D:\\builds\\odd 'quoted' $value & 文 output"],
  },
  {
    name: "watch-ccswitchmulti",
    arguments: [
      "-InstalledExecutable",
      "D:\\app 'quoted' $value & 文\\cc-switch.exe",
      "-Port",
      "17001",
      "-PlanOnly",
      "-DevelopmentMode",
      "-NoRestart",
    ],
  },
  {
    name: "install-ccswitchmulti-watchdog",
    arguments: [
      "-GuardianRoot",
      "D:\\guardian 'quoted' $value & 文",
      "-TaskName",
      "fixture $name & 文",
      "-NoStart",
    ],
  },
];

for (const fixture of wrapperCases) {
  test(
    `${fixture.name} compatibility entry preserves argument boundaries`,
    { skip: process.platform !== "win32" },
    () => {
      const fixtureRoot = mkdtempSync(
        path.join(os.tmpdir(), "ccsm-js-wrapper-"),
      );
      try {
        const wrapperPath = path.join(fixtureRoot, `${fixture.name}.ps1`);
        copyFileSync(
          path.join(scriptsRoot, `${fixture.name}.ps1`),
          wrapperPath,
        );
        writeFileSync(
          path.join(fixtureRoot, `${fixture.name}.mjs`),
          "process.stdout.write(JSON.stringify(process.argv.slice(2)))\n",
        );
        const child = spawnSync(
          "pwsh.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-File",
            wrapperPath,
            ...fixture.arguments,
          ],
          {
            encoding: "utf8",
            windowsHide: true,
            timeout: 15000,
          },
        );
        assert.equal(child.error, undefined);
        assert.equal(child.status, 0, child.stderr);
        assert.deepEqual(JSON.parse(child.stdout), fixture.arguments);
        const help = spawnSync(
          "pwsh.exe",
          ["-NoProfile", "-NonInteractive", "-File", wrapperPath, "-Help"],
          {
            encoding: "utf8",
            windowsHide: true,
            timeout: 15000,
          },
        );
        assert.equal(help.status, 0, help.stderr);
        assert.deepEqual(JSON.parse(help.stdout), ["--help"]);
      } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    },
  );
}
