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
import { loadCodexRendererSourceRuntime } from "./codex-renderer-source-runtime.mjs";

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

test("the source renderer assembler resolves every production slot", async () => {
  const runtime = await loadCodexRendererSourceRuntime();
  assert.match(runtime.fingerprint, /^sha256-[a-f0-9]{64}$/);
  assert.equal(runtime.template.includes("__CCSWITCH_"), false);
  const payload = JSON.stringify({
    catalogAvailable: true,
    modelProvider: "test-provider",
    modelNames: ["fixture-model"],
    models: [{ model: "fixture-model" }],
  });
  const source = runtime.assemble(payload, false, true);
  assert.equal(source.includes("__CCSWITCH_"), false);
  assert.match(source, /test-provider/);
  assert.match(source, /requestHealthWarningsSuppressed = true/);
});

test("source injection evidence distinguishes fixture prompts from compatibility cache refreshes", async () => {
  const source = await readFile(script, "utf8");
  const begin = source.indexOf("const threadScopeEvidence =");
  const end = source.indexOf("const fixtureScenarios =", begin);
  assert.ok(begin >= 0 && end > begin);
  for (const injectSourceRuntime of [false, true]) {
    const context = vm.createContext({ injectSourceRuntime });
    const evidence = JSON.parse(
      vm.runInContext(
        `${source.slice(begin, end)}; JSON.stringify(threadScopeEvidence())`,
        context,
      ),
    );
    if (injectSourceRuntime) {
      assert.deepEqual(evidence, {
        existingThreadsPrompted: false,
        fixtureOperationsRestrictedToOwnedThread: true,
        sourceRuntimeMayRefreshModelAndHistoryCaches: true,
      });
      assert.equal(Object.hasOwn(evidence, "existingThreadsTouched"), false);
    } else assert.deepEqual(evidence, { existingThreadsTouched: false });
  }
  assert.ok(source.includes("...threadScopeEvidence()"));
});

test("fixture scenarios are finite and preserve the explicit failure signals", async () => {
  const source = await readFile(script, "utf8");
  const begin = source.indexOf("const fixtureScenarios =");
  const end = source.indexOf("const patchKey =", begin);
  assert.ok(begin >= 0 && end > begin);
  for (const selected of [
    undefined,
    "overload",
    "concurrent_limit",
    "temporary_usage",
    "connection_drop",
  ]) {
    const context = vm.createContext({
      assert,
      options: new Map(selected ? [["--scenario", selected]] : []),
    });
    const projection = vm.runInContext(
      `${source.slice(begin, end)}; ({ scenario, error: fixtureScenarios[scenario] })`,
      context,
    );
    assert.equal(projection.scenario, selected || "overload");
    if (selected === "connection_drop") assert.equal(projection.error, null);
    else {
      assert.equal(projection.error.type, "server_error");
      assert.match(projection.error.message, /try again later/);
      if (selected === "concurrent_limit")
        assert.match(projection.error.message, /concurrent limit reached/);
      if (selected === "temporary_usage") {
        assert.equal(projection.error.code, "usage_limit_reached");
        assert.match(projection.error.message, /usage limit/);
        assert.doesNotMatch(
          projection.error.message,
          /daily|weekly|monthly|quota|billing|credit/i,
        );
      }
    }
  }
  const invalidContext = vm.createContext({
    assert,
    options: new Map([["--scenario", "unknown"]]),
  });
  assert.throws(
    () => vm.runInContext(source.slice(begin, end), invalidContext),
    /Unknown verifier scenario/,
  );
  assert.ok(
    source.includes("[`model_providers.${providerId}.stream_max_retries`]: 0"),
  );
});

