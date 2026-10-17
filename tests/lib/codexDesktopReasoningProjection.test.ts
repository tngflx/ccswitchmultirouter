import { readFileSync } from "node:fs";
import path from "node:path";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

const core = readFileSync(
  path.resolve(
    process.cwd(),
    "src-tauri/src/resources/codex_model_picker_core.js",
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
const select = (value: typeof raw) => ({
  models: value.data.map((model) => ({
    ...model,
    supportedReasoningEfforts: model.supportedReasoningEfforts.filter((level) =>
      ["low", "medium", "high", "xhigh"].includes(level.reasoningEffort),
    ),
  })),
});
type State = {
  payload: {
    modelProvider: string;
    catalogAvailable: boolean;
    modelNames: string[];
    models: ({ model: string } & Record<string, unknown>)[];
  };
  reasoningQueryCaches?: Map<unknown, { unsubscribe: () => void }>;
};
type Core = {
  patchCodexModelReasoningQueryCache: (
    cache: ReturnType<QueryClient["getQueryCache"]>,
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
const loadCore = (state: State) =>
  new Function(
    "state",
    `${core}\nreturn { patchCodexModelReasoningQueryCache, patchModelArray, restoreCodexCatalogReasoningSelection };`,
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
      for (const entry of state.reasoningQueryCaches?.values() ?? [])
        entry.unsubscribe();
      unsubscribe();
      client.clear();
    },
  };
};

describe("Codex Desktop post-filter reasoning projection", () => {
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
        "supportedReasoningEfforts",
        "supportedReasoningLevels",
        "supported_reasoning_levels",
        "supported_reasoning_efforts",
        "reasoning",
      ]) {
        expect(models[0]).not.toHaveProperty(field);
      }
      expect(models[0].inputModalities).toEqual(["text", "image"]);
      expect(models[0].unknownMetadata).toEqual({ preserve: true });
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
