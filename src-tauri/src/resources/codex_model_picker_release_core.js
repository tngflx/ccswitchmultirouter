const releaseCodexModelPicker = (modelProvider = null) => {
  if (state.catalogReleased === true) {
    if (state.payload?.modelProvider !== modelProvider) {
      state.payload = { ...state.payload, modelProvider };
      state.catalogProviderEpoch = (state.catalogProviderEpoch || 0) + 1;
    }
    return true;
  }
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
    return (
      previousProvider &&
      previousProvider !== "openai" &&
      Array.isArray(key) &&
      key[0] === "models" &&
      key[1] === "list" &&
      key[2] === "local" &&
      ["chatgpt", "apikey", "no-auth"].includes(key[3]) &&
      key.slice(5).includes(previousProvider)
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
  for (const query of queries) {
    try {
      // Raw responses were projected in place. Discard only the formerly
      // managed cache result before requesting the native model/list again.
      query.setState?.({
        data: undefined,
        dataUpdatedAt: 0,
        error: null,
        status: "pending",
      });
      if (typeof query.fetch === "function")
        refreshes.push(Promise.resolve(query.fetch()));
      else query.invalidate?.();
    } catch {}
  }
  state.modelPickerReleaseRefresh = Promise.allSettled(refreshes);
  return true;
};
