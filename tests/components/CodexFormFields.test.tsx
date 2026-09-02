import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyCodexProtocolGroups,
  buildSplitCodexProviderSuggestionForFetchedModels,
  catalogInputCapabilityState,
  CodexFormFields,
  splitFetchedModelsByLikelyCodexProtocol,
} from "@/components/providers/forms/CodexFormFields";
import {
  fetchModelsForConfig,
  fetchXaiOauthModels,
} from "@/lib/api/model-fetch";
import {
  cancelCodexProviderProtocolProbe,
  preflightCodexProviderProtocolCompatibility,
  type CodexProtocolCompatibilityRecord,
  type CodexProtocolProbeProgressEvent,
  type CodexProtocolTransport,
  type CodexProviderProtocolPreflightOutcome,
} from "@/lib/api/protocol-compatibility";
import type {
  CodexApiFormat,
  CodexCatalogModel,
  CodexApiKeyGroup,
  CodexRoutingConfig,
} from "@/types";
import type {
  CodexModelReasoningResolution,
  CodexReasoningDiscoveryOutcome,
} from "@/types/codexSubagentV2";

const reasoningApiMocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  trigger: vi.fn(),
}));

vi.mock("@/lib/api/codexSubagentV2", () => ({
  codexSubagentV2Api: {
    resolveModelReasoningCapability: reasoningApiMocks.resolve,
    triggerModelReasoningDetection: reasoningApiMocks.trigger,
  },
}));

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3" },
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      let value = String(options?.defaultValue ?? key);
      if (options) {
        for (const [name, replacement] of Object.entries(options)) {
          value = value.split("{{" + name + "}}").join(String(replacement));
        }
      }
      return value;
    },
  }),
}));

vi.mock("@/lib/api/model-fetch", () => ({
  fetchModelsForConfig: vi.fn(),
  fetchXaiOauthModels: vi.fn(),
  showFetchModelsError: vi.fn(),
}));

vi.mock("@/lib/api/protocol-compatibility", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/api/protocol-compatibility")
  >("@/lib/api/protocol-compatibility");
  return {
    ...actual,
    cancelCodexProviderProtocolProbe: vi.fn(),
    preflightCodexProviderProtocolCompatibility: vi.fn(),
  };
});

vi.mock("@/components/ui/form", () => ({
  FormLabel: ({ children }: { children: ReactNode }) => (
    <label>{children}</label>
  ),
}));

vi.mock("@/components/providers/forms/XaiOAuthSection", () => ({
  XaiOAuthSection: () => <div data-testid="xai-oauth-section" />,
}));

beforeEach(() => {
  vi.useRealTimers();
  vi.mocked(fetchModelsForConfig).mockReset();
  vi.mocked(fetchXaiOauthModels).mockReset();
  vi.mocked(preflightCodexProviderProtocolCompatibility).mockReset();
  vi.mocked(cancelCodexProviderProtocolProbe).mockReset();
  vi.mocked(cancelCodexProviderProtocolProbe).mockResolvedValue(true);
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
  reasoningApiMocks.resolve.mockReset();
  reasoningApiMocks.trigger.mockReset();
  reasoningApiMocks.resolve.mockImplementation(
    async (_settings, _provider, model) =>
      createUnknownReasoningResolution(model),
  );
});

function createUnknownReasoningResolution(
  model: string,
): CodexModelReasoningResolution {
  return {
    model,
    capability: null,
    source: "unknown",
    fingerprint: "",
    resolved: {
      supportKind: "unknown",
      confidence: "unverified",
      codexSelectableEfforts: [],
      providerAcceptedEfforts: [],
      providerDefaultEffort: null,
      disableAllowed: false,
      effortMap: {},
    },
    hasDetectionCandidate: false,
    detection: null,
  };
}

function createDetectedReasoningOutcome(
  model: string,
): Extract<CodexReasoningDiscoveryOutcome, { found: unknown }> {
  return {
    found: {
      providerKey: "codex-thirdparty",
      model,
      fetchedAt: 1_700_000_000_000,
      source: "openrouter_api",
      reasoning: {
        supportedEfforts: ["low", "high"],
        defaultEffort: "high",
        mandatory: false,
        defaultEnabled: true,
      },
    },
  };
}

function createDeepProbeRecord(
  model: string,
  selectedTransport: CodexProtocolTransport | null,
  readiness: "verified" | "partial" | "unverified" = "verified",
): CodexProtocolCompatibilityRecord {
  const passed = selectedTransport ? "passed" : "failed";
  return {
    probeVersion: 1,
    target: {
      provider_id: "codex-thirdparty",
      route_id: null,
      public_model: model,
      upstream_model: model,
      transport: selectedTransport ?? "open_ai_responses",
      endpoint_fingerprint: "redacted-endpoint",
      authentication_kind: "bearer",
      credential_fingerprint: "redacted-credential",
    },
    result: {
      selected_transport: selectedTransport,
      readiness,
      branches: (["open_ai_responses", "open_ai_chat"] as const).map(
        (transport) => ({
          assessment: {
            transport,
            baseline: transport === selectedTransport ? passed : "failed",
            streaming: transport === selectedTransport ? passed : "skipped",
            forced_tool: transport === selectedTransport ? passed : "skipped",
            continuation: transport === selectedTransport ? passed : "skipped",
          },
          reasoning_shape: {
            semantic:
              transport === selectedTransport
                ? ("readable" as const)
                : ("none" as const),
            source:
              transport === selectedTransport
                ? transport === "open_ai_chat"
                  ? ("reasoning_content" as const)
                  : ("native_responses" as const)
                : ("none" as const),
            pre_tool_visible_content: "absent" as const,
          },
        }),
      ),
    },
    testedAt: 1_700_000_000,
    expiresAt: 1_700_086_400,
  };
}

function createDeepProbeOutcome(
  records: CodexProtocolCompatibilityRecord[],
): CodexProviderProtocolPreflightOutcome {
  return {
    provider: {
      id: "codex-thirdparty",
      name: "Third party",
      settingsConfig: {},
    },
    records,
    protocolApplied: records.every(
      (record) =>
        record.result.selected_transport ===
        records[0]?.result.selected_transport,
    ),
  };
}

