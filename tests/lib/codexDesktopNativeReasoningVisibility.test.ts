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
  nativeReasoningVisibilityMaxEnabled?: boolean;
  payload?: { catalogAvailable?: boolean; modelProvider?: string };
  pendingReactNodes?: Set<object>;
};
const fixtureRoot = {};
const fixtureWindow = {
  __codexRoot: { _internalRoot: { current: fixtureRoot } },
};
const fixtureDocument = { getElementById: () => null };
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
const createScope = (cache: object, enabled: unknown) => {
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
  payload: { catalogAvailable: true, modelProvider: "codex_model_router_v2" },
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

describe("Codex Desktop managed native Max reconciliation", () => {
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
    expect(state.nativeReasoningVisibilityMaxEnabled).toBe(true);
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

  it("restores a Max wrapper when the managed catalog no longer declares Max", () => {
    const cache = createManagedCache();
    const atom = createAtom();
    const enabled = new Set(allEfforts.slice(0, 4));
    const { scope } = createScope(cache, enabled);
    const originalGet = scope.get;
    const state = createState(atom, scope);
    const reconcile = createReconciler(state);
    expect(reconcile(["max"]).patchedScopes).toBe(1);
    expect(reconcile(["low", "high"])).toMatchObject({
      managed: false,
      restoredScopes: 1,
    });
    expect(scope.get).toBe(originalGet);
    expect(scope.get(atom)).toBe(enabled);
  });
});

const createReconciler = (state: State) =>
  new Function(
    "state",
    "window",
    "document",
    `const codexPickerOwnData = (value, key) => {
      if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
      const field = Object.getOwnPropertyDescriptor(value, key);
      return field && "value" in field ? field.value : undefined;
    };
    const codexPickerDataArray = (value) => Array.isArray(value) ? Array.from({ length: value.length }, (_, index) => value[index]) : [];
    const currentPayload = () => state.payload || { catalogAvailable: true, modelProvider: "codex_model_router_v2", modelNames: ["fixture"] };
    const modelNames = () => ["fixture"];
    const descriptorFor = () => ({ supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"].map((reasoningEffort) => ({ reasoningEffort })) });
    const isManagedCodexModelQuery = (key) => Array.isArray(key) && key[0] === "models" && key[1] === "list" && key[2] === "local" && ["chatgpt", "apikey", "no-auth"].includes(key[3]) && (key.length < 6 || key.slice(5).includes(currentPayload().modelProvider));
    ${discovery}\n${native}\nreturn reconcileCodexNativeReasoningVisibility;`,
  )(state, fixtureWindow, fixtureDocument) as (efforts: unknown) => {
    status: string;
    managed: boolean;
    patchedScopes: number;
    restoredScopes: number;
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
