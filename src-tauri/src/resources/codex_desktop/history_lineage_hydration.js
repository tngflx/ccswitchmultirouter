const normalizedRolloutPath = (value) =>
  typeof value === "string"
    ? value
        .replaceAll("\\", "/")
        .replace(/^\/\/?\?\//, "")
        .toLowerCase()
    : "";
const conversationHasActiveTurn = (conversation) => {
  if (
    Array.isArray(conversation?.turns) &&
    conversation.turns.some((turn) => turn?.status === "inProgress")
  )
    return true;
  const history =
    conversation?.turnHistory?.kind === "canonical"
      ? conversation.turnHistory.history
      : null;
  const entities = history?.entitiesByKey;
  return entities && typeof entities === "object"
    ? Object.values(entities).some((turn) => turn?.status === "inProgress")
    : false;
};
const canonicalHistoryIsFragmented = (conversation) => {
  const history =
    conversation?.turnHistory?.kind === "canonical"
      ? conversation.turnHistory.history
      : null;
  return (
    history?.isComplete !== true &&
    Array.isArray(history?.islands) &&
    history.islands.length > 1
  );
};
const planHistoryLineageRehydration = (manager) => {
  const repair = [];
  const deferred = [];
  const conversations =
    typeof manager?.getCachedConversations === "function"
      ? manager.getCachedConversations()
      : [];
  const metadata = manager?.threadStore?.threadsById;
  for (const conversation of Array.isArray(conversations)
    ? conversations
    : []) {
    const id = typeof conversation?.id === "string" ? conversation.id : "";
    if (!id || !metadata || typeof metadata.get !== "function") continue;
    const currentPath = normalizedRolloutPath(conversation.rolloutPath);
    const activePath = normalizedRolloutPath(metadata.get(id)?.path);
    if (!activePath) continue;
    const pathChanged = currentPath !== activePath;
    if (!pathChanged && !canonicalHistoryIsFragmented(conversation)) continue;
    const streaming =
      typeof manager?.isConversationStreaming === "function" &&
      manager.isConversationStreaming(id);
    if (streaming || conversationHasActiveTurn(conversation)) deferred.push(id);
    else repair.push(id);
  }
  return { repair, deferred };
};
const rehydrateStaleHistoryLineages = async (manager) => {
  const plan = planHistoryLineageRehydration(manager);
  const repaired = [];
  const failed = [];
  for (const id of plan.repair) {
    const previous = manager.getConversation(id);
    const activePath = manager.threadStore.threadsById.get(id)?.path;
    try {
      manager.updateConversationState(id, (conversation) => {
        conversation.rolloutPath = activePath;
        conversation.turns = [];
        // Codex 26.901 renders canonical turnHistory when present. Clearing only the
        // legacy turns overlay leaves the stale islands visible and causes resume to
        // merge the new tail into the broken cache instead of replacing it.
        delete conversation.turnHistory;
        conversation.turnsPagination = {
          olderCursor: null,
          oldestLoadedTurnId: null,
          isLoadingOlder: false,
          hasLoadedOldest: false,
        };
        conversation.resumeState = "needs_resume";
      });
      const resume = await manager.resumeConversationForUnavailableOwner({
        conversationId: id,
        model: null,
        serviceTier: null,
        reasoningEffort: null,
        workspaceRoots: previous?.cwd ? [previous.cwd] : ["/"],
        collaborationMode: previous?.latestCollaborationMode || null,
      });
      if (resume?.status === "not-ready") {
        throw new Error(
          `Codex App could not resume history: ${String(resume.reason || "not-ready")}`,
        );
      }
      // Resume intentionally hydrates only the newest page for paginated histories.
      // Ask Codex's own pagination layer to close every remaining boundary so a
      // fragmented middle cannot remain hidden behind a stale virtual-list island.
      if (typeof manager.getCompleteConversationTurns === "function") {
        await manager.getCompleteConversationTurns(id);
      }
      repaired.push(id);
    } catch (error) {
      if (previous) manager.setConversation(previous);
      failed.push({ id, error: String(error?.message || error) });
    }
  }
  return { repaired, deferred: plan.deferred, failed };
};