function emitFinishedProgress(
  records: CodexProtocolCompatibilityRecord[],
  onProgress: (event: CodexProtocolProbeProgressEvent) => void,
) {
  for (const record of records) {
    const model = record.target.public_model;
    onProgress({ kind: "candidate_started", model });
    onProgress({
      kind: "candidate_finished",
      model,
      selectedTransport: record.result.selected_transport,
      readiness: record.result.readiness,
    });
  }
  onProgress({
    kind: "batch_finished",
    total: records.length,
    verified: records.filter((record) => record.result.readiness === "verified")
      .length,
    partial: records.filter((record) => record.result.readiness === "partial")
      .length,
    failed: records.filter((record) => record.result.readiness === "unverified")
      .length,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function renderRoutingHarness(
  initialRouting?: CodexRoutingConfig,
  options: { shouldShowSpeedTest?: boolean } = {},
) {
  const onRoutingChange = vi.fn();
  let latestRouting: CodexRoutingConfig = initialRouting ?? {
    enabled: true,
    defaultRouteId: "",
    routes: [],
  };

  function Harness() {
    const [routing, setRouting] = useState<CodexRoutingConfig>(latestRouting);

    // 测试壳同步保存最新 route 配置，模拟 ProviderForm 对受控字段的回写。
    const handleRoutingChange = (next: CodexRoutingConfig) => {
      latestRouting = next;
      onRoutingChange(next);
      setRouting(next);
    };

    return (
      <CodexFormFields
        codexApiKey="sk-test"
        onApiKeyChange={vi.fn()}
        category="custom"
        shouldShowApiKeyLink={false}
        websiteUrl=""
        shouldShowSpeedTest={options.shouldShowSpeedTest ?? true}
        codexBaseUrl="https://api.example.com"
        onBaseUrlChange={vi.fn()}
        isFullUrl={false}
        onFullUrlChange={vi.fn()}
        isEndpointModalOpen={false}
        onEndpointModalToggle={vi.fn()}
        autoSelect={false}
        onAutoSelectChange={vi.fn()}
        takeoverEnabled={true}
        onTakeoverEnabledChange={vi.fn()}
        apiFormat="openai_chat"
        onApiFormatChange={vi.fn()}
        codexRouting={routing}
        onCodexRoutingChange={handleRoutingChange}
        speedTestEndpoints={[]}
        customUserAgent=""
        onCustomUserAgentChange={vi.fn()}
        localProxyHeadersOverride=""
        onLocalProxyHeadersOverrideChange={vi.fn()}
        localProxyBodyOverride=""
        onLocalProxyBodyOverrideChange={vi.fn()}
      />
    );
  }

  return {
    ...render(<Harness />),
    onRoutingChange,
    latestRouting: () => latestRouting,
  };
}

function renderTrafficPolicyHarness(baseUrl = "https://opencode.ai/zen/go/v1") {
  const onPolicyChange = vi.fn();
  let latestPolicy: import("@/types").CodexTrafficPolicy | undefined;

  function Harness() {
    const [policy, setPolicy] = useState<
      import("@/types").CodexTrafficPolicy | undefined
    >();
    return (
      <CodexFormFields
        codexApiKey="sk-test"
        onApiKeyChange={vi.fn()}
        category="custom"
        shouldShowApiKeyLink={false}
        websiteUrl=""
        shouldShowSpeedTest={false}
        codexBaseUrl={baseUrl}
        onBaseUrlChange={vi.fn()}
        isFullUrl={false}
        onFullUrlChange={vi.fn()}
        isEndpointModalOpen={false}
        onEndpointModalToggle={vi.fn()}
        autoSelect={false}
        onAutoSelectChange={vi.fn()}
        takeoverEnabled
        onTakeoverEnabledChange={vi.fn()}
        apiFormat="openai_responses"
        onApiFormatChange={vi.fn()}
        codexTrafficPolicy={policy}
        onCodexTrafficPolicyChange={(next) => {
          latestPolicy = next;
          onPolicyChange(next);
          setPolicy(next);
        }}
        speedTestEndpoints={[]}
        customUserAgent=""
        onCustomUserAgentChange={vi.fn()}
        localProxyHeadersOverride=""
        onLocalProxyHeadersOverrideChange={vi.fn()}
        localProxyBodyOverride=""
        onLocalProxyBodyOverrideChange={vi.fn()}
      />
    );
  }

  return {
    ...render(<Harness />),
    onPolicyChange,
    latestPolicy: () => latestPolicy,
  };
}

function renderCatalogHarness(
  initialCatalog: CodexCatalogModel[],
  options: {
    shouldShowSpeedTest?: boolean;
    providerName?: string;
    partnerPromotionKey?: string;
    baseUrl?: string;
    apiKey?: string;
    planAccessKeyId?: string;
    planSecretAccessKey?: string;
    takeoverEnabled?: boolean;
    allowModelMenuProjectionToggle?: boolean;
    openAdvancedOptions?: boolean;
    presetCatalogModels?: CodexCatalogModel[];
    knownCatalogModels?: CodexCatalogModel[];
    onProviderSplitSuggestionChange?: ReturnType<typeof vi.fn>;
    initialApiKeyGroups?: CodexApiKeyGroup[];
    isXaiOauthPreset?: boolean;
    isXaiOauthAuthenticated?: boolean;
    selectedXaiAccountId?: string;
  } = {},
) {
  const onCatalogChange = vi.fn();
  const onApiFormatChange = vi.fn();
  const onApiKeyGroupsChange = vi.fn();
  let latestCatalog = initialCatalog;
  let latestApiKeyGroups = options.initialApiKeyGroups ?? [];

  function Harness() {
    const [catalog, setCatalog] = useState<CodexCatalogModel[]>(initialCatalog);
    const [apiKeyGroups, setApiKeyGroups] = useState<CodexApiKeyGroup[]>(
      options.initialApiKeyGroups ?? [],
    );

    // 测试壳模拟 ProviderForm 对 modelCatalog 的受控回写。
    const handleCatalogChange = (next: CodexCatalogModel[]) => {
      latestCatalog = next;
      onCatalogChange(next);
      setCatalog(next);
    };
    const handleApiKeyGroupsChange = (next: CodexApiKeyGroup[]) => {
      latestApiKeyGroups = next;
      onApiKeyGroupsChange(next);
      setApiKeyGroups(next);
    };

    return (
      <CodexFormFields
        providerId="codex-thirdparty"
        providerName={options.providerName}
        isXaiOauthPreset={options.isXaiOauthPreset}
        isXaiOauthAuthenticated={options.isXaiOauthAuthenticated}
        selectedXaiAccountId={options.selectedXaiAccountId}
        codexApiKey={options.apiKey ?? "sk-test"}
        onApiKeyChange={vi.fn()}
        apiKeyGroups={apiKeyGroups}
        onApiKeyGroupsChange={handleApiKeyGroupsChange}
        category="custom"
        shouldShowApiKeyLink={false}
        websiteUrl=""
        partnerPromotionKey={options.partnerPromotionKey}
        planAccessKeyId={options.planAccessKeyId}
        planSecretAccessKey={options.planSecretAccessKey}
        shouldShowSpeedTest={options.shouldShowSpeedTest ?? false}
        codexBaseUrl={options.baseUrl ?? "https://api.thirdparty.example/v1"}
        onBaseUrlChange={vi.fn()}
        isFullUrl={false}
        onFullUrlChange={vi.fn()}
        isEndpointModalOpen={false}
        onEndpointModalToggle={vi.fn()}
        autoSelect={false}
        onAutoSelectChange={vi.fn()}
        takeoverEnabled={options.takeoverEnabled ?? true}
        onTakeoverEnabledChange={vi.fn()}
        allowModelMenuProjectionToggle={
          options.allowModelMenuProjectionToggle ?? true
        }
        apiFormat="openai_chat"
        onApiFormatChange={onApiFormatChange}
        catalogModels={catalog}
        presetCatalogModels={options.presetCatalogModels}
        knownCatalogModels={options.knownCatalogModels}
        onCatalogModelsChange={handleCatalogChange}
        spawnAgentModels={[]}
        onSpawnAgentModelsChange={vi.fn()}
        codexRouting={{ enabled: false, defaultRouteId: "", routes: [] }}
        onProviderSplitSuggestionChange={
          options.onProviderSplitSuggestionChange
        }
        speedTestEndpoints={[]}
        customUserAgent=""
        onCustomUserAgentChange={vi.fn()}
        localProxyHeadersOverride=""
        onLocalProxyHeadersOverrideChange={vi.fn()}
        localProxyBodyOverride=""
        onLocalProxyBodyOverrideChange={vi.fn()}
      />
    );
  }

  const renderResult = render(<Harness />);
  if (options.openAdvancedOptions ?? true) {
    fireEvent.click(screen.getByRole("button", { name: "高级选项" }));
  }

  return {
    ...renderResult,
    onCatalogChange,
    onApiFormatChange,
    onApiKeyGroupsChange,
    latestCatalog: () => latestCatalog,
    latestApiKeyGroups: () => latestApiKeyGroups,
  };
}

function prepareAndOpenProtocolProbe() {
  const verify = screen.getByRole("button", { name: "Verify Connection" });
  if (verify.hasAttribute("disabled")) {
    fireEvent.click(screen.getByRole("button", { name: "Protocol groups" }));
  }
  fireEvent.click(screen.getByRole("button", { name: "Verify Connection" }));
}

interface ReadinessIdentityState {
  baseUrl: string;
  apiKey: string;
  selectedAccountId: string | null;
  customUserAgent: string;
  headersOverride: string;
  apiFormat: CodexApiFormat;
  defaultModel: string;
  catalog: CodexCatalogModel[];
}

function renderReadinessIdentityHarness(
  overrides: Partial<ReadinessIdentityState> = {},
) {
  const initial: ReadinessIdentityState = {
    baseUrl: "https://old.example/v1",
    apiKey: "sk-old",
    selectedAccountId: "account-old",
    customUserAgent: "ccswitch-old",
    headersOverride: '{"X-Route":"old"}',
    apiFormat: "openai_chat",
    defaultModel: "model-a",
    catalog: [
      {
        model: "model-a",
        upstreamModel: "model-a",
        inputModalities: ["text"],
        supportsImage: false,
      },
    ],
    ...overrides,
  };
  const onApiFormatChange = vi.fn();
  let patchIdentity: (patch: Partial<ReadinessIdentityState>) => void = () => {
    throw new Error("readiness identity harness is not mounted");
  };

  function Harness() {
    const [identity, setIdentity] = useState(initial);
    patchIdentity = (patch) =>
      setIdentity((current) => ({ ...current, ...patch }));

    return (
      <CodexFormFields
        providerId="identity-provider"
        providerName="Identity Provider"
        selectedXaiAccountId={identity.selectedAccountId}
        onXaiAccountSelect={vi.fn()}
        codexApiKey={identity.apiKey}
        onApiKeyChange={(apiKey) => patchIdentity({ apiKey })}
        category="custom"
        shouldShowApiKeyLink={false}
        websiteUrl=""
        shouldShowSpeedTest
        codexBaseUrl={identity.baseUrl}
        onBaseUrlChange={(baseUrl) => patchIdentity({ baseUrl })}
        isFullUrl={false}
        onFullUrlChange={vi.fn()}
        isEndpointModalOpen={false}
        onEndpointModalToggle={vi.fn()}
        autoSelect={false}
        onAutoSelectChange={vi.fn()}
        takeoverEnabled
        onTakeoverEnabledChange={vi.fn()}
        codexModel={identity.defaultModel}
        onModelChange={(defaultModel) => patchIdentity({ defaultModel })}
        apiFormat={identity.apiFormat}
        onApiFormatChange={(apiFormat) => {
          onApiFormatChange(apiFormat);
          patchIdentity({ apiFormat });
        }}
        catalogModels={identity.catalog}
        onCatalogModelsChange={(catalog) => patchIdentity({ catalog })}
        spawnAgentModels={[]}
        onSpawnAgentModelsChange={vi.fn()}
        codexRouting={{ enabled: false, defaultRouteId: "", routes: [] }}
        speedTestEndpoints={[]}
        customUserAgent={identity.customUserAgent}
        onCustomUserAgentChange={(customUserAgent) =>
          patchIdentity({ customUserAgent })
        }
        localProxyHeadersOverride={identity.headersOverride}
        onLocalProxyHeadersOverrideChange={(headersOverride) =>
          patchIdentity({ headersOverride })
        }
        localProxyBodyOverride=""
        onLocalProxyBodyOverrideChange={vi.fn()}
      />
    );
  }

  const renderResult = render(<Harness />);
  return {
    ...renderResult,
    onApiFormatChange,
    updateIdentity(patch: Partial<ReadinessIdentityState>) {
      act(() => patchIdentity(patch));
    },
  };
}

function renderAutoSplitHarness() {
  const onCatalogChange = vi.fn();
  const onRoutingChange = vi.fn();
  const onTakeoverEnabledChange = vi.fn();
  const onApiFormatChange = vi.fn();
  const onProviderSplitSuggestionChange = vi.fn();
  let latestRouting: CodexRoutingConfig = {
    enabled: false,
    defaultRouteId: "",
    routes: [],
  };
  let latestCatalog: CodexCatalogModel[] = [];

  function Harness() {
    const [catalog, setCatalog] = useState<CodexCatalogModel[]>([]);
    const [routing, setRouting] = useState<CodexRoutingConfig>(latestRouting);

    /// 测试壳同时接住 catalog 和 routing 回写，模拟第一次配置 provider 时的受控状态。
    const handleCatalogChange = (next: CodexCatalogModel[]) => {
      latestCatalog = next;
      onCatalogChange(next);
      setCatalog(next);
    };
    const handleRoutingChange = (next: CodexRoutingConfig) => {
      latestRouting = next;
      onRoutingChange(next);
      setRouting(next);
    };

    return (
      <CodexFormFields
        providerId="relay-provider"
        providerName="Relay"
        codexApiKey="sk-relay"
        onApiKeyChange={vi.fn()}
        category="custom"
        shouldShowApiKeyLink={false}
        websiteUrl=""
        shouldShowSpeedTest={false}
        codexBaseUrl="https://relay.example/v1"
        onBaseUrlChange={vi.fn()}
        isFullUrl={false}
        onFullUrlChange={vi.fn()}
        isEndpointModalOpen={false}
        onEndpointModalToggle={vi.fn()}
        autoSelect={false}
        onAutoSelectChange={vi.fn()}
        takeoverEnabled={true}
        onTakeoverEnabledChange={onTakeoverEnabledChange}
        apiFormat="openai_chat"
        onApiFormatChange={onApiFormatChange}
        catalogModels={catalog}
        onCatalogModelsChange={handleCatalogChange}
        spawnAgentModels={[]}
        onSpawnAgentModelsChange={vi.fn()}
        codexRouting={routing}
        onCodexRoutingChange={handleRoutingChange}
        onProviderSplitSuggestionChange={onProviderSplitSuggestionChange}
        speedTestEndpoints={[]}
        customUserAgent=""
        onCustomUserAgentChange={vi.fn()}
        localProxyHeadersOverride=""
        onLocalProxyHeadersOverrideChange={vi.fn()}
        localProxyBodyOverride=""
        onLocalProxyBodyOverrideChange={vi.fn()}
      />
    );
  }

  const renderResult = render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "高级选项" }));

  return {
    ...renderResult,
    latestRouting: () => latestRouting,
    latestCatalog: () => latestCatalog,
    onCatalogChange,
    onRoutingChange,
    onTakeoverEnabledChange,
    onApiFormatChange,
    onProviderSplitSuggestionChange,
  };
}

