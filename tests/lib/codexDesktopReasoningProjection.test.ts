import { readFileSync } from "node:fs";
import path from "node:path";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

const core = readFileSync(
  path.resolve(
    process.cwd(),
    "src-tauri/src/resources/codex_desktop/model_picker_core.js",
  ),
  "utf8",
);
const cacheLifecycleCore = readFileSync(
  path.resolve(
    process.cwd(),
    "src-tauri/src/resources/codex_desktop/model_picker_cache_lifecycle.js",
  ),
  "utf8",
);
const legacyV8QueryCacheCore = readFileSync(
  path.resolve(
    process.cwd(),
    "tests/fixtures/codex-model-picker-v8-query-cache.js",
  ),
  "utf8",
);
const releaseCore = readFileSync(
  path.resolve(
    process.cwd(),
    "src-tauri/src/resources/codex_desktop/model_picker_release.js",
  ),
  "utf8",
);
const discoveryCore = readFileSync(
  path.resolve(
    process.cwd(),
    "src-tauri/src/resources/codex_desktop/client_discovery.js",
  ),
  "utf8",
);
const provider = "codex_model_router_v2";
const allEfforts = ["low", "medium", "high", "xhigh", "max", "ultra"];
const key = ["models", "list", "local", "chatgpt", 100, provider];
const raw = {
  data: [
    {
      model: "sol-relay",
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: allEfforts.map((reasoningEffort) => ({
        reasoningEffort,
        description: reasoningEffort,
      })),
    },
  ],
};
const select = (value: typeof raw) => {
  const models = value.data.map((model) => ({
    ...model,
    supportedReasoningEfforts: model.supportedReasoningEfforts.filter((level) =>
      ["low", "medium", "high", "xhigh"].includes(level.reasoningEffort),
    ),
  }));
  return {
    models,
    defaultModel: models[0],
    hasModelSupportingMaxReasoningEffort: false,
    hasModelSupportingUltraReasoningEffort: false,
  };
};
type State = {
  payload: {
    modelProvider: string;
    catalogAvailable: boolean;
    catalogReleased?: boolean;
    modelNames: string[];
    models: ({ model: string } & Record<string, unknown>)[];
  };
  catalogReleased?: boolean;
  catalogProviderEpoch?: number;
  modelPickerQueryClients?: Map<unknown, QueryClient>;
  modelPickerReleaseRefresh?: Promise<PromiseSettledResult<unknown>[]>;
  reasoningObserverPrototypes?: Map<
    unknown,
    { dispose: () => void; patched: unknown }
  >;
  reasoningQueryCaches?: Map<
    unknown,
    {
      unsubscribe: () => void;
      dispose?: () => void;
      selectorSources?: WeakMap<object, object>;
    }
  >;
};
type Core = {
  codexModelCatalogDiagnostics: () => {
    reasoningModelCount: number;
    maxEffortModelCount: number;
    ultraEffortModelCount: number;
  };
  patchCodexModelReasoningQueryCache: (
    cache: ReturnType<QueryClient["getQueryCache"]>,
  ) => boolean;
  patchCodexModelReasoningQueryObserverPrototype: (
    prototype: object,
  ) => boolean;
  patchModelArray: (
    models: Record<string, unknown>[],
    allowEmpty?: boolean,
    managedOnly?: boolean,
  ) => boolean;
  restoreCodexCatalogReasoningSelection: (
    queryKey: unknown[],
    selection: {
      models: Record<string, unknown>[];
      [field: string]: unknown;
    },
  ) => {
    models: Record<string, unknown>[];
    [field: string]: unknown;
  };
};
const prepareCacheReinjection = new Function(
  "state",
  `${cacheLifecycleCore}\nreturn prepareCodexModelReasoningQueryCachesForReinjection();`,
) as (state: State) => ReturnType<QueryClient["getQueryCache"]>[];
const loadCore = (state: State) =>
  new Function(
    "state",
    `${core}\nreturn { codexModelCatalogDiagnostics, patchCodexModelReasoningQueryCache, patchCodexModelReasoningQueryObserverPrototype, patchModelArray, restoreCodexCatalogReasoningSelection };`,
  )(state) as Core;
const createHarness = () => {
  const state: State = {
    payload: {
      modelProvider: provider,
      catalogAvailable: true,
      modelNames: ["sol-relay"],
      models: [
        { model: "sol-relay", supported_reasoning_levels: [...allEfforts] },
      ],
    },
  };
  const api = loadCore(state);
  const client = new QueryClient();
  client.setQueryData(key, raw);
  const options = { queryKey: key, enabled: false, select };
  const observer = new QueryObserver(client, options);
  const unsubscribe = observer.subscribe(() => {});
  const efforts = () =>
    observer
      .getCurrentResult()
      .data?.models[0].supportedReasoningEfforts.map(
        (level) => level.reasoningEffort,
      );
  return {
    state,
    client,
    observer,
    options,
    efforts,
    api,
    patch: () => api.patchCodexModelReasoningQueryCache(client.getQueryCache()),
    dispose: () => {
      for (const entry of state.reasoningObserverPrototypes?.values() ?? [])
        entry.dispose();
      state.reasoningObserverPrototypes?.clear();
      for (const entry of state.reasoningQueryCaches?.values() ?? [])
        if (entry.dispose) entry.dispose();
        else entry.unsubscribe();
      unsubscribe();
      client.clear();
    },
  };
};

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const createReleaseRaceHarness = () => {
  const harness = createHarness();
  harness.observer.destroy();
  harness.client.clear();
  const queryKey = ["models", "list", "local", "chatgpt", 100];
  let activeProvider = provider;
  const requests: {
    provider: string;
    signal: AbortSignal;
    response: ReturnType<typeof deferred<typeof raw>>;
  }[] = [];
  harness.client.setQueryData(queryKey, raw);
  const observer = new QueryObserver(harness.client, {
    queryKey,
    enabled: false,
    select,
    queryFn: ({ signal }) => {
      const response = deferred<typeof raw>();
      requests.push({ provider: activeProvider, signal, response });
      return response.promise;
    },
  });
  const unsubscribe = observer.subscribe(() => {});
  harness.state.modelPickerQueryClients = new Map([
    [harness.client.getQueryCache(), harness.client],
  ]);
  harness.patch();
  const query = harness.client.getQueryCache().find({ queryKey })!;
  const releaseApi = new Function(
    "state",
    `${releaseCore}\nreturn {
      release: releaseCodexModelPicker,
      cancel: () => cancelCodexModelPickerReleaseRefresh(),
    };`,
  )(harness.state) as {
    release: (provider: string) => boolean;
    cancel: () => void;
  };
  return {
    ...harness,
    queryKey,
    query,
    observer,
    requests,
    releaseApi,
    setActiveProvider: (next: string) => {
      activeProvider = next;
    },
    dispose: () => {
      unsubscribe();
      observer.destroy();
      harness.dispose();
    },
  };
};

