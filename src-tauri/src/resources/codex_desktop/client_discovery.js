// RpcStub/RpcPromise proxies manufacture a function for every property name.
// Discover capabilities from declared descriptors so a stub cannot impersonate
// the app-server client or cause arbitrary RPC calls during object discovery.
const codexClientDiscoveryIsCurrent = () =>
  typeof installationIsCurrent !== "function" || installationIsCurrent();
const codexDeclaredMethod = (value, name) => {
  let current = value;
  for (let depth = 0; current && depth < 5; depth += 1) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(current, name);
      if (descriptor)
        return typeof descriptor.value === "function" ? descriptor.value : null;
      current = Object.getPrototypeOf(current);
    } catch {
      return null;
    }
  }
  return null;
};
const looksLikeAppServerRequestClient = (value) =>
  Boolean(
    codexDeclaredMethod(value, "sendRequest") &&
    codexDeclaredMethod(value, "getCompatibleThreadSortKey") &&
    codexDeclaredMethod(value, "supportsPaginatedThreadHistory"),
  );
// A declared original-request marker alone is not proof that user actions are
// observed. Frozen/non-writable clients can silently reject the wrapper while
// retaining callable methods. Verify the installed function's exact ownership.
const codexVerifiedAppServerOriginalRequest = (client, expectedVersion) => {
  try {
    const original = codexDeclaredMethod(
      client,
      "__ccSwitchOriginalSendRequest",
    );
    const wrapper = codexDeclaredMethod(client, "sendRequest");
    if (!original || !wrapper || typeof expectedVersion !== "string")
      return null;
    const hook = Object.getOwnPropertyDescriptor(
      wrapper,
      "__ccSwitchRequestHook",
    )?.value;
    if (!hook || typeof hook !== "object") return null;
    const fields = Object.getOwnPropertyDescriptors(hook);
    return fields.client?.value === client &&
      fields.original?.value === original &&
      fields.version?.value === expectedVersion &&
      Object.getOwnPropertyDescriptor(client, "__ccSwitchModelRequestPatch")
        ?.value === expectedVersion
      ? original
      : null;
  } catch {
    return null;
  }
};
const codexDeclaredModuleValues = (module) => {
  try {
    return Object.values(Object.getOwnPropertyDescriptors(module || {}))
      .filter((descriptor) => "value" in descriptor)
      .map((descriptor) => descriptor.value);
  } catch {
    return [];
  }
};
const codexQueryObserverPrototype = (value) => {
  if (typeof value !== "function") return null;
  try {
    const prototype = Object.getOwnPropertyDescriptor(
      value,
      "prototype",
    )?.value;
    if (!prototype) return null;
    return [
      "createResult",
      "getCurrentResult",
      "getOptimisticResult",
      "getCurrentQuery",
      "setOptions",
    ].every(
      (name) =>
        typeof Object.getOwnPropertyDescriptor(prototype, name)?.value ===
        "function",
    )
      ? prototype
      : null;
  } catch {
    return null;
  }
};
const patchCodexModelReasoningQueryObserverModule = (module) => {
  if (typeof patchCodexModelReasoningQueryObserverPrototype !== "function")
    return;
  for (const value of codexDeclaredModuleValues(module)) {
    const prototype = codexQueryObserverPrototype(value);
    if (!prototype) continue;
    try {
      patchCodexModelReasoningQueryObserverPrototype(prototype);
    } catch (error) {
      recordFailure(error);
    }
  }
};
const codexModelReasoningQueryCacheForClient = (value) => {
  if (!codexClientDiscoveryIsCurrent()) return false;
  const getQueryCache = codexDeclaredMethod(value, "getQueryCache");
  if (
    !getQueryCache ||
    !codexDeclaredMethod(value, "getQueryData") ||
    !codexDeclaredMethod(value, "setQueryData")
  )
    return null;
  try {
    return getQueryCache.call(value) || null;
  } catch (error) {
    recordFailure(error);
    return null;
  }
};
const patchCodexModelReasoningQueryCacheOnce = (cache, patchedCaches) => {
  if (patchedCaches?.has(cache)) return true;
  const patched = patchCodexModelReasoningQueryCache(cache);
  if (patched) patchedCaches?.add(cache);
  return patched;
};
const patchCodexModelReasoningQueryClient = (value, patchedCaches) => {
  const cache = codexModelReasoningQueryCacheForClient(value);
  if (!cache) return false;
  try {
    state.modelPickerQueryClients = state.modelPickerQueryClients || new Map();
    state.modelPickerQueryClients.set(cache, value);
    return patchCodexModelReasoningQueryCacheOnce(cache, patchedCaches);
  } catch (error) {
    recordFailure(error);
    return false;
  }
};
// Ownership checks are separate from hook installation: a historical hook can
// remain attached for restoration without authorizing another continuation.
const codexAppServerClientHasCurrentOwner = (client) => {
  let tracked = false;
  const scoped = state.scopedAppServerClientSet;
  if (scoped instanceof Set && scoped.has(client)) {
    tracked = true;
    if (
      state.scopedAppServerScopeScanComplete === true &&
      codexRendererScopeSnapshotIsCurrent()
    ) {
      const owners = state.scopedAppServerClientOwners;
      if (!(owners instanceof Map)) return true;
      for (const current of owners.get(client) || []) {
        try {
          if (current()) return true;
        } catch {}
      }
    }
  }
  const modules = state.moduleAppServerClientOwners;
  if (modules instanceof Map) {
    tracked = true;
    for (const bindings of modules.values()) {
      for (const binding of bindings instanceof Map
        ? bindings.get(client) || []
        : []) {
        try {
          const field = Object.getOwnPropertyDescriptor(
            binding.module,
            binding.key,
          );
          if (!field || !("value" in field) || field.value !== binding.source)
            continue;
          if (!binding.get) {
            if (binding.source === client) return true;
          } else if (
            codexDeclaredMethod(binding.source, "get") === binding.get &&
            binding.get.length === 0 &&
            binding.get.call(binding.source) === client
          )
            return true;
        } catch {}
      }
    }
  }
  const react = state.reactAppServerClientOwners;
  if (react instanceof Map) {
    tracked = true;
    for (const current of react.get(client) || []) {
      try {
        if (current()) return true;
      } catch {}
    }
  }
  // Standalone compatibility probes supply verified clients explicitly. The
  // renderer always initializes source registries, so unowned live clients
  // never enter this compatibility path.
  return !tracked;
};
const patchAppServerModuleClients = (module, patchedCaches = new Set()) => {
  if (!codexClientDiscoveryIsCurrent()) return 0;
  patchCodexModelReasoningQueryObserverModule(module);
  let patched = 0;
  const owners =
    state.moduleAppServerClientOwners instanceof Map
      ? state.moduleAppServerClientOwners
      : new Map();
  const previous = owners.get(module) || new Map();
  const current = new Map();
  const retain = (client, key, source, get = null) => {
    if (!current.has(client)) current.set(client, []);
    current.get(client).push({ module, key, source, get });
    patched += 1;
  };
  let entries = [];
  try {
    entries = Object.entries(Object.getOwnPropertyDescriptors(module || {}));
  } catch {}
  for (const [key, field] of entries) {
    if (!("value" in field)) continue;
    const candidate = field.value;
    if (!candidate || typeof candidate !== "object") continue;
    patchCodexModelReasoningQueryClient(candidate, patchedCaches);
    if (looksLikeAppServerRequestClient(candidate)) {
      if (patchRequestClient(candidate)) retain(candidate, key, candidate);
      continue;
    }
    // Revalidate the same declared signal and its exact value at continuation
    // boundaries too, not only when the next discovery heartbeat runs.
    const get = codexDeclaredMethod(candidate, "get");
    if (get && get.length === 0) {
      try {
        const client = get.call(candidate);
        patchCodexModelReasoningQueryClient(client, patchedCaches);
        if (
          looksLikeAppServerRequestClient(client) &&
          patchRequestClient(client)
        )
          retain(client, key, candidate, get);
      } catch {}
    }
  }
  owners.set(module, current);
  state.moduleAppServerClientOwners = owners;
  const owned = new Set();
  for (const clients of owners.values())
    for (const client of clients.keys()) owned.add(client);
  state.appServerClients = Array.from(
    new Set([
      ...(Array.isArray(state.appServerClients)
        ? state.appServerClients
        : []
      ).filter(
        (client) =>
          !previous.has(client) || codexAppServerClientHasCurrentOwner(client),
      ),
      ...owned,
    ]),
  );
  return patched;
};
const codexDeclaredDependencyScope = (value) => {
  if (!value || typeof value !== "object") return false;
  try {
    // Discovery may inspect many export candidates. Probe only the scope
    // contract, not every unrelated key or descriptor on the candidate.
    const client = Object.getOwnPropertyDescriptor(value, "queryClient");
    return (
      ["get", "set", "watch"].every(
        (key) =>
          typeof Object.getOwnPropertyDescriptor(value, key)?.value ===
          "function",
      ) &&
      ["chain", "node"].every((key) => {
        const field = Object.getOwnPropertyDescriptor(value, key);
        return field && "value" in field;
      }) &&
      client &&
      ("value" in client || typeof client.get === "function")
    );
  } catch {
    return false;
  }
};
const codexScopedRegistryClass = (value) => {
  if (typeof value !== "function") return false;
  try {
    const prototype = Object.getOwnPropertyDescriptor(
      value,
      "prototype",
    )?.value;
    if (
      !["getForHostId", "getAll", "getImplForHostId"].every((name) =>
        codexDeclaredMethod(prototype, name),
      )
    )
      return false;
    // This is Codex's read-only registry view, not an arbitrary exported
    // factory. Its constructor only retains the dependency scope.
    const source = Function.prototype.toString.call(value).replace(/\s/g, "");
    if (
      !source.startsWith("class") ||
      !/constructor\(([$\w]+)\)\{this\.scope=\1;?\}/.test(source)
    )
      return false;
    const lookup = Function.prototype.toString.call(
      codexDeclaredMethod(prototype, "getForHostId"),
    );
    return lookup.includes("this.scope.get(") && !lookup.includes(".set(");
  } catch {
    return false;
  }
};
const codexScopedRegistryInstance = (value) => {
  if (!value || typeof value !== "object") return false;
  try {
    const fields = Object.getOwnPropertyDescriptors(value);
    const scope = fields.scope?.value;
    const prototype = Object.getPrototypeOf(value);
    if (
      !codexDeclaredDependencyScope(scope) ||
      !codexDeclaredMethod(prototype, "getForHostId") ||
      !codexDeclaredMethod(prototype, "getImplForHostId")
    )
      return false;
    // Current Desktop bundles keep this read-only registry instance in React
    // hook state instead of exporting its constructor from app-shared. Accept
    // the instance only when its declared lookup reads the retained scope.
    const source = Function.prototype.toString.call(
      codexDeclaredMethod(prototype, "getForHostId"),
    );
    return source.includes("this.scope.get(") && !source.includes(".set(");
  } catch {
    return false;
  }
};
const codexScopeQueryClient = (scope) => {
  if (!codexDeclaredDependencyScope(scope)) return null;
  const node = Object.getOwnPropertyDescriptor(scope, "node")?.value;
  if (node && (typeof node === "object" || typeof node === "function")) {
    // Current Desktop's declared scope accessor only returns node.queryClient.
    // Read that initialized own data slot directly: a missing/null client is
    // not permission to invoke an unrelated getter or borrow a stale owner.
    const client = Object.getOwnPropertyDescriptor(node, "queryClient");
    if (client) return "value" in client ? client.value || null : null;
  }
  // Older validated dependency scopes expose the client only through their
  // own queryClient field/accessor. Preserve that established compatibility
  // path only when the modern node slot is absent, never for module exports.
  const client = Object.getOwnPropertyDescriptor(scope, "queryClient");
  if (!client) return null;
  return "value" in client
    ? client.value || null
    : client.get.call(scope) || null;
};
const codexRendererScopeRootIdentities = () => {
  const roots = [window.__codexRoot?._internalRoot?.current];
  const root = document.getElementById("root");
  for (const key of Object.keys(root || {})) {
    if (!key.startsWith("__reactContainer")) continue;
    const fiber = Object.getOwnPropertyDescriptor(root, key)?.value;
    roots.push(fiber?.stateNode?.current || fiber);
  }
  return roots.filter(Boolean);
};
const codexRendererScopeSnapshotIsCurrent = (
  roots = codexRendererScopeRootIdentities(),
) => {
  if (state.scopedAppServerScopeScanComplete !== true) return false;
  const previous = state.scopedAppServerRootIdentities;
  if (
    !Array.isArray(previous) ||
    roots.length === 0 ||
    roots.length !== previous.length ||
    !roots.every((identity, index) => identity === previous[index])
  )
    return false;
  // DOM changes can mount new dependency providers before the retained root
  // identity changes. Re-prove ownership before native visibility/continuation.
  return !(state.pendingReactNodes?.size > 0);
};
const codexRendererScopeCandidates = async () => {
  if (!codexClientDiscoveryIsCurrent()) return [];
  // A retained scope set is only authoritative after a complete React scan.
  // We invalidate the snapshot immediately before a real traversal, while
  // preserving the fast path for a recently completed scan.
  const retained = Array.from(
    state.scopedAppServerScopeCandidates || state.scopedAppServerScopes || [],
  ).filter(codexDeclaredDependencyScope);
  const retainedRegistries = Array.from(
    state.scopedAppServerRegistryInstances || [],
  ).filter(codexScopedRegistryInstance);
  const scanStartedAt = Date.now();
  // A retained scope snapshot is usable only while the React root identities
  // that produced it are still current. React may replace the current Fiber
  // during navigation without changing the DOM container, so compare the
  // exact root objects before taking the bounded fast path. Pending DOM
  // mutations are also a conservative signal that a new provider may have
  // mounted and require a fresh walk.
  const currentRootIdentities = codexRendererScopeRootIdentities();
  if (
    retained.length &&
    state.scopedAppServerScopesScannedAt != null &&
    codexRendererScopeSnapshotIsCurrent(currentRootIdentities) &&
    scanStartedAt - state.scopedAppServerScopesScannedAt < 30000
  ) {
    state.scopedAppServerScopeScanComplete = true;
    state.scopedAppServerRegistryInstances = new Set(retainedRegistries);
    return retained;
  }
  state.scopedAppServerScopeScanComplete = false;
  const fibers = currentRootIdentities.slice();
  if (!fibers.length) {
    state.scopedAppServerRegistryInstances = new Set(retainedRegistries);
    return retained;
  }
  const seenFibers = new Set();
  const scopes = new Set();
  const registryInstances = new Set();
  let cursor = 0;
  for (; cursor < fibers.length && seenFibers.size < 25000;) {
    if (!codexClientDiscoveryIsCurrent()) return [];
    const sliceDeadline = monotonicNow() + 4;
    let inspected = 0;
    while (
      cursor < fibers.length &&
      seenFibers.size < 25000 &&
      inspected < 100 &&
      monotonicNow() < sliceDeadline
    ) {
      inspected += 1;
      const fiber = fibers[cursor++];
      if (!fiber || seenFibers.has(fiber)) continue;
      seenFibers.add(fiber);
      if (fiber.child) fibers.push(fiber.child);
      if (fiber.sibling) fibers.push(fiber.sibling);
      // Fiber depth must not consume the object depth budget: the application
      // scope lives below many providers in current Codex Desktop builds.
      const seenValues = new Set();
      const values = [
        "memoizedState",
        "dependencies",
        "memoizedProps",
        "pendingProps",
      ].map((key) => ({ value: fiber[key], depth: 0 }));
      for (let index = 0; index < values.length && index < 160; index += 1) {
        const { value, depth } = values[index];
        if (
          !value ||
          typeof value !== "object" ||
          seenValues.has(value) ||
          value === window ||
          (typeof Node !== "undefined" && value instanceof Node)
        )
          continue;
        seenValues.add(value);
        if (codexScopedRegistryInstance(value)) {
          registryInstances.add(value);
          const registryScope = Object.getOwnPropertyDescriptor(
            value,
            "scope",
          )?.value;
          if (codexDeclaredDependencyScope(registryScope))
            scopes.add(registryScope);
        }
        if (codexDeclaredDependencyScope(value)) {
          scopes.add(value);
          continue;
        }
        if (depth >= 5) continue;
        let descriptors = {};
        try {
          descriptors = Object.getOwnPropertyDescriptors(value);
        } catch {}
        for (const [key, descriptor] of Object.entries(descriptors)) {
          if (
            "value" in descriptor &&
            ![
              "return",
              "child",
              "sibling",
              "alternate",
              "ownerDocument",
              "parentNode",
              "parentElement",
              "window",
            ].includes(key)
          ) {
            values.push({ value: descriptor.value, depth: depth + 1 });
          }
        }
      }
    }
    if (cursor < fibers.length && seenFibers.size < 25000)
      await yieldReactDiscovery();
  }
  if (!codexClientDiscoveryIsCurrent()) return [];
  // The shell and the Codex composer can own different caches. Retaining the
  // first scope forever misses the picker, including scopes mounted later. A
  // complete scan with no scopes is authoritative; an incomplete/capped scan
  // must keep previously discovered owners until the next complete scan.
  const scanWasCapped = seenFibers.size >= 25000 && cursor < fibers.length;
  const current = scanWasCapped
    ? Array.from(new Set([...retained, ...scopes]))
    : Array.from(scopes);
  const currentRegistries = scanWasCapped
    ? Array.from(new Set([...retainedRegistries, ...registryInstances]))
    : Array.from(registryInstances);
  state.scopedAppServerScopeCandidates = new Set(current);
  state.scopedAppServerRegistryInstances = new Set(currentRegistries);
  state.scopedAppServerScopesScannedAt = scanStartedAt;
  state.scopedAppServerScopeScanComplete = !scanWasCapped;
  state.scopedAppServerRootIdentities = currentRootIdentities;
  return current;
};
const refreshCodexScopedAppServerClients = (
  scopes = state.scopedAppServerScopeCandidates ||
    state.scopedAppServerScopes ||
    [],
  registries = state.scopedAppServerRegistryClasses || [],
  patchedCaches = new Set(),
) => {
  if (!codexClientDiscoveryIsCurrent()) return 0;
  let patched = 0;
  let queryClientCount = 0;
  // Scope getters can diverge after navigation even when they currently share
  // a cache. Retain their identities, but project one cache owner and each
  // independent request manager so aliases never multiply cache work.
  const clientCaches = new Map();
  const seenCaches = new Set();
  const seenManagers = new Set();
  const seenRequestClients = new Set();
  const verifiedRequestClients = new Set();
  const verifiedOwners = new Map();
  const retainOwner = (client, scope, registry, lookup) => {
    if (!verifiedOwners.has(client)) verifiedOwners.set(client, []);
    const scopeGet = Object.getOwnPropertyDescriptor(scope, "get")?.value;
    verifiedOwners.get(client).push(() => {
      if (
        !Set.prototype.has.call(state.scopedAppServerScopeCandidates, scope) ||
        Object.getOwnPropertyDescriptor(scope, "get")?.value !== scopeGet ||
        Object.getOwnPropertyDescriptor(registry, "scope")?.value !== scope ||
        codexDeclaredMethod(registry, "getForHostId") !== lookup
      )
        return false;
      const current = lookup.call(registry, "local");
      return (
        Object.getOwnPropertyDescriptor(current || {}, "requestClient")
          ?.value === client
      );
    });
  };
  const retainedScopes = new Set();
  for (const scope of scopes) {
    let client = null;
    try {
      client = codexScopeQueryClient(scope);
    } catch (error) {
      recordFailure(error);
    }
    if (client) {
      if (!clientCaches.has(client))
        clientCaches.set(
          client,
          codexModelReasoningQueryCacheForClient(client),
        );
      const cache = clientCaches.get(client);
      if (cache && !seenCaches.has(cache)) {
        seenCaches.add(cache);
        try {
          state.modelPickerQueryClients =
            state.modelPickerQueryClients || new Map();
          state.modelPickerQueryClients.set(cache, client);
          if (patchCodexModelReasoningQueryCacheOnce(cache, patchedCaches)) {
            queryClientCount += 1;
            retainedScopes.add(scope);
          }
        } catch (error) {
          recordFailure(error);
        }
      }
    }
    for (const Registry of registries) {
      try {
        const registry = new Registry(scope);
        const lookup = codexDeclaredMethod(registry, "getForHostId");
        const manager = lookup.call(registry, "local");
        if (seenManagers.has(manager)) continue;
        const requestClient = Object.getOwnPropertyDescriptor(
          manager || {},
          "requestClient",
        )?.value;
        const host = Object.getOwnPropertyDescriptor(
          requestClient || {},
          "hostId",
        )?.value;
        if (host !== "local" || !looksLikeAppServerRequestClient(requestClient))
          continue;
        seenManagers.add(manager);
        retainedScopes.add(scope);
        if (seenRequestClients.has(requestClient)) continue;
        seenRequestClients.add(requestClient);
        if (patchRequestClient(requestClient)) {
          verifiedRequestClients.add(requestClient);
          retainOwner(requestClient, scope, registry, lookup);
          patched += 1;
        }
      } catch (error) {
        recordFailure(error);
      }
    }
    for (const registry of state.scopedAppServerRegistryInstances || []) {
      if (Object.getOwnPropertyDescriptor(registry, "scope")?.value !== scope)
        continue;
      try {
        const lookup = codexDeclaredMethod(registry, "getForHostId");
        const manager = lookup.call(registry, "local");
        const requestClient = Object.getOwnPropertyDescriptor(
          manager || {},
          "requestClient",
        )?.value;
        const host = Object.getOwnPropertyDescriptor(
          requestClient || {},
          "hostId",
        )?.value;
        if (host !== "local" || !looksLikeAppServerRequestClient(requestClient))
          continue;
        retainedScopes.add(scope);
        if (seenRequestClients.has(requestClient)) continue;
        seenRequestClients.add(requestClient);
        if (patchRequestClient(requestClient)) {
          verifiedRequestClients.add(requestClient);
          retainOwner(requestClient, scope, registry, lookup);
          patched += 1;
        }
      } catch (error) {
        recordFailure(error);
      }
    }
  }
  // Scope discovery is the ownership boundary for continuation clients.
  // Once a complete React snapshot is available, replace the previous scoped
  // projection instead of appending forever; preserve only clients discovered
  // by legacy module-level fallback paths. During an incomplete scan, retain
  // the previous projection fail-closed until a complete snapshot is published.
  const previousScopedClients =
    state.scopedAppServerClientSet instanceof Set
      ? state.scopedAppServerClientSet
      : new Set();
  if (state.scopedAppServerScopeScanComplete === true) {
    const unscopedClients = (
      Array.isArray(state.appServerClients) ? state.appServerClients : []
    ).filter(
      (client) =>
        !previousScopedClients.has(client) ||
        Array.from(state.moduleAppServerClientOwners?.values() || []).some(
          (clients) => clients.has(client),
        ),
    );
    state.appServerClients = Array.from(
      new Set([...unscopedClients, ...verifiedRequestClients]),
    );
    state.scopedAppServerClientSet = new Set(verifiedRequestClients);
    state.scopedAppServerClientOwners = verifiedOwners;
  } else if (verifiedRequestClients.size) {
    state.appServerClients = Array.from(
      new Set([
        ...(Array.isArray(state.appServerClients)
          ? state.appServerClients
          : []),
        ...verifiedRequestClients,
      ]),
    );
    state.scopedAppServerClientSet = new Set([
      ...previousScopedClients,
      ...verifiedRequestClients,
    ]);
    const owners =
      state.scopedAppServerClientOwners instanceof Map
        ? new Map(state.scopedAppServerClientOwners)
        : new Map();
    for (const [client, checks] of verifiedOwners) owners.set(client, checks);
    state.scopedAppServerClientOwners = owners;
  }
  state.scopedAppServerScopes = retainedScopes;
  state.scopedAppServerDiscovery = {
    scopeCount: retainedScopes.size,
    registryCount: registries.length,
    clientCount: patched,
    queryClientCount,
  };
  return patched;
};
const patchCodexScopedAppServerClients = async (
  module,
  patchedCaches = new Set(),
) => {
  if (!codexClientDiscoveryIsCurrent()) return 0;
  patchCodexModelReasoningQueryObserverModule(module);
  const registries = codexDeclaredModuleValues(module).filter(
    codexScopedRegistryClass,
  );
  const scopes = await codexRendererScopeCandidates();
  if (!codexClientDiscoveryIsCurrent()) return 0;
  state.scopedAppServerScopeCandidates = new Set(scopes);
  state.scopedAppServerRegistryClasses = registries;
  return refreshCodexScopedAppServerClients(scopes, registries, patchedCaches);
};
