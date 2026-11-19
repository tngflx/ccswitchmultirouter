import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { isIP } from "node:net";
import {
  link,
  lstat,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
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
const normalizeMonitorSource = (source) => source.replace(/\r\n/g, "\n");
const readMonitorSource = async () =>
  normalizeMonitorSource(await readFile(script, "utf8"));

test("monitor source slices preserve boundaries across LF and CRLF checkouts", async () => {
  const original = await readFile(script, "utf8");
  for (const newline of ["\n", "\r\n"]) {
    const source = normalizeMonitorSource(original.replace(/\r?\n/g, newline));
    for (const marker of [
      "let evidence;\ntry {",
      "assert.equal(\n  process.platform,",
      "const options = new Map();",
    ])
      assert.ok(source.includes(marker), `Source marker missing: ${marker}`);
    const begin = source.indexOf("const options = new Map();");
    const end = source.indexOf("assert.equal(\n  process.platform,", begin);
    assert.ok(end > begin, "The CLI slice must end before module-level awaits");
    new vm.Script(source.slice(begin, end));
  }
});
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
  const nativeBooleanReasoning = await readFile(
    new URL(
      "../src-tauri/src/resources/codex_desktop/native_boolean_reasoning.js",
      import.meta.url,
    ),
    "utf8",
  );
  assert.ok(source.includes(nativeBooleanReasoning));
  assert.match(source, /test-provider/);
  assert.match(source, /requestHealthWarningsSuppressed = true/);
});

test("source injection evidence distinguishes fixture prompts from compatibility cache refreshes", async () => {
  const source = await readMonitorSource();
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
  const source = await readMonitorSource();
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
  assert.ok(source.includes("stream_max_retries: 0"));
});

test("terminal fixture scenarios keep explicit denial and hard quota distinct from the four recoverable failures", async () => {
  const source = await readMonitorSource();
  const begin = source.indexOf("const fixtureScenarios =");
  const end = source.indexOf("const patchKey =", begin);
  assert.ok(begin >= 0 && end > begin);
  for (const scenario of ["explicit_no_retry", "hard_quota"]) {
    const context = vm.createContext({
      assert,
      options: new Map([["--scenario", scenario]]),
    });
    const result = vm.runInContext(
      `${source.slice(begin, end)}; ({ error: fixtureScenarios[scenario], terminal: scenarioExpectsTerminalRefusal })`,
      context,
    );
    assert.equal(result.terminal, true);
    assert.equal(result.error.type, "server_error");
    if (scenario === "explicit_no_retry") {
      assert.equal(result.error.retryable, false);
      assert.match(result.error.message, /do not retry/i);
    } else {
      assert.equal(result.error.code, "insufficient_quota");
      assert.match(result.error.message, /billing|credit/i);
      assert.doesNotMatch(
        result.error.message,
        /try again|reset|available in/i,
      );
    }
  }
});

const terminalRefusalContext = async (scenario, overrides = {}) => {
  const source = await readMonitorSource();
  const begin = source.indexOf("const verifyTerminalFixtureRefusal =");
  const end = source.indexOf("const run =", begin);
  assert.ok(
    begin >= 0 && end > begin,
    "The terminal fixture must have its own zero-commit verification branch",
  );
  const calls = [];
  const failed = {
    turnId: "owned-failed-turn",
    turnCount: 1,
    status: "failed",
    threadMatches: true,
  };
  const context = vm.createContext({
    assert,
    stage: "production_prepare",
    scenario,
    connection: {
      evaluate: async (expression) => {
        calls.push(expression);
        assert.equal(
          expression,
          "read-owned-thread",
          "Terminal refusal must never invoke commit or turn/start",
        );
        return failed;
      },
    },
    threadProjection: () => "read-owned-thread",
    checkNativeIdentity: () => calls.push("native-check"),
    checkBinary: async () => calls.push("binary-check"),
    initialRequests: 1,
    continuedRequests: 0,
    receivedLiteralContinue: false,
    fixtureFailure: false,
    injectSourceRuntime: false,
    expectedFingerprint: fingerprint,
    binarySha256: "0".repeat(64),
    nativeIdentity: { host: "::1", owners: [{ pid: 200 }] },
    sourceRuntimeInjection: undefined,
    creationReadinessDiagnostics: undefined,
    threadScopeEvidence: () => ({ existingThreadsTouched: false }),
    ...overrides,
  });
  vm.runInContext(
    `${source.slice(begin, end)}; globalThis.verify = verifyTerminalFixtureRefusal;`,
    context,
  );
  return { context, calls, failed };
};

test("terminal refusal verification proves zero submissions without committing or serializing a job reason", async () => {
  for (const scenario of ["explicit_no_retry", "hard_quota"]) {
    const { context, calls, failed } = await terminalRefusalContext(scenario);
    const receipt = await context.verify(
      {
        status: "completed",
        submitted: false,
        mutationAttempted: false,
        threadMatches: true,
        terminalRefusal: true,
        reason: "secret-reflected-provider-value",
      },
      failed,
    );
    assert.equal(receipt.verified, true);
    assert.equal(receipt.desktopCdpVerified, true);
    assert.equal(
      receipt.scope,
      "actual_codex_desktop_cdp_existing_production_renderer_terminal_refusal",
    );
    assert.equal(receipt.automaticNativeSchedulingVerified, false);
    assert.equal(receipt.terminalRefusalObserved, true);
    assert.equal(receipt.continuationSubmitted, false);
    assert.equal(receipt.continuationMutationAttempted, false);
    assert.equal(receipt.continuationCommitInvoked, false);
    assert.equal(receipt.initialFailedTurnUnchanged, true);
    assert.equal(receipt.exactlyZeroContinuations, true);
    assert.equal(receipt.initialRequests, 1);
    assert.equal(receipt.continuedRequests, 0);
    assert.equal(JSON.stringify(receipt).includes("secret"), false);
    assert.deepEqual(calls, [
      "native-check",
      "binary-check",
      "read-owned-thread",
    ]);
  }
});

test("terminal refusal verification rejects unrelated preparation failures, mutations and newer turns", async () => {
  const base = {
    status: "completed",
    submitted: false,
    mutationAttempted: false,
    threadMatches: true,
    terminalRefusal: true,
  };
  for (const changed of [
    { status: "prepared" },
    { submitted: true },
    { mutationAttempted: true },
    { threadMatches: false },
    { terminalRefusal: false },
  ]) {
    const { context, failed } =
      await terminalRefusalContext("explicit_no_retry");
    await assert.rejects(context.verify({ ...base, ...changed }, failed));
  }
  for (const changed of [
    { turnId: "newer-turn" },
    { turnCount: 2 },
    { status: "completed" },
    { threadMatches: false },
  ]) {
    const { context, failed } = await terminalRefusalContext("hard_quota", {
      connection: { evaluate: async () => ({ ...failed, ...changed }) },
    });
    await assert.rejects(context.verify(base, failed));
  }
  const { context, failed } = await terminalRefusalContext("hard_quota", {
    continuedRequests: 1,
  });
  await assert.rejects(context.verify(base, failed));
});

test("continuation outcome diagnostics classify only fixed reasons and never serialize reflected values or read getters", async () => {
  const source = await readMonitorSource();
  const begin = source.indexOf("const projectContinuationResult =");
  const end = source.indexOf("const continuationResultExpression =", begin);
  assert.ok(
    begin >= 0 && end > begin,
    "Continuation results need an in-renderer safe projection",
  );
  const context = vm.createContext({});
  vm.runInContext(
    `${source.slice(begin, end)}; globalThis.project = projectContinuationResult;`,
    context,
  );
  for (const [reason, reasonCode] of [
    ["Continuation is not prepared", "not_prepared"],
    ["The Codex compatibility runtime was replaced", "runtime_replaced"],
    [
      "Codex continuation authorization changed while reading the thread",
      "authorization_changed",
    ],
    ["The latest Codex turn needs a user action", "terminal_user_action"],
    ["Continuation submitted to the interrupted Codex thread", "submitted"],
    [
      "The latest Codex turn changed before continuation",
      "failed_turn_changed",
    ],
    ["The interrupted Codex thread changed model", "model_changed"],
    [
      "Codex Desktop request client was not found with its guarded activity hook",
      "client_hook_unavailable",
    ],
    [
      "Continuation result is uncertain: secret-reflected-error",
      "uncertain_result",
    ],
    ["secret-reflected-error", "unclassified"],
    [undefined, "none"],
  ]) {
    const projected = context.project(
      {
        status: "completed",
        started: false,
        submitted: false,
        mutationAttempted: false,
        threadId: "owned-thread",
        jobId: "owned-recovery",
        turnId: "secret-turn-id",
        reason,
        unknown: "secret-extra-field",
        error: "secret-error",
        input: "secret-prompt",
      },
      "owned-thread",
      "owned-recovery",
      7,
    );
    assert.equal(projected.reasonCode, reasonCode);
    assert.equal(projected.runtimeGeneration, 7);
    assert.equal(projected.started, false);
    assert.equal(projected.submitted, false);
    assert.equal(projected.mutationAttempted, false);
    assert.equal(projected.threadMatches, true);
    assert.equal(projected.jobMatches, true);
    assert.equal(projected.turnIdPresent, true);
    assert.equal(projected.status, "completed");
    assert.equal(JSON.stringify(projected).includes("secret"), false);
    assert.equal(Object.hasOwn(projected, "reason"), false);
    assert.equal(Object.hasOwn(projected, "turnId"), false);
  }
  for (const status of ["confirming", "confirmed"]) {
    const projected = context.project(
      { status },
      "owned-thread",
      "owned-recovery",
      7,
    );
    assert.equal(projected.status, status);
  }
  let getterReads = 0;
  const hostile = {};
  for (const field of [
    "reason",
    "status",
    "started",
    "submitted",
    "mutationAttempted",
    "threadId",
    "jobId",
    "turnId",
  ])
    Object.defineProperty(hostile, field, {
      get() {
        getterReads += 1;
        throw new Error("secret-getter");
      },
    });
  const projected = context.project(
    hostile,
    "owned-thread",
    "owned-recovery",
    Infinity,
  );
  assert.equal(getterReads, 0);
  assert.equal(projected.reasonCode, "none");
  assert.equal(projected.status, "unknown");
  assert.equal(projected.runtimeGeneration, null);
  for (const field of [
    "started",
    "submitted",
    "mutationAttempted",
    "threadMatches",
    "jobMatches",
  ])
    assert.equal(projected[field], null);
  const malformed = context.project(
    {
      status: "secret-status",
      started: "false",
      submitted: 1,
      mutationAttempted: "true",
    },
    "owned-thread",
    "owned-recovery",
    -1,
  );
  assert.equal(malformed.status, "unknown");
  assert.equal(malformed.started, null);
  assert.equal(malformed.submitted, null);
  assert.equal(malformed.mutationAttempted, null);
  assert.equal(malformed.runtimeGeneration, null);
  assert.equal(
    context.project(null, "owned-thread", "owned-recovery", 8).present,
    false,
  );
});

test("continuation diagnostic RPC programs project reasons inside the renderer before returning", async () => {
  const source = await readMonitorSource();
  const begin = source.indexOf("const projectContinuationResult =");
  const end = source.indexOf("const currentProviderExpression =", begin);
  assert.ok(begin >= 0 && end > begin);
  const state = {
    runtimeGeneration: 9,
    commitCodexContinuation: () => ({
      started: false,
      reason: "Continuation is not prepared",
      provider: "secret-provider",
    }),
    readCodexContinuationJob: () => ({
      status: "completed",
      submitted: false,
      mutationAttempted: false,
      threadId: "owned-thread",
      turnId: "owned-turn",
      reason: "secret-reflected-error",
    }),
  };
  const context = vm.createContext({
    fixtureState: state,
    recoveryId: "owned-recovery",
    threadId: "owned-thread",
    guarded: (body) =>
      `(async () => { const state = fixtureState; ${body} })()`,
  });
  vm.runInContext(
    `${source.slice(begin, end)}; globalThis.ackExpression = continuationResultExpression; globalThis.jobExpression = continuationJobExpression;`,
    context,
  );
  const ack = await vm.runInContext(
    context.ackExpression("state.commitCodexContinuation('owned-recovery')"),
    context,
  );
  assert.equal(ack.started, false);
  assert.equal(ack.reasonCode, "not_prepared");
  assert.equal(ack.runtimeGeneration, 9);
  assert.equal(JSON.stringify(ack).includes("secret"), false);
  const observed = await vm.runInContext(context.jobExpression(), context);
  assert.equal(observed.job.status, "completed");
  assert.equal(
    observed.job.turnId,
    "owned-turn",
    "Only the owned turn ID remains internal for cleanup",
  );
  assert.equal(observed.diagnostics.reasonCode, "unclassified");
  assert.equal(observed.diagnostics.threadMatches, true);
  assert.equal(observed.diagnostics.runtimeGeneration, 9);
  assert.equal(JSON.stringify(observed).includes("secret"), false);
  state.readCodexContinuationJob = () => null;
  const missing = await vm.runInContext(context.jobExpression(), context);
  assert.equal(missing.job, null);
  assert.equal(missing.diagnostics.present, false);
  assert.equal(missing.diagnostics.status, "missing");
  assert.equal(missing.diagnostics.runtimeGeneration, 9);
});

test("failed commit diagnostics observe the job once without repreparing or committing again", async () => {
  const source = await readMonitorSource();
  const begin = source.indexOf("const readContinuationJob =");
  const end = source.indexOf("const verifyTerminalFixtureRefusal =", begin);
  assert.ok(
    begin >= 0 && end > begin,
    "A refused commit needs bounded diagnostics before assertions",
  );
  for (const readFails of [false, true]) {
    const calls = [];
    const diagnostics = {};
    const ack = {
      started: false,
      reasonCode: "not_prepared",
      runtimeGeneration: 10,
    };
    const job = {
      present: false,
      status: "missing",
      started: null,
      submitted: null,
      mutationAttempted: null,
      threadMatches: null,
      jobMatches: null,
      turnIdPresent: false,
      reasonCode: "none",
      runtimeGeneration: 10,
    };
    const context = vm.createContext({
      continuationDiagnostics: diagnostics,
      recoveryId: "owned-recovery",
      continuationResultExpression: () => "safe-commit-expression",
      connection: {
        evaluate: async (expression) => {
          calls.push(expression);
          if (expression === "safe-commit-expression") return ack;
          assert.equal(
            expression,
            "safe-job-expression",
            "There must be no second commit or preparation call",
          );
          if (readFails) throw new Error("secret-reflected-error");
          return { job: null, diagnostics: job };
        },
      },
    });
    vm.runInContext(
      `${source.slice(begin, end)}; globalThis.commit = commitContinuationWithDiagnostics;`,
      context,
    );
    assert.equal(await context.commit("safe-job-expression"), ack);
    assert.deepEqual(calls, ["safe-commit-expression", "safe-job-expression"]);
    assert.equal(diagnostics.commitAck, ack);
    if (readFails) assert.equal(diagnostics.commitJobReadFailed, true);
    else assert.equal(diagnostics.latestJob, job);
    assert.equal(JSON.stringify(diagnostics).includes("secret"), false);
  }
});

test("confirmation diagnostics wait for a read-only confirmed phase without committing", async () => {
  const source = await readMonitorSource();
  const begin = source.indexOf("const readContinuationJob =");
  const end = source.indexOf("const verifyTerminalFixtureRefusal =", begin);
  assert.ok(begin >= 0 && end > begin);
  for (const accepted of [false, true]) {
    const calls = [];
    const diagnostics = {};
    const ack = { started: accepted };
    const expected = {
      status: accepted ? "confirmed" : "completed",
      threadMatches: true,
      submitted: false,
      mutationAttempted: false,
    };
    let observations = 0;
    const context = vm.createContext({
      recoveryId: "owned-recovery",
      continuationDiagnostics: diagnostics,
      continuationResultExpression: (call) => {
        assert.equal(call, 'state.confirmCodexContinuation("owned-recovery")');
        return "safe-confirm-expression";
      },
      waitUntil: async (read) => {
        for (let index = 0; index < 3; index += 1) {
          const value = await read();
          if (value) return value;
        }
        throw new Error("Confirmation never settled");
      },
      connection: {
        evaluate: async (expression) => {
          calls.push(expression);
          if (expression === "safe-confirm-expression") return ack;
          assert.equal(
            expression,
            "safe-job-expression",
            "Confirmation must not commit or reprepare",
          );
          const job =
            accepted && observations++ === 0
              ? { status: "confirming" }
              : expected;
          return { job, diagnostics: { status: job.status } };
        },
      },
    });
    vm.runInContext(
      `${source.slice(begin, end)}; globalThis.confirm = confirmContinuationWithDiagnostics;`,
      context,
    );
    const result = await context.confirm("safe-job-expression");
    assert.equal(result.ack, ack);
    assert.equal(result.job, expected);
    assert.deepEqual(
      calls,
      accepted
        ? [
            "safe-confirm-expression",
            "safe-job-expression",
            "safe-job-expression",
          ]
        : ["safe-confirm-expression", "safe-job-expression"],
    );
    assert.equal(diagnostics.confirmAck, ack);
    assert.equal(diagnostics.confirmedJob.status, expected.status);
  }
});

