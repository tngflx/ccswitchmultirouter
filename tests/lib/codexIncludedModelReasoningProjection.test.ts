import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import fixture from "../fixtures/codexIncludedModelReasoning.json";

type PickerModel = {
  model: string;
  supportedReasoningEfforts?: { reasoningEffort: string }[];
  defaultReasoningEffort?: string;
  providerName?: string;
  providerId?: string;
  enabled?: boolean;
  [field: string]: unknown;
};
type MatrixProvider = (typeof fixture.providers)[number];
type MatrixCase = MatrixProvider["models"][number];
type Binding = { provider: MatrixProvider; entry: MatrixCase };
type PickerSelection = {
  models: PickerModel[];
  defaultModel?: PickerModel;
  hasModelSupportingMaxReasoningEffort?: boolean;
  hasModelSupportingUltraReasoningEffort?: boolean;
};

const core = readFileSync(
  path.resolve(
    process.cwd(),
    "src-tauri/src/resources/codex_desktop/model_picker_core.js",
  ),
  "utf8",
);
const bindings = fixture.providers.flatMap((provider) =>
  provider.models.map((entry) => ({ provider, entry })),
);
const staleEfforts = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];
const key = [
  "models",
  "list",
  "local",
  "chatgpt",
  100,
  "codex_model_router_v2",
];
const effortNames = (row: PickerModel | undefined) =>
  row?.supportedReasoningEfforts?.map((level) => level.reasoningEffort);

function descriptor({ provider, entry }: Binding): PickerModel {
  return {
    model: entry.pickerModel,
    upstreamModel: entry.catalog.model,
    providerId: provider.id,
    providerName: provider.name,
    enabled: true,
    supported_reasoning_levels: [...entry.expected.pickerEfforts],
    ...("defaultEffort" in entry.expected
      ? { default_reasoning_effort: entry.expected.defaultEffort }
      : {}),
    reasoning: {
      controlKind: entry.expected.controlKind,
      supportedEfforts: [...entry.expected.nativeEfforts],
    },
  };
}

function loadPicker(current: Binding[]) {
  const state = {
    payload: {
      modelProvider: "codex_model_router_v2",
      catalogAvailable: true,
      modelNames: current.map(({ entry }) => entry.pickerModel),
      models: current.map(descriptor),
    },
  };
  const api = new Function(
    "state",
    `${core}\nreturn { patchModelArray, restoreCodexCatalogReasoningSelection, codexModelCatalogDiagnostics };`,
  )(state) as {
    patchModelArray: (
      models: PickerModel[],
      allowEmpty?: boolean,
      managedOnly?: boolean,
    ) => boolean;
    restoreCodexCatalogReasoningSelection: (
      queryKey: unknown[],
      selection: PickerSelection,
    ) => PickerSelection;
    codexModelCatalogDiagnostics: () => {
      reasoningModelCount: number;
      maxEffortModelCount: number;
      ultraEffortModelCount: number;
    };
  };
  return { state, api };
}

function staleRow(binding: Binding): PickerModel {
  return {
    model: binding.entry.pickerModel,
    upstreamModel: binding.entry.catalog.model,
    defaultReasoningEffort: "ultra",
    supportedReasoningEfforts: staleEfforts.map((reasoningEffort) => ({
      reasoningEffort,
    })),
    reasoning: {
      defaultEffort: "ultra",
      supportedEfforts: [...staleEfforts],
    },
  };
}

