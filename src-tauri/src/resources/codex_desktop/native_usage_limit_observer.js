// The guardian samples the verified local app-server clients. A terminal snapshot
// alone cannot establish that a session was running while we observed it.
const codexNativeUsageLimitPageSize = 32;
const codexNativeUsageLimitConcurrentReads = 8;
// Return before the guardian's four-second CDP deadline.
const codexNativeUsageLimitBridgeWaitMs = 3000;
const codexNativeUsageLimitPendingFreshnessMs = 30000;
const codexNativeUsageLimitAcknowledgementGraceMs = 30000;
const codexNativeUsageLimitUnlistedGraceMs = 30000;
let codexNativeUsageLimitScan = null;
const codexNativeUsageLimitSources = new WeakMap();
const codexNativeUsageLimitTurns = new Map();
const codexNativeUsageLimitAcknowledgements = new Map();

const codexNativeUsageLimitSourceIsCurrent = (source) =>
  !!source &&
  codexNativeUsageLimitSources.get(source.client) === source &&
  continuationInstallationIsCurrent() &&
  source.generation === state.runtimeGeneration &&
  codexContinuationClientIsCurrent(source.client) &&
  codexVerifiedAppServerOriginalRequest(
    source.client,
    codexContinuationRequestPatchVersion,
  ) === source.request;

const codexNativeUsageLimitSourceForClient = (client) => {
  if (!client || !codexContinuationClientIsCurrent(client)) return null;
  const current = codexNativeUsageLimitSources.get(client);
  if (codexNativeUsageLimitSourceIsCurrent(current)) return current;
  const request = codexVerifiedAppServerOriginalRequest(
    client,
    codexContinuationRequestPatchVersion,
  );
  if (!request) return null;
  const source = { client, request, generation: state.runtimeGeneration };
  codexNativeUsageLimitSources.set(client, source);
  return source;
};

const codexNativeUsageLimitCurrentSources = () =>
  codexContinuationLocalClients()
    .map(codexNativeUsageLimitSourceForClient)
    .filter(codexNativeUsageLimitSourceIsCurrent);

const codexNativeUsageLimitScanIsCurrent = (scan) =>
  codexNativeUsageLimitScan === scan &&
  scan.generation === state.runtimeGeneration &&
  continuationInstallationIsCurrent();

const codexNativeUsageLimitSameAction = (evidence, current) => {
  // An action in another thread advances the shared revision and copies the
  // local projection. Only this thread's action IDs, methods and times matter.
  return (
    !!evidence &&
    !!current &&
    Object.keys(evidence).every(
      (key) =>
        key === "documentRevision" ||
        key === "localRecord" ||
        evidence[key] === current[key],
    )
  );
};

const codexNativeUsageLimitActionIsCurrent = (threadId, evidence) =>
  codexNativeUsageLimitSameAction(
    evidence,
    readCodexOwnerUserActionEvidence(threadId),
  );

const codexNativeUsageLimitAcknowledgementIsCurrent = (
  threadId,
  acknowledgement,
  now,
) => {
  const age = now - acknowledgement.receivedAtMs;
  return (
    age >= 0 &&
    age <= codexNativeUsageLimitAcknowledgementGraceMs &&
    codexNativeUsageLimitSourceIsCurrent(acknowledgement.source) &&
    codexNativeUsageLimitActionIsCurrent(threadId, acknowledgement.userAction)
  );
};

const keepCodexNativeUsageLimitRunningProof = (previous) =>
  previous &&
  codexNativeUsageLimitSourceIsCurrent(previous.source) &&
  codexNativeUsageLimitActionIsCurrent(previous.threadId, previous.userAction)
    ? { ...previous, observedAtMs: undefined, readFailed: true }
    : null;

