// Current Desktop filters the final reasoning menu through an account-scoped
// native signal after selecting model/list. Cache projection alone cannot prove
// final visibility. Read the exact current signal for diagnostics, and apply
// only the reversible renderer-local Max compatibility wrapper defined below;
// never persist account/local preferences or change dependency resolution.
const codexNativeReasoningOwnData = (value, key) => {
  if (!value || !["object", "function"].includes(typeof value))
    return undefined;
  const field = Object.getOwnPropertyDescriptor(value, key);
  return field && "value" in field ? field.value : undefined;
};
const codexNativeReasoningScopeQueryCache = (scope) => {
  if (!codexDeclaredDependencyScope(scope)) return null;
  const node = codexNativeReasoningOwnData(scope, "node");
  // Do not enter the legacy accessor compatibility path when proving a modern
  // native consumer. Only an initialized own node slot can establish ownership.
  const nodeClient = codexNativeReasoningOwnData(node, "queryClient");
  if (!nodeClient) return null;
  const client = codexScopeQueryClient(scope);
  if (client !== nodeClient) return null;
  const getQueryCache = codexDeclaredMethod(client, "getQueryCache");
  if (
    !getQueryCache ||
    !codexDeclaredMethod(client, "getQueryData") ||
    !codexDeclaredMethod(client, "setQueryData")
  )
    return null;
  const cache = getQueryCache.call(client);
  return cache && ["object", "function"].includes(typeof cache) ? cache : null;
};
// A complete current owner snapshot can ignore historical, still-subscribed
// caches without deleting their undo/release registrations. Any uncertain owner
// or a capped scan means unknown, never a partially authoritative cache list.
const codexCurrentNativeReasoningQueryCaches = () => {
  if (!codexRendererScopeSnapshotIsCurrent()) return null;
  try {
    const scopes = Set.prototype.values.call(
      state.scopedAppServerScopeCandidates,
    );
    const caches = new Set();
    for (let inspected = 0; inspected <= 2048; inspected += 1) {
      const entry = scopes.next();
      if (entry.done) return caches.size ? caches : null;
      if (inspected === 2048) return null;
      const cache = codexNativeReasoningScopeQueryCache(entry.value);
      if (!cache) return null;
      caches.add(cache);
    }
  } catch {}
  return null;
};
const readCodexNativeReasoningVisibility = (cache, efforts) => {
  if (state.nativeReasoningVisibilityRequired !== true)
    return { status: "not_required", missingEfforts: [] };
  const unverified = () => ({ status: "unverified", missingEfforts: [] });
  try {
    if (!codexRendererScopeSnapshotIsCurrent()) return unverified();
    const atoms = state.nativeReasoningVisibilityAtoms;
    if (
      !Array.isArray(atoms) ||
      codexNativeReasoningOwnData(atoms, "length") !== 1
    )
      return unverified();
    const atom = codexNativeReasoningOwnData(atoms, "0");
    const scopeDefinition = codexNativeReasoningOwnData(atom, "scope");
    if (
      !scopeDefinition ||
      !["object", "function"].includes(typeof scopeDefinition) ||
      scopeDefinition === globalThis ||
      typeof codexNativeReasoningOwnData(atom, "resolve") !== "function"
    )
      return unverified();
    if (!Array.isArray(efforts)) return unverified();
    const count = codexNativeReasoningOwnData(efforts, "length");
    if (!Number.isInteger(count) || count < 0 || count > 64)
      return unverified();
    const expected = [];
    for (let index = 0; index < count; index += 1) {
      const effort = codexNativeReasoningOwnData(efforts, String(index));
      if (typeof effort !== "string" || !effort) return unverified();
      if (!expected.includes(effort)) expected.push(effort);
    }
    // Scope ownership is fresh, not inferred from the historical patched-cache
    // map. Use the intrinsic iterator only for the canonical current scope Set.
    const scopes = Set.prototype.values.call(
      state.scopedAppServerScopeCandidates,
    );
    for (let inspected = 0; inspected < 2048; inspected += 1) {
      const entry = scopes.next();
      if (entry.done) break;
      const scope = entry.value;
      try {
        const currentCache = codexNativeReasoningScopeQueryCache(scope);
        if (!currentCache || currentCache !== cache) continue;
        const get = codexNativeReasoningOwnData(scope, "get");
        if (typeof get !== "function") return unverified();
        // Native scope.get resolves the exact definition through its parent
        // chain. Never invoke atom.resolve or a new hook/factory ourselves.
        const enabled = get.call(scope, atom);
        Set.prototype.has.call(enabled, "");
        return {
          status: "known",
          missingEfforts: expected.filter(
            (effort) => !Set.prototype.has.call(enabled, effort),
          ),
        };
      } catch {
        // No alternate scope may turn a failed same-owner native read into a
        // positive proof by borrowing another account or historical value.
        return unverified();
      }
    }
  } catch {}
  return unverified();
};