// The fixture enumerates model/provider bindings, not just model names: the same
// GPT model through Official, Sublyx, and a relay must never share wire claims.
describe("included-model Codex Desktop picker reasoning matrix", () => {
  it("covers all 45 included bindings and the 37-model active router separately", () => {
    expect(bindings).toHaveLength(45);
    expect(
      bindings.filter(({ provider }) => provider.profile === "router"),
    ).toHaveLength(37);
    expect(
      bindings.filter(({ provider }) => provider.profile === "official"),
    ).toHaveLength(8);
    expect(
      new Set(
        bindings.map(
          ({ provider, entry }) => `${provider.key}:${entry.catalog.model}`,
        ),
      ).size,
    ).toBe(45);
    expect(new Set(bindings.map(({ entry }) => entry.pickerModel)).size).toBe(
      45,
    );

    const openrouter = bindings.filter(
      ({ provider }) => provider.key === "openrouter",
    );
    expect(openrouter).toHaveLength(20);
    expect(
      openrouter.reduce<Record<string, number>>((counts, { entry }) => {
        counts[entry.expected.controlKind] =
          (counts[entry.expected.controlKind] ?? 0) + 1;
        return counts;
      }, {}),
    ).toEqual({ graded: 6, boolean: 9, budget: 1, none: 4 });
    for (const { entry } of openrouter) {
      expect("apiModel" in entry && entry.apiModel.id).toBe(
        entry.catalog.model,
      );
    }
  });

  it.each(bindings)(
    "$provider.name / $entry.catalog.model retains its declared picker efforts after native filtering",
    (binding) => {
      const { state, api } = loadPicker([binding]);
      const before = JSON.stringify(state.payload);
      const raw: PickerModel[] = [staleRow(binding)];
      api.patchModelArray(raw, true, true);
      const selected = {
        models: raw.map((row) => ({
          ...row,
          supportedReasoningEfforts: row.supportedReasoningEfforts?.filter(
            (level) => !["max", "ultra"].includes(level.reasoningEffort),
          ),
        })),
        defaultModel: raw[0],
        hasModelSupportingMaxReasoningEffort: false,
        hasModelSupportingUltraReasoningEffort: false,
      };
      const restored = api.restoreCodexCatalogReasoningSelection(key, selected);
      expect(restored.models).toHaveLength(1);
      const model = restored.models[0];
      expect(model.model).toBe(binding.entry.pickerModel);
      expect(model.providerId).toBe(binding.provider.id);
      expect(model.providerName).toBe(binding.provider.name);
      expect(effortNames(model)).toEqual(binding.entry.expected.pickerEfforts);
      expect(Array.isArray(model.supportedReasoningEfforts)).toBe(true);
      if (binding.entry.expected.pickerEfforts.length > 0) {
        expect(model.defaultReasoningEffort).toBe(
          binding.entry.expected.defaultEffort,
        );
      } else {
        expect(model).not.toHaveProperty("defaultReasoningEffort");
        expect(effortNames(model)).toEqual([]);
      }
      expect(restored.hasModelSupportingMaxReasoningEffort).toBe(
        (binding.entry.expected.pickerEfforts as string[]).includes("max"),
      );
      expect(restored.hasModelSupportingUltraReasoningEffort).toBe(
        (binding.entry.expected.pickerEfforts as string[]).includes("ultra"),
      );
      expect(restored.defaultModel).toBe(model);
      expect(JSON.stringify(state.payload)).toBe(before);
    },
  );

  it("restores canonical provider blocks after the native selector reorders all 45 rows", () => {
    const { api } = loadPicker(bindings);
    const raw: PickerModel[] = [];
    api.patchModelArray(raw, true, true);
    expect(raw.map((row) => row.model)).toEqual(
      bindings.map(({ entry }) => entry.pickerModel),
    );
    const selected = { models: [...raw].reverse(), defaultModel: raw[20] };
    const restored = api.restoreCodexCatalogReasoningSelection(key, selected);
    expect(restored.models.map((row) => row.model)).toEqual(
      bindings.map(({ entry }) => entry.pickerModel),
    );
    expect(restored.models.map((row) => row.providerId)).toEqual(
      bindings.map(({ provider }) => provider.id),
    );
    expect(restored.defaultModel?.model).toBe(raw[20].model);
    expect(api.restoreCodexCatalogReasoningSelection(key, restored)).toBe(
      restored,
    );
  });

  it("keeps the active router closed to official, excluded, stale, and unknown rows", () => {
    const active = bindings.filter(
      ({ provider }) => provider.profile === "router",
    );
    const { state, api } = loadPicker(active);
    state.payload.models.push({
      model: "excluded-model",
      enabled: false,
      supported_reasoning_levels: ["high"],
    });
    state.payload.modelNames.push(
      "excluded-model",
      "unknown-without-catalog-row",
    );
    const raw = [...bindings].reverse().map(staleRow);
    raw.push({ model: "excluded-model" }, { model: "stale-legacy-model" });
    api.patchModelArray(raw, true, true);
    const restored = api.restoreCodexCatalogReasoningSelection(key, {
      models: [...raw].reverse(),
    });
    expect(restored.models.map((row) => row.model)).toEqual(
      active.map(({ entry }) => entry.pickerModel),
    );
    expect(new Set(restored.models.map((row) => row.model)).size).toBe(37);
    for (const binding of active) {
      const actual = restored.models.find(
        (row) => row.model === binding.entry.pickerModel,
      );
      expect(effortNames(actual)).toEqual(binding.entry.expected.pickerEfforts);
    }
  });

  it("sorts only available rows and collapses duplicate selected public identities", () => {
    const { api } = loadPicker(bindings);
    const raw: PickerModel[] = [];
    api.patchModelArray(raw, true, true);
    // Native availability checks may remove rows independently of catalog
    // inclusion. Canonical ordering must not revive those rows afterward.
    const available = raw.filter((_, index) => index % 4 !== 0);
    const duplicate = {
      ...available[3],
      model: available[3].model.toUpperCase(),
    };
    const restored = api.restoreCodexCatalogReasoningSelection(key, {
      models: [...available].reverse().concat(duplicate, { ...available[3] }),
      defaultModel: available[3],
    });
    expect(restored.models.map((row) => row.model.toLowerCase())).toEqual(
      available.map((row) => row.model.toLowerCase()),
    );
    expect(restored.models).toHaveLength(available.length);
    expect(restored.defaultModel?.model.toLowerCase()).toBe(
      available[3].model.toLowerCase(),
    );
    for (const removed of raw.filter((_, index) => index % 4 === 0)) {
      expect(restored.models.some((row) => row.model === removed.model)).toBe(
        false,
      );
    }
  });

  it("does not change other hosts or another provider's native picker", () => {
    const { api } = loadPicker(bindings);
    const selection = { models: bindings.map(staleRow) };
    expect(
      api.restoreCodexCatalogReasoningSelection(
        ["models", "list", "remote", "chatgpt", 100, "codex_model_router_v2"],
        selection,
      ),
    ).toBe(selection);
    expect(
      api.restoreCodexCatalogReasoningSelection(
        ["models", "list", "local", "chatgpt", 100, "other-provider"],
        selection,
      ),
    ).toBe(selection);
  });
});
