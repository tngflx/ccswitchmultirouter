import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  samePath,
  pathInside,
  utcTicks,
  parseGuardianJson,
  watchdogEnabled,
  devSessionEnvironment,
  devRestartTimes,
  devSessionRecoveryPlan,
  devSessionRecovery,
  devSessionListenerIdentity,
  maintenanceLeaseRecord,
  maintenanceLeaseRecordActive,
  maintenanceLeaseActive,
  fileSha256,
  tauriNsisPayloadHash,
  guardianIteration,
  guardianUncleanExit,
  guardianRestartBudget,
  guardianSafeIteration,
  guardianRecovery,
} from "./ccswitchmulti-guardian-core.mjs";

const START = "2026-10-21T12:01:15.7130461Z";
const FILETIME = "134370576757130461";
const NOW = "2026-10-21T12:02:00.000Z";
const NOW_MS = Date.parse(NOW);
const installed = "C:\\Apps\\CCSwitchMulti\\cc-switch.exe";
const identity = { ProcessId: 42, Path: installed, StartTimeUtc: START };

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccsm-js-guardian-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "logs"));
  const write = (name, value) =>
    writeFileSync(
      path.join(root, name),
      typeof value === "string" ? value : JSON.stringify(value),
    );
  const writeMarker = (overrides = {}) =>
    write("logs/app-run-marker.json", {
      pid: 42,
      executablePath: installed,
      processStartedAtTicks: FILETIME,
      ...overrides,
    });
  return { root, write, writeMarker };
}

function devFixture(t) {
  const base = fixture(t);
  const repoRoot = path.join(base.root, "repo");
  mkdirSync(path.join(repoRoot, "scripts"), { recursive: true });
  const scriptPath = path.join(repoRoot, "scripts", "dev-tauri-delayed.mjs");
  const executable = path.join(base.root, "node.exe");
  writeFileSync(scriptPath, "fixture");
  writeFileSync(path.join(repoRoot, "package.json"), "{}");
  writeFileSync(executable, "fixture");
  const session = {
    schemaVersion: 1,
    state: "running",
    repoRoot,
    scriptPath,
    supervisorExecutablePath: executable,
    supervisorPid: 73,
    supervisorStartedAtUtc: "2026-10-21T11:00:00.123Z",
    startedAtUtc: "2026-10-21T11:00:01.456Z",
    args: ["--delay", "0", "argument with spaces"],
    roots: [],
    environment: {},
    restartTimesMs: [],
  };
  const save = () => base.write("logs/dev-session.json", session);
  save();
  const inspectWatchdogOwnership = async () => ({
    Active: false,
    Unknown: false,
  });
  const getPlan = (options = {}) =>
    devSessionRecoveryPlan({
      configPath: base.root,
      getProcessIdentity: async () => null,
      inspectWatchdogOwnership,
      ...options,
    });
  const events = [];
  const launches = [];
  const recover = async (options = {}) =>
    devSessionRecovery({
      plan: await getPlan(),
      isMaintenance: async () => false,
      getListenerOwner: async () => null,
      getProcessIdentity: async () => null,
      inspectWatchdogOwnership,
      startDevSession: async (plan) => {
        launches.push(plan);
        return 99;
      },
      writeEvent: async (...event) => {
        events.push(event);
      },
      nowMs: NOW_MS,
      ...options,
    });
  return {
    ...base,
    repoRoot,
    scriptPath,
    executable,
    session,
    save,
    getPlan,
    recover,
    events,
    launches,
  };
}

test("Windows paths preserve host AppContainer projection identity", () => {
  const local = "C:\\Users\\fixture\\AppData\\Local";
  const executable = `${local}\\CCSwitchMulti\\cc-switch.exe`;
  const projected = `${local}\\Packages\\OpenAI.Codex_fixture\\LocalCache\\Local\\CCSwitchMulti\\cc-switch.exe`;
  assert.equal(samePath(executable, projected, local), true);
  assert.equal(
    samePath(
      executable,
      projected.replace("OpenAI.Codex_", "Other.App_"),
      local,
    ),
    false,
  );
  assert.equal(
    pathInside("C:\\repo\\target", "C:\\repo\\target-other\\app.exe"),
    false,
  );
  assert.equal(
    pathInside("C:\\repo\\target", "c:\\repo\\target\\debug\\app.exe"),
    true,
  );
});

