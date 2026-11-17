import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { execFile } from "node:child_process";
import {
  createServer as createHttpsServer,
  request as httpsRequest,
} from "node:https";
import { request as httpRequest } from "node:http";
import { link, lstat, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const LIMIT = 16 * 1024;
const RESPONSE_LIMIT = 256 * 1024;
const HOST = "owner.example.test";
const NATIVE = "127.0.0.1";
const NATIVE_PORT = 15723;
const fail = (code) => new Error(code);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const safeId = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value);
const safeOperation = (value) =>
  typeof value === "string" && /^owner-[a-f0-9]{32}$/.test(value);
const files = new Set([
  "browser-config.json",
  "browser-ready.json",
  "browser-done.json",
  "browser-result.json",
  "result.json",
]);

const PREPARE_PHASES = [
  "not_started",
  "import_browser",
  "profile_guard",
  "launch_browser",
  "prepare_page",
  "restrict_network",
  "configure_webauthn",
  "navigate",
  "enroll_label",
  "enroll_submit",
  "enroll_workspace",
  "enrollment_guard",
  "cookie_guard",
  "csrf_guard",
  "origin_guard",
  "logout_submit",
  "logout_panel",
  "logout_guard",
  "login_submit",
  "login_workspace",
  "login_guard",
  "thread_fill",
  "thread_open",
  "continue_ready_wait",
  "bound_view_guard",
  "content_guard",
  "assets_guard",
  "secure_context",
  "completed",
];
const PREPARE_GUARDS = [
  null,
  "profile_exists",
  "enrollment_count",
  "cookie_attributes",
  "csrf_response",
  "origin_response",
  "logout_response",
  "login_assertion",
  "bound_view",
  "view_items",
  "console_assets",
  "secure_context",
];
const VIEW_STATUSES = [null, "idle", "active", "waiting", "error", "unknown"];
const TURN_STATUSES = [
  null,
  "completed",
  "failed",
  "interrupted",
  "inProgress",
  "unknown",
];
const BLOCKERS = [
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
];
const NATIVE_ERRORS = [
  null,
  "owner_unauthorized",
  "invalid_thread",
  "owner_platform_unavailable",
  "codex_unavailable",
  "codex_target_ambiguous",
  "view_stale",
  "content_unavailable",
  "operation_unavailable",
  "invalid_request",
  "owner_remote_unavailable",
  "authentication_required",
  "rate_limited",
  "view_unavailable",
  "request_body_timeout",
  "unknown",
];
const UI_STATUSES = [
  "idle",
  "active",
  "waiting",
  "error",
  "unknown",
  "stale",
  "completed",
  "failed",
  "interrupted",
  "inProgress",
  "declined",
  "loading",
];
const UI_STATUS_KEYS = [
  "page.notLoaded",
  ...UI_STATUSES.map((key) => `status.${key}`),
];
const UI_FEEDBACK_KEYS = [
  "sessionExpired",
  "hostUnavailable",
  "rateLimited",
  "enrollFailed",
  "managementFailed",
  "loginFailed",
  "chooseExact",
  "invitationReceived",
  "signedOut",
  "signOutUncertain",
  "authLossAfterContinue",
  "localizationUnavailable",
].map((key) => `message.${key}`);
const UI_ACTION_KEYS = [
  ...[
    "viewExpired",
    "acceptedIdle",
    "readOnly",
    "notIdle",
    "bindingUnavailable",
    "idleReady",
    "errorReady",
    "refreshFailed",
    "focusRefresh",
    "secureIdentityUnavailable",
  ].map((key) => `message.${key}`),
  ...["pending", "submitted", "uncertain", "refused", "completed"].map(
    (key) => `operation.${key}`,
  ),
];
const HTTP_ROUTES = [
  "asset",
  "session",
  "auth",
  "devices",
  "view",
  "operation",
  "continue",
  "history",
];
const HTTP_BINS = [
  "success",
  "unauthorized",
  "forbidden",
  "conflict",
  "client_error",
  "server_error",
  "other",
];
const DIAGNOSTIC_BOOLS = [
  "headlessBrowserVerified",
  "realConsoleAssetsVerified",
  "virtualPasskeyEnrollmentVerified",
  "virtualPasskeyLoginVerified",
  "httpsBrowserOriginVerified",
  "certificateTrustInstalled",
  "userBrowserProfileUsed",
  "historyEnumerationBlocked",
  "browserSingleUiSubmissionVerified",
  "browserOperationReceiptVerified",
  "cookieAttributesVerified",
  "actualRemoteDeviceVerified",
];
const VIEW_BOOLS = [
  "bodyObject",
  "contentObject",
  "turnsArray",
  "itemArraysValid",
  "viewIdValid",
  "expiryValid",
  "threadMatches",
  "latestTurnMatches",
  "modelMatches",
  "canContinue",
  "truncated",
  "turnLimitExceeded",
  "itemLimitExceeded",
];
const ownData = (value) => {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const result = Object.create(null);
    for (const [key, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(value),
    ))
      if (Object.hasOwn(descriptor, "value")) result[key] = descriptor.value;
    return result;
  } catch {
    return {};
  }
};
const finiteProjection = (value, booleans, enums = {}, integers = {}) => {
  const input = ownData(value),
    output = {};
  for (const key of booleans)
    if (typeof input[key] === "boolean") output[key] = input[key];
  for (const [key, allowed] of Object.entries(enums))
    if (Object.hasOwn(input, key) && allowed.includes(input[key]))
      output[key] = input[key];
  for (const [key, [minimum, maximum]] of Object.entries(integers))
    if (
      Number.isInteger(input[key]) &&
      input[key] >= minimum &&
      input[key] <= maximum
    )
      output[key] = input[key];
  return output;
};
const viewEnums = {
  viewStatus: VIEW_STATUSES,
  latestTurnStatus: TURN_STATUSES,
  continueBlocker: BLOCKERS,
  nativeError: NATIVE_ERRORS,
};
export const projectOwnerRemoteBrowserAuditDiagnostics = (value) => {
  const input = ownData(value);
  const output = finiteProjection(
    input,
    DIAGNOSTIC_BOOLS,
    {
      preparePhase: PREPARE_PHASES,
      prepareFailure: [
        null,
        "guard_rejected",
        "timeout",
        "browser_step_failed",
      ],
      prepareGuard: PREPARE_GUARDS,
      proxyViewCaptureState: [
        "not_requested",
        "awaiting_body",
        "complete",
        "oversized",
        "failed",
      ],
      viewCaptureState: [
        "not_requested",
        "awaiting_headers",
        "awaiting_body",
        "complete",
        "failed",
      ],
    },
    Object.fromEntries(
      [
        "viewRequestCount",
        "viewResponseCount",
        "viewCaptureStartedCount",
        "viewCaptureCompletedCount",
      ].map((key) => [key, [0, 1000]]),
    ),
  );
  for (const key of [
    "firstViewStartedMs",
    "firstViewResponseMs",
    "lastViewEndMs",
    "finishRequestedMs",
  ]) {
    if (input[key] === null && Object.hasOwn(input, key)) output[key] = null;
    else if (
      Number.isInteger(input[key]) &&
      input[key] >= 0 &&
      input[key] <= 120000
    )
      output[key] = input[key];
  }
  if (typeof input.viewResponseAfterFinish === "boolean")
    output.viewResponseAfterFinish = input.viewResponseAfterFinish;
  if (
    ["not_started", "no_inflight", "completed", "timed_out"].includes(
      input.readOnlyViewDrain,
    )
  )
    output.readOnlyViewDrain = input.readOnlyViewDrain;
  if (
    [
      "not_requested",
      "awaiting_body",
      "complete",
      "oversized",
      "failed",
    ].includes(input.preFinishViewCaptureState)
  )
    output.preFinishViewCaptureState = input.preFinishViewCaptureState;
  if (Object.hasOwn(input, "preFinishView"))
    output.preFinishView = finiteProjection(
      input.preFinishView,
      VIEW_BOOLS,
      viewEnums,
      { turnCount: [0, 120], itemCount: [0, 120] },
    );
  if (input.lastViewHttpStatus === null) output.lastViewHttpStatus = null;
  else
    Object.assign(
      output,
      finiteProjection(input, [], {}, { lastViewHttpStatus: [100, 599] }),
    );
  if (Object.hasOwn(input, "httpStatus")) {
    output.httpStatus = {};
    const routes = ownData(input.httpStatus);
    for (const route of HTTP_ROUTES)
      if (Object.hasOwn(routes, route))
        output.httpStatus[route] = finiteProjection(
          routes[route],
          [],
          {},
          Object.fromEntries(HTTP_BINS.map((key) => [key, [0, 1000]])),
        );
  }
  if (Object.hasOwn(input, "prepareDom"))
    output.prepareDom = finiteProjection(
      input.prepareDom,
      [
        "captured",
        "documentVisible",
        "documentFocused",
        "continueDisabled",
        "refreshDisabled",
        "openDisabled",
      ],
      {
        viewStatus: [null, ...UI_STATUSES],
        viewStatusKey: ["empty", "unknown", ...UI_STATUS_KEYS],
        feedbackKey: ["empty", "unknown", ...UI_FEEDBACK_KEYS],
        actionMessageKey: ["empty", "unknown", ...UI_ACTION_KEYS],
      },
    );
  if (Object.hasOwn(input, "lastView"))
    output.lastView = finiteProjection(input.lastView, VIEW_BOOLS, viewEnums, {
      turnCount: [0, 120],
      itemCount: [0, 120],
    });
  return output;
};
export const projectOwnerRemoteBrowserViewDiagnostics = (value, expected) => {
  const body = ownData(value),
    content = ownData(body.content),
    binding = ownData(expected);
  const turns = Array.isArray(content.turns) ? content.turns : [];
  const latest = ownData(turns.at(-1));
  let count = 0,
    itemArraysValid = Array.isArray(content.turns);
  for (const turn of turns.slice(0, 121)) {
    const items = ownData(turn).items;
    if (!Array.isArray(items)) itemArraysValid = false;
    else count = Math.min(121, count + items.length);
  }
  const known = (value, allowed) =>
    value === undefined || value === null
      ? null
      : allowed.includes(value)
        ? value
        : "unknown";
  return {
    bodyObject:
      value !== null && typeof value === "object" && !Array.isArray(value),
    contentObject:
      body.content !== null &&
      typeof body.content === "object" &&
      !Array.isArray(body.content),
    turnsArray: Array.isArray(content.turns),
    itemArraysValid,
    viewIdValid: safeId(body.viewId),
    expiryValid:
      Number.isInteger(body.expiresInSeconds) &&
      body.expiresInSeconds >= 1 &&
      body.expiresInSeconds <= 30,
    threadMatches:
      safeId(binding.threadId) && content.threadId === binding.threadId,
    latestTurnMatches:
      safeId(binding.initialTurnId) &&
      content.latestTurnId === binding.initialTurnId &&
      latest.id === binding.initialTurnId,
    modelMatches:
      typeof binding.model === "string" && content.model === binding.model,
    canContinue: body.canContinue === true,
    truncated: content.truncated === true,
    viewStatus: known(content.status, VIEW_STATUSES),
    latestTurnStatus: known(latest.status, TURN_STATUSES),
    continueBlocker: known(content.continueBlocker, BLOCKERS),
    nativeError: known(body.error, NATIVE_ERRORS),
    turnCount: Math.min(120, turns.length),
    itemCount: Math.min(120, count),
    turnLimitExceeded: turns.length > 120,
    itemLimitExceeded: count > 120,
  };
};
// A read-only stream observer: never modifies, delays, destroys or replaces the pipe.
export const captureOwnerRemoteBrowserViewResponse = (
  incoming,
  expected,
  record,
) => {
  let chunks = [],
    length = 0,
    oversized = false,
    settled = false;
  const finish = (state, lastView) => {
    if (settled) return;
    settled = true;
    chunks = [];
    record({ state, ...(lastView ? { lastView } : {}) });
  };
  incoming.on("data", (chunk) => {
    if (settled || oversized) return;
    length += chunk.length;
    if (length > LIMIT) {
      oversized = true;
      chunks = [];
      return;
    }
    chunks.push(Buffer.from(chunk));
  });
  incoming.once("end", () => {
    if (settled) return;
    if (oversized) {
      finish("oversized");
      return;
    }
    try {
      const value = JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
      finish(
        "complete",
        projectOwnerRemoteBrowserViewDiagnostics(value, expected),
      );
    } catch {
      finish("failed");
    }
  });
  incoming.once("error", () => finish("failed"));
  incoming.once("aborted", () => finish("failed"));
};