test("renderer failures expose fixed reasons without reflected secrets", async () => {
  const source = await readFile(script, "utf8");
  const begin = source.indexOf("const classifyRendererException =");
  const end = source.indexOf("const sleep =", begin);
  assert.ok(begin >= 0 && end > begin);
  const context = vm.createContext({});
  vm.runInContext(
    `${source.slice(begin, end)}; globalThis.classify = classifyRendererException;`,
    context,
  );
  for (const [description, reason] of [
    ["Error: runtime_changed at app://secret-location", "runtime_changed"],
    ["Error: client_missing", "client_missing"],
    ["Error: invalid type: secret-token, expected a string", "invalid_params"],
    ["Error: missing field secret-field", "invalid_params"],
    [
      'Error: [{"code":"invalid_value","values":["secret"],"path":["type"],"message":"Invalid option"}]',
      "invalid_params",
    ],
    [
      'ZodError: {"errors":[{"code":"invalid_type","input":"secret"}]}',
      "invalid_params",
    ],
    ["Error: method not found secret-method", "unsupported_method"],
    ["Error: unknown provider secret-provider", "provider_unavailable"],
    ["Error: secret-token", "unclassified"],
  ]) {
    assert.equal(context.classify({ exception: { description } }), reason);
    assert.equal(
      JSON.stringify(context.classify({ exception: { description } })).includes(
        "secret",
      ),
      false,
    );
  }
  assert.equal(
    context.classify({
      exception: {
        value: { errors: [{ code: "invalid_value", input: "secret" }] },
      },
    }),
    "invalid_params",
  );
});

test("busy temporary cleanup preserves the original failure and writes its receipt", async () => {
  const source = await readFile(script, "utf8");
  const begin = source.indexOf("const cleanupTemporaryDirectory =");
  const end = source.indexOf("if (binaryPath)", begin);
  const receiptBegin = source.indexOf("evidence.verifiedAtUtc =");
  assert.ok(begin >= 0 && end > begin && receiptBegin > end);
  for (const [code, cleanupPending] of [
    ["EBUSY", "temporary_directory_busy"],
    ["EPERM", "temporary_directory_access_denied"],
    ["UNKNOWN", "temporary_directory_cleanup_failed"],
  ]) {
    const evidence = {
      verified: false,
      failure: "renderer_operation_rejected",
      rendererOperationFailure: { reason: "invalid_params" },
    };
    let receipt;
    let stdout;
    let closed = false;
    const context = vm.createContext({
      temporary: "/tmp/ccswitch-desktop-continuation-secret",
      temporaryPrefix: "/tmp/ccswitch-desktop-continuation-",
      threadId: "only-owned-thread",
      testThreadCreationAttempted: true,
      cleanupArchived: true,
      os: { tmpdir: () => "/tmp" },
      rm: async () => {
        throw Object.assign(new Error("secret cwd path"), { code });
      },
      evidence,
      Date,
      options: new Map([["--output", "/receipt.json"]]),
      open: async () => ({
        writeFile: async (value) => {
          receipt = value;
        },
        close: async () => {
          closed = true;
        },
      }),
      process: {
        exitCode: 1,
        stdout: {
          write: (value) => {
            stdout = value;
          },
        },
      },
    });
    await vm.runInContext(
      `(async () => { ${source.slice(begin, end)}; await cleanupTemporaryDirectory(evidence); ${source.slice(receiptBegin)} })()`,
      context,
    );
    assert.equal(closed, true);
    for (const output of [receipt, stdout]) {
      const result = JSON.parse(output);
      assert.equal(result.failure, "renderer_operation_rejected");
      assert.equal(result.rendererOperationFailure.reason, "invalid_params");
      assert.equal(result.pendingDirectory, true);
      assert.equal(result.cleanupPending, cleanupPending);
      assert.equal(output.includes("secret"), false);
    }
  }
});

