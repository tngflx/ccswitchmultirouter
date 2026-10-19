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
    const methods = Object.getOwnPropertyDescriptors(prototype);
    return [
      "createResult",
      "getCurrentResult",
      "getOptimisticResult",
      "getCurrentQuery",
      "setOptions",
    ].every((name) => typeof methods[name]?.value === "function")
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
const patchAppServerModuleClients = (module, patchedCaches = new Set()) => {
  if (!codexClientDiscoveryIsCurrent()) return 0;
  patchCodexModelReasoningQueryObserverModule(module);
  let patched = 0;
  for (const candidate of codexDeclaredModuleValues(module).filter(
    (item) => item && typeof item === "object",
  )) {
    patchCodexModelReasoningQueryClient(candidate, patchedCaches);
    if (looksLikeAppServerRequestClient(candidate)) {
      if (patchRequestClient(candidate)) patched += 1;
      continue;
    }
    // The legacy signal has a declared, zero-argument get method. Maps and RPC
    // proxies are excluded; the signal can replace its client on any heartbeat.
    const get = codexDeclaredMethod(candidate, "get");
    if (get && get.length === 0) {
      try {
        const client = get.call(candidate);
        patchCodexModelReasoningQueryClient(client, patchedCaches);
        if (
          looksLikeAppServerRequestClient(client) &&
          patchRequestClient(client)
        )
          patched += 1;
      } catch {}
    }
  }
  return patched;
};
const codexDeclaredDependencyScope = (value) => {
  if (!value || typeof value !== "object") return false;
  try {
    const fields = Object.getOwnPropertyDescriptors(value);
    return (
      ["get", "set", "watch"].every(
        (key) => typeof fields[key]?.value === "function",
      ) &&
      ["chain", "node"].every((key) => fields[key] && "value" in fields[key]) &&
      fields.queryClient &&
      ("value" in fields.queryClient ||
        typeof fields.queryClient.get === "function")
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
      !["getForHostId", "getAll", "getDefault", "getImplForHostId"].every(
        (name) => codexDeclaredMethod(prototype, name),
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
const codexScopeQueryClient = (scope) => scope?.queryClient || null;
const codexRendererScopeCandidates = async () => {
  if (!codexClientDiscoveryIsCurrent()) return [];
  const retained = Array.from(
    state.scopedAppServerScopeCandidates || state.scopedAppServerScopes || [],
  ).filter(codexDeclaredDependencyScope);
  const scanStartedAt = Date.now();
  if (
    retained.length &&
    state.scopedAppServerScopesScannedAt != null &&
    scanStartedAt - state.scopedAppServerScopesScannedAt < 30000
  )
    return retained;
  const roots = [window.__codexRoot?._internalRoot?.current];
  const root = document.getElementById("root");
  for (const key of Object.keys(root || {})) {
    if (!key.startsWith("__reactContainer")) continue;
    const fiber = Object.getOwnPropertyDescriptor(root, key)?.value;
    roots.push(fiber?.stateNode?.current || fiber);
  }
  const fibers = roots.filter(Boolean);
  if (!fibers.length) return retained;
  const seenFibers = new Set();
  const scopes = new Set();
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
  state.scopedAppServerScopeCandidates = new Set(current);
  state.scopedAppServerScopesScannedAt = scanStartedAt;
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
        if (patchRequestClient(requestClient)) patched += 1;
      } catch (error) {
        recordFailure(error);
      }
    }
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
