import { readFileSync } from "node:fs";
import path from "node:path";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const resource = (name: string) =>
  readFileSync(
    path.resolve(process.cwd(), "src-tauri/src/resources/codex_desktop", name),
    "utf8",
  );
const discoveryCore = resource("client_discovery.js");
const modelCore = resource("model_picker_core.js");
const renderer = resource("renderer_runtime.js");
const heartbeatStart = renderer.indexOf(
  "  const installAppServerPatch = async () => {",
);
const heartbeatEnd = renderer.indexOf(
  "  const patchMcpModelResponseData = ",
  heartbeatStart,
);
if (heartbeatStart < 0 || heartbeatEnd < 0)
  throw new Error("The production picker heartbeat could not be located");
const heartbeat = renderer.slice(heartbeatStart, heartbeatEnd);
const efforts = ["low", "medium", "high", "xhigh", "max", "ultra"];
const key = ["models", "list", "local", "chatgpt", 100, "router"];
type Scope = {
  chain: object;
  node: object;
  get: (host: string) => unknown;
  set: () => void;
  watch: () => void;
  readonly queryClient: QueryClient;
};
type State = Record<string, unknown> & {
  scopedAppServerScopes?: Set<Scope>;
  scopedAppServerScopeCandidates?: Set<Scope>;
  scopedAppServerDiscoveryPromise?: Promise<unknown>;
  reasoningQueryCaches?: Map<object, { dispose?: () => void }>;
  reasoningObserverPrototypes?: Map<object, { dispose: () => void }>;
};
type Api = {
  patchCodexScopedAppServerClients: (module: object) => Promise<number>;
  installAppServerPatch: () => Promise<void>;
};
class RequestClient {
  hostId = "local";
  constructor(readonly id: string) {}
  sendRequest() {}
  getCompatibleThreadSortKey() {}
  supportsPaginatedThreadHistory() {}
}
class Registry {
  scope: Scope;
  constructor(scope: Scope) {
    this.scope = scope;
  }
  getForHostId(host: string) {
    return this.scope.get(host);
  }
  getAll() {}
  getDefault() {}
  getImplForHostId() {}
}
class SecondaryRegistry {
  scope: Scope;
  constructor(scope: Scope) {
    this.scope = scope;
  }
  getForHostId(host: string) {
    return this.scope.get(`${host}-secondary`);
  }
  getAll() {}
  getDefault() {}
  getImplForHostId() {}
}
const createScope = (
  client: () => QueryClient,
  get: Scope["get"] = () => null,
): Scope => ({
  chain: {},
  node: {},
  get,
  set() {},
  watch() {},
  get queryClient() {
    return client();
  },
});
const createHarness = (
  root: Record<string, unknown> | undefined,
  options: { state?: State; realProjection?: boolean; module?: object } = {},
) => {
  const state: State = {
    payload: {
      modelProvider: "router",
      catalogAvailable: true,
      modelNames: ["sol"],
      models: [{ model: "sol", supported_reasoning_levels: efforts }],
    },
    appServerModuleRetryAt: Infinity,
    reactInitialDiscoveryCompleted: true,
    lastReactFullScanAt: Date.now(),
    pendingReactNodes: new Set(),
    historyManagerCandidates: new Set(),
    reasoningQueryCaches: new Map(),
    ...options.state,
  };
  const projection = new Function(
    "state",
    `${modelCore}\nreturn { patchCodexModelReasoningQueryCache, patchCodexModelReasoningQueryObserverPrototype };`,
  )(state) as {
    patchCodexModelReasoningQueryCache: (
      cache: ReturnType<QueryClient["getQueryCache"]>,
    ) => boolean;
    patchCodexModelReasoningQueryObserverPrototype: (value: object) => boolean;
  };
  const patchCache = vi.fn(
    (cache: ReturnType<QueryClient["getQueryCache"]>) => {
      if (options.realProjection)
        return projection.patchCodexModelReasoningQueryCache(cache);
      state.reasoningQueryCaches!.set(cache, {});
      return true;
    },
  );
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
    "loadAppModule",
    "installReactRootObserver",
    "patchReactAppServerClients",
    "initialReactNodes",
    "drainPendingReactNodes",
    "scheduleHistoryLineageHydration",
    "appServerRequestPatchVersion",
    `${discoveryCore}\n${heartbeat}\nreturn { patchCodexScopedAppServerClients, installAppServerPatch };`,
  )(
    state,
    { __codexRoot: { _internalRoot: { current: root } } },
    { getElementById: () => null },
    patchCache,
    options.realProjection
      ? projection.patchCodexModelReasoningQueryObserverPrototype
      : () => true,
    patchRequest,
    recordFailure,
    () => 0,
    async () => {},
    () => true,
    async (name: string) =>
      name === "app-shared-" ? (options.module ?? {}) : {},
    () => {},
    async () => 0,
    () => [],
    () => [],
    () => {},
    "ownership-test",
  ) as Api;
  return {
    state,
    api,
    patchCache,
    patchRequest,
    recordFailure,
    dispose: () => {
      for (const entry of state.reasoningObserverPrototypes?.values() ?? [])
        entry.dispose();
      for (const entry of state.reasoningQueryCaches?.values() ?? [])
        entry.dispose?.();
    },
  };
};

