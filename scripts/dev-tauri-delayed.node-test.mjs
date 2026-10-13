import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertNormalCargoTargetDirectory,
  createBackendContentTracker,
  createBackendRebuildGate,
  createChangeEventBatcher,
  createExpectedExitRegistry,
  createQuietPeriodScheduler,
  devAutoRestartDecision,
  devSessionEnvironment,
  devWorkerCommand,
  devWorkerRestartDecision,
  isDevCrashMarker,
  isPathInside,
  isTauriAppStartedOutput,
  normalizeCliArgs,
  parseDelayMs,
  parseNoRebuild,
  parsePort,
  readDevWatchdogEnabled,
  resolveDevSettingsPath,
  parseWindowsListeners,
  resolveRepoRootBackendInput,
  resolveTauriRootBackendInput,
  runCargoTargetMaintenance,
  sameWindowsProcess,
  snapshotBackendFileFingerprints,
  stopVerifiedWindowsApp,
  stopWindowsProcess,
  superviseDevSessions,
  waitForChildExit,
  waitForWindowsListenersReleased,
  waitForWindowsProcessExit,
  windowsDevDescendants,
  windowsDevWorkerDescendants,
  windowsFrontendDescendants,
  windowsProcessStartedAtUtc,
} from "./dev-tauri-delayed.mjs";

test("CLI normalization removes pnpm's leading argument separator", () => {
  assert.deepEqual(normalizeCliArgs(["--", "--delay", "0"]), ["--delay", "0"]);
  assert.deepEqual(normalizeCliArgs(["--no-rebuild"]), ["--no-rebuild"]);
  assert.deepEqual(normalizeCliArgs([]), []);
});

test("parseDelayMs uses the default and supports environment and CLI overrides", () => {
  assert.equal(parseDelayMs([], {}), 14_400_000);
  assert.equal(
    parseDelayMs([], { TAURI_DEV_REBUILD_DELAY_MS: "15000" }),
    15_000,
  );
  assert.equal(
    parseDelayMs(["--delay", "25000"], {
      TAURI_DEV_REBUILD_DELAY_MS: "15000",
    }),
    25_000,
  );
});

test("parseDelayMs rejects invalid values", () => {
  assert.throws(
    () => parseDelayMs(["--delay", "later"], {}),
    /Invalid rebuild delay/,
  );
  assert.throws(
    () => parseDelayMs(["--delay", "-1"], {}),
    /Invalid rebuild delay/,
  );
  assert.throws(
    () => parseDelayMs(["--delay", "1.5"], {}),
    /Invalid rebuild delay/,
  );
  assert.throws(
    () => parseDelayMs(["--delay", "2147483648"], {}),
    /Invalid rebuild delay/,
  );
  assert.throws(
    () => parseDelayMs([], { TAURI_DEV_REBUILD_DELAY_MS: "" }),
    /cannot be empty/,
  );
  assert.throws(
    () => parseDelayMs(["--delay", "10", "-d", "20"], {}),
    /only be specified once/,
  );
  assert.throws(() => parseDelayMs(["--delay"], {}), /Missing milliseconds/);
  assert.throws(
    () => parseDelayMs(["--delay", "--help"], {}),
    /Missing milliseconds/,
  );
  assert.throws(() => parseDelayMs(["--wat", "10"], {}), /Unknown argument/);
});

test("parseNoRebuild supports the CLI flag and environment override", () => {
  assert.equal(parseNoRebuild([], {}), false);
  assert.equal(parseNoRebuild(["--no-rebuild"], {}), true);
  assert.equal(parseNoRebuild([], { TAURI_DEV_NO_REBUILD: "true" }), true);
  assert.equal(parseNoRebuild([], { TAURI_DEV_NO_REBUILD: "0" }), false);
  assert.throws(
    () => parseNoRebuild(["--no-rebuild", "--no-rebuild"], {}),
    /only be specified once/,
  );
  assert.throws(
    () => parseNoRebuild([], { TAURI_DEV_NO_REBUILD: "sometimes" }),
    /Invalid TAURI_DEV_NO_REBUILD/,
  );
});

test("parsePort supports isolated development sessions", () => {
  assert.equal(parsePort({}), 3000);
  assert.equal(parsePort({ TAURI_DEV_PORT: "3410" }), 3410);
  assert.throws(
    () => parsePort({ TAURI_DEV_PORT: "0" }),
    /Invalid development port/,
  );
});

test("development recovery reads the shared watchdog toggle safely", () => {
  assert.equal(
    resolveDevSettingsPath({
      CC_SWITCH_TEST_HOME: path.join("tmp", "cc-switch"),
    }),
    path.join("tmp", "cc-switch", ".cc-switch", "settings.json"),
  );
  assert.equal(
    readDevWatchdogEnabled(
      { CC_SWITCH_TEST_HOME: "tmp", CC_SWITCH_DEV_WATCHDOG_ENABLED: "off" },
      () => {
        throw new Error("settings should not be read when overridden");
      },
    ),
    false,
  );
  assert.equal(
    readDevWatchdogEnabled(
      { CC_SWITCH_TEST_HOME: "tmp" },
      () => '{"watchdogEnabled":false}',
    ),
    false,
  );
  assert.equal(
    readDevWatchdogEnabled({ CC_SWITCH_TEST_HOME: "tmp" }, () => "{"),
    false,
  );
  assert.equal(
    readDevWatchdogEnabled({ CC_SWITCH_TEST_HOME: "tmp" }, (filePath) => {
      const error = new Error(`missing ${filePath}`);
      error.code = "ENOENT";
      throw error;
    }),
    true,
  );
});

test("development recovery rebuilds after startup and runtime crashes", () => {
  assert.deepEqual(
    devAutoRestartDecision({
      appStarted: false,
      exitCode: 1,
      signal: null,
      watchdogEnabled: true,
    }),
    { restart: true, reason: "unexpected-exit" },
  );
  assert.deepEqual(
    devAutoRestartDecision({
      appStarted: true,
      exitCode: 0,
      signal: null,
      watchdogEnabled: true,
    }),
    { restart: false, reason: "clean-exit" },
  );
  assert.deepEqual(
    devAutoRestartDecision({
      appStarted: true,
      exitCode: 1,
      signal: null,
      watchdogEnabled: false,
    }),
    { restart: false, reason: "disabled" },
  );
  assert.deepEqual(
    devAutoRestartDecision({
      appStarted: true,
      exitCode: 1,
      signal: null,
      watchdogEnabled: true,
      nowMs: 1_000,
      restartTimesMs: [],
    }),
    { restart: true, reason: "unexpected-exit" },
  );
  assert.deepEqual(
    devAutoRestartDecision({
      appStarted: true,
      exitCode: 1,
      signal: null,
      watchdogEnabled: true,
      nowMs: 1_000,
      restartTimesMs: [1, 2, 3, 4, 5],
    }),
    { restart: false, reason: "rate-limited" },
  );
});

