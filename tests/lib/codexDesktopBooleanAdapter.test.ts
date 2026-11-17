import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const core = readFileSync(
  path.resolve(
    process.cwd(),
    "src-tauri/src/resources/codex_desktop/model_picker_core.js",
  ),
  "utf8",
);
const provider = "codex_model_router_v2";
const marker = {
  kind: "boolean",
  disableAllowed: true,
  fingerprint: "canonical-boolean-fingerprint",
};
const row = (extra: Record<string, unknown> = {}) => ({
  model: "mimo-pro",
  supported_reasoning_levels: [],
  ccSwitchReasoningControl: { ...marker },
  ...extra,
});
function harness(models: Record<string, unknown>[] = [row()]) {
  const state = {
    payload: {
      modelProvider: provider,
      catalogAvailable: true,
      modelNames: models.map((item) => String(item.model)),
      models,
    },
  };
  const api = new Function(
    "state",
    `${core}\nreturn { descriptorFor, patchModelArray, restoreCodexCatalogReasoningSelection };`,
  )(state);
  return { state, api };
}
const efforts = (model: Record<string, any>) =>
  model.supportedReasoningEfforts?.map((entry: any) => entry.reasoningEffort);
// Matches the installed native ER5p.SP / hI9J.MD fallback. Removing defaults
// alone cannot preserve Off: the native consumer turns none + [] into medium.
const nativeSelection = (effort: string, model: Record<string, any>) =>
  efforts(model).includes(effort) ? effort : "medium";

describe("renderer-only Boolean reasoning transport adapter", () => {
  it("preserves Off through the real native fallback contract without changing provider capabilities", () => {
    const { state, api } = harness();
    const before = JSON.stringify(state.payload);
    const projected = api.descriptorFor("mimo-pro");
    expect(efforts(projected)).toEqual(["none", "medium"]);
    expect(nativeSelection("none", projected)).toBe("none");
    expect(nativeSelection("medium", projected)).toBe("medium");
    expect(projected.defaultReasoningEffort).toBeUndefined();
    expect(projected.ccSwitchReasoningControl).toEqual(marker);
    expect(JSON.stringify(state.payload)).toBe(before);
    expect(state.payload.models[0].supported_reasoning_levels).toEqual([]);
  });

  it("restores Off after native global visibility filters it, without changing global preferences", () => {
    const { api } = harness();
    const visible = new Set(["low", "medium", "high", "xhigh"]);
    const projected = api.descriptorFor("mimo-pro");
    const selected = {
      models: [
        {
          ...projected,
          supportedReasoningEfforts: projected.supportedReasoningEfforts.filter(
            (entry: any) => visible.has(entry.reasoningEffort),
          ),
        },
      ],
    };
    expect(nativeSelection("none", selected.models[0])).toBe("medium");
    const restored = api.restoreCodexCatalogReasoningSelection(
      ["models", "list", "local", "chatgpt", 100, provider],
      selected,
    );
    expect(nativeSelection("none", restored.models[0])).toBe("none");
    expect([...visible]).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("does not offer Off for a mandatory Boolean control", () => {
    const { api } = harness([
      row({ ccSwitchReasoningControl: { ...marker, disableAllowed: false } }),
    ]);
    expect(efforts(api.descriptorFor("mimo-pro"))).toEqual(["medium"]);
    expect(
      api.descriptorFor("mimo-pro").defaultReasoningEffort,
    ).toBeUndefined();
  });

  it.each([
    undefined,
    { kind: "budget", disableAllowed: true, fingerprint: "x" },
    { kind: "boolean", disableAllowed: true },
    { ...marker, disableAllowed: "true" },
  ])(
    "keeps unknown, budget and malformed markers effort-free: %j",
    (invalid) => {
      const { api } = harness([row({ ccSwitchReasoningControl: invalid })]);
      const projected = api.descriptorFor("mimo-pro");
      expect(efforts(projected)).toEqual([]);
      expect(projected.ccSwitchReasoningControl).toBeUndefined();
    },
  );

  it("keeps graded capabilities graded and removes a stale Boolean marker", () => {
    const { api } = harness([
      row({
        supported_reasoning_levels: ["high", "max"],
        default_reasoning_level: "max",
      }),
    ]);
    const projected = api.descriptorFor("mimo-pro");
    expect(efforts(projected)).toEqual(["high", "max"]);
    expect(projected.defaultReasoningEffort).toBe("max");
    expect(projected.ccSwitchReasoningControl).toBeUndefined();
  });

  it("removes inherited binary adapter metadata when the canonical model becomes unknown", () => {
    const { state, api } = harness();
    const selected = [api.descriptorFor("mimo-pro")];
    state.payload.models = [row({ ccSwitchReasoningControl: undefined })];
    api.patchModelArray(selected, true, true);
    expect(efforts(selected[0])).toEqual([]);
    expect(selected[0].ccSwitchReasoningControl).toBeUndefined();
    expect(selected[0].defaultReasoningEffort).toBeUndefined();
  });

  it("never revives excluded binary models", () => {
    const { api } = harness([row({ enabled: false })]);
    const selected = [
      {
        model: "mimo-pro",
        supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
      },
    ];
    api.patchModelArray(selected, true, true);
    expect(selected).toEqual([]);
  });
});