test("renderer failures expose fixed reasons without reflected secrets", async () => {
  const source = await readMonitorSource();
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
  const source = await readMonitorSource();
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
      ownerAuditChild: undefined,
      ownerAuditMutationUncertain: false,
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
  const source = await readMonitorSource();
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
    ownerAuditChild: undefined,
    ownerAuditMutationUncertain: false,
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
  const source = await readMonitorSource();
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

test("the disposable fixture validates the current provider but isolates a dedicated credential-free provider per thread", async () => {
  const source = await readMonitorSource();
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
  assert.equal(
    source.includes("[`model_providers.${providerId}.base_url`]"),
    false,
  );
  assert.ok(
    source.includes(
      "[`model_providers.${providerId}`]: fixtureProviderDefinition(localBase)",
    ),
  );
  assert.ok(source.includes("request_max_retries: 0"));
  assert.ok(source.includes("stream_max_retries: 0"));
  assert.ok(source.includes("requires_openai_auth: false"));
  assert.ok(source.includes("JSON.stringify(capturedCurrentProviderId)"));
  assert.ok(source.includes("modelProvider: providerId"));
});

const nativeListener = (
  address,
  pid,
  verified = true,
  creationTicks = `${pid}`,
) => ({
  address,
  pid,
  verified,
  creationTicks,
  name: verified ? "ChatGPT.exe" : null,
});

const nativeEndpointContext = async (initialRows, pinned = null) => {
  const source = await readMonitorSource();
  const helperBegin = source.indexOf("const normalizeListenerAddress =");
  const identityBegin = source.indexOf("const readNativeIdentity =");
  const begin = helperBegin >= 0 ? helperBegin : identityBegin;
  const end = source.indexOf("const readTargets =", identityBegin);
  assert.ok(begin >= 0 && end > begin);
  let rows = initialRows;
  const context = vm.createContext({
    isIP,
    URL,
    port: 9229,
    nativeIdentity: pinned,
    sameIdentity: (left, right) =>
      JSON.stringify(left) === JSON.stringify(right),
    fail: (reason) => new Error(reason),
    spawnSync: () => ({ status: 0, stdout: JSON.stringify(rows) }),
  });
  vm.runInContext(
    `${source.slice(begin, end)}; globalThis.probe = readNativeIdentity; globalThis.check = checkNativeIdentity;`,
    context,
  );
  return {
    context,
    setRows: (value) => {
      rows = value;
    },
  };
};

test("dual-stack ownership falls back from an unqueryable IPv4 listener to verified IPv6 only", async () => {
  const { context } = await nativeEndpointContext([
    nativeListener("127.0.0.1", 100, false, null),
    nativeListener("::1", 200),
  ]);
  const identity = context.probe();
  assert.equal(identity.host, "::1");
  assert.deepEqual(
    Array.from(identity.owners, ({ pid }) => pid),
    [200],
  );
  assert.equal(identity.owners[0].verified, true);
});

test("dual-stack ownership never borrows a different address proof or lets unrelated IPv6 poison IPv4", async () => {
  const { context } = await nativeEndpointContext([
    nativeListener("127.0.0.1", 200),
    nativeListener("::1", 100, false, null),
  ]);
  const identity = context.probe();
  assert.equal(identity.host, "127.0.0.1");
  assert.deepEqual(
    Array.from(identity.owners, ({ pid }) => pid),
    [200],
  );
  const blocked = await nativeEndpointContext([
    nativeListener("127.0.0.1", 100, false, null),
  ]);
  assert.throws(() => blocked.context.probe(), /debug_port_owner_not_codex/);
});

test("dual-stack ownership keeps wildcard, mapped and malformed addresses fail closed", async () => {
  for (const address of ["::", "missing-address", undefined]) {
    const { context } = await nativeEndpointContext([
      nativeListener("127.0.0.1", 200),
      nativeListener("::1", 200),
      nativeListener(address, 100, false, null),
    ]);
    assert.throws(
      () => context.probe(),
      address === "::"
        ? /debug_port_owner_not_codex/
        : /native_identity_invalid/,
    );
  }
  for (const address of [
    "0.0.0.0",
    "::ffff:0.0.0.0",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
  ]) {
    const { context } = await nativeEndpointContext([
      nativeListener("127.0.0.1", 200),
      nativeListener("::1", 200),
      nativeListener(address, 100, false, null),
    ]);
    assert.equal(
      context.probe().host,
      "::1",
      `${address} must reject IPv4 without authorizing or poisoning IPv6`,
    );
  }
  const mapped = await nativeEndpointContext([
    nativeListener("::ffff:127.0.0.1", 200),
  ]);
  assert.equal(mapped.context.probe().host, "127.0.0.1");
  const empty = await nativeEndpointContext([]);
  assert.equal(empty.context.probe(), null);
});

test("dual-stack ownership pins address, listener coverage, PID and process creation across mutations", async () => {
  const initial = [nativeListener("::1", 200)];
  const { context, setRows } = await nativeEndpointContext(initial);
  const pinned = context.probe();
  context.nativeIdentity = pinned;
  assert.doesNotThrow(() => context.check());
  for (const replacement of [
    [nativeListener("127.0.0.1", 200)],
    [nativeListener("::1", 201)],
    [nativeListener("::1", 200, true, "201")],
    [nativeListener("::", 200)],
  ]) {
    setRows(replacement);
    assert.throws(() => context.check(), /debug_port_identity_changed/);
    assert.equal(
      context.nativeIdentity,
      pinned,
      "A mutation check must never repin another endpoint",
    );
  }
  setRows(initial);
  assert.doesNotThrow(() => context.check());
});

test(
  "the native listener query rejects partial snapshots even when their error is ObjectNotFound",
  { skip: process.platform !== "win32", timeout: 15_000 },
  async () => {
    const source = await readMonitorSource();
    const begin = source.indexOf("const normalizeListenerAddress =");
    const end = source.indexOf("const checkNativeIdentity =", begin);
    let query;
    const context = vm.createContext({
      isIP,
      URL,
      port: 9229,
      nativeIdentity: null,
      fail: (reason) => new Error(reason),
      spawnSync: (_file, args) => {
        query = args.at(-1);
        return { status: 0, stdout: "[]" };
      },
    });
    vm.runInContext(
      `${source.slice(begin, end)}; readNativeIdentity();`,
      context,
    );
    for (const [hasRow, category, accepted] of [
      [false, "ObjectNotFound", true],
      [true, "ObjectNotFound", false],
      [true, "PermissionDenied", false],
      [false, "PermissionDenied", false],
      [true, null, true],
    ]) {
      const controlledNativeCommands = `
function Get-NetTCPConnection {
  [CmdletBinding()]
  param([string]$State, [int]$LocalPort)
  ${hasRow ? "[pscustomobject]@{LocalAddress='127.0.0.1';OwningProcess=200}" : ""}
  ${category ? `$PSCmdlet.WriteError([Management.Automation.ErrorRecord]::new([Exception]::new('fixture-only'), 'fixture-only', [Management.Automation.ErrorCategory]::${category}, $null))` : ""}
}
function Get-CimInstance {
  [CmdletBinding()]
  param([string]$ClassName, [string]$Filter)
  [pscustomobject]@{ProcessId=200;Name='ChatGPT.exe';ExecutablePath='C:\\Program Files\\WindowsApps\\OpenAI.Codex_fixture\\app\\ChatGPT.exe';CommandLine='fixture-main-shell';CreationDate=[datetime]::UtcNow}
}
`;
      const result = spawnSync(
        "pwsh",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          controlledNativeCommands + query,
        ],
        { windowsHide: true, encoding: "utf8", timeout: 2000 },
      );
      assert.equal(
        result.status === 0,
        accepted,
        `hasRow=${hasRow}, category=${category}`,
      );
      if (accepted) {
        const rows = JSON.parse(result.stdout);
        assert.equal(rows.length, hasRow ? 1 : 0);
        if (hasRow) assert.equal(rows[0].verified, true);
      }
    }
  },
);

test("CDP metadata and WebSockets stay on the selected concrete endpoint without redirects or credentials", async () => {
  const source = await readMonitorSource();
  const begin = source.indexOf("const readTargets =");
  const end = source.indexOf("const connect =", begin);
  assert.ok(begin >= 0 && end > begin);
  for (const host of ["127.0.0.1", "::1"]) {
    const authority = host === "::1" ? "[::1]" : host;
    const opposite = host === "::1" ? "127.0.0.1" : "[::1]";
    const target = (id, socket) => ({
      id,
      type: "page",
      url: "app://-/index.html",
      webSocketDebuggerUrl: socket,
    });
    const targets = [
      target("selected", `ws://${authority}:9229/devtools/page/owned`),
      target("other-address", `ws://${opposite}:9229/devtools/page/other`),
      target("dns", "ws://localhost:9229/devtools/page/dns"),
      target(
        "credentials",
        `ws://secret:token@${authority}:9229/devtools/page/auth`,
      ),
      target("empty-credentials", `ws://@${authority}:9229/devtools/page/auth`),
      target(
        "query",
        `ws://${authority}:9229/devtools/page/query?secret=token`,
      ),
      target("empty-query", `ws://${authority}:9229/devtools/page/query?`),
      target("fragment", `ws://${authority}:9229/devtools/page/hash#token`),
      target("empty-fragment", `ws://${authority}:9229/devtools/page/hash#`),
      target("external", "ws://192.0.2.1:9229/devtools/page/external"),
      target("port", `ws://${authority}:9230/devtools/page/other-port`),
      target(
        "normalized-different-authority",
        "ws://127.1:9229/devtools/page/short",
      ),
    ];
    let status = 200;
    let requests = 0;
    const context = vm.createContext({
      URL,
      nativeIdentity: { host, owners: [nativeListener(host, 200)] },
      port: 9229,
      fail: (reason) => new Error(reason),
      get: (options, receive) => {
        requests += 1;
        assert.equal(options.hostname, host);
        assert.equal(options.path, "/json");
        const request = new EventEmitter();
        request.destroy = (error) => request.emit("error", error);
        queueMicrotask(() => {
          const response = new EventEmitter();
          response.statusCode = status;
          response.setEncoding = () => {};
          receive(response);
          response.emit("data", JSON.stringify(targets));
          response.emit("end");
        });
        return request;
      },
    });
    vm.runInContext(
      `${source.slice(begin, end)}; globalThis.read = readTargets;`,
      context,
    );
    const accepted = await context.read();
    assert.deepEqual(
      Array.from(accepted, ({ id }) => id),
      ["selected"],
    );
    status = 302;
    await assert.rejects(context.read(), /target_list_invalid/);
    assert.equal(
      requests,
      2,
      "The verifier must not follow metadata redirects",
    );
  }
});

const nativeIdentityFixture = async (result) => {
  const source = await readMonitorSource();
  const begin = source.indexOf("const normalizeListenerAddress =");
  const end = source.indexOf("const checkNativeIdentity = () => {", begin);
  assert.ok(begin >= 0 && end > begin);
  let calls = 0;
  const context = vm.createContext({
    isIP,
    URL,
    nativeIdentity: null,
    port: 49152,
    nativeIdentityDiagnostic: { cause: "previous_failure" },
    fail: (code) => new Error(code),
    spawnSync(command, args, options) {
      calls += 1;
      assert.equal(command, "pwsh");
      assert.deepEqual(Array.from(args).slice(0, 3), [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
      ]);
      assert.match(
        args[3],
        /Get-NetTCPConnection -State Listen -LocalPort 49152/,
      );
      assert.match(args[3], /PSVersionTable.PSVersion.Major -ne 7/);
      assert.match(args[3], /PSVersionTable.PSVersion.Minor -lt 5/);
      assert.equal(options.windowsHide, true);
      assert.equal(options.encoding, "utf8");
      assert.equal(options.timeout, 8000);
      return result;
    },
  });
  const projection = vm.runInContext(
    source.slice(begin, end) +
      "; (() => { try { return JSON.stringify({ owners: readNativeIdentity(), diagnostic: nativeIdentityDiagnostic }); } catch (error) { return JSON.stringify({ failure: error.message, diagnostic: nativeIdentityDiagnostic }); } })()",
    context,
  );
  assert.equal(calls, 1);
  return JSON.parse(projection);
};

test("native identity failures expose only finite sanitized spawn causes without changing the shell guard", async () => {
  const secret = "private-fixture-never-reflect";
  for (const [result, cause] of [
    [
      {
        status: null,
        error: { code: "ETIMEDOUT", message: secret },
        signal: "SIGTERM",
        stderr: secret,
      },
      "timeout",
    ],
    [
      {
        status: null,
        error: { code: "ENOENT", message: secret },
        stderr: secret,
      },
      "shell_not_found",
    ],
    [
      {
        status: null,
        error: { code: "EACCES", message: secret },
        stderr: secret,
      },
      "shell_launch_failed",
    ],
    [
      { status: 1, stderr: "powershell_75_required " + secret },
      "powershell_version_required",
    ],
    [{ status: null, signal: "SIGTERM", stderr: secret }, "shell_terminated"],
    [{ status: 1, stderr: secret }, "query_failed"],
  ]) {
    const projection = await nativeIdentityFixture({
      stdout: secret,
      ...result,
    });
    assert.equal(projection.failure, "native_identity_query_failed");
    assert.deepEqual(projection.diagnostic, { cause, queryTimeoutMs: 8000 });
    assert.equal(JSON.stringify(projection).includes(secret), false);
  }
});

test("native identity diagnostic state clears on success while invalid output and owner guards remain fail closed", async () => {
  for (const stdout of ["[]"]) {
    const projection = await nativeIdentityFixture({
      status: 0,
      stdout,
      stderr: "powershell_75_required",
    });
    assert.equal(projection.owners, null);
    assert.equal(Object.hasOwn(projection, "diagnostic"), false);
  }
  const malformed = await nativeIdentityFixture({ status: 0, stdout: "{}" });
  assert.equal(malformed.failure, "native_identity_invalid");
  const invalid = await nativeIdentityFixture({
    status: 0,
    stdout: "private-malformed-fixture",
    stderr: "private-fixture",
  });
  assert.equal(invalid.failure, "native_identity_invalid");
  assert.deepEqual(invalid.diagnostic, {
    cause: "invalid_json",
    queryTimeoutMs: 8000,
  });
  assert.equal(JSON.stringify(invalid).includes("private"), false);
  for (const owner of [
    { verified: false, pid: 1, creationTicks: "1" },
    { verified: true, creationTicks: "1" },
    { verified: true, pid: 1 },
  ]) {
    const projection = await nativeIdentityFixture({
      status: 0,
      stdout: JSON.stringify([{ address: "127.0.0.1", ...owner }]),
    });
    assert.equal(projection.failure, "debug_port_owner_not_codex");
    assert.equal(Object.hasOwn(projection, "diagnostic"), false);
  }
  const owners = [
    { verified: true, pid: 2, creationTicks: "2" },
    { verified: true, pid: 1, creationTicks: "1" },
  ];
  const projection = await nativeIdentityFixture({
    status: 0,
    stdout: JSON.stringify(
      owners.map((owner) => ({ address: "127.0.0.1", ...owner })),
    ),
  });
  assert.deepEqual(
    projection.owners.owners.map(({ pid }) => pid),
    [1, 2],
  );
  assert.equal(Object.hasOwn(projection, "diagnostic"), false);
});

test("the actual monitor failure receipt attaches sanitized native identity diagnostics without Desktop actions", async () => {
  const source = await readMonitorSource();
  const begin = source.indexOf("let evidence;\ntry {");
  const end = source.indexOf("} finally {", begin);
  assert.ok(begin >= 0 && end > begin);
  const context = vm.createContext({
    run: async () => {
      throw new Error("native_identity_query_failed");
    },
    connection: undefined,
    nativeIdentityDiagnostic: { cause: "timeout", queryTimeoutMs: 8000 },
    scenario: "overload",
    stage: "readiness",
    initialRequests: 0,
    continuedRequests: 0,
    rendererOperationFailure: undefined,
    initialTurnDiagnostics: undefined,
    latestThreadDiagnostics: undefined,
    ownedThreadReadFailure: undefined,
    ownerAuditDiagnostics: undefined,
    readinessBlocker: undefined,
    readinessDiagnostics: undefined,
    creationReadinessDiagnostics: undefined,
    inspectPicker: true,
    pickerSampleCount: 1,
    pickerSampleIntervalMs: 1000,
    pickerInspection: undefined,
    pickerTargetInspections: undefined,
    sourceRuntimeInjection: undefined,
    threadId: undefined,
    testThreadCreationAttempted: false,
    threadScopeEvidence: () => ({ existingThreadsTouched: false }),
    process: { exitCode: undefined },
  });
  const evidence = await vm.runInContext(
    "(async () => {" + source.slice(begin, end + 1) + "; return evidence; })()",
    context,
  );
  assert.equal(evidence.failure, "native_identity_query_failed");
  assert.equal(evidence.nativeIdentityDiagnostic.cause, "timeout");
  assert.equal(evidence.nativeIdentityDiagnostic.queryTimeoutMs, 8000);
  assert.equal(evidence.pickerInspectionPerformed, false);
  assert.equal(evidence.renderedMenuVerified, false);
  assert.equal(evidence.existingThreadsTouched, false);
  assert.equal(evidence.temporaryDurableTestThread, false);
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
  const source = await readMonitorSource();
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
  const source = await readMonitorSource();
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
  const source = await readMonitorSource();
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
    confirmCodexContinuation: noCall,
    commitCodexContinuation: noCall,
  });
  for (const [state, blocker] of [
    [undefined, "renderer_runtime_not_installed"],
    [
      { ...healthy(), rendererRuntimeFingerprint: "other-runtime" },
      "renderer_runtime_fingerprint_mismatch",
    ],
    [
      { ...healthy(), confirmCodexContinuation: undefined },
      "renderer_continuation_api_unavailable",
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
  const source = await readMonitorSource();
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
        confirmCodexContinuation: noCall,
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

const pickerInspectionProgram = async (context) => {
  const source = await readMonitorSource();
  const begin = source.indexOf("const pickerInspectionExpression = () =>");
  const end = source.indexOf("const sourceRuntimeSnapshotExpression =", begin);
  assert.ok(
    begin >= 0 && end > begin,
    "The configured monitor needs its read-only picker program",
  );
  return vm.runInContext(
    `${source.slice(begin, end)}; pickerInspectionExpression()`,
    context,
  );
};

const pickerInspectionContext = (state, extra = {}) =>
  vm.createContext({
    patchKey: "fixture-runtime",
    expectedFingerprint: fingerprint,
    window: { "fixture-runtime": state },
    ...extra,
  });

test("picker inspection reports a stale runtime without requiring or invoking continuation APIs", async () => {
  let reads = 0;
  const state = {
    rendererRuntimeFingerprint: `sha256-${"1".repeat(64)}`,
    payload: {
      catalogAvailable: true,
      modelProvider: "private-provider",
      modelNames: ["openai/gpt-test:free", "gpt-test-sublyx"],
      models: [
        {
          model: "openai/gpt-test:free",
          supported_reasoning_levels: ["high", "max"],
        },
        {
          model: "gpt-test-sublyx",
          supportedReasoningEfforts: [
            { reasoningEffort: "max" },
            { reasoningEffort: "ultra" },
          ],
        },
      ],
    },
    readCodexModelPickerDiagnostics(options) {
      reads += 1;
      assert.equal(options.includeModelObservations, true);
      return { status: "ready", selectedMaxModelCount: 2 };
    },
    startCodexContinuation() {
      throw new Error("No continuation may run");
    },
    isCodexContinuationRequestClient() {
      throw new Error("No client lookup may run");
    },
  };
  const context = pickerInspectionContext(state);
  const result = vm.runInContext(
    await pickerInspectionProgram(context),
    context,
  );
  assert.equal(reads, 1);
  assert.equal(result.runtimeStatus, "mismatch");
  assert.equal(result.fingerprintMatches, false);
  assert.equal(result.renderedMenuVerified, false);
  assert.equal(result.modelObservations.queryRowsVerified, false);
  assert.deepEqual(JSON.parse(JSON.stringify(result.catalog.models)), [
    { model: "openai/gpt-test:free", declaredEfforts: ["high", "max"] },
    { model: "gpt-test-sublyx", declaredEfforts: ["max", "ultra"] },
  ]);
});

test("picker inspection whitelists diagnostics and model observations without reflected secrets or getter reads", async () => {
  const secret = "sk-private-fixture-not-for-evidence";
  let getterReads = 0;
  const state = {
    rendererRuntimeFingerprint: fingerprint,
    nativeReasoningVisibilityRequired: true,
    scopedAppServerScopeScanComplete: true,
    nativeReasoningVisibilityAtoms: [{}],
    scopedAppServerScopeCandidates: new Set([{}]),
    nativeReasoningVisibilityReconciliation: {
      status: "ready",
      managed: true,
      patchedScopes: 1,
      private: secret,
    },
    payload: {
      catalogAvailable: true,
      modelProvider: secret,
      modelNames: [
        "model-with-max",
        "https://private.invalid/?api_key=" + secret,
        secret,
      ],
      models: [
        {
          model: "model-with-max",
          supported_reasoning_levels: ["high", "max"],
          description: secret,
        },
      ],
      apiKey: secret,
    },
    readCodexModelPickerDiagnostics() {
      return {
        status: "ready",
        selectedMaxModelCount: 1,
        unreadableObserverCount: -4,
        private: secret,
        modelObservations: {
          renderedMenuVerified: true,
          queryRowsVerified: true,
          unavailable: false,
          truncated: false,
          unavailableReasons: [secret],
          rows: [
            {
              model: "model-with-max",
              expectedEfforts: ["high", "max"],
              observedEfforts: ["high", "max"],
              nativeVisibleEfforts: ["high", "max"],
              missingEfforts: [],
              private: secret,
            },
          ],
        },
      };
    },
  };
  Object.defineProperty(state.payload, "auth", {
    get() {
      getterReads += 1;
      throw new Error(secret);
    },
  });
  Object.defineProperty(state, "appServerClients", {
    get() {
      getterReads += 1;
      throw new Error(secret);
    },
  });
  const context = pickerInspectionContext(state);
  const result = vm.runInContext(
    await pickerInspectionProgram(context),
    context,
  );
  const encoded = JSON.stringify(result);
  assert.equal(encoded.includes(secret), false);
  assert.equal(encoded.includes("private.invalid"), false);
  assert.equal(getterReads, 0);
  assert.equal(result.renderedMenuVerified, false);
  assert.equal(result.modelObservations.renderedMenuVerified, false);
  assert.equal(result.modelObservations.queryRowsVerified, true);
  assert.equal(
    result.modelObservations.rows[0].nativeVisibleEfforts.includes("max"),
    true,
  );
  assert.equal(result.pickerDiagnostics.unreadableObserverCount, undefined);
  assert.equal(result.nativeVisibility.scopeCandidateCount, 1);
});

test("picker inspection preserves safe leading-tilde model IDs as verified query evidence", async () => {
  const modelNames = [
    "~claude-fable-5-1",
    "~openrouter/provider-model:free",
    "~" + "m".repeat(255),
  ];
  const context = pickerInspectionContext({
    rendererRuntimeFingerprint: fingerprint,
    payload: {
      catalogAvailable: true,
      modelNames,
      models: modelNames.map((model) => ({
        model,
        supported_reasoning_levels: ["high", "max"],
      })),
    },
    readCodexModelPickerDiagnostics: () => ({
      status: "ready",
      modelObservations: {
        queryRowsVerified: true,
        unavailable: false,
        rows: modelNames.map((model) => ({
          model,
          expectedEfforts: ["high", "max"],
          observedEfforts: ["high", "max"],
          nativeVisibleEfforts: ["high", "max"],
          missingEfforts: [],
        })),
      },
    }),
  });
  const result = vm.runInContext(
    await pickerInspectionProgram(context),
    context,
  );
  assert.deepEqual(
    Array.from(result.catalog.models, ({ model }) => model),
    modelNames,
  );
  assert.deepEqual(
    Array.from(result.modelObservations.rows, ({ model }) => model),
    modelNames,
  );
  assert.equal(result.modelObservations.queryRowsVerified, true);
  assert.equal(result.modelObservations.unavailable, false);
  assert.equal(result.renderedMenuVerified, false);
});

test("picker inspection rejects unsafe tilde-decorated model IDs without reflecting them", async () => {
  const unsafeNames = [
    "~sk-private-fixture",
    "~RK_private-fixture",
    "~pk-private-fixture",
    "~https://private.invalid/path",
    "~model?api_key=private-fixture",
    "~model-token=private-fixture",
    "~model-secret=private-fixture",
    "~" + "m".repeat(256),
    "~~model",
    "~",
  ];
  const modelNames = ["~safe-model", ...unsafeNames];
  const context = pickerInspectionContext({
    rendererRuntimeFingerprint: fingerprint,
    payload: {
      catalogAvailable: true,
      modelNames,
      models: modelNames.map((model) => ({
        model,
        supported_reasoning_levels: ["max"],
      })),
    },
    readCodexModelPickerDiagnostics: () => ({
      status: "ready",
      modelObservations: {
        queryRowsVerified: true,
        unavailable: false,
        rows: modelNames.map((model) => ({
          model,
          expectedEfforts: ["max"],
          observedEfforts: ["max"],
          nativeVisibleEfforts: ["max"],
          missingEfforts: [],
        })),
      },
    }),
  });
  const result = vm.runInContext(
    await pickerInspectionProgram(context),
    context,
  );
  assert.deepEqual(
    Array.from(result.catalog.models, ({ model }) => model),
    ["~safe-model"],
  );
  assert.deepEqual(
    Array.from(result.modelObservations.rows, ({ model }) => model),
    ["~safe-model"],
  );
  assert.equal(JSON.stringify(result).includes("private-fixture"), false);
  assert.equal(result.modelObservations.queryRowsVerified, false);
  assert.equal(
    result.modelObservations.unavailableReasons.includes(
      "invalid_model_observations",
    ),
    true,
  );
});
test("picker inspection redacts credential-shaped catalog model IDs without rejecting supported model ID lengths", async () => {
  const credentialNames = ["sk", "SK", "rk", "RK", "pk", "PK"].flatMap(
    (prefix) =>
      ["-", "_"].map((separator) => prefix + separator + "private_fixture"),
  );
  const supportedName = "m".repeat(256);
  const modelNames = ["safe-model", supportedName, ...credentialNames];
  const context = pickerInspectionContext({
    rendererRuntimeFingerprint: fingerprint,
    payload: {
      catalogAvailable: true,
      modelNames,
      models: modelNames.map((model) => ({
        model,
        supported_reasoning_levels: ["max"],
      })),
    },
    readCodexModelPickerDiagnostics: () => ({
      status: "ready",
      modelObservations: {
        queryRowsVerified: true,
        unavailable: false,
        rows: modelNames.map((model) => ({
          model,
          expectedEfforts: ["max"],
          observedEfforts: ["max"],
          nativeVisibleEfforts: ["max"],
          missingEfforts: [],
        })),
      },
    }),
  });
  const result = vm.runInContext(
    await pickerInspectionProgram(context),
    context,
  );
  const encoded = JSON.stringify(result);
  for (const name of credentialNames)
    assert.equal(encoded.includes(name), false);
  assert.equal(
    result.catalog.models.some(({ model }) => model === supportedName),
    true,
  );
  assert.equal(
    result.modelObservations.rows.some(({ model }) => model === supportedName),
    true,
  );
  assert.equal(result.modelObservations.queryRowsVerified, false);
});

test("picker inspection never certifies retained query rows when the canonical catalog is unavailable", async () => {
  for (const catalogAvailable of [false, undefined]) {
    const payload = {
      modelNames: ["safe-model"],
      models: [{ model: "safe-model", supported_reasoning_levels: ["max"] }],
    };
    if (catalogAvailable !== undefined)
      payload.catalogAvailable = catalogAvailable;
    const context = pickerInspectionContext({
      rendererRuntimeFingerprint: fingerprint,
      payload,
      readCodexModelPickerDiagnostics: () => ({
        status: "ready",
        modelObservations: {
          queryRowsVerified: true,
          unavailable: false,
          rows: [
            {
              model: "safe-model",
              expectedEfforts: ["max"],
              observedEfforts: ["max"],
              nativeVisibleEfforts: ["max"],
              missingEfforts: [],
            },
          ],
        },
      }),
    });
    const result = vm.runInContext(
      await pickerInspectionProgram(context),
      context,
    );
    assert.equal(result.catalog.available, false);
    assert.equal(
      result.modelObservations.rows.length,
      1,
      "Sanitized retained snapshot remains telemetry only",
    );
    assert.equal(result.modelObservations.queryRowsVerified, false);
    assert.equal(result.modelObservations.unavailable, true);
    assert.equal(
      result.modelObservations.unavailableReasons.includes(
        "catalog_unavailable",
      ),
      true,
    );
    assert.equal(result.nativeVisibility.ownershipStatus, "unverified");
  }
});

test("picker inspection rejects contradictory excluded and duplicate catalog selections as observation proof", async () => {
  for (const models of [
    [{ model: "excluded-model", enabled: false }],
    [{ model: "excluded-model" }, { model: "excluded-model" }],
  ]) {
    const context = pickerInspectionContext({
      rendererRuntimeFingerprint: fingerprint,
      payload: {
        catalogAvailable: true,
        modelNames: ["excluded-model"],
        models,
      },
      readCodexModelPickerDiagnostics: () => ({
        status: "ready",
        modelObservations: {
          queryRowsVerified: true,
          unavailable: false,
          rows: [
            {
              model: "excluded-model",
              expectedEfforts: ["max"],
              observedEfforts: ["max"],
              nativeVisibleEfforts: ["max"],
              missingEfforts: [],
            },
          ],
        },
      }),
    });
    const result = vm.runInContext(
      await pickerInspectionProgram(context),
      context,
    );
    assert.equal(result.catalog.models.length, 0);
    assert.equal(result.modelObservations.rows.length, 0);
    assert.equal(result.modelObservations.queryRowsVerified, false);
  }
});

test("picker inspection whitelists finite native reconciliation refusal evidence without secrets, getters or inflated counts", async () => {
  const secret = "private-reconciliation-fixture";
  for (const [
    refusalReason,
    ownerScopeCount,
    expectedReason,
    expectedCount,
  ] of [
    [
      "renderer_scope_snapshot_unverified",
      2048,
      "renderer_scope_snapshot_unverified",
      2048,
    ],
    [null, 0, null, 0],
    [secret, 2049, undefined, undefined],
  ]) {
    let getterReads = 0;
    const ownerFailureCounts = {
      scope_contract: 1,
      node_unavailable: 0,
      scope_read_failed: 2,
      inventory_read_failed: secret,
      private: secret,
    };
    Object.defineProperty(ownerFailureCounts, "client_mismatch", {
      get() {
        getterReads += 1;
        throw new Error(secret);
      },
    });
    const context = pickerInspectionContext({
      rendererRuntimeFingerprint: fingerprint,
      payload: { catalogAvailable: true, modelNames: [], models: [] },
      nativeReasoningVisibilityReconciliation: {
        status: refusalReason === null ? "known" : "unverified",
        managed: false,
        refusalReason,
        ownerScopeCount,
        ownerFailureCounts,
        private: secret,
      },
      readCodexModelPickerDiagnostics: () => ({ status: "unverified" }),
    });
    const result = vm.runInContext(
      await pickerInspectionProgram(context),
      context,
    );
    const evidence = result.nativeVisibility.reconciliation;
    assert.equal(evidence.refusalReason, expectedReason);
    assert.equal(
      evidence.status,
      refusalReason === null ? "known" : "unverified",
    );
    assert.equal(evidence.ownerScopeCount, expectedCount);
    assert.deepEqual(JSON.parse(JSON.stringify(evidence.ownerFailureCounts)), {
      scope_contract: 1,
      node_unavailable: 0,
    });
    assert.equal(getterReads, 0);
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(result.modelObservations.queryRowsVerified, false);
    assert.equal(result.renderedMenuVerified, false);
  }
});

test("picker inspection preserves fixed-enum current and settled cap reasons", async () => {
  for (const reason of [
    "value_limit",
    "object_limit",
    "field_limit",
    "fiber_limit",
  ]) {
    const context = pickerInspectionContext({
      rendererRuntimeFingerprint: fingerprint,
      scopedAppServerScopeScan: { status: "capped", reason },
      scopedAppServerScopeLastSettledScan: { status: "capped", reason },
    });
    const result = vm.runInContext(
      await pickerInspectionProgram(context),
      context,
    );
    assert.equal(result.nativeVisibility.scopeScan.reason, reason);
    assert.equal(result.nativeVisibility.lastSettledScopeScan.reason, reason);
    assert.equal(result.renderedMenuVerified, false);
  }
});

test("picker inspection preserves bounded canonical owner diagnostics without certifying ownership", async () => {
  for (const reason of [
    null,
    "unavailable",
    "atoms_unverified",
    "pending_nodes",
    "roots_unavailable",
    "hints_read_failed",
    "snapshot_changed",
    "hints_ambiguous",
    "hints_incomplete",
    "hint_count_mismatch",
    "scope_unmounted",
    "scope_cache_unverified",
  ]) {
    const counts = {
      appServerStatusAtomCount: 17,
      uniqueBrandCount: 16,
      hintCount: 17,
      pendingNodeCount: 30000,
    };
    const context = pickerInspectionContext({
      rendererRuntimeFingerprint: fingerprint,
      nativeReasoningVisibilityReconciliation: {
        status: "unverified",
        canonicalOwnerCounts: counts,
        canonicalOwnerRefusalReason: reason,
        ownerFailureCounts: {
          canonical_owner_unavailable: 0,
          canonical_owner_unverified: 1,
        },
      },
    });
    const result = vm.runInContext(
      await pickerInspectionProgram(context),
      context,
    );
    const evidence = result.nativeVisibility.reconciliation;
    assert.deepEqual(
      JSON.parse(JSON.stringify(evidence.canonicalOwnerCounts)),
      counts,
    );
    assert.equal(evidence.canonicalOwnerRefusalReason, reason);
    assert.deepEqual(JSON.parse(JSON.stringify(evidence.ownerFailureCounts)), {
      canonical_owner_unavailable: 0,
      canonical_owner_unverified: 1,
    });
    assert.equal(result.nativeVisibility.ownershipStatus, "unverified");
    assert.equal(result.renderedMenuVerified, false);
  }
});

test("picker inspection filters malformed canonical diagnostics without getter reads or secrets", async () => {
  const secret = "private-canonical-owner-fixture";
  let reads = 0;
  const counts = {
    appServerStatusAtomCount: 18,
    uniqueBrandCount: -1,
    hintCount: 1.5,
    pendingNodeCount: 30001,
    private: secret,
  };
  Object.defineProperty(counts, "hintCount", {
    get() {
      reads += 1;
      throw new Error(secret);
    },
  });
  const failures = {
    canonical_owner_unavailable: 2,
    canonical_owner_unverified: secret,
    private: secret,
  };
  for (const invalidCounts of [
    counts,
    Object.create({ uniqueBrandCount: 1 }),
    [],
    null,
  ]) {
    const context = pickerInspectionContext({
      rendererRuntimeFingerprint: fingerprint,
      scopedAppServerScopeScan: { status: "capped", reason: secret },
      scopedAppServerScopeLastSettledScan: { status: "capped", reason: secret },
      nativeReasoningVisibilityReconciliation: {
        canonicalOwnerCounts: invalidCounts,
        canonicalOwnerRefusalReason: secret,
        ownerFailureCounts: failures,
      },
    });
    const result = vm.runInContext(
      await pickerInspectionProgram(context),
      context,
    );
    const evidence = result.nativeVisibility.reconciliation;
    assert.equal(evidence.canonicalOwnerRefusalReason, undefined);
    assert.deepEqual(
      JSON.parse(JSON.stringify(evidence.canonicalOwnerCounts ?? {})),
      {},
    );
    assert.deepEqual(
      JSON.parse(JSON.stringify(evidence.ownerFailureCounts)),
      {},
    );
    assert.equal(result.nativeVisibility.scopeScan.reason, undefined);
    assert.equal(
      result.nativeVisibility.lastSettledScopeScan.reason,
      undefined,
    );
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
  assert.equal(reads, 0);
});

test("picker inspection reports only public scheduler capability booleans without invoking them", async () => {
  let calls = 0;
  const forbidden = () => {
    calls += 1;
    throw new Error("No scheduler may be invoked");
  };
  for (const [scheduler, MessageChannel, expected] of [
    [
      { yield: forbidden },
      forbidden,
      { schedulerYieldAvailable: true, messageChannelAvailable: true },
    ],
    [
      { yield: "private-scheduler-fixture" },
      "private-channel-fixture",
      { schedulerYieldAvailable: false, messageChannelAvailable: false },
    ],
  ]) {
    const context = pickerInspectionContext(
      { rendererRuntimeFingerprint: fingerprint },
      { scheduler, MessageChannel },
    );
    const result = vm.runInContext(
      await pickerInspectionProgram(context),
      context,
    );
    assert.deepEqual(
      JSON.parse(JSON.stringify(result.nativeVisibility.schedulerCapabilities)),
      expected,
    );
    assert.equal(
      JSON.stringify(result).includes("private-scheduler-fixture"),
      false,
    );
    assert.equal(
      JSON.stringify(result).includes("private-channel-fixture"),
      false,
    );
    assert.equal(result.renderedMenuVerified, false);
  }
  assert.equal(calls, 0);
});

test("picker inspection omits accessor-backed scheduler capabilities without invoking getters", async () => {
  let getterReads = 0;
  const context = pickerInspectionContext({
    rendererRuntimeFingerprint: fingerprint,
  });
  for (const key of ["scheduler", "MessageChannel"])
    Object.defineProperty(context, key, {
      get() {
        getterReads += 1;
        throw new Error("private-scheduler-accessor");
      },
    });
  const result = vm.runInContext(
    await pickerInspectionProgram(context),
    context,
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(result.nativeVisibility.schedulerCapabilities)),
    {},
  );
  assert.equal(getterReads, 0);
  assert.equal(
    JSON.stringify(result).includes("private-scheduler-accessor"),
    false,
  );
});

test("picker inspection retains sanitized last-settled scan evidence while the active scan is scanning", async () => {
  for (const reason of [
    "exact_root",
    "fiber_snapshot",
    "object_snapshot",
    "object_read",
    "mutation_generation",
    "pending_nodes",
    "object_limit",
    "field_limit",
    "fiber_limit",
    "private-settled-reason",
  ]) {
    const terminal = {
      status: "invalidated",
      visitedFiberCount: 120,
      fiberLimit: 30000,
      scopeCount: 24,
      elapsedMs: 5,
      reason,
      private: "private-settled-scan",
    };
    const context = pickerInspectionContext({
      rendererRuntimeFingerprint: fingerprint,
      scopedAppServerScopeScan: {
        status: "scanning",
        visitedFiberCount: 1,
        fiberLimit: 30000,
        scopeCount: 0,
        elapsedMs: 0,
      },
      scopedAppServerScopeLastSettledScan: terminal,
    });
    const result = vm.runInContext(
      await pickerInspectionProgram(context),
      context,
    );
    assert.equal(result.nativeVisibility.scopeScan.status, "scanning");
    assert.deepEqual(
      JSON.parse(JSON.stringify(result.nativeVisibility.lastSettledScopeScan)),
      {
        status: "invalidated",
        visitedFiberCount: 120,
        fiberLimit: 30000,
        scopeCount: 24,
        elapsedMs: 5,
        ...(reason.startsWith("private") ? {} : { reason }),
      },
    );
    assert.equal(JSON.stringify(result).includes("private-settled"), false);
    assert.equal(result.renderedMenuVerified, false);
  }
});

test("picker inspection sanitizes bounded scope scan telemetry without secrets or getter reads", async () => {
  const secret = "private-scope-scan-fixture";
  const validScan = {
    status: "complete",
    visitedFiberCount: 30000,
    fiberLimit: 30000,
    scopeCount: 100000,
    elapsedMs: 900000,
  };
  let getterReads = 0;
  const accessorScan = Object.fromEntries(
    Object.keys(validScan).map((key) => [key, undefined]),
  );
  for (const key of Object.keys(validScan)) {
    Object.defineProperty(accessorScan, key, {
      get() {
        getterReads += 1;
        throw new Error(secret);
      },
    });
  }
  const cases = [
    ...[
      "scanning",
      "complete",
      "capped",
      "root_unavailable",
      "invalidated",
    ].map((status) => [
      { ...validScan, status, private: secret },
      { ...validScan, status },
    ]),
    [
      {
        status: "scanning",
        visitedFiberCount: 0,
        fiberLimit: 30000,
        scopeCount: 0,
        elapsedMs: 0,
      },
      {
        status: "scanning",
        visitedFiberCount: 0,
        fiberLimit: 30000,
        scopeCount: 0,
        elapsedMs: 0,
      },
    ],
    [
      { ...validScan, elapsedMs: 0.5 },
      { ...validScan, elapsedMs: 0.5 },
    ],
    [
      {
        status: secret,
        visitedFiberCount: 30001,
        fiberLimit: 29999,
        scopeCount: 100001,
        elapsedMs: 900001,
        private: secret,
      },
      {},
    ],
    [
      {
        status: secret,
        visitedFiberCount: -1,
        fiberLimit: "30000",
        scopeCount: -1,
        elapsedMs: -1,
      },
      {},
    ],
    [
      {
        status: secret,
        visitedFiberCount: 1.5,
        fiberLimit: Infinity,
        scopeCount: 1.5,
        elapsedMs: NaN,
      },
      {},
    ],
    [
      {
        status: secret,
        visitedFiberCount: "1",
        fiberLimit: 30001,
        scopeCount: "1",
        elapsedMs: Infinity,
      },
      {},
    ],
    [accessorScan, {}],
    [Object.create(validScan), {}],
    [undefined, undefined],
    [null, undefined],
    [[validScan], undefined],
  ];
  for (const [scan, expected] of cases) {
    const context = pickerInspectionContext({
      rendererRuntimeFingerprint: fingerprint,
      payload: { catalogAvailable: true, modelNames: [], models: [] },
      scopedAppServerScopeScan: scan,
      readCodexModelPickerDiagnostics: () => ({ status: "unverified" }),
    });
    const result = vm.runInContext(
      await pickerInspectionProgram(context),
      context,
    );
    assert.deepEqual(
      result.nativeVisibility.scopeScan === undefined
        ? undefined
        : JSON.parse(JSON.stringify(result.nativeVisibility.scopeScan)),
      expected,
    );
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(result.modelObservations.queryRowsVerified, false);
    assert.equal(result.renderedMenuVerified, false);
  }
  assert.equal(getterReads, 0);
});
const nativeEffortLabelSelector =
  "span[data-reasoning-effort][data-max-effort]";
const nativeEffortLabelNode = (document, effort, text, opacity, extra = {}) =>
  Object.defineProperties(
    {
      ownerDocument: document,
      isConnected: true,
      textContent: text,
      opacity,
      getAttribute(name) {
        if (name === "class")
          return "native-other ModelPickerTriggerEffortText-module__fixture";
        if (name === "data-reasoning-effort") return effort;
        throw new Error("Only bounded effort-label fields may be read");
      },
    },
    Object.getOwnPropertyDescriptors(extra),
  );

test("picker inspection emits only mounted native effort enums, fixed label matches and opacity states", async () => {
  const secret = "private-label-fixture-never-reflect";
  const document = {
    querySelectorAll(selector) {
      assert.equal(selector, nativeEffortLabelSelector);
      return nodes;
    },
  };
  let unrelatedTextReads = 0;
  const nodes = [
    ...[
      ["none", "None", "0"],
      ["minimal", "Minimal", "1"],
      ["low", "Low", "1"],
      ["medium", "Medium", "1"],
      ["high", "High", "1"],
      ["xhigh", "Extra high", "1"],
      ["max", "Max", "1"],
      ["ultra", "Ultra", "1"],
    ].map(([effort, text, opacity]) =>
      nativeEffortLabelNode(document, effort, text, opacity),
    ),
    nativeEffortLabelNode(document, "max", secret, "0.5"),
    nativeEffortLabelNode(document, secret, secret, "1", {
      get textContent() {
        unrelatedTextReads += 1;
        throw new Error(secret);
      },
    }),
    nativeEffortLabelNode(document, "max", secret, "1", {
      getAttribute(name) {
        assert.equal(name, "class");
        return "unrelated-ModelPickerTriggerEffortText";
      },
      get textContent() {
        unrelatedTextReads += 1;
        throw new Error(secret);
      },
    }),
    nativeEffortLabelNode(document, "max", secret, "1", {
      isConnected: false,
      get textContent() {
        unrelatedTextReads += 1;
        throw new Error(secret);
      },
    }),
  ];
  const context = pickerInspectionContext(
    {
      rendererRuntimeFingerprint: fingerprint,
      payload: { catalogAvailable: true, modelNames: [], models: [] },
      readCodexModelPickerDiagnostics: () => ({ status: "unverified" }),
    },
    {
      document,
      getComputedStyle: (node) => ({ opacity: node.opacity }),
    },
  );
  const result = vm.runInContext(
    await pickerInspectionProgram(context),
    context,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(result.mountedReasoningLabels)), {
    available: true,
    truncated: false,
    renderedMenuVerified: false,
    rows: [
      ...[
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
        "ultra",
      ].map((effort) => ({
        effort,
        labelMatches: true,
        opacityState: effort === "none" ? "zero" : "one",
      })),
      { effort: "max", labelMatches: false, opacityState: "other" },
    ],
  });
  assert.equal(unrelatedTextReads, 0);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(result.renderedMenuVerified, false);
  assert.equal(result.modelObservations.queryRowsVerified, false);
});

test("picker inspection caps native mounted effort-label evidence at 64 without reading later nodes", async () => {
  const document = {
    querySelectorAll(selector) {
      assert.equal(selector, nativeEffortLabelSelector);
      return nodes;
    },
  };
  const nodes = Array.from({ length: 64 }, () =>
    nativeEffortLabelNode(document, "max", "Max", "1"),
  );
  let laterReads = 0;
  nodes.push({
    get isConnected() {
      laterReads += 1;
      throw new Error("The 65th label must not be inspected");
    },
  });
  const context = pickerInspectionContext(
    { rendererRuntimeFingerprint: fingerprint },
    { document, getComputedStyle: () => ({ opacity: "1" }) },
  );
  const result = vm.runInContext(
    await pickerInspectionProgram(context),
    context,
  );
  assert.equal(result.mountedReasoningLabels.available, true);
  assert.equal(result.mountedReasoningLabels.truncated, true);
  assert.equal(result.mountedReasoningLabels.rows.length, 64);
  assert.equal(laterReads, 0);
  assert.equal(result.mountedReasoningLabels.renderedMenuVerified, false);
  assert.equal(result.renderedMenuVerified, false);
});

test("picker inspection leaves mounted effort-label evidence unavailable when the document or selector is unavailable", async () => {
  const secret = "private-selector-fixture-never-reflect";
  for (const document of [
    undefined,
    {},
    {
      querySelectorAll() {
        throw new Error(secret);
      },
    },
  ]) {
    const context = pickerInspectionContext(
      { rendererRuntimeFingerprint: fingerprint },
      { document },
    );
    const result = vm.runInContext(
      await pickerInspectionProgram(context),
      context,
    );
    assert.deepEqual(
      JSON.parse(JSON.stringify(result.mountedReasoningLabels)),
      {
        available: false,
        truncated: false,
        renderedMenuVerified: false,
        rows: [],
      },
    );
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(result.renderedMenuVerified, false);
  }
});
const nativePowerFixture = (modelNames = ["~safe-model", "other-model"]) => {
  const labels = [];
  const document = {
    querySelectorAll(selector) {
      assert.equal(selector, nativeEffortLabelSelector);
      return labels;
    },
  };
  let handlerCalls = 0;
  const props = {
    selectedLabelCandidate: {
      model: "~safe-model",
      reasoningEffort: "high",
      modelLabel: "private-model-label-never-reflect",
    },
    onSelectPower() {
      handlerCalls += 1;
      throw new Error("No source selection callback may run");
    },
    powerSelections: [
      { model: "~safe-model", reasoningEffort: "high", isLocked: false },
      { model: "~safe-model", reasoningEffort: "max", isLocked: false },
      { model: "~safe-model", reasoningEffort: "ultra", isLocked: true },
    ],
    triggerConfig: {},
  };
  const addButton = () => {
    const button = { isConnected: true, ownerDocument: document };
    const rootState = {
      current: undefined,
      containerInfo: {
        isConnected: true,
        contains: (node) => node === button,
      },
    };
    const root = { tag: 3, stateNode: rootState, return: null };
    const owner = { memoizedProps: props, return: root };
    const host = { stateNode: button, return: owner };
    owner.child = host;
    root.child = owner;
    rootState.current = root;
    button.__reactFiberFixture = host;
    labels.push(
      nativeEffortLabelNode(document, "max", "Max", "0", {
        closest(selector) {
          assert.equal(selector, "button");
          return button;
        },
      }),
    );
    return { button, host, owner, root, rootState };
  };
  const tree = addButton();
  const context = pickerInspectionContext(
    {
      rendererRuntimeFingerprint: fingerprint,
      payload: {
        catalogAvailable: true,
        modelNames,
        models: modelNames.map((model) => ({
          model,
          supported_reasoning_levels: ["high", "max", "ultra"],
        })),
      },
      readCodexModelPickerDiagnostics: () => ({ status: "unverified" }),
    },
    { document, getComputedStyle: () => ({ opacity: "0" }) },
  );
  let program;
  return {
    ...tree,
    props,
    labels,
    addButton,
    context,
    handlerCalls: () => handlerCalls,
    read: async () => {
      program ??= await pickerInspectionProgram(context);
      return vm.runInContext(program, context);
    },
  };
};

test("picker inspection proves a current native Max option from existing props rather than animated label text", async () => {
  const fixture = nativePowerFixture();
  const result = await fixture.read();
  assert.deepEqual(JSON.parse(JSON.stringify(result.nativePowerSelections)), {
    available: true,
    truncated: false,
    renderedMenuVerified: false,
    selectedModel: "~safe-model",
    selectedEffort: "high",
    rows: [
      { model: "~safe-model", effort: "high", isLocked: false },
      { model: "~safe-model", effort: "max", isLocked: false },
      { model: "~safe-model", effort: "ultra", isLocked: true },
    ],
  });
  assert.equal(fixture.handlerCalls(), 0);
  assert.equal(result.renderedMenuVerified, false);
  delete fixture.props.selectedLabelCandidate.reasoningEffort;
  const presetResult = await fixture.read();
  assert.equal(presetResult.nativePowerSelections.available, true);
  assert.equal(presetResult.nativePowerSelections.selectedEffort, undefined);
});

test("picker inspection reads Max from current native power props without invoking source callbacks or reflecting unsafe rows", async () => {
  const secret = "sk-private-power-fixture";
  const fixture = nativePowerFixture(["~safe-model", "other-model", secret]);
  let getterReads = 0;
  const accessorRow = { reasoningEffort: "max", isLocked: false };
  Object.defineProperty(accessorRow, "model", {
    get() {
      getterReads += 1;
      throw new Error(secret);
    },
  });
  fixture.props.powerSelections.push(
    { model: "other-model", reasoningEffort: "max", isLocked: true },
    { model: secret, reasoningEffort: "max", isLocked: false },
    {
      model: "not-currently-included",
      reasoningEffort: "max",
      isLocked: false,
    },
    { model: "~safe-model", reasoningEffort: secret, isLocked: false },
    { model: "~safe-model", reasoningEffort: "low", isLocked: secret },
    accessorRow,
  );
  // Animated effort spans share one button/props owner, not multiple owners.
  fixture.labels.push(fixture.labels[0]);
  const result = await fixture.read();
  assert.deepEqual(JSON.parse(JSON.stringify(result.nativePowerSelections)), {
    available: false,
    truncated: false,
    renderedMenuVerified: false,
    refusalReasons: ["unsafe_selection_rows"],
    selectedModel: "~safe-model",
    selectedEffort: "high",
    rows: [
      { model: "~safe-model", effort: "high", isLocked: false },
      { model: "~safe-model", effort: "max", isLocked: false },
      { model: "~safe-model", effort: "ultra", isLocked: true },
      { model: "other-model", effort: "max", isLocked: true },
      { model: "~safe-model", effort: "low" },
    ],
  });
  assert.equal(fixture.handlerCalls(), 0);
  assert.equal(getterReads, 0);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(
    JSON.stringify(result).includes("private-model-label-never-reflect"),
    false,
  );
  assert.equal(result.renderedMenuVerified, false);
  assert.equal(result.modelObservations.queryRowsVerified, false);
});

test("picker inspection requires one exact current React branch and one native power props owner", async () => {
  for (const mutate of [
    (f) => {
      f.owner.child = { return: f.owner };
    },
    (f) => {
      f.rootState.current = { tag: 3 };
    },
    (f) => {
      f.rootState.containerInfo.contains = () => false;
    },
    (f) => {
      f.button.__reactInternalInstanceOther = f.host;
    },
    (f) => {
      f.root.memoizedProps = f.props;
    },
    (f) => {
      const alternate = { stateNode: f.button, return: f.owner };
      f.host.alternate = alternate;
      f.host.sibling = alternate;
    },
    (f) => {
      f.props.selectedLabelCandidate.model = "sk-private-selected-fixture";
    },
    (f) => {
      f.props.selectedLabelCandidate.reasoningEffort = "private-effort-fixture";
    },
  ]) {
    const fixture = nativePowerFixture();
    mutate(fixture);
    const result = await fixture.read();
    assert.equal(result.nativePowerSelections.available, false);
    assert.equal(result.nativePowerSelections.rows.length, 0);
    assert.equal(result.nativePowerSelections.selectedModel, undefined);
    assert.equal(result.nativePowerSelections.selectedEffort, undefined);
    assert.equal(
      JSON.stringify(result).includes("private-selected-fixture"),
      false,
    );
    assert.equal(
      JSON.stringify(result).includes("private-effort-fixture"),
      false,
    );
    assert.equal(fixture.handlerCalls(), 0);
    assert.equal(result.renderedMenuVerified, false);
  }
  const fixture = nativePowerFixture();
  const alternate = { stateNode: fixture.button, return: fixture.owner };
  fixture.host.alternate = alternate;
  fixture.owner.child = alternate;
  const result = await fixture.read();
  assert.equal(result.nativePowerSelections.available, true);
  assert.equal(
    result.nativePowerSelections.rows.some((row) => row.effort === "max"),
    true,
  );
});

test("picker inspection keeps native power evidence bounded at every traversal and array boundary", async () => {
  for (const [mutate, truncated] of [
    [
      (f) => {
        let child = f.host;
        // Host + 1022 ancestors + owner + root = 1025: one beyond the limit.
        for (let index = 0; index < 1022; index += 1) {
          const parent = { child, return: f.owner };
          child.return = parent;
          child = parent;
        }
        f.owner.child = child;
      },
      true,
    ],
    [
      (f) => {
        let child = f.host;
        for (let index = 0; index < 512; index += 1)
          child = { sibling: child, return: f.owner };
        f.owner.child = child;
      },
      true,
    ],
    [
      (f) => {
        f.props.powerSelections = Array.from({ length: 513 }, () => ({
          model: "~safe-model",
          reasoningEffort: "max",
          isLocked: false,
        }));
      },
      true,
    ],
    [
      (f) => {
        for (let index = 0; index < 8; index += 1) f.addButton();
      },
      true,
    ],
  ]) {
    const fixture = nativePowerFixture();
    mutate(fixture);
    const result = await fixture.read();
    assert.equal(result.nativePowerSelections.available, false);
    assert.equal(result.nativePowerSelections.truncated, truncated);
    assert.equal(result.nativePowerSelections.rows.length, 0);
    assert.equal(fixture.handlerCalls(), 0);
    assert.equal(result.renderedMenuVerified, false);
  }
});

test("picker inspection reports finite native power truncation and refusal reasons without reflecting source values", async () => {
  for (const [mutate, reason] of [
    [
      (f) => {
        let child = f.host;
        // Host + 1022 ancestors + owner + root = 1025: one beyond the limit.
        for (let index = 0; index < 1022; index += 1) {
          const parent = { child, return: f.owner };
          child.return = parent;
          child = parent;
        }
        f.owner.child = child;
      },
      "fiber_limit",
    ],
    [
      (f) => {
        let child = f.host;
        for (let index = 0; index < 512; index += 1)
          child = { sibling: child, return: f.owner };
        f.owner.child = child;
      },
      "sibling_limit",
    ],
    [
      (f) => {
        f.props.powerSelections = Array.from({ length: 513 }, () => ({
          model: "~safe-model",
          reasoningEffort: "max",
          isLocked: false,
        }));
      },
      "selection_limit",
    ],
    [
      (f) => {
        for (let index = 0; index < 8; index += 1) f.addButton();
      },
      "button_limit",
    ],
    [
      (f) => {
        while (f.labels.length < 65) f.labels.push(f.labels[0]);
      },
      "label_limit",
    ],
  ]) {
    const fixture = nativePowerFixture();
    mutate(fixture);
    const result = await fixture.read();
    assert.equal(result.nativePowerSelections.available, false);
    assert.equal(result.nativePowerSelections.truncated, true);
    assert.deepEqual(
      Array.from(result.nativePowerSelections.truncationReasons || []),
      [reason],
    );
    assert.equal(
      result.nativePowerSelections.refusalReasons.includes("inspection_capped"),
      true,
    );
    assert.equal(result.renderedMenuVerified, false);
  }
  const fixture = nativePowerFixture();
  fixture.owner.child = {
    private: "private-power-path-fixture-never-reflect",
  };
  const result = await fixture.read();
  assert.deepEqual(
    Array.from(result.nativePowerSelections.refusalReasons || []),
    ["child_edge_unverified"],
  );
  assert.equal(result.nativePowerSelections.truncationReasons, undefined);
  assert.equal(
    JSON.stringify(result).includes("private-power-path-fixture-never-reflect"),
    false,
  );
});

test("picker inspection accepts a legitimate 300-fiber current native ancestry without weakening exact ownership", async () => {
  const fixture = nativePowerFixture();
  let child = fixture.host;
  for (let index = 0; index < 297; index += 1) {
    const parent = { child, return: fixture.owner };
    child.return = parent;
    child = parent;
  }
  fixture.owner.child = child;
  const result = await fixture.read();
  assert.equal(result.nativePowerSelections.available, true);
  assert.equal(result.nativePowerSelections.truncated, false);
  assert.equal(
    result.nativePowerSelections.rows.some((row) => row.effort === "max"),
    true,
  );
  assert.equal(fixture.handlerCalls(), 0);
  assert.equal(result.renderedMenuVerified, false);
});

test("monitor and production native current-path ancestry limits share the same compatibility contract", async () => {
  const runtimeSource = await readFile(
    new URL(
      "../src-tauri/src/resources/codex_desktop/native_boolean_reasoning.js",
      import.meta.url,
    ),
    "utf8",
  );
  const monitorSource = await readMonitorSource();
  const declaration =
    /const CODEX_NATIVE_CURRENT_FIBER_PATH_LIMIT\s*=\s*(\d+)\s*;/;
  const runtimeLimit = runtimeSource.match(declaration)?.[1];
  const monitorLimit = monitorSource.match(declaration)?.[1];
  assert.equal(runtimeLimit, "1024");
  assert.equal(monitorLimit, runtimeLimit);
  assert.match(runtimeSource, /depth < CODEX_NATIVE_CURRENT_FIBER_PATH_LIMIT/);
  assert.match(monitorSource, /depth < CODEX_NATIVE_CURRENT_FIBER_PATH_LIMIT/);
});

test("picker inspection accepts native power evidence exactly at its finite traversal and array caps", async () => {
  for (const mutate of [
    (f) => {
      let child = f.host;
      // Host + 1021 ancestors + owner + root = exactly 1024: inclusive limit.
      for (let index = 0; index < 1021; index += 1) {
        const parent = { child, return: f.owner };
        child.return = parent;
        child = parent;
      }
      f.owner.child = child;
    },
    (f) => {
      let child = f.host;
      for (let index = 0; index < 511; index += 1)
        child = { sibling: child, return: f.owner };
      f.owner.child = child;
    },
    (f) => {
      f.props.powerSelections = Array.from({ length: 512 }, () => ({
        model: "~safe-model",
        reasoningEffort: "max",
        isLocked: false,
      }));
    },
    (f) => {
      for (let index = 0; index < 7; index += 1) f.addButton();
    },
  ]) {
    const fixture = nativePowerFixture();
    mutate(fixture);
    const result = await fixture.read();
    assert.equal(result.nativePowerSelections.available, true);
    assert.equal(result.nativePowerSelections.truncated, false);
    assert.equal(fixture.handlerCalls(), 0);
    assert.equal(result.renderedMenuVerified, false);
  }
});

test("picker inspection never invokes native power props, candidate, or array accessors", async () => {
  const secret = "private-power-accessor-fixture";
  for (const mutate of [
    (f, getter) =>
      Object.defineProperty(f.props, "powerSelections", { get: getter }),
    (f, getter) =>
      Object.defineProperty(f.props, "onSelectPower", { get: getter }),
    (f, getter) =>
      Object.defineProperty(f.props.selectedLabelCandidate, "reasoningEffort", {
        get: getter,
      }),
    (f, getter) =>
      Object.defineProperty(f.props.powerSelections, "0", { get: getter }),
    (f, getter) =>
      Object.defineProperty(f.props.powerSelections[0], "isLocked", {
        get: getter,
      }),
    (f, getter) =>
      Object.defineProperty(f.owner, "memoizedProps", { get: getter }),
  ]) {
    const fixture = nativePowerFixture();
    let getterReads = 0;
    mutate(fixture, () => {
      getterReads += 1;
      throw new Error(secret);
    });
    const result = await fixture.read();
    assert.equal(result.nativePowerSelections.available, false);
    assert.equal(getterReads, 0);
    assert.equal(fixture.handlerCalls(), 0);
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(result.renderedMenuVerified, false);
  }
});

test("picker inspection leaves missing and empty native observation evidence explicitly unverified", async () => {
  for (const diagnostics of [
    { status: "ready" },
    {
      status: "ready",
      modelObservations: {
        queryRowsVerified: true,
        rows: [],
        unavailable: false,
      },
    },
    {
      status: "ready",
      modelObservations: {
        queryRowsVerified: true,
        rows: [
          {
            model: "model",
            expectedEfforts: ["max"],
            observedEfforts: ["secret"],
            nativeVisibleEfforts: ["max"],
            missingEfforts: [],
          },
        ],
      },
    },
  ]) {
    const context = pickerInspectionContext({
      rendererRuntimeFingerprint: fingerprint,
      payload: { catalogAvailable: true, modelNames: [], models: [] },
      readCodexModelPickerDiagnostics: () => diagnostics,
    });
    const result = vm.runInContext(
      await pickerInspectionProgram(context),
      context,
    );
    assert.equal(result.modelObservations.queryRowsVerified, false);
    assert.equal(result.modelObservations.unavailable, true);
    assert.equal(result.renderedMenuVerified, false);
  }
  const context = pickerInspectionContext(undefined);
  const result = vm.runInContext(
    await pickerInspectionProgram(context),
    context,
  );
  assert.equal(result.runtimeStatus, "not_installed");
  assert.equal(result.modelObservations.queryRowsVerified, false);
});

test("picker inspection bounds catalog and observation receipts and never treats excluded inventory as active", async () => {
  const models = Array.from({ length: 300 }, (_, i) => ({
    model: `model-${i}`,
    supported_reasoning_levels: ["max"],
  }));
  const context = pickerInspectionContext({
    rendererRuntimeFingerprint: fingerprint,
    payload: {
      catalogAvailable: true,
      modelNames: models.map((model) => model.model),
      models: [
        ...models,
        {
          model: "excluded",
          enabled: false,
          supported_reasoning_levels: ["max"],
        },
      ],
    },
    readCodexModelPickerDiagnostics: () => ({
      status: "ready",
      modelObservations: {
        queryRowsVerified: true,
        unavailable: false,
        truncated: true,
        rows: models.map(({ model }) => ({
          model,
          expectedEfforts: ["max"],
          observedEfforts: ["max"],
          nativeVisibleEfforts: ["max"],
          missingEfforts: [],
        })),
      },
    }),
  });
  const result = vm.runInContext(
    await pickerInspectionProgram(context),
    context,
  );
  assert.ok(result.catalog.models.length <= 256);
  assert.equal(result.catalog.truncated, true);
  assert.equal(
    result.catalog.models.some((model) => model.model === "excluded"),
    false,
  );
  assert.ok(result.modelObservations.rows.length <= 64);
  assert.equal(result.modelObservations.truncated, true);
  assert.equal(result.modelObservations.queryRowsVerified, false);
});

test("picker target sweep deadlines shorten only its optional connection budget while default readiness timeouts stay unchanged", async () => {
  const source = await readMonitorSource();
  const begin = source.indexOf("const connect = async (");
  const end = source.indexOf("const readinessExpression =", begin);
  assert.ok(begin >= 0 && end > begin);
  for (const [deadline, expected] of [
    [Infinity, [4000, 8000]],
    [1250, [250, 250]],
  ]) {
    const timers = [],
      commands = [];
    let closes = 0;
    class FixtureSocket {
      listeners = new Map();
      constructor() {
        queueMicrotask(() => this.emit("open", {}));
      }
      addEventListener(name, callback) {
        const callbacks = this.listeners.get(name) || [];
        callbacks.push(callback);
        this.listeners.set(name, callbacks);
      }
      emit(name, event) {
        for (const callback of this.listeners.get(name) || []) callback(event);
      }
      send(text) {
        const command = JSON.parse(text);
        commands.push(command.method);
        queueMicrotask(() =>
          this.emit("message", {
            data: JSON.stringify({ id: command.id, result: {} }),
          }),
        );
      }
      close() {
        closes += 1;
        this.emit("close", {});
      }
    }
    const context = vm.createContext({
      WebSocket: FixtureSocket,
      Date: { now: () => 1000 },
      setTimeout: (_callback, duration) => {
        timers.push(duration);
        return timers.length;
      },
      clearTimeout: () => {},
      fail: (reason) => new Error(reason),
      verificationDeadline: Infinity,
      deadline,
    });
    const candidate = await vm.runInContext(
      source.slice(begin, end) +
        '; connect("ws://127.0.0.1:9229/fixture", deadline)',
      context,
    );
    assert.deepEqual(timers, expected);
    assert.deepEqual(commands, ["Runtime.enable"]);
    candidate.close();
    assert.equal(closes, 1);
  }
});

test("CDP command timeouts retain the fixed local command without request content", async () => {
  const source = await readMonitorSource();
  const begin = source.indexOf("const connect = async (");
  const end = source.indexOf("const readinessExpression =", begin);
  assert.ok(begin >= 0 && end > begin);
  for (const timedOutCommand of ["Runtime.enable", "Runtime.evaluate"]) {
    const timers = new Map();
    let timerId = 0;
    class FixtureSocket {
      listeners = new Map();
      constructor() {
        queueMicrotask(() => this.emit("open", {}));
      }
      addEventListener(name, callback) {
        this.listeners.set(name, [
          ...(this.listeners.get(name) || []),
          callback,
        ]);
      }
      emit(name, value) {
        for (const callback of this.listeners.get(name) || []) callback(value);
      }
      send(text) {
        const command = JSON.parse(text);
        if (command.method === timedOutCommand) {
          const timeout = [...timers.values()].at(-1);
          queueMicrotask(timeout);
        } else
          queueMicrotask(() =>
            this.emit("message", {
              data: JSON.stringify({ id: command.id, result: {} }),
            }),
          );
      }
      close() {
        this.emit("close", {});
      }
    }
    const context = vm.createContext({
      WebSocket: FixtureSocket,
      Date: { now: () => 1000 },
      setTimeout: (callback) => {
        timers.set(++timerId, callback);
        return timerId;
      },
      clearTimeout: (id) => timers.delete(id),
      fail: (code) => new Error(code),
      verificationDeadline: Infinity,
    });
    const connect = vm.runInContext(
      source.slice(begin, end) + "; connect",
      context,
    );
    const operation = async () => {
      const candidate = await connect("ws://127.0.0.1:9229/fixture");
      try {
        await candidate.evaluate("redacted-private-expression", 8000);
      } finally {
        candidate.close();
      }
    };
    await assert.rejects(operation(), (error) => {
      assert.equal(error.message, "cdp_command_timeout");
      assert.equal(error.cdpCommand, timedOutCommand);
      assert.equal(JSON.stringify(error).includes("redacted-private"), false);
      return true;
    });
  }
});

const runPickerTargetsFixture = async (
  definitions,
  {
    waitMs = 15000,
    sampleCount = 1,
    sampleIntervalMs = 1000,
    nativeFailure,
    nativeFailureAt = 1,
  } = {},
) => {
  const source = await readMonitorSource();
  const begin = source.indexOf("const run = async () => {");
  const end = source.indexOf("\nlet evidence;", begin);
  const helpers = source.indexOf("const PICKER_INSPECTION_TARGET_LIMIT =");
  const helperSource = helpers >= 0 ? source.slice(helpers, begin) : "";
  const targets = definitions.map((definition, index) => ({
    id: definition.id,
    webSocketDebuggerUrl:
      definition.url || "ws://127.0.0.1:9229/devtools/page/" + index,
  }));
  const byUrl = new Map();
  targets.forEach((target, index) => {
    if (!byUrl.has(target.webSocketDebuggerUrl))
      byUrl.set(target.webSocketDebuggerUrl, definitions[index]);
  });
  let now = Date.now();
  let nativeChecks = 0;
  let binaryChecks = 0;
  const sleeps = [];
  const readCounts = new Map();
  const connected = [],
    closed = [],
    evaluated = [];
  const program = await pickerInspectionProgram(
    pickerInspectionContext(undefined),
  );
  const forbidden = () => {
    throw new Error(
      "Read-only target sweep must not mutate Desktop or submit a prompt",
    );
  };
  const context = vm.createContext({
    assert,
    createHash: (await import("node:crypto")).createHash,
    options: new Map(),
    stat: forbidden,
    startedAt: now,
    Date: { now: () => now },
    waitMs,
    port: 9229,
    checkBinary: async () => {
      binaryChecks += 1;
    },
    checkNativeIdentity: () => {
      nativeChecks += 1;
      if (nativeFailure && nativeChecks === nativeFailureAt)
        throw new Error(nativeFailure);
    },
    sourceRuntimeBootstrapped: false,
    refreshFingerprint: async () => {},
    readNativeIdentity: () => ({
      host: "127.0.0.1",
      owners: [
        {
          pid: 123,
          creationTicks: "123",
          verified: true,
          addresses: ["127.0.0.1"],
        },
      ],
    }),
    expectedFingerprint: fingerprint,
    inspectPicker: true,
    pickerSampleCount: sampleCount,
    pickerSampleIntervalMs: sampleIntervalMs,
    injectSourceRuntime: false,
    runDisposableTest: false,
    readTargets: async () => targets,
    connect: async (url) => {
      connected.push(url);
      const definition = byUrl.get(url);
      if (definition.connectFailure) {
        const error = new Error(definition.connectFailure);
        if (definition.connectCommand)
          error.cdpCommand = definition.connectCommand;
        throw error;
      }
      return {
        evaluate: async (expression) => {
          assert.equal(expression, program);
          evaluated.push(url);
          const index = readCounts.get(url) || 0;
          readCounts.set(url, index + 1);
          if (
            definition.failure &&
            (!definition.failureAt || index + 1 === definition.failureAt)
          )
            throw new Error(definition.failure);
          if (definition.invalidInspection) return undefined;
          const state = Array.isArray(definition.states)
            ? definition.states[Math.min(index, definition.states.length - 1)]
            : definition.state;
          return vm.runInContext(expression, pickerInspectionContext(state));
        },
        close: () => closed.push(url),
      };
    },
    pickerInspectionExpression: () => program,
    readinessExpression: forbidden,
    createServer: forbidden,
    mkdtemp: forbidden,
    loadCodexRendererSourceRuntime: forbidden,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      now += milliseconds;
    },
    fail: (reason) => new Error(reason),
    connection: null,
    nativeIdentity: null,
    readinessBlocker: undefined,
    readinessDiagnostics: undefined,
    pickerInspection: undefined,
    pickerTargetInspections: undefined,
    stage: "readiness",
  });
  let result, failure;
  try {
    result = await vm.runInContext(
      helperSource + source.slice(begin, end) + "; run()",
      context,
    );
  } catch (error) {
    failure = error.message;
  }
  return {
    result,
    failure,
    collection: context.pickerTargetInspections,
    connected,
    closed,
    evaluated,
    sleeps,
    nativeChecks,
    binaryChecks,
  };
};
const nativeTargetId = (value) => value.toString(16).padStart(32, "0");
const installedPickerState = (value = fingerprint) => ({
  rendererRuntimeFingerprint: value,
  payload: { catalogAvailable: true, modelNames: [], models: [] },
});

test("picker target sweep does not mistake the first absent renderer for every renderer and selects the best current snapshot deterministically", async () => {
  const definitions = [
    { id: nativeTargetId(1), state: undefined },
    { id: nativeTargetId(2), state: installedPickerState() },
    {
      id: nativeTargetId(3),
      state: installedPickerState("sha256-" + "1".repeat(64)),
    },
  ];
  for (const ordered of [definitions, [...definitions].reverse()]) {
    const fixture = await runPickerTargetsFixture(ordered);
    assert.equal(fixture.failure, undefined);
    assert.equal(fixture.evaluated.length, 3);
    assert.equal(fixture.closed.length, 3);
    assert.equal(fixture.result.pickerInspection.runtimeStatus, "current");
    assert.equal(
      fixture.result.pickerTargetInspections.selectedTargetId,
      nativeTargetId(2),
    );
    assert.equal(fixture.result.pickerTargetInspections.complete, true);
    assert.equal(fixture.result.renderedMenuVerified, false);
    assert.equal(fixture.result.existingThreadsTouched, false);
    assert.equal(fixture.result.noTestThreadCreated, true);
  }
  const fixture = await runPickerTargetsFixture([
    { id: nativeTargetId(9), state: installedPickerState() },
    { id: nativeTargetId(4), state: installedPickerState() },
  ]);
  assert.equal(
    fixture.result.pickerTargetInspections.selectedTargetId,
    nativeTargetId(4),
  );
});

test("picker target sweep deduplicates transport targets without collapsing distinct targets that share an ID", async () => {
  const shared = "ws://127.0.0.1:9229/devtools/page/shared";
  const fixture = await runPickerTargetsFixture([
    { id: nativeTargetId(1), url: shared, state: installedPickerState() },
    { id: nativeTargetId(2), url: shared, state: installedPickerState() },
    { id: nativeTargetId(1), state: undefined },
  ]);
  assert.equal(fixture.evaluated.length, 2);
  assert.equal(fixture.closed.length, 2);
  assert.equal(fixture.collection.eligibleTargetCount, 3);
  assert.equal(fixture.collection.uniqueTargetCount, 2);
  assert.equal(fixture.collection.duplicateTargetCount, 1);
  assert.equal(
    new Set(fixture.collection.targets.map(({ targetRef }) => targetRef)).size,
    2,
  );
  assert.equal(fixture.collection.complete, true);
});

test("picker target sweep caps sanitized receipts and never reflects untrusted target IDs or socket URLs", async () => {
  const secret = "SK_private_fixture";
  const definitions = Array.from({ length: 20 }, (_, index) => ({
    id: index === 0 ? secret : nativeTargetId(index + 1),
    url: "ws://127.0.0.1:9229/devtools/page/private-fixture-" + index,
    state: installedPickerState(),
  }));
  const fixture = await runPickerTargetsFixture(definitions);
  assert.equal(fixture.collection.targetLimit, 8);
  assert.equal(fixture.collection.uniqueTargetCount, 20);
  assert.equal(fixture.collection.inspectedTargetCount, 8);
  assert.equal(fixture.evaluated.length, 8);
  assert.equal(fixture.closed.length, 8);
  assert.equal(fixture.collection.targets.length, 8);
  assert.equal(fixture.collection.truncated, true);
  assert.equal(fixture.collection.complete, false);
  assert.equal(JSON.stringify(fixture.result).includes(secret), false);
  assert.equal(
    JSON.stringify(fixture.result).includes("private-fixture"),
    false,
  );
  assert.equal(JSON.stringify(fixture.result).includes("ws://"), false);
});

test("picker target sweep continues after finite sanitized target failures and closes each reached connection", async () => {
  const fixture = await runPickerTargetsFixture([
    { id: nativeTargetId(1), failure: "private-target-error" },
    { id: nativeTargetId(2), state: installedPickerState() },
  ]);
  assert.equal(fixture.failure, undefined);
  assert.equal(fixture.result.pickerInspection.runtimeStatus, "current");
  assert.equal(fixture.collection.inspectedTargetCount, 1);
  assert.equal(fixture.collection.unavailableTargetCount, 1);
  assert.equal(fixture.collection.complete, false);
  assert.equal(fixture.closed.length, 2);
  assert.equal(
    JSON.stringify(fixture.result).includes("private-target-error"),
    false,
  );
  assert.equal(
    fixture.collection.targets.find(({ status }) => status === "unavailable")
      .failure,
    "picker_target_unavailable",
  );
});

test("picker target sweep reports all failed or deadline-exhausted inspections as unavailable rather than absent runtimes", async () => {
  const failed = await runPickerTargetsFixture([
    { id: nativeTargetId(1), connectFailure: "cdp_connect_failed" },
    { id: nativeTargetId(2), failure: "private-target-error" },
  ]);
  assert.equal(failed.failure, "picker_inspection_unavailable");
  assert.equal(failed.collection.inspectedTargetCount, 0);
  assert.equal(failed.collection.unavailableTargetCount, 2);
  assert.equal(
    failed.collection.targets.every(
      (target) => target.inspection === undefined,
    ),
    true,
  );
  assert.equal(failed.closed.length, 1);
  const deadline = await runPickerTargetsFixture(
    [{ id: nativeTargetId(1), state: installedPickerState() }],
    { waitMs: -1 },
  );
  assert.equal(deadline.failure, "picker_inspection_unavailable");
  assert.equal(deadline.evaluated.length, 0);
  assert.equal(deadline.collection.complete, false);
  assert.equal(deadline.collection.targets[0].failure, "inspection_deadline");
});

test("picker sampling preserves initial finite target failures when no session can be sampled", async () => {
  const fixture = await runPickerTargetsFixture(
    [
      { id: nativeTargetId(1), connectFailure: "cdp_connect_failed" },
      { id: nativeTargetId(2), failure: "renderer_operation_rejected" },
      { id: nativeTargetId(3), failure: "private-target-error-never-reflect" },
    ],
    { sampleCount: 3, sampleIntervalMs: 100 },
  );
  assert.equal(fixture.failure, "picker_inspection_unavailable");
  assert.equal(fixture.collection.inspectedTargetCount, 0);
  assert.equal(fixture.collection.sampling.complete, false);
  assert.equal(fixture.collection.sampling.ownershipVerified, false);
  assert.equal(fixture.collection.sampling.samples.length, 0);
  const failures = new Map(
    Array.from(fixture.collection.targets, (target) => [
      target.targetId,
      target.failure,
    ]),
  );
  assert.equal(failures.get(nativeTargetId(1)), "cdp_connect_failed");
  assert.equal(failures.get(nativeTargetId(2)), "renderer_operation_rejected");
  assert.equal(failures.get(nativeTargetId(3)), "picker_target_unavailable");
  assert.equal(
    JSON.stringify(fixture.collection).includes("private-target-error"),
    false,
  );
});

test("picker target diagnostics distinguish connection, runtime enable, evaluation and result shape without reflected commands", async () => {
  const fixture = await runPickerTargetsFixture(
    [
      { id: nativeTargetId(1), connectFailure: "cdp_connect_failed" },
      {
        id: nativeTargetId(2),
        connectFailure: "cdp_command_timeout",
        connectCommand: "Runtime.enable",
      },
      { id: nativeTargetId(3), failure: "cdp_command_timeout" },
      { id: nativeTargetId(4), invalidInspection: true },
      {
        id: nativeTargetId(5),
        connectFailure: "cdp_protocol_error",
        connectCommand: "private-command-never-reflect",
      },
    ],
    { sampleCount: 3 },
  );
  const rows = new Map(
    Array.from(fixture.collection.targets, (row) => [row.targetId, row]),
  );
  assert.equal(rows.get(nativeTargetId(1)).failureStage, "connect");
  assert.equal(rows.get(nativeTargetId(2)).failureStage, "runtime_enable");
  assert.equal(rows.get(nativeTargetId(3)).failureStage, "runtime_evaluate");
  assert.equal(rows.get(nativeTargetId(4)).failureStage, "result_shape");
  assert.equal(rows.get(nativeTargetId(4)).failure, "picker_result_invalid");
  assert.equal(rows.get(nativeTargetId(5)).failureStage, "connect");
  assert.equal(
    JSON.stringify(fixture.collection).includes("private-command"),
    false,
  );
});

test("picker inspection execution uses the existing monitor without a test thread, source injection or bridge requirement", async () => {
  const source = await readMonitorSource();
  const begin = source.indexOf("const run = async () => {");
  const end = source.indexOf("\nlet evidence;", begin);
  const helperBegin = source.indexOf("const PICKER_INSPECTION_TARGET_LIMIT =");
  assert.ok(begin >= 0 && end > begin);
  const rendered = pickerInspectionContext({
    rendererRuntimeFingerprint: `sha256-${"1".repeat(64)}`,
    payload: { catalogAvailable: true, modelNames: [], models: [] },
  });
  const program = await pickerInspectionProgram(rendered);
  let evaluations = 0;
  const forbidden = () => {
    throw new Error("Inspection must not mutate Desktop or submit a prompt");
  };
  const context = vm.createContext({
    assert,
    createHash: (await import("node:crypto")).createHash,
    port: 9229,
    options: new Map(),
    stat: forbidden,
    startedAt: Date.now(),
    waitMs: 15000,
    checkBinary: async () => {},
    sourceRuntimeBootstrapped: false,
    refreshFingerprint: async () => {},
    readNativeIdentity: () => ({
      host: "127.0.0.1",
      owners: [
        {
          pid: 123,
          creationTicks: "123",
          verified: true,
          addresses: ["127.0.0.1"],
        },
      ],
    }),
    expectedFingerprint: fingerprint,
    inspectPicker: true,
    pickerSampleCount: 1,
    pickerSampleIntervalMs: 1000,
    injectSourceRuntime: false,
    runDisposableTest: false,
    readTargets: async () => [
      { webSocketDebuggerUrl: "ws://127.0.0.1:9229/test" },
    ],
    connect: async () => ({
      evaluate: async (expression) => {
        evaluations += 1;
        assert.equal(expression, program);
        return vm.runInContext(expression, rendered);
      },
      close() {},
    }),
    pickerInspectionExpression: () => program,
    readinessExpression: forbidden,
    createServer: forbidden,
    mkdtemp: forbidden,
    loadCodexRendererSourceRuntime: forbidden,
    sleep: forbidden,
    fail: (reason) => new Error(reason),
    connection: null,
    nativeIdentity: null,
    readinessBlocker: undefined,
    readinessDiagnostics: undefined,
    pickerInspection: undefined,
    pickerTargetInspections: undefined,
    stage: "readiness",
  });
  const result = await vm.runInContext(
    `${source.slice(helperBegin, begin)}${source.slice(begin, end)}; run()`,
    context,
  );
  assert.equal(evaluations, 1);
  assert.equal(result.pickerTargetInspections.inspectedTargetCount, 1);
  assert.equal(result.pickerTargetInspections.complete, true);
  assert.equal(result.pickerInspectionPerformed, true);
  assert.equal(result.readinessVerified, false);
  assert.equal(result.verified, false);
  assert.equal(result.desktopCdpVerified, false);
  assert.equal(result.noTestThreadCreated, true);
  assert.equal(result.existingThreadsTouched, false);
  assert.equal(result.renderedMenuVerified, false);
  assert.equal(result.pickerInspection.runtimeStatus, "mismatch");
});

test("picker inspection cannot be combined with mutating verifier modes", async () => {
  const source = await readMonitorSource();
  const begin = source.indexOf("const runDisposableTest =");
  const end = source.indexOf("const threadScopeEvidence =", begin);
  assert.ok(begin >= 0 && end > begin);
  for (const flag of ["--run-disposable-test", "--inject-source-runtime"]) {
    const context = vm.createContext({
      assert,
      options: new Map([
        ["--inspect-picker", true],
        [flag, true],
      ]),
    });
    assert.throws(
      () => vm.runInContext(source.slice(begin, end), context),
      /Picker inspection cannot mutate Desktop/,
    );
  }
});

test("picker inspection preserves the default bridge-only readiness mode", async () => {
  const source = await readMonitorSource();
  const begin = source.indexOf("const run = async () => {");
  const end = source.indexOf("\nlet evidence;", begin);
  const forbidden = () => {
    throw new Error("Default readiness cannot inspect or mutate Desktop");
  };
  let evaluations = 0;
  const context = vm.createContext({
    options: new Map(),
    stat: forbidden,
    startedAt: Date.now(),
    waitMs: 0,
    checkBinary: async () => {},
    sourceRuntimeBootstrapped: false,
    refreshFingerprint: async () => {},
    readNativeIdentity: () => ({
      host: "127.0.0.1",
      owners: [
        {
          pid: 123,
          creationTicks: "123",
          verified: true,
          addresses: ["127.0.0.1"],
        },
      ],
    }),
    expectedFingerprint: fingerprint,
    inspectPicker: false,
    injectSourceRuntime: false,
    runDisposableTest: false,
    readTargets: async () => [
      { webSocketDebuggerUrl: "ws://127.0.0.1:9229/test" },
    ],
    connect: async () => ({
      evaluate: async (expression) => {
        evaluations += 1;
        assert.equal(expression, "original-readiness");
        return { ready: true };
      },
    }),
    pickerInspectionExpression: forbidden,
    readinessExpression: () => "original-readiness",
    createServer: forbidden,
    mkdtemp: forbidden,
    sleep: forbidden,
    fail: (reason) => new Error(reason),
    connection: null,
    nativeIdentity: null,
    readinessBlocker: undefined,
    readinessDiagnostics: undefined,
    pickerInspection: undefined,
    scenario: "overload",
    threadScopeEvidence: () => ({ existingThreadsTouched: false }),
  });
  const result = await vm.runInContext(
    `${source.slice(begin, end)}; run()`,
    context,
  );
  assert.equal(evaluations, 1);
  assert.equal(result.readinessVerified, true);
  assert.equal(result.verified, false);
  assert.equal(result.noTestThreadCreated, true);
  assert.equal(result.existingThreadsTouched, false);
  assert.equal(Object.hasOwn(result, "pickerInspectionPerformed"), false);
});

test("picker inspection accepts its explicit flag without consuming a value", async () => {
  const source = await readMonitorSource();
  const begin = source.indexOf("const options = new Map();");
  const end = source.indexOf("assert.equal(\n  process.platform,", begin);
  assert.ok(begin >= 0 && end > begin);
  const context = vm.createContext({
    assert,
    process: {
      argv: ["node", "verifier", "--inspect-picker", "--wait-ms", "250"],
    },
  });
  const result = vm.runInContext(
    `${source.slice(begin, end)}; Object.fromEntries(options)`,
    context,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    "--inspect-picker": true,
    "--wait-ms": "250",
  });
});

test("picker inspection uses a bounded default readiness window", async () => {
  const source = await readMonitorSource();
  const begin = source.indexOf("const options = new Map();");
  const end = source.indexOf("const fingerprintPattern", begin);
  assert.ok(begin >= 0 && end > begin);
  const defaultContext = vm.createContext({
    assert,
    process: {
      platform: "win32",
      argv: ["node", "verifier", "--inspect-picker"],
    },
  });
  assert.equal(
    vm.runInContext(`${source.slice(begin, end)}; waitMs`, defaultContext),
    30_000,
  );

  const explicitContext = vm.createContext({
    assert,
    process: {
      platform: "win32",
      argv: ["node", "verifier", "--inspect-picker", "--wait-ms", "0"],
    },
  });
  assert.equal(
    vm.runInContext(`${source.slice(begin, end)}; waitMs`, explicitContext),
    0,
  );
});

test("picker sampling keeps requested cadence on one pinned selected session with validation only before and after", async () => {
  const state = (status) => ({
    ...installedPickerState(),
    scopedAppServerScopeScan: {
      status,
      visitedFiberCount: 1,
      fiberLimit: 30000,
      scopeCount: 1,
      elapsedMs: 1,
    },
  });
  const fixture = await runPickerTargetsFixture(
    [
      { id: nativeTargetId(1), state: undefined },
      {
        id: nativeTargetId(2),
        states: [
          state("scanning"),
          state("scanning"),
          state("invalidated"),
          state("scanning"),
          state("complete"),
        ],
      },
    ],
    { sampleCount: 4, sampleIntervalMs: 100 },
  );
  assert.equal(fixture.failure, undefined);
  const sampling = fixture.result.pickerTargetInspections.sampling;
  assert.equal(sampling.scope, "same_pinned_target_session");
  assert.equal(sampling.complete, true);
  assert.equal(sampling.ownershipVerified, true);
  assert.equal(sampling.renderedMenuVerified, false);
  assert.equal(sampling.targetId, nativeTargetId(2));
  assert.deepEqual(
    Array.from(
      sampling.samples,
      (sample) => sample.inspection.nativeVisibility.scopeScan.status,
    ),
    ["scanning", "invalidated", "scanning", "complete"],
  );
  assert.deepEqual(
    Array.from(sampling.samples, (sample) => sample.index),
    [1, 2, 3, 4],
  );
  assert.deepEqual(
    Array.from(sampling.samples, (sample) => sample.elapsedMs),
    [0, 100, 200, 300],
  );
  assert.deepEqual(fixture.sleeps, [100, 100, 100]);
  assert.equal(fixture.connected.length, 2);
  assert.equal(fixture.closed.length, 2);
  assert.equal(new Set(fixture.closed).size, 2);
  assert.equal(fixture.evaluated.length, 6);
  assert.equal(new Set(fixture.evaluated.slice(-4)).size, 1);
  assert.equal(fixture.nativeChecks, 2);
  assert.equal(fixture.binaryChecks, 3);
  assert.equal(
    fixture.result.pickerInspection.nativeVisibility.scopeScan.status,
    "complete",
  );
  assert.equal(fixture.result.renderedMenuVerified, false);
  assert.equal(fixture.result.readinessVerified, false);
});

test("picker sampling leaves the default one-shot receipt and connection behavior unchanged", async () => {
  const fixture = await runPickerTargetsFixture([
    { id: nativeTargetId(1), state: installedPickerState() },
  ]);
  assert.equal(fixture.failure, undefined);
  assert.equal(
    Object.hasOwn(fixture.result.pickerTargetInspections, "sampling"),
    false,
  );
  assert.equal(fixture.evaluated.length, 1);
  assert.equal(fixture.connected.length, 1);
  assert.equal(fixture.closed.length, 1);
  assert.equal(fixture.nativeChecks, 0);
  assert.deepEqual(fixture.sleeps, []);
});

test("picker sampling preserves the overall deadline without extending intervals or reconnecting", async () => {
  const fixture = await runPickerTargetsFixture(
    [{ id: nativeTargetId(1), state: installedPickerState() }],
    { waitMs: 250, sampleCount: 4, sampleIntervalMs: 100 },
  );
  assert.equal(fixture.failure, undefined);
  const sampling = fixture.result.pickerTargetInspections.sampling;
  assert.equal(sampling.complete, false);
  assert.equal(sampling.ownershipVerified, true);
  assert.equal(sampling.failure, "inspection_deadline");
  assert.equal(sampling.samples.length, 3);
  assert.deepEqual(fixture.sleeps, [100, 100]);
  assert.equal(fixture.evaluated.length, 4);
  assert.equal(fixture.connected.length, 1);
  assert.equal(fixture.closed.length, 1);
  assert.equal(fixture.nativeChecks, 2);
});

test("picker sampling clears every retained proof when final ownership validation fails", async () => {
  for (const nativeFailure of [
    "debug_port_identity_changed",
    "private-native-fixture-never-reflect",
  ]) {
    const fixture = await runPickerTargetsFixture(
      [{ id: nativeTargetId(1), state: installedPickerState() }],
      {
        sampleCount: 3,
        sampleIntervalMs: 100,
        nativeFailure,
        nativeFailureAt: 2,
      },
    );
    assert.equal(fixture.failure, "picker_inspection_unavailable");
    const sampling = fixture.collection.sampling;
    assert.equal(sampling.complete, false);
    assert.equal(sampling.ownershipVerified, false);
    assert.equal(sampling.samples.length, 0);
    assert.equal(
      sampling.failure,
      nativeFailure === "debug_port_identity_changed"
        ? nativeFailure
        : "picker_target_unavailable",
    );
    assert.equal(fixture.collection.selectedTargetId, null);
    assert.equal(fixture.collection.inspectedTargetCount, 0);
    assert.equal(fixture.collection.complete, false);
    assert.equal(
      fixture.collection.targets.every(
        (target) => !Object.hasOwn(target, "inspection"),
      ),
      true,
    );
    assert.equal(
      JSON.stringify(fixture.collection).includes(
        "private-native-fixture-never-reflect",
      ),
      false,
    );
    assert.equal(fixture.nativeChecks, 2);
    assert.equal(fixture.connected.length, 1);
    assert.equal(fixture.closed.length, 1);
  }
});

test("picker sampling fails closed on pinned-session closure instead of reconnecting or keeping current proof", async () => {
  const fixture = await runPickerTargetsFixture(
    [
      {
        id: nativeTargetId(1),
        state: installedPickerState(),
        failure: "cdp_closed",
        failureAt: 3,
      },
    ],
    { sampleCount: 3, sampleIntervalMs: 100 },
  );
  assert.equal(fixture.failure, "picker_inspection_unavailable");
  assert.equal(fixture.collection.sampling.failure, "cdp_closed");
  assert.equal(fixture.collection.sampling.samples.length, 0);
  assert.equal(fixture.collection.sampling.ownershipVerified, false);
  assert.equal(fixture.connected.length, 1);
  assert.equal(fixture.closed.length, 1);
  assert.equal(fixture.evaluated.length, 3);
  assert.equal(fixture.nativeChecks, 2);
});

test("picker sampling options require explicit read-only inspection and finite count and interval bounds", async () => {
  const source = await readMonitorSource();
  const begin = source.indexOf("const runDisposableTest =");
  const end = source.indexOf("const threadScopeEvidence =", begin);
  const parse = (entries) =>
    vm.runInNewContext(
      source.slice(begin, end) +
        "; ({pickerSampleCount,pickerSampleIntervalMs})",
      { assert, options: new Map(entries) },
    );
  assert.deepEqual(JSON.parse(JSON.stringify(parse([]))), {
    pickerSampleCount: 1,
    pickerSampleIntervalMs: 1000,
  });
  for (const [count, interval] of [
    [1, 100],
    [16, 5000],
  ]) {
    const result = parse([
      ["--inspect-picker", true],
      ["--sample-count", String(count)],
      ["--sample-interval-ms", String(interval)],
    ]);
    assert.equal(result.pickerSampleCount, count);
    assert.equal(result.pickerSampleIntervalMs, interval);
  }
  for (const count of ["0", "17", "1.5", "NaN"])
    assert.throws(
      () =>
        parse([
          ["--inspect-picker", true],
          ["--sample-count", count],
        ]),
      /sample count/,
    );
  for (const interval of ["0", "99", "5001", "1.5", "NaN"])
    assert.throws(
      () =>
        parse([
          ["--inspect-picker", true],
          ["--sample-interval-ms", interval],
        ]),
      /sample interval/,
    );
  assert.throws(
    () => parse([["--sample-count", "2"]]),
    /require --inspect-picker/,
  );
  assert.throws(
    () => parse([["--sample-interval-ms", "100"]]),
    /require --inspect-picker/,
  );
  const argsBegin = source.indexOf("const options = new Map();");
  const argsEnd = source.indexOf(
    "assert.equal(\n  process.platform,",
    argsBegin,
  );
  const parsed = vm.runInNewContext(
    source.slice(argsBegin, argsEnd) + "; Object.fromEntries(options)",
    {
      assert,
      process: {
        argv: [
          "node",
          "verifier",
          "--inspect-picker",
          "--sample-count",
          "16",
          "--sample-interval-ms",
          "1000",
        ],
      },
    },
  );
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), {
    "--inspect-picker": true,
    "--sample-count": "16",
    "--sample-interval-ms": "1000",
  });
});

