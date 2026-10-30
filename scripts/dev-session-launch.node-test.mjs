import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { utcTicks } from "./ccswitchmulti-guardian-core.mjs";
import { quoteWindowsProcessArgument } from "./dev-independent-watchdog.mjs";
import test from "node:test";
import {
  DEV_RECOVERY_FLAG,
  parseDevSupervisorLaunchArgs,
  prepareDevSessionLaunch,
  stopOwnedWindowsDevSession,
} from "./dev-session-launch.mjs";
import {
  runWindowsJsonQuery,
  windowsJsonQueryCommand,
} from "./windows-json-query.mjs";

function fixture(overrides = {}) {
  const repoRoot = path.resolve("fixture-repository");
  const scriptPath = path.join(repoRoot, "scripts", "dev-tauri-delayed.mjs");
  const executable = process.execPath;
  const nowMs = Date.parse("2026-10-22T00:00:00.000Z");
  const session = {
    schemaVersion: 1,
    supervisorPid: 4242,
    supervisorExecutablePath: executable,
    supervisorStartedAtUtc: "2026-10-21T23:59:00.000Z",
    repoRoot,
    scriptPath,
    args: ["--delay", "0"],
    environment: {},
    startedAtUtc: "2026-10-21T23:59:00.000Z",
    roots: [],
    state: "running",
    restartTimesMs: [nowMs - 20_000, nowMs - 10_000],
    ...overrides,
  };
  const identity = {
    ProcessId: session.supervisorPid,
    ParentProcessId: 4000,
    ExecutablePath: executable,
    CreationDate: session.supervisorStartedAtUtc,
    CommandLine: `"${executable}" "${scriptPath}" --delay 0`,
  };
  const actions = [];
  const options = {
    markerPath: path.join(repoRoot, "fixture-session.json"),
    repoRoot,
    scriptPath,
    executable,
    platform: "win32",
    now: () => nowMs,
    readSession: () => session,
    queryProcesses: () => [],
    persistSession: (record) => actions.push(["persist", record]),
    stopOwnedSession: () => actions.push(["stop"]),
  };
  return { session, identity, actions, options, nowMs };
}

test("explicit launcher preserves user arguments and recovery strips only its own prefix", () => {
  const args = ["--delay", "0", "value with spaces"];
  assert.deepEqual(parseDevSupervisorLaunchArgs(args), {
    args,
    mode: "explicit",
  });
  assert.deepEqual(
    parseDevSupervisorLaunchArgs([DEV_RECOVERY_FLAG, "4242", ...args]),
    {
      args,
      mode: "recovery",
      expectedSupervisorPid: 4242,
    },
  );
});

test("reserved recovery arguments cannot be malformed, duplicated, or hidden in saved user arguments", () => {
  for (const args of [
    [DEV_RECOVERY_FLAG],
    [DEV_RECOVERY_FLAG, "0"],
    [DEV_RECOVERY_FLAG, "-1"],
    [DEV_RECOVERY_FLAG, "1.5"],
    [DEV_RECOVERY_FLAG, "9007199254740992"],
    ["--delay", "0", DEV_RECOVERY_FLAG, "4242"],
    [`${DEV_RECOVERY_FLAG}=4242`],
    ["--delay", "0", `${DEV_RECOVERY_FLAG}=4242`],
    [DEV_RECOVERY_FLAG, "4242", DEV_RECOVERY_FLAG, "4242"],
  ]) {
    assert.throws(
      () => parseDevSupervisorLaunchArgs(args),
      undefined,
      JSON.stringify(args),
    );
  }
});

test("manual launch starts a fresh restart budget after a dead owned session", async () => {
  const f = fixture();
  const prepared = await prepareDevSessionLaunch(f.options);
  assert.deepEqual(prepared.restartTimesMs, []);
  assert.equal(prepared.previous, f.session);
  assert.deepEqual(f.actions, []);
});

function independentWatchdogFixture() {
  const f = fixture();
  const watchdog = {
    ProcessId: 5500,
    ParentProcessId: 7000,
    ExecutablePath: f.options.executable,
    CommandLine: `"${f.options.executable}" "${f.options.scriptPath}" --ccsm-dev-watchdog ${f.session.supervisorPid}`,
    CreationDate: "2026-10-21T23:59:01.123456Z",
  };
  f.session.watchdogIdentity = watchdog;
  return { ...f, watchdog };
}