// Diagnostic only: a failed prepare never becomes a pass and never starts a read.
export const createOwnerRemoteBrowserViewDrain = (
  diagnostics,
  { now = () => performance.now(), startedAt = now() } = {},
) => {
  const active = new Set();
  let sealed = false;
  const elapsed = () =>
    Math.min(120000, Math.max(0, Math.floor(now() - startedAt)));
  Object.assign(diagnostics, {
    firstViewStartedMs: null,
    firstViewResponseMs: null,
    lastViewEndMs: null,
    finishRequestedMs: null,
    viewResponseAfterFinish: false,
    readOnlyViewDrain: "not_started",
  });
  return {
    canStart: () => !sealed,
    begin() {
      if (sealed) return null;
      if (diagnostics.firstViewStartedMs === null)
        diagnostics.firstViewStartedMs = elapsed();
      let resolve,
        ended = false;
      const done = new Promise((finish) => {
        resolve = finish;
      });
      active.add(done);
      return {
        headers() {
          if (diagnostics.firstViewResponseMs === null)
            diagnostics.firstViewResponseMs = elapsed();
          if (diagnostics.finishRequestedMs !== null)
            diagnostics.viewResponseAfterFinish = true;
        },
        end() {
          if (ended) return;
          ended = true;
          diagnostics.lastViewEndMs = elapsed();
          active.delete(done);
          resolve();
        },
      };
    },
    async drainExisting() {
      sealed = true;
      const pending = [...active];
      const waitMs = Math.min(30000, Math.max(0, 120000 - (now() - startedAt)));
      let timer;
      try {
        const result = pending.length
          ? await Promise.race([
              Promise.all(pending).then(() => "completed"),
              new Promise((resolve) => {
                timer = setTimeout(() => resolve("timed_out"), waitMs);
              }),
            ])
          : "no_inflight";
        diagnostics.readOnlyViewDrain = result;
      } finally {
        clearTimeout(timer);
        diagnostics.preFinishViewCaptureState =
          diagnostics.proxyViewCaptureState;
        if (diagnostics.lastView)
          diagnostics.preFinishView = finiteProjection(
            diagnostics.lastView,
            VIEW_BOOLS,
            viewEnums,
            { turnCount: [0, 120], itemCount: [0, 120] },
          );
      }
    },
    markFinishRequested() {
      sealed = true;
      if (diagnostics.finishRequestedMs === null)
        diagnostics.finishRequestedMs = elapsed();
    },
  };
};

