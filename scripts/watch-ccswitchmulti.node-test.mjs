import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as guardianCore from "./ccswitchmulti-guardian-core.mjs";
import {
  acquireGuardianLock,
  createGuardianRuntime,
  guardianProcessIdentity,
  guardianRecoveryPolicy,
  inspectDevWatchdogProcesses,
  parseGuardianArgs,
  runGuardian,
  stopVerifiedWindowsProcess,
} from "./watch-ccswitchmulti.mjs";

function fixture(t, overrides = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccsm-js-guardian-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const plan = {
    ...parseGuardianArgs([], {
      environment: { LOCALAPPDATA: root, USERPROFILE: root },
    }),
    ...overrides,
  };
  const repo = path.join(root, "repo");
  const node = path.join(root, "node.exe");
  const script = path.join(repo, "scripts", "dev-tauri-delayed.mjs");
  mkdirSync(path.dirname(script), { recursive: true });
  mkdirSync(path.join(plan.ConfigPath, "logs"), { recursive: true });
  writeFileSync(script, "");
  writeFileSync(path.join(repo, "package.json"), "{}");
  writeFileSync(node, "");
  writeFileSync(
    path.join(plan.ConfigPath, "logs", "app-run-marker.json"),
    '{"pid":7777}',
  );
  const events = [];
  const launches = [];
  const state = {
    supervisorAlive: false,
    maintenance: false,
    enabled: true,
    listener: null,
  };
  const supervisor = {
    ProcessId: 4242,
    Path: node,
    StartTimeUtc: "2026-10-13T00:00:00.000Z",
    CimStartTimeUtc: "2026-10-13T00:00:00.000Z",
    CommandLine: `node "${script}" --delay 0`,
  };
  const runtime = {
    watchdogEnabled: () => state.enabled,
    isMaintenance: () => state.maintenance,
    getListenerOwner: () => state.listener,
    getProcessIdentity: (pid) =>
      pid === process.pid
        ? {
            ProcessId: process.pid,
            Path: process.execPath,
            StartTimeUtc: "2026-10-21T00:00:00.1234567Z",
          }
        : state.supervisorAlive && pid === 4242
          ? supervisor
          : null,
    inspectWatchdogOwnership: () => ({ Active: false, Unknown: false }),
    installedExecutableExists: () => true,
    isExpectedProductIdentity: (identity) =>
      identity?.Path === plan.InstalledExecutable,
    getExpectedProductProcesses: () => [],
    stopVerifiedProductProcess: () => {
      throw new Error("Unexpected process stop in test.");
    },
    waitPortFree: () => true,
    startProduct: () => {
      launches.push({ kind: "product", executable: plan.InstalledExecutable });
      return 9001;
    },
    startDevSession: (devPlan) => {
      launches.push({ kind: "dev", plan: devPlan });
      return 9002;
    },
    waitReady: () => true,
    writeEvent: (level, event, detail) => events.push({ level, event, detail }),
  };
  const session = {
    schemaVersion: 1,
    state: "running",
    supervisorPid: 4242,
    supervisorExecutablePath: node,
    supervisorStartedAtUtc: supervisor.StartTimeUtc,
    startedAtUtc: "2026-10-13T00:00:01.000Z",
    repoRoot: repo,
    scriptPath: script,
    args: ["--delay", "0"],
    roots: [],
  };
  const writeSession = (value = session) =>
    writeFileSync(
      path.join(plan.ConfigPath, "logs", "dev-session.json"),
      typeof value === "string" ? value : JSON.stringify(value),
    );
  const writeAppMarker = (value) =>
    writeFileSync(
      path.join(plan.ConfigPath, "logs", "app-run-marker.json"),
      JSON.stringify(value),
    );
  const policy = (options = {}) =>
    guardianRecoveryPolicy({
      plan,
      runtime,
      restartTimesUtc: [],
      core: guardianCore,
      ...options,
    });
  return {
    root,
    plan,
    repo,
    node,
    script,
    events,
    launches,
    state,
    runtime,
    session,
    writeSession,
    writeAppMarker,
    policy,
  };
}