const captureCodexNativeUsageLimitAcknowledgement = (
  client,
  threadId,
  model,
  continuation = null,
) => {
  try {
    if (!threadId || (model != null && !codexOwnerRemoteId(model))) return;

    const source = codexNativeUsageLimitSourceForClient(client);
    if (
      !codexNativeUsageLimitSourceIsCurrent(source) ||
      (continuation && source.request !== continuation.request)
    )
      return;
    const userAction = captureCodexOwnerUserActionEvidence(threadId);
    if (
      !userAction ||
      (!continuation && userAction.localMethod !== "turn/start")
    )
      return;

    return (response) => {
      try {
        if (
          !codexNativeUsageLimitSourceIsCurrent(source) ||
          !codexNativeUsageLimitActionIsCurrent(threadId, userAction)
        )
          return;
        const turn = codexContinuationOwnData(response, "turn");
        if (codexContinuationOwnData(turn, "status") !== "inProgress") return;
        const turnId = readCodexContinuationAcknowledgement(
          response,
          threadId,
          continuation?.baseTurnId ?? null,
        );
        const turnModel = codexContinuationOwnData(turn, "model");
        if (
          !turnId ||
          (turnModel != null &&
            (!codexOwnerRemoteId(turnModel) ||
              (model != null && turnModel !== model)))
        )
          return;
        codexNativeUsageLimitAcknowledgements.set(threadId, {
          source,
          turnId,
          model: model ?? turnModel,
          userAction,
          receivedAtMs: Date.now(),
        });
      } catch {
        // An unreadable observation must not affect the original request.
      }
    };
  } catch {
    return undefined;
  }
};

const captureCodexNativeUsageLimitTurnStart = (client, method, params) => {
  try {
    const wrapped = method === "send-cli-request-for-host";
    const actualMethod = wrapped
      ? codexContinuationOwnData(params, "method")
      : method;
    if (
      actualMethod !== "turn/start" ||
      !isLocalAppServerTarget(client, params)
    )
      return;
    const requestParams = wrapped
      ? codexContinuationOwnData(params, "params")
      : params;
    return captureCodexNativeUsageLimitAcknowledgement(
      client,
      codexOwnerRemoteId(codexContinuationOwnData(requestParams, "threadId")),
      codexContinuationOwnData(requestParams, "model"),
    );
  } catch {
    return undefined;
  }
};

const codexNativeUsageLimitReadLoaded = async (scan, source) => {
  const threads = new Set();
  const cursors = new Set();
  let cursor = null;
  do {
    const result = await readOwnedCodexContinuationRequest(
      source.client,
      "thread/loaded/list",
      { cursor, limit: codexNativeUsageLimitPageSize },
    );
    if (
      !codexNativeUsageLimitScanIsCurrent(scan) ||
      !codexNativeUsageLimitSourceIsCurrent(source) ||
      result.request !== source.request
    )
      throw new Error("Codex loaded-session source changed");
    const page = codexOwnerRemoteReadPage(
      result.response,
      "data",
      codexNativeUsageLimitPageSize,
    );
    for (let row = 0; row < page.length; row++) {
      const threadId = codexOwnerRemoteId(
        codexContinuationOwnData(page.values, String(row)),
      );
      if (!threadId || threads.has(threadId))
        throw new Error("Codex loaded-session binding is unavailable");
      threads.add(threadId);
    }
    const nextCursor = codexContinuationOwnData(result.response, "nextCursor");
    if (cursors.has(nextCursor))
      throw new Error("Codex loaded-session cursor repeated");
    cursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor !== null);
  return threads;
};

