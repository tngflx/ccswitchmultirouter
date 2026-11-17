import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import * as browserAuditModule from "./owner-remote-browser-audit.mjs";
import {
  browserAuditRoute,
  browserAuditOperationAllowed,
  canonicalBrowserReceipt,
  publishBrowserAuditFile,
  readBrowserAuditFile,
  validateBrowserReady,
} from "./owner-remote-browser-audit.mjs";
const thread = "owned-fixture-thread";
const nonce = "a".repeat(64);
const operation = "owner-" + "b".repeat(32);
const initial = "initial-turn";

test("browser proxy is host-only, exact-thread, endpoint bounded and denies history enumeration", () => {
  assert.equal(browserAuditRoute("GET", "/remote/", thread), "asset");
  assert.equal(
    browserAuditRoute("GET", `/remote/api/v1/view?threadId=${thread}`, thread),
    "read",
  );
  assert.equal(
    browserAuditRoute("GET", "/remote/api/v1/conversations", thread),
    "deny_history",
  );
  assert.equal(
    browserAuditRoute("POST", "/remote/api/v1/continue", thread),
    "continue",
  );
  assert.equal(
    browserAuditRoute("GET", `/remote/api/v1/operations/${operation}`, thread),
    "read",
  );
  for (const [method, url] of [
    ["GET", "http://owner.example.test/remote/"],
    ["GET", "https://other.example.test/remote/"],
    ["GET", "//other.example.test/remote/"],
    ["GET", "/remote/api/v1/view?threadId=unowned"],
    ["GET", `/remote/api/v1/view?threadId=${thread}&threadId=${thread}`],
    ["POST", `/remote/api/v1/view?threadId=${thread}`],
    ["POST", "/remote/api/v1/devices"],
    ["GET", "/rpc"],
    ["GET", "/json"],
    ["POST", "/remote/api/v1/continue?unbounded=1"],
  ])
    assert.equal(browserAuditRoute(method, url, thread), "deny", url);
});

test("browser canonical receipts grant exact positive ACK only and reject malformed reflected fields", () => {
  const submitted = {
    operationId: operation,
    status: "submitted",
    submitted: true,
    mutationAttempted: true,
    acknowledgedTurnId: "exact-new-turn",
  };
  assert.equal(canonicalBrowserReceipt(submitted, operation, initial), true);
  assert.equal(
    canonicalBrowserReceipt(
      {
        operationId: operation,
        status: "refused",
        submitted: false,
        mutationAttempted: false,
      },
      operation,
      initial,
    ),
    true,
  );
  for (const receipt of [
    { ...submitted, operationId: "owner-" + "c".repeat(32) },
    { ...submitted, acknowledgedTurnId: initial },
    { ...submitted, acknowledgedTurnId: "bad id" },
    { ...submitted, mutationAttempted: false },
    { ...submitted, submitted: false },
    { ...submitted, status: "completed" },
    { ...submitted, transcript: "redacted-private" },
    {
      ...submitted,
      status: "refused",
      submitted: false,
      mutationAttempted: false,
    },
  ])
    assert.equal(canonicalBrowserReceipt(receipt, operation, initial), false);
  let getters = 0;
  const malicious = {};
  Object.defineProperty(malicious, "status", {
    get() {
      getters += 1;
      throw new Error("redacted-private");
    },
  });
  assert.equal(canonicalBrowserReceipt(malicious, operation, initial), false);
  assert.equal(getters, 0);
});