test("FILETIME numeric source retains exact 100ns identity beyond Number precision", () => {
  const marker = parseGuardianJson(`{"processStartedAtTicks":${FILETIME}}`);
  assert.equal(marker.processStartedAtTicks, FILETIME);
  assert.equal(utcTicks(START) + 1n, utcTicks("2026-10-21T12:01:15.7130462Z"));
  assert.equal(utcTicks(START), utcTicks("2026-10-21T20:01:15.7130461+08:00"));
  assert.throws(
    () => utcTicks("2026-02-30T12:00:00Z"),
    /Invalid UTC timestamp/,
  );
});

test("a missing clean-exit marker does not authorize production restart", async (t) => {
  const { root } = fixture(t);
  assert.equal(
    await guardianUncleanExit({
      configPath: root,
      expectedExecutable: installed,
      getProcessIdentity: async () => null,
    }),
    false,
  );
});

for (const variant of ["string", "numeric"]) {
  test(`matching ${variant} FILETIME marker keeps exact original process alive`, async (t) => {
    const f = fixture(t);
    f.writeMarker();
    if (variant === "numeric")
      f.write(
        "logs/app-run-marker.json",
        `{"pid":42,"executablePath":${JSON.stringify(installed)},"processStartedAtTicks":${FILETIME}}`,
      );
    assert.equal(
      await guardianUncleanExit({
        configPath: f.root,
        expectedExecutable: installed,
        getProcessIdentity: async () => identity,
      }),
      false,
    );
  });
}

for (const [name, observed] of [
  [
    "one FILETIME tick of PID reuse",
    { ...identity, StartTimeUtc: "2026-10-21T12:01:15.7130462Z" },
  ],
  ["a different executable", { ...identity, Path: "C:\\Other\\cc-switch.exe" }],
  ["a different PID", { ...identity, ProcessId: 43 }],
  ["a disappeared process", null],
]) {
  test(`production crash marker authorizes recovery after ${name}`, async (t) => {
    const f = fixture(t);
    f.writeMarker();
    assert.equal(
      await guardianUncleanExit({
        configPath: f.root,
        expectedExecutable: installed,
        getProcessIdentity: async () => observed,
      }),
      true,
    );
  });
}

test("a development crash marker cannot authorize installed recovery", async (t) => {
  const f = fixture(t);
  f.writeMarker({
    executablePath: "C:\\repo\\src-tauri\\target\\debug\\cc-switch.exe",
  });
  assert.equal(
    await guardianUncleanExit({
      configPath: f.root,
      expectedExecutable: installed,
      getProcessIdentity: async () => null,
    }),
    false,
  );
});

for (const fields of [
  { processStartedAtTicks: null },
  { processStartedAtTicks: "-1" },
  { processStartedAtTicks: "bad" },
  { processStartedAtTicks: "999999999999999999999999" },
  { executablePath: "relative.exe" },
  { executablePath: "\\relative.exe" },
  { pid: "42" },
]) {
  test(`malformed modern crash identity blocks restart: ${JSON.stringify(fields)}`, async (t) => {
    const f = fixture(t);
    f.writeMarker(fields);
    assert.equal(
      await guardianUncleanExit({
        configPath: f.root,
        expectedExecutable: installed,
        getProcessIdentity: async () => null,
      }),
      false,
    );
  });
}

test("PID-only markers preserve conservative legacy behavior", async (t) => {
  const f = fixture(t);
  f.write("logs/app-run-marker.json", { pid: 42 });
  assert.equal(
    await guardianUncleanExit({
      configPath: f.root,
      getProcessIdentity: async () => identity,
    }),
    false,
  );
  assert.equal(
    await guardianUncleanExit({
      configPath: f.root,
      getProcessIdentity: async () => null,
    }),
    true,
  );
});

test("a drive-relative modern marker cannot authorize recovery without an expected path", async (t) => {
  const f = fixture(t);
  f.writeMarker({ executablePath: "\\relative.exe" });
  assert.equal(
    await guardianUncleanExit({
      configPath: f.root,
      getProcessIdentity: async () => null,
    }),
    false,
  );
});

