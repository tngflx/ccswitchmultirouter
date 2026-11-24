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
type ScopeBinding = { node: object };
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
  scopedAppServerScopeHintScanComplete?: boolean;
  scopedAppServerScopeHintScan?: { status: string; reason?: string };
  scopedAppServerRootIdentities?: object[];
  pendingReactNodes?: Set<object>;
  reactMutationGeneration?: number;
  scopedAppServerScopeScan?: {
    status: string;
    visitedFiberCount: number;
    fiberLimit: number;
    scopeCount: number;
    elapsedMs: number;
    reason?: string;
  };
  scopedAppServerScopeLastSettledScan?: {
    status: string;
    visitedFiberCount: number;
    fiberLimit: number;
    scopeCount: number;
    elapsedMs: number;
    reason?: string;
  };
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
    objectScanLimit?: number;
    fieldScanLimit?: number;
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
  const source = discoveryCore
    .replace(
      "CODEX_RENDERER_SCOPE_OBJECT_SCAN_LIMIT = 100000",
      `CODEX_RENDERER_SCOPE_OBJECT_SCAN_LIMIT = ${lifecycle.objectScanLimit ?? 100000}`,
    )
    .replace(
      "CODEX_RENDERER_SCOPE_FIELD_SCAN_LIMIT = 500000",
      `CODEX_RENDERER_SCOPE_FIELD_SCAN_LIMIT = ${lifecycle.fieldScanLimit ?? 500000}`,
    );
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
    `${source}\nreturn { patchAppServerModuleClients, patchCodexScopedAppServerClients, refreshCodexScopedAppServerClients, codexAppServerClientHasCurrentOwner, codexDeclaredDependencyScope, codexScopeQueryClient, codexQueryObserverPrototype, codexRendererScopeRootsMatchCurrent, codexRendererScopeCandidates, codexRendererScopeSnapshotIsCurrent, codexCurrentAppServerScopeHints, codexRendererMountedNodes, codexRendererScopePathIsCurrent };`,
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
    codexRendererScopeRootsMatchCurrent: () => boolean;
    codexRendererScopeCandidates: () => Promise<Scope[]>;
    codexRendererScopeSnapshotIsCurrent: () => boolean;
    codexCurrentAppServerScopeHints: (
      completeInventory?: boolean,
      scopeBindings?: Map<Scope, ScopeBinding>,
    ) => Scope[];
    codexRendererMountedNodes: (targets: Set<unknown>) => Set<unknown>;
    codexRendererScopePathIsCurrent: (
      scope: Scope,
      binding?: ScopeBinding,
    ) => boolean;
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

  it("rejects an alternate commit as proof that the old scope inventory is current", () => {
    const fiberRoot = {};
    const first: Record<string, unknown> = { stateNode: fiberRoot };
    const second: Record<string, unknown> = { stateNode: fiberRoot };
    first.alternate = second;
    second.alternate = first;
    const state: State = {
      scopedAppServerRootIdentities: [{ root: fiberRoot, fiber: first }],
      pendingReactNodes: new Set(),
    };
    const window = { __codexRoot: { _internalRoot: { current: first } } };
    const harness = createHarness(state, window);
    expect(harness.api.codexRendererScopeRootsMatchCurrent()).toBe(true);
    first.stateNode = {};
    expect(harness.api.codexRendererScopeRootsMatchCurrent()).toBe(false);
    first.stateNode = fiberRoot;
    window.__codexRoot._internalRoot.current = second;
    expect(harness.api.codexRendererScopeRootsMatchCurrent()).toBe(false);
    window.__codexRoot._internalRoot.current = { stateNode: {} };
    expect(harness.api.codexRendererScopeRootsMatchCurrent()).toBe(false);
  });

  it("accepts the exact saved synthetic Fiber without requiring a stateNode", () => {
    const fiber = {};
    const harness = createHarness(
      { scopedAppServerRootIdentities: [{ root: fiber, fiber }] },
      { __codexRoot: { _internalRoot: { current: fiber } } },
    );
    expect(harness.api.codexRendererScopeRootsMatchCurrent()).toBe(true);
  });

  it("rescans an alternate commit with a replaced provider before the cache timeout", async () => {
    const client = new QueryClient();
    const oldScope = createScope(client);
    const newScope = createScope(client);
    const fiberRoot = {};
    const first: Record<string, unknown> = {
      stateNode: fiberRoot,
      dependencies: { scope: oldScope },
    };
    const second: Record<string, unknown> = {
      stateNode: fiberRoot,
      dependencies: { scope: newScope },
      alternate: first,
    };
    first.alternate = second;
    const window = { __codexRoot: { _internalRoot: { current: first } } };
    const harness = createHarness({}, window);
    try {
      await harness.api.codexRendererScopeCandidates();
      window.__codexRoot._internalRoot.current = second;
      expect(await harness.api.codexRendererScopeCandidates()).toEqual([
        newScope,
      ]);
      expect(harness.state.scopedAppServerScopeScanComplete).toBe(true);
    } finally {
      client.clear();
    }
  });

  it("does not publish a yielded pre-commit scope inventory as complete", async () => {
    const client = new QueryClient();
    const oldScope = createScope(client);
    const newScope = createScope(client);
    const fiberRoot = {};
    const first: Record<string, unknown> = {
      stateNode: fiberRoot,
      dependencies: { scope: oldScope },
    };
    let child = first;
    for (let index = 0; index < 150; index += 1) {
      const next = {};
      child.child = next;
      child = next;
    }
    const second: Record<string, unknown> = {
      stateNode: fiberRoot,
      alternate: first,
      dependencies: { scope: newScope },
    };
    first.alternate = second;
    const window = { __codexRoot: { _internalRoot: { current: first } } };
    const harness = createHarness({}, window, {
      yieldDiscovery: async () => {
        window.__codexRoot._internalRoot.current = second;
      },
    });
    try {
      await harness.api.codexRendererScopeCandidates();
      expect(harness.state.scopedAppServerScopeScanComplete).toBe(false);
      expect(harness.api.codexRendererScopeSnapshotIsCurrent()).toBe(false);
      expect(await harness.api.codexRendererScopeCandidates()).toEqual([
        newScope,
      ]);
      expect(harness.state.scopedAppServerScopeScanComplete).toBe(true);
    } finally {
      client.clear();
    }
  });

  it("retains the last settled scan while an immediate retry is still scanning", async () => {
    const root: Record<string, unknown> = {};
    let child = root;
    for (let index = 0; index < 150; index += 1) {
      const next = {};
      child.child = next;
      child = next;
    }
    const state: State = {};
    let invalidate = true;
    let release = () => {};
    const retryGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = createHarness(
      state,
      { __codexRoot: { _internalRoot: { current: root } } },
      {
        yieldDiscovery: async () => {
          if (invalidate) state.reactMutationGeneration = 1;
          else await retryGate;
        },
      },
    );
    await harness.api.codexRendererScopeCandidates();
    const settled = state.scopedAppServerScopeLastSettledScan;
    expect(settled).toMatchObject({
      status: "invalidated",
      reason: "mutation_generation",
      visitedFiberCount: 151,
      fiberLimit: 30000,
      scopeCount: 0,
      elapsedMs: expect.any(Number),
    });
    invalidate = false;
    const retry = harness.api.codexRendererScopeCandidates();
    try {
      expect(state.scopedAppServerScopeScan?.status).toBe("scanning");
      expect(state.scopedAppServerScopeLastSettledScan).toBe(settled);
      expect(state.scopedAppServerScopeScanComplete).toBe(false);
    } finally {
      release();
      await retry;
    }
    expect(state.scopedAppServerScopeLastSettledScan).toMatchObject({
      status: "complete",
      visitedFiberCount: 151,
      scopeCount: 0,
    });
    expect(state.scopedAppServerScopeLastSettledScan).not.toHaveProperty(
      "reason",
    );
  });

  it("rejects a mixed inventory when deep scanned state changes with the same final root", async () => {
    const client = new QueryClient();
    const oldScope = createScope(client);
    const newScope = createScope(client);
    const root: Record<string, unknown> = {};
    const owner: Record<string, unknown> = {
      dependencies: { scope: oldScope },
    };
    root.child = owner;
    let child = owner;
    for (let index = 0; index < 150; index += 1) {
      const next = {};
      child.child = next;
      child = next;
    }
    const harness = createHarness(
      {},
      { __codexRoot: { _internalRoot: { current: root } } },
      {
        yieldDiscovery: async () => {
          owner.dependencies = { scope: newScope };
        },
      },
    );
    try {
      await harness.api.codexRendererScopeCandidates();
      expect(harness.state.scopedAppServerScopeScanComplete).toBe(false);
      expect(harness.api.codexRendererScopeSnapshotIsCurrent()).toBe(false);
    } finally {
      client.clear();
    }
  });

  it("rejects a yielded inventory when a stable nested ref changes its current scope", async () => {
    const client = new QueryClient();
    const oldScope = createScope(client);
    const newScope = createScope(client);
    const ref = { current: oldScope };
    const root: Record<string, unknown> = {
      memoizedState: { memoizedState: ref },
    };
    let child = root;
    for (let index = 0; index < 150; index += 1) {
      const next = {};
      child.child = next;
      child = next;
    }
    const harness = createHarness(
      {},
      {
        __codexRoot: { _internalRoot: { current: root } },
      },
      {
        yieldDiscovery: async () => {
          ref.current = newScope;
        },
      },
    );
    try {
      await harness.api.codexRendererScopeCandidates();
      expect(harness.state.scopedAppServerScopeScanComplete).toBe(false);
      expect(harness.api.codexRendererScopeSnapshotIsCurrent()).toBe(false);
      expect(harness.state.scopedAppServerScopeScan?.status).toBe(
        "invalidated",
      );
    } finally {
      client.clear();
    }
  });

  it("finds a scope behind scalar fields and still invalidates changed edges", async () => {
    const client = new QueryClient();
    const owner = createScope(client);
    const values: Record<string, unknown> = Object.fromEntries(
      Array.from({ length: 200 }, (_, index) => [`scalar${index}`, index]),
    );
    values.owner = owner;
    const root = { memoizedState: values };
    const harness = createHarness(
      {},
      { __codexRoot: { _internalRoot: { current: root } } },
    );
    try {
      expect(await harness.api.codexRendererScopeCandidates()).toEqual([owner]);
      expect(harness.state.scopedAppServerScopeScanComplete).toBe(true);
      expect(harness.api.codexRendererScopeSnapshotIsCurrent()).toBe(true);

      values.scalar0 = createScope(client);
      expect(harness.api.codexRendererScopeSnapshotIsCurrent()).toBe(false);
    } finally {
      client.clear();
    }
  });

  it("finds an owner after repeated references without losing descriptor provenance", async () => {
    const client = new QueryClient();
    const brand = {};
    const owner = Object.assign(createScope(client), { scope: brand });
    const sharedValue = {};
    const primitiveTarget = "mounted primitive";
    const values: Record<string, unknown> = Object.fromEntries(
      Array.from({ length: 2048 }, (_, index) => [
        `alias${index}`,
        sharedValue,
      ]),
    );
    values.owner = owner;
    values.primitiveTarget = primitiveTarget;
    const root = { memoizedState: values, pendingProps: values };
    const harness = createHarness(
      { appServerStatusAtoms: [{ scope: brand }] },
      { __codexRoot: { _internalRoot: { current: root } } },
    );
    try {
      expect(harness.api.codexCurrentAppServerScopeHints()).toEqual([owner]);
      expect(harness.api.codexCurrentAppServerScopeHints(true)).toEqual([
        owner,
      ]);
      expect(harness.state.scopedAppServerScopeHintScanComplete).toBe(true);
      const targets = new Set([owner.node, primitiveTarget]);
      expect(harness.api.codexRendererMountedNodes(targets)).toEqual(targets);
      expect(await harness.api.codexRendererScopeCandidates()).toEqual([owner]);
      expect(harness.state.scopedAppServerScopeScanComplete).toBe(true);
      expect(harness.api.codexRendererScopeSnapshotIsCurrent()).toBe(true);

      values.alias0 = {};
      expect(harness.api.codexRendererScopeSnapshotIsCurrent()).toBe(false);
    } finally {
      client.clear();
    }
  });

  it("finds a previously unseen same-brand owner beyond the broad Fiber value cap", async () => {
    const client = new QueryClient();
    const secondClient = new QueryClient();
    const brand = {};
    const retained = Object.assign(createScope(client), { scope: brand });
    const omitted = Object.assign(createScope(secondClient), { scope: brand });
    const values: Record<string, unknown> = {
      retained,
      ...Object.fromEntries(
        Array.from({ length: 2048 }, (_, index) => [`unrelated${index}`, {}]),
      ),
    };
    values.owner = omitted;
    const root = { memoizedState: values };
    const harness = createHarness(
      {
        appServerStatusAtoms: [{ scope: brand }],
        scopedAppServerScopeCandidates: new Set([retained]),
      },
      { __codexRoot: { _internalRoot: { current: root } } },
    );
    try {
      expect(harness.api.codexCurrentAppServerScopeHints()).toEqual([retained]);
      const bindings = new Map<Scope, ScopeBinding>();
      expect(
        harness.api.codexCurrentAppServerScopeHints(true, bindings),
      ).toEqual([retained, omitted]);
      expect(harness.state.scopedAppServerScopeHintScanComplete).toBe(true);
      const binding = bindings.get(omitted);
      expect(binding?.node).toBe(omitted.node);
      expect(
        harness.api.codexRendererScopePathIsCurrent(omitted, binding),
      ).toBe(true);
      expect(
        harness.api.codexRendererMountedNodes(new Set([omitted.node])),
      ).toEqual(new Set());
      expect(await harness.api.codexRendererScopeCandidates()).toEqual([
        retained,
      ]);
      expect(harness.state.scopedAppServerScopeScanComplete).toBe(false);
      expect(harness.state.scopedAppServerScopeScan).toMatchObject({
        status: "capped",
        reason: "value_limit",
      });
      expect(harness.state.scopedAppServerScopeLastSettledScan).toMatchObject({
        status: "capped",
        reason: "value_limit",
      });
      expect(harness.api.codexRendererScopeSnapshotIsCurrent()).toBe(false);
      delete values.owner;
      expect(
        harness.api.codexRendererScopePathIsCurrent(omitted, binding),
      ).toBe(false);
    } finally {
      client.clear();
      secondClient.clear();
    }
  });

  it("charges a shared value once across Fibers and retains its shallowest path", () => {
    const client = new QueryClient();
    const brand = {};
    const scope = Object.assign(createScope(client), { scope: brand });
    const shared = { scope };
    const outer = { shared };
    const child = { memoizedState: shared };
    const root = { memoizedState: outer, child, sibling: child };
    const harness = createHarness(
      { appServerStatusAtoms: [{ scope: brand }] },
      { __codexRoot: { _internalRoot: { current: root } } },
      { objectScanLimit: 3, fieldScanLimit: 2 },
    );
    try {
      const bindings = new Map<Scope, ScopeBinding>();
      expect(
        harness.api.codexCurrentAppServerScopeHints(true, bindings),
      ).toEqual([scope]);
      expect(harness.state.scopedAppServerScopeHintScanComplete).toBe(true);
      root.memoizedState = { shared: { scope } };
      expect(
        harness.api.codexRendererScopePathIsCurrent(scope, bindings.get(scope)),
      ).toBe(true);
    } finally {
      client.clear();
    }
  });

  it.each(["object", "field"] as const)(
    "keeps both inventories incomplete when their %s work budget is exhausted",
    async (budget) => {
      const root = { memoizedState: { holder: { current: {} } } };
      const harness = createHarness(
        { appServerStatusAtoms: [{ scope: {} }] },
        {
          __codexRoot: { _internalRoot: { current: root } },
        },
        budget === "object" ? { objectScanLimit: 1 } : { fieldScanLimit: 1 },
      );
      expect(harness.api.codexCurrentAppServerScopeHints(true)).toEqual([]);
      expect(harness.state.scopedAppServerScopeHintScanComplete).toBe(false);
      expect(harness.state.scopedAppServerScopeHintScan).toMatchObject({
        status: "capped",
        reason: budget === "object" ? "object_limit" : "field_limit",
      });
      await harness.api.codexRendererScopeCandidates();
      expect(harness.state.scopedAppServerScopeScanComplete).toBe(false);
      expect(harness.state.scopedAppServerScopeScan).toMatchObject({
        status: "capped",
        reason: budget === "object" ? "object_limit" : "field_limit",
      });
      expect(harness.state.scopedAppServerScopeLastSettledScan).toMatchObject({
        status: "capped",
        reason: budget === "object" ? "object_limit" : "field_limit",
      });
      expect(harness.api.codexRendererScopeSnapshotIsCurrent()).toBe(false);
    },
  );

  it("rejects newly added nested data edges without invoking existing getters", async () => {
    const getter = vi.fn(() => {
      throw new Error("Discovery accessors must not run");
    });
    const holder = Object.defineProperty({}, "lazy", {
      configurable: true,
      get: getter,
    });
    const root: Record<string, unknown> = { memoizedState: { holder } };
    let child = root;
    for (let index = 0; index < 150; index += 1) {
      const next = {};
      child.child = next;
      child = next;
    }
    const harness = createHarness(
      {},
      {
        __codexRoot: { _internalRoot: { current: root } },
      },
      {
        yieldDiscovery: async () => {
          Object.defineProperty(holder, "added", { value: {} });
        },
      },
    );
    await harness.api.codexRendererScopeCandidates();
    expect(harness.state.scopedAppServerScopeScanComplete).toBe(false);
    expect(getter).not.toHaveBeenCalled();
  });

  it("invalidates retained provenance after publication before reusing a changed nested ref", async () => {
    const client = new QueryClient();
    const oldScope = createScope(client);
    const newScope = createScope(client);
    const ref = { current: oldScope };
    const root = { memoizedState: { memoizedState: ref } };
    const harness = createHarness(
      {},
      { __codexRoot: { _internalRoot: { current: root } } },
    );
    try {
      expect((await harness.api.codexRendererScopeCandidates())[0]).toBe(
        oldScope,
      );
      expect(harness.api.codexRendererScopeSnapshotIsCurrent()).toBe(true);
      ref.current = newScope;
      expect(harness.api.codexRendererScopeSnapshotIsCurrent()).toBe(false);
      const refreshed = await harness.api.codexRendererScopeCandidates();
      expect(refreshed).toHaveLength(1);
      expect(refreshed[0]).toBe(newScope);
      expect(harness.api.codexRendererScopeSnapshotIsCurrent()).toBe(true);
    } finally {
      client.clear();
    }
  });

  it("does not lose a mutation generation change when pending nodes are drained during a scan", async () => {
    const root: Record<string, unknown> = {};
    let child = root;
    for (let index = 0; index < 150; index += 1) {
      const next = {};
      child.child = next;
      child = next;
    }
    const state: State = {
      reactMutationGeneration: 1,
      pendingReactNodes: new Set(),
    };
    const harness = createHarness(
      state,
      { __codexRoot: { _internalRoot: { current: root } } },
      {
        yieldDiscovery: async () => {
          state.reactMutationGeneration = 2;
          state.pendingReactNodes!.clear();
        },
      },
    );
    await harness.api.codexRendererScopeCandidates();
    expect(state.scopedAppServerScopeScanComplete).toBe(false);
  });

  it("shares one in-flight owner inventory instead of racing concurrent walks", async () => {
    const root: Record<string, unknown> = {};
    let child = root;
    for (let index = 0; index < 150; index += 1) {
      const next = {};
      child.child = next;
      child = next;
    }
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const yieldDiscovery = vi.fn(() => gate);
    const harness = createHarness(
      {},
      { __codexRoot: { _internalRoot: { current: root } } },
      { yieldDiscovery },
    );
    const first = harness.api.codexRendererScopeCandidates();
    const second = harness.api.codexRendererScopeCandidates();
    try {
      expect(yieldDiscovery).toHaveBeenCalledTimes(1);
    } finally {
      release!();
      await Promise.all([first, second]);
    }
    expect(harness.state.scopedAppServerScopeScan).toMatchObject({
      status: "complete",
      visitedFiberCount: 151,
      fiberLimit: 30000,
      scopeCount: 0,
    });
  });

  it("does not treat JSX debug owners as current scopes but keeps ordinary nested props", async () => {
    const client = new QueryClient();
    const current = createScope(client);
    const stale = createScope(client);
    const readAccessor = vi.fn(() => {
      throw new Error("An uncertain current owner must not be read");
    });
    Object.defineProperty(current.node, "queryClient", { get: readAccessor });
    const root = {
      memoizedProps: {
        children: {
          $$typeof: Symbol.for("react.transitional.element"),
          props: { provider: current },
          _owner: { memoizedState: { scope: stale } },
        },
      },
    };
    const harness = createHarness(
      {},
      { __codexRoot: { _internalRoot: { current: root } } },
    );
    try {
      expect(
        (await harness.api.codexRendererScopeCandidates()).map((value) =>
          value === current ? "current" : "stale",
        ),
      ).toEqual(["current"]);
      expect(readAccessor).not.toHaveBeenCalled();
    } finally {
      client.clear();
    }
  });

  it("keeps an unknown application _owner field in the owner inventory", async () => {
    const client = new QueryClient();
    const unknown = createScope(client);
    const root = { memoizedProps: { _owner: { provider: unknown } } };
    const harness = createHarness(
      {},
      {
        __codexRoot: { _internalRoot: { current: root } },
      },
    );
    try {
      const found = await harness.api.codexRendererScopeCandidates();
      expect(found).toHaveLength(1);
      expect(found[0]).toBe(unknown);
    } finally {
      client.clear();
    }
  });

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

  it("reads the installed retained-node forwarding triple without using a getter's overridden call", () => {
    const client = new QueryClient();
    const n = { parent: {}, queryClient: client, value: {} };
    const queryGetter = () => n.queryClient;
    const overriddenCall = vi.fn(() => {
      throw new Error(
        "Validated forwarding getter call must use the intrinsic",
      );
    });
    Object.defineProperty(queryGetter, "call", { get: overriddenCall });
    const retainedNode = {};
    Object.defineProperties(retainedNode, {
      parent: {
        get: () => n.parent,
        configurable: true,
        enumerable: true,
      },
      queryClient: {
        get: queryGetter,
        configurable: true,
        enumerable: true,
      },
      value: {
        get: () => n.value,
        configurable: true,
        enumerable: true,
      },
    });
    const scope = {
      ...createScope(client),
      node: retainedNode,
    };
    const harness = createHarness();
    try {
      expect(harness.api.codexScopeQueryClient(scope)).toBe(client);
      expect(overriddenCall).not.toHaveBeenCalled();
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
  it("does not re-expand one shared object for every Fiber", async () => {
    const client = new QueryClient();
    const scope = createScope(client);
    const shared = { __sharedExpansionMarker: { scope } };
    const root: Record<string, unknown> = {
      memoizedState: { shared },
    };
    let fiber = root;
    for (let index = 0; index < 64; index += 1) {
      const next = { memoizedState: { shared } };
      fiber.child = next;
      fiber = next;
    }
    const harness = createHarness(
      {},
      { __codexRoot: { _internalRoot: { current: root } } },
      { objectScanLimit: 70 },
    );
    const originalEntries = Object.entries;
    let sharedExpansionCount = 0;
    vi.spyOn(Object, "entries").mockImplementation((value) => {
      const entries = originalEntries(value);
      if (entries.some(([key]) => key === "__sharedExpansionMarker"))
        sharedExpansionCount += 1;
      return entries;
    });
    try {
      const found = await harness.api.codexRendererScopeCandidates();
      expect(found).toEqual([scope]);
      expect(harness.state.scopedAppServerScopeScanComplete).toBe(true);
      expect(sharedExpansionCount).toBe(1);
    } finally {
      vi.restoreAllMocks();
      client.clear();
    }
  });

  it("re-expands a shared object reached later at a shallower depth", async () => {
    const client = new QueryClient();
    const scope = createScope(client);
    const shared = { next: { next: { scope } } };
    const root = {
      memoizedState: { a: { b: { c: shared } } },
      child: { memoizedState: shared },
    };
    const harness = createHarness(
      {},
      { __codexRoot: { _internalRoot: { current: root } } },
    );
    try {
      const found = await harness.api.codexRendererScopeCandidates();
      expect(found).toEqual([scope]);
      expect(harness.state.scopedAppServerScopeScanComplete).toBe(true);
      expect(harness.api.codexRendererScopeSnapshotIsCurrent()).toBe(true);
      shared.next.next.scope = createScope(client);
      expect(harness.api.codexRendererScopeSnapshotIsCurrent()).toBe(false);
    } finally {
      client.clear();
    }
  });
});
