import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// This verifies the installed app-server protocol with the production recovery
// program. Its client shim cannot establish Desktop renderer/CDP readiness.
const args = process.argv.slice(2);
assert.equal(
  args.length,
  2,
  "Use --executable <absolute installed codex path>",
);
assert.equal(
  args[0],
  "--executable",
  "Use --executable <installed codex path>",
);
assert.ok(path.isAbsolute(args[1]), "The executable path must be absolute");
const executable = await realpath(args[1]);
assert.match(path.basename(executable), /^codex(?:\.exe)?$/i);
const executableSha256 = createHash("sha256")
  .update(await readFile(executable))
  .digest("hex");
const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const temporaryPrefix = path.join(
  os.tmpdir(),
  "ccswitch-continuation-verifier-",
);
const temporary = await mkdtemp(temporaryPrefix);
const pending = new Map();
const notifications = [];
const storage = new Map();
let child;
let lines;
let nextId = 1;
let isolatedThreadId;
let turnStartCalls = 0;
let scenario = "http_overload";
let stage = "setup";
let phase = "initial";
let initialRequests = 0;
let continuedRequests = 0;
let receivedContinue = false;
let fixtureError = false;
let deadlineTimer;
let shuttingDown = false;

const fail = (code) => new Error(code);
const terminalTurns = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitUntil = async (predicate, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await sleep(20);
  }
  throw fail("verification_wait_deadline");
};
const inputContainsContinue = (body) => {
  const userInputs = Array.isArray(body.input)
    ? body.input.filter((item) => item.role === "user")
    : [];
  const latest = userInputs.at(-1);
  return (
    latest?.content === "continue" ||
    (Array.isArray(latest?.content) &&
      latest.content.some((item) => item.text === "continue"))
  );
};
const sendCompletedResponse = (response) => {
  const id = `resp_ccswitch_fixture_${continuedRequests}`;
  const item = {
    id: `msg_ccswitch_fixture_${continuedRequests}`,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "OK", annotations: [] }],
  };
  const complete = {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: "fixture-model",
    output: [item],
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
  const events = [
    {
      type: "response.created",
      response: { ...complete, status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: "OK",
    },
    {
      type: "response.output_text.done",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      text: "OK",
    },
    {
      type: "response.content_part.done",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: item.content[0],
    },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: complete },
  ];
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of events)
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
};
const server = createServer(async (request, response) => {
  try {
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 512 * 1024) throw fail("fixture_request_too_large");
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (phase === "initial") {
      initialRequests += 1;
      const error =
        scenario === "daily_quota"
          ? {
              message: "The daily quota was exhausted.",
              type: "insufficient_quota",
              code: "daily_limit",
            }
          : {
              message:
                "Our servers are currently overloaded. Please try again later.",
              type: "server_error",
              code: "overloaded",
            };
      if (scenario === "http_overload" || scenario === "daily_quota") {
        response.writeHead(scenario === "daily_quota" ? 429 : 503, {
          "content-type": "application/json",
        });
        response.end(JSON.stringify({ error }));
      } else {
        response.writeHead(200, { "content-type": "text/event-stream" });
        const created = {
          type: "response.created",
          response: {
            id: "resp_fixture_initial",
            status: "in_progress",
            model: "fixture-model",
            output: [],
          },
        };
        response.write(
          `event: ${created.type}\ndata: ${JSON.stringify(created)}\n\n`,
        );
        if (scenario === "stream_overload") {
          const failed = {
            type: "response.failed",
            response: { ...created.response, status: "failed", error },
          };
          response.write(
            `event: ${failed.type}\ndata: ${JSON.stringify(failed)}\n\n`,
          );
        }
        // A stream without response.completed is an actual protocol-level
        // disconnect, even when its HTTP transport closes without an RST.
        response.end();
      }
      return;
    }
    continuedRequests += 1;
    receivedContinue ||= inputContainsContinue(body);
    sendCompletedResponse(response);
  } catch {
    fixtureError = true;
    response.writeHead(500).end();
  }
});

const request = (method, params) =>
  new Promise((resolve, reject) => {
    if (
      !new Set(["initialize", "thread/start", "thread/read", "turn/start"]).has(
        method,
      )
    ) {
      reject(fail("verification_unexpected_rpc"));
      return;
    }
    if (
      (method === "thread/read" || method === "turn/start") &&
      (!isolatedThreadId || params.threadId !== isolatedThreadId)
    ) {
      reject(fail("verification_wrong_thread"));
      return;
    }
    if (method === "turn/start") turnStartCalls += 1;
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(fail(`rpc_timeout:${method}`));
    }, 10_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });

