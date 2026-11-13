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
  appServerStatusAtoms?: object[];
  appServerStatusBindings?: { atom: object; managerToken: object }[];
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
  const rememberCodexUserTurnAction = vi.fn();
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
    "rememberCodexUserTurnAction",
    `${discoveryCore}\nreturn { patchAppServerModuleClients, patchCodexScopedAppServerClients, refreshCodexScopedAppServerClients, codexAppServerClientHasCurrentOwner, codexDeclaredDependencyScope, codexScopeQueryClient, codexQueryObserverPrototype };`,
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
    rememberCodexUserTurnAction,
  ) as {
    patchAppServerModuleClients: (module: object) => number;
    patchCodexScopedAppServerClients: (module: object) => Promise<number>;
    refreshCodexScopedAppServerClients: (
      scopes: Scope[],
      registries?: object[],
      patchedCaches?: Set<object>,
    ) => number;
    codexAppServerClientHasCurrentOwner: (client: object) => boolean;
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
    rememberCodexUserTurnAction,
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
    const root = { memoizedState: { scope } };
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

  it("adapts the current family-bound RpcPromise and routes app calls through the hook", async () => {
    const rawSendRequest = vi.fn(async (...args: unknown[]) => ({ args }));
    const hook = vi.fn();
    const rpcBase = {
      dup() {},
      onRpcBroken() {},
      map() {},
      toString() {
        return "[object RpcPromise]";
      },
    };
    const rpcPrototype = Object.create(rpcBase);
    const rpc = function rpcPromise() {};
    Object.setPrototypeOf(rpc, rpcPrototype);
    Object.assign(rpc, {
      sendRequest: rawSendRequest,
      getCompatibleThreadSortKey: () => "sort",
      supportsPaginatedThreadHistory: () => true,
      startTurn: vi.fn(async (...args: unknown[]) => ({ args })),
      retrySafetyBufferedTurn: vi.fn(async (...args: unknown[]) => ({ args })),
      interruptConversation: vi.fn(async (...args: unknown[]) => ({ args })),
    });
    const sourceClient = { hostId: "local", rpc };
    const scope = createScope(new QueryClient());
    const atomScope = {};
    const statusAtom = { scope: atomScope };
    Object.assign(scope, { scope: atomScope });
    const managerToken = {};
    const provider = {
      forHost: (host: string) => (host === "local" ? rpc : "remote-rpc"),
    };
    scope.get = (token: unknown) =>
      token === managerToken
        ? provider
        : { status: "ready", client: sourceClient };
    const entry = { value: { current: { client: sourceClient } } };
    const familyBindings = new Map([
      ["app-server", new Map([["local", entry]])],
    ]);
    scope.node.familyBindings = familyBindings;
    const root: Record<string, unknown> = { memoizedState: { scope } };
    const testWindow = { __codexRoot: { _internalRoot: { current: root } } };
    const harness = createHarness(
      {
        appServerStatusAtoms: [statusAtom],
        appServerStatusBindings: [{ atom: statusAtom, managerToken }],
        scopedAppServerScopeCandidates: new Set([scope]),
        scopedAppServerScopeScanComplete: true,
        scopedAppServerRootIdentities: [root],
      },
      testWindow,
    );
    harness.patchRequest.mockImplementation((client: object) => {
      const original = (
        client as { sendRequest: (...args: unknown[]) => unknown }
      ).sendRequest;
      (client as { sendRequest: (...args: unknown[]) => unknown }).sendRequest =
        (...args: unknown[]) => {
          hook(...args);
          return original(...args);
        };
      harness.state.appServerClients = harness.state.appServerClients ?? [];
      harness.state.appServerClients.push(client);
      return true;
    });
    try {
      expect(harness.api.refreshCodexScopedAppServerClients([scope])).toBe(1);
      await (
        sourceClient.rpc as unknown as {
          sendRequest: (...args: unknown[]) => Promise<unknown>;
        }
      ).sendRequest("thread/read", { threadId: "x" });
      expect(rawSendRequest).toHaveBeenCalledWith("thread/read", {
        threadId: "x",
      });
      expect(hook).toHaveBeenCalledWith("thread/read", { threadId: "x" });
      await (
        sourceClient.rpc as unknown as {
          startTurn: (threadId: string) => Promise<unknown>;
        }
      ).startTurn("thread-1");
      expect(harness.rememberCodexUserTurnAction).toHaveBeenCalledWith(
        "turn/start",
        { threadId: "thread-1" },
      );
      await (
        sourceClient.rpc as unknown as {
          retrySafetyBufferedTurn: (params: {
            threadId: string;
          }) => Promise<unknown>;
        }
      ).retrySafetyBufferedTurn({ threadId: "thread-2" });
      expect(harness.rememberCodexUserTurnAction).toHaveBeenCalledWith(
        "turn/start",
        { threadId: "thread-2" },
      );
      await (
        sourceClient.rpc as unknown as {
          interruptConversation: (threadId: string) => Promise<unknown>;
        }
      ).interruptConversation("thread-3");
      expect(harness.rememberCodexUserTurnAction).toHaveBeenCalledWith(
        "turn/interrupt",
        { threadId: "thread-3" },
      );
      expect(provider.forHost("remote")).toBe("remote-rpc");
      await (
        provider.forHost("local") as unknown as {
          startTurn: (id: string) => Promise<unknown>;
        }
      ).startTurn("via-provider");
      expect(harness.rememberCodexUserTurnAction).toHaveBeenCalledWith(
        "turn/start",
        { threadId: "via-provider" },
      );
      expect(harness.state.appServerClients).toHaveLength(1);
      const alias = createScope(scope.queryClient);
      alias.node = scope.node;
      harness.state.scopedAppServerScopeCandidates?.add(alias);
      harness.patchRequest.mockClear();
      expect(
        harness.api.refreshCodexScopedAppServerClients([scope, alias]),
      ).toBe(1);
      expect(harness.patchRequest).toHaveBeenCalledTimes(1);
      const ownedClient = harness.state.appServerClients?.[0];
      if (!ownedClient)
        throw new Error("Expected discovered app-server client");
      expect(harness.api.codexAppServerClientHasCurrentOwner(ownedClient)).toBe(
        true,
      );
      harness.state.scopedAppServerScopeScanComplete = false;
      expect(harness.api.codexAppServerClientHasCurrentOwner(ownedClient)).toBe(
        true,
      );
      testWindow.__codexRoot._internalRoot.current = {};
      expect(harness.api.codexAppServerClientHasCurrentOwner(ownedClient)).toBe(
        false,
      );
      testWindow.__codexRoot._internalRoot.current = root;
      harness.state.scopedAppServerScopeScanComplete = true;
      sourceClient.hostId = "durable";
      expect(harness.api.codexAppServerClientHasCurrentOwner(ownedClient)).toBe(
        false,
      );
      sourceClient.hostId = "local";
      scope.get = () => null;
      expect(harness.api.codexAppServerClientHasCurrentOwner(ownedClient)).toBe(
        false,
      );
    } finally {
      scope.queryClient.clear();
    }
  });

  it.each([
    "nonextensible_client",
    "nonextensible_provider",
    "client_write_rejected",
    "provider_write_rejected",
    "missing_provider_binding",
  ] as const)("leaves both RPC owners unchanged when %s", (failure) => {
    const rpc = Object.assign(function rpcStub() {}, {
      sendRequest: vi.fn(),
      getCompatibleThreadSortKey() {},
      supportsPaginatedThreadHistory() {},
    });
    Object.setPrototypeOf(rpc, {
      dup() {},
      onRpcBroken() {},
      map() {},
      toString: () => "[object RpcStub]",
    });
    const rawClient = { hostId: "local", rpc };
    const sourceClient =
      failure === "client_write_rejected"
        ? new Proxy(rawClient, {
            defineProperty(target, key, descriptor) {
              if (key === "rpc") throw new Error("RPC assignment rejected");
              return Reflect.defineProperty(target, key, descriptor);
            },
          })
        : rawClient;
    const originalForHost = (host: string) =>
      host === "local" ? rpc : "remote-rpc";
    const rawProvider = { forHost: originalForHost };
    const provider =
      failure === "provider_write_rejected"
        ? new Proxy(rawProvider, {
            defineProperty(target, key, descriptor) {
              if (key === "forHost")
                throw new Error("Host assignment rejected");
              return Reflect.defineProperty(target, key, descriptor);
            },
          })
        : rawProvider;
    if (failure === "nonextensible_client")
      Object.preventExtensions(sourceClient);
    if (failure === "nonextensible_provider")
      Object.preventExtensions(provider);
    const scope = createScope(new QueryClient());
    const atomScope = {};
    const atom = { scope: atomScope };
    const managerToken = {};
    Object.assign(scope, { scope: atomScope });
    scope.get = (token: unknown) =>
      token === managerToken
        ? provider
        : { status: "ready", client: sourceClient };
    const root = { memoizedState: { scope } };
    const harness = createHarness(
      {
        appServerStatusAtoms: [atom],
        appServerStatusBindings:
          failure === "missing_provider_binding"
            ? []
            : [{ atom, managerToken }],
        scopedAppServerScopeCandidates: new Set([scope]),
      },
      { __codexRoot: { _internalRoot: { current: root } } },
    );
    try {
      for (let pass = 0; pass < 2; pass += 1) {
        expect(harness.api.refreshCodexScopedAppServerClients([scope])).toBe(0);
        expect(sourceClient.rpc).toBe(rpc);
        expect(provider.forHost).toBe(originalForHost);
        expect(sourceClient).not.toHaveProperty("__ccSwitchRpcBinding");
        expect(provider).not.toHaveProperty("__ccSwitchForHostBinding");
      }
      expect(harness.patchRequest).not.toHaveBeenCalled();
      expect(rawClient.rpc.sendRequest).not.toHaveBeenCalled();
    } finally {
      scope.queryClient.clear();
    }
  });
});
