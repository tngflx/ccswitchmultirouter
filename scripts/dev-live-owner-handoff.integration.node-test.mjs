import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  commitPlannedDevExit,
  stopPlannedWindowsApp,
} from "./dev-app-exit.mjs";
import {
  waitForManualDevHandoffReady,
  windowsProcessStartedAtUtc,
} from "./dev-tauri-delayed.mjs";
import {
  prepareDevSessionLaunch,
  stopOwnedWindowsDevSession,
  withDevSessionLaunchLock,
} from "./dev-session-launch.mjs";
import {
  runWindowsJsonQuery,
  windowsJsonQueryCommand,
} from "./windows-json-query.mjs";

const controllerUrl = new URL("./dev-tauri-delayed.mjs", import.meta.url).href;

const fixtureSource = `
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDevSupervisorHandoff, retireDevWorkerForManualHandoff } from ${JSON.stringify(controllerUrl)};
const scriptPath = fileURLToPath(import.meta.url);
const directory = path.dirname(scriptPath);
const markerPath = path.join(directory, "dev-session.json");
const timelinePath = path.join(directory, "timeline.jsonl");
const record = (event) => appendFileSync(timelinePath, JSON.stringify({ event, pid: process.pid }) + "\\n");
const readSession = () => JSON.parse(readFileSync(markerPath, "utf8"));
const role = process.argv[2];
setInterval(() => {}, 1_000);
if (role === "--ccsm-dev-watchdog") {
  setInterval(() => {
    try {
      if (readSession().state === "stopping") {
        record("watchdog-retired-on-stopping");
        process.exit(0);
      }
    } catch {}
  }, 25);
} else if (role === "--child") {
  // The app depends on this child, reproducing WebView-style lifetime coupling.
} else if (role === "--app") {
  const child = spawn(process.execPath, [scriptPath, "--child"], { stdio: "ignore", windowsHide: true });
  child.once("spawn", () => process.send({ type: "topology", childPid: child.pid }));
  child.once("exit", () => process.exit(0));
} else if (role === "--worker") {
  let retired = false;
  let context;
  const retire = () => retireDevWorkerForManualHandoff({
    readSession,
    context,
    isRetired: () => retired,
    retireMonitors: () => { retired = true; record("worker-monitors-retired"); },
    acknowledge: (message) => {
      record("worker-ready-sent");
      process.send(message);
    },
  });
  const app = spawn(process.execPath, [scriptPath, "--app"], {
    stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
  });
  app.on("message", (message) => {
    if (message.type === "topology") process.send({ ...message, appPid: app.pid });
  });
  app.once("exit", () => {
    record(retired ? "retired-worker-observed-app-exit" : "unexpected-worker-app-cleanup");
    if (!retired) process.exit(1);
  });
  process.on("message", (message) => {
    if (message.type === "arm") { context = message.context; process.send({ type: "worker-armed" }); }
    if (message.type === "dev-handoff" && context) retire();
  });
} else {
  let session;
  let manual = false;
  let handoff;
  const watchdog = spawn(process.execPath, [scriptPath, "--ccsm-dev-watchdog", String(process.pid)], {
    stdio: "ignore", detached: true, windowsHide: true,
  });
  watchdog.unref();
  const worker = spawn(process.execPath, [scriptPath, "--worker"], {
    stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
  });
  const persistSession = (value) => {
    const temporary = markerPath + ".supervisor.tmp";
    writeFileSync(temporary, JSON.stringify(value));
    renameSync(temporary, markerPath);
  };
  worker.on("message", (message) => {
    if (handoff?.acknowledge(worker, message)) record("supervisor-ready-persisted");
    if (message.type === "topology") process.send({ ...message, workerPid: worker.pid, watchdogPid: watchdog.pid });
    if (message.type === "worker-armed") process.send(message);
  });
  worker.once("exit", () => {
    record(manual ? "supervisor-parked-after-worker-exit" : "unexpected-supervisor-worker-cleanup");
    if (!manual) process.exit(1);
  });
  process.on("message", (message) => {
    if (message.type !== "arm") return;
    session = message.session;
    handoff = createDevSupervisorHandoff({
      getWorker: () => worker,
      getContext: () => ({ ...session, workerIdentity: session.workerIdentity }),
      readSession,
      persistSession,
      onRequested: () => { manual = true; },
    });
    worker.send({ type: "arm", context: {
      workerPid: worker.pid, workerIdentity: session.workerIdentity, supervisorPid: process.pid,
    } });
  });
  setInterval(() => handoff?.request(), 50);
}
`;

