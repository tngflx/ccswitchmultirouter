// Both automatic recovery and an explicit owner Continue address an exact
// thread through its owned local app-server client. Neither edits a composer
// or applies picker defaults. Owner preparation is not network authorization.
const codexContinuationIntents = Object.freeze({
  AutoRecovery: "AutoRecovery",
  UsageLimitResume: "UsageLimitResume",
  OwnerContinue: "OwnerContinue",
});
const codexContinuationOwnData = (value, key) => {
  if (!value || (typeof value !== "object" && typeof value !== "function"))
    return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, "value")
    ? descriptor.value
    : undefined;
};
const continuationStorageKey = "ccswitch-codex-continuations-v1";
const continuationActionStorageKey = "ccswitch-codex-user-turn-actions-v1";
// The Rust terminal classifier owns this embedded policy. The renderer runs
// without a Rust callback while validating an exact failed thread.
const continuationTerminalErrorPolicy = __CCSWITCH_TERMINAL_ERROR_POLICY__;
if (
  continuationTerminalErrorPolicy.schemaVersion !== 1 ||
  !continuationTerminalErrorPolicy.categories.length ||
  !continuationTerminalErrorPolicy.cancelledCode ||
  !continuationTerminalErrorPolicy.nonRetryable?.categoryCode ||
  !continuationTerminalErrorPolicy.nonRetryable?.retryablePaths?.length
)
  throw new Error("Invalid embedded terminal-error policy");
const continuationTerminalErrorSeparators = new Set(
  continuationTerminalErrorPolicy.ignoredSeparators,
);
const normalizeContinuationTerminalError = (value) =>
  [...value]
    .filter((char) => !continuationTerminalErrorSeparators.has(char))
    .join("")
    .replace(/[A-Z]/g, (char) => char.toLowerCase());
const continuationTerminalErrorCategories =
  continuationTerminalErrorPolicy.categories.map((category) => {
    const markers = category.markers.map(normalizeContinuationTerminalError);
    const serializedMarkers = (
      category.serializedMarkers || category.markers
    ).map(normalizeContinuationTerminalError);
    if (
      !category.code ||
      !markers.length ||
      !serializedMarkers.length ||
      [...markers, ...serializedMarkers].some((marker) => !marker)
    )
      throw new Error("Invalid embedded terminal-error category");
    return { code: category.code, markers, serializedMarkers };
  });
const continuationTerminalErrorAtPath = (payload, pointer) => {
  if (!pointer) return payload;
  return pointer
    .slice(1)
    .split("/")
    .reduce(
      (value, part) => value?.[part.replace(/~1/g, "/").replace(/~0/g, "~")],
      payload,
    );
};
const continuationTemporaryUsageLimitPolicy =
  continuationTerminalErrorPolicy.temporaryUsageLimit;
if (
  !continuationTemporaryUsageLimitPolicy ||
  !continuationTerminalErrorCategories.some(
    (category) =>
      category.code === continuationTemporaryUsageLimitPolicy.categoryCode,
  ) ||
  !continuationTemporaryUsageLimitPolicy.retryMessagePaths?.length
)
  throw new Error("Invalid embedded temporary usage-limit policy");
const continuationTemporaryUsageLimitMarkers = {};
for (const key of [
  "usageMarkers",
  "retryMarkers",
  "retryDenialMarkers",
  "hardLimitMarkers",
]) {
  const markers = continuationTemporaryUsageLimitPolicy[key]?.map(
    normalizeContinuationTerminalError,
  );
  if (!markers?.length || markers.some((marker) => !marker))
    throw new Error("Invalid embedded temporary usage-limit markers");
  continuationTemporaryUsageLimitMarkers[key] = markers;
}
const continuationCodexPlanCreditSuggestion =
  normalizeContinuationTerminalError("to purchase more credits");
const codexContinuationTerminalErrorClassification = (
  eventName,
  payload,
  { ignoreCodexPlanCreditSuggestion = false } = {},
) => {
  if (continuationTerminalErrorPolicy.cancelledEvents.includes(eventName))
    return {
      terminalCode: continuationTerminalErrorPolicy.cancelledCode,
      temporaryUsageLimit: false,
    };
  // Match each field separately, so neighboring fields cannot form a marker.
  const summary = continuationTerminalErrorPolicy.summaryPaths
    .map((pointer) => continuationTerminalErrorAtPath(payload, pointer))
    .filter((value) => typeof value === "string")
    .map(normalizeContinuationTerminalError);
  const serialized = continuationTerminalErrorPolicy.serializedPaths
    .map((pointer) => continuationTerminalErrorAtPath(payload, pointer))
    .filter((value) => value !== undefined)
    .map((value) => normalizeContinuationTerminalError(JSON.stringify(value)));
  const errorDetails = [...summary, ...serialized];
  const matchesMarker = (values, markers) =>
    values.some((value) => markers.some((marker) => value.includes(marker)));
  const retryMessages = continuationTemporaryUsageLimitPolicy.retryMessagePaths
    .map((pointer) => continuationTerminalErrorAtPath(payload, pointer))
    .filter((value) => typeof value === "string")
    .map(normalizeContinuationTerminalError);
  // Read the shared known error paths only. Request/debug metadata and string
  // "false" are not an explicit provider decision about this failed turn.
  const explicitRetryDenial =
    continuationTerminalErrorPolicy.nonRetryable.retryablePaths.some(
      (pointer) => continuationTerminalErrorAtPath(payload, pointer) === false,
    ) ||
    matchesMarker(
      summary,
      continuationTemporaryUsageLimitMarkers.retryDenialMarkers,
    );
  const temporaryUsageLimit =
    !explicitRetryDenial &&
    !matchesMarker(
      errorDetails,
      continuationTemporaryUsageLimitMarkers.retryDenialMarkers,
    ) &&
    matchesMarker(
      summary,
      continuationTemporaryUsageLimitMarkers.usageMarkers,
    ) &&
    matchesMarker(
      retryMessages,
      continuationTemporaryUsageLimitMarkers.retryMarkers,
    ) &&
    !matchesMarker(
      ignoreCodexPlanCreditSuggestion
        ? errorDetails.map((value) =>
            value.replace(continuationCodexPlanCreditSuggestion, ""),
          )
        : errorDetails,
      continuationTemporaryUsageLimitMarkers.hardLimitMarkers,
    );
  const terminalCode =
    continuationTerminalErrorCategories.find(
      (category) =>
        !(
          temporaryUsageLimit &&
          category.code === continuationTemporaryUsageLimitPolicy.categoryCode
        ) &&
        (matchesMarker(summary, category.markers) ||
          matchesMarker(serialized, category.serializedMarkers)),
    )?.code ||
    (explicitRetryDenial
      ? continuationTerminalErrorPolicy.nonRetryable.categoryCode
      : null);
  return { terminalCode, temporaryUsageLimit };
};
const codexContinuationTerminalErrorCode = (eventName, payload) =>
  codexContinuationTerminalErrorClassification(eventName, payload).terminalCode;
