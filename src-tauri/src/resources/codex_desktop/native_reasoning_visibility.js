// Current Desktop filters the final reasoning menu through an account-scoped
// native signal after selecting model/list. Cache projection alone cannot prove
// final visibility. Read the exact current signal for diagnostics, and apply
// only the reversible renderer-local graded-effort wrapper defined below;
// never persist account/local preferences or change dependency resolution.
const codexNativeReasoningOwnData = (value, key) => {
  if (!value || !["object", "function"].includes(typeof value))
    return undefined;
  const field = Object.getOwnPropertyDescriptor(value, key);
  return field && "value" in field ? field.value : undefined;
};
// Diagnostics are fixed counters from the same fail-closed proof below, not a
// second ownership classifier. Preserve its first-refusal short circuit: these
// counts describe the inspected prefix, never a census of all mounted scopes.
const codexNativeReasoningOwnerRefusal = (inspection, reason) => {
  if (inspection) inspection.ownerFailureCounts[reason] = 1;
  return null;
};
const codexNativeReasoningScopeQueryCache = (scope, inspection) => {
  if (!codexDeclaredDependencyScope(scope))
    return codexNativeReasoningOwnerRefusal(inspection, "scope_contract");
  return codexNativeReasoningNodeQueryCache(
    codexNativeReasoningOwnData(scope, "node"),
    inspection,
  );
};
const codexNativeReasoningNodeQueryCache = (node, inspection) => {
  const refuse = (reason) =>
    codexNativeReasoningOwnerRefusal(inspection, reason);
  // Modern retained nodes may use one exact generated forwarding triple. The
  // shared helper validates every descriptor before invoking only its pure
  // queryClient forwarder; arbitrary accessors remain untrusted.
  if (!node || !["object", "function"].includes(typeof node))
    return refuse("node_unavailable");
  const nodeClientField = Object.getOwnPropertyDescriptor(node, "queryClient");
  if (!nodeClientField) return refuse("node_client_absent");
  const nodeClientIsData = "value" in nodeClientField;
  const nodeClient = nodeClientIsData
    ? nodeClientField.value
    : codexForwardedNodeQueryClient(node);
  if (!nodeClient)
    return refuse(
      nodeClientIsData ? "node_client_uninitialized" : "node_client_accessor",
    );
  // The validated modern node descriptor already supplied the exact client;
  // do not invoke the forwarding getter a second time during the same proof.
  const client = nodeClient;
  const getQueryCache = codexDeclaredMethod(client, "getQueryCache");
  if (
    !getQueryCache ||
    !codexDeclaredMethod(client, "getQueryData") ||
    !codexDeclaredMethod(client, "setQueryData")
  )
    return refuse("client_methods_unavailable");
  const cache = getQueryCache.call(client);
  return cache && ["object", "function"].includes(typeof cache)
    ? cache
    : refuse("cache_unavailable");
};
// A complete current owner snapshot can ignore historical, still-subscribed
// caches without deleting their undo/release registrations. Any uncertain owner
// or a capped scan means unknown, never a partially authoritative cache list.
const codexNativeReasoningCompleteOwnerProof = (
  inspection,
  snapshotCurrent = codexRendererScopeSnapshotIsCurrent(),
) => {
  const refuse = (reason) =>
    codexNativeReasoningOwnerRefusal(inspection, reason);
  if (!snapshotCurrent) return null;
  try {
    const scopes = Set.prototype.values.call(
      state.scopedAppServerScopeCandidates,
    );
    const currentScopes = new Set();
    const scopeCaches = new Map();
    for (
      let inspected = 0;
      inspected <= CODEX_RENDERER_SCOPE_OWNER_LIMIT;
      inspected += 1
    ) {
      const entry = scopes.next();
      if (entry.done)
        return scopeCaches.size
          ? {
              kind: "complete",
              scopes: currentScopes,
              scopeCaches,
              scopeBindings:
                state.scopedAppServerScopeProvenance?.scopeBindings,
              roots: codexRendererScopeRootIdentities(),
              mutationGeneration: codexRendererMutationGeneration(),
              caches: new Set(scopeCaches.values()),
            }
          : refuse("inventory_empty");
      if (inspected === CODEX_RENDERER_SCOPE_OWNER_LIMIT)
        return refuse("inventory_capped");
      if (inspection) inspection.ownerScopeCount = inspected + 1;
      let cache;
      try {
        cache = codexNativeReasoningScopeQueryCache(entry.value, inspection);
      } catch {
        return refuse("scope_read_failed");
      }
      if (!cache) return null;
      currentScopes.add(entry.value);
      scopeCaches.set(entry.value, cache);
    }
  } catch {
    return refuse("inventory_read_failed");
  }
  return null;
};
// The broad Fiber/object inventory can be capped by unrelated renderer state.
// Native reasoning has one narrower, independently validated owner boundary:
// the current app-server status atom brand. This path never certifies the
// broad request-client inventory or changes its completion flag. It only proves
// exact mounted scope/cache pairs for the native preference read/patch, and
// refuses on missing, ambiguous, stale, or mutating hints.
const codexNativeReasoningCanonicalOwnerProof = (inspection) => {
  // Fixed counters describe only this proof's inspected prefix. Never retain
  // atom/brand identities, object paths, descriptor contents or error text.
  const counts = inspection?.canonicalOwnerCounts;
  if (counts) {
    counts.hintScanStatus =
      state.scopedAppServerScopeHintScan?.status || "unknown";
    counts.hintScanReason = state.scopedAppServerScopeHintScan?.reason || null;
  }
  const refuse = (reason) => {
    if (inspection) inspection.canonicalOwnerRefusalReason = reason;
    return codexNativeReasoningOwnerRefusal(
      inspection,
      reason === "unavailable"
        ? "canonical_owner_unavailable"
        : "canonical_owner_unverified",
    );
  };
  if (typeof codexCurrentAppServerScopeHints !== "function")
    return refuse("unavailable");
  const atoms = state.appServerStatusAtoms;
  const brands = new Set();
  let atomCount;
  try {
    atomCount = codexNativeReasoningOwnData(atoms, "length");
    if (counts && Number.isSafeInteger(atomCount) && atomCount >= 0)
      counts.appServerStatusAtomCount = Math.min(atomCount, 17);
    if (
      !Array.isArray(atoms) ||
      !Number.isSafeInteger(atomCount) ||
      atomCount < 1 ||
      atomCount > 16
    )
      return refuse("atoms_unverified");
    for (let index = 0; index < atomCount; index += 1) {
      const atom = codexNativeReasoningOwnData(atoms, String(index));
      const brand = codexNativeReasoningOwnData(atom, "scope");
      if (
        !brand ||
        typeof codexNativeReasoningOwnData(atom, "resolve") !== "function"
      )
        return refuse("atoms_unverified");
      brands.add(brand);
      if (counts) counts.uniqueBrandCount = brands.size;
    }
  } catch {
    return refuse("atoms_unverified");
  }
  // Several status atoms may share a brand, and every mounted scope of that
  // brand must be accounted for in the proof.
  let pendingNodeCount = 0;
  try {
    if (state.pendingReactNodes != null)
      pendingNodeCount = Object.getOwnPropertyDescriptor(
        Set.prototype,
        "size",
      ).get.call(state.pendingReactNodes);
  } catch {
    return refuse("pending_nodes");
  }
  if (counts) counts.pendingNodeCount = Math.min(pendingNodeCount, 30000);
  if (pendingNodeCount > 0) return refuse("pending_nodes");
  let beforeRoots;
  let beforeGeneration;
  try {
    beforeRoots = codexRendererScopeRootIdentities();
    beforeGeneration = codexRendererMutationGeneration();
  } catch {
    return refuse("roots_unavailable");
  }
  if (!beforeRoots.length) return refuse("roots_unavailable");
  let hints;
  const scopeBindings = new Map();
  try {
    hints = codexCurrentAppServerScopeHints(true, scopeBindings);
    if (counts && Array.isArray(hints))
      counts.hintCount = Math.min(
        hints.length,
        CODEX_RENDERER_SCOPE_OWNER_LIMIT + 1,
      );
    if (counts) {
      counts.hintScanStatus =
        state.scopedAppServerScopeHintScan?.status || "unknown";
      counts.hintScanReason =
        state.scopedAppServerScopeHintScan?.reason || null;
    }
  } catch {
    return refuse("hints_read_failed");
  }
  let afterRoots;
  try {
    afterRoots = codexRendererScopeRootIdentities();
    if (
      beforeRoots.length !== afterRoots.length ||
      !beforeRoots.every((root, index) => root === afterRoots[index]) ||
      beforeGeneration !== codexRendererMutationGeneration() ||
      state.pendingReactNodes?.size > 0
    )
      return refuse("snapshot_changed");
  } catch {
    return refuse("snapshot_changed");
  }
  if (state.scopedAppServerScopeHintScanComplete !== true)
    return refuse("hints_incomplete");
  if (
    !Array.isArray(hints) ||
    hints.length < brands.size ||
    hints.length > CODEX_RENDERER_SCOPE_OWNER_LIMIT
  )
    return refuse("hint_count_mismatch");
  const scopes = new Set(hints);
  if (scopes.size !== hints.length) return refuse("hint_count_mismatch");
  const scopeCaches = new Map();
  const brandCaches = new Map();
  const caches = new Set();
  for (const scope of scopes) {
    let cache;
    let brand;
    try {
      brand = codexNativeReasoningOwnData(scope, "scope");
      // The hint walk found this exact scope in a mounted Fiber. The scope's
      // own node descriptor is the same edge used by the mounted-node walk.
      const node = codexNativeReasoningOwnData(scope, "node");
      const binding = scopeBindings.get(scope);
      if (
        !brands.has(brand) ||
        !node ||
        typeof node !== "object" ||
        binding?.node !== node ||
        !codexRendererScopePathIsCurrent(scope, binding)
      )
        return refuse("scope_unmounted");
      binding.brand = brand;
      cache = codexNativeReasoningScopeQueryCache(scope, inspection);
    } catch {
      return refuse("scope_cache_unverified");
    }
    if (
      !cache ||
      (!caches.has(cache) && !codexNativeReasoningCacheHasManagedQuery(cache))
    )
      return refuse("scope_cache_unverified");
    // The brand identifies a scope definition, not a unique instance. Keep
    // every mounted scope on its exact managed cache; never guess which cache
    // owns the native preference when a single brand spans different caches.
    if (brandCaches.has(brand) && brandCaches.get(brand) !== cache)
      return refuse("hints_ambiguous");
    brandCaches.set(brand, cache);
    scopeCaches.set(scope, cache);
    caches.add(cache);
  }
  if (brandCaches.size !== brands.size) return refuse("hint_count_mismatch");
  return {
    kind: "canonical_hints",
    scopes,
    scopeCaches,
    scopeBindings,
    caches,
    roots: afterRoots,
    mutationGeneration: beforeGeneration,
  };
};
const codexCurrentNativeReasoningOwnerProof = (inspection, scannedBindings) => {
  const snapshotCurrent = codexRendererScopeSnapshotIsCurrent();
  const proof = snapshotCurrent
    ? codexNativeReasoningCompleteOwnerProof(inspection, snapshotCurrent)
    : codexNativeReasoningCanonicalOwnerProof(inspection);
  if (!proof) return null;
  // A settled capped walk allows reconciliation to replace the last published
  // bindings. Validate its path when it saw the scope. The complete canonical
  // walk supplies the exact path for scopes outside the broad walk's budget.
  if (!snapshotCurrent) {
    const previous = state.nativeReasoningVisibilityOwnerProof;
    if (previous) {
      if (
        scannedBindings &&
        Array.from(proof.scopeCaches).every(
          ([scope, cache]) =>
            previous.scopeCaches.get(scope) === cache ||
            codexRendererScopePathIsCurrent(
              scope,
              scannedBindings.get(scope) ?? proof.scopeBindings.get(scope),
            ),
        )
      )
        return proof;
      for (const [scope, cache] of proof.scopeCaches) {
        if (previous.scopeCaches.get(scope) !== cache) return null;
      }
    }
  }
  return proof;
};
const readCodexNativeReasoningVisibility = (cache, efforts, ownerProof) => {
  if (state.nativeReasoningVisibilityRequired !== true)
    return { status: "not_required", missingEfforts: [] };
  const unverified = () => ({ status: "unverified", missingEfforts: [] });
  try {
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
    // The caller proves exact scope/cache pairs for this synchronous sample.
    if (!ownerProof || !ownerProof.caches.has(cache)) return unverified();
    let missingEfforts = null;
    for (const scope of ownerProof.scopes) {
      try {
        const currentCache = ownerProof.scopeCaches.get(scope);
        if (!currentCache || currentCache !== cache) continue;
        const get = codexNativeReasoningOwnData(scope, "get");
        if (typeof get !== "function") return unverified();
        // Native scope.get resolves the exact definition through its parent
        // chain. Never invoke atom.resolve or a new hook/factory ourselves.
        const enabled = get.call(scope, atom);
        Set.prototype.has.call(enabled, "");
        const missing = expected.filter(
          (effort) => !Set.prototype.has.call(enabled, effort),
        );
        // Scopes can share a query cache while resolving different preferences.
        // Without agreement, the cache cannot prove which efforts are visible.
        if (
          missingEfforts &&
          (missing.length !== missingEfforts.length ||
            missing.some((effort, index) => effort !== missingEfforts[index]))
        )
          return unverified();
        missingEfforts = missing;
      } catch {
        // No alternate scope may turn a failed same-owner native read into a
        // positive proof by borrowing another account or historical value.
        return unverified();
      }
    }
    if (missingEfforts) return { status: "known", missingEfforts };
  } catch {}
  return unverified();
};

