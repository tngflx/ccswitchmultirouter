const rememberHandoffClient = (client) => {
  if (!client || typeof client.sendRequest !== "function") return;
  state.appServerClients = Array.isArray(state.appServerClients)
    ? state.appServerClients
    : [];
  if (!state.appServerClients.includes(client))
    state.appServerClients.push(client);
};
const readExactHandoffThread = async (client, threadId, includeTurns) => {
  const response = await client.sendRequest("thread/read", {
    threadId,
    includeTurns,
  });
  const thread = response?.thread || response;
  const returnedThreadId = String(thread?.id || "").trim();
  if (returnedThreadId !== threadId) {
    throw new Error(
      returnedThreadId
        ? `Codex returned the wrong task ${returnedThreadId} instead of ${threadId}`
        : `Codex did not return task ${threadId}`,
    );
  }
  return thread;
};
const discoverHandoffClients = async () => {
  try {
    await installAppServerPatch();
  } catch (error) {
    recordFailure(error);
  }
  const clients = (
    Array.isArray(state.appServerClients) ? state.appServerClients : []
  ).filter(
    (client, index, array) =>
      client &&
      typeof client.sendRequest === "function" &&
      array.indexOf(client) === index,
  );
  if (!clients.length)
    throw new Error("Codex Desktop request client was not found");
  return clients;
};
const extractAssistantText = (value, seen = new WeakSet()) => {
  if (!value || typeof value !== "object") return [];
  if (seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value))
    return value.flatMap((item) => extractAssistantText(item, seen));
  const type = String(value.type || "").toLowerCase();
  const role = String(value.role || "").toLowerCase();
  const own =
    role === "assistant" ||
    type === "agentmessage" ||
    type === "assistant_message"
      ? [value.text, value.content]
          .flatMap((item) =>
            typeof item === "string"
              ? [item]
              : extractAssistantText(item, seen),
          )
          .filter(Boolean)
      : [];
  return [
    ...own,
    ...Object.values(value).flatMap((item) => extractAssistantText(item, seen)),
  ];
};
const runSummarizeSession = async (threadId) => {
  const normalizedThreadId = String(threadId || "").trim();
  if (!normalizedThreadId) throw new Error("A Codex thread id is required");
  const clients = await discoverHandoffClients();
  let lastError = null;
  for (const client of clients) {
    let mutationAttempted = false;
    try {
      const idleDeadline = Date.now() + 30000;
      let before = null;
      const interrupted = new Set();
      while (Date.now() < idleDeadline) {
        before = await readExactHandoffThread(client, normalizedThreadId, true);
        if (String(before?.status?.type || "") !== "active") break;
        const active = [...(before?.turns || [])]
          .reverse()
          .find((turn) => String(turn?.status || "") === "inProgress");
        const activeTurnId = String(active?.id || "").trim();
        if (activeTurnId && !interrupted.has(activeTurnId)) {
          interrupted.add(activeTurnId);
          mutationAttempted = true;
          await client.sendRequest("turn/interrupt", {
            threadId: normalizedThreadId,
            turnId: activeTurnId,
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (String(before?.status?.type || "") === "active")
        throw new Error("Timed out interrupting the source turn");
      mutationAttempted = true;
      const started = await client.sendRequest("turn/start", {
        threadId: normalizedThreadId,
        input: [{ type: "text", text: __CCSWITCH_MANUAL_SUMMARY_PROMPT__ }],
      });
      const summaryTurnId = String(
        started?.turn?.id || started?.turnId || started?.turn_id || "",
      ).trim();
      if (!summaryTurnId)
        throw new Error("Codex did not return the manual summary turn id");
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 750));
        const current = await readExactHandoffThread(
          client,
          normalizedThreadId,
          true,
        );
        const turn = (current?.turns || []).find(
          (candidate) => candidate?.id === summaryTurnId,
        );
        const status = String(turn?.status || "").toLowerCase();
        if (status === "completed") {
          const summary = [...new Set(extractAssistantText(turn))]
            .map((value) => String(value).trim())
            .filter(Boolean)
            .join("\n")
            .trim();
          if (!summary)
            throw new Error("Codex completed without a manual handoff summary");
          return { summary };
        }
        if (status === "failed" || status === "interrupted")
          throw new Error(`Manual summary turn ${status}`);
      }
      throw new Error("Timed out waiting for the manual handoff summary");
    } catch (error) {
      if (mutationAttempted) throw error;
      lastError = error;
    }
  }
  throw lastError || new Error("Codex Desktop could not summarize the session");
};
const verifyFreshHandoff = (thread, source, newThreadId, phase) => {
  if (String(thread?.id || "").trim() !== newThreadId)
    throw new Error(`Codex returned the wrong fresh task during ${phase}`);
  if (
    String(thread?.projectId || "").trim() !==
    String(source.projectId || "").trim()
  )
    throw new Error(`Fresh session ${phase} changed project ownership`);
  if (
    source.cwd &&
    String(thread?.cwd || "")
      .replace(/\//g, "\\")
      .replace(/\\+$/, "")
      .toLowerCase() !==
      String(source.cwd).replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase()
  )
    throw new Error(`Fresh session ${phase} changed workspace`);
  for (const field of ["model", "modelProvider", "reasoningEffort"]) {
    if (
      source[field] != null &&
      JSON.stringify(thread?.[field]) !== JSON.stringify(source[field])
    )
      throw new Error(`Fresh session ${phase} changed ${field}`);
  }
  return String(thread?.name || "").trim();
};
const runFreshSessionFromSummary = async (sourceThreadId, summary) => {
  const sourceId = String(sourceThreadId || "").trim();
  const handoffSummary = String(summary || "").trim();
  if (!sourceId) throw new Error("A Codex source thread id is required");
  if (!handoffSummary) throw new Error("The manual handoff summary is empty");
  const clients = await discoverHandoffClients();
  let lastError = null;
  for (const client of clients) {
    let mutationAttempted = false;
    try {
      const source = await readExactHandoffThread(client, sourceId, false);
      const startParams = {
        config: {
          model_reasoning_effort: String(source?.reasoningEffort || "medium"),
        },
      };
      for (const key of ["cwd", "model", "modelProvider"])
        if (source?.[key]) startParams[key] = source[key];
      mutationAttempted = true;
      const started = await client.sendRequest("thread/start", startParams);
      let fresh = started?.thread || started;
      const newThreadId = String(
        fresh?.id || started?.threadId || started?.thread_id || "",
      ).trim();
      if (!newThreadId || newThreadId === sourceId)
        throw new Error("Codex did not create a fresh root session");
      if (fresh?.forkedFromId || fresh?.forked_from_id)
        throw new Error("Codex created a fork instead of a fresh root session");
      fresh = await readExactHandoffThread(client, newThreadId, false);
      let freshName = verifyFreshHandoff(
        fresh,
        source,
        newThreadId,
        "before acknowledgement",
      );
      if (!freshName) {
        await client.sendRequest("thread/name/set", {
          threadId: newThreadId,
          name: `Handoff - ${String(source?.name || "continued task").trim()}`.slice(
            0,
            120,
          ),
        });
        fresh = await readExactHandoffThread(client, newThreadId, false);
        freshName = verifyFreshHandoff(
          fresh,
          source,
          newThreadId,
          "after naming",
        );
      }
      const acknowledged = await client.sendRequest("turn/start", {
        threadId: newThreadId,
        input: [
          {
            type: "text",
            text: [
              "Fresh-session handoff from an oversized prior task.",
              "Use the summary below as reference context only. Do not execute its action items or call tools in this acknowledgement turn; wait for the user's next instruction.",
              handoffSummary,
            ].join("\n"),
          },
        ],
      });
      const turnId = String(
        acknowledged?.turn?.id ||
          acknowledged?.turnId ||
          acknowledged?.turn_id ||
          "",
      ).trim();
      if (!turnId)
        throw new Error(
          "Codex did not return the fresh-session handoff turn id",
        );
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 750));
        const current = await readExactHandoffThread(client, newThreadId, true);
        const turn = (current?.turns || []).find(
          (candidate) => candidate?.id === turnId,
        );
        const status = String(turn?.status || "").toLowerCase();
        if (status === "completed") {
          freshName =
            verifyFreshHandoff(
              current,
              source,
              newThreadId,
              "after acknowledgement",
            ) || freshName;
          try {
            await triggerLocalThreadCatalogSync();
          } catch (error) {
            recordFailure(error);
          }
          return { newThreadId, turnId, name: freshName };
        }
        if (status === "failed" || status === "interrupted")
          throw new Error(`Fresh-session handoff turn ${status}`);
      }
      throw new Error("Timed out waiting for the fresh-session handoff");
    } catch (error) {
      if (mutationAttempted) throw error;
      lastError = error;
    }
  }
  throw (
    lastError ||
    new Error("Codex Desktop could not create the fresh handoff session")
  );
};
state.summarizeJobs = state.summarizeJobs || {};
state.startSummarizeSession = (threadId) => {
  const id = String(threadId || "").trim();
  if (!id) throw new Error("A Codex thread id is required");
  const existing = Object.entries(state.summarizeJobs).find(
    ([, job]) => job?.threadId === id && job?.status === "pending",
  );
  if (existing) return { started: true, jobId: existing[0] };
  const jobId = `${id}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  state.summarizeJobs[jobId] = { status: "pending", threadId: id };
  void runSummarizeSession(id).then(
    (result) => {
      state.summarizeJobs[jobId] = {
        ...state.summarizeJobs[jobId],
        ...result,
        status: "completed",
      };
    },
    (error) => {
      state.summarizeJobs[jobId] = {
        ...state.summarizeJobs[jobId],
        status: "failed",
        reason: String(error?.message || error),
      };
    },
  );
  return { started: true, jobId };
};
state.readSummarizeJob = (jobId) =>
  state.summarizeJobs[String(jobId || "")] || null;
state.freshSessionJobs = state.freshSessionJobs || {};
state.startFreshSessionFromSummary = (sourceThreadId, summary) => {
  const sourceId = String(sourceThreadId || "").trim();
  const handoffSummary = String(summary || "").trim();
  if (!sourceId) throw new Error("A Codex source thread id is required");
  if (!handoffSummary) throw new Error("The manual handoff summary is empty");
  const existing = Object.entries(state.freshSessionJobs).find(
    ([, job]) => job?.sourceThreadId === sourceId && job?.status === "pending",
  );
  if (existing) return { started: true, jobId: existing[0] };
  const jobId = `${sourceId}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  state.freshSessionJobs[jobId] = {
    status: "pending",
    sourceThreadId: sourceId,
  };
  void runFreshSessionFromSummary(sourceId, handoffSummary).then(
    (result) => {
      state.freshSessionJobs[jobId] = {
        ...state.freshSessionJobs[jobId],
        ...result,
        status: "completed",
      };
    },
    (error) => {
      state.freshSessionJobs[jobId] = {
        ...state.freshSessionJobs[jobId],
        status: "failed",
        reason: String(error?.message || error),
      };
    },
  );
  return { started: true, jobId };
};
state.readFreshSessionJob = (jobId) =>
  state.freshSessionJobs[String(jobId || "")] || null;