test("manual takeover stops its exact canonical independent watchdog without requiring supervisor parentage", async () => {
  const f = independentWatchdogFixture();
  let stopped = false;
  let selected;
  await prepareDevSessionLaunch({
    ...f.options,
    queryProcesses: () => (stopped ? [] : [f.identity, f.watchdog]),
    stopOwnedSession: ({ watchdogs }) => {
      selected = watchdogs;
      stopped = true;
    },
  });
  assert.deepEqual(selected, [f.watchdog]);
});

test("manual takeover recognizes the exact fully quoted command produced by the independent launcher", async () => {
  const f = independentWatchdogFixture();
  const watchdog = {
    ...f.watchdog,
    CommandLine: [
      f.options.executable,
      f.options.scriptPath,
      "--ccsm-dev-watchdog",
      String(f.session.supervisorPid),
    ]
      .map(quoteWindowsProcessArgument)
      .join(" "),
  };
  f.session.watchdogIdentity = watchdog;
  let stopped = false;
  await prepareDevSessionLaunch({
    ...f.options,
    queryProcesses: () => (stopped ? [] : [f.identity, watchdog]),
    stopOwnedSession: ({ watchdogs }) => {
      assert.deepEqual(watchdogs, [watchdog]);
      stopped = true;
    },
  });
  assert.equal(stopped, true);
});

test("canonical watchdog identity is authoritative and ambiguous or reused identities cannot authorize takeover", async () => {
  for (const changed of [
    null,
    { CommandLine: undefined },
    { ParentProcessId: 8000 },
    { CreationDate: "2026-10-21T23:59:01.1234561Z" },
    { ExecutablePath: path.resolve("foreign", "node.exe") },
    { CommandLine: "foreign --ccsm-dev-watchdog 4242" },
  ]) {
    const f = independentWatchdogFixture();
    const current = changed === null ? null : { ...f.watchdog, ...changed };
    if (changed === null) f.session.watchdogIdentity = null;
    await assert.rejects(
      prepareDevSessionLaunch({
        ...f.options,
        queryProcesses: () => [f.identity, current ?? f.watchdog],
      }),
      /watchdog ownership/,
    );
    assert.deepEqual(f.actions, []);
  }
});

test("a missing canonical independent watchdog does not block exact manual takeover", async () => {
  const f = independentWatchdogFixture();
  let stopped = false;
  let selected;
  await prepareDevSessionLaunch({
    ...f.options,
    queryProcesses: () => (stopped ? [] : [f.identity]),
    stopOwnedSession: ({ watchdogs }) => {
      selected = watchdogs;
      stopped = true;
    },
  });
  assert.deepEqual(selected, []);
});

test("canonical watchdog cannot be silently replaced by a competing legacy child", async () => {
  const f = independentWatchdogFixture();
  await assert.rejects(
    prepareDevSessionLaunch({
      ...f.options,
      queryProcesses: () => [
        f.identity,
        f.watchdog,
        { ...f.watchdog, ProcessId: 5501, ParentProcessId: 4242 },
      ],
    }),
    /watchdog ownership/,
  );
  assert.deepEqual(f.actions, []);
});

test("canonical watchdog refuses a competing exact command with an unknown executable path", async () => {
  for (const pathOverride of [undefined, path.resolve("foreign", "node.exe")]) {
    const f = independentWatchdogFixture();
    const competing = {
      ...f.watchdog,
      ProcessId: 5501,
      ...(pathOverride === undefined
        ? { ExecutablePath: undefined }
        : { ExecutablePath: pathOverride }),
    };
    await assert.rejects(
      prepareDevSessionLaunch({
        ...f.options,
        queryProcesses: () => [f.identity, f.watchdog, competing],
      }),
      /watchdog ownership/,
    );
    assert.deepEqual(f.actions, []);
  }
});

test("canonical watchdog native ticks are exact strings consistent with its CIM creation and malformed ticks block takeover", async () => {
  for (const ticks of [
    null,
    134371007411234560,
    "bad",
    "-1",
    "1",
    "999999999999999999999999",
  ]) {
    const f = independentWatchdogFixture();
    f.session.watchdogIdentity = {
      ...f.watchdog,
      ProcessStartedAtTicks: ticks,
    };
    await assert.rejects(
      prepareDevSessionLaunch({
        ...f.options,
        queryProcesses: () => [f.identity, f.watchdog],
      }),
      /watchdog ownership/,
    );
    assert.deepEqual(f.actions, []);
  }
  const f = independentWatchdogFixture();
  const ticks = (
    utcTicks(f.watchdog.CreationDate) +
    116444736000000000n +
    9n
  ).toString();
  f.session.watchdogIdentity = { ...f.watchdog, ProcessStartedAtTicks: ticks };
  let stopped = false;
  await prepareDevSessionLaunch({
    ...f.options,
    queryProcesses: () => (stopped ? [] : [f.identity, f.watchdog]),
    stopOwnedSession: ({ watchdogs }) => {
      assert.deepEqual(watchdogs, [f.session.watchdogIdentity]);
      stopped = true;
    },
  });
  assert.equal(stopped, true);
});

