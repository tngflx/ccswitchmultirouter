import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendBoundedDevLog,
  DEV_RECOVERY_LOG_MAX_BYTES,
  RECOVERY_LOG_ENV,
  RECOVERY_PRELOAD_OPTION,
  spawnDevRecoveryProcess,
} from "./dev-recovery-output.mjs";

const helperUrl = new URL("./dev-recovery-output.mjs", import.meta.url).href;

function fixture(context, { removeDirectory = rmSync } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ccsm-dev-output-"));
  const cleanupWaiters = [];
  context.after(async () => {
    for (const waiter of cleanupWaiters) await waiter();
    // On Windows, kernel/AV handles can briefly outlive process termination.
    // Retry only bounded removal of this fixture's exact temporary directory;
    // never replace the owned-exit waiter or suppress a persistent failure.
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.equal(path.basename(directory).startsWith("ccsm-dev-output-"), true);
    removeDirectory(directory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  });
  return {
    directory,
    markerPath: path.join(directory, "logs", "dev-session.json"),
    waitForCleanup: (waiter) => cleanupWaiters.push(waiter),
  };
}

test("fixture cleanup awaits owned exits and bounds transient Windows handle-release retries", async () => {
  let after;
  const events = [];
  const f = fixture(
    {
      after: (action) => {
        after = action;
      },
    },
    {
      removeDirectory(directory, options) {
        events.push("remove");
        assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
        assert.equal(
          path.basename(directory).startsWith("ccsm-dev-output-"),
          true,
        );
        assert.deepEqual(options, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 50,
        });
        rmSync(directory, options);
      },
    },
  );
  f.waitForCleanup(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    events.push("owned-exit");
  });
  await after();
  assert.deepEqual(events, ["owned-exit", "remove"]);
  assert.equal(existsSync(f.directory), false);
});

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

function specification(markerPath) {
  return {
    executable: process.execPath,
    args: ["fixture.js", "--ccsm-dev-recover", "4241", "value with spaces"],
    markerPath,
    options: {
      cwd: path.dirname(markerPath),
      env: { PATH: "fixture-path", FIXTURE_SECRET: "redacted-fixture" },
      windowsVerbatimArguments: false,
      shell: false,
      stdio: "ignore",
      detached: false,
      windowsHide: false,
    },
  };
}