test("development recovery uses a crash marker when Tauri reports code zero", () => {
  assert.deepEqual(
    devAutoRestartDecision({
      exitCode: 0,
      signal: null,
      uncleanExit: true,
      watchdogEnabled: true,
    }),
    { restart: true, reason: "unexpected-exit" },
  );
});

test("development recovery retries code-zero quits before Tauri is ready", () => {
  assert.deepEqual(
    devAutoRestartDecision({
      appStarted: false,
      exitCode: 0,
      signal: null,
      watchdogEnabled: true,
    }),
    { restart: true, reason: "unexpected-exit" },
  );
});

test("development crash markers require the current dev launch and target", () => {
  const repoRoot = path.resolve("workspace", "ccswitchmulti");
  const sessionStartedAt = Date.parse("2026-10-13T04:00:00Z");
  const appName = process.platform === "win32" ? "cc-switch.exe" : "cc-switch";
  const marker = {
    pid: 42,
    executablePath: path.join(
      repoRoot,
      "src-tauri",
      "target",
      "debug",
      appName,
    ),
    startedAt: "2026-10-13T04:00:01Z",
  };

  assert.equal(isDevCrashMarker(marker, sessionStartedAt, repoRoot), true);
  assert.equal(
    isDevCrashMarker(
      {
        pid: 42,
        executable_path: marker.executablePath,
        started_at: marker.startedAt,
      },
      sessionStartedAt,
      repoRoot,
    ),
    true,
  );
  for (const invalid of [
    null,
    { ...marker, pid: 0 },
    { ...marker, pid: -1 },
    { ...marker, pid: 1.5 },
    { ...marker, pid: undefined },
    { ...marker, startedAt: "2026-10-13T03:59:59Z" },
    { ...marker, startedAt: "invalid" },
    { ...marker, executablePath: path.join(repoRoot, "installed", appName) },
    {
      ...marker,
      executablePath: path.join(
        repoRoot,
        "src-tauri",
        "target-imposter",
        "debug",
        appName,
      ),
    },
    {
      ...marker,
      executablePath: path.join(
        repoRoot,
        "src-tauri",
        "target",
        "debug",
        "foreign-app.exe",
      ),
    },
  ]) {
    assert.equal(isDevCrashMarker(invalid, sessionStartedAt, repoRoot), false);
  }
});

test("development worker launch preserves options and enters worker mode", () => {
  const args = ["--delay", "25000", "--no-rebuild"];
  const environment = {
    TAURI_DEV_PORT: "3410",
    CC_SWITCH_TEST_HOME: "isolated-home",
    CC_SWITCH_DEV_SUPERVISOR: "0",
  };
  const command = devWorkerCommand(args, environment);
  const scriptPath = fileURLToPath(
    new URL("./dev-tauri-delayed.mjs", import.meta.url),
  );

  assert.equal(command.executable, process.execPath);
  assert.deepEqual(command.args, [scriptPath, "--ccsm-dev-worker", ...args]);
  assert.equal(
    command.options.cwd,
    path.resolve(path.dirname(scriptPath), ".."),
  );
  assert.deepEqual(command.options.env, {
    ...environment,
    CC_SWITCH_DEV_SUPERVISOR: "1",
  });
  assert.deepEqual(command.options.stdio, [
    "inherit",
    "inherit",
    "inherit",
    "ipc",
  ]);
  assert.equal(command.options.windowsHide, true);
  assert.deepEqual(args, ["--delay", "25000", "--no-rebuild"]);
  assert.equal(environment.CC_SWITCH_DEV_SUPERVISOR, "0");
});

test("development recovery metadata saves options without arbitrary environment secrets", () => {
  const options = {
    TAURI_DEV_PORT: "3410",
    TAURI_DEV_REBUILD_DELAY_MS: "25000",
    TAURI_DEV_NO_REBUILD: "true",
    CC_SWITCH_TEST_HOME: "isolated-home",
    CC_SWITCH_DEV_WATCHDOG_ENABLED: "off",
  };
  const environment = {
    ...options,
    OPENAI_API_KEY: "dummy-secret-for-test",
    PRIVATE_SERVICE_TOKEN: "dummy-token-for-test",
    CC_SWITCH_DEV_SUPERVISOR: "1",
    PATH: "not-persisted",
  };

  assert.deepEqual(devSessionEnvironment(environment), options);
  assert.deepEqual(devSessionEnvironment(), {});
  assert.deepEqual(
    devSessionEnvironment({
      TAURI_DEV_PORT: 3410,
      TAURI_DEV_REBUILD_DELAY_MS: undefined,
      TAURI_DEV_NO_REBUILD: false,
    }),
    {},
  );
  assert.equal(environment.OPENAI_API_KEY, "dummy-secret-for-test");
});

test("development worker recovery respects intentional exits and restart budget", () => {
  const defaults = {
    exitCode: 1,
    signal: null,
    watchdogEnabled: true,
    nowMs: 2_000_000,
  };
  assert.deepEqual(devWorkerRestartDecision(defaults), {
    restart: true,
    reason: "unexpected-exit",
  });
  assert.deepEqual(
    devWorkerRestartDecision({
      ...defaults,
      exitCode: null,
      signal: "SIGKILL",
    }),
    { restart: true, reason: "unexpected-exit" },
  );
  assert.deepEqual(
    devWorkerRestartDecision({ ...defaults, expectedExit: true }),
    { restart: false, reason: "expected-exit" },
  );
  assert.deepEqual(
    devWorkerRestartDecision({ ...defaults, watchdogEnabled: false }),
    { restart: false, reason: "disabled" },
  );
  assert.deepEqual(devWorkerRestartDecision({ ...defaults, exitCode: 0 }), {
    restart: false,
    reason: "clean-exit",
  });
  assert.deepEqual(
    devWorkerRestartDecision({
      ...defaults,
      restartTimesMs: Array(5).fill(2_000_000),
    }),
    { restart: false, reason: "rate-limited" },
  );
  assert.deepEqual(
    devWorkerRestartDecision({
      ...defaults,
      restartTimesMs: Array(5).fill(199_999),
    }),
    { restart: true, reason: "unexpected-exit" },
  );
});

function fakeDevWorker(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.finish = (code, signal = null) => {
    child.exitCode = code;
    child.signalCode = signal;
    child.emit("exit", code, signal);
  };
  return child;
}

const nextEventLoopTurn = () => new Promise((resolve) => setImmediate(resolve));

