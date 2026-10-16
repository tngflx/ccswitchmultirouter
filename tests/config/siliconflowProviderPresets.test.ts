import { describe, expect, it } from "vitest";
import { opencodeProviderPresets } from "@/config/opencodeProviderPresets";
import { getPiModelCatalogReference } from "@/config/piModelCatalog";
import { piProviderPresets } from "@/config/piProviderPresets";

const SILICONFLOW_PRESETS = [
  {
    name: "SiliconFlow",
    providerKey: "cc-switch-siliconflow",
    websiteUrl: "https://siliconflow.cn",
    apiKeyUrl: "https://cloud.siliconflow.cn/account/ak",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "Pro/MiniMaxAI/MiniMax-M2.7",
  },
  {
    name: "SiliconFlow en",
    providerKey: "cc-switch-siliconflow-en",
    websiteUrl: "https://siliconflow.com",
    apiKeyUrl: "https://cloud.siliconflow.com",
    baseUrl: "https://api.siliconflow.com/v1",
    model: "MiniMaxAI/MiniMax-M2.7",
  },
];

describe("SiliconFlow provider presets", () => {
  it.each(SILICONFLOW_PRESETS)(
    "exposes the $name OpenAI-compatible endpoint in OpenCode",
    ({ name, websiteUrl, apiKeyUrl, baseUrl, model }) => {
      const matches = opencodeProviderPresets.filter(
        (preset) => preset.name === name,
      );
      expect(matches).toHaveLength(1);
      const preset = matches[0]!;
      expect(preset).toMatchObject({
        websiteUrl,
        apiKeyUrl,
        category: "aggregator",
        settingsConfig: {
          npm: "@ai-sdk/openai-compatible",
          name,
          options: { baseURL: baseUrl, apiKey: "" },
          models: {
            [model]: expect.objectContaining({ name: expect.any(String) }),
          },
        },
      });
      expect(preset.templateValues?.baseURL).toMatchObject({
        defaultValue: baseUrl,
        placeholder: baseUrl,
      });
      expect(JSON.stringify(preset)).not.toMatch(/:free|\(free\)|"cost":/i);
    },
  );

  it.each(SILICONFLOW_PRESETS)(
    "exposes the $name OpenAI-compatible endpoint in Pi",
    ({ name, providerKey, websiteUrl, apiKeyUrl, baseUrl, model }) => {
      const matches = piProviderPresets.filter(
        (preset) => preset.name === name,
      );
      expect(matches).toHaveLength(1);
      const preset = matches[0]!;
      expect(preset).toMatchObject({
        providerKey,
        websiteUrl,
        apiKeyUrl,
        category: "aggregator",
        settingsConfig: {
          name,
          baseUrl,
          api: "openai-completions",
          apiKey: "",
        },
      });
      expect(preset.settingsConfig.models).toEqual([
        expect.objectContaining({
          id: model,
          input: ["text"],
          contextWindow: 200_000,
          maxTokens: 131_072,
        }),
      ]);
      expect(
        getPiModelCatalogReference(preset.settingsConfig.models[0]),
      ).toEqual({ catalogKey: "minimax/minimax-m2.7" });
      expect(JSON.stringify(preset)).not.toMatch(/:free|\(free\)|"cost":/i);
    },
  );
});