test("guardian CLI requires explicit development opt-in and preserves PowerShell aliases", () => {
  assert.equal(parseGuardianArgs([]).DevelopmentMode, false);
  const plan = parseGuardianArgs([
    "-DevelopmentMode",
    "-NoRestart:$false",
    "-PlanOnly",
    "--poll-seconds",
    "2",
    "-MaxCycles",
    "1",
  ]);
  assert.equal(plan.DevelopmentMode, true);
  assert.equal(plan.NoRestart, false);
  assert.equal(plan.PlanOnly, true);
  assert.equal(plan.PollSeconds, 2);
  assert.equal(plan.MaxCycles, 1);
  assert.equal(
    parseGuardianArgs(["--development-mode=false"]).DevelopmentMode,
    false,
  );
});

test("guardian CLI rejects invalid or duplicate timing and switch options", () => {
  for (const args of [
    ["-Port", "0"],
    ["-PollSeconds", "0"],
    ["-MaxCycles", "-1"],
    ["-Port", "65536"],
    ["-NoRestart:maybe"],
    ["--unknown"],
    ["-Port", "3", "--port", "4"],
    ["-LogPath"],
  ])
    assert.throws(() => parseGuardianArgs(args));
});

test("guardian custom port updates default health endpoint and preserves explicit endpoint", () => {
  assert.equal(
    parseGuardianArgs(["--port", "12345"]).HealthUri,
    "http://127.0.0.1:12345/health",
  );
  assert.equal(
    parseGuardianArgs([
      "--port",
      "12345",
      "--health-uri",
      "http://127.0.0.1:54321/custom",
    ]).HealthUri,
    "http://127.0.0.1:54321/custom",
  );
});

for (const marker of ["missing", "live", "stale", "stopping", "malformed"])
  test(`production recovery ignores ${marker} development session and launches installed executable`, async (t) => {
    const f = fixture(t);
    if (marker === "malformed") f.writeSession("{");
    else if (marker !== "missing") {
      f.writeSession({
        ...f.session,
        state: marker === "stopping" ? "stopping" : "running",
      });
      f.state.supervisorAlive = marker === "live";
    }
    const core = {
      ...guardianCore,
      devSessionRecoveryPlan: () => {
        throw new Error("Production must not read development markers.");
      },
    };
    await f.policy({ core });
    assert.deepEqual(f.launches, [
      { kind: "product", executable: f.plan.InstalledExecutable },
    ]);
  });

for (const marker of ["missing", "dev-live", "dev-stale", "foreign"])
  test(`production does not authorize a launch from ${marker} app marker`, async (t) => {
    const f = fixture(t);
    f.writeSession();
    f.state.supervisorAlive = marker === "dev-live";
    if (marker === "missing")
      rmSync(path.join(f.plan.ConfigPath, "logs", "app-run-marker.json"));
    else
      f.writeAppMarker({
        pid: 7777,
        executablePath: marker.startsWith("dev-")
          ? path.join(f.repo, "src-tauri", "target", "debug", "cc-switch.exe")
          : path.join(f.root, "other", "cc-switch.exe"),
        processStartedAtTicks: "134000000000000001",
      });
    await f.policy({
      core: {
        ...guardianCore,
        devSessionRecoveryPlan: () => {
          throw new Error("Production must not inspect development session.");
        },
      },
    });
    assert.equal(f.launches.length, 0);
    assert.ok(
      f.events.some(({ event }) => event === "restart-skipped-clean-exit"),
    );
  });

test("production recovers modern installed marker independently of live development supervisor", async (t) => {
  const f = fixture(t);
  f.writeSession();
  f.state.supervisorAlive = true;
  f.writeAppMarker({
    pid: 7777,
    executablePath: f.plan.InstalledExecutable,
    processStartedAtTicks: "134000000000000001",
  });
  await f.policy({
    core: {
      ...guardianCore,
      devSessionRecoveryPlan: () => {
        throw new Error("Production must not inspect development session.");
      },
    },
  });
  assert.equal(f.launches[0]?.kind, "product");
});

