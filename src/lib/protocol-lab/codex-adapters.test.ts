import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type {
  CodexProviderProtocolPreflightOutcome,
  CodexProtocolCompatibilityRecord,
  CodexProtocolProbeProgressEvent,
} from "@/lib/api/protocol-compatibility";
import type { Provider, UniversalProvider } from "@/types";

import {
  codexProviderModelsRequiringProtocolProbe,
  createBatchCodexProtocolLabAdapter,
  createSingleCodexProtocolLabAdapter,
  createUniversalCodexProtocolLabAdapter,
  type CodexProviderSetBatchProbeOutcome,
} from "./codex-adapters";
import { useProtocolLabWorkflow } from "./useProtocolLabWorkflow";

const provider = {
  id: "provider-one",
  name: "Provider One",
  settingsConfig: {
    modelCatalog: {
      models: [{ model: "qwen3.8", enabled: true }],
    },
  },
};

const apiCapability = {
  schemaVersion: 1,
  source: "provider_api",
  baseUrl: "https://example.test/v1",
  upstreamModel: "qwen3.8",
  supportedEndpoints: ["openai_responses"],
};

function providerWithApiCapability(
  capabilityOverrides: Record<string, unknown> = {},
  modelOverrides: Record<string, unknown> = {},
): Provider {
  return {
    ...provider,
    settingsConfig: {
      base_url: apiCapability.baseUrl,
      modelCatalog: {
        models: [
          {
            model: "qwen3.8",
            enabled: true,
            protocolCapability: { ...apiCapability, ...capabilityOverrides },
            ...modelOverrides,
          },
        ],
      },
    },
  };
}

