import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  handoffDetachedDevSupervisor,
  runDetachedDevWatchdog,
  windowsProcessStartedAtUtc,
} from "./dev-tauri-delayed.mjs";
import {
  parseWindowsJsonQueryOutput,
  runWindowsJsonQuery,
  windowsJsonQueryCommand,
} from "./windows-json-query.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const scriptPath = path.join(repoRoot, "scripts", "dev-tauri-delayed.mjs");
const devModuleUrl = new URL("./dev-tauri-delayed.mjs", import.meta.url).href;
const queryModuleUrl = new URL("./windows-json-query.mjs", import.meta.url)
  .href;

function queryFixtureProcess(processId) {
  assert.ok(Number.isInteger(processId) && processId > 0);
  const stdout = runWindowsJsonQuery(
    windowsJsonQueryCommand(
      `Get-CimInstance Win32_Process -Filter 'ProcessId = ${processId}' -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,CreationDate | ConvertTo-Json -Compress`,
    ),
    "fixture process",
    { timeoutMs: 5_000 },
  );
  if (!stdout.trim()) return [];
  const parsed = parseWindowsJsonQueryOutput(stdout, "fixture process");
  return (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean);
}

async function stopOwnedFixture(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill();
  await exited;
}

test(
  "detached dev watchdog retries a real failed replacement after its supervisor exits",
  { skip: process.platform !== "win32", timeout: 30_000 },
  async (context) => {
    const deadline = Date.now() + 20_000;
    const fixtureDirectory = await mkdtemp(
      path.join(os.tmpdir(), "ccswitch-dev-handoff-integration-"),
    );
    const markerPath = path.join(fixtureDirectory, "dev-session.json");
    const fixtures = [];
    const events = [];
    const requestedLaunches = [];
    let observedOldSupervisorAlive = false;
    let secondReplacementPublished = false;
    let watcherReturned = false;

    const startFixture = async (source, args = []) => {
      const child = spawn(
        process.execPath,
        ["--input-type=module", "-e", source, ...args],
        { cwd: fixtureDirectory, stdio: "ignore", windowsHide: true },
      );
      fixtures.push(child);
      await once(child, "spawn");
      return child;
    };

    try {
      const oldSupervisor = await startFixture("setInterval(() => {}, 1_000);");
      const [oldIdentity] = queryFixtureProcess(oldSupervisor.pid);
      assert.ok(
        oldIdentity,
        "the owned old supervisor must have a CIM identity",
      );
      const originalArgs = ["--no-rebuild"];
      await writeFile(
        markerPath,
        JSON.stringify({
          schemaVersion: 1,
          supervisorPid: oldSupervisor.pid,
          supervisorExecutablePath: oldIdentity.ExecutablePath,
          supervisorStartedAtUtc: windowsProcessStartedAtUtc(oldIdentity),
          repoRoot,
          scriptPath,
          args: originalArgs,
          environment: {},
          startedAtUtc: new Date().toISOString(),
          restartTimesMs: [],
          state: "running",
          roots: [],
        }),
      );

      const readSession = () => JSON.parse(readFileSync(markerPath, "utf8"));

      const publishingFixture = `
        import { readFileSync, writeFileSync, renameSync } from "node:fs";
        const [markerPath, devModuleUrl, queryModuleUrl] = process.argv.slice(1);
        const { windowsProcessStartedAtUtc } = await import(devModuleUrl);
        const { runWindowsJsonQuery, windowsJsonQueryCommand } = await import(queryModuleUrl);
        const output = runWindowsJsonQuery(windowsJsonQueryCommand(
          "Get-CimInstance Win32_Process -Filter 'ProcessId = " + process.pid + "' -ErrorAction Stop | Select-Object ProcessId,ExecutablePath,CreationDate | ConvertTo-Json -Compress"
        ), "fixture self", { timeoutMs: 5_000 });
        const identity = JSON.parse(output);
        const previous = JSON.parse(readFileSync(markerPath, "utf8"));
        const session = {
          ...previous,
          supervisorPid: process.pid,
          supervisorExecutablePath: identity.ExecutablePath,
          supervisorStartedAtUtc: windowsProcessStartedAtUtc(identity),
          startedAtUtc: new Date().toISOString(),
          state: "running"
        };
        const temporary = markerPath + "." + process.pid + ".tmp";
        writeFileSync(temporary, JSON.stringify(session));
        renameSync(temporary, markerPath);
        setInterval(() => {}, 1_000);
      `;

      await runDetachedDevWatchdog(oldSupervisor.pid, {
        markerPath,
        readSession,
        queryProcesses: (pid) => {
          const processes = queryFixtureProcess(pid);
          if (pid === oldSupervisor.pid && processes.length > 0) {
            observedOldSupervisorAlive = true;
          }
          return processes;
        },
        wait: async () => {
          assert.equal(context.signal.aborted, false, "test must not time out");
          assert.ok(
            Date.now() < deadline,
            "the isolated handoff must finish promptly",
          );
          if (observedOldSupervisorAlive) await stopOwnedFixture(oldSupervisor);
          await new Promise((resolve) => setTimeout(resolve, 100));
        },
        handoff: (options) =>
          handoffDetachedDevSupervisor({
            ...options,
            readEnabled: () => true,
            spawnReplacement: async (specification) => {
              assert.equal(specification.executable, process.execPath);
              assert.deepEqual(specification.args, [
                scriptPath,
                ...originalArgs,
              ]);
              assert.equal(specification.options.cwd, repoRoot);
              assert.equal(specification.options.windowsHide, true);
              assert.equal(specification.options.detached, true);
              assert.equal(specification.options.stdio, "ignore");
              requestedLaunches.push(specification);
              assert.ok(
                requestedLaunches.length <= 2,
                "recovery must be bounded",
              );
              if (requestedLaunches.length === 1) {
                return startFixture("process.exitCode = 1;");
              }
              return startFixture(publishingFixture, [
                markerPath,
                devModuleUrl,
                queryModuleUrl,
              ]);
            },
            writeEvent: (event, detail) => {
              if (event === "dev-supervisor-restarted") {
                const current = readSession();
                assert.equal(current.supervisorPid, detail.newPid);
                const [identity] = queryFixtureProcess(detail.newPid);
                assert.ok(identity);
                assert.equal(
                  current.supervisorStartedAtUtc,
                  windowsProcessStartedAtUtc(identity),
                );
                secondReplacementPublished = true;
              }
              events.push({ event, detail });
            },
          }),
        writeEvent: (event, detail) => events.push({ event, detail }),
      });
      watcherReturned = true;

      const current = JSON.parse(await readFile(markerPath, "utf8"));
      assert.equal(observedOldSupervisorAlive, true);
      assert.equal(requestedLaunches.length, 2);
      assert.equal(fixtures[1].exitCode, 1);
      assert.equal(current.supervisorPid, fixtures[2].pid);
      assert.equal(current.restartTimesMs.length, 2);
      assert.ok(current.restartTimesMs.every(Number.isSafeInteger));
      assert.equal(secondReplacementPublished, true);
      assert.equal(watcherReturned, true);
      assert.equal(
        events.filter(
          ({ event }) => event === "dev-supervisor-publication-failed",
        ).length,
        1,
      );
      assert.equal(
        events.filter(({ event }) => event === "dev-supervisor-restarted")
          .length,
        1,
      );
      assert.equal(
        events.filter(({ event }) => event === "dev-watchdog-iteration-failed")
          .length,
        0,
      );
    } finally {
      await Promise.allSettled(fixtures.map(stopOwnedFixture));
      assert.equal(path.dirname(fixtureDirectory), os.tmpdir());
      assert.ok(
        path
          .basename(fixtureDirectory)
          .startsWith("ccswitch-dev-handoff-integration-"),
      );
      await rm(fixtureDirectory, { recursive: true, force: true });
    }
  },
);