test("owned thread read diagnostics classify only fixed protocol and initialization reasons", async () => {
  const source = await readMonitorSource();
  const begin = source.indexOf("const classifyOwnedThreadReadFailure =");
  const end = source.indexOf("const threadProjection =", begin);
  assert.ok(
    begin >= 0 && end > begin,
    "Owned reads need an in-renderer finite error projection",
  );
  const context = vm.createContext({});
  vm.runInContext(
    source.slice(begin, end) +
      "; globalThis.classify = classifyOwnedThreadReadFailure; globalThis.project = projectOwnedThreadReadFailure;",
    context,
  );
  for (const [error, expected] of [
    [
      {
        code: -32603,
        message: "no rollout found for thread redacted-private-id",
      },
      { reason: "thread_not_found", protocolCode: "internal_error" },
    ],
    [
      {
        code: -32603,
        message: "Thread redacted-private-id is not yet initialized",
      },
      { reason: "thread_not_ready", protocolCode: "internal_error" },
    ],
    [
      { code: -32602, message: "redacted-private-input" },
      { reason: "invalid_params", protocolCode: "invalid_params" },
    ],
    [
      { code: -32601, message: "redacted-private-method" },
      { reason: "unsupported_method", protocolCode: "method_not_found" },
    ],
    [
      { message: "Permission denied for redacted-private-file" },
      { reason: "permission_denied", protocolCode: "unknown" },
    ],
    [
      { code: 987654321, message: "redacted-private-error" },
      { reason: "unclassified", protocolCode: "unknown" },
    ],
  ]) {
    const result = JSON.parse(JSON.stringify(context.classify(error)));
    assert.deepEqual(result, expected);
    assert.equal(JSON.stringify(result).includes("redacted-private"), false);
  }
  const reflected = {
    reason: "redacted-private-reason",
    protocolCode: "redacted-private-code",
    message: "redacted-private-message",
  };
  assert.deepEqual(JSON.parse(JSON.stringify(context.project(reflected))), {
    reason: "unclassified",
    protocolCode: "unknown",
  });
});