const httpRoute = (target) => {
  const pathname = new URL(target, `https://${HOST}`).pathname;
  if (pathname === "/remote/api/v1/view") return "view";
  if (pathname === "/remote/api/v1/conversations") return "history";
  if (pathname === "/remote/api/v1/session") return "session";
  if (pathname.startsWith("/remote/api/v1/session/")) return "auth";
  if (pathname === "/remote/api/v1/devices") return "devices";
  if (pathname.startsWith("/remote/api/v1/operations/")) return "operation";
  if (pathname === "/remote/api/v1/continue") return "continue";
  return "asset";
};

export const browserAuditRoute = (method, target, expectedThreadId) => {
  let url;
  try {
    url = new URL(target, `https://${HOST}`);
  } catch {
    return "deny";
  }
  if (url.origin !== `https://${HOST}` || url.hash) return "deny";
  if (
    method === "GET" &&
    [
      "/remote/",
      "/remote/console.js",
      "/remote/console.css",
      "/remote/i18next.js",
      "/remote/locales",
    ].includes(url.pathname) &&
    !url.search
  )
    return "asset";
  if (method === "GET" && url.pathname === "/remote/api/v1/conversations")
    return "deny_history";
  if (
    method === "GET" &&
    ["/remote/api/v1/session", "/remote/api/v1/devices"].includes(
      url.pathname,
    ) &&
    !url.search
  )
    return "read";
  if (
    method === "GET" &&
    url.pathname === "/remote/api/v1/view" &&
    [...url.searchParams.keys()].length === 1 &&
    url.searchParams.get("threadId") === expectedThreadId
  )
    return "read";
  if (
    method === "GET" &&
    /^\/remote\/api\/v1\/operations\/owner-[a-f0-9]{32}$/.test(url.pathname) &&
    !url.search
  )
    return "read";
  if (
    method === "POST" &&
    [
      "/remote/api/v1/session/enroll/options",
      "/remote/api/v1/session/enroll/finish",
      "/remote/api/v1/session/auth/options",
      "/remote/api/v1/session/auth/finish",
      "/remote/api/v1/session/logout",
    ].includes(url.pathname) &&
    !url.search
  )
    return "auth";
  if (
    method === "POST" &&
    url.pathname === "/remote/api/v1/continue" &&
    !url.search
  )
    return "continue";
  return "deny";
};

