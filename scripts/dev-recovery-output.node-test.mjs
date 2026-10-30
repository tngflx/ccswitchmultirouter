import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  fstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnDevRecoveryProcess } from "./dev-recovery-output.mjs";

const helperUrl = new URL("./dev-recovery-output.mjs", import.meta.url).href;

function fixture(context) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ccsm-dev-output-"));
  const cleanupWaiters = [];
  context.after(async () => {
    for (const waiter of cleanupWaiters) await waiter();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    markerPath: path.join(directory, "logs", "dev-session.json"),
    waitForCleanup: (waiter) => cleanupWaiters.push(waiter),
  };
}

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

test("headless recovery appends both streams, preserves launch arguments, and closes the parent descriptor before spawn acknowledgement", async (context) => {
  const f = fixture(context);
  const spec = specification(f.markerPath);
  let observed;
  let descriptor;
  const child = fakeChild();
  const launching = spawnDevRecoveryProcess(spec, {
    spawnProcess(executable, args, options) {
      observed = { executable, args, options };
      descriptor = options.stdio[1];
      assert.equal(options.stdio[2], descriptor);
      assert.equal(fstatSync(descriptor).isFile(), true);
      writeFileSync(descriptor, "fixture stdout\nfixture stderr\n");
      return child;
    },
  });
  assert.throws(() => fstatSync(descriptor), { code: "EBADF" });
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
  assert.deepEqual(observed.options.env, spec.options.env);
  assert.equal(observed.options.shell, false);
  assert.equal(observed.options.windowsVerbatimArguments, false);
  assert.equal(observed.options.detached, true);
  assert.equal(observed.options.windowsHide, true);
  assert.equal(observed.options.stdio[0], "ignore");
  const output = readFileSync(result.output.logPath, "utf8");
  const [launchLine] = output.split("\n");
  const launch = JSON.parse(launchLine);
  assert.equal(launch.event, "dev-recovery-launch");
  assert.equal(launch.pid, process.pid);
  assert.equal(Number.isFinite(Date.parse(launch.timestamp)), true);
  assert.match(output, /fixture stdout\nfixture stderr\n$/);
  assert.equal(output.includes("redacted-fixture"), false);
  assert.equal(output.includes("value with spaces"), false);
});

test("subsequent recovery launches append to the same configured persistent log", async (context) => {
  const f = fixture(context);
  for (const generation of [1, 2]) {
    const child = fakeChild();
    const result = await spawnDevRecoveryProcess(specification(f.markerPath), {
      spawnProcess(_executable, _args, options) {
        assert.equal(typeof options.stdio[1], "number");
        assert.equal(options.stdio[1], options.stdio[2]);
        assert.equal(options.detached, true);
        assert.equal(options.windowsHide, true);
        writeFileSync(options.stdio[1], `fixture generation ${generation}\n`);
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
  assert.equal(records.length, 4, "every launch appends to existing output");
  assert.equal(records[1], "fixture generation 1");
  assert.equal(records[3], "fixture generation 2");
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

test("a synchronous spawn failure closes the opened recovery descriptor", async (context) => {
  const f = fixture(context);
  let descriptor;
  const failure = new Error("fixture synchronous failure");
  await assert.rejects(
    spawnDevRecoveryProcess(specification(f.markerPath), {
      spawnProcess(_executable, _args, options) {
        descriptor = options.stdio[1];
        assert.equal(fstatSync(descriptor).isFile(), true);
        throw failure;
      },
    }),
    (error) => error === failure,
  );
  assert.throws(() => fstatSync(descriptor), { code: "EBADF" });
});

test("an asynchronous spawn failure closes its descriptor and removes its listeners", async (context) => {
  const f = fixture(context);
  let descriptor;
  const child = fakeChild();
  const failure = new Error("fixture asynchronous failure");
  const launching = spawnDevRecoveryProcess(specification(f.markerPath), {
    spawnProcess(_executable, _args, options) {
      descriptor = options.stdio[1];
      queueMicrotask(() => child.emit("error", failure));
      return child;
    },
  });
  await assert.rejects(launching, (error) => error === failure);
  assert.throws(() => fstatSync(descriptor), { code: "EBADF" });
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
  "native headless recovery preserves stdout and stderr written after the launcher exits",
  { timeout: 20_000 },
  async (context) => {
    const f = fixture(context);
    const parentPath = path.join(f.directory, "launcher.mjs");
    const childPath = path.join(f.directory, "child.mjs");
    const releasePath = path.join(f.directory, "parent-exited.json");
    const completedPath = path.join(f.directory, "completed.json");
    writeFileSync(
      childPath,
      `import { existsSync, writeFileSync } from "node:fs";
const [releasePath, completedPath] = process.argv.slice(2);
const deadline = Date.now() + 10000;
while (!existsSync(releasePath)) {
  if (Date.now() >= deadline) process.exit(2);
  await new Promise(resolve => setTimeout(resolve, 20));
}
process.stdout.write("after-parent-exit stdout\\n");
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
  markerPath, options: { cwd: ${JSON.stringify(f.directory)}, env: process.env }
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
    writeFileSync(releasePath, JSON.stringify({ parentExited: true }));
    await waitForFile(completedPath);
    const completed = JSON.parse(readFileSync(completedPath, "utf8"));
    assert.equal(completed.pid, result.childPid);
    const output = readFileSync(result.output.logPath, "utf8");
    assert.match(output, /after-parent-exit stdout\n/);
    assert.match(output, /after-parent-exit stderr\n/);
    assert.equal(output.includes("dev-recovery-launch"), true);
  },
);