test("owned thread read diagnostics never invoke getters or inherited error fields", async () => {
  const source = await readMonitorSource();
  const begin = source.indexOf("const classifyOwnedThreadReadFailure =");
  const end = source.indexOf("const threadProjection =", begin);
  assert.ok(begin >= 0 && end > begin);
  const context = vm.createContext({});
  vm.runInContext(
    source.slice(begin, end) +
      "; globalThis.classify = classifyOwnedThreadReadFailure; globalThis.project = projectOwnedThreadReadFailure;",
    context,
  );
  let getterReads = 0;
  const error = {};
  for (const key of [
    "code",
    "message",
    "reason",
    "protocolCode",
    "error",
    "cause",
  ]) {
    Object.defineProperty(error, key, {
      get() {
        getterReads += 1;
        throw new Error("redacted-private-getter");
      },
    });
  }
  for (const value of [
    error,
    Object.create({
      code: -32603,
      message: "thread not found redacted-private",
    }),
    new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("redacted-private-proxy");
        },
      },
    ),
  ]) {
    assert.deepEqual(JSON.parse(JSON.stringify(context.classify(value))), {
      reason: "unclassified",
      protocolCode: "unknown",
    });
    assert.deepEqual(JSON.parse(JSON.stringify(context.project(value))), {
      reason: "unclassified",
      protocolCode: "unknown",
    });
  }
  assert.equal(getterReads, 0);
});

