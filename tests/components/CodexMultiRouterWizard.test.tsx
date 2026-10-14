import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";
import type { Provider } from "@/types";
import { CodexMultiRouterWizard } from "@/components/codex/CodexMultiRouterWizard";
import { CODEX_MULTI_ROUTER_WIZARD_DISMISSED_KEY } from "@/lib/codexMultiRouterWizard";
import { providersApi } from "@/lib/api/providers";
import { codexSubagentV2Api } from "@/lib/api/codexSubagentV2";
import {
  commitCodexProviderSetBatch,
  prepareCodexProviderSetBatch,
  preflightCodexProviderProtocolCompatibility,
  type CodexProviderProtocolPreflightOutcome,
} from "@/lib/api/protocol-compatibility";
import {
  fetchCodexOfficialFallbackModels,
  fetchCodexOauthModels,
  fetchModelsForConfig,
} from "@/lib/api/model-fetch";

vi.mock("@/lib/api/providers", () => ({
  providersApi: {
    add: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("@/lib/api/codexSubagentV2", () => ({
  codexSubagentV2Api: {
    initializeProviderConfig: vi.fn(),
  },
}));

vi.mock("@/lib/api/protocol-compatibility", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/api/protocol-compatibility")
  >()),
  commitCodexProviderSetBatch: vi.fn(),
  prepareCodexProviderSetBatch: vi.fn(),
  preflightCodexProviderProtocolCompatibility: vi.fn(),
}));

vi.mock("@/lib/api/model-fetch", () => ({
  fetchCodexOfficialFallbackModels: vi.fn(),
  fetchCodexOauthModels: vi.fn(),
  fetchModelsForConfig: vi.fn(),
}));

vi.mock("@/components/providers/forms/hooks/useCodexOauth", () => ({
  useCodexOauth: vi.fn(() => ({
    accounts: [],
    hasAnyAccount: false,
    isLoadingStatus: false,
  })),
}));

vi.mock("@/components/providers/forms/CodexOAuthSection", () => ({
  CodexOAuthSection: () => (
    <div data-testid="wizard-codex-oauth-section">使用 ChatGPT 登录</div>
  ),
}));

// 构造最小 Codex provider，避免 UI 测试依赖真实数据库返回结构。
function provider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: overrides.id ?? "deepseek",
    name: overrides.name ?? "DeepSeek",
    category: overrides.category,
    settingsConfig: overrides.settingsConfig ?? {
      base_url: "https://api.deepseek.com/v1",
      auth: { OPENAI_API_KEY: "sk-test" },
      modelCatalog: { models: [{ model: "deepseek-chat" }] },
    },
    meta: overrides.meta,
  };
}

function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

function verifiedPreflight(
  source: Provider,
  transport: "open_ai_responses" | "open_ai_chat" = "open_ai_responses",
): CodexProviderProtocolPreflightOutcome {
  const models = source.settingsConfig.modelCatalog.models.map(
    (model: { model: string }) => model.model,
  );
  return {
    provider: source,
    adaptationPreview: {
      persistence: "single",
      status: "ready",
      effectiveTransport: transport,
      testedAt: 100,
      expiresAt: 200,
      models: [],
    },
    receiptIds: models.map((model: string) => `receipt:${source.id}:${model}`),
    protocolApplied: false,
    observations: [],
    records: models.map((model: string) => ({
      probeVersion: 1,
      target: {
        provider_id: source.id,
        route_id: null,
        public_model: model,
        upstream_model: model,
        transport,
        endpoint_fingerprint: "endpoint",
        authentication_kind: "bearer",
        credential_fingerprint: "credential",
        request_policy_fingerprint: "policy",
      },
      result: {
        selected_transport: transport,
        readiness: "verified",
        branches: [],
      },
      testedAt: 100,
      expiresAt: 200,
    })),
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.mocked(fetchCodexOfficialFallbackModels).mockResolvedValue([]);
  vi.mocked(preflightCodexProviderProtocolCompatibility).mockImplementation(
    async (source) => verifiedPreflight(source),
  );
  vi.mocked(prepareCodexProviderSetBatch).mockImplementation(
    async (_sources, router) => ({
      digest: `digest:${router.id}`,
      sourcePreviews: [],
      routerProviderId: router.id,
      blocked: false,
    }),
  );
  vi.mocked(commitCodexProviderSetBatch).mockImplementation(
    async (_sources, router, digest) => ({
      preview: {
        digest,
        sourcePreviews: [],
        routerProviderId: router.id,
        blocked: false,
      },
      router,
      editorRouter: router,
      sourceSnapshots: [],
      projections: [],
      status: "committed",
      projectionErrorCode: null,
    }),
  );
});

async function completeWizardDeepProbe() {
  fireEvent.click(screen.getByRole("button", { name: "Protocol deep probe" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Start compatibility deep probe" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Confirm test" }));
  fireEvent.click(await screen.findByRole("button", { name: "Close" }));
}

