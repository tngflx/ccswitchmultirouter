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
  get: () => unknown;
  set: () => void;
  watch: () => void;
  readonly queryClient: QueryClient;
};
type State = {
  scopedAppServerScopes?: Set<Scope>;
  scopedAppServerScopeCandidates?: Set<Scope>;
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
  const patchRequest = vi.fn(() => true);
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
    `${discoveryCore}\nreturn { patchAppServerModuleClients, patchCodexScopedAppServerClients };`,
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