function waitForMessage(child, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("message", receive);
      reject(new Error(`Timed out waiting for fixture ${type}.`));
    }, 30_000);
    const receive = (message) => {
      if (message?.type !== type) return;
      clearTimeout(timer);
      child.off("message", receive);
      resolve(message);
    };
    child.on("message", receive);
  });
}

function queryIdentities(pids) {
  assert.ok(pids.every((pid) => Number.isSafeInteger(pid) && pid > 0));
  const filter = pids.map((pid) => `ProcessId=${pid}`).join(" OR ");
  const raw = runWindowsJsonQuery(
    windowsJsonQueryCommand(`
$ErrorActionPreference = 'Stop'
$result = @(Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object {
  $item = $_
  $handle = Get-Process -Id $item.ProcessId -ErrorAction Stop
  try {
    [pscustomobject]@{
      ProcessId=[int]$item.ProcessId; ParentProcessId=[int]$item.ParentProcessId;
      Name=$item.Name; ExecutablePath=$item.ExecutablePath; CommandLine=$item.CommandLine;
      CreationDate=$item.CreationDate.ToUniversalTime().ToString('o');
      ticks=$handle.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()
    }
  } finally { $handle.Dispose() }
})
ConvertTo-Json -InputObject $result -Compress
`),
    "live-owner fixture identity",
    { timeoutMs: 15_000 },
  );
  return JSON.parse(raw);
}