const codexNativeUsageLimitReadTurn = async (
  scan,
  source,
  threadId,
  previous,
  idlePeers,
  proxyHeads,
) => {
  const userAction = captureCodexOwnerUserActionEvidence(threadId);
  if (!userAction) throw new Error("Codex user-action evidence is unavailable");
  const { thread, request } = await readExactCodexContinuationThread(
    source.client,
    threadId,
    false,
  );
  if (
    request !== source.request ||
    !codexNativeUsageLimitScanIsCurrent(scan) ||
    !codexNativeUsageLimitSourceIsCurrent(source) ||
    !codexNativeUsageLimitActionIsCurrent(threadId, userAction)
  )
    throw new Error("Codex thread evidence changed while reading metadata");
  const status = codexContinuationOwnData(
    codexContinuationOwnData(thread, "status"),
    "type",
  );
  const threadSource = codexContinuationOwnData(thread, "threadSource");
  const sessionSource = codexContinuationOwnData(thread, "source");
  const readAcknowledgement = () => {
    const acknowledgement = codexNativeUsageLimitAcknowledgements.get(threadId);
    return acknowledgement?.source === source ? acknowledgement : null;
  };
  if (
    codexContinuationOwnData(thread, "ephemeral") === true ||
    codexContinuationOwnData(thread, "parentThreadId") != null ||
    codexContinuationOwnData(sessionSource, "subAgent") != null ||
    (threadSource != null && threadSource !== "user")
  ) {
    if (readAcknowledgement())
      codexNativeUsageLimitAcknowledgements.delete(threadId);
    return null;
  }
  if (!["active", "idle", "systemError", "notLoaded"].includes(status))
    throw new Error("Codex thread status is unavailable");

  const acknowledgement = readAcknowledgement();
  const priorObservation =
    previous?.source === source &&
    codexNativeUsageLimitSameAction(previous.userAction, userAction)
      ? previous
      : null;
  const acknowledgedTurn =
    acknowledgement &&
    codexNativeUsageLimitSameAction(acknowledgement.userAction, userAction)
      ? acknowledgement
      : null;
  if (
    acknowledgement &&
    !acknowledgedTurn &&
    codexNativeUsageLimitActionIsCurrent(threadId, userAction)
  )
    codexNativeUsageLimitAcknowledgements.delete(threadId);
  const readLatestTurn = () =>
    codexNativeUsageLimitReadLatestTurn({
      scan,
      source,
      threadId,
      thread,
      status,
      userAction,
      previous,
      priorObservation,
      acknowledgedTurn,
      readAcknowledgement,
      proxyHeads,
    });
  const needsProxyHead =
    proxyHeads && status !== "notLoaded" && !scan.proxyWaitExpired;
  if (
    status !== "active" &&
    (priorObservation == null || priorObservation.runningProof === false) &&
    acknowledgedTurn == null &&
    !needsProxyHead
  ) {
    idlePeers?.set(source, readLatestTurn);
    return null;
  }
  return readLatestTurn();
};

