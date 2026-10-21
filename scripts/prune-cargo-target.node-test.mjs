import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  cleanupDecision,
  findCargoTargetOwners,
  maintainCargoTarget,
  parseCleanupOptions,
  processOwnsCargoTarget,
  windowsCargoProcesses,
} from "./prune-cargo-target.mjs";

test("Windows target ownership uses only PowerShell 7 with a bounded UTF-8 probe", () => {
  const owners = windowsCargoProcesses({
    run: (executable, args, options) => {
      assert.equal(executable, "pwsh.exe");
      assert.equal(options.timeout, 10_000);
      assert.equal(options.encoding, "utf8");
      assert.equal(options.windowsHide, true);
      assert.match(
        args.at(-1),
        /Get-CimInstance Win32_Process -ErrorAction Stop/,
      );
      assert.match(args.at(-1), /\$PSVersionTable\.PSVersion\.Major -lt 7/);
      return {
        status: 0,
        stdout: JSON.stringify({
          Name: "cargo.exe",
          ProcessId: 42,
          ExecutablePath: "C:/fixture/cargo.exe",
          CommandLine: "cargo check --manifest-path D:/fixture/Cargo.toml",
        }),
      };
    },
  });
  assert.equal(owners.length, 1);
  assert.equal(owners[0].ProcessId, 42);
});

test("Windows ownership probe failures prevent cleanup without exposing process output", () => {
  for (const failure of [
    { status: 1, stderr: "[REDACTED_PROCESS_OUTPUT]" },
    {
      error: Object.assign(new Error("[REDACTED_PROCESS_OUTPUT]"), {
        code: "ETIMEDOUT",
      }),
    },
  ]) {
    const calls = [];
    assert.throws(
      () =>
        maintainCargoTarget({
          actualTarget: "src-tauri/target",
          options: { dryRun: false, force: true, maxGb: 5 },
          getOwners: () => windowsCargoProcesses({ run: () => failure }),
          measureSize: () => calls.push("measure"),
          clean: () => calls.push("clean"),
          log: () => calls.push("log"),
        }),
      (error) => {
        assert.match(error.message, /PowerShell 7/);
        assert.equal(error.message.includes("REDACTED_PROCESS_OUTPUT"), false);
        return true;
      },
    );
    assert.deepEqual(calls, []);
  }
});

test("Windows malformed ownership results prevent cleanup without exposing process output", () => {
  const calls = [];
  assert.throws(
    () =>
      maintainCargoTarget({
        actualTarget: "src-tauri/target",
        options: { dryRun: false, force: true, maxGb: 5 },
        getOwners: () =>
          windowsCargoProcesses({
            run: () => ({ status: 0, stdout: "[REDACTED_PROCESS_OUTPUT]" }),
          }),
        measureSize: () => calls.push("measure"),
        clean: () => calls.push("clean"),
        log: () => calls.push("log"),
      }),
    (error) => {
      assert.match(error.message, /query returned malformed JSON/);
      assert.equal(error.message.includes("REDACTED_PROCESS_OUTPUT"), false);
      return true;
    },
  );
  assert.deepEqual(calls, []);
});

test("Windows incomplete owner identities block target measurement and cleanup", () => {
  const calls = [];
  assert.throws(
    () =>
      maintainCargoTarget({
        actualTarget: "src-tauri/target",
        options: { dryRun: false, force: true, maxGb: 5 },
        getOwners: () =>
          windowsCargoProcesses({
            run: () => ({
              status: 0,
              stdout: JSON.stringify({
                Name: "cargo.exe",
                ProcessId: 42,
                ExecutablePath: null,
                CommandLine: null,
              }),
            }),
          }),
        measureSize: () => calls.push("measure"),
        clean: () => calls.push("clean"),
        log: () => calls.push("log"),
      }),
    /returned incomplete ownership data/,
  );
  assert.deepEqual(calls, []);
});

test("cleanup options use a bounded default and accept overrides", () => {
  assert.deepEqual(parseCleanupOptions([], {}), {
    dryRun: false,
    force: false,
    maxGb: 5,
  });
  assert.equal(
    parseCleanupOptions([], { CCSM_CARGO_TARGET_MAX_GB: "12.5" }).maxGb,
    12.5,
  );
  assert.deepEqual(parseCleanupOptions(["--force", "--dry-run"], {}), {
    dryRun: true,
    force: true,
    maxGb: 5,
  });
  assert.throws(() => parseCleanupOptions(["--max-gb"], {}), /Missing value/);
  assert.throws(
    () => parseCleanupOptions(["--max-gb", "-1"], {}),
    /Invalid Cargo target limit/,
  );
});

