  const currentPayload = () => state.payload || {};
  const normalizedIdentity = (value) =>
    typeof value === "string" && value.trim()
      ? value.trim().toLowerCase()
      : null;
  const modelNames = () => {
    const payload = currentPayload();
    return Array.from(new Set([...(payload.modelNames || []), payload.defaultModel].filter((name) => typeof name === "string" && name.trim()).map((name) => name.trim())));
  };
  const normalizeReasoningDescriptor = (descriptor) => {
    if (!descriptor || typeof descriptor !== "object") return descriptor;
    const defaultEffort =
      descriptor.defaultReasoningEffort ||
      descriptor.default_reasoning_level ||
      descriptor.default_reasoning_effort;
    if (typeof defaultEffort === "string" && defaultEffort.trim()) {
      descriptor.defaultReasoningEffort = defaultEffort.trim();
    }
    const source =
      descriptor.supportedReasoningEfforts ||
      descriptor.supportedReasoningLevels ||
      descriptor.supported_reasoning_levels ||
      descriptor.supported_reasoning_efforts;
    if (!Array.isArray(source)) return descriptor;
    const normalized = source
      .map((level) => {
        const effort =
          typeof level === "string"
            ? level
            : level?.reasoningEffort ||
              level?.reasoning_effort ||
              level?.effort;
        if (typeof effort !== "string" || !effort.trim()) return null;
        const value = effort.trim();
        const description =
          typeof level?.description === "string" && level.description.trim()
            ? level.description.trim()
            : value;
        return { effort: value, description };
      })
      .filter(Boolean);
    descriptor.supportedReasoningEfforts = normalized.map(
      ({ effort, description }) => ({
        reasoningEffort: effort,
        description,
      }),
    );
    descriptor.supportedReasoningLevels = normalized.map(
      ({ effort, description }) => ({ effort, description }),
    );
    return descriptor;
  };
  const descriptorFor = (name) => {
    const payload = currentPayload();
    const normalizedName = normalizedIdentity(name);
    const existing = (payload.models || []).find(
      (model) =>
        model && normalizedIdentity(modelIdentity(model)) === normalizedName,
    );
    return normalizeReasoningDescriptor({
      model: name,
      id: name,
      slug: name,
      displayName: name,
      hidden: false,
      ...(existing || {}),
      name: existing?.displayName || existing?.display_name || name,
      hidden: false,
    });
  };
  const stringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
  const modelIdentity = (item) => {
    if (!item || typeof item !== "object") return null;
    for (const key of ["model", "id", "slug", "name"]) {
      if (typeof item[key] === "string" && item[key].trim()) return item[key].trim();
    }
    return null;
  };
  const modelArray = (value, allowEmpty = false) =>
    Array.isArray(value) &&
    (allowEmpty || value.length > 0) &&
    value.every((item) => modelIdentity(item) !== null);
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
    const existing = new Map();
    for (const model of models) {
      const identity = modelIdentity(model);
      if (identity && typeof model.model !== "string") model.model = identity;
      if (identity) existing.set(normalizedIdentity(identity), model);
    }
    let changed = false;
    for (const name of names) {
      const descriptor = descriptorFor(name);
      const current = existing.get(normalizedIdentity(name));
      if (!current) {
        models.push(descriptor);
        existing.set(normalizedIdentity(name), descriptor);
        changed = true;
        continue;
      }
      for (const [key, value] of Object.entries(descriptor)) {
        if (JSON.stringify(current[key]) !== JSON.stringify(value)) {
          current[key] = value;
          changed = true;
        }
      }
    }
    // Keep routed models in catalog order (including provider groups) while retaining any
    // unrelated Codex entries after them. Mutate the original array so renderer references live.
    const routed = names
      .map((name) => existing.get(normalizedIdentity(name)))
      .filter(Boolean);
    const routedNames = new Set(names.map(normalizedIdentity));
    const untouched = models.filter(
      (model) => !routedNames.has(normalizedIdentity(modelIdentity(model))),
    );
    const ordered = [...routed, ...untouched];
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
