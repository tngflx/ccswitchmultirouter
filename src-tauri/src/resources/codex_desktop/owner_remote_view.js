// Read-only owner-view foundation. This is not an authenticated web endpoint.
// The native host must pin its verified CDP endpoint/target to the opaque view
// reference before a future remote transport can authorize any continuation.
const codexOwnerRemoteViewLimits = Object.freeze({
  turns: 20,
  itemsPerTurn: 40,
  items: 120,
  partsPerItem: 20,
  textPerItem: 4096,
  totalText: 32768,
  references: 32,
  concurrentReads: 4,
  referenceLifetimeMs: 30000,
  sourceReadTimeoutMs: 5000,
});
// Keep only ephemeral references in this installation's closure. Renderer
// replacement invalidates them without affecting durable continuation evidence.
const codexOwnerRemoteViewReferences = new Map();
const codexOwnerRemoteViewReads = new Map();
const codexOwnerRemoteOwnData = (value, key) => {
  if (!value || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor && !Object.hasOwn(descriptor, "value"))
    throw new Error("owner_remote_unreadable_field");
  return descriptor?.value;
};
const codexOwnerRemoteArrayLength = (value) => {
  if (!Array.isArray(value)) return null;
  const length = codexOwnerRemoteOwnData(value, "length");
  if (!Number.isSafeInteger(length) || length < 0)
    throw new Error("owner_remote_unreadable_array");
  return length;
};
const codexOwnerRemoteId = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 256 &&
  value === value.trim() &&
  !/[\u0000-\u0020\u007f]/.test(value)
    ? value
    : null;
const codexOwnerRemoteModel = (value) =>
  typeof codexPickerModelIdentityIsSafe === "function" &&
  codexPickerModelIdentityIsSafe(value) &&
  value.trim() === value &&
  value.toLowerCase() !== "unknown"
    ? value
    : null;
const codexOwnerRemoteUnavailable = (reason) => ({
  kind: "unavailable",
  reason,
});
const codexOwnerRemoteEpoch = () => ({
  runtimeGeneration: codexOwnerRemoteOwnData(state, "runtimeGeneration"),
  catalogPayload: codexOwnerRemoteOwnData(state, "payload"),
});
const codexOwnerRemoteEpochIsCurrent = (epoch) =>
  continuationInstallationIsCurrent() &&
  Number.isSafeInteger(epoch.runtimeGeneration) &&
  epoch.runtimeGeneration > 0 &&
  codexOwnerRemoteOwnData(state, "runtimeGeneration") ===
    epoch.runtimeGeneration &&
  codexOwnerRemoteOwnData(state, "payload") === epoch.catalogPayload;
const codexOwnerRemoteSourceIsCurrent = (epoch, client, request) =>
  codexOwnerRemoteEpochIsCurrent(epoch) &&
  codexContinuationClientIsCurrent(client) &&
  codexVerifiedAppServerOriginalRequest(
    client,
    codexContinuationRequestPatchVersion,
  ) === request;
