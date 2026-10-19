// Inspect existing results only: installation currentness must not depend on
// picker readiness, or a pending/error observer would cause reinjection loops.
const codexPickerOwnData = (value, key) => {
  if (!value || !["object", "function"].includes(typeof value))
    return undefined;
  const field = Object.getOwnPropertyDescriptor(value, key);
  if (field && !("value" in field)) throw new Error("unreadable_picker_field");
  return field?.value;
};
const codexPickerDataArray = (value) => {
  if (!Array.isArray(value)) return null;
  const length = codexPickerOwnData(value, "length");
  if (!Number.isSafeInteger(length) || length > 25000)
    throw new Error("unreadable_picker_array");
  return Array.from({ length }, (_, index) => codexPickerOwnData(value, index));
};
const codexPickerModelSnapshot = (model) => {
  const snapshot = Object.create(null);
  for (const key of [
    "model",
    "id",
    "slug",
    "canonicalSlug",
    "canonical_slug",
    "name",
  ]) {
    const value = codexPickerOwnData(model, key);
    if (typeof value === "string") snapshot[key] = value;
  }
  const aliases = codexPickerOwnData(model, "aliases");
  if (Array.isArray(aliases)) {
    snapshot.aliases = codexPickerDataArray(aliases).filter(
      (alias) => typeof alias === "string",
    );
  } else if (aliases && typeof aliases === "object") {
    snapshot.aliases = Object.create(null);
    for (const [key, field] of Object.entries(
      Object.getOwnPropertyDescriptors(aliases),
    )) {
      if (!("value" in field)) throw new Error("unreadable_picker_alias");
      if (typeof field.value === "string") snapshot.aliases[key] = field.value;
    }
  }
  return snapshot;
};
const codexModelPickerDiagnostics = () => {
  const diagnostics = {
    status: "pending",
    pickerObserverCount: 0,
    successObserverCount: 0,
    errorObserverCount: 0,
    pendingObserverCount: 0,
    unsupportedObserverCount: 0,
    unreadableObserverCount: 0,
    effortMismatchCount: 0,
    flagMismatchCount: 0,
    missingMaxModelCount: 0,
    missingUltraModelCount: 0,
    selectedMaxModelCount: 0,
    selectedUltraModelCount: 0,
  };
  const seen = new Set();
  const mismatches = new Set();
  const missingMax = new Set();
  const missingUltra = new Set();
  const selectedMax = new Set();
  const selectedUltra = new Set();
  for (const cache of state.reasoningQueryCaches?.keys() || []) {
    let queries;
    try {
      const getAll = codexDeclaredMethod(cache, "getAll");
      if (!getAll) throw new Error("unreadable_picker_cache");
      queries = codexPickerDataArray(getAll.call(cache));
      if (!queries) throw new Error("unreadable_picker_cache");
    } catch {
      diagnostics.unreadableObserverCount += 1;
      continue;
    }
    for (const query of queries) {
      let observers;
      try {
        const key = codexPickerDataArray(codexPickerOwnData(query, "queryKey"));
        if (!isManagedCodexModelQuery(key)) continue;
        observers = codexPickerDataArray(
          codexPickerOwnData(query, "observers"),
        );
        if (!observers) throw new Error("unreadable_picker_observers");
      } catch {
        diagnostics.unreadableObserverCount += 1;
        continue;
      }
      for (const observer of observers) {
        if (seen.has(observer)) continue;
        seen.add(observer);
        try {
          const options = codexPickerOwnData(observer, "options");
          const key = codexPickerDataArray(
            codexPickerOwnData(options, "queryKey"),
          );
          if (!isManagedCodexModelQuery(key)) continue;
          diagnostics.pickerObserverCount += 1;
          const getCurrentResult = codexDeclaredMethod(
            observer,
            "getCurrentResult",
          );
          if (!getCurrentResult) throw new Error("unreadable_picker_result");
          const result = getCurrentResult.call(observer);
          const status = codexPickerOwnData(result, "status");
          if (status === "error") {
            diagnostics.errorObserverCount += 1;
            continue;
          }
          if (status !== "success") {
            diagnostics.pendingObserverCount += 1;
            continue;
          }
          diagnostics.successObserverCount += 1;
          const selection = codexPickerOwnData(result, "data");
          const models = codexPickerDataArray(
            codexPickerOwnData(selection, "models"),
          );
          if (!models) {
            diagnostics.unsupportedObserverCount += 1;
            continue;
          }
          if (!models.length && modelNames().length) {
            diagnostics.pendingObserverCount += 1;
            continue;
          }
          let hasMax = false;
          let hasUltra = false;
          let unsupported = false;
          for (const model of models) {
            const row = catalogRowForModel(codexPickerModelSnapshot(model));
            if (
              !row ||
              row.enabled === false ||
              !modelNames().includes(row.model)
            ) {
              unsupported = true;
              continue;
            }
            const expected = new Set(
              (descriptorFor(row.model).supportedReasoningEfforts || []).map(
                (level) => level.reasoningEffort,
              ),
            );
            const levels = codexPickerDataArray(
              codexPickerOwnData(model, "supportedReasoningEfforts"),
            );
            const actual = new Set();
            let invalid = !levels;
            for (const level of levels || []) {
              const effort = codexPickerOwnData(level, "reasoningEffort");
              if (typeof effort !== "string" || !effort.trim()) invalid = true;
              else actual.add(effort.trim());
            }
            if (
              invalid ||
              actual.size !== expected.size ||
              [...expected].some((effort) => !actual.has(effort))
            )
              mismatches.add(row.model);
            if (expected.has("max") && !actual.has("max"))
              missingMax.add(row.model);
            if (expected.has("ultra") && !actual.has("ultra"))
              missingUltra.add(row.model);
            if (actual.has("max")) {
              selectedMax.add(row.model);
              hasMax = true;
            }
            if (actual.has("ultra")) {
              selectedUltra.add(row.model);
              hasUltra = true;
            }
          }
          if (unsupported) diagnostics.unsupportedObserverCount += 1;
          else {
            for (const [field, expected] of [
              ["hasModelSupportingMaxReasoningEffort", hasMax],
              ["hasModelSupportingUltraReasoningEffort", hasUltra],
            ]) {
              const flag = codexPickerOwnData(selection, field);
              if (typeof flag === "boolean" && flag !== expected)
                diagnostics.flagMismatchCount += 1;
            }
          }
        } catch {
          diagnostics.unreadableObserverCount += 1;
        }
      }
    }
  }
  diagnostics.effortMismatchCount = mismatches.size;
  diagnostics.missingMaxModelCount = missingMax.size;
  diagnostics.missingUltraModelCount = missingUltra.size;
  diagnostics.selectedMaxModelCount = selectedMax.size;
  diagnostics.selectedUltraModelCount = selectedUltra.size;
  if (diagnostics.errorObserverCount) diagnostics.status = "error";
  else if (diagnostics.effortMismatchCount || diagnostics.flagMismatchCount)
    diagnostics.status = "mismatch";
  else if (
    diagnostics.unreadableObserverCount ||
    diagnostics.unsupportedObserverCount
  )
    diagnostics.status = "unverified";
  else if (diagnostics.pickerObserverCount && !diagnostics.pendingObserverCount)
    diagnostics.status = "ready";
  return diagnostics;
};
