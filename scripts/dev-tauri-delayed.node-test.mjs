import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { utcTicks } from "./ccswitchmulti-guardian-core.mjs";
import { createDevReconnectTracker } from "./dev-watchdog-policy.mjs";
import { DEV_RECOVERY_FLAG } from "./dev-session-launch.mjs";

import {
  assertNormalCargoTargetDirectory,
  createBackendContentTracker,
  createBackendRebuildGate,
  createChangeEventBatcher,
  createExpectedExitRegistry,
  createQuietPeriodScheduler,
  createDevWorkerRecovery,
  createDevRootRecord,
  cleanRecordedDevRoots,
  cleanRecordedDevWorker,
  devAppIdentityMatchesProcess,
  legacyDevAppIdentityForPlannedStop,
  createDevSupervisorHandoff,
  devAutoRestartDecision,
  devSessionEnvironment,
  devWorkerCommand,
  devWorkerRestartDecision,
  handoffDetachedDevSupervisor,
  handleDevWorkerDisconnect,
  isManualTakeoverHandoff,
  isDevCrashMarker,
  isPathInside,
  isTauriAppStartedOutput,
  normalizeCliArgs,
  observeDevChildTermination,
  parseDelayMs,
  parseNoRebuild,
  parsePort,
  preserveManualTakeoverHandoff,
  retireDevWorkerForManualHandoff,
  parseWindowsJsonQueryOutput,
  queryWindowsProcesses,
  readDevRestartTimesMs,
  readDevRunMarkerPresent,
  readDevWatchdogEnabled,
  reportDevSupervisorDecision,
  resolveDevRunMarkerPath,
  resolveDevSettingsPath,
  parseWindowsListeners,
  persistIndependentWatchdog,
  resolveRepoRootBackendInput,
  resolveTauriRootBackendInput,
  runCargoTargetMaintenance,
  runPlannedDevCleanup,
  runDetachedDevWatchdog,
  runWindowsJsonQuery,
  sameWindowsProcess,
  snapshotBackendFileFingerprints,
  stopVerifiedWindowsApp,
  stopWindowsProcess,
  superviseDevSessions,
  waitForChildExit,
  waitForDevSupervisorPublication,
  waitForManualDevHandoffReady,
  waitForWindowsListenersReleased,
  waitForWindowsProcessExit,
  windowsDevDescendants,
  windowsDevWorkerDescendants,
  windowsFrontendDescendants,
  windowsJsonQueryCommand,
  windowsProcessObservationCrashed,
  windowsProcessStartedAtUtc,
} from "./dev-tauri-delayed.mjs";

test("failed watchdog marker publication retires the newly launched independent watchdog", () => {
  const identity = { ProcessId: 4242 };
  const actions = [];
  assert.throws(
    () =>
      persistIndependentWatchdog({
        launch: () => {
          actions.push("launch");
          return identity;
        },
        persist: () => {
          actions.push("persist");
          throw new Error("marker write failed");
        },
        stop: (current) => {
          actions.push(["stop", current]);
        },
      }),
    /marker write failed/,
  );
  assert.deepEqual(actions, ["launch", "persist", ["stop", identity]]);
});

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

test("development recovery uses the app run marker to detect code-zero crashes", () => {
  assert.equal(
    resolveDevRunMarkerPath({
      CC_SWITCH_TEST_HOME: path.join("tmp", "cc-switch"),
    }),
    path.join("tmp", "cc-switch", ".cc-switch", "logs", "app-run-marker.json"),
  );
  const identity = {
    pid: 42,
    executablePath: path.resolve(
      "src-tauri",
      "target",
      "debug",
      "cc-switch.exe",
    ),
    processStartedAtTicks: "1234",
    markerPath: path.join("custom-config", "logs", "app-run-marker.json"),
  };
  const read = (markerPath) => {
    assert.equal(markerPath, identity.markerPath);
    return JSON.stringify(identity);
  };
  assert.equal(readDevRunMarkerPresent({}, read, identity), true);
  assert.equal(
    readDevRunMarkerPresent(
      {},
      () => JSON.stringify({ ...identity, pid: 43 }),
      identity,
    ),
    false,
  );
  assert.equal(
    readDevRunMarkerPresent(
      {},
      () => JSON.stringify({ ...identity, processStartedAtTicks: "1235" }),
      identity,
    ),
    false,
  );
  assert.equal(readDevRunMarkerPresent({}, read), false);
  assert.equal(
    readDevRunMarkerPresent(
      {},
      () => {
        const error = new Error("marker removed after intentional quit");
        error.code = "ENOENT";
        throw error;
      },
      identity,
    ),
    false,
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
      runMarkerPresent: false,
    }),
    { restart: false, reason: "clean-exit" },
  );
  assert.deepEqual(
    devAutoRestartDecision({
      appStarted: true,
      exitCode: 0,
      signal: null,
      watchdogEnabled: true,
      runMarkerPresent: true,
    }),
    { restart: true, reason: "unexpected-exit" },
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
  assert.deepEqual(
    devAutoRestartDecision({
      appStarted: true,
      exitCode: null,
      signal: "SIGINT",
      watchdogEnabled: true,
    }),
    { restart: false, reason: "signal" },
  );
});

