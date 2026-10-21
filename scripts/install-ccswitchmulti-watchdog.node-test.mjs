import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  GUARDIAN_RUNTIME_FILES,
  assertGuardianNodeVersion,
  guardianSnapshotCommand,
  guardianStartupReceiptMatches,
  guardianTaskArguments,
  guardianTaskMutationCommand,
  installGuardian,
  normalizeGuardianInstallerOptions,
  ownedGuardianProcesses,
  ownsGuardianAction,
  parseGuardianInstallerArguments,
  quoteWindowsArgument,
  splitWindowsArguments,
  stageGuardianRuntime,
  waitForGuardianStartup,
} from "./install-ccswitchmulti-watchdog.mjs";

const environment = {
  LOCALAPPDATA: "C:\\Users\\fixture\\AppData\\Local",
  USERPROFILE: "C:\\Users\\fixture",
};
const executable = "C:\\Program Files\\nodejs\\node.exe";
const options = normalizeGuardianInstallerOptions(
  {},
  { environment, executable },
);
const sid = "S-1-5-21-100-200-300-1001";
const legacyAction = {
  execute: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  arguments: `-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ${quoteWindowsArgument(path.win32.join(options.guardianRoot, "watch-ccswitchmulti.ps1"))} -Port 15721`,
};
function processFixture(action = legacyAction, overrides = {}) {
  return {
    pid: 4321,
    executablePath: action.execute,
    commandLine: `${quoteWindowsArgument(action.execute)} ${action.arguments}`,
    startedAtUtc: "2026-10-21T12:00:00.0000000Z",
    ownerSid: sid,
    ...overrides,
  };
}
function snapshotFixture(overrides = {}) {
  return {
    currentSid: sid,
    task: { ownerSid: sid, actions: [legacyAction], state: "Running" },
    processes: [processFixture()],
    ...overrides,
  };
}
function dependencies(overrides = {}) {
  const calls = [];
  let registered = false;
  return {
    calls,
    environment,
    executable,
    inspect: async () => {
      calls.push("inspect");
      return registered
        ? snapshotFixture({
            task: {
              ownerSid: sid,
              actions: [
                {
                  execute: executable,
                  arguments: guardianTaskArguments(options),
                },
              ],
              state: "Ready",
            },
            processes: [],
          })
        : snapshotFixture();
    },
    mutate: async (operation) => {
      calls.push(operation);
      if (operation === "register") registered = true;
    },
    stop: async (identity) => {
      calls.push(`stop:${identity.pid}`);
    },
    isRegularFile: () => true,
    stageRuntime: () => {
      calls.push("stage");
      return () => {
        calls.push("apply");
        return () => {
          calls.push("rollback");
        };
      };
    },
    waitForStartup: async () => {
      calls.push("ready");
      return 5432;
    },
    ...overrides,
  };
}

test("installer accepts all legacy parameter names and JavaScript aliases", () => {
  assert.deepEqual(
    parseGuardianInstallerArguments([
      "-GuardianRoot",
      "D:\\guardian",
      "-TaskName",
      "Fixture",
      "-InstalledExecutable",
      "D:\\app.exe",
      "-Port",
      "12345",
      "-PollSeconds",
      "2",
      "-FailureThresholdSeconds",
      "12",
      "-ConfigPath",
      "D:\\config",
      "-Uninstall",
      "-NoStart",
      "-DryRun",
    ]),
    {
      guardianRoot: "D:\\guardian",
      taskName: "Fixture",
      installedExecutable: "D:\\app.exe",
      port: "12345",
      pollSeconds: "2",
      failureThresholdSeconds: "12",
      configPath: "D:\\config",
      uninstall: true,
      noStart: true,
      dryRun: true,
    },
  );
  assert.deepEqual(
    parseGuardianInstallerArguments([
      "--guardian-root",
      "D:\\guardian",
      "--no-start",
      "--dry-run",
    ]),
    {
      guardianRoot: "D:\\guardian",
      noStart: true,
      dryRun: true,
    },
  );
  assert.throws(
    () => parseGuardianInstallerArguments(["--development-mode"]),
    /Unknown/,
  );
  assert.throws(
    () => parseGuardianInstallerArguments(["-NoStart", "--no-start"]),
    /twice/,
  );
  assert.throws(
    () => parseGuardianInstallerArguments(["--task-name"]),
    /requires a value/,
  );
});