const verify = async () => {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await writeFile(
    path.join(temporary, "config.toml"),
    `model = "fixture-model"\nmodel_provider = "fixture"\nmodel_reasoning_effort = "low"\napproval_policy = "never"\nsandbox_mode = "read-only"\n[model_providers.fixture]\nname = "Local continuation verification fixture"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\nstream_idle_timeout_ms = 5000\n`,
    "utf8",
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/(?:key|token|secret|password|credential|auth)/i.test(name),
    ),
  );
  env.CODEX_HOME = temporary;
  child = spawn(executable, ["app-server", "--listen", "stdio://"], {
    env,
    cwd: temporary,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const rejectPending = () => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(fail("isolated_app_server_closed"));
    }
    pending.clear();
  };
  child.once("error", rejectPending);
  child.stdin.on("error", () => {});
  child.once("close", () => {
    if (!shuttingDown) rejectPending();
  });
  child.stderr.on("data", () => {});
  lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.method === "turn/completed") {
      terminalTurns.set(message.params?.turn?.id, message.params?.turn);
    }
    // Record only method names. Never persist request bodies or server errors.
    if (typeof message.method === "string") notifications.push(message.method);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    pending.delete(message.id);
    if (message.error) waiter.reject(fail(`rpc_error:${message.error.code}`));
    else waiter.resolve(message.result);
  });
  await request("initialize", {
    clientInfo: {
      name: "ccswitch_continuation_verifier",
      title: "CCSwitch isolated continuation verifier",
      version: "1.0.0",
    },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write(
    `${JSON.stringify({ method: "initialized", params: {} })}\n`,
  );
  const results = [];
  for (scenario of [
    "http_overload",
    "stream_overload",
    "connection_drop",
    "daily_quota",
  ]) {
    stage = "create_isolated_thread";
    phase = "initial";
    initialRequests = 0;
    continuedRequests = 0;
    turnStartCalls = 0;
    receivedContinue = false;
    terminalTurns.clear();
    notifications.length = 0;
    isolatedThreadId = undefined;
    const created = await request("thread/start", {
      model: "fixture-model",
      modelProvider: "fixture",
      cwd: temporary,
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    const threadId = created?.thread?.id;
    assert.ok(
      threadId,
      "The installed app-server must create the isolated thread",
    );
    isolatedThreadId = threadId;
    stage = "fail_initial_turn";
    const observation = Date.now();
    const first = await request("turn/start", {
      threadId,
      input: [{ type: "text", text: "Reply with OK. Do not call tools." }],
    });
    assert.ok(first?.turn?.id, "The initial turn must be acknowledged");
    const failed = await waitUntil(() => terminalTurns.get(first.turn.id));
    assert.equal(
      failed.status,
      "failed",
      "The local overload must terminate the first turn",
    );
    assert.ok(
      initialRequests > 0,
      "The failure must come from the local upstream fixture",
    );
    stage = "production_preparation";

    const [discovery, core, policy] = await Promise.all([
      readFile(
        path.join(
          repository,
          "src-tauri/src/resources/codex_desktop/client_discovery.js",
        ),
        "utf8",
      ),
      readFile(
        path.join(
          repository,
          "src-tauri/src/resources/codex_desktop/continuation.js",
        ),
        "utf8",
      ),
      readFile(
        path.join(
          repository,
          "src-tauri/src/proxy/providers/terminal_error_policy.json",
        ),
        "utf8",
      ),
    ]);
    const state = {
      appServerClients: [
        {
          hostId: "local",
          getCompatibleThreadSortKey() {},
          supportsPaginatedThreadHistory() {},
          sendRequest: request,
        },
      ],
    };
    const context = vm.createContext({
      state,
      localStorage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
      },
      installAppServerPatch: async () => {},
      recordFailure: () => {},
      installationIsCurrent: () => true,
      setTimeout,
      clearTimeout,
    });
    new vm.Script(
      `${discovery}\n${core.replace("__CCSWITCH_TERMINAL_ERROR_POLICY__", policy)}`,
      { filename: "production-codex-continuation.js" },
    ).runInContext(context);
    const recoveryId = `isolated-installed-app-server-${scenario}`;
    assert.equal(
      state.startCodexContinuation(
        threadId,
        recoveryId,
        "fixture-model",
        observation,
      ).started,
      true,
    );
    const prepared = await waitUntil(() => {
      const job = state.readCodexContinuationJob(recoveryId);
      return job?.status !== "pending" ? job : null;
    });
    if (scenario === "daily_quota") {
      assert.equal(prepared.status, "completed");
      assert.equal(prepared.submitted, false);
      assert.equal(prepared.mutationAttempted, false);
      assert.equal(
        prepared.reason,
        "The latest Codex turn needs a user action",
      );
      assert.equal(state.commitCodexContinuation(recoveryId).started, false);
      assert.equal(
        turnStartCalls,
        1,
        "A quota failure must never submit continue",
      );
      assert.equal(continuedRequests, 0);
      assert.equal(terminalTurns.size, 1);
      const final = await request("thread/read", {
        threadId,
        includeTurns: true,
      });
      assert.equal(final.thread.turns.length, 1);
      assert.equal(fixtureError, false);
      results.push({
        scenario,
        initialRequests,
        appServerAcceptedContinue: false,
        blockedByProductionQuotaGuard: true,
        noContinuationSubmitted: turnStartCalls === 1,
        continuedRequests,
      });
      continue;
    }
    assert.equal(
      prepared.status,
      "prepared",
      "The production guard must prepare the real failed turn",
    );
    phase = "continued";
    stage = "production_commit";
    assert.equal(state.commitCodexContinuation(recoveryId).started, true);
    const submitted = await waitUntil(() => {
      const job = state.readCodexContinuationJob(recoveryId);
      return job?.status === "completed" ? job : null;
    });
    assert.equal(
      submitted.submitted,
      true,
      "The installed app-server must acknowledge continue",
    );
    assert.equal(submitted.mutationAttempted, true);
    stage = "complete_continued_turn";
    const complete = await waitUntil(() =>
      [...terminalTurns.values()].find((turn) => turn.id !== failed.id),
    );
    assert.equal(
      complete.status,
      "completed",
      "The continued turn must complete against the local fixture",
    );
    assert.equal(
      receivedContinue,
      true,
      "The actual upstream request must contain literal continue",
    );
    assert.equal(fixtureError, false);
    assert.equal(
      terminalTurns.size,
      2,
      "The failed turn must produce exactly one continuation",
    );
    const final = await request("thread/read", {
      threadId,
      includeTurns: true,
    });
    assert.equal(final.thread.id, threadId);
    assert.equal(final.thread.turns.at(-1).id, complete.id);
    assert.equal(final.thread.turns.at(-1).status, "completed");
    stage = "duplicate_guard";
    state.startCodexContinuation(
      threadId,
      recoveryId,
      "fixture-model",
      observation,
    );
    state.commitCodexContinuation(recoveryId);
    assert.equal(state.readCodexContinuationJob(recoveryId).submitted, true);
    assert.equal(
      turnStartCalls,
      2,
      "A repeated recovery token must not start another turn",
    );
    results.push({
      scenario,
      fixture:
        scenario === "connection_drop"
          ? "sse_closed_before_response_completed"
          : scenario === "stream_overload"
            ? "sse_response_failed_with_overload_message"
            : "http_503_overload",
      productionCoreSha256: createHash("sha256")
        .update(core)
        .update(policy)
        .digest("hex"),
      failedTurnObserved: failed.status === "failed",
      preparedByProductionGuards: true,
      appServerAcceptedContinue: true,
      upstreamReceivedLiteralContinue: receivedContinue,
      continuedTurnCompleted: complete.status === "completed",
      exactlyOneContinuation: terminalTurns.size === 2,
      duplicateRecoveryTokenDidNotReplay: turnStartCalls === 2,
      initialRequests,
      continuedRequests,
      turnCompletedNotifications: notifications.filter(
        (method) => method === "turn/completed",
      ).length,
    });
  }
  return {
    verifiedAtUtc: new Date().toISOString(),
    scope:
      "installed_app_server_with_production_continuation_core_and_client_shim",
    desktopCdpVerified: false,
    isolatedConfiguration: true,
    localFixtureOnly: true,
    executableSha256,
    scenarios: results,
  };
};

try {
  const evidence = await Promise.race([
    verify(),
    new Promise((_, reject) => {
      deadlineTimer = setTimeout(
        () => reject(fail("verification_global_deadline")),
        // Leave five seconds inside the one-minute run budget for killing
        // our owned child and removing our exact temporary directory.
        55_000,
      );
    }),
  ]);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
} catch (error) {
  // Assertion/error text from the fixture is finite; avoid exposing arbitrary
  // app-server diagnostics, persisted prompts, paths, or credentials.
  const code = String(error?.message || "verification_failed");
  const allowed =
    /^(?:rpc_(?:timeout:[a-z/]+|error:-?\d+)|isolated_app_server_closed|verification_[a-z_]+)$/;
  process.stderr.write(
    `${JSON.stringify({ verified: false, scenario, stage, failure: allowed.test(code) ? code : "verification_assertion_failed", desktopCdpVerified: false })}\n`,
  );
  process.exitCode = 1;
} finally {
  clearTimeout(deadlineTimer);
  shuttingDown = true;
  lines?.close();
  for (const waiter of pending.values()) clearTimeout(waiter.timer);
  pending.clear();
  if (child && child.exitCode === null) {
    child.stdin.end();
    child.kill();
    await Promise.race([
      new Promise((resolve) => child.once("close", resolve)),
      sleep(2000),
    ]);
  }
  server.closeAllConnections();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  assert.ok(temporary.startsWith(temporaryPrefix) && temporary !== os.tmpdir());
  await rm(temporary, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 200,
  });
}
