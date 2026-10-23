import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

const script = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "verify-codex-desktop-continuation.mjs",
);
const fingerprint = `sha256-${"0".repeat(64)}`;
const runVerifier = (port, extra = []) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        script,
        "--port",
        String(port),
        "--runtime-fingerprint",
        fingerprint,
        ...extra,
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Verifier guard test exceeded 12 seconds"));
    }, 12_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });

test(
  "a real unrelated native listener cannot impersonate Codex using a CDP target",
  { skip: process.platform !== "win32", timeout: 15_000 },
  async () => {
    let targetRequests = 0;
    let websocketRequests = 0;
    let threadRequests = 0;
    const server = createServer((request, response) => {
      targetRequests += 1;
      if (request.url !== "/json") threadRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify([
          {
            id: "pretend-codex",
            type: "page",
            title: "Codex",
            url: "app://-/index.html",
            webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/pretend-codex`,
          },
        ]),
      );
    });
    server.on("upgrade", (_request, socket) => {
      websocketRequests += 1;
      socket.destroy();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const result = await runVerifier(server.address().port, [
        "--run-disposable-test",
      ]);
      assert.equal(result.code, 1, result.stderr);
      const evidence = JSON.parse(result.stdout);
      assert.equal(evidence.failure, "debug_port_owner_not_codex");
      assert.equal(evidence.stage, "readiness");
      assert.equal(evidence.desktopCdpVerified, false);
      assert.equal(evidence.temporaryDurableTestThread, false);
      assert.equal(evidence.existingThreadsTouched, false);
      assert.equal(
        targetRequests,
        0,
        "Native identity must be checked before target metadata",
      );
      assert.equal(
        websocketRequests,
        0,
        "No Runtime.evaluate can reach an unverified listener",
      );
      assert.equal(threadRequests, 0);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);

test("the actual log watcher accepts newly appended same-second installation records and rotation", async () => {
  const source = await readFile(script, "utf8");
  const begin = source.indexOf("const refreshFingerprint = async () => {");
  const end = source.indexOf("const readNativeIdentity = () => {", begin);
  assert.ok(begin >= 0 && end > begin);
  const prefix = path.join(os.tmpdir(), "ccswitch-desktop-log-guard-");
  const directory = await mkdtemp(prefix);
  const logPath = path.join(directory, "cc-switch.log");
  const second = Math.floor(Date.now() / 1000) * 1000;
  const timestamp = (time) => {
    const local = new Date(time);
    return `[${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}][${String(local.getHours()).padStart(2, "0")}:${String(local.getMinutes()).padStart(2, "0")}:${String(local.getSeconds()).padStart(2, "0")}]`;
  };
  const record = (time, hash) =>
    `${timestamp(time)}[INFO] Codex picker catalog payload installed: runtime_fingerprint=sha256-${hash.repeat(64)}\n`;
  try {
    await writeFile(logPath, record(second - 10_000, "1"));
    const initial = await stat(logPath);
    const context = vm.createContext({
      stat,
      open,
      Buffer,
      Date,
      logPath,
      logOffset: initial.size,
      logFileIdentity: `${initial.dev}:${initial.ino}`,
      logFragment: "",
      expectedFingerprint: undefined,
      startedAt: second + 900,
      binaryIdentity: { modifiedAt: second - 2_000 },
    });
    new vm.Script(
      `${source.slice(begin, end)}\nglobalThis.refresh = refreshFingerprint;`,
    ).runInContext(context);
    await context.refresh();
    assert.equal(
      context.expectedFingerprint,
      undefined,
      "A prior installation must not establish current runtime identity",
    );
    await writeFile(logPath, record(second, "2"), { flag: "a" });
    await context.refresh();
    assert.equal(
      context.expectedFingerprint,
      `sha256-${"2".repeat(64)}`,
      "Appended records have only second precision and remain fresh in the start second",
    );
    await rename(logPath, path.join(directory, "cc-switch.old.log"));
    await writeFile(logPath, record(second, "3"));
    await context.refresh();
    assert.equal(
      context.expectedFingerprint,
      `sha256-${"3".repeat(64)}`,
      "A rotated log must be read from its own beginning",
    );
  } finally {
    assert.ok(directory.startsWith(prefix) && directory !== os.tmpdir());
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "a missing explicitly supplied debug port stops within its bounded wait without a thread",
  { skip: process.platform !== "win32", timeout: 15_000 },
  async () => {
    const reservation = createServer();
    await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const startedAt = Date.now();
    const result = await runVerifier(port, [
      "--wait-ms",
      "250",
      "--run-disposable-test",
    ]);
    assert.equal(result.code, 1, result.stderr);
    const evidence = JSON.parse(result.stdout);
    assert.equal(evidence.failure, "desktop_bridge_not_ready");
    assert.equal(evidence.desktopCdpVerified, false);
    assert.equal(evidence.temporaryDurableTestThread, false);
    assert.equal(evidence.existingThreadsTouched, false);
    assert.ok(
      Date.now() - startedAt < 10_000,
      "A bounded native probe must not hang on a closed port",
    );
  },
);

test(
  "an existing evidence file is preserved before any native or Desktop operation",
  { timeout: 15_000, skip: process.platform !== "win32" },
  async () => {
    const prefix = path.join(
      os.tmpdir(),
      "ccswitch-desktop-existing-evidence-",
    );
    const directory = await mkdtemp(prefix);
    const output = path.join(directory, "receipt.json");
    const original = "preserve existing evidence\n";
    try {
      await writeFile(output, original);
      const result = await runVerifier(1, [
        "--output",
        output,
        "--run-disposable-test",
      ]);
      assert.equal(result.code, 1);
      const evidence = JSON.parse(result.stdout);
      assert.equal(evidence.failure, "output_exists");
      assert.equal(evidence.temporaryDurableTestThread, false);
      assert.equal(evidence.receiptFailure, "output_exists");
      assert.equal(await readFile(output, "utf8"), original);
    } finally {
      assert.ok(directory.startsWith(prefix) && directory !== os.tmpdir());
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("the actual cleanup renderer program refuses any unowned newer turn", async () => {
  const source = await readFile(script, "utf8");
  const guardedBegin = source.indexOf("const guarded = (body) =>");
  const guardedEnd = source.indexOf("const waitUntil = async", guardedBegin);
  const cleanupBegin = source.indexOf("const cleanupExpression = () =>");
  const cleanupEnd = source.indexOf("const run = async", cleanupBegin);
  assert.ok(
    guardedBegin >= 0 &&
      guardedEnd > guardedBegin &&
      cleanupBegin >= 0 &&
      cleanupEnd > cleanupBegin,
  );
  for (const newerTurn of [false, true]) {
    const calls = [];
    const threadId = "only-fresh-test-thread";
    const patchKey = "test-runtime";
    const leaseKey = "test-owned-lease";
    const turns = [
      { id: "owned-initial", status: "failed" },
      { id: "owned-continuation", status: "completed" },
    ];
    if (newerTurn)
      turns.push({ id: "unexpected-user-turn", status: "completed" });
    const context = vm.createContext({
      patchKey,
      leaseKey,
      expectedFingerprint: fingerprint,
      threadId,
      ownedTurnIds: ["owned-initial", "owned-continuation"],
      recoveryId: "only-test-recovery",
      window: {
        [patchKey]: {
          rendererRuntimeFingerprint: fingerprint,
          cancelCodexContinuation: (id) => {
            assert.equal(id, "only-test-recovery");
          },
        },
        [leaseKey]: {
          threadId,
          request: async (method, params) => {
            assert.equal(params.threadId, threadId);
            calls.push(method);
            if (method === "thread/read")
              return {
                thread: { id: threadId, status: { type: "idle" }, turns },
              };
            assert.equal(method, "thread/archive");
            return {};
          },
        },
      },
    });
    new vm.Script(
      `${source.slice(guardedBegin, guardedEnd)}\n${source.slice(cleanupBegin, cleanupEnd)}\nglobalThis.expression=cleanupExpression();`,
    ).runInContext(context);
    const result = await new vm.Script(context.expression).runInContext(
      context,
    );
    assert.equal(result.archived, !newerTurn);
    assert.deepEqual(
      calls,
      newerTurn ? ["thread/read"] : ["thread/read", "thread/archive"],
    );
    if (newerTurn) assert.equal(result.reason, "unexpected_turn");
  }
});
