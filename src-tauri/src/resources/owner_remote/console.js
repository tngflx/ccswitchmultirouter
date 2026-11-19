// Narrow same-origin client. No RPC passthrough and no automatic mutation retry.
const API = "/remote/api/v1";
const MAX_RESPONSE_BYTES = 256 * 1024;
const POLL_MS = 2500;
const REQUEST_TIMEOUT_MS = 20_000;
// Transport wait only: never extends native authorization or view lifetimes.
const CONTINUE_REQUEST_TIMEOUT_MS = 45_000;
const operationStatuses = new Set([
  "pending",
  "submitted",
  "refused",
  "uncertain",
]);
const itemTypes = new Set([
  "user",
  "assistant",
  "plan",
  "reasoning_summary",
  "command",
  "tool",
  "agent_tool",
  "file_change",
  "web_search",
  "image_generation",
  "context_compaction",
  "unsupported",
]);
const failureCategories = new Set([
  "server_overloaded",
  "usage_limit",
  "rate_limit",
  "internal_server_error",
  "authentication_error",
  "context_length_exceeded",
  "invalid_request_error",
  "connection_error",
  "unknown",
]);
const failureCategoryKey = (turn) => {
  if (!plain(turn) || !plain(turn.failure)) return null;
  return typeof turn.failure.category === "string" &&
    failureCategories.has(turn.failure.category)
    ? turn.failure.category
    : "unknown";
};
const statuses = new Set([
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
]);
const statusKey = (value) =>
  typeof value === "string" && statuses.has(value) ? value : "unknown";
const plain = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, limit = 256) =>
  typeof value === "string" ? value.slice(0, limit) : "";
const id = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 256 &&
  value.trim() === value &&
  !/[\u0000-\u0020\u007f]/.test(value)
    ? value
    : null;

// Native canContinue is the sole authorization capability. This projection
// only rejects malformed/inconsistent snapshot metadata; it grants no fallback.
const hasNativeContinueProof = (view) => {
  if (
    !plain(view) ||
    view.canContinue !== true ||
    !plain(view.content) ||
    !id(view.content.latestTurnId) ||
    view.content.continueBlocker !== null
  )
    return false;
  const content = view.content;
  if (content.status === "idle") return true;
  if (content.status !== "error" || !Array.isArray(content.turns)) return false;
  const latest = content.turns.at(-1);
  return (
    plain(latest) &&
    latest.id === content.latestTurnId &&
    ["failed", "interrupted"].includes(latest.status)
  );
};
const isCanonicalOperationReceipt = (result, operation) => {
  if (
    !plain(result) ||
    result.operationId !== operation.operationId ||
    !operationStatuses.has(result.status) ||
    typeof result.submitted !== "boolean" ||
    typeof result.mutationAttempted !== "boolean" ||
    Object.keys(result).some(
      (key) =>
        ![
          "operationId",
          "status",
          "submitted",
          "mutationAttempted",
          "acknowledgedTurnId",
        ].includes(key),
    )
  )
    return false;
  const hasAck = Object.hasOwn(result, "acknowledgedTurnId");
  if (result.status === "submitted")
    return (
      result.submitted &&
      result.mutationAttempted &&
      typeof result.acknowledgedTurnId === "string" &&
      /^[A-Za-z0-9_-]{1,256}$/.test(result.acknowledgedTurnId) &&
      result.acknowledgedTurnId !== operation.baseTurnId
    );
  if (result.submitted || hasAck) return false;
  if (result.status === "refused") return !result.mutationAttempted;
  if (result.status === "uncertain") return result.mutationAttempted;
  return result.status === "pending";
};