test("installer help runs before Windows, filesystem, identity, or task probes", () => {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL("./install-ccswitchmulti-watchdog.mjs", import.meta.url),
      ),
      "--help",
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /--dry-run/);
  assert.equal(result.stderr, "");
});

test("install rejects Node versions that cannot preserve raw modern marker identity", async () => {
  for (const version of ["20.19.0", "22.11.0", "invalid"]) {
    assert.throws(() => assertGuardianNodeVersion(version), /22.12/);
    const deps = dependencies({ nodeVersion: version });
    await assert.rejects(installGuardian({}, deps), /22.12/);
    assert.deepEqual(deps.calls, []);
  }
  for (const version of ["22.12.0", "22.20.1", "24.0.0"])
    assert.doesNotThrow(() => assertGuardianNodeVersion(version));
});

test("installer requires absolute Node, user-scoped task names and positive timings", () => {
  assert.equal(options.nodeExecutable, executable);
  for (const changed of [
    { taskName: "\\other\\task" },
    { guardianRoot: "C:\\" },
    { guardianRoot: "relative" },
    { port: 65536 },
    { pollSeconds: 0 },
    { failureThresholdSeconds: "NaN" },
  ]) {
    assert.throws(() =>
      normalizeGuardianInstallerOptions(changed, { environment, executable }),
    );
  }
  assert.throws(
    () =>
      normalizeGuardianInstallerOptions(
        {},
        { environment, executable: "node.exe" },
      ),
    /absolute/,
  );
  assert.throws(
    () =>
      normalizeGuardianInstallerOptions(
        {},
        { environment, executable: "C:\\fixture\\pwsh.exe" },
      ),
    /Node.js/,
  );
});

test("scheduled action uses absolute Node and quoted JS script without a PS1 invocation", () => {
  const argv = splitWindowsArguments(guardianTaskArguments(options));
  assert.equal(
    argv[0],
    path.win32.join(options.guardianRoot, "watch-ccswitchmulti.mjs"),
  );
  assert.equal(
    argv[argv.indexOf("--installed-executable") + 1],
    options.installedExecutable,
  );
  assert.equal(
    argv[argv.indexOf("--maintenance-marker") + 1],
    path.win32.join(options.guardianRoot, "maintenance.lock"),
  );
  assert.ok(!argv.some((argument) => /\.ps1$/iu.test(argument)));
  assert.ok(!argv.includes("--development-mode"));
  for (const argument of [
    "",
    "D:\\space here\\",
    'literal"quote',
    "plain",
    "D:\\one\\two\\",
  ]) {
    assert.deepEqual(splitWindowsArguments(quoteWindowsArgument(argument)), [
      argument,
    ]);
  }
});

test("legacy ownership matches the exact script token and rejects substrings or encoded commands", () => {
  assert.equal(ownsGuardianAction(legacyAction, options), true);
  assert.equal(
    ownsGuardianAction(
      {
        ...legacyAction,
        arguments: legacyAction.arguments.replace(
          "watch-ccswitchmulti.ps1",
          "watch-ccswitchmulti.ps1.backup",
        ),
      },
      options,
    ),
    false,
  );
  assert.equal(
    ownsGuardianAction(
      {
        ...legacyAction,
        arguments: `-Command Write-Host -File ${quoteWindowsArgument(path.win32.join(options.guardianRoot, "watch-ccswitchmulti.ps1"))}`,
      },
      options,
    ),
    false,
  );
  assert.equal(
    ownsGuardianAction(
      { ...legacyAction, arguments: '-File "unclosed' },
      options,
    ),
    false,
  );
  assert.equal(
    ownsGuardianAction(
      {
        execute: executable,
        arguments: `--eval ${quoteWindowsArgument(path.win32.join(options.guardianRoot, "watch-ccswitchmulti.mjs"))}`,
      },
      options,
    ),
    false,
  );
});

test("process migration preserves exact creation identities and ignores other users/hosts/scripts", () => {
  const owned = processFixture();
  assert.deepEqual(
    ownedGuardianProcesses(
      snapshotFixture({
        processes: [
          owned,
          processFixture(legacyAction, {
            pid: 4322,
            ownerSid: "S-1-5-21-other",
          }),
          processFixture(legacyAction, {
            pid: 4323,
            executablePath: "C:\\other\\pwsh.exe",
          }),
          processFixture(
            {
              ...legacyAction,
              arguments: legacyAction.arguments.replace(".ps1", ".ps1-other"),
            },
            { pid: 4324 },
          ),
        ],
      }),
      options,
    ),
    [owned],
  );
});

