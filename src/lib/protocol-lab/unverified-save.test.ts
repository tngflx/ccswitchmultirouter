import { describe, expect, it } from "vitest";

import type { Provider } from "@/types";
import { prepareUnverifiedCodexProvider } from "./unverified-save";

function createProvider(settingsConfig: Provider["settingsConfig"]): Provider {
  return {
    id: "provider-test",
    name: "Provider Test",
    settingsConfig,
    meta: { apiFormat: "openai_responses" },
  };
}

describe("unverified Codex provider catalog selection", () => {
  it("preserves API-declared transports while filling only unresolved models from the provider default", () => {
    const provider = createProvider({
      base_url: "https://provider.example/v1",
      modelCatalog: {
        models: [
          {
            model: "api-chat",
            upstreamModel: "wire-chat",
            protocolCapability: {
              schemaVersion: 1,
              source: "provider_api",
              baseUrl: "https://provider.example/v1",
              upstreamModel: "wire-chat",
              supportedEndpoints: ["openai_chat"],
              supportsTools: true,
            },
          },
          { model: "unresolved" },
        ],
      },
    });
    const before = structuredClone(provider);

    expect(
      prepareUnverifiedCodexProvider(provider).meta?.codexProtocolOverrides,
    ).toEqual({
      "api-chat": "openai_chat",
      unresolved: "openai_responses",
    });
    expect(provider).toEqual(before);
  });

  it("keeps explicit selections ahead of API metadata and rejects metadata outside the current target", () => {
    const provider = createProvider({
      base_url: "https://provider.example/v1",
      modelCatalog: {
        models: ["explicit", "legacy", "wrong-endpoint", "wrong-model"].map(
          (model) => ({
            model,
            ...(model === "legacy" ? { apiFormat: "openai_responses" } : {}),
            protocolCapability: {
              schemaVersion: 1,
              source: "provider_api",
              baseUrl:
                model === "wrong-endpoint"
                  ? "https://other.example/v1"
                  : "https://provider.example/v1",
              upstreamModel: model === "wrong-model" ? "old-wire" : model,
              supportedEndpoints: ["openai_chat"],
            },
          }),
        ),
      },
    });
    provider.meta!.codexProtocolOverrides = {
      explicit: "openai_responses",
    };

    expect(
      prepareUnverifiedCodexProvider(provider).meta?.codexProtocolOverrides,
    ).toEqual({
      explicit: "openai_responses",
      legacy: "openai_responses",
      "wrong-endpoint": "openai_responses",
      "wrong-model": "openai_responses",
    });
  });

  it("preserves current model overrides and fills declared row protocols without mutating the draft", () => {
    const provider = createProvider({
      modelCatalog: {
        models: [
          { model: "model-a", apiFormat: "openai_responses" },
          { model: " MODEL-B ", api_format: "openai_chat" },
          { id: "model-c", wireApi: "responses" },
          { slug: "model-d", wire_api: "open_ai_chat" },
          { model: "model-e" },
          { model: "excluded-model", enabled: false },
        ],
      },
    });
    provider.meta!.codexProtocolOverrides = {
      " MODEL-A ": "openai_chat",
      "excluded-model": "openai_chat",
      "removed-model": "openai_chat",
    };
    const before = structuredClone(provider);

    const prepared = prepareUnverifiedCodexProvider(provider);

    expect(prepared.meta).toMatchObject({
      apiFormat: "openai_responses",
      codexProtocolMode: "manual",
      codexProtocolOverrides: {
        "model-a": "openai_chat",
        "model-b": "openai_chat",
        "model-c": "openai_responses",
        "model-d": "openai_chat",
        "model-e": "openai_responses",
      },
    });
    expect(prepared.meta?.codexProtocolOverrides).not.toHaveProperty(
      "excluded-model",
    );
    expect(prepared.meta?.codexProtocolOverrides).not.toHaveProperty(
      "removed-model",
    );
    expect(prepared.settingsConfig).toBe(provider.settingsConfig);
    expect(provider).toEqual(before);
  });

  it("keeps an empty canonical catalog authoritative and removes stale overrides", () => {
    const provider = createProvider({
      modelCatalog: { models: [] },
      model_catalog: { models: [{ model: "stale-model" }] },
    });
    provider.meta!.codexProtocolOverrides = {
      "stale-model": "openai_chat",
    };

    const prepared = prepareUnverifiedCodexProvider(provider);

    expect(prepared.meta?.codexProtocolOverrides ?? {}).toEqual({});
    expect(prepared.settingsConfig.modelCatalog).toEqual({ models: [] });
  });

  it("does not merge legacy rows or overrides into a valid canonical catalog", () => {
    const provider = createProvider({
      modelCatalog: { models: [{ model: "current-model" }] },
      model_catalog: { models: [{ model: "stale-model" }] },
    });
    provider.meta!.codexProtocolOverrides = {
      "stale-model": "openai_chat",
    };

    expect(
      prepareUnverifiedCodexProvider(provider).meta?.codexProtocolOverrides,
    ).toEqual({ "current-model": "openai_responses" });
  });

  it.each([{ models: "not-an-array" }, {}, 7, false, "not-a-catalog", []])(
    "uses legacy rows when the canonical catalog is malformed: %j",
    (modelCatalog) => {
      const provider = createProvider({
        modelCatalog,
        model_catalog: {
          models: [{ model: " LEGACY-MODEL ", wire_api: "chat" }],
        },
      });

      expect(
        prepareUnverifiedCodexProvider(provider).meta?.codexProtocolOverrides,
      ).toEqual({ "legacy-model": "openai_chat" });
    },
  );

  it("uses legacy rows when the canonical catalog is absent", () => {
    const provider = createProvider({
      model_catalog: { models: [{ model: "legacy-model" }] },
    });

    expect(
      prepareUnverifiedCodexProvider(provider).meta?.codexProtocolOverrides,
    ).toEqual({ "legacy-model": "openai_responses" });
  });

  it("removes existing overrides when every current catalog model is excluded", () => {
    const provider = createProvider({
      modelCatalog: {
        models: [{ model: "excluded-model", enabled: false }],
      },
    });
    provider.meta!.codexProtocolOverrides = {
      "excluded-model": "openai_chat",
    };

    expect(
      prepareUnverifiedCodexProvider(provider).meta?.codexProtocolOverrides ??
        {},
    ).toEqual({});
  });

  it("ignores malformed catalog rows without falling back to stale legacy rows", () => {
    const provider = createProvider({
      modelCatalog: {
        models: [
          null,
          undefined,
          7,
          false,
          "not-a-model",
          [],
          {},
          { model: 7 },
          { model: " " },
          { model: "included-model" },
        ],
      },
      model_catalog: { models: [{ model: "stale-model" }] },
    });

    expect(
      prepareUnverifiedCodexProvider(provider).meta?.codexProtocolOverrides,
    ).toEqual({ "included-model": "openai_responses" });
  });

  it.each([{}, { modelCatalog: { models: "not-an-array" } }])(
    "preserves normalized selections when no valid catalog is loaded: %j",
    (settingsConfig) => {
      const provider = createProvider(settingsConfig);
      provider.meta!.codexProtocolOverrides = {
        " MODEL-A ": "openai_chat",
        " ": "openai_responses",
      };

      expect(
        prepareUnverifiedCodexProvider(provider).meta?.codexProtocolOverrides,
      ).toEqual({ "model-a": "openai_chat" });
    },
  );

  it("uses the declared settings protocol when metadata does not declare one", () => {
    const provider = createProvider({
      apiFormat: "openai_chat",
      modelCatalog: { models: [{ model: "included-model" }] },
    });
    delete provider.meta!.apiFormat;

    expect(prepareUnverifiedCodexProvider(provider).meta).toMatchObject({
      apiFormat: "openai_chat",
      codexProtocolMode: "manual",
      codexProtocolOverrides: { "included-model": "openai_chat" },
    });
  });

  it("still rejects an unverified save without a declared protocol", () => {
    const provider = createProvider({});
    delete provider.meta!.apiFormat;

    expect(() => prepareUnverifiedCodexProvider(provider)).toThrow(
      "codex_provider_set_unverified_protocol_required",
    );
  });
});
