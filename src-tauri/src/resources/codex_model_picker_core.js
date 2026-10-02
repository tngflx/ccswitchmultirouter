  const currentPayload = () => state.payload || {};
  const normalizedIdentity = (value) =>
    typeof value === "string" && value.trim()
      ? value.trim().toLowerCase()
      : null;
  const modelNames = () => {
    const payload = currentPayload();
    const ordered = Array.from(new Set((payload.modelNames || [])
      .filter((name) => typeof name === "string" && name.trim())
      .map((name) => name.trim())));
    if (ordered.length) return ordered;
    return typeof payload.defaultModel === "string" && payload.defaultModel.trim()
      ? [payload.defaultModel.trim()]
      : [];
  };
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
    const normalized = sources
      .map((source) => {
        if (!Array.isArray(source)) return [];
        const seen = new Set();
        return source
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
      })
      .find((levels) => levels.length > 0);
    if (!normalized) {
      for (const key of [
        "defaultReasoningEffort",
        "default_reasoning_level",
        "default_reasoning_effort",
        "supportedReasoningEfforts",
        "supportedReasoningLevels",
        "supported_reasoning_levels",
        "supported_reasoning_efforts",
      ]) delete descriptor[key];
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
    return descriptor;
  };
  const modelIdentityValues = (item) => {
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
  const modelIdentitySet = (item) => new Set(modelIdentityValues(item));
  const identitiesIntersect = (left, right) => {
    const rightSet = right instanceof Set ? right : modelIdentitySet(right);
    return modelIdentityValues(left).some((identity) => rightSet.has(identity));
  };
  const descriptorFor = (name) => {
    const payload = currentPayload();
    const normalizedName = normalizedIdentity(name);
    const existing = (payload.models || []).find(
      (model) => model && modelIdentityValues(model).includes(normalizedName),
    );
    const descriptor = normalizeReasoningDescriptor({
      // Codex's renderer matches model rows by id/slug/name before it reads
      // supportedReasoningLevels. Injected routed rows therefore need the
      // visible route name in every stable identity slot. Rich upstream
      // identity remains authoritative when a row already exists.
      id: existing?.id || existing?.model || existing?.slug || name,
      slug: existing?.slug || existing?.model || existing?.id || name,
      name: existing?.name || existing?.displayName || existing?.display_name || name,
      ...(existing || {}),
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
  const stringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
  const modelArray = (value, allowEmpty = false) =>
    Array.isArray(value) &&
    (allowEmpty || value.length > 0) &&
    value.every((item) => modelIdentityValues(item).length > 0);
  const patchModelNameArray = (models) => {
    if (!stringArray(models)) return false;
    const names = modelNames();
    const routed = names.filter((name) => models.includes(name));
    const missing = names.filter((name) => !models.includes(name));
    const routedSet = new Set(names);
    const untouched = models.filter((name) => !routedSet.has(name));
    const ordered = [...routed, ...untouched, ...missing];
    const changed = models.length !== ordered.length ||
      models.some((name, index) => name !== ordered[index]);
    if (changed) {
      models.splice(0, models.length, ...ordered);
    }
    return changed;
  };
  const patchModelArray = (models, allowEmpty = false) => {
    if (!modelArray(models, allowEmpty)) return false;
    const names = modelNames();
    const existing = models.slice();
    const routedByName = new Map();
    const used = new Set();
    let changed = false;
    for (const name of names) {
      const descriptor = descriptorFor(name);
      const current = existing.find(
        (model) => !used.has(model) && identitiesIntersect(model, descriptor),
      );
      if (!current) {
        models.push(descriptor);
        existing.push(descriptor);
        routedByName.set(normalizedIdentity(name), descriptor);
        changed = true;
        continue;
      }
      used.add(current);
      for (const [key, value] of Object.entries(descriptor)) {
        if (JSON.stringify(current[key]) !== JSON.stringify(value)) {
          current[key] = value;
          changed = true;
        }
      }
      routedByName.set(normalizedIdentity(name), current);
    }
    // Keep routed models in catalog order (including provider groups) while retaining any
    // unrelated Codex entries after them. Mutate the original array so renderer references live.
    const orderedRouted = names
      .map((name) => routedByName.get(normalizedIdentity(name)))
      .filter(Boolean);
    const untouched = models.filter(
      (model) => !orderedRouted.includes(model),
    );
    const ordered = [...orderedRouted, ...untouched];
    if (models.length !== ordered.length || models.some((model, index) => model !== ordered[index])) {
      models.splice(0, models.length, ...ordered);
      changed = true;
    }
    return changed;
  };
  const removeHiddenNames = (container, key) => {
    if (!Array.isArray(container?.[key])) return false;
    const names = new Set(modelNames());
    const before = container[key].length;
    container[key] = container[key].filter((name) => !names.has(name));
    return before !== container[key].length;
  };
  const patchNameSet = (setLike) => {
    if (!(setLike instanceof Set)) return false;
    let changed = false;
    for (const name of modelNames()) {
      if (!setLike.has(name)) {
        setLike.add(name);
        changed = true;
      }
    }
    return changed;
  };
  const patchModelContainer = (value) => {
    if (!value || typeof value !== "object") return false;
    const looksLikeModelGate = "availableModels" in value || "available_models" in value || "useHiddenModels" in value || "use_hidden_models" in value || "defaultModel" in value || "default_model" in value;
    if (!looksLikeModelGate) return false;

    let changed = false;
    if (patchModelArray(value.models, "defaultModel" in value || "availableModels" in value || "available_models" in value)) changed = true;
    if (patchModelNameArray(value.models)) changed = true;
    if (patchModelArray(value.data)) changed = true;
    if (patchModelArray(value.result)) changed = true;
    if (patchModelArray(value.pages?.[0]?.data)) changed = true;
    if (patchModelArray(value.result?.data)) changed = true;
    if (patchModelArray(value.result?.models)) changed = true;
    if (patchModelArray(value.message?.result?.data)) changed = true;
    if (patchModelArray(value.message?.result?.models)) changed = true;
    if (patchNameSet(value.availableModels)) changed = true;
    if (patchNameSet(value.available_models)) changed = true;
    if (patchModelNameArray(value.availableModels)) changed = true;
    if (patchModelNameArray(value.available_models)) changed = true;
    if (removeHiddenNames(value, "hiddenModels")) changed = true;
    if (removeHiddenNames(value, "hidden_models")) changed = true;
    if ("useHiddenModels" in value && value.useHiddenModels !== false) {
      value.useHiddenModels = false;
      changed = true;
    }
    if ("use_hidden_models" in value && value.use_hidden_models !== false) {
      value.use_hidden_models = false;
      changed = true;
    }
    if ("default_model" in value && typeof value.default_model === "string" && modelNames().length && !modelNames().includes(value.default_model)) {
      value.default_model = modelNames()[0];
      changed = true;
    }
    if ("defaultModel" in value && value.defaultModel == null && modelNames().length > 0) {
      value.defaultModel = descriptorFor(modelNames()[0]);
      changed = true;
    }
    return changed;
  };
