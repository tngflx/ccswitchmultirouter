import { describe, expect, it } from "vitest";
import {
  normalizeCodexCatalogModelsForSave,
  normalizeCodexChatReasoningForSave,
} from "@/components/providers/forms/ProviderForm";
import { extractCodexCatalogModels } from "@/components/providers/forms/hooks/useCodexConfigState";
import {
  codexModelProtocolDeclarationStatus,
  readCodexModelProtocolCapability,
} from "@/lib/codexProtocolCapability";
import { reconcileFetchedCodexCatalogRows } from "@/lib/codexCatalogReconciliation";
import { createSingleCodexProtocolLabAdapter } from "@/lib/protocol-lab/codex-adapters";
import type {
  CodexCatalogModel,
  CodexModelProtocolCapability,
  CodexModelReasoningCapability,
  Provider,
} from "@/types";

const protocolDeclaration: CodexModelProtocolCapability = {
  schemaVersion: 1,
  source: "provider_api",
  baseUrl: "https://relay.example/v1",
  upstreamModel: "vendor/wire-model",
  supportedEndpoints: ["openai_chat", "openai_responses"],
  supportsTools: true,
  supportsStreaming: true,
  supportsToolContinuation: true,
};

const providerWithCatalog = (models: CodexCatalogModel[]): Provider => ({
  id: "api-provider",
  name: "API Provider",
  settingsConfig: {
    baseUrl: protocolDeclaration.baseUrl,
    modelCatalog: { models },
  },
});