const codexNativeUsageLimitReadLatestTurn = async ({
  scan,
  source,
  threadId,
  thread,
  status,
  userAction,
  previous,
  priorObservation,
  acknowledgedTurn,
  readAcknowledgement,
  proxyHeads,
}) => {
  const threadModelField = codexOwnerRemoteOwnData(thread, "model");
  const threadModel = codexOwnerRemoteId(threadModelField);
  const modelProvider = codexOwnerRemoteId(
    codexContinuationOwnData(thread, "modelProvider"),
  );
  if (
    (threadModelField != null && !threadModel) ||
    threadModel?.toLowerCase() === "unknown" ||
    !modelProvider
  )
    throw new Error("Codex thread model metadata is unavailable");
  if (
    status !== "active" &&
    !acknowledgedTurn &&
    priorObservation &&
    priorObservation.modelProvider !== modelProvider
  )
    return {
      ...priorObservation,
      modelProvider,
      observedAtMs: undefined,
      runningProof: false,
      readFailed: false,
    };

  const readAtMs = proxyHeads ? Date.now() : null;
  const page = await readOwnedCodexContinuationRequest(
    source.client,
    "thread/turns/list",
    {
      threadId,
      cursor: null,
      limit: 1,
      sortDirection: "desc",
      itemsView: "notLoaded",
    },
  );
  if (
    page.request !== source.request ||
    !codexNativeUsageLimitScanIsCurrent(scan) ||
    !codexNativeUsageLimitSourceIsCurrent(source) ||
    !codexNativeUsageLimitActionIsCurrent(threadId, userAction)
  )
    throw new Error(
      "Codex thread evidence changed while reading the latest turn",
    );
  const { values } = codexOwnerRemoteReadPage(page.response, "data", 1);
  const turn = codexContinuationOwnData(values, "0");
  const turnId = codexOwnerRemoteId(codexContinuationOwnData(turn, "id"));
  const turnStatus = codexContinuationOwnData(turn, "status");
  const turnModelField = codexOwnerRemoteOwnData(turn, "model");
  const turnModel = codexOwnerRemoteId(turnModelField);
  if (
    !turnId ||
    !["inProgress", "completed", "failed", "interrupted"].includes(
      turnStatus,
    ) ||
    codexContinuationOwnData(turn, "itemsView") !== "notLoaded" ||
    codexOwnerRemoteArrayLength(codexContinuationOwnData(turn, "items")) !==
      0 ||
    (turnModelField != null && !turnModel)
  )
    throw new Error("Codex latest-turn metadata is unavailable");
  const previousTurn =
    priorObservation?.turnId === turnId &&
    priorObservation.runningProof !== false &&
    priorObservation.modelProvider === modelProvider
      ? priorObservation
      : null;
  const currentAcknowledgement = readAcknowledgement();
  const matchedAcknowledgement =
    currentAcknowledgement &&
    codexNativeUsageLimitSameAction(
      currentAcknowledgement.userAction,
      userAction,
    )
      ? currentAcknowledgement
      : null;
  if (matchedAcknowledgement && matchedAcknowledgement.turnId !== turnId) {
    // The acknowledgement can arrive before the latest-turn read includes it.
    // Keep the count partial until the exact turn is readable or proof expires.
    return null;
  }
  // The metadata and head can straddle a state change. Wait for the latest
  // turn to agree with the thread's loaded activity before displacing proof.
  if (
    proxyHeads &&
    status !== "notLoaded" &&
    (status === "active") === (turnStatus === "inProgress")
  )
    proxyHeads.set(source, { turnId, userAction, readAtMs });
  if (matchedAcknowledgement)
    codexNativeUsageLimitAcknowledgements.delete(threadId);
  const modelEvidence = [
    threadModel,
    turnModel,
    previousTurn?.model,
    matchedAcknowledgement?.model,
  ];
  const model = modelEvidence.find((value) => value != null) ?? null;
  const currentTurn = {
    source,
    threadId,
    turnId,
    model,
    modelProvider,
    userAction,
  };
  // A peer without running proof can verify the failure binding or contradict
  // it. Its terminal observation cannot qualify a turn on its own.
  const rejectedTurn = { ...currentTurn, runningProof: false };
  if (
    model?.toLowerCase() === "unknown" ||
    modelEvidence.some((value) => value != null && value !== model)
  )
    return status === "active" && previous?.turnId === turnId
      ? { source, threadId, turnId }
      : rejectedTurn;
  const pendingStateIsClear = codexOwnerContinuationPendingStateIsClear(thread);
  if (
    status === "active" &&
    turnStatus === "inProgress" &&
    pendingStateIsClear
  ) {
    // An interrupt can leave the same turn active until the server settles.
    // A replacement can be sampled when its server start time follows the stop.
    const actionMethods = [userAction.localMethod, userAction.persistedMethod];
    const startedAtSeconds = codexContinuationOwnData(turn, "startedAt");
    const startedAfterInterrupt =
      actionMethods.includes("turn/interrupt") &&
      actionMethods.every(
        (method) =>
          method === null ||
          method === "turn/start" ||
          method === "turn/interrupt",
      ) &&
      Number.isSafeInteger(startedAtSeconds) &&
      Number.isSafeInteger(startedAtSeconds * 1000) &&
      startedAtSeconds * 1000 >
        Math.max(userAction.localAtMs ?? 0, userAction.persistedAtMs ?? 0);
    if (
      matchedAcknowledgement ||
      previousTurn ||
      ((previous?.turnId !== turnId || previous.runningProof === false) &&
        (actionMethods.every(
          (method) => method === null || method === "turn/start",
        ) ||
          startedAfterInterrupt))
    )
      return currentTurn;
    if (previous?.turnId === turnId) return { source, threadId, turnId };
    return rejectedTurn;
  }
  const hasRunningProof = previousTurn || matchedAcknowledgement;
  // The metadata and latest-turn calls are separate. Keep the exact proof
  // while either snapshot shows activity and wait for both to settle.
  if (status === "active" || turnStatus === "inProgress")
    return hasRunningProof ? currentTurn : rejectedTurn;
  if (turnStatus !== "failed" && turnStatus !== "interrupted")
    return rejectedTurn;
  const error = codexContinuationOwnData(turn, "error");
  if (!codexContinuationIsTemporaryUsageLimit(error)) return rejectedTurn;
  if (status === "notLoaded" || !pendingStateIsClear)
    return hasRunningProof ? currentTurn : rejectedTurn;
  if (!hasRunningProof) return { ...rejectedTurn, settledUsageLimit: true };
  const verifiedAtMs = Date.now();
  return {
    ...currentTurn,
    observedAtMs: previousTurn?.observedAtMs ?? verifiedAtMs,
    verifiedAtMs,
  };
};

