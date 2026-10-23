import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { createServer, get } from "node:http";
import os from "node:os";
import path from "node:path";

// Bounded, background verification of the existing Desktop compatibility
// runtime. No UI, runtime installation, process restart, or existing-chat RPC.
const startedAt = Date.now();
const options = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (key === "--run-disposable-test") options.set(key, true);
  else {
    assert.ok(
      [
        "--port",
        "--runtime-fingerprint",
        "--ccswitch-log",
        "--ccswitch-binary",
        "--wait-ms",
        "--output",
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
const patchKey = "__ccSwitchCodexAppCompatibilityV9";
const leaseKey = `__ccSwitchContinuationVerifier_${randomUUID().replaceAll("-", "")}`;
const recoveryId = `desktop-verification-${randomUUID()}`;
const providerId = `ccswitch_verifier_${randomUUID().replaceAll("-", "")}`;
const model = "fixture-model";
const temporaryPrefix = path.join(
  os.tmpdir(),
  "ccswitch-desktop-continuation-",
);
let temporary;
let connection;
let fixture;
let threadId;
const ownedTurnIds = [];
let cleanupArchived = false;
let stage = "readiness";
let initialRequests = 0;
let continuedRequests = 0;
let receivedLiteralContinue = false;
let fixturePhase = "overload";
let fixtureFailure = false;
let binaryIdentity;
let binarySha256;
let nativeIdentity;
let verificationDeadline = Infinity;
const initialLogInfo = logPath ? await stat(logPath).catch(() => null) : null;
let logFileIdentity = initialLogInfo
  ? `${initialLogInfo.dev}:${initialLogInfo.ino}`
  : null;
let logOffset = initialLogInfo?.size || 0;
let logFragment = "";
const fail = (code) => new Error(code);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sameIdentity = (left, right) =>
  JSON.stringify(left) === JSON.stringify(right);

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
$owners = @(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
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
      if (result.exceptionDetails) throw fail("renderer_operation_rejected");
      return result.result?.value;
    },
    close: () => socket.close(),
  };
};
const readinessExpression = () => `(() => {
  const state = window[${JSON.stringify(patchKey)}];
  const declared = (value, name) => { for (let n=0; value && n<5; n++, value=Object.getPrototypeOf(value)) { const d=Object.getOwnPropertyDescriptor(value,name); if(d) return typeof d.value==='function' ? d.value : null; } return null; };
  const client = state?.appServerClients?.find((item) => Object.getOwnPropertyDescriptor(item,'hostId')?.value==='local' && declared(item,'__ccSwitchOriginalSendRequest') && declared(item,'getCompatibleThreadSortKey') && declared(item,'supportsPaginatedThreadHistory'));
  return {ready: Boolean(state && state.rendererRuntimeFingerprint===${JSON.stringify(expectedFingerprint)} && client && ['startCodexContinuation','readCodexContinuationJob','commitCodexContinuation'].every(k=>typeof state[k]==='function')), fingerprintMatches:state?.rendererRuntimeFingerprint===${JSON.stringify(expectedFingerprint)}};
})()`;
const guarded = (body) => `(async () => {
  const state = window[${JSON.stringify(patchKey)}];
  if (!state || state.rendererRuntimeFingerprint!==${JSON.stringify(expectedFingerprint)}) throw new Error('runtime_changed');
  const lease=window[${JSON.stringify(leaseKey)}];
  ${body}
})()`;
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
const run = async () => {
  if (
    options.get("--output") &&
    (await stat(options.get("--output")).catch(() => null))
  )
    throw fail("output_exists");
  const readinessDeadline = startedAt + waitMs;
  do {
    await checkBinary();
    await refreshFingerprint();
    const owner = readNativeIdentity();
    if (owner && expectedFingerprint) {
      const targets = await readTargets();
      for (const target of targets) {
        const candidate = await connect(target.webSocketDebuggerUrl);
        const ready = await candidate
          .evaluate(readinessExpression())
          .catch(() => null);
        if (ready?.ready) {
          connection = candidate;
          nativeIdentity = owner;
          break;
        }
        candidate.close();
      }
    }
    if (connection) break;
    if (Date.now() >= readinessDeadline) throw fail("desktop_bridge_not_ready");
    await sleep(500);
  } while (true);
  if (!runDisposableTest)
    return {
      verified: false,
      readinessVerified: true,
      desktopCdpVerified: false,
      noTestThreadCreated: true,
      runtimeFingerprint: expectedFingerprint,
    };
  // Bounded commands and eight-second native probes can overrun this soft
  // deadline once; the remainder of the minute is reserved for cleanup.
  verificationDeadline = Date.now() + 45_000;
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
      if (fixturePhase === "overload") {
        initialRequests += 1;
        event({
          type: "response.failed",
          response: {
            ...base,
            status: "failed",
            error: {
              code: "overloaded",
              type: "server_error",
              message:
                "Our servers are currently overloaded. Please try again later.",
            },
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
  const created = await connection.evaluate(
    guarded(`
    if(lease) throw new Error('lease_already_exists');
    const declared=(value,name)=>{for(let n=0;value&&n<5;n++,value=Object.getPrototypeOf(value)){const d=Object.getOwnPropertyDescriptor(value,name);if(d)return typeof d.value==='function'?d.value:null;}return null;};
    const client=state.appServerClients.find(item=>Object.getOwnPropertyDescriptor(item,'hostId')?.value==='local'&&declared(item,'__ccSwitchOriginalSendRequest')&&declared(item,'getCompatibleThreadSortKey')&&declared(item,'supportsPaginatedThreadHistory'));
    if(!client)throw new Error('client_missing');
    const request=declared(client,'__ccSwitchOriginalSendRequest').bind(client);
    const result=await request('thread/start',${JSON.stringify({ model, modelProvider: providerId, allowProviderModelFallback: false, cwd: temporary, approvalPolicy: "never", sandbox: "read-only", environments: [], dynamicTools: [], baseInstructions: "Reply only OK. Do not call tools.", developerInstructions: "This is a disposable local protocol test. Do not call tools.", config: { [`model_providers.${providerId}`]: { name: "Local Desktop continuation verification fixture", base_url: localBase, wire_api: "responses", requires_openai_auth: false, request_max_retries: 0, stream_max_retries: 0, stream_idle_timeout_ms: 5000 }, model_reasoning_effort: "low" } })});
    const id=result?.thread?.id;
    if(!id)throw new Error('created_thread_missing');
    window[${JSON.stringify(leaseKey)}]={threadId:id,request,observedAtMs:Date.now(),providerMatches:result.modelProvider===${JSON.stringify(providerId)}&&result.model===${JSON.stringify(model)}};
    return {threadId:id,providerMatches:window[${JSON.stringify(leaseKey)}].providerMatches};
  `),
  );
  threadId = created?.threadId;
  if (!threadId || created.providerMatches !== true)
    throw fail("local_fixture_provider_not_confirmed");
  stage = "initial_overload";
  const initialTurn = await connection.evaluate(
    guarded(`
    if(!lease?.providerMatches||lease.threadId!==${JSON.stringify(threadId)})throw new Error('wrong_test_thread');
    lease.observedAtMs=Date.now();
    const result=await lease.request('turn/start',{threadId:lease.threadId,input:[{type:'text',text:'Reply with OK. Do not call tools.'}]});
    return {turnId:result?.turn?.id};
  `),
  );
  assert.ok(typeof initialTurn?.turnId === "string" && initialTurn.turnId);
  ownedTurnIds.push(initialTurn.turnId);
  const failed = await waitUntil(async () => {
    const current = await connection.evaluate(threadProjection());
    if (current.turnId && current.turnId !== initialTurn.turnId)
      throw fail("unexpected_test_thread_turn");
    return current.status === "failed" ? current : null;
  });
  assert.equal(initialRequests, 1);
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
  stage = "production_commit";
  checkNativeIdentity();
  await checkBinary();
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
    scope: "actual_codex_desktop_cdp_existing_production_runtime",
    desktopCdpVerified: true,
    runtimeFingerprint: expectedFingerprint,
    ccswitchBinarySha256: binarySha256,
    nativeOwnerVerified: true,
    nativeOwnerPids: nativeIdentity.map((owner) => owner.pid),
    temporaryDurableTestThread: true,
    perThreadLocalFixtureProviderConfirmed: true,
    sseOverloadFailedTurnObserved: true,
    productionGuardsPrepared: true,
    appServerAcceptedContinue: true,
    upstreamReceivedLiteralContinue: true,
    continuedTurnCompleted: true,
    exactlyOneContinuation: true,
    existingThreadsTouched: false,
    initialRequests,
    continuedRequests,
  };
};

let evidence;
try {
  evidence = await run();
} catch (error) {
  const code = String(error?.message || "");
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
    "local_fixture_provider_not_confirmed",
    "output_exists",
    "unexpected_test_thread_turn",
  ]);
  evidence = {
    verified: false,
    desktopCdpVerified: false,
    stage,
    failure: finiteCodes.has(code) ? code : "verification_assertion_failed",
    temporaryDurableTestThread: Boolean(threadId),
    existingThreadsTouched: false,
  };
  process.exitCode = 1;
} finally {
  // Cleanup is restricted to our lease and its newly-created thread. A loaded
  // or uncertain active turn is never interrupted or archived here.
  if (connection && runDisposableTest) {
    try {
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
  connection?.close();
  fixture?.closeAllConnections();
  if (fixture?.listening)
    await new Promise((resolve) => fixture.close(resolve));
  if (temporary) {
    assert.ok(
      temporary.startsWith(temporaryPrefix) && temporary !== os.tmpdir(),
    );
    await rm(temporary, {
      recursive: true,
      force: true,
      maxRetries: 2,
      retryDelay: 100,
    });
  }
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