test("development supervisor waits for cleanup before relaunching a full worker", async () => {
  const workers = [];
  const actions = [];
  let finishCleanup;
  const cleanupBarrier = new Promise((resolve) => {
    finishCleanup = resolve;
  });
  const supervising = superviseDevSessions({
    spawnSession: () => {
      const child = fakeDevWorker(workers.length + 1);
      workers.push(child);
      actions.push(`launch-worker:${child.pid}`);
      return child;
    },
    cleanSession: async (child) => {
      actions.push(`cleanup-start:${child.pid}`);
      if (child.pid === 1) await cleanupBarrier;
      actions.push(`cleanup-done:${child.pid}`);
    },
    readEnabled: () => true,
    waitToRestart: async () => {
      actions.push("restart-delay");
    },
  });

  workers[0].finish(1);
  await nextEventLoopTurn();
  assert.equal(workers.length, 1);
  assert.deepEqual(actions, ["launch-worker:1", "cleanup-start:1"]);
  finishCleanup();
  await nextEventLoopTurn();
  assert.equal(workers.length, 2);
  assert.deepEqual(actions, [
    "launch-worker:1",
    "cleanup-start:1",
    "cleanup-done:1",
    "restart-delay",
    "launch-worker:2",
  ]);
  workers[1].finish(0);
  assert.equal(await supervising, 0);
});

test("development supervisor rebuilds a new worker after a startup error", async () => {
  const actions = [];
  const outcomes = [];
  let launches = 0;
  const code = await superviseDevSessions({
    spawnSession: () => {
      const child = fakeDevWorker(++launches);
      actions.push(`launch-worker:${child.pid}`);
      queueMicrotask(() => {
        if (child.pid === 1)
          child.emit("error", new Error("injected startup failure"));
        else child.finish(0);
      });
      return child;
    },
    cleanSession: async (child) => {
      actions.push(`cleanup:${child.pid}`);
    },
    readEnabled: () => true,
    waitToRestart: async () => {
      actions.push("restart-delay");
    },
    onEvent: (decision, outcome) => {
      outcomes.push({ decision, outcome });
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(actions, [
    "launch-worker:1",
    "cleanup:1",
    "restart-delay",
    "launch-worker:2",
    "cleanup:2",
  ]);
  assert.equal(outcomes[0].decision.reason, "unexpected-exit");
  assert.match(outcomes[0].outcome.error.message, /startup failure/);
  assert.equal(outcomes[1].decision.reason, "clean-exit");
});

test("development supervisor leaves clean and disabled sessions stopped", async () => {
  for (const { exitCode, enabled, reason } of [
    { exitCode: 0, enabled: true, reason: "clean-exit" },
    { exitCode: 1, enabled: false, reason: "disabled" },
  ]) {
    let launches = 0;
    let cleanups = 0;
    const decisions = [];
    const code = await superviseDevSessions({
      spawnSession: () => {
        const child = fakeDevWorker(++launches);
        queueMicrotask(() => child.finish(exitCode));
        return child;
      },
      cleanSession: async () => {
        cleanups += 1;
      },
      readEnabled: () => enabled,
      waitToRestart: async () => {
        assert.fail("stopped sessions must not schedule a restart");
      },
      onEvent: (decision) => {
        decisions.push(decision.reason);
      },
    });
    assert.equal(code, exitCode);
    assert.equal(launches, 1);
    assert.equal(cleanups, 1);
    assert.deepEqual(decisions, [reason]);
  }
});

test("development supervisor stops a repeated startup crash loop at five restarts", async () => {
  let launches = 0;
  let cleanups = 0;
  let delays = 0;
  const decisions = [];
  const code = await superviseDevSessions({
    spawnSession: () => {
      const child = fakeDevWorker(++launches);
      queueMicrotask(() => child.finish(1));
      return child;
    },
    cleanSession: async () => {
      cleanups += 1;
    },
    readEnabled: () => true,
    now: () => 2_000_000,
    waitToRestart: async () => {
      delays += 1;
    },
    onEvent: (decision) => {
      decisions.push(decision.reason);
    },
  });
  assert.equal(code, 1);
  assert.equal(launches, 6);
  assert.equal(cleanups, 6);
  assert.equal(delays, 5);
  assert.equal(decisions.at(-1), "rate-limited");
});

test("development supervisor cancels a delayed restart when shutting down", async () => {
  let stopping = false;
  let launches = 0;
  const code = await superviseDevSessions({
    spawnSession: () => {
      const child = fakeDevWorker(++launches);
      queueMicrotask(() => child.finish(1));
      return child;
    },
    cleanSession: async () => {},
    readEnabled: () => true,
    isStopping: () => stopping,
    waitToRestart: async () => {
      stopping = true;
    },
  });
  assert.equal(code, 0);
  assert.equal(launches, 1);
});

test("development supervisor rereads the watchdog toggle after the restart delay", async () => {
  let enabled = true;
  let launches = 0;
  const code = await superviseDevSessions({
    spawnSession: () => {
      const child = fakeDevWorker(++launches);
      queueMicrotask(() => child.finish(1));
      return child;
    },
    cleanSession: async () => {},
    readEnabled: () => enabled,
    waitToRestart: async () => {
      enabled = false;
    },
  });
  assert.equal(code, 1);
  assert.equal(launches, 1);
});

test("development requires the repository Cargo target directory", () => {
  const tauriDirectory = path.join("workspace", "src-tauri");
  assert.doesNotThrow(() =>
    assertNormalCargoTargetDirectory(
      path.join(tauriDirectory, "target"),
      {},
      tauriDirectory,
    ),
  );
  assert.throws(
    () =>
      assertNormalCargoTargetDirectory(
        path.join(tauriDirectory, "target"),
        { CARGO_TARGET_DIR: path.join("..", "custom-target") },
        tauriDirectory,
      ),
    /CARGO_TARGET_DIR is not supported/,
  );
  assert.throws(
    () =>
      assertNormalCargoTargetDirectory(
        path.join("workspace", "custom-target"),
        {},
        tauriDirectory,
      ),
    /Remove custom target-dir configuration/,
  );
});

test("development runs guarded Cargo target maintenance before launch", () => {
  const calls = [];
  runCargoTargetMaintenance({
    executable: "node",
    scriptPath: "prune-cargo-target.mjs",
    cwd: "workspace",
    environment: { TEST_ENV: "1" },
    run: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  assert.deepEqual(calls, [
    {
      command: "node",
      args: ["prune-cargo-target.mjs"],
      options: {
        cwd: "workspace",
        env: { TEST_ENV: "1" },
        encoding: "utf8",
        windowsHide: true,
      },
    },
  ]);
});

test("development stops when Cargo target maintenance fails", () => {
  assert.throws(
    () =>
      runCargoTargetMaintenance({
        run: () => ({ status: 3, stdout: "", stderr: "" }),
      }),
    /exited with status 3/,
  );
});

test("quiet-period scheduler coalesces edits", async () => {
  let calls = 0;
  const scheduler = createQuietPeriodScheduler(30, () => {
    calls += 1;
  });

  scheduler.schedule();
  await new Promise((resolve) => setTimeout(resolve, 20));
  scheduler.schedule();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 0);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 1);
});

test("every later edit restarts the entire quiet period", async () => {
  let calls = 0;
  const scheduler = createQuietPeriodScheduler(50, () => {
    calls += 1;
  });

  scheduler.schedule();
  await new Promise((resolve) => setTimeout(resolve, 40));
  scheduler.schedule();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(calls, 0);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 1);
});

test("change event batcher deduplicates watcher noise and keeps distinct files", async () => {
  const batches = [];
  const batcher = createChangeEventBatcher(20, (paths) => {
    batches.push(paths);
  });

  batcher.add("src/provider.rs");
  batcher.add("src/provider.rs");
  batcher.add("Cargo.toml");
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.deepEqual(batches, [["src/provider.rs", "Cargo.toml"]]);
});

test("backend rebuild gate remembers edits made during a successful build", async () => {
  let calls = 0;
  const gate = createBackendRebuildGate(30, () => {
    calls += 1;
  });

  assert.equal(gate.scheduleChange(), "deferred");
  assert.equal(gate.markReady(), true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 0);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 1);
});

test("backend rebuild gate does not add another delay after a long build", async () => {
  let calls = 0;
  const gate = createBackendRebuildGate(20, () => {
    calls += 1;
  });

  assert.equal(gate.scheduleChange(), "deferred");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls, 0);
  assert.equal(gate.markReady(), true);
  assert.equal(calls, 1);
});

