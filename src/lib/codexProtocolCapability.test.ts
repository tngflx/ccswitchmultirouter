import { describe, expect, it } from "vitest";

import type {
  CodexCatalogModel,
  CodexModelProtocolCapability,
  Provider,
} from "@/types";
import { readCodexModelProtocolCapability } from "./codexProtocolCapability";

const declaration: CodexModelProtocolCapability = {
  schemaVersion: 1,
  source: "provider_api",
  baseUrl: "https://relay.example/v1",
  upstreamModel: "wire-model",
  supportedEndpoints: ["openai_chat"],
};

function providerWith(
  capability: unknown = declaration,
  settings: Record<string, unknown> = {},
): Provider {
  return {
    id: "provider",
    name: "Provider",
    settingsConfig: {
      baseUrl: "https://relay.example/v1",
      modelCatalog: {
        models: [
          {
            model: "public-model",
            upstreamModel: "wire-model",
            protocolCapability: capability,
          },
        ],
      },
      ...settings,
    },
  };
}

describe("provider API protocol capability", () => {
  it("accepts a bound API transport declaration without fabricating probe verification", () => {
    const provider = providerWith();

    expect(readCodexModelProtocolCapability(provider, "public-model")).toBe(
      "openai_chat",
    );
    expect(
      readCodexModelProtocolCapability(provider, {
        model: "public-model",
        upstreamModel: "wire-model",
        protocolCapability: declaration,
      }),
    ).toBe("openai_chat");
    expect(declaration).not.toHaveProperty("readiness");
  });

  it("prefers a declared configured transport and otherwise prefers Responses", () => {
    const both = {
      ...declaration,
      supportedEndpoints: ["openai_chat", "openai_responses"],
    };
    expect(
      readCodexModelProtocolCapability(providerWith(both), "public-model"),
    ).toBe("openai_responses");
    expect(
      readCodexModelProtocolCapability(
        {
          ...providerWith(both),
          meta: { apiFormat: "openai_chat" },
        },
        "public-model",
      ),
    ).toBe("openai_chat");
    expect(
      readCodexModelProtocolCapability(
        providerWith(both, { api_format: "openai_chat" }),
        "public-model",
      ),
    ).toBe("openai_chat");
    expect(
      readCodexModelProtocolCapability(
        providerWith(both, {
          apiFormat: "unknown",
          api_format: "openai_chat",
        }),
        "public-model",
      ),
    ).toBe("openai_chat");
    expect(
      readCodexModelProtocolCapability(
        providerWith(both, {
          baseUrl: undefined,
          config:
            'model_provider = "relay"\n[model_providers.relay]\nbase_url = "https://relay.example/v1/"\nwire_api = "chat"\n',
        }),
        "public-model",
      ),
    ).toBe("openai_chat");
  });

  it("normalizes provider origin and trailing slashes without changing path identity", () => {
    expect(
      readCodexModelProtocolCapability(
        providerWith(
          { ...declaration, baseUrl: "https://RELAY.example:443/v1/" },
          { baseUrl: "https://relay.example/v1///" },
        ),
        "public-model",
      ),
    ).toBe("openai_chat");
    expect(
      readCodexModelProtocolCapability(
        providerWith(declaration, { baseUrl: "https://relay.example/v2" }),
        "public-model",
      ),
    ).toBeNull();
  });

  it("resolves legacy config objects after direct endpoint aliases", () => {
    expect(
      readCodexModelProtocolCapability(
        providerWith(declaration, {
          baseUrl: undefined,
          config: { base_url: "https://relay.example/v1/" },
        }),
        "public-model",
      ),
    ).toBe("openai_chat");
    expect(
      readCodexModelProtocolCapability(
        providerWith(declaration, {
          baseURL: "https://relay.example/v1",
          baseUrl: "https://stale.example/v1",
          config: { base_url: "https://stale.example/v1" },
        }),
        "public-model",
      ),
    ).toBe("openai_chat");
  });

  it("ignores blank direct endpoint aliases and binds the selected TOML provider", () => {
    expect(
      readCodexModelProtocolCapability(
        providerWith(declaration, {
          base_url: " ",
          baseURL: "",
          baseUrl: undefined,
          config: [
            'model_provider = "active"',
            "[model_providers.stale]",
            'base_url = "https://stale.example/v1"',
            "[model_providers.active]",
            'base_url = "https://relay.example/v1"',
            'wire_api = "chat"',
          ].join("\n"),
        }),
        "public-model",
      ),
    ).toBe("openai_chat");
  });

  it("keeps full-URL declarations on their physical endpoint transport", () => {
    const both = {
      ...declaration,
      supportedEndpoints: ["openai_chat", "openai_responses"],
    };
    const fullUrlProvider = (
      baseUrl: string,
      apiFormat: "openai_chat" | "openai_responses",
    ) => ({
      ...providerWith({ ...both, baseUrl }, { baseUrl }),
      meta: { isFullUrl: true, apiFormat },
    });

    expect(
      readCodexModelProtocolCapability(
        fullUrlProvider("https://relay.example/v1/responses", "openai_chat"),
        "public-model",
      ),
    ).toBe("openai_responses");
    expect(
      readCodexModelProtocolCapability(
        fullUrlProvider(
          "https://relay.example/v1/chat/completions",
          "openai_responses",
        ),
        "public-model",
      ),
    ).toBe("openai_chat");
    expect(
      readCodexModelProtocolCapability(
        {
          ...providerWith(
            {
              ...declaration,
              baseUrl: "https://relay.example/v1/responses",
            },
            { baseUrl: "https://relay.example/v1/responses" },
          ),
          meta: { isFullUrl: true, apiFormat: "openai_chat" },
        },
        "public-model",
      ),
    ).toBeNull();
  });

  it("does not switch an unknown custom full URL away from its configured transport", () => {
    const baseUrl = "https://relay.example/inference";
    const provider = {
      ...providerWith({ ...declaration, baseUrl }, { baseUrl }),
      meta: { isFullUrl: true, apiFormat: "openai_responses" as const },
    };
    expect(
      readCodexModelProtocolCapability(provider, "public-model"),
    ).toBeNull();
    expect(
      readCodexModelProtocolCapability(
        { ...provider, meta: { isFullUrl: true, apiFormat: "openai_chat" } },
        "public-model",
      ),
    ).toBe("openai_chat");
    expect(
      readCodexModelProtocolCapability(
        {
          ...providerWith(
            {
              ...declaration,
              baseUrl,
              supportedEndpoints: ["openai_responses"],
            },
            { baseUrl },
          ),
          meta: { isFullUrl: true },
        },
        "public-model",
      ),
    ).toBeNull();
  });

  it.each([
    "https://redacted@relay.example/v1",
    "https://relay.example/v1?token=redacted",
    "https://relay.example/v1#redacted",
    "https://relay.example/v1?",
    "https://relay.example/v1#",
    "https://@relay.example/v1",
    "https://relay.example/v1\n?token=redacted",
    "file:///relay.example/v1",
    "not-a-url",
  ])("rejects unsafe or unbound URLs: %s", (baseUrl) => {
    expect(
      readCodexModelProtocolCapability(
        providerWith({ ...declaration, baseUrl }),
        "public-model",
      ),
    ).toBeNull();
    expect(
      readCodexModelProtocolCapability(
        providerWith(declaration, { baseUrl }),
        "public-model",
      ),
    ).toBeNull();
  });

  it("invalidates the declaration when the model binding changes", () => {
    const provider = providerWith();
    expect(
      readCodexModelProtocolCapability(provider, {
        model: "public-model",
        upstreamModel: "other-wire-model",
        protocolCapability: declaration,
      }),
    ).toBeNull();
    expect(
      readCodexModelProtocolCapability(provider, {
        model: "public-model",
        upstream_model: "wire-model",
        protocolCapability: declaration,
      }),
    ).toBe("openai_chat");
    expect(
      readCodexModelProtocolCapability(provider, {
        model: "wire-model",
        protocolCapability: declaration,
      }),
    ).toBe("openai_chat");
  });

  it.each([
    null,
    {},
    { ...declaration, schemaVersion: 2 },
    { ...declaration, source: "inferred" },
    { ...declaration, upstreamModel: "WIRE-MODEL" },
    { ...declaration, supportedEndpoints: [] },
    { ...declaration, supportedEndpoints: ["chat"] },
    { ...declaration, supportedEndpoints: ["openai_chat", "unknown"] },
    { ...declaration, supportedEndpoints: "openai_chat" },
    { ...declaration, supportsTools: false },
    { ...declaration, supportsStreaming: false },
    { ...declaration, supportsToolContinuation: false },
    { ...declaration, supportsTools: "true" },
    { ...declaration, supportsStreaming: null },
  ])(
    "leaves malformed or incompatible declarations unresolved: %j",
    (value) => {
      expect(
        readCodexModelProtocolCapability(providerWith(value), "public-model"),
      ).toBeNull();
    },
  );

  it("keeps excluded rows and canonical empty catalogs out of capability readiness", () => {
    const excluded: CodexCatalogModel = {
      model: "public-model",
      upstreamModel: "wire-model",
      enabled: false,
      protocolCapability: declaration,
    };
    expect(
      readCodexModelProtocolCapability(providerWith(), excluded),
    ).toBeNull();
    expect(
      readCodexModelProtocolCapability(
        providerWith(declaration, {
          modelCatalog: { models: [] },
          model_catalog: {
            models: [
              {
                model: "public-model",
                upstreamModel: "wire-model",
                protocolCapability: declaration,
              },
            ],
          },
        }),
        "public-model",
      ),
    ).toBeNull();
  });

  it("uses a legacy catalog only when the canonical catalog is malformed", () => {
    const provider = providerWith();
    const legacy = {
      ...provider,
      settingsConfig: {
        ...provider.settingsConfig,
        modelCatalog: { models: "invalid" },
        model_catalog: provider.settingsConfig.modelCatalog,
      },
    };
    expect(readCodexModelProtocolCapability(legacy, "public-model")).toBe(
      "openai_chat",
    );
  });

  it("does not infer protocol capability from reasoning, model names, or old format fields", () => {
    const provider = providerWith(undefined);
    expect(
      readCodexModelProtocolCapability(provider, {
        model: "gpt-5",
        apiFormat: "openai_responses",
        apiFormatSource: "probe",
        contextWindow: 400000,
      }),
    ).toBeNull();
  });
});