test("settings precedence and explicit environment disable share the dev policy", (t) => {
  const f = fixture(t);
  assert.equal(watchdogEnabled({ configPath: f.root }), true);
  f.write("settings.json", { watchdogEnabled: false, watchdog_enabled: true });
  assert.equal(watchdogEnabled({ configPath: f.root }), false);
  assert.equal(
    watchdogEnabled({
      configPath: f.root,
      environment: { CC_SWITCH_DEV_WATCHDOG_ENABLED: "1" },
    }),
    true,
  );
  assert.equal(
    watchdogEnabled({
      configPath: f.root,
      environment: { CC_SWITCH_DEV_WATCHDOG_ENABLED: "0" },
    }),
    false,
  );
  f.write("settings.json", "{");
  assert.equal(watchdogEnabled({ configPath: f.root }), false);
});

test("only declared valid session environment values cross the launcher boundary", () => {
  assert.deepEqual(
    devSessionEnvironment({
      CC_SWITCH_DEV_WATCHDOG_ENABLED: "1",
      TAURI_DEV_REBUILD_DELAY_MS: "0",
      PRIVATE_TOKEN: "redacted-fixture",
      TAURI_DEV_PORT: "bad\0port",
    }),
    { CC_SWITCH_DEV_WATCHDOG_ENABLED: "1", TAURI_DEV_REBUILD_DELAY_MS: "0" },
  );
});

test("canonical empty history is authoritative and malformed canonical uses legacy history", () => {
  assert.deepEqual(
    devRestartTimes(
      { restartTimesMs: [], supervisorRestartTimesMs: [NOW_MS] },
      NOW_MS,
    ),
    [],
  );
  assert.deepEqual(
    devRestartTimes(
      { restartTimesMs: null, supervisorRestartTimesMs: [NOW_MS] },
      NOW_MS,
    ),
    [NOW_MS],
  );
  assert.deepEqual(
    devRestartTimes(
      {
        restartTimesMs: [
          NOW_MS - 1_800_000,
          NOW_MS - 1_800_001,
          "123",
          0.5,
          Infinity,
          Number.MAX_SAFE_INTEGER + 1,
        ],
      },
      NOW_MS,
    ),
    [NOW_MS - 1_800_000],
  );
});

test("active supervisor ownership binds executable, script, PID and CIM millisecond identity", async (t) => {
  const f = devFixture(t);
  const owner = {
    ProcessId: 73,
    Path: f.executable,
    StartTimeUtc: "2026-10-21T11:00:00.1239999Z",
    CommandLine: `"${f.executable}" "${f.scriptPath}"`,
  };
  assert.equal(
    (await f.getPlan({ getProcessIdentity: async () => owner })).Active,
    true,
  );
  for (const mutation of [
    { ProcessId: 74 },
    { Path: "C:\\other\\node.exe" },
    { StartTimeUtc: "2026-10-21T11:00:00.124Z" },
    { CommandLine: "node other.mjs" },
  ]) {
    assert.equal(
      (
        await f.getPlan({
          getProcessIdentity: async () => ({ ...owner, ...mutation }),
        })
      ).Active,
      false,
    );
  }
});

for (const [name, ownership] of [
  ["live", { Active: true, Unknown: false }],
  ["unknown", { Active: false, Unknown: true }],
]) {
  test(`a ${name} detached watcher prevents a competing dev launcher`, async (t) => {
    const f = devFixture(t);
    const plan = await f.getPlan({
      inspectWatchdogOwnership: async () => ownership,
    });
    assert.equal(plan.Recoverable, false);
    await f.recover({ plan });
    assert.equal(f.launches.length, 0);
    assert.deepEqual(
      JSON.parse(readFileSync(plan.SessionPath, "utf8")).restartTimesMs,
      [],
    );
  });
}