// The native model projection reads Q3tq.pN through the same current dependency
// scope that owns the picker query cache. Current Desktop 26.1029 omits `max`
// from that native set even when the managed catalog declares it. Keep the
// repair renderer-local and reversible: wrap only that exact scope.get/atom
// pair, return a Set clone with `max`, and never persist or mutate the user's
// Codex preference store. A release or renderer reinjection restores the exact
// original method.
const codexNativeReasoningCloneSet = (value) => {
  try {
    Set.prototype.has.call(value, "");
    const iterator = Set.prototype.values.call(value);
    const values = [];
    for (let index = 0; index < 64; index += 1) {
      const entry = iterator.next();
      if (entry.done) return values;
      if (typeof entry.value !== "string" || !entry.value) return null;
      if (!values.includes(entry.value)) values.push(entry.value);
    }
  } catch {}
  return null;
};
const codexNativeReasoningManagedEfforts = () => {
  try {
    if (typeof currentPayload !== "function") return [];
    const payload = currentPayload();
    if (
      payload?.catalogAvailable !== true ||
      typeof payload?.modelProvider !== "string" ||
      !payload.modelProvider.trim() ||
      payload.modelProvider.trim() === "openai"
    )
      return [];
    const names =
      typeof modelNames === "function"
        ? modelNames()
        : Array.isArray(payload.modelNames)
          ? payload.modelNames
          : [];
    const efforts = [];
    for (const name of names) {
      const descriptor =
        typeof descriptorFor === "function" ? descriptorFor(name) : null;
      const levels = descriptor?.supportedReasoningEfforts;
      if (!Array.isArray(levels)) continue;
      for (const level of levels) {
        const effort = level?.reasoningEffort;
        if (
          typeof effort === "string" &&
          effort.trim() &&
          !efforts.includes(effort.trim())
        )
          efforts.push(effort.trim());
      }
    }
    return efforts;
  } catch {
    return [];
  }
};
const codexNativeReasoningScopeIsCurrent = (scope, cache) => {
  if (!codexRendererScopeSnapshotIsCurrent()) return false;
  try {
    return codexNativeReasoningScopeQueryCache(scope) === cache;
  } catch {
    return false;
  }
};
const codexNativeReasoningCacheHasManagedQuery = (cache) => {
  try {
    const getAll = codexDeclaredMethod(cache, "getAll");
    if (!getAll) return false;
    return codexPickerDataArray(getAll.call(cache)).some((query) =>
      isManagedCodexModelQuery(
        codexPickerDataArray(codexPickerOwnData(query, "queryKey")),
      ),
    );
  } catch {
    return false;
  }
};
const codexNativeReasoningPatchMap = () => {
  if (!(state.nativeReasoningVisibilityPatches instanceof Map))
    state.nativeReasoningVisibilityPatches = new Map();
  return state.nativeReasoningVisibilityPatches;
};
const restoreCodexNativeReasoningVisibility = () => {
  const patches = state.nativeReasoningVisibilityPatches;
  state.nativeReasoningVisibilityMaxEnabled = false;
  if (!(patches instanceof Map)) return 0;
  let restored = 0;
  for (const [scope, record] of patches) {
    try {
      const current = Object.getOwnPropertyDescriptor(scope, "get");
      if (current?.value === record.patched) {
        if (record.originalOwnDescriptor)
          Object.defineProperty(scope, "get", record.originalOwnDescriptor);
        else delete scope.get;
        restored += 1;
      }
    } catch {}
    patches.delete(scope);
  }
  return restored;
};
const codexNativeReasoningRefreshPickerObservers = () => {
  for (const entry of state.reasoningQueryCaches?.values?.() || []) {
    try {
      entry.refresh?.();
    } catch {}
  }
};
const reconcileCodexNativeReasoningVisibility = (requestedEfforts) => {
  const result = {
    status: "unverified",
    managed: false,
    patchedScopes: 0,
    restoredScopes: 0,
  };
  if (state.nativeReasoningVisibilityRequired !== true) {
    result.status = "not_required";
    result.restoredScopes = restoreCodexNativeReasoningVisibility();
    return result;
  }
  const efforts = Array.isArray(requestedEfforts)
    ? requestedEfforts.filter(
        (effort, index, values) =>
          typeof effort === "string" &&
          effort.trim() &&
          values.indexOf(effort) === index,
      )
    : [];
  const shouldExposeMax = efforts.includes("max");
  result.managed = shouldExposeMax;
  const atoms = state.nativeReasoningVisibilityAtoms;
  if (
    !Array.isArray(atoms) ||
    codexNativeReasoningOwnData(atoms, "length") !== 1 ||
    !codexRendererScopeSnapshotIsCurrent()
  ) {
    result.restoredScopes = restoreCodexNativeReasoningVisibility();
    return result;
  }
  const atom = codexNativeReasoningOwnData(atoms, "0");
  const atomScope = codexNativeReasoningOwnData(atom, "scope");
  if (
    !atomScope ||
    typeof codexNativeReasoningOwnData(atom, "resolve") !== "function"
  ) {
    result.restoredScopes = restoreCodexNativeReasoningVisibility();
    return result;
  }
  const scopes = state.scopedAppServerScopeCandidates;
  if (!(scopes instanceof Set)) {
    result.restoredScopes = restoreCodexNativeReasoningVisibility();
    return result;
  }
  const currentScopes = new Set();
  try {
    const iterator = Set.prototype.values.call(scopes);
    for (let index = 0; index < 2048; index += 1) {
      const entry = iterator.next();
      if (entry.done) break;
      currentScopes.add(entry.value);
    }
  } catch {
    result.restoredScopes = restoreCodexNativeReasoningVisibility();
    return result;
  }
  const currentCaches = codexCurrentNativeReasoningQueryCaches();
  if (!currentCaches) {
    result.restoredScopes = restoreCodexNativeReasoningVisibility();
    return result;
  }
  const patches = codexNativeReasoningPatchMap();
  // A changed atom, scope, or renderer ownership snapshot invalidates the old
  // wrapper. Restore it before installing the new exact current-owner patch.
  for (const [scope, record] of patches) {
    let retained = record.atom === atom && currentScopes.has(scope);
    if (retained) {
      try {
        const getDescriptor = Object.getOwnPropertyDescriptor(scope, "get");
        const cache = codexNativeReasoningScopeQueryCache(scope);
        retained =
          getDescriptor?.value === record.patched &&
          Boolean(cache) &&
          currentCaches.has(cache) &&
          codexNativeReasoningCacheHasManagedQuery(cache);
      } catch {
        retained = false;
      }
    }
    if (!retained) {
      try {
        const current = Object.getOwnPropertyDescriptor(scope, "get");
        if (current?.value === record.patched) {
          if (record.originalOwnDescriptor)
            Object.defineProperty(scope, "get", record.originalOwnDescriptor);
          else delete scope.get;
          result.restoredScopes += 1;
        }
      } catch {}
      patches.delete(scope);
    }
  }
  if (!shouldExposeMax) {
    result.restoredScopes += restoreCodexNativeReasoningVisibility();
    result.status = "known";
    return result;
  }
  state.nativeReasoningVisibilityMaxEnabled = true;
  for (const scope of currentScopes) {
    const cache = codexNativeReasoningScopeQueryCache(scope);
    if (
      !cache ||
      !currentCaches.has(cache) ||
      !codexNativeReasoningScopeIsCurrent(scope, cache) ||
      !codexNativeReasoningCacheHasManagedQuery(cache)
    )
      continue;
    const existing = patches.get(scope);
    if (existing?.atom === atom) {
      result.patchedScopes += 1;
      continue;
    }
    const ownDescriptor = Object.getOwnPropertyDescriptor(scope, "get");
    const original = codexDeclaredMethod(scope, "get");
    if (
      typeof original !== "function" ||
      (ownDescriptor &&
        (!ownDescriptor.configurable ||
          ("writable" in ownDescriptor && !ownDescriptor.writable)))
    )
      continue;
    let baseline;
    try {
      baseline = original.call(scope, atom);
      if (!codexNativeReasoningCloneSet(baseline)) continue;
    } catch {
      continue;
    }
    const patched = function ccSwitchNativeReasoningVisibility(
      atomValue,
      ...args
    ) {
      const value = original.call(this, atomValue, ...args);
      if (
        this !== scope ||
        state.nativeReasoningVisibilityMaxEnabled !== true ||
        atomValue !== atom ||
        !codexNativeReasoningScopeIsCurrent(scope, cache) ||
        !codexNativeReasoningCacheHasManagedQuery(cache) ||
        !codexNativeReasoningManagedEfforts().includes("max")
      )
        return value;
      const values = codexNativeReasoningCloneSet(value);
      if (!values || values.includes("max")) return value;
      values.push("max");
      return new Set(values);
    };
    try {
      Object.defineProperty(scope, "get", {
        configurable: true,
        enumerable: ownDescriptor?.enumerable ?? false,
        writable: true,
        value: patched,
      });
      patches.set(scope, {
        atom,
        cache,
        originalOwnDescriptor: ownDescriptor,
        original,
        patched,
      });
      result.patchedScopes += 1;
    } catch {}
  }
  result.status = patches.size ? "known" : "unverified";
  if (result.patchedScopes) codexNativeReasoningRefreshPickerObservers();
  return result;
};
// The runtime and release fragments execute before this fragment is evaluated
// during an initial injection. Keep the current restore hook on state so a
// later reinjection/release can restore the previous closure without touching
// a temporal-dead-zone binding.
state.nativeReasoningVisibilityRestore = restoreCodexNativeReasoningVisibility;
