import { readFileSync } from "node:fs";
import path from "node:path";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const discoveryCore = readFileSync(
  path.resolve(
    process.cwd(),
    "src-tauri/src/resources/codex_desktop/client_discovery.js",
  ),
  "utf8",
);

type Scope = {
  chain: Record<string, unknown>;
  node: Record<string, unknown>;
  get: (hostId: string) => unknown;
  set: () => void;
  watch: () => void;
  readonly queryClient: QueryClient;
};
type State = {
  appServerClients?: object[];
  scopedAppServerClientSet?: Set<object>;
  scopedAppServerScopes?: Set<Scope>;
  scopedAppServerScopeCandidates?: Set<Scope>;
  scopedAppServerRegistryInstances?: Set<object>;
  scopedAppServerScopesScannedAt?: number | null;
  scopedAppServerScopeScanComplete?: boolean;
  scopedAppServerRootIdentities?: object[];
  scopedAppServerDiscovery?: {
    scopeCount: number;
    registryCount: number;
    clientCount: number;
    queryClientCount?: number;
  };
};

const createHarness = (
  state: State = {},
  window: object = {},
  lifecycle: {
    isCurrent?: () => boolean;
    yieldDiscovery?: () => Promise<void>;
  } = {},
) => {
  const patchCache = vi.fn(() => true);
  const patchPrototype = vi.fn(() => true);
  const patchRequest = vi.fn((client: object) => {
    state.appServerClients = state.appServerClients ?? [];
    if (!state.appServerClients.includes(client))
      state.appServerClients.push(client);
    return true;
  });
  const recordFailure = vi.fn();
  const api = new Function(
    "state",
    "window",
    "document",
    "patchCodexModelReasoningQueryCache",
    "patchCodexModelReasoningQueryObserverPrototype",
    "patchRequestClient",
    "recordFailure",
    "monotonicNow",
    "yieldReactDiscovery",
    "installationIsCurrent",
    `${discoveryCore}\nreturn { patchAppServerModuleClients, patchCodexScopedAppServerClients, codexDeclaredDependencyScope, codexScopeQueryClient, codexQueryObserverPrototype };`,
  )(
    state,
    window,
    { getElementById: () => null },
    patchCache,
    patchPrototype,
    patchRequest,
    recordFailure,
    () => 0,
    lifecycle.yieldDiscovery ?? (async () => {}),
    lifecycle.isCurrent ?? (() => true),
  ) as {
    patchAppServerModuleClients: (module: object) => number;
    patchCodexScopedAppServerClients: (module: object) => Promise<number>;
    codexDeclaredDependencyScope: (value: unknown) => boolean;
    codexScopeQueryClient: (value: object) => QueryClient | null;
    codexQueryObserverPrototype: (value: unknown) => object | null;
  };
  return {
    state,
    api,
    patchCache,
    patchPrototype,
    patchRequest,
    recordFailure,
  };
};

const createScope = (queryClient: QueryClient): Scope => ({
  chain: {},
  node: {},
  get: () => null,
  set() {},
  watch() {},
  get queryClient() {
    return queryClient;
  },
});