test("backend rebuild gate stays idle when no edit event arrives", async () => {
  let calls = 0;
  const gate = createBackendRebuildGate(20, () => {
    calls += 1;
  });

  assert.equal(gate.markReady(), false);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(calls, 0);
});

test("backend rebuild gate cancels a queued rebuild when content returns to baseline", async () => {
  let calls = 0;
  const gate = createBackendRebuildGate(20, () => {
    calls += 1;
  });

  assert.equal(gate.markReady(), false);
  assert.equal(gate.scheduleChange(), "scheduled");
  assert.equal(gate.clearChange(), true);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(calls, 0);
});

test("backend content tracker ignores first-launch watcher noise", () => {
  const fingerprints = new Map([
    ["src/provider.rs", "provider-v1"],
    ["src/transient.tmp", null],
  ]);
  const tracker = createBackendContentTracker(
    [["src/provider.rs", "provider-v1"]],
    (filePath) => fingerprints.get(filePath) ?? null,
  );

  assert.equal(tracker.record("src/provider.rs", "src/provider.rs"), false);
  assert.equal(tracker.record("src/transient.tmp", "src/transient.tmp"), false);
  assert.deepEqual(tracker.dirtyPaths(), []);
});

test("first launch does not queue a second build for unchanged watcher events", async () => {
  let rebuilds = 0;
  const gate = createBackendRebuildGate(20, () => {
    rebuilds += 1;
  });
  const tracker = createBackendContentTracker(
    [["src/lib.rs", "lib-v1"]],
    () => "lib-v1",
  );

  assert.equal(tracker.record("src/lib.rs", "src/lib.rs"), false);
  assert.equal(gate.markReady(), false);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(rebuilds, 0);
});

test("backend content tracker reports real edits once and clears reverted edits", () => {
  const fingerprints = new Map([["src/provider.rs", "provider-v1"]]);
  const tracker = createBackendContentTracker(
    [["src/provider.rs", "provider-v1"]],
    (filePath) => fingerprints.get(filePath) ?? null,
  );

  fingerprints.set("src/provider.rs", "provider-v2");
  assert.equal(tracker.record("src/provider.rs", "src/provider.rs"), true);
  assert.deepEqual(tracker.dirtyPaths(), ["src/provider.rs"]);
  assert.equal(tracker.record("src/provider.rs", "src/provider.rs"), false);

  fingerprints.set("src/provider.rs", "provider-v1");
  assert.equal(tracker.record("src/provider.rs", "src/provider.rs"), true);
  assert.deepEqual(tracker.dirtyPaths(), []);
});

test("backend content tracker treats deletion of a built input as a real edit", () => {
  const tracker = createBackendContentTracker(
    [["src/provider.rs", "provider-v1"]],
    () => null,
  );

  assert.equal(tracker.record("src/provider.rs", "src/provider.rs"), true);
  assert.deepEqual(tracker.dirtyPaths(), ["src/provider.rs"]);
});

test("backend content tracker starts each rebuild from the latest source baseline", () => {
  const fingerprints = new Map([["src/provider.rs", "provider-v1"]]);
  const tracker = createBackendContentTracker(
    [["src/provider.rs", "provider-v1"]],
    (filePath) => fingerprints.get(filePath) ?? null,
  );

  fingerprints.set("src/provider.rs", "provider-v2");
  assert.equal(tracker.record("src/provider.rs", "src/provider.rs"), true);
  tracker.beginBuild([["src/provider.rs", "provider-v2"]]);
  assert.deepEqual(tracker.dirtyPaths(), []);
  assert.equal(tracker.record("src/provider.rs", "src/provider.rs"), false);
});

test("undefined watcher filenames are ignored instead of becoming fake edits", () => {
  const resolveDirectoryEvent = (filename) =>
    filename ? `src/${filename.toString()}` : null;

  assert.equal(resolveDirectoryEvent(undefined), null);
  assert.equal(resolveTauriRootBackendInput(undefined), null);
  assert.equal(resolveTauriRootBackendInput("target"), null);
  assert.equal(resolveTauriRootBackendInput("Cargo.lock"), "Cargo.lock");
  assert.equal(resolveRepoRootBackendInput(undefined), null);
  assert.equal(resolveRepoRootBackendInput("package.json"), null);
  assert.equal(
    resolveRepoRootBackendInput("rust-toolchain.toml"),
    path.join("..", "rust-toolchain.toml"),
  );
  assert.equal(
    resolveRepoRootBackendInput(
      path.join("contracts", "openai-responses.v1.json"),
    ),
    path.join("..", "contracts", "openai-responses.v1.json"),
  );
  assert.equal(
    resolveRepoRootBackendInput(path.join("contracts", "README.md")),
    null,
  );
});

test("backend build baseline includes the repository Rust toolchain file", () => {
  const trackedPaths = new Set(
    snapshotBackendFileFingerprints().map(([trackedPath]) => trackedPath),
  );
  assert.equal(trackedPaths.has(path.join("..", "rust-toolchain.toml")), true);
  assert.equal(
    trackedPaths.has(path.join("..", "contracts", "openai-responses.v1.json")),
    true,
  );
});