test("production clean-exit opt-in remains bound to installed application", async (t) => {
  const f = fixture(t, { RestartOnCleanExit: true });
  f.writeSession();
  f.writeAppMarker({
    pid: 7777,
    executablePath: path.join(
      f.repo,
      "src-tauri",
      "target",
      "debug",
      "cc-switch.exe",
    ),
    processStartedAtTicks: "134000000000000001",
  });
  await f.policy({
    core: {
      ...guardianCore,
      devSessionRecoveryPlan: () => {
        throw new Error("Production must not select development recovery.");
      },
    },
  });
  assert.equal(f.launches[0]?.kind, "product");
});

test("explicit development mode launches recorded JavaScript entry with saved arguments", async (t) => {
  const f = fixture(t, { DevelopmentMode: true });
  f.writeSession();
  rmSync(path.join(f.plan.ConfigPath, "logs", "app-run-marker.json"));
  await f.policy();
  assert.equal(f.launches.length, 1);
  assert.equal(f.launches[0].kind, "dev");
  assert.equal(f.launches[0].plan.Executable, f.node);
  assert.equal(f.launches[0].plan.ScriptPath, f.script);
  assert.deepEqual(f.launches[0].plan.Args, ["--delay", "0"]);
  assert.ok(f.events.some(({ event }) => event === "dev-session-started"));
});

test("development recovery does not consult production restart budget", async (t) => {
  const f = fixture(t, { DevelopmentMode: true });
  f.writeSession();
  const restartTimesUtc = Array.from({ length: 6 }, () => new Date());
  await f.policy({
    restartTimesUtc,
    core: {
      ...guardianCore,
      guardianRestartBudget: () => {
        throw new Error(
          "Development must not consult production restart budget.",
        );
      },
    },
  });
  assert.equal(f.launches.length, 1);
  assert.equal(f.launches[0].kind, "dev");
  assert.equal(restartTimesUtc.length, 6);
});

test("live supervisor defers explicit development recovery", async (t) => {
  const f = fixture(t, { DevelopmentMode: true });
  f.writeSession();
  f.state.supervisorAlive = true;
  await f.policy();
  assert.equal(f.launches.length, 0);
  assert.ok(
    f.events.some(({ event }) => event === "dev-session-recovery-deferred"),
  );
});

for (const marker of ["malformed", "stopping"])
  test(`explicit development mode never falls back to installed app for ${marker} marker`, async (t) => {
    const f = fixture(t, { DevelopmentMode: true });
    f.writeSession(
      marker === "malformed" ? "{" : { ...f.session, state: "stopping" },
    );
    await f.policy();
    assert.equal(f.launches.length, 0);
  });

for (const setting of ["disabled", "no-restart", "maintenance", "rate-limited"])
  test(`product recovery honors ${setting}`, async (t) => {
    const f = fixture(t, { NoRestart: setting === "no-restart" });
    f.state.enabled = setting !== "disabled";
    f.state.maintenance = setting === "maintenance";
    await f.policy({
      restartTimesUtc:
        setting === "rate-limited"
          ? Array.from({ length: 6 }, () => new Date())
          : [],
    });
    assert.equal(f.launches.length, 0);
  });

test("dev watchdog identity requires exact script, supervisor parent and creation", (t) => {
  const f = fixture(t);
  const plan = {
    Executable: f.node,
    ScriptPath: f.script,
    SupervisorPid: 4242,
    Session: f.session,
  };
  const item = {
    ProcessId: 5500,
    ParentProcessId: 4242,
    ExecutablePath: f.node,
    CommandLine: `"${f.node}" "${f.script}" --ccsm-dev-watchdog 4242`,
    CreationDate: "2026-10-13T00:00:01.000Z",
  };
  assert.deepEqual(inspectDevWatchdogProcesses(plan, [item]), {
    Active: true,
    Unknown: false,
  });
  for (const changed of [
    { CommandLine: `${item.CommandLine} --foreign` },
    { ParentProcessId: 9876 },
    { CreationDate: "2026-10-12T23:59:59.999Z" },
  ])
    assert.equal(
      inspectDevWatchdogProcesses(plan, [{ ...item, ...changed }]).Active,
      false,
    );
  assert.deepEqual(
    inspectDevWatchdogProcesses(plan, [{ ...item, CommandLine: null }]),
    { Active: false, Unknown: true },
  );
});

