import { readFileSync } from "node:fs";
import path from "node:path";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

const resources = path.resolve(
  process.cwd(),
  "src-tauri/src/resources/codex_desktop",
);
const resource = (name: string) =>
  readFileSync(path.join(resources, name), "utf8");
const renderer = resource("renderer_runtime.js");
const patchKey = "__ccSwitchCodexAppCompatibilityV9";
const runtimeFingerprint = "modern-runtime-regression";
const provider = "codex_model_router_v2";
const allEfforts = ["low", "medium", "high", "xhigh", "max", "ultra"];
const nativeVisibleEfforts = allEfforts.slice(0, 4);
const entryUrl = "https://codex.test/assets/348410.fixture.js";
const rawModels = {
  data: [
    {
      model: "sol",
      supportedReasoningEfforts: allEfforts.map((reasoningEffort) => ({
        reasoningEffort,
        description: reasoningEffort,
      })),
    },
  ],
};
const payload = () => ({
  modelProvider: provider,
  catalogAvailable: true,
  modelNames: ["sol"],
  models: [{ model: "sol", supported_reasoning_levels: [...allEfforts] }],
});
const nativeSelect = (raw: typeof rawModels) => {
  const models = raw.data.map((model) => ({
    ...model,
    supportedReasoningEfforts: model.supportedReasoningEfforts.filter((level) =>
      nativeVisibleEfforts.includes(level.reasoningEffort),
    ),
  }));
  return {
    models,
    defaultModel: models[0],
    hasModelSupportingMaxReasoningEffort: raw.data.some((model) =>
      model.supportedReasoningEfforts.some(
        (level) => level.reasoningEffort === "max",
      ),
    ),
    hasModelSupportingUltraReasoningEffort: false,
  };
};
type PickerData = ReturnType<typeof nativeSelect>;
type RuntimeState = {
  appServerClients?: unknown[];
  appServerPatchInstalled?: boolean;
  reasoningQueryCaches?: Map<object, { dispose?: () => void }>;
  reasoningObserverPrototypes?: Map<object, { dispose: () => void }>;
  readCodexModelPickerDiagnostics?: () => Record<string, unknown>;
  [key: string]: unknown;
};
const assembleRuntime = (
  catalog: ReturnType<typeof payload>,
  fingerprint = runtimeFingerprint,
) => {
  const fragments: Record<string, string> = {
    CATALOG_PAYLOAD_SELECTION: "catalog_payload_selection.js",
    MODEL_PICKER_RELEASE: "model_picker_release.js",
    QUERY_CACHE_LIFECYCLE: "model_picker_cache_lifecycle.js",
    MODEL_PATCH: "model_picker_core.js",
    GUARDIAN_V2_PATCH: "guardian_v2_compatibility.js",
    REQUEST_NORMALIZATION: "app_server_request_normalization.js",
    HISTORY_LINEAGE_HYDRATION: "history_lineage_hydration.js",
    MODULE_CLIENT_DISCOVERY: "client_discovery.js",
    WEBPACK_DISCOVERY: "webpack_discovery.js",
    NATIVE_REASONING_VISIBILITY: "native_reasoning_visibility.js",
    MODEL_PICKER_DIAGNOSTICS: "model_picker_diagnostics.js",
    REQUEST_HEALTH_WARNING: "request_health_warning.js",
    SUMMARY_HANDOFF: "summary_handoff.js",
    CODEX_CONTINUATION: "continuation.js",
    APP_SERVER_MODEL_LIST_SCOPE: "app_server_model_list_scope.js",
  };
  let script = renderer;
  for (const [slot, filename] of Object.entries(fragments)) {
    const marker = `/*__CCSWITCH_${slot}_CORE__*/`;
    if (!script.includes(marker))
      throw new Error(
        `The production renderer resource slot is missing: ${slot}`,
      );
    script = script.replace(marker, resource(filename));
  }
  return (
    script
      .replace("__CCSWITCH_CATALOG_PAYLOAD__", JSON.stringify(catalog))
      .replace("__CCSWITCH_CATALOG_RELEASED__", "false")
      .replace("__CCSWITCH_PATCH_KEY__", JSON.stringify(patchKey))
      .replace(
        "__CCSWITCH_RENDERER_RUNTIME_FINGERPRINT__",
        JSON.stringify(fingerprint),
      )
      .replace("__CCSWITCH_REQUEST_HEALTH_SUPPRESSED__", "true")
      .replace(
        "__CCSWITCH_TERMINAL_ERROR_POLICY__",
        readFileSync(
          path.resolve(
            process.cwd(),
            "src-tauri/src/proxy/providers/terminal_error_policy.json",
          ),
          "utf8",
        ),
      )
      // The only test seam replaces the browser import transport. Discovery,
      // cache binding, projection, and lifecycle run the production resources.
      .replace(/import\(url\)/g, "importModule(url)")
  );
};
const createHarness = (
  moduleNamespace: object,
  options: {
    reactScope?: object;
    additionalReactScopes?: object[];
    scripts?: { src: string; type: string }[];
    performanceEntries?: string[];
    fetchSources?: Record<string, string>;
    catalog?: ReturnType<typeof payload>;
    moduleNamespaces?: Record<string, object>;
    importError?: boolean;
    runtimeFingerprint?: string;
    state?: RuntimeState;
  } = {},
) => {
  const state: RuntimeState = options.state ?? {};
  const window = {
    [patchKey]: state,
    location: {
      href: "https://codex.test/index.html",
      origin: "https://codex.test",
    },
    dispatchEvent: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    ...(options.reactScope
      ? {
          __codexRoot: {
            _internalRoot: {
              current: {
                dependencies: {
                  first: options.reactScope,
                  ...Object.fromEntries(
                    (options.additionalReactScopes ?? []).map(
                      (scope, index) => [`scope${index}`, scope],
                    ),
                  ),
                },
              },
            },
          },
        }
      : {}),
  };
  const scripts = options.scripts ?? [{ src: entryUrl, type: "module" }];
  const document = {
    scripts,
    baseURI: "https://codex.test/index.html",
    body: null,
    documentElement: null,
    getElementById: () => null,
    querySelectorAll: () => [],
  };
  const importModule = vi.fn(async (url: string) => {
    if (options.importError)
      throw new Error("Fixture numeric entry import unavailable");
    const configuredNamespace = options.moduleNamespaces?.[url];
    if (configuredNamespace) return configuredNamespace;
    if (url !== entryUrl)
      throw new Error("The adapter must not import guessed or foreign bundles");
    return moduleNamespace;
  });
  const fetch = vi.fn(async (_url: string) => ({
    ok: true,
    text: async () => options.fetchSources?.[_url] ?? "",
  }));
  const performanceEntries = options.performanceEntries ?? [];
  let heartbeat: (() => void) | undefined;
  const setInterval = vi.fn((callback: () => void) => {
    heartbeat = callback;
    return 1;
  });
  const run = new Function(
    "window",
    "document",
    "location",
    "performance",
    "localStorage",
    "fetch",
    "importModule",
    "setInterval",
    "clearInterval",
    "setTimeout",
    "clearTimeout",
    "globalThis",
    `return ${assembleRuntime(options.catalog ?? payload(), options.runtimeFingerprint ?? runtimeFingerprint)}`,
  );
  const execute = async () => {
    const result = await run(
      window,
      document,
      window.location,
      {
        now: () => 0,
        getEntriesByType: () => performanceEntries.map((name) => ({ name })),
      },
      { getItem: () => null, setItem() {}, removeItem() {} },
      fetch,
      importModule,
      setInterval,
      () => {},
      (callback: () => void) => {
        callback();
        return 1;
      },
      () => {},
      {},
    );
    // Module/scope discovery intentionally must not block installation. Let
    // its bounded async work settle, then exercise the installed heartbeat.
    for (let index = 0; index < 128; index += 1) await Promise.resolve();
    heartbeat?.();
    for (let index = 0; index < 128; index += 1) await Promise.resolve();
    return result;
  };
  return {
    state,
    execute,
    tick: async () => {
      heartbeat?.();
      for (let index = 0; index < 128; index += 1) await Promise.resolve();
    },
    importModule,
    fetch,
    dispose: () => {
      for (const entry of state.reasoningObserverPrototypes?.values() ?? [])
        entry.dispose();
      for (const entry of state.reasoningQueryCaches?.values() ?? [])
        entry.dispose?.();
    },
  };
};
const createPicker = (
  client: QueryClient,
  host = "local",
  modelProvider = provider,
) => {
  const queryKey = ["models", "list", host, "chatgpt", 100, modelProvider];
  client.setQueryData(queryKey, rawModels);
  const observer = new QueryObserver(client, {
    queryKey,
    enabled: false,
    select: nativeSelect,
  });
  const unsubscribe = observer.subscribe(() => {});
  return {
    observer,
    data: () => observer.getCurrentResult().data as PickerData,
    efforts: () =>
      observer
        .getCurrentResult()
        .data?.models[0].supportedReasoningEfforts.map(
          (level) => level.reasoningEffort,
        ),
    dispose: () => {
      unsubscribe();
      observer.destroy();
    },
  };
};
const createWebpackNamespace = (exports: object) => {
  const requireModule = vi.fn(() => {
    throw new Error("Initialized-cache discovery must never require a module");
  });
  const factory = vi.fn(() => {
    throw new Error("Discovery must never execute a module factory");
  });
  const cache = { fixture: { id: "fixture", loaded: true, exports } } as Record<
    string,
    { id: string; loaded: boolean; exports: object }
  >;
  Object.assign(requireModule, {
    c: cache,
    m: { uninitialized: factory },
  });
  return {
    namespace: { __webpack_require__: requireModule },
    requireModule,
    factory,
    cache,
  };
};

