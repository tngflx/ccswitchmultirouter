// RpcStub/RpcPromise proxies manufacture a function for every property name.
// Discover capabilities from declared descriptors so a stub cannot impersonate
// the app-server client or cause arbitrary RPC calls during object discovery.
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
const patchCodexModelReasoningQueryClient = (value) => {
  const getQueryCache = codexDeclaredMethod(value, "getQueryCache");
  if (
    !getQueryCache ||
    !codexDeclaredMethod(value, "getQueryData") ||
    !codexDeclaredMethod(value, "setQueryData")
  )
    return false;
  try {
    const cache = getQueryCache.call(value);
    state.modelPickerQueryClients = state.modelPickerQueryClients || new Map();
    state.modelPickerQueryClients.set(cache, value);
    return patchCodexModelReasoningQueryCache(cache);
  } catch (error) {
    recordFailure(error);
    return false;
  }
};
const patchAppServerModuleClients = (module) => {
  let patched = 0;
  for (const candidate of Object.values(module || {}).filter(
    (item) => item && typeof item === "object",
  )) {
    patchCodexModelReasoningQueryClient(candidate);
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
        patchCodexModelReasoningQueryClient(client);
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
const codexRendererScopeCandidates = async () => {
  const retained = Array.from(state.scopedAppServerScopes || []).filter(
    codexDeclaredDependencyScope,
  );
  if (retained.length) return retained;
  const roots = [window.__codexRoot?._internalRoot?.current];
  const root = document.getElementById("root");
  for (const key of Object.keys(root || {})) {
    if (!key.startsWith("__reactContainer")) continue;
    const fiber = Object.getOwnPropertyDescriptor(root, key)?.value;
    roots.push(fiber?.stateNode?.current || fiber);
  }
  const fibers = roots.filter(Boolean);
  const seenFibers = new Set();
  for (let cursor = 0; cursor < fibers.length && seenFibers.size < 25000;) {
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
          state.scopedAppServerScopes = new Set([value]);
          return [value];
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
  return [];
};
const patchCodexScopedAppServerClients = async (module) => {
  const registries = Object.values(module || {}).filter(
    codexScopedRegistryClass,
  );
  if (!registries.length) return 0;
  const scopes = await codexRendererScopeCandidates();
  let patched = 0;
  for (const scope of scopes) {
    for (const Registry of registries) {
      try {
        const registry = new Registry(scope);
        const lookup = codexDeclaredMethod(registry, "getForHostId");
        const manager = lookup.call(registry, "local");
        const client = Object.getOwnPropertyDescriptor(
          manager || {},
          "requestClient",
        )?.value;
        const host = Object.getOwnPropertyDescriptor(
          client || {},
          "hostId",
        )?.value;
        if (host !== "local" || !looksLikeAppServerRequestClient(client))
          continue;
        if (patchRequestClient(client)) patched += 1;
      } catch (error) {
        recordFailure(error);
      }
    }
  }
  state.scopedAppServerDiscovery = {
    scopeCount: scopes.length,
    registryCount: registries.length,
    clientCount: patched,
  };
  if (patched === 0) state.scopedAppServerScopes = new Set();
  return patched;
};