test("backend rebuild gate recovers from a failed build and later edits", async () => {
  let calls = 0;
  const gate = createBackendRebuildGate(20, () => {
    calls += 1;
  });

  assert.equal(gate.markFailed(), false);
  assert.equal(gate.scheduleChange(), "scheduled");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls, 1);

  gate.markBuilding();
  assert.equal(gate.scheduleChange(), "deferred");
  assert.equal(gate.markFailed(), true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls, 2);
});

test("cancelled rebuild gate ignores late process and watcher events", async () => {
  let calls = 0;
  const gate = createBackendRebuildGate(10, () => {
    calls += 1;
  });

  gate.scheduleChange();
  gate.cancel();
  assert.equal(gate.markReady(), false);
  assert.equal(gate.markBuilding(), false);
  assert.equal(gate.markFailed(), false);
  assert.equal(gate.scheduleChange(), "ignored");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 0);
});

test("cancelled change event batcher drops pending watcher noise", async () => {
  let calls = 0;
  const batcher = createChangeEventBatcher(10, () => {
    calls += 1;
  });

  batcher.add("src/provider.rs");
  batcher.cancel();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 0);
});

test("expected child exits are consumed exactly once", () => {
  const registry = createExpectedExitRegistry();
  const expectedChild = {};
  const unexpectedChild = {};

  registry.mark(expectedChild);
  assert.equal(registry.consume(unexpectedChild), false);
  registry.unmark(expectedChild);
  assert.equal(registry.consume(expectedChild), false);
  registry.mark(expectedChild);
  assert.equal(registry.consume(expectedChild), true);
  assert.equal(registry.consume(expectedChild), false);
});

test("detects Cargo launching the Tauri executable", () => {
  assert.equal(
    isTauriAppStartedOutput(
      "\u001b[1m\u001b[32m     Running\u001b[0m `target\\debug\\cc-switch.exe`",
    ),
    true,
  );
  assert.equal(
    isTauriAppStartedOutput("Compiling cc-switch v3.19.2-20"),
    false,
  );
  assert.equal(
    isTauriAppStartedOutput(
      "Running `H:\\targets\\custom-debug\\debug\\cc-switch.exe`",
    ),
    true,
  );
  assert.equal(isTauriAppStartedOutput("Running `cargo metadata`"), false);
});

test("Windows shutdown selects only the owned Tauri development chain", () => {
  const repoRoot = "H:\\repos\\ccswitchmulti-fork";
  const processes = [
    {
      ProcessId: 20,
      ParentProcessId: 10,
      Name: "cargo.exe",
      ExecutablePath: "C:\\Users\\dev\\.cargo\\bin\\cargo.exe",
      CommandLine: "cargo run --no-default-features",
    },
    {
      ProcessId: 30,
      ParentProcessId: 20,
      Name: "cc-switch.exe",
      ExecutablePath:
        "H:\\repos\\ccswitchmulti-fork\\src-tauri\\target\\debug\\cc-switch.exe",
      CommandLine: "target\\debug\\cc-switch.exe",
    },
    {
      ProcessId: 40,
      ParentProcessId: 30,
      Name: "ChatGPT.exe",
      ExecutablePath:
        "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0\\app\\ChatGPT.exe",
      CommandLine: "ChatGPT.exe --remote-debugging-port=9222",
    },
    {
      ProcessId: 50,
      ParentProcessId: 40,
      Name: "codex.exe",
      ExecutablePath:
        "C:\\Users\\dev\\AppData\\Local\\OpenAI\\Codex\\codex.exe",
      CommandLine: "codex.exe app-server",
    },
    {
      ProcessId: 60,
      ParentProcessId: 30,
      Name: "cc-switch.exe",
      ExecutablePath: "C:\\Program Files\\CCSwitchMulti\\cc-switch.exe",
      CommandLine: "cc-switch.exe",
    },
  ];

  assert.deepEqual(
    windowsDevDescendants(processes, 10, repoRoot).map(
      (processInfo) => processInfo.ProcessId,
    ),
    [30, 20],
  );
});

test("Windows worker cleanup follows only its Vite and Tauri roots", () => {
  const repoRoot = path.resolve("workspace", "ccswitchmulti");
  const processes = [
    {
      ProcessId: 20,
      ParentProcessId: 10,
      Name: "node.exe",
      CommandLine: 'node "./node_modules/vite/bin/vite.js" --port 3410',
    },
    {
      ProcessId: 21,
      ParentProcessId: 20,
      Name: "esbuild.exe",
      ExecutablePath: path.join(
        repoRoot,
        "node_modules",
        "esbuild",
        "esbuild.exe",
      ),
    },
    {
      ProcessId: 30,
      ParentProcessId: 10,
      Name: "node.exe",
      CommandLine:
        'node ".\\node_modules\\@tauri-apps\\cli\\tauri.js" dev --no-watch',
    },
    {
      ProcessId: 31,
      ParentProcessId: 30,
      Name: "cargo.exe",
      ExecutablePath: "C:\\Users\\dev\\.cargo\\bin\\cargo.exe",
    },
    {
      ProcessId: 32,
      ParentProcessId: 31,
      Name: "cc-switch.exe",
      ExecutablePath: path.join(
        repoRoot,
        "src-tauri",
        "target",
        "debug",
        "cc-switch.exe",
      ),
    },
    {
      ProcessId: 40,
      ParentProcessId: 32,
      Name: "node.exe",
      CommandLine: "codex app-server",
    },
    {
      ProcessId: 41,
      ParentProcessId: 40,
      Name: "cargo.exe",
      CommandLine: "cargo test",
    },
    {
      ProcessId: 50,
      ParentProcessId: 10,
      Name: "node.exe",
      CommandLine: "node unrelated-helper.js",
    },
    {
      ProcessId: 51,
      ParentProcessId: 50,
      Name: "esbuild.exe",
      ExecutablePath: path.join(
        repoRoot,
        "node_modules",
        "esbuild",
        "esbuild.exe",
      ),
    },
    {
      ProcessId: 60,
      ParentProcessId: 99,
      Name: "node.exe",
      CommandLine: 'node "./node_modules/vite/bin/vite.js"',
    },
    {
      ProcessId: 70,
      ParentProcessId: 10,
      Name: "foreign.exe",
      CommandLine: 'node "./node_modules/vite/bin/vite.js"',
    },
  ];

  assert.deepEqual(
    windowsDevWorkerDescendants(processes, 10, repoRoot).map(
      ({ ProcessId, kind }) => ({ ProcessId, kind }),
    ),
    [
      { ProcessId: 32, kind: "app" },
      { ProcessId: 21, kind: "frontend-helper" },
      { ProcessId: 31, kind: "cargo" },
      { ProcessId: 20, kind: "frontend" },
      { ProcessId: 30, kind: "tauri" },
    ],
  );
});

