const cancelCodexModelPickerQueryFetch = (query) => {
  if (typeof query.cancel !== "function") return;
  const previousState = query.state;
  const cancellation = query.cancel({ silent: true });
  // Silent cancellation leaves TanStack's fetch status unchanged. Do not
  // leave the picker fetching forever or revert data written by another read.
  if (
    query.state === previousState &&
    previousState?.fetchStatus &&
    previousState.fetchStatus !== "idle"
  )
    query.setState?.({ fetchStatus: "idle" });
  return cancellation;
};

const cancelCodexModelPickerReleaseRefresh = () => {
  const operation = state.modelPickerReleaseOperation;
  if (!operation) return [];
  state.modelPickerReleaseOperation = null;
  const pending = [];
  for (const entry of operation.entries) {
    const query = entry.query;
    if (entry.phase === "cancelling") {
      if (query.state === entry.cancelledState) pending.push(query);
      continue;
    }
    if (
      query.state?.fetchMeta !== operation.marker ||
      query.state?.fetchStatus === "idle"
    )
      continue;
    try {
      // Cancellation rejects the owned retryer synchronously, before a newer
      // installation can publish data into this same provider-less query.
      const shouldRefresh = query.state?.data === undefined;
      Promise.resolve(cancelCodexModelPickerQueryFetch(query)).catch(() => {});
      if (shouldRefresh) pending.push(query);
    } catch {}
  }
  return pending;
};

const refreshReleasedCodexModelQueries = (queries, invalidations = []) => {
  const operation = {
    marker: { ccSwitchCatalogRelease: true },
    provider: state.payload?.modelProvider,
    entries: [],
  };
  state.modelPickerReleaseOperation = operation;
  const isCurrent = () =>
    state.modelPickerReleaseOperation === operation &&
    state.catalogReleased === true &&
    state.payload?.catalogReleased === true &&
    state.payload?.modelProvider === operation.provider;
  const refreshes = queries.map((query) => {
    const entry = { query, phase: "cancelling", cancelledState: query.state };
    operation.entries.push(entry);
    return (async () => {
      const cancellation = cancelCodexModelPickerQueryFetch(query);
      entry.cancelledState = query.state;
      await cancellation;
      if (!isCurrent() || query.state !== entry.cancelledState) return;
      query.setState?.({
        data: undefined,
        dataUpdatedAt: 0,
        error: null,
        status: "pending",
      });
      if (
        !isCurrent() ||
        (query.state &&
          (query.state.data !== undefined || query.state.status !== "pending"))
      )
        return;
      if (typeof query.fetch === "function") {
        entry.phase = "fetching";
        return query.fetch(undefined, { meta: operation.marker });
      }
      query.invalidate?.();
    })();
  });
  state.modelPickerReleaseRefresh = Promise.allSettled([
    ...invalidations,
    ...refreshes,
  ]);
  void state.modelPickerReleaseRefresh.then(() => {
    if (state.modelPickerReleaseOperation === operation)
      state.modelPickerReleaseOperation = null;
  });
};

const releaseCodexModelPicker = (modelProvider = null) => {
  if (state.catalogReleased === true) {
    if (state.payload?.modelProvider !== modelProvider) {
      const pending = cancelCodexModelPickerReleaseRefresh();
      state.payload = { ...state.payload, modelProvider };
      state.catalogProviderEpoch = (state.catalogProviderEpoch || 0) + 1;
      if (pending.length) refreshReleasedCodexModelQueries(pending);
    }
    return true;
  }
  cancelCodexModelPickerReleaseRefresh();
  const previousProvider = state.payload?.modelProvider;
  const queries = [];
  const caches = new Set(state.reasoningQueryCaches?.keys() || []);
  const clients = new Set(state.modelPickerQueryClients?.values() || []);
  for (const scope of state.scopedAppServerScopes || []) {
    try {
      if (scope.queryClient) clients.add(scope.queryClient);
    } catch {}
  }
  const managedQuery = (query) => {
    const key = query?.queryKey;
    const queryTail = Array.isArray(key) ? key.slice(5) : [];
    return (
      previousProvider &&
      previousProvider !== "openai" &&
      Array.isArray(key) &&
      key[0] === "models" &&
      key[1] === "list" &&
      key[2] === "local" &&
      ["chatgpt", "apikey", "no-auth"].includes(key[3]) &&
      (queryTail.length === 0 || queryTail.includes(previousProvider))
    );
  };
  for (const client of clients) {
    try {
      const cache = client.getQueryCache?.();
      if (cache) caches.add(cache);
    } catch {}
  }
  for (const cache of caches) {
    for (const query of cache.getAll?.() || []) {
      if (managedQuery(query) && !queries.includes(query)) queries.push(query);
    }
  }
  state.catalogReleased = true;
  state.catalogProviderEpoch = (state.catalogProviderEpoch || 0) + 1;
  state.payload = {
    defaultModel: null,
    modelProvider,
    catalogAvailable: false,
    modelNames: [],
    models: [],
    catalogReleased: true,
  };
  state.requestIds?.clear?.();
  state.modelListRequestScopes?.clear?.();
  state.pendingReactNodes?.clear?.();
  for (const [prototype, entry] of state.reasoningObserverPrototypes || []) {
    try {
      entry.dispose();
      state.reasoningObserverPrototypes.delete(prototype);
    } catch {}
  }
  for (const [cache, entry] of state.reasoningQueryCaches || []) {
    try {
      if (typeof entry.dispose === "function") {
        entry.dispose();
        state.reasoningQueryCaches.delete(cache);
      } else {
        // Legacy wrappers are not reversible. Refresh them against the inert
        // payload and retain the entry so reactivation never nests wrappers.
        entry.refresh?.();
      }
    } catch {}
  }
  for (const [config, owned] of state.modelPickerStatsigOverrides || []) {
    try {
      if (config.value === owned.projectedValue)
        config.value = owned.originalValue;
    } catch {}
  }
  state.modelPickerStatsigOverrides?.clear?.();
  for (const [client, owned] of state.modelPickerStatsigGetters || []) {
    try {
      if (client.getDynamicConfig === owned.patched) {
        client.getDynamicConfig = owned.original;
        delete client.__ccSwitchStatsigPatchVersion;
      }
    } catch {}
  }
  state.modelPickerStatsigGetters?.clear?.();
  const refreshes = [];
  for (const client of clients) {
    try {
      refreshes.push(
        Promise.resolve(
          client.invalidateQueries?.({
            predicate: managedQuery,
            refetchType: "none",
          }),
        ),
      );
    } catch {}
  }
  refreshReleasedCodexModelQueries(queries, refreshes);
  return true;
};