test("an unreadable direct child still blocks takeover when an independent watchdog is canonical", async () => {
  const f = independentWatchdogFixture();
  await assert.rejects(
    prepareDevSessionLaunch({
      ...f.options,
      queryProcesses: () => [
        f.identity,
        f.watchdog,
        {
          ProcessId: 5501,
          ParentProcessId: 4242,
          ExecutablePath: f.options.executable,
        },
      ],
    }),
    /watchdog ownership/,
  );
  assert.deepEqual(f.actions, []);
});

test("a replaced canonical watchdog during marker reread cannot authorize termination", async () => {
  const f = independentWatchdogFixture();
  let reads = 0;
  await assert.rejects(
    prepareDevSessionLaunch({
      ...f.options,
      queryProcesses: () => [f.identity, f.watchdog],
      readSession: () =>
        ++reads === 1
          ? f.session
          : {
              ...f.session,
              watchdogIdentity: { ...f.watchdog, ProcessId: 5501 },
            },
    }),
    /ownership changed/,
  );
  assert.deepEqual(f.actions, []);
});

test("unknown launch modes cannot stop a session or reset its restart history", async () => {
  const f = fixture();
  await assert.rejects(
    prepareDevSessionLaunch({
      ...f.options,
      mode: "typo",
      queryProcesses: () => {
        assert.fail("invalid mode must be rejected before probing");
      },
    }),
    /launch mode/,
  );
  assert.deepEqual(f.actions, []);
});

test("automatic launch preserves the current canonical budget and discards expired history", async () => {
  const f = fixture();
  f.session.restartTimesMs.unshift(f.nowMs - 1_800_001);
  const prepared = await prepareDevSessionLaunch({
    ...f.options,
    mode: "recovery",
    expectedSupervisorPid: 4242,
  });
  assert.deepEqual(prepared.restartTimesMs, [
    f.nowMs - 20_000,
    f.nowMs - 10_000,
  ]);
  assert.deepEqual(f.actions, []);
});

test("automatic launch reads legacy restart history only when canonical history is absent", async () => {
  const f = fixture();
  delete f.session.restartTimesMs;
  f.session.supervisorRestartTimesMs = [f.nowMs - 10_000];
  const options = {
    ...f.options,
    mode: "recovery",
    expectedSupervisorPid: 4242,
  };
  assert.deepEqual((await prepareDevSessionLaunch(options)).restartTimesMs, [
    f.nowMs - 10_000,
  ]);
  f.session.restartTimesMs = [];
  assert.deepEqual((await prepareDevSessionLaunch(options)).restartTimesMs, []);
});

test("automatic launch cannot restart an intentionally stopping session", async () => {
  const f = fixture({ state: "stopping" });
  await assert.rejects(
    prepareDevSessionLaunch({
      ...f.options,
      mode: "recovery",
      expectedSupervisorPid: 4242,
    }),
  );
  assert.deepEqual(f.actions, []);
});

test("automatic launch cannot claim a missing or newer owner and never terminates one", async () => {
  const f = fixture();
  for (const readSession of [
    () => undefined,
    () => ({ ...f.session, supervisorPid: 9999 }),
  ]) {
    await assert.rejects(
      prepareDevSessionLaunch({
        ...f.options,
        mode: "recovery",
        expectedSupervisorPid: 4242,
        readSession,
        queryProcesses: () => {
          assert.fail("a superseded owner must not reach process probing");
        },
      }),
    );
  }
  assert.deepEqual(f.actions, []);
});

test("automatic launch cannot terminate a healthy owner", async () => {
  const f = fixture();
  await assert.rejects(
    prepareDevSessionLaunch({
      ...f.options,
      mode: "recovery",
      expectedSupervisorPid: 4242,
      queryProcesses: () => [f.identity],
    }),
    /healthy supervisor/,
  );
  assert.deepEqual(f.actions, []);
});

test("failed native identity validation does not mark the session stopping", async () => {
  const f = fixture();
  await assert.rejects(
    prepareDevSessionLaunch({
      ...f.options,
      queryProcesses: () => [f.identity],
      stopOwnedSession: () => {
        throw new Error("retained native handle no longer matches");
      },
    }),
    /retained native handle/,
  );
  assert.deepEqual(f.actions, []);
  assert.equal(f.session.state, "running");
});