test("temporary cleanup leaves an uncertain thread cwd intact", async () => {
  const source = await readFile(script, "utf8");
  const begin = source.indexOf("const cleanupTemporaryDirectory =");
  const end = source.indexOf("if (binaryPath)", begin);
  let deletes = 0;
  const evidence = { failure: "verification_deadline" };
  const context = vm.createContext({
    temporary: "/tmp/ccswitch-desktop-continuation-owned",
    temporaryPrefix: "/tmp/ccswitch-desktop-continuation-",
    threadId: "only-owned-thread",
    testThreadCreationAttempted: true,
    cleanupArchived: false,
    os: { tmpdir: () => "/tmp" },
    rm: async () => {
      deletes += 1;
    },
    evidence,
  });
  await vm.runInContext(
    `(async () => { ${source.slice(begin, end)}; await cleanupTemporaryDirectory(evidence); })()`,
    context,
  );
  assert.equal(deletes, 0);
  assert.equal(evidence.failure, "verification_deadline");
  assert.equal(evidence.pendingDirectory, true);
  assert.equal(evidence.cleanupPending, "temporary_directory_thread_uncertain");
});

test("source restoration accepts only validated baseline or exact source fingerprints", async () => {
  const source = await readFile(script, "utf8");
  const begin = source.indexOf("const sourceRuntimeSnapshotExpression =");
  const end = source.indexOf("const guarded =", begin);
  assert.ok(begin >= 0 && end > begin);
  const oldFingerprint = `sha256-${"1".repeat(64)}`;
  const sourceFingerprint = `sha256-${"2".repeat(64)}`;
  for (const installedFingerprint of [
    oldFingerprint,
    sourceFingerprint,
    `sha256-${"3".repeat(64)}`,
  ]) {
    const patchKey = "fixture-runtime";
    const payload = {
      catalogAvailable: true,
      modelProvider: "fixture-provider",
    };
    const context = vm.createContext({
      patchKey,
      expectedFingerprint: oldFingerprint,
      window: {
        [patchKey]: {
          rendererRuntimeFingerprint: installedFingerprint,
          payload,
          requestHealthWarningsSuppressed: true,
        },
      },
    });
    const expression = vm.runInContext(
      `${source.slice(begin, end)}; sourceRuntimeSnapshotExpression(${JSON.stringify([oldFingerprint, sourceFingerprint])})`,
      context,
    );
    const result = vm.runInContext(expression, context);
    const accepted = [oldFingerprint, sourceFingerprint].includes(
      installedFingerprint,
    );
    assert.equal(result.ok, accepted);
    if (accepted) {
      assert.equal(result.payload, payload);
      assert.equal(result.installedFingerprint, installedFingerprint);
      assert.equal(result.requestHealthWarningsSuppressed, true);
    } else {
      assert.equal(result.reason, "renderer_runtime_fingerprint_mismatch");
      assert.equal(result.payload, undefined);
    }
  }
});

