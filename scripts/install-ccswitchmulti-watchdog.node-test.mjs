import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as guardianMigration from "./install-ccswitchmulti-watchdog.mjs";
import {
  assertProductionGuardianInstallSupported,
  guardianSnapshotCommand,
  guardianTaskArguments,
  guardianTaskMutationCommand,
  installGuardian,
  normalizeGuardianInstallerOptions,
  ownedGuardianProcesses,
  ownsGuardianAction,
  parseGuardianInstallerArguments,
  quoteWindowsArgument,
  splitWindowsArguments,
} from "./install-ccswitchmulti-watchdog.mjs";

test("retired installation, staging, and startup APIs are not exported by the migration module", () => {
  for (const name of [
    "GUARDIAN_RUNTIME_FILES",
    "stageGuardianRuntime",
    "assertGuardianRootSafe",
    "guardianStartupReceiptMatches",
    "waitForGuardianStartup",
    "assertGuardianNodeVersion",
  ]) {
    assert.equal(
      Object.hasOwn(guardianMigration, name),
      false,
      `${name} must not remain a second-owner capability`,
    );
  }
});

test("task mutator rejects every operation except unregister before reading any configuration", () => {
  const untouchedConfiguration = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("configuration must remain unobserved");
      },
      get() {
        throw new Error("configuration must remain unobserved");
      },
    },
  );
  for (const operation of [
    "register",
    "start",
    "delete-everything",
    "UNREGISTER",
    null,
    undefined,
  ]) {
    assert.throws(
      () =>
        guardianTaskMutationCommand(
          operation,
          untouchedConfiguration,
          untouchedConfiguration,
        ),
      /only supports.*unregister/iu,
    );
  }
});

test("CLI refuses legacy production installs without touching uninstall migration", () => {
  for (const options of [{}, { dryRun: true }, { noStart: true }]) {
    assert.throws(
      () => assertProductionGuardianInstallSupported(options),
      /built-in Rust watchdog/,
    );
  }
  assert.doesNotThrow(() =>
    assertProductionGuardianInstallSupported({ uninstall: true }),
  );
});

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

test("direct import refuses a competing production guardian before any dependency is observed", async () => {
  for (const requested of [
    {},
    { dryRun: true },
    { noStart: true },
    { noStart: true, dryRun: true },
    { uninstall: false },
    { uninstall: "true" },
    { uninstall: "false" },
    { uninstall: 1 },
    { uninstall: null },
  ]) {
    const deps = dependencies();
    await assert.rejects(
      installGuardian(requested, deps),
      /built-in Rust watchdog/,
    );
    assert.deepEqual(
      deps.calls,
      [],
      "refused install must not inspect, stage, stop, register, or start",
    );
  }
  const unexpectedDependency = new Proxy(
    {},
    {
      get() {
        throw new Error("dependency must remain unobserved");
      },
    },
  );
  await assert.rejects(
    installGuardian(
      { guardianRoot: "invalid", dryRun: true },
      unexpectedDependency,
    ),
    /built-in Rust watchdog/,
  );
});

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

test("uninstall dry run validates task ownership without staging or mutating anything", async () => {
  const deps = dependencies();
  const result = await installGuardian({ uninstall: true, dryRun: true }, deps);
  assert.equal(result.operation, "uninstall");
  assert.deepEqual(result.matchingProcesses, [4321]);
  assert.deepEqual(result.runtimeFiles, []);
  assert.deepEqual(result.stoppedProcesses, []);
  assert.deepEqual(deps.calls, ["inspect"]);
});

test("read-only inspection distinguishes a dormant owned task from an absent task", async () => {
  for (const task of [snapshotFixture().task, null]) {
    const deps = dependencies({
      inspect: async () => {
        deps.calls.push("inspect");
        return snapshotFixture({ task, processes: [] });
      },
    });
    const result = await installGuardian(
      { uninstall: true, dryRun: true },
      deps,
    );
    assert.equal(result.taskPresent, Boolean(task));
    assert.deepEqual(result.matchingProcesses, []);
    assert.deepEqual(result.stoppedProcesses, []);
    assert.deepEqual(deps.calls, ["inspect"]);
  }
});

test("uninstall removes only owned task and exact processes without copying or deleting files", async () => {
  const deps = dependencies();
  const result = await installGuardian({ uninstall: true }, deps);
  assert.equal(result.taskRemoved, true);
  assert.deepEqual(result.stoppedProcesses, [4321]);
  assert.deepEqual(deps.calls, ["inspect", "unregister", "stop:4321"]);
});

test("uninstall recognizes an owned legacy Node guardian without registering a replacement", async () => {
  const action = {
    execute: executable,
    arguments: guardianTaskArguments(options),
  };
  const deps = dependencies({
    inspect: async () => {
      deps.calls.push("inspect");
      return snapshotFixture({
        task: { ownerSid: sid, actions: [action], state: "Running" },
        processes: [processFixture(action)],
      });
    },
  });
  const result = await installGuardian({ uninstall: true }, deps);
  assert.equal(result.taskRemoved, true);
  assert.deepEqual(result.stoppedProcesses, [4321]);
  assert.deepEqual(deps.calls, ["inspect", "unregister", "stop:4321"]);
});