describe("CodexFormFields local model routing", () => {
  it("does not represent missing input capability metadata as text-only", () => {
    expect(catalogInputCapabilityState({ model: "unknown-model" })).toBe(
      "unknown",
    );
    renderCatalogHarness([{ model: "unknown-model" }]);

    expect(screen.getByText("Unknown")).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "unknown-model 文本与图像",
      }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.getByRole("button", {
        name: "unknown-model 仅文本",
      }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("renders route availability as an accessible status light", () => {
    renderCatalogHarness([
      { model: "routable-model" },
      { model: "excluded-model", enabled: false },
    ]);

    expect(
      screen.getByRole("status", {
        name: "routable-model: Enabled",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("status", {
        name: "excluded-model: Disabled",
      }),
    ).toBeInTheDocument();
  });

  it("keeps the model catalog in normal settings before model reasoning", () => {
    renderCatalogHarness([{ model: "qwen3.8" }], {
      openAdvancedOptions: false,
    });

    expect(screen.getByText("模型目录明细")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "模型推理能力" }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "配置 qwen3.8 的推理能力" }),
    );
    expect(screen.getByLabelText("qwen3.8推理能力来源")).toBeInTheDocument();
    expect(screen.queryByText(/Codex 推理能力（/)).not.toBeInTheDocument();
    expect(
      screen
        .getByText("模型目录明细")
        .compareDocumentPosition(
          screen.getByRole("heading", { name: "模型推理能力" }),
        ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("lets users override and restore a preset model's input capability", async () => {
    const preset: CodexCatalogModel = {
      model: "deepseek-v4-flash-vision-exp",
      inputModalities: ["text", "image"],
      supportsImage: true,
      textOnly: false,
    };
    const { latestCatalog } = renderCatalogHarness([preset], {
      presetCatalogModels: [preset],
    });

    expect(
      screen.getByRole("button", {
        name: "deepseek-v4-flash-vision-exp 文本与图像",
      }),
    ).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(
      screen.getByRole("button", {
        name: "deepseek-v4-flash-vision-exp 仅文本",
      }),
    );
    await waitFor(() => {
      expect(latestCatalog()[0]).toEqual(
        expect.objectContaining({
          inputModalities: ["text"],
          supportsImage: false,
          textOnly: true,
        }),
      );
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "deepseek-v4-flash-vision-exp 恢复 CCSM 输入能力预设",
      }),
    );
    await waitFor(() => {
      expect(latestCatalog()[0]).toEqual(
        expect.objectContaining({
          inputModalities: ["text", "image"],
          supportsImage: true,
          textOnly: false,
        }),
      );
    });
  });

  it("hydrates missing aggregator capabilities from trusted provider catalogs", async () => {
    const { latestCatalog } = renderCatalogHarness(
      [
        { model: "gpt-5.6-luna", contextWindow: 272000 },
        { model: "MiniMax-M3", contextWindow: 1000000 },
        { model: "unreported-model" },
      ],
      {
        knownCatalogModels: [
          {
            model: "gpt-5.6-luna",
            inputModalities: ["text", "image"],
            supportsImage: true,
          },
          {
            model: "MiniMax-M3",
            inputModalities: ["text", "image"],
            supportsImage: true,
          },
        ],
      },
    );

    expect(
      screen.getByRole("button", { name: "gpt-5.6-luna 文本与图像" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: "MiniMax-M3 文本与图像" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Unknown")).toBeInTheDocument();

    await waitFor(() => {
      expect(latestCatalog()[0]).toEqual(
        expect.objectContaining({
          inputModalities: ["text", "image"],
          supportsImage: true,
          textOnly: false,
        }),
      );
      expect(latestCatalog()[1]).toEqual(
        expect.objectContaining({
          inputModalities: ["text", "image"],
          supportsImage: true,
          textOnly: false,
        }),
      );
      expect(catalogInputCapabilityState(latestCatalog()[2])).toBe("unknown");
    });
  });

  it("does not guess when trusted catalogs disagree about a model", () => {
    renderCatalogHarness([{ model: "ambiguous-model" }], {
      knownCatalogModels: [
        { model: "ambiguous-model", supportsImage: true },
        { model: "ambiguous-model", supportsImage: false },
      ],
    });

    expect(screen.getByText("Unknown")).toBeInTheDocument();
  });

  it("uses maintained preset capability when the saved row has no capability metadata", () => {
    const preset: CodexCatalogModel = {
      model: "preset-vision-model",
      inputModalities: ["text", "image"],
      supportsImage: true,
      textOnly: false,
    };
    renderCatalogHarness([{ model: "preset-vision-model" }], {
      presetCatalogModels: [preset],
    });

    expect(screen.getAllByText("文本与图像").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", {
        name: "preset-vision-model 文本与图像",
      }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps Ultra independent from automatic reasoning discovery", async () => {
    reasoningApiMocks.resolve.mockImplementation(
      async (_settings, _provider, model) => ({
        model,
        source: "library",
        fingerprint: "library-deepseek",
        capability: {
          schemaVersion: 2,
          supportStatus: "confirmed_supported",
          controlKind: "graded",
          supportedEfforts: ["low", "high"],
          defaultEffort: "high",
          disableAllowed: false,
          upstream: {
            format: "string",
            parameter: "reasoning_effort",
            effortMap: { low: "low", high: "high", max: "high" },
          },
          source: "provider",
        },
        resolved: {
          supportKind: "effort_levels",
          confidence: "maintained",
          codexSelectableEfforts: ["low", "high", "max"],
          providerAcceptedEfforts: ["low", "high"],
          providerDefaultEffort: "high",
          disableAllowed: false,
          effortMap: { low: "low", high: "high", max: "high" },
        },
        hasDetectionCandidate: false,
        detection: null,
      }),
    );
    const { latestCatalog } = renderCatalogHarness([
      { model: "deepseek-v4-flash" },
    ]);

    fireEvent.click(
      screen.getByRole("button", {
        name: "配置 deepseek-v4-flash 的推理能力",
      }),
    );

    expect(
      await screen.findByText(/自动发现会按当前 Provider、模型和已验证声明/),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "解锁 deepseek-v4-flash 的 Ultra 档",
      }),
    );
    fireEvent.change(
      screen.getByRole("combobox", {
        name: "deepseek-v4-flash Ultra 对应的 Provider 推理强度",
      }),
      { target: { value: "high" } },
    );

    await waitFor(() => {
      expect(latestCatalog()[0]).toEqual(
        expect.objectContaining({
          codexUltra: { enabled: true, providerEffort: "high" },
        }),
      );
    });
    expect(latestCatalog()[0].reasoning).toBeUndefined();
  });

  it("renders the resolved reasoning card and lets the user declare an unknown model", async () => {
    renderCatalogHarness([{ model: "qwen3.8" }]);
    await waitFor(() => expect(reasoningApiMocks.resolve).toHaveBeenCalled());
    fireEvent.click(
      screen.getByRole("button", { name: "配置 qwen3.8 的推理能力" }),
    );

    expect(
      await screen.findByText("未知（使用服务端默认）"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("使用服务端默认（不发送推理参数）。"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "手动声明" }));

    await waitFor(() => {
      expect(screen.getByLabelText("qwen3.8推理能力 JSON")).not.toHaveValue("");
    });
  });

  it("adopts a detected reasoning snapshot into the catalog declaration", async () => {
    const detected = createDetectedReasoningOutcome("qwen3.8");
    reasoningApiMocks.resolve.mockImplementation(
      async (_settings, _provider, model) => ({
        ...createUnknownReasoningResolution(model),
        hasDetectionCandidate: true,
        detection: detected.found,
      }),
    );
    const { latestCatalog } = renderCatalogHarness([{ model: "qwen3.8" }]);
    fireEvent.click(
      screen.getByRole("button", { name: "配置 qwen3.8 的推理能力" }),
    );

    expect(await screen.findByText("采用检测结果")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "采用检测结果" }));

    await waitFor(() => {
      expect(latestCatalog()[0].reasoning).toEqual(
        expect.objectContaining({
          source: "user",
          supportedEfforts: ["low", "high"],
          defaultEffort: "high",
          disableAllowed: true,
        }),
      );
    });
  });

  it("re-detects a model through the read-only capability command", async () => {
    const detected = createDetectedReasoningOutcome("qwen3.8");
    let redetected = false;
    reasoningApiMocks.resolve.mockImplementation(
      async (_settings, _provider, model) =>
        redetected
          ? {
              ...createUnknownReasoningResolution(model),
              source: "detection",
              capability: {
                schemaVersion: 2,
                supportStatus: "confirmed_supported",
                controlKind: "graded",
                supportedEfforts: ["low", "high"],
                defaultEffort: "high",
                disableAllowed: true,
                upstream: {
                  format: "reasoning_object",
                  parameter: "reasoning.effort",
                },
              },
              resolved: {
                supportKind: "effort_levels",
                confidence: "confirmed",
                codexSelectableEfforts: ["low", "high"],
                providerAcceptedEfforts: ["low", "high"],
                providerDefaultEffort: "high",
                disableAllowed: true,
                effortMap: { low: "low", high: "high" },
              },
              hasDetectionCandidate: true,
              detection: detected.found,
            }
          : createUnknownReasoningResolution(model),
    );
    reasoningApiMocks.trigger.mockImplementationOnce(async () => {
      redetected = true;
      return detected;
    });
    renderCatalogHarness([{ model: "qwen3.8" }]);
    fireEvent.click(
      screen.getByRole("button", { name: "配置 qwen3.8 的推理能力" }),
    );

    expect(
      await screen.findByRole("button", { name: "重新检测" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新检测" }));

    await waitFor(() => {
      expect(reasoningApiMocks.trigger).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "codex-thirdparty",
          settingsConfig: { base_url: "https://api.thirdparty.example/v1" },
        }),
        "qwen3.8",
      );
    });
    expect(await screen.findByText("支持推理")).toBeInTheDocument();
  });

  it("keeps built-in reasoning read-only until an explicit override and restores the preset", async () => {
    const builtinReasoning: NonNullable<CodexCatalogModel["reasoning"]> = {
      supported: true as const,
      supportedEfforts: ["low", "high", "max"],
      defaultEffort: "high" as const,
      disableAllowed: false,
      upstream: {
        format: "reasoning_object" as const,
        parameter: "reasoning.effort" as const,
      },
      source: "builtin" as const,
    };
    const { latestCatalog } = renderCatalogHarness(
      [{ model: "deepseek-v4-pro", reasoning: builtinReasoning }],
      {
        presetCatalogModels: [
          { model: "deepseek-v4-pro", reasoning: builtinReasoning },
        ],
      },
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "配置 deepseek-v4-pro 的推理能力",
      }),
    );
    const textarea = screen.getByLabelText("deepseek-v4-pro推理能力 JSON");
    expect(textarea).toHaveAttribute("readonly");
    expect(screen.getByText("能力来源：CCSM 受维护声明")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "创建高级覆盖" }));
    await waitFor(() => {
      expect(latestCatalog()[0].reasoning?.source).toBe("user");
    });
    expect(
      screen.getByLabelText("deepseek-v4-pro推理能力 JSON"),
    ).not.toHaveAttribute("readonly");
    expect(
      screen.getByText("能力来源：用户声明（已覆盖维护值）"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "恢复内置默认" }));
    await waitFor(() => {
      expect(latestCatalog()[0].reasoning).toEqual(builtinReasoning);
    });
    expect(
      screen.getByLabelText("deepseek-v4-pro推理能力 JSON"),
    ).toHaveAttribute("readonly");
  });
  it("classifies fetched relay models into Responses and Chat groups", () => {
    expect(
      splitFetchedModelsByLikelyCodexProtocol([
        { id: "openai/gpt-5.5", ownedBy: null },
        { id: "gpt-5.4-mini", ownedBy: null },
        { id: "qwen3.6", ownedBy: null },
        { id: "deepseek-v4-flash", ownedBy: null },
      ]),
    ).toEqual({
      responses: ["openai/gpt-5.5", "gpt-5.4-mini"],
      chat: ["qwen3.6", "deepseek-v4-flash"],
    });
  });

  it("builds split provider suggestion with -responses and -chat model groups", () => {
    const split = buildSplitCodexProviderSuggestionForFetchedModels({
      providerName: "Relay",
      models: [
        { id: "gpt-5.5", ownedBy: null },
        { id: "qwen3.6", ownedBy: null },
      ],
    });

    expect(split).toMatchObject({
      providerName: "Relay",
      responsesModels: ["gpt-5.5"],
      chatModels: ["qwen3.6"],
      apiFormatSource: "inferred",
    });
  });

  it("applies detected protocol groups and replaces stale row protocol metadata", () => {
    expect(
      applyCodexProtocolGroups(
        [
          {
            model: "gpt-alias",
            upstreamModel: "gpt-5.5",
            apiFormat: "openai_chat",
          },
          {
            model: "qwen-alias",
            upstreamModel: "qwen3.6",
            apiFormat: "openai_responses",
          },
        ],
        ["gpt-5.5"],
        ["qwen3.6"],
        "probe",
      ),
    ).toMatchObject([
      {
        model: "gpt-alias",
        apiFormat: "openai_responses",
        apiFormatSource: "probe",
      },
      {
        model: "qwen-alias",
        apiFormat: "openai_chat",
        apiFormatSource: "probe",
      },
    ]);
  });

  it("clears protocol metadata for rows absent from a fresh detection", () => {
    const [row] = applyCodexProtocolGroups(
      [
        {
          model: "legacy",
          upstreamModel: "legacy",
          apiFormat: "openai_chat",
          api_format: "openai_chat",
          apiFormatSource: "probe",
          api_format_source: "probe",
        },
      ],
      [],
      [],
      "probe",
    );
    expect(row).not.toHaveProperty("apiFormat");
    expect(row).not.toHaveProperty("api_format");
    expect(row).not.toHaveProperty("apiFormatSource");
    expect(row).not.toHaveProperty("api_format_source");
  });

  it("prompts before preparing split providers after fetching mixed relay models", async () => {
    vi.mocked(fetchModelsForConfig).mockResolvedValueOnce([
      { id: "gpt-5.5", ownedBy: null, contextWindow: 272000 },
      { id: "qwen3.6", ownedBy: null, contextWindow: 128000 },
    ]);
    const {
      latestRouting,
      latestCatalog,
      onRoutingChange,
      onTakeoverEnabledChange,
      onApiFormatChange,
      onProviderSplitSuggestionChange,
    } = renderAutoSplitHarness();

    fireEvent.click(screen.getByRole("button", { name: "Sync Models" }));

    expect(await screen.findByText("检测到混合协议模型")).toBeInTheDocument();
    expect(screen.getByText("Relay / Responses")).toBeInTheDocument();
    expect(screen.getByText("Relay / Chat Completions")).toBeInTheDocument();
    expect(onRoutingChange).not.toHaveBeenCalled();
    expect(latestRouting().routes).toHaveLength(0);

    fireEvent.click(
      screen.getByRole("button", { name: "使用一个 provider，自动路由" }),
    );

    await waitFor(() => {
      expect(latestCatalog()).toMatchObject([
        {
          model: "gpt-5.5",
          apiFormat: "openai_responses",
          apiFormatSource: "inferred",
        },
        {
          model: "qwen3.6",
          apiFormat: "openai_chat",
          apiFormatSource: "inferred",
        },
      ]);
    });
    expect(onProviderSplitSuggestionChange).toHaveBeenLastCalledWith(null);
    expect(onRoutingChange).not.toHaveBeenCalled();
    expect(latestRouting().routes).toHaveLength(0);
    expect(onTakeoverEnabledChange).toHaveBeenCalledWith(true);
    expect(onApiFormatChange).toHaveBeenCalledWith("openai_responses");
  });

  it("keeps routing and provider split untouched when mixed relay split prompt is cancelled", async () => {
    vi.mocked(fetchModelsForConfig).mockResolvedValueOnce([
      { id: "gpt-5.5", ownedBy: null, contextWindow: 272000 },
      { id: "qwen3.6", ownedBy: null, contextWindow: 128000 },
    ]);
    const {
      latestRouting,
      onRoutingChange,
      onTakeoverEnabledChange,
      onApiFormatChange,
      onProviderSplitSuggestionChange,
    } = renderAutoSplitHarness();

    fireEvent.click(screen.getByRole("button", { name: "Sync Models" }));

    expect(await screen.findByText("检测到混合协议模型")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "暂不应用" }));

    await waitFor(() => {
      expect(screen.queryByText("检测到混合协议模型")).not.toBeInTheDocument();
    });
    expect(onRoutingChange).not.toHaveBeenCalled();
    expect(onProviderSplitSuggestionChange).toHaveBeenCalledWith(null);
    expect(latestRouting().routes).toHaveLength(0);
    expect(onTakeoverEnabledChange).not.toHaveBeenCalled();
    expect(onApiFormatChange).not.toHaveBeenCalled();
  });

  it("keeps the previous model as upstream when the visible catalog model is renamed", async () => {
    const { latestCatalog } = renderCatalogHarness([
      { model: "gpt-5.5", displayName: "Third-party GPT" },
    ]);

    fireEvent.change(screen.getByLabelText("候选模型名"), {
      target: { value: "gpt-5.5-thirdparty" },
    });

    await waitFor(() => {
      expect(latestCatalog()).toMatchObject([
        {
          model: "gpt-5.5-thirdparty",
          upstreamModel: "gpt-5.5",
        },
      ]);
    });
  });

  it("confirms protocol probing and switches a single provider to Responses when Responses works", async () => {
    const records = [createDeepProbeRecord("gpt-5.5", "open_ai_responses")];
    vi.mocked(
      preflightCodexProviderProtocolCompatibility,
    ).mockImplementationOnce(async (_provider, _probeId, _mode, onProgress) => {
      emitFinishedProgress(records, onProgress);
      return createDeepProbeOutcome(records);
    });
    const { onApiFormatChange } = renderCatalogHarness(
      [{ model: "gpt-5.5", upstreamModel: "gpt-5.5" }],
      { shouldShowSpeedTest: true },
    );

    prepareAndOpenProtocolProbe();
    expect(screen.getByText("确认测试 Chat / Responses")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认测试" }));

    expect(
      await screen.findByRole("heading", { name: "Codex 兼容性深度探测" }),
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(onApiFormatChange).toHaveBeenCalledWith("openai_responses");
    });
    expect(preflightCodexProviderProtocolCompatibility).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "codex-thirdparty",
        settingsConfig: expect.objectContaining({
          auth: { OPENAI_API_KEY: "sk-test" },
          modelCatalog: {
            models: [expect.objectContaining({ model: "gpt-5.5" })],
          },
        }),
      }),
      expect.stringMatching(/^provider-probe-/),
      "deep",
      expect.any(Function),
    );
  });

  it("runs a light availability probe without changing the provider protocol", async () => {
    const records = [
      createDeepProbeRecord("gpt-5.5", "open_ai_responses", "partial"),
    ];
    vi.mocked(
      preflightCodexProviderProtocolCompatibility,
    ).mockImplementationOnce(async (_provider, _probeId, mode, onProgress) => {
      expect(mode).toBe("light");
      emitFinishedProgress(records, onProgress);
      return createDeepProbeOutcome(records);
    });
    const { onApiFormatChange } = renderCatalogHarness(
      [{ model: "gpt-5.5", upstreamModel: "gpt-5.5" }],
      { shouldShowSpeedTest: true },
    );

    fireEvent.click(screen.getByRole("button", { name: "Light" }));
    prepareAndOpenProtocolProbe();
    fireEvent.click(screen.getByRole("button", { name: "确认测试" }));

    expect(
      await screen.findByText(/Light probe complete: 1 models responded/),
    ).toBeInTheDocument();
    expect(onApiFormatChange).not.toHaveBeenCalled();
    expect(preflightCodexProviderProtocolCompatibility).toHaveBeenCalledWith(
      expect.any(Object),
      expect.stringMatching(/^provider-probe-/),
      "light",
      expect.any(Function),
    );
  });

  it("cancels the active backend probe from the progress dialog", async () => {
    const probe = deferred<CodexProviderProtocolPreflightOutcome>();
    vi.mocked(preflightCodexProviderProtocolCompatibility).mockReturnValueOnce(
      probe.promise,
    );
    renderCatalogHarness([{ model: "gpt-5.5", upstreamModel: "gpt-5.5" }], {
      shouldShowSpeedTest: true,
    });

    prepareAndOpenProtocolProbe();
    fireEvent.click(screen.getByRole("button", { name: "确认测试" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop probe" }));

    await waitFor(() =>
      expect(cancelCodexProviderProtocolProbe).toHaveBeenCalledWith(
        expect.stringMatching(/^provider-probe-/),
      ),
    );
  });

  it("omits disabled catalog models from the deep-probe request", async () => {
    const records = [
      createDeepProbeRecord("model-enabled", "open_ai_responses"),
    ];
    vi.mocked(
      preflightCodexProviderProtocolCompatibility,
    ).mockImplementationOnce(async (_provider, _probeId, _mode, onProgress) => {
      emitFinishedProgress(records, onProgress);
      return createDeepProbeOutcome(records);
    });
    renderCatalogHarness(
      [
        {
          model: "model-enabled",
          upstreamModel: "model-enabled",
          enabled: true,
        },
        {
          model: "model-disabled",
          upstreamModel: "model-disabled",
          enabled: false,
        },
      ],
      { shouldShowSpeedTest: true },
    );

    prepareAndOpenProtocolProbe();
    fireEvent.click(screen.getByRole("button", { name: "确认测试" }));

    await waitFor(() => {
      expect(preflightCodexProviderProtocolCompatibility).toHaveBeenCalled();
    });
    const provider = vi.mocked(preflightCodexProviderProtocolCompatibility).mock
      .calls[0][0];
    expect(provider.settingsConfig.modelCatalog.models).toEqual([
      expect.objectContaining({ model: "model-enabled" }),
    ]);
  });
  it("invalidates successful readiness for every routing and catalog identity input", async () => {
    vi.mocked(preflightCodexProviderProtocolCompatibility).mockImplementation(
      async (provider, _probeId, _mode, onProgress) => {
        const models = provider.settingsConfig.modelCatalog.models.map(
          (model: { model: string }) => model.model,
        );
        const selectedTransport =
          provider.meta?.apiFormat === "openai_chat"
            ? "open_ai_chat"
            : "open_ai_responses";
        const records = models.map((model: string) =>
          createDeepProbeRecord(model, selectedTransport),
        );
        emitFinishedProgress(records, onProgress);
        return createDeepProbeOutcome(records);
      },
    );
    const { updateIdentity } = renderReadinessIdentityHarness();

    const validateCurrentIdentity = async () => {
      prepareAndOpenProtocolProbe();
      fireEvent.click(screen.getByRole("button", { name: "确认测试" }));
      expect(
        await screen.findByText("Can join MultiRouter"),
      ).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    };
    const expectInvalidated = async () => {
      await waitFor(() => {
        expect(
          screen.queryByText("Can join MultiRouter"),
        ).not.toBeInTheDocument();
      });
      expect(screen.getByText("Verify connection first")).toBeInTheDocument();
    };

    await validateCurrentIdentity();
    const identityChanges: Array<Partial<ReadinessIdentityState>> = [
      { baseUrl: "https://new.example/v1" },
      { apiKey: "sk-new" },
      { selectedAccountId: "account-new" },
      { customUserAgent: "ccswitch-new" },
      { headersOverride: '{"X-Route":"new"}' },
      { apiFormat: "openai_responses" },
      { defaultModel: "model-a-alias" },
      {
        catalog: [
          {
            model: "model-a",
            upstreamModel: "model-a",
            inputModalities: ["text", "image"],
            supportsImage: true,
          },
          {
            model: "model-b",
            upstreamModel: "model-b",
            enabled: true,
          },
        ],
      },
      {
        catalog: [
          {
            model: "model-a",
            upstreamModel: "model-a",
            inputModalities: ["text", "image"],
            supportsImage: true,
          },
          {
            model: "model-b",
            upstreamModel: "model-b",
            enabled: false,
          },
        ],
      },
    ];

    for (const patch of identityChanges) {
      updateIdentity(patch);
      await expectInvalidated();
      await validateCurrentIdentity();
    }
  }, 15_000);

  it("ignores an older probe completion after a newer provider identity succeeds", async () => {
    const oldProbe = deferred<CodexProviderProtocolPreflightOutcome>();
    const newProbe = deferred<CodexProviderProtocolPreflightOutcome>();
    vi.mocked(preflightCodexProviderProtocolCompatibility).mockImplementation(
      async (provider) =>
        String(provider.settingsConfig.config).includes("old.example")
          ? oldProbe.promise
          : newProbe.promise,
    );
    const { updateIdentity } = renderReadinessIdentityHarness();

    prepareAndOpenProtocolProbe();
    fireEvent.click(screen.getByRole("button", { name: "确认测试" }));
    await waitFor(() => {
      expect(preflightCodexProviderProtocolCompatibility).toHaveBeenCalledTimes(
        1,
      );
    });

    updateIdentity({ baseUrl: "https://new.example/v1" });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Verify Connection" }),
      ).toBeEnabled(),
    );
    prepareAndOpenProtocolProbe();
    fireEvent.click(screen.getByRole("button", { name: "确认测试" }));

    await act(async () => {
      newProbe.resolve(
        createDeepProbeOutcome([
          createDeepProbeRecord("model-a", "open_ai_responses"),
        ]),
      );
      await Promise.resolve();
    });
    expect(await screen.findByText("Can join MultiRouter")).toBeInTheDocument();

    await act(async () => {
      oldProbe.resolve(
        createDeepProbeOutcome([
          createDeepProbeRecord("model-a", null, "unverified"),
        ]),
      );
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByText("Can join MultiRouter")).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  it("shows per-model protocol tags and suggests split providers for mixed probe results", async () => {
    const records = [
      createDeepProbeRecord("gpt-5.5", "open_ai_responses"),
      createDeepProbeRecord("qwen3.6", "open_ai_chat"),
      createDeepProbeRecord("glm-4.5", null, "unverified"),
    ];
    vi.mocked(
      preflightCodexProviderProtocolCompatibility,
    ).mockImplementationOnce(async (_provider, _probeId, _mode, onProgress) => {
      emitFinishedProgress(records, onProgress);
      return createDeepProbeOutcome(records);
    });
    const onProviderSplitSuggestionChange = vi.fn();
    const { latestCatalog, onApiFormatChange } = renderCatalogHarness(
      [
        { model: "gpt-5.5", upstreamModel: "gpt-5.5" },
        { model: "qwen3.6", upstreamModel: "qwen3.6" },
        { model: "glm-4.5", upstreamModel: "glm-4.5" },
      ],
      {
        providerName: "Relay",
        shouldShowSpeedTest: true,
        onProviderSplitSuggestionChange,
      },
    );

    prepareAndOpenProtocolProbe();
    fireEvent.click(screen.getByRole("button", { name: "确认测试" }));

    expect(await screen.findByText("检测到混合协议模型")).toBeInTheDocument();
    expect(onApiFormatChange).not.toHaveBeenCalled();
    expect(
      screen.getByRole("article", { name: "gpt-5.5 探测进度" }),
    ).toHaveTextContent("选择 Responses");
    expect(
      screen.getByRole("article", { name: "qwen3.6 探测进度" }),
    ).toHaveTextContent("选择 Chat Completions");
    expect(
      screen.getByRole("article", { name: "glm-4.5 探测进度" }),
    ).toHaveTextContent("Failed");

    fireEvent.click(
      screen.getByRole("button", { name: "使用一个 provider，自动路由" }),
    );
    await waitFor(() => {
      expect(latestCatalog()).toMatchObject([
        {
          model: "gpt-5.5",
          apiFormat: "openai_responses",
          apiFormatSource: "probe",
        },
        {
          model: "qwen3.6",
          apiFormat: "openai_chat",
          apiFormatSource: "probe",
        },
        { model: "glm-4.5" },
      ]);
    });
    expect(onProviderSplitSuggestionChange).toHaveBeenLastCalledWith(null);
    expect(onApiFormatChange).toHaveBeenCalledWith("openai_responses");
  });

  it("opens the protocol probe confirmation above the full screen provider panel", () => {
    renderCatalogHarness([{ model: "gpt-5.5", upstreamModel: "gpt-5.5" }], {
      shouldShowSpeedTest: true,
      openAdvancedOptions: false,
    });

    fireEvent.click(screen.getByRole("button", { name: "高级选项" }));
    prepareAndOpenProtocolProbe();

    expect(
      screen.getByText("已打开验证确认框；如果没有看到弹窗，请按 Esc 后重试。"),
    ).toBeVisible();
    expect(screen.getByRole("dialog")).toHaveClass("z-[200]");
    expect(screen.getByText("确认测试 Chat / Responses")).toBeInTheDocument();
  });

  it("blocks protocol probing until a model catalog exists", () => {
    renderCatalogHarness([], { shouldShowSpeedTest: true });

    expect(
      screen.getByRole("button", { name: "Protocol groups" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Verify Connection" }),
    ).toBeDisabled();
    expect(preflightCodexProviderProtocolCompatibility).not.toHaveBeenCalled();
  });

  it("surfaces protocol probe exceptions inline instead of looking frozen", async () => {
    vi.mocked(
      preflightCodexProviderProtocolCompatibility,
    ).mockRejectedValueOnce(new Error("backend timeout"));
    renderCatalogHarness([{ model: "gpt-5.5", upstreamModel: "gpt-5.5" }], {
      shouldShowSpeedTest: true,
    });

    prepareAndOpenProtocolProbe();
    fireEvent.click(screen.getByRole("button", { name: "确认测试" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "探测中断：backend timeout",
    );
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(
      screen.getByRole("button", { name: "Verify Connection" }),
    ).toBeEnabled();
  });
  it("merges fetched models by upstream model without overwriting a visible alias", async () => {
    vi.mocked(fetchModelsForConfig).mockResolvedValueOnce([
      { id: "gpt-5.5", ownedBy: null, contextWindow: 272000 },
    ]);
    const { latestCatalog } = renderCatalogHarness([
      {
        model: "gpt-5.5-thirdparty",
        upstreamModel: "gpt-5.5",
        displayName: "Third-party GPT",
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Sync Models" }));

    await waitFor(() => {
      expect(latestCatalog()).toEqual([
        {
          model: "gpt-5.5-thirdparty",
          upstreamModel: "gpt-5.5",
          displayName: "Third-party GPT",
          contextWindow: "272000",
        },
      ]);
    });
  });

  it("refreshes existing model metadata from the provider without overwriting the alias", async () => {
    vi.mocked(fetchModelsForConfig).mockResolvedValueOnce([
      {
        id: "gpt-5.5",
        ownedBy: null,
        contextWindow: 272000,
        inputModalities: ["text", "image"],
        supportsImage: true,
      },
    ]);
    const { latestCatalog } = renderCatalogHarness([
      {
        model: "my-gpt",
        upstreamModel: "gpt-5.5",
        displayName: "My GPT",
        contextWindow: "128000",
        inputModalities: ["text"],
        supportsImage: false,
        apiFormat: "openai_responses",
        apiFormatSource: "probe",
        enabled: false,
      },
      {
        model: "my-qwen",
        upstreamModel: "qwen3.6",
        apiFormat: "openai_chat",
        apiFormatSource: "probe",
      },
    ]);

    const refreshButton = screen
      .getAllByText("Refresh Existing")
      .map((node) => node.closest("button"))
      .find((node): node is HTMLButtonElement => node !== null);
    expect(refreshButton).toBeDefined();
    fireEvent.click(refreshButton!);

    await waitFor(() => {
      expect(latestCatalog()[0]).toMatchObject({
        model: "my-gpt",
        displayName: "My GPT",
        contextWindow: "272000",
        inputModalities: ["text", "image"],
        supportsImage: true,
        textOnly: false,
        enabled: false,
      });
    });
    expect(screen.queryByText("检测到混合协议模型")).not.toBeInTheDocument();
    expect(latestCatalog()).toMatchObject([
      {
        model: "my-gpt",
        apiFormat: "openai_responses",
        apiFormatSource: "probe",
      },
      {
        model: "my-qwen",
        apiFormat: "openai_chat",
        apiFormatSource: "probe",
      },
    ]);
  });

  it("dismisses a stale mixed-protocol suggestion when refreshing existing models", async () => {
    vi.mocked(fetchModelsForConfig)
      .mockResolvedValueOnce([
        { id: "gpt-5.5", ownedBy: null, contextWindow: 272000 },
        { id: "qwen3.6", ownedBy: null, contextWindow: 128000 },
      ])
      .mockResolvedValueOnce([
        {
          id: "gpt-5.5",
          ownedBy: null,
          contextWindow: 300000,
          inputModalities: ["text", "image"],
          supportsImage: true,
        },
        { id: "qwen3.6", ownedBy: null, contextWindow: 160000 },
      ]);
    const { latestCatalog } = renderCatalogHarness([
      {
        model: "my-gpt",
        upstreamModel: "gpt-5.5",
        apiFormat: "openai_responses",
        apiFormatSource: "probe",
      },
      {
        model: "my-qwen",
        upstreamModel: "qwen3.6",
        apiFormat: "openai_chat",
        apiFormatSource: "probe",
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Sync Models" }));
    expect(await screen.findByText("检测到混合协议模型")).toBeInTheDocument();

    const dialog = screen.getByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: /Refresh Existing|刷新现有模型/i,
      }),
    );

    await waitFor(() => {
      expect(screen.queryByText("检测到混合协议模型")).not.toBeInTheDocument();
      expect(latestCatalog()[0]).toMatchObject({
        model: "my-gpt",
        contextWindow: "300000",
        apiFormat: "openai_responses",
        apiFormatSource: "probe",
      });
    });
    expect(latestCatalog()[1]).toMatchObject({
      model: "my-qwen",
      contextWindow: "160000",
      apiFormat: "openai_chat",
      apiFormatSource: "probe",
    });
  });

  it("does not fetch models from the provider when the catalog filter changes", () => {
    const { latestCatalog } = renderCatalogHarness([
      { model: "free-model", upstreamModel: "free-model" },
      { model: "paid-model", upstreamModel: "paid-model" },
    ]);

    fireEvent.change(screen.getByLabelText("Filter model catalog"), {
      target: { value: "free" },
    });

    expect(fetchModelsForConfig).not.toHaveBeenCalled();
    expect(latestCatalog()).toHaveLength(2);
    expect(screen.getByLabelText("Select free-model")).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Select paid-model"),
    ).not.toBeInTheDocument();
  });

  it("clears the model catalog search from the input clear button", () => {
    renderCatalogHarness([
      { model: "free-model", upstreamModel: "free-model" },
      { model: "paid-model", upstreamModel: "paid-model" },
    ]);

    const searchInput = screen.getByLabelText("Filter model catalog");
    fireEvent.change(searchInput, { target: { value: "free" } });

    expect(screen.getByLabelText("Clear model search")).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Select paid-model"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Clear model search"));

    expect(searchInput).toHaveValue("");
    expect(
      screen.queryByLabelText("Clear model search"),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Select paid-model")).toBeInTheDocument();
  });

  it("discards an in-flight fetch when grouped credentials change", async () => {
    const pending = deferred<{ id: string; ownedBy: null }[]>();
    vi.mocked(fetchModelsForConfig).mockReturnValueOnce(pending.promise);
    const { latestCatalog } = renderCatalogHarness([]);

    fireEvent.click(screen.getByRole("button", { name: "Sync Models" }));
    await waitFor(() => {
      expect(fetchModelsForConfig).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "Add key group" }));
    fireEvent.change(screen.getByPlaceholderText("API key"), {
      target: { value: "sk-new-group" },
    });

    pending.resolve([{ id: "stale-model", ownedBy: null }]);
    await Promise.resolve();

    expect(latestCatalog()).toEqual([]);
  });

  it("matches free case-insensitively across model, display name, and upstream id", async () => {
    const { latestCatalog } = renderCatalogHarness([
      {
        model: "alias",
        displayName: "My Free Alias",
        upstreamModel: "upstream-paid",
        enabled: false,
      },
      {
        model: "plain",
        displayName: "Plain",
        upstreamModel: "provider-free-id",
        enabled: false,
      },
      {
        model: "some-FREE-model",
        upstreamModel: "some-FREE-model",
        enabled: false,
      },
      {
        model: "paid-only",
        upstreamModel: "paid-only",
        enabled: false,
      },
    ]);

    fireEvent.change(screen.getByLabelText("Filter model catalog"), {
      target: { value: "free" },
    });
    fireEvent.click(screen.getByLabelText("Select shown"));
    fireEvent.click(screen.getByRole("button", { name: "Use selected" }));

    await waitFor(() => {
      expect(
        latestCatalog()
          .filter((model) => model.enabled === true)
          .map((model) => model.model),
      ).toEqual(["alias", "plain", "some-FREE-model"]);
    });
    expect(
      latestCatalog().find((model) => model.model === "paid-only")?.enabled,
    ).toBe(false);
    expect(screen.getByLabelText("Filter model catalog")).toHaveValue("free");
  });

  it("uses only the searched models after selecting all shown rows", async () => {
    vi.mocked(fetchModelsForConfig).mockResolvedValueOnce([
      { id: "free-model", ownedBy: null },
      { id: "paid-model", ownedBy: null },
    ]);
    const { latestCatalog } = renderCatalogHarness([]);

    fireEvent.click(screen.getByRole("button", { name: "Sync Models" }));

    await waitFor(() => {
      expect(latestCatalog().map((model) => model.model)).toEqual([
        "free-model",
        "paid-model",
      ]);
      expect(latestCatalog().every((model) => model.enabled !== false)).toBe(
        true,
      );
    });

    fireEvent.change(screen.getByLabelText("Filter model catalog"), {
      target: { value: "free" },
    });
    fireEvent.click(screen.getByLabelText("Select shown"));
    fireEvent.click(screen.getByRole("button", { name: "Use only these" }));

    await waitFor(() => {
      expect(
        latestCatalog().find((model) => model.model === "free-model")?.enabled,
      ).toBe(true);
      expect(
        latestCatalog().find((model) => model.model === "paid-model")?.enabled,
      ).toBe(false);
    });
  });

  it("persists xAI OAuth models so the local free filter can find them", async () => {
    vi.mocked(fetchXaiOauthModels).mockResolvedValueOnce([
      { id: "grok-free", ownedBy: "xai" },
      { id: "grok-paid", ownedBy: "xai" },
    ]);
    const { latestCatalog } = renderCatalogHarness([], {
      isXaiOauthPreset: true,
      isXaiOauthAuthenticated: true,
      selectedXaiAccountId: "xai-account",
    });

    fireEvent.click(screen.getByRole("button", { name: "Sync Models" }));

    await waitFor(() => {
      expect(latestCatalog().map((model) => model.model)).toEqual([
        "grok-free",
        "grok-paid",
      ]);
    });
    expect(fetchXaiOauthModels).toHaveBeenCalledWith("xai-account");

    fireEvent.change(screen.getByLabelText("Filter model catalog"), {
      target: { value: "free" },
    });
    expect(screen.getByLabelText("Select grok-free")).toBeInTheDocument();
    expect(screen.queryByLabelText("Select grok-paid")).not.toBeInTheDocument();
  });

  it("accumulates included rows across successive filters", async () => {
    const { latestCatalog } = renderCatalogHarness([
      { model: "free-a", upstreamModel: "free-a", enabled: false },
      { model: "free-b", upstreamModel: "free-b", enabled: false },
      { model: "paid-c", upstreamModel: "paid-c", enabled: false },
    ]);

    fireEvent.change(screen.getByLabelText("Filter model catalog"), {
      target: { value: "free" },
    });
    fireEvent.click(screen.getByLabelText("Select shown"));
    fireEvent.click(screen.getByRole("button", { name: "Use selected" }));

    await waitFor(() => {
      expect(
        latestCatalog()
          .filter((model) => model.enabled === true)
          .map((model) => model.model),
      ).toEqual(["free-a", "free-b"]);
    });

    fireEvent.change(screen.getByLabelText("Filter model catalog"), {
      target: { value: "paid" },
    });
    fireEvent.click(screen.getByLabelText("Select shown"));
    fireEvent.click(screen.getByRole("button", { name: "Use selected" }));

    await waitFor(() => {
      expect(latestCatalog().every((model) => model.enabled === true)).toBe(
        true,
      );
    });
  });

  it("selects filtered rows and removes only the selected catalog models", async () => {
    const { latestCatalog } = renderCatalogHarness([
      { model: "free-a", upstreamModel: "free-a", enabled: true },
      { model: "free-b", upstreamModel: "free-b", enabled: false },
      { model: "paid-c", upstreamModel: "paid-c", enabled: true },
    ]);

    fireEvent.change(screen.getByLabelText("Filter model catalog"), {
      target: { value: "free" },
    });
    fireEvent.click(screen.getByLabelText("Select shown"));

    expect(screen.getByLabelText("Select free-a")).toBeChecked();
    expect(screen.getByLabelText("Select free-b")).toBeChecked();
    expect(screen.getByLabelText("Remove selected models")).toBeEnabled();

    fireEvent.click(screen.getByLabelText("Remove selected models"));

    await waitFor(() => {
      expect(latestCatalog().map((model) => model.model)).toEqual(["paid-c"]);
    });
    expect(screen.queryByLabelText("Select free-a")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Select free-b")).not.toBeInTheDocument();
  });

  it("adds a key group directly while keeping the fallback API key visible", () => {
    const { latestApiKeyGroups } = renderCatalogHarness([]);

    expect(document.getElementById("codexApiKey")).toBeInTheDocument();
    expect(
      screen.getByText(/No model-specific groups\. The fallback API key/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add key group" }));

    expect(latestApiKeyGroups()).toHaveLength(1);
    expect(latestApiKeyGroups()[0]).toMatchObject({
      apiKeys: [""],
      models: [],
      prefixes: [],
      enabled: true,
      strategy: "round_robin",
    });
    expect(document.getElementById("codexApiKey")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Group label")).toBeInTheDocument();
  });

  it("edits and removes a model-specific API key group through the canonical form controls", async () => {
    const { latestApiKeyGroups } = renderCatalogHarness([], {
      initialApiKeyGroups: [
        {
          id: "priority-models",
          label: "Priority",
          apiKeys: ["sk-priority"],
          models: ["gpt-5.5"],
          prefixes: ["gpt-5"],
          enabled: true,
          strategy: "round_robin",
        },
      ],
    });

    fireEvent.change(screen.getByPlaceholderText("Group label"), {
      target: { value: "Premium" },
    });
    fireEvent.change(screen.getByPlaceholderText("API key"), {
      target: { value: "sk-premium" },
    });
    fireEvent.click(screen.getByRole("switch", { name: "Enabled" }));
    fireEvent.click(screen.getByRole("combobox", { name: "Rotation" }));
    fireEvent.click(await screen.findByRole("option", { name: "Random" }));
    fireEvent.click(screen.getByRole("button", { name: "Add key" }));
    fireEvent.change(screen.getAllByPlaceholderText("API key")[1], {
      target: { value: "sk-premium-backup" },
    });
    fireEvent.change(
      screen.getByPlaceholderText("Exact models, comma separated"),
      { target: { value: "gpt-5.5, gpt-5.6" } },
    );
    fireEvent.change(
      screen.getByPlaceholderText("Model prefixes, comma separated"),
      { target: { value: "gpt-5, o4-" } },
    );

    expect(latestApiKeyGroups()[0]).toMatchObject({
      label: "Premium",
      apiKeys: ["sk-premium", "sk-premium-backup"],
      models: ["gpt-5.5", "gpt-5.6"],
      prefixes: ["gpt-5", "o4-"],
      enabled: false,
      strategy: "random",
    });

    const groupEditor = screen
      .getByPlaceholderText("Group label")
      .closest("div.space-y-3");
    expect(groupEditor).not.toBeNull();
    fireEvent.click(
      within(groupEditor as HTMLElement).getAllByRole("button", {
        name: "Delete",
      })[2],
    );
    expect(latestApiKeyGroups()[0].apiKeys).toEqual(["sk-premium"]);
    fireEvent.click(
      within(groupEditor as HTMLElement).getAllByRole("button", {
        name: "Delete",
      })[0],
    );

    expect(latestApiKeyGroups()).toEqual([]);
    expect(
      screen.getByText(/No model-specific groups\. The fallback API key/),
    ).toBeInTheDocument();
  });

  it("syncs models with the fallback key and every enabled grouped key", async () => {
    vi.mocked(fetchModelsForConfig).mockResolvedValue([]);
    renderCatalogHarness([], {
      apiKey: "sk-fallback",
      initialApiKeyGroups: [
        {
          id: "enabled",
          apiKeys: ["sk-enabled", "sk-enabled"],
          enabled: true,
        },
        {
          id: "disabled",
          apiKeys: ["sk-disabled"],
          enabled: false,
        },
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "Sync Models" }));

    await waitFor(() => {
      expect(fetchModelsForConfig).toHaveBeenCalledTimes(2);
    });
    expect(fetchModelsForConfig).toHaveBeenNthCalledWith(
      1,
      "https://api.thirdparty.example/v1",
      "sk-fallback",
      false,
      undefined,
      "",
      undefined,
    );
    expect(fetchModelsForConfig).toHaveBeenNthCalledWith(
      2,
      "https://api.thirdparty.example/v1",
      "sk-enabled",
      false,
      undefined,
      "",
      undefined,
    );
    expect(
      vi.mocked(fetchModelsForConfig).mock.calls.map((call) => call[1]),
    ).toEqual(["sk-fallback", "sk-enabled"]);
  });

  it("removes stale remote models on a complete successive sync without re-enabling retained rows", async () => {
    vi.mocked(fetchModelsForConfig)
      .mockResolvedValueOnce([
        { id: "alpha-free", ownedBy: null },
        { id: "beta-paid", ownedBy: null },
      ])
      .mockResolvedValueOnce([
        { id: "beta-paid", ownedBy: null },
        { id: "gamma-free", ownedBy: null },
      ]);
    const { latestCatalog } = renderCatalogHarness([]);

    fireEvent.click(screen.getByRole("button", { name: "Sync Models" }));
    await waitFor(() => {
      expect(latestCatalog().map((model) => model.model)).toEqual([
        "alpha-free",
        "beta-paid",
      ]);
    });

    fireEvent.change(screen.getByLabelText("Filter model catalog"), {
      target: { value: "beta-paid" },
    });
    fireEvent.click(screen.getByLabelText("Select shown"));
    fireEvent.click(screen.getByRole("button", { name: "Don't use" }));
    await waitFor(() => {
      expect(
        latestCatalog().find((model) => model.model === "beta-paid")?.enabled,
      ).toBe(false);
    });
    expect(screen.getByLabelText("Filter model catalog")).toHaveValue(
      "beta-paid",
    );

    fireEvent.change(screen.getByLabelText("Filter model catalog"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sync Models" }));

    await waitFor(() => {
      expect(latestCatalog().map((model) => model.model)).toEqual([
        "beta-paid",
        "gamma-free",
      ]);
    });
    expect(
      latestCatalog().find((model) => model.model === "beta-paid")?.enabled,
    ).toBe(false);
    expect(
      latestCatalog().filter((model) => model.model === "beta-paid"),
    ).toHaveLength(1);
  });

  it("keeps stale remote and manual rows when one grouped credential fails", async () => {
    vi.mocked(fetchModelsForConfig)
      .mockResolvedValueOnce([{ id: "remote-kept", ownedBy: null }])
      .mockRejectedValueOnce(new Error("group unavailable"));
    const { latestCatalog } = renderCatalogHarness(
      [
        { model: "remote-kept", upstreamModel: "remote-kept" },
        { model: "remote-stale", upstreamModel: "remote-stale" },
        { model: "manual-entry" },
      ],
      {
        apiKey: "sk-fallback",
        initialApiKeyGroups: [
          { id: "group", enabled: true, apiKeys: ["sk-group"] },
        ],
      },
    );

    fireEvent.click(screen.getByRole("button", { name: "Sync Models" }));

    await waitFor(() => {
      expect(latestCatalog().map((model) => model.model)).toEqual([
        "remote-kept",
        "remote-stale",
        "manual-entry",
      ]);
    });
    expect(fetchModelsForConfig).toHaveBeenCalledTimes(2);
  });

  it("preserves manual rows while removing all remote-bound rows from an empty complete sync", async () => {
    vi.mocked(fetchModelsForConfig).mockResolvedValueOnce([]);
    const { latestCatalog } = renderCatalogHarness([
      { model: "remote-stale", upstreamModel: "remote-stale" },
      { model: "manual-entry" },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Sync Models" }));

    await waitFor(() => {
      expect(latestCatalog()).toEqual([
        expect.objectContaining({ model: "manual-entry", upstreamModel: "" }),
      ]);
    });
  });

  it("falls back to data-plane models when AgentPlan AK/SK is missing but API Key exists", async () => {
    vi.mocked(fetchModelsForConfig).mockResolvedValueOnce([
      { id: "ark-code-latest", ownedBy: "volcengine" },
      { id: "doubao-seed-1.6", ownedBy: "volcengine" },
    ]);
    const { latestCatalog } = renderCatalogHarness(
      [{ model: "ark-code-latest", upstreamModel: "ark-code-latest" }],
      {
        providerName: "火山Agentplan",
        partnerPromotionKey: "volcengine_agentplan",
        baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
      },
    );

    fireEvent.click(screen.getByRole("button", { name: "Sync Models" }));

    await waitFor(() => {
      expect(fetchModelsForConfig).toHaveBeenCalledWith(
        "https://ark.cn-beijing.volces.com/api/coding/v3",
        "sk-test",
        false,
        undefined,
        "",
        undefined,
      );
      expect(latestCatalog().map((model) => model.model)).toEqual([
        "ark-code-latest",
        "doubao-seed-1.6",
      ]);
    });
  });

  it("keeps AgentPlan catalog when both inference key and AK/SK are missing", () => {
    const { latestCatalog } = renderCatalogHarness(
      [{ model: "ark-code-latest", upstreamModel: "ark-code-latest" }],
      {
        providerName: "火山Agentplan",
        partnerPromotionKey: "volcengine_agentplan",
        baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
        apiKey: "",
      },
    );

    fireEvent.click(screen.getByRole("button", { name: "Sync Models" }));

    expect(fetchModelsForConfig).not.toHaveBeenCalled();
    expect(latestCatalog()).toEqual([
      { model: "ark-code-latest", upstreamModel: "ark-code-latest" },
    ]);
  });

  it("fetches AgentPlan models through Volcengine OpenAPI when AK/SK credentials exist", async () => {
    vi.mocked(fetchModelsForConfig).mockResolvedValueOnce([
      { id: "doubao-seed-1.6", ownedBy: "volcengine" },
    ]);
    const { latestCatalog } = renderCatalogHarness(
      [{ model: "ark-code-latest", upstreamModel: "ark-code-latest" }],
      {
        providerName: "火山Agentplan",
        partnerPromotionKey: "volcengine_agentplan",
        baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
        planAccessKeyId: "AKLTtest",
        planSecretAccessKey: "secret",
      },
    );

    fireEvent.click(screen.getByRole("button", { name: "Sync Models" }));

    await waitFor(() => {
      expect(fetchModelsForConfig).toHaveBeenCalledWith(
        "https://ark.cn-beijing.volces.com/api/coding/v3",
        "sk-test",
        false,
        undefined,
        "",
        {
          action: "ListArkAgentPlanModel",
          accessKeyId: "AKLTtest",
          secretAccessKey: "secret",
        },
      );
      expect(latestCatalog().map((model) => model.model)).toEqual([
        "doubao-seed-1.6",
      ]);
    });
  });

  it("uses model mapping checkboxes and arrows for catalog retention and order", async () => {
    const { latestCatalog } = renderCatalogHarness([
      { model: "model-a", upstreamModel: "model-a" },
      { model: "model-b", upstreamModel: "model-b" },
      { model: "model-c", upstreamModel: "model-c" },
    ]);

    fireEvent.click(screen.getByLabelText("Select model-b"));
    fireEvent.click(screen.getByRole("button", { name: "Don't use" }));

    await waitFor(() => {
      const models = latestCatalog();
      expect(models.map((model) => model.model)).toEqual([
        "model-a",
        "model-b",
        "model-c",
      ]);
      expect(models.find((model) => model.model === "model-b")?.enabled).toBe(
        false,
      );
    });

    // Unused rows remain visible and saved as persistent catalog metadata.
    expect(screen.getAllByTitle("上移")).toHaveLength(3);

    fireEvent.click(screen.getAllByTitle("上移")[2]);

    await waitFor(() => {
      const models = latestCatalog();
      expect(models.map((model) => model.model)).toEqual([
        "model-a",
        "model-c",
        "model-b",
      ]);
      expect(
        models
          .filter((model) => model.enabled !== false)
          .map((model) => model.model),
      ).toEqual(["model-a", "model-c"]);
    });
  });

  it("hides the legacy route editor while retaining the supplied routing state", () => {
    const { latestRouting } = renderRoutingHarness({
      enabled: true,
      defaultRouteId: "deepseek",
      routes: [
        {
          id: "deepseek",
          label: "DeepSeek",
          enabled: true,
          match: { models: ["deepseek-v4-flash"], prefixes: [] },
          upstream: {
            baseUrl: "https://api.deepseek.example",
            apiFormat: "openai_chat",
            auth: { source: "provider_config" },
          },
          capabilities: { textOnly: true, inputModalities: ["text"] },
        },
      ],
    });

    expect(screen.queryByText("Codex 多模型路由")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "添加路由" }),
    ).not.toBeInTheDocument();
    expect(latestRouting()).toMatchObject({
      enabled: true,
      defaultRouteId: "deepseek",
      routes: [{ id: "deepseek" }],
    });
  });

  it("shows Zen recommendations, creates a custom policy, clamps edits, and restores recommendations", () => {
    const { latestPolicy } = renderTrafficPolicyHarness();
    fireEvent.click(screen.getByRole("button", { name: "高级选项" }));

    expect(
      screen.getByText(/OpenCode Zen recommendation: 4 in flight/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Customize" }));
    expect(latestPolicy()).toMatchObject({
      admissionEnabled: true,
      maxInFlight: 4,
      maxQueueWaitMs: 30_000,
      rateLimitMaxRetries: 5,
      rejectionRetryMode: "opencode_endpoint_unavailable",
      rejectionMaxRetries: 2,
    });

    fireEvent.change(document.getElementById("codex-max-in-flight")!, {
      target: { value: "999" },
    });
    expect(latestPolicy()?.maxInFlight).toBe(64);
    fireEvent.change(document.getElementById("codex-max-queue-wait")!, {
      target: { value: "1" },
    });
    expect(latestPolicy()?.maxQueueWaitMs).toBe(100);
    fireEvent.change(document.getElementById("codex-rate-limit-retries")!, {
      target: { value: "99" },
    });
    expect(latestPolicy()?.rateLimitMaxRetries).toBe(5);

    fireEvent.click(screen.getByRole("button", { name: "Use recommendation" }));
    expect(latestPolicy()).toBeUndefined();
  });

  it("shows unknown capacity and keeps rejection controls disabled by default", () => {
    renderTrafficPolicyHarness("https://unknown.example/v1");
    fireEvent.click(screen.getByRole("button", { name: "高级选项" }));
    expect(screen.getByText(/No capacity claim is known/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Customize" }));
    expect(document.getElementById("codex-rejection-retries")).toBeDisabled();
    expect(document.getElementById("codex-rejection-delay")).toBeDisabled();
    expect(document.getElementById("codex-rejection-max-delay")).toBeDisabled();
  });

  it("places the explained custom menu projection control last in advanced options", () => {
    renderCatalogHarness([], {
      shouldShowSpeedTest: false,
      takeoverEnabled: true,
      openAdvancedOptions: false,
    });

    expect(
      screen.queryByText("在 Codex /model 菜单中显示"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "高级选项" }));

    const overrides = screen.getByText("本地代理请求覆盖");
    const projection = screen.getByText("在 Codex /model 菜单中显示");
    expect(projection).toBeInTheDocument();
    expect(
      overrides.compareDocumentPosition(projection) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.getByText(/它不控制 Provider、代理或 MultiRouter 是否可用/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/仅当你要使用自己维护的 model_catalog_json 时关闭/),
    ).toBeInTheDocument();
  });

  it("does not offer a menu projection opt-out for maintained presets", () => {
    renderCatalogHarness([], {
      allowModelMenuProjectionToggle: false,
      openAdvancedOptions: false,
    });

    fireEvent.click(screen.getByRole("button", { name: "高级选项" }));

    expect(
      screen.queryByText("在 Codex /model 菜单中显示"),
    ).not.toBeInTheDocument();
  });
});
