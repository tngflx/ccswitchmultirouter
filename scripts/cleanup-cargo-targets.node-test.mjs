import assert from "node:assert/strict";
import {
  mkdirSync,
  symlinkSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertCargoTargetPath,
  cleanupCargoCache,
  findStaleCargoTargetDirectories,
  hasActiveCargoBuild,
  parseCleanupOptions,
  parseRegisteredWorktreeRoots,
  removeCargoTargetDir,
} from "./cleanup-cargo-targets.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccsm-cache-js-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeDirectory(
  root,
  relative,
  { old = true, now = new Date("2026-09-09T18:00:00Z") } = {},
) {
  const target = path.join(root, relative);
  mkdirSync(target, { recursive: true });
  if (old) {
    const timestamp = new Date(now.getTime() - 8 * 60 * 60 * 1000);
    utimesSync(target, timestamp, timestamp);
  }
  return target;
}

test("parses registered worktree paths without splitting spaces", () => {
  const roots = parseRegisteredWorktreeRoots([
    "worktree C:/workspace/cc-switch",
    "HEAD 111",
    "",
    "worktree C:/workspace/feature worktree",
  ]);
  assert.equal(roots.length, 2);
  assert.equal(roots[1], path.resolve("C:/workspace/feature worktree"));
});

test("parses PowerShell-compatible cleanup options", () => {
  assert.deepEqual(
    parseCleanupOptions([
      "-RepoRoot",
      "C:/workspace/cc-switch",
      "-MinimumAgeHours",
      "12.5",
      "-DryRun",
    ]),
    {
      repoRoot: "C:/workspace/cc-switch",
      minimumAgeHours: 12.5,
      dryRun: true,
    },
  );
  assert.deepEqual(parseCleanupOptions(["--dry-run"], { environment: {} }), {
    repoRoot: "",
    minimumAgeHours: 6,
    dryRun: true,
  });
  assert.throws(
    () => parseCleanupOptions(["--minimum-age-hours", "-1"]),
    /zero or greater/,
  );
  assert.throws(() => parseCleanupOptions(["--repo-root"]), /Missing value/);
});

test("discovers only stale supported target shapes", (t) => {
  const root = fixture(t);
  const now = new Date("2026-09-09T18:00:00Z");
  const expected = [
    makeDirectory(root, "src-tauri/target", { now }),
    makeDirectory(root, "src-tauri/target-history-exclusive", { now }),
    makeDirectory(root, ".release-target", { now }),
    makeDirectory(root, ".superpowers/sdd/2026-09-09-diagnostic/target", {
      now,
    }),
    makeDirectory(
      root,
      ".superpowers/sdd/2026-09-09-diagnostic/target-flake-diagnosis",
      { now },
    ),
  ];
  makeDirectory(root, "src-tauri/target-recent", { old: false, now });
  makeDirectory(root, "src-tauri/targeted", { now });
  makeDirectory(root, "target", { now });
  makeDirectory(root, ".superpowers/sdd/2026-09-09-diagnostic/nested/target", {
    now,
  });

  const found = findStaleCargoTargetDirectories([root], 6, now);
  assert.deepEqual(
    found.map((candidate) => candidate.fullName).sort(),
    expected.map((candidate) => path.resolve(candidate)).sort(),
  );
});

test("validates supported target boundaries before invoking Cargo", (t) => {
  const root = fixture(t);
  const srcTarget = makeDirectory(root, "src-tauri/target-old");
  const releaseTarget = makeDirectory(root, ".release-target");
  const sddTarget = makeDirectory(root, ".superpowers/sdd/task/target");
  assert.equal(assertCargoTargetPath(root, srcTarget), path.resolve(srcTarget));
  assert.equal(
    assertCargoTargetPath(root, releaseTarget),
    path.resolve(releaseTarget),
  );
  assert.equal(assertCargoTargetPath(root, sddTarget), path.resolve(sddTarget));
  assert.throws(
    () => assertCargoTargetPath(root, makeDirectory(root, "target")),
    /direct child of the worktree src-tauri/,
  );
  assert.throws(
    () =>
      assertCargoTargetPath(
        root,
        makeDirectory(root, ".superpowers/sdd/task/nested/target"),
      ),
    /supported release\/SDD Cargo target/,
  );
});

