import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseWindowsJsonQueryOutput,
  runWindowsJsonQuery,
  windowsJsonQueryCommand,
} from "./windows-json-query.mjs";
import { windowsProcessStartedAtUtc } from "./dev-tauri-delayed.mjs";

const fixtureSource = `
  import { spawn } from "node:child_process";
  import { existsSync, writeFileSync } from "node:fs";
  import path from "node:path";
  import { fileURLToPath } from "node:url";
  const scriptPath = fileURLToPath(import.meta.url);
  const directory = path.dirname(scriptPath);
  if (process.argv[2] === "--ccsm-dev-watchdog") {
    const supervisorPid = Number(process.argv[3]);
    setInterval(() => {
      if (existsSync(path.join(directory, process.pid + ".cleanup"))) process.exit(0);
      try { process.kill(supervisorPid, 0); } catch {
        writeFileSync(path.join(directory, supervisorPid + ".resurrected"), "old watcher survived supervisor");
        process.exit(0);
      }
    }, 50);
  } else {
    const watcher = spawn(process.execPath, [scriptPath, "--ccsm-dev-watchdog", String(process.pid)], {
      cwd: directory, stdio: "ignore", detached: true, windowsHide: true
    });
    watcher.once("spawn", () => process.send?.({ watcherPid: watcher.pid }));
    process.on("message", (message) => {
      if (message?.type === "cleanup") {
        if (watcher.exitCode === null && watcher.signalCode === null) watcher.kill();
        process.exit(0);
      }
    });
    setInterval(() => {}, 1_000);
  }
`;

function queryIdentities(processIds) {
  assert.ok(processIds.every((pid) => Number.isInteger(pid) && pid > 0));
  if (processIds.length === 0) return [];
  const filter = processIds.map((pid) => `ProcessId = ${pid}`).join(" OR ");
  const stdout = runWindowsJsonQuery(
    windowsJsonQueryCommand(
      `Get-CimInstance Win32_Process -Filter '${filter}' -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,CreationDate | ConvertTo-Json -Compress`,
    ),
    "owned takeover fixture",
    { timeoutMs: 5_000 },
  );
  if (!stdout.trim()) return [];
  const parsed = parseWindowsJsonQueryOutput(stdout, "owned takeover fixture");
  return (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean);
}

async function createFixtureScope() {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "ccswitch-dev-takeover-integration-"),
  );
  const scriptPath = path.join(directory, "fixture.mjs");
  const markerPath = path.join(directory, "dev-session.json");
  await writeFile(scriptPath, fixtureSource);
  const fixtures = [];
  const readSession = () =>
    existsSync(markerPath)
      ? JSON.parse(readFileSync(markerPath, "utf8"))
      : undefined;
  const queryProcesses = (pid) =>
    queryIdentities(
      pid === undefined
        ? fixtures.flatMap(({ child, watcherPid }) => [child.pid, watcherPid])
        : [pid],
    );
  const start = async () => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: directory,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    });
    const message = once(child, "message");
    await once(child, "spawn");
    const [{ watcherPid }] = await message;
    const fixture = { child, watcherPid };
    fixtures.push(fixture);
    const [identity] = queryIdentities([child.pid]);
    assert.ok(identity);
    fixture.session = {
      schemaVersion: 1,
      supervisorPid: child.pid,
      supervisorExecutablePath: identity.ExecutablePath,
      supervisorStartedAtUtc: windowsProcessStartedAtUtc(identity),
      repoRoot: directory,
      scriptPath,
      args: [],
      environment: {},
      startedAtUtc: new Date().toISOString(),
      restartTimesMs: [],
      roots: [],
      state: "running",
    };
    return fixture;
  };
  const publish = (fixture) => {
    writeFileSync(markerPath, JSON.stringify(fixture.session));
    writeFileSync(`${markerPath}.lock`, JSON.stringify(fixture.session));
  };
  const cleanup = async () => {
    for (const { child, watcherPid } of fixtures) {
      writeFileSync(path.join(directory, `${watcherPid}.cleanup`), "cleanup");
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(
      path.basename(directory).startsWith("ccswitch-dev-takeover-integration-"),
    );
    await rm(directory, { recursive: true, force: true });
  };
  return {
    directory,
    scriptPath,
    markerPath,
    fixtures,
    readSession,
    queryProcesses,
    start,
    publish,
    cleanup,
  };
}