describe("Codex Desktop declared client discovery", () => {
  afterEach(() => vi.useRealTimers());

  it("rediscovers mounted picker scopes instead of permanently retaining only the shell", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-18T08:00:00Z"));
    const shell = new QueryClient();
    const picker = new QueryClient();
    const shellScope = createScope(shell);
    const pickerScope = createScope(picker);
    const root: Record<string, unknown> = {
      dependencies: { firstContext: { memoizedValue: shellScope } },
    };
    const harness = createHarness(
      {},
      {
        __codexRoot: { _internalRoot: { current: root } },
      },
    );
    try {
      await harness.api.patchCodexScopedAppServerClients({});
      expect(harness.state.scopedAppServerScopes).toEqual(
        new Set([shellScope]),
      );
      root.child = {
        dependencies: { firstContext: { memoizedValue: pickerScope } },
      };
      vi.advanceTimersByTime(30_001);
      await harness.api.patchCodexScopedAppServerClients({});
      expect(harness.state.scopedAppServerScopes).toEqual(
        new Set([shellScope, pickerScope]),
      );
      expect(harness.patchCache).toHaveBeenCalledWith(picker.getQueryCache());
    } finally {
      shell.clear();
      picker.clear();
    }
  });

  it("rescans when React replaces the current root before the retained-scope timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-18T08:00:00Z"));
    const shell = new QueryClient();
    const picker = new QueryClient();
    const shellScope = createScope(shell);
    const pickerScope = createScope(picker);
    const root = {
      dependencies: { firstContext: { memoizedValue: shellScope } },
    };
    const window = { __codexRoot: { _internalRoot: { current: root } } };
    const harness = createHarness({}, window);
    try {
      await harness.api.patchCodexScopedAppServerClients({});
      window.__codexRoot._internalRoot.current = {
        dependencies: { firstContext: { memoizedValue: pickerScope } },
      };
      await harness.api.patchCodexScopedAppServerClients({});
      expect(harness.state.scopedAppServerScopes).toEqual(
        new Set([pickerScope]),
      );
      expect(harness.patchCache).toHaveBeenCalledWith(picker.getQueryCache());
    } finally {
      shell.clear();
      picker.clear();
    }
  });

  it("abandons a superseded scope scan before publishing caches or replacing retained scopes", async () => {
    const client = new QueryClient();
    const root: Record<string, unknown> = {};
    let fiber = root;
    for (let depth = 0; depth < 150; depth += 1) {
      const child: Record<string, unknown> = {};
      fiber.child = child;
      fiber = child;
    }
    fiber.dependencies = {
      firstContext: { memoizedValue: createScope(client) },
    };
    let current = true;
    const yieldDiscovery = vi.fn(async () => {
      current = false;
    });
    const harness = createHarness(
      {},
      { __codexRoot: { _internalRoot: { current: root } } },
      { isCurrent: () => current, yieldDiscovery },
    );
    try {
      expect(await harness.api.patchCodexScopedAppServerClients({})).toBe(0);
      expect(yieldDiscovery).toHaveBeenCalled();
      expect(harness.patchCache).not.toHaveBeenCalled();
      expect(harness.patchRequest).not.toHaveBeenCalled();
      expect(harness.state.scopedAppServerScopes).toBeUndefined();
      expect(harness.recordFailure).not.toHaveBeenCalled();
    } finally {
      client.clear();
    }
  });

  it("discovers a deeply nested scope query client without an exported registry", async () => {
    const client = new QueryClient();
    const scope = createScope(client);
    const root: Record<string, unknown> = {};
    let fiber = root;
    for (let depth = 0; depth < 30; depth += 1) {
      const child: Record<string, unknown> = {};
      fiber.child = child;
      fiber = child;
    }
    fiber.dependencies = { firstContext: { memoizedValue: scope } };
    const harness = createHarness(
      {},
      { __codexRoot: { _internalRoot: { current: root } } },
    );
    try {
      expect(await harness.api.patchCodexScopedAppServerClients({})).toBe(0);
      expect(harness.patchCache).toHaveBeenCalledWith(client.getQueryCache());
      expect(harness.state.scopedAppServerScopes).toEqual(new Set([scope]));
      expect(harness.state.scopedAppServerDiscovery).toEqual({
        scopeCount: 1,
        registryCount: 0,
        clientCount: 0,
        queryClientCount: 1,
      });
      expect(harness.patchRequest).not.toHaveBeenCalled();
      expect(harness.recordFailure).not.toHaveBeenCalled();
    } finally {
      client.clear();
    }
  });

  it("validates only named own observer methods without enumerating its prototype", () => {
    const prototype = {
      createResult() {},
      getCurrentResult() {},
      getOptimisticResult() {},
      getCurrentQuery() {},
      setOptions() {},
    };
    const irrelevantGetter = vi.fn(() => {
      throw new Error("Unrelated observer getter must not run");
    });
    Object.defineProperty(prototype, "unrelated", { get: irrelevantGetter });
    const ownKeys = vi.fn(() => {
      throw new Error("Observer prototype enumeration must not run");
    });
    const declared = new Proxy(prototype, { ownKeys });
    const constructor = Object.defineProperty(
      function Observer() {},
      "prototype",
      {
        value: declared,
      },
    );
    const harness = createHarness();
    expect(harness.api.codexQueryObserverPrototype(constructor)).toBe(declared);
    expect(ownKeys).not.toHaveBeenCalled();
    expect(irrelevantGetter).not.toHaveBeenCalled();
    const methodGetter = vi.fn(() => prototype.createResult);
    Object.defineProperty(prototype, "createResult", { get: methodGetter });
    expect(harness.api.codexQueryObserverPrototype(constructor)).toBeNull();
    expect(methodGetter).not.toHaveBeenCalled();
  });

  it("validates and reads declared scope fields without enumerating unrelated keys", () => {
    const client = new QueryClient();
    const scope = createScope(client);
    scope.node.queryClient = client;
    const ownKeys = vi.fn(() => {
      throw new Error("Scope key enumeration must not run");
    });
    const scopeGetter = vi.fn(() => {
      throw new Error("Scope queryClient accessor must not run");
    });
    const irrelevantGetter = vi.fn(() => {
      throw new Error("Unrelated accessor must not run");
    });
    Object.defineProperty(scope, "queryClient", { get: scopeGetter });
    Object.defineProperty(scope, "irrelevant", { get: irrelevantGetter });
    const declared = new Proxy(scope, { ownKeys });
    const harness = createHarness();
    try {
      expect(harness.api.codexDeclaredDependencyScope(declared)).toBe(true);
      expect(harness.api.codexScopeQueryClient(declared)).toBe(client);
      expect(ownKeys).not.toHaveBeenCalled();
      expect(scopeGetter).not.toHaveBeenCalled();
      expect(irrelevantGetter).not.toHaveBeenCalled();
    } finally {
      client.clear();
    }
  });

  it("does not request descriptors for unrelated scope fields", () => {
    const client = new QueryClient();
    const scope = createScope(client);
    scope.node.queryClient = client;
    Object.defineProperty(scope, "unrelated", { value: {} });
    const descriptor = vi.fn((target: Scope, key: string | symbol) => {
      if (key === "unrelated")
        throw new Error("Unrelated descriptor must not be inspected");
      return Reflect.getOwnPropertyDescriptor(target, key);
    });
    const declared = new Proxy(scope, { getOwnPropertyDescriptor: descriptor });
    const harness = createHarness();
    try {
      expect(harness.api.codexDeclaredDependencyScope(declared)).toBe(true);
      expect(harness.api.codexScopeQueryClient(declared)).toBe(client);
      expect(
        descriptor.mock.calls.every(([, key]) => key !== "unrelated"),
      ).toBe(true);
    } finally {
      client.clear();
    }
  });

  it("binds the initialized modern node cache without invoking the scope accessor", async () => {
    const client = new QueryClient();
    const scope = createScope(client);
    scope.node.queryClient = client;
    const readScopeClient = vi.fn(() => {
      throw new Error("Modern scope queryClient accessor must not run");
    });
    Object.defineProperty(scope, "queryClient", { get: readScopeClient });
    const root = { dependencies: { firstContext: { memoizedValue: scope } } };
    const harness = createHarness(
      {},
      { __codexRoot: { _internalRoot: { current: root } } },
    );
    try {
      await expect(
        harness.api.patchCodexScopedAppServerClients({}),
      ).resolves.toBe(0);
      expect(readScopeClient).not.toHaveBeenCalled();
      expect(harness.patchCache).toHaveBeenCalledWith(client.getQueryCache());
      expect(harness.state.scopedAppServerScopes).toEqual(new Set([scope]));
      expect(harness.state.scopedAppServerDiscovery).toMatchObject({
        queryClientCount: 1,
        clientCount: 0,
      });
      expect(harness.patchRequest).not.toHaveBeenCalled();
      expect(harness.recordFailure).not.toHaveBeenCalled();
    } finally {
      client.clear();
    }
  });

  it("keeps modern node initialization authoritative and follows replacement caches", async () => {
    const first = new QueryClient();
    const second = new QueryClient();
    const scope = createScope(first);
    scope.node.queryClient = null;
    const readScopeClient = vi.fn(() => first);
    Object.defineProperty(scope, "queryClient", { get: readScopeClient });
    const harness = createHarness({ scopedAppServerScopes: new Set([scope]) });
    try {
      await harness.api.patchCodexScopedAppServerClients({});
      expect(harness.patchCache).not.toHaveBeenCalled();
      expect(harness.state.scopedAppServerDiscovery).toMatchObject({
        queryClientCount: 0,
        clientCount: 0,
      });
      scope.node.queryClient = first;
      await harness.api.patchCodexScopedAppServerClients({});
      expect(harness.patchCache).toHaveBeenLastCalledWith(
        first.getQueryCache(),
      );
      scope.node.queryClient = second;
      await harness.api.patchCodexScopedAppServerClients({});
      expect(harness.patchCache).toHaveBeenLastCalledWith(
        second.getQueryCache(),
      );
      expect(readScopeClient).not.toHaveBeenCalled();
      expect(harness.patchRequest).not.toHaveBeenCalled();
      expect(harness.recordFailure).not.toHaveBeenCalled();
    } finally {
      first.clear();
      second.clear();
    }
  });

  it("never executes a modern node queryClient getter or falls back past it", async () => {
    const client = new QueryClient();
    const scope = createScope(client);
    const readNodeClient = vi.fn(() => {
      throw new Error("Node queryClient getter must not run");
    });
    const readScopeClient = vi.fn(() => client);
    Object.defineProperty(scope.node, "queryClient", { get: readNodeClient });
    Object.defineProperty(scope, "queryClient", { get: readScopeClient });
    const harness = createHarness({ scopedAppServerScopes: new Set([scope]) });
    try {
      await expect(
        harness.api.patchCodexScopedAppServerClients({}),
      ).resolves.toBe(0);
      expect(readNodeClient).not.toHaveBeenCalled();
      expect(readScopeClient).not.toHaveBeenCalled();
      expect(harness.patchCache).not.toHaveBeenCalled();
      expect(harness.patchRequest).not.toHaveBeenCalled();
      expect(harness.recordFailure).not.toHaveBeenCalled();
    } finally {
      client.clear();
    }
  });
  it("registers a declared QueryObserver prototype before its cache has observers", async () => {
    const harness = createHarness();
    const module = {
      arbitraryMinifiedName: QueryObserver,
      unrelatedClass: class Unrelated {},
    };
    expect(harness.api.patchAppServerModuleClients(module)).toBe(0);
    expect(harness.patchPrototype).toHaveBeenCalledWith(
      QueryObserver.prototype,
    );
    harness.patchPrototype.mockClear();
    expect(await harness.api.patchCodexScopedAppServerClients(module)).toBe(0);
    expect(harness.patchPrototype).toHaveBeenCalledWith(
      QueryObserver.prototype,
    );
    expect(harness.patchRequest).not.toHaveBeenCalled();
    expect(harness.recordFailure).not.toHaveBeenCalled();
  });

  it("collapses duplicate scopes that resolve to the same query client", async () => {
    const shared = new QueryClient();
    const picker = new QueryClient();
    const first = createScope(shared);
    const second = createScope(shared);
    const third = createScope(picker);
    const root: Record<string, unknown> = {};
    let fiber = root;
    for (let depth = 0; depth < 30; depth += 1) {
      const child: Record<string, unknown> = {};
      fiber.child = child;
      fiber = child;
    }
    fiber.dependencies = {
      firstContext: { memoizedValue: first },
      secondContext: { memoizedValue: second },
      thirdContext: { memoizedValue: third },
    };
    const harness = createHarness(
      {},
      { __codexRoot: { _internalRoot: { current: root } } },
    );
    try {
      expect(await harness.api.patchCodexScopedAppServerClients({})).toBe(0);
      // The renderer exposes hundreds of scope objects that all resolve to one
      // store; heartbeats must patch each distinct cache once, not per scope.
      expect(harness.state.scopedAppServerScopes).toEqual(
        new Set([first, third]),
      );
      expect(harness.patchCache).toHaveBeenCalledTimes(2);
      expect(harness.patchCache).toHaveBeenCalledWith(shared.getQueryCache());
      expect(harness.patchCache).toHaveBeenCalledWith(picker.getQueryCache());
      expect(harness.state.scopedAppServerDiscovery).toEqual({
        scopeCount: 2,
        registryCount: 0,
        clientCount: 0,
        queryClientCount: 2,
      });
      expect(harness.recordFailure).not.toHaveBeenCalled();
    } finally {
      shared.clear();
      picker.clear();
    }
  });

  it("replaces a legacy signal's request-client ownership instead of retaining its old client", () => {
    const createClient = () => ({
      hostId: "local",
      sendRequest() {},
      getCompatibleThreadSortKey() {},
      supportsPaginatedThreadHistory() {},
    });
    const first = createClient();
    const second = createClient();
    let current = first;
    const module = { signal: { get: () => current } };
    const harness = createHarness();
    harness.api.patchAppServerModuleClients(module);
    expect(harness.state.appServerClients).toEqual([first]);
    current = second;
    harness.api.patchAppServerModuleClients(module);
    expect(harness.state.appServerClients).toEqual([second]);
  });

  it("replaces stale scoped continuation clients after a complete ownership scan", async () => {
    const queryClient = new QueryClient();
    const current = {
      hostId: "local",
      sendRequest() {},
      getCompatibleThreadSortKey() {},
      supportsPaginatedThreadHistory() {},
    };
    const manager = { requestClient: current };
    class AppServerRegistry {
      scope: Scope;
      constructor(scope: Scope) {
        this.scope = scope;
      }
      getForHostId(hostId: string) {
        return this.scope.get(hostId) as typeof manager;
      }
      getAll() {
        return [];
      }
      getImplForHostId() {
        return null;
      }
    }
    const scope = {
      ...createScope(queryClient),
      get: (hostId: string) => (hostId === "local" ? manager : null),
    };
    const stale = { id: "stale" };
    const root = {};
    const harness = createHarness(
      {
        appServerClients: [stale],
        scopedAppServerClientSet: new Set([stale]),
        scopedAppServerScopes: new Set([scope]),
        scopedAppServerScopeCandidates: new Set([scope]),
        scopedAppServerScopesScannedAt: Date.now(),
        scopedAppServerScopeScanComplete: true,
        scopedAppServerRootIdentities: [root],
      },
      { __codexRoot: { _internalRoot: { current: root } } },
    );
    try {
      await harness.api.patchCodexScopedAppServerClients({ AppServerRegistry });
      expect(harness.state.appServerClients).toEqual([current]);
      expect(harness.state.scopedAppServerClientSet).toEqual(
        new Set([current]),
      );
    } finally {
      queryClient.clear();
    }
  });

  it("patches a shared cache once per discovery pass with 691 scope aliases", async () => {
    const client = new QueryClient();
    const reads = vi.fn(() => client);
    const scopes = Array.from({ length: 691 }, () => ({
      ...createScope(client),
      get queryClient() {
        return reads();
      },
    }));
    const harness = createHarness({ scopedAppServerScopes: new Set(scopes) });
    try {
      await harness.api.patchCodexScopedAppServerClients({});
      expect(reads).toHaveBeenCalledTimes(691);
      expect(harness.patchCache).toHaveBeenCalledTimes(1);
      expect(harness.state.scopedAppServerScopes?.size).toBe(1);
      expect(harness.state.scopedAppServerScopeCandidates?.size).toBe(691);
      reads.mockClear();
      harness.patchCache.mockClear();
      for (let pass = 0; pass < 5; pass += 1)
        await harness.api.patchCodexScopedAppServerClients({});
      // Aliases retain lightweight ownership because their clients may diverge.
      // Cache work stays bounded even though each getter is re-read once.
      expect(reads).toHaveBeenCalledTimes(5 * scopes.length);
      expect(harness.patchCache).toHaveBeenCalledTimes(5);
      expect(harness.recordFailure).not.toHaveBeenCalled();
    } finally {
      client.clear();
    }
  });

  it("skips accessor exports and dynamic RPC properties while discovering prototypes", async () => {
    const getter = vi.fn(() => {
      throw new Error("An unrelated export getter must not run");
    });
    const dynamicRead = vi.fn(() => {
      throw new Error("A dynamic RPC property must not run");
    });
    const module = {
      queryObserver: QueryObserver,
      rpc: new Proxy({}, { get: dynamicRead }),
      get unrelated() {
        return getter();
      },
    };
    const harness = createHarness();
    expect(() => harness.api.patchAppServerModuleClients(module)).not.toThrow();
    await expect(
      harness.api.patchCodexScopedAppServerClients(module),
    ).resolves.toBe(0);
    expect(harness.patchPrototype).toHaveBeenCalledWith(
      QueryObserver.prototype,
    );
    expect(getter).not.toHaveBeenCalled();
    expect(dynamicRead).not.toHaveBeenCalled();
  });

  it("reads a function-valued modern node without invoking the legacy scope getter", () => {
    const client = new QueryClient();
    const node = Object.assign(function node() {}, { queryClient: client });
    const scopeGetter = vi.fn(() => {
      throw new Error("The legacy scope getter must not run");
    });
    const scope = {
      chain: {},
      node,
      get() {},
      set() {},
      watch() {},
      get queryClient() {
        return scopeGetter();
      },
    };
    const harness = createHarness();
    try {
      expect(harness.api.codexScopeQueryClient(scope)).toBe(client);
      expect(scopeGetter).not.toHaveBeenCalled();
    } finally {
      client.clear();
    }
  });

  it("retains independently discovered query clients when a registry export is absent", async () => {
    const first = new QueryClient();
    const second = new QueryClient();
    let current = first;
    const scope = {
      ...createScope(first),
      get queryClient() {
        return current;
      },
    };
    const harness = createHarness({
      scopedAppServerScopes: new Set([scope]),
    });
    try {
      await harness.api.patchCodexScopedAppServerClients({});
      expect(harness.patchCache).toHaveBeenLastCalledWith(
        first.getQueryCache(),
      );
      current = second;
      await harness.api.patchCodexScopedAppServerClients({});
      expect(harness.patchCache).toHaveBeenLastCalledWith(
        second.getQueryCache(),
      );
      expect(harness.state.scopedAppServerScopes).toEqual(new Set([scope]));
    } finally {
      first.clear();
      second.clear();
    }
  });
});