test("live reconnect recovery respects an intentional quit that removed the run marker", () => {
  assert.deepEqual(
    devAutoRestartDecision({
      appStarted: true,
      appRunning: true,
      exitCode: 1,
      signal: null,
      runMarkerPresent: false,
      watchdogEnabled: true,
    }),
    { restart: false, reason: "clean-exit" },
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

test("development restart history migrates legacy sessions without competing canonical state", () => {
  const nowMs = 2_000_000;
  const legacy = Array(4).fill(nowMs - 1_000);
  assert.deepEqual(
    readDevRestartTimesMs({ supervisorRestartTimesMs: legacy }, nowMs),
    legacy,
  );
  assert.deepEqual(
    readDevRestartTimesMs(
      { restartTimesMs: [], supervisorRestartTimesMs: legacy },
      nowMs,
    ),
    [],
  );
  assert.deepEqual(
    readDevRestartTimesMs(
      { restartTimesMs: [nowMs], supervisorRestartTimesMs: legacy },
      nowMs,
    ),
    [nowMs],
  );
  assert.deepEqual(
    readDevRestartTimesMs(
      { restartTimesMs: null, supervisorRestartTimesMs: legacy },
      nowMs,
    ),
    legacy,
  );
  assert.deepEqual(
    readDevRestartTimesMs(
      {
        restartTimesMs: [
          nowMs - 1_800_001,
          nowMs - 1_800_000,
          nowMs,
          "2000000",
          null,
          NaN,
          1.5,
        ],
      },
      nowMs,
    ),
    [nowMs - 1_800_000, nowMs],
  );
  assert.deepEqual(readDevRestartTimesMs(undefined, nowMs), []);
});

test("every development recovery decision rejects malformed restart history consistently", () => {
  const defaults = {
    exitCode: 1,
    signal: null,
    watchdogEnabled: true,
    nowMs: 2_000_000,
    restartTimesMs: ["2000000", "2000000", Infinity, 2_000_000.5, Infinity],
  };
  for (const decide of [devAutoRestartDecision, devWorkerRestartDecision]) {
    assert.deepEqual(decide(defaults), {
      restart: true,
      reason: "unexpected-exit",
    });
  }
});

test("development settings use canonical field presence instead of a stale legacy fallback", () => {
  assert.equal(
    readDevWatchdogEnabled(
      { CC_SWITCH_TEST_HOME: "tmp" },
      () => '{"watchdogEnabled":null,"watchdog_enabled":false}',
    ),
    true,
  );
});

test("development and external recovery share settings and restart-history fixtures", () => {
  const cases = JSON.parse(
    readFileSync(
      new URL(
        "./tests/fixtures/dev-recovery-policy-cases.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  for (const entry of cases.settings) {
    assert.equal(
      readDevWatchdogEnabled({ CC_SWITCH_TEST_HOME: "tmp" }, () =>
        JSON.stringify(entry.value),
      ),
      entry.enabled,
      entry.name,
    );
  }
  for (const entry of cases.history) {
    assert.deepEqual(
      readDevRestartTimesMs(entry.session, entry.nowMs),
      entry.times,
      entry.name,
    );
  }
  for (const entry of cases.overrides) {
    assert.equal(
      readDevWatchdogEnabled(
        { ...entry.environment, CC_SWITCH_TEST_HOME: "tmp" },
        () => '{"watchdogEnabled":false}',
      ),
      entry.enabled,
      entry.name,
    );
  }
});

test("live development recovery requests one worker failure without a second restart budget", () => {
  const scheduled = [];
  const recovered = [];
  const recovery = createDevWorkerRecovery({
    isCurrent: () => true,
    readEnabled: () => true,
    readMarkerPresent: () => true,
    recover: (reason) => recovered.push(reason),
    schedule: (callback, delayMs) => {
      scheduled.push({ callback, delayMs });
      return scheduled.length;
    },
  });

  assert.equal(recovery.request("reconnect-loop"), true);
  assert.equal(recovery.request("backend-process-crashed"), false);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delayMs, 1_000);
  assert.deepEqual(recovered, []);
  scheduled[0].callback();
  assert.deepEqual(recovered, ["reconnect-loop"]);
  assert.equal(recovery.request("backend-process-crashed"), false);
});

test("live development recovery requires an enabled current app with its exact run marker", () => {
  for (const absent of ["current", "enabled", "marker"]) {
    const recovery = createDevWorkerRecovery({
      isCurrent: () => absent !== "current",
      readEnabled: () => absent !== "enabled",
      readMarkerPresent: () => absent !== "marker",
      recover: () => assert.fail("an unverified app must not be recovered"),
      schedule: () => assert.fail("an unverified app must not queue recovery"),
    });
    assert.equal(recovery.request("backend-process-crashed"), false);
  }
});

test("live development recovery rereads quit markers and watchdog preferences before handing off", () => {
  for (const cancelledState of ["current", "enabled", "marker"]) {
    const state = { current: true, enabled: true, marker: true };
    const scheduled = [];
    const recovered = [];
    const recovery = createDevWorkerRecovery({
      isCurrent: () => state.current,
      readEnabled: () => state.enabled,
      readMarkerPresent: () => state.marker,
      recover: (reason) => recovered.push(reason),
      schedule: (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
    });

    assert.equal(recovery.request("reconnect-loop"), true);
    state[cancelledState] = false;
    scheduled[0]();
    assert.deepEqual(recovered, []);
    if (cancelledState !== "current") {
      state[cancelledState] = true;
      assert.equal(recovery.request("reconnect-loop"), true);
      scheduled[1]();
      assert.deepEqual(recovered, ["reconnect-loop"]);
    }
  }
});

for (const terminal of ["stream_finished", "stream_cancelled"]) {
  test(`queued reconnect recovery revalidates ${terminal} before shutdown`, () => {
    const tracker = createDevReconnectTracker();
    const key = "0123456789abcdef";
    let nowMs = 60_000;
    const scheduled = [];
    const recovered = [];
    const recovery = createDevWorkerRecovery({
      isCurrent: () => true,
      readEnabled: () => true,
      readMarkerPresent: () => true,
      isRecoveryNeeded: (reason) =>
        reason === "reconnect-loop" && tracker.recoveryReason(nowMs) === reason,
      recover: (reason) => recovered.push(reason),
      schedule: (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
    });
    for (const [attempt, time] of [
      [1, 0],
      [2, 30_000],
      [3, 60_000],
    ]) {
      tracker.observe({ event: "retry_scheduled", key, attempt }, time);
    }
    assert.equal(recovery.request(tracker.recoveryReason(nowMs)), true);
    tracker.observe({ event: terminal, key }, 60_500);
    nowMs = 61_000;
    scheduled[0]();
    assert.deepEqual(recovered, []);

    const nextKey = "fedcba9876543210";
    for (const [attempt, time] of [
      [1, 70_000],
      [2, 100_000],
      [3, 130_000],
    ]) {
      tracker.observe(
        { event: "retry_scheduled", key: nextKey, attempt },
        time,
      );
    }
    nowMs = 130_000;
    assert.equal(recovery.request(tracker.recoveryReason(nowMs)), true);
    scheduled[0]();
    assert.deepEqual(recovered, []);
    scheduled[1]();
    assert.deepEqual(recovered, ["reconnect-loop"]);
  });
}

for (const stateBeforeTimer of ["running", "unavailable"]) {
  test(`queued backend recovery skips the ${stateBeforeTimer} process probe and allows a later crash`, () => {
    const observed = {
      ProcessId: 42,
      Name: "cc-switch.exe",
      ExecutablePath: path.resolve(
        "isolated",
        "target",
        "debug",
        "cc-switch.exe",
      ),
      CreationDate: "2026-10-14T02:00:00Z",
    };
    let processState = "crashed";
    const scheduled = [];
    const recovered = [];
    const recovery = createDevWorkerRecovery({
      isCurrent: () => true,
      readEnabled: () => true,
      readMarkerPresent: () => true,
      isRecoveryNeeded: (reason) => {
        assert.equal(reason, "backend-process-crashed");
        if (processState === "unavailable") {
          throw new Error("isolated process identity query unavailable");
        }
        return windowsProcessObservationCrashed(
          observed,
          processState === "running" ? observed : undefined,
        );
      },
      recover: (reason) => recovered.push(reason),
      schedule: (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
    });
    assert.equal(recovery.request("backend-process-crashed"), true);
    processState = stateBeforeTimer;
    scheduled[0]();
    assert.deepEqual(recovered, []);
    processState = "crashed";
    assert.equal(recovery.request("backend-process-crashed"), true);
    scheduled[1]();
    assert.deepEqual(recovered, ["backend-process-crashed"]);
  });
}

for (const terminal of ["stream_finished", "stream_cancelled"]) {
  test(`queued reconnect recovery preserves another failed stream after ${terminal}`, () => {
    const tracker = createDevReconnectTracker();
    const finishedKey = "0123456789abcdef";
    const activeKey = "fedcba9876543210";
    for (const key of [finishedKey, activeKey]) {
      for (const [attempt, time] of [
        [1, 0],
        [2, 30_000],
        [3, 60_000],
      ]) {
        tracker.observe({ event: "retry_scheduled", key, attempt }, time);
      }
    }
    const scheduled = [];
    const recovered = [];
    const recovery = createDevWorkerRecovery({
      isCurrent: () => true,
      readEnabled: () => true,
      readMarkerPresent: () => true,
      isRecoveryNeeded: (reason) =>
        reason === "reconnect-loop" &&
        tracker.recoveryReason(61_000) === reason,
      recover: (reason) => recovered.push(reason),
      schedule: (callback) => {
        scheduled.push(callback);
        return 1;
      },
    });
    assert.equal(recovery.request("reconnect-loop"), true);
    tracker.observe({ event: terminal, key: finishedKey }, 60_500);
    scheduled[0]();
    assert.deepEqual(recovered, ["reconnect-loop"]);
  });
}

test("queued recovery rechecks quit state after a blocking reason probe", () => {
  for (const changed of ["current", "enabled", "marker"]) {
    const state = { current: true, enabled: true, marker: true };
    const scheduled = [];
    const recovered = [];
    const recovery = createDevWorkerRecovery({
      isCurrent: () => state.current,
      readEnabled: () => state.enabled,
      readMarkerPresent: () => state.marker,
      isRecoveryNeeded: () => {
        state[changed] = false;
        return true;
      },
      recover: (reason) => recovered.push(reason),
      schedule: (callback) => {
        scheduled.push(callback);
        return 1;
      },
    });
    assert.equal(recovery.request("backend-process-crashed"), true);
    scheduled[0]();
    assert.deepEqual(recovered, []);
  }
});

test("expected source rebuilds cancel live recovery and reject old app signals during cleanup", () => {
  let restartInProgress = false;
  const scheduled = [];
  const cancelled = [];
  const recovered = [];
  const recovery = createDevWorkerRecovery({
    isCurrent: () => !restartInProgress,
    readEnabled: () => true,
    readMarkerPresent: () => true,
    recover: (reason) => recovered.push(reason),
    schedule: (callback) => {
      scheduled.push(callback);
      return scheduled.length;
    },
    cancelScheduled: (timer) => cancelled.push(timer),
  });

  assert.equal(recovery.request("reconnect-loop"), true);
  restartInProgress = true;
  recovery.cancel();
  assert.deepEqual(cancelled, [1]);
  assert.equal(recovery.request("backend-process-crashed"), false);
  scheduled[0]();
  assert.deepEqual(recovered, []);
  restartInProgress = false;
  assert.equal(recovery.request("reconnect-loop"), true);
  scheduled[0]();
  assert.deepEqual(recovered, []);
  scheduled[1]();
  assert.deepEqual(recovered, ["reconnect-loop"]);
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

test("live reconnect recovery restarts the full dev session after cleanup even with no source rebuilds", async () => {
  const args = ["--delay", "14400000", "--no-rebuild"];
  const workers = [];
  const scheduled = [];
  const actions = [];
  let releaseCleanup;
  const cleanupBarrier = new Promise((resolve) => {
    releaseCleanup = resolve;
  });
  const supervising = superviseDevSessions({
    spawnSession: () => {
      assert.deepEqual(devWorkerCommand(args).args.slice(2), args);
      const child = fakeDevWorker(workers.length + 1);
      workers.push(child);
      actions.push(`launch-full-session:${child.pid}`);
      if (child.pid === 1) {
        child.recovery = createDevWorkerRecovery({
          isCurrent: () => child.exitCode === null,
          readEnabled: () => true,
          readMarkerPresent: () => true,
          recover: (reason) => {
            actions.push(`worker-failure:${reason}`);
            child.finish(1);
          },
          schedule: (callback, delayMs) => {
            scheduled.push({ callback, delayMs });
            return scheduled.length;
          },
        });
      }
      return child;
    },
    cleanSession: async (child) => {
      actions.push(`cleanup-start:${child.pid}`);
      if (child.pid === 1) await cleanupBarrier;
      actions.push(`cleanup-done:${child.pid}`);
    },
    readEnabled: () => true,
    waitToRestart: async () => actions.push("supervisor-restart-delay"),
  });

  assert.equal(parseDelayMs(args, {}), 14_400_000);
  assert.equal(parseNoRebuild(args, {}), true);
  const tracker = createDevReconnectTracker();
  for (const [attempt, nowMs] of [
    [1, 0],
    [2, 30_000],
    [3, 60_000],
  ]) {
    tracker.observe(
      {
        event: "retry_scheduled",
        key: "0123456789abcdef",
        attempt,
      },
      nowMs,
    );
  }
  const reason = tracker.recoveryReason(60_000);
  assert.equal(reason, "reconnect-loop");
  assert.equal(workers[0].recovery.request(reason), true);
  assert.equal(scheduled[0].delayMs, 1_000);
  scheduled[0].callback();
  await nextEventLoopTurn();
  assert.equal(workers.length, 1);
  assert.deepEqual(actions, [
    "launch-full-session:1",
    "worker-failure:reconnect-loop",
    "cleanup-start:1",
  ]);
  releaseCleanup();
  await nextEventLoopTurn();
  assert.equal(workers.length, 2);
  assert.deepEqual(actions.slice(3), [
    "cleanup-done:1",
    "supervisor-restart-delay",
    "launch-full-session:2",
  ]);
  workers[1].finish(0);
  assert.equal(await supervising, 0);
});

test("live reconnect and process crashes share the full-session five-restart limit", async () => {
  let launches = 0;
  let cleanups = 0;
  const recoveryReasons = [];
  const decisions = [];
  const code = await superviseDevSessions({
    spawnSession: () => {
      const child = fakeDevWorker(++launches);
      const reason =
        launches % 2 === 0 ? "backend-process-crashed" : "reconnect-loop";
      const recovery = createDevWorkerRecovery({
        isCurrent: () => child.exitCode === null,
        readEnabled: () => true,
        readMarkerPresent: () => true,
        recover: (recoveryReason) => {
          recoveryReasons.push(recoveryReason);
          child.finish(1);
        },
        schedule: (callback) => {
          queueMicrotask(callback);
          return launches;
        },
      });
      recovery.request(reason);
      return child;
    },
    cleanSession: async () => {
      cleanups += 1;
    },
    readEnabled: () => true,
    now: () => 2_000_000,
    waitToRestart: async () => {},
    onEvent: (decision) => decisions.push(decision.reason),
  });

  assert.equal(code, 1);
  assert.equal(launches, 6);
  assert.equal(cleanups, 6);
  assert.deepEqual(recoveryReasons, [
    "reconnect-loop",
    "backend-process-crashed",
    "reconnect-loop",
    "backend-process-crashed",
    "reconnect-loop",
    "backend-process-crashed",
  ]);
  assert.equal(decisions.at(-1), "rate-limited");
});

test("replacement supervisors respect persisted worker and launcher restart history", async () => {
  const nowMs = 2_000_000;
  const restartTimesMs = Array(5).fill(nowMs - 1_000);
  let launches = 0;
  const decisions = [];
  const code = await superviseDevSessions({
    spawnSession: () => {
      const child = fakeDevWorker(++launches);
      queueMicrotask(() => child.finish(1));
      return child;
    },
    cleanSession: async () => {},
    readEnabled: () => true,
    now: () => nowMs,
    restartTimesMs,
    waitToRestart: async () => {},
    onEvent: (decision) => decisions.push(decision.reason),
  });

  assert.equal(code, 1);
  assert.equal(launches, 1);
  assert.deepEqual(decisions, ["rate-limited"]);
  assert.deepEqual(restartTimesMs, Array(5).fill(nowMs - 1_000));
});

test("development rate limit exposes one durable event for the exact supervisor", async () => {
  const nowMs = 2_000_000;
  const events = [];
  let launches = 0;
  const code = await superviseDevSessions({
    spawnSession: () => {
      const child = fakeDevWorker(++launches);
      queueMicrotask(() => child.finish(1));
      return child;
    },
    cleanSession: async () => {},
    readEnabled: () => true,
    now: () => nowMs,
    restartTimesMs: Array(5).fill(nowMs),
    waitToRestart: async () =>
      assert.fail("a limited supervisor must not launch another session"),
    onEvent: (_decision, _outcome, watchdogEvent) => {
      if (watchdogEvent) events.push(watchdogEvent);
    },
  });

  assert.equal(code, 1);
  assert.equal(launches, 1);
  assert.deepEqual(events, [
    {
      event: "dev-session-restart-limited",
      detail: { supervisorPid: process.pid, restartCount: 5 },
    },
  ]);
});

test("worker recovery persists the shared restart budget before its restart delay", async () => {
  const nowMs = 2_000_000;
  const session = { restartTimesMs: Array(4).fill(nowMs - 1_000) };
  let persisted;
  let launches = 0;
  const code = await superviseDevSessions({
    spawnSession: () => {
      const child = fakeDevWorker(++launches);
      queueMicrotask(() => child.finish(1));
      return child;
    },
    cleanSession: async () => {},
    readEnabled: () => true,
    now: () => nowMs,
    restartTimesMs: session.restartTimesMs,
    onRestart: () => {
      persisted = JSON.parse(JSON.stringify(session));
    },
    waitToRestart: async () => {
      assert.deepEqual(persisted?.restartTimesMs, [
        ...Array(4).fill(nowMs - 1_000),
        nowMs,
      ]);
    },
  });

  assert.equal(code, 1);
  assert.equal(launches, 2);
  assert.equal(persisted.restartTimesMs.length, 5);
});

test("four worker recoveries and one launcher recovery block the next restart", async () => {
  const nowMs = 2_000_000;
  const session = { restartTimesMs: [] };
  let persisted;
  let workerLaunches = 0;
  await assert.rejects(
    superviseDevSessions({
      spawnSession: () => {
        const child = fakeDevWorker(++workerLaunches);
        queueMicrotask(() => child.finish(1));
        return child;
      },
      cleanSession: async () => {},
      readEnabled: () => true,
      now: () => nowMs,
      restartTimesMs: session.restartTimesMs,
      onRestart: () => {
        persisted = JSON.parse(JSON.stringify(session));
      },
      waitToRestart: async () => {
        if (persisted.restartTimesMs.length === 4) {
          throw new Error("injected launcher crash during restart delay");
        }
      },
    }),
    /injected launcher crash/,
  );
  assert.equal(workerLaunches, 4);
  assert.equal(persisted.restartTimesMs.length, 4);
  const launcherHistory = readDevRestartTimesMs(persisted, nowMs);
  assert.equal(
    devWorkerRestartDecision({
      exitCode: 1,
      signal: null,
      watchdogEnabled: true,
      nowMs,
      restartTimesMs: launcherHistory,
    }).restart,
    true,
  );
  persisted.restartTimesMs = [...launcherHistory, nowMs];
  const replacementHistory = readDevRestartTimesMs(
    JSON.parse(JSON.stringify(persisted)),
    nowMs,
  );
  let replacementLaunches = 0;
  const decisions = [];
  const code = await superviseDevSessions({
    spawnSession: () => {
      const child = fakeDevWorker(++replacementLaunches);
      queueMicrotask(() => child.finish(1));
      return child;
    },
    cleanSession: async () => {},
    readEnabled: () => true,
    now: () => nowMs,
    restartTimesMs: replacementHistory,
    waitToRestart: async () =>
      assert.fail("the replacement must not reset the full-session budget"),
    onEvent: (decision) => decisions.push(decision.reason),
  });

  assert.equal(code, 1);
  assert.equal(replacementLaunches, 1);
  assert.deepEqual(decisions, ["rate-limited"]);
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
    const restartTimesMs = Array(4).fill(Date.now());
    const previousHistory = [...restartTimesMs];
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
      restartTimesMs,
      onRestart: () =>
        assert.fail("clean and disabled sessions must not record a restart"),
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
    assert.deepEqual(restartTimesMs, previousHistory);
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

test("development supervisor reports budget exhaustion without throwing", async () => {
  const messages = [];
  const nowMs = 1_800_000;
  let launches = 0;
  const code = await superviseDevSessions({
    spawnSession: () => {
      const child = fakeDevWorker(++launches);
      queueMicrotask(() => child.finish(1));
      return child;
    },
    cleanSession: async () => {},
    readEnabled: () => true,
    now: () => nowMs,
    restartTimesMs: Array(5).fill(nowMs),
    waitToRestart: async () =>
      assert.fail("exhausted budget must stop recovery"),
    onEvent: (decision, outcome) =>
      reportDevSupervisorDecision(decision, outcome, {
        log: () => assert.fail("exhausted budget must not announce a restart"),
        error: (message) => messages.push(message),
      }),
  });
  assert.equal(code, 1);
  assert.equal(launches, 1);
  assert.deepEqual(messages, [
    "[dev watchdog] Restart limit reached (5 in 30 minutes).",
  ]);
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

test("Windows JSON queries explicitly select UTF-8 output without rewriting the pipeline", () => {
  const pipeline = "Get-CimInstance Win32_Process | ConvertTo-Json -Compress";
  const script = windowsJsonQueryCommand(pipeline);
  assert.match(
    script,
    /^\[Console\]::OutputEncoding = \[System\.Text\.UTF8Encoding\]::new\(\$false\)\n/,
  );
  assert.match(script, /\n\$OutputEncoding = \[Console\]::OutputEncoding\n/);
  assert.ok(script.endsWith(`\n${pipeline}`));
});

test("Windows JSON queries use PowerShell 7 only", () => {
  const calls = [];
  const stdout = runWindowsJsonQuery(
    "Get-CimInstance Win32_Process | ConvertTo-Json -Compress",
    "process",
    {
      run: (executable) => {
        calls.push(executable);
        return { status: 0, stdout: '{"ProcessId":42}' };
      },
    },
  );
  assert.deepEqual(calls, ["pwsh.exe"]);
  assert.deepEqual(JSON.parse(stdout), { ProcessId: 42 });
});

test("Windows JSON query reports a clear PowerShell 7 setup failure", () => {
  assert.throws(
    () =>
      runWindowsJsonQuery("Get-CimInstance Win32_Process", "process", {
        run: () => ({
          error: new Error("[REDACTED_COMMAND_OUTPUT]"),
          status: null,
        }),
      }),
    (error) => {
      assert.match(error.message, /PowerShell 7 \(pwsh\.exe\) is required/);
      assert.equal(error.message.includes("REDACTED_COMMAND_OUTPUT"), false);
      return true;
    },
  );
});

test("Windows JSON query status failures redact command output", () => {
  assert.throws(
    () =>
      runWindowsJsonQuery("Get-CimInstance Win32_Process", "process", {
        run: () => ({
          status: 3221225794,
          stderr: "[REDACTED_COMMAND_OUTPUT]",
        }),
      }),
    (error) => {
      assert.equal(
        error.message,
        "PowerShell 7 process query failed with status 3221225794.",
      );
      assert.equal(error.message.includes("REDACTED_COMMAND_OUTPUT"), false);
      return true;
    },
  );
});

test("Windows process identity accepts equivalent PowerShell creation-date formats", () => {
  const original = {
    ProcessId: 42,
    Name: "cc-switch.exe",
    ExecutablePath: path.resolve(
      "isolated",
      "target",
      "debug",
      "cc-switch.exe",
    ),
    CreationDate: "/Date(1792576562434)/",
  };
  assert.equal(
    sameWindowsProcess(original, {
      ...original,
      CreationDate: "2026-10-21T09:56:02.434Z",
    }),
    true,
  );
});

test("Windows process identity rejects malformed creation dates without throwing", () => {
  const malformed = {
    ProcessId: 42,
    Name: "cc-switch.exe",
    ExecutablePath: path.resolve(
      "isolated",
      "target",
      "debug",
      "cc-switch.exe",
    ),
    CreationDate: "not-a-date",
  };
  assert.equal(sameWindowsProcess(malformed, malformed), false);
  assert.equal(windowsProcessObservationCrashed(malformed, undefined), false);
});

test("Windows malformed query diagnostics omit redacted process output", () => {
  for (const queryName of ["process", "listener"]) {
    assert.throws(
      () =>
        parseWindowsJsonQueryOutput(
          '{"CommandLine":"[REDACTED_FIXTURE]"unescaped quote"}',
          queryName,
        ),
      (error) => {
        assert.equal(
          error.message,
          `PowerShell ${queryName} query returned malformed JSON.`,
        );
        assert.equal(Object.hasOwn(error, "cause"), false);
        assert.equal(Object.hasOwn(error, "stdout"), false);
        assert.equal(error.message.includes("REDACTED_FIXTURE"), false);
        return true;
      },
    );
  }
});

test(
  "Windows JSON queries preserve Unicode quotes and prompt text under PowerShell 7",
  { skip: process.platform !== "win32" },
  () => {
    const fixture = [
      "$value = 'fixture ' + [char]0x201c + 'quoted prompt' + [char]0x201d + ' path caf' + [char]0x00e9 + ' unicode ' + [char]0x4e2d",
      "[pscustomobject]@{CommandLine=$value;ProcessId=42} | ConvertTo-Json -Compress",
    ].join("\n");
    const script = [
      "[Console]::OutputEncoding = [System.Text.Encoding]::GetEncoding(437)",
      windowsJsonQueryCommand(fixture),
    ].join("\n");
    const result = spawnSync(
      "pwsh.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, "harmless PowerShell JSON fixture failed");
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ProcessId, 42);
    assert.equal(
      parsed.CommandLine,
      "fixture \u201cquoted prompt\u201d path caf\u00e9 unicode \u4e2d",
    );
  },
);

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

test("Windows crash observations require complete baseline and current process identities", () => {
  const observed = {
    ProcessId: 42,
    Name: "cc-switch.exe",
    ExecutablePath: path.resolve(
      "isolated",
      "target",
      "debug",
      "cc-switch.exe",
    ),
    CreationDate: "2026-10-14T02:00:00Z",
  };
  for (const field of ["ProcessId", "Name", "ExecutablePath", "CreationDate"]) {
    const incomplete = { ...observed, [field]: null };
    assert.equal(
      windowsProcessObservationCrashed(incomplete, undefined),
      false,
    );
    assert.equal(windowsProcessObservationCrashed(observed, incomplete), false);
  }
});

test("Windows crash observations distinguish a verified disappearance from PID reuse", () => {
  const observed = {
    ProcessId: 42,
    Name: "cc-switch.exe",
    ExecutablePath: path.resolve(
      "isolated",
      "target",
      "debug",
      "cc-switch.exe",
    ),
    CreationDate: "2026-10-14T02:00:00Z",
  };
  assert.equal(windowsProcessObservationCrashed(observed, observed), false);
  assert.equal(windowsProcessObservationCrashed(observed, undefined), true);
  assert.equal(
    windowsProcessObservationCrashed(observed, {
      ...observed,
      CreationDate: "2026-10-14T02:01:00Z",
    }),
    true,
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
  assert.equal(
    windowsProcessStartedAtUtc({
      CreationDate: "20261013120000.000000+480",
    }),
    "2026-10-13T04:00:00.000Z",
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

test("Tauri exit observation recovers when orphaned stdio never closes", async () => {
  const child = fakeDevWorker(72);
  const outcomes = [];
  observeDevChildTermination(
    child,
    (exitCode, signal) => outcomes.push({ exitCode, signal }),
    { drainTimeoutMs: 10 },
  );
  child.finish(1);
  assert.deepEqual(outcomes, []);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(outcomes, [{ exitCode: 1, signal: null }]);
  child.emit("close", 1, null);
  assert.equal(outcomes.length, 1);
});

test("Tauri exit observation drains pending crash identity before classification", async () => {
  const child = fakeDevWorker(73);
  let runMarkerPresent = false;
  const decisions = [];
  observeDevChildTermination(
    child,
    (exitCode, signal) =>
      decisions.push(
        devAutoRestartDecision({
          appStarted: true,
          exitCode,
          signal,
          runMarkerPresent,
          watchdogEnabled: true,
        }),
      ),
    { drainTimeoutMs: 10 },
  );
  child.finish(0);
  assert.deepEqual(decisions, []);
  runMarkerPresent = true;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(decisions, [{ restart: true, reason: "unexpected-exit" }]);
});

test("Tauri exit observation bounds the default drain and deduplicates close", () => {
  const child = fakeDevWorker(74);
  const scheduled = [];
  const cancelled = [];
  const outcomes = [];
  observeDevChildTermination(
    child,
    (code, signal) => outcomes.push({ code, signal }),
    {
      schedule: (callback, delayMs) => {
        scheduled.push({ callback, delayMs });
        return 1;
      },
      cancelScheduled: (timer) => cancelled.push(timer),
    },
  );
  child.finish(1);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delayMs, 250);
  child.emit("close", 1, null);
  scheduled[0].callback();
  assert.deepEqual(outcomes, [{ code: 1, signal: null }]);
  assert.deepEqual(cancelled, [1]);
  assert.equal(child.listenerCount("exit"), 0);
  assert.equal(child.listenerCount("close"), 0);
});

test("Tauri exit observation respects a clean quit during the drain", () => {
  const child = fakeDevWorker(75);
  const scheduled = [];
  const decisions = [];
  let runMarkerPresent = true;
  observeDevChildTermination(
    child,
    (exitCode, signal) =>
      decisions.push(
        devAutoRestartDecision({
          appStarted: true,
          exitCode,
          signal,
          runMarkerPresent,
          watchdogEnabled: true,
        }),
      ),
    {
      schedule: (callback) => {
        scheduled.push(callback);
        return 1;
      },
      cancelScheduled: () => {},
    },
  );
  child.finish(0);
  runMarkerPresent = false;
  scheduled[0]();
  child.emit("close", 0, null);
  assert.deepEqual(decisions, [{ restart: false, reason: "clean-exit" }]);
});

test("Tauri exit observation consumes expected rebuild exits once without recovery", () => {
  const child = fakeDevWorker(76);
  const expectedExits = createExpectedExitRegistry();
  const scheduled = [];
  let classifications = 0;
  let recoveries = 0;
  expectedExits.mark(child);
  observeDevChildTermination(
    child,
    () => {
      classifications += 1;
      if (!expectedExits.consume(child)) recoveries += 1;
    },
    {
      schedule: (callback) => {
        scheduled.push(callback);
        return 1;
      },
      cancelScheduled: () => {},
    },
  );
  child.finish(1);
  scheduled[0]();
  child.emit("close", 1, null);
  assert.equal(classifications, 1);
  assert.equal(recoveries, 0);
  assert.equal(expectedExits.consume(child), false);
});

function replacementDevSession() {
  const repoRoot = path.resolve("workspace", "ccswitchmulti");
  return {
    schemaVersion: 1,
    state: "running",
    supervisorPid: 200,
    supervisorExecutablePath: path.resolve("runtime", "node.exe"),
    supervisorStartedAtUtc: "2026-10-14T02:00:01.000Z",
    startedAtUtc: "2026-10-14T02:00:02.000Z",
    repoRoot,
    scriptPath: path.join(repoRoot, "scripts", "dev-tauri-delayed.mjs"),
    launchedAtMs: Date.parse("2026-10-14T02:00:00.000Z"),
  };
}

function manualTakeoverFixture() {
  const workerIdentity = {
    Name: "node.exe",
    ProcessId: 201,
    ParentProcessId: 200,
    ExecutablePath: path.resolve("runtime", "node.exe"),
    CreationDate: "2026-10-14T02:00:02.1234567Z",
    CommandLine: 'node "scripts/dev-tauri-delayed.mjs" --ccsm-dev-worker',
  };
  const session = {
    ...replacementDevSession(),
    state: "stopping",
    workerPid: 201,
    workerIdentity,
    handoffIntent: "manual_takeover",
    handoffOwner: {
      supervisorPid: 200,
      supervisorStartedAtUtc: "2026-10-14T02:00:01.000Z",
      workerPid: 201,
      workerIdentity,
    },
  };
  const context = { workerPid: 201, supervisorPid: 200, workerIdentity };
  return { session, context };
}

test("manual takeover disconnect retires monitors and leaves app cleanup to the new owner", async () => {
  const { session, context } = manualTakeoverFixture();
  const actions = [];
  assert.equal(isManualTakeoverHandoff(session, context), true);
  assert.equal(
    await handleDevWorkerDisconnect({
      ...context,
      isStopping: () => false,
      readSession: () => session,
      queryWorkerIdentity: () => context.workerIdentity,
      retireMonitors: () => actions.push("retire"),
      shutdown: (code) => actions.push(["shutdown", code]),
    }),
    "handoff",
  );
  assert.deepEqual(actions, ["retire"]);
});

test("live-owner handoff persists readiness only after the exact current worker retires monitors", async () => {
  const { session: original, context } = manualTakeoverFixture();
  let session = original;
  let retired = false;
  const events = [];
  const child = {
    pid: context.workerPid,
    connected: true,
    send: (message) => events.push(message.type),
  };
  const coordinator = createDevSupervisorHandoff({
    getWorker: () => child,
    getContext: () => ({
      ...context,
      supervisorStartedAtUtc: original.supervisorStartedAtUtc,
    }),
    readSession: () => session,
    persistSession: (value) => {
      session = value;
      events.push("readiness-persisted");
    },
    onRequested: () => events.push("supervisor-parked"),
  });
  assert.equal(coordinator.request(), true);
  assert.equal(session.handoffPhase, undefined);
  assert.equal(
    coordinator.acknowledge(
      { ...child },
      { type: "dev-handoff-ready", workerPid: child.pid },
    ),
    false,
  );
  assert.equal(
    retireDevWorkerForManualHandoff({
      readSession: () => session,
      context,
      isRetired: () => retired,
      retireMonitors: () => {
        retired = true;
        events.push("monitors-retired");
      },
      acknowledge: (message) =>
        assert.equal(coordinator.acknowledge(child, message), true),
    }),
    true,
  );
  assert.equal(session.handoffPhase, "worker_ready");
  assert.ok(
    events.indexOf("monitors-retired") < events.indexOf("readiness-persisted"),
  );
  assert.equal(
    await waitForManualDevHandoffReady({
      expected: session,
      readSession: () => session,
      timeoutMs: 0,
    }),
    session,
  );
  assert.equal(
    preserveManualTakeoverHandoff({ ...session, state: "running" }, session)
      .handoffPhase,
    "worker_ready",
  );
});

test("ordinary stop and mismatched worker cannot publish or consume live handoff readiness", async () => {
  const { session, context } = manualTakeoverFixture();
  for (const candidate of [
    { ...session, handoffIntent: undefined },
    { ...session, state: "running" },
    {
      ...session,
      workerIdentity: {
        ...context.workerIdentity,
        CreationDate: "2026-10-14T02:00:02.1234568Z",
      },
    },
  ]) {
    assert.equal(
      retireDevWorkerForManualHandoff({
        readSession: () => candidate,
        context,
        isRetired: () => false,
        retireMonitors: () =>
          assert.fail("unverified handoff cannot retire monitors"),
        acknowledge: () =>
          assert.fail("unverified handoff cannot acknowledge readiness"),
      }),
      false,
    );
    await assert.rejects(
      waitForManualDevHandoffReady({
        expected: session,
        readSession: () => ({ ...candidate, handoffPhase: "worker_ready" }),
        timeoutMs: 0,
      }),
      /did not acknowledge/,
    );
  }
});

test("handoff readiness republishes a lost intent only for its exact still-running owner", async () => {
  const { session } = manualTakeoverFixture();
  let recorded = { ...session, state: "running", handoffIntent: undefined };
  let clock = 0;
  let refreshes = 0;
  const ready = await waitForManualDevHandoffReady({
    expected: session,
    readSession: () => recorded,
    refreshHandoff: async () => {
      refreshes++;
      recorded = { ...session, handoffPhase: "worker_ready" };
    },
    now: () => clock,
    wait: async (ms) => {
      clock += ms;
    },
  });
  assert.equal(ready.handoffPhase, "worker_ready");
  assert.equal(refreshes, 1);
  for (const candidate of [
    { ...session, handoffIntent: undefined },
    { ...session, state: "running", supervisorPid: session.supervisorPid + 1 },
  ]) {
    clock = 0;
    await assert.rejects(
      waitForManualDevHandoffReady({
        expected: session,
        readSession: () => candidate,
        timeoutMs: 1_500,
        refreshHandoff: () =>
          assert.fail("ordinary stopping or new owner cannot be republished"),
        now: () => clock,
        wait: async (ms) => {
          clock += ms;
        },
      }),
      /did not acknowledge/,
    );
  }
});

test("disconnect uses verified startup identity when CIM is overloaded", async () => {
  const { session, context } = manualTakeoverFixture();
  const actions = [];
  const result = await handleDevWorkerDisconnect({
    ...context,
    verifiedWorkerIdentity: context.workerIdentity,
    isStopping: () => false,
    readSession: () => session,
    queryWorkerIdentity: () => {
      throw new Error("simulated overloaded CIM query");
    },
    retireMonitors: () => actions.push("retire"),
    shutdown: (code) => actions.push(["shutdown", code]),
    timeoutMs: 0,
  });
  assert.equal(result, "handoff");
  assert.deepEqual(actions, ["retire"]);
});

test("manual handoff compares creation instants at exact 100ns precision across JSON date spellings", () => {
  const { session, context } = manualTakeoverFixture();
  const observed = {
    ...context.workerIdentity,
    CreationDate: "2026-10-14T10:00:02.1234560+08:00",
  };
  const recorded = {
    ...context.workerIdentity,
    CreationDate: "2026-10-14T02:00:02.123456Z",
  };
  const candidate = {
    ...session,
    workerIdentity: recorded,
    handoffOwner: { ...session.handoffOwner, workerIdentity: recorded },
  };
  assert.equal(
    isManualTakeoverHandoff(candidate, {
      ...context,
      workerIdentity: observed,
    }),
    true,
  );
  assert.equal(
    isManualTakeoverHandoff(candidate, {
      ...context,
      workerIdentity: {
        ...observed,
        CreationDate: "2026-10-14T10:00:02.1234561+08:00",
      },
    }),
    false,
  );
});

test("ordinary stop, parent crash, reused identity, and malformed handoff keep unplanned cleanup", async () => {
  const { session, context } = manualTakeoverFixture();
  const candidates = [
    { ...session, state: "running" },
    { ...session, handoffIntent: undefined },
    { ...session, handoffIntent: "ordinary_stop" },
    { ...session, handoffOwner: undefined },
    { ...session, workerPid: 999 },
    { ...session, supervisorPid: 999 },
    {
      ...session,
      handoffOwner: {
        ...session.handoffOwner,
        supervisorStartedAtUtc: "2026-10-14T02:00:00.000Z",
      },
    },
    {
      ...session,
      workerIdentity: {
        ...context.workerIdentity,
        CreationDate: "2026-10-14T02:00:02.1234568Z",
      },
    },
    {
      ...session,
      workerIdentity: { ...context.workerIdentity, ParentProcessId: 999 },
    },
    {
      ...session,
      workerIdentity: {
        ...context.workerIdentity,
        CommandLine: "foreign worker",
      },
    },
  ];
  for (const candidate of candidates) {
    const actions = [];
    assert.equal(isManualTakeoverHandoff(candidate, context), false);
    assert.equal(
      await handleDevWorkerDisconnect({
        ...context,
        isStopping: () => false,
        readSession: () => candidate,
        queryWorkerIdentity: () => context.workerIdentity,
        retireMonitors: () => actions.push("retire"),
        shutdown: (code) => actions.push(["shutdown", code]),
        timeoutMs: 0,
      }),
      "shutdown",
    );
    assert.deepEqual(actions, [["shutdown", 1]]);
  }
});

test("disconnect waits for the final takeover publication after an old queued write", async () => {
  const { session, context } = manualTakeoverFixture();
  let recorded = { ...session, state: "running", handoffIntent: undefined };
  let nowMs = 0;
  let queries = 0;
  const actions = [];
  const result = await handleDevWorkerDisconnect({
    ...context,
    isStopping: () => false,
    readSession: () => recorded,
    queryWorkerIdentity: () => {
      queries++;
      return context.workerIdentity;
    },
    retireMonitors: () => actions.push("retire"),
    shutdown: (code) => actions.push(["shutdown", code]),
    now: () => nowMs,
    wait: async (milliseconds) => {
      nowMs += milliseconds;
      if (nowMs >= 150) recorded = session;
    },
  });
  assert.equal(result, "handoff");
  assert.equal(nowMs, 150);
  assert.equal(queries, 1);
  assert.deepEqual(actions, ["retire"]);
});

test("ordinary parent crash retries marker observation only until its bounded deadline", async () => {
  const { session, context } = manualTakeoverFixture();
  let nowMs = 0;
  let reads = 0;
  const actions = [];
  const result = await handleDevWorkerDisconnect({
    ...context,
    isStopping: () => false,
    readSession: () => {
      reads++;
      return { ...session, handoffIntent: undefined };
    },
    queryWorkerIdentity: () => context.workerIdentity,
    retireMonitors: () => actions.push("retire"),
    shutdown: (code) => actions.push(["shutdown", code]),
    timeoutMs: 150,
    now: () => nowMs,
    wait: async (milliseconds) => {
      nowMs += milliseconds;
    },
  });
  assert.equal(result, "shutdown");
  assert.equal(nowMs, 150);
  assert.equal(reads, 4);
  assert.deepEqual(actions, [["shutdown", 1]]);
});

test("queued old supervisor publications preserve only their exact manual takeover", () => {
  const { session } = manualTakeoverFixture();
  const running = {
    ...session,
    state: "running",
    roots: [{ role: "tauri", pid: 202 }],
  };
  const merged = preserveManualTakeoverHandoff(running, session);
  assert.equal(merged.state, "stopping");
  assert.equal(merged.handoffIntent, "manual_takeover");
  assert.deepEqual(merged.roots, running.roots);
  assert.deepEqual(merged.handoffOwner, session.handoffOwner);
  for (const current of [running, { ...running, state: "stopping" }]) {
    for (const persisted of [
      undefined,
      { ...session, handoffIntent: undefined },
      { ...session, supervisorStartedAtUtc: "2026-10-14T02:00:00.000Z" },
      { ...session, repoRoot: path.resolve("foreign") },
    ]) {
      const ordinary = preserveManualTakeoverHandoff(current, persisted);
      assert.equal(ordinary.state, current.state);
      assert.equal(ordinary.handoffIntent, undefined);
      assert.equal(ordinary.handoffOwner, undefined);
    }
  }
  const ordinaryStop = preserveManualTakeoverHandoff(
    { ...running, state: "stopping" },
    session,
  );
  assert.equal(ordinaryStop.handoffIntent, undefined);
});

test("detached watchdog relaunches the pnpm dev entry point after supervisor death", async () => {
  const session = {
    ...replacementDevSession(),
    supervisorPid: 100,
    args: ["--delay", "0"],
    environment: { TAURI_DEV_NO_REBUILD: "0" },
  };
  const persisted = [];
  const launches = [];
  const events = [];
  const replacement = {
    pid: 200,
    exitCode: null,
    signalCode: null,
    unref() {},
  };
  const result = await handoffDetachedDevSupervisor({
    supervisorPid: session.supervisorPid,
    markerPath: path.join("isolated", "dev-session.json"),
    session,
    scriptPath: session.scriptPath,
    repoRoot: session.repoRoot,
    now: () => 1_000,
    readEnabled: () => true,
    persistSession: (nextSession) =>
      persisted.push(JSON.parse(JSON.stringify(nextSession))),
    spawnReplacement: async (specification) => {
      launches.push(specification);
      return replacement;
    },
    waitForPublication: async (publication) => {
      assert.equal(publication.expected.supervisorPid, replacement.pid);
      assert.equal(publication.expected.repoRoot, session.repoRoot);
      assert.equal(publication.expected.scriptPath, session.scriptPath);
      assert.equal(publication.isRunning(), true);
      return { ...session, supervisorPid: replacement.pid };
    },
    writeEvent: (event, detail) => events.push({ event, detail }),
  });

  assert.equal(result.restarted, true);
  assert.deepEqual(persisted[0].restartTimesMs, [1_000]);
  assert.equal(launches.length, 1);
  assert.equal(launches[0].executable, process.execPath);
  assert.deepEqual(launches[0].args, [
    session.scriptPath,
    DEV_RECOVERY_FLAG,
    String(session.supervisorPid),
    "--delay",
    "0",
  ]);
  assert.equal(launches[0].options.cwd, session.repoRoot);
  assert.equal(launches[0].options.env.TAURI_DEV_NO_REBUILD, "0");
  assert.equal(
    launches[0].markerPath,
    path.join("isolated", "dev-session.json"),
    "recovery output must follow the canonical session's configured directory",
  );
  assert.deepEqual(events, [
    {
      event: "dev-supervisor-restarting",
      detail: {
        oldPid: session.supervisorPid,
        outputPath: path.resolve("isolated", "dev-recovery.log"),
      },
    },
    {
      event: "dev-supervisor-restarted",
      detail: { oldPid: session.supervisorPid, newPid: replacement.pid },
    },
  ]);
});

test("detached watchdog retries when the replacement pnpm dev supervisor dies before claiming ownership", async () => {
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const scriptPath = path.join(repoRoot, "scripts", "dev-tauri-delayed.mjs");
  const nowMs = Date.parse("2026-10-21T01:00:00Z");
  let session = {
    ...replacementDevSession(),
    supervisorPid: 100,
    supervisorExecutablePath: process.execPath,
    repoRoot,
    scriptPath,
    args: ["--no-rebuild"],
    environment: {},
    restartTimesMs: [],
  };
  const launches = [];
  const events = [];
  let waits = 0;
  let released = 0;
  await runDetachedDevWatchdog(100, {
    markerPath: path.join("isolated", "dev-session.json"),
    readSession: () => session,
    wait: async () =>
      assert.ok(
        ++waits <= 3,
        "watcher should finish after the owned second publication",
      ),
    queryProcesses: (pid) => {
      if (pid === 100) return [];
      return [
        {
          ProcessId: pid,
          ExecutablePath: process.execPath,
          CreationDate: session.supervisorStartedAtUtc,
        },
      ];
    },
    writeEvent: (event, detail) => events.push({ event, detail }),
    handoff: (options) =>
      handoffDetachedDevSupervisor({
        ...options,
        now: () => nowMs,
        readEnabled: () => true,
        persistSession: (next) => {
          session = JSON.parse(JSON.stringify(next));
        },
        spawnReplacement: async (specification) => {
          launches.push(specification);
          const pid = 200 + launches.length;
          const failed = launches.length === 1;
          if (!failed)
            session = {
              ...session,
              supervisorPid: pid,
              startedAtUtc: new Date(nowMs).toISOString(),
              supervisorStartedAtUtc: new Date(nowMs).toISOString(),
            };
          return {
            pid,
            exitCode: failed ? 1 : null,
            signalCode: null,
            unref: () => {
              released++;
            },
          };
        },
        writeEvent: (event, detail) => events.push({ event, detail }),
      }),
  });
  assert.equal(
    launches.length,
    2,
    "the old watchdog must stay alive after the first replacement fails",
  );
  assert.equal(released, 2);
  assert.deepEqual(session.restartTimesMs, [nowMs, nowMs]);
  assert.equal(
    events.filter(({ event }) => event === "dev-supervisor-publication-failed")
      .length,
    1,
  );
  assert.deepEqual(
    events.filter(({ event }) => event === "dev-supervisor-restarted"),
    [
      {
        event: "dev-supervisor-restarted",
        detail: { oldPid: 100, newPid: 202 },
      },
    ],
  );
  assert.ok(
    launches.every(
      ({ args }) =>
        JSON.stringify(args) ===
        JSON.stringify([scriptPath, DEV_RECOVERY_FLAG, "100", "--no-rebuild"]),
    ),
  );
});

test("detached watchdog stops failed replacement launches at the shared restart limit", async () => {
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  let session = {
    ...replacementDevSession(),
    repoRoot,
    scriptPath: path.join(repoRoot, "scripts", "dev-tauri-delayed.mjs"),
    supervisorPid: 100,
    args: [],
    environment: {},
    restartTimesMs: [],
  };
  const events = [];
  let launches = 0;
  let iterations = 0;
  await runDetachedDevWatchdog(100, {
    markerPath: path.join("isolated", "dev-session.json"),
    readSession: () => session,
    queryProcesses: () => [],
    wait: async () => assert.ok(++iterations <= 6),
    handoff: (options) =>
      handoffDetachedDevSupervisor({
        ...options,
        now: () => 1_000,
        readEnabled: () => true,
        persistSession: (next) => {
          session = structuredClone(next);
        },
        spawnReplacement: async () => ({
          pid: 200 + ++launches,
          exitCode: 1,
          signalCode: null,
          unref() {},
        }),
        writeEvent: (event, detail) => events.push({ event, detail }),
      }),
  });
  assert.equal(launches, 5);
  assert.equal(session.restartTimesMs.length, 5);
  assert.deepEqual(events.at(-1), {
    event: "dev-supervisor-restart-skipped",
    detail: { supervisorPid: 100, reason: "rate-limited", restartCount: 5 },
  });
  assert.equal(
    events.filter(({ event }) => event === "dev-supervisor-restarted").length,
    0,
  );
});

test("detached watchdog preserves recovery ownership across a failed process query", async () => {
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const session = {
    ...replacementDevSession(),
    supervisorPid: 100,
    repoRoot,
    scriptPath: path.join(repoRoot, "scripts", "dev-tauri-delayed.mjs"),
  };
  let queries = 0;
  let handoffs = 0;
  const events = [];
  await runDetachedDevWatchdog(100, {
    markerPath: path.join("isolated", "dev-session.json"),
    readSession: () => session,
    wait: async () => {},
    queryProcesses: (pid) => {
      assert.equal(pid, 100);
      if (++queries === 1)
        throw new Error("PowerShell 7 process query timed out");
      return [];
    },
    handoff: async () => {
      handoffs++;
      return { restarted: true };
    },
    writeEvent: (event) => events.push(event),
  });
  assert.equal(handoffs, 1);
  if (process.platform === "win32") {
    assert.equal(queries, 2);
    assert.deepEqual(events, ["dev-watchdog-iteration-failed"]);
  }
});

test("detached watchdog publication does not release ownership at spawn acknowledgement", async () => {
  const expected = replacementDevSession();
  let session = { ...expected, supervisorPid: expected.supervisorPid - 1 };
  let resumePublication;
  let settled = false;
  const publication = waitForDevSupervisorPublication({
    expected,
    readSession: () => session,
    isRunning: () => true,
    wait: () =>
      new Promise((resolve) => {
        resumePublication = resolve;
      }),
  }).then((recorded) => {
    settled = true;
    return recorded;
  });
  await nextEventLoopTurn();
  assert.equal(settled, false);
  assert.equal(typeof resumePublication, "function");
  session = expected;
  resumePublication();
  assert.equal(await publication, expected);
});

test("detached watchdog publication rejects stale or foreign replacement markers", async () => {
  const expected = replacementDevSession();
  const markers = [
    { ...expected, schemaVersion: 2 },
    { ...expected, supervisorPid: expected.supervisorPid - 1 },
    {
      ...expected,
      supervisorExecutablePath: path.resolve("foreign-runtime", "node.exe"),
    },
    { ...expected, supervisorStartedAtUtc: "2026-10-14T01:00:00.000Z" },
    { ...expected, repoRoot: path.resolve("workspace", "another-repo") },
    {
      ...expected,
      scriptPath: path.resolve("foreign", "dev-tauri-delayed.mjs"),
    },
    { ...expected, state: "stopping" },
    { ...expected, startedAtUtc: "2026-10-14T01:59:59.000Z" },
    expected,
  ];
  let reads = 0;
  const recorded = await waitForDevSupervisorPublication({
    expected,
    readSession: () => markers[reads++],
    isRunning: () => true,
    wait: nextEventLoopTurn,
  });
  assert.equal(recorded, expected);
  assert.equal(reads, markers.length);
});

test("detached watchdog publication waits through missing or malformed markers", async () => {
  const expected = replacementDevSession();
  let reads = 0;
  const recorded = await waitForDevSupervisorPublication({
    expected,
    readSession: () => {
      reads += 1;
      if (reads === 1) {
        const error = new Error("isolated marker not published");
        error.code = "ENOENT";
        throw error;
      }
      if (reads === 2) throw new SyntaxError("isolated marker incomplete");
      return expected;
    },
    isRunning: () => true,
    wait: nextEventLoopTurn,
  });
  assert.equal(recorded, expected);
  assert.equal(reads, 3);
});

test("detached watchdog publication stops when the replacement dies before claiming", async () => {
  const expected = replacementDevSession();
  await assert.rejects(
    waitForDevSupervisorPublication({
      expected,
      readSession: () =>
        assert.fail("a dead replacement cannot publish a valid handoff"),
      isRunning: () => false,
      wait: () => assert.fail("a dead replacement must not wait until timeout"),
    }),
    /exited before publishing/,
  );
});

test("detached watchdog publication reports timeout without accepting an unclaimed session", async () => {
  const expected = replacementDevSession();
  let nowMs = 0;
  let polls = 0;
  const diagnostics = [];
  await assert.rejects(
    waitForDevSupervisorPublication({
      expected,
      readSession: () => ({ ...expected, supervisorPid: 100 }),
      isRunning: () => nowMs < 500,
      timeoutMs: 300,
      now: () => nowMs,
      onTimeout: (error) => diagnostics.push(error.message),
      wait: async (delayMs) => {
        nowMs += delayMs;
        polls += 1;
      },
    }),
    /exited before publishing/,
  );
  assert.equal(polls, 5);
  assert.equal(diagnostics.length, 1);
  assert.match(
    diagnostics[0],
    /did not publish its owned session within 300ms/,
  );
});

test("detached watchdog publication retains ownership while OS identity is unavailable", async () => {
  const recorded = replacementDevSession();
  const expected = { ...recorded, supervisorStartedAtUtc: undefined };
  let identityChecks = 0;
  const publication = await waitForDevSupervisorPublication({
    expected,
    readSession: () => recorded,
    isRunning: () => true,
    verifyOwnership: () => {
      identityChecks += 1;
      if (identityChecks === 1) {
        throw new Error("isolated identity query temporarily unavailable");
      }
      return identityChecks >= 3;
    },
    wait: nextEventLoopTurn,
  });
  assert.equal(publication, recorded);
  assert.equal(identityChecks, 3);
});

test("detached watchdog publication requires start identity or an ownership verifier", async () => {
  const recorded = replacementDevSession();
  const expected = { ...recorded, supervisorStartedAtUtc: undefined };
  let nowMs = 0;
  const diagnostics = [];
  await assert.rejects(
    waitForDevSupervisorPublication({
      expected,
      readSession: () => recorded,
      isRunning: () => nowMs < 200,
      timeoutMs: 100,
      now: () => nowMs,
      onTimeout: (error) => diagnostics.push(error.message),
      wait: async (delayMs) => {
        nowMs += delayMs;
      },
    }),
    /exited before publishing/,
  );
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0], /did not publish its owned session/);
});

test("detached watchdog publication timeout retains a live child until late ownership publication", async () => {
  const expected = replacementDevSession();
  let nowMs = 0;
  const diagnostics = [];
  const publication = await waitForDevSupervisorPublication({
    expected,
    readSession: () =>
      nowMs >= 400 ? expected : { ...expected, supervisorPid: 100 },
    isRunning: () => true,
    timeoutMs: 100,
    now: () => nowMs,
    onTimeout: (error) => diagnostics.push(error.message),
    wait: async (delayMs) => {
      nowMs += delayMs;
    },
  });

  assert.equal(publication, expected);
  assert.equal(nowMs, 400);
  assert.equal(diagnostics.length, 1);
  assert.match(
    diagnostics[0],
    /did not publish its owned session within 100ms/,
  );
});

test("detached watchdog publication timeout retains ownership until the unpublished child exits", async () => {
  const expected = replacementDevSession();
  let nowMs = 0;
  const diagnostics = [];
  await assert.rejects(
    waitForDevSupervisorPublication({
      expected,
      readSession: () => ({ ...expected, supervisorPid: 100 }),
      isRunning: () => nowMs < 400,
      timeoutMs: 100,
      now: () => nowMs,
      onTimeout: (error) => diagnostics.push(error.message),
      wait: async (delayMs) => {
        nowMs += delayMs;
      },
    }),
    /exited before publishing/,
  );

  assert.equal(nowMs, 400);
  assert.equal(diagnostics.length, 1);
  assert.match(
    diagnostics[0],
    /did not publish its owned session within 100ms/,
  );
});

function customConfigAppFixture() {
  const repoRoot = fileURLToPath(new URL("../", import.meta.url));
  const app = {
    ProcessId: 30,
    ParentProcessId: 20,
    Name: "cc-switch.exe",
    ExecutablePath: path.join(
      repoRoot,
      "src-tauri",
      "target",
      "debug",
      "cc-switch.exe",
    ),
    CreationDate: "2026-10-25T02:00:00.000000Z",
    NativeStartedAtFiletime: "134373672000000009",
  };
  const appIdentity = {
    event: "ready",
    pid: app.ProcessId,
    executablePath: app.ExecutablePath,
    processStartedAtTicks: app.NativeStartedAtFiletime,
    markerPath: path.resolve(
      "fixture-custom-config",
      "logs",
      "app-run-marker.json",
    ),
  };
  const worker = {
    ProcessId: 5,
    ParentProcessId: 1,
    Name: "node.exe",
    ExecutablePath: process.execPath,
    CommandLine: "node scripts/dev-tauri-delayed.mjs --ccsm-dev-worker",
    CreationDate: "2026-10-25T01:59:57.0000000Z",
  };
  const cli = {
    ProcessId: 10,
    ParentProcessId: worker.ProcessId,
    Name: "node.exe",
    ExecutablePath: process.execPath,
    CommandLine: "node node_modules/@tauri-apps/cli/tauri.js dev --no-watch",
    CreationDate: "2026-10-25T01:59:58.0000000Z",
  };
  const cargo = {
    ProcessId: 20,
    ParentProcessId: cli.ProcessId,
    Name: "cargo.exe",
    ExecutablePath: path.resolve("fixture-toolchain", "cargo.exe"),
    CreationDate: "2026-10-25T01:59:59.0000000Z",
  };
  const processes = [worker, cli, cargo, app];
  const message = {
    type: "dev-root",
    role: "tauri",
    pid: cli.ProcessId,
    appIdentity,
  };
  return { repoRoot, app, appIdentity, worker, cli, cargo, processes, message };
}

test("planned Windows app cleanup uses the verified runtime marker instead of the default home", async () => {
  const { app, appIdentity } = customConfigAppFixture();
  const plannedAppExits = [];
  let receivedMarkerPath;
  await stopVerifiedWindowsApp(app, {
    plannedExitReason: "development_backend_reload",
    plannedAppExits,
    appIdentities: [appIdentity],
    queryProcesses: () => [app],
    queryListeners: () => [],
    stopPlannedApp: (_identity, options) => {
      receivedMarkerPath = options.markerPath;
      return {
        terminated: true,
        markerPath: options.markerPath,
        markerText: "fixture-only",
      };
    },
    terminate: () =>
      assert.fail("a planned app stop must not fall back to taskkill"),
    waitForProcessExit: async () => {},
    writeEvent: () => {},
    log: () => {},
  });
  assert.equal(receivedMarkerPath, appIdentity.markerPath);
  assert.equal(plannedAppExits.length, 1);
});

test("runtime dev-root publication binds the custom marker to the exact owned app", () => {
  const fixture = customConfigAppFixture();
  const record = createDevRootRecord(fixture.message, fixture.processes, {
    repoRoot: fixture.repoRoot,
    platform: "win32",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(record)).appIdentity, {
    pid: fixture.appIdentity.pid,
    executablePath: fixture.appIdentity.executablePath,
    processStartedAtTicks: fixture.appIdentity.processStartedAtTicks,
    processStartedAtUtc: fixture.app.CreationDate,
    markerPath: fixture.appIdentity.markerPath,
  });
  const initial = createDevRootRecord(
    { type: "dev-root", role: "tauri", pid: fixture.cli.ProcessId },
    fixture.processes,
    { repoRoot: fixture.repoRoot, platform: "win32" },
  );
  assert.equal(initial.appIdentity, undefined);
  for (const candidate of [
    { ...fixture.message, role: "vite" },
    { ...fixture.message, pid: fixture.worker.ProcessId },
    { ...fixture.message, appIdentity: { ...fixture.appIdentity, pid: 999 } },
    {
      ...fixture.message,
      appIdentity: {
        ...fixture.appIdentity,
        processStartedAtTicks: (
          BigInt(fixture.appIdentity.processStartedAtTicks) + 10000n
        ).toString(),
      },
    },
    {
      ...fixture.message,
      appIdentity: {
        ...fixture.appIdentity,
        executablePath: path.resolve("foreign", "cc-switch.exe"),
      },
    },
    {
      ...fixture.message,
      appIdentity: {
        ...fixture.appIdentity,
        markerPath: path.join("relative-config", "logs", "app-run-marker.json"),
      },
    },
    {
      ...fixture.message,
      appIdentity: {
        ...fixture.appIdentity,
        markerPath: path.resolve("fixture-custom-config", "settings.json"),
      },
    },
  ]) {
    assert.equal(
      createDevRootRecord(candidate, fixture.processes, {
        repoRoot: fixture.repoRoot,
        platform: "win32",
      }),
      undefined,
    );
  }
  const foreignApp = { ...fixture.app, ParentProcessId: 999 };
  assert.equal(
    createDevRootRecord(
      fixture.message,
      [...fixture.processes.filter((item) => item !== fixture.app), foreignApp],
      { repoRoot: fixture.repoRoot, platform: "win32" },
    ),
    undefined,
  );
});

for (const mode of ["recorded-root", "recorded-worker"]) {
  test(
    mode + " planned cleanup retains the serialized custom-config app marker",
    async () => {
      const fixture = customConfigAppFixture();
      const root = JSON.parse(
        JSON.stringify(
          createDevRootRecord(fixture.message, fixture.processes, {
            repoRoot: fixture.repoRoot,
            platform: "win32",
          }),
        ),
      );
      let processes = [...fixture.processes];
      const seenMarkers = [];
      const commits = [];
      const stopOptions = {
        platform: "win32",
        queryProcesses: () => processes,
        queryListeners: () => [],
        stopPlannedApp: (_identity, options) => {
          assert.equal(options.markerPath, fixture.appIdentity.markerPath);
          seenMarkers.push(options.markerPath);
          processes = processes.filter(
            (item) => item.ProcessId !== fixture.app.ProcessId,
          );
          return {
            terminated: true,
            markerPath: options.markerPath,
            markerText: "fixture-only",
            reason: options.reason,
          };
        },
        terminate: (pid) => {
          processes = processes.filter((item) => item.ProcessId !== pid);
          return { status: 0 };
        },
        waitForProcessExit: async () => {},
        waitForListenersReleased: async () => {},
        log: () => {},
      };
      await runPlannedDevCleanup(
        (options) =>
          mode === "recorded-root"
            ? cleanRecordedDevRoots([root], { ...stopOptions, ...options })
            : cleanRecordedDevWorker(
                {
                  workerPid: fixture.worker.ProcessId,
                  workerIdentity: fixture.worker,
                  roots: [root],
                },
                { ...stopOptions, ...options },
              ),
        "development_manual_restart",
        { commit: (proof) => commits.push(proof) },
      );
      assert.deepEqual(seenMarkers, [fixture.appIdentity.markerPath]);
      assert.equal(commits.length, 1);
      assert.equal(commits[0].markerPath, fixture.appIdentity.markerPath);
    },
  );
}

test("planned marker cleanup rejects absent, replayed and unrelated runtime identities before mutation", async () => {
  const { app, appIdentity } = customConfigAppFixture();
  for (const identities of [
    [],
    [{ ...appIdentity, pid: 999 }],
    [
      {
        ...appIdentity,
        executablePath: path.resolve("unrelated", "cc-switch.exe"),
      },
    ],
    [
      {
        ...appIdentity,
        processStartedAtTicks: (
          BigInt(appIdentity.processStartedAtTicks) + 10000n
        ).toString(),
      },
    ],
    [
      {
        ...appIdentity,
        markerPath: path.join("relative", "logs", "app-run-marker.json"),
      },
    ],
    [
      {
        ...appIdentity,
        markerPath: path.resolve(
          "fixture-custom-config",
          "logs",
          "unrelated.json",
        ),
      },
    ],
  ]) {
    await assert.rejects(
      stopVerifiedWindowsApp(app, {
        plannedExitReason: "development_backend_reload",
        appIdentities: identities,
        readLegacyAppIdentity: () =>
          identities.length
            ? assert.fail(
                "a modern runtime identity is authoritative; stale data cannot fall back to default",
              )
            : undefined,
        queryProcesses: () => [app],
        queryListeners: () => [],
        stopPlannedApp: () =>
          assert.fail("unverified marker cannot reach the native planned stop"),
        terminate: () =>
          assert.fail("failed planned identity must not fall back to taskkill"),
        log: () => {},
        writeEvent: () => {},
      }),
      /no verified runtime marker identity/,
    );
  }
  assert.equal(
    devAppIdentityMatchesProcess(appIdentity, {
      ...app,
      CreationDate: "invalid",
    }),
    false,
  );
  assert.equal(devAppIdentityMatchesProcess(appIdentity, undefined), false);
  let forced = 0;
  await stopVerifiedWindowsApp(app, {
    queryProcesses: () => [app],
    queryListeners: () => [],
    stopPlannedApp: () =>
      assert.fail("crash cleanup never creates a planned marker"),
    terminate: () => {
      forced++;
      return { status: 0 };
    },
    waitForProcessExit: async () => {},
    log: () => {},
  });
  assert.equal(
    forced,
    1,
    "startup failure without a ready identity still has bounded ordinary cleanup",
  );
});

test("legacy default marker fallback requires exact process identity and canonical config scope", async () => {
  const fixture = customConfigAppFixture();
  const environment = {
    CC_SWITCH_TEST_HOME: path.resolve("fixture-legacy-home"),
  };
  const markerPath = resolveDevRunMarkerPath(environment);
  const configRoot = path.dirname(path.dirname(markerPath));
  const scope = createHash("sha256")
    .update(configRoot.replaceAll("/", "\\").toLowerCase())
    .digest("hex")
    .slice(0, 16);
  const validMarker = {
    pid: fixture.app.ProcessId,
    executablePath: fixture.app.ExecutablePath,
    processStartedAtTicks: String(fixture.appIdentity.processStartedAtTicks),
    configScope: scope,
    startedAt: "2026-10-25 10:00:00.000",
  };
  const readIdentity = (marker) =>
    legacyDevAppIdentityForPlannedStop(fixture.app, {
      environment,
      resolveConfigPath: (value) => value,
      read: (requested) => {
        assert.equal(requested, markerPath);
        return JSON.stringify(marker).replace(
          /"processStartedAtTicks":"(\d+)"/,
          '"processStartedAtTicks":$1',
        );
      },
    });
  const identity = readIdentity(validMarker);
  assert.equal(identity.markerPath, markerPath);
  assert.equal(identity.processStartedAtUtc, fixture.app.CreationDate);
  for (const marker of [
    { ...validMarker, pid: 999 },
    {
      ...validMarker,
      executablePath: path.resolve("unrelated", "cc-switch.exe"),
    },
    {
      ...validMarker,
      processStartedAtTicks: String(
        BigInt(validMarker.processStartedAtTicks) + 1n,
      ),
    },
    { ...validMarker, configScope: "unrelated-config-scope" },
    { ...validMarker, startedAt: "" },
  ])
    assert.equal(readIdentity(marker), undefined);
  assert.equal(
    legacyDevAppIdentityForPlannedStop(fixture.app, {
      environment,
      read: () => {
        throw new Error("missing marker");
      },
    }),
    undefined,
  );

  // A persisted root written by the previous launcher has no appIdentity. It
  // remains usable only with the positively verified legacy marker above.
  const root = createDevRootRecord(
    { type: "dev-root", role: "tauri", pid: fixture.cli.ProcessId },
    fixture.processes,
    { platform: "win32" },
  );
  let processes = [...fixture.processes];
  const markers = [];
  await cleanRecordedDevRoots([JSON.parse(JSON.stringify(root))], {
    platform: "win32",
    plannedExitReason: "development_manual_restart",
    plannedAppExits: [],
    readLegacyAppIdentity: () => readIdentity(validMarker),
    queryProcesses: () => processes,
    queryListeners: () => [],
    stopPlannedApp: (_app, options) => {
      assert.equal(options.requireMarker, true);
      markers.push(options.markerPath);
      processes = processes.filter(
        (item) => item.ProcessId !== fixture.app.ProcessId,
      );
      return {
        terminated: true,
        markerText: "fixture-only",
        markerPath: options.markerPath,
      };
    },
    terminate: (pid) => {
      processes = processes.filter((item) => item.ProcessId !== pid);
      return { status: 0 };
    },
    waitForProcessExit: async () => {},
    log: () => {},
  });
  assert.deepEqual(markers, [markerPath]);
});

test("runtime root captures exact creation precision to reject a one-tick replay", () => {
  const fixture = customConfigAppFixture();
  const root = createDevRootRecord(fixture.message, fixture.processes, {
    platform: "win32",
  });
  assert.equal(
    devAppIdentityMatchesProcess(root.appIdentity, {
      ...fixture.app,
      CreationDate: "2026-10-25T02:00:00.0000001Z",
    }),
    false,
  );
});

test("native FILETIME ready identity survives the CIM microsecond rounding boundary", () => {
  const fixture = customConfigAppFixture();
  const nativeFiletime = "134373672000000009";
  const app = {
    ...fixture.app,
    CreationDate: "2026-10-25T02:00:00.000000Z",
    NativeStartedAtFiletime: nativeFiletime,
  };
  const identity = {
    ...fixture.appIdentity,
    processStartedAtTicks: nativeFiletime,
  };
  assert.notEqual(Number(nativeFiletime), Number("134373672000000000"));
  assert.equal(devAppIdentityMatchesProcess(identity, app), true);
  assert.equal(
    devAppIdentityMatchesProcess(
      {
        ...identity,
        processStartedAtTicks: "134373672000000008",
      },
      app,
    ),
    false,
    "a one-native-tick replay must never match",
  );
  assert.equal(
    devAppIdentityMatchesProcess(identity, {
      ...app,
      NativeStartedAtFiletime: "134373672000000008",
    }),
    false,
    "the native process timestamp must match exactly even within one CIM microsecond",
  );
});

test("legacy default marker accepts the exact native FILETIME rather than truncated CIM", () => {
  const fixture = customConfigAppFixture();
  const environment = {
    CC_SWITCH_TEST_HOME: path.resolve("fixture-native-legacy-home"),
  };
  const markerPath = resolveDevRunMarkerPath(environment);
  const configRoot = path.dirname(path.dirname(markerPath));
  const configScope = createHash("sha256")
    .update(configRoot.replaceAll("/", "\\").toLowerCase())
    .digest("hex")
    .slice(0, 16);
  const nativeFiletime = "134373672000000009";
  const app = {
    ...fixture.app,
    CreationDate: "2026-10-25T02:00:00.000000Z",
    NativeStartedAtFiletime: nativeFiletime,
  };
  const marker = {
    pid: app.ProcessId,
    executablePath: app.ExecutablePath,
    processStartedAtTicks: nativeFiletime,
    configScope,
    startedAt: "2026-10-25 10:00:00.000",
  };
  const readIdentity = (value) =>
    legacyDevAppIdentityForPlannedStop(app, {
      environment,
      resolveConfigPath: (value) => value,
      read: () =>
        JSON.stringify(value).replace(
          /"processStartedAtTicks":"(\d+)"/,
          '"processStartedAtTicks":$1',
        ),
    });
  const identity = readIdentity(marker);
  assert.equal(identity?.processStartedAtTicks, nativeFiletime);
  assert.equal(identity?.markerPath, markerPath);
  assert.equal(
    readIdentity({ ...marker, processStartedAtTicks: "134373672000000008" }),
    undefined,
  );
});

test("run marker matching preserves exact FILETIME and rejects rounded one-tick replay", () => {
  const fixture = customConfigAppFixture();
  const identity = {
    ...fixture.appIdentity,
    processStartedAtTicks: "134373672000000009",
  };
  const text = (ticks) =>
    JSON.stringify({ ...identity, processStartedAtTicks: ticks }).replace(
      /"processStartedAtTicks":"(\d+)"/,
      '"processStartedAtTicks":$1',
    );
  assert.equal(
    readDevRunMarkerPresent({}, () => text("134373672000000009"), identity),
    true,
  );
  assert.equal(
    readDevRunMarkerPresent({}, () => text("134373672000000008"), identity),
    false,
  );
});

test("native FILETIME identity rejects one tick inside the same Number and CIM bins", () => {
  const fixture = customConfigAppFixture();
  const app = {
    ...fixture.app,
    CreationDate: "2026-10-25T02:00:00.000001Z",
    NativeStartedAtFiletime: "134373672000000017",
  };
  const identity = {
    ...fixture.appIdentity,
    processStartedAtTicks: "134373672000000017",
  };
  assert.equal(Number("134373672000000017"), Number("134373672000000018"));
  assert.equal(devAppIdentityMatchesProcess(identity, app), true);
  assert.equal(
    devAppIdentityMatchesProcess(
      { ...identity, processStartedAtTicks: "134373672000000018" },
      app,
    ),
    false,
  );
  assert.equal(
    devAppIdentityMatchesProcess(identity, {
      ...app,
      NativeStartedAtFiletime: "134373672000000018",
    }),
    false,
  );
  assert.equal(
    sameWindowsProcess(app, {
      ...app,
      NativeStartedAtFiletime: "134373672000000018",
    }),
    false,
    "exact process comparison rejects a PID replay inside one CIM microsecond",
  );
  assert.equal(
    readDevRunMarkerPresent(
      {},
      () =>
        JSON.stringify({
          ...identity,
          processStartedAtTicks: "134373672000000018",
        }).replace(
          /"processStartedAtTicks":"(\d+)"/,
          '"processStartedAtTicks":$1',
        ),
      identity,
    ),
    false,
  );
});

test("bounded Windows process query binds app-only exact native FILETIME to its CIM row", () => {
  const fixture = customConfigAppFixture();
  let captured;
  assert.deepEqual(
    queryWindowsProcesses(fixture.app.ProcessId, {
      runQuery: (script, name) => {
        captured = script;
        assert.equal(name, "process");
        return JSON.stringify(fixture.app);
      },
    }),
    [fixture.app],
  );
  assert.match(
    captured,
    /Get-CimInstance Win32_Process -Filter 'ProcessId = 30'/,
  );
  for (const required of [
    "if ($row.Name -ieq 'cc-switch.exe')",
    "$null = $native.Handle",
    "$nativeStartedAt = $native.StartTime.ToUniversalTime()",
    "$native.Path -ine $row.ExecutablePath",
    "$nativeStartedAt.Ticks - ($nativeStartedAt.Ticks % 10)",
    "NativeStartedAtFiletime -NotePropertyValue $nativeStartedAt.ToFileTimeUtc().ToString",
    "$native.Dispose()",
  ])
    assert.ok(captured.includes(required), required);
  assert.ok(
    captured.indexOf("$null = $native.Handle") <
      captured.indexOf("$native.StartTime"),
  );
  assert.equal(
    devAppIdentityMatchesProcess(fixture.appIdentity, {
      ...fixture.app,
      NativeStartedAtFiletime: undefined,
    }),
    false,
  );
  assert.equal(
    devAppIdentityMatchesProcess(fixture.appIdentity, {
      ...fixture.app,
      NativeStartedAtFiletime: Number(fixture.app.NativeStartedAtFiletime),
    }),
    false,
  );
  assert.equal(
    devAppIdentityMatchesProcess(fixture.appIdentity, {
      ...fixture.app,
      NativeStartedAtFiletime: "18446744073709551616",
    }),
    false,
  );
  assert.equal(
    devAppIdentityMatchesProcess(fixture.appIdentity, {
      ...fixture.app,
      CreationDate: "2026-10-25T02:00:01.000000Z",
    }),
    false,
  );
});

test(
  "bounded native FILETIME query validates only its disposable process fixture",
  { skip: process.platform !== "win32", timeout: 30000 },
  async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    await once(child, "spawn");
    try {
      const rows = queryWindowsProcesses(child.pid, {
        runQuery: (script, name) => {
          assert.ok(script.includes("-Filter 'ProcessId = " + child.pid + "'"));
          // Test-only name substitution lets the native app-identity branch run
          // against our own disposable node, never any actual cc-switch process.
          return runWindowsJsonQuery(
            script.replace(
              "$row.Name -ieq 'cc-switch.exe'",
              "$row.Name -ieq 'node.exe'",
            ),
            name,
          );
        },
      });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].ProcessId, child.pid);
      assert.equal(
        rows[0].ExecutablePath.toLowerCase(),
        process.execPath.toLowerCase(),
      );
      assert.equal(typeof rows[0].NativeStartedAtFiletime, "string");
      const native = BigInt(rows[0].NativeStartedAtFiletime);
      assert.equal(
        native - (native % 10n),
        utcTicks(rows[0].CreationDate) + 116444736000000000n,
      );
    } finally {
      child.kill();
      await once(child, "exit");
    }
  },
);
