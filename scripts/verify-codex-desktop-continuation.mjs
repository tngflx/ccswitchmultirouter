import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer, get } from "node:http";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import {
  createOwnerRemoteBrowserAudit,
  projectOwnerRemoteBrowserAuditDiagnostics,
  readBrowserAuditFile,
} from "./owner-remote-browser-audit.mjs";
import { loadCodexRendererSourceRuntime } from "./codex-renderer-source-runtime.mjs";

// Bounded background verification of Desktop compatibility. Direct fixture
// RPCs use only the owned thread lease. Explicit full source injection may
// refresh existing model/history caches through the compatibility runtime.
const startedAt = Date.now();
const options = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (
    [
      "--run-disposable-test",
      "--inject-source-runtime",
      "--inspect-picker",
      "--owner-remote-audit",
      "--owner-remote-browser-audit",
      "--help",
    ].includes(key)
  )
    options.set(key, true);
  else {
    assert.ok(
      [
        "--port",
        "--runtime-fingerprint",
        "--ccswitch-log",
        "--ccswitch-binary",
        "--wait-ms",
        "--output",
        "--scenario",
        "--sample-count",
        "--sample-interval-ms",
        "--browser-runtime-root",
      ].includes(key),
      "Unknown verifier option",
    );
    assert.ok(process.argv[index + 1], "A verifier option needs a value");
    options.set(key, process.argv[++index]);
  }
}
if (options.has("--help")) {
  process.stdout.write(
    "Configured Desktop continuation audit.\n--run-disposable-test --owner-remote-audit: isolated native HTTP audit.\n--run-disposable-test --owner-remote-browser-audit --browser-runtime-root <absolute bundled dependencies>: isolated actual-console HTTPS/headless Edge/virtual-passkey audit (one UI Continue, no duplicate POST).\nBoth owner modes require overload, exact runtime authority and no source injection/picker inspection. Browser audit blocks history enumeration and never uses your browser profile.\n",
  );
  process.exit(0);
}
assert.equal(
  process.platform,
  "win32",
  "This verifier needs native Windows port identity",
);
const port = Number(options.get("--port") || 9229);
assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
const waitMs = Number(options.get("--wait-ms") || 0);
assert.ok(Number.isInteger(waitMs) && waitMs >= 0 && waitMs <= 900_000);
const fingerprintPattern = /^sha256-[a-f0-9]{64}$/;
let expectedFingerprint = options.get("--runtime-fingerprint");
if (expectedFingerprint)
  assert.ok(
    fingerprintPattern.test(expectedFingerprint),
    "Runtime fingerprint must be SHA256",
  );
const logPath = options.get("--ccswitch-log");
const binaryPath = options.get("--ccswitch-binary");
assert.ok(
  expectedFingerprint || (logPath && binaryPath),
  "Provide a current runtime fingerprint or exact CCSwitch log and binary paths",
);
assert.ok(
  !expectedFingerprint || !logPath,
  "Choose one runtime fingerprint authority",
);
for (const file of [logPath, binaryPath, options.get("--output")].filter(
  Boolean,
))
  assert.ok(path.isAbsolute(file), "Verifier paths must be absolute");
const runDisposableTest = options.get("--run-disposable-test") === true;
const injectSourceRuntime = options.get("--inject-source-runtime") === true;
const inspectPicker = options.get("--inspect-picker") === true;
assert.ok(
  !(inspectPicker && (runDisposableTest || injectSourceRuntime)),
  "Picker inspection cannot mutate Desktop",
);
const pickerSampleCount = Number(options.get("--sample-count") ?? 1);
const pickerSampleIntervalMs = Number(
  options.get("--sample-interval-ms") ?? 1000,
);
assert.ok(
  Number.isInteger(pickerSampleCount) &&
    pickerSampleCount >= 1 &&
    pickerSampleCount <= 16,
  "Picker sample count must be an integer from 1 to 16",
);
assert.ok(
  Number.isInteger(pickerSampleIntervalMs) &&
    pickerSampleIntervalMs >= 100 &&
    pickerSampleIntervalMs <= 5000,
  "Picker sample interval must be an integer from 100 to 5000 milliseconds",
);
assert.ok(
  inspectPicker ||
    (!options.has("--sample-count") && !options.has("--sample-interval-ms")),
  "Picker sampling options require --inspect-picker",
);
const threadScopeEvidence = () =>
  injectSourceRuntime
    ? {
        existingThreadsPrompted: false,
        fixtureOperationsRestrictedToOwnedThread: true,
        sourceRuntimeMayRefreshModelAndHistoryCaches: true,
      }
    : { existingThreadsTouched: false };
const fixtureScenarios = Object.freeze({
  overload: Object.freeze({
    code: "overloaded",
    type: "server_error",
    message: "Our servers are currently overloaded. Please try again later.",
  }),
  concurrent_limit: Object.freeze({
    code: "concurrent_limit_reached",
    type: "server_error",
    message: "Stream account concurrent limit reached. Please try again later.",
  }),
  temporary_usage: Object.freeze({
    code: "usage_limit_reached",
    type: "server_error",
    message: "You've hit your usage limit. Please try again later.",
  }),
  connection_drop: null,
  explicit_no_retry: Object.freeze({
    code: "overloaded",
    type: "server_error",
    message:
      "The upstream refused automatic continuation. Do not retry this request.",
    retryable: false,
  }),
  hard_quota: Object.freeze({
    code: "insufficient_quota",
    type: "server_error",
    message:
      "Insufficient credits. Check billing before making another request.",
  }),
});
const scenario = options.get("--scenario") || "overload";
assert.ok(
  Object.hasOwn(fixtureScenarios, scenario),
  "Unknown verifier scenario",
);
const scenarioExpectsTerminalRefusal = [
  "explicit_no_retry",
  "hard_quota",
].includes(scenario);
const ownerRemoteAudit =
  options.get("--owner-remote-audit") === true ||
  options.get("--owner-remote-browser-audit") === true;
const ownerRemoteBrowserAudit =
  options.get("--owner-remote-browser-audit") === true;
if (ownerRemoteBrowserAudit)
  assert.ok(
    typeof options.get("--browser-runtime-root") === "string" &&
      path.isAbsolute(options.get("--browser-runtime-root")),
    "Browser audit requires an absolute --browser-runtime-root",
  );
else
  assert.ok(
    !options.has("--browser-runtime-root"),
    "Browser runtime root requires --owner-remote-browser-audit",
  );
if (ownerRemoteAudit) {
  assert.equal(
    options.get("--run-disposable-test"),
    true,
    "Owner audit requires --run-disposable-test",
  );
  assert.ok(
    !options.get("--inspect-picker") && !options.get("--inject-source-runtime"),
    "Owner audit forbids picker inspection and source injection",
  );
  assert.equal(
    scenario,
    "overload",
    "Owner audit requires the overload scenario",
  );
}
const patchKey = "__ccSwitchCodexAppCompatibilityV9";
const leaseKey = `__ccSwitchContinuationVerifier_${randomUUID().replaceAll("-", "")}`;
const recoveryId = `desktop-verification-${randomUUID()}`;
let providerId;
let capturedCurrentProviderId;
const model = "fixture-model";
const fixtureProviderDefinition = (baseUrl) => ({
  name: "Isolated local protocol fixture",
  base_url: baseUrl,
  wire_api: "responses",
  requires_openai_auth: false,
  request_max_retries: 0,
  stream_max_retries: 0,
  stream_idle_timeout_ms: 5000,
});
const temporaryPrefix = path.join(
  os.tmpdir(),
  "ccswitch-desktop-continuation-",
);
let temporary;
let connection;
let fixture;
let threadId;
let testThreadCreationAttempted = false;
const ownedTurnIds = [];
let cleanupArchived = false;
let stage = "readiness";
let initialRequests = 0;
let continuedRequests = 0;
let initialTurnDiagnostics;
let latestThreadDiagnostics;
let ownedThreadReadFailure;
let continuationDiagnostics;
let receivedLiteralContinue = false;
let fixturePhase = "initial";
let fixtureFailure = false;
let binaryIdentity;
let binarySha256;
let nativeIdentity;
let nativeIdentityDiagnostic;
let readinessBlocker;
let readinessDiagnostics;
let creationReadinessDiagnostics;
let pickerInspection;
let pickerTargetInspections;
let rendererOperationFailure;
let sourceRuntimeInjection;
let sourceRuntime;
let sourceRuntimeBootstrapped = false;
let sourceRuntimeBaselineFingerprint;
let sourceRuntimeReinjectionCount = 0;
let sourceRuntimeReprepareCount = 0;
let verificationDeadline = Infinity;
let ownerAuditExecutable;
let ownerAuditChild;
let ownerAuditBrowser;
let ownerAuditNonce;
let ownerAuditInitialTurnId;
let ownerAuditAcknowledgedTurnId;
let ownerAuditDiagnostics;
let ownerAuditMutationUncertain = false;
const initialLogInfo = logPath ? await stat(logPath).catch(() => null) : null;
let logFileIdentity = initialLogInfo
  ? `${initialLogInfo.dev}:${initialLogInfo.ino}`
  : null;