test("unavailable watcher inspection fails closed and suppresses installed fallback", async (t) => {
  const f = devFixture(t);
  const plan = await f.getPlan({
    inspectWatchdogOwnership: async () => {
      throw new Error("probe unavailable");
    },
  });
  assert.equal(plan.PreventInstalledFallback, true);
  assert.equal(plan.WatchdogOwnershipUnknown, true);
  assert.equal(plan.Recoverable, false);
  f.write("logs/dev-session.json", "{");
  const malformed = await f.getPlan();
  assert.equal(malformed.PreventInstalledFallback, true);
  assert.equal(malformed.Recoverable, false);
});

test("dev fallback persists canonical budget before launch and preserves exact identities", async (t) => {
  const f = devFixture(t);
  f.session.supervisorRestartTimesMs = [NOW_MS - 100];
  delete f.session.restartTimesMs;
  f.session.workerIdentity = { CreationDate: "2026-10-21T11:00:02.1234567Z" };
  f.save();
  await f.recover({
    startDevSession: async (plan) => {
      const current = JSON.parse(readFileSync(plan.SessionPath, "utf8"));
      assert.deepEqual(current.restartTimesMs, [NOW_MS - 100, NOW_MS]);
      assert.equal(Object.hasOwn(current, "supervisorRestartTimesMs"), false);
      assert.equal(
        current.workerIdentity.CreationDate,
        "2026-10-21T11:00:02.1234567Z",
      );
      assert.deepEqual(plan.Args, f.session.args);
      f.launches.push(plan);
      return 99;
    },
  });
  assert.equal(f.launches.length, 1);
  assert.deepEqual(
    f.events.map((e) => e[1]),
    ["dev-session-started", "dev-session-rebuild-pending"],
  );
});

test("fifth canonical charge is allowed, next attempt is rate limited", async (t) => {
  const f = devFixture(t);
  f.session.restartTimesMs = Array(4).fill(NOW_MS - 100);
  f.save();
  await f.recover();
  await f.recover();
  assert.equal(f.launches.length, 1);
  assert.equal(f.events.at(-1)[1], "dev-session-restart-rate-limited");
});

test("stale dev plan cannot overwrite a newer stopping marker", async (t) => {
  const f = devFixture(t);
  const plan = await f.getPlan();
  f.session.state = "stopping";
  f.save();
  await f.recover({ plan });
  assert.equal(f.launches.length, 0);
  assert.equal(
    JSON.parse(readFileSync(plan.SessionPath, "utf8")).state,
    "stopping",
  );
});

test("foreign listener, maintenance and disabled recovery do not consume dev budget", async (t) => {
  const f = devFixture(t);
  await f.recover({
    getListenerOwner: async () => 44,
    getProcessIdentity: async () => identity,
  });
  await f.recover({ isMaintenance: async () => true });
  f.write("settings.json", { watchdogEnabled: false });
  await f.recover();
  assert.equal(f.launches.length, 0);
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(f.root, "logs/dev-session.json"), "utf8"))
      .restartTimesMs,
    [],
  );
});

test("failed budget persistence blocks launch and cannot log arbitrary error data", async (t) => {
  const f = devFixture(t);
  await f.recover({
    persistBudget: async () => {
      throw new Error("redacted-fixture-private-data");
    },
  });
  assert.equal(f.launches.length, 0);
  assert.deepEqual(f.events.at(-1), [
    "error",
    "dev-session-restart-budget-persist-failed",
    null,
  ]);
});

test("spawn failure retains its persisted canonical restart charge", async (t) => {
  const f = devFixture(t);
  await assert.rejects(
    f.recover({
      startDevSession: async () => {
        throw new Error("fixture spawn failure");
      },
    }),
    /fixture spawn failure/,
  );
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(f.root, "logs/dev-session.json"), "utf8"))
      .restartTimesMs,
    [NOW_MS],
  );
});

test("lost guardian ownership cannot charge or launch a development replacement", async (t) => {
  const f = devFixture(t);
  await assert.rejects(
    f.recover({
      assertHeld: () => {
        throw new Error("Native lock ownership lost");
      },
    }),
    /Native lock ownership lost/,
  );
  assert.equal(f.launches.length, 0);
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(f.root, "logs/dev-session.json"), "utf8"))
      .restartTimesMs,
    [],
  );
  assert.deepEqual(f.events, []);
});