test("Windows worker cleanup refuses a foreign cc-switch descendant", async () => {
  const repoRoot = path.resolve("workspace", "ccswitchmulti");
  const processes = [
    {
      ProcessId: 20,
      ParentProcessId: 10,
      Name: "node.exe",
      CommandLine: 'node "./node_modules/@tauri-apps/cli/tauri.js" dev',
    },
    { ProcessId: 30, ParentProcessId: 20, Name: "cargo.exe" },
    {
      ProcessId: 40,
      ParentProcessId: 30,
      Name: "cc-switch.exe",
      ExecutablePath: path.resolve(
        "foreign",
        "src-tauri",
        "target",
        "debug",
        "cc-switch.exe",
      ),
    },
  ];
  const child = fakeDevWorker(10);
  child.exitCode = 1;
  const terminations = [];
  const select = (snapshot, pid) =>
    windowsDevWorkerDescendants(snapshot, pid, repoRoot);

  assert.equal(select(processes, child.pid)[0].kind, "unverified-app");
  await assert.rejects(
    stopWindowsProcess(child, select, {
      queryProcesses: () => processes,
      terminate: (pid) => {
        terminations.push(pid);
        return { status: 0 };
      },
      log: () => {},
    }),
    /outside the verified Cargo target directory/,
  );
  assert.deepEqual(terminations, []);
});

test("Windows worker relaunch waits for old app and Vite listeners to release", async () => {
  const repoRoot = path.resolve("workspace", "ccswitchmulti");
  const creationDate = "2026-10-13T04:00:00Z";
  const processes = [
    {
      ProcessId: 20,
      ParentProcessId: 10,
      Name: "node.exe",
      ExecutablePath: "C:\\node\\node.exe",
      CreationDate: creationDate,
      CommandLine: 'node "./node_modules/vite/bin/vite.js"',
    },
    {
      ProcessId: 30,
      ParentProcessId: 10,
      Name: "node.exe",
      ExecutablePath: "C:\\node\\node.exe",
      CreationDate: creationDate,
      CommandLine: 'node "./node_modules/@tauri-apps/cli/tauri.js" dev',
    },
    {
      ProcessId: 31,
      ParentProcessId: 30,
      Name: "cargo.exe",
      ExecutablePath: "C:\\cargo\\cargo.exe",
      CreationDate: creationDate,
    },
    {
      ProcessId: 32,
      ParentProcessId: 31,
      Name: "cc-switch.exe",
      ExecutablePath: path.join(
        repoRoot,
        "src-tauri",
        "target",
        "debug",
        "cc-switch.exe",
      ),
      CreationDate: creationDate,
    },
  ];
  const workers = [];
  const actions = [];
  let releaseFrontend;
  const frontendRelease = new Promise((resolve) => {
    releaseFrontend = resolve;
  });
  const supervising = superviseDevSessions({
    spawnSession: () => {
      const child = fakeDevWorker(workers.length === 0 ? 10 : 11);
      workers.push(child);
      actions.push(`launch-worker:${child.pid}`);
      return child;
    },
    cleanSession: (child) =>
      stopWindowsProcess(
        child,
        (snapshot, pid) => windowsDevWorkerDescendants(snapshot, pid, repoRoot),
        {
          queryProcesses: () => processes,
          queryListeners: (info) =>
            info.ProcessId === 32
              ? [{ address: "127.0.0.1", port: 15721 }]
              : info.ProcessId === 20
                ? [{ address: "127.0.0.1", port: 3410 }]
                : [],
          terminate: (pid, force, tree = false) => {
            actions.push(`terminate:${pid}:${force}:${tree}`);
            return { status: 0 };
          },
          waitForProcessExit: async (info) => {
            actions.push(`exited:${info.ProcessId}`);
          },
          waitForListenersReleased: async (listeners) => {
            const port = listeners[0].port;
            actions.push(`release-start:${port}`);
            if (port === 3410) await frontendRelease;
            actions.push(`release-done:${port}`);
          },
          log: () => {},
        },
      ),
    readEnabled: () => true,
    waitToRestart: async () => {},
  });

  workers[0].finish(1);
  await nextEventLoopTurn();
  assert.equal(workers.length, 1);
  assert.equal(actions.includes("release-done:15721"), true);
  assert.equal(actions.includes("release-start:3410"), true);
  assert.equal(actions.includes("release-done:3410"), false);
  releaseFrontend();
  await nextEventLoopTurn();
  assert.equal(workers.length, 2);
  assert.equal(
    actions.indexOf("release-done:3410") < actions.indexOf("launch-worker:11"),
    true,
  );
  assert.equal(actions.includes("terminate:32:true:true"), true);
  assert.equal(actions.includes("terminate:20:true:true"), true);
  workers[1].finish(0);
  assert.equal(await supervising, 0);
});

test("Windows root cleanup checks identity again after listener release", async () => {
  for (const reuseRootPid of [false, true]) {
    const root = {
      ProcessId: 10,
      Name: "node.exe",
      ExecutablePath: "C:\\node\\node.exe",
      CreationDate: "2026-10-13T04:00:00Z",
    };
    const frontend = {
      ...root,
      ProcessId: 20,
      ParentProcessId: 10,
      kind: "frontend",
    };
    const replacement = {
      ...root,
      Name: "unrelated.exe",
      ExecutablePath: "C:\\other\\unrelated.exe",
      CreationDate: "2026-10-13T04:01:00Z",
    };
    let processes = [root, frontend];
    const terminations = [];
    let releaseListener;
    const listenerRelease = new Promise((resolve) => {
      releaseListener = resolve;
    });
    let waitingForListener = false;
    const child = fakeDevWorker(10);
    child.exitCode = 0;
    const cleanup = stopWindowsProcess(child, () => [frontend], {
      expectedRootIdentity: root,
      terminateRoot: true,
      queryProcesses: () => processes,
      queryListeners: () => [{ address: "127.0.0.1", port: 3410 }],
      terminate: (pid, force, tree) => {
        terminations.push({ pid, force, tree });
        processes = processes.filter(({ ProcessId }) => ProcessId !== pid);
        return { status: 0 };
      },
      waitForProcessExit: async () => {},
      waitForListenersReleased: async () => {
        waitingForListener = true;
        await listenerRelease;
      },
      log: () => {},
    });
    await nextEventLoopTurn();
    assert.equal(waitingForListener, true);
    assert.deepEqual(terminations, [{ pid: 20, force: true, tree: true }]);
    if (reuseRootPid) processes = [replacement];
    releaseListener();
    await cleanup;
    assert.deepEqual(terminations, [
      { pid: 20, force: true, tree: true },
      ...(!reuseRootPid ? [{ pid: 10, force: true, tree: true }] : []),
    ]);
  }
});