describe("Codex Desktop scope ownership and production heartbeat", () => {
  afterEach(() => vi.useRealTimers());

  it.each([false, true])(
    "observes independent manager replacement when request clients initially share identity: %s",
    async (initiallyShared) => {
      const client = new QueryClient();
      const first = { requestClient: new RequestClient("first") };
      const second = {
        requestClient: initiallyShared
          ? first.requestClient
          : new RequestClient("second"),
      };
      const a = createScope(
        () => client,
        () => first,
      );
      const b = createScope(
        () => client,
        () => second,
      );
      const harness = createHarness({ dependencies: { first: a, second: b } });
      try {
        await harness.api.patchCodexScopedAppServerClients({ Registry });
        harness.patchRequest.mockClear();
        harness.patchCache.mockClear();
        second.requestClient = new RequestClient("second-replaced");
        await harness.api.patchCodexScopedAppServerClients({ Registry });
        expect(harness.patchRequest).toHaveBeenCalledWith(second.requestClient);
        expect(harness.patchRequest).toHaveBeenCalledTimes(2);
        expect(harness.patchCache).toHaveBeenCalledTimes(1);
        expect(harness.recordFailure).not.toHaveBeenCalled();
      } finally {
        harness.dispose();
        client.clear();
      }
    },
  );

  it("checks every registry class before collapsing shared-cache scopes", async () => {
    const client = new QueryClient();
    const common = { requestClient: new RequestClient("common") };
    const first = { requestClient: new RequestClient("first-secondary") };
    const second = { requestClient: new RequestClient("second-secondary") };
    const a = createScope(
      () => client,
      (host) => (host === "local" ? common : first),
    );
    const b = createScope(
      () => client,
      (host) => (host === "local" ? common : second),
    );
    const harness = createHarness({ dependencies: { first: a, second: b } });
    try {
      await harness.api.patchCodexScopedAppServerClients({
        Registry,
        SecondaryRegistry,
      });
      harness.patchRequest.mockClear();
      second.requestClient = new RequestClient("second-secondary-replaced");
      await harness.api.installAppServerPatch();
      expect(harness.patchRequest).toHaveBeenCalledWith(second.requestClient);
      expect(harness.patchRequest).toHaveBeenCalledTimes(3);
      expect(harness.recordFailure).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
      client.clear();
    }
  });

  it("restores Max before a full rescan when a registry-free alias changes its client", async () => {
    vi.useFakeTimers();
    const shared = new QueryClient();
    const picker = new QueryClient();
    let current = shared;
    const a = createScope(() => shared);
    const b = createScope(() => current);
    const harness = createHarness(
      { dependencies: { first: a, second: b } },
      { realProjection: true },
    );
    let observer: { destroy: () => void } | undefined;
    let unsubscribe = () => {};
    try {
      await harness.api.patchCodexScopedAppServerClients({ QueryObserver });
      current = picker;
      const raw = {
        data: [
          {
            model: "sol",
            supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
              reasoningEffort,
              description: reasoningEffort,
            })),
          },
        ],
      };
      picker.setQueryData(key, raw);
      const mounted = new QueryObserver(picker, {
        queryKey: key,
        enabled: false,
        select: (value: typeof raw) => ({
          models: value.data.map((row) => ({
            ...row,
            supportedReasoningEfforts: row.supportedReasoningEfforts.filter(
              (level) => level.reasoningEffort !== "max",
            ),
          })),
        }),
      });
      observer = mounted;
      const updates: string[][] = [];
      unsubscribe = mounted.subscribe((result) => {
        updates.push(
          result.data!.models[0].supportedReasoningEfforts.map(
            (level) => level.reasoningEffort,
          ),
        );
      });
      const stops = () =>
        mounted
          .getCurrentResult()
          .data!.models[0].supportedReasoningEfforts.map(
            (level) => level.reasoningEffort,
          );
      expect(stops()).not.toContain("max");
      vi.advanceTimersByTime(1500);
      await harness.api.installAppServerPatch();
      expect(stops()).toEqual(efforts);
      expect(updates).toContainEqual(efforts);
      expect(picker.getQueryData(key)).toBe(raw);
      expect(harness.recordFailure).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      observer?.destroy();
      harness.dispose();
      shared.clear();
      picker.clear();
    }
  });

  it("keeps 691 lightweight alias owners while patching one cache per heartbeat", async () => {
    const client = new QueryClient();
    const reads = Array.from({ length: 691 }, () => vi.fn(() => client));
    const scopes = reads.map((read) => createScope(read));
    const root: Record<string, unknown> = {};
    let fiber = root;
    for (const scope of scopes) {
      fiber.dependencies = { memoizedValue: scope };
      fiber.child = {};
      fiber = fiber.child as Record<string, unknown>;
    }
    const harness = createHarness(
      root,
      { state: { scopedAppServerScopes: new Set(scopes) } },
    );
    try {
      await harness.api.patchCodexScopedAppServerClients({});
      expect(harness.state.scopedAppServerScopes?.size).toBe(1);
      expect(harness.state.scopedAppServerScopeCandidates?.size).toBe(691);
      expect(harness.patchCache).toHaveBeenCalledTimes(1);
      for (const read of reads) {
        expect(read).toHaveBeenCalledTimes(1);
        read.mockClear();
      }
      harness.patchCache.mockClear();
      for (let pass = 0; pass < 5; pass += 1)
        await harness.api.installAppServerPatch();
      for (const read of reads) expect(read).toHaveBeenCalledTimes(5);
      expect(harness.patchCache).toHaveBeenCalledTimes(5);
      expect(harness.recordFailure).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
      client.clear();
    }
  });

  it("deduplicates by cache identity across separate clients and heartbeat paths", async () => {
    const first = new QueryClient();
    const second = new QueryClient({ queryCache: first.getQueryCache() });
    const a = createScope(() => first);
    const b = createScope(() => second);
    const harness = createHarness(
      { dependencies: { first: a, second: b } },
      { state: { appServerModuleRetryAt: 0 } },
    );
    try {
      await harness.api.installAppServerPatch();
      await harness.state.scopedAppServerDiscoveryPromise;
      expect(harness.patchCache).toHaveBeenCalledTimes(1);
      expect(harness.state.scopedAppServerScopes?.size).toBe(1);
      expect(harness.state.scopedAppServerScopeCandidates?.size).toBe(2);
      expect(harness.recordFailure).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
      first.clear();
      second.clear();
    }
  });

  it("removes unmounted alias owners after a complete scope rescan", async () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const first = createScope(() => client);
    const secondRead = vi.fn(() => client);
    const second = createScope(secondRead);
    const root: Record<string, unknown> = { dependencies: { first, second } };
    const harness = createHarness(root);
    try {
      await harness.api.patchCodexScopedAppServerClients({});
      root.dependencies = { first };
      vi.advanceTimersByTime(30_001);
      await harness.api.patchCodexScopedAppServerClients({});
      expect(harness.state.scopedAppServerScopeCandidates).toEqual(
        new Set([first]),
      );
      secondRead.mockClear();
      await harness.api.installAppServerPatch();
      expect(secondRead).not.toHaveBeenCalled();
      expect(harness.patchCache).toHaveBeenCalledTimes(3);
    } finally {
      harness.dispose();
      client.clear();
    }
  });

  it("clears all scope owners after a complete empty scan but retains registered caches", async () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const read = vi.fn(() => client);
    const scope = createScope(read);
    const root: Record<string, unknown> = { dependencies: { scope } };
    const harness = createHarness(root);
    try {
      await harness.api.patchCodexScopedAppServerClients({});
      root.dependencies = {};
      vi.advanceTimersByTime(30_001);
      await harness.api.patchCodexScopedAppServerClients({});
      expect(harness.state.scopedAppServerScopeCandidates).toEqual(new Set());
      expect(harness.state.scopedAppServerScopes).toEqual(new Set());
      read.mockClear();
      harness.patchCache.mockClear();
      await harness.api.installAppServerPatch();
      expect(read).not.toHaveBeenCalled();
      expect(harness.patchCache).toHaveBeenCalledTimes(1);
      expect(harness.patchCache).toHaveBeenCalledWith(client.getQueryCache());
    } finally {
      harness.dispose();
      client.clear();
    }
  });

  it("preserves lightweight scope owners while renderer roots are unavailable", async () => {
    const client = new QueryClient();
    const scope = createScope(() => client);
    const harness = createHarness(undefined, {
      state: { scopedAppServerScopes: new Set([scope]) },
    });
    try {
      await harness.api.patchCodexScopedAppServerClients({});
      expect(harness.state.scopedAppServerScopeCandidates).toEqual(new Set([scope]));
      expect(harness.state.scopedAppServerScopes).toEqual(new Set([scope]));
      expect(harness.patchCache).toHaveBeenCalledTimes(1);
    } finally {
      harness.dispose();
      client.clear();
    }
  });

  it("preserves unseen owners when a capped scan finds another usable scope", async () => {
    const first = new QueryClient();
    const second = new QueryClient();
    const unseen = createScope(() => first);
    const visible = createScope(() => second);
    const root: Record<string, unknown> = { dependencies: { scope: visible } };
    let fiber = root;
    for (let depth = 0; depth < 25_001; depth += 1) {
      fiber.child = {};
      fiber = fiber.child as Record<string, unknown>;
    }
    fiber.dependencies = { scope: unseen };
    const harness = createHarness(root, {
      state: { scopedAppServerScopes: new Set([unseen]) },
    });
    try {
      await harness.api.patchCodexScopedAppServerClients({});
      expect(harness.state.scopedAppServerScopeCandidates).toEqual(new Set([unseen, visible]));
      expect(harness.patchCache).toHaveBeenCalledTimes(2);
      expect(harness.recordFailure).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
      first.clear();
      second.clear();
    }
  });
});