export const browserAuditOperationAllowed = (target, capturedOperation) => {
  let url;
  try {
    url = new URL(target, `https://${HOST}`);
  } catch {
    return false;
  }
  if (!url.pathname.startsWith("/remote/api/v1/operations/")) return true;
  return (
    safeOperation(capturedOperation) &&
    url.pathname === `/remote/api/v1/operations/${capturedOperation}` &&
    !url.search
  );
};
export const canonicalBrowserReceipt = (value, operationId, initialTurnId) => {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors);
    if (
      keys.some(
        (key) =>
          ![
            "operationId",
            "status",
            "submitted",
            "mutationAttempted",
            "acknowledgedTurnId",
          ].includes(key),
      ) ||
      Object.values(descriptors).some((item) => !Object.hasOwn(item, "value"))
    )
      return false;
    const own = (key) => descriptors[key]?.value;
    if (
      !safeOperation(operationId) ||
      own("operationId") !== operationId ||
      typeof own("submitted") !== "boolean" ||
      typeof own("mutationAttempted") !== "boolean"
    )
      return false;
    const hasAck = Object.hasOwn(descriptors, "acknowledgedTurnId");
    if (own("status") === "submitted")
      return (
        own("submitted") &&
        own("mutationAttempted") &&
        hasAck &&
        safeId(own("acknowledgedTurnId")) &&
        own("acknowledgedTurnId") !== initialTurnId
      );
    if (own("submitted") || hasAck) return false;
    if (own("status") === "refused") return own("mutationAttempted") === false;
    if (own("status") === "uncertain") return own("mutationAttempted") === true;
    return own("status") === "pending";
  } catch {
    return false;
  }
};
const sameReceipt = (left, right) =>
  [
    "operationId",
    "status",
    "submitted",
    "mutationAttempted",
    "acknowledgedTurnId",
  ].every(
    (key) =>
      Object.hasOwn(left, key) === Object.hasOwn(right, key) &&
      left[key] === right[key],
  );

export async function publishBrowserAuditFile(directory, name, value) {
  if (!files.has(name)) throw fail("browser_audit_handoff_invalid");
  const bytes = Buffer.from(JSON.stringify(value));
  if (!bytes.length || bytes.length > LIMIT)
    throw fail("browser_audit_handoff_invalid");
  const temporary = path.join(directory, `.browser-audit-${randomUUID()}.tmp`);
  let file;
  let owned = false;
  try {
    file = await open(temporary, "wx");
    owned = true;
    await file.writeFile(bytes);
    await file.sync();
    await file.close();
    file = undefined;
    await link(temporary, path.join(directory, name));
  } catch {
    throw fail("browser_audit_handoff_failed");
  } finally {
    await file?.close().catch(() => {});
    if (owned) await unlink(temporary).catch(() => {});
  }
}
export async function readBrowserAuditFile(directory, name) {
  if (!files.has(name)) throw fail("browser_audit_handoff_invalid");
  const target = path.join(directory, name);
  const info = await lstat(target).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw fail("browser_audit_handoff_invalid");
  });
  if (!info) return null;
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size < 1 ||
    info.size > LIMIT
  )
    throw fail("browser_audit_handoff_invalid");
  const file = await open(target, "r");
  try {
    const opened = await file.stat();
    if (opened.ino !== info.ino || opened.dev !== info.dev || !opened.isFile())
      throw 0;
    const bytes = Buffer.alloc(LIMIT + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(
        bytes,
        offset,
        bytes.length - offset,
        null,
      );
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    if (!offset || offset > LIMIT) throw 0;
    return JSON.parse(bytes.subarray(0, offset).toString("utf8"));
  } catch {
    throw fail("browser_audit_handoff_invalid");
  } finally {
    await file.close();
  }
}
export const validateBrowserReady = (value, nonce) => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "auditNonce,invitationSecret,schemaVersion" ||
    value.schemaVersion !== 1 ||
    value.auditNonce !== nonce ||
    !/^[a-f0-9]{64}$/.test(nonce) ||
    typeof value.invitationSecret !== "string" ||
    !/^[A-Za-z0-9_-]{22,256}$/.test(value.invitationSecret)
  )
    throw fail("browser_audit_handoff_invalid");
  return value.invitationSecret;
};