test("Windows recorded root cleanup skips an already reused PID and its tree", async () => {
  const original = {
    ProcessId: 10,
    Name: "node.exe",
    ExecutablePath: "C:\\node\\node.exe",
    CreationDate: "2026-10-13T04:00:00Z",
  };
  const replacement = {
    ...original,
    CreationDate: "2026-10-13T04:01:00Z",
  };
  const child = fakeDevWorker(10);
  child.exitCode = 0;
  let selectedTree = false;
  const terminations = [];
  await stopWindowsProcess(
    child,
    () => {
      selectedTree = true;
      return [];
    },
    {
      expectedRootIdentity: original,
      terminateRoot: true,
      queryProcesses: () => [replacement],
      terminate: (pid) => {
        terminations.push(pid);
        return { status: 0 };
      },
      log: () => {},
    },
  );
  assert.equal(selectedTree, false);
  assert.deepEqual(terminations, []);
});

test("Windows shutdown roots the tree kill at the verified app", () => {
  const repoRoot = "H:\\repos\\ccswitchmulti-fork";
  const processes = [
    {
      ProcessId: 20,
      ParentProcessId: 10,
      Name: "cargo.exe",
      ExecutablePath: "C:\\Users\\dev\\.cargo\\bin\\cargo.exe",
      CommandLine: "cargo run --no-default-features",
    },
    {
      ProcessId: 30,
      ParentProcessId: 20,
      Name: "cc-switch.exe",
      ExecutablePath:
        "H:\\repos\\ccswitchmulti-fork\\src-tauri\\target\\debug\\cc-switch.exe",
      CommandLine: "target\\debug\\cc-switch.exe",
    },
    {
      ProcessId: 40,
      ParentProcessId: 30,
      Name: "ChatGPT.exe",
      ExecutablePath:
        "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0\\app\\ChatGPT.exe",
      CommandLine: "ChatGPT.exe",
    },
    {
      ProcessId: 50,
      ParentProcessId: 40,
      Name: "cargo.exe",
      ExecutablePath: "C:\\Users\\dev\\.cargo\\bin\\cargo.exe",
      CommandLine: "cargo test",
    },
    {
      ProcessId: 60,
      ParentProcessId: 50,
      Name: "cc-switch.exe",
      ExecutablePath:
        "H:\\repos\\ccswitchmulti-fork\\src-tauri\\target\\debug\\cc-switch.exe",
      CommandLine: "target\\debug\\cc-switch.exe",
    },
  ];

  assert.deepEqual(
    windowsDevDescendants(processes, 10, repoRoot).map(
      (processInfo) => processInfo.ProcessId,
    ),
    [30, 20],
  );
});

test("Windows shutdown blocks unverified same-name app descendants", () => {
  const descendants = windowsDevDescendants(
    [
      {
        ProcessId: 20,
        ParentProcessId: 10,
        Name: "cargo.exe",
        ExecutablePath: "C:\\Users\\dev\\.cargo\\bin\\cargo.exe",
      },
      {
        ProcessId: 70,
        ParentProcessId: 20,
        Name: "cc-switch.exe",
        ExecutablePath: "H:\\other\\src-tauri\\target\\debug\\cc-switch.exe",
        CommandLine: "cc-switch.exe",
      },
    ],
    10,
    "H:\\repos\\ccswitchmulti-fork",
    {},
  );
  assert.deepEqual(
    descendants.map(({ ProcessId, kind }) => ({ ProcessId, kind })),
    [
      { ProcessId: 70, kind: "unverified-app" },
      { ProcessId: 20, kind: "cargo" },
    ],
  );
});

test("Windows shutdown rejects apps outside the repository Cargo target directory", () => {
  const descendants = windowsDevDescendants(
    [
      {
        ProcessId: 20,
        ParentProcessId: 10,
        Name: "cargo.exe",
        ExecutablePath: "C:\\Users\\dev\\.cargo\\bin\\cargo.exe",
      },
      {
        ProcessId: 30,
        ParentProcessId: 20,
        Name: "cc-switch.exe",
        ExecutablePath:
          "H:\\repos\\ccswitchmulti-fork\\custom-target\\debug\\cc-switch.exe",
      },
    ],
    10,
    "H:\\repos\\ccswitchmulti-fork",
  );
  assert.deepEqual(
    descendants.map(({ ProcessId, kind }) => ({ ProcessId, kind })),
    [
      { ProcessId: 30, kind: "unverified-app" },
      { ProcessId: 20, kind: "cargo" },
    ],
  );
});

test("Windows listener parsing supports zero, one, or multiple endpoints", () => {
  assert.deepEqual(parseWindowsListeners(""), []);
  assert.deepEqual(
    parseWindowsListeners('{"LocalAddress":"127.0.0.1","LocalPort":15721}'),
    [{ address: "127.0.0.1", port: 15721 }],
  );
  assert.deepEqual(
    parseWindowsListeners(
      '[{"LocalAddress":"127.0.0.1","LocalPort":15721},{"LocalAddress":"::1","LocalPort":15722}]',
    ),
    [
      { address: "127.0.0.1", port: 15721 },
      { address: "::1", port: 15722 },
    ],
  );
});

test("verified Windows app force-terminates its verified tree before rebuild", async () => {
  const app = {
    ProcessId: 30,
    Name: "cc-switch.exe",
    ExecutablePath:
      "H:\\repos\\ccswitchmulti-fork\\src-tauri\\target\\debug\\cc-switch.exe",
    CreationDate: "20260830210502.000000+480",
  };
  const terminations = [];
  const events = [];

  await stopVerifiedWindowsApp(app, {
    queryProcesses: () => [app],
    queryListeners: () => [{ address: "127.0.0.1", port: 15721 }],
    terminate: (processId, force, tree) => {
      events.push("terminate");
      terminations.push({ processId, force, tree });
      return { status: 0 };
    },
    waitForProcessExit: async () => {
      events.push("process-exited");
    },
    waitForListenersReleased: async () => {
      events.push("listeners-released");
    },
    log: () => {},
  });

  assert.deepEqual(terminations, [{ processId: 30, force: true, tree: true }]);
  assert.deepEqual(events, [
    "terminate",
    "process-exited",
    "listeners-released",
  ]);
});

