// Automatic continuation addresses a thread through its app-server client. It
// never reads or edits the visible composer, and never applies picker defaults.
const continuationStorageKey = "ccswitch-codex-continuations-v1";
const continuationActionStorageKey = "ccswitch-codex-user-turn-actions-v1";
// The Rust terminal classifier owns this embedded policy. The renderer runs
// without a Rust callback while validating an exact failed thread.
const continuationTerminalErrorPolicy = __CCSWITCH_TERMINAL_ERROR_POLICY__;
if (
  continuationTerminalErrorPolicy.schemaVersion !== 1 ||
  !continuationTerminalErrorPolicy.categories.length ||
  !continuationTerminalErrorPolicy.cancelledCode
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
const codexContinuationTerminalErrorCode = (eventName, payload) => {
  if (continuationTerminalErrorPolicy.cancelledEvents.includes(eventName))
    return continuationTerminalErrorPolicy.cancelledCode;
  // Match each field separately, so neighboring fields cannot form a marker.
  const summary = continuationTerminalErrorPolicy.summaryPaths
    .map((pointer) => continuationTerminalErrorAtPath(payload, pointer))
    .filter((value) => typeof value === "string")
    .map(normalizeContinuationTerminalError);
  const serialized = continuationTerminalErrorPolicy.serializedPaths
    .map((pointer) => continuationTerminalErrorAtPath(payload, pointer))
    .filter((value) => value !== undefined)
    .map((value) => normalizeContinuationTerminalError(JSON.stringify(value)));
  return (
    continuationTerminalErrorCategories.find(
      (category) =>
        summary.some((value) =>
          category.markers.some((marker) => value.includes(marker)),
        ) ||
        serialized.some((value) =>
          category.serializedMarkers.some((marker) => value.includes(marker)),
        ),
    )?.code || null
  );
};
state.codexUserTurnActions = state.codexUserTurnActions || {};
const rememberCodexUserTurnAction = (method, params) => {
  const wrapped = method === "send-cli-request-for-host";
  const actualMethod = wrapped ? params?.method : method;
  if (
    ![
      "turn/start",
      "turn/interrupt",
      "thread/rollback",
      "thread/revert",
      "thread/archive",
    ].includes(actualMethod)
  )
    return;
  const requestParams = wrapped ? params?.params : params;
  const threadId = String(requestParams?.threadId || "").trim();
  if (!threadId) return;
  const action = { method: actualMethod, atMs: Date.now() };
  state.codexUserTurnActions[threadId] = action;
  try {
    const actions = JSON.parse(
      localStorage.getItem(continuationActionStorageKey) || "{}",
    );
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [id, existing] of Object.entries(actions)) {
      if (Number(existing?.atMs || 0) < cutoff) delete actions[id];
    }
    actions[threadId] = action;
    localStorage.setItem(continuationActionStorageKey, JSON.stringify(actions));
  } catch (error) {
    recordFailure(error);
  }
};
const codexContinuationHasNewerUserAction = (threadId, observedAtMs) => {
  const actions = JSON.parse(
    localStorage.getItem(continuationActionStorageKey) || "{}",
  );
  return (
    Math.max(
      Number(actions?.[threadId]?.atMs || 0),
      Number(state.codexUserTurnActions[threadId]?.atMs || 0),
    ) > observedAtMs
  );
};
const continuationStatus = (value) =>
  String(value?.type || value || "").toLowerCase();