test("native process query retains handle before reading CIM and checks creation identity", () => {
  let script;
  const identity = {
    ProcessId: 4242,
    Path: process.execPath,
    StartTimeUtc: "2026-10-21T00:00:00.1234567Z",
  };
  assert.equal(
    guardianProcessIdentity(4242, {
      query: (value) => {
        script = value;
        return identity;
      },
    }),
    identity,
  );
  assert.ok(
    script.indexOf("$null = $h.Handle") < script.indexOf("Get-CimInstance"),
  );
  assert.match(script, /ProcessId=4242/);
  assert.match(script, /\.Ticks\) -ge 10/);
  assert.match(script, /NoProcessFoundForGivenId/);
  assert.doesNotMatch(script, /SilentlyContinue/);
  assert.throws(() => guardianProcessIdentity(0));
});

test(
  "native process query reads only this test process with exact Windows identity",
  { skip: process.platform !== "win32" },
  () => {
    const identity = guardianProcessIdentity(process.pid);
    assert.equal(identity.ProcessId, process.pid);
    assert.equal(identity.Path.toLowerCase(), process.execPath.toLowerCase());
    assert.match(identity.StartTimeUtc, /\.\d{7}Z$/);
  },
);

test("native stop checks exact retained handle path/start and optional command/SID before same-handle termination", () => {
  let captured;
  const expected = {
    ProcessId: 4242,
    Path: process.execPath,
    StartTimeUtc: "2026-10-21T00:00:00.1234567Z",
  };
  stopVerifiedWindowsProcess(expected, {
    expectedCommandLine: 'node "fixture.mjs"',
    expectedOwnerSid: "S-1-fixture",
    query: (script, name, options) => {
      captured = { script, name, options };
      return true;
    },
  });
  assert.ok(
    captured.script.indexOf("$null = $h.Handle") <
      captured.script.indexOf("Get-CimInstance"),
  );
  assert.match(captured.script, /\$h\.Path/);
  assert.match(captured.script, /1234567Z/);
  assert.match(captured.script, /GetOwnerSid/);
  assert.match(captured.script, /Process command identity changed/);
  assert.match(captured.script, /\$h\.Kill\(\)/);
  assert.doesNotMatch(captured.script, /Stop-Process/);
  assert.equal(captured.options.timeoutMs, 25_000);
  assert.throws(() =>
    stopVerifiedWindowsProcess({ ...expected, StartTimeUtc: undefined }),
  );
});

test("process stop and launch refuse lost native lock ownership", async (t) => {
  const f = fixture(t);
  let nativeCalled = false;
  const assertHeld = () => {
    throw new Error("lock lost");
  };
  assert.throws(
    () =>
      stopVerifiedWindowsProcess(
        {
          ProcessId: 1,
          Path: process.execPath,
          StartTimeUtc: "2026-10-21T00:00:00.0000000Z",
        },
        {
          assertHeld,
          query: () => {
            nativeCalled = true;
          },
        },
      ),
    /lock lost/,
  );
  const runtime = createGuardianRuntime(f.plan, {
    assertHeld,
    spawnProcess: () => {
      nativeCalled = true;
    },
  });
  await assert.rejects(runtime.startProduct(), /lock lost/);
  assert.equal(nativeCalled, false);
});

test("runtime product inspection combines exact installed identity and healthy response", async (t) => {
  const f = fixture(t);
  let identity = { ProcessId: 4242, Path: f.plan.InstalledExecutable };
  const runtime = createGuardianRuntime(f.plan, {
    query: (script, name) => (name === "guardian listener" ? 4242 : identity),
    fetchHealth: async () => ({ status: 200 }),
  });
  assert.deepEqual(await runtime.inspectRuntime(), {
    Healthy: true,
    ListenerOwner: 4242,
  });
  identity = {
    ...identity,
    Path: path.join(f.root, "foreign", "cc-switch.exe"),
  };
  assert.equal((await runtime.inspectRuntime()).Healthy, false);
});