let logOffset = initialLogInfo?.size || 0;
let logFragment = "";
const fail = (code) => new Error(code);
// Never serialize raw renderer exceptions: server messages can contain paths,
// prompts, credentials, or reflected provider input. Keep only fixed classes.
const classifyRendererException = (details) => {
  const exception = details?.exception;
  const structured = exception?.value;
  const issues = Array.isArray(structured)
    ? structured
    : Array.isArray(structured?.issues)
      ? structured.issues
      : Array.isArray(structured?.errors)
        ? structured.errors
        : [];
  if (
    issues
      .slice(0, 128)
      .some((issue) =>
        [
          "invalid_value",
          "invalid_type",
          "invalid_union",
          "unrecognized_keys",
        ].includes(issue?.code),
      )
  )
    return "invalid_params";
  const message = [details?.text, exception?.description, exception?.value]
    .filter((value) => typeof value === "string")
    .join(" ")
    .toLowerCase();
  for (const reason of [
    "runtime_changed",
    "client_missing",
    "lease_already_exists",
    "created_thread_missing",
    "wrong_test_thread",
    "current_provider_unavailable",
    "current_provider_changed",
  ])
    if (message.includes(reason)) return reason;
  if (
    /invalid.?params|invalid parameters|invalid type|invalid_value|invalid_type|invalid_union|unrecognized_keys|missing field|unknown field|expected (?:a |an )?(?:string|object|array|boolean|integer|number)|(?:zoderror|zod error)/.test(
      message,
    )
  )
    return "invalid_params";
  if (
    /unknown (?:method|variant)|method not found|unsupported method/.test(
      message,
    )
  )
    return "unsupported_method";
  if (
    /provider.*(?:not found|unknown|unavailable)|unknown.*provider/.test(
      message,
    )
  )
    return "provider_unavailable";
  if (/timed? ?out|timeout/.test(message)) return "timeout";
  if (/rpc.*(?:broken|disconnected)|connection.*closed/.test(message))
    return "rpc_disconnected";
  return "unclassified";
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sameIdentity = (left, right) =>
  JSON.stringify(left) === JSON.stringify(right);
// Private owner-audit IPC is opt-in, bounded and never copied into public receipts.
const ownerAuditLimit = 16 * 1024;
const ownerAuditTest =
  "services::owner_remote::tests::live_owner_remote_socket_native_round_trip";
const ownerAuditBrowserTest =
  "services::owner_remote::tests::live_owner_remote_browser_fixture";
const ownerAuditBooleanKeys = [
  "passed",
  "socketVerified",
  "webauthnVerified",
  "loginVerified",
  "csrfVerified",
  "originVerified",
  "logoutVerified",
  "snapshotVerified",
  "threadMatches",
  "latestTurnMatches",
  "modelMatches",
  "truncated",
  "ready",
  "continueRequestSent",
  "acknowledgementVerified",
  "receiptVerified",
  "duplicateRefused",
  "durableLedgerVerified",
  "operationMatches",
  "canonicalReceiptMatches",
  "canonicalRefusalVerified",
];
// Test-only native phase diagnostics have no authorization or outcome authority.
const readOwnerAuditNativeTrace = (value) => {
  if (value === null) return null;
  try {
    const keys = [
      "phase",
      "failedGate",
      "evaluatorError",
      "viewAgeMs",
      "preflightCount",
      "lastJobStatus",
    ];
    if (!value || typeof value !== "object" || Array.isArray(value)) throw 0;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const owned = Reflect.ownKeys(descriptors);
    if (
      owned.length !== keys.length ||
      owned.some((key) => typeof key !== "string" || !keys.includes(key))
    )
      throw 0;
    if (
      keys.some(
        (key) =>
          !Object.hasOwn(descriptors, key) ||
          !Object.hasOwn(descriptors[key], "value"),
      )
    )
      throw 0;
    for (const key in value) if (!Object.hasOwn(value, key)) throw 0;
    const trace = Object.fromEntries(
      keys.map((key) => [key, descriptors[key].value]),
    );
    if (
      ![
        "not_started",
        "start",
        "read_prepare",
        "confirm",
        "read_confirm",
        "commit",
        "read_ack",
      ].includes(trace.phase) ||
      ![
        null,
        "auth",
        "scope",
        "view_lifetime",
        "epoch",
        "reservation",
        "commit_cas",
      ].includes(trace.failedGate) ||
      ![
        null,
        "owner_unauthorized",
        "invalid_thread",
        "owner_platform_unavailable",
        "codex_unavailable",
        "codex_target_ambiguous",
        "view_stale",
        "content_unavailable",
        "operation_unavailable",
      ].includes(trace.evaluatorError) ||
      !(
        trace.viewAgeMs === null ||
        (Number.isInteger(trace.viewAgeMs) &&
          trace.viewAgeMs >= 0 &&
          trace.viewAgeMs <= 120000)
      ) ||
      !Number.isInteger(trace.preflightCount) ||
      trace.preflightCount < 0 ||
      trace.preflightCount > 1024 ||
      ![
        null,
        "pending",
        "prepared",
        "confirming",
        "confirmed",
        "submitting",
        "completed",
        "unknown",
      ].includes(trace.lastJobStatus)
    )
      throw 0;
    return trace;
  } catch {
    throw fail("owner_audit_invalid_evidence");
  }
};
const validateOwnerAuditEvidence = (
  value,
  nonce,
  initialTurnId,
  readyOnly = false,
  browserSingleSubmitContext = false,
) => {
  const required = [
    "schemaVersion",
    "auditNonce",
    "stage",
    "error",
    "turnCount",
    "itemCount",
    "nativeError",
    "viewStatus",
    "latestTurnStatus",
    "continueBlocker",
    "postStatus",
    "postSubmitted",
    "postMutationAttempted",
    "postElapsedMs",
    "nativeTrace",
    ...ownerAuditBooleanKeys,
  ];
  let data;
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw 0;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Object.keys(descriptors).some(
        (key) => ![...required, "acknowledgedTurnId"].includes(key),
      )
    )
      throw 0;
    if (
      required.some(
        (key) =>
          !Object.hasOwn(descriptors, key) ||
          !Object.hasOwn(descriptors[key], "value"),
      )
    )
      throw 0;
    if (
      Object.values(descriptors).some(
        (descriptor) => !Object.hasOwn(descriptor, "value"),
      )
    )
      throw 0;
    data = Object.fromEntries(
      Object.entries(descriptors).map(([key, descriptor]) => [
        key,
        descriptor.value,
      ]),
    );
  } catch {
    throw fail("owner_audit_invalid_evidence");
  }
  const stages = [
    "isolated_setup",
    "socket_authentication",
    "native_owner_view",
    "owner_view_ready",
    "native_owner_continue",
    "completed",
  ];
  const nativeErrors = [
    null,
    "codex_unavailable",
    "codex_target_ambiguous",
    "view_stale",
    "content_unavailable",
    "operation_unavailable",
  ];
  if (
    data.schemaVersion !== 1 ||
    !/^[a-f0-9]{64}$/.test(nonce) ||
    data.auditNonce !== nonce ||
    !stages.includes(data.stage) ||
    !nativeErrors.includes(data.nativeError) ||
    ![null, "idle", "active", "waiting", "error", "unknown"].includes(
      data.viewStatus,
    ) ||
    ![
      null,
      "completed",
      "failed",
      "interrupted",
      "inProgress",
      "unknown",
    ].includes(data.latestTurnStatus) ||
    ![
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
    ].includes(data.continueBlocker) ||
    ![null, "pending", "submitted", "uncertain", "refused", "unknown"].includes(
      data.postStatus,
    ) ||
    ![null, true, false].includes(data.postSubmitted) ||
    ![null, true, false].includes(data.postMutationAttempted) ||
    !(
      data.postElapsedMs === null ||
      (Number.isInteger(data.postElapsedMs) &&
        data.postElapsedMs >= 0 &&
        data.postElapsedMs <= 120000)
    ) ||
    !(data.error === null || typeof data.error === "string") ||
    ownerAuditBooleanKeys.some((key) => typeof data[key] !== "boolean") ||
    !Number.isInteger(data.turnCount) ||
    data.turnCount < 0 ||
    data.turnCount > 20 ||
    !Number.isInteger(data.itemCount) ||
    data.itemCount < 0 ||
    data.itemCount > 120 ||
    data.durableLedgerVerified !== false
  )
    throw fail("owner_audit_invalid_evidence");
  data.nativeTrace = readOwnerAuditNativeTrace(data.nativeTrace);
  const hasAck = Object.hasOwn(data, "acknowledgedTurnId");
  if (
    hasAck !== data.acknowledgementVerified ||
    (hasAck &&
      (!data.continueRequestSent ||
        data.postStatus !== "submitted" ||
        data.postSubmitted !== true ||
        data.postMutationAttempted !== true ||
        !data.operationMatches ||
        typeof data.acknowledgedTurnId !== "string" ||
        !/^[A-Za-z0-9_-]{1,256}$/.test(data.acknowledgedTurnId) ||
        data.acknowledgedTurnId === initialTurnId)) ||
    (data.receiptVerified && !hasAck) ||
    (data.duplicateRefused && !data.receiptVerified)
  )
    throw fail("owner_audit_invalid_evidence");
  if (
    data.canonicalReceiptMatches &&
    (!data.continueRequestSent ||
      !data.operationMatches ||
      !["pending", "submitted", "uncertain", "refused"].includes(
        data.postStatus,
      ) ||
      typeof data.postSubmitted !== "boolean" ||
      typeof data.postMutationAttempted !== "boolean" ||
      data.postElapsedMs === null)
  )
    throw fail("owner_audit_invalid_evidence");
  if (
    data.canonicalRefusalVerified &&
    (data.stage !== "native_owner_continue" ||
      data.passed ||
      !data.canonicalReceiptMatches ||
      data.postStatus !== "refused" ||
      data.postSubmitted !== false ||
      data.postMutationAttempted !== false ||
      hasAck ||
      data.receiptVerified ||
      data.duplicateRefused)
  )
    throw fail("owner_audit_invalid_evidence");
  const proof = [
    "socketVerified",
    "webauthnVerified",
    "loginVerified",
    "csrfVerified",
    "originVerified",
    "logoutVerified",
    "snapshotVerified",
    "threadMatches",
    "latestTurnMatches",
    "modelMatches",
  ];
  if (
    (readyOnly || data.passed || data.canonicalRefusalVerified) &&
    (proof.some((key) => !data[key]) ||
      data.turnCount < 1 ||
      !data.ready ||
      !(
        data.viewStatus === "idle" ||
        (data.viewStatus === "error" &&
          ["failed", "interrupted"].includes(data.latestTurnStatus))
      ) ||
      data.continueBlocker !== null ||
      (!data.canonicalRefusalVerified && data.error !== null) ||
      data.nativeError !== null)
  )
    throw fail("owner_audit_invalid_evidence");
  if (
    readyOnly &&
    (data.stage !== "owner_view_ready" ||
      data.passed ||
      data.continueRequestSent ||
      hasAck ||
      data.receiptVerified ||
      data.duplicateRefused ||
      data.postStatus !== null ||
      data.postSubmitted !== null ||
      data.postMutationAttempted !== null ||
      data.postElapsedMs !== null ||
      data.operationMatches ||
      data.canonicalReceiptMatches ||
      data.canonicalRefusalVerified)
  )
    throw fail("owner_audit_invalid_evidence");
  if (
    data.passed &&
    (data.stage !== "completed" ||
      !data.continueRequestSent ||
      !hasAck ||
      !data.receiptVerified ||
      (!data.duplicateRefused && !browserSingleSubmitContext) ||
      !data.canonicalReceiptMatches ||
      data.canonicalRefusalVerified)
  )
    throw fail("owner_audit_invalid_evidence");
  const publicEvidence = Object.fromEntries(
    [
      "stage",
      "turnCount",
      "itemCount",
      "nativeError",
      "viewStatus",
      "latestTurnStatus",
      "continueBlocker",
      "postStatus",
      "postSubmitted",
      "postMutationAttempted",
      "postElapsedMs",
      "nativeTrace",
      ...ownerAuditBooleanKeys,
    ].map((key) => [key, data[key]]),
  );
  publicEvidence.error = data.error === null ? null : "child_refused";
  return {
    publicEvidence,
    acknowledgedTurnId: hasAck ? data.acknowledgedTurnId : undefined,
  };
};
const publishOwnerAuditFile = async (directory, name, value) => {
  if (!["request.json", "commit.json"].includes(name))
    throw fail("owner_audit_invalid_handoff");
  const bytes = Buffer.from(JSON.stringify(value));
  if (!bytes.length || bytes.length > ownerAuditLimit)
    throw fail("owner_audit_invalid_handoff");
  const pending = path.join(directory, `.owner-audit-${randomUUID()}.tmp`);
  const target = path.join(directory, name);
  let handle;
  let owned = false;
  try {
    handle = await open(pending, "wx");
    owned = true;
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(pending, target); // Atomic exclusive publication: never rename over a file.
  } catch {
    throw fail("owner_audit_handoff_failed");
  } finally {
    await handle?.close().catch(() => {});
    if (owned) await unlink(pending).catch(() => {});
  }
};
const readOwnerAuditFile = async (directory, name) => {
  if (!["ready.json", "result.json"].includes(name))
    throw fail("owner_audit_invalid_handoff");
  const target = path.join(directory, name);
  const before = await lstat(target).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw fail("owner_audit_invalid_evidence");
  });
  if (!before) return null;
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size === 0 ||
    before.size > ownerAuditLimit
  )
    throw fail("owner_audit_invalid_evidence");
  const file = await open(target, "r").catch(() => {
    throw fail("owner_audit_invalid_evidence");
  });
  try {
    const opened = await file.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    )
      throw 0;
    const bytes = Buffer.alloc(ownerAuditLimit + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (!length || length > ownerAuditLimit) throw 0;
    return JSON.parse(bytes.subarray(0, length).toString("utf8"));
  } catch {
    throw fail("owner_audit_invalid_evidence");
  } finally {
    await file.close();
  }
};
const spawnOwnedOwnerAuditChild = (
  executable,
  args,
  childOptions,
  collectOutput = false,
) => {
  const child = spawn(executable, args, {
    ...childOptions,
    windowsHide: true,
    stdio: ["ignore", collectOutput ? "pipe" : "ignore", "ignore"],
  });
  const state = {
    child,
    closed: false,
    code: null,
    output: "",
    overflow: false,
  };
  state.close = new Promise((resolve) => {
    child.once("error", () => {}); // Only a fixed failure is reported after actual close.
    child.once("close", (code) => {
      state.closed = true;
      state.code = code;
      resolve();
    });
  });
  if (collectOutput)
    child.stdout.on("data", (chunk) => {
      if (state.output.length + chunk.length > 8 * 1024 * 1024)
        state.overflow = true;
      else state.output += chunk.toString("utf8");
    });
  return state;
};
const waitOwnerAuditChildClose = async (state, milliseconds) => {
  if (state.closed) return true;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    state.close.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
  return state.closed;
};
const settleOwnerAuditChild = async (state, grace = 5000) => {
  if (!state || (await waitOwnerAuditChildClose(state, grace))) return true;
  try {
    state.child.kill();
  } catch {
    /* Exact owned process only. */
  }
  return waitOwnerAuditChildClose(state, 5000);
};
const selectOwnerAuditExecutable = (output) => {
  const artifacts = [];
  for (const line of output.split(/\r?\n/)) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      entry.reason === "compiler-artifact" &&
      entry.target?.name === "cc_switch_lib" &&
      entry.profile?.test === true &&
      Array.isArray(entry.target?.kind) &&
      entry.target.kind.length > 0 &&
      entry.target.kind.every((kind) =>
        ["lib", "rlib", "staticlib", "cdylib", "dylib"].includes(kind),
      ) &&
      typeof entry.executable === "string" &&
      path.isAbsolute(entry.executable)
    )
      artifacts.push(entry.executable);
  }
  const unique = [...new Set(artifacts)];
  if (unique.length !== 1) throw fail("owner_audit_compile_failed");
  return unique[0];
};
const compileOwnerAuditExecutable = async (testName = ownerAuditTest) => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const compilation = spawnOwnedOwnerAuditChild(
    "cargo",
    [
      "test",
      "--manifest-path",
      path.join(root, "src-tauri", "Cargo.toml"),
      "--lib",
      testName,
      "--no-run",
      "--message-format=json",
    ],
    { cwd: root },
    true,
  );
  if (!(await waitOwnerAuditChildClose(compilation, 180000))) {
    await settleOwnerAuditChild(compilation, 0);
    throw fail("owner_audit_compile_failed");
  }
  if (compilation.code !== 0 || compilation.overflow)
    throw fail("owner_audit_compile_failed");
  return selectOwnerAuditExecutable(compilation.output);
};
const captureOwnerAuditResult = async () => {
  const result = await readOwnerAuditFile(temporary, "result.json");
  if (!result) return null;
  const checked = validateOwnerAuditEvidence(
    result,
    ownerAuditNonce,
    ownerAuditInitialTurnId,
    false,
    ownerRemoteBrowserAudit,
  );
  ownerAuditDiagnostics = checked.publicEvidence;
  if (checked.acknowledgedTurnId) {
    ownerAuditAcknowledgedTurnId = checked.acknowledgedTurnId;
    if (!ownedTurnIds.includes(checked.acknowledgedTurnId))
      ownedTurnIds.push(checked.acknowledgedTurnId);
  }
  return checked;
};
const resolveOwnerAuditMutationUncertainty = async () => {
  if (!ownerAuditMutationUncertain || !ownerAuditChild?.closed || !connection)
    return;
  const refusal =
    !ownerAuditAcknowledgedTurnId &&
    ownerAuditDiagnostics?.canonicalRefusalVerified === true &&
    ownerAuditDiagnostics.canonicalReceiptMatches === true &&
    ownerAuditDiagnostics.operationMatches === true &&
    ownerAuditDiagnostics.postStatus === "refused" &&
    ownerAuditDiagnostics.postSubmitted === false &&
    ownerAuditDiagnostics.postMutationAttempted === false &&
    ownerAuditDiagnostics.acknowledgementVerified === false;
  if (!ownerAuditAcknowledgedTurnId && !refusal) return;
  try {
    const latest = await connection.evaluate(threadProjection(), 2500);
    if (ownerAuditAcknowledgedTurnId) {
      if (
        latest?.threadMatches === true &&
        latest.turnId === ownerAuditAcknowledgedTurnId &&
        latest.turnCount === 2 &&
        latest.threadStatus === "idle" &&
        ["completed", "failed", "interrupted"].includes(latest.status)
      )
        ownerAuditMutationUncertain = false;
    } else if (
      refusal &&
      latest?.threadMatches === true &&
      latest.turnId === ownerAuditInitialTurnId &&
      latest.turnCount === 1 &&
      latest.status === "failed" &&
      ["idle", "systemError"].includes(latest.threadStatus) &&
      initialRequests === 1 &&
      continuedRequests === 0 &&
      !fixtureFailure
    )
      ownerAuditMutationUncertain = false;
  } catch {
    /* Unknown state never authorizes archival or a replacement send. */
  }
};
const verifyOwnerRemoteFixture = async (failed, localBase) => {
  stage = "owner_remote_handoff";
  ownerAuditNonce = randomBytes(32).toString("hex");
  ownerAuditInitialTurnId = failed.turnId;
  await publishOwnerAuditFile(temporary, "request.json", {
    schemaVersion: 1,
    auditNonce: ownerAuditNonce,
    threadId,
    initialTurnId: failed.turnId,
    model,
    providerId,
    fixtureBaseUrl: localBase,
    expectedRendererFingerprint: expectedFingerprint,
  });
  if (ownerRemoteBrowserAudit)
    ownerAuditBrowser = await createOwnerRemoteBrowserAudit({
      directory: temporary,
      runtimeRoot: options.get("--browser-runtime-root"),
      auditNonce: ownerAuditNonce,
      threadId,
      initialTurnId: failed.turnId,
      model,
    });
  ownerAuditChild = spawnOwnedOwnerAuditChild(
    ownerAuditExecutable,
    [
      "--ignored",
      "--exact",
      ownerRemoteBrowserAudit ? ownerAuditBrowserTest : ownerAuditTest,
      "--test-threads=1",
      "--nocapture",
    ],
    {
      cwd: temporary,
      env: {
        ...process.env,
        CC_SWITCH_OWNER_REMOTE_LIVE_HANDOFF: path.join(
          temporary,
          "request.json",
        ),
      },
    },
  );
  stage = "owner_remote_view";
  const readyDeadline = Math.min(verificationDeadline, Date.now() + 45000);
  if (ownerRemoteBrowserAudit) {
    const invitation = await ownerAuditBrowser.waitForNativeReady(
      ownerAuditChild,
      readyDeadline,
    );
    const ready = await ownerAuditBrowser.prepare(invitation);
    ownerAuditDiagnostics = validateOwnerAuditEvidence(
      ready,
      ownerAuditNonce,
      failed.turnId,
      true,
      true,
    ).publicEvidence;
  } else {
    while (true) {
      const ready = await readOwnerAuditFile(temporary, "ready.json");
      if (ready) {
        ownerAuditDiagnostics = validateOwnerAuditEvidence(
          ready,
          ownerAuditNonce,
          failed.turnId,
          true,
        ).publicEvidence;
        break;
      }
      if (ownerAuditChild.closed || Date.now() >= readyDeadline) {
        await captureOwnerAuditResult();
        throw fail("owner_audit_view_failed");
      }
      await sleep(50);
    }
  }
  const sameFailure = await connection.evaluate(threadProjection());
  if (sameFailure?.readFailure) {
    ownedThreadReadFailure = projectOwnedThreadReadFailure(
      sameFailure.readFailure,
    );
    throw fail("owned_thread_read_rejected");
  }
  if (
    sameFailure?.threadMatches !== true ||
    sameFailure.turnId !== failed.turnId ||
    sameFailure.status !== "failed" ||
    sameFailure.turnCount !== 1 ||
    !["idle", "systemError"].includes(sameFailure.threadStatus) ||
    initialRequests !== 1 ||
    continuedRequests !== 0
  )
    throw fail("unexpected_test_thread_turn");
  checkNativeIdentity();
  await checkBinary();
  fixturePhase = "continued";
  stage = "owner_remote_commit";
  // A lost response is never retried. Only a private, exact positive ACK owns a new turn.
  ownerAuditMutationUncertain = true;
  if (ownerRemoteBrowserAudit) await ownerAuditBrowser.commit();
  else
    await publishOwnerAuditFile(temporary, "commit.json", {
      schemaVersion: 1,
      auditNonce: ownerAuditNonce,
      commit: true,
    });
  const resultDeadline = Math.min(verificationDeadline, Date.now() + 60000);
  let result;
  while (!(result = await captureOwnerAuditResult())) {
    if (ownerAuditChild.closed || Date.now() >= resultDeadline)
      throw fail("owner_audit_continue_failed");
    await sleep(50);
  }
  if (!(await waitOwnerAuditChildClose(ownerAuditChild, 5000)))
    throw fail("owner_audit_child_pending");
  if (
    !result.acknowledgedTurnId ||
    !ownerAuditDiagnostics.passed ||
    ownerAuditChild.code !== 0
  )
    throw fail("owner_audit_continue_failed");
  stage = "owner_remote_completion";
  const complete = await waitUntil(async () => {
    const current = await connection.evaluate(threadProjection());
    if (current?.readFailure) {
      ownedThreadReadFailure = projectOwnedThreadReadFailure(
        current.readFailure,
      );
      throw fail("owned_thread_read_rejected");
    }
    if (
      current?.threadMatches !== true ||
      current.turnId !== result.acknowledgedTurnId
    )
      throw fail("unexpected_test_thread_turn");
    return current.status === "completed" && current.threadStatus === "idle"
      ? current
      : null;
  });
  assert.equal(complete.turnCount, 2);
  assert.equal(initialRequests, 1);
  assert.equal(continuedRequests, 1);
  assert.equal(receivedLiteralContinue, true);
  assert.equal(fixtureFailure, false);
  ownerAuditMutationUncertain = false;
  checkNativeIdentity();
  await checkBinary();
  return {
    verified: true,
    scenario,
    scope: ownerRemoteBrowserAudit
      ? "actual_owner_remote_browser_https_isolated_native_existing_renderer"
      : "actual_owner_remote_http_isolated_native_existing_renderer",
    ...(ownerAuditBrowser
      ? {
          browserAudit: projectOwnerRemoteBrowserAuditDiagnostics(
            ownerAuditBrowser.diagnostics,
          ),
        }
      : {}),
    desktopCdpVerified: true,
    ownerRemoteVerified: true,
    nativeHarnessScope: "isolated_test_native",
    installedOwnerServiceVerified: false,
    automaticNativeSchedulingVerified: false,
    durableLedgerIoVerified: false,
    remoteDeviceHttpsVerified: false,
    browserPasskeyEnrollmentVerified:
      ownerRemoteBrowserAudit &&
      ownerAuditBrowser?.diagnostics.virtualPasskeyEnrollmentVerified === true,
    runtimeFingerprint: expectedFingerprint,
    ccswitchBinarySha256: binarySha256,
    ...(creationReadinessDiagnostics ? { creationReadinessDiagnostics } : {}),
    nativeOwnerVerified: true,
    nativeHost: nativeIdentity.host,
    temporaryDurableTestThread: true,
    perThreadLocalFixtureProviderConfirmed: true,
    initialFailedTurnObserved: true,
    appServerAcceptedContinue: true,
    upstreamReceivedLiteralContinue: true,
    continuedTurnCompleted: true,
    exactlyOneContinuation: true,
    ownerRemoteAudit: ownerAuditDiagnostics,
    initialRequests,
    continuedRequests,
    ...threadScopeEvidence(),
  };
};