const codexPlanLimitWithCreditSuggestion =
  /^You['’]ve hit your usage limit\. (?:Upgrade to Pro \(https:\/\/chatgpt\.com\/explore\/pro\), visit |Visit )https:\/\/chatgpt\.com\/settings\/usage to purchase more credits or try again (?:later|at [^.\r\n]+)\.$/;
const codexContinuationIsTemporaryUsageLimit = (error) => {
  // Codex reports usageLimitExceeded for plan resets and hard quota failures.
  // Only its plan-limit message with a retry offer can exempt the purchase
  // suggestion from the ordinary hard-limit checks.
  const message = codexContinuationOwnData(error, "message");
  const ignoreCodexPlanCreditSuggestion =
    codexContinuationOwnData(error, "codexErrorInfo") ===
      "usageLimitExceeded" &&
    typeof message === "string" &&
    codexPlanLimitWithCreditSuggestion.test(message);
  const { temporaryUsageLimit, terminalCode } =
    codexContinuationTerminalErrorClassification(
      "",
      { error },
      { ignoreCodexPlanCreditSuggestion },
    );
  return temporaryUsageLimit && !terminalCode;
};
// One canonical persisted action document. Explicit installation upgrades legacy
// records before owner references can exist; reads and action writes never try
// to repair an unknown/old document after that boundary. Every canonical write
// gets a new document revision, so an honest stale read/modify/write cannot
// restore the revision captured by an owner view (even for another thread).
const codexContinuationUserActionMethods = Object.freeze([
  "turn/start",
  "turn/interrupt",
  "thread/rollback",
  "thread/revert",
  "thread/archive",
]);
const createCodexUserActionId = () => {
  try {
    if (
      typeof crypto === "undefined" ||
      typeof crypto.getRandomValues !== "function"
    )
      return null;
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  } catch {
    // Never substitute Math.random, timestamps, or a copied revision.
    return null;
  }
};
const codexContinuationActionIdIsValid = (value) =>
  typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
const codexContinuationActionThreadIdIsValid = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 256 &&
  value === value.trim() &&
  !/[\u0000-\u0020\u007f]/.test(value);
const codexContinuationActionOwnFields = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Codex action evidence has an invalid object");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error("Codex action evidence has an invalid object");
  const fields = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string")
      throw new Error("Codex action evidence has an invalid field");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value"))
      throw new Error("Codex action evidence has an unreadable field");
    fields[key] = descriptor.value;
  }
  return fields;
};
const codexContinuationActionRecord = (value, allowUnidentified = false) => {
  const fields = codexContinuationActionOwnFields(value);
  const keys = Object.keys(fields);
  if (
    keys.some((key) => !["method", "atMs", "actionId"].includes(key)) ||
    !Object.hasOwn(fields, "method") ||
    !Object.hasOwn(fields, "atMs") ||
    !codexContinuationUserActionMethods.includes(fields.method) ||
    !Number.isSafeInteger(fields.atMs) ||
    fields.atMs <= 0 ||
    (!codexContinuationActionIdIsValid(fields.actionId) &&
      !(
        allowUnidentified &&
        (fields.actionId === undefined || fields.actionId === null)
      ))
  )
    throw new Error("Codex action evidence has an invalid record");
  return Object.freeze({
    method: fields.method,
    atMs: fields.atMs,
    actionId: codexContinuationActionIdIsValid(fields.actionId)
      ? fields.actionId
      : null,
  });
};
const codexContinuationActionRecords = (value, allowUnidentified = false) => {
  const fields = codexContinuationActionOwnFields(value);
  const records = Object.create(null);
  for (const key of Object.keys(fields)) {
    if (!codexContinuationActionThreadIdIsValid(key))
      throw new Error("Codex action evidence has an invalid thread");
    records[key] = codexContinuationActionRecord(
      fields[key],
      allowUnidentified,
    );
  }
  return Object.freeze(records);
};
// Every read checks the serialized storage value. Reuse only the last fully
// validated v2 document when its contents match exactly.
let codexContinuationActionDocumentCache = null;
const parseCodexContinuationActionDocument = (raw, legacyMode = "deny") => {
  if (raw !== null && typeof raw !== "string")
    throw new Error("Codex action evidence has invalid serialized data");
  if (raw === null && legacyMode === "deny")
    throw new Error("Codex action evidence is unavailable");
  if (codexContinuationActionDocumentCache?.raw === raw)
    return codexContinuationActionDocumentCache.document;
  const parsed = raw === null ? {} : JSON.parse(raw);
  const fields = codexContinuationActionOwnFields(parsed);
  const keys = Object.keys(fields);
  const isEnvelope = ["schemaVersion", "revision", "actions"].some((key) =>
    Object.hasOwn(fields, key),
  );
  if (isEnvelope) {
    if (
      keys.length !== 3 ||
      !["schemaVersion", "revision", "actions"].every((key) =>
        Object.hasOwn(fields, key),
      ) ||
      fields.schemaVersion !== 2 ||
      !codexContinuationActionIdIsValid(fields.revision)
    )
      throw new Error("Codex action evidence has an unsupported document");
    const document = Object.freeze({
      schemaVersion: 2,
      revision: fields.revision,
      actions: codexContinuationActionRecords(fields.actions),
    });
    codexContinuationActionDocumentCache = { raw, document };
    return document;
  }
  if (legacyMode === "deny")
    throw new Error(
      "Codex action evidence needs an explicit installation upgrade",
    );
  const actions = codexContinuationActionRecords(parsed, true);
  // A null nonce was never valid persisted owner evidence. Only automatic
  // timestamp compatibility may inspect it; installation does not bless it.
  if (legacyMode === "migrate") {
    for (const key of keys) {
      const record = codexContinuationActionOwnFields(fields[key]);
      if (
        Object.hasOwn(record, "actionId") &&
        !codexContinuationActionIdIsValid(record.actionId)
      )
        throw new Error("Codex legacy action evidence has an invalid identity");
    }
  }
  return Object.freeze({ schemaVersion: 1, revision: null, actions });
};
// Monotonic proof for this installed runtime, separate from owner readiness.
// Once valid v2 was read or a canonical write confirmed, AUTO must not treat a
// later legacy clobber as missing history. Never-v2 legacy/no-Crypto runtimes
// retain their original timestamp compatibility until they observe valid v2.
let codexContinuationActionV2Established = false;
const readCodexContinuationActionDocument = (legacyMode = "deny") => {
  const document = parseCodexContinuationActionDocument(
    localStorage.getItem(continuationActionStorageKey),
    legacyMode,
  );
  if (document.schemaVersion === 2) codexContinuationActionV2Established = true;
  return document;
};
const readCodexContinuationLocalActionProjection = (requirePresent = false) => {
  const descriptor = Object.getOwnPropertyDescriptor(
    state,
    "codexUserTurnActions",
  );
  if (!descriptor) {
    if (requirePresent)
      throw new Error("Codex local action projection is unavailable");
    return Object.freeze(Object.create(null));
  }
  if (!Object.hasOwn(descriptor, "value"))
    throw new Error("Codex local action projection is unreadable");
  return descriptor.value;
};
const codexContinuationActionProjection = (canonical, observed) => {
  const projection = Object.create(null);
  for (const key of Object.keys(canonical)) projection[key] = canonical[key];
  for (const key of Object.keys(observed)) {
    const observation = observed[key];
    const persisted = canonical[key];
    if (
      persisted &&
      observation.method === persisted.method &&
      observation.atMs === persisted.atMs &&
      (!observation.actionId || observation.actionId === persisted.actionId)
    ) {
      projection[key] = persisted;
      continue;
    }
    // A local stop/start may have failed to persist. Never replace it with an
    // older canonical record; retain that observation for max-time/identity.
    const actionId = observation.actionId || createCodexUserActionId();
    if (!actionId)
      throw new Error("Codex action identity randomness is unavailable");
    projection[key] = Object.freeze({ ...observation, actionId });
  }
  return Object.freeze(projection);
};
const assignCodexContinuationActionProjection = (projection) => {
  const descriptor = Object.getOwnPropertyDescriptor(
    state,
    "codexUserTurnActions",
  );
  if (descriptor && !Object.hasOwn(descriptor, "value"))
    throw new Error("Codex local action projection is unreadable");
  Object.defineProperty(state, "codexUserTurnActions", {
    value: projection,
    writable: true,
    configurable: true,
    enumerable: true,
  });
};
const writeCodexContinuationActionDocument = (
  actions,
  previousRevision = null,
) => {
  // Generate at this write, never while reading/copying a previous document.
  const revision = createCodexUserActionId();
  if (!revision || revision === previousRevision)
    throw new Error("Codex action revision randomness is unavailable");
  const document = Object.freeze({ schemaVersion: 2, revision, actions });
  const serialized = JSON.stringify(document);
  localStorage.setItem(continuationActionStorageKey, serialized);
  // Web Storage writes are atomic, but failure/partial adapter behavior must
  // not turn an unconfirmed installation/write into an owner-capable runtime.
  if (localStorage.getItem(continuationActionStorageKey) !== serialized)
    throw new Error("Codex action evidence write was not confirmed");
  const confirmed = parseCodexContinuationActionDocument(serialized);
  codexContinuationActionV2Established = true;
  return confirmed;
};
// A failed observation write is not proof of no user action. Keep a sticky
// in-memory capability failure across compatibility reinjection, even if a
// projection is replaced. It is not another persisted action ledger, and a
// read/clock change/unrelated successful write must never silently clear it.
let codexContinuationActionPersistenceFailed = false;
const codexContinuationActionPersistenceIsUncertain = () => {
  const descriptor = Object.getOwnPropertyDescriptor(
    state,
    "codexUserTurnActionPersistenceFailed",
  );
  if (
    descriptor &&
    (!Object.hasOwn(descriptor, "value") ||
      typeof descriptor.value !== "boolean")
  )
    throw new Error("Codex action persistence capability is unreadable");
  return codexContinuationActionPersistenceFailed || descriptor?.value === true;
};
const markCodexContinuationActionPersistenceFailed = () => {
  codexContinuationActionPersistenceFailed = true;
  try {
    Object.defineProperty(state, "codexUserTurnActionPersistenceFailed", {
      value: true,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  } catch {}
};
let codexContinuationActionDocumentReady = false;
let codexContinuationActionDocumentInitialized = false;
const codexContinuationActionInstallationGeneration = codexContinuationOwnData(
  state,
  "runtimeGeneration",
);
const initializeCodexContinuationActionDocument = () => {
  if (codexContinuationActionDocumentInitialized)
    return codexContinuationActionDocumentReady;
  codexContinuationActionDocumentInitialized = true;
  try {
    const persistenceUncertain =
      codexContinuationActionPersistenceIsUncertain();
    if (!createCodexUserActionId())
      throw new Error("Codex action identity randomness is unavailable");
    const observed = codexContinuationActionRecords(
      readCodexContinuationLocalActionProjection(),
      true,
    );
    let document = readCodexContinuationActionDocument("migrate");
    if (document.schemaVersion === 1) {
      const actions = Object.create(null);
      for (const key of Object.keys(document.actions)) {
        const record = document.actions[key];
        const observation = observed[key];
        const matchingObservedIdentity =
          observation &&
          observation.method === record.method &&
          observation.atMs === record.atMs
            ? observation.actionId
            : null;
        const actionId =
          record.actionId ||
          matchingObservedIdentity ||
          createCodexUserActionId();
        if (!actionId)
          throw new Error("Codex action identity randomness is unavailable");
        actions[key] = Object.freeze({ ...record, actionId });
      }
      // Validate local observations before touching persisted evidence. A
      // failed/crashed migration exposes no owner reference from this runtime.
      const projection = codexContinuationActionProjection(actions, observed);
      document = writeCodexContinuationActionDocument(Object.freeze(actions));
      assignCodexContinuationActionProjection(projection);
    } else {
      assignCodexContinuationActionProjection(
        codexContinuationActionProjection(document.actions, observed),
      );
    }
    codexContinuationActionDocumentReady = !persistenceUncertain;
  } catch {
    // Do not replace malformed/future data or silently retry a migration on a
    // read/action. Existing valid local observations remain available to auto.
    codexContinuationActionDocumentReady = false;
    if (typeof recordFailure === "function")
      recordFailure(
        new Error("Codex action evidence installation is unavailable"),
      );
  }
  return codexContinuationActionDocumentReady;
};
// Deliberate installation boundary, before owner view/continuation entrypoints
// are installed. Reinjection already invalidates old runtime-generation refs.
initializeCodexContinuationActionDocument();
const rememberCodexUserTurnAction = (method, params) => {
  const wrapped = method === "send-cli-request-for-host";
  const actualMethod = wrapped
    ? codexContinuationOwnData(params, "method")
    : method;
  if (!codexContinuationUserActionMethods.includes(actualMethod)) return;
  const requestParams = wrapped
    ? codexContinuationOwnData(params, "params")
    : params;
  const threadId = codexContinuationOwnData(requestParams, "threadId");
  if (!codexContinuationActionThreadIdIsValid(threadId)) return;
  try {
    const action = Object.freeze({
      method: actualMethod,
      atMs: Date.now(),
      actionId: createCodexUserActionId(),
    });
    const observed = codexContinuationActionRecords(
      readCodexContinuationLocalActionProjection(),
      true,
    );
    const projection = Object.create(null);
    for (const key of Object.keys(observed)) projection[key] = observed[key];
    projection[threadId] = action;
    assignCodexContinuationActionProjection(Object.freeze(projection));
    // New observations remain local even if persistence fails. No write may
    // reinterpret a legacy clobber or an unsupported schema as an empty store.
    if (
      !codexContinuationActionIdIsValid(action.actionId) ||
      !Number.isSafeInteger(action.atMs) ||
      action.atMs <= 0
    )
      throw new Error("Codex action identity is unavailable");
    const current = readCodexContinuationActionDocument();
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const actions = Object.create(null);
    for (const key of Object.keys(current.actions)) {
      if (current.actions[key].atMs >= cutoff)
        actions[key] = current.actions[key];
    }
    actions[threadId] = action;
    writeCodexContinuationActionDocument(
      Object.freeze(actions),
      current.revision,
    );
  } catch {
    markCodexContinuationActionPersistenceFailed();
    codexContinuationActionDocumentReady = false;
    if (typeof recordFailure === "function")
      recordFailure(new Error("Codex action evidence could not be persisted"));
  }
};
const codexContinuationHasNewerUserAction = (threadId, observedAtMs) => {
  if (codexContinuationActionPersistenceIsUncertain())
    throw new Error("Codex user-action persistence is uncertain");
  const document = readCodexContinuationActionDocument(
    codexContinuationActionV2Established ? "deny" : "automatic",
  );
  const observed = codexContinuationActionRecords(
    readCodexContinuationLocalActionProjection(),
    true,
  );
  const latestActionAtMs = Math.max(
    Number(document.actions[threadId]?.atMs || 0),
    Number(observed[threadId]?.atMs || 0),
  );
  // Preserve automatic recovery's original timestamp > cutoff policy.
  return latestActionAtMs > observedAtMs;
};
const readCodexOwnerUserActionEvidence = (threadId) => {
  try {
    if (
      !codexContinuationActionDocumentReady ||
      codexContinuationActionPersistenceIsUncertain() ||
      !codexContinuationActionThreadIdIsValid(threadId) ||
      !Number.isSafeInteger(codexContinuationActionInstallationGeneration) ||
      codexContinuationActionInstallationGeneration <= 0 ||
      codexContinuationOwnData(state, "runtimeGeneration") !==
        codexContinuationActionInstallationGeneration ||
      (typeof installationIsCurrent === "function" && !installationIsCurrent())
    )
      return null;
    const document = readCodexContinuationActionDocument();
    const localFields = codexContinuationActionOwnFields(
      readCodexContinuationLocalActionProjection(true),
    );
    const inspect = (records, preserveIdentity = false) => {
      const descriptor = Object.getOwnPropertyDescriptor(records, threadId);
      if (!descriptor)
        return { record: null, actionId: null, method: null, atMs: null };
      if (!Object.hasOwn(descriptor, "value")) return null;
      const record = codexContinuationActionRecord(descriptor.value);
      return {
        record: preserveIdentity ? descriptor.value : record,
        actionId: record.actionId,
        method: record.method,
        atMs: record.atMs,
      };
    };
    const persistedAction = inspect(document.actions);
    const localAction = inspect(localFields, true);
    if (!persistedAction || !localAction) return null;
    return Object.freeze({
      threadId,
      documentRevision: document.revision,
      runtimeGeneration: codexContinuationActionInstallationGeneration,
      localRecord: localAction.record,
      localActionId: localAction.actionId,
      localMethod: localAction.method,
      localAtMs: localAction.atMs,
      persistedActionId: persistedAction.actionId,
      persistedMethod: persistedAction.method,
      persistedAtMs: persistedAction.atMs,
    });
  } catch {
    return null;
  }
};
const captureCodexOwnerUserActionEvidence = (threadId) => {
  // Capability is proved at installation and secure randomness must still be
  // usable now. Reads never initialize/migrate/repair an action document.
  if (!createCodexUserActionId()) return null;
  return readCodexOwnerUserActionEvidence(threadId);
};
const codexOwnerUserActionEvidenceIsCurrent = (threadId, evidence) => {
  if (!evidence) return false;
  const current = readCodexOwnerUserActionEvidence(threadId);
  return (
    !!current &&
    [
      "threadId",
      "documentRevision",
      "runtimeGeneration",
      "localRecord",
      "localActionId",
      "localMethod",
      "localAtMs",
      "persistedActionId",
      "persistedMethod",
      "persistedAtMs",
    ].every(
      (key) =>
        codexContinuationOwnData(current, key) ===
        codexContinuationOwnData(evidence, key),
    )
  );
};
const continuationStatus = (value) =>
  String(value?.type || value || "").toLowerCase();
const classifyCodexContinuationThread = (
  thread,
  threadId,
  expectedModel,
  { temporaryUsageLimitVerified = false } = {},
) => {
  const requestedModel = String(expectedModel || "").trim();
  if (!requestedModel || requestedModel.toLowerCase() === "unknown") {
    return { ready: false, reason: "The interrupted Codex model is required" };
  }
  if (String(thread?.id || "").trim() !== threadId) {
    return { ready: false, reason: "Codex returned a different thread" };
  }
  if (continuationStatus(thread?.status) === "active") {
    return {
      ready: false,
      reason: "The interrupted Codex thread is still active",
    };
  }
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const turn = turns.at(-1);
  const turnId = String(turn?.id || "").trim();
  if (!turnId)
    return {
      ready: false,
      reason: "Codex did not identify the interrupted turn",
    };
  const status = continuationStatus(turn?.status);
  if (status !== "failed" && status !== "interrupted") {
    return {
      ready: false,
      reason: `The latest Codex turn is ${status || "not terminal"}`,
    };
  }
  const error = JSON.stringify(turn?.error || "");
  if (
    /cancel(?:led|ed|lation)?|user.?abort|turn.?abort|user.?interrupt/i.test(
      error,
    )
  ) {
    return { ready: false, reason: "The latest Codex turn was cancelled" };
  }
  if (
    !temporaryUsageLimitVerified &&
    codexContinuationTerminalErrorCode("", { error: turn?.error })
  ) {
    return {
      ready: false,
      reason: "The latest Codex turn needs a user action",
    };
  }
  // App-server reports a user stop as interrupted without an error. Recover
  // interrupted turns only when their error identifies an unexpected failure.
  if (
    status === "interrupted" &&
    !/overload|capacity|rate.?limit|usage.?limit|server.?error|transport|connection|network|socket|fetch.?(?:failed|error)|econn(?:reset|refused)|enotfound|eai.?again|enetunreach|ehostunreach|unexpected|premature|eof|stream|timeout|timed.?out|crash|process.?exit/i.test(
      error,
    ) &&
    !/(?:^|[^\d.])(?:408|425|429|5\d{2})(?!\d|\.\d)/.test(error)
  ) {
    return {
      ready: false,
      reason:
        "The latest Codex turn was interrupted without a recoverable error",
    };
  }
  const threadModel = String(thread?.model || "").trim();
  const turnModel = String(turn?.model || "").trim();
  if (!threadModel && !turnModel) {
    return {
      ready: false,
      reason: "Codex did not identify the interrupted model",
    };
  }
  if (threadModel && turnModel && threadModel !== turnModel) {
    return {
      ready: false,
      reason: "The interrupted Codex thread returned conflicting models",
    };
  }
  const model = threadModel || turnModel;
  if (model !== requestedModel) {
    return {
      ready: false,
      reason: "The interrupted Codex thread changed model",
    };
  }
  return { ready: true, turnId };
};
// Owner intent is a deliberate new user action, not a retryable-error policy.
// Its private view reference binds the exact base turn, model and provider. The
// canonical app-server idle state proves quiescence. A loaded systemError is
// eligible only when its exact latest turn failed/interrupted and no pending
// operation is reported. It remains an error for display, never inferred idle;
// missing, active, unloaded or unfamiliar state cannot authorize submission.
const codexOwnerContinuationPendingStateIsClear = (thread) => {
  const status = codexContinuationOwnData(thread, "status");
  if (!status || typeof status !== "object") return false;
  for (const [source, key, expectsList] of [
    [status, "activeFlags", true],
    [thread, "pendingApprovals", true],
    [thread, "pendingOperations", true],
    [thread, "pendingRequests", true],
    [thread, "pendingApproval", false],
    [thread, "pendingOperation", false],
    [thread, "waitingOnApproval", false],
    [thread, "waitingOnUserInput", false],
  ]) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor) continue;
    if (!Object.hasOwn(descriptor, "value")) return false;
    const value = descriptor.value;
    if (
      expectsList
        ? !Array.isArray(value) || value.length !== 0
        : value !== false
    )
      return false;
  }
  return true;
};
const classifyCodexUsageLimitContinuationThread = (
  thread,
  threadId,
  expectedModel,
  expectedTurnId,
  nativeObservation,
) => {
  const turns = codexContinuationOwnData(thread, "turns");
  const turn =
    Array.isArray(turns) && turns.length
      ? codexContinuationOwnData(turns, String(turns.length - 1))
      : null;
  if (
    codexContinuationOwnData(thread, "id") !== threadId ||
    codexContinuationOwnData(turn, "id") !== expectedTurnId
  )
    return {
      ready: false,
      reason: "The latest Codex turn does not match the usage-limited turn",
    };
  const status = codexContinuationOwnData(thread, "status");
  const statusType = codexContinuationOwnData(status, "type");
  const turnStatus = codexContinuationOwnData(turn, "status");
  if (turnStatus === "completed")
    return { ready: false, reason: "The usage-limited Codex turn completed" };
  if (statusType === "active" && turnStatus === "inProgress")
    return {
      ready: false,
      usageLimitDeferred: true,
      reason: "The usage-limited Codex turn is still active",
    };
  const error = codexContinuationOwnData(turn, "error");
  if (
    !["failed", "interrupted"].includes(turnStatus) ||
    !codexContinuationIsTemporaryUsageLimit(error)
  )
    return {
      ready: false,
      reason:
        "The latest Codex turn is no longer a temporary usage-limit failure",
    };
  if (
    (statusType !== "idle" && statusType !== "systemError") ||
    !codexOwnerContinuationPendingStateIsClear(thread)
  )
    return {
      ready: false,
      usageLimitDeferred: true,
      reason: "The usage-limited Codex thread is not ready for continuation",
    };
  if (nativeObservation) {
    const threadModel = Object.getOwnPropertyDescriptor(thread, "model");
    const turnModel = codexContinuationOwnData(turn, "model");
    if (
      (threadModel && !Object.hasOwn(threadModel, "value")) ||
      codexContinuationOwnData(thread, "modelProvider") !==
        nativeObservation.modelProvider ||
      [threadModel?.value, turnModel].some(
        (model) => model != null && model !== expectedModel,
      )
    )
      return {
        ready: false,
        reason: "The usage-limited Codex thread changed provider or model",
      };
    // Native thread and turn reads can omit the model. The exact observed
    // turn, verified local client, and current provider bind this continuation.
    return { ready: true, turnId: expectedTurnId };
  }
  return classifyCodexContinuationThread(thread, threadId, expectedModel, {
    temporaryUsageLimitVerified: true,
  });
};
const classifyCodexOwnerContinuationThread = (thread, binding) => {
  const unavailable = (reason, blocker = "thread_binding_unavailable") => ({
    ready: false,
    reason,
    blocker,
  });
  if (codexContinuationOwnData(thread, "id") !== binding.threadId)
    return unavailable("The owner view returned a different Codex thread");
  const status = codexContinuationOwnData(thread, "status");
  const statusType = codexContinuationOwnData(status, "type");
  if (statusType !== "idle" && statusType !== "systemError")
    return unavailable(
      "The owner Codex thread is not positively quiescent",
      "thread_not_idle",
    );
  if (!codexOwnerContinuationPendingStateIsClear(thread))
    return unavailable(
      "The owner Codex pending-operation state is unavailable",
      "thread_not_idle",
    );
  const turns = codexContinuationOwnData(thread, "turns");
  if (!Array.isArray(turns) || !turns.length)
    return unavailable("The owner view did not identify its latest Codex turn");
  const turn = codexContinuationOwnData(turns, String(turns.length - 1));
  const turnId = codexContinuationOwnData(turn, "id");
  if (turnId !== binding.latestTurnId)
    return unavailable(
      "The owner Codex view is stale; its latest turn changed",
    );
  const turnStatus = codexContinuationOwnData(turn, "status");
  if (!["completed", "failed", "interrupted"].includes(turnStatus))
    return unavailable("The owner Codex latest turn is not terminal");
  if (
    statusType === "systemError" &&
    !["failed", "interrupted"].includes(turnStatus)
  )
    return unavailable(
      "The owner Codex error state has no failed or interrupted latest turn",
      "thread_not_idle",
    );
  const model = codexContinuationOwnData(thread, "model");
  const turnModelDescriptor = Object.getOwnPropertyDescriptor(turn, "model");
  if (turnModelDescriptor && !Object.hasOwn(turnModelDescriptor, "value"))
    return unavailable("The owner Codex latest-turn model is unavailable");
  const turnModel = turnModelDescriptor?.value;
  if (
    model !== binding.expectedModel ||
    (turnModel !== undefined && turnModel !== model)
  )
    return unavailable("The owner Codex view changed model");
  if (
    codexContinuationOwnData(thread, "modelProvider") !==
    binding.expectedModelProvider
  )
    return unavailable("The owner Codex view changed provider");
  return { ready: true, turnId };
};
const readCodexContinuationMarkers = () => {
  const value = JSON.parse(
    localStorage.getItem(continuationStorageKey) || "{}",
  );
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Codex continuation submission evidence is invalid");
  return value;
};
const writeCodexContinuationMarker = (key, marker) => {
  const markers = readCodexContinuationMarkers();
  // Elapsed time does not prove that a dispatched turn did not happen. Keep
  // both uncertain and acknowledged evidence until a future canonical exact-
  // turn reconciliation can retire it. If storage fills, refuse another send
  // rather than trading away at-most-once mutation for an arbitrary TTL.
  markers[key] = { ...marker, writtenAt: Date.now() };
  localStorage.setItem(continuationStorageKey, JSON.stringify(markers));
};
const codexContinuationRequestPatchVersion =
  typeof appServerRequestPatchVersion === "string"
    ? appServerRequestPatchVersion
    : "standalone";