// The native model projection reads Q3tq.pN through the same current dependency
// scope that owns the picker query cache. Native account defaults can omit
// provider-declared levels (for example OpenRouter minimal or native Max).
// The composer subscribes to the resolved atom through its store. Scopes
// without that store contract still read their native preference via scope.get.
// Both readers project a Set without changing the stored preference.
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
const codexNativeReasoningDeclaredModelEfforts = (descriptor) => {
  const control =
    descriptor?.ccSwitchReasoningControl?.kind ||
    descriptor?.reasoning?.controlKind ||
    descriptor?.reasoning?.control_kind;
  // Boolean aliases and budget controls have separate capability handling.
  const levels = descriptor?.supportedReasoningEfforts;
  if ((control && control !== "graded") || !Array.isArray(levels)) return [];
  const efforts = Array.from(
    new Set(
      levels
        .map((level) => level?.reasoningEffort)
        .filter((effort) => CODEX_NATIVE_REASONING_EFFORTS.has(effort)),
    ),
  );
  // `none` is a graded menu option only when paired with a positive tier.
  return efforts.some((effort) => effort !== "none") ? efforts : [];
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
    const efforts = new Set();
    for (const name of names) {
      const descriptor =
        typeof descriptorFor === "function" ? descriptorFor(name) : null;
      for (const effort of codexNativeReasoningDeclaredModelEfforts(descriptor))
        efforts.add(effort);
    }
    return Array.from(efforts);
  } catch {
    return [];
  }
};
const codexNativeReasoningPowerPatchMap = () => {
  if (!(state.nativeReasoningVisibilityPowerPatches instanceof Map))
    state.nativeReasoningVisibilityPowerPatches = new Map();
  return state.nativeReasoningVisibilityPowerPatches;
};
const codexNativeReasoningCopyEnumerableData = (source) => {
  const copy = {};
  if (!source || typeof source !== "object") return copy;
  try {
    for (const [key, field] of Object.entries(
      Object.getOwnPropertyDescriptors(source),
    )) {
      if (field.enumerable && "value" in field)
        Object.defineProperty(copy, key, {
          value: field.value,
          enumerable: true,
          configurable: true,
          writable: true,
        });
    }
  } catch {}
  return copy;
};
const codexNativeReasoningModelEfforts = (model) => {
  try {
    const descriptor =
      typeof descriptorFor === "function" ? descriptorFor(model) : null;
    const managed = new Set(
      Array.isArray(state.nativeReasoningVisibilityManagedEfforts)
        ? state.nativeReasoningVisibilityManagedEfforts
        : codexNativeReasoningManagedEfforts(),
    );
    return codexNativeReasoningDeclaredModelEfforts(descriptor).filter(
      (effort) => managed.has(effort),
    );
  } catch {
    return [];
  }
};
const codexNativeReasoningRestorePickerPowerSelections = () => {
  const patches = state.nativeReasoningVisibilityPowerPatches;
  if (!(patches instanceof Map)) return 0;
  let restored = 0;
  for (const [props, record] of patches) {
    try {
      const current = Object.getOwnPropertyDescriptor(props, "powerSelections");
      if (current?.value === record.patched) {
        Object.defineProperty(props, "powerSelections", record.original);
        restored += 1;
      }
    } catch {}
    patches.delete(props);
  }
  return restored;
};
const codexNativeReasoningStopPickerPowerSync = () => {
  const timer = state.nativeReasoningVisibilityPickerSyncTimer;
  if (timer == null) return;
  try {
    if (typeof window?.clearInterval === "function")
      window.clearInterval(timer);
  } catch {}
  delete state.nativeReasoningVisibilityPickerSyncTimer;
};
const codexNativeReasoningStartPickerPowerSync = () => {
  if (state.nativeReasoningVisibilityPickerSyncTimer != null) return;
  if (typeof window?.setInterval !== "function") return;
  try {
    state.nativeReasoningVisibilityPickerSyncTimer = window.setInterval(() => {
      if (
        state.nativeReasoningVisibilityEnabled !== true ||
        state.nativeReasoningVisibilityReconciliation?.status !== "known"
      ) {
        codexNativeReasoningRestorePickerPowerSelections();
        return;
      }
      codexNativeReasoningPatchPickerPowerSelections();
    }, 250);
  } catch {}
};
// Native candidates normally inherit provider ownership from the verified current
// picker scope. An explicit provider field must agree; accessors/ambiguity never
// authorize a cross-provider mutation.
const codexNativeReasoningMatchesPickerProvider = (value, provider) => {
  try {
    for (const key of ["modelProvider", "model_provider"]) {
      const field = Object.getOwnPropertyDescriptor(value, key);
      if (!field) continue;
      if (
        !("value" in field) ||
        typeof field.value !== "string" ||
        field.value.trim() !== provider
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
};
const codexNativeReasoningPatchPickerPowerSelections = () => {
  const payload = currentPayload();
  if (
    state.nativeReasoningVisibilityEnabled !== true ||
    payload.catalogAvailable !== true ||
    typeof payload.modelProvider !== "string" ||
    !payload.modelProvider.trim() ||
    payload.modelProvider.trim() === "openai" ||
    typeof document === "undefined" ||
    typeof document.querySelectorAll !== "function"
  )
    return codexNativeReasoningRestorePickerPowerSelections();
  const patches = codexNativeReasoningPowerPatchMap();
  const active = new Set();
  const updates = new Map();
  let patched = 0;
  let nodes;
  try {
    nodes = document.querySelectorAll(
      "span[data-reasoning-effort][data-max-effort]",
    );
  } catch {
    return codexNativeReasoningRestorePickerPowerSelections();
  }
  const count = Number.isSafeInteger(nodes?.length)
    ? Math.min(nodes.length, 32)
    : 0;
  for (let index = 0; index < count; index += 1) {
    let button;
    try {
      const node = nodes[index];
      button = node?.closest?.("button");
    } catch {}
    if (!button?.isConnected) continue;
    const path =
      typeof nativeBooleanCurrentFiberPath === "function"
        ? nativeBooleanCurrentFiberPath(button)
        : null;
    if (!Array.isArray(path)) continue;
    const candidates = [];
    for (const fiber of path) {
      const props = codexNativeReasoningOwnData(fiber, "memoizedProps");
      const candidate = codexNativeReasoningOwnData(
        props,
        "selectedLabelCandidate",
      );
      const selections = codexNativeReasoningOwnData(props, "powerSelections");
      if (
        candidate &&
        typeof codexNativeReasoningOwnData(props, "onSelectPower") ===
          "function" &&
        Array.isArray(selections) &&
        codexNativeReasoningOwnData(props, "triggerConfig") &&
        typeof codexNativeReasoningOwnData(props, "triggerConfig") === "object"
      )
        candidates.push({ props, candidate, selections });
    }
    if (candidates.length !== 1) continue;
    const { props, candidate, selections } = candidates[0];
    const model = codexNativeReasoningOwnData(candidate, "model");
    if (typeof model !== "string" || !model.trim()) continue;
    if (
      !catalogNameIsEnabled(model) ||
      !codexNativeReasoningMatchesPickerProvider(
        candidate,
        payload.modelProvider.trim(),
      )
    )
      continue;
    const efforts = codexNativeReasoningModelEfforts(model);
    // An authoritative empty list closes this model's graded choices. The
    // catalog-wide visibility union must not revive options from its old mode.
    const allowed = new Set(
      (descriptorFor(model).supportedReasoningEfforts || []).map(
        (level) => level.reasoningEffort,
      ),
    );
    const field = Object.getOwnPropertyDescriptor(props, "powerSelections");
    if (
      !field ||
      !("value" in field) ||
      !field.configurable ||
      field.writable === false
    )
      continue;
    const existing = new Map();
    const residual = [];
    let removed = 0;
    const ownsSelection = (selection) => {
      const selectedModel = codexNativeReasoningOwnData(selection, "model");
      return (
        typeof selectedModel === "string" &&
        normalizedIdentity(selectedModel) === normalizedIdentity(model) &&
        codexNativeReasoningMatchesPickerProvider(
          selection,
          payload.modelProvider.trim(),
        )
      );
    };
    for (const selection of selections) {
      const effort = codexNativeReasoningOwnData(selection, "reasoningEffort");
      if (!ownsSelection(selection) || typeof effort !== "string") {
        residual.push(selection);
      } else if (!allowed.has(effort) || existing.has(effort)) {
        removed += 1;
      } else if (efforts.includes(effort)) {
        existing.set(effort, selection);
      } else {
        // Preserve only canonical overlays/none for this exact model. Other
        // providers, models and unscoped rows remain untouched above.
        residual.push(selection);
      }
    }
    const missing = efforts.filter((effort) => !existing.has(effort));
    if (!missing.length && removed === 0) {
      const retained = patches.get(props);
      if (retained?.patched === field.value) active.add(props);
      continue;
    }
    const template = existing.values().next().value || candidate;
    const modelLabel = codexNativeReasoningOwnData(candidate, "modelLabel");
    const next = [];
    for (let effortIndex = 0; effortIndex < efforts.length; effortIndex += 1) {
      const effort = efforts[effortIndex];
      const row = existing.get(effort);
      if (row) {
        next.push(row);
        continue;
      }
      const generated = codexNativeReasoningCopyEnumerableData(template);
      generated.id = `${model}:${effort}`;
      generated.model = model;
      if (typeof modelLabel === "string" && modelLabel.trim())
        generated.modelLabel = modelLabel;
      generated.reasoningEffort = effort;
      generated.powerSettingIndex = effortIndex;
      if (typeof generated.isLocked !== "boolean") generated.isLocked = false;
      next.push(generated);
    }
    next.push(...residual);
    updates.set(props, {
      field,
      next: next.map((row, index) => {
        const previous = codexNativeReasoningOwnData(row, "powerSettingIndex");
        return Number.isSafeInteger(previous) &&
          previous !== index &&
          ownsSelection(row)
          ? {
              ...codexNativeReasoningCopyEnumerableData(row),
              powerSettingIndex: index,
            }
          : row;
      }),
    });
  }
  // DOM and Fiber lookups precede one inventory check for the whole batch.
  if (
    (active.size || updates.size) &&
    (!codexNativeReasoningRetainedOwnerProofIsCurrent() ||
      (state.nativeReasoningVisibilityOwnerProof.kind === "complete" &&
        !Array.from(state.nativeReasoningVisibilityOwnerProof.caches).some(
          codexNativeReasoningCacheHasManagedQuery,
        )))
  )
    return codexNativeReasoningRestorePickerPowerSelections();
  for (const [props, { field, next }] of updates) {
    try {
      const current = Object.getOwnPropertyDescriptor(props, "powerSelections");
      if (current?.value !== field.value) continue;
      Object.defineProperty(props, "powerSelections", {
        ...current,
        value: next,
      });
      if (codexNativeReasoningOwnData(props, "powerSelections") !== next)
        continue;
      const previous = patches.get(props);
      patches.set(props, {
        original: previous?.patched === field.value ? previous.original : field,
        patched: next,
      });
      active.add(props);
      patched += 1;
    } catch {}
  }
  for (const [props, record] of patches) {
    if (active.has(props)) continue;
    try {
      const current = Object.getOwnPropertyDescriptor(props, "powerSelections");
      if (current?.value === record.patched)
        Object.defineProperty(props, "powerSelections", record.original);
    } catch {}
    patches.delete(props);
  }
  return patched;
};

// Refs can replace scopes without changing the root, node or mutation
// generation. Scoped reads validate their exact current binding. Unscoped
// picker mutations still require a fresh inventory of all owners.
const codexNativeReasoningRetainedOwnerProofIsCurrent = (scope, cache) => {
  const proof = state.nativeReasoningVisibilityOwnerProof;
  if (!proof) return false;
  try {
    if (scope && proof.scopeCaches.get(scope) !== cache) return false;
    if (proof.kind === "complete" && scope)
      return (
        codexRendererScopeBindingIsCurrent(scope) &&
        codexNativeReasoningScopeQueryCache(scope) === cache
      );
    let current;
    if (proof.kind === "canonical_hints") {
      const roots = codexRendererScopeRootIdentities();
      if (
        !Array.isArray(proof.roots) ||
        roots.length !== proof.roots.length ||
        !roots.every((root, index) => root === proof.roots[index]) ||
        proof.mutationGeneration !== codexRendererMutationGeneration() ||
        state.pendingReactNodes?.size > 0
      )
        return false;
      if (scope) {
        const binding = proof.scopeBindings.get(scope);
        return (
          codexRendererScopePathIsCurrent(scope, binding) &&
          binding.brand === codexNativeReasoningOwnData(scope, "scope") &&
          binding.node === codexNativeReasoningOwnData(scope, "node") &&
          codexNativeReasoningScopeQueryCache(scope) === cache
        );
      }
      current = codexNativeReasoningCanonicalOwnerProof();
    } else if (proof.kind === "complete") {
      current = codexNativeReasoningCompleteOwnerProof();
    }
    return Boolean(
      current &&
      current.scopeCaches.size === proof.scopeCaches.size &&
      Array.from(proof.scopeCaches).every(
        ([scope, cache]) => current.scopeCaches.get(scope) === cache,
      ),
    );
  } catch {
    return false;
  }
};
const codexNativeReasoningScopeIsCurrent = (scope, cache) =>
  codexNativeReasoningRetainedOwnerProofIsCurrent(scope, cache);
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
const codexNativeReasoningComposerNode = (scope, brand) => {
  try {
    return Map.prototype.get.call(
      codexNativeReasoningOwnData(scope, "chain"),
      codexNativeReasoningOwnData(brand, "id"),
    );
  } catch {
    return undefined;
  }
};
const codexNativeReasoningResolvedAtom = (node, atom) => {
  try {
    // Desktop's cached signal resolver retains one atom per definition on
    // its owning node. Inspect that exact binding without resolving it again.
    return WeakMap.prototype.get.call(
      codexNativeReasoningOwnData(node, "cachedBindings"),
      atom,
    );
  } catch {
    return undefined;
  }
};
const codexNativeReasoningAgreesWithScopeGet = (scope, brand, owner) => {
  // React uses the context chain. The imperative getter first checks the
  // nearest matching node, then falls back to the chain.
  let node = codexNativeReasoningOwnData(scope, "node");
  for (let depth = 0; node && depth < 32; depth += 1) {
    if (codexNativeReasoningOwnData(node, "token") === brand)
      return node === owner;
    const parent = Object.getOwnPropertyDescriptor(node, "parent");
    if (!parent || "value" in parent) node = parent?.value;
    else if (codexForwardedNodeQueryClientDescriptor(node))
      node = parent.get.call(node);
    else return false;
  }
  return node == null;
};
const codexNativeReasoningRestoreGet = (target, record) => {
  try {
    if (codexNativeReasoningOwnData(target, "get") !== record.patched)
      return false;
    if (record.originalOwnDescriptor)
      Object.defineProperty(target, "get", record.originalOwnDescriptor);
    else delete target.get;
    return true;
  } catch {
    return false;
  }
};
// A same-fingerprint reinjection retains the installed readers. Share their
// registry so a new scope cannot wrap an already patched store again.
const codexNativeReasoningStorePatches =
  (state.nativeReasoningVisibilityStorePatches ??= new Map());
const codexNativeReasoningSameFiber = (saved, current) =>
  saved === current ||
  (codexNativeReasoningOwnData(saved, "alternate") === current &&
    codexNativeReasoningOwnData(current, "alternate") === saved);
const codexNativeReasoningStoreScopeIsCurrent = (scope, cache) => {
  if (codexNativeReasoningScopeIsCurrent(scope, cache)) return true;
  // React checks the external-store snapshot after committing the alternate
  // HostRoot. Revalidate the exact mounted scope along the committed edges
  // so that a renderer commit alone does not change the store snapshot.
  const proof = state.nativeReasoningVisibilityOwnerProof;
  if (
    proof?.scopeCaches.get(scope) !== cache ||
    proof.mutationGeneration !== codexRendererMutationGeneration() ||
    state.pendingReactNodes?.size > 0
  )
    return false;
  const binding = proof.scopeBindings?.get(scope);
  if (binding?.value !== scope) return false;
  const roots = codexRendererScopeRootIdentities();
  if (
    roots.length !== proof.roots.length ||
    !roots.every(
      (root, index) =>
        codexNativeReasoningSameFiber(proof.roots[index], root) &&
        codexNativeReasoningOwnData(proof.roots[index], "stateNode") ===
          codexNativeReasoningOwnData(root, "stateNode"),
    )
  )
    return false;
  const path = [];
  let ancestor = binding;
  while (ancestor.parent) {
    if (path.length >= CODEX_RENDERER_FIBER_SCAN_LIMIT + 16) return false;
    path.push(ancestor);
    ancestor = ancestor.parent;
  }
  let value = roots[proof.roots.indexOf(ancestor.value)];
  let onFiber = true;
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const { key, value: saved } = path[index];
    value = codexNativeReasoningOwnData(value, key);
    if (!value) return false;
    onFiber = onFiber && (key === "child" || key === "sibling");
    if (onFiber && !codexNativeReasoningSameFiber(saved, value)) return false;
  }
  return (
    value === scope && codexNativeReasoningScopeQueryCache(scope) === cache
  );
};
const codexNativeReasoningStoreBindingIsCurrent = (scope, binding) => {
  const {
    atom,
    brand,
    cache,
    node,
    store,
    scopeBrand,
    scopeGet,
    scopeNode,
    resolve,
    resolved,
    patch,
  } = binding;
  try {
    const atoms = state.nativeReasoningVisibilityAtoms;
    return (
      Array.isArray(atoms) &&
      codexNativeReasoningOwnData(atoms, "length") === 1 &&
      codexNativeReasoningOwnData(atoms, "0") === atom &&
      codexNativeReasoningOwnData(atom, "scope") === brand &&
      codexNativeReasoningOwnData(atom, "resolve") === resolve &&
      codexNativeReasoningOwnData(scope, "scope") === scopeBrand &&
      codexNativeReasoningOwnData(scope, "get") === scopeGet &&
      codexNativeReasoningOwnData(scope, "node") === scopeNode &&
      codexNativeReasoningOwnData(store, "get") === patch.patched &&
      codexNativeReasoningOwnData(node, "store") === store &&
      codexNativeReasoningComposerNode(scope, brand) === node &&
      codexNativeReasoningResolvedAtom(node, atom) === resolved &&
      codexNativeReasoningAgreesWithScopeGet(scope, brand, node) &&
      codexNativeReasoningStoreScopeIsCurrent(scope, cache) &&
      (node === scopeNode ||
        codexNativeReasoningNodeQueryCache(node) === cache) &&
      codexNativeReasoningCacheHasManagedQuery(cache)
    );
  } catch {
    return false;
  }
};
const codexNativeReasoningProjectStoreValue = (reader, value) => {
  if (state.nativeReasoningVisibilityOwnerProof?.payload !== currentPayload())
    return value;
  const native = codexNativeReasoningCloneSet(value);
  if (!native) return value;
  const missing = state.nativeReasoningVisibilityManagedEfforts.filter(
    (effort) => !native.includes(effort),
  );
  if (!missing.length) return value;
  const values = [...native, ...missing];
  // useSyncExternalStore compares snapshots by identity. A new Set on each
  // read would make React continually render even when membership is unchanged.
  if (
    reader.values?.length !== values.length ||
    values.some((effort, index) => reader.values[index] !== effort)
  ) {
    reader.values = values;
    reader.snapshot = new Set(values);
  }
  return reader.snapshot;
};
const codexNativeReasoningAttachStoreReader = (scope, binding) => {
  const { resolved, store } = binding;
  let patch = codexNativeReasoningStorePatches.get(store);
  if (!patch) {
    const originalOwnDescriptor = Object.getOwnPropertyDescriptor(store, "get");
    const original = originalOwnDescriptor?.value;
    if (
      typeof original !== "function" ||
      !originalOwnDescriptor.configurable ||
      !originalOwnDescriptor.writable ||
      typeof codexNativeReasoningOwnData(store, "sub") !== "function"
    )
      return false;
    patch = { originalOwnDescriptor, readers: new Map() };
    patch.patched = function ccSwitchNativeReasoningStoreGet(atom, ...args) {
      const value = original.call(this, atom, ...args);
      if (this !== store) return value;
      const reader = patch.readers.get(atom);
      if (state.nativeReasoningVisibilityEnabled === true && reader) {
        for (const [owner, current] of reader.bindings)
          if (codexNativeReasoningStoreBindingIsCurrent(owner, current))
            return codexNativeReasoningProjectStoreValue(reader, value);
      }
      return value;
    };
    Object.defineProperty(store, "get", {
      ...originalOwnDescriptor,
      value: patch.patched,
    });
    codexNativeReasoningStorePatches.set(store, patch);
  }
  if (codexNativeReasoningOwnData(store, "get") !== patch.patched) return false;
  let reader = patch.readers.get(resolved);
  if (!reader) {
    reader = { bindings: new Map() };
    patch.readers.set(resolved, reader);
  }
  binding.patch = patch;
  reader.bindings.set(scope, binding);
  return true;
};
const codexNativeReasoningRestoreScope = (scope, record) => {
  if (!record.store) return codexNativeReasoningRestoreGet(scope, record);
  const { store, resolved, patch } = record;
  const reader = patch.readers.get(resolved);
  reader.bindings.delete(scope);
  if (!reader.bindings.size) patch.readers.delete(resolved);
  if (!patch.readers.size) {
    codexNativeReasoningRestoreGet(store, patch);
    codexNativeReasoningStorePatches.delete(store);
  }
  return true;
};
const restoreCodexNativeReasoningVisibility = () => {
  const patches = state.nativeReasoningVisibilityPatches;
  state.nativeReasoningVisibilityEnabled = false;
  delete state.nativeReasoningVisibilityMaxEnabled;
  codexNativeReasoningStopPickerPowerSync();
  codexNativeReasoningRestorePickerPowerSelections();
  if (!(patches instanceof Map)) return 0;
  let restored = 0;
  for (const [scope, record] of patches) {
    if (codexNativeReasoningRestoreScope(scope, record)) restored += 1;
    patches.delete(scope);
  }
  return restored;
};
const codexNativeReasoningRefreshPickerObservers = () => {
  const refreshVersion = Number.isSafeInteger(
    state.nativeReasoningVisibilityRefreshVersion,
  )
    ? state.nativeReasoningVisibilityRefreshVersion
    : 0;
  for (const entry of state.reasoningQueryCaches?.values?.() || []) {
    try {
      // The native scope wrapper changes a read-time atom projection after the
      // cached model query has already been selected. Ask the public
      // QueryObserver recomputation boundary to notify mounted picker
      // subscribers without refetching or mutating scope.set/watch state.
      (entry.refreshNative || entry.refresh)?.(refreshVersion);
    } catch {}
  }
};
// Refusal must invalidate any previously published native projection before
// returning. Restoring the scope/props alone does not force mounted React
// observers to recompute, so a stale Max row could survive until an unrelated
// render. This helper is only for fail-closed exits; the normal known path
// keeps its existing refresh-key coalescing.
const codexNativeReasoningRestoreAndRefresh = () => {
  const hadPublishedProjection =
    (typeof state.nativeReasoningVisibilityRefreshKey === "string" &&
      state.nativeReasoningVisibilityRefreshKey.length > 0) ||
    (state.nativeReasoningVisibilityPowerPatches instanceof Map &&
      state.nativeReasoningVisibilityPowerPatches.size > 0);
  const restoredScopes = restoreCodexNativeReasoningVisibility();
  state.nativeReasoningVisibilityManagedEfforts = [];
  state.nativeReasoningVisibilityRefreshKey = "";
  if (hadPublishedProjection || restoredScopes > 0) {
    state.nativeReasoningVisibilityRefreshVersion =
      (Number.isSafeInteger(state.nativeReasoningVisibilityRefreshVersion)
        ? state.nativeReasoningVisibilityRefreshVersion
        : 0) + 1;
    codexNativeReasoningRefreshPickerObservers();
  }
  return restoredScopes;
};
const reconcileCodexNativeReasoningVisibility = (requestedEfforts) => {
  const result = {
    status: "unverified",
    managed: false,
    patchedScopes: 0,
    restoredScopes: 0,
    refusalReason: null,
    ownerScopeCount: 0,
    canonicalOwnerRefusalReason: null,
    canonicalOwnerCounts: {
      // Counts saturate at the first excess atom/hint and 30000 pending nodes.
      appServerStatusAtomCount: 0,
      uniqueBrandCount: 0,
      hintCount: 0,
      pendingNodeCount: 0,
      hintScanStatus: "unknown",
      hintScanReason: null,
    },
    ownerFailureCounts: {
      scope_contract: 0,
      node_unavailable: 0,
      node_client_absent: 0,
      node_client_accessor: 0,
      node_client_uninitialized: 0,
      client_mismatch: 0,
      client_methods_unavailable: 0,
      cache_unavailable: 0,
      scope_read_failed: 0,
      inventory_empty: 0,
      inventory_capped: 0,
      inventory_read_failed: 0,
      owner_snapshot_unverified: 0,
      canonical_owner_unavailable: 0,
      canonical_owner_unverified: 0,
    },
  };
  if (state.nativeReasoningVisibilityRequired !== true) {
    result.status = "not_required";
    result.restoredScopes = codexNativeReasoningRestoreAndRefresh();
    return result;
  }
  const declaredEfforts = codexNativeReasoningManagedEfforts();
  const efforts = Array.isArray(requestedEfforts)
    ? requestedEfforts.filter(
        (effort, index, values) =>
          declaredEfforts.includes(effort) && values.indexOf(effort) === index,
      )
    : [];
  const shouldExposeNativeEfforts = efforts.length > 0;
  const refreshKey = shouldExposeNativeEfforts ? efforts.join("\0") : "";
  state.nativeReasoningVisibilityManagedEfforts = shouldExposeNativeEfforts
    ? [...efforts]
    : [];
  result.managed = shouldExposeNativeEfforts;
  const atoms = state.nativeReasoningVisibilityAtoms;
  if (
    !Array.isArray(atoms) ||
    codexNativeReasoningOwnData(atoms, "length") !== 1
  ) {
    result.refusalReason = "native_atom_unverified";
    result.restoredScopes = codexNativeReasoningRestoreAndRefresh();
    return result;
  }
  // The complete owner-cache inventory below validates retained nested
  // provenance once. If that broad inventory is capped, a separate exact
  // canonical atom-owner proof may authorize only native visibility.
  const atom = codexNativeReasoningOwnData(atoms, "0");
  const atomScope = codexNativeReasoningOwnData(atom, "scope");
  const resolve = codexNativeReasoningOwnData(atom, "resolve");
  if (!atomScope || typeof resolve !== "function") {
    result.refusalReason = "native_atom_definition_unverified";
    result.restoredScopes = codexNativeReasoningRestoreAndRefresh();
    return result;
  }
  const ownerProof = codexCurrentNativeReasoningOwnerProof(
    result,
    typeof codexTakeCappedRendererScopeBindings === "function"
      ? codexTakeCappedRendererScopeBindings()
      : null,
  );
  if (!ownerProof) {
    result.refusalReason = codexRendererScopeSnapshotRootsAreCurrent()
      ? "owner_cache_inventory_unverified"
      : "renderer_scope_snapshot_unverified";
    result.restoredScopes = codexNativeReasoningRestoreAndRefresh();
    return result;
  }
  const currentScopes = ownerProof.scopes;
  const managedCaches =
    ownerProof.kind === "canonical_hints"
      ? ownerProof.caches
      : new Set(
          Array.from(ownerProof.caches).filter(
            codexNativeReasoningCacheHasManagedQuery,
          ),
        );
  state.nativeReasoningVisibilityOwnerProof = {
    ...ownerProof,
    payload: currentPayload(),
  };
  const patches = codexNativeReasoningPatchMap();
  const usesComposerStore =
    typeof codexNativeReasoningOwnData(atomScope, "id") === "symbol";
  const unmanagedStores = new Set();
  if (usesComposerStore) {
    for (const [scope, cache] of ownerProof.scopeCaches) {
      if (managedCaches.has(cache)) continue;
      const node = codexNativeReasoningComposerNode(scope, atomScope);
      const store = codexNativeReasoningOwnData(node, "store");
      if (store) unmanagedStores.add(store);
    }
  }
  let newlyPatchedScopes = 0;
  // A changed atom, scope, or renderer ownership snapshot invalidates the old
  // wrapper. Restore it before installing the new exact current-owner patch.
  for (const [scope, record] of patches) {
    let retained = record.atom === atom && currentScopes.has(scope);
    if (retained) {
      try {
        const cache = ownerProof.scopeCaches.get(scope);
        retained =
          cache === record.cache &&
          managedCaches.has(cache) &&
          (record.store
            ? usesComposerStore &&
              !unmanagedStores.has(record.store) &&
              codexNativeReasoningStoreBindingIsCurrent(scope, record)
            : !usesComposerStore &&
              codexNativeReasoningOwnData(scope, "get") === record.patched);
      } catch {
        retained = false;
      }
    }
    if (!retained) {
      if (codexNativeReasoningRestoreScope(scope, record))
        result.restoredScopes += 1;
      patches.delete(scope);
    }
  }
  if (!shouldExposeNativeEfforts) {
    result.restoredScopes += restoreCodexNativeReasoningVisibility();
    const needsRefresh =
      result.restoredScopes > 0 ||
      state.nativeReasoningVisibilityRefreshKey !== refreshKey;
    state.nativeReasoningVisibilityRefreshKey = refreshKey;
    if (needsRefresh)
      state.nativeReasoningVisibilityRefreshVersion =
        (Number.isSafeInteger(state.nativeReasoningVisibilityRefreshVersion)
          ? state.nativeReasoningVisibilityRefreshVersion
          : 0) + 1;
    result.status = "known";
    if (needsRefresh) codexNativeReasoningRefreshPickerObservers();
    return result;
  }
  for (const scope of currentScopes) {
    const cache = ownerProof.scopeCaches.get(scope);
    if (!managedCaches.has(cache)) continue;
    const existing = patches.get(scope);
    if (existing?.atom === atom) {
      result.patchedScopes += 1;
      continue;
    }
    const ownDescriptor = Object.getOwnPropertyDescriptor(scope, "get");
    const original = codexDeclaredMethod(scope, "get");
    if (usesComposerStore) {
      try {
        const node = codexNativeReasoningComposerNode(scope, atomScope);
        const store = codexNativeReasoningOwnData(node, "store");
        if (
          codexNativeReasoningOwnData(atom, "cache") !== "cached" ||
          typeof original !== "function" ||
          codexNativeReasoningOwnData(node, "token") !== atomScope ||
          !store ||
          unmanagedStores.has(store) ||
          codexNativeReasoningNodeQueryCache(node) !== cache ||
          !codexNativeReasoningAgreesWithScopeGet(scope, atomScope, node)
        ) {
          result.refusalReason = "native_store_owner_unverified";
          break;
        }
        if (!codexNativeReasoningCloneSet(original.call(scope, atom))) {
          result.refusalReason = "native_set_unverified";
          break;
        }
        const resolved = codexNativeReasoningResolvedAtom(node, atom);
        const record = {
          atom,
          brand: atomScope,
          cache,
          node,
          resolve,
          resolved,
          scopeBrand: codexNativeReasoningOwnData(scope, "scope"),
          scopeGet: original,
          scopeNode: codexNativeReasoningOwnData(scope, "node"),
          store,
        };
        if (
          typeof codexNativeReasoningOwnData(resolved, "read") !== "function" ||
          !codexNativeReasoningAttachStoreReader(scope, record)
        ) {
          result.refusalReason = "native_store_reader_unverified";
          break;
        }
        patches.set(scope, record);
        newlyPatchedScopes += 1;
        result.patchedScopes += 1;
        continue;
      } catch {
        result.refusalReason = "native_store_read_failed";
        break;
      }
    }
    if (
      typeof original !== "function" ||
      (ownDescriptor &&
        (!ownDescriptor.configurable ||
          ("writable" in ownDescriptor && !ownDescriptor.writable)))
    ) {
      result.refusalReason = "native_get_unpatchable";
      break;
    }
    let baseline;
    try {
      baseline = original.call(scope, atom);
      if (!codexNativeReasoningCloneSet(baseline)) {
        result.refusalReason = "native_set_unverified";
        break;
      }
    } catch {
      result.refusalReason = "native_get_read_failed";
      break;
    }
    const patched = function ccSwitchNativeReasoningVisibility(
      atomValue,
      ...args
    ) {
      const value = original.call(this, atomValue, ...args);
      if (
        this !== scope ||
        state.nativeReasoningVisibilityEnabled !== true ||
        atomValue !== atom ||
        !codexNativeReasoningScopeIsCurrent(scope, cache) ||
        !codexNativeReasoningCacheHasManagedQuery(cache)
      )
        return value;
      const values = codexNativeReasoningCloneSet(value);
      if (!values) return value;
      const missing = codexNativeReasoningManagedEfforts().filter(
        (effort) => !values.includes(effort),
      );
      if (!missing.length) return value;
      return new Set([...values, ...missing]);
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
      newlyPatchedScopes += 1;
      result.patchedScopes += 1;
    } catch {
      result.refusalReason = "native_get_patch_failed";
      break;
    }
  }
  // The menu has no authoritative scope identifier of its own. Publishing a
  // partial bridge can add choices even when the native scope that handles
  // selection refused them. Restore all owned projections on a failed proof.
  if (
    !result.refusalReason &&
    patches.size &&
    !codexNativeReasoningRetainedOwnerProofIsCurrent()
  )
    result.refusalReason = "owner_cache_inventory_unverified";
  if (result.refusalReason || !patches.size) {
    result.refusalReason ||= "no_managed_picker_query";
    result.restoredScopes += codexNativeReasoningRestoreAndRefresh();
    result.patchedScopes = 0;
    return result;
  }
  state.nativeReasoningVisibilityEnabled = true;
  result.status = "known";
  const needsRefresh =
    newlyPatchedScopes > 0 ||
    result.restoredScopes > 0 ||
    state.nativeReasoningVisibilityRefreshKey !== refreshKey;
  state.nativeReasoningVisibilityRefreshKey = refreshKey;
  if (needsRefresh)
    state.nativeReasoningVisibilityRefreshVersion =
      (Number.isSafeInteger(state.nativeReasoningVisibilityRefreshVersion)
        ? state.nativeReasoningVisibilityRefreshVersion
        : 0) + 1;
  codexNativeReasoningStartPickerPowerSync();
  codexNativeReasoningPatchPickerPowerSelections();
  if (needsRefresh) {
    codexNativeReasoningRefreshPickerObservers();
    const schedule =
      typeof queueMicrotask === "function"
        ? queueMicrotask
        : (callback) => setTimeout(callback, 0);
    schedule(() => {
      if (state.nativeReasoningVisibilityEnabled === true)
        codexNativeReasoningPatchPickerPowerSelections();
    });
  }
  return result;
};
// The runtime and release fragments execute before this fragment is evaluated
// during an initial injection. Keep the current restore hook on state so a
// later reinjection/release can restore the previous closure without touching
// a temporal-dead-zone binding.
state.nativeReasoningVisibilityRestore = restoreCodexNativeReasoningVisibility;