const codexOwnerRemoteToolStatus = (value) => {
  if (value === "inProgress") return "active";
  return ["completed", "failed", "declined", "interrupted"].includes(value)
    ? value
    : "unknown";
};
const codexOwnerRemoteThreadStatus = (thread) => {
  const source = codexOwnerRemoteOwnData(thread, "status");
  const type = codexOwnerRemoteOwnData(source, "type");
  const flags = codexOwnerRemoteOwnData(source, "activeFlags");
  const flagCount = codexOwnerRemoteArrayLength(flags);
  if (flags !== undefined && flagCount === null) return "unknown";
  if (flagCount) {
    for (let index = 0; index < Math.min(flagCount, 8); index += 1) {
      const flag = codexOwnerRemoteOwnData(flags, String(index));
      if (flag === "waitingOnApproval" || flag === "waitingOnUserInput")
        return "waiting";
    }
    return "unknown";
  }
  for (const key of [
    "pendingApproval",
    "pendingApprovals",
    "pendingOperation",
    "pendingOperations",
    "pendingRequests",
    "waitingOnApproval",
    "waitingOnUserInput",
  ]) {
    const pending = codexOwnerRemoteOwnData(thread, key);
    if (pending === undefined || pending === null || pending === false)
      continue;
    const count = codexOwnerRemoteArrayLength(pending);
    if (count === 0) continue;
    return "waiting";
  }
  // Share the owner executor's pending-state proof; display metadata cannot
  // turn an absent/unknown pending signal into an affirmative idle claim.
  if (!codexOwnerContinuationPendingStateIsClear(thread)) return "unknown";
  if (type === "idle") return "idle";
  if (type === "active") return "active";
  if (type === "systemError") return "error";
  return "unknown";
};
// These are the protocol's bounded history APIs. Never fall back to
// thread/read(includeTurns:true) when an installed client lacks pagination.
// Page sizes bound source item counts, not arbitrary message byte lengths; the
// native adapter must independently cap its CDP frames and response bodies.
const codexOwnerRemotePendingFields = Object.freeze([
  "pendingApproval",
  "pendingApprovals",
  "pendingOperation",
  "pendingOperations",
  "pendingRequests",
  "waitingOnApproval",
  "waitingOnUserInput",
]);
const codexOwnerRemoteThreadMetadata = (thread) => {
  const metadata = {};
  for (const key of [
    "id",
    "model",
    "modelProvider",
    "status",
    ...codexOwnerRemotePendingFields,
  ]) {
    const value = codexOwnerRemoteOwnData(thread, key);
    if (value !== undefined) metadata[key] = value;
  }
  return metadata;
};
const codexOwnerRemoteMetadataSignature = (thread) => {
  const status = codexOwnerRemoteOwnData(thread, "status");
  const rawType = codexOwnerRemoteOwnData(status, "type");
  const type = ["idle", "active", "systemError", "notLoaded"].includes(rawType)
    ? rawType
    : "unknown";
  const flags = codexOwnerRemoteOwnData(status, "activeFlags");
  const flagCount = codexOwnerRemoteArrayLength(flags);
  if (flagCount !== null && flagCount > 8)
    throw new Error("owner_remote_unreadable_status");
  const projectedFlags = [];
  if (flagCount !== null) {
    for (let index = 0; index < flagCount; index += 1) {
      const flag = codexOwnerRemoteOwnData(flags, String(index));
      projectedFlags.push(
        ["waitingOnApproval", "waitingOnUserInput"].includes(flag)
          ? flag
          : "unknown",
      );
    }
  }
  const pending = codexOwnerRemotePendingFields.map((key) => {
    const value = codexOwnerRemoteOwnData(thread, key);
    if (value === undefined) return "absent";
    if (value === null || typeof value === "boolean") return value;
    const count = codexOwnerRemoteArrayLength(value);
    return count === null ? "unknown" : count === 0 ? "empty" : "pending";
  });
  return JSON.stringify([
    codexOwnerRemoteId(codexOwnerRemoteOwnData(thread, "id")),
    codexOwnerRemoteModel(codexOwnerRemoteOwnData(thread, "model")),
    codexOwnerRemoteId(codexOwnerRemoteOwnData(thread, "modelProvider")),
    type,
    flags === undefined
      ? "absent"
      : flagCount === null
        ? "unknown"
        : projectedFlags,
    pending,
  ]);
};
const codexOwnerRemoteFailureCategories = Object.freeze({
  serverOverloaded: "server_overloaded",
  usageLimitExceeded: "usage_limit",
  rateLimitExceeded: "rate_limit",
  internalServerError: "internal_server_error",
  unauthorized: "authentication_error",
  contextWindowExceeded: "context_length_exceeded",
  badRequest: "invalid_request_error",
  modelNotFound: "invalid_request_error",
});
const codexOwnerRemoteFailureVariants = Object.freeze({
  httpConnectionFailed: "connection_error",
  responseStreamConnectionFailed: "connection_error",
  responseStreamDisconnected: "connection_error",
  responseTooManyFailedAttempts: "connection_error",
});
const codexOwnerRemoteFailureCategoryValues = new Set([
  ...Object.values(codexOwnerRemoteFailureCategories),
  "connection_error",
  "unknown",
]);
const codexOwnerRemoteDataField = (value, key) => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { present: false };
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return { present: false };
  if (!Object.hasOwn(descriptor, "value"))
    return { present: true, unsafe: true };
  return { present: true, value: descriptor.value };
};
const codexOwnerRemoteFailureCategory = (turn) => {
  const status = codexOwnerRemoteDataField(turn, "status");
  if (!status.present || !["failed", "interrupted"].includes(status.value))
    return undefined;
  const projected = codexOwnerRemoteDataField(turn, "failure");
  if (projected.present && !projected.unsafe) {
    const category = codexOwnerRemoteDataField(projected.value, "category");
    return category.present &&
      typeof category.value === "string" &&
      codexOwnerRemoteFailureCategoryValues.has(category.value)
      ? { category: category.value }
      : { category: "unknown" };
  }
  if (projected.unsafe) return { category: "unknown" };
  const error = codexOwnerRemoteDataField(turn, "error");
  if (!error.present || error.unsafe) return { category: "unknown" };
  const info = codexOwnerRemoteDataField(error.value, "codexErrorInfo");
  if (!info.present || info.unsafe) return { category: "unknown" };
  if (typeof info.value === "string")
    return {
      category:
        Object.getOwnPropertyDescriptor(
          codexOwnerRemoteFailureCategories,
          info.value,
        )?.value || "unknown",
    };
  if (
    info.value &&
    typeof info.value === "object" &&
    !Array.isArray(info.value)
  ) {
    for (const key of Object.keys(codexOwnerRemoteFailureVariants)) {
      const variant = codexOwnerRemoteDataField(info.value, key);
      if (variant.present)
        return {
          category: variant.unsafe
            ? "unknown"
            : codexOwnerRemoteFailureVariants[key],
        };
    }
  }
  return { category: "unknown" };
};
const codexOwnerRemoteTurnMetadata = (turn) => {
  const items = codexOwnerRemoteOwnData(turn, "items");
  if (
    codexOwnerRemoteOwnData(turn, "itemsView") !== "notLoaded" ||
    codexOwnerRemoteArrayLength(items) !== 0
  )
    throw new Error("owner_remote_unbounded_history");
  const metadata = {};
  for (const key of ["id", "status"]) {
    const value = codexOwnerRemoteOwnData(turn, key);
    if (value !== undefined) metadata[key] = value;
  }
  const failure = codexOwnerRemoteFailureCategory(turn);
  if (failure) metadata.failure = failure;
  // Preserve an accessor descriptor as unavailable evidence for the shared
  // classifier, without invoking it or hiding it as an absent optional model.
  const model = Object.getOwnPropertyDescriptor(turn, "model");
  if (model) Object.defineProperty(metadata, "model", model);
  if (!codexOwnerRemoteId(metadata.id))
    throw new Error("owner_remote_unreadable_turn");
  return metadata;
};
const codexOwnerRemoteTurnModelSignature = (turn) => {
  const model = Object.getOwnPropertyDescriptor(turn, "model");
  return model && !Object.hasOwn(model, "value")
    ? "unreadable"
    : codexOwnerRemoteModel(model?.value);
};
const codexOwnerRemoteTurnSignature = (turn) =>
  turn
    ? JSON.stringify([
        codexOwnerRemoteOwnData(turn, "id"),
        ["completed", "failed", "interrupted", "inProgress"].includes(
          codexOwnerRemoteOwnData(turn, "status"),
        )
          ? codexOwnerRemoteOwnData(turn, "status")
          : "unknown",
        codexOwnerRemoteTurnModelSignature(turn),
        codexOwnerRemoteFailureCategory(turn)?.category || "none",
      ])
    : "empty";
