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
  const refuse = (reason) =>
    codexNativeReasoningOwnerRefusal(inspection, reason);
  if (!codexDeclaredDependencyScope(scope)) return refuse("scope_contract");
  const node = codexNativeReasoningOwnData(scope, "node");
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
const codexNativeReasoningCompleteOwnerProof = (inspection) => {
  const refuse = (reason) =>
    codexNativeReasoningOwnerRefusal(inspection, reason);
  if (!codexRendererScopeSnapshotIsCurrent()) return null;
  try {
    const scopes = Set.prototype.values.call(
      state.scopedAppServerScopeCandidates,
    );
    const currentScopes = new Set();
    const scopeCaches = new Map();
    for (let inspected = 0; inspected <= 2048; inspected += 1) {
      const entry = scopes.next();
      if (entry.done)
        return scopeCaches.size
          ? {
              kind: "complete",
              scopes: currentScopes,
              scopeCaches,
              caches: new Set(scopeCaches.values()),
            }
          : refuse("inventory_empty");
      if (inspected === 2048) return refuse("inventory_capped");
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
  if (
    typeof codexCurrentAppServerScopeHints !== "function" ||
    typeof codexRendererScopeIsMounted !== "function"
  )
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
  // Discovery deduplicates status atoms by atom identity, not by scope brand.
  // Several validated manager/status bindings may share one exact scope brand;
  // the shared hint reader deliberately returns one owner per unique brand.
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
  try {
    hints = codexCurrentAppServerScopeHints(true);
    if (counts && Array.isArray(hints))
      counts.hintCount = Math.min(hints.length, 17);
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
  // A complete hint walk can hit an unrelated large Fiber-owned object graph
  // after finding the current branded scopes. Keep that bounded walk usable
  // only after the exact visible scopes below pass mounted/cache validation.
  // Other incomplete scans remain fail-closed.
  const hintScan = state.scopedAppServerScopeHintScan;
  const boundedValueScan =
    hintScan?.status === "capped" && hintScan.reason === "value_limit";
  if (state.scopedAppServerScopeHintScanComplete !== true && !boundedValueScan)
    return refuse("hints_incomplete");
  if (
    !Array.isArray(hints) ||
    hints.length < brands.size ||
    hints.length > CODEX_APP_SERVER_SCOPE_HINT_LIMIT
  )
    return refuse("hint_count_mismatch");
  const scopes = new Set(hints);
  if (scopes.size !== hints.length) return refuse("hint_count_mismatch");
  if (boundedValueScan) {
    // The retained renderer inventory is the second bounded view of the same
    // mounted tree. A capped hint walk may authorize only when every retained
    // candidate is present in the exact branded hints. This rejects omitted
    // visible owners while allowing unrelated object edges to be truncated.
    try {
      const candidates = state.scopedAppServerScopeCandidates;
      if (!candidates || typeof candidates[Symbol.iterator] !== "function")
        return refuse("hints_incomplete");
      for (const candidate of candidates)
        if (!scopes.has(candidate)) return refuse("hints_incomplete");
    } catch {
      return refuse("hints_incomplete");
    }
  }
  const scopeCaches = new Map();
  const brandCaches = new Map();
  for (const scope of hints) {
    let cache;
    let brand;
    try {
      brand = codexNativeReasoningOwnData(scope, "scope");
      if (
        !codexDeclaredDependencyScope(scope) ||
        !brands.has(brand) ||
        !codexRendererScopeIsMounted(scope)
      )
        return refuse("scope_unmounted");
      cache = codexNativeReasoningScopeQueryCache(scope, inspection);
    } catch {
      return refuse("scope_cache_unverified");
    }
    if (!cache || !codexNativeReasoningCacheHasManagedQuery(cache))
      return refuse("scope_cache_unverified");
    // The brand identifies a scope definition, not a unique instance. Keep
    // every mounted scope on its exact managed cache; never guess which cache
    // owns the native preference when a single brand spans different caches.
    if (brandCaches.has(brand) && brandCaches.get(brand) !== cache)
      return refuse("hints_ambiguous");
    brandCaches.set(brand, cache);
    scopeCaches.set(scope, cache);
  }
  if (brandCaches.size !== brands.size) return refuse("hint_count_mismatch");
  return {
    kind: "canonical_hints",
    scopes,
    scopeCaches,
    caches: new Set(scopeCaches.values()),
    roots: afterRoots,
    mutationGeneration: beforeGeneration,
  };
};
const codexCurrentNativeReasoningOwnerProof = (inspection) => {
  const snapshotCurrent = codexRendererScopeSnapshotIsCurrent();
  const proof = snapshotCurrent
    ? codexNativeReasoningCompleteOwnerProof(inspection)
    : codexNativeReasoningCanonicalOwnerProof(inspection);
  if (!proof) return null;
  // A stale broad snapshot may still find a same-node ref replacement through
  // canonical hints. Preserve the identities from the last published proof
  // until a complete current scan can establish a new owner boundary.
  if (!snapshotCurrent) {
    const previous = state.nativeReasoningVisibilityOwnerProof;
    if (previous) {
      const retainedScopes = new Set();
      const retainedScopeCaches = new Map();
      for (const [scope, cache] of proof.scopeCaches) {
        if (previous.scopeCaches.get(scope) !== cache) continue;
        retainedScopes.add(scope);
        retainedScopeCaches.set(scope, cache);
      }
      if (!retainedScopes.size) return null;
      if (retainedScopes.size !== proof.scopeCaches.size)
        return {
          ...proof,
          scopes: retainedScopes,
          scopeCaches: retainedScopeCaches,
          caches: new Set(retainedScopeCaches.values()),
        };
    }
  }
  return proof;
};
const codexCurrentNativeReasoningQueryCaches = (inspection) =>
  codexCurrentNativeReasoningOwnerProof(inspection)?.caches || null;
const readCodexNativeReasoningVisibility = (cache, efforts) => {
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
    // Scope ownership is fresh, not inferred from the historical patched-cache
    // map. Complete inventories and the narrower canonical atom proof both
    // return exact current scope/cache pairs.
    const ownerProof = codexCurrentNativeReasoningOwnerProof();
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
// Keep the repair renderer-local and reversible: wrap only that exact
// scope.get/atom pair, return a Set clone with declared native graded levels,
// and never persist or mutate the user's
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
      // Boolean transport aliases (none/medium) and budget controls do not
      // advertise an intensity ladder. Their owned adapter remains separate.
      const control =
        descriptor?.ccSwitchReasoningControl?.kind ||
        descriptor?.reasoning?.controlKind ||
        descriptor?.reasoning?.control_kind;
      if (control && control !== "graded") continue;
      const levels = descriptor?.supportedReasoningEfforts;
      if (!Array.isArray(levels)) continue;
      for (const level of levels) {
        const effort = level?.reasoningEffort;
        if (
          typeof effort === "string" &&
          CODEX_NATIVE_REASONING_EFFORTS.has(effort.trim()) &&
          effort.trim() !== "none" &&
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
    const control =
      descriptor?.ccSwitchReasoningControl?.kind ||
      descriptor?.reasoning?.controlKind ||
      descriptor?.reasoning?.control_kind;
    // Boolean aliases are owned by the binary adapter, not graded effort
    // generation. Empty non-graded lists still participate in pruning below.
    if (control && control !== "graded") return [];
    const levels = descriptor?.supportedReasoningEfforts;
    if (!Array.isArray(levels)) return [];
    const managed = new Set(
      Array.isArray(state.nativeReasoningVisibilityManagedEfforts)
        ? state.nativeReasoningVisibilityManagedEfforts
        : codexNativeReasoningManagedEfforts(),
    );
    const efforts = [];
    for (const level of levels) {
      const effort = level?.reasoningEffort;
      if (
        typeof effort === "string" &&
        managed.has(effort) &&
        CODEX_NATIVE_REASONING_EFFORTS.has(effort) &&
        effort !== "none" &&
        !efforts.includes(effort)
      )
        efforts.push(effort);
    }
    return efforts;
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
    !codexNativeReasoningRetainedOwnerProofIsCurrent() ||
    !Array.from(state.nativeReasoningVisibilityOwnerProof.caches).some(
      (cache) => codexNativeReasoningCacheHasManagedQuery(cache),
    ) ||
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
    for (const selection of selections) {
      const effort = codexNativeReasoningOwnData(selection, "reasoningEffort");
      const selectedModel = codexNativeReasoningOwnData(selection, "model");
      const owned =
        typeof selectedModel === "string" &&
        normalizedIdentity(selectedModel) === normalizedIdentity(model) &&
        codexNativeReasoningMatchesPickerProvider(
          selection,
          payload.modelProvider.trim(),
        );
      if (!owned || typeof effort !== "string") {
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
    // DOM/Fiber lookup may cross a renderer update. Do not retain an old
    // projection merely because its native array already contains all efforts.
    if (!codexNativeReasoningRetainedOwnerProofIsCurrent())
      return codexNativeReasoningRestorePickerPowerSelections();
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
    if (!codexNativeReasoningRetainedOwnerProofIsCurrent())
      return codexNativeReasoningRestorePickerPowerSelections();
    try {
      Object.defineProperty(props, "powerSelections", {
        ...field,
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

// A mounted node is not proof that its old scope is still the current own-data
// binding: refs can replace scopes without changing the root, node or mutation
// generation. Reuse the same bounded owner proof used during reconciliation,
// and require its exact scope/cache inventory before any retained mutation.
const codexNativeReasoningRetainedOwnerProofIsCurrent = (scope, cache) => {
  const proof = state.nativeReasoningVisibilityOwnerProof;
  if (!proof) return false;
  try {
    if (scope && proof.scopeCaches.get(scope) !== cache) return false;
    // Complete discovery retains exact binding provenance. Native atom reads
    // validate only their own path, not unrelated renderer objects; unscoped
    // picker mutations must still revalidate the whole inventory below.
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
        proof.mutationGeneration !== codexRendererMutationGeneration()
      )
        return false;
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
const restoreCodexNativeReasoningVisibility = () => {
  const patches = state.nativeReasoningVisibilityPatches;
  state.nativeReasoningVisibilityEnabled = false;
  delete state.nativeReasoningVisibilityMaxEnabled;
  codexNativeReasoningStopPickerPowerSync();
  codexNativeReasoningRestorePickerPowerSelections();
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
      // Saturated overflow sentinels are 17 atoms/hints and 30000 pending nodes.
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
  if (
    !atomScope ||
    typeof codexNativeReasoningOwnData(atom, "resolve") !== "function"
  ) {
    result.refusalReason = "native_atom_definition_unverified";
    result.restoredScopes = codexNativeReasoningRestoreAndRefresh();
    return result;
  }
  const ownerProof = codexCurrentNativeReasoningOwnerProof(result);
  if (!ownerProof) {
    result.refusalReason = codexRendererScopeSnapshotRootsAreCurrent()
      ? "owner_cache_inventory_unverified"
      : "renderer_scope_snapshot_unverified";
    result.restoredScopes = codexNativeReasoningRestoreAndRefresh();
    return result;
  }
  const currentScopes = ownerProof.scopes;
  const currentCaches = ownerProof.caches;
  state.nativeReasoningVisibilityOwnerProof = ownerProof;
  const patches = codexNativeReasoningPatchMap();
  let newlyPatchedScopes = 0;
  // A changed atom, scope, or renderer ownership snapshot invalidates the old
  // wrapper. Restore it before installing the new exact current-owner patch.
  for (const [scope, record] of patches) {
    let retained = record.atom === atom && currentScopes.has(scope);
    if (retained) {
      try {
        const getDescriptor = Object.getOwnPropertyDescriptor(scope, "get");
        const cache = ownerProof.scopeCaches.get(scope);
        retained =
          getDescriptor?.value === record.patched &&
          Boolean(cache) &&
          cache === record.cache &&
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
    if (
      !cache ||
      !currentCaches.has(cache) ||
      !codexNativeReasoningScopeIsCurrent(scope, cache)
    ) {
      result.refusalReason = "owner_cache_inventory_unverified";
      break;
    }
    if (!codexNativeReasoningCacheHasManagedQuery(cache)) continue;
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