test("task from another user or another guardian directory blocks every uninstall mutation", async () => {
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
    for (const dryRun of [false, true]) {
      await assert.rejects(
        installGuardian({ uninstall: true, dryRun }, deps),
        /not owned/,
      );
      assert.deepEqual(deps.calls, []);
    }
  }
});

test("uninstall does not require a surviving app executable, runtime file, or modern marker parser", async () => {
  const unexpectedFileAccess = () => {
    throw new Error("uninstall must not inspect runtime sources");
  };
  const deps = dependencies({
    nodeVersion: "20.19.0",
    isRegularFile: unexpectedFileAccess,
    stageRuntime: unexpectedFileAccess,
    waitForStartup: unexpectedFileAccess,
  });
  await installGuardian({ uninstall: true }, deps);
  assert.deepEqual(deps.calls, ["inspect", "unregister", "stop:4321"]);
});

test("failed or incomplete identity inspection prevents stopping an old watcher during uninstall", async () => {
  const failure = dependencies({
    inspect: () => {
      throw new Error("Process probe failed.");
    },
  });
  await assert.rejects(
    installGuardian({ uninstall: true }, failure),
    /probe failed/,
  );
  assert.deepEqual(failure.calls, []);
  const incomplete = dependencies({
    inspect: () =>
      snapshotFixture({
        processes: [processFixture(legacyAction, { executablePath: "" })],
      }),
  });
  await assert.rejects(
    installGuardian({ uninstall: true }, incomplete),
    /inspection is incomplete/,
  );
  assert.deepEqual(incomplete.calls, []);
});

test("unregister failure cannot stop processes, write files, or start a replacement", async () => {
  const deps = dependencies({
    mutate: async (operation) => {
      deps.calls.push(operation);
      throw new Error("Unregister failed.");
    },
  });
  await assert.rejects(
    installGuardian({ uninstall: true }, deps),
    /Unregister failed/,
  );
  assert.deepEqual(deps.calls, ["inspect", "unregister"]);
});

test("changed task ownership during unregister blocks stopping even the previously owned process", async () => {
  const deps = dependencies({
    mutate: async (operation, expectedTask) => {
      assert.equal(operation, "unregister");
      assert.deepEqual(expectedTask, snapshotFixture().task);
      deps.calls.push(operation);
      throw new Error("Watchdog task action changed.");
    },
  });
  await assert.rejects(
    installGuardian({ uninstall: true }, deps),
    /task action changed/,
  );
  assert.deepEqual(deps.calls, ["inspect", "unregister"]);
});

test("migration source has no staging, file-writing, registration, or startup implementation", () => {
  const source = readFileSync(
    new URL("./install-ccswitchmulti-watchdog.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /\b(?:New|Register|Start)-ScheduledTask\b/iu);
  assert.doesNotMatch(
    source,
    /\b(?:writeFileSync|mkdirSync|renameSync|rmSync|stageGuardianRuntime|waitForGuardianStartup)\b/u,
  );
});

test("unregister builder rejects missing or foreign snapshots before native configuration is serialized", () => {
  const notSerializable = new Proxy(options, {
    ownKeys() {
      throw new Error("foreign snapshot must not be serialized");
    },
  });
  for (const expectedTask of [
    undefined,
    {},
    { ownerSid: "unknown", actions: [legacyAction] },
    { ownerSid: sid, actions: [legacyAction, legacyAction] },
    {
      ownerSid: sid,
      actions: [
        { execute: "C:\\Windows\\System32\\cmd.exe", arguments: "unrelated" },
      ],
    },
  ]) {
    assert.throws(
      () =>
        guardianTaskMutationCommand(
          "unregister",
          notSerializable,
          expectedTask,
        ),
      /Windows user identity|not owned/iu,
    );
  }
});

test("missing legacy task is rechecked for absence and cannot authorize removing a new task", () => {
  const command = guardianTaskMutationCommand("unregister", options, null);
  assert.match(command, /if \(\$null -eq \$config.expectedTask\)/);
  assert.match(
    command,
    /if \(\$null -ne \$current\) \{ throw 'Watchdog task ownership changed\.'/,
  );
  assert.match(
    command,
    /if \(\$null -ne \$config.expectedTask\) \{ Unregister-ScheduledTask/,
  );
});

test("owned unregister rechecks the inspected action and current SID before native removal", () => {
  const command = guardianTaskMutationCommand(
    "unregister",
    options,
    snapshotFixture().task,
  );
  assert.match(
    command,
    /Assert-UnchangedWatchdogTask\nif \(\$null -ne \$config.expectedTask\) \{ Unregister-ScheduledTask/,
  );
  assert.doesNotMatch(command, /\b(?:New|Register|Start)-ScheduledTask\b/iu);
  assert.match(command, /current\.ownerSid -cne \$currentSid/);
  assert.match(command, /current\.actions \| ConvertTo-Json/);
  assert.throws(
    () => guardianTaskMutationCommand("delete-everything", options, null),
    /only supports.*unregister/iu,
  );
});

test(
  "inline installer commands parse in PowerShell 7 without executing any task APIs",
  { skip: process.platform !== "win32" },
  () => {
    for (const command of [
      guardianSnapshotCommand(options),
      guardianTaskMutationCommand(
        "unregister",
        options,
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