describe("single Codex Protocol Lab adapter", () => {
  it("treats missing or mismatched probe receipts as stale evidence that must be re-probed", () => {
    const adapter = createSingleCodexProtocolLabAdapter({} as never);

    expect(
      adapter.isDependencyChanged(
        new Error("codex_provider_set_probe_required: receipt-old"),
      ),
    ).toBe(true);
    expect(
      adapter.isDependencyChanged(
        new Error("codex_provider_set_probe_target_mismatch"),
      ),
    ).toBe(true);
    expect(
      adapter.isDependencyChanged(
        new Error("codex_provider_set_probe_receipt_in_use: receipt-live"),
      ),
    ).toBe(false);
  });

  it("requires a probe only while an enabled model follows automatic selection", () => {
    const adapter = createSingleCodexProtocolLabAdapter({} as never);

    expect(adapter.requiresProbe(provider, [])).toBe(true);
    expect(adapter.requiresProbe(provider, ["receipt-one"])).toBe(false);
    expect(
      adapter.requiresProbe(
        {
          ...provider,
          meta: {
            codexProtocolMode: "manual",
            codexProtocolOverrides: { "qwen3.8": "openai_chat" },
          },
        },
        [],
      ),
    ).toBe(false);
    expect(
      adapter.requiresProbe(
        {
          ...provider,
          meta: { providerType: "xai_oauth" },
        },
        [],
      ),
    ).toBe(false);
  });

  it("does not request a probe for a bound API declaration that explicitly denies a capability", () => {
    const provider = providerWithApiCapability({ supportsTools: false });
    expect(codexProviderModelsRequiringProtocolProbe(provider)).toEqual([]);
    expect(
      createSingleCodexProtocolLabAdapter({} as never).requiresProbe(
        provider,
        [],
      ),
    ).toBe(false);
  });

  it.each([
    { supportedEndpoints: ["openai_responses"] },
    { supportedEndpoints: ["openai_chat"] },
    { supportedEndpoints: ["openai_responses", "openai_chat"] },
  ])(
    "does not require deep-probe receipts for provider API endpoints %j",
    ({ supportedEndpoints }) => {
      const adapter = createSingleCodexProtocolLabAdapter({} as never);
      const declaredProvider = providerWithApiCapability({
        supportedEndpoints,
      });

      expect(adapter.requiresProbe(declaredProvider, [])).toBe(false);
      expect(
        codexProviderModelsRequiringProtocolProbe(declaredProvider),
      ).toEqual([]);
      expect(adapter.isManual(declaredProvider)).toBe(false);
    },
  );

  it("restores API-only readiness when reopening the saved profile without probe receipts", () => {
    const adapter = createSingleCodexProtocolLabAdapter({} as never);
    const reopened: Provider = JSON.parse(
      JSON.stringify(providerWithApiCapability()),
    );

    expect(adapter.requiresProbe(reopened, [])).toBe(false);
    expect(codexProviderModelsRequiringProtocolProbe(reopened)).toEqual([]);
  });

  it("only targets unresolved included models in a mixed API-declared catalog", () => {
    const adapter = createSingleCodexProtocolLabAdapter({} as never);
    const mixedProvider: Provider = {
      ...provider,
      meta: { codexProtocolOverrides: { "manual-model": "openai_chat" } },
      settingsConfig: {
        base_url: apiCapability.baseUrl,
        modelCatalog: {
          models: [
            {
              model: "qwen-public",
              upstreamModel: "qwen3.8",
              protocolCapability: apiCapability,
            },
            { model: "unresolved", enabled: true },
            { model: "excluded", enabled: false },
            { model: "manual-model", enabled: true },
          ],
        },
      },
    };

    expect(adapter.requiresProbe(mixedProvider, [])).toBe(true);
    expect(codexProviderModelsRequiringProtocolProbe(mixedProvider)).toEqual([
      "unresolved",
    ]);
  });

  it.each([
    ["empty endpoint inventory", { supportedEndpoints: [] }],
    ["unsupported endpoint", { supportedEndpoints: ["anthropic"] }],
    [
      "mixed supported and unsupported endpoints",
      { supportedEndpoints: ["openai_responses", "anthropic"] },
    ],
    [
      "malformed endpoint inventory",
      { supportedEndpoints: "openai_responses" },
    ],
    ["wrong evidence source", { source: "inferred" }],
    ["unknown schema version", { schemaVersion: 2 }],
    ["missing endpoint binding", { baseUrl: undefined }],
    ["changed provider endpoint", { baseUrl: "https://other.example.test/v1" }],
    ["changed provider path", { baseUrl: "https://example.test/v2" }],
    ["changed upstream model", { upstreamModel: "qwen3.9" }],
    ["malformed tool capability", { supportsTools: "true" }],
    ["malformed streaming capability", { supportsStreaming: null }],
    [
      "malformed continuation capability",
      { supportsToolContinuation: "supported" },
    ],
  ])("falls back to a deep probe for %s", (_label, capabilityOverrides) => {
    const adapter = createSingleCodexProtocolLabAdapter({} as never);
    const declaredProvider = providerWithApiCapability(capabilityOverrides);

    expect(adapter.requiresProbe(declaredProvider, [])).toBe(true);
    expect(codexProviderModelsRequiringProtocolProbe(declaredProvider)).toEqual(
      ["qwen3.8"],
    );
  });

  it.each([
    ["tools explicitly unsupported", { supportsTools: false }],
    ["streaming explicitly unsupported", { supportsStreaming: false }],
    [
      "tool continuation explicitly unsupported",
      { supportsToolContinuation: false },
    ],
  ])("does not probe for %s", (_label, capabilityOverrides) => {
    const adapter = createSingleCodexProtocolLabAdapter({} as never);
    const declaredProvider = providerWithApiCapability(capabilityOverrides);

    expect(adapter.requiresProbe(declaredProvider, [])).toBe(false);
    expect(codexProviderModelsRequiringProtocolProbe(declaredProvider)).toEqual(
      [],
    );
  });

  it.each(["base_url", "baseURL", "baseUrl"])(
    "accepts current %s endpoint settings with normalized trailing slashes",
    (endpointKey) => {
      const adapter = createSingleCodexProtocolLabAdapter({} as never);
      const declaredProvider = providerWithApiCapability({
        baseUrl: "https://EXAMPLE.test/v1/",
      });
      declaredProvider.settingsConfig = {
        [endpointKey]: "https://example.test/v1///",
        modelCatalog: declaredProvider.settingsConfig.modelCatalog,
      };

      expect(adapter.requiresProbe(declaredProvider, [])).toBe(false);
    },
  );

  it("binds API evidence to the current selected TOML provider endpoint", () => {
    const adapter = createSingleCodexProtocolLabAdapter({} as never);
    const declaredProvider = providerWithApiCapability();
    declaredProvider.settingsConfig = {
      config: [
        'model_provider = "selected"',
        "[model_providers.selected]",
        'base_url = "https://example.test/v1/"',
        "[model_providers.unselected]",
        'base_url = "https://other.example.test/v1"',
      ].join("\n"),
      modelCatalog: declaredProvider.settingsConfig.modelCatalog,
    };

    expect(adapter.requiresProbe(declaredProvider, [])).toBe(false);
    declaredProvider.settingsConfig.config =
      'model_provider = "selected"\n[model_providers.selected]\nbase_url = "https://other.example.test/v1"';
    expect(adapter.requiresProbe(declaredProvider, [])).toBe(true);
  });

  it.each([
    "https://example.test/v1?access_token=redacted",
    "https://example.test/v1#fragment",
    "https://redacted@example.test/v1",
  ])("does not trust API evidence with an unsafe endpoint %s", (baseUrl) => {
    const adapter = createSingleCodexProtocolLabAdapter({} as never);
    const declaredProvider = providerWithApiCapability({ baseUrl });
    declaredProvider.settingsConfig.base_url = baseUrl;

    expect(adapter.requiresProbe(declaredProvider, [])).toBe(true);
  });

  it.each([{ upstreamModel: " qwen3.8 " }, { upstream_model: " qwen3.8 " }])(
    "matches API evidence to the row's upstream identity %j",
    (identity) => {
      const adapter = createSingleCodexProtocolLabAdapter({} as never);
      const declaredProvider = providerWithApiCapability(
        {},
        { model: "display-alias", ...identity },
      );

      expect(adapter.requiresProbe(declaredProvider, [])).toBe(false);
    },
  );

  it.each([
    { models: [] },
    { models: [{ model: "excluded", enabled: false }] },
  ])(
    "does not reintroduce stale legacy probes for an empty included canonical catalog %j",
    ({ models }) => {
      const adapter = createSingleCodexProtocolLabAdapter({} as never);
      const emptyProvider: Provider = {
        ...provider,
        settingsConfig: {
          modelCatalog: { models },
          model_catalog: { models: [{ model: "stale-legacy", enabled: true }] },
        },
      };

      expect(adapter.requiresProbe(emptyProvider, [])).toBe(false);
      expect(codexProviderModelsRequiringProtocolProbe(emptyProvider)).toEqual(
        [],
      );
    },
  );

  it.each([{}, { modelCatalog: { models: "malformed" } }])(
    "retains the conservative recovery probe when no usable catalog exists",
    (settingsConfig) => {
      const adapter = createSingleCodexProtocolLabAdapter({} as never);
      expect(adapter.requiresProbe({ ...provider, settingsConfig }, [])).toBe(
        true,
      );
    },
  );

  it("treats an explicit per-model protocol selection as manual commit intent", () => {
    const single = createSingleCodexProtocolLabAdapter({} as never);
    const universal = createUniversalCodexProtocolLabAdapter({} as never);
    const perModelChatSelection = {
      ...provider,
      meta: { codexProtocolOverrides: { "qwen3.8": "openai_chat" as const } },
    };
    const universalPerModelChatSelection: UniversalProvider = {
      id: "universal-one",
      name: "Universal One",
      providerType: "newapi",
      baseUrl: "https://example.test/v1",
      apiKey: "secret",
      apps: { claude: false, codex: true, gemini: false },
      models: { codex: { model: "qwen3.8" } },
      meta: { codexProtocolOverrides: { "qwen3.8": "openai_chat" } },
    };

    expect(single.isManual(perModelChatSelection)).toBe(true);
    expect(universal.isManual(universalPerModelChatSelection)).toBe(true);
  });

  it("maps the backend commit snapshot and projection status without split confirmation", async () => {
    const snapshot = {
      logicalProvider: provider,
      adaptation: {
        persistence: "split" as const,
        status: "ready" as const,
        effectiveTransport: "mixed" as const,
        models: [],
      },
    };
    const commitCodexProviderSet = vi.fn(async () => ({
      preview: {
        digest: "digest-one",
        sourceProviderId: "provider-one",
        responsesModels: ["qwen3.8"],
        chatModels: ["kimi"],
        plan: {
          kind: "split" as const,
          responses_provider_id: "responses-leaf",
          chat_provider_id: "chat-leaf",
        },
      },
      snapshot,
      projections: [],
      status: "committed_with_projection_error" as const,
      projectionErrorCode: "projection_pending",
    }));
    const adapter = createSingleCodexProtocolLabAdapter({
      commitCodexProviderSet,
    } as never);

    const result = await adapter.commit(
      provider,
      ["receipt-one"],
      {
        digest: "digest-one",
        sourceProviderId: "provider-one",
        responsesModels: [],
        chatModels: [],
        plan: { kind: "single", transport: "open_ai_responses" },
      },
      "accept_auto",
    );

    expect(commitCodexProviderSet).toHaveBeenCalledWith(
      provider,
      ["receipt-one"],
      "digest-one",
      "accept_auto",
    );
    expect(result.snapshot).toBe(snapshot);
    expect(result.projectionWarning).toBe(true);
    expect(result.projectionErrorCode).toBe("projection_pending");
  });
});