test("owned thread read RPC failures are projected inside the actual guarded renderer program", async () => {
  const source = await readMonitorSource();
  const classifyBegin = source.indexOf(
    "const classifyOwnedThreadReadFailure =",
  );
  const projectionBegin = source.indexOf(
    "const threadProjection =",
    classifyBegin,
  );
  const projectionEnd = source.indexOf(
    "const cleanupExpression =",
    projectionBegin,
  );
  assert.ok(
    classifyBegin >= 0 &&
      projectionBegin > classifyBegin &&
      projectionEnd > projectionBegin,
  );
  const guardBegin = source.indexOf("const guarded =");
  const guardEnd = source.indexOf(
    "// This projection runs INSIDE the renderer",
    guardBegin,
  );
  let calls = 0;
  const threadId = "owned-fixture-thread";
  const leaseKey = "owned-fixture-lease";
  const window = {
    __ccSwitchCodexAppCompatibilityV9: {
      rendererRuntimeFingerprint: fingerprint,
    },
  };
  window[leaseKey] = {
    threadId,
    request: async (method, params) => {
      calls += 1;
      assert.equal(method, "thread/read");
      assert.deepEqual(JSON.parse(JSON.stringify(params)), {
        threadId,
        includeTurns: true,
      });
      throw {
        code: -32603,
        message: "no rollout found for thread redacted-private-id",
      };
    },
  };
  const context = vm.createContext({
    window,
    threadId,
    leaseKey,
    patchKey: "__ccSwitchCodexAppCompatibilityV9",
    expectedFingerprint: fingerprint,
  });
  vm.runInContext(
    source.slice(guardBegin, guardEnd) +
      source.slice(classifyBegin, projectionEnd) +
      "; globalThis.expression = threadProjection();",
    context,
  );
  const observed = JSON.parse(
    JSON.stringify(await vm.runInContext(context.expression, context)),
  );
  assert.deepEqual(observed, {
    readFailure: { reason: "thread_not_found", protocolCode: "internal_error" },
  });
  assert.equal(calls, 1, "A diagnostic may not retry the read or any mutation");
  assert.equal(JSON.stringify(observed).includes("redacted-private"), false);
});