async function waitForTimelineEvent(timelinePath, expected) {
  const deadline = Date.now() + 5_000;
  while (true) {
    const events = existsSync(timelinePath)
      ? readFileSync(timelinePath, "utf8")
          .trim()
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line).event)
      : [];
    if (events.includes(expected)) return;
    if (Date.now() >= deadline) {
      throw new Error(`Fixture lifecycle event was not observed: ${expected}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForFixtureProcessExit(pid) {
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    if (Date.now() >= deadline)
      throw new Error("An owned fixture process did not exit.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test(
  "native live-owner handoff commits app receipt before ancestor stop",
  { skip: process.platform !== "win32", timeout: 120_000 },
  async () => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "ccswitch-live-owner-handoff-"),
    );
    const scriptPath = path.join(directory, "fixture.mjs");
    const markerPath = path.join(directory, "dev-session.json");
    const appMarkerPath = path.join(directory, "app-run-marker.json");
    const journalPath = path.join(directory, "app-exit-events.jsonl");
    const timelinePath = path.join(directory, "timeline.jsonl");
    writeFileSync(scriptPath, fixtureSource);
    const supervisor = spawn(process.execPath, [scriptPath], {
      cwd: directory,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    });
    const topologyPromise = waitForMessage(supervisor, "topology");
    let topology;
    try {
      topology = await topologyPromise;
      const pids = [
        supervisor.pid,
        topology.watchdogPid,
        topology.workerPid,
        topology.appPid,
        topology.childPid,
      ];
      const identities = queryIdentities(pids);
      const identity = (pid) =>
        identities.find((entry) => entry.ProcessId === pid);
      assert.equal(identities.length, 5);
      assert.equal(
        identity(topology.watchdogPid).ParentProcessId,
        supervisor.pid,
      );
      assert.equal(
        identity(topology.workerPid).ParentProcessId,
        supervisor.pid,
      );
      assert.equal(
        identity(topology.appPid).ParentProcessId,
        topology.workerPid,
      );
      assert.equal(
        identity(topology.childPid).ParentProcessId,
        topology.appPid,
      );
      const session = {
        schemaVersion: 1,
        handoffProtocolVersion: 1,
        supervisorPid: supervisor.pid,
        supervisorExecutablePath: process.execPath,
        supervisorStartedAtUtc: windowsProcessStartedAtUtc(
          identity(supervisor.pid),
        ),
        repoRoot: directory,
        scriptPath,
        args: [],
        environment: {},
        startedAtUtc: new Date().toISOString(),
        restartTimesMs: [],
        state: "running",
        workerPid: topology.workerPid,
        workerIdentity: identity(topology.workerPid),
        roots: [],
      };
      writeFileSync(markerPath, JSON.stringify(session));
      const appMarkerText = JSON.stringify({
        startedAt: "2026-10-22 12:00:00.000",
        pid: topology.appPid,
        executablePath: identity(topology.appPid).ExecutablePath,
        processStartedAtTicks: identity(topology.appPid).ticks,
        configScope: "isolated-live-owner-fixture",
        version: "fixture",
        os: "windows",
        arch: "x86_64",
      });
      writeFileSync(appMarkerPath, appMarkerText);
      const armed = waitForMessage(supervisor, "worker-armed");
      supervisor.send({ type: "arm", session });
      await armed;
      const readSession = () => JSON.parse(readFileSync(markerPath, "utf8"));
      let receiptCommittedWhileOwnerAlive = false;
      await withDevSessionLaunchLock(
        { markerPath },
        async (assertLaunchHeld) => {
          const prepared = await prepareDevSessionLaunch({
            markerPath,
            repoRoot: directory,
            scriptPath,
            executable: process.execPath,
            mode: "explicit",
            queryProcesses: () =>
              queryIdentities([supervisor.pid, topology.watchdogPid]),
            assertLaunchHeld,
            beforeOwnerStop: async (current) => {
              const ready = await waitForManualDevHandoffReady({
                expected: current,
                readSession,
                timeoutMs: 15_000,
              });
              assert.equal(ready.handoffPhase, "worker_ready");
              await waitForTimelineEvent(
                timelinePath,
                "watchdog-retired-on-stopping",
              );
              await waitForFixtureProcessExit(topology.watchdogPid);
              assert.throws(
                () => process.kill(topology.watchdogPid, 0),
                "the owned detached watchdog can retire during the prepared handoff",
              );
              assert.doesNotThrow(() => process.kill(supervisor.pid, 0));
              const readyMarkerText = readFileSync(markerPath, "utf8");
              assert.throws(
                () =>
                  stopOwnedWindowsDevSession({
                    markerPath,
                    session: current,
                    supervisor: identity(supervisor.pid),
                    watchdogs: [identity(topology.watchdogPid)],
                    handoffIntent: "manual_takeover",
                    handoffOwner: ready.handoffOwner,
                    phase: "prepare",
                    requireRunning: true,
                  }),
                /development replacement/,
                "a refresh must reject a canonical stop at the native mutation boundary",
              );
              assert.equal(
                readFileSync(markerPath, "utf8"),
                readyMarkerText,
                "a rejected refresh must leave the exact canonical marker unchanged",
              );
              assert.doesNotThrow(() => process.kill(supervisor.pid, 0));
              assert.doesNotThrow(() => process.kill(topology.appPid, 0));
              const proof = stopPlannedWindowsApp(identity(topology.appPid), {
                markerPath: appMarkerPath,
                reason: "development_manual_restart",
              });
              assert.equal(proof.terminated, true);
              assert.throws(() => process.kill(topology.appPid, 0));
              assert.throws(() => process.kill(topology.childPid, 0));
              assert.doesNotThrow(() => process.kill(supervisor.pid, 0));
              assert.equal(commitPlannedDevExit(proof), true);
              receiptCommittedWhileOwnerAlive = true;
              assert.equal(readFileSync(appMarkerPath, "utf8"), appMarkerText);
              process.kill(topology.workerPid);
              await waitForTimelineEvent(
                timelinePath,
                "supervisor-parked-after-worker-exit",
              );
              assert.doesNotThrow(
                () => process.kill(supervisor.pid, 0),
                "the acknowledged supervisor must park after its worker exits",
              );
            },
          });
          assert.equal(prepared.plannedCleanupComplete, true);
        },
      );
      assert.equal(receiptCommittedWhileOwnerAlive, true);
      assert.throws(() => process.kill(supervisor.pid, 0));
      const events = readFileSync(journalPath, "utf8")
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line));
      assert.equal(events.length, 1);
      assert.equal(events[0].kind, "planned_restart");
      assert.equal(events[0].pid, topology.appPid);
      const timeline = readFileSync(timelinePath, "utf8")
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line).event);
      assert.ok(timeline.indexOf("worker-monitors-retired") >= 0);
      assert.ok(
        timeline.indexOf("worker-monitors-retired") <
          timeline.indexOf("worker-ready-sent"),
      );
      assert.ok(timeline.includes("supervisor-ready-persisted"));
      assert.ok(timeline.includes("supervisor-parked-after-worker-exit"));
      assert.ok(!timeline.some((event) => event.startsWith("unexpected-")));
    } finally {
      // This is an isolated fixture marker. Let its detached watcher retire
      // even if an earlier assertion prevented native preparation.
      writeFileSync(markerPath, JSON.stringify({ state: "stopping" }));
      if (supervisor.exitCode === null && supervisor.signalCode === null) {
        const exited = once(supervisor, "exit");
        supervisor.kill();
        await exited;
      }
      if (topology?.watchdogPid)
        await waitForFixtureProcessExit(topology.watchdogPid);
      assert.equal(path.dirname(directory), os.tmpdir());
      assert.ok(
        path.basename(directory).startsWith("ccswitch-live-owner-handoff-"),
      );
      if (existsSync(directory))
        rmSync(directory, { recursive: true, force: true });
    }
  },
);