describe("batch Codex Protocol Lab adapter", () => {
  it("returns the actual successful operation receipts after internal retries", async () => {
    const preview = {
      digest: "batch-digest",
      sourcePreviews: [],
      routerProviderId: provider.id,
      blocked: false,
    };
    const backendOutcome = {
      preview,
      router: provider,
      editorRouter: provider,
      sourceSnapshots: [],
      projections: [],
      status: "committed" as const,
    };
    const commit = vi.fn(async () => backendOutcome);
    const adapter = createBatchCodexProtocolLabAdapter({
      commitCodexProviderSetBatch: commit,
    } as never);
    const draft = {
      router: provider,
      sources: [
        { provider, receiptIds: ["fresh-retry-lease"] },
        {
          provider: { ...provider, id: "second-source" },
          receiptIds: ["second-current-lease"],
        },
      ],
    };

    const result = await adapter.commit(
      draft,
      ["obsolete-outer-lease"],
      preview,
      "accept_auto",
    );

    expect(commit).toHaveBeenCalledWith(
      draft.sources,
      draft.router,
      preview.digest,
      "accept_auto",
    );
    expect(result.outcome).toHaveProperty("consumedReceiptIds", [
      "fresh-retry-lease",
      "second-current-lease",
    ]);
    expect(result.snapshot).toBe(result.outcome);
    expect(result.outcome).not.toHaveProperty("committedEvidence");
    expect(backendOutcome).not.toHaveProperty("consumedReceiptIds");
    expect(backendOutcome).not.toHaveProperty("committedEvidence");
  });

  it("returns the latest supplied probe evidence with actual consumed receipts without mutating the backend outcome", async () => {
    const preview = {
      digest: "evidence-batch-digest",
      sourcePreviews: [],
      routerProviderId: provider.id,
      blocked: false,
    };
    const backendOutcome = {
      preview,
      router: provider,
      editorRouter: provider,
      sourceSnapshots: [],
      projections: [],
      status: "committed" as const,
    };
    const commit = vi.fn(async () => backendOutcome);
    const adapter = createBatchCodexProtocolLabAdapter({
      commitCodexProviderSetBatch: commit,
    } as never);
    const record: CodexProtocolCompatibilityRecord = {
      probeVersion: 1,
      target: {
        provider_id: provider.id,
        route_id: null,
        public_model: "qwen3.8",
        upstream_model: "qwen3.8",
        transport: "open_ai_responses",
        endpoint_fingerprint: "redacted",
        authentication_kind: "api_key",
        credential_fingerprint: "redacted",
        request_policy_fingerprint: "redacted",
      },
      result: {
        selected_transport: "open_ai_responses",
        readiness: "verified",
        branches: [],
      },
      testedAt: 200,
      expiresAt: 300,
    };
    const latestOutcome: CodexProviderProtocolPreflightOutcome = {
      provider,
      adaptationPreview: {
        persistence: "single",
        status: "ready",
        effectiveTransport: "open_ai_responses",
        models: [],
      },
      records: [record],
      observations: [record],
      receiptIds: ["fresh-response-lease"],
      receiptModels: { "fresh-response-lease": "qwen3.8" },
      protocolApplied: false,
    };
    const earlierOutcome: CodexProviderProtocolPreflightOutcome = {
      ...latestOutcome,
      records: [],
      observations: [],
      receiptIds: ["earlier-obsolete-lease"],
      receiptModels: { "earlier-obsolete-lease": "qwen3.8" },
    };
    const draft = {
      router: provider,
      sources: [{ provider, receiptIds: latestOutcome.receiptIds }],
    };
    const latestProbe: CodexProviderSetBatchProbeOutcome = {
      sources: draft.sources,
      outcomes: [
        {
          providerId: provider.id,
          inputProvider: provider,
          outcome: latestOutcome,
        },
      ],
    };
    const earlierProbe: CodexProviderSetBatchProbeOutcome = {
      sources: [{ provider, receiptIds: earlierOutcome.receiptIds }],
      outcomes: [
        {
          providerId: provider.id,
          inputProvider: provider,
          outcome: earlierOutcome,
        },
      ],
    };

    await adapter.commit(
      { router: provider, sources: earlierProbe.sources },
      earlierOutcome.receiptIds,
      preview,
      "accept_auto",
      { probeOutcome: earlierProbe },
    );
    const result = await adapter.commit(
      draft,
      ["obsolete-outer-lease"],
      preview,
      "accept_auto",
      { probeOutcome: latestProbe },
    );

    expect(commit).toHaveBeenLastCalledWith(
      draft.sources,
      draft.router,
      preview.digest,
      "accept_auto",
    );
    expect(result.outcome.committedEvidence).toEqual([latestOutcome]);
    expect(result.outcome.committedEvidence?.[0]).toBe(latestOutcome);
    expect(result.outcome.committedEvidence?.[0].records[0]).toBe(record);
    expect(result.outcome.consumedReceiptIds).toEqual(["fresh-response-lease"]);
    expect(result.snapshot).toBe(result.outcome);
    expect(result.outcome).not.toBe(backendOutcome);
    expect(backendOutcome).not.toHaveProperty("committedEvidence");
    expect(backendOutcome).not.toHaveProperty("consumedReceiptIds");
    expect(latestProbe.outcomes[0].outcome).toBe(latestOutcome);
    expect(earlierProbe.outcomes[0].outcome).toBe(earlierOutcome);
  });

  it("retries a known-bad declared source without probing unaffected API-ready sources", async () => {
    const failedProvider = providerWithApiCapability();
    const unaffectedProvider = {
      ...providerWithApiCapability(),
      id: "unaffected-source",
    };
    const unaffectedSource = {
      provider: unaffectedProvider,
      receiptIds: [] as string[],
    };
    const draft = {
      router: provider,
      sources: [
        { provider: failedProvider, receiptIds: [] as string[] },
        unaffectedSource,
      ],
      forceProbeSourceIds: [failedProvider.id],
    };
    const preflight = vi.fn(async () => ({
      provider: failedProvider,
      receiptIds: ["fresh-fallback-lease"],
      records: [],
      observations: [],
      protocolApplied: false,
      adaptationPreview: {
        persistence: "single" as const,
        status: "ready" as const,
        effectiveTransport: "open_ai_responses" as const,
        models: [],
      },
    }));
    const adapter = createBatchCodexProtocolLabAdapter({
      preflightCodexProviderProtocolCompatibility: preflight,
    } as never);

    expect(adapter.requiresProbe(draft, [])).toBe(true);
    const result = await adapter.preflight(draft, () => {});

    expect(preflight).toHaveBeenCalledOnce();
    expect(preflight).toHaveBeenCalledWith(
      failedProvider,
      expect.any(Function),
    );
    expect(result.outcome.sources[1]).toBe(unaffectedSource);
    expect(result.outcome.sources[0].provider).toBe(failedProvider);
    expect(result.draft).toHaveProperty(
      "forceProbeSourceIds",
      draft.forceProbeSourceIds,
    );
    expect(failedProvider.settingsConfig).toEqual(
      providerWithApiCapability().settingsConfig,
    );
  });

  it("retains forced fallback sources through a stale-receipt retry while clearing unaffected stale leases", async () => {
    const failedProvider = providerWithApiCapability();
    const unaffectedProvider = {
      ...providerWithApiCapability(),
      id: "unaffected-source",
    };
    const draft = {
      router: provider,
      sources: [
        { provider: failedProvider, receiptIds: ["stale-fallback-lease"] },
        {
          provider: unaffectedProvider,
          receiptIds: ["stale-unaffected-lease"],
        },
      ],
      forceProbeSourceIds: [failedProvider.id],
    };
    const preflight = vi.fn(async () => ({
      provider: failedProvider,
      receiptIds: ["fresh-fallback-lease"],
      records: [],
      observations: [],
      protocolApplied: false,
      adaptationPreview: {
        persistence: "single" as const,
        status: "ready" as const,
        effectiveTransport: "open_ai_responses" as const,
        models: [],
      },
    }));
    const adapter = createBatchCodexProtocolLabAdapter({
      preflightCodexProviderProtocolCompatibility: preflight,
    } as never);

    const result = await adapter.preflight(draft, () => {}, {
      staleRetry: true,
    });

    expect(preflight).toHaveBeenCalledOnce();
    expect(preflight).toHaveBeenCalledWith(
      failedProvider,
      expect.any(Function),
    );
    expect(result.draft).toHaveProperty(
      "forceProbeSourceIds",
      draft.forceProbeSourceIds,
    );
    expect(result.receiptIds).toEqual(["fresh-fallback-lease"]);
    expect(result.outcome.sources[1].receiptIds).toEqual([]);
  });

  it("ignores forced source identifiers that are not part of the current draft", async () => {
    const declaredProvider = providerWithApiCapability();
    const preflight = vi.fn();
    const adapter = createBatchCodexProtocolLabAdapter({
      preflightCodexProviderProtocolCompatibility: preflight,
    } as never);
    const draft = {
      router: provider,
      sources: [{ provider: declaredProvider, receiptIds: [] as string[] }],
      forceProbeSourceIds: ["removed-source"],
    };

    expect(adapter.requiresProbe(draft, [])).toBe(false);
    await adapter.preflight(draft, () => {});
    expect(preflight).not.toHaveBeenCalled();
  });

  it("saves API-ready sources after stale nested receipts are retried without sending model requests", async () => {
    const declaredProvider = providerWithApiCapability();
    const sources = [
      { provider: declaredProvider, receiptIds: ["consumed-declared-lease"] },
    ];
    const preview = {
      digest: "metadata-batch",
      sourcePreviews: [],
      routerProviderId: provider.id,
      blocked: false,
    };
    const preflight = vi.fn();
    const prepare = vi
      .fn()
      .mockRejectedValueOnce(new Error("codex_provider_set_probe_required"))
      .mockResolvedValueOnce(preview);
    const commit = vi.fn(async () => ({
      preview,
      router: provider,
      editorRouter: provider,
      sourceSnapshots: [],
      projections: [],
      status: "committed" as const,
    }));
    const adapter = createBatchCodexProtocolLabAdapter({
      preflightCodexProviderProtocolCompatibility: preflight,
      prepareCodexProviderSetBatch: prepare,
      commitCodexProviderSetBatch: commit,
    } as never);
    const { result } = renderHook(() => useProtocolLabWorkflow(adapter));

    await act(async () => {
      await result.current.save({ router: provider, sources }, [
        "consumed-declared-lease",
      ]);
    });

    expect(preflight).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepare.mock.calls[0][0]).toEqual(sources);
    expect(prepare.mock.calls[1][0]).toEqual([
      { provider: declaredProvider, receiptIds: [] },
    ]);
    expect(commit).toHaveBeenCalledWith(
      [{ provider: declaredProvider, receiptIds: [] }],
      provider,
      preview.digest,
      "accept_auto",
    );
    expect(result.current.state.phase).toBe("committed");
    expect(result.current.state.staleRetryCount).toBe(1);
  });

  it("discards stale nested receipts for metadata-ready and manual sources only on dependency retry", async () => {
    const declaredProvider = providerWithApiCapability();
    const manualProvider = {
      ...provider,
      id: "manual-provider",
      meta: { codexProtocolMode: "manual" as const },
    };
    const sources = [
      { provider: declaredProvider, receiptIds: ["consumed-declared-lease"] },
      { provider: manualProvider, receiptIds: ["consumed-manual-lease"] },
    ];
    const preflight = vi.fn();
    const adapter = createBatchCodexProtocolLabAdapter({
      preflightCodexProviderProtocolCompatibility: preflight,
    } as never);

    expect(adapter.requiresProbe({ router: provider, sources }, [])).toBe(
      false,
    );
    const result = await adapter.preflight(
      { router: provider, sources },
      () => {},
      { staleRetry: true },
    );

    expect(preflight).not.toHaveBeenCalled();
    expect(result.draft?.sources).toEqual([
      { provider: declaredProvider, receiptIds: [] },
      { provider: manualProvider, receiptIds: [] },
    ]);
    expect(result.receiptIds).toEqual([]);
    expect(sources[0].receiptIds).toEqual(["consumed-declared-lease"]);
    expect(sources[1].receiptIds).toEqual(["consumed-manual-lease"]);
  });

  it("skips API-ready sources and preserves their providers and receipts while probing unresolved sources", async () => {
    const declaredProvider = providerWithApiCapability();
    const unresolvedProvider = {
      ...provider,
      id: "unresolved-provider",
      name: "Unresolved Provider",
    };
    const normalizedProvider = {
      ...unresolvedProvider,
      name: "Unresolved Provider Normalized",
    };
    const declaredSource = {
      provider: declaredProvider,
      receiptIds: ["existing-declared-receipt"],
    };
    const preflight = vi.fn(async () => ({
      provider: normalizedProvider,
      receiptIds: ["fresh-unresolved-receipt"],
      records: [],
      observations: [],
      protocolApplied: false,
      adaptationPreview: {
        persistence: "single" as const,
        status: "ready" as const,
        effectiveTransport: "open_ai_chat" as const,
        models: [],
      },
    }));
    const adapter = createBatchCodexProtocolLabAdapter({
      preflightCodexProviderProtocolCompatibility: preflight,
      prepareCodexProviderSetBatch: vi.fn(),
      commitCodexProviderSetBatch: vi.fn(),
    });
    const sources = [
      declaredSource,
      { provider: unresolvedProvider, receiptIds: [] },
    ];

    expect(
      adapter.requiresProbe(
        {
          router: provider,
          sources: [{ provider: declaredProvider, receiptIds: [] }],
        },
        [],
      ),
    ).toBe(false);
    expect(adapter.requiresProbe({ router: provider, sources }, [])).toBe(true);

    const result = await adapter.preflight(
      { router: provider, sources },
      () => {},
    );

    expect(preflight).toHaveBeenCalledTimes(1);
    expect(preflight).toHaveBeenCalledWith(
      unresolvedProvider,
      expect.any(Function),
    );
    expect(result.outcome.sources[0]).toBe(declaredSource);
    expect(result.outcome.sources).toEqual([
      declaredSource,
      {
        provider: normalizedProvider,
        receiptIds: ["fresh-unresolved-receipt"],
      },
    ]);
    expect(result.receiptIds).toEqual([
      "existing-declared-receipt",
      "fresh-unresolved-receipt",
    ]);
    expect(result.outcome.outcomes).toEqual([
      {
        providerId: unresolvedProvider.id,
        inputProvider: unresolvedProvider,
        outcome: expect.objectContaining({ provider: normalizedProvider }),
      },
    ]);
    expect(sources).toEqual([
      declaredSource,
      { provider: unresolvedProvider, receiptIds: [] },
    ]);
  });

  it("re-probes nested stale receipts when the workflow requests preflight again", async () => {
    const preflight = vi.fn(async () => ({
      provider,
      receiptIds: ["fresh"],
      records: [],
      observations: [],
      protocolApplied: false,
      adaptationPreview: {
        persistence: "single" as const,
        status: "ready" as const,
        effectiveTransport: "open_ai_responses" as const,
        models: [],
      },
    }));
    const adapter = createBatchCodexProtocolLabAdapter({
      preflightCodexProviderProtocolCompatibility: preflight,
      prepareCodexProviderSetBatch: vi.fn(),
      commitCodexProviderSetBatch: vi.fn(),
    });
    const result = await adapter.preflight(
      { router: provider, sources: [{ provider, receiptIds: ["expired"] }] },
      () => {},
    );
    expect(result.receiptIds).toEqual(["fresh"]);
  });
  it("overlaps two providers, refills a free slot and preserves source/receipt order", async () => {
    const started: string[] = [];
    const release = new Map<string, () => void>();
    const sources = ["a", "b", "c", "d"].map((id) => ({
      provider: { ...provider, id },
      receiptIds: [] as string[],
    }));
    const adapter = createBatchCodexProtocolLabAdapter({
      preflightCodexProviderProtocolCompatibility: async (input, progress) => {
        started.push(input.id);
        await new Promise<void>((resolve) => release.set(input.id, resolve));
        progress?.({
          kind: "candidate_finished",
          model: "qwen3.8",
          selectedTransport: "open_ai_chat",
          readiness: "verified",
        });
        return {
          provider: input,
          receiptIds: [`receipt-${input.id}`],
          records: [],
          observations: [],
          protocolApplied: false,
          adaptationPreview: {
            persistence: "single",
            status: "ready",
            effectiveTransport: "open_ai_chat",
            models: [],
          },
        };
      },
      prepareCodexProviderSetBatch: vi.fn(),
      commitCodexProviderSetBatch: vi.fn(),
    });
    const progress = vi.fn();
    const pending = adapter.preflight({ sources, router: provider }, progress);
    expect(started).toEqual(["a", "b"]);
    release.get("b")!();
    await vi.waitFor(() => expect(started).toEqual(["a", "b", "c"]));
    release.get("c")!();
    await vi.waitFor(() => expect(started).toEqual(["a", "b", "c", "d"]));
    release.get("d")!();
    release.get("a")!();
    const result = await pending;
    expect(result.receiptIds).toEqual([
      "receipt-a",
      "receipt-b",
      "receipt-c",
      "receipt-d",
    ]);
    expect(result.outcome.outcomes.map((entry) => entry.providerId)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(progress.mock.calls[0][0]).toMatchObject({
      providerId: "b",
      model: "qwen3.8",
    });
  });

  it("stops queued providers on error and drains in-flight work before allowing retry", async () => {
    const started: string[] = [];
    let fail!: (error: Error) => void;
    let finish!: () => void;
    const adapter = createBatchCodexProtocolLabAdapter({
      preflightCodexProviderProtocolCompatibility: async (input) => {
        started.push(input.id);
        if (input.id === "a")
          await new Promise<void>((_, reject) => {
            fail = reject;
          });
        else
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
        return {
          provider: input,
          receiptIds: [],
          records: [],
          observations: [],
          protocolApplied: false,
          adaptationPreview: {
            persistence: "single",
            status: "ready",
            effectiveTransport: "open_ai_chat",
            models: [],
          },
        };
      },
      prepareCodexProviderSetBatch: vi.fn(),
      commitCodexProviderSetBatch: vi.fn(),
    });
    let settled = false;
    const pending = adapter
      .preflight(
        {
          router: provider,
          sources: ["a", "b", "c"].map((id) => ({
            provider: { ...provider, id },
            receiptIds: [],
          })),
        },
        () => {},
      )
      .catch((error) => {
        settled = true;
        return error;
      });
    expect(started).toEqual(["a", "b"]);
    fail(new Error("probe failed"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(started).toEqual(["a", "b"]);
    finish();
    expect((await pending).message).toBe("probe failed");
    expect(started).toEqual(["a", "b"]);
  });

  it("returns normalized sources and receipts as the authoritative probe outcome", async () => {
    const manualProvider = {
      ...provider,
      id: "provider-manual",
      name: "Provider Manual",
      meta: {
        codexProtocolMode: "manual" as const,
        codexProtocolOverrides: { "qwen3.8": "openai_chat" as const },
      },
    };
    const normalizedProvider = { ...provider, name: "Provider One Normalized" };
    const preflightCodexProviderProtocolCompatibility = vi.fn(
      async (
        _provider: unknown,
        onProgress: (event: CodexProtocolProbeProgressEvent) => void,
      ) => {
        onProgress({
          kind: "candidate_finished",
          model: "qwen3.8",
          selectedTransport: "open_ai_responses",
          readiness: "verified",
        });
        return {
          provider: normalizedProvider,
          adaptationPreview: {
            persistence: "single" as const,
            status: "ready" as const,
            effectiveTransport: "open_ai_responses" as const,
            models: [],
          },
          records: [],
          observations: [],
          receiptIds: ["receipt-one"],
          protocolApplied: false,
        };
      },
    );
    const adapter = createBatchCodexProtocolLabAdapter({
      preflightCodexProviderProtocolCompatibility,
    } as never);
    const router = { ...provider, id: "router-one", name: "Router One" };

    const onProgress = vi.fn();
    const result = await adapter.preflight(
      {
        sources: [
          { provider, receiptIds: [] },
          { provider: manualProvider, receiptIds: [] },
        ],
        router,
      },
      onProgress,
    );

    expect(preflightCodexProviderProtocolCompatibility).toHaveBeenCalledTimes(
      1,
    );
    expect(onProgress).toHaveBeenCalledWith({
      kind: "candidate_finished",
      providerId: "provider-one",
      providerName: "Provider One",
      model: "qwen3.8",
      selectedTransport: "open_ai_responses",
      readiness: "verified",
    });
    expect(result.outcome.sources).toEqual([
      { provider: normalizedProvider, receiptIds: ["receipt-one"] },
      { provider: manualProvider, receiptIds: [] },
    ]);
    expect(result.outcome.outcomes).toEqual([
      {
        providerId: "provider-one",
        inputProvider: provider,
        outcome: expect.objectContaining({ provider: normalizedProvider }),
      },
    ]);
    expect(result.draft).toEqual({
      sources: result.outcome.sources,
      router,
    });
  });
});

describe("Universal Codex Protocol Lab adapter", () => {
  it("maps a committed projection warning without reporting the save as failed", async () => {
    const commitUniversalProviderSet = vi.fn(async () => ({
      preview: {
        digest: "universal-digest",
        universalProviderId: "universal-one",
        codex: null,
      },
      codexSnapshot: null,
      status: "committed_with_projection_error" as const,
      projectionErrorCode: "projection_pending",
    }));
    const adapter = createUniversalCodexProtocolLabAdapter({
      commitUniversalProviderSet,
    } as never);
    const universal = {
      id: "universal-one",
      name: "Universal One",
      providerType: "newapi",
      baseUrl: "https://example.test/v1",
      apiKey: "secret",
      apps: { claude: false, codex: false, gemini: false },
      models: {},
    };

    const result = await adapter.commit(
      universal,
      [],
      {
        digest: "universal-digest",
        universalProviderId: "universal-one",
        codex: null,
      },
      "accept_auto",
    );

    expect(result.projectionWarning).toBe(true);
    expect(result.projectionErrorCode).toBe("projection_pending");
  });
});