test("dry run validates sources and task ownership but mutates nothing", async () => {
  const deps = dependencies();
  const result = await installGuardian({ dryRun: true }, deps);
  assert.equal(result.operation, "install");
  assert.deepEqual(result.matchingProcesses, [4321]);
  assert.deepEqual(deps.calls, ["inspect", "stage"]);
});

test("install migrates exact old watcher then publishes JS files and registers Node before start", async () => {
  const deps = dependencies();
  const result = await installGuardian({}, deps);
  assert.deepEqual(deps.calls, [
    "inspect",
    "stage",
    "stop:4321",
    "apply",
    "register",
    "inspect",
    "start",
    "ready",
  ]);
  assert.deepEqual(result.stoppedProcesses, [4321]);
  assert.equal(result.watcherPid, 5432);
  assert.equal(result.startRequested, true);
});

test("NoStart registers production Node task without starting it", async () => {
  const deps = dependencies();
  const result = await installGuardian({ noStart: true }, deps);
  assert.equal(result.startRequested, false);
  assert.ok(!deps.calls.includes("start"));
});

test("uninstall removes only owned task and exact processes without copying or deleting files", async () => {
  const deps = dependencies();
  const result = await installGuardian({ uninstall: true }, deps);
  assert.equal(result.taskRemoved, true);
  assert.deepEqual(deps.calls, ["inspect", "unregister", "stop:4321"]);
});

test("task from another user or another guardian directory blocks every mutation", async () => {
  for (const task of [
    { ownerSid: "S-1-5-21-other", actions: [legacyAction] },
    {
      ownerSid: sid,
      actions: [
        {
          execute: legacyAction.execute,
          arguments: '-File "D:\\unrelated\\watch-ccswitchmulti.ps1"',
        },
      ],
    },
    { ownerSid: sid, actions: [legacyAction, legacyAction] },
  ]) {
    const deps = dependencies({ inspect: () => snapshotFixture({ task }) });
    await assert.rejects(installGuardian({}, deps), /not owned/);
    assert.deepEqual(deps.calls, []);
  }
});

test("missing app/Node or failed identity inspection prevents stopping the old watcher", async () => {
  const missing = dependencies({ isRegularFile: () => false });
  await assert.rejects(
    installGuardian({}, missing),
    /Node.js executable is unavailable/,
  );
  assert.deepEqual(missing.calls, ["inspect"]);
  const failure = dependencies({
    inspect: () => {
      throw new Error("Process probe failed.");
    },
  });
  await assert.rejects(installGuardian({}, failure), /probe failed/);
  assert.deepEqual(failure.calls, []);
  const incomplete = dependencies({
    inspect: () =>
      snapshotFixture({
        processes: [processFixture(legacyAction, { executablePath: "" })],
      }),
  });
  await assert.rejects(
    installGuardian({}, incomplete),
    /inspection is incomplete/,
  );
  assert.deepEqual(incomplete.calls, []);
});

test("registration failure rolls runtime files back and never starts an unverified task", async () => {
  const deps = dependencies({
    mutate: async (operation) => {
      deps.calls.push(operation);
      throw new Error("Registration failed.");
    },
  });
  await assert.rejects(installGuardian({}, deps), /Registration failed/);
  assert.deepEqual(deps.calls, [
    "inspect",
    "stage",
    "stop:4321",
    "apply",
    "register",
    "rollback",
  ]);
});

test("changed registered action blocks a task start", async () => {
  let inspections = 0;
  const deps = dependencies({
    inspect: () => {
      inspections += 1;
      return inspections === 1
        ? snapshotFixture()
        : snapshotFixture({ task: null });
    },
  });
  await assert.rejects(installGuardian({}, deps), /does not match/);
  assert.ok(!deps.calls.includes("start"));
});