const certificateProgram = String.raw`
import datetime,pathlib,sys
from cryptography import x509
from cryptography.hazmat.primitives import hashes,serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID
root=pathlib.Path(sys.argv[1])
key=ec.generate_private_key(ec.SECP256R1())
name=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,"owner.example.test")])
now=datetime.datetime.now(datetime.timezone.utc)
cert=(x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now-datetime.timedelta(minutes=1)).not_valid_after(now+datetime.timedelta(hours=1)).add_extension(x509.SubjectAlternativeName([x509.DNSName("owner.example.test")]),critical=False).sign(key,hashes.SHA256()))
with (root/"browser-audit-key.pem").open("xb") as f:f.write(key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
with (root/"browser-audit-cert.pem").open("xb") as f:f.write(cert.public_bytes(serialization.Encoding.PEM))
`;
const readResponse = async (response) => {
  const length = Number(response.headers()["content-length"] || 0);
  if (length > RESPONSE_LIMIT) throw fail("browser_audit_response_invalid");
  const bytes = await response.body();
  if (bytes.length > RESPONSE_LIMIT)
    throw fail("browser_audit_response_invalid");
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw fail("browser_audit_response_invalid");
  }
};
const baseEvidence = (nonce) => ({
  schemaVersion: 1,
  auditNonce: nonce,
  stage: "isolated_setup",
  passed: false,
  error: null,
  socketVerified: false,
  webauthnVerified: false,
  loginVerified: false,
  csrfVerified: false,
  originVerified: false,
  logoutVerified: false,
  snapshotVerified: false,
  viewStatus: null,
  latestTurnStatus: null,
  threadMatches: false,
  continueBlocker: null,
  latestTurnMatches: false,
  modelMatches: false,
  turnCount: 0,
  itemCount: 0,
  truncated: false,
  ready: false,
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

export async function createOwnerRemoteBrowserAudit({
  directory,
  runtimeRoot,
  auditNonce,
  threadId,
  initialTurnId,
  model,
}) {
  const auditStartedAt = performance.now();
  if (
    !path.isAbsolute(directory) ||
    !path.basename(directory).startsWith("ccswitch-desktop-continuation-") ||
    !path.isAbsolute(runtimeRoot) ||
    !safeId(threadId) ||
    !safeId(initialTurnId) ||
    model !== "fixture-model" ||
    !/^[a-f0-9]{64}$/.test(auditNonce)
  )
    throw fail("browser_audit_configuration_invalid");
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw fail("browser_audit_configuration_invalid");
  try {
    await promisify(execFile)(
      path.join(runtimeRoot, "python", "python.exe"),
      ["-c", certificateProgram, directory],
      { windowsHide: true, timeout: 10000, maxBuffer: 1024 },
    );
  } catch {
    throw fail("browser_audit_certificate_unavailable");
  }
  const [key, cert] = await Promise.all([
    readFile(path.join(directory, "browser-audit-key.pem")),
    readFile(path.join(directory, "browser-audit-cert.pem")),
  ]);
  const certificate = new X509Certificate(cert);
  const spki = createHash("sha256")
    .update(certificate.publicKey.export({ type: "spki", format: "der" }))
    .digest("base64");
  const evidence = baseEvidence(auditNonce);
  const diagnostics = {
    headlessBrowserVerified: false,
    realConsoleAssetsVerified: false,
    virtualPasskeyEnrollmentVerified: false,
    virtualPasskeyLoginVerified: false,
    httpsBrowserOriginVerified: false,
    certificateTrustInstalled: false,
    userBrowserProfileUsed: false,
    historyEnumerationBlocked: true,
    browserSingleUiSubmissionVerified: false,
    browserOperationReceiptVerified: false,
    cookieAttributesVerified: false,
    actualRemoteDeviceVerified: false,
    preparePhase: "not_started",
    prepareFailure: null,
    prepareGuard: null,
    viewRequestCount: 0,
    viewResponseCount: 0,
    viewCaptureStartedCount: 0,
    viewCaptureCompletedCount: 0,
    proxyViewCaptureState: "not_requested",
    viewCaptureState: "not_requested",
    lastViewHttpStatus: null,
    httpStatus: {},
  };
  let origin, authority, context, page, browser, view, operationId;
  let continueRequests = 0,
    registered = 0,
    asserted = 0,
    stopped = false;
  const viewDrain = createOwnerRemoteBrowserViewDrain(diagnostics, {
    startedAt: auditStartedAt,
  });
  let postStarted = 0;
  const assets = new Set();
  const guard = (code) => {
    diagnostics.prepareGuard = code;
    throw 0;
  };
  const countDiagnostic = (key) => {
    diagnostics[key] = Math.min(1000, diagnostics[key] + 1);
  };
  const capturePrepareDom = async () => {
    diagnostics.prepareDom = { captured: false };
    if (!page) return;
    try {
      diagnostics.prepareDom = await page.evaluate(
        ({ statuses, statusKeys, feedbackKeys, actionKeys }) => {
          const byId = (id) => document.getElementById(id);
          const match = (id, keys) => {
            const text = byId(id)?.textContent?.trim();
            if (!text) return "empty";
            const i18n = window.i18next;
            if (!i18n || typeof i18n.t !== "function") return "unknown";
            return (
              keys.find(
                (key) => text === i18n.t(`ownerRemoteConsole.${key}`),
              ) || "unknown"
            );
          };
          const disabled = (id) =>
            typeof byId(id)?.disabled === "boolean"
              ? byId(id).disabled
              : undefined;
          const status = byId("view-status")?.dataset.status;
          return {
            captured: true,
            documentVisible: document.visibilityState === "visible",
            documentFocused: document.hasFocus(),
            continueDisabled: disabled("continue"),
            refreshDisabled: disabled("refresh"),
            openDisabled: disabled("open-thread"),
            viewStatus:
              status === undefined
                ? null
                : statuses.includes(status)
                  ? status
                  : "unknown",
            viewStatusKey: match("view-status", statusKeys),
            feedbackKey: match("feedback", feedbackKeys),
            actionMessageKey: match("action-message", actionKeys),
          };
        },
        {
          statuses: UI_STATUSES,
          statusKeys: UI_STATUS_KEYS,
          feedbackKeys: UI_FEEDBACK_KEYS,
          actionKeys: UI_ACTION_KEYS,
        },
      );
    } catch {
      /* Only a finite capture-failure flag is retained. */
    }
  };
  const server = createHttpsServer({ key, cert }, async (request, response) => {
    try {
      if (
        request.socket.remoteAddress !== "127.0.0.1" ||
        request.headers.host !== authority
      ) {
        response.writeHead(403).end();
        return;
      }
      const route = browserAuditRoute(request.method, request.url, threadId);
      const diagnosticRoute = httpRoute(request.url);
      const isView = diagnosticRoute === "view" && route === "read";
      // After a failed prepare, drain only already-issued reads; refuse new audit reads.
      if (isView && !viewDrain.canStart()) {
        response
          .writeHead(403, { "content-type": "application/json" })
          .end('{"error":"audit_view_drain_sealed"}');
        return;
      }
      if (isView) {
        countDiagnostic("viewRequestCount");
        diagnostics.viewCaptureState = "awaiting_headers";
      }
      let auditViewReadRefused = false;
      response.once("finish", () => {
        if (auditViewReadRefused) return;
        const status = response.statusCode;
        const bin =
          status >= 200 && status < 300
            ? "success"
            : status === 401
              ? "unauthorized"
              : status === 403
                ? "forbidden"
                : status === 409
                  ? "conflict"
                  : status >= 400 && status < 500
                    ? "client_error"
                    : status >= 500 && status < 600
                      ? "server_error"
                      : "other";
        const bins = (diagnostics.httpStatus[diagnosticRoute] ||= {});
        bins[bin] = Math.min(1000, (bins[bin] || 0) + 1);
      });
      if (
        route === "deny" ||
        route === "deny_history" ||
        !browserAuditOperationAllowed(request.url, operationId)
      ) {
        response
          .writeHead(403, { "content-type": "application/json" })
          .end('{"error":"audit_endpoint_refused"}');
        return;
      }
      const chunks = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > RESPONSE_LIMIT) throw 0;
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      if (route === "continue") {
        continueRequests += 1;
        postStarted = Date.now();
        if (continueRequests !== 1) {
          response
            .writeHead(409, { "content-type": "application/json" })
            .end('{"error":"audit_extra_submission_refused"}');
          return;
        }
        let payload;
        try {
          payload = JSON.parse(body.toString("utf8"));
        } catch {
          throw 0;
        }
        if (
          !payload ||
          Object.keys(payload).sort().join(",") !== "operationId,viewId" ||
          !safeOperation(payload.operationId) ||
          typeof payload.viewId !== "string" ||
          !view ||
          payload.viewId !== view.viewId
        )
          throw 0;
        operationId = payload.operationId;
      }
      const headers = { host: authority };
      for (const name of [
        "origin",
        "sec-fetch-site",
        "cookie",
        "x-ccsm-csrf",
        "content-type",
        "accept",
        "accept-language",
      ]) {
        if (typeof request.headers[name] === "string")
          headers[name] = request.headers[name];
      }
      headers["content-length"] = String(body.length);
      const viewObservation = isView ? viewDrain.begin() : null;
      if (isView && !viewObservation) {
        auditViewReadRefused = true;
        response
          .writeHead(403, { "content-type": "application/json" })
          .end('{"error":"audit_view_drain_sealed"}');
        return;
      }
      const upstream = httpRequest(
        {
          host: NATIVE,
          port: NATIVE_PORT,
          path: request.url,
          method: request.method,
          headers,
        },
        (incoming) => {
          if (isView) {
            viewObservation.headers();
            countDiagnostic("viewResponseCount");
            diagnostics.lastViewHttpStatus = incoming.statusCode || 502;
            diagnostics.proxyViewCaptureState = "awaiting_body";
            captureOwnerRemoteBrowserViewResponse(
              incoming,
              { threadId, initialTurnId, model },
              (result) => {
                diagnostics.proxyViewCaptureState = result.state;
                if (result.lastView) diagnostics.lastView = result.lastView;
              },
            );
            incoming.once("end", () => viewObservation.end());
            incoming.once("error", () => viewObservation.end());
            incoming.once("aborted", () => viewObservation.end());
          }
          response.writeHead(incoming.statusCode || 502, incoming.headers);
          incoming.pipe(response);
        },
      );
      upstream.once("error", () => {
        viewObservation?.end();
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      request.once("aborted", () => {
        /* Native mutation outcome remains unknown, never resend. */
      });
      upstream.end(body);
    } catch {
      if (!response.headersSent) response.writeHead(403);
      response.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  authority = `${HOST}:${server.address().port}`;
  origin = `https://${authority}`;
  try {
    await publishBrowserAuditFile(directory, "browser-config.json", {
      schemaVersion: 1,
      auditNonce,
      httpsOrigin: origin,
    });
  } catch {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    throw fail("browser_audit_handoff_failed");
  }
  const fixedRequest = async (target, options = {}) => {
    const full = new URL(target, origin);
    if (
      full.origin !== origin ||
      !["read", "auth"].includes(
        browserAuditRoute(
          options.method || "GET",
          full.pathname + full.search,
          threadId,
        ),
      ) ||
      !browserAuditOperationAllowed(full.pathname + full.search, operationId)
    )
      throw fail("browser_audit_request_refused");
    if (
      options.headers &&
      Object.keys(options.headers).some((name) => name !== "origin")
    )
      throw fail("browser_audit_request_refused");
    const cookies = await context.cookies([origin]);
    if (
      cookies.length > 1 ||
      cookies.some(
        (cookie) =>
          cookie.name !== "__Host-ccsm-owner" ||
          cookie.domain !== HOST ||
          cookie.path !== "/" ||
          cookie.secure !== true ||
          cookie.httpOnly !== true ||
          cookie.sameSite !== "Strict" ||
          !/^[A-Za-z0-9_-]{22,256}$/.test(cookie.value),
      )
    )
      throw fail("browser_audit_request_refused");
    const headers = {
      host: authority,
      origin: options.headers?.origin || origin,
      "sec-fetch-site": "same-origin",
    };
    if (
      headers.origin !== origin &&
      headers.origin !== "https://invalid.example.test"
    )
      throw fail("browser_audit_request_refused");
    if (cookies.length)
      headers.cookie = `__Host-ccsm-owner=${cookies[0].value}`;
    const body =
      options.data === undefined
        ? Buffer.alloc(0)
        : Buffer.from(JSON.stringify(options.data));
    if (body.length > LIMIT) throw fail("browser_audit_request_refused");
    if (body.length) headers["content-type"] = "application/json";
    headers["content-length"] = String(body.length);
    return new Promise((resolve, reject) => {
      // Only the owned proxy certificate and loopback address are trusted here.
      // No system trust changes, generic ignoreHTTPSErrors, or cookie injection.
      const request = httpsRequest(
        {
          hostname: HOST,
          family: 4,
          port: server.address().port,
          servername: HOST,
          lookup: (_name, _options, callback) =>
            callback(
              null,
              _options?.all
                ? [{ address: "127.0.0.1", family: 4 }]
                : "127.0.0.1",
              4,
            ),
          ca: cert,
          rejectUnauthorized: true,
          agent: false,
          path: full.pathname + full.search,
          method: options.method || "GET",
          headers,
        },
        (response) => {
          const chunks = [];
          let length = 0;
          response.on("data", (chunk) => {
            length += chunk.length;
            if (length > RESPONSE_LIMIT) {
              response.destroy();
              reject(fail("browser_audit_response_invalid"));
              return;
            }
            chunks.push(chunk);
          });
          response.once("error", () =>
            reject(fail("browser_audit_request_failed")),
          );
          response.once("end", () => {
            const bytes = Buffer.concat(chunks);
            resolve({
              status: () => response.statusCode,
              headers: () => response.headers,
              body: async () => bytes,
            });
          });
        },
      );
      request.setTimeout(20000, () => request.destroy());
      request.once("error", () => reject(fail("browser_audit_request_failed")));
      request.end(body);
    });
  };
  const finish = async () => {
    if (stopped) return;
    viewDrain.markFinishRequested();
    await publishBrowserAuditFile(directory, "browser-done.json", {
      schemaVersion: 1,
      auditNonce,
      done: true,
    });
    stopped = true;
  };
  const dispose = async () => {
    try {
      await context?.close();
      if (browser?.isConnected()) await browser.close();
    } catch {
      throw fail("browser_audit_cleanup_pending");
    }
    if (browser?.isConnected()) throw fail("browser_audit_cleanup_pending");
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  };
  return {
    diagnostics,
    async waitForNativeReady(child, deadline) {
      while (true) {
        const ready = await readBrowserAuditFile(
          directory,
          "browser-ready.json",
        );
        if (ready) return validateBrowserReady(ready, auditNonce);
        if (child.closed || Date.now() >= deadline)
          throw fail("browser_audit_service_unavailable");
        await sleep(50);
      }
    },
    async prepare(invitationSecret) {
      try {
        diagnostics.preparePhase = "import_browser";
        const imported = await import(
          pathToFileURL(
            path.join(
              runtimeRoot,
              "node",
              "node_modules",
              "playwright",
              "index.mjs",
            ),
          ).href
        );
        const edge = path.join(
          process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
          "Microsoft",
          "Edge",
          "Application",
          "msedge.exe",
        );
        diagnostics.preparePhase = "profile_guard";
        const profileInfo = await lstat(
          path.join(directory, "browser-profile"),
        ).catch((error) => {
          if (error?.code === "ENOENT") return null;
          throw error;
        });
        if (profileInfo) guard("profile_exists");
        diagnostics.preparePhase = "launch_browser";
        context = await imported.chromium.launchPersistentContext(
          path.join(directory, "browser-profile"),
          {
            executablePath: edge,
            headless: true,
            locale: "en-US",
            viewport: { width: 1000, height: 900 },
            timeout: 15000,
            args: [
              `--host-resolver-rules=MAP ${HOST} 127.0.0.1`,
              `--ignore-certificate-errors-spki-list=${spki}`,
              "--no-proxy-server",
              "--disable-background-networking",
              "--disable-component-update",
              "--no-first-run",
              "--no-default-browser-check",
            ],
          },
        );
        diagnostics.preparePhase = "prepare_page";
        browser = context.browser();
        page = context.pages()[0] || (await context.newPage());
        diagnostics.preparePhase = "restrict_network";
        await context.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          if (url.origin !== origin) return route.abort();
          return route.continue();
        });
        diagnostics.preparePhase = "configure_webauthn";
        const session = await context.newCDPSession(page);
        await session.send("WebAuthn.enable");
        await session.send("WebAuthn.addVirtualAuthenticator", {
          options: {
            protocol: "ctap2",
            transport: "internal",
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            automaticPresenceSimulation: true,
          },
        });
        session.on("WebAuthn.credentialAdded", () => {
          registered += 1;
        });
        session.on("WebAuthn.credentialAsserted", () => {
          asserted += 1;
        });
        page.on("response", (response) => {
          void (async () => {
            const url = new URL(response.url());
            if (url.origin !== origin) return;
            if (
              response.status() === 200 &&
              [
                "/remote/",
                "/remote/console.js",
                "/remote/console.css",
                "/remote/i18next.js",
                "/remote/locales",
              ].includes(url.pathname)
            )
              assets.add(url.pathname);
            if (
              url.pathname === "/remote/api/v1/view" &&
              url.searchParams.get("threadId") === threadId
            ) {
              countDiagnostic("viewCaptureStartedCount");
              diagnostics.lastViewHttpStatus = response.status();
              diagnostics.viewCaptureState = "awaiting_body";
              try {
                const value = await readResponse(response);
                diagnostics.lastView = projectOwnerRemoteBrowserViewDiagnostics(
                  value,
                  { threadId, initialTurnId, model },
                );
                if (
                  response.status() === 200 &&
                  diagnostics.lastView.threadMatches
                )
                  view = value;
                diagnostics.viewCaptureState = "complete";
              } catch {
                diagnostics.viewCaptureState = "failed";
              }
              countDiagnostic("viewCaptureCompletedCount");
            }
          })().catch(() => {
            diagnostics.viewCaptureState = "failed";
          });
        });
        diagnostics.preparePhase = "navigate";
        await page.goto(
          `${origin}/remote/#invite=${encodeURIComponent(invitationSecret)}`,
          { waitUntil: "domcontentloaded", timeout: 20000 },
        );
        diagnostics.preparePhase = "enroll_label";
        await page.locator("#device-label").fill("Isolated browser audit");
        diagnostics.preparePhase = "enroll_submit";
        await page.locator("#enroll").click();
        diagnostics.preparePhase = "enroll_workspace";
        await page
          .locator("#workspace")
          .waitFor({ state: "visible", timeout: 20000 });
        diagnostics.preparePhase = "enrollment_guard";
        if (registered !== 1) guard("enrollment_count");
        diagnostics.virtualPasskeyEnrollmentVerified = true;
        diagnostics.preparePhase = "cookie_guard";
        const cookies = await context.cookies();
        if (
          cookies.length !== 1 ||
          cookies[0].name !== "__Host-ccsm-owner" ||
          cookies[0].domain !== HOST ||
          cookies[0].path !== "/" ||
          cookies[0].secure !== true ||
          cookies[0].httpOnly !== true ||
          cookies[0].sameSite !== "Strict"
        )
          guard("cookie_attributes");
        diagnostics.cookieAttributesVerified = true;
        diagnostics.preparePhase = "csrf_guard";
        const noCsrf = await fixedRequest("/remote/api/v1/session/logout", {
          method: "POST",
          data: {},
        });
        if (noCsrf.status() !== 403) guard("csrf_response");
        evidence.csrfVerified = true;
        diagnostics.preparePhase = "origin_guard";
        const wrongOrigin = await fixedRequest("/remote/api/v1/session", {
          headers: { origin: "https://invalid.example.test" },
        });
        if (wrongOrigin.status() !== 403) guard("origin_response");
        evidence.originVerified = true;
        diagnostics.preparePhase = "logout_submit";
        await page.locator("#logout").click();
        diagnostics.preparePhase = "logout_panel";
        await page
          .locator("#auth-panel")
          .waitFor({ state: "visible", timeout: 10000 });
        diagnostics.preparePhase = "logout_guard";
        if ((await fixedRequest("/remote/api/v1/session")).status() !== 401)
          guard("logout_response");
        evidence.logoutVerified = true;
        diagnostics.preparePhase = "login_submit";
        await page.locator("#sign-in").click();
        diagnostics.preparePhase = "login_workspace";
        await page
          .locator("#workspace")
          .waitFor({ state: "visible", timeout: 20000 });
        diagnostics.preparePhase = "login_guard";
        if (asserted < 1) guard("login_assertion");
        diagnostics.virtualPasskeyLoginVerified = true;
        diagnostics.preparePhase = "thread_fill";
        await page.locator("#thread-id").fill(threadId);
        diagnostics.preparePhase = "thread_open";
        await page.locator("#open-thread").click();
        diagnostics.preparePhase = "continue_ready_wait";
        await page.waitForFunction(
          () => document.querySelector("#continue")?.disabled === false,
          undefined,
          { timeout: 20000 },
        );
        diagnostics.preparePhase = "bound_view_guard";
        const content = view?.content;
        const turns = content?.turns;
        const latest = Array.isArray(turns) ? turns.at(-1) : null;
        if (
          !content ||
          content.threadId !== threadId ||
          content.latestTurnId !== initialTurnId ||
          latest?.id !== initialTurnId ||
          content.model !== model ||
          !Array.isArray(turns) ||
          turns.length !== 1 ||
          view.canContinue !== true ||
          content.continueBlocker !== null ||
          !(
            ["idle"].includes(content.status) ||
            (content.status === "error" &&
              ["failed", "interrupted"].includes(latest.status))
          ) ||
          !safeId(view.viewId) ||
          !Number.isInteger(view.expiresInSeconds) ||
          view.expiresInSeconds < 1 ||
          view.expiresInSeconds > 30
        )
          guard("bound_view");
        diagnostics.preparePhase = "content_guard";
        let count = 0;
        for (const turn of turns) {
          if (!Array.isArray(turn.items)) guard("view_items");
          count += turn.items.length;
        }
        if (count > 120 || typeof content.truncated !== "boolean")
          guard("view_items");
        diagnostics.preparePhase = "assets_guard";
        if (
          ![
            "/remote/",
            "/remote/console.js",
            "/remote/console.css",
            "/remote/i18next.js",
            "/remote/locales",
          ].every((asset) => assets.has(asset))
        )
          guard("console_assets");
        Object.assign(evidence, {
          stage: "owner_view_ready",
          socketVerified: true,
          webauthnVerified: true,
          loginVerified: true,
          snapshotVerified: true,
          viewStatus: content.status,
          latestTurnStatus: latest.status,
          threadMatches: true,
          latestTurnMatches: true,
          modelMatches: true,
          turnCount: turns.length,
          itemCount: count,
          truncated: content.truncated,
          ready: true,
        });
        diagnostics.preparePhase = "secure_context";
        Object.assign(diagnostics, {
          headlessBrowserVerified: true,
          realConsoleAssetsVerified: true,
          httpsBrowserOriginVerified: await page.evaluate(
            () => window.isSecureContext === true,
          ),
        });
        if (!diagnostics.httpsBrowserOriginVerified) guard("secure_context");
        diagnostics.preparePhase = "completed";
        await capturePrepareDom();
        return { ...evidence };
      } catch (error) {
        diagnostics.prepareFailure = diagnostics.prepareGuard
          ? "guard_rejected"
          : ownData(error).name === "TimeoutError"
            ? "timeout"
            : "browser_step_failed";
        await capturePrepareDom();
        await viewDrain.drainExisting();
        throw fail("browser_audit_prepare_failed");
      }
    },
    async commit() {
      evidence.stage = "native_owner_continue";
      evidence.continueRequestSent = true;
      try {
        if (!(await page.locator("#continue").isEnabled())) throw 0;
        const responseWait = page.waitForResponse(
          (response) =>
            new URL(response.url()).origin === origin &&
            new URL(response.url()).pathname === "/remote/api/v1/continue" &&
            response.request().method() === "POST",
          { timeout: 45000 },
        );
        responseWait.catch(() => {}); // A click failure must not leave an unhandled pending response waiter.
        await page
          .locator("#continue")
          .click({ timeout: 2000, noWaitAfter: true });
        const response = await responseWait;
        evidence.postElapsedMs = Math.min(
          120000,
          Math.max(0, Date.now() - postStarted),
        );
        if (
          response.status() !== 200 ||
          !safeOperation(operationId) ||
          continueRequests !== 1
        )
          throw 0;
        const receipt = await readResponse(response);
        evidence.postStatus = [
          "pending",
          "submitted",
          "uncertain",
          "refused",
        ].includes(receipt?.status)
          ? receipt.status
          : "unknown";
        evidence.postSubmitted =
          typeof receipt?.submitted === "boolean" ? receipt.submitted : null;
        evidence.postMutationAttempted =
          typeof receipt?.mutationAttempted === "boolean"
            ? receipt.mutationAttempted
            : null;
        evidence.operationMatches = receipt?.operationId === operationId;
        const lookup = await fixedRequest(
          `/remote/api/v1/operations/${operationId}`,
        );
        const canonical = await readResponse(lookup);
        evidence.canonicalReceiptMatches =
          lookup.status() === 200 &&
          canonicalBrowserReceipt(receipt, operationId, initialTurnId) &&
          canonicalBrowserReceipt(canonical, operationId, initialTurnId) &&
          sameReceipt(receipt, canonical);
        if (
          evidence.canonicalReceiptMatches &&
          receipt.status === "refused" &&
          !receipt.submitted &&
          !receipt.mutationAttempted
        ) {
          evidence.canonicalRefusalVerified = true;
          evidence.error = "browser_canonical_refused";
        } else if (
          evidence.canonicalReceiptMatches &&
          receipt.status === "submitted"
        ) {
          evidence.acknowledgementVerified = true;
          evidence.acknowledgedTurnId = receipt.acknowledgedTurnId;
          evidence.receiptVerified = true;
          evidence.stage = "completed";
          evidence.passed = true;
          diagnostics.browserSingleUiSubmissionVerified = true;
          diagnostics.browserOperationReceiptVerified = true;
        } else evidence.error = "browser_acknowledgement_unproven";
      } catch {
        evidence.error = "browser_acknowledgement_unproven";
      }
      await publishBrowserAuditFile(directory, "result.json", evidence);
      if (evidence.passed || evidence.canonicalRefusalVerified) await finish();
      return { ...evidence };
    },
    finish,
    dispose,
  };
}