const createNativeVisibilityFixture = (
  client: QueryClient,
  enabled = new Set(nativeVisibleEfforts),
) => {
  const resolve = vi.fn(() => {
    throw new Error(
      "The native atom must only be read through its owner scope",
    );
  });
  const atom = { scope: {}, resolve };
  const get = vi.fn((key: object) => {
    if (key !== atom) throw new Error("Unknown native atom");
    return enabled;
  });
  const set = vi.fn();
  const watch = vi.fn();
  const scope = {
    chain: {},
    node: { queryClient: client },
    queryClient: client,
    get,
    set,
    watch,
  };
  const webpack = createWebpackNamespace({ pickerClient: client });
  webpack.cache.Q3tq = {
    id: "Q3tq",
    loaded: true,
    exports: { pN: atom },
  };
  return { enabled, resolve, atom, get, set, watch, scope, webpack };
};
const nativeVisible = (
  picker: ReturnType<typeof createPicker>,
  enabled: Set<string>,
) =>
  picker
    .data()
    .models[0].supportedReasoningEfforts.filter((level) =>
      enabled.has(level.reasoningEffort),
    )
    .map((level) => level.reasoningEffort);
describe("Codex Desktop current numeric-bundle runtime integration", () => {
  it("discovers an initialized Rspack cache and restores native-filtered Max/Ultra only for the managed local picker", async () => {
    const client = new QueryClient();
    const local = createPicker(client);
    const remote = createPicker(client, "ssh-host");
    const otherProvider = createPicker(client, "local", "another-provider");
    const getter = vi.fn(() => {
      throw new Error("Arbitrary export getters must never run");
    });
    const request = vi.fn();
    const exports = {
      pickerClient: client,
      unrelatedRequestClient: {
        hostId: "local",
        sendRequest: request,
        getCompatibleThreadSortKey() {},
        supportsPaginatedThreadHistory() {},
      },
    };
    Object.defineProperty(exports, "unsafe", { get: getter });
    const webpack = createWebpackNamespace(exports);
    const harness = createHarness(webpack.namespace);
    try {
      expect(local.efforts()).toEqual(nativeVisibleEfforts);
      expect(local.data().hasModelSupportingMaxReasoningEffort).toBe(true);
      await harness.execute();
      expect(local.efforts()).toEqual(allEfforts);
      expect(local.data().hasModelSupportingMaxReasoningEffort).toBe(true);
      expect(local.data().hasModelSupportingUltraReasoningEffort).toBe(true);
      expect(remote.efforts()).toEqual(nativeVisibleEfforts);
      expect(otherProvider.efforts()).toEqual(nativeVisibleEfforts);
      expect(harness.state.reasoningQueryCaches?.size).toBe(1);
      expect(harness.state.readCodexModelPickerDiagnostics?.()).toMatchObject({
        status: "unverified",
      });
      expect(harness.state.appServerClients ?? []).toEqual([]);
      expect(harness.state.appServerPatchInstalled).not.toBe(true);
      expect(harness.importModule).toHaveBeenCalledWith(entryUrl);
      expect(webpack.requireModule).not.toHaveBeenCalled();
      expect(webpack.factory).not.toHaveBeenCalled();
      expect(getter).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
      local.dispose();
      remote.dispose();
      otherProvider.dispose();
      client.clear();
    }
  });

  it("repairs native Max visibility while leaving the separate Ultra gate untouched", async () => {
    const client = new QueryClient();
    const picker = createPicker(client);
    const native = createNativeVisibilityFixture(client);
    const harness = createHarness(native.webpack.namespace, {
      reactScope: native.scope,
    });
    try {
      await harness.execute();
      expect(picker.efforts()).toEqual(allEfforts);
      expect(nativeVisible(picker, native.enabled)).toEqual(
        nativeVisibleEfforts,
      );
      expect(nativeVisible(picker, native.scope.get(native.atom))).toEqual([
        ...nativeVisibleEfforts,
        "max",
      ]);
      expect(harness.state.readCodexModelPickerDiagnostics?.()).toMatchObject({
        status: "mismatch",
        missingMaxModelCount: 0,
        missingUltraModelCount: 1,
      });
      expect(harness.state.nativeReasoningVisibilityReconciliation).toMatchObject({
        status: "known",
        managed: true,
        patchedScopes: 1,
      });
      native.enabled.add("max");
      native.enabled.add("ultra");
      expect(nativeVisible(picker, native.enabled)).toEqual(allEfforts);
      expect(harness.state.readCodexModelPickerDiagnostics?.()).toMatchObject({
        status: "ready",
        missingMaxModelCount: 0,
        missingUltraModelCount: 0,
      });
      expect(native.get).toHaveBeenCalledWith(native.atom);
      expect(native.resolve).not.toHaveBeenCalled();
      expect(native.set).not.toHaveBeenCalled();
      expect(native.watch).not.toHaveBeenCalled();
      expect(harness.state.appServerClients ?? []).toEqual([]);
    } finally {
      harness.dispose();
      picker.dispose();
      client.clear();
    }
  });

  it("does not promote an orphaned module-export scope into current React ownership", async () => {
    const currentClient = new QueryClient();
    const orphanClient = new QueryClient();
    const currentPicker = createPicker(currentClient);
    const orphanPicker = createPicker(orphanClient);
    const current = createNativeVisibilityFixture(
      currentClient,
      new Set(allEfforts),
    );
    const orphan = createNativeVisibilityFixture(
      orphanClient,
      new Set(allEfforts),
    );
    // Both scopes can read the initialized native atom, but only current.scope
    // is actually mounted in the renderer's dependency-provider tree.
    orphan.scope.get.mockImplementation(() => new Set(allEfforts));
    current.webpack.cache.orphan = {
      id: "orphan",
      loaded: true,
      exports: { orphanScope: orphan.scope },
    };
    const harness = createHarness(current.webpack.namespace, {
      reactScope: current.scope,
    });
    try {
      await harness.execute();
      expect(harness.state.scopedAppServerScopeCandidates).toEqual(
        new Set([current.scope]),
      );
      expect(orphan.get).not.toHaveBeenCalled();
      expect(harness.state.readCodexModelPickerDiagnostics?.()).toMatchObject({
        status: "ready",
      });
    } finally {
      harness.dispose();
      currentPicker.dispose();
      orphanPicker.dispose();
      currentClient.clear();
      orphanClient.clear();
    }
  });

  it.each(["unknown_atom", "remote_cache", "different_cache"])(
    "does not certify native visibility without an observed managed picker and exact current cache proof: %s",
    async (boundary) => {
      const client = new QueryClient();
      const otherClient = new QueryClient();
      const picker = createPicker(client);
      const remote =
        boundary === "remote_cache"
          ? createPicker(otherClient, "ssh-host")
          : undefined;
      const native = createNativeVisibilityFixture(
        boundary === "unknown_atom" ? client : otherClient,
        new Set(allEfforts),
      );
      native.webpack.cache.fixture.exports = { pickerClient: client };
      if (boundary === "unknown_atom") delete native.webpack.cache.Q3tq;
      const harness = createHarness(native.webpack.namespace, {
        reactScope: native.scope,
      });
      try {
        await harness.execute();
        expect(picker.efforts()).toEqual(allEfforts);
        expect(harness.state.readCodexModelPickerDiagnostics?.()).toMatchObject(
          {
            // A current managed picker without its exact atom cannot be
            // verified. An empty or remote-only current owner has not observed
            // a managed picker yet, so it is pending rather than certified by
            // a historical cache that happens to contain all six efforts.
            status: boundary === "unknown_atom" ? "unverified" : "pending",
          },
        );
        expect(native.get).not.toHaveBeenCalled();
        expect(native.resolve).not.toHaveBeenCalled();
        expect(native.set).not.toHaveBeenCalled();
        expect(native.watch).not.toHaveBeenCalled();
        expect(remote?.efforts()).toEqual(
          boundary === "remote_cache" ? nativeVisibleEfforts : undefined,
        );
      } finally {
        harness.dispose();
        picker.dispose();
        remote?.dispose();
        client.clear();
        otherClient.clear();
      }
    },
  );

  it("fails closed when a second recognized scope owner is incomplete even though the first cache has known native visibility", async () => {
    const client = new QueryClient();
    const picker = createPicker(client);
    const native = createNativeVisibilityFixture(client, new Set(allEfforts));
    const incomplete = {
      chain: {},
      node: { queryClient: null },
      queryClient: client,
      get() {},
      set: vi.fn(),
      watch: vi.fn(),
    };
    const harness = createHarness(native.webpack.namespace, {
      reactScope: native.scope,
      additionalReactScopes: [incomplete],
    });
    try {
      await harness.execute();
      expect(harness.state.readCodexModelPickerDiagnostics?.()).toMatchObject({
        status: "unverified",
      });
      expect(native.get).not.toHaveBeenCalled();
      expect(native.resolve).not.toHaveBeenCalled();
      expect(incomplete.set).not.toHaveBeenCalled();
      expect(incomplete.watch).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
      picker.dispose();
      client.clear();
    }
  });
  it("keeps native visibility required when the numeric entry import transiently fails but its mounted picker cache is restored", async () => {
    const client = new QueryClient();
    const picker = createPicker(client);
    const native = createNativeVisibilityFixture(client, new Set(allEfforts));
    const harness = createHarness(native.webpack.namespace, {
      reactScope: native.scope,
      importError: true,
    });
    try {
      await harness.execute();
      expect(harness.importModule).toHaveBeenCalledWith(entryUrl);
      expect(picker.efforts()).toEqual(allEfforts);
      expect(harness.state.reasoningQueryCaches?.size).toBe(1);
      expect(harness.state.nativeReasoningVisibilityRequired).toBe(true);
      expect(harness.state.nativeReasoningVisibilityAtoms).toEqual([]);
      expect(harness.state.readCodexModelPickerDiagnostics?.()).toMatchObject({
        status: "unverified",
      });
      expect(native.get).not.toHaveBeenCalled();
      expect(native.resolve).not.toHaveBeenCalled();
      expect(native.set).not.toHaveBeenCalled();
      expect(native.watch).not.toHaveBeenCalled();
      expect(harness.state.appServerClients ?? []).toEqual([]);
    } finally {
      harness.dispose();
      picker.dispose();
      client.clear();
    }
  });
  it("invalidates prepared continuation jobs when a new runtime generation is installed", async () => {
    const state: RuntimeState = {
      codexContinuationJobs: {
        stale: { status: "prepared", threadId: "old-thread" },
      },
    };
    const harness = createHarness({}, { state, scripts: [] });
    try {
      await harness.execute();
      expect(harness.state.codexContinuationJobs).toEqual({});
    } finally {
      harness.dispose();
    }
  });
  it("drops semantic module promises when a new runtime fingerprint sees a new renderer bundle", async () => {
    const state: RuntimeState = {};
    const oldModuleUrl = "https://codex.test/assets/app-shared-old.js";
    const newModuleUrl = "https://codex.test/assets/app-shared-new.js";
    const first = createHarness(
      {},
      {
        state,
        runtimeFingerprint: "old-runtime",
        scripts: [
          { src: entryUrl, type: "module" },
          { src: oldModuleUrl, type: "module" },
        ],
        moduleNamespaces: { [entryUrl]: {}, [oldModuleUrl]: {} },
      },
    );
    try {
      await first.execute();
      expect(first.importModule).toHaveBeenCalledWith(oldModuleUrl);
    } finally {
      first.dispose();
    }
    const second = createHarness(
      {},
      {
        state,
        runtimeFingerprint: "new-runtime",
        scripts: [
          { src: entryUrl, type: "module" },
          { src: newModuleUrl, type: "module" },
        ],
        moduleNamespaces: { [entryUrl]: {}, [newModuleUrl]: {} },
      },
    );
    try {
      await second.execute();
      expect(second.importModule).toHaveBeenCalledWith(newModuleUrl);
    } finally {
      second.dispose();
    }
  });
  it("retains a known native visibility requirement across fingerprint reinjection without reusing stale atom proof when entry scripts disappear", async () => {
    const client = new QueryClient();
    const picker = createPicker(client);
    const native = createNativeVisibilityFixture(client, new Set(allEfforts));
    const harness = createHarness(native.webpack.namespace, {
      reactScope: native.scope,
      scripts: [],
    });
    harness.state.rendererRuntimeFingerprint = "older-native-runtime";
    harness.state.nativeReasoningVisibilityRequired = true;
    harness.state.nativeReasoningVisibilityAtoms = [native.atom];
    try {
      await harness.execute();
      expect(picker.efforts()).toEqual(allEfforts);
      expect(harness.state.nativeReasoningVisibilityRequired).toBe(true);
      expect(harness.state.nativeReasoningVisibilityAtoms).toEqual([]);
      expect(harness.state.readCodexModelPickerDiagnostics?.()).toMatchObject({
        status: "unverified",
      });
      expect(harness.importModule).not.toHaveBeenCalled();
      expect(native.get).not.toHaveBeenCalled();
      expect(native.resolve).not.toHaveBeenCalled();
      expect(native.set).not.toHaveBeenCalled();
      expect(native.watch).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
      picker.dispose();
      client.clear();
    }
  });
  it("does not keep a historical all-efforts cache Ready after the current mounted scope replaces its owner", async () => {
    const client = new QueryClient();
    const replacement = new QueryClient();
    const picker = createPicker(client);
    const native = createNativeVisibilityFixture(client, new Set(allEfforts));
    const harness = createHarness(native.webpack.namespace, {
      reactScope: native.scope,
    });
    try {
      await harness.execute();
      expect(picker.efforts()).toEqual(allEfforts);
      expect(harness.state.readCodexModelPickerDiagnostics?.()).toMatchObject({
        status: "ready",
      });
      native.scope.node.queryClient = replacement;
      expect(client.getQueryCache().getAll()).toHaveLength(1);
      expect(replacement.getQueryCache().getAll()).toHaveLength(0);
      expect(picker.efforts()).toEqual(allEfforts);
      expect(harness.state.readCodexModelPickerDiagnostics?.().status).toMatch(
        /^(pending|unverified)$/,
      );
      expect(native.resolve).not.toHaveBeenCalled();
      expect(native.set).not.toHaveBeenCalled();
      expect(native.watch).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
      picker.dispose();
      client.clear();
      replacement.clear();
    }
  });
  it("ignores an orphaned subscribed cache for readiness after the current scope moves to a healthy replacement cache", async () => {
    const client = new QueryClient();
    const replacement = new QueryClient();
    const oldPicker = createPicker(client);
    const native = createNativeVisibilityFixture(client, new Set(allEfforts));
    const harness = createHarness(native.webpack.namespace, {
      reactScope: native.scope,
    });
    let currentPicker: ReturnType<typeof createPicker> | undefined;
    try {
      await harness.execute();
      expect(harness.state.readCodexModelPickerDiagnostics?.()).toMatchObject({
        status: "ready",
      });
      currentPicker = createPicker(replacement);
      native.scope.node.queryClient = replacement;
      await harness.tick();
      expect(oldPicker.efforts()).toEqual(allEfforts);
      expect(currentPicker.efforts()).toEqual(allEfforts);
      expect(
        harness.state.reasoningQueryCaches?.has(client.getQueryCache()),
      ).toBe(true);
      expect(
        harness.state.reasoningQueryCaches?.has(replacement.getQueryCache()),
      ).toBe(true);
      expect(harness.state.readCodexModelPickerDiagnostics?.()).toMatchObject({
        status: "ready",
        missingMaxModelCount: 0,
        missingUltraModelCount: 0,
      });
      expect(native.resolve).not.toHaveBeenCalled();
      expect(native.set).not.toHaveBeenCalled();
      expect(native.watch).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
      oldPicker.dispose();
      currentPicker?.dispose();
      client.clear();
      replacement.clear();
    }
  });
  it("binds an initialized React scope through node.queryClient when all semantic imports fail without invoking its queryClient getter", async () => {
    const client = new QueryClient();
    const picker = createPicker(client);
    const getter = vi.fn(() => {
      throw new Error("Only the stored scope node queryClient is safe to read");
    });
    const scope = {
      chain: {},
      node: { queryClient: client },
      get() {},
      set() {},
      watch() {},
    };
    Object.defineProperty(scope, "queryClient", { get: getter });
    const webpack = createWebpackNamespace({});
    const harness = createHarness(webpack.namespace, { reactScope: scope });
    try {
      expect(picker.efforts()).toEqual(nativeVisibleEfforts);
      await harness.execute();
      expect(picker.efforts()).toEqual(allEfforts);
      expect(harness.state.reasoningQueryCaches?.size).toBe(1);
      expect(getter).not.toHaveBeenCalled();
      expect(webpack.requireModule).not.toHaveBeenCalled();
      expect(harness.state.appServerClients ?? []).toEqual([]);
    } finally {
      harness.dispose();
      picker.dispose();
      client.clear();
    }
  });

  it.each([true, false])(
    "preserves canonical empty/unavailable catalog authority through numeric discovery: available=%s",
    async (available) => {
      const client = new QueryClient();
      const picker = createPicker(client);
      const webpack = createWebpackNamespace({ pickerClient: client });
      const harness = createHarness(webpack.namespace, {
        catalog: {
          ...payload(),
          catalogAvailable: available,
          modelNames: [],
          models: [],
        },
      });
      try {
        await harness.execute();
        if (available) {
          expect(picker.data().models).toEqual([]);
          expect(picker.data().defaultModel).toBeUndefined();
          expect(picker.data().hasModelSupportingMaxReasoningEffort).toBe(
            false,
          );
          expect(picker.data().hasModelSupportingUltraReasoningEffort).toBe(
            false,
          );
        } else {
          expect(picker.efforts()).toEqual(nativeVisibleEfforts);
          expect(
            harness.state.readCodexModelPickerDiagnostics?.(),
          ).toMatchObject({
            status: "unverified",
          });
        }
        expect(webpack.requireModule).not.toHaveBeenCalled();
        expect(webpack.factory).not.toHaveBeenCalled();
        expect(harness.state.appServerClients ?? []).toEqual([]);
      } finally {
        harness.dispose();
        picker.dispose();
        client.clear();
      }
    },
  );
  it("rejects foreign semantic-name fallback assets before fetching or importing their valid-looking exports", async () => {
    const client = new QueryClient();
    const picker = createPicker(client);
    const request = vi.fn();
    const foreignModule = {
      pickerClient: client,
      requestClient: {
        hostId: "local",
        sendRequest: request,
        getCompatibleThreadSortKey() {},
        supportsPaginatedThreadHistory() {},
      },
    };
    const foreignUrls = [
      "https://foreign.test/assets/app-shared-fixture.js",
      "https://foreign.test/assets/app-server-manager-signals-fixture.js",
    ];
    const harness = createHarness(
      {},
      {
        scripts: foreignUrls.map((src) => ({ src, type: "module" })),
        moduleNamespaces: Object.fromEntries(
          foreignUrls.map((url) => [url, foreignModule]),
        ),
      },
    );
    try {
      await harness.execute();
      const foreignCalls = (calls: unknown[][]) =>
        calls
          .map(([url]) => String(url))
          .filter((url) => new URL(url).origin === "https://foreign.test");
      expect({
        imports: foreignCalls(harness.importModule.mock.calls),
        fetches: foreignCalls(harness.fetch.mock.calls),
      }).toEqual({ imports: [], fetches: [] });
      expect(picker.efforts()).toEqual(nativeVisibleEfforts);
      expect(harness.state.reasoningQueryCaches?.size ?? 0).toBe(0);
      expect(harness.state.appServerClients ?? []).toEqual([]);
      expect(harness.state.appServerPatchInstalled).not.toBe(true);
      expect(request).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
      picker.dispose();
      client.clear();
    }
  });
  it("does not authorize a semantic URL in a non-executable script element", async () => {
    const semanticUrl = "https://codex.test/assets/app-shared-plain.fixture.js";
    const harness = createHarness(
      {},
      {
        scripts: [{ src: semanticUrl, type: "text/plain" }],
        moduleNamespaces: { [semanticUrl]: {} },
      },
    );
    try {
      await harness.execute();
      expect(harness.importModule).not.toHaveBeenCalled();
      expect(harness.fetch).not.toHaveBeenCalled();
      expect(harness.state.appServerPatchInstalled).not.toBe(true);
    } finally {
      harness.dispose();
    }
  });

  it("does not authorize imports from a loaded entry's unused dependency strings", async () => {
    const scriptUrl = "https://codex.test/assets/index-fixture.js";
    const lazyUrl = "https://codex.test/assets/app-shared-never-executed.js";
    const harness = createHarness(
      {},
      {
        scripts: [{ src: scriptUrl, type: "module" }],
        fetchSources: {
          [scriptUrl]: 'const lazyChunks=["./app-shared-never-executed.js"];',
        },
        moduleNamespaces: { [lazyUrl]: {} },
      },
    );
    try {
      await harness.execute();
      expect(harness.importModule).not.toHaveBeenCalledWith(lazyUrl);
      expect(harness.fetch).not.toHaveBeenCalled();
      expect(harness.state.appServerPatchInstalled).not.toBe(true);
    } finally {
      harness.dispose();
    }
  });

  it("does not import a semantic module found only in a performance resource entry", async () => {
    const client = new QueryClient();
    const picker = createPicker(client);
    const asyncUrl =
      "https://codex.test/assets/async/app-shared-unexecuted.fixture.js";
    const asyncModule = { pickerClient: client };
    const harness = createHarness(
      {},
      {
        scripts: [{ src: entryUrl, type: "module" }],
        performanceEntries: [asyncUrl],
        moduleNamespaces: { [asyncUrl]: asyncModule },
      },
    );
    try {
      await harness.execute();
      expect(harness.importModule).not.toHaveBeenCalledWith(asyncUrl);
      expect(harness.fetch).not.toHaveBeenCalledWith(asyncUrl);
      expect(harness.state.reasoningQueryCaches?.size ?? 0).toBe(0);
      expect(harness.state.appServerPatchInstalled).not.toBe(true);
    } finally {
      harness.dispose();
      picker.dispose();
      client.clear();
    }
  });

  it("leaves the picker unverified instead of importing a foreign or unexecuted async numeric bundle", async () => {
    const client = new QueryClient();
    const picker = createPicker(client);
    const webpack = createWebpackNamespace({ pickerClient: client });
    const harness = createHarness(webpack.namespace, {
      scripts: [
        {
          src: "https://foreign.test/assets/348410.fixture.js",
          type: "module",
        },
        {
          src: "https://codex.test/assets/async/24191.fixture.js",
          type: "module",
        },
        { src: entryUrl, type: "text/javascript" },
      ],
    });
    try {
      await harness.execute();
      expect(picker.efforts()).toEqual(nativeVisibleEfforts);
      expect(harness.importModule).not.toHaveBeenCalled();
      expect(harness.state.reasoningQueryCaches?.size ?? 0).toBe(0);
      expect(harness.state.readCodexModelPickerDiagnostics?.()).toMatchObject({
        status: "pending",
        pickerObserverCount: 0,
      });
      expect(harness.state.appServerClients ?? []).toEqual([]);
      expect(webpack.requireModule).not.toHaveBeenCalled();
      expect(webpack.factory).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
      picker.dispose();
      client.clear();
    }
  });
});