// Real CIM and PowerShell startup run several times per replacement; concurrent
// build/test load can legitimately take longer than an individual probe timeout.
const windowsOnly = { skip: process.platform !== "win32", timeout: 60_000 };

test(
  "a dead launch mutex keeper invalidates ownership and releases the next launcher",
  windowsOnly,
  async () => {
    const { acquireDevSessionLaunchLock, withDevSessionLaunchLock } =
      await import("./dev-session-launch.mjs");
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "ccswitch-dev-takeover-lock-"),
    );
    const markerPath = path.join(directory, "dev-session.json");
    let keeper;
    let release;
    try {
      release = await acquireDevSessionLaunchLock({
        markerPath,
        spawnProcess: (...arguments_) => {
          keeper = spawn(...arguments_);
          return keeper;
        },
      });
      release.assertHeld();
      const ended = once(keeper, "close");
      keeper.kill();
      await ended;
      assert.throws(() => release.assertHeld(), /ownership was lost/);
      let nextEntered = false;
      await withDevSessionLaunchLock({ markerPath }, (assertHeld) => {
        assertHeld();
        nextEntered = true;
      });
      assert.equal(nextEntered, true);
    } finally {
      if (release) await release();
      if (keeper && keeper.exitCode === null && keeper.signalCode === null) {
        const ended = once(keeper, "close");
        keeper.kill();
        await ended;
      }
      assert.equal(path.dirname(directory), os.tmpdir());
      assert.ok(
        path.basename(directory).startsWith("ccswitch-dev-takeover-lock-"),
      );
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "explicit dev launch replaces the owned session and stops its watcher first",
  windowsOnly,
  async () => {
    const { prepareDevSessionLaunch, withDevSessionLaunchLock } =
      await import("./dev-session-launch.mjs");
    const scope = await createFixtureScope();
    try {
      const first = await scope.start();
      // Keep a deterministic trailing-zero timestamp to prove the native
      // handoff preserves canonical strings, not only DateTime equivalence.
      first.session.supervisorStartedAtUtc =
        first.session.supervisorStartedAtUtc.replace(/(\.\d{3})Z$/, "$10000Z");
      scope.publish(first);
      let second;
      await withDevSessionLaunchLock(
        { markerPath: scope.markerPath },
        async () => {
          const prepared = await prepareDevSessionLaunch({
            markerPath: scope.markerPath,
            repoRoot: scope.directory,
            scriptPath: scope.scriptPath,
            executable: process.execPath,
            mode: "explicit",
            queryProcesses: scope.queryProcesses,
          });
          assert.equal(prepared.previous.supervisorPid, first.child.pid);
          assert.deepEqual(prepared.restartTimesMs, []);
          const handoff = scope.readSession();
          assert.equal(handoff.state, "stopping");
          assert.equal(handoff.handoffIntent, "manual_takeover");
          assert.equal(handoff.handoffOwner.supervisorPid, first.child.pid);
          assert.equal(
            handoff.handoffOwner.supervisorStartedAtUtc,
            first.session.supervisorStartedAtUtc,
          );
          second = await scope.start();
          scope.publish(second);
        },
      );
      const remaining = scope.queryProcesses();
      assert.equal(
        remaining.some(({ ProcessId }) => ProcessId === first.child.pid),
        false,
      );
      assert.equal(
        remaining.some(({ ProcessId }) => ProcessId === first.watcherPid),
        false,
      );
      assert.equal(scope.readSession().supervisorPid, second.child.pid);
      assert.equal(
        existsSync(
          path.join(scope.directory, `${first.child.pid}.resurrected`),
        ),
        false,
      );
      assert.equal(
        remaining.filter(({ ProcessId }) => ProcessId === second.child.pid)
          .length,
        1,
      );
    } finally {
      await scope.cleanup();
    }
  },
);