test("headless recovery installs the bounded writer without changing its identity command line", async (context) => {
  const f = fixture(context);
  const spec = specification(f.markerPath);
  let observed;
  const child = fakeChild();
  const launching = spawnDevRecoveryProcess(spec, {
    spawnProcess(executable, args, options) {
      observed = { executable, args, options };
      return child;
    },
  });
  let resolved = false;
  launching.then(() => {
    resolved = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, false, "launch success requires the spawn event");
  child.emit("spawn");
  const result = await launching;
  assert.equal(result.child, child);
  assert.deepEqual(result.output, {
    mode: "log",
    logPath: path.join(path.dirname(f.markerPath), "dev-recovery.log"),
  });
  assert.equal(observed.executable, spec.executable);
  assert.deepEqual(observed.args, spec.args);
  assert.equal(observed.options.cwd, spec.options.cwd);
  assert.deepEqual(observed.options.env, {
    ...spec.options.env,
    NODE_OPTIONS: RECOVERY_PRELOAD_OPTION,
    [RECOVERY_LOG_ENV]: result.output.logPath,
  });
  assert.equal(spec.options.env[RECOVERY_LOG_ENV], undefined);
  assert.equal(observed.options.shell, false);
  assert.equal(observed.options.windowsVerbatimArguments, false);
  assert.equal(observed.options.detached, true);
  assert.equal(observed.options.windowsHide, true);
  assert.deepEqual(observed.options.stdio, ["ignore", "ignore", "ignore"]);
  const output = readFileSync(result.output.logPath, "utf8");
  const [launchLine] = output.split("\n");
  const launch = JSON.parse(launchLine);
  assert.equal(launch.event, "dev-recovery-launch");
  assert.equal(launch.pid, process.pid);
  assert.equal(Number.isFinite(Date.parse(launch.timestamp)), true);
  assert.equal(output.includes("redacted-fixture"), false);
  assert.equal(output.includes("value with spaces"), false);
});

test("subsequent recovery launches append to the same configured persistent log", async (context) => {
  const f = fixture(context);
  for (let generation = 1; generation <= 2; generation++) {
    const child = fakeChild();
    const result = await spawnDevRecoveryProcess(specification(f.markerPath), {
      spawnProcess(_executable, _args, options) {
        assert.deepEqual(options.stdio, ["ignore", "ignore", "ignore"]);
        assert.equal(options.detached, true);
        assert.equal(options.windowsHide, true);
        queueMicrotask(() => child.emit("spawn"));
        return child;
      },
    });
    assert.equal(result.output.mode, "log");
  }
  const records = readFileSync(
    path.join(path.dirname(f.markerPath), "dev-recovery.log"),
    "utf8",
  )
    .trim()
    .split("\n");
  assert.equal(records.length, 2, "every launch appends to existing output");
  assert.ok(
    records.every((line) => JSON.parse(line).event === "dev-recovery-launch"),
  );
});

test("the bounded writer rolls over an existing oversized file and retains an oversized write's tail", (context) => {
  const f = fixture(context);
  const logPath = path.join(f.directory, "bounded.log");
  writeFileSync(logPath, "a".repeat(300));
  appendBoundedDevLog(logPath, Buffer.from("first\n"), 100);
  assert.equal(readFileSync(logPath, "utf8"), "first\n");
  const oversized = `${"b".repeat(150)}\nlast\n`;
  appendBoundedDevLog(logPath, Buffer.from(oversized), 100);
  assert.equal(statSync(logPath).size, 100);
  assert.equal(readFileSync(logPath, "utf8"), oversized.slice(-100));
});

test("headless recovery requires its configured marker directory before spawning", async () => {
  let launches = 0;
  await assert.rejects(
    spawnDevRecoveryProcess(
      { executable: process.execPath, args: [] },
      {
        spawnProcess() {
          launches++;
        },
      },
    ),
    /marker path/,
  );
  assert.equal(launches, 0);
});

test("a synchronous spawn failure is surfaced to the recovery owner", async (context) => {
  const f = fixture(context);
  const failure = new Error("fixture synchronous failure");
  await assert.rejects(
    spawnDevRecoveryProcess(specification(f.markerPath), {
      spawnProcess() {
        throw failure;
      },
    }),
    (error) => error === failure,
  );
});

test("an asynchronous spawn failure removes its listeners", async (context) => {
  const f = fixture(context);
  const child = fakeChild();
  const failure = new Error("fixture asynchronous failure");
  const launching = spawnDevRecoveryProcess(specification(f.markerPath), {
    spawnProcess() {
      queueMicrotask(() => child.emit("error", failure));
      return child;
    },
  });
  await assert.rejects(launching, (error) => error === failure);
  assert.equal(child.listenerCount("spawn"), 0);
  assert.equal(child.listenerCount("error"), 0);
});

async function waitForFile(file, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    assert.ok(Date.now() < deadline, "fixture child must finish promptly");
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

async function waitForProcessExit(pid, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (processExists(pid)) {
    assert.ok(Date.now() < deadline, "fixture child must exit promptly");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test(
  "native headless recovery caps both streams after the launcher exits",
  { timeout: 20_000 },
  async (context) => {
    const f = fixture(context);
    const parentPath = path.join(f.directory, "launcher.mjs");
    const childPath = path.join(f.directory, "child.mjs");
    const releasePath = path.join(f.directory, "parent-exited.json");
    const completedPath = path.join(f.directory, "completed.json");
    const budget = DEV_RECOVERY_LOG_MAX_BYTES;
    writeFileSync(
      childPath,
      `import { existsSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
const [releasePath, completedPath] = process.argv.slice(2);
assert.equal(process.env.${RECOVERY_LOG_ENV}, undefined);
assert.equal(process.env.NODE_OPTIONS, "--no-warnings");
const deadline = Date.now() + 10000;
while (!existsSync(releasePath)) {
  if (Date.now() >= deadline) process.exit(2);
  await new Promise(resolve => setTimeout(resolve, 20));
}
const large = Buffer.alloc(${budget} + 2048, "x");
process.stdout.write(large);
process.stderr.write(large);
await new Promise(resolve => process.stdout.write("after-parent-exit stdout\\n", resolve));
process.stderr.write("after-parent-exit stderr\\n");
writeFileSync(completedPath, JSON.stringify({ pid: process.pid }));
`,
    );
    writeFileSync(
      parentPath,
      `import { spawnDevRecoveryProcess } from ${JSON.stringify(helperUrl)};
const [markerPath, childPath, releasePath, completedPath] = process.argv.slice(2);
const { child, output } = await spawnDevRecoveryProcess({
  executable: process.execPath, args: [childPath, releasePath, completedPath],
  markerPath, options: { cwd: ${JSON.stringify(f.directory)}, env: { ...process.env, NODE_OPTIONS: "--no-warnings" } }
});
child.unref();
process.stdout.write(JSON.stringify({ pid: process.pid, childPid: child.pid, output }) + "\\n");
`,
    );
    const parent = spawn(
      process.execPath,
      [parentPath, f.markerPath, childPath, releasePath, completedPath],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    parent.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    parent.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const code = await new Promise((resolve, reject) => {
      parent.once("error", reject);
      parent.once("close", resolve);
    });
    assert.equal(code, 0, stderr);
    const result = JSON.parse(stdout);
    f.waitForCleanup(() => waitForProcessExit(result.childPid));
    assert.equal(result.pid, parent.pid);
    assert.notEqual(result.childPid, parent.pid);
    assert.match(
      readFileSync(result.output.logPath, "utf8"),
      /dev-recovery-launch/,
    );
    writeFileSync(releasePath, JSON.stringify({ parentExited: true }));
    await waitForFile(completedPath);
    const completed = JSON.parse(readFileSync(completedPath, "utf8"));
    assert.equal(completed.pid, result.childPid);
    const output = readFileSync(result.output.logPath, "utf8");
    assert.match(output, /after-parent-exit stdout\n/);
    assert.match(output, /after-parent-exit stderr\n/);
    assert.ok(statSync(result.output.logPath).size <= budget);
  },
);