const readCodexNativeUsageLimitMarkers = () => {
  try {
    return readCodexContinuationMarkers();
  } catch {
    return null;
  }
};

const codexNativeUsageLimitBindingForThread = (
  threadId,
  now,
  readMarkers = readCodexNativeUsageLimitMarkers,
) => {
  if (codexNativeUsageLimitScan?.pendingSharedThreads?.has(threadId))
    return null;
  const observations = codexNativeUsageLimitTurns.get(threadId);
  if (!observations) return null;
  let candidate;
  let reportedFailure;
  let conflicting = false;
  let unreadable = false;
  for (const turn of observations.values()) {
    if (
      turn.unlistedAtMs != null ||
      !codexNativeUsageLimitSourceIsCurrent(turn.source)
    )
      continue;
    if (
      turn.userAction &&
      !codexNativeUsageLimitActionIsCurrent(threadId, turn.userAction)
    )
      continue;
    if (turn.readFailed) {
      unreadable = true;
      continue;
    }
    if (!turn.observedAtMs && !turn.settledUsageLimit) {
      conflicting = true;
      continue;
    }
    if (
      turn.observedAtMs &&
      (now < turn.verifiedAtMs ||
        now - turn.verifiedAtMs > codexNativeUsageLimitPendingFreshnessMs)
    )
      continue;
    if (
      reportedFailure &&
      (reportedFailure.turnId !== turn.turnId ||
        reportedFailure.modelProvider !== turn.modelProvider ||
        (reportedFailure.model != null &&
          turn.model != null &&
          reportedFailure.model !== turn.model))
    )
      conflicting = true;
    if (
      !reportedFailure ||
      (reportedFailure.model == null && turn.model != null)
    )
      reportedFailure = turn;
    if (
      turn.observedAtMs &&
      (!candidate || (candidate.model == null && turn.model != null))
    )
      candidate = turn;
  }
  if (!candidate) return null;
  // A verified disagreement can invalidate this thread even in a partial
  // snapshot. An unreadable peer only defers this renderer's endorsement.
  if (conflicting) return { conflicting: true };
  if (unreadable) return null;
  const markers = readMarkers();
  if (!markers || Object.hasOwn(markers, `${threadId}:${candidate.turnId}`))
    return null;
  return { candidate };
};

const projectCodexNativeUsageLimitCandidate = ({
  threadId,
  turnId,
  model,
  modelProvider,
  observedAtMs,
}) => ({ threadId, turnId, model, modelProvider, observedAtMs });

state.getCodexNativeUsageLimitCandidate = (threadId, turnId, client) => {
  const candidate = codexNativeUsageLimitBindingForThread(
    threadId,
    Date.now(),
  )?.candidate;
  return candidate &&
    candidate.turnId === turnId &&
    (!client || candidate.source.client === client)
    ? projectCodexNativeUsageLimitCandidate(candidate)
    : null;
};

const codexNativeUsageLimitStaleProxyTurns = (
  scan,
  proxyTurnsByThread,
  now,
) => {
  const stale = [];
  for (const [threadId, proxyTurns] of proxyTurnsByThread) {
    const scannedProxyTurns = scan.proxyTurnsByThread.get(threadId);
    const heads = scan.proxyHeads.get(threadId);
    if (!scannedProxyTurns || !heads?.size) continue;
    const first = heads.values().next().value;
    let earliestReadAtMs = first.readAtMs;
    let agreed = true;
    for (const [source, head] of heads) {
      if (
        head.turnId !== first.turnId ||
        now < head.readAtMs ||
        now - head.readAtMs > codexNativeUsageLimitPendingFreshnessMs ||
        !codexNativeUsageLimitSourceIsCurrent(source) ||
        !codexNativeUsageLimitActionIsCurrent(threadId, head.userAction)
      ) {
        agreed = false;
        break;
      }
      earliestReadAtMs = Math.min(earliestReadAtMs, head.readAtMs);
    }
    if (!agreed) continue;
    const ownerActionAtMs = Math.max(
      first.userAction.localAtMs ?? 0,
      first.userAction.persistedAtMs ?? 0,
    );
    for (const proxy of proxyTurns) {
      // The request timestamp can predate the read even when the failure was
      // recorded later. Limit this scan to tickets it received at startup.
      if (
        proxy.observedAtMs <= earliestReadAtMs &&
        scannedProxyTurns.some(
          (scanned) =>
            scanned.turnId === proxy.turnId &&
            scanned.observedAtMs === proxy.observedAtMs,
        ) &&
        (proxy.turnId !== first.turnId || ownerActionAtMs > proxy.observedAtMs)
      )
        stale.push(proxy);
    }
  }
  return stale;
};