describe("ProviderForm Codex catalog helpers", () => {
  it("preserves bound provider API declarations when opening a saved provider", () => {
    const [loaded] = extractCodexCatalogModels({
      models: [
        {
          model: "public-model",
          upstreamModel: protocolDeclaration.upstreamModel,
          protocolCapability: protocolDeclaration,
        },
      ],
    });

    expect(loaded.protocolCapability).toEqual(protocolDeclaration);
    expect(
      readCodexModelProtocolCapability(providerWithCatalog([loaded]), loaded),
    ).toBe("openai_responses");
  });

  it("preserves provider API declarations when constructing the save payload", () => {
    const [saved] = normalizeCodexCatalogModelsForSave([
      {
        model: "public-model",
        upstreamModel: protocolDeclaration.upstreamModel,
        protocolCapability: protocolDeclaration,
      },
    ]);

    expect(saved.protocolCapability).toEqual(protocolDeclaration);
    expect(
      readCodexModelProtocolCapability(providerWithCatalog([saved]), saved),
    ).toBe("openai_responses");
  });

  it("round-trips fetched capability evidence and exact reasoning efforts through saving and reopening", () => {
    const efforts = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
    const reasoning: CodexModelReasoningCapability = {
      schemaVersion: 2,
      supportStatus: "confirmed_supported",
      controlKind: "graded",
      supportedEfforts: [...efforts],
      defaultEffort: "ultra",
      disableAllowed: false,
      upstream: {
        format: "reasoning_object",
        parameter: "reasoning.effort",
        effortMap: Object.fromEntries(
          efforts.map((effort) => [effort, effort]),
        ),
      },
      source: "provider",
      confidence: "authoritative",
    };
    const refreshed = reconcileFetchedCodexCatalogRows(
      [
        { model: "public-model", upstreamModel: "vendor/wire-model" },
        {
          model: "excluded-model",
          upstreamModel: "vendor/wire-model",
          enabled: false,
        },
      ],
      [
        {
          id: "vendor/wire-model",
          displayName: "Provider Model",
          contextWindow: 262144,
          inputModalities: ["text"],
          supportsImage: false,
          supportsParallelToolCalls: false,
          protocolCapability: protocolDeclaration,
          reasoning,
        },
      ],
      { baseUrl: protocolDeclaration.baseUrl },
      {
        appendNew: true,
        existingMetadataMode: "refresh",
        createRow: (seed) => seed as CodexCatalogModel,
      },
    );
    const saved = normalizeCodexCatalogModelsForSave(refreshed.rows);
    const reopened = extractCodexCatalogModels(
      JSON.parse(JSON.stringify({ models: saved })),
    );
    const provider = providerWithCatalog(reopened);

    expect(reopened).toEqual(saved);
    expect(reopened[0]).toMatchObject({
      contextWindow: 262144,
      inputModalities: ["text"],
      supportsImage: false,
      supportsParallelToolCalls: false,
      protocolCapability: protocolDeclaration,
      reasoning,
    });
    expect(reopened[0].reasoning?.supportedEfforts).toEqual([...efforts]);
    expect(reopened[0].reasoning?.defaultEffort).toBe("ultra");
    expect(readCodexModelProtocolCapability(provider, "public-model")).toBe(
      "openai_responses",
    );
    expect(
      createSingleCodexProtocolLabAdapter().requiresProbe(provider, []),
    ).toBe(false);
    expect(reopened[1].enabled).toBe(false);
    expect(reopened[1].protocolCapability).toEqual(protocolDeclaration);
    expect(
      readCodexModelProtocolCapability(provider, "excluded-model"),
    ).toBeNull();
  });

  it.each([
    ["supportsTools", false],
    ["supportsStreaming", false],
    ["supportsToolContinuation", false],
  ] as const)(
    "preserves explicit negative %s evidence without granting readiness",
    (field, value) => {
      const capability = { ...protocolDeclaration, [field]: value };
      const reopened = extractCodexCatalogModels({
        models: normalizeCodexCatalogModelsForSave([
          {
            model: "public-model",
            upstreamModel: capability.upstreamModel,
            protocolCapability: capability,
          },
        ]),
      });
      const provider = providerWithCatalog(reopened);

      expect(reopened[0].protocolCapability).toEqual(capability);
      expect(
        codexModelProtocolDeclarationStatus(provider, "public-model"),
      ).toBe("unsupported");
      expect(
        readCodexModelProtocolCapability(provider, "public-model"),
      ).toBeNull();
    },
  );

  it("preserves an explicit empty endpoint declaration without granting readiness", () => {
    const capability = { ...protocolDeclaration, supportedEndpoints: [] };
    const reopened = extractCodexCatalogModels({
      models: normalizeCodexCatalogModelsForSave([
        {
          model: "public-model",
          upstreamModel: capability.upstreamModel,
          protocolCapability: capability,
        },
      ]),
    });

    expect(reopened[0].protocolCapability).toEqual(capability);
    expect(
      readCodexModelProtocolCapability(
        providerWithCatalog(reopened),
        "public-model",
      ),
    ).toBeNull();
  });

  it.each([
    { schemaVersion: 2 },
    { source: "inferred" },
    { supportedEndpoints: ["openai_chat", "unknown"] },
    { supportedEndpoints: "openai_chat" },
    { supportsTools: "false" },
    { supportsStreaming: null },
    { baseUrl: "https://redacted@relay.example/v1" },
    { baseUrl: "https://relay.example/v1?token=redacted" },
    { baseUrl: "https://relay.example/v1#redacted" },
    { baseUrl: "not-a-url" },
    { upstreamModel: "" },
  ])("does not persist unsafe or malformed protocol evidence: %j", (patch) => {
    const row = {
      model: "public-model",
      upstreamModel: protocolDeclaration.upstreamModel,
      protocolCapability: { ...protocolDeclaration, ...patch },
    } as unknown as CodexCatalogModel;
    const [loaded] = extractCodexCatalogModels({ models: [row] });
    const [saved] = normalizeCodexCatalogModelsForSave([row]);

    expect(loaded).not.toHaveProperty("protocolCapability");
    expect(saved).not.toHaveProperty("protocolCapability");
    expect(
      readCodexModelProtocolCapability(providerWithCatalog([saved]), saved),
    ).toBeNull();
  });

  it("canonicalizes provider declarations without persisting unrelated or secret fields", () => {
    const row = {
      model: "public-model",
      upstreamModel: protocolDeclaration.upstreamModel,
      protocolCapability: {
        ...protocolDeclaration,
        baseUrl: "https://RELAY.example:443/v1///",
        apiKey: "redacted",
        requestHeaders: { Authorization: "redacted" },
      },
    };
    const [loaded] = extractCodexCatalogModels({
      models: [row],
    });
    const [saved] = normalizeCodexCatalogModelsForSave([row]);

    expect(loaded.protocolCapability).toEqual(protocolDeclaration);
    expect(saved.protocolCapability).toEqual(protocolDeclaration);
    expect(JSON.stringify(loaded)).not.toContain("redacted");
    expect(JSON.stringify(saved)).not.toContain("redacted");
  });

  it.each([
    { baseUrl: "https://other.example/v1" },
    { upstreamModel: "vendor/other-model" },
  ])(
    "does not reuse a declaration with a foreign endpoint or model binding: %j",
    (patch) => {
      const capability = { ...protocolDeclaration, ...patch };
      const reopened = extractCodexCatalogModels({
        models: normalizeCodexCatalogModelsForSave([
          {
            model: "public-model",
            upstreamModel: protocolDeclaration.upstreamModel,
            protocolCapability: capability,
          },
        ]),
      });

      expect(
        readCodexModelProtocolCapability(
          providerWithCatalog(reopened),
          "public-model",
        ),
      ).toBeNull();
    },
  );

  it("round-trips searchable model identities and excluded inventory through load and save", () => {
    const loaded = extractCodexCatalogModels({
      models: [
        {
          model: " visible-model ",
          canonical_slug: " vendor/canonical ",
          slug: " stable-slug ",
          aliases: [" fast ", "backup", "fast"],
          name: " Friendly Model ",
          enabled: false,
        },
        {
          model: "included-model",
          aliases: { " quick ": " upstream-target " },
        },
      ],
    });
    const saved = normalizeCodexCatalogModelsForSave(loaded);
    expect(saved).toEqual([
      {
        model: "visible-model",
        canonicalSlug: "vendor/canonical",
        slug: "stable-slug",
        aliases: ["fast", "backup"],
        name: "Friendly Model",
        enabled: false,
      },
      { model: "included-model", aliases: { quick: "upstream-target" } },
    ]);
    expect(extractCodexCatalogModels({ models: saved })).toEqual(saved);
  });

  it("normalizes catalog rows and removes empty or duplicate models", () => {
    expect(
      normalizeCodexCatalogModelsForSave([
        {
          model: " deepseek-v4-flash ",
          upstreamModel: " deepseek-chat ",
          displayName: " DeepSeek ",
        },
        { model: "deepseek-v4-flash", displayName: "Duplicate" },
        { model: "", displayName: "Empty" },
        {
          model: "kimi-k2",
          upstreamModel: "kimi-k2",
          contextWindow: "128000 tokens",
        },
      ]),
    ).toEqual([
      {
        model: "deepseek-v4-flash",
        upstreamModel: "deepseek-chat",
        displayName: "DeepSeek",
      },
      { model: "kimi-k2", contextWindow: 128000 },
    ]);
  });

  it("keeps duplicate upstream models when visible model aliases differ", () => {
    expect(
      normalizeCodexCatalogModelsForSave([
        { model: "gpt-5.5-thirdparty", upstreamModel: "gpt-5.5" },
        { model: "gpt-5.5-backup", upstream_model: "gpt-5.5" },
      ]),
    ).toEqual([
      { model: "gpt-5.5-thirdparty", upstreamModel: "gpt-5.5" },
      { model: "gpt-5.5-backup", upstreamModel: "gpt-5.5" },
    ]);
  });

  it("preserves explicit Codex Chat min output tokens", () => {
    expect(
      normalizeCodexChatReasoningForSave({
        supportsThinking: true,
        supportsEffort: false,
        thinkingParam: "thinking",
        effortParam: "none",
        minOutputTokens: 4096,
        defaultOutputTokens: 65536,
        outputFormat: "reasoning_content",
      }),
    ).toMatchObject({
      supportsThinking: true,
      supportsEffort: false,
      thinkingParam: "thinking",
      effortParam: "none",
      minOutputTokens: 4096,
      defaultOutputTokens: 65536,
      outputFormat: "reasoning_content",
    });
  });

  it("applies Qwen vLLM Codex Chat defaults without implicit output cap", () => {
    expect(
      normalizeCodexChatReasoningForSave(
        {
          supportsThinking: true,
          supportsEffort: false,
          thinkingParam: "thinking",
          effortParam: "none",
          outputFormat: "reasoning_content",
        },
        {
          providerName: "Qwen Local",
          baseUrl: "https://www.matrixminecraft.cn:24443/vllm/v1",
          models: [{ model: "qwen3.6" }],
        },
      ),
    ).toMatchObject({
      supportsThinking: true,
      supportsEffort: false,
      thinkingParam: "enable_thinking",
      effortParam: "none",
      minOutputTokens: 2048,
      outputFormat: "reasoning_content",
    });
    expect(
      normalizeCodexChatReasoningForSave(
        {
          supportsThinking: true,
          supportsEffort: false,
          thinkingParam: "thinking",
          effortParam: "none",
          outputFormat: "reasoning_content",
        },
        {
          providerName: "Qwen Local",
          baseUrl: "https://www.matrixminecraft.cn:24443/vllm/v1",
          models: [{ model: "qwen3.6" }],
        },
      ),
    ).not.toHaveProperty("defaultOutputTokens");
  });

  it("preserves native-profile overrides (parallel tool calls + input modalities + base instructions)", () => {
    expect(
      normalizeCodexCatalogModelsForSave([
        {
          model: "MiniMax-M3",
          displayName: "MiniMax-M3",
          contextWindow: 1000000,
          supportsParallelToolCalls: true,
          inputModalities: ["text", "image"],
          baseInstructions:
            "  You are Codex, a coding agent based on MiniMax-M3.  ",
        },
        // false must be preserved (not dropped as falsy); empty modalities dropped;
        // empty/whitespace baseInstructions dropped
        {
          model: "mimo-v2.5-pro",
          supportsParallelToolCalls: false,
          inputModalities: [],
          baseInstructions: "   ",
        },
      ]),
    ).toEqual([
      {
        model: "MiniMax-M3",
        displayName: "MiniMax-M3",
        contextWindow: 1000000,
        supportsParallelToolCalls: true,
        inputModalities: ["text", "image"],
        baseInstructions: "You are Codex, a coding agent based on MiniMax-M3.",
      },
      { model: "mimo-v2.5-pro", supportsParallelToolCalls: false },
    ]);
  });

  it("preserves explicit image-support booleans without input modalities", () => {
    expect(
      normalizeCodexCatalogModelsForSave([
        { model: "vision-explicit", supportsImage: true },
        { model: "text-explicit", supportsImage: false },
      ]),
    ).toEqual([
      { model: "vision-explicit", supportsImage: true },
      { model: "text-explicit", supportsImage: false },
    ]);
  });

  it("keeps disabled catalog rows instead of dropping their enabled:false marker", () => {
    expect(
      normalizeCodexCatalogModelsForSave([
        { model: "enabled-model" },
        { model: "disabled-model", enabled: false },
      ]),
    ).toEqual([
      { model: "enabled-model" },
      { model: "disabled-model", enabled: false },
    ]);
  });

  it("round-trips model transport, cache, and ordering metadata through provider editing", () => {
    const loaded = extractCodexCatalogModels({
      models: [
        {
          model: "qwen3.8",
          api_format: "openai_chat",
          codex_cache: {
            cacheMode: "qwen_context_cache",
            supportsPromptCacheKey: true,
          },
          sortIndex: 7,
        },
      ],
    });

    expect(normalizeCodexCatalogModelsForSave(loaded)).toEqual([
      {
        model: "qwen3.8",
        apiFormat: "openai_chat",
        codexCache: {
          cacheMode: "qwen_context_cache",
          supportsPromptCacheKey: true,
        },
        sortIndex: 7,
      },
    ]);
  });
});