const isCodexContinuationRequestClient = (client) =>
  Boolean(
    looksLikeAppServerRequestClient(client) &&
    Object.getOwnPropertyDescriptor(client, "hostId")?.value === "local" &&
    codexVerifiedAppServerOriginalRequest(
      client,
      codexContinuationRequestPatchVersion,
    ),
  );
// Readiness and mutation share this pure predicate; no Desktop RPC is needed
// to reject a retained client whose activity hook is absent or replaced.
const readOwnedCodexContinuationRequest = async (client, method, params) => {
  // The compatibility wrapper deliberately changes thread/resume providers.
  // Read-only owner history and recovery use the original guarded local client.
  const request = codexVerifiedAppServerOriginalRequest(
    client,
    codexContinuationRequestPatchVersion,
  );
  if (!codexContinuationClientIsCurrent(client) || !request)
    throw new Error(
      "Codex Desktop request client was not found with its guarded activity hook",
    );
  let timer;
  let response;
  try {
    response = await Promise.race([
      request(method, params),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                method === "thread/read"
                  ? "Codex thread/read timed out"
                  : "Codex read-only request timed out",
              ),
            ),
          2500,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (
    !continuationInstallationIsCurrent() ||
    !codexContinuationClientIsCurrent(client) ||
    codexVerifiedAppServerOriginalRequest(
      client,
      codexContinuationRequestPatchVersion,
    ) !== request
  )
    throw new Error(
      "Codex Desktop request client was not found with its guarded activity hook",
    );
  return { response, request };
};
const readExactCodexContinuationThread = async (
  client,
  threadId,
  includeTurns = true,
) => {
  const { response, request } = await readOwnedCodexContinuationRequest(
    client,
    "thread/read",
    { threadId, includeTurns },
  );
  const responseThread =
    response && typeof response === "object"
      ? Object.getOwnPropertyDescriptor(response, "thread")
      : undefined;
  if (responseThread && !Object.hasOwn(responseThread, "value"))
    throw new Error("Codex returned an unavailable thread binding");
  const thread = responseThread ? responseThread.value : response;
  if (codexContinuationOwnData(thread, "id") !== threadId)
    throw new Error("Codex returned a different thread");
  if (includeTurns === false) {
    const turns = codexContinuationOwnData(thread, "turns");
    if (!Array.isArray(turns) || turns.length !== 0)
      throw new Error("Codex returned unbounded metadata history");
  }
  return { thread, request };
};
// Read only metadata and the latest turn. Readiness polling must not load
// conversation items, including when the interrupted thread is still active.
const readBoundedCodexContinuationThread = async (
  client,
  threadId,
  ensureCurrent = () => {},
  retainTerminalError = true,
) => {
  ensureCurrent();
  const { thread, request } = await readExactCodexContinuationThread(
    client,
    threadId,
    false,
  );
  ensureCurrent(request);
  const page = await readOwnedCodexContinuationRequest(
    client,
    "thread/turns/list",
    {
      threadId,
      cursor: null,
      limit: 1,
      sortDirection: "desc",
      itemsView: "notLoaded",
    },
  );
  ensureCurrent(page.request);
  const turns = codexContinuationOwnData(page.response, "data");
  const nextCursor = codexContinuationOwnData(page.response, "nextCursor");
  if (
    page.request !== request ||
    !Array.isArray(turns) ||
    turns.length > 1 ||
    (nextCursor !== null &&
      !(
        typeof nextCursor === "string" &&
        nextCursor.length > 0 &&
        nextCursor.length <= 4096
      ))
  )
    throw new Error("The owner Codex bounded history is unavailable");
  const snapshot = {};
  // Retain finite proof fields. Automatic recovery also needs terminal error
  // metadata to reject user cancellation and permanent failures.
  for (const key of [
    "id",
    "model",
    "modelProvider",
    "status",
    "pendingApproval",
    "pendingApprovals",
    "pendingOperation",
    "pendingOperations",
    "pendingRequests",
    "waitingOnApproval",
    "waitingOnUserInput",
  ]) {
    const descriptor = Object.getOwnPropertyDescriptor(thread, key);
    if (descriptor) Object.defineProperty(snapshot, key, descriptor);
  }
  snapshot.turns = [];
  if (turns.length) {
    const turn = codexContinuationOwnData(turns, "0");
    if (!turn || typeof turn !== "object")
      throw new Error("The owner Codex bounded history is unavailable");
    const unloadedItems = codexContinuationOwnData(turn, "items");
    if (
      codexContinuationOwnData(turn, "itemsView") !== "notLoaded" ||
      !Array.isArray(unloadedItems) ||
      unloadedItems.length !== 0
    )
      throw new Error("The owner Codex bounded history is unavailable");
    const latest = {};
    const fields = retainTerminalError
      ? ["id", "status", "model", "error"]
      : ["id", "status", "model"];
    for (const key of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(turn, key);
      if (
        retainTerminalError &&
        descriptor &&
        !Object.hasOwn(descriptor, "value")
      )
        throw new Error("The Codex bounded turn metadata is unavailable");
      if (descriptor) Object.defineProperty(latest, key, descriptor);
    }
    snapshot.turns.push(latest);
  }
  return { thread: snapshot, request };
};
const readExactCodexOwnerContinuationThread = (
  client,
  threadId,
  ownerTarget,
  ownerReferenceIsCurrent,
) =>
  readBoundedCodexContinuationThread(
    client,
    threadId,
    (request) => {
      if (
        ownerReferenceIsCurrent() !== true ||
        !codexContinuationClientIsCurrent(client) ||
        (request && request !== ownerTarget.request) ||
        codexVerifiedAppServerOriginalRequest(
          client,
          codexContinuationRequestPatchVersion,
        ) !== ownerTarget.request
      )
        throw new Error("The owner Codex view is no longer current");
    },
    false,
  );
const continuationInstallationIsCurrent = () =>
  typeof installationIsCurrent !== "function" || installationIsCurrent();
const codexContinuationLocalClients = () =>
  (Array.isArray(state.appServerClients) ? state.appServerClients : []).filter(
    (client, index, array) =>
      codexContinuationClientIsCurrent(client) &&
      array.indexOf(client) === index,
  );
const codexContinuationClientIsCurrent = (client) => {
  if (!isCodexContinuationRequestClient(client)) return false;
  if (
    !Array.isArray(state.appServerClients) ||
    !state.appServerClients.includes(client)
  )
    return false;
  if (!codexAppServerClientHasCurrentOwner(client)) return false;
  return true;
};
// Readiness and mutation require current discovery ownership, not merely a
// hook still attached to an object retained from a previous manager.
state.isCodexContinuationRequestClient = codexContinuationClientIsCurrent;
// A local RPC acknowledgement is mutation evidence, not an object-coercion
// surface. Accept only consistent own-data IDs; getters, aliases that disagree,
// the old base turn, and non-string IDs leave the durable attempt uncertain.
const readCodexContinuationAcknowledgement = (
  response,
  threadId,
  baseTurnId,
) => {
  const own = (object, key) => {
    if (!object || typeof object !== "object" || Array.isArray(object))
      return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor && !Object.hasOwn(descriptor, "value"))
      throw new Error("continuation_acknowledgement_unreadable");
    return descriptor?.value;
  };
  const safeId = (value) =>
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    !/[\u0000-\u0020\u007f]/.test(value);
  const turn = own(response, "turn");
  const thread = own(response, "thread");
  if (
    (turn !== undefined &&
      (!turn || typeof turn !== "object" || Array.isArray(turn))) ||
    (thread !== undefined &&
      (!thread || typeof thread !== "object" || Array.isArray(thread)))
  )
    return null;
  const turnIds = [
    own(turn, "id"),
    own(response, "turnId"),
    own(response, "turn_id"),
  ].filter((value) => value !== undefined);
  const threadIds = [
    own(response, "threadId"),
    own(response, "thread_id"),
    own(thread, "id"),
  ].filter((value) => value !== undefined);
  if (
    !turnIds.length ||
    turnIds.some((value) => !safeId(value) || value !== turnIds[0]) ||
    turnIds[0] === baseTurnId ||
    threadIds.some((value) => !safeId(value) || value !== threadId)
  )
    return null;
  return turnIds[0];
};
const readCodexNativeUsageLimitObservation = (
  threadId,
  turnId,
  model,
  observedAtMs,
  client,
) => {
  const read = codexContinuationOwnData(
    state,
    "getCodexNativeUsageLimitCandidate",
  );
  const observation =
    typeof read === "function" ? read(threadId, turnId, client) : null;
  // The proxy can supply the model even when the exact native turn omits it.
  return observation &&
    observation.observedAtMs === observedAtMs &&
    (observation.model === null || observation.model === model) &&
    codexContinuationActionThreadIdIsValid(observation.modelProvider)
    ? observation
    : null;
};
const prepareCodexContinuation = async (
  threadId,
  recoveryId,
  expectedModel,
  observedAtMs,
  intent = codexContinuationIntents.AutoRecovery,
  ownerTarget = null,
  ownerViewReference = null,
  expectedTurnId = null,
  requireNativeObservation = false,
) => {
  if (!Object.values(codexContinuationIntents).includes(intent))
    return {
      submitted: false,
      reason: "The Codex continuation intent is invalid",
    };
  const isOwner = intent === codexContinuationIntents.OwnerContinue;
  const isUsageLimitResume =
    intent === codexContinuationIntents.UsageLimitResume;
  const readNativeObservation = (client) =>
    readCodexNativeUsageLimitObservation(
      threadId,
      expectedTurnId,
      expectedModel,
      observedAtMs,
      client,
    );
  const nativeObservation = requireNativeObservation
    ? readNativeObservation()
    : null;
  const nativeObservationIsCurrent = (client) => {
    const current = readNativeObservation(client);
    return (
      !!current &&
      current.model === nativeObservation.model &&
      current.modelProvider === nativeObservation.modelProvider
    );
  };
  if (requireNativeObservation && !nativeObservation)
    return {
      submitted: false,
      usageLimitDeferred: true,
      reason:
        "The observed Codex usage-limit interruption is no longer current",
    };
  const ownerReferenceIsCurrent = () =>
    !isOwner ||
    (typeof codexOwnerRemoteViewReferenceIsCurrent === "function" &&
      codexOwnerRemoteViewReferenceIsCurrent(
        ownerViewReference,
        ownerTarget,
      ) === true &&
      codexOwnerUserActionEvidenceIsCurrent(
        threadId,
        ownerTarget?.userActionEvidence,
      ));
  const classifyThread = (thread) => {
    if (isOwner)
      return classifyCodexOwnerContinuationThread(thread, ownerTarget);
    if (isUsageLimitResume)
      return classifyCodexUsageLimitContinuationThread(
        thread,
        threadId,
        expectedModel,
        expectedTurnId,
        nativeObservation,
      );
    return classifyCodexContinuationThread(thread, threadId, expectedModel);
  };
  const readThread = (client) =>
    isOwner
      ? readExactCodexOwnerContinuationThread(
          client,
          threadId,
          ownerTarget,
          ownerReferenceIsCurrent,
        )
      : readBoundedCodexContinuationThread(client, threadId);
  if (!ownerReferenceIsCurrent())
    return {
      submitted: false,
      reason: "The owner Codex view is no longer current",
    };
  if (!Number.isFinite(observedAtMs) || observedAtMs <= 0)
    return {
      submitted: false,
      reason: "The interrupted turn observation time is required",
    };
  let clients = isOwner
    ? codexContinuationLocalClients().filter(
        (client) => client === ownerTarget.client,
      )
    : codexContinuationLocalClients();
  let reason = "Codex Desktop request client was not found";
  if (!clients.length && !isOwner) {
    let timer;
    try {
      // Installation can itself wait on a renderer module or React scan. Use
      // one readiness budget for that work and the asynchronous scoped pass.
      // An existing verified client needs neither operation to finish.
      await Promise.race([
        (async () => {
          try {
            await installAppServerPatch();
          } catch (error) {
            recordFailure(error);
          }
          if (!codexContinuationLocalClients().length)
            await state.scopedAppServerDiscoveryPromise;
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  "Codex Desktop request client was not found after discovery timed out",
                ),
              ),
            5000,
          );
        }),
      ]);
    } catch (error) {
      reason = String(error?.message || error);
      recordFailure(error);
    } finally {
      if (timer) clearTimeout(timer);
    }
    clients = codexContinuationLocalClients();
  }
  if (!isOwner && codexContinuationHasNewerUserAction(threadId, observedAtMs))
    return {
      submitted: false,
      reason:
        "The user changed or stopped the Codex thread after this request started",
    };
  // Native observations are bound to the client that verified the exact turn.
  if (requireNativeObservation)
    clients = clients.filter(nativeObservationIsCurrent);
  for (const client of clients) {
    let binding;
    try {
      binding = await readThread(client);
    } catch (error) {
      reason = isOwner
        ? "The owner Codex thread could not be read"
        : String(error?.message || error);
      continue;
    }
    if (
      !ownerReferenceIsCurrent() ||
      (isOwner && binding.request !== ownerTarget.request)
    )
      return {
        submitted: false,
        reason: "The owner Codex view is no longer current",
      };
    const before = classifyThread(binding.thread);
    if (!before.ready)
      return {
        submitted: false,
        reason: before.reason,
        usageLimitDeferred: before.usageLimitDeferred === true,
      };
    // A second read prevents a cached failure from resuming after the user has
    // already started a newer turn. No action is taken on active user work.
    const current = await readThread(client);
    if (
      !ownerReferenceIsCurrent() ||
      (isOwner && current.request !== ownerTarget.request)
    )
      return {
        submitted: false,
        reason: "The owner Codex view is no longer current",
      };
    const ready = classifyThread(current.thread);
    if (!ready.ready || ready.turnId !== before.turnId) {
      return {
        submitted: false,
        usageLimitDeferred: ready.usageLimitDeferred === true,
        reason:
          ready.reason || "The latest Codex turn changed before continuation",
      };
    }
    if (!isOwner && codexContinuationHasNewerUserAction(threadId, observedAtMs))
      return {
        submitted: false,
        reason:
          "The user changed or stopped the Codex thread before continuation",
      };
    // Thread reads may have waited for seconds. Return a prepared operation to
    // the backend so it can recheck canonical policy/provider/budget before
    // authorizing a mutation. Preparation itself never writes a send marker.
    const preparedRequest = current.request;
    const failedTurnId = ready.turnId;
    const checkBeforeSend = () => {
      if (!ownerReferenceIsCurrent())
        return {
          submitted: false,
          mutationAttempted: false,
          reason: "The owner Codex view is no longer current",
        };
      if (!continuationInstallationIsCurrent())
        return {
          submitted: false,
          mutationAttempted: false,
          usageLimitDeferred: isUsageLimitResume,
          reason: "The Codex compatibility runtime was replaced",
        };
      if (
        !isOwner &&
        codexContinuationHasNewerUserAction(threadId, observedAtMs)
      )
        return {
          submitted: false,
          mutationAttempted: false,
          reason:
            "The user changed or stopped the Codex thread before continuation",
        };
      if (requireNativeObservation && !nativeObservationIsCurrent(client))
        return {
          submitted: false,
          mutationAttempted: false,
          usageLimitDeferred: true,
          reason:
            "The observed Codex usage-limit interruption is no longer current",
        };
      if (
        !codexContinuationClientIsCurrent(client) ||
        codexVerifiedAppServerOriginalRequest(
          client,
          codexContinuationRequestPatchVersion,
        ) !== preparedRequest
      )
        return {
          submitted: false,
          mutationAttempted: false,
          usageLimitDeferred: isUsageLimitResume,
          reason:
            "Codex Desktop request client was not found with its guarded activity hook",
        };
      return null;
    };
    const confirm = async () => {
      const blocked = checkBeforeSend();
      if (blocked) return blocked;
      // Preparation may be separated from authorization by an arbitrary
      // backend round trip. Re-read the exact thread immediately before the
      // mutation so a newer failure/turn cannot inherit the old commit
      // closure merely because the client and thread id still match.
      let latest;
      try {
        latest = await readThread(client);
      } catch (error) {
        return {
          submitted: false,
          mutationAttempted: false,
          usageLimitDeferred: isUsageLimitResume,
          reason: isOwner
            ? "The owner Codex thread could not be read"
            : String(error?.message || error),
        };
      }
      const newerUserAction =
        !isOwner && codexContinuationHasNewerUserAction(threadId, observedAtMs);
      if (
        !continuationInstallationIsCurrent() ||
        !ownerReferenceIsCurrent() ||
        newerUserAction ||
        !codexContinuationClientIsCurrent(client) ||
        latest.request !== preparedRequest ||
        codexVerifiedAppServerOriginalRequest(
          client,
          codexContinuationRequestPatchVersion,
        ) !== preparedRequest
      )
        return {
          submitted: false,
          mutationAttempted: false,
          usageLimitDeferred: isUsageLimitResume && !newerUserAction,
          reason:
            "Codex continuation authorization changed while reading the thread",
        };
      if (requireNativeObservation && !nativeObservationIsCurrent(client))
        return {
          submitted: false,
          mutationAttempted: false,
          usageLimitDeferred: true,
          reason:
            "The observed Codex usage-limit interruption is no longer current",
        };
      const latestReady = classifyThread(latest.thread);
      if (!latestReady.ready || latestReady.turnId !== failedTurnId)
        return {
          submitted: false,
          mutationAttempted: false,
          usageLimitDeferred: latestReady.usageLimitDeferred === true,
          reason:
            latestReady.reason ||
            "The latest Codex turn changed before continuation",
        };
      return {
        confirmed: true,
        commit: async () => {
          // No awaited operation may occur between these exact local checks,
          // durable mutation intent, and invoking the one original sender.
          // Native final authorization happens only after confirm completed.
          const blocked = checkBeforeSend();
          if (blocked) return blocked;
          const currentReady = classifyThread(latest.thread);
          if (
            latest.request !== preparedRequest ||
            !currentReady.ready ||
            currentReady.turnId !== failedTurnId
          )
            return {
              submitted: false,
              mutationAttempted: false,
              usageLimitDeferred: currentReady.usageLimitDeferred === true,
              reason: "Codex continuation changed after final confirmation",
            };
          const markerKey = `${threadId}:${failedTurnId}`;
          let previous;
          let hasPrevious;
          try {
            const markers = readCodexContinuationMarkers();
            hasPrevious = Object.hasOwn(markers, markerKey);
            previous = codexContinuationOwnData(markers, markerKey);
          } catch {
            return {
              submitted: false,
              mutationAttempted: false,
              reason: "Codex continuation submission evidence is unavailable",
            };
          }
          if (hasPrevious) {
            const submitted =
              codexContinuationOwnData(previous, "status") === "submitted";
            const turnId = codexContinuationOwnData(previous, "turnId");
            return {
              submitted,
              mutationAttempted: true,
              ...(submitted && codexContinuationActionThreadIdIsValid(turnId)
                ? { turnId }
                : {}),
              reason: submitted
                ? "Continuation was already submitted for this interrupted turn"
                : "A continuation was already attempted; its result is uncertain",
            };
          }
          // Persist before sending: a lost response or renderer restart must not
          // cause another continue to be submitted for the same failed turn.
          try {
            writeCodexContinuationMarker(markerKey, {
              recoveryId,
              intent,
              status: "attempted",
            });
          } catch {
            return {
              submitted: false,
              mutationAttempted: false,
              reason:
                "Codex continuation submission evidence could not be persisted",
            };
          }
          try {
            // Bulk resume calls the verified original sender directly. Capture
            // its activity before sending so a fast failure can be observed.
            const observeStart =
              isUsageLimitResume &&
              typeof captureCodexNativeUsageLimitAcknowledgement === "function"
                ? captureCodexNativeUsageLimitAcknowledgement(
                    client,
                    threadId,
                    expectedModel,
                    { request: preparedRequest, baseTurnId: failedTurnId },
                  )
                : undefined;
            const started = await preparedRequest("turn/start", {
              threadId,
              input: [{ type: "text", text: "continue" }],
            });
            const turnId = readCodexContinuationAcknowledgement(
              started,
              threadId,
              failedTurnId,
            );
            if (!turnId) {
              return {
                submitted: false,
                mutationAttempted: true,
                reason: "Codex did not confirm the targeted continuation",
              };
            }
            writeCodexContinuationMarker(markerKey, {
              recoveryId,
              intent,
              status: "submitted",
              turnId,
            });
            observeStart?.(started);
            return {
              submitted: true,
              mutationAttempted: true,
              turnId,
              reason: "Continuation submitted to the interrupted Codex thread",
            };
          } catch (error) {
            return {
              submitted: false,
              mutationAttempted: true,
              reason: isOwner
                ? "The owner continuation result is uncertain"
                : `Continuation result is uncertain: ${String(error?.message || error)}`,
            };
          }
        },
      };
    };
    return {
      prepared: true,
      baseTurnId: failedTurnId,
      confirm,
      // Preserve the legacy direct automatic API. Native dispatchers use the
      // explicit confirmation phase before their final authorization instead.
      commit: async () => {
        const result = await confirm();
        return result.confirmed ? result.commit() : result;
      },
    };
  }
  // Every eligible client failed its initial exact read. A newer local user
  // action is still authoritative if it arrived while those reads ran.
  const nativeInitialReadUnavailable =
    requireNativeObservation && clients.length > 0;
  if (
    nativeInitialReadUnavailable &&
    codexContinuationHasNewerUserAction(threadId, observedAtMs)
  )
    return {
      submitted: false,
      reason:
        "The user changed or stopped the Codex thread before continuation",
    };
  return {
    submitted: false,
    mutationAttempted: false,
    usageLimitDeferred: isUsageLimitResume,
    ...(nativeInitialReadUnavailable
      ? { usageLimitInitialReadUnavailable: true }
      : {}),
    reason,
  };
};
const codexContinuationMutationAttempted = (job) => {
  if (!job) return false;
  if (job.submitted === true || job.status === "submitting") return true;
  if (
    (job.submitted !== undefined && typeof job.submitted !== "boolean") ||
    (job.mutationAttempted !== undefined &&
      typeof job.mutationAttempted !== "boolean")
  )
    return true;
  return typeof job.mutationAttempted === "boolean"
    ? job.mutationAttempted
    : !["pending", "prepared", "confirming", "confirmed"].includes(job.status);
};
state.codexContinuationJobs = state.codexContinuationJobs || {};
const startCodexContinuationJob = (
  threadId,
  recoveryId,
  expectedModel,
  observedAtMs,
  intent = codexContinuationIntents.AutoRecovery,
  ownerTarget = null,
  ownerViewReference = null,
  expectedTurnId = null,
  requireNativeObservation = false,
) => {
  const id = String(threadId || "").trim();
  const token = String(recoveryId || "").trim();
  const isUsageLimitResume =
    intent === codexContinuationIntents.UsageLimitResume;
  const model =
    isUsageLimitResume && requireNativeObservation && expectedModel === null
      ? null
      : String(expectedModel || "").trim();
  if (!id || !token)
    return {
      started: false,
      reason: "An exact Codex thread and recovery id are required",
    };
  if (model === "" || model?.toLowerCase() === "unknown")
    return {
      started: false,
      reason: "The interrupted Codex model is required",
    };
  if (
    isUsageLimitResume &&
    !codexContinuationActionThreadIdIsValid(expectedTurnId)
  )
    return {
      started: false,
      reason: "The usage-limited Codex turn is required",
    };
  if (!Number.isFinite(observedAtMs) || observedAtMs <= 0)
    return {
      started: false,
      reason: "The interrupted turn observation time is required",
    };
  if (
    requireNativeObservation &&
    !readCodexNativeUsageLimitObservation(
      id,
      expectedTurnId,
      model,
      observedAtMs,
    )
  )
    return {
      started: false,
      reason: "This Codex renderer does not have the usage-limit interruption",
    };
  const existing = state.codexContinuationJobs[token];
  if (existing && existing.threadId !== id)
    return {
      started: false,
      reason: "The recovery id belongs to a different Codex thread",
    };
  if (
    existing &&
    (existing.expectedModel !== model ||
      existing.observedAtMs !== observedAtMs ||
      (existing.intent || codexContinuationIntents.AutoRecovery) !== intent ||
      (isUsageLimitResume &&
        (existing.expectedBaseTurnId !== expectedTurnId ||
          existing.requireNativeObservation !== requireNativeObservation)) ||
      (intent === codexContinuationIntents.OwnerContinue &&
        existing.ownerViewReference !== ownerViewReference))
  )
    return {
      started: false,
      reason: "The recovery id belongs to a different interrupted request",
    };
  if (
    ["pending", "prepared", "confirming", "confirmed", "submitting"].includes(
      existing?.status,
    ) ||
    codexContinuationMutationAttempted(existing)
  ) {
    return { started: true, jobId: token };
  }
  const binding = {
    threadId: id,
    expectedModel: model,
    observedAtMs,
    intent,
    runtimeGeneration: state.runtimeGeneration,
    ...(intent === codexContinuationIntents.OwnerContinue
      ? { ownerViewReference, expectedBaseTurnId: ownerTarget.latestTurnId }
      : {}),
    ...(isUsageLimitResume
      ? { expectedBaseTurnId: expectedTurnId, requireNativeObservation }
      : {}),
  };
  const job = {
    ...binding,
    status: "pending",
    submitted: false,
    mutationAttempted: false,
  };
  state.codexContinuationJobs[token] = job;
  void prepareCodexContinuation(
    id,
    token,
    model,
    observedAtMs,
    intent,
    ownerTarget,
    ownerViewReference,
    expectedTurnId,
    requireNativeObservation,
  ).then(
    (result) => {
      if (
        state.codexContinuationJobs[token] !== job ||
        job.status !== "pending"
      )
        return;
      if (
        result.prepared &&
        typeof result.confirm === "function" &&
        typeof result.commit === "function"
      ) {
        // Functions stay outside the serialized job view. Every native
        // dispatcher confirms its final read before native authorization.
        Object.defineProperty(job, "confirm", {
          value: result.confirm,
          configurable: true,
        });
        // Only the legacy direct automatic API may combine read and send.
        // Starting explicit confirmation removes that legacy sender.
        if (intent === codexContinuationIntents.AutoRecovery)
          Object.defineProperty(job, "commit", {
            value: result.commit,
            configurable: true,
          });
        job.baseTurnId = result.baseTurnId;
        job.status = "prepared";
      } else
        Object.assign(job, { mutationAttempted: false }, result, {
          status: "completed",
        });
    },
    (error) => {
      if (
        state.codexContinuationJobs[token] !== job ||
        job.status !== "pending"
      )
        return;
      Object.assign(job, {
        submitted: false,
        mutationAttempted: false,
        usageLimitDeferred: isUsageLimitResume,
        status: "completed",
        reason:
          intent === codexContinuationIntents.OwnerContinue
            ? "The owner Codex thread could not be prepared"
            : String(error?.message || error),
      });
    },
  );
  return { started: true, jobId: token };
};
// Preserve the native automatic API and its existing policy unchanged.
state.startCodexContinuation = (
  threadId,
  recoveryId,
  expectedModel,
  observedAtMs,
) =>
  startCodexContinuationJob(threadId, recoveryId, expectedModel, observedAtMs);