test("owned thread initial read rejection remains terminal without retry or mutation replay", async () => {
  const source = await readMonitorSource();
  const classifyBegin = source.indexOf(
    "const classifyOwnedThreadReadFailure =",
  );
  const classifyEnd = source.indexOf("const threadProjection =", classifyBegin);
  const pollBegin = source.indexOf(
    "const failed = await waitUntil(async () => {",
  );
  const pollEnd = source.indexOf(
    'stage = "initial_fixture_request_count";',
    pollBegin,
  );
  assert.ok(
    classifyBegin >= 0 &&
      classifyEnd > classifyBegin &&
      pollBegin >= 0 &&
      pollEnd > pollBegin,
  );
  let reads = 0;
  const context = vm.createContext({
    connection: {
      evaluate: async () => {
        reads += 1;
        return {
          readFailure: {
            reason: "thread_not_found",
            protocolCode: "internal_error",
            message: "redacted-private-message",
          },
        };
      },
    },
    threadProjection: () => "owned read",
    waitUntil: async (read) => read(),
    fail: (reason) => new Error(reason),
    latestThreadDiagnostics: undefined,
    ownedThreadReadFailure: undefined,
    initialTurn: { turnId: "owned-turn" },
  });
  vm.runInContext(source.slice(classifyBegin, classifyEnd), context);
  await assert.rejects(
    vm.runInContext(
      "(async () => {" + source.slice(pollBegin, pollEnd) + "})()",
      context,
    ),
    /owned_thread_read_rejected/,
  );
  assert.equal(reads, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(context.ownedThreadReadFailure)), {
    reason: "thread_not_found",
    protocolCode: "internal_error",
  });
  assert.equal(
    JSON.stringify(context.ownedThreadReadFailure).includes("redacted-private"),
    false,
  );
});