export function decodeOwnerRemoteBase64Url(value) {
  if (
    typeof value !== "string" ||
    value.length > 128 * 1024 ||
    !/^[A-Za-z0-9_-]*$/.test(value) ||
    value.length % 4 === 1
  )
    throw new Error("invalid_passkey_data");
  return Uint8Array.from(
    atob(value.replace(/-/g, "+").replace(/_/g, "/")),
    (character) => character.charCodeAt(0),
  );
}
export function encodeOwnerRemoteBase64Url(value) {
  let bytes;
  if (ArrayBuffer.isView(value))
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
  else throw new Error("invalid_passkey_data");
  if (bytes.byteLength > 128 * 1024) throw new Error("invalid_passkey_data");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
const passkeyOptions = (source, registration) => {
  if (!plain(source)) throw new Error("invalid_passkey_options");
  const publicKey = {
    ...source,
    challenge: decodeOwnerRemoteBase64Url(source.challenge),
  };
  if (registration) {
    if (!plain(source.user)) throw new Error("invalid_passkey_options");
    publicKey.user = {
      ...source.user,
      id: decodeOwnerRemoteBase64Url(source.user.id),
    };
  }
  const key = registration ? "excludeCredentials" : "allowCredentials";
  if (source[key] !== undefined) {
    if (!Array.isArray(source[key]) || source[key].length > 64)
      throw new Error("invalid_passkey_options");
    publicKey[key] = source[key].map((credential) => ({
      ...credential,
      id: decodeOwnerRemoteBase64Url(credential.id),
    }));
  }
  return { publicKey };
};
const passkeyCredential = (credential, registration) => {
  if (
    !credential ||
    credential.type !== "public-key" ||
    !credential.response ||
    typeof credential.id !== "string"
  )
    throw new Error("invalid_passkey_credential");
  const response = {
    clientDataJSON: encodeOwnerRemoteBase64Url(
      credential.response.clientDataJSON,
    ),
  };
  if (registration) {
    response.attestationObject = encodeOwnerRemoteBase64Url(
      credential.response.attestationObject,
    );
    if (typeof credential.response.getTransports === "function")
      response.transports = credential.response
        .getTransports()
        .filter((value) =>
          ["usb", "nfc", "ble", "internal", "hybrid"].includes(value),
        );
  } else {
    response.authenticatorData = encodeOwnerRemoteBase64Url(
      credential.response.authenticatorData,
    );
    response.signature = encodeOwnerRemoteBase64Url(
      credential.response.signature,
    );
    response.userHandle =
      credential.response.userHandle == null
        ? null
        : encodeOwnerRemoteBase64Url(credential.response.userHandle);
  }
  return {
    id: text(credential.id, 4096),
    rawId: encodeOwnerRemoteBase64Url(credential.rawId),
    type: "public-key",
    response,
    clientExtensionResults:
      typeof credential.getClientExtensionResults === "function"
        ? credential.getClientExtensionResults()
        : {},
  };
};
class RequestFailure extends Error {
  constructor(kind, status = 0) {
    super(kind);
    this.kind = kind;
    this.status = status;
  }
}

// Injected options are for deterministic offline tests, not runtime configuration.
export function mountOwnerRemoteConsole(root, options = {}) {
  const document = root.ownerDocument;
  const window = options.window || document.defaultView;
  const fetch = options.fetch || window.fetch.bind(window);
  const credentials = options.credentials || window.navigator.credentials;
  const crypto = options.crypto || window.crypto;
  const i18n = options.i18n || window.i18next;
  let t = () => "";
  const now = options.now || (() => window.performance.now());
  const isActive =
    options.isActive ||
    (() => document.visibilityState === "visible" && document.hasFocus());
  const nodes = {};
  for (const name of [
    "connection-state",
    "feedback",
    "auth-panel",
    "auth-note",
    "sign-in",
    "enroll-form",
    "device-label",
    "enroll",
    "workspace",
    "host-name",
    "logout",
    "thread-form",
    "thread-id",
    "open-thread",
    "conversation-choice",
    "view-heading",
    "view-status",
    "view-model",
    "view-time",
    "view-note",
    "transcript",
    "refresh",
    "action-message",
    "continue",
    "invite-device",
    "invitation-result",
    "invitation-link",
    "copy-invitation",
    "devices-list",
  ]) {
    nodes[name] = root.querySelector(`#${name}`);
    if (!nodes[name]) throw new Error("owner_remote_document_incomplete");
  }
  const state = {
    destroyed: false,
    ready: false,
    started: false,
    session: null,
    generation: 0,
    selection: 0,
    threadId: null,
    view: null,
    deadline: 0,
    invitation: null,
    authBusy: false,
    submitting: false,
    refreshing: false,
    poll: null,
    expiry: null,
    invitationExpiry: null,
    requests: new Set(),
    operations: new Map(),
    listeners: [],
  };
  const say = (name, message) => {
    nodes[name].textContent = message;
  };
  const listen = (target, event, listener) => {
    target.addEventListener(event, listener);
    state.listeners.push(() => target.removeEventListener(event, listener));
  };
  const clearTimer = (name) => {
    if (state[name] !== null) window.clearTimeout(state[name]);
    state[name] = null;
  };
  const current = (generation, selection = state.selection) =>
    !state.destroyed &&
    generation === state.generation &&
    selection === state.selection;
  const invalidateView = () => {
    state.view = null;
    state.deadline = 0;
    clearTimer("expiry");
    nodes.continue.disabled = true;
  };
  const clearInvitation = () => {
    clearTimer("invitationExpiry");
    nodes["invitation-result"].hidden = true;
    nodes["invitation-link"].value = "";
  };
  const emptyTranscript = (message) => {
    const paragraph = document.createElement("p");
    paragraph.className = "empty-state";
    paragraph.textContent = message;
    nodes.transcript.replaceChildren(paragraph);
  };
  const updateControls = () => {
    const view = state.view;
    nodes.continue.disabled =
      !state.ready ||
      !state.session ||
      state.authBusy ||
      state.submitting ||
      state.refreshing ||
      !isActive() ||
      !view ||
      !id(view.viewId) ||
      now() >= state.deadline ||
      !hasNativeContinueProof(view) ||
      state.operations.has(state.threadId);
    nodes["sign-in"].disabled = !state.ready || state.authBusy;
    nodes.enroll.disabled = !state.ready || state.authBusy;
    nodes["invite-device"].disabled = state.authBusy || !state.session;
    nodes.refresh.disabled =
      state.refreshing || !state.session || !state.threadId;
    nodes["open-thread"].disabled = state.refreshing;
    nodes.logout.disabled = state.authBusy || state.submitting;
  };
  const resetSession = (message = "") => {
    state.session = null;
    state.generation++;
    state.selection++;
    state.threadId = null;
    state.authBusy = false;
    state.submitting = false;
    state.refreshing = false;
    const hadUnresolvedOperation = [...state.operations.values()].some(
      (operation) => operation.status !== "refused",
    );
    for (const operation of state.operations.values())
      if (operation.status === "pending") operation.status = "uncertain";
    invalidateView();
    clearTimer("poll");
    clearInvitation();
    for (const controller of state.requests) controller.abort();
    state.requests.clear();
    nodes.workspace.hidden = true;
    nodes["auth-panel"].hidden = false;
    nodes["enroll-form"].hidden = !state.invitation;
    nodes["devices-list"].replaceChildren();
    nodes["conversation-choice"].replaceChildren();
    nodes["thread-id"].value = "";
    say("connection-state", t("status.notConnected"));
    say("view-heading", t("page.noConversation"));
    say("view-status", t("page.notLoaded"));
    nodes["view-status"].removeAttribute("data-status");
    say("view-model", "");
    say("view-time", "");
    emptyTranscript(t("message.signInToRead"));
    say(
      "feedback",
      hadUnresolvedOperation
        ? `${message} ${t("message.authLossAfterContinue")}`.trim()
        : message,
    );
    updateControls();
  };
  const request = async (path, method = "GET", body, requireSession = true) => {
    if (state.destroyed) throw new RequestFailure("cancelled");
    if (requireSession && !state.session)
      throw new RequestFailure("authentication_required", 401);
    const headers = { Accept: "application/json" };
    if (method !== "GET") {
      headers["Content-Type"] = "application/json";
      if (state.session) headers["x-ccsm-csrf"] = state.session.csrfToken;
    }
    const controller = new window.AbortController();
    state.requests.add(controller);
    const timeout = window.setTimeout(
      () => controller.abort(),
      method === "POST" && path === "/continue"
        ? CONTINUE_REQUEST_TIMEOUT_MS
        : REQUEST_TIMEOUT_MS,
    );
    try {
      const response = await fetch(
        path === "/remote/locales" ? path : `${API}${path}`,
        {
          method,
          headers,
          credentials: "same-origin",
          mode: "same-origin",
          cache: "no-store",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal: controller.signal,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
      if (response.status === 401 && requireSession) {
        resetSession(t("message.sessionExpired"));
        throw new RequestFailure("authentication_required", 401);
      }
      if (!response.ok)
        throw new RequestFailure(
          response.status === 429 ? "rate_limited" : "request_refused",
          response.status,
        );
      if (Number(response.headers?.get("content-length")) > MAX_RESPONSE_BYTES)
        throw new RequestFailure("response_unavailable");
      let source;
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        const chunks = [];
        let length = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > MAX_RESPONSE_BYTES)
              throw new RequestFailure("response_unavailable");
            chunks.push(value);
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } else {
        source = await response.text();
        if (source.length > MAX_RESPONSE_BYTES)
          throw new RequestFailure("response_unavailable");
      }
      const result = JSON.parse(source);
      if (!plain(result)) throw new RequestFailure("response_unavailable");
      return result;
    } catch (error) {
      if (error instanceof RequestFailure) throw error;
      throw new RequestFailure("connection_unavailable");
    } finally {
      window.clearTimeout(timeout);
      state.requests.delete(controller);
    }
  };
  const showOperation = (operation) =>
    say("action-message", t(`operation.${operation.status}`));
  const applyOperation = (operation, result) => {
    if (!isCanonicalOperationReceipt(result, operation))
      operation.status = "uncertain";
    else {
      operation.status = result.status;
      if (id(result.acknowledgedTurnId))
        operation.acknowledgedTurnId = result.acknowledgedTurnId;
    }
    if (operation.status === "refused")
      state.operations.delete(operation.threadId);
    if (state.threadId === operation.threadId) showOperation(operation);
  };
  const renderContent = (content) => {
    let itemCount = 0,
      textBudget = 32768;
    const fragment = document.createDocumentFragment();
    const turns = Array.isArray(content.turns) ? content.turns.slice(-20) : [];
    for (let index = 0; index < turns.length; index++) {
      const turn = turns[index];
      if (!plain(turn)) continue;
      const section = document.createElement("section");
      section.className = "turn";
      const label = document.createElement("div");
      label.className = "turn-label";
      const name = document.createElement("span");
      name.textContent = t("message.turnNumber", { number: index + 1 });
      const status = document.createElement("span");
      status.textContent = t(`status.${statusKey(turn.status)}`);
      label.append(name, status);
      const failure = failureCategoryKey(turn);
      if (failure) {
        const failureLabel = document.createElement("span");
        failureLabel.className = "turn-failure";
        failureLabel.textContent = t(`failure.${failure}`);
        label.append(failureLabel);
      }
      section.append(label);
      const items = Array.isArray(turn.items) ? turn.items.slice(-40) : [];
      for (const item of items) {
        if (!plain(item) || itemCount >= 120) break;
        itemCount++;
        const type =
          typeof item.type === "string" && itemTypes.has(item.type)
            ? item.type
            : "unsupported";
        const article = document.createElement("article");
        article.className = "message";
        article.dataset.type = type;
        const heading = document.createElement("p");
        heading.className = "message-label";
        heading.textContent = t(`item.${type}`);
        if (item.status) {
          const status = document.createElement("span");
          status.textContent = t(`status.${statusKey(item.status)}`);
          heading.append(status);
        }
        article.append(heading);
        if (
          type !== "unsupported" &&
          typeof item.text === "string" &&
          textBudget > 0
        ) {
          const body = document.createElement("pre");
          body.className = "message-text";
          body.textContent = item.text.slice(0, Math.min(4096, textBudget));
          textBudget -= body.textContent.length;
          article.append(body);
        }
        section.append(article);
      }
      fragment.append(section);
    }
    if (!turns.length) {
      emptyTranscript(t("message.noRecentContent"));
      return;
    }
    const transcript = nodes.transcript;
    const follow =
      transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight <
      100;
    const priorScroll = transcript.scrollTop;
    transcript.replaceChildren(fragment);
    transcript.scrollTop = follow ? transcript.scrollHeight : priorScroll;
  };
  const applyView = (result) => {
    const content = result.content;
    if (
      !plain(content) ||
      content.kind !== "snapshot" ||
      content.threadId !== state.threadId
    )
      throw new RequestFailure("view_unavailable");
    renderContent(content);
    say(
      "view-heading",
      t("message.conversationHeading", {
        threadId: text(content.threadId, 96),
      }),
    );
    const status = statusKey(content.status);
    say("view-status", t(`status.${status}`));
    nodes["view-status"].dataset.status = status;
    say(
      "view-model",
      content.model
        ? t("message.model", { model: text(content.model, 128) })
        : t("message.modelUnavailable"),
    );
    say("view-time", t("message.refreshed"));
    say(
      "view-note",
      content.truncated
        ? t("message.truncated")
        : t("message.snapshotDisclaimer"),
    );
    const seconds = Number(result.expiresInSeconds);
    state.view = id(result.viewId) ? result : null;
    state.deadline =
      now() +
      Math.min(
        30_000,
        Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0,
      );
    clearTimer("expiry");
    if (state.view && state.deadline > now())
      state.expiry = window.setTimeout(() => {
        state.expiry = null;
        invalidateView();
        say("action-message", t("message.viewExpired"));
      }, state.deadline - now());
    const operation = state.operations.get(state.threadId);
    if (
      operation &&
      operation.status === "submitted" &&
      operation.acknowledgedTurnId &&
      content.latestTurnId === operation.acknowledgedTurnId &&
      content.latestTurnId !== operation.baseTurnId &&
      content.status === "idle"
    ) {
      state.operations.delete(state.threadId);
      say("action-message", t("message.acceptedIdle"));
    } else if (operation) showOperation(operation);
    else if (result.canContinue !== true || content.continueBlocker)
      say("action-message", t("message.readOnly"));
    else if (!hasNativeContinueProof(result))
      say("action-message", t("message.notIdle"));
    else if (!state.view || state.deadline <= now())
      say("action-message", t("message.bindingUnavailable"));
    else
      say(
        "action-message",
        t(
          content.status === "error"
            ? "message.errorReady"
            : "message.idleReady",
        ),
      );
  };
  const reconcile = async (operation) => {
    if (!operation || operation.status === "refused") return;
    try {
      const result = await request(
        `/operations/${encodeURIComponent(operation.operationId)}`,
      );
      if (state.operations.get(operation.threadId) === operation)
        applyOperation(operation, result);
    } catch {
      /* A failed read is never evidence of no mutation. */
    }
  };
  const schedule = () => {
    clearTimer("poll");
    if (!state.destroyed && state.session && state.threadId && isActive())
      state.poll = window.setTimeout(() => {
        state.poll = null;
        void refresh();
      }, POLL_MS);
  };
  const refresh = async () => {
    if (
      state.destroyed ||
      !state.session ||
      !state.threadId ||
      state.refreshing ||
      state.submitting ||
      !isActive()
    ) {
      schedule();
      return;
    }
    const generation = state.generation,
      selection = state.selection,
      threadId = state.threadId;
    state.refreshing = true;
    invalidateView();
    updateControls();
    try {
      await reconcile(state.operations.get(threadId));
      if (!current(generation, selection)) return;
      const result = await request(
        `/view?threadId=${encodeURIComponent(threadId)}`,
      );
      if (!current(generation, selection)) return;
      applyView(result);
      say("feedback", "");
    } catch {
      if (!current(generation, selection) || !state.session) return;
      invalidateView();
      say("view-status", t("status.stale"));
      nodes["view-status"].dataset.status = "stale";
      say("view-time", t("message.refreshUnavailable"));
      if (!state.operations.has(threadId))
        say("action-message", t("message.refreshFailed"));
      say("feedback", t("message.hostUnavailable"));
    } finally {
      if (current(generation, selection)) {
        state.refreshing = false;
        updateControls();
        schedule();
      }
    }
  };
  const loadConversations = async () => {
    const generation = state.generation;
    try {
      const result = await request("/conversations");
      if (!current(generation) || !Array.isArray(result.conversations)) return;
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = t("page.chooseConversation");
      const choices = [placeholder];
      for (const conversation of result.conversations.slice(0, 50)) {
        const threadId = id(conversation?.threadId);
        if (!threadId) continue;
        const choice = document.createElement("option");
        choice.value = threadId;
        choice.textContent = text(conversation.title, 120) || threadId;
        choices.push(choice);
      }
      nodes["conversation-choice"].replaceChildren(...choices);
    } catch {
      /* Absence never selects an inferred conversation; exact IDs remain available. */
    }
  };
  const loadDevices = async () => {
    const generation = state.generation;
    try {
      const result = await request("/devices");
      if (!current(generation) || !Array.isArray(result.devices)) return;
      const rows = [];
      for (const device of result.devices.slice(0, 32)) {
        const deviceId = id(device?.deviceId);
        if (!deviceId) continue;
        const row = document.createElement("li"),
          label = document.createElement("span"),
          button = document.createElement("button");
        label.textContent = `${text(device.label, 80) || t("message.ownerPasskey")}${deviceId === state.session.deviceId ? ` · ${t("message.currentCredential")}` : ""}`;
        button.type = "button";
        button.className = "button quiet";
        button.textContent = t("message.revokePasskey");
        button.disabled = state.authBusy || device.revoked === true;
        button.setAttribute(
          "aria-label",
          t("message.revokeLabel", {
            label: text(device.label, 80) || t("message.ownerPasskey"),
          }),
        );
        if (device.revoked === true)
          label.textContent += ` · ${t("message.revokedCredential")}`;
        button.addEventListener(
          "click",
          () => void management({ action: "revoke_credential", deviceId }),
        );
        row.append(label, button);
        rows.push(row);
      }
      nodes["devices-list"].replaceChildren(...rows);
    } catch {
      /* Device management failure does not authorize any fallback. */
    }
  };
  const activateSession = async (session) => {
    if (
      session.authenticated !== true ||
      !id(session.csrfToken) ||
      !id(session.deviceId)
    )
      throw new RequestFailure("authentication_required");
    state.session = {
      csrfToken: session.csrfToken,
      deviceId: session.deviceId,
      sessionId: id(session.sessionId),
    };
    state.invitation = null;
    state.generation++;
    nodes.workspace.hidden = false;
    nodes["auth-panel"].hidden = true;
    nodes["enroll-form"].hidden = true;
    say("connection-state", t("status.connected"));
    say(
      "host-name",
      session.hostId
        ? t("message.host", { hostId: text(session.hostId, 48) })
        : "",
    );
    say("feedback", "");
    updateControls();
    await Promise.all([loadConversations(), loadDevices()]);
  };
  const ceremony = async (registration, managementAction) => {
    if (!state.ready || state.authBusy || state.destroyed) return;
    if (
      !credentials ||
      typeof credentials.get !== "function" ||
      (registration && typeof credentials.create !== "function")
    ) {
      say("feedback", t("message.passkeyUnavailable"));
      return;
    }
    const generation = state.generation;
    state.authBusy = true;
    updateControls();
    say("feedback", "");
    try {
      const challenge = await request(
        registration ? "/session/enroll/options" : "/session/auth/options",
        "POST",
        registration
          ? {
              invitationSecret: state.invitation,
              label: text(nodes["device-label"].value.trim(), 80),
            }
          : managementAction
            ? { managementAction }
            : {},
        !!managementAction,
      );
      if (!current(generation)) return;
      if (!id(challenge.ceremonyId))
        throw new RequestFailure("request_refused");
      const credential = registration
        ? await credentials.create(passkeyOptions(challenge.publicKey, true))
        : await credentials.get(passkeyOptions(challenge.publicKey, false));
      if (!current(generation)) return;
      const result = await request(
        registration ? "/session/enroll/finish" : "/session/auth/finish",
        "POST",
        {
          ceremonyId: challenge.ceremonyId,
          credential: passkeyCredential(credential, registration),
          ...(!registration
            ? { purpose: managementAction ? "management" : "login" }
            : {}),
        },
        !!managementAction,
      );
      if (!current(generation)) return;
      if (managementAction) {
        const outcome = result.management;
        if (!plain(outcome)) throw new RequestFailure("request_refused");
        const invitation = outcome.invitation;
        if (plain(invitation) && id(invitation.invitationSecret)) {
          clearInvitation();
          const url = new URL("/remote/", window.location.origin);
          url.hash = `invite=${encodeURIComponent(invitation.invitationSecret)}`;
          nodes["invitation-link"].value = url.href;
          nodes["invitation-result"].hidden = false;
          state.invitationExpiry = window.setTimeout(
            clearInvitation,
            Math.min(
              60,
              Math.max(0, Number(invitation.expiresInSeconds) || 0),
            ) * 1000,
          );
          say("feedback", t("message.invitationCreated"));
        } else if (outcome.revoked === true) {
          if (managementAction.deviceId === state.session.deviceId) {
            resetSession(t("message.selfRevoked"));
            return;
          }
          say("feedback", t("message.revoked"));
        } else throw new RequestFailure("request_refused");
        await loadDevices();
      } else await activateSession(result);
    } catch (error) {
      if (!current(generation) || state.destroyed) return;
      say(
        "feedback",
        error instanceof RequestFailure && error.kind === "rate_limited"
          ? t("message.rateLimited")
          : registration
            ? t("message.enrollFailed")
            : managementAction
              ? t("message.managementFailed")
              : t("message.loginFailed"),
      );
    } finally {
      state.authBusy = false;
      updateControls();
    }
  };
  const management = (action) =>
    !state.session || state.submitting
      ? Promise.resolve()
      : ceremony(false, action);
  const selectThread = async (value) => {
    const threadId = id(value);
    if (!state.session || !threadId) {
      say("feedback", t("message.chooseExact"));
      return;
    }
    state.selection++;
    state.threadId = threadId;
    state.refreshing = false;
    clearTimer("poll");
    invalidateView();
    nodes["thread-id"].value = threadId;
    say(
      "view-heading",
      t("message.conversationHeading", { threadId: text(threadId, 96) }),
    );
    say("view-status", t("status.loading"));
    say("view-model", "");
    say("view-time", "");
    emptyTranscript(t("message.reading"));
    say("feedback", "");
    await refresh();
  };
  const sendContinue = async () => {
    updateControls();
    if (nodes.continue.disabled) return;
    const view = state.view,
      threadId = state.threadId,
      generation = state.generation;
    if (!crypto || typeof crypto.getRandomValues !== "function") {
      invalidateView();
      say("action-message", t("message.secureIdentityUnavailable"));
      return;
    }
    let bytes;
    try {
      bytes = crypto.getRandomValues(new Uint8Array(16));
    } catch {
      invalidateView();
      say("action-message", t("message.secureIdentityUnavailable"));
      return;
    }
    const operationId = `owner-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    const operation = {
      operationId,
      threadId,
      baseTurnId: id(view.content.latestTurnId),
      acknowledgedTurnId: null,
      status: "pending",
    };
    state.operations.set(threadId, operation);
    state.submitting = true;
    invalidateView();
    clearTimer("poll");
    showOperation(operation);
    updateControls();
    try {
      const result = await request("/continue", "POST", {
        viewId: view.viewId,
        operationId,
      });
      if (!current(generation) || !state.session) return;
      applyOperation(operation, result);
    } catch {
      if (!current(generation) || !state.session) return;
      operation.status = "uncertain";
      if (state.threadId === threadId) showOperation(operation);
    } finally {
      if (current(generation)) {
        state.submitting = false;
        updateControls();
        schedule(); /* GET reconciliation only, never resubmit. */
      }
    }
  };
  const takeInvitationFragment = () => {
    const fragment = window.location.hash;
    if (!fragment) return;
    // Synchronous history removal precedes all network requests and awaits.
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}`,
    );
    const invitation = new URLSearchParams(fragment.slice(1)).get("invite");
    if (id(invitation) && /^[A-Za-z0-9_-]{22,256}$/.test(invitation)) {
      state.invitation = invitation;
      nodes["enroll-form"].hidden = false;
    }
  };
  listen(nodes["sign-in"], "click", () => void ceremony(false));
  listen(nodes["enroll-form"], "submit", (event) => {
    event.preventDefault();
    if (state.invitation && nodes["device-label"].value.trim())
      void ceremony(true);
  });
  listen(nodes["thread-form"], "submit", (event) => {
    event.preventDefault();
    void selectThread(nodes["thread-id"].value.trim());
  });
  listen(nodes["conversation-choice"], "change", () => {
    if (nodes["conversation-choice"].value)
      void selectThread(nodes["conversation-choice"].value);
  });
  listen(nodes.refresh, "click", () => void refresh());
  listen(nodes.continue, "click", () => void sendContinue());
  listen(
    nodes["invite-device"],
    "click",
    () => void management({ action: "invite" }),
  );
  listen(nodes["copy-invitation"], "click", async () => {
    try {
      if (nodes["invitation-result"].hidden) return;
      await window.navigator.clipboard.writeText(
        nodes["invitation-link"].value,
      );
      say("feedback", t("message.invitationCopied"));
    } catch {
      nodes["invitation-link"].select();
      say("feedback", t("message.copyInvitation"));
    }
  });
  listen(nodes.logout, "click", async () => {
    if (!state.session || state.authBusy || state.submitting) return;
    state.authBusy = true;
    updateControls();
    let confirmed = false;
    try {
      await request("/session/logout", "POST", {});
      confirmed = true;
    } catch {
      /* Do not claim server revocation without an acknowledgement. */
    }
    resetSession(
      confirmed ? t("message.signedOut") : t("message.signOutUncertain"),
    );
  });
  const activityChanged = () => {
    clearTimer("poll");
    if (!isActive()) {
      invalidateView();
      if (
        state.session &&
        state.threadId &&
        !state.operations.has(state.threadId)
      )
        say("action-message", t("message.focusRefresh"));
      updateControls();
    } else if (state.session && state.threadId) void refresh();
  };
  listen(document, "visibilitychange", activityChanged);
  listen(window, "blur", activityChanged);
  listen(window, "focus", activityChanged);
  const start = async () => {
    if (state.started || state.destroyed) return;
    state.started = true;
    takeInvitationFragment();
    updateControls();
    try {
      if (!i18n || typeof i18n.init !== "function")
        throw new RequestFailure("interface_unavailable");
      const resources = await request(
        "/remote/locales",
        "GET",
        undefined,
        false,
      );
      if (!plain(resources.en?.translation?.ownerRemoteConsole))
        throw new RequestFailure("interface_unavailable");
      const requestedLanguage =
        options.language ||
        window.navigator.languages?.[0] ||
        window.navigator.language ||
        "en";
      const language = /^zh-(TW|HK|Hant)/i.test(requestedLanguage)
        ? "zh-TW"
        : /^zh/i.test(requestedLanguage)
          ? "zh"
          : /^ja/i.test(requestedLanguage)
            ? "ja"
            : "en";
      await i18n.init({
        resources,
        lng: language,
        fallbackLng: "en",
        supportedLngs: ["en", "zh", "zh-TW", "ja"],
        load: "currentOnly",
        interpolation: { escapeValue: false },
        returnNull: false,
      });
      if (state.destroyed) return;
      t = (key, values) => i18n.t(`ownerRemoteConsole.${key}`, values);
      document.documentElement.lang = language;
      document.title = t("page.title");
      for (const node of root.querySelectorAll("[data-i18n]"))
        node.textContent = t(node.dataset.i18n);
      for (const node of root.querySelectorAll("[data-i18n-placeholder]"))
        node.setAttribute("placeholder", t(node.dataset.i18nPlaceholder));
      for (const node of root.querySelectorAll("[data-i18n-aria-label]"))
        node.setAttribute("aria-label", t(node.dataset.i18nAriaLabel));
      state.ready = true;
      updateControls();
      if (state.invitation) say("feedback", t("message.invitationReceived"));
      const session = await request("/session", "GET", undefined, false);
      if (!state.destroyed) await activateSession(session);
    } catch {
      if (!state.destroyed) {
        if (state.ready) say("connection-state", t("status.notConnected"));
        else
          say(
            "feedback",
            "The local interface could not be loaded safely. Reload this page; no action was sent.",
          );
        nodes["enroll-form"].hidden = !state.invitation;
        updateControls();
      }
    }
  };
  const destroy = () => {
    state.destroyed = true;
    state.generation++;
    state.invitation = null;
    invalidateView();
    clearTimer("poll");
    clearInvitation();
    for (const controller of state.requests) controller.abort();
    state.requests.clear();
    for (const remove of state.listeners) remove();
    state.listeners.length = 0;
  };
  return Object.freeze({ start, destroy, refresh, selectThread });
}
if (typeof document !== "undefined") {
  const root = document.querySelector(
    "#owner-remote-console[data-owner-remote-auto]",
  );
  if (root) void mountOwnerRemoteConsole(root).start();
}