const codexOwnerRemoteReadPage = (response, key, limit) => {
  const values = codexOwnerRemoteOwnData(response, key);
  const length = codexOwnerRemoteArrayLength(values);
  const nextCursor = codexOwnerRemoteOwnData(response, "nextCursor");
  if (
    length === null ||
    length > limit ||
    (nextCursor !== null &&
      !(
        typeof nextCursor === "string" &&
        nextCursor.length > 0 &&
        nextCursor.length <= 4096
      ))
  )
    throw new Error("owner_remote_unbounded_history");
  return { values, length, truncated: nextCursor !== null };
};
const readBoundedCodexOwnerRemoteThread = async (
  client,
  threadId,
  epoch,
  request,
  userActionEvidence,
) => {
  let expired = false;
  let userActionChanged = false;
  let timer;
  const ensureCurrent = () => {
    if (expired || !codexOwnerRemoteSourceIsCurrent(epoch, client, request))
      throw new Error("owner_remote_read_invalidated");
    // Viewing may continue read-only after a local action, but that action can
    // never be forgotten when deciding whether this multi-request view binds a
    // Continue. Check after every await, not only its eventual wall-clock time.
    if (
      userActionEvidence &&
      !codexOwnerUserActionEvidenceIsCurrent(threadId, userActionEvidence)
    )
      userActionChanged = true;
  };
  const readPage = async (method, params, key, limit) => {
    ensureCurrent();
    const result = await readOwnedCodexContinuationRequest(
      client,
      method,
      params,
    );
    ensureCurrent();
    if (result.request !== request)
      throw new Error("owner_remote_read_invalidated");
    return codexOwnerRemoteReadPage(result.response, key, limit);
  };
  const readMetadata = async () => {
    ensureCurrent();
    const result = await readExactCodexContinuationThread(
      client,
      threadId,
      false,
    );
    ensureCurrent();
    if (result.request !== request)
      throw new Error("owner_remote_read_invalidated");
    return codexOwnerRemoteThreadMetadata(result.thread);
  };
  const readTurns = (limit) =>
    readPage(
      "thread/turns/list",
      {
        threadId,
        cursor: null,
        limit,
        sortDirection: "desc",
        itemsView: "notLoaded",
      },
      "data",
      limit,
    );
  const read = async () => {
    const thread = await readMetadata();
    const signature = codexOwnerRemoteMetadataSignature(thread);
    const page = await readTurns(codexOwnerRemoteViewLimits.turns);
    const turns = [];
    const turnIds = new Set();
    let remainingItems = codexOwnerRemoteViewLimits.items;
    let truncated = page.truncated;
    for (let index = 0; index < page.length; index += 1) {
      const turn = codexOwnerRemoteTurnMetadata(
        codexOwnerRemoteOwnData(page.values, String(index)),
      );
      if (turnIds.has(turn.id)) throw new Error("owner_remote_duplicate_turn");
      turnIds.add(turn.id);
      const limit = Math.min(
        codexOwnerRemoteViewLimits.itemsPerTurn,
        remainingItems,
      );
      const items = [];
      let itemsTruncated = limit === 0;
      if (limit > 0) {
        const itemPage = await readPage(
          "thread/items/list",
          {
            threadId,
            turnId: turn.id,
            cursor: null,
            limit,
            sortDirection: "desc",
            deferOutput: {},
          },
          "data",
          limit,
        );
        itemsTruncated = itemPage.truncated;
        for (let itemIndex = 0; itemIndex < itemPage.length; itemIndex += 1) {
          const entry = codexOwnerRemoteOwnData(
            itemPage.values,
            String(itemIndex),
          );
          if (codexOwnerRemoteOwnData(entry, "turnId") !== turn.id)
            throw new Error("owner_remote_different_turn");
          const item = codexOwnerRemoteOwnData(entry, "item");
          if (!item || typeof item !== "object" || Array.isArray(item))
            throw new Error("owner_remote_unreadable_item");
          items.push(item);
        }
        remainingItems -= itemPage.length;
      }
      truncated ||= itemsTruncated;
      turn.items = items.reverse();
      turn.itemsTruncated = itemsTruncated;
      turns.push(turn);
    }
    // No multi-request snapshot is presumed atomic. Check the exact latest turn
    // and routing/pending metadata again, using bounded metadata-only reads.
    const currentThread = await readMetadata();
    const currentTurns = await readTurns(1);
    const currentTurn = currentTurns.length
      ? codexOwnerRemoteTurnMetadata(
          codexOwnerRemoteOwnData(currentTurns.values, "0"),
        )
      : null;
    if (
      signature !== codexOwnerRemoteMetadataSignature(currentThread) ||
      codexOwnerRemoteTurnSignature(turns[0]) !==
        codexOwnerRemoteTurnSignature(currentTurn)
    )
      throw new Error("owner_remote_snapshot_changed");
    ensureCurrent();
    return {
      thread: { ...thread, turns: turns.reverse() },
      request,
      truncated,
      userActionChanged,
    };
  };
  try {
    return await Promise.race([
      read(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(new Error("owner_remote_read_timed_out"));
        }, codexOwnerRemoteViewLimits.sourceReadTimeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};
const codexOwnerRemoteProjectThread = (thread, threadId, observedAtMs) => {
  const budget = { text: codexOwnerRemoteViewLimits.totalText, items: 0 };
  let truncated = false;
  const readText = (value) => {
    if (typeof value !== "string") return undefined;
    const length = Math.min(
      value.length,
      codexOwnerRemoteViewLimits.textPerItem,
      budget.text,
    );
    if (length < value.length) truncated = true;
    budget.text -= length;
    return value.slice(0, length);
  };
  const readTextParts = (value, userContent) => {
    const length = codexOwnerRemoteArrayLength(value);
    if (length === null) return undefined;
    const count = Math.min(length, codexOwnerRemoteViewLimits.partsPerItem);
    if (count < length) truncated = true;
    const parts = [];
    let remaining = codexOwnerRemoteViewLimits.textPerItem;
    for (let index = 0; index < count; index += 1) {
      const part = codexOwnerRemoteOwnData(value, String(index));
      const text = userContent
        ? codexOwnerRemoteOwnData(part, "type") === "text"
          ? codexOwnerRemoteOwnData(part, "text")
          : undefined
        : part;
      if (typeof text !== "string") continue;
      // Bound joined parts as a single item, including newline separators.
      const separator = parts.length ? "\n" : "";
      const available = Math.min(remaining, budget.text);
      if (available < separator.length + text.length) truncated = true;
      const piece = (separator + text).slice(0, available);
      remaining -= piece.length;
      budget.text -= piece.length;
      parts.push(piece);
      if (!remaining || !budget.text) break;
    }
    return parts.length ? parts.join("") : undefined;
  };
  const projectItem = (item) => {
    const id = codexOwnerRemoteId(codexOwnerRemoteOwnData(item, "id"));
    const type = codexOwnerRemoteOwnData(item, "type");
    if (type === "userMessage") {
      const text = readTextParts(
        codexOwnerRemoteOwnData(item, "content"),
        true,
      );
      return { id, type: "user", ...(text !== undefined ? { text } : {}) };
    }
    if (type === "agentMessage" || type === "plan") {
      const text = readText(codexOwnerRemoteOwnData(item, "text"));
      return {
        id,
        type: type === "agentMessage" ? "assistant" : "plan",
        ...(text !== undefined ? { text } : {}),
      };
    }
    if (type === "reasoning") {
      // Only the application's explicitly public summary field is admitted.
      // Never inspect content/text or recursively extract reasoning strings.
      const text = readTextParts(
        codexOwnerRemoteOwnData(item, "summary"),
        false,
      );
      return {
        id,
        type: "reasoning_summary",
        ...(text !== undefined ? { text } : {}),
      };
    }
    const tools = {
      commandExecution: "command",
      mcpToolCall: "tool",
      dynamicToolCall: "tool",
      collabAgentToolCall: "agent_tool",
      fileChange: "file_change",
      webSearch: "web_search",
      imageGeneration: "image_generation",
      contextCompaction: "context_compaction",
    };
    const projectedType =
      typeof type === "string"
        ? Object.getOwnPropertyDescriptor(tools, type)?.value
        : undefined;
    if (projectedType) {
      const status = codexOwnerRemoteToolStatus(
        codexOwnerRemoteOwnData(item, "status"),
      );
      const text =
        type === "commandExecution"
          ? readText(codexOwnerRemoteOwnData(item, "aggregatedOutput"))
          : undefined;
      return {
        id,
        type: projectedType,
        status,
        ...(text !== undefined ? { text } : {}),
      };
    }
    return { id, type: "unsupported", status: "unknown" };
  };
  const sourceTurns = codexOwnerRemoteOwnData(thread, "turns");
  const sourceLength = codexOwnerRemoteArrayLength(sourceTurns);
  const length = sourceLength ?? 0;
  const count = Math.min(length, codexOwnerRemoteViewLimits.turns);
  if (count < length) truncated = true;
  const turns = [];
  let latestTurnId = null;
  // Read only the bounded tail and allocate item/text budgets newest first.
  // Source pagination is already count-bounded; never crawl older pages,
  // resume a thread, or repair its cache here.
  for (let offset = 0; offset < count; offset += 1) {
    const turn = codexOwnerRemoteOwnData(
      sourceTurns,
      String(length - offset - 1),
    );
    const id = codexOwnerRemoteId(codexOwnerRemoteOwnData(turn, "id"));
    if (offset === 0) latestTurnId = id;
    const rawStatus = codexOwnerRemoteOwnData(turn, "status");
    const status = [
      "completed",
      "failed",
      "interrupted",
      "inProgress",
    ].includes(rawStatus)
      ? rawStatus
      : "unknown";
    const sourceItems = codexOwnerRemoteOwnData(turn, "items");
    const itemLength = codexOwnerRemoteArrayLength(sourceItems) ?? 0;
    const itemCount = Math.min(
      itemLength,
      codexOwnerRemoteViewLimits.itemsPerTurn,
      codexOwnerRemoteViewLimits.items - budget.items,
    );
    const items = [];
    for (let itemOffset = 0; itemOffset < itemCount; itemOffset += 1) {
      items.push(
        projectItem(
          codexOwnerRemoteOwnData(
            sourceItems,
            String(itemLength - itemOffset - 1),
          ),
        ),
      );
      budget.items += 1;
    }
    const turnTruncated =
      itemCount < itemLength ||
      codexOwnerRemoteOwnData(turn, "itemsTruncated") === true;
    if (turnTruncated) truncated = true;
    const failure = codexOwnerRemoteFailureCategory(turn);
    turns.push({
      id,
      status,
      items: items.reverse(),
      truncated: turnTruncated,
      ...(failure ? { failure } : {}),
    });
  }
  return {
    kind: "snapshot",
    threadId,
    observedAtMs,
    model: codexOwnerRemoteModel(codexOwnerRemoteOwnData(thread, "model")),
    latestTurnId,
    status: codexOwnerRemoteThreadStatus(thread),
    currentDisplay: "unavailable",
    historyMode: "bounded_recent_snapshot",
    olderContentAvailable: false,
    turns: turns.reverse(),
    truncated,
    viewReference: null,
    continueBlocker: null,
  };
};
const codexOwnerRemoteViewReferenceIsCurrent = (id, binding) => {
  if (typeof id !== "string" || !binding) return false;
  if (codexOwnerRemoteViewReferences.get(id) !== binding) return false;
  try {
    const now = Date.now();
    return (
      now >= binding.observedAtMs &&
      now < binding.expiresAtMs &&
      codexOwnerRemoteSourceIsCurrent(
        binding,
        binding.client,
        binding.request,
      ) &&
      binding.userActionEvidence !== null &&
      typeof codexOwnerUserActionEvidenceIsCurrent === "function" &&
      codexOwnerUserActionEvidenceIsCurrent(
        binding.threadId,
        binding.userActionEvidence,
      )
    );
  } catch {
    return false;
  }
};
const resolveCodexOwnerRemoteViewReference = (id) => {
  if (typeof id !== "string") return null;
  const binding = codexOwnerRemoteViewReferences.get(id);
  if (!codexOwnerRemoteViewReferenceIsCurrent(id, binding)) {
    codexOwnerRemoteViewReferences.delete(id);
    return null;
  }
  return binding;
};
const codexOwnerRemoteCreateReference = (binding) => {
  try {
    if (
      typeof crypto === "undefined" ||
      typeof crypto.getRandomValues !== "function"
    )
      return null;
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const id = `view-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    if (codexOwnerRemoteViewReferences.has(id)) return null;
    for (const [existing, value] of codexOwnerRemoteViewReferences) {
      if (!codexOwnerRemoteViewReferenceIsCurrent(existing, value))
        codexOwnerRemoteViewReferences.delete(existing);
    }
    while (
      codexOwnerRemoteViewReferences.size >=
      codexOwnerRemoteViewLimits.references
    )
      codexOwnerRemoteViewReferences.delete(
        codexOwnerRemoteViewReferences.keys().next().value,
      );
    codexOwnerRemoteViewReferences.set(id, Object.freeze(binding));
    return id;
  } catch {
    return null;
  }
};
const readCodexOwnerRemoteView = async (threadId) => {
  const epoch = codexOwnerRemoteEpoch();
  if (!codexOwnerRemoteEpochIsCurrent(epoch))
    return codexOwnerRemoteUnavailable("runtime_unavailable");
  const client = codexContinuationLocalClients()[0];
  if (!client) return codexOwnerRemoteUnavailable("runtime_unavailable");
  const request = codexVerifiedAppServerOriginalRequest(
    client,
    codexContinuationRequestPatchVersion,
  );
  const observedAtMs = Date.now();
  // Action identity is captured before the await. Wall time orders neither
  // same-tick actions nor actions occurring during a clock rollback/catch-up.
  let userActionEvidence = null;
  try {
    if (typeof captureCodexOwnerUserActionEvidence === "function")
      userActionEvidence = captureCodexOwnerUserActionEvidence(threadId);
  } catch {}
  let result;
  try {
    result = await readBoundedCodexOwnerRemoteThread(
      client,
      threadId,
      epoch,
      request,
      userActionEvidence,
    );
  } catch {
    return codexOwnerRemoteUnavailable(
      codexOwnerRemoteSourceIsCurrent(epoch, client, request)
        ? "thread_unavailable"
        : "ownership_changed",
    );
  }
  if (
    !codexOwnerRemoteSourceIsCurrent(epoch, client, request) ||
    result.request !== request
  )
    return codexOwnerRemoteUnavailable("ownership_changed");
  try {
    const thread = result.thread;
    const view = codexOwnerRemoteProjectThread(thread, threadId, observedAtMs);
    view.truncated ||= result.truncated;
    const expectedModelProvider = codexOwnerRemoteId(
      codexOwnerRemoteOwnData(thread, "modelProvider"),
    );
    let blocker = null;
    if (!view.latestTurnId) blocker = "latest_turn_unavailable";
    else if (!view.model) blocker = "model_unavailable";
    else if (!expectedModelProvider) blocker = "provider_unavailable";
    const binding = {
      ...epoch,
      threadId,
      latestTurnId: view.latestTurnId,
      expectedModel: view.model,
      expectedModelProvider,
      observedAtMs,
      userActionEvidence,
      expiresAtMs: Date.now() + codexOwnerRemoteViewLimits.referenceLifetimeMs,
      client,
      request,
    };
    if (!blocker) {
      // The common executor owns eligibility; error display is not an idle
      // inference and cannot become a competing authorization rule here.
      const eligibility = classifyCodexOwnerContinuationThread(thread, binding);
      if (!eligibility.ready) blocker = eligibility.blocker;
    }
    if (!blocker && !userActionEvidence) blocker = "user_action_unavailable";
    if (
      !blocker &&
      (result.userActionChanged ||
        typeof codexOwnerUserActionEvidenceIsCurrent !== "function" ||
        !codexOwnerUserActionEvidenceIsCurrent(threadId, userActionEvidence))
    )
      blocker = "user_action_changed";
    if (!codexOwnerRemoteSourceIsCurrent(epoch, client, request))
      return codexOwnerRemoteUnavailable("ownership_changed");
    if (!blocker) {
      view.viewReference = codexOwnerRemoteCreateReference(binding);
      if (!view.viewReference) blocker = "reference_unavailable";
    }
    view.continueBlocker = blocker;
    return view;
  } catch {
    return codexOwnerRemoteUnavailable("snapshot_unreadable");
  }
};
state.readCodexOwnerRemoteView = (selectedThreadId) => {
  const threadId = codexOwnerRemoteId(selectedThreadId);
  if (!threadId)
    return Promise.resolve(codexOwnerRemoteUnavailable("invalid_thread"));
  const existing = codexOwnerRemoteViewReads.get(threadId);
  if (existing) return existing;
  if (
    codexOwnerRemoteViewReads.size >= codexOwnerRemoteViewLimits.concurrentReads
  )
    return Promise.resolve(codexOwnerRemoteUnavailable("read_busy"));
  const read = readCodexOwnerRemoteView(threadId)
    .catch(() => codexOwnerRemoteUnavailable("runtime_unavailable"))
    .finally(() => {
      if (codexOwnerRemoteViewReads.get(threadId) === read)
        codexOwnerRemoteViewReads.delete(threadId);
    });
  codexOwnerRemoteViewReads.set(threadId, read);
  return read;
};

// Local native bridge metadata only. Never expose this method or its provider
// binding through the future website; private runtime/client/action objects stay
// in the closure. A stale reference has no usable inspection projection.
state.inspectCodexOwnerRemoteViewReference = (id) => {
  const binding = resolveCodexOwnerRemoteViewReference(id);
  return binding
    ? {
        threadId: binding.threadId,
        baseTurnId: binding.latestTurnId,
        expectedModel: binding.expectedModel,
        expectedModelProvider: binding.expectedModelProvider,
        runtimeGeneration: binding.runtimeGeneration,
        observedAtMs: binding.observedAtMs,
      }
    : null;
};

const codexOwnerRemoteConversationsKey = Symbol("owner-conversations");
const listCodexOwnerRemoteConversations = async () => {
  const epoch = codexOwnerRemoteEpoch();
  if (!codexOwnerRemoteEpochIsCurrent(epoch))
    return codexOwnerRemoteUnavailable("runtime_unavailable");
  const client = codexContinuationLocalClients()[0];
  if (!client) return codexOwnerRemoteUnavailable("runtime_unavailable");
  const request = codexVerifiedAppServerOriginalRequest(
    client,
    codexContinuationRequestPatchVersion,
  );
  try {
    const result = await readOwnedCodexContinuationRequest(
      client,
      "thread/list",
      {
        cursor: null,
        limit: codexOwnerRemoteViewLimits.turns,
        sortKey: "updated_at",
        sortDirection: "desc",
        archived: false,
        sourceKinds: ["appServer"],
      },
    );
    if (
      !codexOwnerRemoteSourceIsCurrent(epoch, client, request) ||
      result.request !== request
    )
      return codexOwnerRemoteUnavailable("ownership_changed");
    const page = codexOwnerRemoteReadPage(
      result.response,
      "data",
      codexOwnerRemoteViewLimits.turns,
    );
    const conversations = [];
    const ids = new Set();
    for (let index = 0; index < page.length; index += 1) {
      const thread = codexOwnerRemoteOwnData(page.values, String(index));
      const threadId = codexOwnerRemoteId(
        codexOwnerRemoteOwnData(thread, "id"),
      );
      const rawTitle = codexOwnerRemoteOwnData(thread, "name");
      if (
        !threadId ||
        ids.has(threadId) ||
        (rawTitle !== undefined &&
          rawTitle !== null &&
          typeof rawTitle !== "string")
      )
        throw new Error("owner_remote_unreadable_conversation");
      ids.add(threadId);
      const title =
        typeof rawTitle === "string"
          ? rawTitle
              .slice(0, 160)
              .replace(/[\u0000-\u001f\u007f]/g, " ")
              .trim() || null
          : null;
      conversations.push({ threadId, title });
    }
    if (!codexOwnerRemoteSourceIsCurrent(epoch, client, request))
      return codexOwnerRemoteUnavailable("ownership_changed");
    return {
      kind: "conversations",
      currentDisplay: "unavailable",
      conversations,
      truncated: page.truncated,
    };
  } catch {
    return codexOwnerRemoteUnavailable(
      codexOwnerRemoteSourceIsCurrent(epoch, client, request)
        ? "conversations_unavailable"
        : "ownership_changed",
    );
  }
};
state.listCodexOwnerRemoteConversations = () => {
  const existing = codexOwnerRemoteViewReads.get(
    codexOwnerRemoteConversationsKey,
  );
  if (existing) return existing;
  if (
    codexOwnerRemoteViewReads.size >= codexOwnerRemoteViewLimits.concurrentReads
  )
    return Promise.resolve(codexOwnerRemoteUnavailable("read_busy"));
  const read = listCodexOwnerRemoteConversations()
    .catch(() => codexOwnerRemoteUnavailable("runtime_unavailable"))
    .finally(() => {
      if (
        codexOwnerRemoteViewReads.get(codexOwnerRemoteConversationsKey) === read
      )
        codexOwnerRemoteViewReads.delete(codexOwnerRemoteConversationsKey);
    });
  codexOwnerRemoteViewReads.set(codexOwnerRemoteConversationsKey, read);
  return read;
};