test("the disposable fixture uses the validated current provider and isolates endpoint and retry settings per thread", async () => {
  const source = await readFile(script, "utf8");
  const begin = source.indexOf("const guarded =");
  const end = source.indexOf("const waitUntil =", begin);
  assert.ok(begin >= 0 && end > begin);
  for (const provider of [
    "codex_model_router_v2",
    undefined,
    "bad.provider",
    "secret provider",
  ]) {
    const patchKey = "fixture-runtime";
    const context = vm.createContext({
      patchKey,
      expectedFingerprint: fingerprint,
      leaseKey: "fixture-lease",
      window: {
        [patchKey]: {
          rendererRuntimeFingerprint: fingerprint,
          payload: { modelProvider: provider },
        },
      },
    });
    const expression = vm.runInContext(
      `${source.slice(begin, end)}; currentProviderExpression()`,
      context,
    );
    const result = vm.runInContext(expression, context);
    if (provider === "codex_model_router_v2")
      assert.equal(await result, provider);
    else await assert.rejects(result, /current_provider_unavailable/);
  }
  assert.equal(source.includes("ccswitch_verifier_"), false);
  assert.ok(
    source.includes("[`model_providers.${providerId}.base_url`]: localBase"),
  );
  assert.equal(source.includes("[`model_providers.${providerId}`]"), false);
  assert.ok(
    source.includes("[`model_providers.${providerId}.request_max_retries`]: 0"),
  );
  assert.ok(
    source.includes("[`model_providers.${providerId}.stream_max_retries`]: 0"),
  );
  assert.ok(source.includes("modelProvider: providerId"));
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

test(
  "an unopened debugging port is reported separately from an unusable bridge",
  { skip: process.platform !== "win32", timeout: 15000 },
  async () => {
    const server = createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    const result = await runVerifier(port);
    assert.equal(result.code, 1);
    const evidence = JSON.parse(result.stdout);
    assert.equal(evidence.failure, "desktop_debug_port_unavailable");
    assert.equal(evidence.existingThreadsTouched, false);
    assert.equal(evidence.temporaryDurableTestThread, false);
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
    assert.equal(evidence.failure, "desktop_debug_port_unavailable");
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

test("the actual readiness probe reports the blocked prerequisite without calling a Desktop method", async () => {
  const source = await readFile(script, "utf8");
  const begin = source.indexOf("const readinessExpression = () =>");
  const end = source.indexOf("const guarded = (body) =>", begin);
  assert.ok(begin >= 0 && end > begin);
  const noCall = () => {
    throw new Error("Readiness must not call a Desktop method");
  };
  const healthy = () => ({
    rendererRuntimeFingerprint: fingerprint,
    appServerClients: [
      {
        hostId: "local",
        __ccSwitchOriginalSendRequest: noCall,
        getCompatibleThreadSortKey: noCall,
        supportsPaginatedThreadHistory: noCall,
      },
    ],
    isCodexContinuationRequestClient: () => true,
    startCodexContinuation: noCall,
    readCodexContinuationJob: noCall,
    commitCodexContinuation: noCall,
  });
  for (const [state, blocker] of [
    [undefined, "renderer_runtime_not_installed"],
    [
      { ...healthy(), rendererRuntimeFingerprint: "other-runtime" },
      "renderer_runtime_fingerprint_mismatch",
    ],
    [
      { ...healthy(), commitCodexContinuation: undefined },
      "renderer_continuation_api_unavailable",
    ],
    [
      { ...healthy(), isCodexContinuationRequestClient: undefined },
      "renderer_continuation_api_unavailable",
    ],
    [
      { ...healthy(), appServerClients: [] },
      "desktop_request_client_unavailable",
    ],
    [healthy(), null],
  ]) {
    const patchKey = "fixture-runtime";
    const context = vm.createContext({
      patchKey,
      expectedFingerprint: fingerprint,
      window: { [patchKey]: state },
    });
    const expression = vm.runInContext(
      `${source.slice(begin, end)}; readinessExpression()`,
      context,
    );
    const result = vm.runInContext(expression, context);
    assert.equal(result.ready, blocker === null);
    assert.equal(result.readinessBlocker, blocker);
  }
});

test("readiness rejects an unverified retained client even when an original-request marker exists", async () => {
  const source = await readFile(script, "utf8");
  const begin = source.indexOf("const readinessExpression = () =>");
  const end = source.indexOf("const guarded = (body) =>", begin);
  assert.ok(begin >= 0 && end > begin);
  const noCall = () => {
    throw new Error("Readiness must not call a Desktop method");
  };
  const client = {
    hostId: "local",
    __ccSwitchOriginalSendRequest: noCall,
    getCompatibleThreadSortKey: noCall,
    supportsPaginatedThreadHistory: noCall,
  };
  let ownershipChecks = 0;
  const patchKey = "fixture-runtime";
  const context = vm.createContext({
    patchKey,
    expectedFingerprint: fingerprint,
    window: {
      [patchKey]: {
        rendererRuntimeFingerprint: fingerprint,
        appServerClients: [client],
        isCodexContinuationRequestClient(candidate) {
          assert.equal(candidate, client);
          ownershipChecks += 1;
          return false;
        },
        startCodexContinuation: noCall,
        readCodexContinuationJob: noCall,
        commitCodexContinuation: noCall,
      },
    },
  });
  const expression = vm.runInContext(
    source.slice(begin, end) + "; readinessExpression()",
    context,
  );
  const result = vm.runInContext(expression, context);
  assert.equal(result.ready, false);
  assert.equal(result.readinessBlocker, "desktop_request_client_unavailable");
  assert.equal(ownershipChecks, 1);
});
