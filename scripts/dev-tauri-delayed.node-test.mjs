import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  createBackendContentTracker,
  createBackendRebuildGate,
  createChangeEventBatcher,
  createExpectedExitRegistry,
  createQuietPeriodScheduler,
  isPathInside,
  isTauriAppStartedOutput,
  parseDelayMs,
  parsePort,
  parseWindowsListeners,
  sameWindowsProcess,
  stopVerifiedWindowsApp,
  waitForChildExit,
  waitForWindowsListenersReleased,
  waitForWindowsProcessExit,
  windowsDevDescendants,
  windowsFrontendDescendants,
} from "./dev-tauri-delayed.mjs";

test("parseDelayMs uses the default and supports environment and CLI overrides", () => {
  assert.equal(parseDelayMs([], {}), 50_000);
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

test("parsePort supports isolated development sessions", () => {
  assert.equal(parsePort({}), 3000);
  assert.equal(parsePort({ TAURI_DEV_PORT: "3410" }), 3410);
  assert.throws(
    () => parsePort({ TAURI_DEV_PORT: "0" }),
    /Invalid development port/,
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
  const resolveRootEvent = (filename) => {
    if (!filename) return null;
    return new Set(["Cargo.lock", "Cargo.toml"]).has(filename.toString())
      ? filename.toString()
      : null;
  };

  assert.equal(resolveDirectoryEvent(undefined), null);
  assert.equal(resolveRootEvent(undefined), null);
  assert.equal(resolveRootEvent("target"), null);
  assert.equal(resolveRootEvent("Cargo.lock"), "Cargo.lock");
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

test("Windows shutdown never traverses through Codex into matching helper names", () => {
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

test("Windows shutdown supports a custom Cargo target directory", () => {
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
    { CARGO_TARGET_DIR: "..\\custom-target" },
  );
  assert.deepEqual(
    descendants.map(({ ProcessId, kind }) => ({ ProcessId, kind })),
    [
      { ProcessId: 30, kind: "app" },
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

test("verified Windows app waits for authenticated self-shutdown without taskkill", async () => {
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
    queryProcesses: () => [],
    queryListeners: () => [{ address: "127.0.0.1", port: 15721 }],
    prepareGracefulShutdown: () => {
      events.push("shutdown-armed");
      return () => events.push("shutdown-disarmed");
    },
    terminate: (processId, force) => {
      events.push(force ? "forced-terminate" : "unexpected-terminate");
      terminations.push({ processId, force });
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

  assert.deepEqual(terminations, []);
  assert.deepEqual(events, [
    "shutdown-armed",
    "process-exited",
    "shutdown-disarmed",
    "listeners-released",
  ]);
});

test("verified Windows app shutdown force-kills only after graceful timeout", async () => {
  const app = {
    ProcessId: 30,
    Name: "cc-switch.exe",
    ExecutablePath:
      "H:\\repos\\ccswitchmulti-fork\\src-tauri\\target\\debug\\cc-switch.exe",
    CreationDate: "20260830210502.000000+480",
  };
  const terminations = [];
  const waitTimeouts = [];
  let exitWait = 0;

  await stopVerifiedWindowsApp(app, {
    queryProcesses: () => [app],
    queryListeners: () => [],
    terminate: (processId, force) => {
      terminations.push({ processId, force });
      return { status: 0 };
    },
    waitForProcessExit: async (_processInfo, _query, timeoutMs) => {
      waitTimeouts.push(timeoutMs);
      exitWait += 1;
      if (exitWait === 1) {
        throw new Error("graceful timeout");
      }
    },
    gracefulTimeoutMs: 10_000,
    forcedTimeoutMs: 2_000,
    log: () => {},
  });

  assert.deepEqual(terminations, [
    { processId: 30, force: true },
  ]);
  assert.deepEqual(waitTimeouts, [10_000, 2_000]);
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