test("active Cargo or rustc blocks destructive cleanup", (t) => {
  const root = fixture(t);
  const now = new Date("2026-09-09T18:00:00Z");
  const target = makeDirectory(root, "src-tauri/target", { now });
  assert.equal(hasActiveCargoBuild([{ Name: "cargo.exe" }]), true);
  let removed = false;
  const result = cleanupCargoCache({
    worktreeRoots: [root],
    minimumAgeHours: 0,
    buildProcesses: [{ Name: "rustc" }],
    now,
    remove: () => {
      removed = true;
    },
    log() {},
    warn() {},
  });
  assert.equal(result.skippedForActiveBuild, true);
  assert.equal(result.removedCount, 0);
  assert.equal(removed, false);
  assert.equal(path.basename(target), "target");
});

test("dry run reports candidates without invoking Cargo", (t) => {
  const root = fixture(t);
  const now = new Date("2026-09-09T18:00:00Z");
  makeDirectory(root, "src-tauri/target", { now });
  let removed = false;
  const result = cleanupCargoCache({
    worktreeRoots: [root],
    minimumAgeHours: 6,
    dryRun: true,
    now,
    remove: () => {
      removed = true;
    },
    log() {},
    warn() {},
  });
  assert.equal(result.candidateCount, 1);
  assert.equal(result.removedCount, 0);
  assert.equal(removed, false);
});

test("cleanup counts failures and continues through all candidates", (t) => {
  const root = fixture(t);
  const now = new Date("2026-09-09T18:00:00Z");
  makeDirectory(root, "src-tauri/target-a", { now });
  makeDirectory(root, "src-tauri/target-b", { now });
  const calls = [];
  const warnings = [];
  const result = cleanupCargoCache({
    worktreeRoots: [root],
    minimumAgeHours: 6,
    now,
    remove: (_worktree, target) => {
      calls.push(target);
      if (target.endsWith("target-a"))
        throw new Error("simulated cleanup failure");
    },
    warn: (message) => warnings.push(message),
    log() {},
  });
  assert.equal(result.candidateCount, 2);
  assert.equal(result.removedCount, 1);
  assert.equal(result.failedCount, 1);
  assert.equal(calls.length, 2);
  assert.deepEqual(warnings, ["simulated cleanup failure"]);
});

test("Cargo removal validates manifest and command exit code", (t) => {
  const root = fixture(t);
  const target = makeDirectory(root, "src-tauri/target-old");
  mkdirSync(path.join(root, "src-tauri"), { recursive: true });
  writeFileSync(path.join(root, "src-tauri", "Cargo.toml"), "[package]\n");
  const calls = [];
  removeCargoTargetDir(root, target, {
    run: (executable, args, options) => {
      calls.push({ executable, args, options });
      return { status: 0 };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, "cargo");
  assert.deepEqual(calls[0].args, [
    "clean",
    "--manifest-path",
    path.join(root, "src-tauri", "Cargo.toml"),
    "--target-dir",
    path.resolve(target),
  ]);
  assert.throws(
    () =>
      removeCargoTargetDir(root, target, {
        run: () => ({ status: 7 }),
      }),
    /cargo clean failed with exit code 7/,
  );
});

test("cleanup refuses a src-tauri junction before invoking Cargo", (t) => {
  const root = fixture(t);
  const foreign = path.join(root, "foreign");
  mkdirSync(path.join(foreign, "target"), { recursive: true });
  symlinkSync(
    foreign,
    path.join(root, "src-tauri"),
    process.platform === "win32" ? "junction" : "dir",
  );
  writeFileSync(path.join(foreign, "Cargo.toml"), "[package]\n");
  let called = false;
  assert.throws(
    () =>
      removeCargoTargetDir(root, path.join(root, "src-tauri", "target"), {
        run: () => {
          called = true;
          return { status: 0 };
        },
      }),
    /reparse|link|junction/iu,
  );
  assert.equal(called, false);
  assert.equal(hasActiveCargoBuild([]), false);
});
