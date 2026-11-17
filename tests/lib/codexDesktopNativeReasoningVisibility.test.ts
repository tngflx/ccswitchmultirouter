import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const resources = path.resolve(
  process.cwd(),
  "src-tauri/src/resources/codex_desktop",
);
const discovery = readFileSync(
  path.join(resources, "client_discovery.js"),
  "utf8",
);
const pickerCore = readFileSync(
  path.join(resources, "model_picker_core.js"),
  "utf8",
);
const nativePath = path.join(resources, "native_reasoning_visibility.js");
const native = existsSync(nativePath) ? readFileSync(nativePath, "utf8") : "";
const allEfforts = ["low", "medium", "high", "xhigh", "max", "ultra"];
type Result = {
  status: "not_required" | "known" | "unverified";
  missingEfforts: string[];
};
type State = {
  nativeReasoningVisibilityRequired?: boolean;
  nativeReasoningVisibilityAtoms?: unknown;
  scopedAppServerScopeCandidates?: unknown;
  scopedAppServerScopeScanComplete?: boolean;
  scopedAppServerRootIdentities?: object[];
  reasoningQueryCaches?: Map<object, object>;
  modelPickerQueryClients?: Map<object, object>;
  nativeReasoningVisibilityPatches?: Map<object, object>;
  nativeReasoningVisibilityPowerPatches?: Map<object, object>;
  nativeReasoningVisibilityEnabled?: boolean;
  payload?: {
    catalogAvailable?: boolean;
    modelProvider?: string;
    modelNames?: string[];
    models?: Record<string, unknown>[];
  };
  pendingReactNodes?: Set<object>;
  nativeReasoningVisibilityFiberPath?: (button: object) => object[] | null;
};
const fixtureRoot = {};
const fixtureWindow = {
  __codexRoot: { _internalRoot: { current: fixtureRoot } },
};
type FixtureDocument = {
  getElementById: () => null;
  querySelectorAll?: () => object[];
};
const fixtureDocument: FixtureDocument = { getElementById: () => null };
const createReader = (state: State) =>
  new Function(
    "state",
    "window",
    "document",
    `${discovery}\n${native}\nreturn typeof readCodexNativeReasoningVisibility === "function"
      ? readCodexNativeReasoningVisibility
      : () => ({ status: "not_required", missingEfforts: [] });`,
  )(state, fixtureWindow, fixtureDocument) as (
    cache: object,
    efforts: unknown,
  ) => Result;
const createAtom = () => ({
  scope: {},
  resolve: vi.fn(() => {
    throw new Error("The diagnostic must not resolve an atom directly");
  }),
});
const createScope = <T>(cache: object, enabled: T) => {
  const client = {
    getQueryCache: vi.fn(() => cache),
    getQueryData: vi.fn(),
    setQueryData: vi.fn(),
  };
  const scopeGetter = vi.fn(() => {
    throw new Error("The modern scope getter must not run");
  });
  const scope = {
    chain: {},
    node: { queryClient: client },
    get: vi.fn((_atom: object) => enabled),
    set: vi.fn(),
    watch: vi.fn(),
    get queryClient() {
      return scopeGetter();
    },
  };
  return { scope, client, scopeGetter };
};
const createState = (atom: object, ...scopes: object[]): State => ({
  nativeReasoningVisibilityRequired: true,
  nativeReasoningVisibilityAtoms: [atom],
  scopedAppServerScopeCandidates: new Set(scopes),
  scopedAppServerScopeScanComplete: true,
  scopedAppServerRootIdentities: [fixtureRoot],
  payload: {
    catalogAvailable: true,
    modelProvider: "codex_model_router_v2",
    modelNames: ["fixture"],
    models: [{ model: "fixture", supported_reasoning_levels: [...allEfforts] }],
  },
});