const scanCodexNativeUsageLimitCandidates = async (scan) => {
  const { sources } = scan;
  try {
    const acknowledgements = new Map(codexNativeUsageLimitAcknowledgements);
    const loadedBySource = new Map();
    for (
      let index = 0;
      index < sources.length && codexNativeUsageLimitScanIsCurrent(scan);
      index += codexNativeUsageLimitConcurrentReads
    ) {
      const batch = sources.slice(
        index,
        index + codexNativeUsageLimitConcurrentReads,
      );
      const results = await Promise.all(
        batch.map((source) =>
          codexNativeUsageLimitReadLoaded(scan, source).catch(() => null),
        ),
      );
      batch.forEach((source, offset) =>
        loadedBySource.set(source, results[offset]),
      );
    }
    if (!codexNativeUsageLimitScanIsCurrent(scan)) return false;
    const threadSources = new Map();
    let allThreadsRead = true;
    for (const [source, loaded] of loadedBySource) {
      if (!loaded) {
        allThreadsRead = false;
        continue;
      }
      for (const threadId of loaded) {
        // Loaded thread IDs alone cannot identify an app-server connection.
        if (!threadSources.has(threadId))
          threadSources.set(threadId, new Set());
        threadSources.get(threadId).add(source);
      }
    }
    scan.threadSources = threadSources;
    const allSourcesListed = allThreadsRead;
    const now = Date.now();
    for (const [threadId, observations] of codexNativeUsageLimitTurns) {
      for (const [source, previous] of observations) {
        const loaded = loadedBySource.get(source);
        const unlistedAge = now - (previous.unlistedAtMs ?? now);
        if (
          !codexNativeUsageLimitSourceIsCurrent(source) ||
          unlistedAge < 0 ||
          unlistedAge > codexNativeUsageLimitUnlistedGraceMs
        ) {
          observations.delete(source);
        } else if (loaded && !loaded.has(threadId)) {
          // A thread can disappear from the in-memory list while a turn
          // settles. Keep exact running proof until a short reload window
          // expires, without treating the absent thread as a candidate.
          const proof =
            previous.runningProof !== false &&
            keepCodexNativeUsageLimitRunningProof(previous);
          if (proof)
            observations.set(source, {
              ...proof,
              unlistedAtMs: previous.unlistedAtMs ?? now,
            });
          else observations.delete(source);
        } else if (
          threadSources.has(threadId) &&
          (loaded || previous.unlistedAtMs == null)
        ) {
          // Keep reading an already observed turn through its exact client.
          threadSources.get(threadId).add(source);
        } else if (previous.unlistedAtMs == null) {
          const proof = keepCodexNativeUsageLimitRunningProof(previous);
          if (proof) observations.set(source, proof);
          else observations.delete(source);
        }
      }
      if (!observations.size) codexNativeUsageLimitTurns.delete(threadId);
    }
    // A start acknowledged during pagination may first appear on the next pass.
    for (const [threadId, acknowledgement] of acknowledgements) {
      if (
        codexNativeUsageLimitAcknowledgements.get(threadId) !== acknowledgement
      )
        continue;
      if (
        !codexNativeUsageLimitAcknowledgementIsCurrent(
          threadId,
          acknowledgement,
          now,
        )
      )
        codexNativeUsageLimitAcknowledgements.delete(threadId);
      else {
        if (!threadSources.has(threadId))
          threadSources.set(threadId, new Set());
        threadSources.get(threadId).add(acknowledgement.source);
      }
    }
    const loaded = Array.from(threadSources);
    scan.pendingSharedThreads = new Set(
      loaded.filter(([, sources]) => sources.size > 1).map(([id]) => id),
    );
    let nextThread = 0;
    await Promise.all(
      Array.from(
        {
          length: Math.min(loaded.length, codexNativeUsageLimitConcurrentReads),
        },
        async () => {
          while (
            nextThread < loaded.length &&
            codexNativeUsageLimitScanIsCurrent(scan)
          ) {
            const [threadId, listedSources] = loaded[nextThread++];
            const previous = codexNativeUsageLimitTurns.get(threadId);
            const acknowledgement =
              codexNativeUsageLimitAcknowledgements.get(threadId);
            if (
              acknowledgement &&
              codexNativeUsageLimitSourceIsCurrent(acknowledgement.source)
            )
              listedSources.add(acknowledgement.source);
            if (listedSources.size > 1) scan.pendingSharedThreads.add(threadId);
            const observations = new Map();
            for (const [source, turn] of previous ?? []) {
              if (turn.unlistedAtMs != null && !listedSources.has(source))
                observations.set(source, turn);
            }
            const idlePeers = listedSources.size > 1 ? new Map() : null;
            // Verify the latest turn on every client that listed this thread.
            // Cached observations and acknowledgements cannot verify listing.
            const proxyHeads =
              scan.proxyTurnsByThread.has(threadId) &&
              allSourcesListed &&
              [...listedSources].every((source) =>
                loadedBySource.get(source)?.has(threadId),
              )
                ? new Map()
                : null;
            const observe = async (source, read) => {
              const turn = await read.catch(() => {
                allThreadsRead = false;
                return (
                  keepCodexNativeUsageLimitRunningProof(
                    previous?.get(source),
                  ) ??
                  (listedSources.size > 1 ? { source, readFailed: true } : null)
                );
              });
              if (turn) observations.set(source, turn);
            };
            for (const source of listedSources) {
              await observe(
                source,
                codexNativeUsageLimitReadTurn(
                  scan,
                  source,
                  threadId,
                  previous?.get(source),
                  idlePeers,
                  proxyHeads,
                ),
              );
              if (!codexNativeUsageLimitScanIsCurrent(scan)) return;
            }
            // Read the latest turn from an idle peer only when it can affect
            // a candidate. Reuse its metadata from this scan.
            if (
              idlePeers?.size &&
              [...observations.values()].some((turn) => turn.observedAtMs)
            ) {
              for (const [source, readLatestTurn] of idlePeers) {
                await observe(source, readLatestTurn());
                if (!codexNativeUsageLimitScanIsCurrent(scan)) return;
              }
            }
            if (
              previous &&
              ![...observations.values()].some((turn) => turn.observedAtMs) &&
              [...observations].some(([source, turn]) => {
                const prior = previous.get(source);
                return (
                  prior?.observedAtMs &&
                  !turn.readFailed &&
                  ((turn.runningProof === false && !turn.settledUsageLimit) ||
                    (turn.userAction && turn.turnId !== prior.turnId))
                );
              })
            ) {
              // A verified change to a previously counted failure must reach
              // the guardian even if another thread makes this scan partial.
              scan.invalidatedThreads.add(threadId);
            }
            if (
              !Array.from(observations.values()).some(
                (turn) => !turn.readFailed && turn.runningProof !== false,
              )
            ) {
              // Once no source has running proof, an old terminal read has
              // nothing to contradict. Resume metadata-only polling.
              for (const [source, turn] of observations) {
                if (turn.runningProof === false) observations.delete(source);
              }
            }
            // Reconcile a thread's clients together so a faster response
            // cannot briefly publish a conflicting candidate.
            if (observations.size)
              codexNativeUsageLimitTurns.set(threadId, observations);
            else codexNativeUsageLimitTurns.delete(threadId);
            if (proxyHeads?.size === listedSources.size)
              scan.proxyHeads.set(threadId, proxyHeads);
            scan.pendingSharedThreads.delete(threadId);
          }
        },
      ),
    );
    return (
      allThreadsRead &&
      codexNativeUsageLimitScanIsCurrent(scan) &&
      ![...codexNativeUsageLimitAcknowledgements].some(
        ([threadId, acknowledgement]) =>
          codexNativeUsageLimitAcknowledgementIsCurrent(
            threadId,
            acknowledgement,
            Date.now(),
          ),
      )
    );
  } catch {
    if (codexNativeUsageLimitScanIsCurrent(scan)) {
      for (const [threadId, observations] of codexNativeUsageLimitTurns) {
        for (const [source, previous] of observations) {
          const proof = keepCodexNativeUsageLimitRunningProof(previous);
          if (proof) observations.set(source, proof);
          else observations.delete(source);
        }
        if (!observations.size) codexNativeUsageLimitTurns.delete(threadId);
      }
    }
    return false;
  }
};