test("startup waits for a fresh owned Node watcher and lock instead of an old lock alone", async () => {
  let currentTime = 1000;
  let inspections = 0;
  const nodeAction = {
    execute: executable,
    arguments: guardianTaskArguments(options),
  };
  const watcherPid = await waitForGuardianStartup(options, {
    inspect: () => {
      inspections += 1;
      return snapshotFixture({
        task: { ownerSid: sid, actions: [nodeAction] },
        processes:
          inspections < 3
            ? []
            : [
                processFixture(nodeAction, {
                  pid: 5432,
                  startedAtUtc: new Date(1100).toISOString(),
                }),
              ],
      });
    },
    startedAtMs: 1000,
    now: () => currentTime,
    wait: async (duration) => {
      currentTime += duration;
    },
    lockExists: () => true,
    startupReceiptMatches: () => true,
  });
  assert.equal(watcherPid, 5432);
  assert.equal(inspections, 3);
});

test("startup deadline and duplicate owned Node watcher both fail explicitly", async () => {
  let currentTime = 1000;
  await assert.rejects(
    waitForGuardianStartup(options, {
      inspect: () =>
        snapshotFixture({
          task: {
            ownerSid: sid,
            actions: [
              {
                execute: executable,
                arguments: guardianTaskArguments(options),
              },
            ],
          },
          processes: [],
        }),
      startedAtMs: 1000,
      now: () => currentTime,
      wait: async (duration) => {
        currentTime += duration;
      },
      timeoutMs: 5,
      lockExists: () => true,
    }),
    /startup deadline/,
  );
  const action = {
    execute: executable,
    arguments: guardianTaskArguments(options),
  };
  await assert.rejects(
    waitForGuardianStartup(options, {
      inspect: () =>
        snapshotFixture({
          task: { ownerSid: sid, actions: [action] },
          processes: [
            processFixture(action, {
              pid: 100,
              startedAtUtc: new Date(1100).toISOString(),
            }),
            processFixture(action, {
              pid: 101,
              startedAtUtc: new Date(1100).toISOString(),
            }),
          ],
        }),
      startedAtMs: 1000,
      now: () => 1000,
    }),
    /More than one/,
  );
});

