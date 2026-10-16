import { describe, expect, it } from "vitest";
import {
  CLAUDE_DESKTOP_ROLE_ROUTE_IDS,
  claudeDesktopProviderPresets,
} from "@/config/claudeDesktopProviderPresets";
import { providerPresets } from "@/config/claudeProviderPresets";
import { codexProviderPresets } from "@/config/codexProviderPresets";
import { hermesProviderPresets } from "@/config/hermesProviderPresets";
import {
  openclawProviderPresets,
  rebaseOpenClawSuggestedDefaults,
} from "@/config/openclawProviderPresets";
import { opencodeProviderPresets } from "@/config/opencodeProviderPresets";
import { getPiModelCatalogReference } from "@/config/piModelCatalog";
import { piProviderPresets } from "@/config/piProviderPresets";
import {
  extractCodexBaseUrl,
  extractCodexModelName,
  extractCodexWireApi,
} from "@/utils/providerConfigUtils";

const OPPER_BASE_URL = "https://api.opper.ai/v3/compat";
const OPPER_API_KEY_URL = "https://platform.opper.ai";
const OPPER_MODEL = "deepseek/deepseek-v4-flash-0731";
const OPPER_MODEL_NAME = "DeepSeek V4 Flash (0731)";

function findOpperPreset<T extends { name: string }>(presets: T[]): T {
  const matches = presets.filter((preset) => preset.name === "Opper");
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

describe("Opper provider presets", () => {
  it("uses the compatible gateway and key dashboard in every supported app", () => {
    const presets = [
      findOpperPreset(providerPresets),
      findOpperPreset(claudeDesktopProviderPresets),
      findOpperPreset(codexProviderPresets),
      findOpperPreset(opencodeProviderPresets),
      findOpperPreset(openclawProviderPresets),
      findOpperPreset(hermesProviderPresets),
      findOpperPreset(piProviderPresets),
    ];

    for (const preset of presets) {
      expect(preset).toMatchObject({
        websiteUrl: "https://opper.ai",
        apiKeyUrl: OPPER_API_KEY_URL,
        category: "aggregator",
      });
      expect(JSON.stringify(preset)).not.toMatch(/:free|\(free\)|"cost":/i);
    }
  });

  it("seeds Claude Code and Desktop with the verified upstream model", () => {
    const claude = findOpperPreset(providerPresets);
    expect(claude).toMatchObject({
      apiFormat: "openai_chat",
      modelsUrl: `${OPPER_BASE_URL}/models`,
      endpointCandidates: [OPPER_BASE_URL],
      settingsConfig: {
        env: {
          ANTHROPIC_BASE_URL: OPPER_BASE_URL,
          ANTHROPIC_AUTH_TOKEN: "",
          ANTHROPIC_MODEL: OPPER_MODEL,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: OPPER_MODEL,
          ANTHROPIC_DEFAULT_SONNET_MODEL: OPPER_MODEL,
          ANTHROPIC_DEFAULT_OPUS_MODEL: OPPER_MODEL,
        },
      },
    });

    const desktop = findOpperPreset(claudeDesktopProviderPresets);
    expect(desktop).toMatchObject({
      baseUrl: OPPER_BASE_URL,
      mode: "proxy",
      apiFormat: "openai_chat",
      endpointCandidates: [OPPER_BASE_URL],
    });
    expect(desktop.modelRoutes).toEqual([
      {
        routeId: CLAUDE_DESKTOP_ROLE_ROUTE_IDS.sonnet,
        upstreamModel: OPPER_MODEL,
        labelOverride: OPPER_MODEL,
        supports1m: false,
      },
    ]);
  });

  it("keeps Codex on local Chat routing without inventing reasoning controls", () => {
    const codex = findOpperPreset(codexProviderPresets);
    expect(codex).toMatchObject({
      presetKey: "opper-chat",
      apiFormat: "openai_chat",
      endpointCandidates: [OPPER_BASE_URL],
      auth: { OPENAI_API_KEY: "" },
    });
    expect(extractCodexBaseUrl(codex.config)).toBe(OPPER_BASE_URL);
    expect(extractCodexModelName(codex.config)).toBe(OPPER_MODEL);
    expect(extractCodexWireApi(codex.config)).toBe("responses");
    expect(codex.modelCatalog).toEqual([
      expect.objectContaining({
        model: OPPER_MODEL,
        displayName: OPPER_MODEL_NAME,
        contextWindow: 1_048_576,
        inputModalities: ["text"],
        reasoning: {
          schemaVersion: 2,
          supportStatus: "unknown",
          controlKind: "unknown",
          supportedEfforts: [],
          disableAllowed: false,
          upstream: { format: "none", parameter: "none" },
          source: "builtin",
        },
      }),
    ]);
  });

  it("selects native configuration shapes for OpenCode, OpenClaw and Hermes", () => {
    const opencode = findOpperPreset(opencodeProviderPresets);
    expect(opencode.settingsConfig).toMatchObject({
      npm: "@ai-sdk/openai-compatible",
      name: "Opper",
      options: { baseURL: OPPER_BASE_URL, apiKey: "" },
      models: { [OPPER_MODEL]: { name: OPPER_MODEL_NAME } },
    });
    expect(opencode.templateValues?.baseURL).toMatchObject({
      defaultValue: OPPER_BASE_URL,
      placeholder: OPPER_BASE_URL,
    });

    const openclaw = findOpperPreset(openclawProviderPresets);
    expect(openclaw.settingsConfig).toMatchObject({
      baseUrl: OPPER_BASE_URL,
      apiKey: "",
      api: "openai-completions",
      models: [
        {
          id: OPPER_MODEL,
          name: OPPER_MODEL_NAME,
          contextWindow: 1_048_576,
        },
      ],
    });
    expect(openclaw.suggestedDefaults).toEqual({
      model: { primary: `opper/${OPPER_MODEL}` },
      modelCatalog: {
        [`opper/${OPPER_MODEL}`]: { alias: OPPER_MODEL_NAME },
      },
    });
    expect(
      rebaseOpenClawSuggestedDefaults(openclaw.suggestedDefaults!, "my-opper")
        .model,
    ).toEqual({ primary: `my-opper/${OPPER_MODEL}` });

    const hermes = findOpperPreset(hermesProviderPresets);
    expect(hermes.settingsConfig).toEqual({
      name: "opper",
      base_url: OPPER_BASE_URL,
      api_key: "",
      api_mode: "chat_completions",
      models: [
        {
          id: OPPER_MODEL,
          name: OPPER_MODEL_NAME,
          context_length: 1_048_576,
        },
      ],
    });
    expect(hermes.suggestedDefaults).toEqual({
      model: { default: OPPER_MODEL, provider: "opper" },
    });
  });

  it("uses Pi's reviewed model catalog with provider-specific limits", () => {
    const pi = findOpperPreset(piProviderPresets);
    expect(pi).toMatchObject({
      providerKey: "cc-switch-opper",
      settingsConfig: {
        name: "Opper",
        baseUrl: OPPER_BASE_URL,
        api: "openai-completions",
        apiKey: "",
      },
    });
    expect(pi.settingsConfig.models).toEqual([
      expect.objectContaining({
        id: OPPER_MODEL,
        name: OPPER_MODEL_NAME,
        input: ["text"],
        contextWindow: 1_048_576,
        maxTokens: 393_216,
        thinkingLevelMap: {},
      }),
    ]);
    expect(getPiModelCatalogReference(pi.settingsConfig.models[0])).toEqual({
      catalogKey: "deepseek/deepseek-v4-flash",
    });
  });
});
