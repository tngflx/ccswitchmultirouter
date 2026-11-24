import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseExportOptions,
  runExport,
} from "./export-latest-ccswitchmulti.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccsm-export-js-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(
    path.join(root, "src-tauri", "target", "release", "bundle", "nsis"),
    { recursive: true },
  );
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ version: "3.20.4-1" }),
  );
  writeFileSync(
    path.join(root, "src-tauri", "Cargo.toml"),
    "[package]\nname='fixture'\n",
  );
  writeFileSync(
    path.join(root, "src-tauri", "target", "release", "cc-switch.exe"),
    "before__TAURI_BUNDLE_TYPE_VAR_UNKafter",
  );
  writeFileSync(
    path.join(
      root,
      "src-tauri",
      "target",
      "release",
      "bundle",
      "nsis",
      "CCSwitchMulti_3.20.4-1_x64-setup.exe",
    ),
    "installer",
  );
  return root;
}

test("export parser accepts explicit root and skip-build", () => {
  assert.deepEqual(
    parseExportOptions(["-ReleaseRoot", "D:/release", "-SkipBuild"]),
    {
      releaseRoot: "D:/release",
      skipBuild: true,
      help: false,
    },
  );
  assert.throws(
    () => parseExportOptions(["--no-typecheck"]),
    /not valid export options/,
  );
});

test("skip-build export stays entirely in Node and promotes artifacts", (t) => {
  const root = fixture(t);
  const output = path.join(root, "output", "exported");
  const calls = [];
  runExport(
    { releaseRoot: output, skipBuild: true, help: false },
    {
      repoRoot: root,
      resolveRoot: (_repo, requested) => requested,
      run: (_executable, args) => {
        calls.push(args);
        return { status: 0 };
      },
      warn() {},
      log() {},
    },
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ["catalog:verify"]);
  assert.equal(
    existsSync(
      path.join(
        output,
        "windows",
        "portable",
        "CCSwitchMulti_3.20.4-1_x64-portable.zip",
      ),
    ),
    true,
  );
  assert.equal(existsSync(path.join(output, "SHA256SUMS.txt")), true);
});