state.startCodexUsageLimitContinuation = (
  threadId,
  recoveryId,
  expectedModel,
  observedAtMs,
  expectedTurnId,
  requireNativeObservation,
) =>
  startCodexContinuationJob(
    threadId,
    recoveryId,
    expectedModel,
    observedAtMs,
    codexContinuationIntents.UsageLimitResume,
    null,
    null,
    expectedTurnId,
    requireNativeObservation === true,
  );
// This prepares only. A future native owner dispatcher must authenticate and
// reauthorize its canonical transaction before using the shared commit bridge.
// Browser-supplied bindings/prompts/RPC are not accepted by this operation.
state.startCodexOwnerContinuation = (viewReference, operationId) => {
  if (
    typeof viewReference !== "string" ||
    !viewReference ||
    viewReference.length > 256 ||
    typeof operationId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(operationId) ||
    typeof resolveCodexOwnerRemoteViewReference !== "function" ||
    typeof codexOwnerRemoteViewReferenceIsCurrent !== "function"
  )
    return {
      started: false,
      reason: "An exact owner view and operation id are required",
    };
  const binding = resolveCodexOwnerRemoteViewReference(viewReference);
  if (
    !binding ||
    !codexOwnerRemoteViewReferenceIsCurrent(viewReference, binding) ||
    typeof binding.threadId !== "string" ||
    !binding.threadId ||
    typeof binding.latestTurnId !== "string" ||
    !binding.latestTurnId ||
    typeof binding.expectedModel !== "string" ||
    !binding.expectedModel ||
    binding.expectedModel.toLowerCase() === "unknown" ||
    typeof binding.expectedModelProvider !== "string" ||
    !binding.expectedModelProvider ||
    !Number.isFinite(binding.observedAtMs) ||
    binding.observedAtMs <= 0
  )
    return {
      started: false,
      reason: "The owner Codex view is no longer current",
    };
  return startCodexContinuationJob(
    binding.threadId,
    operationId,
    binding.expectedModel,
    binding.observedAtMs,
    codexContinuationIntents.OwnerContinue,
    binding,
    viewReference,
  );
};
// Finish all awaited owner reads before native session/scope authorization.
// This is preparation only: no attempted marker and no turn/start are written.
state.confirmCodexContinuation = (jobId) => {
  const id = typeof jobId === "string" ? jobId : "";
  const job = state.codexContinuationJobs[id];
  if (!job || !Object.values(codexContinuationIntents).includes(job.intent))
    return {
      started: false,
      reason: "An exact continuation is required",
    };
  if (["confirming", "confirmed"].includes(job.status))
    return { started: true, jobId: id };
  const confirm = Object.getOwnPropertyDescriptor(job, "confirm")?.value;
  if (
    job.status !== "prepared" ||
    typeof confirm !== "function" ||
    codexContinuationMutationAttempted(job)
  )
    return { started: false, reason: "Continuation is not prepared" };
  delete job.confirm;
  delete job.commit;
  job.status = "confirming";
  void confirm().then(
    (result) => {
      if (
        state.codexContinuationJobs[id] !== job ||
        job.status !== "confirming"
      )
        return;
      if (result.confirmed && typeof result.commit === "function") {
        Object.defineProperty(job, "commit", {
          value: result.commit,
          configurable: true,
        });
        job.status = "confirmed";
      } else
        Object.assign(job, { mutationAttempted: false }, result, {
          status: "completed",
        });
    },
    () => {
      if (
        state.codexContinuationJobs[id] !== job ||
        job.status !== "confirming"
      )
        return;
      Object.assign(job, {
        status: "completed",
        submitted: false,
        mutationAttempted: false,
        usageLimitDeferred:
          job.intent === codexContinuationIntents.UsageLimitResume,
        reason: "The Codex thread could not be confirmed",
      });
    },
  );
  return { started: true, jobId: id };
};
// Keep the owner-only adapter restricted while sharing one confirmation path.
state.confirmCodexOwnerContinuation = (jobId) => {
  if (
    typeof jobId !== "string" ||
    state.codexContinuationJobs[jobId]?.intent !==
      codexContinuationIntents.OwnerContinue
  )
    return {
      started: false,
      reason: "An exact owner continuation is required",
    };
  return state.confirmCodexContinuation(jobId);
};
state.cancelCodexContinuation = (jobId) => {
  const job = state.codexContinuationJobs[String(jobId || "")];
  if (!job)
    return { cancelled: true, notFound: true, mutationAttempted: false };
  if (codexContinuationMutationAttempted(job))
    return {
      cancelled: false,
      submitted: job.submitted === true,
      mutationAttempted: true,
    };
  delete job.confirm;
  delete job.commit;
  Object.assign(job, {
    status: "completed",
    submitted: false,
    mutationAttempted: false,
    reason: "Continuation authorization was revoked",
  });
  return { cancelled: true, mutationAttempted: false };
};
state.commitCodexContinuation = (jobId) => {
  const id = String(jobId || "");
  const job = state.codexContinuationJobs[id];
  if (codexContinuationMutationAttempted(job))
    return { started: true, jobId: id };
  const commit = job && Object.getOwnPropertyDescriptor(job, "commit")?.value;
  const isReady =
    job?.status === "confirmed" ||
    (job?.intent === codexContinuationIntents.AutoRecovery &&
      job.status === "prepared");
  if (!isReady || typeof commit !== "function")
    return {
      started: false,
      reason: "Continuation is not prepared and confirmed",
    };
  delete job.confirm;
  delete job.commit;
  job.status = "submitting";
  job.mutationAttempted = true;
  void commit().then(
    (result) => {
      if (state.codexContinuationJobs[id] !== job) return;
      Object.assign(job, result, { status: "completed" });
    },
    (error) => {
      if (state.codexContinuationJobs[id] !== job) return;
      Object.assign(job, {
        submitted: false,
        mutationAttempted: true,
        status: "completed",
        reason:
          job.intent === codexContinuationIntents.OwnerContinue
            ? "The owner continuation result is uncertain"
            : String(error?.message || error),
      });
    },
  );
  return { started: true, jobId: id };
};
state.readCodexContinuationJob = (jobId) => {
  const job = state.codexContinuationJobs[String(jobId || "")];
  if (!job || typeof job !== "object") return null;
  // Native reservation/acknowledgement checks consume only inert canonical
  // evidence. Never spread a retained job: that can invoke unrelated getters,
  // serialize a private view capability, or expose a commit closure.
  const projected = {};
  for (const key of [
    "status",
    "threadId",
    "expectedModel",
    "observedAtMs",
    "intent",
    "runtimeGeneration",
    "expectedBaseTurnId",
    "baseTurnId",
    "turnId",
    "reason",
  ]) {
    const descriptor = Object.getOwnPropertyDescriptor(job, key);
    if (!descriptor || !("value" in descriptor)) continue;
    const value = descriptor.value;
    if (
      typeof value === "string" ||
      (typeof value === "number" && Number.isFinite(value))
    )
      projected[key] = value;
  }
  let invalidEvidence = false;
  for (const key of [
    "submitted",
    "mutationAttempted",
    "usageLimitDeferred",
    "usageLimitInitialReadUnavailable",
  ]) {
    const descriptor = Object.getOwnPropertyDescriptor(job, key);
    if (!descriptor) continue;
    if (!("value" in descriptor) || typeof descriptor.value !== "boolean") {
      invalidEvidence = true;
      continue;
    }
    projected[key] = descriptor.value;
  }
  projected.mutationAttempted =
    invalidEvidence || codexContinuationMutationAttempted(projected);
  return projected;
};
