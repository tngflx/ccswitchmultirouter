import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
import { providersApi } from "@/lib/api/providers";
import { codexProviderPresets } from "@/config/codexProviderPresets";
import { bindFreshCodexPresetCatalogReasoning } from "@/components/providers/forms/CodexFormFields";

describe("fresh Codex preset evidence IPC", () => {
  beforeEach(() => invokeMock.mockReset());

  it("round-trips the credential-free canonical settings through the binding command", async () => {
    const settingsConfig = {
      config:
        'model_provider = "preset"\n[model_providers.preset]\nbase_url = "https://api.example/v1"',
      modelCatalog: { models: [{ model: "synthetic-model" }] },
    };
    const bound = structuredClone(settingsConfig);
    invokeMock.mockResolvedValueOnce(bound);
    await expect(
      providersApi.bindCodexPresetReasoningEvidence(settingsConfig),
    ).resolves.toEqual(bound);
    expect(invokeMock).toHaveBeenCalledWith(
      "bind_codex_preset_reasoning_evidence",
      { settingsConfig },
    );
  });

  it("sends every maintained preset through the generic fresh-catalog caller without auth or mutation", async () => {
    const maintainedPresets = codexProviderPresets.filter((preset) =>
      preset.modelCatalog?.some(
        (model) => model.reasoning?.source === "builtin",
      ),
    );
    // This matrix deliberately exceeds the metadata detector's named platforms.
    expect(maintainedPresets.length).toBeGreaterThan(6);
    for (const preset of maintainedPresets) {
      const models = preset.modelCatalog!;
      const original = structuredClone(models);
      const boundModels = structuredClone(models).map((model) => ({
        ...model,
        ...(model.reasoning?.source === "builtin"
          ? {
              reasoning: {
                ...model.reasoning,
                evidenceScope: {
                  transportFingerprint: "bound-native-transport",
                  model: model.upstreamModel ?? model.model,
                },
              },
            }
          : {}),
      }));
      invokeMock.mockResolvedValueOnce({
        modelCatalog: { models: boundModels },
      });
      await expect(
        bindFreshCodexPresetCatalogReasoning(preset.config, models),
        preset.presetKey ?? preset.name,
      ).resolves.toEqual(boundModels);
      const [command, payload] = invokeMock.mock.calls.at(-1)!;
      expect(command).toBe("bind_codex_preset_reasoning_evidence");
      expect(payload).toEqual({
        settingsConfig: {
          config: preset.config,
          modelCatalog: { models: original },
        },
      });
      expect(Object.keys(payload.settingsConfig).sort()).toEqual([
        "config",
        "modelCatalog",
      ]);
      expect(payload.settingsConfig.modelCatalog.models).not.toBe(models);
      expect(models).toEqual(original);
    }
    expect(invokeMock).toHaveBeenCalledTimes(maintainedPresets.length);
  });

  it("fails closed rather than returning unbound settings when native binding is unavailable", async () => {
    invokeMock.mockRejectedValueOnce(new Error("Command unavailable"));
    await expect(
      providersApi.bindCodexPresetReasoningEvidence({
        config: "",
        modelCatalog: { models: [] },
      }),
    ).rejects.toThrow("Command unavailable");
  });
});