const cleanupTemporaryDirectory = async (evidence) => {
  if (!temporary) return;
  if (!temporary.startsWith(temporaryPrefix) || temporary === os.tmpdir()) {
    evidence.pendingDirectory = true;
    evidence.cleanupPending = "temporary_directory_outside_lease";
    return;
  }
  if (
    (ownerAuditChild && !ownerAuditChild.closed) ||
    ownerAuditMutationUncertain ||
    ((threadId || testThreadCreationAttempted) && !cleanupArchived)
  ) {
    // Keep an uncertain thread's cwd intact. Archival and directory cleanup
    // are separate: the app-server can hold cwd open after archival too.
    evidence.pendingDirectory = true;
    evidence.cleanupPending = "temporary_directory_thread_uncertain";
    return;
  }
  try {
    await rm(temporary, {
      recursive: true,
      force: true,
      maxRetries: 2,
      retryDelay: 100,
    });
  } catch (error) {
    evidence.pendingDirectory = true;
    evidence.cleanupPending =
      error?.code === "EBUSY" || error?.code === "ENOTEMPTY"
        ? "temporary_directory_busy"
        : error?.code === "EACCES" || error?.code === "EPERM"
          ? "temporary_directory_access_denied"
          : "temporary_directory_cleanup_failed";
  }
};

