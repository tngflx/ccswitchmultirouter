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
  // Family bindings add a direct current node/map/entry boundary. Their owner
  // callback also proves the exact scope is reachable from current roots, so
  // a capped full discovery walk cannot retain an unmounted owner.
  const rpcOwners = state.scopedAppServerRpcClientOwners;
  if (rpcOwners instanceof Map) {
    tracked = true;
    for (const current of rpcOwners.get(client) || []) {
      try {
        if (current()) return true;
      } catch {}
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
// Codex 26.1106 keeps the live app-server client in a retained family binding
// instead of exporting the older AppServerRegistry/requestClient shape. The
// binding value is still a declared ownership boundary: entry.value.current
// is the current host status and its client owns a RpcPromise-backed `rpc`.
const codexRpcPromise = (value) => {
  if (typeof value !== "function") return false;
  try {
    if (
      !["dup", "onRpcBroken", "map"].every((name) =>
        codexDeclaredMethod(value, name),
      )
    )
      return false;
    // RpcPromise proxies report a custom string tag through their declared
    // prototype toString; Object.prototype.toString still sees the function
    // target in current Desktop builds.
    const toString = codexDeclaredMethod(value, "toString");
    const tag =
      typeof toString === "function" ? String(toString.call(value)) : "";
    return tag === "[object RpcPromise]" || tag === "[object RpcStub]";
  } catch {
    return false;
  }
};
const codexScopedRpcClient = (value) => {
  if (!value || typeof value !== "object") return null;
  try {
    const host = Object.getOwnPropertyDescriptor(value, "hostId");
    const rpc = Object.getOwnPropertyDescriptor(value, "rpc");
    if (host?.value !== "local" || !rpc || !("value" in rpc)) return null;
    if (!codexRpcPromise(rpc.value)) return null;
    // Reading these proxy properties creates RpcPromise method stubs but does
    // not send a request. It proves the exact app-server capability before any
    // wrapper is installed.
    for (const name of [
      "sendRequest",
      "getCompatibleThreadSortKey",
      "supportsPaginatedThreadHistory",
    ])
      if (typeof rpc.value[name] !== "function") return null;
    return rpc.value;
  } catch {
    return null;
  }
};
const codexScopedRpcClientBindings = (scope) => {
  if (!codexDeclaredDependencyScope(scope)) return [];
  const node = Object.getOwnPropertyDescriptor(scope, "node")?.value;
  const familyBindings = Object.getOwnPropertyDescriptor(
    node || {},
    "familyBindings",
  )?.value;
  if (!(familyBindings instanceof Map)) return [];
  const result = [];
  const seen = new Set();
  try {
    for (const [familyKey, family] of familyBindings) {
      if (!(family instanceof Map)) continue;
      for (const [entryKey, entry] of family) {
        const value = Object.getOwnPropertyDescriptor(
          entry || {},
          "value",
        )?.value;
        const current = Object.getOwnPropertyDescriptor(
          value || {},
          "current",
        )?.value;
        const client = Object.getOwnPropertyDescriptor(
          current || {},
          "client",
        )?.value;
        const rpc = codexScopedRpcClient(client);
        if (!rpc || seen.has(client)) continue;
        seen.add(client);
        result.push({
          scope,
          node,
          familyBindings,
          familyKey,
          client,
          rpc,
          family,
          entryKey,
          entry,
        });
      }
    }
  } catch {}
  return result;
};
const codexScopedRpcCurrentClient = (binding) => {
  try {
    if (binding.atom) {
      if (
        Object.getOwnPropertyDescriptor(binding.scope || {}, "node")?.value !==
          binding.node ||
        Object.getOwnPropertyDescriptor(binding.scope, "scope")?.value !==
          Object.getOwnPropertyDescriptor(binding.atom, "scope")?.value ||
        !(state.appServerStatusAtoms || []).includes(binding.atom)
      )
        return null;
      const get = Object.getOwnPropertyDescriptor(binding.scope, "get")?.value;
      if (typeof get !== "function") return null;
      const status = get.call(binding.scope, binding.atom, "local");
      const code = Object.getOwnPropertyDescriptor(
        status || {},
        "status",
      )?.value;
      if (code !== "ready") return null;
      const client = Object.getOwnPropertyDescriptor(
        status || {},
        "client",
      )?.value;
      return client === binding.client && codexScopedRpcClient(client)
        ? client
        : null;
    }
    if (
      Object.getOwnPropertyDescriptor(binding.scope || {}, "node")?.value !==
        binding.node ||
      Object.getOwnPropertyDescriptor(binding.node || {}, "familyBindings")
        ?.value !== binding.familyBindings ||
      Map.prototype.get.call(binding.familyBindings, binding.familyKey) !==
        binding.family ||
      Map.prototype.get.call(binding.family, binding.entryKey) !== binding.entry
    )
      return null;
    const current = Object.getOwnPropertyDescriptor(
      Object.getOwnPropertyDescriptor(binding.entry || {}, "value")?.value ||
        {},
      "current",
    )?.value;
    const client = Object.getOwnPropertyDescriptor(
      current || {},
      "client",
    )?.value;
    return client === binding.client && codexScopedRpcClient(client)
      ? client
      : null;
  } catch {
    return null;
  }
};
// Request clients and host providers are plain declared owners. Preflight both
// data slots before mutating either one; RpcStub proxies themselves are never
// queried for extensibility or assigned compatibility properties.
const codexRpcMutationSlot = (owner, key, markerKey) => {
  try {
    const field = Object.getOwnPropertyDescriptor(owner, key);
    const marker = Object.getOwnPropertyDescriptor(owner, markerKey);
    if (
      !field ||
      !("value" in field) ||
      field.writable !== true ||
      (marker ? marker.configurable !== true : !Object.isExtensible(owner))
    )
      return null;
    return { field, marker };
  } catch (error) {
    recordFailure(error);
    return null;
  }
};
const restoreCodexRpcMutation = (mutation) => {
  if (!mutation) return;
  const { owner, key, markerKey, slot, value, marker } = mutation;
  try {
    if (Object.getOwnPropertyDescriptor(owner, key)?.value === value)
      Object.defineProperty(owner, key, slot.field);
    if (Object.getOwnPropertyDescriptor(owner, markerKey)?.value === marker) {
      if (slot.marker) Object.defineProperty(owner, markerKey, slot.marker);
      else delete owner[markerKey];
    }
  } catch (error) {
    recordFailure(error);
  }
};
const installCodexRpcMutation = (mutation) => {
  const { owner, key, markerKey, slot, value, marker } = mutation;
  try {
    Object.defineProperty(owner, markerKey, {
      configurable: true,
      enumerable: false,
      writable: true,
      value: marker,
    });
    Object.defineProperty(owner, key, { ...slot.field, value });
    if (
      Object.getOwnPropertyDescriptor(owner, key)?.value !== value ||
      Object.getOwnPropertyDescriptor(owner, markerKey)?.value !== marker
    )
      throw new Error("Codex RPC owner did not accept its guarded hook");
    return true;
  } catch (error) {
    restoreCodexRpcMutation(mutation);
    recordFailure(error);
    return false;
  }
};
const codexScopedRpcFacade = (binding) => {
  const sourceClient = binding.client;
  const originalRpc = binding.rpc;
  let marker;
  try {
    marker = Object.getOwnPropertyDescriptor(
      sourceClient,
      "__ccSwitchRpcBinding",
    )?.value;
  } catch {}
  if (
    marker?.source === sourceClient &&
    marker.wrappedRpc === sourceClient.rpc &&
    marker.facade &&
    marker.originalRpc
  )
    return {
      facade: marker.facade,
      wrappedRpc: marker.wrappedRpc,
      originalRpc: marker.originalRpc,
      mutation: null,
    };
  const slot = codexRpcMutationSlot(
    sourceClient,
    "rpc",
    "__ccSwitchRpcBinding",
  );
  if (!slot) return null;
  const previousOriginal =
    marker?.source === sourceClient &&
    marker.wrappedRpc === sourceClient.rpc &&
    typeof marker.originalRpc === "function"
      ? marker.originalRpc
      : null;
  const baseRpc = previousOriginal || originalRpc;
  const facade = {
    hostId: "local",
    sendRequest: (...args) => baseRpc.sendRequest(...args),
    getCompatibleThreadSortKey: (...args) =>
      baseRpc.getCompatibleThreadSortKey(...args),
    supportsPaginatedThreadHistory: (...args) =>
      baseRpc.supportsPaginatedThreadHistory(...args),
  };
  Object.defineProperty(facade, "__ccSwitchRpcRequestClient", {
    configurable: true,
    enumerable: false,
    value: true,
  });
  const wrappedRpc = new Proxy(baseRpc, {
    get(target, key) {
      if (key === "sendRequest")
        return (...args) => facade.sendRequest(...args);
      const activityMethods = {
        startTurn: "turn/start",
        startTurnWithOutcome: "turn/start",
        startEmptyTurn: "turn/start",
        steerTurn: "turn/start",
        retrySafetyBufferedTurn: "turn/start",
        sendFollowUpMessage: "turn/start",
        editLastUserTurn: "thread/revert",
        stopThread: "turn/interrupt",
        interruptConversation: "turn/interrupt",
        interruptConversationWithOutcome: "turn/interrupt",
        archiveConversation: "thread/archive",
      };
      if (
        typeof key === "string" &&
        Object.prototype.hasOwnProperty.call(activityMethods, key)
      )
        return (...args) => {
          const first = args[0];
          const threadId =
            typeof first === "string"
              ? first
              : first && typeof first === "object"
                ? first.threadId || first.thread_id || first.id
                : undefined;
          if (typeof rememberCodexUserTurnAction === "function")
            rememberCodexUserTurnAction(activityMethods[key], { threadId });
          return Reflect.get(target, key, target)(...args);
        };
      return Reflect.get(target, key, target);
    },
  });
  const mutation = {
    owner: sourceClient,
    key: "rpc",
    markerKey: "__ccSwitchRpcBinding",
    slot,
    value: wrappedRpc,
    marker: { source: sourceClient, originalRpc: baseRpc, wrappedRpc, facade },
  };
  if (!installCodexRpcMutation(mutation)) return null;
  return { facade, wrappedRpc, originalRpc: baseRpc, mutation };
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
const codexRendererScopeRootsMatchCurrent = (
  roots = codexRendererScopeRootIdentities(),
) => {
  const previous = state.scopedAppServerRootIdentities;
  return (
    Array.isArray(previous) &&
    roots.length > 0 &&
    roots.length === previous.length &&
    roots.every((identity, index) => identity === previous[index]) &&
    !(state.pendingReactNodes?.size > 0)
  );
};
const codexRendererScopeIsMounted = (scope) => {
  if (!codexDeclaredDependencyScope(scope)) return false;
  const node = Object.getOwnPropertyDescriptor(scope, "node")?.value;
  if (!node) return false;
  return codexRendererNodeIsMounted(node);
};
const codexMountedRetainedScopeCandidates = (candidates) => {
  const nodes = new Map();
  for (const scope of candidates || []) {
    if (!codexDeclaredDependencyScope(scope)) continue;
    const node = Object.getOwnPropertyDescriptor(scope, "node")?.value;
    if (!node || nodes.has(node)) continue;
    nodes.set(node, scope);
  }
  const mounted = codexRendererMountedNodes(new Set(nodes.keys()));
  return Array.from(mounted, (node) => nodes.get(node));
};
const codexCurrentAppServerScopeHints = () => {
  const scopesByBrand = new Map();
  for (const atom of state.appServerStatusAtoms || []) {
    const brand = Object.getOwnPropertyDescriptor(atom || {}, "scope")?.value;
    if (brand) scopesByBrand.set(brand, null);
  }
  if (!scopesByBrand.size) return [];
  const fibers = codexRendererScopeRootIdentities();
  const seen = new Set();
  for (
    let cursor = 0;
    cursor < fibers.length && seen.size < 25000;
    cursor += 1
  ) {
    const fiber = fibers[cursor];
    if (!fiber || seen.has(fiber)) continue;
    seen.add(fiber);
    for (const key of ["child", "sibling"]) {
      const next = Object.getOwnPropertyDescriptor(fiber, key)?.value;
      if (next) fibers.push(next);
    }
    const visited = new Set();
    const values = [
      "memoizedState",
      "dependencies",
      "memoizedProps",
      "pendingProps",
    ].map((key) => ({
      value: Object.getOwnPropertyDescriptor(fiber, key)?.value,
      depth: 0,
    }));
    for (let index = 0; index < values.length && index < 160; index += 1) {
      const { value, depth } = values[index];
      if (
        !value ||
        typeof value !== "object" ||
        visited.has(value) ||
        value === window ||
        (typeof Node !== "undefined" && value instanceof Node)
      )
        continue;
      visited.add(value);
      if (codexDeclaredDependencyScope(value)) {
        const brand = Object.getOwnPropertyDescriptor(value, "scope")?.value;
        if (scopesByBrand.has(brand) && !scopesByBrand.get(brand))
          scopesByBrand.set(brand, value);
        if (Array.from(scopesByBrand.values()).every(Boolean))
          return Array.from(scopesByBrand.values());
        continue;
      }
      if (depth >= 5) continue;
      let descriptors = {};
      try {
        descriptors = Object.getOwnPropertyDescriptors(value);
      } catch {}
      for (const [key, field] of Object.entries(descriptors))
        if (
          "value" in field &&
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
        )
          values.push({ value: field.value, depth: depth + 1 });
    }
  }
  return Array.from(scopesByBrand.values()).filter(Boolean);
};
const codexRendererNodeIsMounted = (node) => {
  if (!node || typeof node !== "object") return false;
  return codexRendererMountedNodes(new Set([node])).has(node);
};
const codexRendererMountedNodes = (targets) => {
  const mounted = new Set();
  if (!targets.size) return mounted;
  const fibers = codexRendererScopeRootIdentities();
  const seenFibers = new Set();
  for (
    let cursor = 0;
    cursor < fibers.length && seenFibers.size < 25000;
    cursor += 1
  ) {
    const fiber = fibers[cursor];
    if (!fiber || seenFibers.has(fiber)) continue;
    seenFibers.add(fiber);
    for (const key of ["child", "sibling"]) {
      const next = Object.getOwnPropertyDescriptor(fiber, key)?.value;
      if (next) fibers.push(next);
    }
    const seenValues = new Set();
    const values = [
      "memoizedState",
      "dependencies",
      "memoizedProps",
      "pendingProps",
    ].map((key) => ({
      value: Object.getOwnPropertyDescriptor(fiber, key)?.value,
      depth: 0,
    }));
    for (let index = 0; index < values.length && index < 160; index += 1) {
      const { value, depth } = values[index];
      if (targets.has(value)) {
        mounted.add(value);
        if (mounted.size === targets.size) return mounted;
      }
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
        const node = Object.getOwnPropertyDescriptor(value, "node")?.value;
        if (targets.has(node)) {
          mounted.add(node);
          if (mounted.size === targets.size) return mounted;
        }
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
        )
          values.push({ value: descriptor.value, depth: depth + 1 });
      }
    }
  }
  return mounted;
};
const codexRendererScopeSnapshotIsCurrent = (
  roots = codexRendererScopeRootIdentities(),
) => {
  if (state.scopedAppServerScopeScanComplete !== true) return false;
  if (!codexRendererScopeRootsMatchCurrent(roots)) return false;
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
  const verifiedRpcOwners = new Map();
  const scannedRpcNodes = new Set();
  const canonicalBrands = new Set(
    (state.appServerStatusAtoms || [])
      .map(
        (atom) => Object.getOwnPropertyDescriptor(atom || {}, "scope")?.value,
      )
      .filter(Boolean),
  );
  const canonicalScopes = Array.from(scopes).filter((scope) =>
    canonicalBrands.has(
      Object.getOwnPropertyDescriptor(scope || {}, "scope")?.value,
    ),
  );
  const mountedRpcNodes = new Set(
    codexMountedRetainedScopeCandidates(canonicalScopes).map(
      (scope) => Object.getOwnPropertyDescriptor(scope, "node")?.value,
    ),
  );
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
    // Current Desktop builds expose the request path through a family binding
    // client `{hostId, rpc}`. Install a declared facade and route the exact
    // live RpcPromise through the existing normalization/activity hook.
    const rpcNode = Object.getOwnPropertyDescriptor(scope, "node")?.value;
    const rpcBindings = [];
    if (!scannedRpcNodes.has(rpcNode) && mountedRpcNodes.has(rpcNode)) {
      // Older discovery mistook the account service for the manager. Restore
      // only our exact owned wrapper; account RPC never authorizes a turn.
      for (const activityBinding of codexScopedRpcClientBindings(scope)) {
        const account = activityBinding.client;
        const isCanonical = (state.appServerStatusAtoms || []).some((atom) => {
          try {
            const status = Object.getOwnPropertyDescriptor(
              scope,
              "get",
            ).value.call(scope, atom, "local");
            return (
              Object.getOwnPropertyDescriptor(status || {}, "client")?.value ===
              account
            );
          } catch {
            return false;
          }
        });
        if (isCanonical) continue;
        const marker = Object.getOwnPropertyDescriptor(
          account,
          "__ccSwitchRpcBinding",
        )?.value;
        if (
          marker?.source === account &&
          marker.wrappedRpc === account.rpc &&
          typeof marker.originalRpc === "function"
        ) {
          account.rpc = marker.originalRpc;
          delete account.__ccSwitchRpcBinding;
        }
      }
      for (const atom of state.appServerStatusAtoms || []) {
        try {
          const atomScope = Object.getOwnPropertyDescriptor(
            atom || {},
            "scope",
          )?.value;
          if (
            !atomScope ||
            Object.getOwnPropertyDescriptor(scope, "scope")?.value !== atomScope
          )
            continue;
          const status = Object.getOwnPropertyDescriptor(
            scope,
            "get",
          ).value.call(scope, atom, "local");
          const statusCode = Object.getOwnPropertyDescriptor(
            status || {},
            "status",
          )?.value;
          const sourceClient = Object.getOwnPropertyDescriptor(
            status || {},
            "client",
          )?.value;
          const rpc = codexScopedRpcClient(sourceClient);
          if (rpc && statusCode === "ready")
            rpcBindings.push({
              scope,
              node: rpcNode,
              atom,
              client: sourceClient,
              rpc,
            });
        } catch (error) {
          recordFailure(error);
        }
      }
    }
    scannedRpcNodes.add(rpcNode);
    for (const binding of rpcBindings) {
      try {
        if (codexScopedRpcCurrentClient(binding) !== binding.client) continue;
        const providerBinding = (state.appServerStatusBindings || []).find(
          (item) => item.atom === binding.atom,
        );
        // The host-provider hook observes the same manager capability used by
        // the composer. A generic RPC facade alone cannot authorize recovery.
        if (!providerBinding) continue;
        const get = Object.getOwnPropertyDescriptor(scope, "get")?.value;
        const provider = get.call(scope, providerBinding.managerToken);
        const forHost = codexDeclaredMethod(provider, "forHost");
        const providerSlot = codexRpcMutationSlot(
          provider,
          "forHost",
          "__ccSwitchForHostBinding",
        );
        if (!forHost || !providerSlot || providerSlot.field.value !== forHost)
          continue;
        const previous = providerSlot.marker?.value;
        const original =
          previous?.provider === provider && previous.wrapper === forHost
            ? previous.original
            : forHost;
        const clientMarker = Object.getOwnPropertyDescriptor(
          binding.client,
          "__ccSwitchRpcBinding",
        )?.value;
        const originalRpc =
          clientMarker?.source === binding.client &&
          clientMarker.wrappedRpc === binding.rpc
            ? clientMarker.originalRpc
            : binding.rpc;
        if (original.call(provider, "local") !== originalRpc) continue;
        const patchedRpc = codexScopedRpcFacade(binding);
        if (!patchedRpc) continue;
        const wrapper = function ccSwitchForHost(host, ...args) {
          const result = original.call(this, host, ...args);
          if (host === "local" && result === patchedRpc.originalRpc)
            return patchedRpc.wrappedRpc;
          return result;
        };
        const providerMutation = {
          owner: provider,
          key: "forHost",
          markerKey: "__ccSwitchForHostBinding",
          slot: providerSlot,
          value: wrapper,
          marker: { provider, original, wrapper },
        };
        if (!installCodexRpcMutation(providerMutation)) {
          restoreCodexRpcMutation(patchedRpc.mutation);
          continue;
        }
        binding.provider = provider;
        binding.providerToken = providerBinding.managerToken;
        binding.providerOriginal = original;
        binding.providerWrapper = wrapper;
        const requestClient = patchedRpc.facade;
        retainedScopes.add(scope);
        if (seenRequestClients.has(requestClient)) continue;
        seenRequestClients.add(requestClient);
        if (!patchRequestClient(requestClient)) {
          restoreCodexRpcMutation(providerMutation);
          restoreCodexRpcMutation(patchedRpc.mutation);
          continue;
        }
        verifiedRequestClients.add(requestClient);
        if (!verifiedOwners.has(requestClient))
          verifiedOwners.set(requestClient, []);
        if (!verifiedRpcOwners.has(requestClient))
          verifiedRpcOwners.set(requestClient, []);
        const scopeGet = Object.getOwnPropertyDescriptor(scope, "get")?.value;
        const isCurrentRpcOwner = () => {
          if (
            !codexRendererScopeIsMounted(scope) ||
            !Set.prototype.has.call(
              state.scopedAppServerScopeCandidates,
              scope,
            ) ||
            Object.getOwnPropertyDescriptor(scope, "get")?.value !== scopeGet
          )
            return false;
          const current = codexScopedRpcCurrentClient(binding);
          if (binding.provider) {
            const provider = Object.getOwnPropertyDescriptor(
              scope,
              "get",
            ).value.call(scope, binding.providerToken);
            if (
              provider !== binding.provider ||
              codexDeclaredMethod(provider, "forHost") !==
                binding.providerWrapper ||
              binding.providerOriginal.call(provider, "local") !==
                patchedRpc.originalRpc
            )
              return false;
          }
          const marker = Object.getOwnPropertyDescriptor(
            binding.client,
            "__ccSwitchRpcBinding",
          )?.value;
          return (
            current === binding.client &&
            marker?.source === binding.client &&
            marker.wrappedRpc === binding.client.rpc &&
            marker.wrappedRpc === patchedRpc.wrappedRpc &&
            marker.facade === requestClient
          );
        };
        verifiedOwners.get(requestClient).push(isCurrentRpcOwner);
        verifiedRpcOwners.get(requestClient).push(isCurrentRpcOwner);
        patched += 1;
      } catch (error) {
        recordFailure(error);
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
  state.scopedAppServerRpcClientOwners = verifiedRpcOwners;
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
