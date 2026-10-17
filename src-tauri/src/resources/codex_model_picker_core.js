  const currentPayload = () => state.payload || {};
  const normalizedIdentity = (value) =>
    typeof value === "string" && value.trim()
      ? value.trim().toLowerCase()
      : null;
  const reasoningDescriptorFields = [
    "defaultReasoningEffort",
    "default_reasoning_level",
    "default_reasoning_effort",
    "supportedReasoningEfforts",
    "supportedReasoningLevels",
    "supported_reasoning_levels",
    "supported_reasoning_efforts",
    "reasoning",
  ];
  const nestedReasoningDescriptorFields = [
    "defaultEffort",
    "default_effort",
    "defaultReasoningEffort",
    "supportedEfforts",
    "supported_efforts",
  ];
  const catalogRowForName = (name) => {
    const normalizedName = normalizedIdentity(name);
    if (!normalizedName) return null;
    const rows = currentPayload().models || [];
    const direct = rows.find(
      (model) => normalizedIdentity(model?.model) === normalizedName,
    );
    if (direct) return direct;
    const matches = rows.filter(
      (model) => modelVisibleIdentityValues(model).includes(normalizedName),
    );
    return matches.length === 1 ? matches[0] : null;
  };
  const catalogNameIsEnabled = (name) => {
    const row = catalogRowForName(name);
    return row !== null && row?.enabled !== false;
  };
  const modelNames = () => {
    const payload = currentPayload();
    const ordered = Array.from(new Set((payload.modelNames || [])
      .filter((name) => typeof name === "string" && name.trim())
      .map((name) => name.trim())))
      .filter(catalogNameIsEnabled);
    if (ordered.length) return ordered;
    if (Array.isArray(payload.modelNames)) return [];
    return typeof payload.defaultModel === "string" && payload.defaultModel.trim() &&
      catalogNameIsEnabled(payload.defaultModel)
      ? [payload.defaultModel.trim()]
      : [];
  };
  const retiredManagedNames = () => {
    const payload = currentPayload();
    const provider = typeof payload.modelProvider === "string"
      ? payload.modelProvider.trim()
      : "";
    if (!provider || provider === "openai" || payload.catalogAvailable !== true)
      return new Set();
    state.modelPickerManagedNames = state.modelPickerManagedNames || new Map();
    let known = state.modelPickerManagedNames.get(provider);
    if (!known) {
      known = new Set();
      state.modelPickerManagedNames.set(provider, known);
    }
    const active = new Set(modelNames().map(normalizedIdentity));
    for (const name of active) known.add(name);
    // This is provenance of names patched in this renderer, not a saved
    // catalog or capability fallback. It only removes our own retired rows.
    return new Set([...known].filter((name) => !active.has(name)));
  };
  const isRetiredManagedModel = (model, retired = retiredManagedNames()) =>
    modelVisibleIdentityValues(model).some((identity) => retired.has(identity));
  const normalizeReasoningDescriptor = (descriptor) => {
    if (!descriptor || typeof descriptor !== "object") return descriptor;
    const defaultCandidates = [
      descriptor.defaultReasoningEffort,
      descriptor.default_reasoning_level,
      descriptor.default_reasoning_effort,
    ];
    const nested = descriptor.reasoning;
    if (nested && typeof nested === "object") {
      defaultCandidates.push(
        nested.defaultEffort,
        nested.default_effort,
        nested.defaultReasoningEffort,
      );
    }
    const defaultEffort = defaultCandidates.find(
      (value) => typeof value === "string" && value.trim(),
    );
    const sources = [
      descriptor.supportedReasoningEfforts,
      descriptor.supportedReasoningLevels,
      descriptor.supported_reasoning_levels,
      descriptor.supported_reasoning_efforts,
      nested?.supportedEfforts,
      nested?.supported_efforts,
    ];
    const source = sources.find(Array.isArray);
    const seen = new Set();
    const normalized = (source || [])
      .map((level) => {
        const effort =
          typeof level === "string"
            ? level
            : level?.reasoningEffort ||
              level?.reasoning_effort ||
              level?.effort;
        if (typeof effort !== "string" || !effort.trim()) return null;
        const value = effort.trim();
        if (seen.has(value)) return null;
        seen.add(value);
        const description =
          typeof level?.description === "string" && level.description.trim()
            ? level.description.trim()
            : value;
        return { effort: value, description };
      })
      .filter(Boolean);
    if (!normalized.length) {
      for (const key of reasoningDescriptorFields) {
        if (key !== "reasoning") delete descriptor[key];
      }
      if (descriptor.reasoning && typeof descriptor.reasoning === "object") {
        for (const key of nestedReasoningDescriptorFields)
          delete descriptor.reasoning[key];
        if (Object.keys(descriptor.reasoning).length === 0)
          delete descriptor.reasoning;
      }
      return descriptor;
    }
    const requestedDefault =
      typeof defaultEffort === "string" ? defaultEffort.trim() : "";
    descriptor.defaultReasoningEffort = normalized.some(
      ({ effort }) => effort === requestedDefault,
    )
      ? requestedDefault
      : normalized[0].effort;
    delete descriptor.default_reasoning_level;
    delete descriptor.default_reasoning_effort;
    descriptor.supportedReasoningEfforts = normalized.map(
      ({ effort, description }) => ({
        reasoningEffort: effort,
        description,
      }),
    );
    descriptor.supportedReasoningLevels = normalized.map(
      ({ effort, description }) => ({ effort, description }),
    );
    delete descriptor.supported_reasoning_levels;
    delete descriptor.supported_reasoning_efforts;
    if (descriptor.reasoning && typeof descriptor.reasoning === "object") {
      for (const key of nestedReasoningDescriptorFields)
        delete descriptor.reasoning[key];
      if (Object.keys(descriptor.reasoning).length === 0)
        delete descriptor.reasoning;
    }
    return descriptor;
  };
  const modelIdentityValues = (item, includeUpstream = true) => {
    if (!item || typeof item !== "object") return [];
    const values = [];
    const add = (candidate) => {
      const normalized = normalizedIdentity(candidate);
      if (normalized && !values.includes(normalized)) values.push(normalized);
    };
    for (const key of [
      "model",
      "id",
      "upstreamModel",
      "upstream_model",
      "canonicalSlug",
      "canonical_slug",
      "slug",
    ]) {
      if (!includeUpstream && (key === "upstreamModel" || key === "upstream_model"))
        continue;
      add(item[key]);
    }
    if (Array.isArray(item.aliases)) {
      for (const alias of item.aliases) add(alias);
    } else if (item.aliases && typeof item.aliases === "object") {
      for (const [alias, target] of Object.entries(item.aliases)) {
        add(alias);
        add(target);
      }
    }
    if (values.length === 0) add(item.name);
    return values;
  };
  const modelVisibleIdentityValues = (item) => modelIdentityValues(item, false);
  const visibleIdentitiesIntersect = (left, right) => {
    const rightSet = new Set(modelVisibleIdentityValues(right));
    return modelVisibleIdentityValues(left).some((identity) => rightSet.has(identity));
  };
  const catalogRowForModel = (model) => {
    if (!model || typeof model !== "object") return null;
    const publicName = normalizedIdentity(model.model);
    if (publicName) {
      const direct = (currentPayload().models || []).find(
        (row) => normalizedIdentity(row?.model) === publicName,
      );
      if (direct) return direct;
      // A shared upstream slug is not a routed public identity. Only explicit
      // aliases may match a selected row that already supplies its model name.
      const aliases = (currentPayload().models || []).filter((row) => {
        const declared = row?.aliases;
        const values = Array.isArray(declared)
          ? declared
          : declared && typeof declared === "object"
            ? Object.keys(declared)
            : [];
        return values.some((alias) => normalizedIdentity(alias) === publicName);
      });
      return aliases.length === 1 ? aliases[0] : null;
    }
    const matches = (currentPayload().models || []).filter(
      (row) => visibleIdentitiesIntersect(model, row),
    );
    return matches.length === 1 ? matches[0] : null;
  };
  const clearStaleReasoningFields = (model, descriptor) => {
    let changed = false;
    for (const key of reasoningDescriptorFields) {
      if (key === "reasoning") continue;
      if (!(key in descriptor) && key in model) {
        delete model[key];
        changed = true;
      }
    }
    if (model.reasoning && typeof model.reasoning === "object") {
      const descriptorReasoning = descriptor.reasoning;
      for (const key of nestedReasoningDescriptorFields) {
        if (!(descriptorReasoning && key in descriptorReasoning) &&
            key in model.reasoning) {
          delete model.reasoning[key];
          changed = true;
        }
      }
      if (Object.keys(model.reasoning).length === 0) {
        delete model.reasoning;
        changed = true;
      }
    }
    return changed;
  };
  const assignDescriptorField = (target, key, value) => {
    if (key === "reasoning" &&
        value && typeof value === "object" &&
        target[key] && typeof target[key] === "object") {
      const merged = { ...target[key], ...value };
      if (JSON.stringify(target[key]) === JSON.stringify(merged)) return false;
      target[key] = merged;
      return true;
    }
    if (JSON.stringify(target[key]) === JSON.stringify(value)) return false;
    target[key] = value;
    return true;
  };
  const descriptorFor = (name) => {
    const existing = catalogRowForName(name);
    const descriptor = normalizeReasoningDescriptor({
      // Codex's renderer matches model rows by id/slug/name before it reads
      // supportedReasoningLevels. Injected routed rows therefore need the
      // visible route name in every stable identity slot. Rich upstream
      // identity remains authoritative when a row already exists.
      id: existing?.id || existing?.model || existing?.slug || name,
      slug: existing?.slug || existing?.model || existing?.id || name,
      name: existing?.name || existing?.displayName || existing?.display_name || name,
      ...(existing || {}),
      ...(existing?.reasoning && typeof existing.reasoning === "object"
        ? { reasoning: { ...existing.reasoning } }
        : {}),
      model: name,
      displayName:
        existing?.displayName || existing?.display_name || existing?.name || name,
      hidden: false,
    });
    const providerName =
      descriptor.providerName ||
      descriptor.provider_name ||
      (typeof descriptor.provider === "string"
        ? descriptor.provider
        : descriptor.provider?.name);
    if (typeof providerName === "string" && providerName.trim()) {
      descriptor.providerName = providerName.trim();
      descriptor.provider_name = providerName.trim();
    }
    return descriptor;
  };
  const setPropertyIfWritable = (target, key, value) => {
    if (!target || typeof target !== "object" || Object.isFrozen(target))
      return false;
    const property = Object.getOwnPropertyDescriptor(target, key);
    if (property && "writable" in property && property.writable === false)
      return false;
    if (!property && Object.isSealed(target)) return false;
    if (Object.is(target[key], value)) return false;
    try {
      target[key] = value;
    } catch {
      return false;
    }
    return Object.is(target[key], value);
  };
  const mutableModelTarget = (model) => {
    if (!model || typeof model !== "object") return model;
    const frozenReasoning = model.reasoning && typeof model.reasoning === "object" &&
      (Object.isFrozen(model.reasoning) || Object.isSealed(model.reasoning));
    if (!Object.isFrozen(model) && !Object.isSealed(model) && !frozenReasoning)
      return model;
    return {
      ...model,
      ...(model.reasoning && typeof model.reasoning === "object"
        ? { reasoning: { ...model.reasoning } }
        : {}),
    };
  };
  const stringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
  const modelArray = (value, allowEmpty = false) =>
    Array.isArray(value) &&
    (allowEmpty || value.length > 0) &&
    value.every((item) => modelIdentityValues(item).length > 0);
  const patchModelNameArray = (models, managedOnly = false) => {
    if (!stringArray(models)) return false;
    const names = modelNames();
    const routed = names.filter((name) => models.includes(name));
    const missing = names.filter((name) => !models.includes(name));
    const routedSet = new Set(names);
    const retired = retiredManagedNames();
    const untouched = managedOnly
      ? []
      : models.filter((name) => !routedSet.has(name) &&
        !retired.has(normalizedIdentity(name)) &&
        catalogRowForName(name)?.enabled !== false);
    const ordered = [...routed, ...untouched, ...missing];
    const changed = models.length !== ordered.length ||
      models.some((name, index) => name !== ordered[index]);
    if (changed) {
      if (Object.isFrozen(models) || Object.isSealed(models)) return false;
      try {
        models.splice(0, models.length, ...ordered);
      } catch {
        return false;
      }
    }
    return changed;
  };
  const patchModelArray = (models, allowEmpty = false, managedOnly = false) => {
    if (!modelArray(models, allowEmpty)) return false;
    if (Object.isFrozen(models) || Object.isSealed(models)) return false;
    const names = modelNames();
    const retired = retiredManagedNames();
    const existing = models.filter((model) =>
      !isRetiredManagedModel(model, retired) &&
      catalogRowForModel(model)?.enabled !== false &&
      (!managedOnly || catalogRowForModel(model) !== null));
    const descriptors = names.map(descriptorFor);
    const routedByName = new Map();
    const used = new Set();
    let changed = false;
    for (const [index, name] of names.entries()) {
      const descriptor = descriptors[index];
      const normalizedName = normalizedIdentity(name);
      const current = existing.find(
        (model) => !used.has(model) && normalizedIdentity(model.model) === normalizedName,
      ) || existing.find(
        (model) => !used.has(model) &&
          visibleIdentitiesIntersect(model, descriptor) &&
          descriptors.filter((item) => visibleIdentitiesIntersect(model, item)).length === 1,
      );
      if (!current) {
        existing.push(descriptor);
        routedByName.set(normalizedIdentity(name), descriptor);
        changed = true;
        continue;
      }
      const target = mutableModelTarget(current);
      if (target !== current) {
        existing[existing.indexOf(current)] = target;
        changed = true;
      }
      used.add(current);
      if (clearStaleReasoningFields(target, descriptor)) changed = true;
      for (const [key, value] of Object.entries(descriptor)) {
        if (assignDescriptorField(target, key, value)) changed = true;
      }
      routedByName.set(normalizedIdentity(name), target);
    }
    // Keep routed models in catalog order (including provider groups) while retaining any
    // unrelated Codex entries after them. Mutate the original array so renderer references live.
    const orderedRouted = names
      .map((name) => routedByName.get(normalizedIdentity(name)))
      .filter(Boolean);
    const untouched = managedOnly
      ? []
      : existing.filter((model) => !orderedRouted.includes(model));
    const ordered = [...orderedRouted, ...untouched];
    if (models.length !== ordered.length || models.some((model, index) => model !== ordered[index])) {
      try {
        models.splice(0, models.length, ...ordered);
      } catch {
        return false;
      }
      changed = true;
    }
    return changed;
  };
  const removeHiddenNames = (container, key) => {
    if (!Array.isArray(container?.[key])) return false;
    const names = new Set(modelNames());
    const before = container[key].length;
    const filtered = container[key].filter((name) => !names.has(name));
    if (before === filtered.length) return false;
    return setPropertyIfWritable(container, key, filtered);
  };
  const patchNameSet = (setLike, managedOnly = false) => {
    if (!(setLike instanceof Set)) return false;
    let changed = false;
    const retired = retiredManagedNames();
    for (const name of setLike) {
      if (retired.has(normalizedIdentity(name)) ||
          catalogRowForName(name)?.enabled === false ||
          (managedOnly && catalogRowForName(name) === null)) {
        setLike.delete(name);
        changed = true;
      }
    }
    for (const name of modelNames()) {
      if (!setLike.has(name)) {
        setLike.add(name);
        changed = true;
      }
    }
    return changed;
  };
  const patchModelContainer = (value, managedOnly = false) => {
    if (!value || typeof value !== "object") return false;
    const looksLikeModelGate = "availableModels" in value || "available_models" in value || "useHiddenModels" in value || "use_hidden_models" in value || "defaultModel" in value || "default_model" in value;
    if (!looksLikeModelGate) return false;

    let changed = false;
    if (patchModelArray(value.models, "defaultModel" in value || "availableModels" in value || "available_models" in value, managedOnly)) changed = true;
    if (patchModelNameArray(value.models, managedOnly)) changed = true;
    if (patchModelArray(value.data, false, managedOnly)) changed = true;
    if (patchModelArray(value.result, false, managedOnly)) changed = true;
    if (patchModelArray(value.pages?.[0]?.data, false, managedOnly)) changed = true;
    if (patchModelArray(value.result?.data, false, managedOnly)) changed = true;
    if (patchModelArray(value.result?.models, false, managedOnly)) changed = true;
    if (patchModelArray(value.message?.result?.data, false, managedOnly)) changed = true;
    if (patchModelArray(value.message?.result?.models, false, managedOnly)) changed = true;
    if (patchNameSet(value.availableModels, managedOnly)) changed = true;
    if (patchNameSet(value.available_models, managedOnly)) changed = true;
    if (patchModelNameArray(value.availableModels, managedOnly)) changed = true;
    if (patchModelNameArray(value.available_models, managedOnly)) changed = true;
    if (removeHiddenNames(value, "hiddenModels")) changed = true;
    if (removeHiddenNames(value, "hidden_models")) changed = true;
    if ("useHiddenModels" in value && value.useHiddenModels !== false) {
      if (setPropertyIfWritable(value, "useHiddenModels", false)) changed = true;
    }
    if ("use_hidden_models" in value && value.use_hidden_models !== false) {
      if (setPropertyIfWritable(value, "use_hidden_models", false)) changed = true;
    }
    if ("default_model" in value && typeof value.default_model === "string" && modelNames().length && !modelNames().includes(value.default_model)) {
      if (setPropertyIfWritable(value, "default_model", modelNames()[0])) changed = true;
    }
    if ("defaultModel" in value && value.defaultModel == null && modelNames().length > 0) {
      if (setPropertyIfWritable(value, "defaultModel", descriptorFor(modelNames()[0]))) changed = true;
    }
    return changed;
  };
  const isManagedCodexModelQuery = (key) => {
    const payload = currentPayload();
    const provider = typeof payload.modelProvider === "string"
      ? payload.modelProvider.trim()
      : "";
    return Array.isArray(key) &&
      key[0] === "models" && key[1] === "list" && key[2] === "local" &&
      ["chatgpt", "apikey", "no-auth"].includes(key[3]) &&
      payload.catalogAvailable === true && provider !== "openai" &&
      provider.trim().length > 0 && key.slice(5).includes(provider);
  };
  // Desktop filters model/list a second time using app-wide effort preferences
  // and an official Ultra flag. Restore only managed rows after that selection;
  // retain its other availability decisions and leave every other host alone.
  const restoreCodexCatalogReasoningSelection = (key, selection) => {
    if (!isManagedCodexModelQuery(key) || !Array.isArray(selection?.models))
      return selection;
    const names = new Set(modelNames().map(normalizedIdentity));
    const retired = retiredManagedNames();
    let changed = false;
    const models = selection.models.flatMap((model) => {
      const row = catalogRowForModel(model);
      if (isRetiredManagedModel(model, retired) || row?.enabled === false) {
        changed = true;
        return [];
      }
      const name = row?.model || model?.model;
      if (!names.has(normalizedIdentity(name))) {
        changed = true;
        return [];
      }
      const descriptor = descriptorFor(name);
      const next = { ...model };
      if (model.reasoning && typeof model.reasoning === "object")
        next.reasoning = { ...model.reasoning };
      clearStaleReasoningFields(next, descriptor);
      for (const field of reasoningDescriptorFields) {
        if (field in descriptor) assignDescriptorField(next, field, descriptor[field]);
      }
      next.supportedReasoningEfforts = descriptor.supportedReasoningEfforts || [];
      if (JSON.stringify(next) === JSON.stringify(model)) return [model];
      changed = true;
      return [next];
    });
    const hasModelSupportingMaxReasoningEffort = models.some(
      (model) => model.supportedReasoningEfforts?.some(
        (level) => level.reasoningEffort === "max",
      ),
    );
    const hasModelSupportingUltraReasoningEffort = models.some(
      (model) => model.supportedReasoningEfforts?.some(
        (level) => level.reasoningEffort === "ultra",
      ),
    );
    let defaultModel = selection.defaultModel;
    if (defaultModel) {
      const defaultRow = catalogRowForModel(defaultModel);
      const matching = models.filter((model) =>
        defaultRow
          ? catalogRowForModel(model) === defaultRow
          : normalizedIdentity(defaultModel.model)
            ? normalizedIdentity(model.model) === normalizedIdentity(defaultModel.model)
            : visibleIdentitiesIntersect(model, defaultModel));
      if (matching.length === 1) defaultModel = matching[0];
      else if (matching.length === 0 ||
               isRetiredManagedModel(defaultModel, retired) ||
               catalogRowForModel(defaultModel)?.enabled === false)
        defaultModel = models[0];
    }
    if (!changed &&
        defaultModel === selection.defaultModel &&
        hasModelSupportingMaxReasoningEffort === selection.hasModelSupportingMaxReasoningEffort &&
        hasModelSupportingUltraReasoningEffort === selection.hasModelSupportingUltraReasoningEffort)
      return selection;
    const next = {
      ...selection,
      models,
      hasModelSupportingMaxReasoningEffort,
      hasModelSupportingUltraReasoningEffort,
    };
    if ("defaultModel" in selection) next.defaultModel = defaultModel;
    return next;
  };
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
            // Optimistic reads run before setOptions on a normal render. Both
            // paths must use the same selector or the slider loses its levels again.
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
          // A new selector makes QueryObserver recompute cached data and notify
          // the picker without refetching or mutating the underlying cache.
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