test("ownership lost after a valid charge prevents launch and recovery logs", async (t) => {
  const f = devFixture(t);
  let checks = 0;
  await assert.rejects(
    f.recover({
      assertHeld: () => {
        if (++checks > 1) throw new Error("Native lock ownership lost");
      },
    }),
    /Native lock ownership lost/,
  );
  assert.equal(f.launches.length, 0);
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(f.root, "logs/dev-session.json"), "utf8"))
      .restartTimesMs,
    [NOW_MS],
  );
  assert.deepEqual(f.events, []);
});

test("dev app listener identity uses raw FILETIME and target-directory boundary", async (t) => {
  const f = devFixture(t);
  const app = path.join(f.repoRoot, "src-tauri/target/debug/cc-switch.exe");
  f.writeMarker({ executablePath: app });
  const plan = await f.getPlan();
  assert.equal(
    devSessionListenerIdentity({ plan, identity: { ...identity, Path: app } }),
    true,
  );
  assert.equal(
    devSessionListenerIdentity({
      plan,
      identity: {
        ...identity,
        Path: app,
        StartTimeUtc: "2026-10-21T12:01:15.7130462Z",
      },
    }),
    false,
  );
});

test("maintenance lease binds expiry, owner PID, executable and exact creation ticks", async (t) => {
  const f = fixture(t);
  const lease = maintenanceLeaseRecord({
    ownerIdentity: identity,
    leaseId: "fixture-lease",
    nowUtc: START,
    durationSeconds: 300,
    purpose: "fixture maintenance",
  });
  f.write("maintenance.lock", lease);
  const options = {
    lease,
    nowUtc: NOW,
    getProcessIdentity: async () => identity,
  };
  assert.equal(await maintenanceLeaseRecordActive(options), true);
  assert.equal(
    await maintenanceLeaseActive({
      markerPath: path.join(f.root, "maintenance.lock"),
      nowUtc: NOW,
      getProcessIdentity: async () => identity,
    }),
    true,
  );
  assert.equal(
    await maintenanceLeaseRecordActive({
      ...options,
      nowUtc: "2026-10-21T12:10:00Z",
    }),
    false,
  );
  assert.equal(
    await maintenanceLeaseRecordActive({
      ...options,
      getProcessIdentity: async () => ({
        ...identity,
        StartTimeUtc: "2026-10-21T12:01:15.7130462Z",
      }),
    }),
    false,
  );
  assert.equal(
    await maintenanceLeaseRecordActive({
      ...options,
      getProcessIdentity: async () => ({ ...identity, ProcessId: 43 }),
    }),
    false,
  );
});

test("artifact hashes preserve exact Tauri NSIS bundle-marker transformation", (t) => {
  const f = fixture(t);
  const filename = path.join(f.root, "fixture.exe");
  const bytes = Buffer.from("fixture-__TAURI_BUNDLE_TYPE_VAR_UNK-fixture");
  writeFileSync(filename, bytes);
  assert.equal(
    fileSha256(filename),
    createHash("sha256").update(bytes).digest("hex").toUpperCase(),
  );
  assert.equal(
    tauriNsisPayloadHash(filename),
    createHash("sha256")
      .update(Buffer.from("fixture-__TAURI_BUNDLE_TYPE_VAR_NSS-fixture"))
      .digest("hex")
      .toUpperCase(),
  );
  writeFileSync(filename, Buffer.concat([bytes, bytes]));
  assert.throws(() => tauriNsisPayloadHash(filename), /exactly one/);
});

test("health recovery waits for continuous threshold and resets on maintenance or health", async () => {
  const state = { FailureSinceUtc: null };
  let healthy = false,
    maintenance = false,
    recoveries = 0;
  const events = [];
  const cycle = (seconds) =>
    guardianIteration({
      state,
      nowUtc: new Date(NOW_MS + seconds * 1000),
      failureThresholdSeconds: 60,
      isMaintenance: async () => maintenance,
      inspectRuntime: async () => ({ Healthy: healthy, ListenerOwner: null }),
      recover: async () => {
        recoveries++;
      },
      writeEvent: async (...event) => events.push(event),
    });
  await cycle(0);
  await cycle(59);
  assert.equal(recoveries, 0);
  await cycle(60);
  assert.equal(recoveries, 1);
  healthy = true;
  await cycle(70);
  assert.equal(state.FailureSinceUtc, null);
  healthy = false;
  await cycle(71);
  maintenance = true;
  await cycle(200);
  assert.equal(state.FailureSinceUtc, null);
  assert.deepEqual(
    events.map((e) => e[1]),
    [
      "health-loss-detected",
      "health-loss-threshold-reached",
      "health-loss-detected",
    ],
  );
});