test("verified Windows app waits for forced tree termination", async () => {
  const app = {
    ProcessId: 30,
    Name: "cc-switch.exe",
    ExecutablePath:
      "H:\\repos\\ccswitchmulti-fork\\src-tauri\\target\\debug\\cc-switch.exe",
    CreationDate: "20260830210502.000000+480",
  };
  const terminations = [];
  const waitTimeouts = [];

  await stopVerifiedWindowsApp(app, {
    queryProcesses: () => [app],
    queryListeners: () => [],
    terminate: (processId, force, tree) => {
      terminations.push({ processId, force, tree });
      return { status: 0 };
    },
    waitForProcessExit: async (_processInfo, _query, timeoutMs) => {
      waitTimeouts.push(timeoutMs);
    },
    forcedTimeoutMs: 2_000,
    log: () => {},
  });

  assert.deepEqual(terminations, [{ processId: 30, force: true, tree: true }]);
  assert.deepEqual(waitTimeouts, [2_000]);
});

test("verified Windows app forced fallback reports a stuck owned tree", async () => {
  const app = {
    ProcessId: 30,
    Name: "cc-switch.exe",
    ExecutablePath:
      "H:\\repos\\ccswitchmulti-fork\\src-tauri\\target\\debug\\cc-switch.exe",
    CreationDate: "20260830210502.000000+480",
  };
  const terminations = [];
  const waitTimeouts = [];

  await assert.rejects(
    stopVerifiedWindowsApp(app, {
      queryProcesses: () => [app],
      queryListeners: () => [],
      terminate: (processId, force, tree) => {
        terminations.push({ processId, force, tree });
        return { status: 0, stderr: "still running" };
      },
      waitForProcessExit: async (_processInfo, _query, timeoutMs) => {
        waitTimeouts.push(timeoutMs);
        throw new Error("forced timeout");
      },
      forcedTimeoutMs: 2_000,
      log: () => {},
    }),
    /Could not stop owned cc-switch\.exe process tree.*still running/,
  );

  assert.deepEqual(terminations, [{ processId: 30, force: true, tree: true }]);
  assert.deepEqual(waitTimeouts, [2_000]);
});

test("Windows listener release barrier waits until every endpoint is bindable", async () => {
  const attempts = new Map();
  const listeners = [
    { address: "127.0.0.1", port: 15721 },
    { address: "::1", port: 15722 },
  ];

  await waitForWindowsListenersReleased(
    listeners,
    async ({ port }) => {
      const attempt = (attempts.get(port) ?? 0) + 1;
      attempts.set(port, attempt);
      return port === 15722 || attempt >= 2;
    },
    1_000,
  );

  assert.equal(attempts.get(15721), 2);
  assert.equal(attempts.get(15722), 2);
});

test("Windows frontend shutdown selects only repo-owned Vite helpers", () => {
  const descendants = windowsFrontendDescendants(
    [
      {
        ProcessId: 20,
        ParentProcessId: 10,
        Name: "esbuild.exe",
        ExecutablePath:
          "H:\\repos\\ccswitchmulti-fork\\node_modules\\.pnpm\\esbuild\\esbuild.exe",
      },
      {
        ProcessId: 30,
        ParentProcessId: 10,
        Name: "node.exe",
        ExecutablePath: "H:\\other\\node_modules\\helper\\node.exe",
      },
      {
        ProcessId: 40,
        ParentProcessId: 10,
        Name: "Codex.exe",
        ExecutablePath: "C:\\Program Files\\OpenAI\\Codex.exe",
      },
    ],
    10,
    "H:\\repos\\ccswitchmulti-fork",
  );
  assert.deepEqual(
    descendants.map(({ ProcessId, kind }) => ({ ProcessId, kind })),
    [{ ProcessId: 20, kind: "frontend-helper" }],
  );
});

test("target path matching requires an actual directory boundary", () => {
  const target = "H:\\repos\\ccswitchmulti-fork\\src-tauri\\target";
  assert.equal(isPathInside(target, `${target}\\debug\\cc-switch.exe`), true);
  assert.equal(
    isPathInside(target, `${target}-imposter\\debug\\cc-switch.exe`),
    false,
  );
});

test("Windows shutdown identity rejects PID reuse", () => {
  const original = {
    ProcessId: 70,
    Name: "cargo.exe",
    ExecutablePath: "C:\\Users\\dev\\.cargo\\bin\\cargo.exe",
    CreationDate: "20260830083000.000000+480",
  };

  assert.equal(sameWindowsProcess(original, { ...original }), true);
  assert.equal(
    sameWindowsProcess(original, {
      ...original,
      CreationDate: "20260830083100.000000+480",
    }),
    false,
  );
  assert.equal(
    sameWindowsProcess(original, {
      ...original,
      ExecutablePath: "C:\\Windows\\System32\\cargo.exe",
    }),
    false,
  );
  assert.equal(
    sameWindowsProcess(original, { ...original, CreationDate: "" }),
    false,
  );
});

test("Windows process creation dates normalize PowerShell JSON and UTC forms", () => {
  const iso = "2026-10-13T04:00:00.000Z";
  const milliseconds = Date.parse(iso);
  assert.equal(windowsProcessStartedAtUtc({ CreationDate: iso }), iso);
  assert.equal(
    windowsProcessStartedAtUtc({ CreationDate: `/Date(${milliseconds})/` }),
    iso,
  );
  assert.equal(
    windowsProcessStartedAtUtc({
      CreationDate: `/Date(${milliseconds}+0800)/`,
    }),
    iso,
  );
});

test("Windows process exit wait tolerates delayed WMI disappearance", async () => {
  const original = {
    ProcessId: 70,
    Name: "cargo.exe",
    ExecutablePath: "C:\\Users\\dev\\.cargo\\bin\\cargo.exe",
    CreationDate: "20260830083000.000000+480",
  };
  let queries = 0;

  await waitForWindowsProcessExit(
    original,
    () => {
      queries += 1;
      return queries < 3 ? [original] : [];
    },
    200,
  );
  assert.equal(queries, 3);
});

test("Windows process exit wait rejects a process that remains alive", async () => {
  const original = {
    ProcessId: 70,
    Name: "cargo.exe",
    ExecutablePath: "C:\\Users\\dev\\.cargo\\bin\\cargo.exe",
    CreationDate: "20260830083000.000000+480",
  };

  await assert.rejects(
    waitForWindowsProcessExit(original, () => [original], 10),
    /did not exit/,
  );
});

test("child exit synchronization waits for the exit event", async () => {
  const child = new EventEmitter();
  child.pid = 70;
  child.exitCode = null;
  child.signalCode = null;

  let settled = false;
  const waiting = waitForChildExit(child, 100).then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, false);

  child.exitCode = 0;
  child.emit("exit", 0, null);
  await waiting;
  assert.equal(settled, true);
});

test("child exit synchronization rejects instead of overlapping generations", async () => {
  const child = new EventEmitter();
  child.pid = 71;
  child.exitCode = null;
  child.signalCode = null;

  await assert.rejects(waitForChildExit(child, 10), /did not exit/);
});