test("cleanup runs only above the limit or when forced", () => {
  const gb = 1024 ** 3;
  assert.equal(
    cleanupDecision({
      sizeBytes: 10 * gb,
      maxGb: 24,
      force: false,
      ownerCount: 0,
    }),
    "keep",
  );
  assert.equal(
    cleanupDecision({
      sizeBytes: 25 * gb,
      maxGb: 24,
      force: false,
      ownerCount: 0,
    }),
    "clean",
  );
  assert.equal(
    cleanupDecision({
      sizeBytes: 1,
      maxGb: 24,
      force: true,
      ownerCount: 0,
    }),
    "clean",
  );
  assert.equal(
    cleanupDecision({
      sizeBytes: 100 * gb,
      maxGb: 0,
      force: false,
      ownerCount: 0,
    }),
    "disabled",
  );
});

test("active Cargo target owners always block cleanup", () => {
  assert.equal(
    cleanupDecision({
      sizeBytes: 100 * 1024 ** 3,
      maxGb: 24,
      force: true,
      ownerCount: 1,
    }),
    "active",
  );
});

test("process ownership is scoped to the repository target", () => {
  const repo = path.resolve("H:/repos/ccswitchmulti-fork");
  const target = path.join(repo, "src-tauri", "target");
  assert.equal(
    processOwnsCargoTarget(
      {
        Name: "rustc.exe",
        CommandLine: `rustc -C incremental=${path.join(target, "debug", "incremental")}`,
      },
      target,
      repo,
    ),
    true,
  );
  assert.equal(
    processOwnsCargoTarget(
      {
        Name: "cc-switch.exe",
        ExecutablePath: path.join(target, "debug", "cc-switch.exe"),
      },
      target,
      repo,
    ),
    true,
  );
  assert.equal(
    processOwnsCargoTarget(
      {
        Name: "rustc.exe",
        CommandLine: "rustc -C incremental=H:/repos/another/target",
      },
      target,
      repo,
    ),
    false,
  );
  assert.equal(
    processOwnsCargoTarget(
      {
        Name: "node.exe",
        CommandLine: target,
      },
      target,
      repo,
    ),
    false,
  );
});

test("owner filtering returns only matching Cargo processes", () => {
  const repo = path.resolve("H:/repos/ccswitchmulti-fork");
  const target = path.join(repo, "src-tauri", "target");
  const owners = findCargoTargetOwners(
    [
      {
        Name: "cargo.exe",
        CommandLine: `cargo test --manifest-path ${path.join(repo, "src-tauri", "Cargo.toml")}`,
      },
      {
        Name: "cargo.exe",
        CommandLine: "cargo test --manifest-path H:/repos/other/Cargo.toml",
      },
    ],
    target,
    repo,
  );
  assert.equal(owners.length, 1);
});

test("maintenance checks ownership before traversing the target", () => {
  const calls = [];
  const result = maintainCargoTarget({
    actualTarget: "src-tauri/target",
    options: {
      dryRun: false,
      force: false,
      maxGb: 12,
    },
    getOwners: () => {
      calls.push("owners");
      return [{ Name: "cargo.exe", ProcessId: 123 }];
    },
    measureSize: () => {
      calls.push("measure");
      return 20 * 1024 ** 3;
    },
    clean: () => calls.push("clean"),
    log: () => {},
  });

  assert.equal(result, "active");
  assert.deepEqual(calls, ["owners"]);
});

test("maintenance cancels cleanup when the target becomes active after measurement", () => {
  const calls = [];
  let ownerCheck = 0;
  const result = maintainCargoTarget({
    actualTarget: "src-tauri/target",
    options: {
      dryRun: false,
      force: false,
      maxGb: 12,
    },
    getOwners: () => {
      calls.push("owners");
      ownerCheck += 1;
      return ownerCheck === 1 ? [] : [{ Name: "rustc.exe", ProcessId: 456 }];
    },
    measureSize: () => {
      calls.push("measure");
      return 20 * 1024 ** 3;
    },
    clean: () => calls.push("clean"),
    log: () => {},
  });

  assert.equal(result, "active");
  assert.deepEqual(calls, ["owners", "measure", "owners"]);
});