test("one failed iteration is redacted and does not terminate following iterations", async () => {
  const events = [];
  const writeEvent = async (...event) => events.push(event);
  assert.equal(
    await guardianSafeIteration({
      action: async () => {
        throw new Error("redacted-fixture-private-data");
      },
      writeEvent,
    }),
    false,
  );
  assert.equal(
    await guardianSafeIteration({ action: async () => {}, writeEvent }),
    true,
  );
  assert.deepEqual(events, [["error", "iteration-failed", null]]);
});

test("production budget includes the exact window boundary and blocks invalid limits", () => {
  assert.equal(
    guardianRestartBudget({
      restartTimesUtc: [new Date(NOW_MS - 1_800_000)],
      nowUtc: NOW,
      windowMinutes: 30,
      maxRestarts: 1,
    }),
    false,
  );
  assert.equal(
    guardianRestartBudget({
      restartTimesUtc: [new Date(NOW_MS - 1_800_001)],
      nowUtc: NOW,
      windowMinutes: 30,
      maxRestarts: 1,
    }),
    true,
  );
  assert.equal(
    guardianRestartBudget({
      restartTimesUtc: [],
      nowUtc: NOW,
      windowMinutes: 0,
      maxRestarts: 1,
    }),
    false,
  );
});

function recoveryOptions(overrides = {}) {
  const calls = [];
  const events = [];
  return {
    calls,
    events,
    options: {
      installedExecutable: installed,
      isMaintenance: async () => false,
      installedExecutableExists: async () => true,
      getListenerOwner: async () => 42,
      getProcessIdentity: async () => identity,
      isExpectedProductIdentity: async (value) =>
        samePath(value.Path, installed),
      getExpectedProductProcesses: async () => [
        identity,
        { ...identity, ProcessId: 43 },
      ],
      stopVerifiedProductProcess: async (value) =>
        calls.push(`stop:${value.ProcessId}`),
      waitPortFree: async () => {
        calls.push("port-free");
        return true;
      },
      startProduct: async () => {
        calls.push("start");
        return 99;
      },
      waitReady: async (pid) => {
        calls.push(`ready:${pid}`);
        return true;
      },
      writeEvent: async (...event) => events.push(event),
      ...overrides,
    },
  };
}

test("production recovery blocks a foreign listener without stopping or starting processes", async () => {
  const f = recoveryOptions({
    getProcessIdentity: async () => ({
      ...identity,
      Path: "C:\\Foreign\\app.exe",
    }),
  });
  await guardianRecovery(f.options);
  assert.deepEqual(f.calls, []);
  assert.equal(f.events.at(-1)[1], "foreign-listener-blocked-recovery");
});

test("production recovery stops each verified stale owner once then waits before launch", async () => {
  const f = recoveryOptions();
  await guardianRecovery(f.options);
  assert.deepEqual(f.calls, [
    "stop:42",
    "stop:43",
    "port-free",
    "start",
    "ready:99",
  ]);
  assert.equal(f.events.at(-1)[1], "recovery-ready");
});

test("failed production readiness is reported without claiming ready", async () => {
  const f = recoveryOptions({ waitReady: async () => false });
  await guardianRecovery(f.options);
  assert.deepEqual(f.events.at(-1), [
    "error",
    "recovery-not-ready",
    { ProcessId: 99 },
  ]);
});

test("maintenance activated during port release prevents product relaunch", async () => {
  let checks = 0;
  const f = recoveryOptions({ isMaintenance: async () => ++checks > 1 });
  await guardianRecovery(f.options);
  assert.deepEqual(f.calls, ["stop:42", "stop:43", "port-free"]);
  assert.equal(f.events.at(-1)[1], "recovery-deferred-maintenance");
});
