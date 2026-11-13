import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { createServer, get } from "node:http";
import os from "node:os";
import path from "node:path";
import { loadCodexRendererSourceRuntime } from "./codex-renderer-source-runtime.mjs";

// Bounded background verification of Desktop compatibility. Direct fixture
// RPCs use only the owned thread lease. Explicit full source injection may
// refresh existing model/history caches through the compatibility runtime.
const startedAt = Date.now();
const options = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (key === "--run-disposable-test" || key === "--inject-source-runtime")
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
      ].includes(key),
      "Unknown verifier option",
    );
    assert.ok(process.argv[index + 1], "A verifier option needs a value");
    options.set(key, process.argv[++index]);
  }
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
});
const scenario = options.get("--scenario") || "overload";
assert.ok(
  Object.hasOwn(fixtureScenarios, scenario),
  "Unknown verifier scenario",
);
const patchKey = "__ccSwitchCodexAppCompatibilityV9";
const leaseKey = `__ccSwitchContinuationVerifier_${randomUUID().replaceAll("-", "")}`;
const recoveryId = `desktop-verification-${randomUUID()}`;
let providerId;
const model = "fixture-model";
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
let receivedLiteralContinue = false;
let fixturePhase = "initial";
let fixtureFailure = false;
let binaryIdentity;
let binarySha256;
let nativeIdentity;
let readinessBlocker;
let readinessDiagnostics;
let rendererOperationFailure;
let sourceRuntimeInjection;
let sourceRuntime;
let sourceRuntimeBootstrapped = false;
let sourceRuntimeBaselineFingerprint;
let sourceRuntimeReinjectionCount = 0;
let sourceRuntimeReprepareCount = 0;
let verificationDeadline = Infinity;
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
const cleanupTemporaryDirectory = async (evidence) => {
  if (!temporary) return;
  if (!temporary.startsWith(temporaryPrefix) || temporary === os.tmpdir()) {
    evidence.pendingDirectory = true;
    evidence.cleanupPending = "temporary_directory_outside_lease";
    return;
  }
  if ((threadId || testThreadCreationAttempted) && !cleanupArchived) {
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

const readNativeIdentity = () => {
  // These are the production Windows shell rules from commands/proxy.rs.
  // Query only the explicitly supplied debug port and its exact owner PIDs.
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if ($PSVersionTable.PSVersion.Major -ne 7 -or $PSVersionTable.PSVersion.Minor -lt 5) { throw 'powershell_75_required' }
$owners = @(Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue |
  Where-Object { $_.OwningProcess -ne 0 -and $_.RemotePort -eq 0 } |
  Select-Object -ExpandProperty OwningProcess -Unique)
$result = @($owners | ForEach-Object {
  $item = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $_) -ErrorAction Stop
  $exe = ([string]$item.ExecutablePath).Replace('/', '\\').ToLowerInvariant()
  $main = $item.CommandLine -notmatch ' --type='
  $packaged = $exe.Contains('\\windowsapps\\openai.codex_') -or $exe.Contains('\\windowsapps\\openai.codex.preview_')
  $legacy = @('\\windowsapps\\openai.codex_', '\\windowsapps\\openai.codex.preview_', '\\appdata\\local\\openai\\codex\\', '\\appdata\\local\\programs\\openai\\codex\\', '\\appdata\\local\\programs\\codex\\', '\\program files\\openai\\codex\\', '\\program files\\codex\\', '\\program files (x86)\\openai\\codex\\', '\\scoop\\apps\\codex\\') | Where-Object { $exe.Contains($_) }
  $verified = $main -and $exe -and (($item.Name -ceq 'ChatGPT.exe' -and $packaged) -or ($item.Name -ceq 'Codex.exe' -and $legacy.Count -gt 0 -and -not $exe.EndsWith('\\resources\\codex.exe')))
  [pscustomobject]@{pid=$item.ProcessId; creationTicks=$item.CreationDate.ToUniversalTime().Ticks.ToString(); verified=[bool]$verified; name=$item.Name}
})
ConvertTo-Json -InputObject $result -Compress
`;
  const result = spawnSync(
    "pwsh",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, encoding: "utf8", timeout: 8000 },
  );
  if (result.status !== 0) throw fail("native_identity_query_failed");
  let owners;
  try {
    owners = JSON.parse(result.stdout);
  } catch {
    throw fail("native_identity_invalid");
  }
  if (!Array.isArray(owners) || !owners.length) return null;
  if (
    owners.some(
      (owner) => owner.verified !== true || !owner.pid || !owner.creationTicks,
    )
  )
    throw fail("debug_port_owner_not_codex");
  return owners.sort((a, b) => a.pid - b.pid);
};
const checkNativeIdentity = () => {
  if (!sameIdentity(nativeIdentity, readNativeIdentity()))
    throw fail("debug_port_identity_changed");
};
const readTargets = () =>
  new Promise((resolve, reject) => {
    const request = get(
      { hostname: "127.0.0.1", port, path: "/json", timeout: 2000 },
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
                const localSocket =
                  socket.protocol === "ws:" &&
                  ["127.0.0.1", "localhost", "[::1]"].includes(
                    socket.hostname,
                  ) &&
                  Number(socket.port) === port;
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
const connect = async (url) => {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(fail("cdp_connect_timeout"));
    }, 4000);
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
    });
  try {
    await command("Runtime.enable", {});
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
  const client = state?.appServerClients?.find((item) => typeof state.isCodexContinuationRequestClient==='function' && state.isCodexContinuationRequestClient(item));
  const fingerprintMatches = state?.rendererRuntimeFingerprint===${JSON.stringify(expectedFingerprint)};
  const readinessBlocker = !state ? 'renderer_runtime_not_installed' : !fingerprintMatches ? 'renderer_runtime_fingerprint_mismatch' : !['startCodexContinuation','readCodexContinuationJob','commitCodexContinuation','isCodexContinuationRequestClient'].every(k=>typeof state[k]==='function') ? 'renderer_continuation_api_unavailable' : !client ? 'desktop_request_client_unavailable' : null;
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
const threadProjection = () =>
  guarded(`
  if(!lease?.threadId || lease.threadId!==${JSON.stringify(threadId)}) throw new Error('wrong_test_thread');
  const result=await lease.request('thread/read',{threadId:lease.threadId,includeTurns:true});
  const thread=result.thread||result;
  if(thread.id!==lease.threadId) throw new Error('wrong_test_thread');
  const turn=thread.turns?.at(-1);
  return {threadMatches:true,turnCount:thread.turns?.length||0,turnId:turn?.id,status:turn?.status,threadStatus:thread.status?.type||thread.status};
`);
const cleanupExpression = () =>
  guarded(`
  if(!lease?.threadId)return {archived:false};
  if(${JSON.stringify(threadId || "")}&&lease.threadId!==${JSON.stringify(threadId || "")})throw new Error('wrong_test_thread');
  if(typeof state.cancelCodexContinuation==='function')state.cancelCodexContinuation(${JSON.stringify(recoveryId)});
  const result=await lease.request('thread/read',{threadId:lease.threadId,includeTurns:true});
  const thread=result.thread||result;
  if(thread.id!==lease.threadId)throw new Error('wrong_test_thread');
  const status=thread.status?.type||thread.status;
  const last=thread.turns?.at(-1)?.status;
  const owned=${JSON.stringify(ownedTurnIds)};
  if(!Array.isArray(thread.turns)||thread.turns.some(turn=>!owned.includes(turn.id)))return {archived:false,reason:'unexpected_turn'};
  if(status==='active'||(last&&!['completed','failed','interrupted'].includes(last)))return {archived:false};
  await lease.request('thread/archive',{threadId:lease.threadId});
  delete window[${JSON.stringify(leaseKey)}];
  return {archived:true};
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
    readinessBlocker = undefined;
    readinessFailure = !owner
      ? "desktop_debug_port_unavailable"
      : !expectedFingerprint
        ? "runtime_fingerprint_not_observed"
        : "desktop_bridge_not_ready";
    if (owner && expectedFingerprint) {
      const targets = await readTargets();
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
  if (!runDisposableTest)
    return {
      verified: false,
      readinessVerified: true,
      scenario,
      desktopCdpVerified: false,
      noTestThreadCreated: true,
      runtimeFingerprint: expectedFingerprint,
      ...threadScopeEvidence(),
    };
  // Bounded commands and eight-second native probes can overrun this soft
  // deadline once; the remainder of the minute is reserved for cleanup.
  verificationDeadline = Date.now() + 45_000;
  providerId = await connection.evaluate(currentProviderExpression());
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
  testThreadCreationAttempted = true;
  const created = await connection.evaluate(
    guarded(`
    if(lease) throw new Error('lease_already_exists');
    if(state.payload?.modelProvider!==${JSON.stringify(providerId)})throw new Error('current_provider_changed');
    const declared=(value,name)=>{for(let n=0;value&&n<5;n++,value=Object.getPrototypeOf(value)){const d=Object.getOwnPropertyDescriptor(value,name);if(d)return typeof d.value==='function'?d.value:null;}return null;};
    const client=state.appServerClients.find(item=>typeof state.isCodexContinuationRequestClient==='function'&&state.isCodexContinuationRequestClient(item));
    if(!client)throw new Error('client_missing');
    const request=declared(client,'__ccSwitchOriginalSendRequest').bind(client);
    const result=await request('thread/start',${JSON.stringify({ model, modelProvider: providerId, allowProviderModelFallback: false, cwd: temporary, approvalPolicy: "never", sandbox: "read-only", environments: [], dynamicTools: [], baseInstructions: "Reply only OK. Do not call tools.", developerInstructions: "This is a disposable local protocol test. Do not call tools.", config: { [`model_providers.${providerId}.base_url`]: localBase, [`model_providers.${providerId}.request_max_retries`]: 0, [`model_providers.${providerId}.stream_max_retries`]: 0, [`model_providers.${providerId}.stream_idle_timeout_ms`]: 5000, model_reasoning_effort: "low" } })});
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
  stage = "initial_failed_turn";
  const failed = await waitUntil(async () => {
    const current = await connection.evaluate(threadProjection());
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
  stage = "production_prepare";
  await connection.evaluate(
    guarded(`
    if(lease.threadId!==${JSON.stringify(threadId)})throw new Error('wrong_test_thread');
    return state.startCodexContinuation(lease.threadId,${JSON.stringify(recoveryId)},${JSON.stringify(model)},lease.observedAtMs);
  `),
  );
  const jobExpression = guarded(
    `const job=state.readCodexContinuationJob(${JSON.stringify(recoveryId)}); return job?{status:job.status,submitted:job.submitted,mutationAttempted:job.mutationAttempted,turnId:job.turnId,threadMatches:job.threadId===${JSON.stringify(threadId)}}:null;`,
  );
  const prepared = await waitUntil(async () => {
    const job = await connection.evaluate(jobExpression);
    return job && job.status !== "pending" ? job : null;
  });
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.threadMatches, true);
  const preparedReadiness = await connection.evaluate(readinessExpression());
  const preparedGeneration = preparedReadiness?.diagnostics?.runtimeGeneration;
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
    await connection.evaluate(
      guarded(`
      if(lease.threadId!==${JSON.stringify(threadId)})throw new Error('wrong_test_thread');
      return state.startCodexContinuation(lease.threadId,${JSON.stringify(recoveryId)},${JSON.stringify(model)},lease.observedAtMs);
    `),
    );
    const reprepared = await waitUntil(async () => {
      const job = await connection.evaluate(jobExpression);
      return job && job.status !== "pending" ? job : null;
    });
    assert.equal(reprepared.status, "prepared");
    assert.equal(reprepared.threadMatches, true);
    sourceRuntimeReprepareCount += 1;
    sourceRuntimeInjection = {
      ...sourceRuntimeInjection,
      reprepareCount: sourceRuntimeReprepareCount,
    };
  }
  fixturePhase = "continued";
  const commit = await connection.evaluate(
    guarded(
      `return state.commitCodexContinuation(${JSON.stringify(recoveryId)});`,
    ),
  );
  assert.equal(commit.started, true);
  const submitted = await waitUntil(async () => {
    const job = await connection.evaluate(jobExpression);
    return job?.status === "completed" ? job : null;
  });
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
    if (current.turnId && !ownedTurnIds.includes(current.turnId))
      throw fail("unexpected_test_thread_turn");
    return current.status === "completed" && current.turnId !== failed.turnId
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
    runtimeFingerprint: expectedFingerprint,
    ccswitchBinarySha256: binarySha256,
    nativeOwnerVerified: true,
    nativeOwnerPids: nativeIdentity.map((owner) => owner.pid),
    temporaryDurableTestThread: true,
    perThreadLocalFixtureProviderConfirmed: true,
    initialFailedTurnObserved: true,
    ...(scenario === "overload" ? { sseOverloadFailedTurnObserved: true } : {}),
    productionGuardsPrepared: true,
    appServerAcceptedContinue: true,
    upstreamReceivedLiteralContinue: true,
    continuedTurnCompleted: true,
    exactlyOneContinuation: true,
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
    ...(rendererOperationFailure ? { rendererOperationFailure } : {}),
    ...(initialTurnDiagnostics ? { initialTurnDiagnostics } : {}),
    ...(latestThreadDiagnostics ? { latestThreadDiagnostics } : {}),
    initialRequests,
    continuedRequests,
    ...(code === "desktop_bridge_not_ready" && readinessBlocker
      ? { readinessBlocker }
      : {}),
    ...(readinessDiagnostics ? { readinessDiagnostics } : {}),
    ...(sourceRuntimeInjection ? { sourceRuntimeInjection } : {}),
    temporaryDurableTestThread: Boolean(threadId),
    ...(testThreadCreationAttempted && !threadId
      ? { threadCreationUncertain: true }
      : {}),
    ...threadScopeEvidence(),
  };
  process.exitCode = 1;
} finally {
  // Cleanup is restricted to our lease and its newly-created thread. A loaded
  // or uncertain active turn is never interrupted or archived here.
  if (connection && runDisposableTest) {
    try {
      if (injectSourceRuntime && threadId) {
        checkNativeIdentity();
        await checkBinary();
        await restoreSourceRuntimeAfterNativeCheck();
      }
      const cleanup = await connection.evaluate(cleanupExpression(), 2500);
      cleanupArchived = cleanup?.archived === true;
    } catch {
      /* Report cleanup failure without exposing arbitrary RPC errors. */
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
    connection?.close();
  } catch {
    evidence.connectionCleanupPending = true;
  }
  try {
    fixture?.closeAllConnections();
    if (fixture?.listening)
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