if (binaryPath) {
  const info = await stat(binaryPath);
  binaryIdentity = { size: info.size, modifiedAt: info.mtimeMs };
  binarySha256 = createHash("sha256")
    .update(await readFile(binaryPath))
    .digest("hex");
}
const checkBinary = async () => {
  if (!binaryPath) return;
  const info = await stat(binaryPath);
  if (
    !sameIdentity(binaryIdentity, { size: info.size, modifiedAt: info.mtimeMs })
  )
    throw fail("ccswitch_binary_changed");
};
const refreshFingerprint = async () => {
  if (!logPath) return;
  const info = await stat(logPath).catch(() => null);
  if (!info) return;
  const fileIdentity = `${info.dev}:${info.ino}`;
  if (info.size < logOffset || fileIdentity !== logFileIdentity) {
    logOffset = 0;
    logFragment = "";
  }
  logFileIdentity = fileIdentity;
  const bytes = Math.min(128 * 1024, info.size - logOffset);
  if (!bytes) return;
  const file = await open(logPath, "r");
  const buffer = Buffer.alloc(bytes);
  try {
    const read = await file.read(buffer, 0, bytes, logOffset);
    logOffset += read.bytesRead;
    const lines = (
      logFragment + buffer.subarray(0, read.bytesRead).toString("utf8")
    ).split(/\r?\n/);
    logFragment = lines.pop().slice(-64 * 1024);
    for (const line of lines) {
      if (!line.includes("Codex picker catalog payload installed:")) continue;
      const fingerprint = line.match(
        /runtime_fingerprint=(sha256-[a-f0-9]{64})(?:\s|,|$)/,
      )?.[1];
      const timestamp = line.match(
        /(\d{4}-\d{2}-\d{2})[T\] ]+\[?(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/,
      );
      const atMs = timestamp
        ? new Date(`${timestamp[1]}T${timestamp[2]}`).getTime()
        : NaN;
      if (
        fingerprint &&
        atMs >=
          Math.floor(
            Math.max(startedAt, binaryIdentity?.modifiedAt || 0) / 1000,
          ) *
            1000
      )
        expectedFingerprint = fingerprint;
    }
  } finally {
    await file.close();
  }
};

const normalizeListenerAddress = (address) => {
  if (typeof address !== "string" || isIP(address) === 0)
    throw fail("native_identity_invalid");
  try {
    return address.includes(":")
      ? new URL(`http://[${address}]/`).hostname.slice(1, -1)
      : address;
  } catch {
    throw fail("native_identity_invalid");
  }
};
const listenerCoversHost = (address, host) =>
  address === "::" ||
  (host === "::1"
    ? address === "::1"
    : ["127.0.0.1", "0.0.0.0", "::ffff:7f00:1", "::ffff:0:0"].includes(
        address,
      ));
const readNativeIdentity = () => {
  nativeIdentityDiagnostic = undefined;
  // Query only the explicitly supplied debug port. Preserve unknown owners as
  // unverified rows: they may reject their endpoint, never authorize another.
  // An IPv6 wildcard can be dual-stack, so it covers BOTH concrete endpoints.
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if ($PSVersionTable.PSVersion.Major -ne 7 -or $PSVersionTable.PSVersion.Minor -lt 5) { throw 'powershell_75_required' }
$listenerErrors = @()
$listeners = @(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue -ErrorVariable listenerErrors)
if (@($listenerErrors | Where-Object { $_.CategoryInfo.Category -ne 'ObjectNotFound' }).Count -gt 0 -or ($listenerErrors.Count -gt 0 -and $listeners.Count -gt 0)) { throw 'listener_query_failed' }
$processes = @{}
$result = @($listeners | ForEach-Object {
  $listener = $_
  $ownerPid = $listener.OwningProcess
  $key = [string]$ownerPid
  if (-not $processes.ContainsKey($key)) {
    $processes[$key] = try { Get-CimInstance Win32_Process -Filter ("ProcessId=" + $ownerPid) -ErrorAction Stop } catch { $null }
  }
  $item = $processes[$key]
  $exe = ([string]$item.ExecutablePath).Replace('/', '\\').ToLowerInvariant()
  $main = [bool]$item.CommandLine -and $item.CommandLine -notmatch ' --type='
  $packaged = $exe.Contains('\\windowsapps\\openai.codex_') -or $exe.Contains('\\windowsapps\\openai.codex.preview_')
  $legacy = @('\\windowsapps\\openai.codex_', '\\windowsapps\\openai.codex.preview_', '\\appdata\\local\\openai\\codex\\', '\\appdata\\local\\programs\\openai\\codex\\', '\\appdata\\local\\programs\\codex\\', '\\program files\\openai\\codex\\', '\\program files\\codex\\', '\\program files (x86)\\openai\\codex\\', '\\scoop\\apps\\codex\\') | Where-Object { $exe.Contains($_) }
  $creationTicks = if ($null -ne $item -and $null -ne $item.CreationDate) { $item.CreationDate.ToUniversalTime().Ticks.ToString() } else { $null }
  $verified = $creationTicks -and $main -and $exe -and (($item.Name -ceq 'ChatGPT.exe' -and $packaged) -or ($item.Name -ceq 'Codex.exe' -and $legacy.Count -gt 0 -and -not $exe.EndsWith('\\resources\\codex.exe')))
  [pscustomobject]@{address=[string]$listener.LocalAddress; pid=$ownerPid; creationTicks=$creationTicks; verified=[bool]$verified}
})
ConvertTo-Json -InputObject $result -Compress
`;
  const result = spawnSync(
    "pwsh",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, encoding: "utf8", timeout: 8000 },
  );
  if (result.status !== 0) {
    // Fixed causes only: subprocess output and exceptions may contain secrets.
    const launchCode = result.error?.code;
    const cause =
      launchCode === "ETIMEDOUT"
        ? "timeout"
        : launchCode === "ENOENT"
          ? "shell_not_found"
          : result.error
            ? "shell_launch_failed"
            : result.status === null && result.signal
              ? "shell_terminated"
              : typeof result.stderr === "string" &&
                  result.stderr.includes("powershell_75_required")
                ? "powershell_version_required"
                : "query_failed";
    nativeIdentityDiagnostic = { cause, queryTimeoutMs: 8000 };
    throw fail("native_identity_query_failed");
  }
  let listeners;
  try {
    listeners = JSON.parse(result.stdout);
  } catch {
    nativeIdentityDiagnostic = { cause: "invalid_json", queryTimeoutMs: 8000 };
    throw fail("native_identity_invalid");
  }
  if (!Array.isArray(listeners)) throw fail("native_identity_invalid");
  // Even an address we cannot interpret must not disappear from the authority
  // snapshot: it could cover the chosen loopback endpoint.
  listeners = listeners.map((listener) => ({
    ...listener,
    address: normalizeListenerAddress(listener?.address),
  }));
  const hosts = nativeIdentity ? [nativeIdentity.host] : ["127.0.0.1", "::1"];
  let blocked = false;
  for (const host of hosts) {
    if (!["127.0.0.1", "::1"].includes(host))
      throw fail("native_identity_invalid");
    const selected = listeners.filter((listener) =>
      listenerCoversHost(listener.address, host),
    );
    if (!selected.length) continue;
    if (
      selected.some(
        (owner) =>
          owner.verified !== true ||
          !Number.isSafeInteger(owner.pid) ||
          owner.pid <= 0 ||
          typeof owner.creationTicks !== "string" ||
          !/^[1-9][0-9]*$/.test(owner.creationTicks),
      )
    ) {
      blocked = true;
      continue;
    }
    const owners = new Map();
    for (const listener of selected) {
      const existing = owners.get(listener.pid);
      if (existing && existing.creationTicks !== listener.creationTicks)
        throw fail("native_identity_invalid");
      if (!existing)
        owners.set(listener.pid, {
          pid: listener.pid,
          creationTicks: listener.creationTicks,
          verified: true,
          addresses: [],
        });
      const addresses = owners.get(listener.pid).addresses;
      if (!addresses.includes(listener.address))
        addresses.push(listener.address);
    }
    return {
      host,
      owners: [...owners.values()]
        .map((owner) => ({ ...owner, addresses: owner.addresses.sort() }))
        .sort((left, right) => left.pid - right.pid),
    };
  }
  if (blocked) throw fail("debug_port_owner_not_codex");
  return null;
};
const checkNativeIdentity = () => {
  if (!sameIdentity(nativeIdentity, readNativeIdentity()))
    throw fail("debug_port_identity_changed");
};
const readTargets = () =>
  new Promise((resolve, reject) => {
    const request = get(
      { hostname: nativeIdentity.host, port, path: "/json", timeout: 2000 },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
          if (text.length > 512 * 1024)
            request.destroy(fail("target_list_invalid"));
        });
        response.on("error", () => reject(fail("target_list_unavailable")));
        response.on("end", () => {
          try {
            if (response.statusCode !== 200)
              throw fail("target_list_unavailable");
            const targets = JSON.parse(text);
            resolve(
              targets.filter((target) => {
                if (target.type !== "page") return false;
                const url = new URL(target.url);
                const socket = new URL(target.webSocketDebuggerUrl);
                const authority =
                  nativeIdentity.host === "::1" ? "[::1]" : nativeIdentity.host;
                const rawAuthority = target.webSocketDebuggerUrl.match(
                  /^ws:\/\/([^/]+)(?:\/|$)/,
                )?.[1];
                const localSocket =
                  socket.protocol === "ws:" &&
                  rawAuthority === `${authority}:${port}` &&
                  socket.hostname === authority &&
                  Number(socket.port) === port &&
                  !socket.username &&
                  !socket.password &&
                  !target.webSocketDebuggerUrl.includes("?") &&
                  !target.webSocketDebuggerUrl.includes("#");
                return (
                  localSocket &&
                  url.protocol === "app:" &&
                  url.hostname === "-" &&
                  ["/", "/index.html"].includes(url.pathname)
                );
              }),
            );
          } catch {
            reject(fail("target_list_invalid"));
          }
        });
      },
    );
    request.on("timeout", () => request.destroy(fail("target_list_timeout")));
    request.on("error", () => reject(fail("target_list_unavailable")));
  });
const connect = async (url, deadline = Infinity) => {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        socket.close();
        reject(fail("cdp_connect_timeout"));
      },
      Math.max(1, Math.min(4000, deadline - Date.now())),
    );
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(fail("cdp_connect_failed"));
      },
      { once: true },
    );
  });
  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    pending.delete(message.id);
    if (message.error) waiter.reject(fail("cdp_protocol_error"));
    else waiter.resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(fail("cdp_closed"));
    }
    pending.clear();
  });
  const command = (method, params, timeoutMs = 8000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(fail("cdp_command_timeout"));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch {
        clearTimeout(timer);
        pending.delete(id);
        reject(fail("cdp_closed"));
      }
    }).catch((error) => {
      // Only local fixed command identities cross the diagnostic boundary.
      // Request expressions, protocol messages and parameters remain private.
      if (method === "Runtime.enable" || method === "Runtime.evaluate")
        Object.defineProperty(error, "cdpCommand", { value: method });
      throw error;
    });
  try {
    await command(
      "Runtime.enable",
      {},
      Math.max(1, Math.min(8000, deadline - Date.now())),
    );
  } catch (error) {
    socket.close();
    throw error;
  }
  return {
    evaluate: async (expression, timeoutMs) => {
      if (!timeoutMs && Date.now() >= verificationDeadline)
        throw fail("verification_deadline");
      const result = await command(
        "Runtime.evaluate",
        {
          expression,
          returnByValue: true,
          awaitPromise: true,
          allowUnsafeEvalBlockedByCSP: true,
        },
        timeoutMs || Math.min(8000, verificationDeadline - Date.now()),
      );
      if (result.exceptionDetails) {
        rendererOperationFailure = {
          stage,
          reason: classifyRendererException(result.exceptionDetails),
        };
        throw fail("renderer_operation_rejected");
      }
      return result.result?.value;
    },
    evaluateDetached: async (expression, timeoutMs = 30000) => {
      if (
        Date.now() >= verificationDeadline &&
        Number.isFinite(verificationDeadline)
      )
        throw fail("verification_deadline");
      const result = await command(
        "Runtime.evaluate",
        {
          expression,
          returnByValue: false,
          awaitPromise: false,
          allowUnsafeEvalBlockedByCSP: true,
        },
        timeoutMs,
      );
      if (result.exceptionDetails) {
        rendererOperationFailure = {
          stage,
          reason: classifyRendererException(result.exceptionDetails),
        };
        throw fail("renderer_operation_rejected");
      }
      return result.result;
    },
    close: () => socket.close(),
  };
};
const readinessExpression = () => `(() => {
  const state = window[${JSON.stringify(patchKey)}];
  const eligibleClients = Array.isArray(state?.appServerClients) && typeof state.isCodexContinuationRequestClient==='function' ? state.appServerClients.filter((item) => state.isCodexContinuationRequestClient(item)) : [];
  const client = eligibleClients[0];
  const fingerprintMatches = state?.rendererRuntimeFingerprint===${JSON.stringify(expectedFingerprint)};
  const readinessBlocker = !state ? 'renderer_runtime_not_installed' : !fingerprintMatches ? 'renderer_runtime_fingerprint_mismatch' : !['startCodexContinuation','readCodexContinuationJob','confirmCodexContinuation','commitCodexContinuation','isCodexContinuationRequestClient'].every(k=>typeof state[k]==='function') ? 'renderer_continuation_api_unavailable' : !client ? 'desktop_request_client_unavailable' : null;
  const failures = Array.isArray(state?.failures) ? state.failures : [];
  const failureKinds = [...new Set(failures.map((value) => {
    const text = String(value || '').toLowerCase();
    if (text.includes('asset not found')) return 'asset_not_found';
    if (text.includes('request client')) return 'request_client_discovery';
    if (text.includes('timeout') || text.includes('timed out')) return 'timeout';
    if (text.includes('rpc')) return 'rpc';
    return 'other';
  }))].slice(-8);
  const diagnostics = state ? {
    installedRuntimeFingerprint: /^sha256-[a-f0-9]{64}$/.test(state.rendererRuntimeFingerprint || '') ? state.rendererRuntimeFingerprint : null,
    expectedRuntimeFingerprint: ${JSON.stringify(expectedFingerprint)},
    runtimeGeneration: Number.isSafeInteger(state.runtimeGeneration) ? state.runtimeGeneration : null,
    appServerPatchInstalled: state.appServerPatchInstalled === true,
    appServerClientCount: Array.isArray(state.appServerClients) ? state.appServerClients.length : 0,
    eligibleGuardedRequestClientCount: eligibleClients.length,
    scopedScopeCount: Number(state.scopedAppServerDiscovery?.scopeCount || state.scopedAppServerScopes?.size || 0),
    scopedRegistryCount: Number(state.scopedAppServerDiscovery?.registryCount || state.scopedAppServerRegistryClasses?.length || 0),
    scopedClientCount: Number(state.scopedAppServerDiscovery?.clientCount || 0),
    scopedQueryClientCount: Number(state.scopedAppServerDiscovery?.queryClientCount || 0),
    scopedAppServerScopeScanComplete: state.scopedAppServerScopeScanComplete === true,
    pendingReactNodeCount: Number(state.pendingReactNodes?.size || 0),
    webpackRuntimeCount: Number(state.webpackPickerDiscovery?.runtimeCount || 0),
    webpackModuleCount: Number(state.webpackPickerDiscovery?.moduleCount || 0),
    webpackCandidateCount: Number(state.webpackPickerDiscovery?.candidateCount || 0),
    webpackDiscoveryTruncated: state.webpackPickerDiscovery?.truncated === true,
    failureCount: failures.length,
    failureKinds,
  } : null;
  return {ready: readinessBlocker === null, fingerprintMatches, readinessBlocker, diagnostics};
})()`;
// Read only the installed runtime's existing diagnostics authority and bounded
// native-label markers. No cache ownership discovery, UI interaction, source
// injection or RPC is performed.
const waitForPinnedCreationReadiness = async () => {
  const deadline = Math.min(verificationDeadline, Date.now() + 5000);
  while (true) {
    // Availability polling on the already pinned connection is read-only.
    // An actual CDP/RPC rejection escapes immediately; no reconnect or replay.
    const ready = await connection.evaluate(readinessExpression());
    creationReadinessDiagnostics = ready?.diagnostics;
    if (ready?.ready === true) return;
    readinessBlocker = ready?.readinessBlocker;
    if (
      readinessBlocker !== "desktop_request_client_unavailable" ||
      Date.now() >= deadline
    )
      throw fail("desktop_bridge_not_ready");
    await sleep(Math.min(250, deadline - Date.now()));
  }
};
const pickerInspectionExpression = () => `(() => {
  const own = (value, key) => {
    if (!value || !['object','function'].includes(typeof value)) return undefined;
    try { const field = Object.getOwnPropertyDescriptor(value, key); return field && 'value' in field ? field.value : undefined; } catch { return undefined; }
  };
  const length = (value) => Array.isArray(value) && Number.isSafeInteger(own(value,'length')) ? own(value,'length') : 0;
  const items = (value, limit) => Array.from({length: Math.min(length(value), limit)}, (_, index) => own(value, String(index)));
  const count = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 1000000 ? value : undefined;
  const hash = (value) => typeof value === 'string' && /^sha256-[a-f0-9]{64}$/.test(value) ? value : null;
  const modelId = (value) => typeof value === 'string' && value.length <= 256 && new RegExp('^~?[A-Za-z0-9][A-Za-z0-9._/:@+ -]*$').test(value) && !value.includes('://') && !/^~?(?:sk|rk|pk)[-_]/i.test(value) && !/(?:api_key|apikey|token|secret)=/i.test(value) ? value : null;
  const effortNames = new Set(['none','minimal','low','medium','high','xhigh','max','ultra']);
  const efforts = (value) => {
    if (!Array.isArray(value) || length(value) > 8) return null;
    const result = items(value,8);
    return result.every((item) => typeof item === 'string' && effortNames.has(item)) && new Set(result).size === result.length ? result : null;
  };
  // Bounded, read-only native-label evidence. This does not prove that a menu
  // can be opened, an effort selected, or a provider honors that selection.
  const mountedReasoningLabels = {available:false,truncated:false,renderedMenuVerified:false,rows:[]};
  const nativeButtons = [];
  let nativeButtonInventoryInvalid = false;
  let nativeButtonInventoryTruncated = false;
  try {
    if (typeof document !== 'undefined' && document && typeof document.querySelectorAll === 'function') {
      const nodes = document.querySelectorAll('span[data-reasoning-effort][data-max-effort]');
      const total = nodes?.length;
      if (Number.isSafeInteger(total) && total >= 0) {
        mountedReasoningLabels.available = true;
        mountedReasoningLabels.truncated = total > 64;
        const labels = {none:['None'],minimal:['Minimal'],low:['Low'],medium:['Medium'],high:['High'],xhigh:['Extra high','Extra High'],max:['Max'],ultra:['Ultra']};
        for (let index = 0; index < Math.min(total,64); index += 1) {
          try {
            const node = nodes[index];
            if (!node || node.isConnected !== true || node.ownerDocument !== document || typeof node.getAttribute !== 'function') continue;
            const className = node.getAttribute('class');
            if (typeof className !== 'string' || className.length > 1024 || !className.split(/\\s+/).some((token) => token.startsWith('ModelPickerTriggerEffortText'))) continue;
            try {
              const button = typeof node.closest === 'function' ? node.closest('button') : null;
              if (!button || button.isConnected !== true || button.ownerDocument !== document) nativeButtonInventoryInvalid = true;
              else if (!nativeButtons.includes(button)) {
                if (nativeButtons.length === 8) nativeButtonInventoryTruncated = true;
                else nativeButtons.push(button);
              }
            } catch { nativeButtonInventoryInvalid = true; }
            const effort = node.getAttribute('data-reasoning-effort');
            if (!effortNames.has(effort)) continue;
            let labelMatches = false;
            try {
              const text = node.textContent;
              labelMatches = typeof text === 'string' && text.length <= 64 && labels[effort].includes(text.trim());
            } catch {}
            let opacityState = 'other';
            try {
              const opacity = typeof getComputedStyle === 'function' ? getComputedStyle(node)?.opacity : undefined;
              if (opacity === '0') opacityState = 'zero';
              else if (opacity === '1') opacityState = 'one';
            } catch {}
            mountedReasoningLabels.rows.push({effort,labelMatches,opacityState});
          } catch {}
        }
      }
    }
  } catch {
    mountedReasoningLabels.available = false;
    mountedReasoningLabels.truncated = false;
    mountedReasoningLabels.rows = [];
  }
  const state = own(window, ${JSON.stringify(patchKey)});
  const expected = hash(${JSON.stringify(expectedFingerprint || null)});
  const installed = hash(own(state,'rendererRuntimeFingerprint'));
  const fingerprintMatches = expected !== null && installed === expected;
  const runtimeStatus = !state ? 'not_installed' : !installed ? 'unverified' : !expected ? 'expected_fingerprint_unavailable' : fingerprintMatches ? 'current' : 'mismatch';
  const payload = own(state,'payload');
  const rawNames = own(payload,'modelNames');
  const rawModels = own(payload,'models');
  const names = items(rawNames,4096).map(modelId).filter(Boolean);
  const allowedNames = new Set();
  const canonicalNames = new Map();
  const catalogModels = [];
  const rows = items(rawModels,4096);
  const rowsByName = new Map();
  for (const row of rows) {
    const name = modelId(own(row,'model'));
    if (name) rowsByName.set(name, rowsByName.has(name) ? null : row);
  }
  for (const name of names) {
    const row = rowsByName.get(name);
    if (!row || own(row,'enabled') === false || allowedNames.has(name.toLowerCase())) continue;
    allowedNames.add(name.toLowerCase());
    canonicalNames.set(name.toLowerCase(),name);
    if (catalogModels.length >= 256) continue;
    const nested = own(row,'reasoning');
    const candidates = ['supportedReasoningEfforts','supportedReasoningLevels','supported_reasoning_levels','supported_reasoning_efforts'].map((key) => own(row,key));
    candidates.push(own(nested,'supportedEfforts'),own(nested,'supported_efforts'));
    const source = candidates.find(Array.isArray);
    const declaredEfforts = [...new Set(items(source,64).map((item) => typeof item === 'string' ? item : own(item,'reasoningEffort') || own(item,'reasoning_effort') || own(item,'effort')).filter((effort) => effortNames.has(effort)))].slice(0,8);
    catalogModels.push({model:name,declaredEfforts});
  }
  // Mirror nativeBooleanCurrentFiberPath's exact current-branch proof without
  // invoking the runtime bridge, source handlers, selectors, or scope get/set.
  const CODEX_NATIVE_CURRENT_FIBER_PATH_LIMIT = 1024;
  const nativePowerSelections = {available:false,truncated:mountedReasoningLabels.truncated || nativeButtonInventoryTruncated,renderedMenuVerified:false,rows:[]};
  const powerRefusals = new Set();
  const powerTruncations = new Set();
  const refusePower = (reason) => powerRefusals.add(reason);
  const truncatePower = (reason) => { nativePowerSelections.truncated = true; powerTruncations.add(reason); };
  if (mountedReasoningLabels.truncated) truncatePower('label_limit');
  if (nativeButtonInventoryTruncated) truncatePower('button_limit');
  if (!fingerprintMatches) refusePower('runtime_not_current');
  if (own(payload,'catalogAvailable') !== true) refusePower('catalog_unavailable');
  if (!mountedReasoningLabels.available) refusePower('label_inventory_unavailable');
  if (nativeButtonInventoryInvalid) refusePower('button_inventory_unverified');
  if (!nativeButtons.length) refusePower('native_button_missing');
  const currentNativePowerPath = (button) => {
    if (!button || button.isConnected !== true || button.ownerDocument !== document) { refusePower('button_contract_unverified'); return null; }
    let keys;
    try { keys = Object.getOwnPropertyNames(button).filter((key) => key.startsWith('__reactFiber') || key.startsWith('__reactInternalInstance')); } catch { refusePower('fiber_key_unreadable'); return null; }
    if (keys.length !== 1) { refusePower(keys.length ? 'fiber_key_ambiguous' : 'fiber_key_missing'); return null; }
    const attached = own(button,keys[0]);
    const paths = [];
    let pathRefusal = 'host_fiber_unverified';
    for (const start of [attached,own(attached,'alternate')].filter(Boolean)) {
      if (own(start,'stateNode') !== button) continue;
      const path = [];
      const seen = new Set();
      let fiber = start;
      let valid = true;
      for (let depth = 0; fiber && depth < CODEX_NATIVE_CURRENT_FIBER_PATH_LIMIT; depth += 1) {
        if (seen.has(fiber)) { pathRefusal = 'fiber_cycle'; valid = false; break; }
        seen.add(fiber);
        path.push(fiber);
        const parent = own(fiber,'return');
        if (!parent) break;
        let child = own(parent,'child');
        const siblings = new Set();
        let found = false;
        let index = 0;
        for (; child && index < 512; index += 1) {
          if (siblings.has(child)) break;
          siblings.add(child);
          if (child === fiber) { found = true; break; }
          child = own(child,'sibling');
        }
        if (!found) {
          if (child && index === 512) truncatePower('sibling_limit');
          pathRefusal = 'child_edge_unverified';
          valid = false;
          break;
        }
        fiber = parent;
      }
      const root = path[path.length - 1];
      if (!valid || own(root,'return') || own(root,'tag') !== 3) {
        if (valid && path.length === CODEX_NATIVE_CURRENT_FIBER_PATH_LIMIT && own(root,'return')) truncatePower('fiber_limit');
        if (valid) pathRefusal = 'root_unverified';
        continue;
      }
      const rootState = own(root,'stateNode');
      const container = own(rootState,'containerInfo');
      if (own(rootState,'current') !== root) { pathRefusal = 'root_not_current'; continue; }
      if (!container?.isConnected || typeof container.contains !== 'function' || !container.contains(button)) { pathRefusal = 'root_container_unverified'; continue; }
      paths.push(path);
    }
    if (paths.length !== 1) { refusePower(paths.length ? 'fiber_path_ambiguous' : pathRefusal); return null; }
    return paths[0];
  };
  try {
    if (fingerprintMatches && own(payload,'catalogAvailable') === true && !nativePowerSelections.truncated && !nativeButtonInventoryInvalid && nativeButtons.length) {
      const owners = new Map();
      let valid = true;
      for (const button of nativeButtons) {
        const path = currentNativePowerPath(button);
        if (!path) { valid = false; break; }
        const candidates = [];
        for (const fiber of path) {
          const props = own(fiber,'memoizedProps');
          const candidate = own(props,'selectedLabelCandidate');
          const selections = own(props,'powerSelections');
          const trigger = own(props,'triggerConfig');
          if (candidate && typeof own(props,'onSelectPower') === 'function' && Array.isArray(selections) && trigger && typeof trigger === 'object') candidates.push({props,candidate,selections});
        }
        if (candidates.length !== 1) { refusePower(candidates.length ? 'props_owner_ambiguous' : 'props_owner_missing'); valid = false; break; }
        owners.set(candidates[0].props,candidates[0]);
      }
      if (valid && owners.size !== 1) refusePower('props_owner_ambiguous');
      if (valid && owners.size === 1 && !nativePowerSelections.truncated) {
        const {candidate,selections} = owners.values().next().value;
        const rawSelectedModel = modelId(own(candidate,'model'));
        const selectedModel = rawSelectedModel && canonicalNames.get(rawSelectedModel.toLowerCase());
        const selectedEffortField = Object.getOwnPropertyDescriptor(candidate,'reasoningEffort');
        const selectedEffort = own(candidate,'reasoningEffort');
        const selectedEffortSafe = (!selectedEffortField || 'value' in selectedEffortField) && (selectedEffort === undefined || effortNames.has(selectedEffort));
        if (!selectedModel) refusePower('selected_model_unsafe');
        if (!selectedEffortSafe) refusePower('selected_effort_unsafe');
        if (selectedModel && selectedEffortSafe) {
          const total = own(selections,'length');
          if (!Number.isSafeInteger(total) || total < 0 || total > 512) truncatePower('selection_limit');
          else {
            nativePowerSelections.selectedModel = selectedModel;
            if (selectedEffort !== undefined) nativePowerSelections.selectedEffort = selectedEffort;
            let invalidRows = false;
            for (let index = 0; index < total; index += 1) {
              const row = own(selections,String(index));
              const rawModel = modelId(own(row,'model'));
              const model = rawModel && canonicalNames.get(rawModel.toLowerCase());
              const effort = own(row,'reasoningEffort');
              const isLocked = own(row,'isLocked');
              if (!model || !effortNames.has(effort)) { invalidRows = true; continue; }
              const safeRow = {model,effort};
              if (typeof isLocked === 'boolean') safeRow.isLocked = isLocked;
              else invalidRows = true;
              nativePowerSelections.rows.push(safeRow);
            }
            nativePowerSelections.available = !invalidRows;
            if (invalidRows) refusePower('unsafe_selection_rows');
          }
        }
      }
    }
  } catch {
    refusePower('inspection_failed');
    nativePowerSelections.available = false;
    nativePowerSelections.rows = [];
    delete nativePowerSelections.selectedModel;
    delete nativePowerSelections.selectedEffort;
  }
  if (nativePowerSelections.truncated) refusePower('inspection_capped');
  if (powerRefusals.size) nativePowerSelections.refusalReasons = [...powerRefusals].slice(0,16);
  if (powerTruncations.size) nativePowerSelections.truncationReasons = [...powerTruncations].slice(0,5);
  let rawDiagnostics;
  let diagnosticsAvailable = false;
  try {
    const read = own(state,'readCodexModelPickerDiagnostics');
    if (typeof read === 'function') {
      rawDiagnostics = read.call(state,{includeModelObservations:true});
      diagnosticsAvailable = !!rawDiagnostics && typeof rawDiagnostics === 'object';
    }
  } catch {}
  const statusNames = new Set(['ready','pending','error','mismatch','unverified','not_required']);
  const rawStatus = own(rawDiagnostics,'status');
  const pickerDiagnostics = {available:diagnosticsAvailable,status:statusNames.has(rawStatus) ? rawStatus : 'unverified'};
  for (const key of ['pickerObserverCount','successObserverCount','errorObserverCount','pendingObserverCount','unsupportedObserverCount','unreadableObserverCount','nativeVisibilityUnverifiedObserverCount','booleanControlUnverifiedModelCount','booleanControlReadyModelCount','effortMismatchCount','flagMismatchCount','missingMaxModelCount','missingUltraModelCount','selectedMaxModelCount','selectedUltraModelCount']) {
    const value = count(own(rawDiagnostics,key));
    if (value !== undefined) pickerDiagnostics[key] = value;
  }
  const rawObservations = own(rawDiagnostics,'modelObservations');
  const rawObservedRows = own(rawObservations,'rows');
  const observedRows = [];
  let invalidObservation = false;
  for (const row of items(rawObservedRows,64)) {
    const model = modelId(own(row,'model'));
    const expectedEfforts = efforts(own(row,'expectedEfforts'));
    const observedEfforts = efforts(own(row,'observedEfforts'));
    const nativeVisibleEfforts = efforts(own(row,'nativeVisibleEfforts'));
    const missingEfforts = efforts(own(row,'missingEfforts'));
    if (!model || !allowedNames.has(model.toLowerCase()) || !expectedEfforts || !observedEfforts || !nativeVisibleEfforts || !missingEfforts || nativeVisibleEfforts.some((effort) => !observedEfforts.includes(effort))) { invalidObservation = true; continue; }
    observedRows.push({model,expectedEfforts,observedEfforts,nativeVisibleEfforts,missingEfforts});
  }
  const truncated = own(rawObservations,'truncated') === true || length(rawObservedRows) > 64;
  const queryRowsVerified = fingerprintMatches && own(payload,'catalogAvailable') === true && own(rawObservations,'queryRowsVerified') === true && own(rawObservations,'unavailable') === false && !truncated && !invalidObservation && observedRows.length > 0;
  const allowedReasons = new Set(['catalog_unavailable','native_owner_unverified','native_visibility_unverified','picker_query_pending','picker_query_error','unreadable_picker_evidence','unsupported_picker_selection','invalid_model_observation','no_verified_query_rows','row_limit']);
  const unavailableReasons = items(own(rawObservations,'unavailableReasons'),16).filter((reason) => allowedReasons.has(reason));
  if (!rawObservations) unavailableReasons.push('snapshot_unavailable');
  if (own(payload,'catalogAvailable') !== true) unavailableReasons.push('catalog_unavailable');
  if (!fingerprintMatches) unavailableReasons.push('runtime_not_current');
  if (!observedRows.length) unavailableReasons.push('no_verified_query_rows');
  if (invalidObservation) unavailableReasons.push('invalid_model_observations');
  if (truncated) unavailableReasons.push('observation_limit');
  const schedulerCapabilities = {};
  try {
    const schedulerField = Object.getOwnPropertyDescriptor(globalThis,'scheduler');
    if (schedulerField && 'value' in schedulerField && schedulerField.value && ['object','function'].includes(typeof schedulerField.value)) {
      const yieldField = Object.getOwnPropertyDescriptor(schedulerField.value,'yield');
      if (yieldField && 'value' in yieldField) schedulerCapabilities.schedulerYieldAvailable = typeof yieldField.value === 'function';
    }
  } catch {}
  try {
    const channelField = Object.getOwnPropertyDescriptor(globalThis,'MessageChannel');
    if (channelField && 'value' in channelField) schedulerCapabilities.messageChannelAvailable = typeof channelField.value === 'function';
  } catch {}
  let scopeCandidateCount;
  try { scopeCandidateCount = count(Object.getOwnPropertyDescriptor(Set.prototype,'size').get.call(own(state,'scopedAppServerScopeCandidates'))); } catch {}
  const scanSnapshot = (source,terminalOnly = false) => {
    try {
      if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined;
      const scan = {};
      const status = own(source,'status');
      const statuses = terminalOnly ? ['complete','capped','root_unavailable','invalidated'] : ['scanning','complete','capped','root_unavailable','invalidated'];
      if (statuses.includes(status)) scan.status = status;
      for (const [key,maximum] of [['visitedFiberCount',30000],['scopeCount',100000]]) {
        const value = own(source,key);
        if (Number.isSafeInteger(value) && value >= 0 && value <= maximum) scan[key] = value;
      }
      if (own(source,'fiberLimit') === 30000) scan.fiberLimit = 30000;
      const elapsedMs = own(source,'elapsedMs');
      if (typeof elapsedMs === 'number' && Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs <= 900000) scan.elapsedMs = elapsedMs;
      if (terminalOnly) {
        const reason = own(source,'reason');
        if (['exact_root','fiber_snapshot','object_snapshot','object_read','mutation_generation','pending_nodes','object_limit','field_limit','fiber_limit'].includes(reason)) scan.reason = reason;
      }
      return scan;
    } catch { return undefined; }
  };
  const scopeScan = scanSnapshot(own(state,'scopedAppServerScopeScan'));
  const lastSettledScopeScan = scanSnapshot(own(state,'scopedAppServerScopeLastSettledScan'),true);
  const reconciliation = own(state,'nativeReasoningVisibilityReconciliation');
  const reconciliationStatus = own(reconciliation,'status');
  const refusalReasons = new Set(['native_atom_unverified','renderer_scope_snapshot_unverified','native_atom_definition_unverified','scope_set_unverified','scope_enumeration_failed','owner_cache_inventory_unverified','no_managed_picker_query','native_get_unpatchable','native_set_unverified','native_get_read_failed','native_get_patch_failed','no_patchable_native_scope']);
  const rawRefusalReason = own(reconciliation,'refusalReason');
  const refusalReason = rawRefusalReason === null || refusalReasons.has(rawRefusalReason) ? rawRefusalReason : undefined;
  const rawOwnerScopeCount = own(reconciliation,'ownerScopeCount');
  const ownerScopeCount = Number.isSafeInteger(rawOwnerScopeCount) && rawOwnerScopeCount >= 0 && rawOwnerScopeCount <= 2048 ? rawOwnerScopeCount : undefined;
  const rawOwnerFailures = own(reconciliation,'ownerFailureCounts');
  const ownerFailureCounts = rawOwnerFailures && typeof rawOwnerFailures === 'object' && !Array.isArray(rawOwnerFailures) ? {} : undefined;
  if (ownerFailureCounts) for (const key of ['scope_contract','node_unavailable','node_client_absent','node_client_accessor','node_client_uninitialized','client_mismatch','client_methods_unavailable','cache_unavailable','scope_read_failed','inventory_empty','inventory_capped','inventory_read_failed','owner_snapshot_unverified']) {
    const value = own(rawOwnerFailures,key);
    if (value === 0 || value === 1) ownerFailureCounts[key] = value;
  }

  return {
    runtimeInstalled: !!state,
    expectedRuntimeFingerprint: expected,
    installedRuntimeFingerprint: installed,
    fingerprintMatches,
    runtimeStatus,
    renderedMenuVerified: false,
    catalog: {available:own(payload,'catalogAvailable') === true,declaredOnly:true,truncated:length(rawNames)>256 || length(rawModels)>4096,models:catalogModels},
    pickerDiagnostics,
    mountedReasoningLabels,
    nativePowerSelections,
    nativeVisibility: {
      required:own(state,'nativeReasoningVisibilityRequired') === true,
      atomCount:count(length(own(state,'nativeReasoningVisibilityAtoms'))),
      scopeScanComplete:own(state,'scopedAppServerScopeScanComplete') === true,
      scopeCandidateCount,
      scopeScan,
      lastSettledScopeScan,
      schedulerCapabilities,
      ownershipStatus:queryRowsVerified ? 'verified_current_query_rows' : 'unverified',
      reconciliation: {status:reconciliationStatus === 'known' || statusNames.has(reconciliationStatus) ? reconciliationStatus : 'unverified',managed:own(reconciliation,'managed') === true,patchedScopes:count(own(reconciliation,'patchedScopes')),restoredScopes:count(own(reconciliation,'restoredScopes')),refusalReason,ownerScopeCount,ownerFailureCounts},
    },
    modelObservations: {renderedMenuVerified:false,queryRowsVerified,truncated,unavailable:!queryRowsVerified,unavailableReasons:[...new Set(unavailableReasons)].slice(0,16),rows:observedRows},
  };
})()`;
const sourceRuntimeSnapshotExpression = (
  allowedFingerprints = [expectedFingerprint],
) => `(() => {
  const state = window[${JSON.stringify(patchKey)}];
  if (!state) return { ok: false, reason: "renderer_runtime_not_installed" };
  if (!${JSON.stringify(allowedFingerprints)}.includes(state.rendererRuntimeFingerprint))
    return { ok: false, reason: "renderer_runtime_fingerprint_mismatch" };
  if (state.payload?.catalogAvailable !== true)
    return { ok: false, reason: "catalog_payload_unavailable" };
  return {
    ok: true,
    installedFingerprint: state.rendererRuntimeFingerprint,
    payload: state.payload,
    catalogReleased: state.catalogReleased === true,
    requestHealthWarningsSuppressed: state.requestHealthWarningsSuppressed === true,
  };
})()`;
const guarded = (body) => `(async () => {
  const state = window[${JSON.stringify(patchKey)}];
  if (!state || state.rendererRuntimeFingerprint!==${JSON.stringify(expectedFingerprint)}) throw new Error('runtime_changed');
  const lease=window[${JSON.stringify(leaseKey)}];
  ${body}
})()`;
// This projection runs INSIDE the renderer. Provider/reflected reasons and raw
// job objects must never cross CDP into a receipt, even when an assertion fails.
const projectContinuationResult = (
  value,
  expectedThreadId,
  expectedJobId,
  runtimeGeneration,
) => {
  const present = Boolean(
    value && typeof value === "object" && !Array.isArray(value),
  );
  const own = (name) => {
    if (!present) return undefined;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      return descriptor && Object.hasOwn(descriptor, "value")
        ? descriptor.value
        : undefined;
    } catch {
      return undefined;
    }
  };
  const boolean = (name) => (typeof own(name) === "boolean" ? own(name) : null);
  const status = own("status");
  const reason = own("reason");
  const reasonCodes = new Map([
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
      "The interrupted Codex thread returned conflicting models",
      "model_conflict",
    ],
    ["Codex did not identify the interrupted model", "model_missing"],
    ["The interrupted Codex model is required", "expected_model_missing"],
    [
      "The interrupted turn observation time is required",
      "observation_missing",
    ],
    ["Codex returned a different thread", "thread_mismatch"],
    ["The interrupted Codex thread is still active", "thread_active"],
    ["Codex did not identify the interrupted turn", "failed_turn_missing"],
    ["The latest Codex turn was cancelled", "user_cancelled"],
    [
      "The latest Codex turn was interrupted without a recoverable error",
      "unrecoverable_interruption",
    ],
    ["Codex Desktop request client was not found", "client_unavailable"],
    [
      "Codex Desktop request client was not found with its guarded activity hook",
      "client_hook_unavailable",
    ],
    [
      "Codex Desktop request client was not found after discovery timed out",
      "client_discovery_timeout",
    ],
    ["Codex thread/read timed out", "thread_read_timeout"],
    [
      "The user changed or stopped the Codex thread after this request started",
      "newer_user_action",
    ],
    [
      "The user changed or stopped the Codex thread before continuation",
      "newer_user_action",
    ],
    [
      "Continuation was already submitted for this interrupted turn",
      "already_submitted",
    ],
    [
      "A continuation was already attempted; its result is uncertain",
      "already_attempted",
    ],
    ["Codex did not confirm the targeted continuation", "ack_unconfirmed"],
    ["An exact Codex thread and recovery id are required", "binding_missing"],
    [
      "The recovery id belongs to a different Codex thread",
      "recovery_thread_mismatch",
    ],
    [
      "The recovery id belongs to a different interrupted request",
      "recovery_request_mismatch",
    ],
    ["Continuation authorization was revoked", "authorization_revoked"],
  ]);
  const reasonCode =
    reason === undefined || reason === null || reason === ""
      ? "none"
      : typeof reason !== "string"
        ? "unclassified"
        : reasonCodes.get(reason) ||
          (reason.startsWith("Continuation result is uncertain: ")
            ? "uncertain_result"
            : reason.startsWith("The latest Codex turn is ")
              ? "latest_turn_not_terminal"
              : "unclassified");
  const observedThreadId = own("threadId");
  const observedJobId = own("jobId");
  const turnId = own("turnId");
  return {
    present,
    status: [
      "pending",
      "prepared",
      "confirming",
      "confirmed",
      "submitting",
      "completed",
    ].includes(status)
      ? status
      : present
        ? "unknown"
        : "missing",
    started: boolean("started"),
    submitted: boolean("submitted"),
    mutationAttempted: boolean("mutationAttempted"),
    threadMatches:
      typeof observedThreadId === "string"
        ? observedThreadId === expectedThreadId
        : null,
    jobMatches:
      typeof observedJobId === "string"
        ? observedJobId === expectedJobId
        : null,
    turnIdPresent: typeof turnId === "string" && Boolean(turnId.trim()),
    reasonCode,
    runtimeGeneration:
      Number.isSafeInteger(runtimeGeneration) && runtimeGeneration >= 0
        ? runtimeGeneration
        : null,
  };
};
const continuationResultExpression = (call, prelude = "") =>
  guarded(`
    ${prelude}
    const value=${call};
    return (${projectContinuationResult.toString()})(value,${JSON.stringify(threadId)},${JSON.stringify(recoveryId)},state.runtimeGeneration);
  `);
const continuationJobExpression = () =>
  guarded(`
    const job=state.readCodexContinuationJob(${JSON.stringify(recoveryId)});
    const diagnostics=(${projectContinuationResult.toString()})(job,${JSON.stringify(threadId)},${JSON.stringify(recoveryId)},state.runtimeGeneration);
    return {diagnostics,job:job?{status:diagnostics.status,submitted:diagnostics.submitted,mutationAttempted:diagnostics.mutationAttempted,turnId:typeof job.turnId==='string'?job.turnId:null,threadMatches:diagnostics.threadMatches,terminalRefusal:diagnostics.reasonCode==='terminal_user_action'}:null};
  `);
const currentProviderExpression = () =>
  guarded(`
    const provider = state.payload?.modelProvider;
    if (typeof provider !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(provider))
      throw new Error("current_provider_unavailable");
    return provider;
  `);
const waitUntil = async (getValue) => {
  while (Date.now() < verificationDeadline) {
    const value = await getValue();
    if (value) return value;
    await sleep(100);
  }
  throw fail("verification_deadline");
};

// Keep owned fixture-read failures inside the renderer. Plain thrown JSON-RPC
// objects need not expose their fields in CDP exception descriptions; never
// serialize their messages, paths, prompts, or arbitrary numeric/string codes.
const waitForInitialFixtureRequest = async () =>
  waitUntil(async () => {
    if (initialRequests > 1 || continuedRequests !== 0 || fixtureFailure)
      throw fail("initial_fixture_request_invalid");
    return initialRequests === 1 ? true : null;
  });
const classifyOwnedThreadReadFailure = (error) => {
  const own = (value, key) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return undefined;
    try {
      const field = Object.getOwnPropertyDescriptor(value, key);
      return field && Object.hasOwn(field, "value") ? field.value : undefined;
    } catch {
      return undefined;
    }
  };
  const code = own(error, "code");
  const protocolCode =
    new Map([
      [-32700, "parse_error"],
      [-32600, "invalid_request"],
      [-32601, "method_not_found"],
      [-32602, "invalid_params"],
      [-32603, "internal_error"],
    ]).get(code) || "unknown";
  const rawMessage = own(error, "message");
  const message =
    typeof rawMessage === "string"
      ? rawMessage.slice(0, 4096).toLowerCase()
      : "";
  let reason = "unclassified";
  if (protocolCode === "invalid_params") reason = "invalid_params";
  else if (protocolCode === "method_not_found") reason = "unsupported_method";
  else if (
    /\b(?:permission denied|access denied|forbidden|unauthorized)\b/.test(
      message,
    )
  )
    reason = "permission_denied";
  else if (
    /\b(?:thread|conversation|rollout)\b[^\r\n]{0,192}\b(?:not found|does not exist)\b/.test(
      message,
    ) ||
    /\bno (?:rollout|thread|conversation)\b[^\r\n]{0,96}\bfound\b/.test(message)
  )
    reason = "thread_not_found";
  else if (
    /\b(?:thread|conversation|rollout)\b[^\r\n]{0,192}\bnot (?:yet )?(?:ready|loaded|initialized|materialized|materialised|persisted)\b/.test(
      message,
    )
  )
    reason = "thread_not_ready";
  return { reason, protocolCode };
};
// Also revalidate the fixed projection before persisting native-side evidence.
const projectOwnedThreadReadFailure = (value) => {
  const own = (key) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return undefined;
    try {
      const field = Object.getOwnPropertyDescriptor(value, key);
      return field && Object.hasOwn(field, "value") ? field.value : undefined;
    } catch {
      return undefined;
    }
  };
  const rawReason = own("reason");
  const rawProtocolCode = own("protocolCode");
  const reason = [
    "thread_not_found",
    "thread_not_ready",
    "invalid_params",
    "unsupported_method",
    "permission_denied",
    "unclassified",
  ].includes(rawReason)
    ? rawReason
    : "unclassified";
  const protocolCode = [
    "parse_error",
    "invalid_request",
    "method_not_found",
    "invalid_params",
    "internal_error",
    "unknown",
  ].includes(rawProtocolCode)
    ? rawProtocolCode
    : "unknown";
  return { reason, protocolCode };
};

const threadProjection = () =>
  guarded(`
  if(!lease?.threadId || lease.threadId!==${JSON.stringify(threadId)}) throw new Error('wrong_test_thread');
  let result;
  try {
    result=await lease.request('thread/read',{threadId:lease.threadId,includeTurns:true});
  } catch(error) {
    return {readFailure:(${classifyOwnedThreadReadFailure.toString()})(error)};
  }
  const thread=result.thread||result;
  if(thread.id!==lease.threadId) throw new Error('wrong_test_thread');
  const turn=thread.turns?.at(-1);
  return {threadMatches:true,turnCount:thread.turns?.length||0,turnId:turn?.id,status:turn?.status,threadStatus:thread.status?.type||thread.status};
`);
const projectCleanupResult = (value) => {
  try {
    if (!value || typeof value !== "object") throw 0;
    const archived = Object.getOwnPropertyDescriptor(value, "archived")?.value;
    const reason = Object.getOwnPropertyDescriptor(value, "reason")?.value;
    const allowed = [
      "archived",
      "no_lease",
      "unexpected_turn",
      "thread_active",
      "latest_turn_not_terminal",
      "thread_read_rejected",
      "archive_rejected",
    ];
    if (
      !allowed.includes(reason) ||
      typeof archived !== "boolean" ||
      archived !== (reason === "archived")
    )
      throw 0;
    return { archived, reason };
  } catch {
    return { archived: false, reason: "unclassified" };
  }
};
const classifyCleanupFailure = (error) => {
  let code;
  try {
    code =
      error && typeof error === "object"
        ? Object.getOwnPropertyDescriptor(error, "message")?.value
        : undefined;
  } catch {
    /* Unknown diagnostics stay fixed. */
  }
  if (code === "cdp_command_timeout") return "command_timeout";
  if (code === "ccswitch_binary_changed") return "binary_changed";
  if (
    [
      "native_identity_query_failed",
      "native_identity_invalid",
      "debug_port_owner_not_codex",
      "debug_port_identity_changed",
    ].includes(code)
  )
    return "identity_rejected";
  return "cleanup_rejected";
};
const cleanupExpression = () =>
  guarded(`
  if(!lease?.threadId)return {archived:false,reason:'no_lease'};
  if(${JSON.stringify(threadId || "")}&&lease.threadId!==${JSON.stringify(threadId || "")})throw new Error('wrong_test_thread');
  if(typeof state.cancelCodexContinuation==='function')state.cancelCodexContinuation(${JSON.stringify(recoveryId)});
  let result;
  try { result=await lease.request('thread/read',{threadId:lease.threadId,includeTurns:true}); }
  catch { return {archived:false,reason:'thread_read_rejected'}; }
  const thread=result.thread||result;
  if(thread.id!==lease.threadId)throw new Error('wrong_test_thread');
  const status=thread.status?.type||thread.status;
  const last=thread.turns?.at(-1)?.status;
  const owned=${JSON.stringify(ownedTurnIds)};
  if(!Array.isArray(thread.turns)||thread.turns.some(turn=>!owned.includes(turn.id)))return {archived:false,reason:'unexpected_turn'};
  if(status==='active')return {archived:false,reason:'thread_active'};
  if(last&&!['completed','failed','interrupted'].includes(last))return {archived:false,reason:'latest_turn_not_terminal'};
  try { await lease.request('thread/archive',{threadId:lease.threadId}); }
  catch { return {archived:false,reason:'archive_rejected'}; }
  delete window[${JSON.stringify(leaseKey)}];
  return {archived:true,reason:'archived'};
`);
const restoreSourceRuntimeAfterNativeCheck = async (preparedGeneration) => {
  if (!injectSourceRuntime) return false;
  assert.ok(sourceRuntime && sourceRuntimeBaselineFingerprint);
  const snapshot = await connection.evaluate(
    sourceRuntimeSnapshotExpression([
      sourceRuntimeBaselineFingerprint,
      sourceRuntime.fingerprint,
    ]),
  );
  if (!snapshot?.ok) throw fail("source_runtime_baseline_changed");
  if (threadId) {
    const lease = await connection.evaluate(`(() => {
      const current = window[${JSON.stringify(leaseKey)}];
      return {
        threadMatches: current?.threadId === ${JSON.stringify(threadId)},
        requestPresent: typeof current?.request === "function",
      };
    })()`);
    if (!lease?.threadMatches || !lease?.requestPresent)
      throw fail("unexpected_test_thread_turn");
  }
  if (snapshot.installedFingerprint === sourceRuntime.fingerprint) {
    if (preparedGeneration == null) return false;
    const ready = await connection.evaluate(readinessExpression());
    return ready?.diagnostics?.runtimeGeneration !== preparedGeneration;
  }
  // The guardian can restore the running binary's older validated renderer.
  // Reinstall exact current source after the native check, preserving the new
  // current payload. Prepared jobs are invalidated by this new generation and
  // callers must prepare the same exact failed turn again before committing.
  checkNativeIdentity();
  await checkBinary();
  await connection.evaluateDetached(
    sourceRuntime.assemble(
      JSON.stringify(snapshot.payload),
      snapshot.catalogReleased,
      snapshot.requestHealthWarningsSuppressed,
    ),
  );
  sourceRuntimeReinjectionCount += 1;
  await waitUntil(async () => {
    const ready = await connection.evaluate(readinessExpression());
    readinessDiagnostics = ready?.diagnostics;
    return ready?.ready;
  });
  sourceRuntimeInjection = {
    ...sourceRuntimeInjection,
    reinjectionCount: sourceRuntimeReinjectionCount,
    reprepareCount: sourceRuntimeReprepareCount,
  };
  return true;
};
const readContinuationJob = async (expression) => {
  const observed = await connection.evaluate(expression);
  if (observed?.diagnostics)
    continuationDiagnostics.latestJob = observed.diagnostics;
  return observed?.job || null;
};
const confirmContinuationWithDiagnostics = async (jobExpression) => {
  const ack = await connection.evaluate(
    continuationResultExpression(
      `state.confirmCodexContinuation(${JSON.stringify(recoveryId)})`,
    ),
  );
  continuationDiagnostics.confirmAck = ack;
  const job =
    ack?.started === true
      ? await waitUntil(async () => {
          const current = await readContinuationJob(jobExpression);
          return current && ["confirmed", "completed"].includes(current.status)
            ? current
            : null;
        })
      : await readContinuationJob(jobExpression);
  continuationDiagnostics.confirmedJob = continuationDiagnostics.latestJob;
  return { ack, job };
};
const commitContinuationWithDiagnostics = async (jobExpression) => {
  const commit = await connection.evaluate(
    continuationResultExpression(
      `state.commitCodexContinuation(${JSON.stringify(recoveryId)})`,
    ),
  );
  continuationDiagnostics.commitAck = commit;
  if (commit?.started !== true) {
    // Observe once for diagnosis, but do not manufacture a new preparation or
    // a second commit when the current production runtime refuses this job.
    try {
      await readContinuationJob(jobExpression);
    } catch {
      continuationDiagnostics.commitJobReadFailed = true;
    }
  }
  return commit;
};
const verifyTerminalFixtureRefusal = async (prepared, failed) => {
  stage = "terminal_refusal";
  assert.equal(prepared.status, "completed");
  assert.equal(prepared.threadMatches, true);
  assert.equal(prepared.submitted, false);
  assert.equal(prepared.mutationAttempted, false);
  // Do not misreport an unrelated missing-client/model/runtime guard as proof
  // of terminal-error refusal. The renderer projects this fixed reason only.
  assert.equal(prepared.terminalRefusal, true);
  checkNativeIdentity();
  await checkBinary();
  const unchanged = await connection.evaluate(threadProjection());
  assert.equal(unchanged.threadMatches, true);
  assert.equal(unchanged.turnId, failed.turnId);
  assert.equal(unchanged.status, "failed");
  assert.equal(unchanged.turnCount, 1);
  assert.equal(initialRequests, 1);
  assert.equal(continuedRequests, 0);
  assert.equal(receivedLiteralContinue, false);
  assert.equal(fixtureFailure, false);
  return {
    verified: true,
    scenario,
    scope: injectSourceRuntime
      ? "actual_codex_desktop_cdp_source_production_renderer_terminal_refusal"
      : "actual_codex_desktop_cdp_existing_production_renderer_terminal_refusal",
    desktopCdpVerified: true,
    automaticNativeSchedulingVerified: false,
    runtimeFingerprint: expectedFingerprint,
    ccswitchBinarySha256: binarySha256,
    ...(creationReadinessDiagnostics ? { creationReadinessDiagnostics } : {}),
    nativeOwnerVerified: true,
    nativeHost: nativeIdentity.host,
    nativeOwnerPids: nativeIdentity.owners.map((owner) => owner.pid),
    temporaryDurableTestThread: true,
    perThreadLocalFixtureProviderConfirmed: true,
    initialFailedTurnObserved: true,
    terminalRefusalObserved: true,
    continuationJobCompleted: true,
    continuationSubmitted: false,
    continuationMutationAttempted: false,
    continuationCommitInvoked: false,
    initialFailedTurnUnchanged: true,
    exactlyZeroContinuations: true,
    ...(typeof continuationDiagnostics === "object" && continuationDiagnostics
      ? { continuationDiagnostics }
      : {}),
    ...(sourceRuntimeInjection ? { sourceRuntimeInjection } : {}),
    ...threadScopeEvidence(),
    initialRequests,
    continuedRequests,
  };
};
const PICKER_INSPECTION_TARGET_LIMIT = 8;
const inspectPickerTargets = async (
  targets,
  deadline,
  { sampleCount = 1, sampleIntervalMs = 1000 } = {},
) => {
  assert.ok(
    Number.isInteger(sampleCount) && sampleCount >= 1 && sampleCount <= 16,
  );
  assert.ok(
    Number.isInteger(sampleIntervalMs) &&
      sampleIntervalMs >= 100 &&
      sampleIntervalMs <= 5000,
  );
  // readTargets owns eligibility and endpoint authority; this only bounds,
  // deduplicates and correlates those already-validated transport targets.
  const digest = (value) =>
    "sha256-" + createHash("sha256").update(value).digest("hex");
  const opaqueId = (target) => {
    const id = typeof target.id === "string" ? target.id : "";
    return /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(
      id,
    )
      ? id.toLowerCase()
      : digest(id.slice(0, 512) || target.webSocketDebuggerUrl);
  };
  const unique = new Map();
  let duplicateTargetCount = 0;
  for (const target of targets.slice(0, 4096)) {
    const key = target.webSocketDebuggerUrl;
    const candidate = {
      targetId: opaqueId(target),
      targetRef: digest(key),
      key,
    };
    const previous = unique.get(key);
    if (previous) {
      duplicateTargetCount += 1;
      if (candidate.targetId < previous.targetId) unique.set(key, candidate);
    } else unique.set(key, candidate);
  }
  const selected = [...unique.values()]
    .sort((left, right) =>
      left.targetRef < right.targetRef
        ? -1
        : left.targetRef > right.targetRef
          ? 1
          : 0,
    )
    .slice(0, PICKER_INSPECTION_TARGET_LIMIT);
  const observations = [];
  const retained = new Map();
  const failureCodes = new Set([
    "cdp_connect_timeout",
    "cdp_connect_failed",
    "cdp_protocol_error",
    "cdp_closed",
    "cdp_command_timeout",
    "renderer_operation_rejected",
    "verification_deadline",
    "picker_result_invalid",
  ]);
  const inspect = async (candidate) => {
    if (Date.now() >= deadline) throw fail("inspection_deadline");
    const inspection = await candidate.evaluate(
      pickerInspectionExpression(),
      Math.max(1, Math.min(8000, deadline - Date.now())),
    );
    if (!inspection || typeof inspection.runtimeInstalled !== "boolean")
      throw fail("picker_result_invalid");
    return inspection;
  };
  const close = (candidate, observation) => {
    try {
      candidate?.close();
    } catch {
      observation.connectionCleanupPending = true;
    }
  };
  let attemptedTargetCount = 0;
  for (const target of selected) {
    const observation = {
      targetId: target.targetId,
      targetRef: target.targetRef,
    };
    let candidate;
    let failureStage = "connect";
    try {
      if (Date.now() >= deadline) throw fail("inspection_deadline");
      attemptedTargetCount += 1;
      candidate = await connect(target.key, deadline);
      failureStage = "runtime_evaluate";
      observation.inspection = await inspect(candidate);
      observation.status = "inspected";
    } catch (error) {
      delete observation.inspection;
      observation.status = "unavailable";
      const code = error?.message;
      let command;
      try {
        command = Object.getOwnPropertyDescriptor(error, "cdpCommand")?.value;
      } catch {}
      observation.failureStage =
        code === "picker_result_invalid"
          ? "result_shape"
          : command === "Runtime.enable"
            ? "runtime_enable"
            : command === "Runtime.evaluate"
              ? "runtime_evaluate"
              : failureStage;
      observation.failure =
        code === "inspection_deadline"
          ? code
          : failureCodes.has(code)
            ? code
            : "picker_target_unavailable";
    } finally {
      if (sampleCount > 1 && observation.status === "inspected")
        retained.set(target.targetRef, candidate);
      else close(candidate, observation);
    }
    observations.push(observation);
  }
  const rank = (row) =>
    row.inspection.fingerprintMatches === true
      ? 3
      : row.inspection.runtimeInstalled === true
        ? row.inspection.installedRuntimeFingerprint
          ? 2
          : 1
        : 0;
  const successful = observations.filter((row) => row.status === "inspected");
  const best = [...successful].sort(
    (left, right) =>
      rank(right) - rank(left) ||
      (left.targetId < right.targetId
        ? -1
        : left.targetId > right.targetId
          ? 1
          : left.targetRef < right.targetRef
            ? -1
            : left.targetRef > right.targetRef
              ? 1
              : 0),
  )[0];
  let sampling;
  if (sampleCount > 1) {
    sampling = {
      scope: "same_pinned_target_session",
      requestedSampleCount: sampleCount,
      intervalMs: sampleIntervalMs,
      complete: false,
      ownershipVerified: false,
      renderedMenuVerified: false,
      targetId: best?.targetId || null,
      targetRef: best?.targetRef || null,
      samples: [],
    };
    // Keep the originally inspected selected session. Native ownership/binary
    // validation brackets the finite session, not each requested-cadence sample.
    for (const observation of observations) {
      if (observation.targetRef !== best?.targetRef) {
        close(retained.get(observation.targetRef), observation);
        retained.delete(observation.targetRef);
      }
    }
    const candidate = retained.get(best?.targetRef);
    const sampleFailures = new Set([
      ...failureCodes,
      "inspection_deadline",
      "debug_port_identity_changed",
      "native_identity_query_failed",
      "native_identity_invalid",
      "debug_port_owner_not_codex",
      "ccswitch_binary_changed",
    ]);
    const failureCode = (error) =>
      sampleFailures.has(error?.message)
        ? error.message
        : "picker_target_unavailable";
    let validatedBefore = false;
    let validationFailed = false;
    let samplingFailure;
    try {
      if (!candidate || !best) throw fail("picker_target_unavailable");
      if (Date.now() >= deadline) throw fail("inspection_deadline");
      checkNativeIdentity();
      await checkBinary();
      if (Date.now() >= deadline) throw fail("inspection_deadline");
      validatedBefore = true;
      const started = Date.now();
      for (let index = 1; index <= sampleCount; index += 1) {
        if (index > 1) {
          if (Date.now() + sampleIntervalMs >= deadline)
            throw fail("inspection_deadline");
          await sleep(sampleIntervalMs);
        }
        const inspection = await inspect(candidate);
        sampling.samples.push({
          index,
          elapsedMs: Math.max(0, Math.min(900000, Date.now() - started)),
          inspection,
        });
        best.inspection = inspection;
      }
    } catch (error) {
      samplingFailure = failureCode(error);
      if (!validatedBefore) validationFailed = true;
    } finally {
      if (validatedBefore) {
        try {
          checkNativeIdentity();
          await checkBinary();
          sampling.ownershipVerified = true;
        } catch (error) {
          validationFailed = true;
          samplingFailure = failureCode(error);
        }
      }
      if (validationFailed || samplingFailure === "cdp_closed") {
        // A failed final owner/binary proof or closed pinned session cannot
        // certify ANY retained inspection as current. Keep only finite causes.
        sampling.samples = [];
        sampling.ownershipVerified = false;
        for (const observation of observations) {
          // An unavailable target has no retained proof to invalidate. Keep its
          // original finite connection/evaluation failure instead of replacing
          // the actual cause with a later sampling failure from another stage.
          if (observation.status !== "inspected") continue;
          delete observation.inspection;
          observation.status = "unavailable";
          observation.failure = samplingFailure || "picker_target_unavailable";
          observation.failureStage = "sampling";
        }
      }
      if (samplingFailure) sampling.failure = samplingFailure;
      sampling.complete =
        !samplingFailure &&
        sampling.ownershipVerified &&
        sampling.samples.length === sampleCount;
      if (best) close(candidate, best);
      retained.clear();
    }
  }
  const finalSuccessful = observations.filter(
    (row) => row.status === "inspected",
  );
  const truncated =
    targets.length > 4096 || unique.size > PICKER_INSPECTION_TARGET_LIMIT;
  return {
    scope: "pinned_native_verified_endpoint",
    host: nativeIdentity.host,
    port,
    renderedMenuVerified: false,
    targetLimit: PICKER_INSPECTION_TARGET_LIMIT,
    eligibleTargetCount: targets.length,
    uniqueTargetCount: unique.size,
    duplicateTargetCount,
    attemptedTargetCount,
    inspectedTargetCount: finalSuccessful.length,
    unavailableTargetCount: observations.length - finalSuccessful.length,
    truncated,
    complete:
      !truncated &&
      finalSuccessful.length === unique.size &&
      observations.every((row) => !row.connectionCleanupPending),
    selectedTargetId: best?.status === "inspected" ? best.targetId : null,
    selectedTargetRef: best?.status === "inspected" ? best.targetRef : null,
    targets: observations,
    ...(sampling ? { sampling } : {}),
  };
};
const run = async () => {
  if (
    options.get("--output") &&
    (await stat(options.get("--output")).catch(() => null))
  )
    throw fail("output_exists");
  let readinessDeadline = startedAt + waitMs;
  let readinessFailure = "desktop_bridge_not_ready";
  do {
    await checkBinary();
    if (!sourceRuntimeBootstrapped) await refreshFingerprint();
    const owner = readNativeIdentity();
    if (nativeIdentity && !sameIdentity(nativeIdentity, owner))
      throw fail("debug_port_identity_changed");
    readinessBlocker = undefined;
    readinessFailure = !owner
      ? "desktop_debug_port_unavailable"
      : !expectedFingerprint
        ? "runtime_fingerprint_not_observed"
        : "desktop_bridge_not_ready";
    if (owner && (expectedFingerprint || inspectPicker)) {
      // Pin the concrete endpoint before the first HTTP/WebSocket operation.
      // Later identity checks must not silently move to another address.
      nativeIdentity = owner;
      const targets = await readTargets();
      if (inspectPicker && targets.length > 0) {
        stage = "picker_inspection";
        pickerTargetInspections = await inspectPickerTargets(
          targets,
          readinessDeadline,
          {
            sampleCount: pickerSampleCount,
            sampleIntervalMs: pickerSampleIntervalMs,
          },
        );
        pickerInspection = pickerTargetInspections.targets.find(
          (target) =>
            target.targetRef === pickerTargetInspections.selectedTargetRef,
        )?.inspection;
        if (!pickerInspection) throw fail("picker_inspection_unavailable");
        break;
      }
      for (const target of targets) {
        const candidate = await connect(target.webSocketDebuggerUrl);
        if (injectSourceRuntime && !sourceRuntimeBootstrapped) {
          const snapshot = await candidate
            .evaluate(sourceRuntimeSnapshotExpression())
            .catch(() => null);
          if (!snapshot?.ok) {
            sourceRuntimeInjection = {
              started: false,
              reason: snapshot?.reason || "source_runtime_snapshot_failed",
            };
            readinessBlocker =
              snapshot?.reason || "source_runtime_injection_failed";
            candidate.close();
            continue;
          }
          try {
            sourceRuntimeBaselineFingerprint = snapshot.installedFingerprint;
            sourceRuntime = await loadCodexRendererSourceRuntime();
            const payload = JSON.stringify(snapshot.payload);
            const source = sourceRuntime.assemble(
              payload,
              snapshot.catalogReleased,
              snapshot.requestHealthWarningsSuppressed,
            );
            // The source runtime changes the renderer fingerprint as its first
            // synchronous action. Fire it through CDP without awaiting its
            // React/module discovery; readiness below polls the new state.
            expectedFingerprint = sourceRuntime.fingerprint;
            checkNativeIdentity();
            await checkBinary();
            await candidate.evaluateDetached(source);
            sourceRuntimeBootstrapped = true;
            readinessDeadline = Math.max(
              readinessDeadline,
              Date.now() + 20_000,
            );
            sourceRuntimeInjection = {
              started: true,
              sourceFingerprint: sourceRuntime.fingerprint,
              payloadPreserved: snapshot.payload?.catalogAvailable === true,
              requestHealthWarningsSuppressed:
                snapshot.requestHealthWarningsSuppressed === true,
            };
          } catch (error) {
            sourceRuntimeInjection = {
              started: false,
              reason: String(error?.message || error),
            };
            readinessBlocker = "source_runtime_injection_failed";
            candidate.close();
            continue;
          }
        }
        let ready = null;
        do {
          ready = await candidate
            .evaluate(readinessExpression())
            .catch(() => null);
          if (ready?.ready || !injectSourceRuntime) break;
          if (Date.now() >= readinessDeadline) break;
          await sleep(250);
        } while (true);
        readinessDiagnostics = ready?.diagnostics;
        if (
          [
            "renderer_runtime_not_installed",
            "renderer_runtime_fingerprint_mismatch",
            "renderer_continuation_api_unavailable",
            "desktop_request_client_unavailable",
            "source_runtime_injection_failed",
            "source_runtime_snapshot_failed",
            "catalog_payload_unavailable",
          ].includes(ready?.readinessBlocker)
        )
          readinessBlocker = ready.readinessBlocker;
        if (ready?.ready) {
          connection = candidate;
          nativeIdentity = owner;
          break;
        }
        candidate.close();
      }
    }
    if (connection) break;
    if (Date.now() >= readinessDeadline) throw fail(readinessFailure);
    await sleep(500);
  } while (true);
  if (inspectPicker)
    return {
      verified: false,
      readinessVerified: false,
      pickerInspectionPerformed: true,
      desktopCdpVerified: false,
      noTestThreadCreated: true,
      existingThreadsTouched: false,
      existingThreadsPrompted: false,
      renderedMenuVerified: false,
      ...(typeof binarySha256 === "string"
        ? { ccswitchBinarySha256: binarySha256 }
        : {}),
      pickerInspection,
      pickerTargetInspections,
    };
  if (!runDisposableTest)
    return {
      verified: false,
      readinessVerified: true,
      scenario,
      desktopCdpVerified: false,
      noTestThreadCreated: true,
      runtimeFingerprint: expectedFingerprint,
      nativeHost: nativeIdentity.host,
      ...threadScopeEvidence(),
    };
  // Bounded commands and eight-second native probes can overrun this soft
  // deadline once; the remainder of the minute is reserved for cleanup.
  if (ownerRemoteAudit) {
    stage = "owner_remote_compile";
    ownerAuditExecutable = await compileOwnerAuditExecutable(
      ownerRemoteBrowserAudit ? ownerAuditBrowserTest : ownerAuditTest,
    );
  }
  verificationDeadline = Date.now() + (ownerRemoteAudit ? 120_000 : 45_000);
  capturedCurrentProviderId = await connection.evaluate(
    currentProviderExpression(),
  );
  providerId = `ccswitch_live_${randomUUID().replaceAll("-", "")}`;
  temporary = await mkdtemp(temporaryPrefix);
  fixture = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 512 * 1024) throw fail("fixture_request_too_large");
      }
      const input = JSON.parse(body).input;
      response.writeHead(200, { "content-type": "text/event-stream" });
      const event = (value) =>
        response.write(
          `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`,
        );
      const base = {
        id: `resp_fixture_${randomUUID()}`,
        model,
        output: [],
        status: "in_progress",
      };
      event({ type: "response.created", response: base });
      if (fixturePhase === "initial") {
        initialRequests += 1;
        const initialError = fixtureScenarios[scenario];
        if (initialError)
          event({
            type: "response.failed",
            response: {
              ...base,
              status: "failed",
              error: initialError,
            },
          });
      } else {
        continuedRequests += 1;
        const latest = Array.isArray(input)
          ? input.filter((item) => item.role === "user").at(-1)
          : null;
        receivedLiteralContinue ||=
          latest?.content === "continue" ||
          (Array.isArray(latest?.content) &&
            latest.content.some((item) => item.text === "continue"));
        const item = {
          id: `msg_fixture_${randomUUID()}`,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "OK", annotations: [] }],
        };
        event({
          type: "response.output_item.added",
          output_index: 0,
          item: { ...item, content: [], status: "in_progress" },
        });
        event({
          type: "response.content_part.added",
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        });
        event({
          type: "response.output_text.delta",
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          delta: "OK",
        });
        event({
          type: "response.output_text.done",
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          text: "OK",
        });
        event({
          type: "response.content_part.done",
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          part: item.content[0],
        });
        event({ type: "response.output_item.done", output_index: 0, item });
        event({
          type: "response.completed",
          response: {
            ...base,
            status: "completed",
            output: [item],
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              total_tokens: 2,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          },
        });
      }
      response.end();
    } catch {
      fixtureFailure = true;
      response.writeHead(500).end();
    }
  });
  await new Promise((resolve, reject) => {
    fixture.once("error", reject);
    fixture.listen(0, "127.0.0.1", resolve);
  });
  const localBase = `http://127.0.0.1:${fixture.address().port}/v1`;
  stage = "create_test_thread";
  checkNativeIdentity();
  await checkBinary();
  await restoreSourceRuntimeAfterNativeCheck();
  await waitForPinnedCreationReadiness();
  testThreadCreationAttempted = true;
  const created = await connection.evaluate(
    guarded(`
    if(lease) throw new Error('lease_already_exists');
    if(state.payload?.modelProvider!==${JSON.stringify(capturedCurrentProviderId)})throw new Error('current_provider_changed');
    const declared=(value,name)=>{for(let n=0;value&&n<5;n++,value=Object.getPrototypeOf(value)){const d=Object.getOwnPropertyDescriptor(value,name);if(d)return typeof d.value==='function'?d.value:null;}return null;};
    const client=state.appServerClients.find(item=>typeof state.isCodexContinuationRequestClient==='function'&&state.isCodexContinuationRequestClient(item));
    if(!client)throw new Error('client_missing');
    const request=declared(client,'__ccSwitchOriginalSendRequest').bind(client);
    const result=await request('thread/start',${JSON.stringify({ model, modelProvider: providerId, allowProviderModelFallback: false, cwd: temporary, approvalPolicy: "never", sandbox: "read-only", environments: [], dynamicTools: [], baseInstructions: "Reply only OK. Do not call tools.", developerInstructions: "This is a disposable local protocol test. Do not call tools.", config: { [`model_providers.${providerId}`]: fixtureProviderDefinition(localBase), model_reasoning_effort: "low" } })});
    const id=result?.thread?.id;
    if(!id)throw new Error('created_thread_missing');
    window[${JSON.stringify(leaseKey)}]={threadId:id,request,observedAtMs:Date.now(),providerMatches:result.modelProvider===${JSON.stringify(providerId)}&&result.model===${JSON.stringify(model)}};
    return {threadId:id,providerMatches:window[${JSON.stringify(leaseKey)}].providerMatches};
  `),
    20_000,
  );
  threadId = created?.threadId;
  if (!threadId || created.providerMatches !== true)
    throw fail("local_fixture_provider_not_confirmed");
  stage = "initial_fixture_turn";
  checkNativeIdentity();
  await checkBinary();
  const initialTurn = await connection.evaluate(
    guarded(`
    if(!lease?.providerMatches||lease.threadId!==${JSON.stringify(threadId)})throw new Error('wrong_test_thread');
    lease.observedAtMs=Date.now();
    const result=await lease.request('turn/start',{threadId:lease.threadId,input:[{type:'text',text:'Reply with OK. Do not call tools.'}]});
    const turnId=String(result?.turn?.id||result?.turnId||result?.turn_id||'');
    const returnedThreadId=String(result?.threadId||result?.thread_id||result?.thread?.id||'');
    return {turnId,threadMatches:!returnedThreadId||returnedThreadId===lease.threadId,responseType:typeof result,responseKeys:result&&typeof result==='object'?Object.keys(result).filter(k=>/^[a-zA-Z_]{1,40}$/.test(k)).slice(0,24):[],turnStatus:typeof result?.turn?.status==='string'?result.turn.status:null};
  `),
  );
  initialTurnDiagnostics = initialTurn;
  stage = "initial_turn_acknowledgement";
  assert.equal(initialTurn?.threadMatches, true);
  assert.ok(typeof initialTurn?.turnId === "string" && initialTurn.turnId);
  ownedTurnIds.push(initialTurn.turnId);
  stage = "initial_fixture_request";
  await waitForInitialFixtureRequest();
  stage = "initial_failed_turn";
  const failed = await waitUntil(async () => {
    const current = await connection.evaluate(threadProjection());
    if (current?.readFailure) {
      ownedThreadReadFailure = projectOwnedThreadReadFailure(
        current.readFailure,
      );
      // Diagnostic only: do not retry the read, turn/start, or continuation.
      throw fail("owned_thread_read_rejected");
    }
    latestThreadDiagnostics = {
      turnCount: Number.isSafeInteger(current?.turnCount)
        ? current.turnCount
        : null,
      status: [
        "inProgress",
        "in_progress",
        "completed",
        "failed",
        "interrupted",
      ].includes(current?.status)
        ? current.status
        : "unknown",
      threadMatches: current?.threadMatches === true,
      turnIdPresent: Boolean(current?.turnId),
      initialTurnMatches: current?.turnId === initialTurn.turnId,
    };
    if (current.turnId && current.turnId !== initialTurn.turnId)
      throw fail("unexpected_test_thread_turn");
    return current.status === "failed" ? current : null;
  });
  stage = "initial_fixture_request_count";
  assert.equal(initialRequests, 1);
  stage = "initial_fixture_turn_count";
  assert.equal(failed.turnCount, 1);
  if (ownerRemoteAudit) return verifyOwnerRemoteFixture(failed, localBase);
  stage = "production_prepare";
  checkNativeIdentity();
  await checkBinary();
  continuationDiagnostics = {};
  continuationDiagnostics.prepareAck = await connection.evaluate(
    continuationResultExpression(
      `state.startCodexContinuation(lease.threadId,${JSON.stringify(recoveryId)},${JSON.stringify(model)},lease.observedAtMs)`,
      `if(lease.threadId!==${JSON.stringify(threadId)})throw new Error('wrong_test_thread');`,
    ),
  );
  const jobExpression = continuationJobExpression();
  const prepared = await waitUntil(async () => {
    const job = await readContinuationJob(jobExpression);
    return job && job.status !== "pending" ? job : null;
  });
  continuationDiagnostics.preparedJob = continuationDiagnostics.latestJob;
  if (scenarioExpectsTerminalRefusal)
    return verifyTerminalFixtureRefusal(prepared, failed);
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.threadMatches, true);
  const preparedReadiness = await connection.evaluate(readinessExpression());
  const preparedGeneration = preparedReadiness?.diagnostics?.runtimeGeneration;
  continuationDiagnostics.preparedReadinessGeneration = Number.isSafeInteger(
    preparedGeneration,
  )
    ? preparedGeneration
    : null;
  assert.ok(Number.isSafeInteger(preparedGeneration));
  stage = "production_commit";
  checkNativeIdentity();
  await checkBinary();
  if (await restoreSourceRuntimeAfterNativeCheck(preparedGeneration)) {
    const sameFailure = await connection.evaluate(threadProjection());
    if (
      sameFailure.turnId !== failed.turnId ||
      sameFailure.status !== "failed" ||
      sameFailure.turnCount !== 1
    )
      throw fail("unexpected_test_thread_turn");
    checkNativeIdentity();
    await checkBinary();
    continuationDiagnostics.reprepareAck = await connection.evaluate(
      continuationResultExpression(
        `state.startCodexContinuation(lease.threadId,${JSON.stringify(recoveryId)},${JSON.stringify(model)},lease.observedAtMs)`,
        `if(lease.threadId!==${JSON.stringify(threadId)})throw new Error('wrong_test_thread');`,
      ),
    );
    const reprepared = await waitUntil(async () => {
      const job = await readContinuationJob(jobExpression);
      return job && job.status !== "pending" ? job : null;
    });
    continuationDiagnostics.repreparedJob = continuationDiagnostics.latestJob;
    assert.equal(reprepared.status, "prepared");
    assert.equal(reprepared.threadMatches, true);
    sourceRuntimeReprepareCount += 1;
    sourceRuntimeInjection = {
      ...sourceRuntimeInjection,
      reprepareCount: sourceRuntimeReprepareCount,
    };
  }
  stage = "production_confirm";
  const confirmation = await confirmContinuationWithDiagnostics(jobExpression);
  assert.equal(confirmation.ack?.started, true);
  assert.equal(confirmation.job?.status, "confirmed");
  assert.equal(confirmation.job.threadMatches, true);
  assert.equal(confirmation.job.submitted, false);
  assert.equal(confirmation.job.mutationAttempted, false);
  fixturePhase = "continued";
  stage = "production_commit";
  // Final native identity/binary checks follow every renderer read before the
  // confirmed no-await sender is invoked, matching the production phase order.
  checkNativeIdentity();
  await checkBinary();
  const commit = await commitContinuationWithDiagnostics(jobExpression);
  assert.equal(commit.started, true);
  const submitted = await waitUntil(async () => {
    const job = await readContinuationJob(jobExpression);
    return job?.status === "completed" ? job : null;
  });
  continuationDiagnostics.completedJob = continuationDiagnostics.latestJob;
  assert.equal(submitted.submitted, true);
  assert.equal(submitted.mutationAttempted, true);
  assert.ok(
    typeof submitted.turnId === "string" &&
      submitted.turnId &&
      submitted.turnId !== initialTurn.turnId,
  );
  ownedTurnIds.push(submitted.turnId);
  stage = "continued_completion";
  const complete = await waitUntil(async () => {
    const current = await connection.evaluate(threadProjection());
    if (current?.readFailure) {
      ownedThreadReadFailure = projectOwnedThreadReadFailure(
        current.readFailure,
      );
      // Diagnostic only: do not retry the read, turn/start, or continuation.
      throw fail("owned_thread_read_rejected");
    }
    if (current.turnId && !ownedTurnIds.includes(current.turnId))
      throw fail("unexpected_test_thread_turn");
    return current.threadMatches === true &&
      current.status === "completed" &&
      current.turnId === submitted.turnId &&
      current.threadStatus === "idle"
      ? current
      : null;
  });
  assert.equal(complete.turnCount, 2);
  assert.equal(continuedRequests, 1);
  assert.equal(receivedLiteralContinue, true);
  assert.equal(fixtureFailure, false);
  checkNativeIdentity();
  await checkBinary();
  return {
    verified: true,
    scenario,
    scope: injectSourceRuntime
      ? "actual_codex_desktop_cdp_source_production_runtime"
      : "actual_codex_desktop_cdp_existing_production_runtime",
    desktopCdpVerified: true,
    automaticNativeSchedulingVerified: false,
    runtimeFingerprint: expectedFingerprint,
    ccswitchBinarySha256: binarySha256,
    ...(creationReadinessDiagnostics ? { creationReadinessDiagnostics } : {}),
    nativeOwnerVerified: true,
    nativeHost: nativeIdentity.host,
    nativeOwnerPids: nativeIdentity.owners.map((owner) => owner.pid),
    temporaryDurableTestThread: true,
    perThreadLocalFixtureProviderConfirmed: true,
    initialFailedTurnObserved: true,
    ...(scenario === "overload" ? { sseOverloadFailedTurnObserved: true } : {}),
    productionGuardsPrepared: true,
    appServerAcceptedContinue: true,
    upstreamReceivedLiteralContinue: true,
    continuedTurnCompleted: true,
    exactlyOneContinuation: true,
    continuationDiagnostics,
    ...(sourceRuntimeInjection ? { sourceRuntimeInjection } : {}),
    ...threadScopeEvidence(),
    initialRequests,
    continuedRequests,
  };
};