describe("Codex Desktop read-only native reasoning visibility", () => {
  it("does not read scopes or atoms when the native consumer does not require proof", () => {
    const cache = {};
    const atom = createAtom();
    const { scope } = createScope(cache, new Set(allEfforts));
    const state = createState(atom, scope);
    state.nativeReasoningVisibilityRequired = false;
    expect(createReader(state)(cache, allEfforts)).toEqual({
      status: "not_required",
      missingEfforts: [],
    });
    expect(scope.get).not.toHaveBeenCalled();
    expect(atom.resolve).not.toHaveBeenCalled();
  });

  it.each([undefined, [], [{}, {}], [{}], Object.create([createAtom()])])(
    "fails closed without exactly one validated current native atom (%j)",
    (atoms) => {
      const cache = {};
      const { scope } = createScope(cache, new Set(allEfforts));
      const state = createState(createAtom(), scope);
      state.nativeReasoningVisibilityAtoms = atoms;
      expect(createReader(state)(cache, allEfforts)).toEqual({
        status: "unverified",
        missingEfforts: [],
      });
      expect(scope.get).not.toHaveBeenCalled();
    },
  );

  it("does not invoke atom accessors or inherited atom metadata", () => {
    const cache = {};
    const { scope } = createScope(cache, new Set(allEfforts));
    const getter = vi.fn(() => ({}));
    for (const atom of [
      Object.defineProperty({ resolve() {} }, "scope", { get: getter }),
      Object.create(createAtom()),
    ]) {
      expect(
        createReader(createState(atom, scope))(cache, allEfforts).status,
      ).toBe("unverified");
    }
    const atoms = Object.defineProperty([], "0", { get: getter });
    const state = createState(createAtom(), scope);
    state.nativeReasoningVisibilityAtoms = atoms;
    expect(createReader(state)(cache, allEfforts).status).toBe("unverified");
    expect(getter).not.toHaveBeenCalled();
    expect(scope.get).not.toHaveBeenCalled();
  });

  it("fails closed when the scope scan was capped or otherwise incomplete", () => {
    const cache = {};
    const atom = createAtom();
    const { scope } = createScope(cache, new Set(allEfforts));
    const state = createState(atom, scope);
    state.scopedAppServerScopeScanComplete = false;
    expect(createReader(state)(cache, allEfforts)).toEqual({
      status: "unverified",
      missingEfforts: [],
    });
    expect(scope.get).not.toHaveBeenCalled();
  });

  it("rejects a retained complete scan immediately when its React root was replaced", () => {
    const cache = {};
    const atom = createAtom();
    const { scope } = createScope(cache, new Set(allEfforts));
    const state = createState(atom, scope);
    state.scopedAppServerRootIdentities = [{}];
    expect(createReader(state)(cache, allEfforts)).toEqual({
      status: "unverified",
      missingEfforts: [],
    });
    expect(createCurrentCacheReader(state)()).toBeNull();
    expect(scope.get).not.toHaveBeenCalled();
  });

  it("reads the exact native atom through a current modern same-cache scope without writing", () => {
    const cache = {};
    const atom = createAtom();
    const { scope, client, scopeGetter } = createScope(
      cache,
      new Set(allEfforts.slice(0, 4)),
    );
    expect(createReader(createState(atom, scope))(cache, allEfforts)).toEqual({
      status: "known",
      missingEfforts: ["max", "ultra"],
    });
    expect(scope.get).toHaveBeenCalledOnce();
    expect(scope.get).toHaveBeenCalledWith(atom);
    expect(client.getQueryCache).toHaveBeenCalledOnce();
    expect(scopeGetter).not.toHaveBeenCalled();
    expect(atom.resolve).not.toHaveBeenCalled();
    expect(scope.set).not.toHaveBeenCalled();
    expect(scope.watch).not.toHaveBeenCalled();
    expect(client.getQueryData).not.toHaveBeenCalled();
    expect(client.setQueryData).not.toHaveBeenCalled();
  });

  it("reads fresh native visibility rather than caching preference values", () => {
    const cache = {};
    const atom = createAtom();
    const enabled = new Set(allEfforts.slice(0, 4));
    const { scope } = createScope(cache, enabled);
    const read = createReader(createState(atom, scope));
    expect(read(cache, allEfforts).missingEfforts).toEqual(["max", "ultra"]);
    enabled.add("max");
    enabled.add("ultra");
    expect(read(cache, allEfforts)).toEqual({
      status: "known",
      missingEfforts: [],
    });
    expect(scope.get).toHaveBeenCalledTimes(2);
  });

  it("uses intrinsic Set brand and membership checks, never result accessors or iterators", () => {
    const cache = {};
    const atom = createAtom();
    const getter = vi.fn(() => {
      throw new Error("Set accessors must not run");
    });
    const enabled = new Set(allEfforts);
    Object.defineProperty(enabled, "has", { get: getter });
    Object.defineProperty(enabled, Symbol.iterator, { get: getter });
    const { scope } = createScope(cache, enabled);
    expect(createReader(createState(atom, scope))(cache, allEfforts)).toEqual({
      status: "known",
      missingEfforts: [],
    });
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([null, [], {}, new Proxy(new Set(allEfforts), {})])(
    "rejects a malformed native visibility result (%j)",
    (enabled) => {
      const cache = {};
      const { scope } = createScope(cache, enabled);
      expect(
        createReader(createState(createAtom(), scope))(cache, allEfforts),
      ).toEqual({ status: "unverified", missingEfforts: [] });
    },
  );

  it("does not invoke fake Set has methods or has accessors", () => {
    const cache = {};
    const has = vi.fn(() => true);
    const getter = vi.fn(() => has);
    for (const enabled of [
      { has },
      Object.defineProperty({}, "has", { get: getter }),
    ]) {
      const { scope } = createScope(cache, enabled);
      expect(
        createReader(createState(createAtom(), scope))(cache, allEfforts)
          .status,
      ).toBe("unverified");
    }
    expect(has).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
  });

  it("never uses historical owners after a scope is removed or its cache is replaced", () => {
    const cache = {};
    const replacement = {};
    const atom = createAtom();
    const { scope, client } = createScope(cache, new Set(allEfforts));
    const state = createState(atom, scope);
    state.reasoningQueryCaches = new Map([[cache, {}]]);
    state.modelPickerQueryClients = new Map([[cache, client]]);
    const read = createReader(state);
    expect(read(cache, allEfforts).status).toBe("known");
    state.scopedAppServerScopeCandidates = new Set();
    expect(read(cache, allEfforts).status).toBe("unverified");
    state.scopedAppServerScopeCandidates = new Set([scope]);
    client.getQueryCache.mockReturnValue(replacement);
    expect(read(cache, allEfforts).status).toBe("unverified");
    expect(scope.get).toHaveBeenCalledOnce();
  });

  it("does not read arbitrary scope atoms before validating the declared owner and cache", () => {
    const cache = {};
    const otherCache = {};
    const atom = createAtom();
    const getter = vi.fn(() => {
      throw new Error("Unrelated scope getter must not run");
    });
    const wrong = createScope(otherCache, new Set(allEfforts));
    const malformed = Object.defineProperty({}, "get", { get: getter });
    const nodeAccessor = createScope(cache, new Set(allEfforts));
    Object.defineProperty(nodeAccessor.scope.node, "queryClient", {
      get: getter,
    });
    const state = createState(atom, wrong.scope, malformed, nodeAccessor.scope);
    expect(createReader(state)(cache, allEfforts)).toEqual({
      status: "unverified",
      missingEfforts: [],
    });
    expect(wrong.scope.get).not.toHaveBeenCalled();
    expect(nodeAccessor.scope.get).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
    expect(atom.resolve).not.toHaveBeenCalled();
  });

  it("fails closed on the first matching owner read error instead of borrowing another scope", () => {
    const cache = {};
    const atom = createAtom();
    const first = createScope(cache, new Set(allEfforts));
    const second = createScope(cache, new Set(allEfforts));
    first.scope.get.mockImplementation(() => {
      throw new Error("Native visibility unavailable");
    });
    expect(
      createReader(createState(atom, first.scope, second.scope))(
        cache,
        allEfforts,
      ),
    ).toEqual({
      status: "unverified",
      missingEfforts: [],
    });
    expect(second.scope.get).not.toHaveBeenCalled();
  });

  it("accepts a current owner after 691 aliases but bounds total scope reads at 2048", () => {
    const cache = {};
    const atom = createAtom();
    const wrong = createScope({}, new Set(allEfforts));
    const good = createScope(cache, new Set(allEfforts));
    const aliases = Array.from({ length: 691 }, () =>
      Object.defineProperties(
        {},
        Object.getOwnPropertyDescriptors(wrong.scope),
      ),
    );
    expect(
      createReader(createState(atom, ...aliases, good.scope))(cache, allEfforts)
        .status,
    ).toBe("known");
    good.scope.get.mockClear();
    const capped = Array.from({ length: 2048 }, () =>
      Object.defineProperties(
        {},
        Object.getOwnPropertyDescriptors(wrong.scope),
      ),
    );
    expect(
      createReader(createState(atom, ...capped, good.scope))(cache, allEfforts)
        .status,
    ).toBe("unverified");
    expect(good.scope.get).not.toHaveBeenCalled();
    expect(wrong.scope.get).not.toHaveBeenCalled();
  });

  it("rejects malformed or accessor canonical effort input without a native read", () => {
    const cache = {};
    const atom = createAtom();
    const { scope } = createScope(cache, new Set(allEfforts));
    const getter = vi.fn(() => "max");
    const read = createReader(createState(atom, scope));
    for (const efforts of [
      null,
      {},
      ["max", 1],
      Object.defineProperty([], "0", { get: getter }),
    ]) {
      expect(read(cache, efforts)).toEqual({
        status: "unverified",
        missingEfforts: [],
      });
    }
    expect(scope.get).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
  });
});

describe("Codex Desktop managed native graded-effort reconciliation", () => {
  it("notifies the explicit picker refresh boundary without mutating native scope state", () => {
    const cache = createManagedCache();
    const atom = createAtom();
    const enabled = new Set(allEfforts.slice(0, 4));
    const { scope } = createScope(cache, enabled);
    const refreshNative = vi.fn();
    const refreshFallback = vi.fn();
    const legacyRefresh = vi.fn();
    const state = createState(atom, scope);
    state.reasoningQueryCaches = new Map<object, object>([
      [cache, { refreshNative, refresh: refreshFallback }],
      [{}, { refresh: legacyRefresh }],
    ]);
    const reconcile = createReconciler(state);

    expect(reconcile(["max"])).toMatchObject({
      status: "known",
      managed: true,
      patchedScopes: 1,
    });
    expect(refreshNative).toHaveBeenCalledOnce();
    expect(refreshFallback).not.toHaveBeenCalled();
    expect(legacyRefresh).toHaveBeenCalledOnce();
    expect(scope.set).not.toHaveBeenCalled();
    expect(scope.watch).not.toHaveBeenCalled();
  });

  it("projects missing graded efforts into mounted native picker props and restores them", () => {
    const cache = createManagedCache();
    const atom = createAtom();
    const enabled = new Set(allEfforts.slice(0, 4));
    const { scope } = createScope(cache, enabled);
    const originalSelections = allEfforts
      .filter((effort) => effort !== "max")
      .map((reasoningEffort, powerSettingIndex) => ({
        id: `fixture:${reasoningEffort}`,
        model: "fixture",
        modelLabel: "Fixture",
        reasoningEffort,
        powerSettingIndex,
        isLocked: false,
      }));
    const props = {
      selectedLabelCandidate: {
        id: "fixture:ultra",
        model: "fixture",
        modelLabel: "Fixture",
        reasoningEffort: "ultra",
      },
      onSelectPower: vi.fn(),
      powerSelections: originalSelections,
      triggerConfig: {},
    };
    const fiber = { memoizedProps: props };
    const button = {
      isConnected: true,
      closest: vi.fn(() => button),
    };
    const marker = { closest: vi.fn(() => button) };
    const state = createState(atom, scope);
    state.nativeReasoningVisibilityFiberPath = () => [fiber];
    const reconcile = createReconciler(state, {
      getElementById: () => null,
      querySelectorAll: () => [marker],
    });

    expect(reconcile(allEfforts)).toMatchObject({
      status: "known",
      managed: true,
      patchedScopes: 1,
    });
    expect(props.powerSelections.map((row) => row.reasoningEffort)).toEqual(
      allEfforts,
    );
    expect(props.powerSelections).not.toBe(originalSelections);
    expect(state.nativeReasoningVisibilityPowerPatches?.size).toBe(1);

    expect(reconcile([])).toMatchObject({ managed: false, restoredScopes: 1 });
    expect(props.powerSelections).toBe(originalSelections);
    expect(state.nativeReasoningVisibilityPowerPatches?.size).toBe(0);
  });

  it("wraps only the exact current managed scope and restores it on release", () => {
    const cache = createManagedCache();
    const atom = createAtom();
    const enabled = new Set(allEfforts.slice(0, 4));
    const { scope } = createScope(cache, enabled);
    const originalGet = scope.get;
    const state = createState(atom, scope);
    const reconcile = createReconciler(state);

    expect(reconcile(["low", "high", "max"])).toMatchObject({
      status: "known",
      managed: true,
      patchedScopes: 1,
    });
    expect(scope.get(atom)).toEqual(new Set([...enabled, "max"]));
    expect(originalGet).toHaveBeenCalledWith(atom);
    expect(reconcile(["low", "high", "max"]).patchedScopes).toBe(1);
    expect(state.nativeReasoningVisibilityPatches?.size).toBe(1);

    const restore = new Function(
      "state",
      "window",
      "document",
      `${discovery}\n${native}\nreturn restoreCodexNativeReasoningVisibility;`,
    )(state, fixtureWindow, fixtureDocument) as () => number;
    expect(restore()).toBe(1);
    expect(scope.get).toBe(originalGet);
    expect(scope.get(atom)).toBe(enabled);
    expect(state.nativeReasoningVisibilityPatches?.size).toBe(0);
  });

  it.each([
    {
      name: "Boolean transport aliases",
      row: {
        supported_reasoning_levels: [],
        ccSwitchReasoningControl: {
          kind: "boolean",
          disableAllowed: true,
          fingerprint: "fixture-boolean",
        },
      },
      requested: ["none", "medium"],
    },
    {
      name: "budget-only control with residual levels",
      row: {
        supported_reasoning_levels: ["high"],
        reasoning: { controlKind: "budget" },
      },
      requested: ["high"],
    },
    {
      name: "synthetic Ultra overlay",
      row: { supported_reasoning_levels: ["ultra"] },
      requested: ["ultra"],
    },
    {
      name: "reasoning-disabled token",
      row: { supported_reasoning_levels: ["none"] },
      requested: ["none"],
    },
    {
      name: "unknown native enum",
      row: { supported_reasoning_levels: ["fixture-unknown-effort"] },
      requested: ["fixture-unknown-effort"],
    },
  ])(
    "does not create a graded visibility bridge for $name",
    ({ row, requested }) => {
      const cache = createManagedCache();
      const atom = createAtom();
      const enabled = new Set<string>();
      const { scope } = createScope(cache, enabled);
      const originalGet = scope.get;
      const state = createState(atom, scope);
      state.payload!.models = [{ model: "fixture", ...row }];
      const reconcile = createReconciler(state);
      expect(reconcile(requested)).toMatchObject({
        status: "known",
        managed: false,
        patchedScopes: 0,
      });
      expect(scope.get).toBe(originalGet);
      expect(scope.get).not.toHaveBeenCalled();
      expect([...enabled]).toEqual([]);
    },
  );

  it("does not augment a borrowed getter or a scope whose renderer owner became uncertain", () => {
    const cache = createManagedCache();
    const atom = createAtom();
    const enabled = new Set(allEfforts.slice(0, 4));
    const { scope } = createScope(cache, enabled);
    const originalGet = scope.get;
    const state = createState(atom, scope);
    const reconcile = createReconciler(state);
    expect(reconcile(["max"]).patchedScopes).toBe(1);
    const patchedGet = scope.get;
    const foreignThis = createScope(cache, enabled).scope;

    expect(patchedGet.call(foreignThis, atom)).toBe(enabled);
    state.pendingReactNodes = new Set([{}]);
    expect(scope.get(atom)).toBe(enabled);
    expect(state.nativeReasoningVisibilityEnabled).toBe(true);
    expect(originalGet).toHaveBeenCalledTimes(3);
  });

  it("fails closed for foreign caches and incomplete ownership without reading native atoms", () => {
    const localCache = createManagedCache();
    const foreignCache = { getAll: () => [] };
    const atom = createAtom();
    const local = createScope(foreignCache, new Set(allEfforts));
    const state = createState(atom, local.scope);
    const reconcile = createReconciler(state);
    expect(reconcile(["max"])).toMatchObject({
      status: "unverified",
      patchedScopes: 0,
    });
    expect(local.scope.get).not.toHaveBeenCalled();

    const incomplete = createScope(localCache, new Set(allEfforts));
    Object.defineProperty(incomplete.scope.node, "queryClient", {
      value: null,
    });
    state.scopedAppServerScopeCandidates = new Set([incomplete.scope]);
    expect(reconcile(["max"])).toMatchObject({
      status: "unverified",
      patchedScopes: 0,
    });
    expect(incomplete.scope.get).not.toHaveBeenCalled();
  });

  it("stops exposing removed efforts and restores the wrapper when no native effort remains", () => {
    const cache = createManagedCache();
    const atom = createAtom();
    const enabled = new Set(allEfforts.slice(0, 4));
    const { scope } = createScope(cache, enabled);
    const originalGet = scope.get;
    const state = createState(atom, scope);
    const reconcile = createReconciler(state);
    expect(reconcile(["max"]).patchedScopes).toBe(1);
    state.payload!.models![0].supported_reasoning_levels = ["low", "high"];
    expect(reconcile(["low", "high"])).toMatchObject({
      managed: true,
      patchedScopes: 1,
    });
    expect(scope.get(atom)).toBe(enabled);
    expect(scope.get(atom).has("max")).toBe(false);
    state.payload!.models![0].supported_reasoning_levels = [];
    expect(reconcile([])).toMatchObject({ managed: false, restoredScopes: 1 });
    expect(scope.get).toBe(originalGet);
    expect(scope.get(atom)).toBe(enabled);
  });
});

const createReconciler = (state: State, document = fixtureDocument) =>
  new Function(
    "state",
    "window",
    "document",
    `const nativeBooleanCurrentFiberPath = state.nativeReasoningVisibilityFiberPath;
    const codexPickerOwnData = (value, key) => {
      if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
      const field = Object.getOwnPropertyDescriptor(value, key);
      return field && "value" in field ? field.value : undefined;
    };
    const codexPickerDataArray = (value) => Array.isArray(value) ? Array.from({ length: value.length }, (_, index) => value[index]) : [];
    ${pickerCore}
    ${discovery}\n${native}\nreturn reconcileCodexNativeReasoningVisibility;`,
  )(state, fixtureWindow, document) as (efforts: unknown) => {
    status: string;
    managed: boolean;
    patchedScopes: number;
    restoredScopes: number;
    refusalReason: string | null;
    ownerScopeCount: number;
    ownerFailureCounts: Record<string, number>;
  };
const createManagedCache = () => ({
  getAll: () => [
    {
      queryKey: [
        "models",
        "list",
        "local",
        "apikey",
        "provider",
        "codex_model_router_v2",
      ],
    },
  ],
});

const createCurrentCacheReader = (state: State) =>
  new Function(
    "state",
    "window",
    "document",
    `${discovery}\n${native}\nreturn typeof codexCurrentNativeReasoningQueryCaches === "function"
      ? codexCurrentNativeReasoningQueryCaches
      : () => null;`,
  )(state, fixtureWindow, fixtureDocument) as () => Set<object> | null;

const createScannedReconciler = (state: State, root: object) =>
  new Function(
    "state",
    "window",
    "document",
    "monotonicNow",
    "yieldReactDiscovery",
    `const codexPickerOwnData = (value, key) => {
      const field = value && Object.getOwnPropertyDescriptor(value, key);
      return field && "value" in field ? field.value : undefined;
    };
    const codexPickerDataArray = (value) => Array.isArray(value) ? [...value] : [];
    ${pickerCore}
${discovery}
${native}
return {
      scan: codexRendererScopeCandidates,
      snapshotCurrent: codexRendererScopeSnapshotIsCurrent,
      caches: codexCurrentNativeReasoningQueryCaches,
      reconcile: reconcileCodexNativeReasoningVisibility,
    };`,
  )(
    state,
    { __codexRoot: { _internalRoot: { current: root } } },
    fixtureDocument,
    () => 0,
    async () => {},
  ) as {
    scan: () => Promise<object[]>;
    snapshotCurrent: () => boolean;
    caches: () => Set<object> | null;
    reconcile: ReturnType<typeof createReconciler>;
  };

describe("Codex Desktop retained native ownership provenance", () => {
  it("returns the native baseline from a wrapped scope whose retained nested path changed", async () => {
    const cache = createManagedCache();
    const atom = createAtom();
    const enabled = new Set(["high"]);
    const first = createScope(cache, enabled);
    const second = createScope(cache, enabled);
    const ref = { current: first.scope };
    const api = createScannedReconciler(createState(atom, first.scope), {
      memoizedState: { memoizedState: ref },
    });
    await api.scan();
    expect(api.reconcile(["max"]).status).toBe("known");
    expect(first.scope.get(atom).has("max")).toBe(true);
    ref.current = second.scope;
    expect(first.scope.get(atom)).toBe(enabled);
    expect(api.snapshotCurrent()).toBe(false);
    expect(api.caches()).toBeNull();
    expect(api.reconcile(["max"])).toMatchObject({
      status: "unverified",
      restoredScopes: 1,
    });
  });

  it("refreshes mounted picker observers after refusing a stale owner snapshot", async () => {
    const cache = createManagedCache();
    const atom = createAtom();
    const enabled = new Set(["high"]);
    const first = createScope(cache, enabled);
    const second = createScope(cache, enabled);
    const ref = { current: first.scope };
    const refreshNative = vi.fn();
    const state = createState(atom, first.scope);
    state.reasoningQueryCaches = new Map([[cache, { refreshNative }]]);
    const api = createScannedReconciler(state, {
      memoizedState: { memoizedState: ref },
    });
    await api.scan();
    expect(api.reconcile(["max"]).status).toBe("known");
    const afterKnown = refreshNative.mock.calls.length;
    ref.current = second.scope;
    expect(api.snapshotCurrent()).toBe(false);
    expect(api.reconcile(["max"])).toMatchObject({
      status: "unverified",
      restoredScopes: 1,
    });
    expect(refreshNative.mock.calls.length).toBeGreaterThan(afterKnown);
  });

  it("does not certify readiness when an unknown owner is added after publication", async () => {
    const cache = createManagedCache();
    const atom = createAtom();
    const first = createScope(cache, new Set(["high"]));
    const unknown = createScope(cache, new Set(["high"]));
    const accessor = vi.fn(() => {
      throw new Error("Unknown owner getter must not run");
    });
    Object.defineProperty(unknown.scope.node, "queryClient", { get: accessor });
    const holder: Record<string, unknown> = { current: first.scope };
    const api = createScannedReconciler(createState(atom, first.scope), {
      memoizedState: { holder },
    });
    await api.scan();
    expect(api.reconcile(["max"]).status).toBe("known");
    holder.added = unknown.scope;
    expect(api.snapshotCurrent()).toBe(false);
    expect(api.caches()).toBeNull();
    expect(api.reconcile(["max"]).status).toBe("unverified");
    await api.scan();
    expect(api.caches()).toBeNull();
    expect(api.reconcile(["max"])).toMatchObject({
      status: "unverified",
      patchedScopes: 0,
      ownerFailureCounts: { node_client_accessor: 1 },
    });
    expect(accessor).not.toHaveBeenCalled();
  });

  it("checks only the wrapped scope path rather than rescanning unrelated provenance per native read", async () => {
    const cache = createManagedCache();
    const atom = createAtom();
    const first = createScope(cache, new Set(["high"]));
    const ownKeys = vi.fn((target: object) => Reflect.ownKeys(target));
    const noise = new Proxy({ retained: {} }, { ownKeys });
    const api = createScannedReconciler(createState(atom, first.scope), {
      memoizedState: { scope: first.scope, noise },
    });
    await api.scan();
    expect(api.reconcile(["max"]).status).toBe("known");
    ownKeys.mockClear();
    for (let index = 0; index < 50; index += 1)
      expect(first.scope.get(atom).has("max")).toBe(true);
    expect(ownKeys).not.toHaveBeenCalled();
  });
});

describe("Codex Desktop complete current native cache ownership", () => {
  it("follows replacement and removal without reading preferences or retaining historical maps", () => {
    const first = {};
    const replacement = {};
    const { scope, client, scopeGetter } = createScope(
      first,
      new Set(allEfforts),
    );
    const state = createState(createAtom(), scope);
    state.reasoningQueryCaches = new Map([[first, {}]]);
    state.modelPickerQueryClients = new Map([[first, client]]);
    const read = createCurrentCacheReader(state);
    expect(read()).toEqual(new Set([first]));
    client.getQueryCache.mockReturnValue(replacement);
    expect(read()).toEqual(new Set([replacement]));
    state.scopedAppServerScopeCandidates = new Set();
    expect(read()).toBeNull();
    expect(scopeGetter).not.toHaveBeenCalled();
    expect(scope.get).not.toHaveBeenCalled();
    expect(scope.set).not.toHaveBeenCalled();
    expect(scope.watch).not.toHaveBeenCalled();
  });

  it("deduplicates initialized current caches across 691 scope aliases", () => {
    const cache = {};
    const { scope } = createScope(cache, new Set(allEfforts));
    const aliases = Array.from({ length: 691 }, () =>
      Object.defineProperties({}, Object.getOwnPropertyDescriptors(scope)),
    );
    expect(
      createCurrentCacheReader(createState(createAtom(), ...aliases))(),
    ).toEqual(new Set([cache]));
    expect(scope.get).not.toHaveBeenCalled();
  });

  it("requires a complete scope scan, including the exact 2048-entry boundary", () => {
    const cache = {};
    const { scope } = createScope(cache, new Set(allEfforts));
    const aliases = Array.from({ length: 2049 }, () =>
      Object.defineProperties({}, Object.getOwnPropertyDescriptors(scope)),
    );
    const state = createState(createAtom(), ...aliases.slice(0, 2048));
    const read = createCurrentCacheReader(state);
    expect(read()).toEqual(new Set([cache]));
    state.scopedAppServerScopeCandidates = new Set(aliases);
    expect(read()).toBeNull();
    expect(scope.get).not.toHaveBeenCalled();
  });

  it("does not certify a partial owner set when another expected owner is uninitialized", () => {
    const cache = {};
    const initialized = createScope(cache, new Set(allEfforts));
    const pending = createScope({}, new Set(allEfforts));
    Object.defineProperty(pending.scope.node, "queryClient", { value: null });
    expect(
      createCurrentCacheReader(
        createState(createAtom(), initialized.scope, pending.scope),
      )(),
    ).toBeNull();
    expect(initialized.scope.get).not.toHaveBeenCalled();
    expect(pending.scope.get).not.toHaveBeenCalled();
    expect(pending.scopeGetter).not.toHaveBeenCalled();
  });

  it("fails closed without traversing arbitrary scope or client accessors", () => {
    const cache = {};
    const getter = vi.fn(() => {
      throw new Error("Ownership accessor must not run");
    });
    const first = createScope(cache, new Set(allEfforts));
    const accessorClient = createScope(cache, new Set(allEfforts));
    Object.defineProperty(accessorClient.scope.node, "queryClient", {
      get: getter,
    });
    const accessorMethod = createScope(cache, new Set(allEfforts));
    Object.defineProperty(accessorMethod.client, "getQueryCache", {
      get: getter,
    });
    for (const uncertain of [
      {},
      accessorClient.scope,
      accessorMethod.scope,
      new Proxy(
        {},
        {
          getOwnPropertyDescriptor() {
            throw new Error("redacted");
          },
        },
      ),
    ]) {
      expect(
        createCurrentCacheReader(
          createState(createAtom(), first.scope, uncertain),
        )(),
      ).toBeNull();
    }
    expect(getter).not.toHaveBeenCalled();
    expect(first.scope.get).not.toHaveBeenCalled();
    expect(accessorClient.scope.get).not.toHaveBeenCalled();
    expect(accessorMethod.scope.get).not.toHaveBeenCalled();
  });

  it("returns unknown for malformed caches or a failing declared cache reader", () => {
    const { scope, client } = createScope({}, new Set(allEfforts));
    const read = createCurrentCacheReader(createState(createAtom(), scope));
    client.getQueryCache.mockImplementation(() => {
      throw new Error("Cache initialization unavailable");
    });
    expect(read()).toBeNull();
    client.getQueryCache.mockReturnValue(null as unknown as object);
    expect(read()).toBeNull();
    client.getQueryCache.mockReturnValue("invalid" as unknown as object);
    expect(read()).toBeNull();
    expect(scope.get).not.toHaveBeenCalled();
  });

  it.each([undefined, [], {}, new Set()])(
    "returns unknown without a usable current scope set (%j)",
    (scopes) => {
      const state: State = { scopedAppServerScopeCandidates: scopes };
      expect(createCurrentCacheReader(state)()).toBeNull();
    },
  );
});

it("does not prove native visibility from a malformed target cache and matching invalid cache result", () => {
  const atom = createAtom();
  const { scope, client } = createScope({}, new Set(allEfforts));
  client.getQueryCache.mockReturnValue(null as unknown as object);
  expect(
    createReader(createState(atom, scope))(
      null as unknown as object,
      allEfforts,
    ),
  ).toEqual({
    status: "unverified",
    missingEfforts: [],
  });
  expect(scope.get).not.toHaveBeenCalled();
});

describe("Codex Desktop native visibility refusal evidence", () => {
  it("reports a known owner without reading extra preferences or changing readiness", () => {
    const cache = createManagedCache();
    const atom = createAtom();
    const { scope, scopeGetter } = createScope(cache, new Set(["high"]));
    const result = createReconciler(createState(atom, scope))(["max"]);
    expect(result).toMatchObject({
      status: "known",
      refusalReason: null,
      ownerScopeCount: 1,
      patchedScopes: 1,
    });
    expect(Object.values(result.ownerFailureCounts)).toEqual(Array(13).fill(0));
    expect(scopeGetter).not.toHaveBeenCalled();
    expect(atom.resolve).not.toHaveBeenCalled();
  });

  it("accepts only the installed retained-node forwarding accessor triple", () => {
    const cache = createManagedCache();
    const atom = createAtom();
    const { scope, client } = createScope(cache, new Set(["high"]));
    const n = { parent: {}, queryClient: client, value: {} };
    const retainedNode = {};
    Object.defineProperties(retainedNode, {
      parent: {
        get: () => n.parent,
        configurable: true,
        enumerable: true,
      },
      queryClient: {
        get: () => n.queryClient,
        configurable: true,
        enumerable: true,
      },
      value: {
        get: () => n.value,
        configurable: true,
        enumerable: true,
      },
    });
    Object.defineProperty(scope, "node", {
      value: retainedNode,
      configurable: true,
    });
    const result = createReconciler(createState(atom, scope))(["max"]);
    expect(result).toMatchObject({
      status: "known",
      refusalReason: null,
      ownerScopeCount: 1,
      patchedScopes: 1,
    });
    expect(result.ownerFailureCounts.node_client_accessor).toBe(0);
  });

  it.each([
    "missing parent",
    "setter",
    "wrong forwarding source",
    "non-configurable",
  ] as const)(
    "rejects a malformed retained-node accessor triple: %s",
    (fault) => {
      const cache = createManagedCache();
      const atom = createAtom();
      const { scope, client } = createScope(cache, new Set(["high"]));
      const n = { parent: {}, queryClient: client, value: {} };
      const retainedNode = {};
      const descriptors: PropertyDescriptorMap = {
        parent: {
          get: () => n.parent,
          configurable: true,
          enumerable: true,
        },
        queryClient: {
          get: () => n.queryClient,
          configurable: true,
          enumerable: true,
        },
        value: {
          get: () => n.value,
          configurable: true,
          enumerable: true,
        },
      };
      if (fault === "missing parent") delete descriptors.parent;
      if (fault === "setter") descriptors.queryClient!.set = () => {};
      if (fault === "wrong forwarding source")
        descriptors.queryClient!.get = () => n.value;
      if (fault === "non-configurable") descriptors.value!.configurable = false;
      Object.defineProperties(retainedNode, descriptors);
      Object.defineProperty(scope, "node", {
        value: retainedNode,
        configurable: true,
      });
      const result = createReconciler(createState(atom, scope))(["max"]);
      expect(result).toMatchObject({
        status: "unverified",
        refusalReason: "owner_cache_inventory_unverified",
        ownerScopeCount: 1,
        ownerFailureCounts: { node_client_accessor: 1 },
        patchedScopes: 0,
      });
    },
  );

  it("distinguishes an absent modern slot from an explicitly uninitialized owner and keeps both fail closed", () => {
    for (const [slot, reason] of [
      [{}, "node_client_absent"],
      [{ queryClient: null }, "node_client_uninitialized"],
    ] as const) {
      const cache = createManagedCache();
      const first = createScope(cache, new Set(["high"]));
      const pending = createScope(cache, new Set(["high"]));
      Object.defineProperty(pending.scope, "node", { value: slot });
      const result = createReconciler(
        createState(createAtom(), first.scope, pending.scope),
      )(["max"]);
      expect(result).toMatchObject({
        status: "unverified",
        refusalReason: "owner_cache_inventory_unverified",
        ownerScopeCount: 2,
        ownerFailureCounts: { [reason]: 1 },
        patchedScopes: 0,
      });
      expect(
        Object.values(result.ownerFailureCounts).reduce((a, b) => a + b, 0),
      ).toBe(1);
      expect(first.scope.get).not.toHaveBeenCalled();
      expect(pending.scope.get).not.toHaveBeenCalled();
      expect(pending.scopeGetter).not.toHaveBeenCalled();
    }
  });

  it("reports accessor refusal without invoking it or inspecting later owners", () => {
    const getter = vi.fn(() => {
      throw new Error("secret-token-must-not-escape");
    });
    const first = createScope(createManagedCache(), new Set(["high"]));
    Object.defineProperty(first.scope.node, "queryClient", { get: getter });
    const later = createScope(createManagedCache(), new Set(["high"]));
    const result = createReconciler(
      createState(createAtom(), first.scope, later.scope),
    )(["max"]);
    expect(result).toMatchObject({
      status: "unverified",
      refusalReason: "owner_cache_inventory_unverified",
      ownerScopeCount: 1,
      ownerFailureCounts: { node_client_accessor: 1 },
      patchedScopes: 0,
    });
    expect(getter).not.toHaveBeenCalled();
    expect(later.client.getQueryCache).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it("reduces failing cache reads to a fixed reason without leaking exception data", () => {
    const { scope, client } = createScope(
      createManagedCache(),
      new Set(["high"]),
    );
    client.getQueryCache.mockImplementation(() => {
      throw new Error("secret-token-must-not-escape");
    });
    const result = createReconciler(createState(createAtom(), scope))(["max"]);
    expect(result).toMatchObject({
      status: "unverified",
      refusalReason: "owner_cache_inventory_unverified",
      ownerScopeCount: 1,
      ownerFailureCounts: { scope_read_failed: 1 },
      patchedScopes: 0,
    });
    expect(scope.get).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it("keeps a capped inventory unverified and exposes only bounded refusal counts", () => {
    const { scope } = createScope(createManagedCache(), new Set(["high"]));
    const aliases = Array.from({ length: 2049 }, () =>
      Object.defineProperties({}, Object.getOwnPropertyDescriptors(scope)),
    );
    const result = createReconciler(createState(createAtom(), ...aliases))([
      "max",
    ]);
    expect(result).toMatchObject({
      status: "unverified",
      refusalReason: "owner_cache_inventory_unverified",
      ownerScopeCount: 2048,
      ownerFailureCounts: { inventory_capped: 1 },
      patchedScopes: 0,
    });
    expect(scope.get).not.toHaveBeenCalled();
  });

  it("distinguishes a stale snapshot and an absent managed picker query", () => {
    const { scope } = createScope({}, new Set(["high"]));
    const stale = createState(createAtom(), scope);
    stale.scopedAppServerScopeScanComplete = false;
    expect(createReconciler(stale)(["max"])).toMatchObject({
      status: "unverified",
      refusalReason: "renderer_scope_snapshot_unverified",
      ownerScopeCount: 0,
      patchedScopes: 0,
    });
    expect(
      createReconciler(createState(createAtom(), scope))(["max"]),
    ).toMatchObject({
      status: "unverified",
      refusalReason: "no_managed_picker_query",
      ownerScopeCount: 1,
      patchedScopes: 0,
    });
    expect(scope.get).not.toHaveBeenCalled();
  });
});

describe("native graded picker canonical selection authority", () => {
  const mounted = (
    rows: Record<string, unknown>[],
    candidate: Record<string, unknown> = {
      model: "fixture",
      reasoningEffort: "high",
    },
  ) => {
    const cache = createManagedCache();
    const atom = createAtom();
    const { scope } = createScope(cache, new Set(allEfforts));
    const state = createState(atom, scope);
    state.payload!.models = [
      { model: "fixture", supported_reasoning_levels: ["low", "high"] },
      { model: "other", supported_reasoning_levels: ["max"] },
    ];
    state.payload!.modelNames = ["fixture", "other"];
    const props = {
      selectedLabelCandidate: candidate,
      onSelectPower: vi.fn(),
      powerSelections: rows,
      triggerConfig: {},
    };
    state.nativeReasoningVisibilityFiberPath = () => [{ memoizedProps: props }];
    const button = { isConnected: true };
    const reconcile = createReconciler(state, {
      getElementById: () => null,
      querySelectorAll: () => [{ closest: () => button }],
    });
    return { state, props, reconcile };
  };
  it("removes stale same-model levels even when another model supports them and no levels are missing", () => {
    const unrelated = { model: "other", reasoningEffort: "max" };
    const remote = {
      model: "fixture",
      modelProvider: "unrelated_provider",
      reasoningEffort: "max",
    };
    const unscoped = { reasoningEffort: "max" };
    const rows = [
      { model: "fixture", reasoningEffort: "low" },
      { model: "fixture", reasoningEffort: "high" },
      { model: "fixture", reasoningEffort: "max" },
      unrelated,
      remote,
      unscoped,
    ];
    const { props, reconcile } = mounted(rows);
    reconcile(["low", "high", "max"]);
    expect(props.powerSelections).toEqual([
      rows[0],
      rows[1],
      unrelated,
      remote,
      unscoped,
    ]);
    reconcile([]);
    expect(props.powerSelections).toBe(rows);
  });
  it("does not borrow another model's effort as an existing owned selection", () => {
    const other = { model: "other", reasoningEffort: "high" };
    const { props, reconcile } = mounted([
      { model: "fixture", reasoningEffort: "low" },
      other,
    ]);
    reconcile(["low", "high", "max"]);
    expect(
      props.powerSelections
        .filter((row) => row.model === "fixture")
        .map((row) => row.reasoningEffort),
    ).toEqual(["low", "high"]);
    expect(props.powerSelections).toContain(other);
  });
  it("does not mutate a selected candidate explicitly owned by another provider", () => {
    const rows = [
      { model: "fixture", reasoningEffort: "low" },
      { model: "fixture", reasoningEffort: "max" },
    ];
    const { props, reconcile } = mounted(rows, {
      model: "fixture",
      modelProvider: "unrelated_provider",
      reasoningEffort: "max",
    });
    reconcile(["low", "high", "max"]);
    expect(props.powerSelections).toBe(rows);
  });
  it("restores the original native array after more than one canonical narrowing", () => {
    const rows = [
      { model: "fixture", reasoningEffort: "low" },
      { model: "fixture", reasoningEffort: "high" },
      { model: "fixture", reasoningEffort: "max" },
    ];
    const { state, props, reconcile } = mounted(rows);
    reconcile(["low", "high", "max"]);
    expect(props.powerSelections.map((row) => row.reasoningEffort)).toEqual([
      "low",
      "high",
    ]);
    state.payload!.models![0]!.supported_reasoning_levels = ["high"];
    reconcile(["high", "max"]);
    expect(props.powerSelections.map((row) => row.reasoningEffort)).toEqual([
      "high",
    ]);
    reconcile([]);
    expect(props.powerSelections).toBe(rows);
  });
  it("leaves ambiguous canonical model identities untouched", () => {
    const rows = [{ model: "fixture", reasoningEffort: "max" }];
    const { state, props, reconcile } = mounted(rows);
    state.payload!.models!.push({
      model: "fixture",
      supported_reasoning_levels: ["max"],
    });
    reconcile(["low", "high", "max"]);
    expect(props.powerSelections).toBe(rows);
  });
  it("does not invoke accessor provider identities to authorize a mutation", () => {
    const getter = vi.fn(() => "codex_model_router_v2");
    const candidate = Object.defineProperty(
      { model: "fixture", reasoningEffort: "max" },
      "modelProvider",
      { get: getter },
    );
    const rows = [{ model: "fixture", reasoningEffort: "max" }];
    const { props, reconcile } = mounted(rows, candidate);
    reconcile(["low", "high", "max"]);
    expect(props.powerSelections).toBe(rows);
    expect(getter).not.toHaveBeenCalled();
  });
  it.each(["budget", "none", "unknown"])(
    "prunes stale same-model graded options after transition to %s without inventing replacements",
    (controlKind) => {
      const foreign = { model: "other", reasoningEffort: "max" };
      const rows = [
        { model: "fixture", reasoningEffort: "low" },
        { model: "fixture", reasoningEffort: "high" },
        foreign,
      ];
      const { state, props, reconcile } = mounted(rows);
      state.payload!.models![0] = {
        model: "fixture",
        supported_reasoning_levels: [],
        reasoning: { controlKind },
      };
      reconcile(["max"]);
      expect(props.powerSelections).toEqual([foreign]);
      reconcile([]);
      expect(props.powerSelections).toBe(rows);
    },
  );
  it("preserves canonical Boolean aliases while removing a stale graded option", () => {
    const rows = [
      { model: "fixture", reasoningEffort: "none" },
      { model: "fixture", reasoningEffort: "medium" },
      { model: "fixture", reasoningEffort: "high" },
    ];
    const { state, props, reconcile } = mounted(rows, {
      model: "fixture",
      reasoningEffort: "medium",
    });
    state.payload!.models![0] = {
      model: "fixture",
      supported_reasoning_levels: [],
      ccSwitchReasoningControl: {
        kind: "boolean",
        disableAllowed: true,
        fingerprint: "boolean-fixture",
      },
    };
    reconcile(["max"]);
    expect(props.powerSelections).toEqual([rows[0], rows[1]]);
    expect(
      props.powerSelections
        .filter((row) => row.model === "fixture")
        .map((row) => row.reasoningEffort),
    ).toEqual(["none", "medium"]);
  });
  it("does not fabricate Boolean aliases from another model's graded medium visibility", () => {
    const rows: Record<string, unknown>[] = [];
    const { state, props, reconcile } = mounted(rows, {
      model: "fixture",
      reasoningEffort: "medium",
    });
    state.payload!.models![0] = {
      model: "fixture",
      supported_reasoning_levels: [],
      ccSwitchReasoningControl: {
        kind: "boolean",
        disableAllowed: true,
        fingerprint: "boolean-fixture",
      },
    };
    state.payload!.models![1]!.supported_reasoning_levels = ["medium", "max"];
    reconcile(["medium", "max"]);
    expect(props.powerSelections).toBe(rows);
    expect(props.powerSelections).toEqual([]);
  });
});