const classifyCodexContinuationThread = (thread, threadId, expectedModel) => {
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
  if (codexContinuationTerminalErrorCode("", { error: turn?.error })) {
    return {
      ready: false,
      reason: "The latest Codex turn needs a user action",
    };
  }
  // App-server reports a user stop as interrupted without an error. Recover
  // interrupted turns only when their error identifies an unexpected failure.
  if (
    status === "interrupted" &&
    !/overload|capacity|rate.?limit|server.?error|transport|connection|network|socket|fetch.?(?:failed|error)|econn(?:reset|refused)|enotfound|eai.?again|enetunreach|ehostunreach|unexpected|premature|eof|stream|timeout|timed.?out|crash|process.?exit/i.test(
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
  const model = String(thread?.model || turn?.model || "").trim();
  if (model && expectedModel && model !== expectedModel) {
    return {
      ready: false,
      reason: "The interrupted Codex thread changed model",
    };
  }
  return { ready: true, turnId };
};
const readCodexContinuationMarkers = () => {
  const value = JSON.parse(
    localStorage.getItem(continuationStorageKey) || "{}",
  );
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
};
const writeCodexContinuationMarker = (key, marker) => {
  const markers = readCodexContinuationMarkers();
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, existing] of Object.entries(markers)) {
    if (Number(existing?.writtenAt || 0) < cutoff) delete markers[id];
  }
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
state.isCodexContinuationRequestClient = isCodexContinuationRequestClient;
const readExactCodexContinuationThread = async (client, threadId) => {
  // The compatibility wrapper deliberately changes thread/resume providers.
  // Recovery uses the original client and never resumes or changes providers.
  const request = codexVerifiedAppServerOriginalRequest(
    client,
    codexContinuationRequestPatchVersion,
  );
  if (!isCodexContinuationRequestClient(client) || !request)
    throw new Error(
      "Codex Desktop request client was not found with its guarded activity hook",
    );
  let timer;
  let response;
  try {
    response = await Promise.race([
      request("thread/read", { threadId, includeTurns: true }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Codex thread/read timed out")),
          2500,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  const thread = response?.thread || response;
  if (String(thread?.id || "").trim() !== threadId)
    throw new Error("Codex returned a different thread");
  return { thread, request };
};
const continuationInstallationIsCurrent = () =>
  typeof installationIsCurrent !== "function" || installationIsCurrent();
const codexContinuationLocalClients = () =>
  (Array.isArray(state.appServerClients) ? state.appServerClients : []).filter(
    (client, index, array) =>
      isCodexContinuationRequestClient(client) &&
      array.indexOf(client) === index,
  );
const prepareCodexContinuation = async (
  threadId,
  recoveryId,
  expectedModel,
  observedAtMs,
) => {
  if (!Number.isFinite(observedAtMs) || observedAtMs <= 0)
    return {
      submitted: false,
      reason: "The interrupted turn observation time is required",
    };
  let clients = codexContinuationLocalClients();
  let reason = "Codex Desktop request client was not found";
  if (!clients.length) {
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
  if (codexContinuationHasNewerUserAction(threadId, observedAtMs))
    return {
      submitted: false,
      reason:
        "The user changed or stopped the Codex thread after this request started",
    };
  for (const client of clients) {
    let binding;
    try {
      binding = await readExactCodexContinuationThread(client, threadId);
    } catch (error) {
      reason = String(error?.message || error);
      continue;
    }
    const before = classifyCodexContinuationThread(
      binding.thread,
      threadId,
      expectedModel,
    );
    if (!before.ready) return { submitted: false, reason: before.reason };
    // A second read prevents a cached failure from resuming after the user has
    // already started a newer turn. No action is taken on active user work.
    const current = await readExactCodexContinuationThread(client, threadId);
    const ready = classifyCodexContinuationThread(
      current.thread,
      threadId,
      expectedModel,
    );
    if (!ready.ready || ready.turnId !== before.turnId) {
      return {
        submitted: false,
        reason:
          ready.reason || "The latest Codex turn changed before continuation",
      };
    }
    if (codexContinuationHasNewerUserAction(threadId, observedAtMs))
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
    return {
      prepared: true,
      commit: async () => {
        if (!continuationInstallationIsCurrent())
          return {
            submitted: false,
            mutationAttempted: false,
            reason: "The Codex compatibility runtime was replaced",
          };
        if (codexContinuationHasNewerUserAction(threadId, observedAtMs))
          return {
            submitted: false,
            mutationAttempted: false,
            reason:
              "The user changed or stopped the Codex thread before continuation",
          };
        if (
          !isCodexContinuationRequestClient(client) ||
          codexVerifiedAppServerOriginalRequest(
            client,
            codexContinuationRequestPatchVersion,
          ) !== preparedRequest
        )
          return {
            submitted: false,
            mutationAttempted: false,
            reason:
              "Codex Desktop request client was not found with its guarded activity hook",
          };
        const markerKey = `${threadId}:${failedTurnId}`;
        const previous = readCodexContinuationMarkers()[markerKey];
        if (previous)
          return {
            submitted: previous.status === "submitted",
            mutationAttempted: true,
            reason:
              previous.status === "submitted"
                ? "Continuation was already submitted for this interrupted turn"
                : "A continuation was already attempted; its result is uncertain",
          };
        // Persist before sending: a lost response or renderer restart must not
        // cause another continue to be submitted for the same failed turn.
        writeCodexContinuationMarker(markerKey, {
          recoveryId,
          status: "attempted",
        });
        try {
          const started = await preparedRequest("turn/start", {
            threadId,
            input: [{ type: "text", text: "continue" }],
          });
          const turnId = String(
            started?.turn?.id || started?.turnId || started?.turn_id || "",
          ).trim();
          const returnedThreadId = String(
            started?.threadId ||
              started?.thread_id ||
              started?.thread?.id ||
              "",
          ).trim();
          if (!turnId || (returnedThreadId && returnedThreadId !== threadId)) {
            return {
              submitted: false,
              mutationAttempted: true,
              reason: "Codex did not confirm the targeted continuation",
            };
          }
          writeCodexContinuationMarker(markerKey, {
            recoveryId,
            status: "submitted",
            turnId,
          });
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
            reason: `Continuation result is uncertain: ${String(error?.message || error)}`,
          };
        }
      },
    };
  }
  return { submitted: false, mutationAttempted: false, reason };
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
    : !["pending", "prepared"].includes(job.status);
};
state.codexContinuationJobs = state.codexContinuationJobs || {};
state.startCodexContinuation = (
  threadId,
  recoveryId,
  expectedModel,
  observedAtMs,
) => {
  const id = String(threadId || "").trim();
  const token = String(recoveryId || "").trim();
  const model = String(expectedModel || "").trim();
  if (!id || !token)
    return {
      started: false,
      reason: "An exact Codex thread and recovery id are required",
    };
  if (!Number.isFinite(observedAtMs) || observedAtMs <= 0)
    return {
      started: false,
      reason: "The interrupted turn observation time is required",
    };
  const existing = state.codexContinuationJobs[token];
  if (existing && existing.threadId !== id)
    return {
      started: false,
      reason: "The recovery id belongs to a different Codex thread",
    };
  if (
    existing &&
    (existing.expectedModel !== model || existing.observedAtMs !== observedAtMs)
  )
    return {
      started: false,
      reason: "The recovery id belongs to a different interrupted request",
    };
  if (
    ["pending", "prepared", "submitting"].includes(existing?.status) ||
    codexContinuationMutationAttempted(existing)
  ) {
    return { started: true, jobId: token };
  }
  const binding = { threadId: id, expectedModel: model, observedAtMs };
  const job = {
    ...binding,
    status: "pending",
    submitted: false,
    mutationAttempted: false,
  };
  state.codexContinuationJobs[token] = job;
  void prepareCodexContinuation(id, token, model, observedAtMs).then(
    (result) => {
      if (
        state.codexContinuationJobs[token] !== job ||
        job.status !== "pending"
      )
        return;
      if (result.prepared && typeof result.commit === "function") {
        // A function is kept outside the serialized job view. It retains the
        // exact twice-read client/thread binding until backend authorization.
        Object.defineProperty(job, "commit", {
          value: result.commit,
          configurable: true,
        });
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
        status: "completed",
        reason: String(error?.message || error),
      });
    },
  );
  return { started: true, jobId: token };
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
  if (job?.status !== "prepared" || typeof commit !== "function")
    return { started: false, reason: "Continuation is not prepared" };
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
        reason: String(error?.message || error),
      });
    },
  );
  return { started: true, jobId: id };
};
state.readCodexContinuationJob = (jobId) => {
  const job = state.codexContinuationJobs[String(jobId || "")];
  return job
    ? {
        ...job,
        mutationAttempted: codexContinuationMutationAttempted(job),
      }
    : null;
};