test("a stale lock and fresh Node process cannot pass startup without its matching post-lock receipt", async () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "ccsm-guardian-receipt-"));
  const logPath = path.join(fixture, "guardian.jsonl");
  const nodeAction = {
    execute: executable,
    arguments: guardianTaskArguments(options),
  };
  const identity = processFixture(nodeAction, {
    pid: 5432,
    startedAtUtc: "2026-10-21T12:00:00.1234567Z",
  });
  const startedAtMs = Date.parse("2026-10-21T12:00:00.000Z");
  const receipt = (changed = {}) => ({
    timestamp: "2026-10-21T12:00:00.500Z",
    event: "guardian-started",
    detail: {
      GuardianProcessId: identity.pid,
      GuardianStartTimeUtc: identity.startedAtUtc,
    },
    ...changed,
  });
  try {
    writeFileSync(
      logPath,
      `${JSON.stringify(receipt({ detail: { GuardianProcessId: 9999, GuardianStartTimeUtc: identity.startedAtUtc } }))}\n`,
    );
    assert.equal(
      guardianStartupReceiptMatches(logPath, identity, startedAtMs),
      false,
    );
    let currentTime = startedAtMs;
    await assert.rejects(
      waitForGuardianStartup(options, {
        inspect: () =>
          snapshotFixture({
            task: { ownerSid: sid, actions: [nodeAction] },
            processes: [identity],
          }),
        startedAtMs,
        now: () => currentTime,
        wait: async (duration) => {
          currentTime += duration;
        },
        lockExists: () => true,
        startupReceiptMatches: (_, candidate, after) =>
          guardianStartupReceiptMatches(logPath, candidate, after),
        timeoutMs: 5,
      }),
      /startup deadline/,
    );
    writeFileSync(
      logPath,
      `${JSON.stringify(receipt({ detail: { GuardianProcessId: identity.pid, GuardianStartTimeUtc: "2026-10-21T12:00:00.1234560Z" } }))}\n`,
    );
    assert.equal(
      guardianStartupReceiptMatches(logPath, identity, startedAtMs),
      false,
      "Submillisecond identity differences must remain visible.",
    );
    writeFileSync(
      logPath,
      `${JSON.stringify(receipt({ timestamp: "2026-10-21T11:59:59.000Z" }))}\n`,
    );
    assert.equal(
      guardianStartupReceiptMatches(logPath, identity, startedAtMs),
      false,
    );
    writeFileSync(
      logPath,
      `invalid-partial-record\n${JSON.stringify(receipt())}\n`,
    );
    assert.equal(
      guardianStartupReceiptMatches(logPath, identity, startedAtMs),
      true,
    );
    assert.equal(
      await waitForGuardianStartup(options, {
        inspect: () =>
          snapshotFixture({
            task: { ownerSid: sid, actions: [nodeAction] },
            processes: [identity],
          }),
        startedAtMs,
        now: () => startedAtMs,
        lockExists: () => true,
        startupReceiptMatches: (_, candidate, after) =>
          guardianStartupReceiptMatches(logPath, candidate, after),
      }),
      identity.pid,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("runtime copy has no PS1 dependency and rollback preserves unrelated files", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "ccsm-guardian-install-"));
  const source = path.join(fixture, "source");
  const target = path.join(fixture, "target");
  // Directory creation is a fixture operation; no real installed guardian touched.
  try {
    mkdirSync(source);
    mkdirSync(target);
    for (const name of GUARDIAN_RUNTIME_FILES)
      writeFileSync(path.join(source, name), `new:${name}`);
    writeFileSync(
      path.join(target, GUARDIAN_RUNTIME_FILES[0]),
      "previous-runtime",
    );
    writeFileSync(path.join(target, "guardian.jsonl"), "keep-log");
    const apply = stageGuardianRuntime({
      sourceRoot: source,
      guardianRoot: target,
    });
    assert.equal(
      readFileSync(path.join(target, GUARDIAN_RUNTIME_FILES[0]), "utf8"),
      "previous-runtime",
    );
    const rollback = apply();
    assert.equal(
      readFileSync(path.join(target, GUARDIAN_RUNTIME_FILES[0]), "utf8"),
      `new:${GUARDIAN_RUNTIME_FILES[0]}`,
    );
    rollback();
    assert.equal(
      readFileSync(path.join(target, GUARDIAN_RUNTIME_FILES[0]), "utf8"),
      "previous-runtime",
    );
    assert.equal(
      readFileSync(path.join(target, "guardian.jsonl"), "utf8"),
      "keep-log",
    );
    assert.throws(
      () => readFileSync(path.join(target, GUARDIAN_RUNTIME_FILES[1])),
      /ENOENT/,
    );
    assert.ok(GUARDIAN_RUNTIME_FILES.every((name) => !name.endsWith(".ps1")));
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("runtime copy rejects a junction and never writes through it", () => {
  const fixture = mkdtempSync(
    path.join(os.tmpdir(), "ccsm-guardian-junction-"),
  );
  const target = path.join(fixture, "target");
  const link = path.join(fixture, "link");
  try {
    mkdirSync(target);
    symlinkSync(
      target,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.throws(
      () => stageGuardianRuntime({ guardianRoot: link }),
      /symbolic link or junction/,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("scheduled task mutations recheck the inspected action and current SID", () => {
  const command = guardianTaskMutationCommand(
    "register",
    { ...options, taskArguments: guardianTaskArguments(options) },
    snapshotFixture().task,
  );
  assert.match(command, /Assert-UnchangedWatchdogTask\n\$action/);
  assert.match(command, /-LogonType Interactive -RunLevel Limited/);
  assert.match(command, /-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries/);
  assert.match(command, /-MultipleInstances IgnoreNew/);
  assert.match(command, /-ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/);
  assert.match(command, /-RestartCount 3/);
  assert.match(command, /current\.ownerSid -cne \$currentSid/);
  assert.match(command, /current\.actions \| ConvertTo-Json/);
  assert.throws(
    () => guardianTaskMutationCommand("delete-everything", options, null),
    /Unknown/,
  );
});

test(
  "inline installer commands parse in PowerShell 7 without executing any task APIs",
  { skip: process.platform !== "win32" },
  () => {
    for (const command of [
      guardianSnapshotCommand(options),
      guardianTaskMutationCommand(
        "register",
        { ...options, taskArguments: guardianTaskArguments(options) },
        snapshotFixture().task,
      ),
    ]) {
      const encoded = Buffer.from(command, "utf8").toString("base64");
      const result = spawnSync(
        "pwsh.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); $tokens=$null; $parseErrors=$null; $null=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$parseErrors); if($parseErrors.Count -gt 0){exit 1}`,
        ],
        { encoding: "utf8", windowsHide: true, timeout: 10_000 },
      );
      assert.equal(result.error, undefined);
      assert.equal(
        result.status,
        0,
        "Installer inline query must parse without running task operations.",
      );
    }
  },
);