const ownerAuditContext = async (overrides = {}) => {
  const source = await readMonitorSource();
  const begin = source.indexOf("// Private owner-audit IPC");
  const end = source.indexOf("const cleanupTemporaryDirectory =", begin);
  assert.ok(
    begin >= 0 && end > begin,
    "Owner audit must use explicit bounded IPC helpers",
  );
  const context = vm.createContext({
    fail: (code) => new Error(code),
    Buffer,
    path,
    open,
    link,
    lstat,
    unlink,
    randomUUID,
    setTimeout,
    clearTimeout,
    fileURLToPath,
    process: { env: {} },
    ownerRemoteBrowserAudit: false,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ...overrides,
  });
  vm.runInContext(
    source
      .slice(begin, end)
      .replaceAll(
        "import.meta.url",
        JSON.stringify(new URL(`file:///${script.replaceAll("\\", "/")}`).href),
      ) +
      "; globalThis.api={validateOwnerAuditEvidence,publishOwnerAuditFile,readOwnerAuditFile,spawnOwnedOwnerAuditChild,settleOwnerAuditChild,captureOwnerAuditResult,selectOwnerAuditExecutable};",
    context,
  );
  return context;
};
const ownerAuditReady = () => ({
  schemaVersion: 1,
  auditNonce: "a".repeat(64),
  stage: "owner_view_ready",
  passed: false,
  error: null,
  socketVerified: true,
  webauthnVerified: true,
  loginVerified: true,
  csrfVerified: true,
  originVerified: true,
  logoutVerified: true,
  snapshotVerified: true,
  viewStatus: "idle",
  latestTurnStatus: "failed",
  threadMatches: true,
  continueBlocker: null,
  latestTurnMatches: true,
  modelMatches: true,
  turnCount: 1,
  itemCount: 0,
  truncated: false,
  ready: true,
  continueRequestSent: false,
  acknowledgementVerified: false,
  receiptVerified: false,
  duplicateRefused: false,
  durableLedgerVerified: false,
  nativeError: null,
  postStatus: null,
  postSubmitted: null,
  postMutationAttempted: null,
  operationMatches: false,
  postElapsedMs: null,
  canonicalReceiptMatches: false,
  canonicalRefusalVerified: false,
  nativeTrace: null,
});

test("owner remote audit CLI requires an explicit isolated disposable overload without injection", async () => {
  const source = await readMonitorSource();
  const begin = source.indexOf("const ownerRemoteAudit =");
  const end = source.indexOf("const patchKey =", begin);
  assert.ok(
    begin >= 0 && end > begin,
    "Owner audit must be opt-in and guarded",
  );
  const parse = (entries, scenario = "overload") =>
    vm.runInNewContext(source.slice(begin, end), {
      assert,
      options: new Map(entries),
      scenario,
    });
  assert.doesNotThrow(() => parse([]));
  assert.doesNotThrow(() =>
    parse([
      ["--owner-remote-audit", true],
      ["--run-disposable-test", true],
    ]),
  );
  assert.throws(
    () => parse([["--owner-remote-audit", true]]),
    /requires --run-disposable-test/,
  );
  for (const flag of ["--inspect-picker", "--inject-source-runtime"])
    assert.throws(
      () =>
        parse([
          ["--owner-remote-audit", true],
          ["--run-disposable-test", true],
          [flag, true],
        ]),
      /forbids/,
    );
  for (const scenario of [
    "concurrent_limit",
    "temporary_usage",
    "connection_drop",
    "explicit_no_retry",
    "hard_quota",
  ])
    assert.throws(
      () =>
        parse(
          [
            ["--owner-remote-audit", true],
            ["--run-disposable-test", true],
          ],
          scenario,
        ),
      /overload scenario/,
    );
});

test("owner audit strictly validates private evidence and publishes no nonce, ACK ID or reflected error", async () => {
  const { api } = await ownerAuditContext();
  const valid = ownerAuditReady();
  const projected = api.validateOwnerAuditEvidence(
    valid,
    valid.auditNonce,
    "initial-turn",
    true,
  );
  assert.equal(projected.publicEvidence.ready, true);
  assert.equal(
    JSON.stringify(projected.publicEvidence).includes(valid.auditNonce),
    false,
  );
  for (const invalid of [
    { ...valid, auditNonce: "b".repeat(64) },
    { ...valid, transcript: "redacted-private" },
    { ...valid, turnCount: 21 },
    { ...valid, itemCount: 121 },
    { ...valid, nativeError: "redacted-private" },
    { ...valid, durableLedgerVerified: true },
    { ...valid, acknowledgedTurnId: "unproven-id" },
    { ...valid, acknowledgementVerified: true },
    { ...valid, receiptVerified: true },
  ])
    assert.throws(
      () =>
        api.validateOwnerAuditEvidence(
          invalid,
          valid.auditNonce,
          "initial-turn",
          true,
        ),
      /owner_audit_invalid_evidence/,
    );
  let getters = 0;
  const accessor = { ...valid };
  Object.defineProperty(accessor, "stage", {
    get() {
      getters += 1;
      return "redacted-private";
    },
  });
  assert.throws(
    () =>
      api.validateOwnerAuditEvidence(
        accessor,
        valid.auditNonce,
        "initial-turn",
      ),
    /owner_audit_invalid_evidence/,
  );
  assert.equal(getters, 0);
  const failedAfterAck = {
    ...valid,
    stage: "native_owner_continue",
    error: "redacted-private",
    continueRequestSent: true,
    acknowledgementVerified: true,
    acknowledgedTurnId: "exact-ack-turn",
    postStatus: "submitted",
    postSubmitted: true,
    postMutationAttempted: true,
    operationMatches: true,
    postElapsedMs: 1,
  };
  const result = api.validateOwnerAuditEvidence(
    failedAfterAck,
    valid.auditNonce,
    "initial-turn",
  );
  assert.equal(result.acknowledgedTurnId, "exact-ack-turn");
  assert.equal(result.publicEvidence.error, "child_refused");
  assert.equal(
    JSON.stringify(result.publicEvidence).includes("exact-ack-turn"),
    false,
  );
  assert.equal(
    JSON.stringify(result.publicEvidence).includes("redacted-private"),
    false,
  );
  for (const id of ["initial-turn", "bad id", "x".repeat(257)])
    assert.throws(
      () =>
        api.validateOwnerAuditEvidence(
          { ...failedAfterAck, acknowledgedTurnId: id },
          valid.auditNonce,
          "initial-turn",
        ),
      /owner_audit_invalid_evidence/,
    );
});