test("manual takeover publishes exact handoff ownership before native owner termination", async () => {
  const workerIdentity = {
    Name: "node.exe",
    ProcessId: 4244,
    ParentProcessId: 4242,
    ExecutablePath: process.execPath,
    CreationDate: "2026-10-21T23:59:01.1234567Z",
    CommandLine: 'node "scripts/dev-tauri-delayed.mjs" --ccsm-dev-worker',
  };
  const f = fixture({ workerPid: 4244, workerIdentity });
  let stopped = false;
  await prepareDevSessionLaunch({
    ...f.options,
    queryProcesses: () => (stopped ? [] : [f.identity]),
    stopOwnedSession: ({ handoffIntent, handoffOwner, markStopping }) => {
      assert.equal(handoffIntent, "manual_takeover");
      assert.deepEqual(handoffOwner, {
        supervisorPid: 4242,
        supervisorStartedAtUtc: f.session.supervisorStartedAtUtc,
        workerPid: 4244,
        workerIdentity,
      });
      assert.deepEqual(
        f.actions,
        [],
        "validation precedes all marker mutations",
      );
      markStopping();
      assert.equal(f.actions[0][0], "persist");
      assert.equal(f.actions[0][1].state, "stopping");
      assert.equal(f.actions[0][1].handoffIntent, "manual_takeover");
      assert.deepEqual(f.actions[0][1].handoffOwner, handoffOwner);
      stopped = true;
    },
  });
  assert.equal(stopped, true);
});

test("updated manual takeover finishes app cleanup before stopping its live owner", async () => {
  const f = fixture({ handoffProtocolVersion: 1 });
  const events = [];
  let stopped = false;
  const result = await prepareDevSessionLaunch({
    ...f.options,
    queryProcesses: () => (stopped ? [] : [f.identity]),
    prepareOwnedSession: ({ markStopping }) => {
      events.push("validated-handoff-published");
      markStopping();
    },
    beforeOwnerStop: async (current) => {
      assert.equal(current, f.session);
      assert.equal(stopped, false);
      events.push("worker-ready-and-app-receipt-committed");
    },
    stopOwnedSession: () => {
      events.push("owner-stopped");
      stopped = true;
    },
  });
  assert.equal(result.plannedCleanupComplete, true);
  assert.deepEqual(events, [
    "validated-handoff-published",
    "worker-ready-and-app-receipt-committed",
    "owner-stopped",
  ]);
});

test("missing readiness or failed app cleanup leaves the old owner alive and blocks publication", async () => {
  for (const failure of [
    "missing exact worker acknowledgement",
    "owned listener cleanup failed",
  ]) {
    const f = fixture({ handoffProtocolVersion: 1 });
    let stops = 0;
    await assert.rejects(
      prepareDevSessionLaunch({
        ...f.options,
        queryProcesses: () => [f.identity],
        prepareOwnedSession: ({ markStopping }) => markStopping(),
        beforeOwnerStop: async () => {
          throw new Error(failure);
        },
        stopOwnedSession: () => {
          stops++;
        },
      }),
      new RegExp(failure),
    );
    assert.equal(stops, 0);
    assert.equal(f.actions.length, 1);
    assert.equal(f.actions[0][1].supervisorPid, f.session.supervisorPid);
  }
});

test("lost publication refresh requires running again at the native mutation boundary", async () => {
  const f = fixture({ handoffProtocolVersion: 1 });
  const guards = [];
  let stopped = false;
  await prepareDevSessionLaunch({
    ...f.options,
    queryProcesses: () => (stopped ? [] : [f.identity]),
    prepareOwnedSession: (options) =>
      guards.push(options.requireRunning === true),
    beforeOwnerStop: async (_current, _intent, { refreshHandoff }) =>
      refreshHandoff(),
    stopOwnedSession: () => {
      stopped = true;
    },
  });
  assert.deepEqual(guards, [false, true]);
});

test("old runtimes and automatic recovery never claim a successful planned handoff", async () => {
  const f = fixture();
  let stopped = false;
  const old = await prepareDevSessionLaunch({
    ...f.options,
    queryProcesses: () => (stopped ? [] : [f.identity]),
    prepareOwnedSession: () =>
      assert.fail("old runtime cannot acknowledge handoff"),
    beforeOwnerStop: () =>
      assert.fail("old runtime transition cannot create planned receipts"),
    stopOwnedSession: () => {
      stopped = true;
    },
  });
  assert.equal(old.plannedCleanupComplete, false);
  const recovered = await prepareDevSessionLaunch({
    ...f.options,
    mode: "recovery",
    expectedSupervisorPid: f.session.supervisorPid,
    beforeOwnerStop: () =>
      assert.fail("crash recovery cannot become planned replacement"),
  });
  assert.equal(recovered.plannedCleanupComplete, false);
});