let evidence;
try {
  evidence = await run();
} catch (error) {
  const code = String(error?.message || "");
  if (connection) {
    const operationFailure = rendererOperationFailure;
    const latest = await connection
      .evaluate(readinessExpression(), 2500)
      .catch(() => null);
    if (latest?.diagnostics) readinessDiagnostics = latest.diagnostics;
    rendererOperationFailure = operationFailure;
  }
  const finiteCodes = new Set([
    "ccswitch_binary_changed",
    "native_identity_query_failed",
    "native_identity_invalid",
    "picker_inspection_unavailable",
    "debug_port_owner_not_codex",
    "debug_port_identity_changed",
    "target_list_unavailable",
    "target_list_invalid",
    "target_list_timeout",
    "cdp_connect_timeout",
    "cdp_connect_failed",
    "cdp_protocol_error",
    "cdp_closed",
    "cdp_command_timeout",
    "renderer_operation_rejected",
    "owned_thread_read_rejected",
    "initial_fixture_request_invalid",
    "owner_audit_invalid_evidence",
    "owner_audit_invalid_handoff",
    "owner_audit_handoff_failed",
    "owner_audit_compile_failed",
    "owner_audit_view_failed",
    "owner_audit_continue_failed",
    "owner_audit_child_pending",
    "browser_audit_configuration_invalid",
    "browser_audit_certificate_unavailable",
    "browser_audit_handoff_invalid",
    "browser_audit_handoff_failed",
    "browser_audit_service_unavailable",
    "browser_audit_prepare_failed",
    "browser_audit_cleanup_pending",
    "verification_deadline",
    "desktop_bridge_not_ready",
    "desktop_debug_port_unavailable",
    "runtime_fingerprint_not_observed",
    "local_fixture_provider_not_confirmed",
    "output_exists",
    "unexpected_test_thread_turn",
    "source_runtime_baseline_changed",
  ]);
  evidence = {
    verified: false,
    scenario,
    desktopCdpVerified: false,
    stage,
    failure: finiteCodes.has(code) ? code : "verification_assertion_failed",
    ...(nativeIdentityDiagnostic ? { nativeIdentityDiagnostic } : {}),
    ...(rendererOperationFailure ? { rendererOperationFailure } : {}),
    ...(initialTurnDiagnostics ? { initialTurnDiagnostics } : {}),
    ...(latestThreadDiagnostics ? { latestThreadDiagnostics } : {}),
    ...(ownedThreadReadFailure ? { ownedThreadReadFailure } : {}),
    ...(ownerAuditDiagnostics
      ? { ownerRemoteAudit: ownerAuditDiagnostics }
      : {}),
    ...(typeof continuationDiagnostics === "object" && continuationDiagnostics
      ? { continuationDiagnostics }
      : {}),
    initialRequests,
    continuedRequests,
    ...(code === "desktop_bridge_not_ready" && readinessBlocker
      ? { readinessBlocker }
      : {}),
    ...(readinessDiagnostics ? { readinessDiagnostics } : {}),
    ...(creationReadinessDiagnostics ? { creationReadinessDiagnostics } : {}),
    ...(inspectPicker
      ? {
          pickerInspectionPerformed: Boolean(pickerInspection),
          renderedMenuVerified: false,
          ...(pickerInspection ? { pickerInspection } : {}),
          ...(pickerTargetInspections ? { pickerTargetInspections } : {}),
        }
      : {}),
    ...(sourceRuntimeInjection ? { sourceRuntimeInjection } : {}),
    temporaryDurableTestThread: Boolean(threadId),
    ...(testThreadCreationAttempted && !threadId
      ? { threadCreationUncertain: true }
      : {}),
    ...threadScopeEvidence(),
  };
  process.exitCode = 1;
} finally {
  // Wait for the exact native test process to close BEFORE any thread/HTTP cleanup.
  // An unconfirmed kill leaves the fixture/lease/cwd alive; no replacement send.
  let ownerChildSettled = true;
  if (ownerAuditChild) {
    if (
      ownerAuditBrowser &&
      !ownerAuditMutationUncertain &&
      !ownerAuditChild.closed
    ) {
      try {
        await ownerAuditBrowser.finish();
      } catch {
        evidence.browserAuditStopPending = true;
      }
    }
    ownerChildSettled = await settleOwnerAuditChild(ownerAuditChild);
    if (ownerChildSettled) {
      try {
        await captureOwnerAuditResult();
      } catch {
        evidence.ownerAuditEvidenceRejected = true;
      }
      if (ownerAuditDiagnostics)
        evidence.ownerRemoteAudit = ownerAuditDiagnostics;
      await resolveOwnerAuditMutationUncertainty();
      if (ownerAuditBrowser) {
        try {
          const stopped = await readBrowserAuditFile(
            temporary,
            "browser-result.json",
          );
          if (
            !stopped ||
            Object.keys(stopped).sort().join(",") !==
              "auditNonce,error,schemaVersion,stopped" ||
            stopped.schemaVersion !== 1 ||
            stopped.auditNonce !== ownerAuditNonce ||
            stopped.stopped !== true ||
            stopped.error !== null
          )
            throw 0;
        } catch {
          evidence.browserAuditServiceStopUnproven = true;
          evidence.verified = false;
          evidence.desktopCdpVerified = false;
          process.exitCode = 1;
        }
      }
    } else {
      evidence.verified = false;
      evidence.desktopCdpVerified = false;
      evidence.ownerAuditChildPending = true;
      evidence.cleanupPending = "owner_audit_child_pending";
      process.exitCode = 1;
    }
    if (ownerAuditMutationUncertain) {
      ownerChildSettled = false;
      evidence.ownerAuditOutcomeUncertain = true;
      evidence.cleanupPending = "owner_audit_outcome_uncertain";
      evidence.verified = false;
      evidence.desktopCdpVerified = false;
      process.exitCode = 1;
    }
  }
  if (ownerAuditBrowser) {
    evidence.browserAudit = projectOwnerRemoteBrowserAuditDiagnostics(
      ownerAuditBrowser.diagnostics,
    );
    if (ownerChildSettled) {
      try {
        await ownerAuditBrowser.dispose();
      } catch {
        ownerChildSettled = false;
        evidence.browserAuditCleanupPending = true;
        evidence.verified = false;
        evidence.desktopCdpVerified = false;
        process.exitCode = 1;
      }
    }
  }
  // Cleanup is restricted to our lease and its newly-created thread. A loaded
  // or uncertain active turn is never interrupted or archived here.
  if (ownerChildSettled && connection && runDisposableTest) {
    try {
      if (injectSourceRuntime && threadId) {
        checkNativeIdentity();
        await checkBinary();
        await restoreSourceRuntimeAfterNativeCheck();
      }
      checkNativeIdentity();
      await checkBinary();
      const cleanup = await connection.evaluate(cleanupExpression(), 2500);
      evidence.cleanupDiagnostics = projectCleanupResult(cleanup);
      cleanupArchived = evidence.cleanupDiagnostics.archived;
    } catch (error) {
      evidence.cleanupDiagnostics = {
        archived: false,
        reason: classifyCleanupFailure(error),
      };
    }
    evidence.cleanupArchived = cleanupArchived;
    if (cleanupArchived) evidence.temporaryDurableTestThread = true;
    if (threadId && !cleanupArchived) {
      evidence.verified = false;
      evidence.desktopCdpVerified = false;
      evidence.cleanupFailure = "disposable_thread_not_archived";
      process.exitCode = 1;
    }
  }
  try {
    if (ownerChildSettled) connection?.close();
  } catch {
    evidence.connectionCleanupPending = true;
  }
  try {
    if (ownerChildSettled) fixture?.closeAllConnections();
    if (ownerChildSettled && fixture?.listening)
      await new Promise((resolve) => fixture.close(resolve));
  } catch {
    evidence.fixtureCleanupPending = true;
  }
  await cleanupTemporaryDirectory(evidence);
}
evidence.verifiedAtUtc = new Date().toISOString();
if (options.get("--output")) {
  try {
    const file = await open(options.get("--output"), "wx");
    try {
      await file.writeFile(`${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    } finally {
      await file.close();
    }
  } catch (error) {
    evidence.receiptFailure =
      error?.code === "EEXIST" ? "output_exists" : "output_write_failed";
    process.exitCode = 1;
  }
}
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