test("runtime refuses recovery when a product process identity query is incomplete", (t) => {
  const f = fixture(t);
  const runtime = createGuardianRuntime(f.plan, {
    query: (script, name) => {
      if (name === "guardian owned processes") return [{ ProcessId: 4242 }];
      throw new Error("Identity access unavailable.");
    },
  });
  assert.throws(
    () => runtime.getExpectedProductProcesses(),
    /Identity access unavailable/,
  );
});

test("runtime development launcher uses Node argv without a shell or PS1 and filters saved environment", async (t) => {
  const f = fixture(t);
  let launch;
  const runtime = createGuardianRuntime(f.plan, {
    spawnProcess: (executable, args, options) => {
      launch = { executable, args, options };
      const child = new EventEmitter();
      child.pid = 8080;
      child.unref = () => {};
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  });
  const pid = await runtime.startDevSession({
    Executable: f.node,
    ScriptPath: f.script,
    SupervisorPid: 4040,
    Args: ["--delay", "0", "value with spaces"],
    RepoRoot: f.repo,
    Environment: {
      CCSWITCH_DEV_WATCHDOG: "1",
      UNRELATED_SECRET: "redacted-fixture",
    },
  });
  assert.equal(pid, 8080);
  assert.equal(launch.executable, f.node);
  assert.deepEqual(launch.args, [
    f.script,
    "--ccsm-dev-recover",
    "4040",
    "--delay",
    "0",
    "value with spaces",
  ]);
  assert.equal(launch.options.shell, undefined);
  assert.equal(
    launch.options.env.UNRELATED_SECRET,
    process.env.UNRELATED_SECRET,
  );
  assert.equal(launch.options.windowsHide, true);
});

test("runner survives transient iteration failures and releases native lock", async (t) => {
  const f = fixture(t, { MaxCycles: 3, FailureThresholdSeconds: 1 });
  let inspections = 0;
  let released = false;
  let now = 0;
  f.runtime.inspectRuntime = () => {
    inspections++;
    if (inspections === 1) throw new Error("transient fixture");
    return { Healthy: true, ListenerOwner: 1234 };
  };
  await runGuardian(f.plan, {
    core: guardianCore,
    runtime: f.runtime,
    acquireLock: async () => ({
      assertHeld() {},
      lost: new Promise(() => {}),
      release: async () => {
        released = true;
      },
    }),
    now: () => now,
    wait: async (duration) => {
      now += duration;
    },
  });
  assert.equal(inspections, 3);
  assert.equal(released, true);
  const started = f.events.find(({ event }) => event === "guardian-started");
  assert.equal(started.detail.GuardianProcessId, process.pid);
  assert.equal(
    started.detail.GuardianStartTimeUtc,
    "2026-10-21T00:00:00.1234567Z",
  );
  assert.ok(f.events.some(({ event }) => event === "iteration-failed"));
});

test("native lock uses legacy-compatible exclusive file sharing and releases keeper on completion", async (t) => {
  const f = fixture(t);
  let invocation;
  let exited = false;
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    exited = true;
    child.emit("exit", 0);
  };
  child.stdin.on("finish", () => child.kill());
  const lock = await acquireGuardianLock(f.plan.LockPath, {
    spawnProcess: (executable, args, options) => {
      invocation = { executable, args, options };
      queueMicrotask(() => child.stdout.write("locked\r\n"));
      return child;
    },
  });
  assert.equal(invocation.executable, "pwsh.exe");
  assert.match(invocation.args.at(-1), /\[IO\.FileShare\]::None/);
  assert.doesNotMatch(invocation.args.join(" "), /\.ps1/);
  lock.assertHeld();
  await lock.release();
  assert.equal(exited, true);
  assert.throws(() => lock.assertHeld(), /ownership was lost/);
});

test(
  "native guardian lock prevents a second owned fixture and can be reacquired after release",
  { skip: process.platform !== "win32", timeout: 30_000 },
  async (t) => {
    const f = fixture(t);
    const lock = await acquireGuardianLock(f.plan.LockPath);
    try {
      lock.assertHeld();
      await assert.rejects(
        acquireGuardianLock(f.plan.LockPath),
        /Another guardian owns the lock/,
      );
      lock.assertHeld();
    } finally {
      await lock.release();
    }
    const replacement = await acquireGuardianLock(f.plan.LockPath);
    try {
      replacement.assertHeld();
    } finally {
      await replacement.release();
    }
  },
);

