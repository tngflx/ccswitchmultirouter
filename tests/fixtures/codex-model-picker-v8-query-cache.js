// Frozen v8 cache installer from d17743d6. Kept to test in-place upgrades.
const patchCodexModelReasoningQueryCache = (cache) => {
  if (typeof cache?.getAll !== "function" || typeof cache?.subscribe !== "function")
    return false;
  state.reasoningQueryCaches = state.reasoningQueryCaches || new Map();
  let entry = state.reasoningQueryCaches.get(cache);
  if (!entry) {
    entry = {
      observers: new WeakMap(),
      selectorSources: new WeakMap(),
      refreshing: false,
    };
    state.reasoningQueryCaches.set(cache, entry);
    entry.refreshQuery = (query) => {
      for (const observer of query?.observers || []) {
        let record = entry.observers.get(observer);
        if (!record) {
          if (!isManagedCodexModelQuery(query.queryKey) ||
              typeof observer?.setOptions !== "function" ||
              typeof observer.options?.select !== "function") continue;
          record = {};
          entry.observers.set(observer, record);
          const projectOptions = (options) => {
            let baseSelect = options?.select;
            while (entry.selectorSources.has(baseSelect))
              baseSelect = entry.selectorSources.get(baseSelect);
            let select = baseSelect;
            if (isManagedCodexModelQuery(options?.queryKey) && typeof baseSelect === "function") {
              const queryKey = JSON.stringify(options.queryKey);
              if (record.baseSelect !== baseSelect ||
                  record.payload !== currentPayload() || record.queryKey !== queryKey) {
                record.baseSelect = baseSelect;
                record.payload = currentPayload();
                record.queryKey = queryKey;
                record.wrappedSelect = function ccSwitchCatalogReasoningSelection(...values) {
                  return restoreCodexCatalogReasoningSelection(
                    options.queryKey, baseSelect.apply(this, values),
                  );
                };
                entry.selectorSources.set(record.wrappedSelect, baseSelect);
              }
              select = record.wrappedSelect;
            } else {
              record.baseSelect = baseSelect;
              record.payload = currentPayload();
              record.queryKey = null;
              record.wrappedSelect = null;
            }
            return select === options?.select ? options : { ...options, select };
          };
          for (const method of ["setOptions", "getOptimisticResult", "fetchOptimistic"]) {
            const original = observer[method];
            if (typeof original !== "function") continue;
            observer[method] = function ccSwitchCatalogReasoningOptions(options, ...args) {
              return original.call(this, projectOptions(options), ...args);
            };
          }
        }
        if (!isManagedCodexModelQuery(observer.options?.queryKey) &&
            !entry.selectorSources.has(observer.options?.select)) continue;
        if (record.payload !== currentPayload() ||
            observer.options?.select !== record.wrappedSelect)
          observer.setOptions(observer.options);
      }
    };
    entry.refresh = (query) => {
      if (entry.refreshing) return;
      entry.refreshing = true;
      try {
        for (const item of query ? [query] : cache.getAll())
          entry.refreshQuery(item);
      } finally {
        entry.refreshing = false;
      }
    };
    entry.unsubscribe = cache.subscribe((event) => {
      if (event?.type === "observerAdded" || event?.type === "observerOptionsUpdated")
        entry.refresh(event.query);
    });
  }
  entry.refresh();
  return true;
};