test(
  "automatic recovery cannot replace a healthy explicit dev owner",
  windowsOnly,
  async () => {
    const { prepareDevSessionLaunch, withDevSessionLaunchLock } =
      await import("./dev-session-launch.mjs");
    const scope = await createFixtureScope();
    try {
      const owner = await scope.start();
      scope.publish(owner);
      let stops = 0;
      await assert.rejects(
        withDevSessionLaunchLock({ markerPath: scope.markerPath }, () =>
          prepareDevSessionLaunch({
            markerPath: scope.markerPath,
            repoRoot: scope.directory,
            scriptPath: scope.scriptPath,
            executable: process.execPath,
            mode: "recovery",
            expectedSupervisorPid: owner.child.pid,
            queryProcesses: scope.queryProcesses,
            stopOwnedSession: () => {
              stops++;
            },
          }),
        ),
      );
      assert.equal(stops, 0);
      assert.equal(scope.readSession().supervisorPid, owner.child.pid);
      assert.equal(scope.queryProcesses(owner.child.pid).length, 1);
    } finally {
      await scope.cleanup();
    }
  },
);

test(
  "concurrent explicit dev launches serialize and the last claimant owns the session",
  windowsOnly,
  async () => {
    const { prepareDevSessionLaunch, withDevSessionLaunchLock } =
      await import("./dev-session-launch.mjs");
    const scope = await createFixtureScope();
    try {
      const initial = await scope.start();
      scope.publish(initial);
      const actions = [];
      const winners = [];
      const launch = (name) =>
        withDevSessionLaunchLock({ markerPath: scope.markerPath }, async () => {
          actions.push(`enter:${name}`);
          await prepareDevSessionLaunch({
            markerPath: scope.markerPath,
            repoRoot: scope.directory,
            scriptPath: scope.scriptPath,
            executable: process.execPath,
            mode: "explicit",
            queryProcesses: scope.queryProcesses,
          });
          const candidate = await scope.start();
          scope.publish(candidate);
          winners.push(candidate);
          await new Promise((resolve) => setTimeout(resolve, 100));
          actions.push(`exit:${name}`);
        });
      const launches = await Promise.allSettled([launch("one"), launch("two")]);
      for (const launch of launches) {
        if (launch.status === "rejected") throw launch.reason;
      }
      assert.equal(actions.length, 4);
      assert.ok(actions[0].startsWith("enter:"));
      assert.equal(actions[1], actions[0].replace("enter:", "exit:"));
      assert.ok(actions[2].startsWith("enter:"));
      assert.equal(actions[3], actions[2].replace("enter:", "exit:"));
      assert.notEqual(actions[0], actions[2]);
      const remaining = scope.queryProcesses();
      assert.equal(scope.readSession().supervisorPid, winners.at(-1).child.pid);
      assert.equal(
        remaining.filter(({ ProcessId }) =>
          scope.fixtures.some(({ child }) => child.pid === ProcessId),
        ).length,
        1,
      );
      assert.equal(
        remaining.filter(({ ProcessId }) =>
          scope.fixtures.some(({ watcherPid }) => watcherPid === ProcessId),
        ).length,
        1,
      );
    } finally {
      await scope.cleanup();
    }
  },
);

test(
  "foreign identity, reused PID metadata, and failed probes cannot kill a fixture",
  windowsOnly,
  async () => {
    const { prepareDevSessionLaunch, withDevSessionLaunchLock } =
      await import("./dev-session-launch.mjs");
    const scope = await createFixtureScope();
    try {
      const owner = await scope.start();
      for (const kind of ["foreign", "reused", "probe-failure"]) {
        const session = structuredClone(owner.session);
        if (kind === "foreign")
          session.scriptPath = path.join(scope.directory, "foreign.mjs");
        if (kind === "reused")
          session.supervisorStartedAtUtc = new Date(
            Date.parse(session.supervisorStartedAtUtc) - 1,
          ).toISOString();
        writeFileSync(scope.markerPath, JSON.stringify(session));
        writeFileSync(`${scope.markerPath}.lock`, JSON.stringify(session));
        let stops = 0;
        await assert.rejects(
          withDevSessionLaunchLock({ markerPath: scope.markerPath }, () =>
            prepareDevSessionLaunch({
              markerPath: scope.markerPath,
              repoRoot: scope.directory,
              scriptPath: scope.scriptPath,
              executable: process.execPath,
              mode: "explicit",
              queryProcesses:
                kind === "probe-failure"
                  ? () => {
                      throw new Error("isolated probe failure");
                    }
                  : scope.queryProcesses,
              stopOwnedSession: () => {
                stops++;
              },
            }),
          ),
        );
        assert.equal(
          stops,
          0,
          `${kind} must not reach the termination boundary`,
        );
        assert.equal(scope.queryProcesses(owner.child.pid).length, 1);
      }
    } finally {
      await scope.cleanup();
    }
  },
);
