import { describe, expect, it } from "vitest";
import { providerPresets } from "@/config/claudeProviderPresets";
import { claudeDesktopProviderPresets } from "@/config/claudeDesktopProviderPresets";
import { codexProviderPresets } from "@/config/codexProviderPresets";
import { hermesProviderPresets } from "@/config/hermesProviderPresets";
import { openclawProviderPresets } from "@/config/openclawProviderPresets";
import { opencodeProviderPresets } from "@/config/opencodeProviderPresets";
import { piProviderPresets } from "@/config/piProviderPresets";

const KILO_BASE_URL = "https://api.kilo.ai/api/gateway";
const KILO_API_KEY_URL = "https://app.kilo.ai/profile";
const KILO_MODELS = [
  "kilo-auto/free",
  "minimax/minimax-m2.1:free",
  "z-ai/glm-5:free",
  "google/gemma-4-26b-a4b-it:free",
];

describe("Kilo provider presets", () => {
  it("exposes the gateway and free model catalog in every OpenAI-compatible app", () => {
    const codex = codexProviderPresets.find((preset) => preset.name === "Kilo");
    const claude = providerPresets.find((preset) => preset.name === "Kilo");
    const desktop = claudeDesktopProviderPresets.find(
      (preset) => preset.name === "Kilo",
    );
    const opencode = opencodeProviderPresets.find(
      (preset) => preset.name === "Kilo",
    );
    const openclaw = openclawProviderPresets.find(
      (preset) => preset.name === "Kilo",
    );
    const hermes = hermesProviderPresets.find(
      (preset) => preset.name === "Kilo",
    );
    const pi = piProviderPresets.find((preset) => preset.name === "Kilo");

    expect(codex).toMatchObject({
      websiteUrl: "https://kilo.ai",
      apiKeyUrl: KILO_API_KEY_URL,
      endpointCandidates: [KILO_BASE_URL],
      apiFormat: "openai_chat",
      modelCatalog: expect.arrayContaining(
        KILO_MODELS.map((model) => expect.objectContaining({ model })),
      ),
    });
    expect(codex?.config).toContain(`base_url = "${KILO_BASE_URL}"`);

    expect(claude).toMatchObject({
      apiKeyUrl: KILO_API_KEY_URL,
      apiFormat: "openai_chat",
      modelsUrl: `${KILO_BASE_URL}/models`,
      endpointCandidates: [KILO_BASE_URL],
    });
    expect(claude?.settingsConfig).toMatchObject({
      env: {
        ANTHROPIC_BASE_URL: KILO_BASE_URL,
        ANTHROPIC_MODEL: "kilo-auto/free",
      },
    });

    expect(desktop).toMatchObject({
      apiKeyUrl: KILO_API_KEY_URL,
      baseUrl: KILO_BASE_URL,
      mode: "proxy",
      apiFormat: "openai_chat",
    });
    expect(desktop?.modelRoutes?.map((route) => route.upstreamModel)).toEqual([
      "kilo-auto/free",
      "kilo-auto/free",
      "kilo-auto/free",
    ]);

    expect(opencode).toMatchObject({
      apiKeyUrl: KILO_API_KEY_URL,
      settingsConfig: {
        options: { baseURL: KILO_BASE_URL },
        models: expect.objectContaining({
          "kilo-auto/free": { name: "Kilo Auto (Free)" },
        }),
      },
    });

    expect(openclaw).toMatchObject({
      apiKeyUrl: KILO_API_KEY_URL,
      settingsConfig: {
        baseUrl: KILO_BASE_URL,
        api: "openai-completions",
      },
      suggestedDefaults: {
        model: { primary: "kilo/kilo-auto/free" },
      },
    });

    expect(hermes).toMatchObject({
      apiKeyUrl: KILO_API_KEY_URL,
      settingsConfig: {
        base_url: KILO_BASE_URL,
        api_mode: "chat_completions",
      },
    });

    expect(pi).toMatchObject({
      apiKeyUrl: KILO_API_KEY_URL,
      settingsConfig: {
        baseUrl: KILO_BASE_URL,
        api: "openai-completions",
      },
    });
    expect(pi?.settingsConfig.models.map((model) => model.id)).toEqual(
      KILO_MODELS,
    );
  });
});