test("guardian help and plan CLI have no native process or startup side effects", () => {
  const entry = new URL("./watch-ccswitchmulti.mjs", import.meta.url);
  const help = spawnSync(process.execPath, [fileURLToPath(entry), "--help"], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);
  assert.match(help.stdout, /Development recovery requires/);
});

test("runner cancels pending probes after native lock loss without later recovery", async (t) => {
  const f = fixture(t, { FailureThresholdSeconds: 1 });
  let inspections = 0;
  let now = 0;
  let loseLock;
  let releaseProbe;
  let probeStarted;
  const started = new Promise((resolve) => {
    probeStarted = resolve;
  });
  const lost = new Promise((resolve) => {
    loseLock = resolve;
  });
  f.runtime.inspectRuntime = () => {
    inspections++;
    if (inspections === 1) return { Healthy: false, ListenerOwner: null };
    probeStarted();
    return new Promise((resolve) => {
      releaseProbe = resolve;
    });
  };
  const running = runGuardian(f.plan, {
    core: guardianCore,
    runtime: f.runtime,
    acquireLock: async () => ({
      assertHeld() {},
      lost,
      release: async () => {},
    }),
    now: () => now,
    wait: async (duration) => {
      now += duration;
    },
  });
  await started;
  loseLock();
  await assert.rejects(running, /lock ownership was lost/);
  releaseProbe({ Healthy: false, ListenerOwner: null });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(inspections, 2);
  assert.equal(f.launches.length, 0);
  assert.ok(f.events.some(({ event }) => event === "guardian-exiting"));
});

test(
  "native runner start receipt records its exact retained process identity after lock acquisition",
  { skip: process.platform !== "win32", timeout: 15_000 },
  async (t) => {
    const f = fixture(t, { MaxCycles: 1 });
    const expected = guardianProcessIdentity(process.pid);
    f.runtime.getProcessIdentity = (pid) => guardianProcessIdentity(pid);
    f.runtime.inspectRuntime = () => ({ Healthy: true, ListenerOwner: 1234 });
    await runGuardian(f.plan, { core: guardianCore, runtime: f.runtime });
    const receipt = f.events.find(({ event }) => event === "guardian-started");
    assert.equal(receipt.detail.GuardianProcessId, expected.ProcessId);
    assert.equal(receipt.detail.GuardianStartTimeUtc, expected.StartTimeUtc);
  },
);

test(
  "JavaScript guardian respects the legacy PowerShell exclusive lock contract",
  { skip: process.platform !== "win32", timeout: 15_000 },
  async (t) => {
    const f = fixture(t);
    mkdirSync(path.dirname(f.plan.LockPath), { recursive: true });
    const lockPath = f.plan.LockPath.replaceAll("'", "''");
    const legacy = spawn(
      "pwsh.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$lock = [System.IO.File]::Open('${lockPath}', [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None); try { [Console]::Out.WriteLine('legacy-locked'); [Console]::Out.Flush(); $null = [Console]::In.ReadLine() } finally { $lock.Dispose() }`,
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    legacy.stderr.resume();
    const ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Legacy fixture did not acquire its own lock.")),
        5000,
      );
      let output = "";
      legacy.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      legacy.stdout.on("data", (data) => {
        output += String(data);
        if (output.includes("legacy-locked")) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
    try {
      await ready;
      await assert.rejects(
        acquireGuardianLock(f.plan.LockPath),
        /Another guardian owns the lock/,
      );
    } finally {
      const exited = new Promise((resolve) => legacy.once("exit", resolve));
      legacy.stdin.end();
      await exited;
    }
    const replacement = await acquireGuardianLock(f.plan.LockPath);
    try {
      replacement.assertHeld();
    } finally {
      await replacement.release();
    }
  },
);

test("runner has no repository PS1 runtime dependency", () => {
  const source = readFileSync(
    new URL("./watch-ccswitchmulti.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /["']-File["']/);
  assert.doesNotMatch(source, /spawn(?:Process)?\([^\n]*\.ps1/);
});