test("an unreadable direct Node child cannot hide the old watchdog", async () => {
  const f = fixture();
  for (const executablePath of [f.options.executable, undefined]) {
    await assert.rejects(
      prepareDevSessionLaunch({
        ...f.options,
        queryProcesses: () => [
          f.identity,
          {
            ProcessId: 4243,
            ParentProcessId: f.identity.ProcessId,
            ExecutablePath: executablePath,
            CommandLine: null,
            CreationDate: f.identity.CreationDate,
          },
        ],
      }),
      /child process ownership is incomplete/,
    );
    assert.deepEqual(f.actions, []);
  }
});

test("lost launch serialization prevents session reads and all mutations", async () => {
  const f = fixture();
  await assert.rejects(
    prepareDevSessionLaunch({
      ...f.options,
      assertLaunchHeld: () => {
        throw new Error("serialization lost");
      },
      readSession: () => {
        assert.fail("lost ownership must be checked first");
      },
    }),
    /serialization lost/,
  );
  assert.deepEqual(f.actions, []);
});

test("loss during native stop prevents publication and subsequent process observations", async () => {
  const f = fixture();
  let held = true;
  let queries = 0;
  await assert.rejects(
    prepareDevSessionLaunch({
      ...f.options,
      assertLaunchHeld: () => {
        if (!held) throw new Error("serialization lost");
      },
      queryProcesses: () => {
        queries++;
        return [f.identity];
      },
      stopOwnedSession: async () => {
        held = false;
      },
    }),
    /serialization lost/,
  );
  assert.equal(queries, 1);
  assert.deepEqual(f.actions, []);
});

test("a marker changed during verification cannot authorize termination", async () => {
  const f = fixture();
  let reads = 0;
  await assert.rejects(
    prepareDevSessionLaunch({
      ...f.options,
      readSession: () =>
        reads++ === 0 ? f.session : { ...f.session, supervisorPid: 9999 },
      queryProcesses: () => [f.identity],
    }),
    /ownership changed/,
  );
  assert.deepEqual(f.actions, []);
});

test(
  "native preparation checks an exact retained FILETIME before mutating its disposable marker",
  { skip: process.platform !== "win32" },
  (context) => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "ccsm-native-owner-ticks-"),
    );
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    const markerPath = path.join(directory, "dev-session.json");
    const identity = JSON.parse(
      runWindowsJsonQuery(
        windowsJsonQueryCommand(`
$h = Get-Process -Id ${process.pid} -ErrorAction Stop
try {
  $null = $h.Handle
  $cim = Get-CimInstance Win32_Process -Filter 'ProcessId=${process.pid}' -ErrorAction Stop
  [pscustomobject]@{ProcessId=$h.Id;ParentProcessId=$cim.ParentProcessId;ExecutablePath=$h.Path;CommandLine=$cim.CommandLine;CreationDate=$cim.CreationDate.ToUniversalTime().ToString('o');ProcessStartedAtTicks=$h.StartTime.ToFileTimeUtc().ToString()} | ConvertTo-Json -Compress
} finally { $h.Dispose() }
`),
        "test exact native owner",
      ),
    );
    const session = {
      supervisorPid: process.pid,
      supervisorStartedAtUtc: identity.CreationDate,
      repoRoot: directory,
      scriptPath: path.join(directory, "fixture.mjs"),
      state: "running",
    };
    const original = JSON.stringify(session);
    writeFileSync(markerPath, original);
    assert.throws(
      () =>
        stopOwnedWindowsDevSession({
          markerPath,
          session,
          supervisor: {
            ...identity,
            ProcessStartedAtTicks: (
              BigInt(identity.ProcessStartedAtTicks) + 1n
            ).toString(),
          },
          watchdogs: [],
          phase: "prepare",
        }),
      /development replacement/,
    );
    assert.equal(readFileSync(markerPath, "utf8"), original);
    assert.deepEqual(
      stopOwnedWindowsDevSession({
        markerPath,
        session,
        supervisor: identity,
        watchdogs: [],
        phase: "prepare",
      }),
      { prepared: true },
    );
    assert.equal(
      JSON.parse(readFileSync(markerPath, "utf8")).state,
      "stopping",
    );
    assert.doesNotThrow(() => process.kill(process.pid, 0));
  },
);