test("owner audit files are bounded and exclusively atomically published without overwriting prior handoff", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "ccswitch-owner-ipc-test-"),
  );
  try {
    const { api } = await ownerAuditContext();
    await api.publishOwnerAuditFile(directory, "request.json", {
      schemaVersion: 1,
    });
    await assert.rejects(
      api.publishOwnerAuditFile(directory, "request.json", {
        schemaVersion: 2,
      }),
      /owner_audit_handoff_failed/,
    );
    assert.deepEqual(
      JSON.parse(await readFile(path.join(directory, "request.json"), "utf8")),
      { schemaVersion: 1 },
    );
    assert.deepEqual(await readdir(directory), ["request.json"]);
    assert.equal(await api.readOwnerAuditFile(directory, "ready.json"), null);
    await writeFile(
      path.join(directory, "ready.json"),
      JSON.stringify(ownerAuditReady()),
    );
    assert.equal(
      (await api.readOwnerAuditFile(directory, "ready.json")).ready,
      true,
    );
    await writeFile(
      path.join(directory, "ready.json"),
      " ".repeat(16 * 1024 + 1),
    );
    await assert.rejects(
      api.readOwnerAuditFile(directory, "ready.json"),
      /owner_audit_invalid_evidence/,
    );
    await assert.rejects(
      api.publishOwnerAuditFile(directory, "commit.json", {
        text: "x".repeat(16 * 1024),
      }),
      /owner_audit_invalid_handoff/,
    );
    await assert.rejects(
      api.readOwnerAuditFile(directory, "request.json"),
      /owner_audit_invalid_handoff/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("owner audit owns only a strictly verified positive ACK even when the child later fails", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "ccswitch-owner-ack-test-"),
  );
  try {
    const ownedTurnIds = ["initial-turn"];
    const context = await ownerAuditContext({
      temporary: directory,
      ownerAuditNonce: "a".repeat(64),
      ownerAuditInitialTurnId: "initial-turn",
      ownedTurnIds,
      ownerAuditDiagnostics: undefined,
      ownerAuditAcknowledgedTurnId: undefined,
    });
    const failed = {
      ...ownerAuditReady(),
      stage: "native_owner_continue",
      error: "redacted-private",
      continueRequestSent: true,
    };
    await writeFile(
      path.join(directory, "result.json"),
      JSON.stringify(failed),
    );
    await context.api.captureOwnerAuditResult();
    assert.deepEqual(
      ownedTurnIds,
      ["initial-turn"],
      "An uncertain latest turn is never adopted",
    );
    await writeFile(
      path.join(directory, "result.json"),
      JSON.stringify({
        ...failed,
        acknowledgedTurnId: "positive-ack-turn",
        acknowledgementVerified: true,
        postStatus: "submitted",
        postSubmitted: true,
        postMutationAttempted: true,
        operationMatches: true,
        postElapsedMs: 1,
      }),
    );
    await context.api.captureOwnerAuditResult();
    assert.deepEqual(ownedTurnIds, ["initial-turn", "positive-ack-turn"]);
    assert.equal(context.ownerAuditAcknowledgedTurnId, "positive-ack-turn");
    assert.equal(
      JSON.stringify(context.ownerAuditDiagnostics).includes(
        "positive-ack-turn",
      ),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("owner audit asynchronously owns the exact executable and waits actual close after an exact-handle kill", async () => {
  const child = new EventEmitter();
  let kills = 0;
  let spawned;
  child.kill = () => {
    kills += 1;
    child.emit("close", 1);
  };
  const { api } = await ownerAuditContext({
    spawn: (...args) => {
      spawned = args;
      return child;
    },
  });
  const state = api.spawnOwnedOwnerAuditChild(
    "C:\\owned\\native-test.exe",
    ["--exact", "owned-test"],
    { cwd: "C:\\owned" },
  );
  assert.equal(state.closed, false);
  assert.equal(spawned[0], "C:\\owned\\native-test.exe");
  assert.deepEqual(JSON.parse(JSON.stringify(spawned[2].stdio)), [
    "ignore",
    "ignore",
    "ignore",
  ]);
  assert.equal(await api.settleOwnerAuditChild(state, 0), true);
  assert.equal(kills, 1);
  assert.equal(state.closed, true);
});

test("owner audit branches before the automatic sender and precompiles before creating the owned fixture", async () => {
  const source = await readMonitorSource();
  const run = source.slice(source.indexOf("const run = async () =>"));
  assert.ok(
    run.indexOf("ownerAuditExecutable = await compileOwnerAuditExecutable(") <
      run.indexOf("temporary = await mkdtemp"),
  );
  const branch = run.indexOf(
    "if (ownerRemoteAudit) return verifyOwnerRemoteFixture(failed, localBase);",
  );
  assert.ok(
    branch >= 0 && branch < run.indexOf("state.startCodexContinuation"),
  );
  const owner = source.slice(
    source.indexOf("const verifyOwnerRemoteFixture ="),
    source.indexOf("const cleanupTemporaryDirectory ="),
  );
  assert.doesNotMatch(
    owner,
    /startCodexContinuation|confirmCodexContinuation|commitCodexContinuation|turn\/start/,
  );
  assert.match(owner, /--ignored/);
  assert.match(owner, /--test-threads=1/);
  assert.match(source, /installedOwnerServiceVerified: false/);
  const cleanup = source.slice(
    source.lastIndexOf("} finally {\n  // Wait for the exact native"),
  );
  assert.ok(
    cleanup.indexOf("await settleOwnerAuditChild") <
      cleanup.indexOf("connection.evaluate(cleanupExpression()"),
  );
  assert.match(cleanup, /ownerChildSettled && connection && runDisposableTest/);
  assert.match(cleanup, /ownerChildSettled && fixture\?\.listening/);
});

test("owner audit Cargo selection accepts exact library crate kinds and refuses other artifacts", async () => {
  const source = await readMonitorSource();
  const begin = source.indexOf("const selectOwnerAuditExecutable =");
  const end = source.indexOf("const compileOwnerAuditExecutable =", begin);
  assert.ok(
    begin >= 0 && end > begin,
    "Cargo test artifact selection must recognize explicit library crate types",
  );
  const context = vm.createContext({ path, fail: (code) => new Error(code) });
  const select = vm.runInContext(
    source.slice(begin, end) + "; selectOwnerAuditExecutable",
    context,
  );
  const executable = path.join(os.tmpdir(), "cc_switch_lib-owned.exe");
  const artifact = {
    reason: "compiler-artifact",
    target: { name: "cc_switch_lib", kind: ["lib"] },
    profile: { test: true },
    executable,
  };
  for (const kind of [["lib"], ["staticlib", "cdylib", "rlib"], ["rlib"]])
    assert.equal(
      select(
        JSON.stringify({ ...artifact, target: { ...artifact.target, kind } }),
      ),
      executable,
    );
  for (const bad of [
    { ...artifact, target: { ...artifact.target, kind: ["bin"] } },
    { ...artifact, target: { ...artifact.target, kind: ["lib", "bin"] } },
    { ...artifact, target: { ...artifact.target, name: "another_lib" } },
    { ...artifact, profile: { test: false } },
    { ...artifact, executable: "relative.exe" },
  ])
    assert.throws(
      () => select(JSON.stringify(bad)),
      /owner_audit_compile_failed/,
    );
  assert.throws(
    () =>
      select(
        JSON.stringify(artifact) +
          "\n" +
          JSON.stringify({ ...artifact, executable: executable + "-other" }),
      ),
    /owner_audit_compile_failed/,
  );
});

test("disposable provider is a random dedicated credential-free definition independent of current provider config", async () => {
  const source = await readMonitorSource();
  const begin = source.indexOf("const fixtureProviderDefinition =");
  const end = source.indexOf("const temporaryPrefix =", begin);
  assert.ok(
    begin >= 0 && end > begin,
    "Loopback fixture must not inherit a real provider credential definition",
  );
  const definition = vm.runInNewContext(
    source.slice(begin, end) +
      "; fixtureProviderDefinition('http://127.0.0.1:12345/v1')",
  );
  assert.deepEqual(JSON.parse(JSON.stringify(definition)), {
    name: "Isolated local protocol fixture",
    base_url: "http://127.0.0.1:12345/v1",
    wire_api: "responses",
    requires_openai_auth: false,
    request_max_retries: 0,
    stream_max_retries: 0,
    stream_idle_timeout_ms: 5000,
  });
  assert.match(
    source,
    /capturedCurrentProviderId\s*=\s*await connection\.evaluate\(\s*currentProviderExpression\(\)\s*,?\s*\)/,
  );
  assert.match(
    source,
    /providerId = `ccswitch_live_\$\{randomUUID\(\).replaceAll\("-", ""\)\}/,
  );
  assert.ok(source.includes("JSON.stringify(capturedCurrentProviderId)"));
  assert.ok(
    source.includes(
      "[`model_providers.${providerId}`]: fixtureProviderDefinition(localBase)",
    ),
  );
  assert.equal(
    source.includes("[`model_providers.${providerId}.base_url`]"),
    false,
  );
});

test("owner audit view diagnostics accept only fixed status, thread binding and blocker evidence", async () => {
  const { api } = await ownerAuditContext();
  const base = {
    ...ownerAuditReady(),
    viewStatus: "idle",
    threadMatches: true,
    continueBlocker: null,
  };
  const ready = api.validateOwnerAuditEvidence(
    base,
    base.auditNonce,
    "initial-turn",
    true,
  );
  assert.equal(ready.publicEvidence.viewStatus, "idle");
  assert.equal(ready.publicEvidence.threadMatches, true);
  assert.equal(ready.publicEvidence.continueBlocker, null);
  for (const viewStatus of [
    null,
    "idle",
    "active",
    "waiting",
    "error",
    "unknown",
  ])
    for (const continueBlocker of [
      null,
      "thread_not_idle",
      "latest_turn_unavailable",
      "model_unavailable",
      "provider_unavailable",
      "thread_binding_unavailable",
      "user_action_unavailable",
      "user_action_changed",
      "reference_unavailable",
      "mutation_evidence_unavailable",
      "unknown",
    ]) {
      const failed = {
        ...base,
        stage: "native_owner_view",
        ready: false,
        snapshotVerified: false,
        error: "redacted-private",
        viewStatus,
        threadMatches: false,
        continueBlocker,
      };
      const diagnostic = api.validateOwnerAuditEvidence(
        failed,
        base.auditNonce,
        "initial-turn",
      ).publicEvidence;
      assert.equal(diagnostic.viewStatus, viewStatus);
      assert.equal(diagnostic.threadMatches, false);
      assert.equal(diagnostic.continueBlocker, continueBlocker);
      assert.equal(
        JSON.stringify(diagnostic).includes("redacted-private"),
        false,
      );
    }
  for (const invalid of [
    { ...base, viewStatus: "redacted-private" },
    { ...base, continueBlocker: "redacted-private" },
    { ...base, threadMatches: "redacted-private" },
    { ...base, viewStatus: "active" },
    { ...base, threadMatches: false },
    { ...base, continueBlocker: "thread_not_idle" },
  ])
    assert.throws(
      () =>
        api.validateOwnerAuditEvidence(
          invalid,
          base.auditNonce,
          "initial-turn",
          true,
        ),
      /owner_audit_invalid_evidence/,
    );
  let reads = 0;
  const getter = { ...base };
  Object.defineProperty(getter, "continueBlocker", {
    get() {
      reads += 1;
      return "redacted-private";
    },
  });
  assert.throws(
    () =>
      api.validateOwnerAuditEvidence(getter, base.auditNonce, "initial-turn"),
    /owner_audit_invalid_evidence/,
  );
  assert.equal(reads, 0);
});

const completionPollContext = async (owner, responses) => {
  const source = await readMonitorSource();
  const stage = owner
    ? 'stage = "owner_remote_completion";'
    : 'stage = "continued_completion";';
  const begin = source.indexOf(
    "  const complete = await waitUntil",
    source.indexOf(stage),
  );
  const end = source.indexOf("  assert.equal(complete.turnCount, 2);", begin);
  assert.ok(begin >= 0 && end > begin);
  let reads = 0;
  const context = vm.createContext({
    connection: {
      evaluate: async () => responses[Math.min(reads++, responses.length - 1)],
    },
    threadProjection: () => "read-exact-owned-thread",
    waitUntil: async (read) => {
      for (let index = 0; index < responses.length; index += 1) {
        const value = await read();
        if (value) return value;
      }
      throw new Error("verification_deadline");
    },
    projectOwnedThreadReadFailure: (value) => ({
      reason: value.reason,
      protocolCode: value.protocolCode,
    }),
    fail: (code) => new Error(code),
    ownedThreadReadFailure: undefined,
    ownedTurnIds: ["initial-turn", "exact-ack-turn"],
    failed: { turnId: "initial-turn" },
    submitted: { turnId: "exact-ack-turn" },
    result: { acknowledgedTurnId: "exact-ack-turn" },
  });
  return {
    context,
    poll: () =>
      vm.runInContext(
        "(async () => {" + source.slice(begin, end) + "return complete;})()",
        context,
      ),
    reads: () => reads,
  };
};

test("both exact-ACK completion polls wait for positive idle after a completed turn with active metadata", async () => {
  for (const owner of [false, true]) {
    const complete = {
      threadMatches: true,
      turnId: "exact-ack-turn",
      turnCount: 2,
      status: "completed",
    };
    const fixture = await completionPollContext(owner, [
      { ...complete, threadStatus: "active" },
      { ...complete, threadStatus: "idle" },
    ]);
    const result = await fixture.poll();
    assert.equal(
      fixture.reads(),
      2,
      "Completed turn alone must not authorize success/early cleanup while metadata is active",
    );
    assert.equal(result.threadStatus, "idle");
    assert.equal(result.turnId, "exact-ack-turn");
  }
});

test("both completion polls treat a read rejection as terminal without retry or turn adoption", async () => {
  for (const owner of [false, true]) {
    const fixture = await completionPollContext(owner, [
      {
        readFailure: {
          reason: "thread_not_ready",
          protocolCode: "internal_error",
        },
      },
      {
        threadMatches: true,
        turnId: "exact-ack-turn",
        turnCount: 2,
        status: "completed",
        threadStatus: "idle",
      },
    ]);
    await assert.rejects(fixture.poll(), /owned_thread_read_rejected/);
    assert.equal(fixture.reads(), 1);
    assert.deepEqual(
      JSON.parse(JSON.stringify(fixture.context.ownedThreadReadFailure)),
      { reason: "thread_not_ready", protocolCode: "internal_error" },
    );
  }
});

test("cleanup diagnostics classify only fixed reasons without raw errors or getter reads", async () => {
  const source = await readMonitorSource();
  const begin = source.indexOf("const projectCleanupResult =");
  const end = source.indexOf("const cleanupExpression =", begin);
  assert.ok(
    begin >= 0 && end > begin,
    "Cleanup failures must expose bounded fixed diagnostics",
  );
  const context = vm.createContext({});
  const api = vm.runInContext(
    source.slice(begin, end) +
      "; ({projectCleanupResult,classifyCleanupFailure})",
    context,
  );
  for (const reason of [
    "archived",
    "no_lease",
    "unexpected_turn",
    "thread_active",
    "latest_turn_not_terminal",
    "thread_read_rejected",
    "archive_rejected",
  ]) {
    const projected = api.projectCleanupResult({
      archived: reason === "archived",
      reason,
    });
    assert.equal(projected.reason, reason);
    assert.equal(projected.archived, reason === "archived");
  }
  assert.equal(
    api.projectCleanupResult({ archived: false, reason: "redacted-private" })
      .reason,
    "unclassified",
  );
  assert.equal(
    api.classifyCleanupFailure(new Error("cdp_command_timeout")),
    "command_timeout",
  );
  assert.equal(
    api.classifyCleanupFailure(new Error("redacted-private")),
    "cleanup_rejected",
  );
  let reads = 0;
  const reflected = {};
  for (const key of ["reason", "archived", "message"])
    Object.defineProperty(reflected, key, {
      get() {
        reads += 1;
        throw new Error("redacted-private");
      },
    });
  assert.equal(api.projectCleanupResult(reflected).reason, "unclassified");
  assert.equal(api.classifyCleanupFailure(reflected), "cleanup_rejected");
  assert.equal(reads, 0);
});

test("actual cleanup read, active-metadata and archive refusals emit fixed diagnostics with no retry", async () => {
  const source = await readMonitorSource();
  const guardBegin = source.indexOf("const guarded = (body) =>");
  const guardEnd = source.indexOf("const waitUntil = async", guardBegin);
  const cleanupBegin = source.indexOf("const cleanupExpression = () =>");
  const cleanupEnd = source.indexOf(
    "const restoreSourceRuntimeAfterNativeCheck =",
    cleanupBegin,
  );
  for (const [scenario, reason, expectedCalls] of [
    ["active", "thread_active", ["thread/read"]],
    ["read_rejected", "thread_read_rejected", ["thread/read"]],
    ["archive_rejected", "archive_rejected", ["thread/read", "thread/archive"]],
    ["not_terminal", "latest_turn_not_terminal", ["thread/read"]],
  ]) {
    const calls = [];
    const threadId = "owned-cleanup-thread";
    const leaseKey = "owned-cleanup-lease";
    const patchKey = "owned-cleanup-runtime";
    const context = vm.createContext({
      threadId,
      leaseKey,
      patchKey,
      expectedFingerprint: fingerprint,
      recoveryId: "owned-recovery",
      ownedTurnIds: ["owned-ack-turn"],
      window: {
        [patchKey]: { rendererRuntimeFingerprint: fingerprint },
        [leaseKey]: {
          threadId,
          request: async (method) => {
            calls.push(method);
            if (method === "thread/read") {
              if (scenario === "read_rejected")
                throw new Error("redacted-private");
              return {
                thread: {
                  id: threadId,
                  status: { type: scenario === "active" ? "active" : "idle" },
                  turns: [
                    {
                      id: "owned-ack-turn",
                      status:
                        scenario === "not_terminal"
                          ? "inProgress"
                          : "completed",
                    },
                  ],
                },
              };
            }
            if (scenario === "archive_rejected")
              throw new Error("redacted-private");
            throw new Error("unexpected mutation");
          },
        },
      },
    });
    vm.runInContext(
      source.slice(guardBegin, guardEnd) +
        source.slice(cleanupBegin, cleanupEnd) +
        ";globalThis.expression=cleanupExpression();",
      context,
    );
    const result = await vm.runInContext(context.expression, context);
    assert.equal(result.archived, false);
    assert.equal(result.reason, reason);
    assert.deepEqual(calls, expectedCalls);
    assert.equal(JSON.stringify(result).includes("redacted-private"), false);
    assert.ok(
      context.window[leaseKey],
      "A refused cleanup must preserve the owned lease",
    );
  }
});

test("pinned precreation readiness waits only for current canonical client eligibility and never retries RPC failure", async () => {
  const source = await readMonitorSource();
  const begin = source.indexOf("const waitForPinnedCreationReadiness =");
  const end = source.indexOf("const pickerInspectionExpression =", begin);
  assert.ok(
    begin >= 0 && end > begin,
    "Fresh pinned creation eligibility must follow long native compilation",
  );
  for (const reject of [false, true]) {
    let reads = 0,
      clock = 0;
    const context = vm.createContext({
      verificationDeadline: 10000,
      Date: { now: () => clock },
      sleep: async (ms) => {
        clock += ms;
      },
      fail: (code) => new Error(code),
      readinessExpression: () => "pinned-canonical-readiness",
      creationReadinessDiagnostics: undefined,
      readinessBlocker: undefined,
      connection: {
        evaluate: async (expression) => {
          assert.equal(expression, "pinned-canonical-readiness");
          reads += 1;
          if (reject) throw new Error("cdp_command_timeout");
          return {
            ready: reads === 2,
            readinessBlocker:
              reads === 2 ? null : "desktop_request_client_unavailable",
            diagnostics: {
              eligibleGuardedRequestClientCount: reads === 2 ? 1 : 0,
            },
          };
        },
      },
    });
    const run = vm.runInContext(
      source.slice(begin, end) + ";waitForPinnedCreationReadiness",
      context,
    );
    if (reject) {
      await assert.rejects(run(), /cdp_command_timeout/);
      assert.equal(reads, 1);
    } else {
      await run();
      assert.equal(reads, 2);
      assert.equal(
        context.creationReadinessDiagnostics.eligibleGuardedRequestClientCount,
        1,
      );
    }
  }
  const run = source.slice(source.indexOf("const run = async () =>"));
  assert.ok(
    run.indexOf("await waitForPinnedCreationReadiness()") >
      run.indexOf("await compileOwnerAuditExecutable()"),
  );
  assert.ok(
    run.indexOf("await waitForPinnedCreationReadiness()") <
      run.indexOf("testThreadCreationAttempted = true"),
  );
  assert.ok(
    source.includes(
      "eligibleGuardedRequestClientCount: eligibleClients.length",
    ),
  );
});

test("owner ready error snapshots require explicit terminal-failure proof and never normalize active or unknown", async () => {
  const { api } = await ownerAuditContext();
  for (const latestTurnStatus of ["failed", "interrupted"]) {
    const value = {
      ...ownerAuditReady(),
      viewStatus: "error",
      latestTurnStatus,
    };
    const proof = api.validateOwnerAuditEvidence(
      value,
      value.auditNonce,
      "initial-turn",
      true,
    );
    assert.equal(proof.publicEvidence.viewStatus, "error");
    assert.equal(proof.publicEvidence.latestTurnStatus, latestTurnStatus);
  }
  for (const latestTurnStatus of [
    null,
    "completed",
    "inProgress",
    "unknown",
    "redacted-private",
  ]) {
    const value = {
      ...ownerAuditReady(),
      viewStatus: "error",
      latestTurnStatus,
    };
    assert.throws(
      () =>
        api.validateOwnerAuditEvidence(
          value,
          value.auditNonce,
          "initial-turn",
          true,
        ),
      /owner_audit_invalid_evidence/,
    );
  }
  for (const viewStatus of ["active", "waiting", "unknown"]) {
    const value = {
      ...ownerAuditReady(),
      viewStatus,
      latestTurnStatus: "failed",
    };
    assert.throws(
      () =>
        api.validateOwnerAuditEvidence(
          value,
          value.auditNonce,
          "initial-turn",
          true,
        ),
      /owner_audit_invalid_evidence/,
    );
  }
});

test("owner fixture precommit accepts exact failed systemError but rejects active, unknown, wrong turn and nonfailure", async () => {
  const source = await readMonitorSource();
  const ownerBegin = source.indexOf("const verifyOwnerRemoteFixture =");
  const begin = source.indexOf(
    "  const sameFailure = await connection.evaluate",
    ownerBegin,
  );
  const end = source.indexOf("  checkNativeIdentity();", begin);
  assert.ok(begin >= 0 && end > begin);
  const base = {
    threadMatches: true,
    turnId: "initial-turn",
    status: "failed",
    turnCount: 1,
    threadStatus: "idle",
  };
  const check = (value) =>
    vm.runInNewContext("(async()=>{" + source.slice(begin, end) + "})()", {
      connection: { evaluate: async () => value },
      threadProjection: () => "exact-lease-read",
      failed: { turnId: "initial-turn" },
      initialRequests: 1,
      continuedRequests: 0,
      fail: (code) => new Error(code),
    });
  for (const threadStatus of ["idle", "systemError"])
    await check({ ...base, threadStatus });
  for (const value of [
    { ...base, threadStatus: "active" },
    { ...base, threadStatus: "unknown" },
    { ...base, threadStatus: "error" },
    { ...base, threadStatus: "systemError", status: "completed" },
    { ...base, threadStatus: "systemError", status: "interrupted" },
    { ...base, threadStatus: "systemError", turnId: "unowned-turn" },
    { ...base, threadStatus: "systemError", turnCount: 2 },
  ])
    await assert.rejects(check(value), /unexpected_test_thread_turn/);
});

test("initial fixture request is observed locally before the first thread read without retrying rejected RPCs", async () => {
  const source = await readMonitorSource();
  const begin = source.indexOf("const waitForInitialFixtureRequest =");
  const end = source.indexOf("const classifyOwnedThreadReadFailure =", begin);
  assert.ok(
    begin >= 0 && end > begin,
    "Initial local request must precede owned thread/read readiness",
  );
  let polls = 0;
  const context = vm.createContext({
    initialRequests: 0,
    continuedRequests: 0,
    fixtureFailure: false,
    fail: (code) => new Error(code),
    waitUntil: async (read) => {
      polls += 1;
      assert.equal(await read(), null);
      context.initialRequests = 1;
      polls += 1;
      assert.equal(await read(), true);
    },
  });
  await vm.runInContext(
    source.slice(begin, end) + ";waitForInitialFixtureRequest();",
    context,
  );
  assert.equal(polls, 2);
  const run = source.slice(source.indexOf("const run = async () =>"));
  assert.ok(
    run.indexOf("await waitForInitialFixtureRequest()") <
      run.indexOf('stage = "initial_failed_turn"'),
  );
  assert.ok(
    run.indexOf("await waitForInitialFixtureRequest()") >
      run.indexOf("ownedTurnIds.push(initialTurn.turnId)"),
  );
});

const ownerAuditCanonicalRefusal = () => ({
  ...ownerAuditReady(),
  stage: "native_owner_continue",
  error: "redacted-private",
  continueRequestSent: true,
  postStatus: "refused",
  postSubmitted: false,
  postMutationAttempted: false,
  operationMatches: true,
  postElapsedMs: 7,
  canonicalReceiptMatches: true,
  canonicalRefusalVerified: true,
});

test("canonical owner refusal requires exact submitted-false mutation-false GET agreement and never acts as an ACK", async () => {
  const { api } = await ownerAuditContext();
  const refused = ownerAuditCanonicalRefusal();
  const proof = api.validateOwnerAuditEvidence(
    refused,
    refused.auditNonce,
    "initial-turn",
  );
  assert.equal(proof.publicEvidence.canonicalRefusalVerified, true);
  assert.equal(proof.acknowledgedTurnId, undefined);
  assert.equal(proof.publicEvidence.receiptVerified, false);
  assert.equal(proof.publicEvidence.postElapsedMs, 7);
  for (const invalid of [
    { ...refused, postStatus: "pending" },
    { ...refused, postStatus: "uncertain" },
    { ...refused, postStatus: "unknown" },
    { ...refused, postSubmitted: true },
    { ...refused, postSubmitted: null },
    { ...refused, postMutationAttempted: true },
    { ...refused, postMutationAttempted: null },
    { ...refused, operationMatches: false },
    { ...refused, canonicalReceiptMatches: false },
    {
      ...refused,
      acknowledgementVerified: true,
      acknowledgedTurnId: "unproven-turn",
    },
    { ...refused, receiptVerified: true },
    { ...refused, postElapsedMs: 120001 },
    { ...refused, postElapsedMs: -1 },
    { ...refused, postElapsedMs: "redacted-private" },
  ])
    assert.throws(
      () =>
        api.validateOwnerAuditEvidence(
          invalid,
          refused.auditNonce,
          "initial-turn",
        ),
      /owner_audit_invalid_evidence/,
    );
  assert.equal(
    JSON.stringify(proof.publicEvidence).includes("redacted-private"),
    false,
  );
});

test("only a closed native child plus canonical refusal and exact unchanged failed fixture clears uncertainty", async () => {
  const source = await readMonitorSource();
  const begin = source.indexOf("const resolveOwnerAuditMutationUncertainty =");
  const end = source.indexOf("const verifyOwnerRemoteFixture =", begin);
  assert.ok(
    begin >= 0 && end > begin,
    "Canonical terminal refusal needs independent exact base-turn proof before cleanup",
  );
  const base = {
    threadMatches: true,
    turnId: "initial-turn",
    turnCount: 1,
    status: "failed",
    threadStatus: "systemError",
  };
  for (const [overrides, latest, expected] of [
    [{}, base, false],
    [{ ownerAuditChild: { closed: false } }, base, true],
    [
      {
        ownerAuditDiagnostics: {
          ...ownerAuditCanonicalRefusal(),
          canonicalRefusalVerified: false,
        },
      },
      base,
      true,
    ],
    [{}, { ...base, turnId: "unowned-turn" }, true],
    [{}, { ...base, turnCount: 2 }, true],
    [{}, { ...base, threadStatus: "active" }, true],
    [{}, { ...base, status: "completed" }, true],
    [{ continuedRequests: 1 }, base, true],
  ]) {
    let reads = 0;
    const ownedTurnIds = ["initial-turn"];
    const context = vm.createContext({
      ownerAuditMutationUncertain: true,
      ownerAuditChild: { closed: true },
      ownerAuditAcknowledgedTurnId: undefined,
      ownerAuditInitialTurnId: "initial-turn",
      ownerAuditDiagnostics: ownerAuditCanonicalRefusal(),
      initialRequests: 1,
      continuedRequests: 0,
      fixtureFailure: false,
      ownedTurnIds,
      connection: {
        evaluate: async (expression) => {
          assert.equal(expression, "exact-owned-read");
          reads += 1;
          return latest;
        },
      },
      threadProjection: () => "exact-owned-read",
      ...overrides,
    });
    await vm.runInContext(
      source.slice(begin, end) + ";resolveOwnerAuditMutationUncertainty();",
      context,
    );
    assert.equal(context.ownerAuditMutationUncertain, expected);
    assert.ok(reads <= 1, "No RPC retry or any mutation is allowed");
    assert.deepEqual(
      ownedTurnIds,
      ["initial-turn"],
      "Refusal never grants ownership of another latest turn",
    );
  }
});

test("browser audit single-UI-submit success requires explicit context and never weakens default native duplicate proof", async () => {
  const { api } = await ownerAuditContext();
  const success = {
    ...ownerAuditReady(),
    stage: "completed",
    passed: true,
    continueRequestSent: true,
    acknowledgementVerified: true,
    acknowledgedTurnId: "exact-new-turn",
    receiptVerified: true,
    postStatus: "submitted",
    postSubmitted: true,
    postMutationAttempted: true,
    operationMatches: true,
    postElapsedMs: 5,
    canonicalReceiptMatches: true,
    duplicateRefused: false,
  };
  assert.throws(
    () =>
      api.validateOwnerAuditEvidence(
        success,
        success.auditNonce,
        "initial-turn",
      ),
    /owner_audit_invalid_evidence/,
  );
  const browser = api.validateOwnerAuditEvidence(
    success,
    success.auditNonce,
    "initial-turn",
    false,
    true,
  );
  assert.equal(browser.publicEvidence.passed, true);
  assert.equal(browser.publicEvidence.duplicateRefused, false);
  for (const invalid of [
    { ...success, receiptVerified: false },
    { ...success, canonicalReceiptMatches: false },
    { ...success, acknowledgementVerified: false },
    { ...success, postStatus: "uncertain" },
    { ...success, postMutationAttempted: false },
  ])
    assert.throws(
      () =>
        api.validateOwnerAuditEvidence(
          invalid,
          success.auditNonce,
          "initial-turn",
          false,
          true,
        ),
      /owner_audit_invalid_evidence/,
    );
});

test("browser audit is explicit with an absolute bundled runtime and preserves the normal native mode", async () => {
  const source = await readMonitorSource();
  const begin = source.indexOf("const ownerRemoteAudit =");
  const end = source.indexOf("const patchKey =", begin);
  const parse = (entries) =>
    vm.runInNewContext(
      source.slice(begin, end) +
        ";({ownerRemoteAudit,ownerRemoteBrowserAudit})",
      { assert, path, scenario: "overload", options: new Map(entries) },
    );
  assert.equal(
    parse([
      ["--owner-remote-audit", true],
      ["--run-disposable-test", true],
    ]).ownerRemoteBrowserAudit,
    false,
  );
  const valid = [
    ["--owner-remote-browser-audit", true],
    ["--run-disposable-test", true],
    ["--browser-runtime-root", path.join(os.tmpdir(), "runtime")],
  ];
  assert.equal(parse(valid).ownerRemoteBrowserAudit, true);
  assert.throws(
    () => parse(valid.filter(([key]) => key !== "--browser-runtime-root")),
    /absolute --browser-runtime-root/,
  );
  assert.throws(
    () =>
      parse([["--browser-runtime-root", path.join(os.tmpdir(), "runtime")]]),
    /requires --owner-remote-browser-audit/,
  );
  assert.match(source, /Configured Desktop continuation audit/);
  assert.match(
    source,
    /ownerRemoteBrowserAudit \? ownerAuditBrowserTest : ownerAuditTest/,
  );
});

test("all public browser diagnostics use the strict projector, never raw spreads", async () => {
  const source = await readMonitorSource();
  assert.match(source, /projectOwnerRemoteBrowserAuditDiagnostics,/);
  assert.equal(
    (
      source.match(
        /projectOwnerRemoteBrowserAuditDiagnostics\(\s*ownerAuditBrowser\.diagnostics/g,
      ) || []
    ).length,
    2,
  );
  assert.doesNotMatch(source, /\.\.\.ownerAuditBrowser\.diagnostics/);
});

test("owner native trace is strictly finite own-data evidence, never a mutation receipt", async () => {
  const { api } = await ownerAuditContext();
  const trace = {
    phase: "read_prepare",
    failedGate: "view_lifetime",
    evaluatorError: "owner_unauthorized",
    viewAgeMs: 30001,
    preflightCount: 8,
    lastJobStatus: "prepared",
  };
  const valid = { ...ownerAuditReady(), nativeTrace: trace };
  const result = api.validateOwnerAuditEvidence(
    valid,
    valid.auditNonce,
    "initial-turn",
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(result.publicEvidence.nativeTrace)),
    trace,
  );
  assert.equal(result.publicEvidence.passed, false);
  assert.equal(result.publicEvidence.receiptVerified, false);
  assert.equal(
    api.validateOwnerAuditEvidence(
      { ...valid, nativeTrace: null },
      valid.auditNonce,
      "initial-turn",
    ).publicEvidence.nativeTrace,
    null,
  );
  const inherited = Object.create({ phase: "read_prepare" });
  Object.assign(inherited, trace);
  delete inherited.phase;
  let touched = false;
  const getter = { ...trace };
  Object.defineProperty(getter, "phase", {
    enumerable: true,
    get() {
      touched = true;
      return "read_prepare";
    },
  });
  for (const invalid of [
    undefined,
    [],
    {},
    { ...trace, extra: "redacted-private" },
    { ...trace, phase: "redacted-private" },
    { ...trace, failedGate: "redacted-private" },
    { ...trace, evaluatorError: "redacted-private" },
    { ...trace, viewAgeMs: -1 },
    { ...trace, viewAgeMs: 120001 },
    { ...trace, viewAgeMs: 1.5 },
    { ...trace, preflightCount: 1025 },
    { ...trace, preflightCount: -1 },
    { ...trace, lastJobStatus: "redacted-private" },
    inherited,
    getter,
  ]) {
    assert.throws(
      () =>
        api.validateOwnerAuditEvidence(
          { ...valid, nativeTrace: invalid },
          valid.auditNonce,
          "initial-turn",
        ),
      /owner_audit_invalid_evidence/,
    );
  }
  assert.equal(touched, false);
  assert.equal(
    JSON.stringify(result.publicEvidence).includes("redacted-private"),
    false,
  );
});