describe("Codex Desktop post-filter reasoning projection", () => {
  it("reports normalized payload effort counts without counting excluded or stale rows", () => {
    const harness = createHarness();
    try {
      harness.state.payload.models = [
        {
          model: "snake",
          supported_reasoning_levels: ["high", "max", "ultra"],
        },
        {
          model: "camel",
          supportedReasoningEfforts: [
            { reasoningEffort: "low" },
            { reasoningEffort: "max" },
            { reasoningEffort: "max" },
          ],
        },
        {
          model: "nested",
          reasoning: { supportedEfforts: ["medium", "ultra"] },
        },
        {
          model: "explicit-empty",
          supportedReasoningEfforts: [],
          reasoning: { supportedEfforts: ["max", "ultra"] },
        },
        {
          model: "excluded",
          enabled: false,
          supported_reasoning_levels: ["max", "ultra"],
        },
      ];
      harness.state.payload.modelNames = [
        "snake",
        "camel",
        "nested",
        "explicit-empty",
        "excluded",
        "stale-name",
        "snake",
      ];
      const before = JSON.stringify(harness.state.payload);

      expect(harness.api.codexModelCatalogDiagnostics()).toEqual({
        reasoningModelCount: 3,
        maxEffortModelCount: 2,
        ultraEffortModelCount: 2,
      });
      expect(JSON.stringify(harness.state.payload)).toBe(before);

      harness.state.payload.modelNames = [];
      expect(harness.api.codexModelCatalogDiagnostics()).toEqual({
        reasoningModelCount: 0,
        maxEffortModelCount: 0,
        ultraEffortModelCount: 0,
      });
    } finally {
      harness.dispose();
    }
  });

  it("projects the provider-less local model query used by current Desktop builds", () => {
    const harness = createHarness();
    try {
      const providerlessKey = ["models", "list", "local", "chatgpt", 100];
      const projected = harness.api.restoreCodexCatalogReasoningSelection(
        providerlessKey,
        select(raw),
      );
      const projectedEfforts = projected.models[0]
        ?.supportedReasoningEfforts as
        { reasoningEffort: string }[] | undefined;

      expect(projectedEfforts?.map((level) => level.reasoningEffort)).toEqual(
        allEfforts,
      );
      expect(projected.hasModelSupportingMaxReasoningEffort).toBe(true);
      expect(projected.hasModelSupportingUltraReasoningEffort).toBe(true);
    } finally {
      harness.dispose();
    }
  });

  it.each(["current", "v8"])(
    "releases %s projection to native cached queries and reactivates without nesting",
    async (version) => {
      const harness = createHarness();
      try {
        const includedPayload = harness.state.payload;
        let nativeRequests = 0;
        const native = {
          data: [{ ...raw.data[0], model: "native-provider-model" }],
        };
        harness.observer.setOptions({
          ...harness.options,
          queryFn: async () => {
            nativeRequests += 1;
            return native;
          },
        });
        const cache = harness.client.getQueryCache();
        harness.state.modelPickerQueryClients = new Map([
          [cache, harness.client],
        ]);
        const remoteKey = key.map((value) =>
          value === "local" ? "remote" : value,
        );
        harness.client.setQueryData(remoteKey, native);
        if (version === "v8") {
          const install = new Function(
            "state",
            `${core}\n{${legacyV8QueryCacheCore}\nreturn patchCodexModelReasoningQueryCache;}`,
          )(harness.state) as Core["patchCodexModelReasoningQueryCache"];
          install(cache);
        } else harness.patch();
        const legacyMethod = harness.observer.setOptions;
        const release = new Function(
          "state",
          `${releaseCore}\nreturn releaseCodexModelPicker;`,
        )(harness.state) as (provider: string) => boolean;
        expect(release(provider)).toBe(true);
        expect(harness.state.payload.catalogReleased).toBe(true);
        expect(harness.state.payload.catalogAvailable).toBe(false);
        await harness.state.modelPickerReleaseRefresh;
        expect(harness.observer.getCurrentResult().data?.models[0].model).toBe(
          "native-provider-model",
        );
        expect(harness.client.getQueryData(remoteKey)).toBe(native);
        expect(nativeRequests).toBe(1);
        release(provider);
        release("another-unmanaged-provider");
        await harness.state.modelPickerReleaseRefresh;
        expect(nativeRequests).toBe(1);
        expect(harness.state.payload.modelProvider).toBe(
          "another-unmanaged-provider",
        );
        expect(harness.state.catalogProviderEpoch).toBe(2);
        harness.state.payload = includedPayload;
        harness.state.catalogReleased = false;
        harness.client.setQueryData(key, raw);
        const api = loadCore(harness.state);
        api.patchCodexModelReasoningQueryCache(cache);
        expect(harness.efforts()).toEqual(allEfforts);
        if (version === "v8")
          expect(harness.observer.setOptions).toBe(legacyMethod);
        const entry = harness.state.reasoningQueryCaches?.get(cache);
        let selector: object | undefined = harness.observer.options.select;
        let depth = 0;
        while (selector && entry?.selectorSources?.has(selector)) {
          depth += 1;
          selector = entry.selectorSources.get(selector);
        }
        expect(depth).toBe(1);
      } finally {
        harness.dispose();
      }
    },
  );

  it("restores only tracked Statsig overrides and never guesses a legacy baseline", () => {
    const originalValue = { available_models: ["native"] };
    const projectedValue = { available_models: ["sol-relay"] };
    const owned = { value: projectedValue };
    const legacy = { value: projectedValue };
    const state = {
      payload: { modelProvider: provider, catalogAvailable: true },
      modelPickerStatsigOverrides: new Map([
        [owned, { originalValue, projectedValue }],
      ]),
    };
    new Function("state", `${releaseCore}\nreleaseCodexModelPicker(null);`)(
      state,
    );
    expect(owned.value).toBe(originalValue);
    expect(legacy.value).toBe(projectedValue);
  });

  it("retains the v8 cache entry during upgrade without nesting observer wrappers", () => {
    const harness = createHarness();
    try {
      const installV8 = new Function(
        "state",
        `${core}\n{${legacyV8QueryCacheCore}\nreturn patchCodexModelReasoningQueryCache;}`,
      )(harness.state) as Core["patchCodexModelReasoningQueryCache"];
      const cache = harness.client.getQueryCache();
      installV8(cache);
      const legacyEntry = harness.state.reasoningQueryCaches?.get(cache);
      expect(legacyEntry?.dispose).toBeUndefined();
      const legacySetOptions = harness.observer.setOptions;
      const legacyOptimisticResult = harness.observer.getOptimisticResult;
      let sourceSelections = 0;
      harness.observer.setOptions({
        ...harness.options,
        select(value) {
          sourceSelections += 1;
          return select(value);
        },
      });
      const api = loadCore(harness.state);
      const selectorDepths = [];
      for (let index = 0; index < 10; index += 1) {
        harness.state.payload = {
          ...harness.state.payload,
          models: [
            {
              model: "sol-relay",
              supported_reasoning_levels: index % 2 ? ["high"] : ["max"],
            },
          ],
        };
        expect(prepareCacheReinjection(harness.state)).toEqual([]);
        api.patchCodexModelReasoningQueryCache(cache);
        expect(harness.state.reasoningQueryCaches?.get(cache)).toBe(
          legacyEntry,
        );
        expect(harness.observer.setOptions).toBe(legacySetOptions);
        expect(harness.observer.getOptimisticResult).toBe(
          legacyOptimisticResult,
        );
        expect(harness.efforts()).toEqual(index % 2 ? ["high"] : ["max"]);
        let selector: object | undefined = harness.observer.options.select;
        let depth = 0;
        while (selector && legacyEntry?.selectorSources?.has(selector)) {
          depth += 1;
          selector = legacyEntry.selectorSources.get(selector);
        }
        selectorDepths.push(depth);
      }
      expect(selectorDepths).toEqual(Array(10).fill(1));
      expect(sourceSelections).toBeLessThanOrEqual(11);
      expect(harness.client.getQueryData(key)).toBe(raw);
    } finally {
      harness.dispose();
    }
  });

  it("restores owned QueryObserver methods and selectors before reinjection", () => {
    const harness = createHarness();
    try {
      const originalSetOptions = harness.observer.setOptions;
      const originalGetOptimisticResult = harness.observer.getOptimisticResult;
      const originalFetchOptimistic = harness.observer.fetchOptimistic;
      harness.patch();
      const firstWrapper = harness.observer.setOptions;
      expect(firstWrapper).not.toBe(originalSetOptions);
      const cache = harness.client.getQueryCache();
      expect(prepareCacheReinjection(harness.state)).toEqual([cache]);
      expect(harness.state.reasoningQueryCaches?.has(cache)).toBe(false);
      expect(harness.observer.setOptions).toBe(originalSetOptions);
      expect(harness.observer.getOptimisticResult).toBe(
        originalGetOptimisticResult,
      );
      expect(harness.observer.fetchOptimistic).toBe(originalFetchOptimistic);
      expect(harness.observer.options.select).toBe(select);
      expect(harness.efforts()).toEqual(allEfforts.slice(0, 4));
      loadCore(harness.state).patchCodexModelReasoningQueryCache(cache);
      expect(harness.observer.setOptions).not.toBe(firstWrapper);
      expect(harness.efforts()).toEqual(allEfforts);
      expect(harness.client.getQueryData(key)).toBe(raw);
    } finally {
      harness.dispose();
    }
  });

  it("restores cached efforts and keeps them through optimistic re-renders", () => {
    const harness = createHarness();
    try {
      expect(harness.efforts()).toEqual(allEfforts.slice(0, 4));
      harness.patch();
      expect(harness.efforts()).toEqual(allEfforts);
      const optimistic = harness.observer.getOptimisticResult(
        harness.client.defaultQueryOptions(harness.options),
      );
      expect(
        optimistic.data?.models[0].supportedReasoningEfforts.map(
          (level) => level.reasoningEffort,
        ),
      ).toEqual(allEfforts);
      harness.observer.setOptions({
        ...harness.options,
        select: (value) => select(value as typeof raw),
      });
      expect(harness.efforts()).toEqual(allEfforts);
      expect(harness.client.getQueryData(key)).toBe(raw);
    } finally {
      harness.dispose();
    }
  });

  it("preserves catalog efforts in query-signal snapshots before subscription", () => {
    const harness = createHarness();
    let snapshot: typeof harness.observer | undefined;
    try {
      harness.patch();
      snapshot = new QueryObserver(harness.client, harness.options);
      const query = harness.client.getQueryCache().find({ queryKey: key });
      expect(query?.observers).not.toContain(snapshot);
      const optimistic = snapshot.getOptimisticResult(
        harness.client.defaultQueryOptions(harness.options),
      );
      expect(
        optimistic.data?.models[0].supportedReasoningEfforts.map(
          (level) => level.reasoningEffort,
        ),
      ).toEqual(allEfforts);
      expect(
        snapshot
          .getCurrentResult()
          .data?.models[0].supportedReasoningEfforts.map(
            (level) => level.reasoningEffort,
          ),
      ).toEqual(allEfforts);
      expect(harness.client.getQueryData(key)).toBe(raw);
    } finally {
      snapshot?.destroy();
      harness.dispose();
    }
  });

  it.each(["chatgpt", "apikey", "no-auth"])(
    "projects the first %s observer with no subscribed cache readers",
    (authMethod) => {
      const harness = createHarness();
      const client = new QueryClient();
      let snapshot: typeof harness.observer | undefined;
      try {
        const queryKey = [
          "models",
          "list",
          "local",
          authMethod,
          100,
          ...(authMethod === "apikey" ? ["redacted-session-id"] : []),
          provider,
          "test-catalog.json",
        ];
        client.setQueryData(queryKey, raw);
        harness.api.patchCodexModelReasoningQueryObserverPrototype(
          QueryObserver.prototype,
        );
        harness.api.patchCodexModelReasoningQueryCache(client.getQueryCache());
        expect(client.getQueryCache().getAll()[0].observers).toEqual([]);
        const options = { ...harness.options, queryKey };
        snapshot = new QueryObserver(client, options);
        const initial = snapshot.getCurrentResult();
        expect(
          initial.data?.models[0].supportedReasoningEfforts.map(
            (level) => level.reasoningEffort,
          ),
        ).toEqual(allEfforts);
        expect(initial.data?.defaultModel).toBe(initial.data?.models[0]);
        expect(initial.data?.hasModelSupportingMaxReasoningEffort).toBe(true);
        expect(initial.data?.hasModelSupportingUltraReasoningEffort).toBe(true);
        for (let index = 0; index < 5; index += 1) {
          expect(
            snapshot.getOptimisticResult(client.defaultQueryOptions(options))
              .data,
          ).toBe(initial.data);
        }
        expect(client.getQueryData(queryKey)).toBe(raw);
      } finally {
        snapshot?.destroy();
        harness.dispose();
        client.clear();
      }
    },
  );

  it("reprojects unmounted snapshots from current declarations, including empty capabilities", () => {
    const harness = createHarness();
    let snapshot: typeof harness.observer | undefined;
    try {
      harness.patch();
      snapshot = new QueryObserver(harness.client, harness.options);
      for (const declared of [["max", "ultra"], ["max"], []]) {
        harness.state.payload = {
          ...harness.state.payload,
          models: [
            { model: "sol-relay", supported_reasoning_levels: declared },
          ],
        };
        const optimistic = snapshot.getOptimisticResult(
          harness.client.defaultQueryOptions(harness.options),
        );
        expect(
          optimistic.data?.models[0].supportedReasoningEfforts.map(
            (level) => level.reasoningEffort,
          ),
        ).toEqual(declared);
        expect(snapshot.getCurrentResult().data).toBe(optimistic.data);
      }
      harness.state.payload = {
        ...harness.state.payload,
        modelNames: [],
        models: [],
      };
      expect(
        snapshot.getOptimisticResult(
          harness.client.defaultQueryOptions(harness.options),
        ).data?.models,
      ).toEqual([]);
    } finally {
      snapshot?.destroy();
      harness.dispose();
    }
  });

  it("does not project foreign caches, remote hosts, unrelated providers, or raw selectors", () => {
    const harness = createHarness();
    const foreign = new QueryClient();
    const observers: { destroy: () => void }[] = [];
    try {
      harness.patch();
      foreign.setQueryData(key, raw);
      const foreignObserver = new QueryObserver(foreign, harness.options);
      observers.push(foreignObserver);
      expect(
        foreignObserver
          .getCurrentResult()
          .data?.models[0].supportedReasoningEfforts.map(
            (level) => level.reasoningEffort,
          ),
      ).toEqual(allEfforts.slice(0, 4));
      for (const queryKey of [
        key.map((part) => (part === "local" ? "remote" : part)),
        key.map((part) => (part === provider ? "another-provider" : part)),
      ]) {
        harness.client.setQueryData(queryKey, raw);
        const observer = new QueryObserver(harness.client, {
          ...harness.options,
          queryKey,
        });
        observers.push(observer);
        expect(
          observer
            .getCurrentResult()
            .data?.models[0].supportedReasoningEfforts.map(
              (level) => level.reasoningEffort,
            ),
        ).toEqual(allEfforts.slice(0, 4));
      }
      const identity = new QueryObserver(harness.client, {
        ...harness.options,
        select: (value: typeof raw) => value,
      });
      observers.push(identity);
      expect(identity.getCurrentResult().data).toBe(raw);
      expect(harness.client.getQueryData(key)).toBe(raw);
    } finally {
      for (const observer of observers) observer.destroy();
      harness.dispose();
      foreign.clear();
    }
  });

  it("unwraps copied managed selectors before foreign-cache or remote-host reads", () => {
    const harness = createHarness();
    const foreign = new QueryClient();
    const observers: { destroy: () => void }[] = [];
    try {
      harness.patch();
      const copiedOptions = harness.observer.options;
      expect(copiedOptions.select).not.toBe(select);
      foreign.setQueryData(key, raw);
      const foreignObserver = new QueryObserver(foreign, copiedOptions);
      observers.push(foreignObserver);
      const remoteKey = key.map((part) => (part === "local" ? "remote" : part));
      harness.client.setQueryData(remoteKey, raw);
      const remoteObserver = new QueryObserver(harness.client, {
        ...copiedOptions,
        queryKey: remoteKey,
      });
      observers.push(remoteObserver);
      for (const observer of [foreignObserver, remoteObserver]) {
        expect(
          observer
            .getCurrentResult()
            .data?.models[0].supportedReasoningEfforts.map(
              (level) => level.reasoningEffort,
            ),
        ).toEqual(allEfforts.slice(0, 4));
      }
    } finally {
      for (const observer of observers) observer.destroy();
      harness.dispose();
      foreign.clear();
    }
  });

  it("restores the owned prototype on reinjection without replacing another patch", () => {
    const harness = createHarness();
    const prototype = QueryObserver.prototype;
    const original = Object.getOwnPropertyDescriptor(
      prototype,
      "createResult",
    )!;
    try {
      harness.patch();
      const firstWrapper = Object.getOwnPropertyDescriptor(
        prototype,
        "createResult",
      )!.value;
      expect(firstWrapper).not.toBe(original.value);
      prepareCacheReinjection(harness.state);
      expect(
        Object.getOwnPropertyDescriptor(prototype, "createResult"),
      ).toEqual(original);
      loadCore(harness.state).patchCodexModelReasoningQueryCache(
        harness.client.getQueryCache(),
      );
      const secondWrapper = Object.getOwnPropertyDescriptor(
        prototype,
        "createResult",
      )!.value;
      expect(secondWrapper).not.toBe(firstWrapper);
      const external = function externalResult(
        this: unknown,
        ...args: unknown[]
      ) {
        return original.value.apply(this, args);
      };
      Object.defineProperty(prototype, "createResult", {
        ...original,
        value: external,
      });
      prepareCacheReinjection(harness.state);
      expect(
        Object.getOwnPropertyDescriptor(prototype, "createResult")!.value,
      ).toBe(external);
    } finally {
      harness.dispose();
      Object.defineProperty(prototype, "createResult", original);
    }
  });

  it("does not reinstall the shared result hook after the managed catalog is released", () => {
    const harness = createHarness();
    const original = Object.getOwnPropertyDescriptor(
      QueryObserver.prototype,
      "createResult",
    );
    try {
      harness.observer.setOptions({
        ...harness.options,
        queryFn: async () => raw,
      });
      harness.patch();
      new Function(
        "state",
        `${releaseCore}\nreleaseCodexModelPicker("openai");`,
      )(harness.state);
      expect(
        Object.getOwnPropertyDescriptor(
          QueryObserver.prototype,
          "createResult",
        ),
      ).toEqual(original);
      expect(
        harness.api.patchCodexModelReasoningQueryObserverPrototype(
          QueryObserver.prototype,
        ),
      ).toBe(false);
      expect(
        Object.getOwnPropertyDescriptor(
          QueryObserver.prototype,
          "createResult",
        ),
      ).toEqual(original);
    } finally {
      harness.dispose();
    }
  });

  it("releases the provider-less local query when the managed provider changes", async () => {
    const harness = createHarness();
    const providerlessKey = ["models", "list", "local", "chatgpt", 100];
    let nativeRefetches = 0;
    try {
      harness.client.clear();
      harness.client.setQueryDefaults(providerlessKey, {
        queryFn: async () => {
          nativeRefetches += 1;
          return raw;
        },
      });
      harness.client.setQueryData(providerlessKey, raw);
      harness.state.modelPickerQueryClients = new Map([
        [harness.client, harness.client],
      ]);

      new Function(
        "state",
        `${releaseCore}\nreleaseCodexModelPicker("openai");`,
      )(harness.state);
      await harness.state.modelPickerReleaseRefresh;

      expect(nativeRefetches).toBe(1);
      expect(harness.client.getQueryData(providerlessKey)).toEqual(raw);
    } finally {
      harness.dispose();
    }
  });

  it("cancels an in-flight managed query before fetching the native release catalog", async () => {
    const harness = createReleaseRaceHarness();
    const native = { data: [{ ...raw.data[0], model: "native-release" }] };
    try {
      const pending = harness.query.fetch().catch(() => undefined);
      expect(harness.requests.map((request) => request.provider)).toEqual([
        provider,
      ]);
      harness.setActiveProvider("openai");
      harness.releaseApi.release("openai");
      harness.requests[0].response.resolve(raw);

      await vi.waitFor(() => expect(harness.requests).toHaveLength(2));
      expect(harness.requests[0].signal.aborted).toBe(true);
      harness.requests[1].response.resolve(native);
      await Promise.all([pending, harness.state.modelPickerReleaseRefresh]);

      expect(harness.requests.map((request) => request.provider)).toEqual([
        provider,
        "openai",
      ]);
      expect(harness.client.getQueryData(harness.queryKey)).toEqual(native);
      expect(harness.observer.getCurrentResult().status).toBe("success");
      expect(
        harness.observer
          .getCurrentResult()
          .data?.models.map((row) => row.model),
      ).toEqual(["native-release"]);
    } finally {
      harness.dispose();
    }
  });

  it("does not clear a reactivated catalog when release cancellation settles late", async () => {
    const harness = createReleaseRaceHarness();
    const cancellationGate = deferred<void>();
    const cancel = harness.query.cancel.bind(harness.query);
    harness.query.cancel = (...args) =>
      Promise.all([cancel(...args), cancellationGate.promise]).then(
        () => undefined,
      );
    const next = { data: [{ ...raw.data[0], model: "reactivated-relay" }] };
    try {
      const pending = harness.query.fetch().catch(() => undefined);
      harness.setActiveProvider("openai");
      harness.releaseApi.release("openai");
      const releaseRefresh = harness.state.modelPickerReleaseRefresh;

      harness.releaseApi.cancel();
      harness.state.catalogReleased = false;
      harness.state.payload = {
        modelProvider: "next-managed-provider",
        catalogAvailable: true,
        modelNames: ["reactivated-relay"],
        models: [
          {
            model: "reactivated-relay",
            supported_reasoning_levels: [...allEfforts],
          },
        ],
      };
      harness.client.setQueryData(harness.queryKey, next);
      loadCore(harness.state).patchCodexModelReasoningQueryCache(
        harness.client.getQueryCache(),
      );
      cancellationGate.resolve();
      harness.requests[0].response.resolve(raw);
      await Promise.all([pending, releaseRefresh]);

      expect(harness.requests).toHaveLength(1);
      expect(harness.client.getQueryData(harness.queryKey)).toEqual(next);
      expect(harness.observer.getCurrentResult().status).toBe("success");
      expect(harness.observer.getCurrentResult().fetchStatus).toBe("idle");
      expect(
        harness.observer
          .getCurrentResult()
          .data?.models.map((row) => row.model),
      ).toEqual(["reactivated-relay"]);
      expect(
        harness.observer
          .getCurrentResult()
          .data?.models[0].supportedReasoningEfforts.map(
            (level) => level.reasoningEffort,
          ),
      ).toEqual(allEfforts);
    } finally {
      cancellationGate.resolve();
      harness.dispose();
    }
  });

  it.each(["pending", "fulfilled"])(
    "cancels its %s native refresh before a managed catalog reactivates",
    async (resolution) => {
      const harness = createReleaseRaceHarness();
      const next = { data: [{ ...raw.data[0], model: "reactivated-relay" }] };
      try {
        harness.setActiveProvider("openai");
        harness.releaseApi.release("openai");
        await vi.waitFor(() => expect(harness.requests).toHaveLength(1));
        const releaseRefresh = harness.state.modelPickerReleaseRefresh;
        const obsolete = {
          data: [{ ...raw.data[0], model: "obsolete-native" }],
        };
        if (resolution === "fulfilled")
          harness.requests[0].response.resolve(obsolete);

        harness.releaseApi.cancel();
        harness.state.catalogReleased = false;
        harness.state.payload = {
          modelProvider: provider,
          catalogAvailable: true,
          modelNames: ["reactivated-relay"],
          models: [
            {
              model: "reactivated-relay",
              supported_reasoning_levels: [...allEfforts],
            },
          ],
        };
        harness.client.setQueryData(harness.queryKey, next);
        loadCore(harness.state).patchCodexModelReasoningQueryCache(
          harness.client.getQueryCache(),
        );
        if (resolution === "pending")
          harness.requests[0].response.resolve(obsolete);
        await releaseRefresh;

        expect(harness.requests[0].signal.aborted).toBe(true);
        expect(harness.client.getQueryData(harness.queryKey)).toEqual(next);
        expect(harness.observer.getCurrentResult().fetchStatus).toBe("idle");
        expect(
          harness.observer
            .getCurrentResult()
            .data?.models.map((row) => row.model),
        ).toEqual(["reactivated-relay"]);
      } finally {
        harness.dispose();
      }
    },
  );

  it("retargets a pending native refresh when the released provider changes", async () => {
    const harness = createReleaseRaceHarness();
    const newest = { data: [{ ...raw.data[0], model: "newest-native" }] };
    try {
      harness.setActiveProvider("openai");
      harness.releaseApi.release("openai");
      await vi.waitFor(() => expect(harness.requests).toHaveLength(1));
      const oldRefresh = harness.state.modelPickerReleaseRefresh;

      harness.setActiveProvider("another-native-provider");
      harness.releaseApi.release("another-native-provider");
      harness.requests[0].response.resolve({
        data: [{ ...raw.data[0], model: "obsolete-native" }],
      });
      await vi.waitFor(() => expect(harness.requests).toHaveLength(2));
      expect(harness.requests[0].signal.aborted).toBe(true);
      const middleRefresh = harness.state.modelPickerReleaseRefresh;
      await oldRefresh;
      harness.setActiveProvider("newest-native-provider");
      harness.releaseApi.release("newest-native-provider");
      harness.requests[1].response.resolve({
        data: [{ ...raw.data[0], model: "obsolete-middle" }],
      });
      await vi.waitFor(() => expect(harness.requests).toHaveLength(3));
      expect(harness.requests[1].signal.aborted).toBe(true);
      harness.requests[2].response.resolve(newest);
      await Promise.all([
        middleRefresh,
        harness.state.modelPickerReleaseRefresh,
      ]);

      expect(harness.requests.map((request) => request.provider)).toEqual([
        "openai",
        "another-native-provider",
        "newest-native-provider",
      ]);
      expect(harness.state.payload.modelProvider).toBe(
        "newest-native-provider",
      );
      expect(harness.client.getQueryData(harness.queryKey)).toEqual(newest);
      expect(
        harness.observer
          .getCurrentResult()
          .data?.models.map((row) => row.model),
      ).toEqual(["newest-native"]);
    } finally {
      harness.dispose();
    }
  });

  it("does not cancel a newer external fetch that replaced its native refresh", async () => {
    const harness = createReleaseRaceHarness();
    const newest = { data: [{ ...raw.data[0], model: "external-newest" }] };
    try {
      harness.setActiveProvider("openai");
      harness.releaseApi.release("openai");
      await vi.waitFor(() => expect(harness.requests).toHaveLength(1));
      const releaseRefresh = harness.state.modelPickerReleaseRefresh;

      const cancellation = harness.query.cancel({ silent: true });
      harness.setActiveProvider("external-new-provider");
      const externalFetch = harness.query.fetch();
      expect(harness.requests).toHaveLength(2);
      harness.releaseApi.cancel();
      expect(harness.requests[1].signal.aborted).toBe(false);
      harness.requests[0].response.resolve(raw);
      harness.requests[1].response.resolve(newest);
      await Promise.all([cancellation, releaseRefresh, externalFetch]);

      expect(harness.client.getQueryData(harness.queryKey)).toEqual(newest);
      expect(harness.observer.getCurrentResult().status).toBe("success");
    } finally {
      harness.dispose();
    }
  });

  it("preserves newer query data written while release cancellation is pending", async () => {
    const harness = createReleaseRaceHarness();
    const cancellationGate = deferred<void>();
    const cancel = harness.query.cancel.bind(harness.query);
    harness.query.cancel = (...args) =>
      Promise.all([cancel(...args), cancellationGate.promise]).then(
        () => undefined,
      );
    const newest = { data: [{ ...raw.data[0], model: "newer-native-cache" }] };
    try {
      const pending = harness.query.fetch().catch(() => undefined);
      harness.setActiveProvider("openai");
      harness.releaseApi.release("openai");
      harness.client.setQueryData(harness.queryKey, newest);
      cancellationGate.resolve();
      harness.requests[0].response.resolve(raw);
      await Promise.all([pending, harness.state.modelPickerReleaseRefresh]);

      expect(harness.requests).toHaveLength(1);
      expect(harness.client.getQueryData(harness.queryKey)).toEqual(newest);
      expect(harness.observer.getCurrentResult().status).toBe("success");
      expect(harness.observer.getCurrentResult().fetchStatus).toBe("idle");
    } finally {
      cancellationGate.resolve();
      harness.dispose();
    }
  });

  it("preserves the cache if cancellation fails instead of clearing a live query", async () => {
    const harness = createReleaseRaceHarness();
    const cancel = harness.query.cancel;
    const cancellationFailure = new Error(
      "synthetic catalog cancellation failure",
    );
    harness.query.cancel = () => {
      throw cancellationFailure;
    };
    try {
      harness.setActiveProvider("openai");
      harness.releaseApi.release("openai");
      await Promise.resolve();

      expect(harness.client.getQueryData(harness.queryKey)).toEqual(raw);
      expect(harness.requests).toHaveLength(0);
      expect(await harness.state.modelPickerReleaseRefresh).toEqual([
        { status: "fulfilled", value: undefined },
        { status: "rejected", reason: cancellationFailure },
      ]);
    } finally {
      harness.query.cancel = cancel;
      harness.dispose();
    }
  });

  it("connects private-registry module discovery to the first real picker snapshot", async () => {
    const harness = createHarness();
    const client = new QueryClient();
    let snapshot: typeof harness.observer | undefined;
    try {
      client.setQueryData(key, raw);
      const scope = {
        chain: {},
        node: {},
        get() {},
        set() {},
        watch() {},
        get queryClient() {
          return client;
        },
      };
      const discover = new Function(
        "state",
        "window",
        "document",
        `${core}
${discoveryCore}
const patchRequestClient = () => false;
const recordFailure = (error) => { throw error; };
const monotonicNow = () => 0;
const yieldReactDiscovery = async () => {};
return patchCodexScopedAppServerClients;`,
      )(
        harness.state,
        {
          __codexRoot: {
            _internalRoot: {
              current: {
                dependencies: { firstContext: { memoizedValue: scope } },
              },
            },
          },
        },
        { getElementById: () => null },
      ) as (module: object) => Promise<number>;
      expect(await discover({ minifiedObserverAlias: QueryObserver })).toBe(0);
      expect(client.getQueryCache().getAll()[0].observers).toEqual([]);
      snapshot = new QueryObserver(client, harness.options);
      expect(
        snapshot
          .getCurrentResult()
          .data?.models[0].supportedReasoningEfforts.map(
            (level) => level.reasoningEffort,
          ),
      ).toEqual(allEfforts);
      expect(
        snapshot.getOptimisticResult(
          client.defaultQueryOptions(harness.options),
        ).data,
      ).toBe(snapshot.getCurrentResult().data);
    } finally {
      snapshot?.destroy();
      harness.dispose();
      client.clear();
    }
  });

  it("restores the missing Max stop when a shell scope precedes the picker scope", async () => {
    const harness = createHarness();
    const shell = new QueryClient();
    const picker = new QueryClient();
    let snapshot: typeof harness.observer | undefined;
    let mounted: typeof harness.observer | undefined;
    let unsubscribe = () => {};
    const scopeFor = (queryClient: QueryClient) => ({
      chain: {},
      node: {},
      get() {},
      set() {},
      watch() {},
      get queryClient() {
        return queryClient;
      },
    });
    try {
      picker.setQueryData(key, raw);
      const discover = new Function(
        "state",
        "window",
        "document",
        [
          core,
          discoveryCore,
          "const patchRequestClient = () => false;",
          "const recordFailure = (error) => { throw error; };",
          "const monotonicNow = () => 0;",
          "const yieldReactDiscovery = async () => {};",
          "return patchCodexScopedAppServerClients;",
        ].join("\n"),
      )(
        harness.state,
        {
          __codexRoot: {
            _internalRoot: {
              current: {
                dependencies: {
                  firstContext: { memoizedValue: scopeFor(shell) },
                },
                child: {
                  dependencies: {
                    firstContext: { memoizedValue: scopeFor(picker) },
                  },
                },
              },
            },
          },
        },
        { getElementById: () => null },
      ) as (module: object) => Promise<number>;
      const options = {
        ...harness.options,
        select: (value: typeof raw) => {
          const models = value.data.map((model) => ({
            ...model,
            supportedReasoningEfforts: model.supportedReasoningEfforts.filter(
              ({ reasoningEffort }) => reasoningEffort !== "max",
            ),
          }));
          return {
            models,
            defaultModel: models[0],
            hasModelSupportingMaxReasoningEffort: true,
            hasModelSupportingUltraReasoningEffort: true,
          };
        },
      };
      snapshot = new QueryObserver(picker, options);
      const stops = () =>
        snapshot!
          .getCurrentResult()
          .data!.models[0].supportedReasoningEfforts.map(
            ({ reasoningEffort }) => reasoningEffort,
          );
      expect(stops()).toEqual(["low", "medium", "high", "xhigh", "ultra"]);
      mounted = new QueryObserver(picker, options);
      const updates: string[][] = [];
      unsubscribe = mounted.subscribe((result) => {
        updates.push(
          result.data!.models[0].supportedReasoningEfforts.map(
            ({ reasoningEffort }) => reasoningEffort,
          ),
        );
      });
      await discover({ minifiedObserverAlias: QueryObserver });
      expect(
        mounted
          .getCurrentResult()
          .data!.models[0].supportedReasoningEfforts.map(
            ({ reasoningEffort }) => reasoningEffort,
          ),
      ).toEqual(allEfforts);
      expect(updates).toContainEqual(allEfforts);
      snapshot.getOptimisticResult(picker.defaultQueryOptions(options));
      expect(stops()).toEqual(allEfforts);
      expect(picker.getQueryData(key)).toBe(raw);
      expect(
        harness.state.reasoningQueryCaches?.has(picker.getQueryCache()),
      ).toBe(true);
    } finally {
      unsubscribe();
      mounted?.destroy();
      snapshot?.destroy();
      harness.dispose();
      shell.clear();
      picker.clear();
    }
  });

  it("uses current catalog capabilities and does not affect remote queries", () => {
    const harness = createHarness();
    try {
      harness.patch();
      harness.state.payload = {
        ...harness.state.payload,
        models: [
          {
            model: "sol-relay",
            supported_reasoning_levels: ["high", "max"],
          },
        ],
      };
      harness.patch();
      expect(harness.efforts()).toEqual(["high", "max"]);
      const remoteKey = key.map((value) =>
        value === "local" ? "remote" : value,
      );
      harness.client.setQueryData(remoteKey, raw);
      harness.observer.setOptions({
        ...harness.options,
        queryKey: remoteKey,
      });
      expect(harness.efforts()).toEqual(allEfforts.slice(0, 4));
      harness.patch();
      expect(harness.efforts()).toEqual(allEfforts.slice(0, 4));
    } finally {
      harness.dispose();
    }
  });

  it("patches replacement observers without changing cached provider data", () => {
    const harness = createHarness();
    let unsubscribe: (() => void) | undefined;
    try {
      harness.patch();
      const replacement = new QueryObserver(harness.client, {
        ...harness.options,
        select: (value) => select(value as typeof raw),
      });
      unsubscribe = replacement.subscribe(() => {});
      expect(
        replacement
          .getCurrentResult()
          .data?.models[0].supportedReasoningEfforts.map(
            (level) => level.reasoningEffort,
          ),
      ).toEqual(allEfforts);
      expect(harness.client.getQueryData(key)).toBe(raw);
    } finally {
      unsubscribe?.();
      harness.dispose();
    }
  });

  it("clears cached capabilities when an explicit empty declaration replaces them", () => {
    const harness = createHarness();
    try {
      harness.patch();
      harness.state.payload = {
        ...harness.state.payload,
        models: [
          {
            model: "sol-relay",
            supportedReasoningEfforts: [],
            supported_reasoning_levels: [...allEfforts],
            defaultReasoningEffort: "ultra",
          },
        ],
      };
      harness.patch();
      expect(harness.efforts()).toEqual([]);
      expect(
        harness.observer.getCurrentResult().data?.models[0],
      ).not.toHaveProperty("defaultReasoningEffort");
    } finally {
      harness.dispose();
    }
  });

  it("removes excluded catalog rows from a cached picker", () => {
    const harness = createHarness();
    try {
      harness.patch();
      harness.state.payload = {
        ...harness.state.payload,
        models: [
          {
            model: "sol-relay",
            enabled: false,
            supported_reasoning_levels: [...allEfforts],
          },
        ],
      };
      harness.patch();
      expect(harness.observer.getCurrentResult().data?.models).toEqual([]);
    } finally {
      harness.dispose();
    }
  });

  it("reprojects current provider state and unwraps unrelated observer options", () => {
    const harness = createHarness();
    try {
      harness.patch();
      const otherProvider = "other-provider";
      harness.state.payload = {
        modelProvider: otherProvider,
        catalogAvailable: true,
        modelNames: ["sol-relay"],
        models: [
          { model: "sol-relay", supported_reasoning_levels: ["high", "max"] },
        ],
      };
      harness.patch();
      expect(harness.efforts()).toEqual(allEfforts.slice(0, 4));
      const unwrapped = harness.observer.options.select;
      harness.patch();
      expect(harness.observer.options.select).toBe(unwrapped);
      expect(unwrapped).toBe(select);
      const otherKey = key.map((part) =>
        part === provider ? otherProvider : part,
      );
      harness.client.setQueryData(otherKey, raw);
      harness.observer.setOptions({
        ...harness.options,
        queryKey: otherKey,
      });
      expect(harness.efforts()).toEqual(["high", "max"]);
    } finally {
      harness.dispose();
    }
  });

  it("clears stale raw reasoning aliases without erasing unrelated model metadata", () => {
    const harness = createHarness();
    try {
      harness.state.payload.models = [{ model: "sol-relay" }];
      const models: Record<string, unknown>[] = [
        {
          model: "sol-relay",
          defaultReasoningEffort: "ultra",
          default_reasoning_level: "ultra",
          supportedReasoningEfforts: [{ reasoningEffort: "ultra" }],
          supportedReasoningLevels: [{ effort: "ultra" }],
          supported_reasoning_levels: ["ultra"],
          supported_reasoning_efforts: ["ultra"],
          reasoning: { supportedEfforts: ["ultra"], defaultEffort: "ultra" },
          inputModalities: ["text", "image"],
          unknownMetadata: { preserve: true },
        },
      ];
      harness.api.patchModelArray(models);
      for (const field of [
        "defaultReasoningEffort",
        "default_reasoning_level",
        "supportedReasoningLevels",
        "supported_reasoning_levels",
        "supported_reasoning_efforts",
        "reasoning",
      ]) {
        expect(models[0]).not.toHaveProperty(field);
      }
      // Codex's native model select reads supportedReasoningEfforts unguarded.
      // A managed row with no declared efforts keeps the canonical empty array
      // instead of dropping the field and crashing the picker.
      expect(models[0].supportedReasoningEfforts).toEqual([]);
      expect(models[0].inputModalities).toEqual(["text", "image"]);
      expect(models[0].unknownMetadata).toEqual({ preserve: true });
    } finally {
      harness.dispose();
    }
  });

  it("keeps the native model select alive when a managed row declares no efforts", () => {
    const harness = createHarness();
    try {
      harness.state.payload.modelNames = ["sol-relay", "plain-relay"];
      harness.state.payload.models = [
        { model: "sol-relay", supported_reasoning_levels: [...allEfforts] },
        { model: "plain-relay", supported_reasoning_levels: [] },
      ];
      const mixedRaw = Object.freeze({
        data: Object.freeze([
          Object.freeze({
            model: "sol-relay",
            supportedReasoningEfforts: Object.freeze(
              allEfforts.map((reasoningEffort) =>
                Object.freeze({
                  reasoningEffort,
                  description: reasoningEffort,
                }),
              ),
            ),
          }),
          // The provider declares no efforts, so the raw response omits the
          // field entirely and the native select throws on it.
          Object.freeze({ model: "plain-relay", displayName: "Plain" }),
        ]),
      });
      harness.client.setQueryData(key, mixedRaw);
      const cachedRaw = harness.client.getQueryData<typeof mixedRaw>(key)!;
      // TanStack can reuse existing rows while accepting new data. Freeze the
      // actual cache value as well as the input fixture before native selection.
      for (const row of cachedRaw.data) Object.freeze(row);
      Object.freeze(cachedRaw.data);
      Object.freeze(cachedRaw);
      harness.observer.setOptions({
        ...harness.options,
        select: (value) => ({
          ...select(value),
          hasModelSupportingMaxReasoningEffort: value.data.some((model) =>
            model.supportedReasoningEfforts.some(
              (level) => level.reasoningEffort === "max",
            ),
          ),
          hasModelSupportingUltraReasoningEffort: value.data.some((model) =>
            model.supportedReasoningEfforts.some(
              (level) => level.reasoningEffort === "ultra",
            ),
          ),
        }),
      });

      harness.patch();
      const result = harness.observer.getCurrentResult();

      expect(result.status).toBe("success");
      expect(result.data?.models.map((model) => model.model)).toEqual([
        "sol-relay",
        "plain-relay",
      ]);
      expect(result.data?.models[1].supportedReasoningEfforts).toEqual([]);
      expect(result.data?.models[1]).not.toHaveProperty(
        "defaultReasoningEffort",
      );
      expect(
        result.data?.models[0].supportedReasoningEfforts.map(
          (level) => level.reasoningEffort,
        ),
      ).toEqual(allEfforts);
      expect(result.data?.hasModelSupportingMaxReasoningEffort).toBe(true);
      expect(result.data?.hasModelSupportingUltraReasoningEffort).toBe(true);
      expect(harness.client.getQueryData(key)).toBe(cachedRaw);
      expect(cachedRaw).toStrictEqual(mixedRaw);
      expect(mixedRaw.data[1]).not.toHaveProperty("supportedReasoningEfforts");
      for (let pass = 0; pass < 5; pass += 1) harness.patch();
      expect(harness.observer.getCurrentResult().data).toBe(result.data);
    } finally {
      harness.dispose();
    }
  });

  it("preserves a mixed effort inventory through reinjection, release, and provider change", async () => {
    const harness = createHarness();
    const includedPayload = {
      ...harness.state.payload,
      modelNames: ["sol-relay", "plain-relay"],
      models: [
        { model: "sol-relay", supported_reasoning_levels: [...allEfforts] },
        { model: "plain-relay", supported_reasoning_levels: [] },
      ],
    };
    const mixedRaw = {
      data: [raw.data[0], { model: "plain-relay", displayName: "Plain" }],
    };
    const assertMixed = (expectedEfforts: string[]) => {
      const result = harness.observer.getCurrentResult();
      expect(result.status).toBe("success");
      expect(result.data?.models.map((model) => model.model)).toEqual([
        "sol-relay",
        "plain-relay",
      ]);
      expect(
        result.data?.models[0].supportedReasoningEfforts.map(
          (level) => level.reasoningEffort,
        ),
      ).toEqual(expectedEfforts);
      expect(result.data?.models[1].supportedReasoningEfforts).toEqual([]);
      expect(result.data?.models[1]).not.toHaveProperty(
        "defaultReasoningEffort",
      );
    };
    try {
      harness.state.payload = includedPayload;
      harness.client.setQueryData(key, mixedRaw);
      harness.patch();
      assertMixed(allEfforts);

      const caches = prepareCacheReinjection(harness.state);
      const reinstalled = loadCore(harness.state);
      for (const cache of caches)
        reinstalled.patchCodexModelReasoningQueryCache(cache);
      assertMixed(allEfforts);

      let nativeRequests = 0;
      const native = { data: [{ ...raw.data[0], model: "official-native" }] };
      harness.state.modelPickerQueryClients = new Map([
        [harness.client.getQueryCache(), harness.client],
      ]);
      harness.observer.setOptions({
        ...harness.options,
        queryFn: async () => {
          nativeRequests += 1;
          return native;
        },
      });
      const release = new Function(
        "state",
        releaseCore + "\nreturn releaseCodexModelPicker;",
      )(harness.state) as (provider: string) => boolean;
      expect(release("openai")).toBe(true);
      await harness.state.modelPickerReleaseRefresh;
      expect(nativeRequests).toBe(1);
      expect(harness.observer.getCurrentResult().status).toBe("success");
      expect(
        harness.observer
          .getCurrentResult()
          .data?.models.map((model) => model.model),
      ).toEqual(["official-native"]);
      expect(harness.observer.options.select).toBe(select);

      const otherProvider = "another-managed-provider";
      const otherKey = key.map((part) =>
        part === provider ? otherProvider : part,
      );
      harness.state.payload = {
        ...includedPayload,
        modelProvider: otherProvider,
        models: [
          { model: "sol-relay", supported_reasoning_levels: ["medium", "max"] },
          { model: "plain-relay", supported_reasoning_levels: [] },
        ],
      };
      harness.state.catalogReleased = false;
      harness.client.setQueryData(otherKey, mixedRaw);
      harness.observer.setOptions({ ...harness.options, queryKey: otherKey });
      loadCore(harness.state).patchCodexModelReasoningQueryCache(
        harness.client.getQueryCache(),
      );
      assertMixed(["medium", "max"]);
      expect(
        harness.observer.getCurrentResult().data
          ?.hasModelSupportingUltraReasoningEffort,
      ).toBe(false);
      expect(harness.client.getQueryData(otherKey)).toBe(mixedRaw);
      expect(mixedRaw.data[1]).not.toHaveProperty("supportedReasoningEfforts");
    } finally {
      harness.dispose();
    }
  });

  it("matches unique declared identities without borrowing a shared upstream alias", () => {
    const harness = createHarness();
    try {
      harness.state.payload = {
        ...harness.state.payload,
        modelNames: ["sol-relay", "sol-backup"],
        models: [
          {
            model: "sol-relay",
            id: "provider/sol-relay",
            canonicalSlug: "provider/sol-release",
            aliases: ["sol-picker-alias"],
            upstreamModel: "gpt-sol",
            supported_reasoning_levels: ["high", "max", "ultra"],
          },
          {
            model: "sol-backup",
            id: "provider/sol-backup",
            upstreamModel: "gpt-sol",
            supported_reasoning_levels: ["low", "high"],
          },
        ],
      };
      const official = {
        model: "gpt-sol",
        supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
      };
      const unknown = {
        id: "gpt-sol",
        supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
      };
      const selection = {
        models: [
          { id: "provider/sol-release", supportedReasoningEfforts: [] },
          { model: "sol-picker-alias", supportedReasoningEfforts: [] },
          { model: "sol-backup", supportedReasoningEfforts: [] },
          official,
          unknown,
        ],
      };
      const restored = harness.api.restoreCodexCatalogReasoningSelection(
        key,
        selection,
      );
      expect(
        restored.models
          .slice(0, 3)
          .map((model) => model.supportedReasoningEfforts),
      ).toEqual([
        ["high", "max", "ultra"].map((reasoningEffort) => ({
          reasoningEffort,
          description: reasoningEffort,
        })),
        ["high", "max", "ultra"].map((reasoningEffort) => ({
          reasoningEffort,
          description: reasoningEffort,
        })),
        ["low", "high"].map((reasoningEffort) => ({
          reasoningEffort,
          description: reasoningEffort,
        })),
      ]);
      expect(restored.models).toHaveLength(3);
      expect(restored.models).not.toContain(official);
      expect(restored.models).not.toContain(unknown);
    } finally {
      harness.dispose();
    }
  });

  it("reconciles aggregate effort flags even when model levels are already current", () => {
    const harness = createHarness();
    try {
      harness.state.payload.models[0].defaultReasoningEffort = "high";
      const selection = {
        models: structuredClone(raw.data),
        defaultModel: raw.data[0],
        hasModelSupportingMaxReasoningEffort: false,
        hasModelSupportingUltraReasoningEffort: false,
      };
      const restored = harness.api.restoreCodexCatalogReasoningSelection(
        key,
        selection,
      );
      expect(restored.hasModelSupportingMaxReasoningEffort).toBe(true);
      expect(restored.hasModelSupportingUltraReasoningEffort).toBe(true);
      expect(restored.defaultModel).toBe(restored.models[0]);
    } finally {
      harness.dispose();
    }
  });

  it("keeps distinct public routes separate when they share an upstream identity", () => {
    const harness = createHarness();
    try {
      harness.state.payload = {
        ...harness.state.payload,
        modelNames: ["sol-relay", "sol-backup"],
        models: [
          {
            model: "sol-relay",
            upstreamModel: "gpt-sol",
            supported_reasoning_levels: ["high", "max", "ultra"],
          },
          {
            model: "sol-backup",
            upstreamModel: "gpt-sol",
            supported_reasoning_levels: ["high"],
          },
        ],
      };
      const official = {
        model: "gpt-sol",
        supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
      };
      const models: Record<string, unknown>[] = [official];
      harness.api.patchModelArray(models);
      expect(models.map((model) => model.model)).toEqual([
        "sol-relay",
        "sol-backup",
        "gpt-sol",
      ]);
      expect(models[2]).toBe(official);
      expect(official.supportedReasoningEfforts).toEqual([
        { reasoningEffort: "medium" },
      ]);
    } finally {
      harness.dispose();
    }
  });

  it("never injects excluded rows or a stale default into raw model lists", () => {
    const harness = createHarness();
    try {
      const models: Record<string, unknown>[] = [];
      harness.state.payload.models[0].enabled = false;
      harness.api.patchModelArray(models, true);
      expect(models).toEqual([]);
    } finally {
      harness.dispose();
    }
  });

  it("does not treat unknown modelNames as managed catalog rows", () => {
    const harness = createHarness();
    try {
      harness.state.payload = {
        ...harness.state.payload,
        modelNames: ["stale-provider-model"],
      };
      const models: Record<string, unknown>[] = [
        { model: "stale-provider-model" },
      ];
      harness.api.patchModelArray(models, true, true);
      expect(models).toEqual([]);
    } finally {
      harness.dispose();
    }
  });

  it("does not post-filter a cached selection while the catalog is unavailable", () => {
    const harness = createHarness();
    try {
      harness.state.payload = {
        ...harness.state.payload,
        catalogAvailable: false,
        modelNames: [],
        models: [],
      };
      const selection = {
        models: [{ model: "provider-fetched-model" }],
        defaultModel: { model: "provider-fetched-model" },
      };
      expect(
        harness.api.restoreCodexCatalogReasoningSelection(key, selection),
      ).toBe(selection);
    } finally {
      harness.dispose();
    }
  });

  it("repairs an unknown defaultModel to the first retained catalog model", () => {
    const harness = createHarness();
    try {
      const selection = {
        models: [{ model: "sol-relay", supportedReasoningEfforts: [] }],
        defaultModel: { model: "provider-fetched-model" },
      };
      const restored = harness.api.restoreCodexCatalogReasoningSelection(
        key,
        selection,
      );
      expect(restored.models).toHaveLength(1);
      expect(restored.defaultModel).toBe(restored.models[0]);
    } finally {
      harness.dispose();
    }
  });

  it("does not throw when patch inputs are frozen or sealed", () => {
    const harness = createHarness();
    try {
      const frozenModels = Object.freeze([
        Object.freeze({ model: "sol-relay" }),
      ]) as unknown as Record<string, unknown>[];
      expect(() =>
        harness.api.patchModelArray(frozenModels, true),
      ).not.toThrow();

      const sealedModels = Object.seal([
        { model: "sol-relay" },
      ]) as unknown as Record<string, unknown>[];
      expect(() =>
        harness.api.patchModelArray(sealedModels, true),
      ).not.toThrow();

      const frozenModel = Object.freeze({ model: "sol-relay" });
      const mutableModels = [frozenModel] as unknown as Record<
        string,
        unknown
      >[];
      expect(() =>
        harness.api.patchModelArray(mutableModels, true),
      ).not.toThrow();
      expect(mutableModels[0]).not.toBe(frozenModel);
      expect(mutableModels[0]).toEqual(
        expect.objectContaining({ model: "sol-relay" }),
      );
    } finally {
      harness.dispose();
    }
  });

  it("removes previously managed cached rows after rename and canonical empty refresh", () => {
    const harness = createHarness();
    try {
      harness.patch();
      const official = {
        model: "official-sol",
        supportedReasoningEfforts: [{ reasoningEffort: "high" }],
      };
      const models: Record<string, unknown>[] = [official];
      harness.api.patchModelArray(models);
      harness.state.payload = {
        ...harness.state.payload,
        modelNames: ["renamed-sol"],
        models: [
          {
            model: "renamed-sol",
            supported_reasoning_levels: ["high", "max"],
          },
        ],
      };
      harness.patch();
      expect(harness.observer.getCurrentResult().data?.models).toEqual([]);
      const idOnlyQuery = {
        models: [{ id: "sol-relay", supportedReasoningEfforts: [] }],
      };
      const renamedSelection = {
        ...idOnlyQuery,
        defaultModel: idOnlyQuery.models[0],
      };
      const restored = harness.api.restoreCodexCatalogReasoningSelection(
        key,
        renamedSelection,
      );
      expect(restored.models).toEqual([]);
      expect(restored.defaultModel).toBeUndefined();
      harness.api.patchModelArray(models);
      expect(models.map((model) => model.model)).toEqual([
        "renamed-sol",
        "official-sol",
      ]);
      harness.state.payload = {
        ...harness.state.payload,
        modelNames: [],
        models: [],
      };
      harness.api.patchModelArray(models);
      expect(models).toEqual([official]);
      expect(models[0]).toBe(official);
    } finally {
      harness.dispose();
    }
  });

  it("drops pre-existing cached rows and defaults for a fresh authoritative empty catalog", () => {
    const harness = createHarness();
    try {
      // Simulate the first injection after Desktop has already populated its
      // query cache: there is no prior managed-name history to classify the
      // cached row as retired.
      harness.state.payload = {
        ...harness.state.payload,
        catalogAvailable: true,
        modelNames: [],
        models: [],
      };
      const stale = {
        model: "stale-managed",
        supportedReasoningEfforts: [{ reasoningEffort: "high" }],
      };
      const restored = harness.api.restoreCodexCatalogReasoningSelection(key, {
        models: [stale],
        defaultModel: stale,
        hasModelSupportingMaxReasoningEffort: true,
        hasModelSupportingUltraReasoningEffort: true,
      });
      expect(restored.models).toEqual([]);
      expect(restored.defaultModel).toBeUndefined();
      expect(restored.hasModelSupportingMaxReasoningEffort).toBe(false);
      expect(restored.hasModelSupportingUltraReasoningEffort).toBe(false);
    } finally {
      harness.dispose();
    }
  });

  it("preserves owned raw rows when a catalog refresh is unavailable", () => {
    const harness = createHarness();
    try {
      const models: Record<string, unknown>[] = [];
      harness.api.patchModelArray(models, true);
      const before = structuredClone(models);
      harness.state.payload = {
        ...harness.state.payload,
        catalogAvailable: false,
        modelNames: [],
        models: [],
      };
      harness.api.patchModelArray(models);
      expect(models).toEqual(before);
    } finally {
      harness.dispose();
    }
  });

  it("does not mutate source capability objects while clearing stale nested aliases", () => {
    const harness = createHarness();
    try {
      harness.state.payload.models = [
        {
          model: "sol-relay",
          supportedReasoningEfforts: [],
          reasoning: {
            supportedEfforts: ["ultra"],
            defaultEffort: "ultra",
            providerHint: "preserve-catalog-metadata",
          },
        },
      ];
      const beforePayload = structuredClone(harness.state.payload);
      const model = {
        model: "sol-relay",
        supportedReasoningEfforts: [{ reasoningEffort: "ultra" }],
        reasoning: {
          supportedEfforts: ["ultra"],
          defaultEffort: "ultra",
          pickerHint: "preserve-renderer-metadata",
        },
      };
      const selection = { models: [model] };
      const beforeSelection = structuredClone(selection);
      const restored = harness.api.restoreCodexCatalogReasoningSelection(
        key,
        selection,
      );
      expect(harness.state.payload).toEqual(beforePayload);
      expect(selection).toEqual(beforeSelection);
      expect(restored.models[0].supportedReasoningEfforts).toEqual([]);
      expect(restored.models[0].reasoning).toEqual({
        providerHint: "preserve-catalog-metadata",
        pickerHint: "preserve-renderer-metadata",
      });
    } finally {
      harness.dispose();
    }
  });

  it("does not replace an unrelated official model with its routed upstream alias", () => {
    const harness = createHarness();
    try {
      harness.state.payload.models[0].upstreamModel = "gpt-sol";
      const official = {
        model: "gpt-sol",
        supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
      };
      const models: Record<string, unknown>[] = [official];
      harness.api.patchModelArray(models);
      expect(models.map((model) => model.model)).toEqual([
        "sol-relay",
        "gpt-sol",
      ]);
      expect(models[1]).toBe(official);
      expect(official.supportedReasoningEfforts).toEqual([
        { reasoningEffort: "medium" },
      ]);
    } finally {
      harness.dispose();
    }
  });
});
