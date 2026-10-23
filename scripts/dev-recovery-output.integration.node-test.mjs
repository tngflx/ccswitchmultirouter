import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEV_RECOVERY_FLAG } from "./dev-session-launch.mjs";
import { devRecoveryLogPath } from "./dev-recovery-output.mjs";
import { handoffDetachedDevSupervisor } from "./dev-tauri-delayed.mjs";

async function waitUntil(predicate, description, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, description);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

test(
  "real detached watchdog handoff preserves finite replacement output and saved launch settings",
  { timeout: 25_000 },
  async (context) => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "ccsm-real-recovery-output-"),
    );
    const markerPath = path.join(directory, "logs", "dev-session.json");
    const scriptPath = path.join(directory, "replacement.mjs");
    const metadataPath = path.join(directory, "metadata.json");
    const acknowledgementPath = path.join(directory, "acknowledged.json");
    const completedPath = path.join(directory, "completed.json");
    const logPath = devRecoveryLogPath(markerPath);
    let replacementPid;
    context.after(async () => {
      // The fixture has a hard deadline even if a publication assertion fails.
      // Wait for its own exit instead of terminating a PID that could be reused.
      if (replacementPid) {
        await waitUntil(
          () => !processExists(replacementPid),
          "the owned finite replacement must exit without leaving an orphan",
          12_000,
        );
      }
      rmSync(directory, { recursive: true, force: true });
    });
    mkdirSync(path.dirname(markerPath), { recursive: true });
    writeFileSync(
      scriptPath,
      `import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
const hardStop = setTimeout(() => process.exit(3), 10000);
const markerPath = process.env.CCSM_OUTPUT_FIXTURE_MARKER;
const metadataPath = process.env.CCSM_OUTPUT_FIXTURE_METADATA;
const acknowledgementPath = process.env.CCSM_OUTPUT_FIXTURE_ACK;
const completedPath = process.env.CCSM_OUTPUT_FIXTURE_COMPLETED;
const previous = JSON.parse(readFileSync(markerPath, "utf8"));
const startedAt = new Date().toISOString();
writeFileSync(metadataPath, JSON.stringify({
  pid: process.pid,
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  port: process.env.TAURI_DEV_PORT,
  rebuild: process.env.TAURI_DEV_NO_REBUILD,
  baseValue: process.env.CCSM_OUTPUT_FIXTURE_BASE,
  unpersisted: process.env.CCSM_OUTPUT_FIXTURE_UNPERSISTED,
}));
const next = {
  ...previous, supervisorPid: process.pid,
  supervisorExecutablePath: process.execPath,
  supervisorStartedAtUtc: startedAt, startedAtUtc: startedAt, state: "running",
};
writeFileSync(markerPath + ".fixture.tmp", JSON.stringify(next));
renameSync(markerPath + ".fixture.tmp", markerPath);
while (!existsSync(acknowledgementPath)) {
  await new Promise(resolve => setTimeout(resolve, 20));
}
process.stdout.write("real recovered supervisor stdout\\n");
process.stderr.write("real recovered supervisor stderr\\n");
writeFileSync(completedPath, JSON.stringify({ pid: process.pid }));
await new Promise(resolve => setTimeout(resolve, 500));
clearTimeout(hardStop);
`,
    );
    const supervisorPid = 424242;
    const savedArgs = ["--delay", "25000", "saved value with spaces"];
    const oldStartedAt = new Date(Date.now() - 60_000).toISOString();
    const session = {
      schemaVersion: 1,
      supervisorPid,
      supervisorExecutablePath: process.execPath,
      supervisorStartedAtUtc: oldStartedAt,
      startedAtUtc: oldStartedAt,
      repoRoot: directory,
      scriptPath,
      args: savedArgs,
      environment: {
        TAURI_DEV_PORT: "3412",
        TAURI_DEV_NO_REBUILD: "true",
        CCSM_OUTPUT_FIXTURE_UNPERSISTED: "must-not-override-base-environment",
      },
      state: "running",
      restartTimesMs: [],
      roots: [],
    };
    const events = [];
    const result = await handoffDetachedDevSupervisor({
      supervisorPid,
      markerPath,
      session,
      executable: process.execPath,
      scriptPath,
      repoRoot: directory,
      readEnabled: () => true,
      environment: {
        ...process.env,
        CCSM_OUTPUT_FIXTURE_MARKER: markerPath,
        CCSM_OUTPUT_FIXTURE_METADATA: metadataPath,
        CCSM_OUTPUT_FIXTURE_ACK: acknowledgementPath,
        CCSM_OUTPUT_FIXTURE_COMPLETED: completedPath,
        CCSM_OUTPUT_FIXTURE_BASE: "base-value",
        CCSM_OUTPUT_FIXTURE_UNPERSISTED: "retained-base-value",
        TAURI_DEV_PORT: "3410",
        TAURI_DEV_NO_REBUILD: "false",
      },
      writeEvent(event, detail) {
        events.push({ event, detail });
        if (event === "dev-supervisor-restarting") {
          assert.equal(detail.oldPid, supervisorPid);
          assert.equal(detail.outputPath, logPath);
          assert.equal(existsSync(logPath), false, "event precedes spawning");
          const persisted = JSON.parse(readFileSync(markerPath, "utf8"));
          assert.equal(persisted.supervisorPid, supervisorPid);
          assert.equal(persisted.restartTimesMs.length, 1);
          assert.deepEqual(persisted.args, savedArgs);
        }
      },
      async waitForPublication({ expected, readSession, isRunning }) {
        replacementPid = expected.supervisorPid;
        await waitUntil(
          () =>
            existsSync(metadataPath) &&
            readSession().supervisorPid === replacementPid,
          "the real replacement must publish its exact session",
        );
        assert.equal(isRunning(), true);
        assert.equal(processExists(replacementPid), true);
        const published = readSession();
        assert.equal(published.schemaVersion, 1);
        assert.equal(published.state, "running");
        assert.equal(published.supervisorPid, expected.supervisorPid);
        assert.equal(
          published.supervisorExecutablePath,
          expected.supervisorExecutablePath,
        );
        assert.equal(published.repoRoot, expected.repoRoot);
        assert.equal(published.scriptPath, expected.scriptPath);
        assert.ok(Date.parse(published.startedAtUtc) >= expected.launchedAtMs);
        const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
        assert.equal(metadata.pid, replacementPid);
        assert.deepEqual(metadata.argv, [
          DEV_RECOVERY_FLAG,
          String(supervisorPid),
          ...savedArgs,
        ]);
        assert.equal(metadata.cwd, directory);
        assert.equal(metadata.port, "3412");
        assert.equal(metadata.rebuild, "true");
        assert.equal(metadata.baseValue, "base-value");
        assert.equal(metadata.unpersisted, "retained-base-value");
        writeFileSync(
          acknowledgementPath,
          JSON.stringify({ acknowledged: true }),
        );
        await waitUntil(
          () => existsSync(completedPath),
          "the acknowledged replacement must finish writing both streams",
        );
        assert.equal(
          JSON.parse(readFileSync(completedPath, "utf8")).pid,
          replacementPid,
        );
        const output = readFileSync(logPath, "utf8");
        assert.match(output, /real recovered supervisor stdout\n/);
        assert.match(output, /real recovered supervisor stderr\n/);
        assert.equal(output.includes("dev-recovery-launch"), true);
        assert.equal(output.includes("saved value with spaces"), false);
        assert.equal(output.includes("base-value"), false);
      },
    });
    assert.equal(result.restarted, true);
    assert.equal(result.replacementPid, replacementPid);
    assert.deepEqual(
      events.map(({ event }) => event),
      ["dev-supervisor-restarting", "dev-supervisor-restarted"],
    );
    await waitUntil(
      () => !processExists(replacementPid),
      "the real finite replacement must exit cleanly after the handoff",
    );
    assert.equal(processExists(replacementPid), false);
  },
);