test("browser private handoff is bounded, nonce-bound and atomically exclusive", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "browser-audit-ipc-test-"),
  );
  try {
    const ready = {
      schemaVersion: 1,
      auditNonce: nonce,
      invitationSecret: "redacted_test_invitation_123456",
    };
    await publishBrowserAuditFile(directory, "browser-ready.json", ready);
    await assert.rejects(
      publishBrowserAuditFile(directory, "browser-ready.json", {
        replaced: true,
      }),
      /browser_audit_handoff_failed/,
    );
    assert.deepEqual(
      await readBrowserAuditFile(directory, "browser-ready.json"),
      ready,
    );
    assert.equal(validateBrowserReady(ready, nonce), ready.invitationSecret);
    assert.throws(
      () =>
        validateBrowserReady({ ...ready, auditNonce: "b".repeat(64) }, nonce),
      /browser_audit_handoff_invalid/,
    );
    assert.throws(
      () =>
        validateBrowserReady({ ...ready, cookie: "redacted-private" }, nonce),
      /browser_audit_handoff_invalid/,
    );
    assert.deepEqual(await readdir(directory), ["browser-ready.json"]);
    await writeFile(
      path.join(directory, "browser-ready.json"),
      " ".repeat(16 * 1024 + 1),
    );
    await assert.rejects(
      readBrowserAuditFile(directory, "browser-ready.json"),
      /browser_audit_handoff_invalid/,
    );
    await assert.rejects(
      publishBrowserAuditFile(directory, "arbitrary.json", {}),
      /browser_audit_handoff_invalid/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("actual browser audit uses fresh owned Edge, pinned ephemeral TLS and real form ceremonies with one UI sender", async () => {
  const source = await readFile(
    new URL("./owner-remote-browser-audit.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /launchPersistentContext/);
  assert.match(source, /path\.join\(directory, "browser-profile"\)/);
  assert.match(source, /WebAuthn\.addVirtualAuthenticator/);
  assert.match(source, /--ignore-certificate-errors-spki-list=/);
  assert.equal(source.includes('"--ignore-certificate-errors"'), false);
  assert.doesNotMatch(
    source,
    /connectOverCDP|addCookies|storageState|console\.log|process\.stdout/,
  );
  assert.match(source, /#enroll/);
  assert.match(source, /#sign-in/);
  assert.equal(
    (source.match(/locator\("#continue"\)\s*\.click/g) || []).length,
    1,
  );
  assert.match(source, /page\.waitForResponse/);
  assert.match(source, /continueRequests !== 1/);
  assert.match(source, /cookies\[0\]\.httpOnly !== true/);
  assert.match(source, /cookies\[0\]\.secure !== true/);
  assert.match(source, /cookies\[0\]\.sameSite !== "Strict"/);
  assert.match(source, /await browser\.close\(\)/);
  assert.match(
    source,
    /if \(evidence\.passed \|\| evidence\.canonicalRefusalVerified\) await finish\(\)/,
  );
});

test("browser ledger proxy allows only the captured UI operation, never before capture or another operation", () => {
  const target = `/remote/api/v1/operations/${operation}`;
  assert.equal(browserAuditOperationAllowed(target, undefined), false);
  assert.equal(
    browserAuditOperationAllowed(target, "owner-" + "c".repeat(32)),
    false,
  );
  assert.equal(browserAuditOperationAllowed(target, operation), true);
  assert.equal(
    browserAuditOperationAllowed(target + "?other=1", operation),
    false,
  );
});

test("ancillary browser-session requests pin the owned certificate and never globally disable TLS", async () => {
  const source = await readFile(
    new URL("./owner-remote-browser-audit.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /ca: cert/);
  assert.match(source, /rejectUnauthorized: true/);
  assert.match(source, /servername: HOST/);
  assert.doesNotMatch(
    source,
    /ignoreHTTPSErrors\s*:\s*true|NODE_TLS_REJECT_UNAUTHORIZED|rejectUnauthorized\s*:\s*false/,
  );
  assert.match(source, /context\.cookies\(\[origin\]\)/);
  assert.match(
    source,
    /!browserAuditOperationAllowed\(request\.url, operationId\)/,
  );
});

test("public browser diagnostics are a finite own-data-only whitelist, not reflected browser data", () => {
  const project = browserAuditModule.projectOwnerRemoteBrowserAuditDiagnostics;
  assert.equal(typeof project, "function");
  let getterCalls = 0;
  const input = Object.assign(
    Object.create({ cookieAttributesVerified: true }),
    {
      virtualPasskeyEnrollmentVerified: true,
      preparePhase: "continue_ready_wait",
      prepareFailure: "timeout",
      prepareGuard: null,
      viewRequestCount: 1,
      viewResponseCount: 1,
      viewCaptureStartedCount: 1,
      viewCaptureCompletedCount: 1,
      viewCaptureState: "complete",
      lastViewHttpStatus: 409,
      httpStatus: {
        view: { conflict: 1, server_error: 2, cookie: "redacted-private" },
        session: { unauthorized: 1 },
        privateRoute: { success: 1 },
      },
      prepareDom: {
        captured: true,
        documentVisible: true,
        documentFocused: false,
        continueDisabled: true,
        refreshDisabled: false,
        openDisabled: false,
        viewStatus: null,
        viewStatusKey: "status.loading",
        feedbackKey: "message.hostUnavailable",
        actionMessageKey: "message.focusRefresh",
        rawText: "redacted-private",
      },
      lastView: {
        bodyObject: true,
        contentObject: false,
        nativeError: "codex_unavailable",
        viewStatus: null,
        continueBlocker: "unknown",
        turnCount: 0,
        itemCount: 0,
        threadId: "redacted-private",
      },
      url: "redacted-private",
      exception: "redacted-private",
    },
  );
  Object.defineProperty(input, "realConsoleAssetsVerified", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error("redacted-private");
    },
  });
  Object.defineProperty(input.prepareDom, "feedback", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error("redacted-private");
    },
  });
  const result = project(input);
  assert.equal(getterCalls, 0);
  assert.deepEqual(result, {
    virtualPasskeyEnrollmentVerified: true,
    preparePhase: "continue_ready_wait",
    prepareFailure: "timeout",
    prepareGuard: null,
    viewRequestCount: 1,
    viewResponseCount: 1,
    viewCaptureStartedCount: 1,
    viewCaptureCompletedCount: 1,
    viewCaptureState: "complete",
    lastViewHttpStatus: 409,
    httpStatus: {
      view: { conflict: 1, server_error: 2 },
      session: { unauthorized: 1 },
    },
    prepareDom: {
      captured: true,
      documentVisible: true,
      documentFocused: false,
      continueDisabled: true,
      refreshDisabled: false,
      openDisabled: false,
      viewStatus: null,
      viewStatusKey: "status.loading",
      feedbackKey: "message.hostUnavailable",
      actionMessageKey: "message.focusRefresh",
    },
    lastView: {
      bodyObject: true,
      contentObject: false,
      nativeError: "codex_unavailable",
      viewStatus: null,
      continueBlocker: "unknown",
      turnCount: 0,
      itemCount: 0,
    },
  });
  assert.equal(JSON.stringify(result).includes("redacted-private"), false);
});

test("browser diagnostics reject invalid enums, unbounded counts, inherited data and accessors", () => {
  const project = browserAuditModule.projectOwnerRemoteBrowserAuditDiagnostics;
  assert.equal(typeof project, "function");
  let getterCalls = 0;
  const invalid = {
    preparePhase: "redacted-private",
    prepareFailure: new Error("redacted-private"),
    prepareGuard: "redacted-private",
    viewRequestCount: Infinity,
    viewResponseCount: -1,
    viewCaptureStartedCount: 1001,
    viewCaptureCompletedCount: 1.5,
    viewCaptureState: "redacted-private",
    lastViewHttpStatus: 600,
    actualRemoteDeviceVerified: "true",
    httpStatus: { view: { conflict: NaN, server_error: 1001 } },
    prepareDom: {
      captured: "true",
      documentVisible: 1,
      documentFocused: null,
      continueDisabled: "false",
      refreshDisabled: [],
      openDisabled: {},
      viewStatus: "redacted-private",
      viewStatusKey: "message.model",
      feedbackKey: "redacted-private",
      actionMessageKey: "redacted-private",
    },
    lastView: {
      nativeError: "redacted-private",
      continueBlocker: "redacted-private",
      viewStatus: "redacted-private",
      latestTurnStatus: "redacted-private",
      turnCount: 121,
      itemCount: -1,
    },
  };
  Object.defineProperty(invalid, "cookieAttributesVerified", {
    get() {
      getterCalls += 1;
      return true;
    },
  });
  assert.deepEqual(project(invalid), {
    httpStatus: { view: {} },
    prepareDom: {},
    lastView: {},
  });
  assert.equal(getterCalls, 0);
  for (const value of [null, undefined, false, [], "redacted-private"])
    assert.deepEqual(project(value), {});
  assert.deepEqual(project(Object.create({ preparePhase: "completed" })), {});
});

test("view diagnostics expose bounded binding proofs and native enums, never IDs or transcript", () => {
  const project = browserAuditModule.projectOwnerRemoteBrowserViewDiagnostics;
  assert.equal(typeof project, "function");
  const value = {
    canContinue: true,
    viewId: "private-view-binding",
    expiresInSeconds: 30,
    content: {
      threadId: thread,
      latestTurnId: initial,
      model: "fixture-model",
      status: "error",
      continueBlocker: null,
      truncated: false,
      turns: [
        {
          id: initial,
          status: "failed",
          items: [{ text: "redacted-private" }],
        },
      ],
    },
  };
  const result = project(value, {
    threadId: thread,
    initialTurnId: initial,
    model: "fixture-model",
  });
  assert.deepEqual(result, {
    bodyObject: true,
    contentObject: true,
    turnsArray: true,
    itemArraysValid: true,
    viewIdValid: true,
    expiryValid: true,
    threadMatches: true,
    latestTurnMatches: true,
    modelMatches: true,
    canContinue: true,
    truncated: false,
    viewStatus: "error",
    latestTurnStatus: "failed",
    continueBlocker: null,
    nativeError: null,
    turnCount: 1,
    itemCount: 1,
    turnLimitExceeded: false,
    itemLimitExceeded: false,
  });
  assert.equal(JSON.stringify(result).includes("redacted-private"), false);
  assert.equal(JSON.stringify(result).includes(thread), false);
  const error = project(
    { error: "codex_unavailable", detail: "redacted-private" },
    {},
  );
  assert.equal(error.nativeError, "codex_unavailable");
  assert.equal(error.contentObject, false);
  assert.equal(
    project({ error: "redacted-private" }, {}).nativeError,
    "unknown",
  );
  let getterCalls = 0;
  const hostile = {};
  Object.defineProperty(hostile, "content", {
    get() {
      getterCalls += 1;
      return value.content;
    },
  });
  assert.equal(project(hostile, {}).contentObject, false);
  assert.equal(getterCalls, 0);
});

test("prepare diagnostics retain first-request, HTTP, response capture and real visible/focused UI gates", async () => {
  const source = await readFile(
    new URL("./owner-remote-browser-audit.mjs", import.meta.url),
    "utf8",
  );
  for (const required of [
    "viewRequestCount",
    "viewResponseCount",
    "viewCaptureStartedCount",
    "viewCaptureCompletedCount",
    "lastViewHttpStatus",
    "preparePhase",
    "prepareFailure",
    "prepareGuard",
    "document.visibilityState",
    "document.hasFocus()",
    '"refresh"',
    '"open-thread"',
    "projectOwnerRemoteBrowserViewDiagnostics",
  ])
    assert.ok(source.includes(required), required);
  assert.match(source, /catch \(error\) \{[\s\S]*prepareFailure/);
  assert.doesNotMatch(
    source,
    /diagnostics\.[A-Za-z]+\s*=\s*error(?:\.message|\.stack|\b)/,
  );
  assert.doesNotMatch(
    source,
    /Object\.defineProperty\(document|prototype\.hasFocus|options\.isActive|mountOwnerRemoteConsole/,
  );
});

test("proxy captures bounded native view error independently of browser body and preserves forwarding", async () => {
  const capture = browserAuditModule.captureOwnerRemoteBrowserViewResponse;
  assert.equal(typeof capture, "function");
  const incoming = new PassThrough(),
    forwarded = new PassThrough();
  const chunks = [];
  let result;
  forwarded.on("data", (chunk) => chunks.push(chunk));
  capture(incoming, {}, (value) => {
    result = value;
  });
  incoming.pipe(forwarded);
  const done = once(forwarded, "end");
  const body = Buffer.from(
    JSON.stringify({ error: "codex_unavailable", detail: "redacted-private" }),
  );
  incoming.write(body.subarray(0, 11));
  incoming.end(body.subarray(11));
  await done;
  assert.deepEqual(Buffer.concat(chunks), body);
  assert.equal(result.state, "complete");
  assert.equal(result.lastView.nativeError, "codex_unavailable");
  assert.equal(result.lastView.contentObject, false);
  assert.equal(JSON.stringify(result).includes("redacted-private"), false);
  assert.equal(
    browserAuditModule.projectOwnerRemoteBrowserAuditDiagnostics({
      proxyViewCaptureState: result.state,
    }).proxyViewCaptureState,
    "complete",
  );
});

test("proxy view capture drops over16KiB and malformed input without changing the forwarded stream", async () => {
  const capture = browserAuditModule.captureOwnerRemoteBrowserViewResponse;
  assert.equal(typeof capture, "function");
  for (const [body, expected] of [
    [Buffer.alloc(16 * 1024 + 1, 32), "oversized"],
    [Buffer.from("redacted-private-not-json"), "failed"],
  ]) {
    const incoming = new PassThrough(),
      forwarded = new PassThrough();
    const chunks = [];
    let result;
    forwarded.on("data", (chunk) => chunks.push(chunk));
    capture(incoming, {}, (value) => {
      result = value;
    });
    incoming.pipe(forwarded);
    const done = once(forwarded, "end");
    incoming.write(body.subarray(0, 16 * 1024));
    incoming.end(body.subarray(16 * 1024));
    await done;
    assert.deepEqual(Buffer.concat(chunks), body);
    assert.deepEqual(result, { state: expected });
    assert.equal(JSON.stringify(result).includes("redacted-private"), false);
  }
});

test("browser native trace stays null and view-drain diagnostics are finite snapshots before shutdown", async () => {
  const source = await readFile(
    new URL("./owner-remote-browser-audit.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /nativeTrace: null/);
  const project = browserAuditModule.projectOwnerRemoteBrowserAuditDiagnostics;
  const valid = {
    firstViewStartedMs: 1,
    firstViewResponseMs: 20001,
    lastViewEndMs: 20005,
    finishRequestedMs: null,
    viewResponseAfterFinish: false,
    readOnlyViewDrain: "completed",
    preFinishViewCaptureState: "complete",
    preFinishView: {
      nativeError: "owner_unauthorized",
      contentObject: false,
      redacted: "redacted-private",
    },
  };
  assert.deepEqual(project(valid), {
    ...valid,
    preFinishView: { contentObject: false, nativeError: "owner_unauthorized" },
  });
  const rejected = project({
    firstViewStartedMs: -1,
    firstViewResponseMs: 120001,
    lastViewEndMs: 1.5,
    finishRequestedMs: "redacted-private",
    viewResponseAfterFinish: "yes",
    readOnlyViewDrain: "redacted-private",
    preFinishViewCaptureState: "redacted-private",
  });
  assert.deepEqual(rejected, {});
});

test("failed browser prepare drains only existing view responses before marking finish and never reopens upstream reads", async () => {
  assert.equal(
    typeof browserAuditModule.createOwnerRemoteBrowserViewDrain,
    "function",
  );
  let clock = 0;
  const diagnostics = {
    proxyViewCaptureState: "awaiting_body",
    lastView: { nativeError: "owner_unauthorized" },
  };
  const tracker = browserAuditModule.createOwnerRemoteBrowserViewDrain(
    diagnostics,
    { now: () => clock, startedAt: 0 },
  );
  const view = tracker.begin();
  clock = 20000;
  const drained = tracker.drainExisting();
  assert.equal(tracker.canStart(), false);
  assert.equal(tracker.begin(), null);
  clock = 21000;
  view.headers();
  diagnostics.proxyViewCaptureState = "complete";
  clock = 21001;
  view.end();
  await drained;
  assert.equal(diagnostics.readOnlyViewDrain, "completed");
  assert.equal(diagnostics.firstViewStartedMs, 0);
  assert.equal(diagnostics.firstViewResponseMs, 21000);
  assert.equal(diagnostics.lastViewEndMs, 21001);
  assert.equal(diagnostics.finishRequestedMs, null);
  assert.equal(diagnostics.viewResponseAfterFinish, false);
  assert.deepEqual(diagnostics.preFinishView, {
    nativeError: "owner_unauthorized",
  });
  clock = 21002;
  tracker.markFinishRequested();
  assert.equal(diagnostics.finishRequestedMs, 21002);
  diagnostics.lastView.nativeError = "codex_unavailable";
  assert.equal(diagnostics.preFinishView.nativeError, "owner_unauthorized");
});

test("browser read-only drain is bounded by the existing fixture lifetime and late headers stay after-finish evidence", async () => {
  assert.equal(
    typeof browserAuditModule.createOwnerRemoteBrowserViewDrain,
    "function",
  );
  let clock = 119999;
  const diagnostics = { proxyViewCaptureState: "awaiting_body" };
  const tracker = browserAuditModule.createOwnerRemoteBrowserViewDrain(
    diagnostics,
    { now: () => clock, startedAt: 0 },
  );
  const view = tracker.begin();
  await tracker.drainExisting();
  assert.equal(diagnostics.readOnlyViewDrain, "timed_out");
  clock = 120000;
  tracker.markFinishRequested();
  clock = 120001;
  view.headers();
  view.end();
  assert.equal(diagnostics.viewResponseAfterFinish, true);
  assert.equal(diagnostics.firstViewResponseMs, 120000);
  assert.equal(diagnostics.lastViewEndMs, 120000);
  assert.equal(diagnostics.preFinishViewCaptureState, "awaiting_body");
});

test("a view sealed while its request body is read cannot open upstream or overwrite native response bins", async () => {
  const source = await readFile(
    new URL("./owner-remote-browser-audit.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /if \(auditViewReadRefused\) return/);
  assert.match(
    source,
    /const viewObservation = isView \? viewDrain\.begin\(\) : null;\s*if \(isView && !viewObservation\) \{\s*auditViewReadRefused = true;/,
  );
  const observation = source.indexOf(
    "const viewObservation = isView ? viewDrain.begin() : null;",
  );
  const upstream = source.indexOf("const upstream = httpRequest(", observation);
  assert.ok(observation >= 0 && upstream > observation);
  assert.match(source.slice(observation, upstream), /return;/);
});