state.collectCodexNativeUsageLimitCandidates = async (proxyTurns = []) => {
  if (
    codexNativeUsageLimitScan &&
    (!codexNativeUsageLimitScanIsCurrent(codexNativeUsageLimitScan) ||
      !codexNativeUsageLimitScan.sources.every(
        codexNativeUsageLimitSourceIsCurrent,
      ))
  ) {
    codexNativeUsageLimitScan = null;
    return null;
  }
  const proxyTurnsByThread = new Map();
  for (const proxyTurn of Array.isArray(proxyTurns) ? proxyTurns : []) {
    const threadId = codexOwnerRemoteId(
      codexContinuationOwnData(proxyTurn, "threadId"),
    );
    const turnId = codexOwnerRemoteId(
      codexContinuationOwnData(proxyTurn, "turnId"),
    );
    const observedAtMs = codexContinuationOwnData(proxyTurn, "observedAtMs");
    if (
      !threadId ||
      !turnId ||
      !Number.isSafeInteger(observedAtMs) ||
      observedAtMs <= 0
    )
      continue;
    if (!proxyTurnsByThread.has(threadId)) proxyTurnsByThread.set(threadId, []);
    proxyTurnsByThread.get(threadId).push({ threadId, turnId, observedAtMs });
  }
  if (!codexNativeUsageLimitScan) {
    const sources = codexNativeUsageLimitCurrentSources();
    if (!sources.length) return null;
    codexNativeUsageLimitScan = {
      sources,
      generation: state.runtimeGeneration,
      threadSources: null,
      invalidatedThreads: new Set(),
      proxyTurnsByThread,
      proxyHeads: new Map(),
      proxyWaitExpired: false,
    };
  }
  const scan = codexNativeUsageLimitScan;
  scan.finished ??= scanCodexNativeUsageLimitCandidates(scan);
  let timer;
  try {
    const completed = await Promise.race([
      scan.finished,
      new Promise((resolve) => {
        timer = setTimeout(() => {
          scan.proxyWaitExpired = true;
          resolve(null);
        }, codexNativeUsageLimitBridgeWaitMs);
      }),
    ]);
    if (completed !== null && codexNativeUsageLimitScan === scan)
      codexNativeUsageLimitScan = null;
    if (!scan.sources.every(codexNativeUsageLimitSourceIsCurrent)) return null;
    // Keep recent evidence while the scan is pending. The next complete scan
    // replaces it, and continuation re-reads the exact turn before sending.
    const now = Date.now();
    const candidates = [];
    const conflictingThreadIds = [];
    let markers;
    const readMarkers = () => {
      if (markers === undefined) markers = readCodexNativeUsageLimitMarkers();
      return markers;
    };
    const threadIds =
      scan.threadSources?.keys() ?? codexNativeUsageLimitTurns.keys();
    for (const threadId of threadIds) {
      const binding = codexNativeUsageLimitBindingForThread(
        threadId,
        now,
        readMarkers,
      );
      if (binding?.conflicting || scan.invalidatedThreads.has(threadId))
        conflictingThreadIds.push(threadId);
      else if (binding?.candidate)
        candidates.push(
          projectCodexNativeUsageLimitCandidate(binding.candidate),
        );
    }
    // If a client appeared during the scan, its loaded threads are sampled on
    // the next pass. Preserve independently confirmed candidates in the meantime.
    const sameSources =
      codexNativeUsageLimitCurrentSources().length === scan.sources.length;
    const complete = completed === true && sameSources;
    const staleProxyTurns = sameSources
      ? codexNativeUsageLimitStaleProxyTurns(scan, proxyTurnsByThread, now)
      : [];
    return {
      candidates,
      complete,
      ...(conflictingThreadIds.length ? { conflictingThreadIds } : {}),
      ...(staleProxyTurns.length ? { staleProxyTurns } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
};