describe("CodexMultiRouterWizard", () => {
  it("opens a v2 plan with malformed historical candidates without restoring catalog selections", async () => {
    const source = provider();
    const plan = provider({
      id: "existing-plan",
      name: "Existing Plan",
      settingsConfig: {
        codexRouting: {
          schemaVersion: 2,
          enabled: true,
          spawnAgentModels: { stale: "deepseek-chat" },
          routes: [
            {
              id: "route",
              targetProviderId: source.id,
              modelSelection: { mode: "all" },
            },
          ],
        },
        modelCatalog: {
          models: [{ model: "deepseek-chat" }],
          spawnAgentModels: ["deepseek-chat"],
        },
        model_catalog: {
          models: [{ model: "removed" }],
          spawnAgentModels: ["removed"],
        },
      },
    });
    renderWithQueryClient(
      <CodexMultiRouterWizard
        open
        providers={[source, plan]}
        onOpenChange={vi.fn()}
        onCreateProvider={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onEnablePlan={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Sub-Agent and tools" }),
    );
    expect(
      screen.getByLabelText("Use deepseek-chat as a Sub-Agent candidate"),
    ).not.toBeChecked();
    expect(
      screen.queryByLabelText("Use removed as a Sub-Agent candidate"),
    ).not.toBeInTheDocument();
  });

  it("routes only included models while preserving excluded inventory in the batch save", async () => {
    const inventory = [
      { model: "kept", upstreamModel: "wire-kept" },
      { model: "hidden", upstreamModel: "wire-hidden", enabled: false },
    ];
    const source = provider({
      settingsConfig: {
        base_url: "https://api.deepseek.com/v1",
        auth: { OPENAI_API_KEY: "sk-test" },
        modelCatalog: { models: inventory },
      },
    });
    renderWithQueryClient(
      <CodexMultiRouterWizard
        open
        providers={[source]}
        onOpenChange={vi.fn()}
        onCreateProvider={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onEnablePlan={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose models" }));
    expect(screen.getByLabelText("Keep kept")).toBeInTheDocument();
    expect(screen.getByLabelText("Keep hidden")).not.toBeChecked();

    await completeWizardDeepProbe();
    fireEvent.click(screen.getByRole("button", { name: "Save and enable" }));
    fireEvent.click(
      screen.getAllByRole("button", { name: "Save and publish" }).at(-1)!,
    );
    await waitFor(() =>
      expect(commitCodexProviderSetBatch).toHaveBeenCalledTimes(1),
    );
    const [savedSources, savedRouter] = vi.mocked(commitCodexProviderSetBatch)
      .mock.calls[0];
    expect(savedSources[0].provider.settingsConfig.modelCatalog.models).toEqual(
      inventory,
    );
    expect(savedRouter.settingsConfig.codexRouting).toMatchObject({
      schemaVersion: 2,
      spawnAgentModels: [],
      routes: [
        {
          targetProviderId: source.id,
          modelSelection: { mode: "all" },
        },
      ],
    });
    expect(
      savedRouter.settingsConfig.codexRouting.spawnAgentModels,
    ).not.toContain("hidden");
    expect(savedRouter.settingsConfig).not.toHaveProperty("modelCatalog");
    expect(source.settingsConfig.modelCatalog.models).toEqual(inventory);
  });

  it("deep-probes ordinary sources and saves the sources plus router through one batch commit", async () => {
    const source = provider();
    renderWithQueryClient(
      <CodexMultiRouterWizard
        open
        providers={[source]}
        onOpenChange={vi.fn()}
        onCreateProvider={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onEnablePlan={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Protocol deep probe" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Start compatibility deep probe" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm test" }));
    await waitFor(() =>
      expect(preflightCodexProviderProtocolCompatibility).toHaveBeenCalledWith(
        source,
        expect.any(Function),
      ),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Close" }));

    fireEvent.click(screen.getByRole("button", { name: "Save and enable" }));
    fireEvent.click(
      screen.getAllByRole("button", { name: "Save and publish" }).at(-1)!,
    );

    await waitFor(() =>
      expect(prepareCodexProviderSetBatch).toHaveBeenCalledTimes(1),
    );
    expect(prepareCodexProviderSetBatch).toHaveBeenCalledWith(
      [{ provider: source, receiptIds: ["receipt:deepseek:deepseek-chat"] }],
      expect.objectContaining({
        settingsConfig: expect.objectContaining({
          codexRouting: expect.objectContaining({ schemaVersion: 2 }),
        }),
      }),
    );
    expect(commitCodexProviderSetBatch).toHaveBeenCalledTimes(1);
    expect(commitCodexProviderSetBatch).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Object),
      expect.stringContaining("digest:"),
      "accept_auto",
    );
    expect(providersApi.add).not.toHaveBeenCalled();
    expect(providersApi.update).not.toHaveBeenCalled();
    expect(codexSubagentV2Api.initializeProviderConfig).not.toHaveBeenCalled();
  });

  it("does not issue a deep probe request for an official managed source", async () => {
    const official = provider({
      id: "codex-official",
      name: "OpenAI Official",
      category: "official",
      meta: { providerType: "codex_oauth" },
      settingsConfig: {
        modelCatalog: { models: [{ model: "gpt-5.6-sol" }] },
      },
    });
    renderWithQueryClient(
      <CodexMultiRouterWizard
        open
        providers={[official]}
        onOpenChange={vi.fn()}
        onCreateProvider={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onEnablePlan={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Protocol deep probe" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Start compatibility deep probe" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm test" }));

    expect(
      await screen.findByText("State machine:connectivityPartial"),
    ).toBeInTheDocument();
    expect(preflightCodexProviderProtocolCompatibility).not.toHaveBeenCalled();
  });

  it("commits an automatically planned split batch without a second confirmation", async () => {
    vi.mocked(prepareCodexProviderSetBatch).mockResolvedValueOnce({
      digest: "split-digest",
      sourcePreviews: [
        {
          digest: "source-digest",
          sourceProviderId: "deepseek",
          responsesModels: ["deepseek-chat"],
          chatModels: ["deepseek-reasoner"],
          plan: {
            kind: "split",
            responses_provider_id: "deepseek--ccsm-responses",
            chat_provider_id: "deepseek--ccsm-chat",
          },
        },
      ],
      routerProviderId: "codex-multi-router",
      blocked: false,
    });
    renderWithQueryClient(
      <CodexMultiRouterWizard
        open
        providers={[provider()]}
        onOpenChange={vi.fn()}
        onCreateProvider={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onEnablePlan={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Protocol deep probe" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Start compatibility deep probe" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm test" }));
    fireEvent.click(await screen.findByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Save and enable" }));
    fireEvent.click(
      screen.getAllByRole("button", { name: "Save and publish" }).at(-1)!,
    );

    await waitFor(() =>
      expect(commitCodexProviderSetBatch).toHaveBeenCalledWith(
        expect.any(Array),
        expect.any(Object),
        "split-digest",
        "accept_auto",
      ),
    );
    expect(screen.queryByText("Split by protocol")).not.toBeInTheDocument();
  });

  it("keeps a blocked batch completely unsaved", async () => {
    vi.mocked(prepareCodexProviderSetBatch).mockResolvedValueOnce({
      digest: "blocked-digest",
      sourcePreviews: [
        {
          digest: "source-digest",
          sourceProviderId: "deepseek",
          responsesModels: [],
          chatModels: [],
          plan: {
            kind: "blocked",
            models: [
              {
                model: "deepseek-chat",
                upstreamModel: "deepseek-chat",
                reason: "probe_not_verified",
              },
            ],
          },
        },
      ],
      routerProviderId: "codex-multi-router",
      blocked: true,
    });
    renderWithQueryClient(
      <CodexMultiRouterWizard
        open
        providers={[provider()]}
        onOpenChange={vi.fn()}
        onCreateProvider={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onEnablePlan={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Protocol deep probe" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Start compatibility deep probe" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm test" }));
    fireEvent.click(await screen.findByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Save and enable" }));
    fireEvent.click(
      screen.getAllByRole("button", { name: "Save and publish" }).at(-1)!,
    );

    expect(await screen.findByText("Cannot save yet")).toBeInTheDocument();
    expect(commitCodexProviderSetBatch).not.toHaveBeenCalled();
    expect(providersApi.add).not.toHaveBeenCalled();
    expect(providersApi.update).not.toHaveBeenCalled();
  });

  it("keeps the first step focused on source selection and provider-owned configuration", () => {
    renderWithQueryClient(
      <CodexMultiRouterWizard
        open
        providers={[provider()]}
        onOpenChange={vi.fn()}
        onCreateProvider={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onEnablePlan={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Choose model sources" }),
    );
    expect(
      screen.getByText("This step only chooses model sources"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/are maintained in each provider page/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Configure DeepSeek" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Sub-Agent candidates")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/This wizard helps you complete/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Technical notes/)).not.toBeInTheDocument();
  });

  it("keeps runtime validation in the workspace and history repair as an independent Sessions action", () => {
    renderWithQueryClient(
      <CodexMultiRouterWizard
        open
        providers={[provider()]}
        onOpenChange={vi.fn()}
        onCreateProvider={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onEnablePlan={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Real-request acceptance" }),
    ).toBeVisible();
    expect(
      screen.queryByText(
        "After enabling, wait for a successful real request before repairing history",
      ),
    ).not.toBeInTheDocument();
  });

  it("shows provider names in route previews while keeping IDs in tooltips", () => {
    const source = provider({
      id: "5626e6b9-33cb-4c3b-8d16-af8176e16209",
      name: "DeepSeek Relay",
    });
    renderWithQueryClient(
      <CodexMultiRouterWizard
        open
        providers={[source]}
        onOpenChange={vi.fn()}
        onCreateProvider={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onEnablePlan={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Review routing" }));

    const providerBadge = screen.getByTitle(
      "Provider ID: 5626e6b9-33cb-4c3b-8d16-af8176e16209",
    );
    expect(providerBadge).toHaveTextContent("DeepSeek Relay");
  });

  it("keeps V1 controls out and exposes the complete guided pages", () => {
    renderWithQueryClient(
      <CodexMultiRouterWizard
        open
        providers={[provider()]}
        onOpenChange={vi.fn()}
        onCreateProvider={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onEnablePlan={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /Sub-Agent V1/ }),
    ).not.toBeInTheDocument();
    for (const pageName of [
      "Start setup",
      "Environment check",
      "Model source readiness",
      "Choose model sources",
      "Sync model catalogs",
      "Protocol deep probe",
      "Choose models",
      "Model order",
      "Reasoning settings",
      "Sub-Agent and tools",
      "Review routing",
      "Save and enable",
      "Real-request acceptance",
    ]) {
      expect(screen.getByRole("button", { name: pageName })).toBeVisible();
    }
  });

  it("initializes a new default V2 plan before handing it to enable", async () => {
    const qwenSource = provider({
      id: "qwen-local",
      name: "Qwen Local",
      settingsConfig: {
        base_url: "https://qwen.example/v1",
        auth: { OPENAI_API_KEY: "sk-qwen" },
        modelCatalog: { models: [{ model: "qwen3.6" }] },
      },
    });
    const onEnablePlan = vi.fn();
    renderWithQueryClient(
      <CodexMultiRouterWizard
        open
        providers={[qwenSource]}
        onOpenChange={vi.fn()}
        onCreateProvider={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onEnablePlan={onEnablePlan}
      />,
    );

    await completeWizardDeepProbe();
    fireEvent.click(screen.getByRole("button", { name: "Save and enable" }));
    fireEvent.click(screen.getByRole("button", { name: "Save and publish" }));

    await waitFor(() =>
      expect(commitCodexProviderSetBatch).toHaveBeenCalledTimes(1),
    );
    const persisted = vi.mocked(commitCodexProviderSetBatch).mock.calls[0][1];
    expect(persisted.settingsConfig.codexRouting.subagentVersion).toBe("v2");
    expect(codexSubagentV2Api.initializeProviderConfig).not.toHaveBeenCalled();

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Enable this multi-route plan",
      }),
    );
    await waitFor(() => expect(onEnablePlan).toHaveBeenCalledWith(persisted));
    expect(onEnablePlan.mock.calls[0][0]).toBe(persisted);
  });

  it("keeps an enabled plan in the wizard and exposes separate post-setup actions", async () => {
    const qwenSource = provider({
      id: "qwen-local",
      name: "Qwen Local",
      settingsConfig: {
        base_url: "https://qwen.example/v1",
        auth: { OPENAI_API_KEY: "sk-qwen" },
        modelCatalog: { models: [{ model: "qwen3.6" }] },
      },
    });
    const onOpenChange = vi.fn();
    const onOpenHistoryRepair = vi.fn();
    const onOpenWorkspace = vi.fn();
    const onEnablePlan = vi.fn();
    renderWithQueryClient(
      <CodexMultiRouterWizard
        open
        providers={[qwenSource]}
        onOpenChange={onOpenChange}
        onCreateProvider={vi.fn()}
        onOpenHistoryRepair={onOpenHistoryRepair}
        onOpenWorkspace={onOpenWorkspace}
        onEnablePlan={onEnablePlan}
      />,
    );

    await completeWizardDeepProbe();
    fireEvent.click(screen.getByRole("button", { name: "Save and enable" }));
    fireEvent.click(screen.getByRole("button", { name: "Save and publish" }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Enable this multi-route plan",
      }),
    );

    await waitFor(() => expect(onEnablePlan).toHaveBeenCalledTimes(1));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(
      screen.getByText(
        "MultiRouter enabled; waiting for real-request acceptance",
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: /Repair Codex history/ }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: /Set model reasoning effort/ }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: /Configure Sub-Agent/ }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: /Adjust model order/ }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Accept later" })).toBeVisible();

    const persisted = vi.mocked(commitCodexProviderSetBatch).mock.calls[0][1];
    fireEvent.click(
      screen.getByRole("button", { name: /Repair Codex history/ }),
    );
    expect(onOpenHistoryRepair).toHaveBeenCalledOnce();
    fireEvent.click(
      screen.getByRole("button", { name: /Set model reasoning effort/ }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Configure Sub-Agent/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Adjust model order/ }));
    expect(onOpenWorkspace).toHaveBeenNthCalledWith(1, persisted, "sources");
    expect(onOpenWorkspace).toHaveBeenNthCalledWith(2, persisted, "subagents");
    expect(onOpenWorkspace).toHaveBeenNthCalledWith(
      3,
      persisted,
      "model-order",
    );
  });

  it("keeps the wizard controls inside small app windows", () => {
    renderWithQueryClient(
      <CodexMultiRouterWizard
        open
        providers={[provider()]}
        onOpenChange={vi.fn()}
        onCreateProvider={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onEnablePlan={vi.fn()}
      />,
    );

    const shell = screen.getByTestId("codex-multirouter-wizard-shell");
    const body = screen.getByTestId("codex-multirouter-wizard-body");
    const footer = screen.getByRole("button", { name: "Next" }).parentElement
      ?.parentElement;

    expect(shell).toHaveClass("flex", "max-h-full", "flex-col");
    expect(body).toHaveClass("min-h-0", "flex-1", "overflow-hidden");
    expect(footer).toHaveClass("shrink-0");
  });

  it("opens, navigates steps, and stores dismissed flag when skipped", () => {
    const onOpenChange = vi.fn();

    renderWithQueryClient(
      <CodexMultiRouterWizard
        open
        providers={[provider()]}
        onOpenChange={onOpenChange}
        onCreateProvider={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onEnablePlan={vi.fn()}
      />,
    );

    expect(screen.getAllByText("Start setup").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getAllByText("Environment check").length).toBeGreaterThan(0);

    fireEvent.click(
      screen.getByRole("button", { name: "Save draft and close" }),
    );
    expect(localStorage.getItem(CODEX_MULTI_ROUTER_WIZARD_DISMISSED_KEY)).toBe(
      "true",
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("renders an existing plan when its historical model catalog contains invalid entries", () => {
    renderWithQueryClient(
      <CodexMultiRouterWizard
        open
        providers={[
          provider({
            id: "existing-plan",
            name: "Existing Plan",
            settingsConfig: {
              codexRouting: { schemaVersion: 2, enabled: true, routes: [] },
              modelCatalog: {
                models: [null, "stale", { model: "deepseek-chat" }],
              },
            } as Provider["settingsConfig"],
          }),
          provider(),
        ]}
        onOpenChange={vi.fn()}
        onCreateProvider={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onEnablePlan={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Start setup" }),
    ).toBeInTheDocument();
  });

  it("guides official Codex sources to configure ChatGPT OAuth in provider config step", () => {
    const onOpenProviderConfig = vi.fn();
    const official = provider({
      id: "codex-official",
      name: "OpenAI Official",
      category: "official",
      settingsConfig: {},
    });
    renderWithQueryClient(
      <CodexMultiRouterWizard
        open
        providers={[official]}
        onOpenChange={vi.fn()}
        onCreateProvider={vi.fn()}
        onOpenProviderConfig={onOpenProviderConfig}
        onOpenWorkspace={vi.fn()}
        onEnablePlan={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Choose model sources" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Configure OpenAI Official" }),
    );
    expect(onOpenProviderConfig).toHaveBeenCalledWith(official);
    expect(
      screen.queryByLabelText("OpenAI Official API format"),
    ).not.toBeInTheDocument();
  });

  it("does not reset to the intro step when parent rerenders with a new providers array", () => {
    const deepseekProvider = provider();
    const { rerender } = renderWithQueryClient(
      <CodexMultiRouterWizard
        open
        providers={[deepseekProvider]}
        onOpenChange={vi.fn()}
        onCreateProvider={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onEnablePlan={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(
      screen.getByRole("heading", { name: "Environment check" }),
    ).toBeInTheDocument();

    rerender(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false } },
          })
        }
      >
        <CodexMultiRouterWizard
          open
          providers={[{ ...deepseekProvider }]}
          onOpenChange={vi.fn()}
          onCreateProvider={vi.fn()}
          onOpenWorkspace={vi.fn()}
          onEnablePlan={vi.fn()}
        />
      </QueryClientProvider>,
    );

    expect(
      screen.getByRole("heading", { name: "Environment check" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("This wizard helps you complete 7 tasks"),
    ).not.toBeInTheDocument();
  });

  it("keeps provider protocol editing out of the wizard when a stale provider refetch arrives", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const staleQwen = provider({
      id: "qwen-local",
      name: "Qwen Local",
      meta: { apiFormat: "openai_responses" },
      settingsConfig: {
        base_url: "https://qwen.example/v1",
        auth: { OPENAI_API_KEY: "sk-qwen" },
        apiFormat: "openai_responses",
        modelCatalog: { models: [{ model: "qwen3.6" }] },
      },
    });
    const renderWizard = (source: Provider) => (
      <QueryClientProvider client={queryClient}>
        <CodexMultiRouterWizard
          open
          providers={[source]}
          onOpenChange={vi.fn()}
          onCreateProvider={vi.fn()}
          onOpenProviderConfig={vi.fn()}
          onOpenWorkspace={vi.fn()}
          onEnablePlan={vi.fn()}
        />
      </QueryClientProvider>
    );
    const { rerender } = render(renderWizard(staleQwen));

    fireEvent.click(
      screen.getByRole("button", { name: "Choose model sources" }),
    );
    expect(
      screen.queryByLabelText("Qwen Local API format"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Configure Qwen Local" }),
    ).toBeInTheDocument();

    // 模拟后台 provider query 在用户选择之后返回数据库里的旧 Responses 快照。
    rerender(renderWizard({ ...staleQwen }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Configure Qwen Local" }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Review routing" }));
    expect(screen.queryByText("openai_responses")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        /Protocols, endpoints, credentials, and model capabilities are always read from the target/,
      ),
    ).toBeInTheDocument();
  });

  it("marks catalog-only providers as continuable instead of requiring full config", () => {
    renderWithQueryClient(
      <CodexMultiRouterWizard
        open
        providers={[
          provider({
            id: "catalog-only",
            name: "Catalog Only",
            settingsConfig: {
              modelCatalog: { models: [{ model: "manual-model" }] },
            },
          }),
        ]}
        onOpenChange={vi.fn()}
        onCreateProvider={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onEnablePlan={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Choose model sources" }),
    );
    expect(screen.getByText("1 models")).toBeInTheDocument();
    expect(
      screen.queryByText(/Online fetch parameters are not configured/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Needs setup")).not.toBeInTheDocument();
  });

  it("refreshes providers that already have modelCatalog and marks unchanged lists", async () => {
    vi.mocked(fetchModelsForConfig).mockResolvedValueOnce([
      { id: "deepseek-chat", ownedBy: null },
    ]);

    renderWithQueryClient(
      <CodexMultiRouterWizard
        open
        providers={[provider()]}
        onOpenChange={vi.fn()}
        onCreateProvider={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onEnablePlan={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Sync model catalogs" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Fetch model lists automatically" }),
    );

    expect(
      await screen.findByText("No model list changes"),
    ).toBeInTheDocument();
    expect(fetchModelsForConfig).toHaveBeenCalledTimes(1);
    expect(providersApi.update).not.toHaveBeenCalled();
  });

  it("refreshes an official OAuth catalog with its bound account without including new models", async () => {
    vi.mocked(fetchCodexOauthModels).mockResolvedValueOnce([
      { id: "gpt-5.5", ownedBy: "openai", contextWindow: 272000 },
      { id: "gpt-5.6-sol", ownedBy: "openai", contextWindow: 372000 },
    ]);
    const officialProvider = provider({
      id: "codex-official",
      name: "OpenAI Official",
      category: "official",
      meta: {
        providerType: "codex_oauth",
        authBinding: {
          source: "managed_codex_oauth",
          accountId: "account-56",
        },
      },
      settingsConfig: {
        modelCatalog: { models: [{ model: "gpt-5.5" }] },
      },
    });

    renderWithQueryClient(
      <CodexMultiRouterWizard
        open
        providers={[officialProvider]}
        onOpenChange={vi.fn()}
        onCreateProvider={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onEnablePlan={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Sync model catalogs" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Fetch model lists automatically" }),
    );

    await waitFor(() =>
      expect(fetchCodexOauthModels).toHaveBeenCalledWith("account-56"),
    );
    expect(
      await screen.findByText(/loaded 2 models into the draft/),
    ).toBeInTheDocument();
    expect(providersApi.update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Choose models" }));
    expect(screen.getByLabelText("Keep gpt-5.5")).toBeInTheDocument();
    expect(screen.getByLabelText("Keep gpt-5.6-sol")).not.toBeChecked();
    expect(fetchModelsForConfig).not.toHaveBeenCalled();
  });

  it("keeps the last OAuth catalog when the dynamic model request fails", async () => {
    vi.mocked(fetchCodexOauthModels).mockRejectedValueOnce(
      new Error("temporary OAuth endpoint failure"),
    );
    const officialProvider = provider({
      id: "codex-official",
      name: "OpenAI Official",
      category: "official",
      meta: { providerType: "codex_oauth" },
      settingsConfig: {
        modelCatalog: { models: [{ model: "gpt-5.5" }] },
      },
    });

    renderWithQueryClient(
      <CodexMultiRouterWizard
        open
        providers={[officialProvider]}
        onOpenChange={vi.fn()}
        onCreateProvider={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onEnablePlan={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Sync model catalogs" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Fetch model lists automatically" }),
    );

    expect(
      await screen.findByText(
        /OAuth model-list fetch failed; kept the existing catalog/,
      ),
    ).toBeInTheDocument();
    expect(providersApi.update).not.toHaveBeenCalled();
    expect(fetchModelsForConfig).not.toHaveBeenCalled();
  });

  it("uses the official fallback catalog when OAuth is unavailable for an empty official source", async () => {
    vi.mocked(fetchCodexOauthModels).mockRejectedValueOnce(
      new Error("error sending request for url"),
    );
    vi.mocked(fetchCodexOfficialFallbackModels).mockResolvedValueOnce([
      { id: "aurora-code", ownedBy: "Codex", contextWindow: 256000 },
      { id: "gpt-6-astra", ownedBy: "Codex", contextWindow: 256000 },
    ]);
    const officialProvider = provider({
      id: "codex-official",
      name: "OpenAI Official",
      category: "official",
      meta: { providerType: "codex_oauth" },
      settingsConfig: { modelCatalog: { models: [] } },
    });

    renderWithQueryClient(
      <CodexMultiRouterWizard
        open
        providers={[officialProvider]}
        onOpenChange={vi.fn()}
        onCreateProvider={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onEnablePlan={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Sync model catalogs" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Fetch model lists automatically" }),
    );

    expect(
      await screen.findByText(
        /loaded 2 models from the fallback official catalog/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /OAuth online model-list fetch failed; used the fallback official catalog/,
      ),
    ).toBeInTheDocument();
    expect(providersApi.update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Choose models" }));
    expect(screen.getByLabelText("Keep aurora-code")).toBeInTheDocument();
  });

  it("excludes an unchecked provider from the generated MultiRouter plan", async () => {
    const secondSource = provider({
      id: "qwen-local",
      name: "Qwen Local",
      settingsConfig: {
        base_url: "https://qwen.example/v1",
        auth: { OPENAI_API_KEY: "sk-qwen" },
        modelCatalog: { models: [{ model: "qwen3.6" }] },
      },
    });

    renderWithQueryClient(
      <CodexMultiRouterWizard
        open
        providers={[provider(), secondSource]}
        onOpenChange={vi.fn()}
        onCreateProvider={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onEnablePlan={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Choose model sources" }),
    );
    fireEvent.click(screen.getByLabelText("Use Qwen Local as a model source"));
    await completeWizardDeepProbe();
    fireEvent.click(screen.getByRole("button", { name: "Save and enable" }));
    fireEvent.click(
      screen.getAllByRole("button", { name: "Save and publish" }).at(-1)!,
    );

    await waitFor(() =>
      expect(commitCodexProviderSetBatch).toHaveBeenCalledTimes(1),
    );
    const savedProvider = vi.mocked(commitCodexProviderSetBatch).mock
      .calls[0][1];
    expect(
      savedProvider.settingsConfig.codexRouting.routes.map(
        (route: { id: string }) => route.id,
      ),
    ).not.toContain("qwen-local");
    expect(savedProvider.settingsConfig).not.toHaveProperty("modelCatalog");
  });

  it("keeps provider curated models when wizard refresh sees extra upstream models", async () => {
    vi.mocked(fetchModelsForConfig).mockResolvedValueOnce([
      { id: "deepseek-chat", ownedBy: null, contextWindow: 128000 },
      { id: "deepseek-reasoner", ownedBy: null, contextWindow: 64000 },
    ]);

    renderWithQueryClient(
      <CodexMultiRouterWizard
        open
        providers={[
          provider({
            settingsConfig: {
              base_url: "https://api.deepseek.com/v1",
              auth: { OPENAI_API_KEY: "sk-test" },
              modelCatalog: {
                models: [{ model: "deepseek-chat" }],
                spawnAgentModels: ["deepseek-chat", "deepseek-reasoner"],
              },
            },
          }),
        ]}
        onOpenChange={vi.fn()}
        onCreateProvider={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onEnablePlan={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Sync model catalogs" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Fetch model lists automatically" }),
    );

    expect(
      await screen.findByText(/loaded 1 models into the draft/),
    ).toBeInTheDocument();
    expect(providersApi.update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Choose models" }));
    expect(screen.getByLabelText("Keep deepseek-chat")).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Keep deepseek-reasoner"),
    ).not.toBeInTheDocument();
  });

  it("falls back to data-plane models for AgentPlan without AK/SK when API Key exists", async () => {
    vi.mocked(fetchModelsForConfig).mockResolvedValueOnce([
      { id: "ark-code-latest", ownedBy: "volcengine" },
      { id: "doubao-seed-1.6", ownedBy: "volcengine" },
    ]);

    renderWithQueryClient(
      <CodexMultiRouterWizard
        open
        providers={[
          provider({
            id: "ark-agentplan",
            name: "火山Agentplan",
            settingsConfig: {
              base_url: "https://ark.cn-beijing.volces.com/api/coding/v3",
              auth: { OPENAI_API_KEY: "sk-volc" },
              modelCatalog: {
                models: [{ model: "ark-code-latest" }],
              },
            },
            meta: { partnerPromotionKey: "volcengine_agentplan" },
          }),
        ]}
        onOpenChange={vi.fn()}
        onCreateProvider={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onEnablePlan={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Sync model catalogs" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Fetch model lists automatically" }),
    );

    await waitFor(() => {
      expect(fetchModelsForConfig).toHaveBeenCalledWith(
        "https://ark.cn-beijing.volces.com/api/coding/v3",
        "sk-volc",
        false,
        undefined,
        undefined,
        undefined,
      );
      expect(providersApi.update).not.toHaveBeenCalled();
    });
    expect(
      await screen.findByText(
        "Read succeeded with no model-list changes; still 1 models.",
      ),
    ).toBeInTheDocument();
  });

  it("skips AgentPlan model fetch when both inference key and AK/SK are missing", async () => {
    renderWithQueryClient(
      <CodexMultiRouterWizard
        open
        providers={[
          provider({
            id: "ark-agentplan",
            name: "火山Agentplan",
            settingsConfig: {
              base_url: "https://ark.cn-beijing.volces.com/api/coding/v3",
              auth: { OPENAI_API_KEY: "" },
              modelCatalog: {
                models: [{ model: "ark-code-latest" }],
              },
            },
            meta: { partnerPromotionKey: "volcengine_agentplan" },
          }),
        ]}
        onOpenChange={vi.fn()}
        onCreateProvider={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onEnablePlan={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Sync model catalogs" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Fetch model lists automatically" }),
    );

    await waitFor(() => {
      expect(fetchModelsForConfig).not.toHaveBeenCalled();
      expect(providersApi.update).not.toHaveBeenCalled();
    });
  });

  it("refreshes AgentPlan models through Volcengine OpenAPI when AK/SK exists", async () => {
    vi.mocked(fetchModelsForConfig).mockResolvedValueOnce([
      { id: "doubao-seed-1.6", ownedBy: "volcengine" },
    ]);

    renderWithQueryClient(
      <CodexMultiRouterWizard
        open
        providers={[
          provider({
            id: "ark-agentplan",
            name: "火山Agentplan",
            settingsConfig: {
              base_url: "https://ark.cn-beijing.volces.com/api/coding/v3",
              auth: { OPENAI_API_KEY: "sk-volc" },
              modelCatalog: {
                models: [{ model: "ark-code-latest" }],
              },
            },
            meta: {
              partnerPromotionKey: "volcengine_agentplan",
              usage_script: {
                enabled: true,
                language: "javascript",
                code: "",
                accessKeyId: "AKLTtest",
                secretAccessKey: "secret",
              },
            },
          }),
        ]}
        onOpenChange={vi.fn()}
        onCreateProvider={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onEnablePlan={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Sync model catalogs" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Fetch model lists automatically" }),
    );

    await waitFor(() => {
      expect(fetchModelsForConfig).toHaveBeenCalledWith(
        "https://ark.cn-beijing.volces.com/api/coding/v3",
        "sk-volc",
        false,
        undefined,
        undefined,
        {
          action: "ListArkAgentPlanModel",
          accessKeyId: "AKLTtest",
          secretAccessKey: "secret",
        },
      );
      expect(providersApi.update).not.toHaveBeenCalled();
    });
    expect(await screen.findByText("Model list updated")).toBeInTheDocument();
    expect(screen.getByText("Changed 1: ark-code-latest")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Choose models" }));
    expect(screen.getByLabelText("Keep ark-code-latest")).not.toBeChecked();
  });

  it("keeps previous model selections without re-adding newly fetched provider models", async () => {
    vi.mocked(fetchModelsForConfig).mockResolvedValueOnce([
      { id: "model-a", ownedBy: null },
      { id: "model-b", ownedBy: null },
      { id: "model-c", ownedBy: null },
    ]);
    renderWithQueryClient(
      <CodexMultiRouterWizard
        open
        providers={[
          provider({
            id: "relay",
            name: "Relay",
            settingsConfig: {
              base_url: "https://relay.example/v1",
              auth: { OPENAI_API_KEY: "sk-test" },
              modelCatalog: {
                models: [
                  { model: "model-a", upstreamModel: "model-a" },
                  { model: "model-b", upstreamModel: "model-b" },
                ],
              },
            },
          }),
        ]}
        onOpenChange={vi.fn()}
        onCreateProvider={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onEnablePlan={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Choose models" }));
    fireEvent.click(screen.getByLabelText("Keep model-b"));
    expect(screen.getByLabelText("Keep model-b")).not.toBeChecked();

    fireEvent.click(
      screen.getByRole("button", { name: "Sync model catalogs" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Fetch model lists automatically" }),
    );

    expect(
      await screen.findByText("No model list changes"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Added 1: model-c/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Choose models" }));
    expect(screen.getByLabelText("Keep model-a")).toBeChecked();
    expect(screen.getByLabelText("Keep model-b")).not.toBeChecked();
    expect(screen.queryByLabelText("Keep model-c")).not.toBeInTheDocument();
  });

  it("opens a provider config page from the model fetch cards", () => {
    const onOpenProviderConfig = vi.fn();
    const source = provider();

    renderWithQueryClient(
      <CodexMultiRouterWizard
        open
        providers={[source]}
        onOpenChange={vi.fn()}
        onCreateProvider={vi.fn()}
        onOpenProviderConfig={onOpenProviderConfig}
        onOpenWorkspace={vi.fn()}
        onEnablePlan={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Sync model catalogs" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Open DeepSeek settings" }),
    );

    expect(onOpenProviderConfig).toHaveBeenCalledWith(source);
  });

  it("does not expose inferred protocol details for official sources in the source picker", () => {
    renderWithQueryClient(
      <CodexMultiRouterWizard
        open
        providers={[
          provider({
            id: "openai-official-backup",
            name: "OpenAI Official Backup",
            category: "official",
            meta: { apiFormat: "openai_chat" },
            settingsConfig: {
              modelCatalog: {
                models: [{ model: "gpt-5.5", upstreamModel: "gpt-5.5" }],
              },
            },
          }),
        ]}
        onOpenChange={vi.fn()}
        onCreateProvider={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onEnablePlan={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Choose model sources" }),
    );
    expect(
      screen.getAllByText(/OpenAI Official Backup/).length,
    ).toBeGreaterThan(0);
    expect(
      screen.queryByText(/API 格式：Responses API（向导推断/),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Configure OpenAI Official Backup" }),
    ).toBeInTheDocument();
  });

  it("keeps manually locked chat protocol on the Provider instead of a Route snapshot", async () => {
    renderWithQueryClient(
      <CodexMultiRouterWizard
        open
        providers={[
          provider({
            id: "relay",
            name: "Relay",
            settingsConfig: {
              base_url: "https://relay.example/v1",
              auth: { OPENAI_API_KEY: "sk-test" },
              apiFormat: "openai_chat",
              modelCatalog: {
                models: [{ model: "gpt-5.5", upstreamModel: "gpt-5.5" }],
              },
            },
            meta: {
              apiFormat: "openai_chat",
              apiFormatSource: "manual",
              codexProtocolMode: "manual",
            },
          }),
        ]}
        onOpenChange={vi.fn()}
        onCreateProvider={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onEnablePlan={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Protocol deep probe" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Start compatibility deep probe" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm test" }));
    expect(
      await screen.findByText("State machine:connectivityPartial"),
    ).toBeInTheDocument();
    expect(preflightCodexProviderProtocolCompatibility).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Save and enable" }));
    fireEvent.click(
      screen.getAllByRole("button", { name: "Save and publish" }).at(-1)!,
    );

    await waitFor(() => {
      expect(commitCodexProviderSetBatch).toHaveBeenCalledTimes(1);
    });
    const savedProvider = vi.mocked(commitCodexProviderSetBatch).mock
      .calls[0][1];
    expect(savedProvider.settingsConfig.codexRouting.routes[0]).toMatchObject({
      targetProviderId: "relay",
    });
    expect(
      savedProvider.settingsConfig.codexRouting.routes[0],
    ).not.toHaveProperty("upstream");
  });

  it("stays in needSources state when advancing without model sources", () => {
    renderWithQueryClient(
      <CodexMultiRouterWizard
        open
        providers={[]}
        onOpenChange={vi.fn()}
        onCreateProvider={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onEnablePlan={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.getByText("State machine:needSources")).toBeInTheDocument();
    expect(
      screen.getByText("Connect a usable model source first"),
    ).toBeInTheDocument();
  });

  it("selects a provider added from the empty-state flow by its returned id", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const renderWizard = (
      providers: Provider[],
      newlyCreatedProviderIds: string[],
    ) => (
      <QueryClientProvider client={queryClient}>
        <CodexMultiRouterWizard
          open
          providers={providers}
          newlyCreatedProviderIds={newlyCreatedProviderIds}
          onOpenChange={vi.fn()}
          onCreateProvider={vi.fn()}
          onOpenWorkspace={vi.fn()}
          onEnablePlan={vi.fn()}
        />
      </QueryClientProvider>
    );
    const { rerender } = render(renderWizard([], []));

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(
      screen.getByText("Connect a usable model source first"),
    ).toBeInTheDocument();

    const addedProvider = provider({
      id: "wizard-new-source",
      name: "Wizard New Source",
    });
    rerender(renderWizard([addedProvider], [addedProvider.id]));

    expect(
      await screen.findByRole("heading", { name: "Model source readiness" }),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Choose model sources" }),
    );
    expect(
      screen.getByRole("checkbox", {
        name: "Use Wizard New Source as a model source",
      }),
    ).toBeChecked();
  });

  it("moves to saveFailed state when publishing the generated plan fails", async () => {
    vi.mocked(commitCodexProviderSetBatch).mockRejectedValueOnce(
      new Error("db locked"),
    );

    renderWithQueryClient(
      <CodexMultiRouterWizard
        open
        providers={[provider()]}
        onOpenChange={vi.fn()}
        onCreateProvider={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onEnablePlan={vi.fn()}
      />,
    );

    await completeWizardDeepProbe();
    fireEvent.click(screen.getByRole("button", { name: "Save and enable" }));
    const publishButtons = screen.getAllByRole("button", {
      name: "Save and publish",
    });
    fireEvent.click(publishButtons[publishButtons.length - 1]);

    expect(
      await screen.findByText("State machine:saveFailed"),
    ).toBeInTheDocument();
    expect(screen.getByText("MultiRouter save failed")).toBeInTheDocument();
    expect(screen.getAllByText("db locked").length).toBeGreaterThan(0);
  });

  it("saves a renamed curated plan without requiring manual subagent selection", async () => {
    const onOpenChange = vi.fn();
    const source = provider({
      id: "relay",
      name: "Relay",
      settingsConfig: {
        base_url: "https://relay.example/v1",
        auth: { OPENAI_API_KEY: "sk-test" },
        modelCatalog: {
          models: [
            { model: "model-a", upstreamModel: "model-a" },
            { model: "model-b", upstreamModel: "model-b" },
            { model: "model-c", upstreamModel: "model-c" },
          ],
        },
      },
    });

    renderWithQueryClient(
      <CodexMultiRouterWizard
        open
        providers={[source]}
        onOpenChange={onOpenChange}
        onCreateProvider={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onEnablePlan={vi.fn()}
      />,
    );

    await completeWizardDeepProbe();

    fireEvent.click(screen.getByRole("button", { name: "Review routing" }));
    fireEvent.change(screen.getByLabelText("MultiRouter name"), {
      target: { value: "Work MultiRouter" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Choose models" }));
    fireEvent.click(screen.getByLabelText("Keep model-b"));
    fireEvent.click(screen.getByRole("button", { name: "Model order" }));
    fireEvent.click(screen.getAllByTitle("Move up")[1]);

    fireEvent.click(screen.getByRole("button", { name: "Save and enable" }));
    fireEvent.click(
      screen.getAllByRole("button", { name: "Save and publish" }).at(-1)!,
    );

    await waitFor(() => {
      expect(commitCodexProviderSetBatch).toHaveBeenCalledTimes(1);
    });
    const savedProvider = vi.mocked(commitCodexProviderSetBatch).mock
      .calls[0][1];
    expect(savedProvider.name).toBe("Work MultiRouter");
    expect(savedProvider.settingsConfig).not.toHaveProperty("modelCatalog");
    expect(savedProvider.settingsConfig.codexRouting.spawnAgentModels).toEqual(
      [],
    );
    expect(
      savedProvider.settingsConfig.codexRouting.routes[0].modelSelection,
    ).toEqual({ mode: "include", models: ["model-c", "model-a"] });
  });

  it("confirms and probes both Chat and Responses connectivity before recording pass state", async () => {
    renderWithQueryClient(
      <CodexMultiRouterWizard
        open
        providers={[provider()]}
        onOpenChange={vi.fn()}
        onCreateProvider={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onEnablePlan={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Protocol deep probe" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Start compatibility deep probe" }),
    );
    expect(
      screen.getByText("Confirm compatibility deep probe"),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("dialog").at(-1)).toHaveClass("z-[200]");
    fireEvent.click(screen.getByRole("button", { name: "Confirm test" }));

    expect(
      await screen.findByText("State machine:connectivityPassed"),
    ).toBeInTheDocument();
    expect(preflightCodexProviderProtocolCompatibility).toHaveBeenCalledWith(
      expect.objectContaining({ id: "deepseek" }),
      expect.any(Function),
    );
  });

  it("shows fetched model exceptions in the wizard issue panel", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    vi.mocked(fetchModelsForConfig).mockRejectedValueOnce(
      new Error("upstream /models timeout"),
    );

    renderWithQueryClient(
      <CodexMultiRouterWizard
        open
        providers={[provider()]}
        onOpenChange={vi.fn()}
        onCreateProvider={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onEnablePlan={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Sync model catalogs" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Fetch model lists automatically" }),
    );

    expect(
      await screen.findByText("Model-list fetch failed"),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText(/upstream \/models timeout/).length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Can continue")).toBeInTheDocument();
    consoleError.mockRestore();
  });

  it("shows responses probe command exceptions and blocks continuation", async () => {
    vi.mocked(
      preflightCodexProviderProtocolCompatibility,
    ).mockRejectedValueOnce(new Error("ipc invoke failed"));

    renderWithQueryClient(
      <CodexMultiRouterWizard
        open
        providers={[provider({ meta: { apiFormat: "openai_responses" } })]}
        onOpenChange={vi.fn()}
        onCreateProvider={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onEnablePlan={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Protocol deep probe" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Start compatibility deep probe" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm test" }));

    expect(
      await screen.findByText("Compatibility deep probe interrupted"),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/ipc invoke failed/).length).toBeGreaterThan(0);
    expect(screen.getByText("Resolve before continuing")).toBeInTheDocument();
    expect(
      screen.getByText("State machine:connectivityFailed"),
    ).toBeInTheDocument();
  });

  it("keeps the overlay open after enabling until the user finishes the optional setup", async () => {
    const onOpenChange = vi.fn();
    const onEnablePlan = vi.fn().mockResolvedValue(undefined);

    renderWithQueryClient(
      <CodexMultiRouterWizard
        open
        providers={[provider()]}
        onOpenChange={onOpenChange}
        onCreateProvider={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onEnablePlan={onEnablePlan}
      />,
    );

    await completeWizardDeepProbe();
    fireEvent.click(screen.getByRole("button", { name: "Save and enable" }));
    const publishButtons = screen.getAllByRole("button", {
      name: "Save and publish",
    });
    fireEvent.click(publishButtons[publishButtons.length - 1]);

    expect(
      await screen.findByText(
        /After enabling, continue with independent settings/,
      ),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Enable this multi-route plan" }),
    );

    expect(onEnablePlan).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText("State machine:enabled"),
    ).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    fireEvent.click(screen.getByRole("button", { name: "Accept later" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
