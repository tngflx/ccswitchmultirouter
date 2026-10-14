import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { providersApi } from "@/lib/api";
import { codexSubagentV2Api } from "@/lib/api/codexSubagentV2";
import {
  fetchCodexOfficialFallbackModels,
  fetchCodexOauthModels,
  fetchModelsForConfig,
  refreshCodexOfficialModelCatalog,
  type FetchedModel,
} from "@/lib/api/model-fetch";
import type { CodexRoutingProjectionStatus } from "@/lib/api/providers";
import { proxyApi } from "@/lib/api/proxy";
import { usageApi } from "@/lib/api/usage";
import type {
  CodexCatalogModel,
  CodexRoutingAuthPolicy,
  Provider,
} from "@/types";
import type { ModelStats, PaginatedLogs, RequestLog } from "@/types/usage";
import type { RequestHealthSnapshot } from "@/types/proxy";
import type { CodexModelReasoningResolution } from "@/types/codexSubagentV2";
import {
  applyMultiRouterSettingsDraft,
  buildMultiRouterRuntimeStatus,
  buildCodexProxyBaseUrl,
  buildModelCatalogForRoutes,
  buildRouteTrafficRows,
  collectRoutedCatalogModels,
  CodexRouterWorkspacePage,
  formatCodexCatalogModelLabel,
  recommendCodexCatalogModels,
  sortCodexCatalogModels,
  createRoutePolicyDraft,
  createDraftRoutingPlan,
  dedupeCodexRoutesBySemanticProvider,
  isRoutingPlan,
  mergeRoutePickerDraftIds,
  normalizeCodexRouteForSave,
  normalizeCodexRoutesForVisibleModelAliases,
  providerWithFetchedModelCatalog,
  projectCodexModelCatalog,
  reconcileCodexRoutingPlanForSave,
  readCodexRouting,
  resolveCodexRouterAuthFacadeLabel,
  routeSummaryDisplayName,
  serializeCodexRouteV2,
  validateProxyListenDraft,
  workspaceErrorMessage,
} from "./CodexRouterWorkspacePage";

const requestLogsFixture = vi.hoisted(() => ({
  value: { data: [], isLoading: false } as {
    data: PaginatedLogs | [];
    isLoading: boolean;
  },
}));

vi.mock("@/lib/api/proxy", () => ({
  proxyApi: {
    getGlobalProxyConfig: vi.fn().mockResolvedValue({
      listenAddress: "127.0.0.1",
      listenPort: 15721,
    }),
    diagnoseCodexMultiRouter: vi.fn(),
    unlockCodexModelPicker: vi.fn(),
    getRequestHealthDiagnostics: vi.fn(),
  },
}));

vi.mock("@/lib/query/usage", () => ({
  usageKeys: {
    all: ["usage"],
  },
  useCodexSubagentUsageStats: () => ({
    data: {
      totals: {
        sessions: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
      agents: [],
      modelStats: [],
      providerModels: [],
    },
    isLoading: false,
    error: null,
  }),
  useSessionCollectionStatus: () => ({
    data: {
      revision: 0,
      phase: "not_started",
      imported: 0,
      deferred: 0,
      errorsCount: 0,
      intervalSecs: 60,
    },
    error: null,
  }),
  useRequestLogs: () => requestLogsFixture.value,
}));

vi.mock("@/lib/api/usage", () => ({
  usageApi: {
    syncSessionUsage: vi.fn(),
    getModelStats: vi.fn(),
  },
}));

vi.mock("@/lib/api", () => ({
  providersApi: {
    add: vi.fn(),
    update: vi.fn(),
    getAll: vi.fn(),
    inspectCodexMultiRouterProjection: vi.fn(),
    retryCodexMultiRouterProjection: vi.fn(),
    getCodexMultiRouterRevision: vi.fn(),
    previewCodexMultiRouterMigration: vi.fn(),
    applyCodexMultiRouterMigration: vi.fn(),
  },
}));

vi.mock("@/lib/api/auth", () => ({
  authApi: {
    getCodexAccountPoolPolicy: vi.fn().mockResolvedValue({
      enabled: false,
      entries: [],
    }),
  },
}));

vi.mock("@/lib/api/model-fetch", () => ({
  fetchCodexOfficialFallbackModels: vi.fn(),
  fetchCodexOauthModels: vi.fn(),
  fetchModelsForConfig: vi.fn(),
  refreshCodexOfficialModelCatalog: vi.fn(),
}));

vi.mock("@/lib/api/codexEgressTimezone", () => ({
  codexEgressTimezoneApi: {
    monitorStatus: vi.fn().mockResolvedValue({
      state: "ready",
      detectedTimezone: "Asia/Taipei",
      detectedEgressIp: "2407:cdc0:…",
      detectedAt: 2_000,
      lastAttemptAt: 2_000,
      lastTrigger: "periodic",
      nextCheckAt: 2_900,
      monitorIntervalMinutes: 15,
      restartRequired: false,
    }),
    triggerAutomaticProbe: vi.fn(),
  },
}));

vi.mock("@/lib/api/codexSubagentV2", () => ({
  codexSubagentV2Api: {
    resolveModelReasoningCapability: vi.fn(),
    getReasoningCapabilities: vi.fn().mockResolvedValue({
      "deepseek-v4-flash": {
        supportKind: "effort_levels",
        source: "builtin",
        confidence: "confirmed",
        codexSelectableEfforts: [
          "none",
          "low",
          "medium",
          "high",
          "xhigh",
          "max",
        ],
        providerAcceptedEfforts: ["low", "high", "max"],
        providerDefaultEffort: "high",
        disableAllowed: true,
        effortMap: {
          low: "low",
          medium: "high",
          high: "high",
          xhigh: "high",
          max: "max",
        },
      },
    }),
    previewProfile: vi.fn().mockResolvedValue({
      providerKind: "third_party",
      requestedRoleName: "deepseek-v4-flash",
      effectiveRoleName: "deepseek-v4-flash",
      description: "Flash profile",
      developerInstructions: "Read only",
      nicknameCandidates: ["Flash"],
      model: "deepseek-v4-flash",
      modelProvider: "codex_model_router_v2",
      modelReasoningEffort: "medium",
      reasoningPolicy: "fixed",
      reasoningCapability: {
        supportKind: "effort_levels",
        source: "builtin",
        confidence: "confirmed",
        codexSelectableEfforts: [
          "none",
          "low",
          "medium",
          "high",
          "xhigh",
          "max",
        ],
        providerAcceptedEfforts: ["low", "high", "max"],
        providerDefaultEffort: "high",
        disableAllowed: true,
        effortMap: {
          low: "low",
          medium: "high",
          high: "high",
          xhigh: "high",
          max: "max",
        },
      },
      modelContextWindow: 128000,
      tomlPreview: 'model = "deepseek-v4-flash"',
      warnings: [],
    }),
    getProfileStatuses: vi.fn().mockResolvedValue({
      mode: "v2",
      generationSource: "configured_profiles",
      profiles: [
        {
          profileKey: "deepseek-v4-flash",
          model: "deepseek-v4-flash",
          providerKind: "third_party",
          enabled: true,
          routable: true,
          requestedRoleName: "deepseek-v4-flash",
          effectiveRoleName: "deepseek-v4-flash",
          modelProvider: "codex_model_router_v2",
          modelReasoningEffort: "medium",
          status: "generated",
          warnings: [],
        },
      ],
      warnings: [],
    }),
    updateProviderConfig: vi.fn(),
    initializeProviderConfig: vi.fn(),
    reconcileProviderProfiles: vi.fn(),
  },
}));

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

/// 创建可手动完成的 Promise，用来稳定复现多个 provider 并发刷新时的返回顺序。
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function modelReasoningResolution(
  model: string,
  efforts: Array<"none" | "low" | "medium" | "high" | "xhigh"> = [],
  defaultEffort: "low" | "medium" | "high" | "xhigh" = "medium",
): CodexModelReasoningResolution {
  return {
    model,
    source: efforts.length ? "official" : "unknown",
    fingerprint: efforts.length ? `official-${model}` : "",
    capability: null,
    resolved: {
      supportKind: efforts.length ? "effort_levels" : "unknown",
      confidence: efforts.length ? "confirmed" : "unverified",
      codexSelectableEfforts: efforts,
      providerAcceptedEfforts: efforts,
      providerDefaultEffort: efforts.length ? defaultEffort : null,
      disableAllowed: efforts.includes("none"),
      effortMap: {},
    },
    hasDetectionCandidate: false,
    detection: null,
  };
}

/// 为刷新类测试补齐真实的启用 route，避免把 provider 存在误当成已在当前方案中勾选。
function withEnabledProviderRoute(
  plan: Provider,
  provider: Provider,
): Provider {
  const models = provider.settingsConfig?.modelCatalog?.models ?? [];
  const route = normalizeCodexRouteForSave(
    {
      label: provider.name,
      enabled: true,
      targetProviderId: provider.id,
      modelSelection: { mode: "all" },
      match: {
        models: models.map((model: { model: string }) => model.model),
        prefixes: [],
      },
      upstream: { auth: { source: "provider_config" } },
    },
    0,
    new Set<string>(),
  );
  return {
    ...plan,
    settingsConfig: {
      ...plan.settingsConfig,
      codexRouting: {
        schemaVersion: 2,
        enabled: true,
        defaultRouteId: route.id,
        spawnAgentModels: models
          .map((model: { model: string }) => model.model)
          .slice(0, 5),
        routes: [serializeCodexRouteV2(route, 0)],
      },
    },
  };
}

function renderWorkspace(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    React.createElement(QueryClientProvider, { client: queryClient }, ui),
  );
}

/// 构造状态页所需的最小代理日志；测试只关心 Codex 最近一次真实转发是否成功。
function createCodexProxyLog(overrides: Partial<RequestLog> = {}): RequestLog {
  return {
    requestId: "req-1",
    providerId: "codex-router",
    providerName: "Codex MultiRouter",
    appType: "codex",
    model: "gpt-5.4-mini",
    requestModel: "gpt-5.4-mini",
    costMultiplier: "1",
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    inputCostUsd: "0",
    outputCostUsd: "0",
    cacheReadCostUsd: "0",
    cacheCreationCostUsd: "0",
    totalCostUsd: "0",
    isStreaming: false,
    latencyMs: 100,
    statusCode: 200,
    createdAt: Date.now(),
    dataSource: "proxy",
    ...overrides,
  };
}

beforeEach(() => {
  requestLogsFixture.value = { data: [], isLoading: false };
  vi.mocked(usageApi.getModelStats).mockReset().mockResolvedValue([]);
  vi.mocked(usageApi.syncSessionUsage).mockReset().mockResolvedValue({
    imported: 0,
    skipped: 0,
    filesScanned: 0,
    suspectedDuplicates: 0,
    deferredFiles: 0,
    errors: [],
  });
  vi.mocked(codexSubagentV2Api.resolveModelReasoningCapability).mockReset();
  vi.mocked(
    codexSubagentV2Api.resolveModelReasoningCapability,
  ).mockImplementation(async (_settings, _provider, model) =>
    modelReasoningResolution(model),
  );
  vi.mocked(fetchCodexOfficialFallbackModels).mockReset();
  vi.mocked(fetchCodexOauthModels).mockReset();
  vi.mocked(fetchModelsForConfig).mockReset();
  vi.mocked(proxyApi.unlockCodexModelPicker).mockReset();
  vi.mocked(proxyApi.getRequestHealthDiagnostics).mockReset();
  vi.mocked(proxyApi.getRequestHealthDiagnostics).mockResolvedValue({
    config: {
      enabled: true,
      optimizationMode: "diagnose",
      largeRequestThresholdBytes: 512 * 1024,
      maxCodexInputTokens: 200_000,
      reviewTimeoutSeconds: 60,
      reviewMode: "first_large_request",
      summarizeAndRestartEnabled: false,
      windowsNotificationsEnabled: true,
      windowsNotificationSnoozeHours: 24,
      windowsNotificationsSnoozedUntilMs: null,
    },
    diagnostics: [],
  } satisfies RequestHealthSnapshot);
  vi.mocked(providersApi.add).mockResolvedValue(true);
  vi.mocked(providersApi.update).mockResolvedValue(true);
  vi.mocked(providersApi.getAll).mockResolvedValue({});
  vi.mocked(providersApi.inspectCodexMultiRouterProjection).mockResolvedValue({
    schemaVersion: 1,
    routerProviderId: "codex-multirouter",
    state: "ready",
    dependencyFingerprint: "test-fingerprint",
    generatedAt: "2026-08-21T00:00:00Z",
    warnings: [],
    routes: [],
    lastErrorCode: null,
    lastError: null,
  } satisfies CodexRoutingProjectionStatus);
  vi.mocked(providersApi.retryCodexMultiRouterProjection).mockResolvedValue({
    schemaVersion: 1,
    routerProviderId: "codex-multirouter",
    state: "ready",
    dependencyFingerprint: "test-fingerprint",
    generatedAt: "2026-08-21T00:00:00Z",
    warnings: [],
    routes: [],
    lastErrorCode: null,
    lastError: null,
  } satisfies CodexRoutingProjectionStatus);
  vi.mocked(providersApi.getCodexMultiRouterRevision).mockReset();
  vi.mocked(providersApi.previewCodexMultiRouterMigration).mockReset();
  vi.mocked(providersApi.applyCodexMultiRouterMigration).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Model order real drag sensors", () => {
  let restoreGeometry: () => void;

  beforeEach(() => {
    // jsdom has neither PointerEvent fields nor layout. Supply only those browser
    // primitives; keep dnd-kit, its sensors, collision detection and handlers real.
    if (typeof window.PointerEvent === "undefined") {
      class TestPointerEvent extends MouseEvent {
        readonly isPrimary: boolean;
        readonly pointerId: number;
        readonly pointerType: string;

        constructor(type: string, init: PointerEventInit = {}) {
          super(type, init);
          this.isPrimary = init.isPrimary ?? true;
          this.pointerId = init.pointerId ?? 1;
          this.pointerType = init.pointerType ?? "mouse";
        }
      }
      vi.stubGlobal("PointerEvent", TestPointerEvent);
    }
    const actualRect = HTMLElement.prototype.getBoundingClientRect;
    const geometry = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const selector = 'button[aria-label^="Drag order-"]';
        const handle = this.matches(selector)
          ? this
          : Array.from(this.children).find((child) => child.matches(selector));
        if (!(handle instanceof HTMLElement)) return actualRect.call(this);
        const handles = Array.from(document.querySelectorAll(selector));
        const index = handles.indexOf(handle);
        if (index < 0) return actualRect.call(this);
        const translation = handle.parentElement?.style.transform.match(
          /translate3d\(([-\d.]+)px,\s*([-\d.]+)px,/,
        );
        const x =
          (index < 8 ? 100 : 650) +
          (this === handle ? 10 : 0) +
          Number(translation?.[1] ?? 0);
        const y =
          100 +
          (index < 8 ? index : index - 8) * 60 +
          (this === handle ? 10 : 0) +
          Number(translation?.[2] ?? 0);
        const width = this === handle ? 24 : 400;
        const height = this === handle ? 24 : 44;
        return {
          x,
          y,
          top: y,
          left: x,
          right: x + width,
          bottom: y + height,
          width,
          height,
          toJSON: () => ({ x, y, width, height }),
        };
      });
    restoreGeometry = () => geometry.mockRestore();
  });

  afterEach(() => {
    restoreGeometry();
    vi.unstubAllGlobals();
  });

  function modelOrder() {
    return screen
      .getAllByRole("button", { name: /^Drag / })
      .map((handle) => handle.getAttribute("aria-label")?.slice(5));
  }

  function renderModelOrder(
    options: {
      models?: CodexCatalogModel[];
      routing?: Record<string, unknown>;
      config?: string;
    } = {},
  ) {
    const source: Provider = {
      id: "drag-source",
      name: "Drag Source",
      category: "custom",
      settingsConfig: {
        auth: { OPENAI_API_KEY: "test-only-credential" },
        modelCatalog: {
          spawnAgentModels: ["order-c", "order-a"],
          models: options.models ?? [
            {
              model: "order-a",
              upstreamModel: "wire-a",
              displayName: "First model",
              sortIndex: 0,
              contextWindow: 128000,
              supportsImage: true,
            },
            { model: "order-b", sortIndex: 1, contextWindow: 64000 },
            { model: "order-c", sortIndex: 2, supportsImage: false },
          ],
        },
      },
    };
    const enabledPlan = withEnabledProviderRoute(
      createDraftRoutingPlan([source], [source]),
      source,
    );
    const plan: Provider = {
      ...enabledPlan,
      settingsConfig: {
        ...enabledPlan.settingsConfig,
        ...(options.config ? { config: options.config } : {}),
        codexRouting: {
          ...enabledPlan.settingsConfig.codexRouting,
          spawnAgentModels: ["order-c", "order-a", "order-b"],
          routes: enabledPlan.settingsConfig.codexRouting.routes.map(
            (route: Record<string, unknown>) => ({
              ...route,
              aliases: source.settingsConfig.modelCatalog.models.some(
                (model: CodexCatalogModel) => model.upstreamModel === "wire-a",
              )
                ? { "order-a": "wire-a" }
                : {},
            }),
          ),
          ...options.routing,
        },
      },
    };
    const snapshot = JSON.stringify({ source, plan });
    const elementFor = (providers: Provider[]) =>
      React.createElement(CodexRouterWorkspacePage, {
        providers,
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "model-order" as const,
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      });
    return {
      source,
      plan,
      snapshot,
      elementFor,
      rendered: renderWorkspace(elementFor([source, plan])),
    };
  }

  it("top-aligns all model-order controls independently of the wrapped effort hint", () => {
    renderModelOrder({
      models: [
        {
          model: "gpt-6.1-sol-sublyx-with-a-long-provider-alias",
          reasoning: {
            ...reasoning(["low", "high"], "low"),
            supportedEfforts: ["medium", "high", "xhigh"],
            defaultEffort: "medium",
          },
        },
      ],
      routing: { defaultReasoningEffort: "xhigh" },
    });
    const display = screen.getByRole("combobox", { name: "Model display" });
    const sort = screen.getByRole("combobox", { name: "Sort models" });
    const effort = screen.getByRole("combobox", {
      name: "Top model default effort",
    });
    const controls = display.closest("label")!.parentElement;
    expect(controls).toHaveClass("items-start", "flex-wrap");
    expect(controls).not.toHaveClass("items-end");
    for (const select of [display, sort, effort]) {
      expect(select.closest("label")?.parentElement).toBe(controls);
      expect(select).toHaveClass("h-8", "min-w-0");
    }
    expect(effort.closest("label")).toHaveClass("w-64", "max-w-full");
    expect(screen.getByText(/Used by new threads when/)).toHaveClass(
      "break-words",
    );
    expect(effort).toHaveValue("xhigh");
  });

  async function pointerMoveFirstToSecond() {
    const handle = await screen.findByRole("button", {
      name: "Drag order-a",
    });
    const start = handle.getBoundingClientRect();
    fireEvent.pointerDown(handle, {
      button: 0,
      isPrimary: true,
      pointerId: 1,
      clientX: start.x + 12,
      clientY: start.y + 12,
    });
    await waitFor(() => expect(handle).toHaveAttribute("aria-pressed", "true"));
    fireEvent.pointerMove(document, {
      pointerId: 1,
      clientX: start.x + 12,
      clientY: start.y + 72,
    });
    await screen.findByText(
      "Draggable item order-a was moved over droppable area order-b.",
    );
    return handle;
  }

  it("reorders by pointer, saves only router preferences and reloads the saved order", async () => {
    const { source, plan, snapshot, elementFor, rendered } = renderModelOrder();
    const handle = await pointerMoveFirstToSecond();
    expect(modelOrder()).toEqual(["order-a", "order-b", "order-c"]);
    expect(providersApi.update).not.toHaveBeenCalled();

    fireEvent.pointerUp(document, { pointerId: 1 });
    await waitFor(() => {
      expect(handle).not.toHaveAttribute("aria-pressed");
      expect(modelOrder()).toEqual(["order-b", "order-a", "order-c"]);
    });
    expect(providersApi.update).not.toHaveBeenCalled();
    // PointerSensor briefly suppresses clicks after release to avoid accidental
    // row actions. A normal later Save click must still use the owning IPC.
    await userEvent
      .setup({ delay: 55 })
      .click(screen.getByRole("button", { name: "Save order" }));
    await waitFor(() => {
      expect(providersApi.update).toHaveBeenCalledTimes(1);
      expect(providersApi.update).toHaveBeenCalledWith(
        expect.objectContaining({
          id: plan.id,
          settingsConfig: expect.objectContaining({
            codexRouting: {
              ...plan.settingsConfig.codexRouting,
              modelOrder: ["order-b", "order-a", "order-c"],
              modelDisplayStyle: "provider-model",
            },
          }),
        }),
        "codex",
      );
    });
    const expected = vi.mocked(providersApi.update).mock.calls[0][0];
    expect(expected.settingsConfig.config).toMatch(/^model = "order-b"/m);
    expect(expected.settingsConfig.modelCatalog).toBeUndefined();
    expect(JSON.stringify({ source, plan })).toBe(snapshot);
    expect(
      screen.getByText(/Saved the display order for 3 models/),
    ).toBeInTheDocument();
    vi.mocked(providersApi.getAll).mockResolvedValue({
      [source.id]: source,
      [plan.id]: expected,
    });
    const reloaded = await providersApi.getAll("codex");
    rendered.unmount();
    renderWorkspace(elementFor(Object.values(reloaded)));
    await waitFor(() =>
      expect(modelOrder()).toEqual(["order-b", "order-a", "order-c"]),
    );
    expect(screen.getByRole("button", { name: "Save order" })).toBeDisabled();
    expect(providersApi.update).toHaveBeenCalledTimes(1);
  });

  it("reorders through the real keyboard sensor without saving until requested", async () => {
    renderModelOrder();
    const user = userEvent.setup();
    const handle = await screen.findByRole("button", {
      name: "Drag order-a",
    });
    handle.focus();
    await user.keyboard("[Space]");
    await waitFor(() => expect(handle).toHaveAttribute("aria-pressed", "true"));
    await user.keyboard("[ArrowDown]");
    await screen.findByText(
      "Draggable item order-a was moved over droppable area order-b.",
    );
    await user.keyboard("[Space]");
    await waitFor(() =>
      expect(modelOrder()).toEqual(["order-b", "order-a", "order-c"]),
    );
    expect(providersApi.update).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save order" })).toBeEnabled();
  });

  it("reconciles stale route references when saving model order after catalog changes", async () => {
    const { source, plan } = renderModelOrder({
      models: [{ model: "order-a" }, { model: "order-b" }],
      routing: {
        routes: [
          {
            id: "stale-selection",
            targetProviderId: "drag-source",
            enabled: true,
            modelSelection: {
              mode: "include",
              models: ["order-a", "removed", "hidden"],
            },
            aliases: { fast: "order-a", stale: "removed" },
            authPolicy: { source: "provider_config" },
          },
        ],
        spawnAgentModels: ["order-a", "removed"],
      },
    });
    const sourceSnapshot = JSON.stringify(source);
    const user = userEvent.setup();
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Model display" }),
      "model",
    );
    await user.click(screen.getByRole("button", { name: "Save order" }));

    await waitFor(() => expect(providersApi.update).toHaveBeenCalledOnce());
    const saved = vi.mocked(providersApi.update).mock.calls[0][0];
    expect(saved.id).toBe(plan.id);
    expect(saved.settingsConfig.codexRouting.routes[0].modelSelection).toEqual({
      mode: "include",
      models: ["order-a"],
    });
    expect(saved.settingsConfig.codexRouting.routes[0].aliases).toEqual({
      fast: "order-a",
    });
    expect(saved.settingsConfig.codexRouting.spawnAgentModels).toEqual([
      "fast",
    ]);
    expect(
      projectCodexModelCatalog(
        saved,
        new Map([[source.id, source]]),
      ).models.map((model) => model.model),
    ).toEqual(["fast"]);
    expect(JSON.stringify(source)).toBe(sourceSnapshot);
  });

  it.each(["pointer", "keyboard"] as const)(
    "cancels an active %s drag without changing the draft or source",
    async (sensor) => {
      const { source, plan, snapshot } = renderModelOrder();
      const user = userEvent.setup();
      let handle: HTMLElement;
      if (sensor === "pointer") {
        handle = await pointerMoveFirstToSecond();
        fireEvent.pointerCancel(document, { pointerId: 1 });
      } else {
        handle = await screen.findByRole("button", {
          name: "Drag order-a",
        });
        handle.focus();
        await user.keyboard("[Space][ArrowDown]");
        await screen.findByText(
          "Draggable item order-a was moved over droppable area order-b.",
        );
        await user.keyboard("[Escape]");
      }
      await waitFor(() => {
        expect(handle).not.toHaveAttribute("aria-pressed");
        expect(modelOrder()).toEqual(["order-a", "order-b", "order-c"]);
      });
      expect(providersApi.update).not.toHaveBeenCalled();
      expect(JSON.stringify({ source, plan })).toBe(snapshot);
      expect(screen.getByRole("button", { name: "Save order" })).toBeDisabled();
    },
  );

  it.each(["pointer", "keyboard"] as const)(
    "keeps Save disabled after a same-position %s drop",
    async (sensor) => {
      renderModelOrder();
      const handle = await screen.findByRole("button", {
        name: "Drag order-a",
      });
      const user = userEvent.setup();
      if (sensor === "pointer") {
        const rect = handle.getBoundingClientRect();
        fireEvent.pointerDown(handle, {
          button: 0,
          isPrimary: true,
          pointerId: 1,
          clientX: rect.x + 12,
          clientY: rect.y + 12,
        });
      } else {
        handle.focus();
        await user.keyboard("[Space]");
      }
      await waitFor(() =>
        expect(handle).toHaveAttribute("aria-pressed", "true"),
      );
      if (sensor === "pointer") {
        fireEvent.pointerUp(document, { pointerId: 1 });
      } else {
        await user.keyboard("[Space]");
      }
      await waitFor(() => expect(handle).not.toHaveAttribute("aria-pressed"));
      expect(modelOrder()).toEqual(["order-a", "order-b", "order-c"]);
      expect(providersApi.update).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Save order" })).toBeDisabled();
    },
  );

  it("retains a pointer-reordered draft after Save fails and retries the same order", async () => {
    const { source, plan, snapshot } = renderModelOrder();
    vi.mocked(providersApi.update).mockRejectedValueOnce(
      new Error("test_source_save_rejected"),
    );
    await pointerMoveFirstToSecond();
    fireEvent.pointerUp(document, { pointerId: 1 });
    await waitFor(() =>
      expect(modelOrder()).toEqual(["order-b", "order-a", "order-c"]),
    );
    const user = userEvent.setup({ delay: 55 });
    await user.click(screen.getByRole("button", { name: "Save order" }));
    expect(
      await screen.findByText(
        "Failed to save model order:Operation failed. See the logs for details (error code: test_source_save_rejected).",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Saved the display order/),
    ).not.toBeInTheDocument();
    expect(modelOrder()).toEqual(["order-b", "order-a", "order-c"]);
    expect(screen.getByRole("button", { name: "Save order" })).toBeEnabled();
    expect(providersApi.update).toHaveBeenCalledTimes(1);
    const failedAttempt = vi.mocked(providersApi.update).mock.calls[0];
    await user.click(screen.getByRole("button", { name: "Save order" }));
    await screen.findByText(/Saved the display order for 3 models/);
    expect(providersApi.update).toHaveBeenCalledTimes(2);
    expect(vi.mocked(providersApi.update).mock.calls[1]).toEqual(failedAttempt);
    expect(JSON.stringify({ source, plan })).toBe(snapshot);
    expect(
      screen.queryByText(/Failed to save model order/),
    ).not.toBeInTheDocument();
  });

  it("moves the last model to the first position through repeated keyboard moves", async () => {
    renderModelOrder();
    const user = userEvent.setup();
    const handle = await screen.findByRole("button", {
      name: "Drag order-c",
    });
    handle.focus();
    await user.keyboard("[Space][ArrowUp]");
    await screen.findByText(
      "Draggable item order-c was moved over droppable area order-b.",
    );
    await user.keyboard("[ArrowUp]");
    await screen.findByText(
      "Draggable item order-c was moved over droppable area order-a.",
    );
    await user.keyboard("[Space]");
    await waitFor(() =>
      expect(modelOrder()).toEqual(["order-c", "order-a", "order-b"]),
    );
    expect(providersApi.update).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save order" })).toBeEnabled();
  });

  const tenModels = () =>
    "abcdefghij".split("").map((suffix) => ({
      model: `order-${suffix}`,
    }));

  it.each(["pointer", "keyboard"] as const)(
    "moves an available model into the ranked column through the real %s sensor",
    async (sensor) => {
      renderModelOrder({ models: tenModels() });
      expect(
        within(
          screen.getByRole("region", { name: "Ranked models" }),
        ).getAllByRole("button", { name: /^Drag / }),
      ).toHaveLength(8);
      expect(
        within(
          screen.getByRole("region", { name: "Available models" }),
        ).getAllByRole("button", { name: /^Drag / }),
      ).toHaveLength(2);
      const handle = screen.getByRole("button", { name: "Drag order-i" });
      if (sensor === "pointer") {
        const from = handle.getBoundingClientRect();
        const to = screen
          .getByRole("button", { name: "Drag order-a" })
          .getBoundingClientRect();
        fireEvent.pointerDown(handle, {
          button: 0,
          isPrimary: true,
          pointerId: 1,
          clientX: from.x + 12,
          clientY: from.y + 12,
        });
        await waitFor(() =>
          expect(handle).toHaveAttribute("aria-pressed", "true"),
        );
        fireEvent.pointerMove(document, {
          pointerId: 1,
          clientX: to.x + 12,
          clientY: to.y + 12,
        });
        await screen.findByText(
          "Draggable item order-i was moved over droppable area order-a.",
        );
        fireEvent.pointerUp(document, { pointerId: 1 });
      } else {
        handle.focus();
        const user = userEvent.setup();
        await user.keyboard("[Space][ArrowLeft]");
        await screen.findByText(
          "Draggable item order-i was moved over droppable area order-a.",
        );
        await user.keyboard("[Space]");
      }
      await waitFor(() =>
        expect(modelOrder()).toEqual([
          "order-i",
          ...tenModels()
            .map((model) => model.model)
            .filter((id) => id !== "order-i"),
        ]),
      );
      expect(
        within(screen.getByRole("region", { name: "Available models" }))
          .getAllByRole("button", { name: /^Drag / })
          .map((button) => button.getAttribute("aria-label")),
      ).toEqual(["Drag order-h", "Drag order-j"]);
      expect(providersApi.update).not.toHaveBeenCalled();
    },
  );

  it("keeps ranks global under search and supports exact ranks and favorite without writing sources", async () => {
    const { source, plan, snapshot } = renderModelOrder({
      models: tenModels(),
    });
    const user = userEvent.setup();
    await user.type(
      screen.getByRole("textbox", { name: "Search models or providers" }),
      "order-j",
    );
    expect(
      screen.getByText("1 results. Rank numbers remain global."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("spinbutton", { name: "Rank for order-j" }),
    ).toHaveValue(10);
    fireEvent.change(
      screen.getByRole("spinbutton", { name: "Rank for order-j" }),
      { target: { value: "3" } },
    );
    await user.click(
      screen.getByRole("button", { name: "Move order-j to rank 3" }),
    );
    expect(
      screen.getByRole("spinbutton", { name: "Rank for order-j" }),
    ).toHaveValue(3);
    await user.click(
      screen.getByRole("button", { name: "Make order-j the favorite model" }),
    );
    expect(
      screen.getByRole("spinbutton", { name: "Rank for order-j" }),
    ).toHaveValue(1);
    expect(
      screen.getByRole("button", { name: "Make order-j the favorite model" }),
    ).toBeDisabled();
    await user.clear(
      screen.getByRole("textbox", { name: "Search models or providers" }),
    );
    expect(modelOrder()).toEqual([
      "order-j",
      ..."abcdefghi".split("").map((suffix) => `order-${suffix}`),
    ]);
    expect(providersApi.update).not.toHaveBeenCalled();
    expect(JSON.stringify({ source, plan })).toBe(snapshot);
  });

  it("switches an alphabetical sort to custom when a model is moved manually", async () => {
    renderModelOrder({
      models: [
        { model: "order-c" },
        { model: "order-a" },
        { model: "order-b" },
      ],
    });
    const user = userEvent.setup();
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Sort models" }),
      "model",
    );
    expect(modelOrder()).toEqual(["order-a", "order-b", "order-c"]);
    await pointerMoveFirstToSecond();
    fireEvent.pointerUp(document, { pointerId: 1 });
    await waitFor(() =>
      expect(modelOrder()).toEqual(["order-b", "order-a", "order-c"]),
    );
    expect(screen.getByRole("combobox", { name: "Sort models" })).toHaveValue(
      "custom",
    );
  });

  it("saves display-only preferences without changing default model, effort, routes or source catalogs", async () => {
    const routing = {
      modelOrder: ["order-c", "order-a", "order-b"],
      defaultReasoningEffort: "high",
      officialAuth: { mode: "managed", accountId: "test-account" },
      customExtension: { keep: true },
    };
    const { source, plan, snapshot } = renderModelOrder({
      routing,
      config: 'model = "order-a"\nmodel_reasoning_effort = "low"\n',
    });
    const user = userEvent.setup();
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Model display" }),
      "model",
    );
    await user.click(screen.getByRole("button", { name: "Save order" }));
    await screen.findByText(/Saved the display order for 3 models/);
    const saved = vi.mocked(providersApi.update).mock.calls[0][0];
    expect(saved.id).toBe(plan.id);
    expect(saved.settingsConfig.config).toBe(plan.settingsConfig.config);
    expect(saved.settingsConfig.codexRouting).toEqual({
      ...plan.settingsConfig.codexRouting,
      modelDisplayStyle: "model",
    });
    expect(saved.settingsConfig.modelCatalog).toBeUndefined();
    expect(JSON.stringify({ source, plan })).toBe(snapshot);
    expect(providersApi.update).toHaveBeenCalledTimes(1);
  });

  const reasoning = (
    efforts: Array<"low" | "high">,
    defaultEffort: "low" | "high",
  ) => ({
    schemaVersion: 2 as const,
    supportStatus: "confirmed_supported" as const,
    controlKind: "graded" as const,
    supportedEfforts: efforts,
    defaultEffort,
    disableAllowed: false,
    upstream: {
      format: "string" as const,
      parameter: "reasoning_effort" as const,
    },
  });

  const modelUsage = (
    model: string,
    requestCount: number,
    providerName = "Drag Source",
  ): ModelStats => ({
    model,
    providerName,
    requestCount,
    totalTokens: requestCount * 100,
    totalCost: "0",
    avgCostPerRequest: "0",
  });

  it("syncs Codex history before querying usage and ranks all models by request count", async () => {
    const sync =
      createDeferred<Awaited<ReturnType<typeof usageApi.syncSessionUsage>>>();
    vi.mocked(usageApi.syncSessionUsage).mockReturnValueOnce(sync.promise);
    const stats = tenModels().map((model, index) =>
      modelUsage(model.model, index + 1),
    );
    vi.mocked(usageApi.getModelStats).mockResolvedValue(stats);
    const { source, plan, snapshot, elementFor, rendered } = renderModelOrder({
      models: tenModels(),
    });
    const user = userEvent.setup();
    expect(usageApi.getModelStats).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "Apply recommendations" }),
    );
    expect(
      screen.getByRole("button", { name: "Querying usage..." }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save order" })).toBeDisabled();
    expect(usageApi.getModelStats).not.toHaveBeenCalled();
    await act(async () =>
      sync.resolve({
        imported: 10,
        skipped: 0,
        filesScanned: 1,
        suspectedDuplicates: 0,
        deferredFiles: 0,
        errors: [],
      }),
    );
    await screen.findByText(/usage history for 10 models/);
    expect(usageApi.getModelStats).toHaveBeenCalledWith(
      undefined,
      undefined,
      "codex",
    );
    expect(usageApi.getModelStats).toHaveBeenCalledWith();
    expect(usageApi.getModelStats).toHaveBeenCalledTimes(2);
    const expectedOrder = "jihgfedcba"
      .split("")
      .map((suffix) => `order-${suffix}`);
    expect(modelOrder()).toEqual(expectedOrder);
    expect(providersApi.update).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Save order" }));
    await screen.findByText(/Saved the display order for 10 models/);
    const saved = vi.mocked(providersApi.update).mock.calls[0][0];
    expect(saved.settingsConfig.codexRouting.modelOrder).toEqual(expectedOrder);
    expect(JSON.stringify({ source, plan })).toBe(snapshot);
    rendered.unmount();
    renderWorkspace(elementFor([source, saved]));
    expect(modelOrder()).toEqual(expectedOrder);
  });

  it("uses provider model history when Codex has no matching usage and re-queries on every click", async () => {
    vi.mocked(usageApi.getModelStats).mockImplementation(
      async (_start, _end, app) =>
        app === "codex"
          ? []
          : [
              modelUsage("order-c", 30),
              { ...modelUsage("order-b", 5), totalCost: "100" },
            ],
    );
    renderModelOrder();
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Apply recommendations" }),
    );
    await screen.findByText(/usage history for 2 models/);
    expect(modelOrder()).toEqual(["order-c", "order-b", "order-a"]);
    vi.mocked(usageApi.getModelStats).mockImplementation(
      async (_start, _end, app) =>
        app === "codex" ? [] : [modelUsage("wire-a", 100)],
    );
    await user.click(
      screen.getByRole("button", { name: "Apply recommendations" }),
    );
    await screen.findByText(/usage history for 1 models/);
    expect(modelOrder()[0]).toBe("order-a");
    expect(usageApi.syncSessionUsage).toHaveBeenCalledTimes(2);
    expect(usageApi.getModelStats).toHaveBeenCalledTimes(4);
    expect(providersApi.update).not.toHaveBeenCalled();
  });

  it("does not change the order or save when both usage queries fail", async () => {
    vi.mocked(usageApi.getModelStats).mockRejectedValue(
      new Error("usage database unavailable"),
    );
    renderModelOrder();
    await userEvent.click(
      screen.getByRole("button", { name: "Apply recommendations" }),
    );
    await screen.findByText(
      /Could not read usage history\. Model order was not changed:/,
    );
    expect(modelOrder()).toEqual(["order-a", "order-b", "order-c"]);
    expect(providersApi.update).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Apply recommendations" }),
    ).toBeEnabled();
  });

  it("uses available provider records and reports incomplete sync or Codex queries", async () => {
    vi.mocked(usageApi.syncSessionUsage).mockRejectedValue(
      new Error("sync unavailable"),
    );
    vi.mocked(usageApi.getModelStats).mockImplementation(
      async (_start, _end, app) => {
        if (app === "codex") throw new Error("Codex usage unavailable");
        return [modelUsage("order-c", 40)];
      },
    );
    renderModelOrder();
    await userEvent.click(
      screen.getByRole("button", { name: "Apply recommendations" }),
    );
    await screen.findByText(/Some usage could not be refreshed/);
    expect(modelOrder()[0]).toBe("order-c");
    expect(screen.getByRole("button", { name: "Save order" })).toBeEnabled();
    expect(providersApi.update).not.toHaveBeenCalled();
  });

  it("ignores a recommendation response after leaving the ordering page", async () => {
    const history = createDeferred<ModelStats[]>();
    vi.mocked(usageApi.getModelStats).mockReturnValue(history.promise);
    const { rendered } = renderModelOrder();
    await userEvent.click(
      screen.getByRole("button", { name: "Apply recommendations" }),
    );
    await waitFor(() =>
      expect(usageApi.getModelStats).toHaveBeenCalledTimes(2),
    );
    rendered.unmount();
    renderModelOrder({
      models: [{ model: "order-new" }, { model: "order-other" }],
    });
    await act(async () => history.resolve([modelUsage("order-c", 100)]));
    expect(modelOrder()).toEqual(["order-new", "order-other"]);
    expect(
      screen.queryByText(/Recommendations applied from usage/),
    ).not.toBeInTheDocument();
    expect(providersApi.update).not.toHaveBeenCalled();
  });

  it("restores latest-first defaults without a saved custom order and projects the saved ranks", async () => {
    const models = [
      { model: "gpt-5.6-luna-sublyx", upstreamModel: "gpt-5.6-luna" },
      { model: "gpt-6-astra-sublyx", upstreamModel: "gpt-6-astra" },
      { model: "gpt-6.1-sol-sublyx", upstreamModel: "gpt-6.1-sol" },
    ];
    const { source, plan, snapshot, elementFor, rendered } = renderModelOrder({
      models,
      config: 'model = "gpt-5.6-luna-sublyx"\n',
    });
    expect(
      screen.getByRole("button", { name: "Restore default" }),
    ).toBeEnabled();
    await userEvent.click(
      screen.getByRole("button", { name: "Restore default" }),
    );
    await screen.findByText(/Restored newest-first model order/);
    const saved = vi.mocked(providersApi.update).mock.calls[0][0];
    const expected = [
      "gpt-6.1-sol-sublyx",
      "gpt-6-astra-sublyx",
      "gpt-5.6-luna-sublyx",
    ];
    expect(saved.settingsConfig.codexRouting.modelOrder).toEqual(expected);
    expect(saved.settingsConfig.config).toBe('model = "gpt-6.1-sol-sublyx"\n');
    expect(saved.settingsConfig.codexRouting.routes).toEqual(
      plan.settingsConfig.codexRouting.routes,
    );
    expect(providersApi.inspectCodexMultiRouterProjection).toHaveBeenCalledWith(
      plan.id,
    );
    expect(JSON.stringify({ source, plan })).toBe(snapshot);
    rendered.unmount();
    renderWorkspace(elementFor([source, saved]));
    expect(
      screen
        .getAllByRole("button", { name: /^Drag / })
        .map((button) => button.getAttribute("aria-label")?.slice(5)),
    ).toEqual(expected);
    expect(
      screen.getByRole("button", { name: "Restore default" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save order" })).toBeDisabled();
  });

  it("keeps Extra high when resetting the remaining order leaves Sol first", async () => {
    vi.mocked(
      codexSubagentV2Api.resolveModelReasoningCapability,
    ).mockImplementation(async (_settings, _provider, model) =>
      modelReasoningResolution(model, ["medium", "high", "xhigh"]),
    );
    renderModelOrder({
      models: [
        { model: "gpt-5.6-luna-sublyx", upstreamModel: "gpt-5.6-luna" },
        { model: "gpt-6-astra-sublyx", upstreamModel: "gpt-6-astra" },
        { model: "gpt-6.1-sol-sublyx", upstreamModel: "gpt-6.1-sol" },
      ],
      routing: {
        modelOrder: [
          "gpt-6.1-sol-sublyx",
          "gpt-5.6-luna-sublyx",
          "gpt-6-astra-sublyx",
        ],
        defaultReasoningEffort: "xhigh",
      },
    });
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", {
          name: "Top model default effort",
        }),
      ).toHaveValue("xhigh"),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Restore default" }),
    );
    await screen.findByText(/Restored newest-first model order/);
    const saved = vi.mocked(providersApi.update).mock.calls[0][0];
    expect(saved.settingsConfig.codexRouting.defaultReasoningEffort).toBe(
      "xhigh",
    );
    expect(saved.settingsConfig.codexRouting.modelOrder).toEqual([
      "gpt-6.1-sol-sublyx",
      "gpt-6-astra-sublyx",
      "gpt-5.6-luna-sublyx",
    ]);
  });

  it("leaves alphabetical view mode when restoring newest-first defaults", async () => {
    renderModelOrder({
      models: [
        { model: "gpt-5.6-luna-sublyx", upstreamModel: "gpt-5.6-luna" },
        { model: "gpt-6.1-sol-sublyx", upstreamModel: "gpt-6.1-sol" },
      ],
    });
    const user = userEvent.setup();
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Sort models" }),
      "model",
    );
    await user.click(screen.getByRole("button", { name: "Restore default" }));
    await screen.findByText(/Restored newest-first model order/);
    expect(screen.getByRole("combobox", { name: "Sort models" })).toHaveValue(
      "custom",
    );
    expect(modelOrder()).toEqual(["gpt-6.1-sol-sublyx", "gpt-5.6-luna-sublyx"]);
  });

  it("retains Extra high when reset replaces a Sol alias with the same provider's canonical model", async () => {
    vi.mocked(
      codexSubagentV2Api.resolveModelReasoningCapability,
    ).mockImplementation(async (_settings, _provider, model) =>
      modelReasoningResolution(model, ["medium", "high", "xhigh"]),
    );
    const { source, elementFor, rendered } = renderModelOrder({
      models: [
        { model: "gpt-5.6-luna", upstreamModel: "gpt-5.6-luna" },
        { model: "gpt-6.1-sol", upstreamModel: "gpt-6.1-sol" },
        { model: "gpt-6.1-sol-sublyx", upstreamModel: "gpt-6.1-sol" },
      ],
      routing: {
        modelOrder: ["gpt-6.1-sol-sublyx", "gpt-5.6-luna", "gpt-6.1-sol"],
        defaultReasoningEffort: "xhigh",
      },
    });
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Top model default effort" }),
      ).toHaveValue("xhigh"),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Restore default" }),
    );
    await screen.findByText(/Restored newest-first model order/);
    const saved = vi.mocked(providersApi.update).mock.calls[0][0];
    expect(saved.settingsConfig.codexRouting).toMatchObject({
      modelOrder: ["gpt-6.1-sol", "gpt-6.1-sol-sublyx", "gpt-5.6-luna"],
      defaultReasoningEffort: "xhigh",
    });
    rendered.unmount();
    renderWorkspace(elementFor([source, saved]));
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Top model default effort" }),
      ).toHaveValue("xhigh"),
    );
    expect(screen.getByRole("button", { name: "Save order" })).toBeDisabled();
  });

  it("applies recommendations across both columns, saves once to the router and remounts the adapted preferences", async () => {
    const models = tenModels().map((model) => ({
      ...model,
      ...(model.model === "order-i" ? { displayName: "Coding assistant" } : {}),
      ...(model.model === "order-j"
        ? {
            displayName: "Codex coding assistant",
            contextWindow: 262144,
            reasoning: reasoning(["low", "high"], "low"),
          }
        : {}),
    }));
    const { source, plan, snapshot, elementFor, rendered } = renderModelOrder({
      models,
      routing: { customExtension: { keep: true } },
      config: 'model = "order-a"\nmodel_reasoning_effort = "high"\n',
    });
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Apply recommendations" }),
    );
    await screen.findByText(/No matching usage history/);
    const expectedOrder = [
      "order-j",
      "order-i",
      ..."abcdefgh".split("").map((suffix) => `order-${suffix}`),
    ];
    expect(modelOrder()).toEqual(expectedOrder);
    expect(
      within(screen.getByRole("region", { name: "Ranked models" }))
        .getAllByRole("button", { name: /^Drag / })
        .map((button) => button.getAttribute("aria-label")?.slice(5)),
    ).toEqual(expectedOrder.slice(0, 8));
    expect(providersApi.update).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox", { name: "Sort models" })).toHaveValue(
      "custom",
    );
    expect(
      screen.getByRole("combobox", { name: "Top model default effort" }),
    ).toHaveValue("low");
    await user.click(screen.getByRole("button", { name: "Save order" }));
    await screen.findByText(/Saved the display order for 10 models/);
    expect(providersApi.update).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(providersApi.update).mock.calls[0][0];
    expect(saved.id).toBe(plan.id);
    expect(saved.settingsConfig.codexRouting).toEqual({
      ...plan.settingsConfig.codexRouting,
      modelOrder: expectedOrder,
      modelDisplayStyle: "provider-model",
      defaultReasoningEffort: "low",
    });
    expect(saved.settingsConfig.config).toBe('model = "order-j"\n');
    expect(saved.settingsConfig.modelCatalog).toBeUndefined();
    expect(JSON.stringify({ source, plan })).toBe(snapshot);
    rendered.unmount();
    renderWorkspace(elementFor([source, saved]));
    expect(modelOrder()).toEqual(expectedOrder);
    expect(
      screen.getByRole("combobox", { name: "Top model default effort" }),
    ).toHaveValue("low");
    expect(screen.getByRole("button", { name: "Save order" })).toBeDisabled();
    expect(providersApi.update).toHaveBeenCalledTimes(1);
  });

  it("offers only declared effort tiers and resets to the newly first models declared default", async () => {
    const { plan, elementFor, rendered, source } = renderModelOrder({
      models: [
        { model: "order-a", reasoning: reasoning(["low", "high"], "low") },
        { model: "order-b", reasoning: reasoning(["high"], "high") },
      ],
      routing: {
        modelOrder: ["order-b", "order-a"],
        defaultReasoningEffort: "high",
      },
      config: 'model = "order-b"\nmodel_reasoning_effort = "high"\n',
    });
    const effort = screen.getByRole("combobox", {
      name: "Top model default effort",
    });
    expect(
      within(effort)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["high"]);
    expect(screen.getByRole("button", { name: "Save order" })).toBeDisabled();
    await userEvent.click(
      screen.getByRole("button", { name: "Restore default" }),
    );
    await screen.findByText(/Restored newest-first model order/);
    const saved = vi.mocked(providersApi.update).mock.calls[0][0];
    expect(saved.id).toBe(plan.id);
    expect(saved.settingsConfig.codexRouting).toMatchObject({
      modelOrder: ["order-a", "order-b"],
      defaultReasoningEffort: "low",
    });
    expect(saved.settingsConfig.config).toMatch(/^model = "order-a"/m);
    expect(saved.settingsConfig.config).not.toMatch(
      /^model_reasoning_effort\s*=/m,
    );
    rendered.unmount();
    renderWorkspace(elementFor([source, saved]));
    expect(
      screen.getByRole("combobox", { name: "Top model default effort" }),
    ).toHaveValue("low");
    expect(screen.getByRole("button", { name: "Save order" })).toBeDisabled();
  });

  it("persists a declared effort-only change without reordering or rewriting the config default", async () => {
    const { plan } = renderModelOrder({
      models: [
        { model: "order-a", reasoning: reasoning(["low", "high"], "low") },
      ],
      config: 'model = "order-a"\n',
    });
    const user = userEvent.setup();
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Top model default effort" }),
      "high",
    );
    await user.click(screen.getByRole("button", { name: "Save order" }));
    await screen.findByText(/Saved the display order for 1 models/);
    const saved = vi.mocked(providersApi.update).mock.calls[0][0];
    expect(saved.settingsConfig.config).toBe(plan.settingsConfig.config);
    expect(saved.settingsConfig.codexRouting.defaultReasoningEffort).toBe(
      "high",
    );
    expect(saved.settingsConfig.codexRouting.modelOrder).toBeUndefined();
  });

  it("shows a selected placeholder instead of a blank value for unknown reasoning", async () => {
    renderModelOrder({ models: [{ model: "order-a" }] });
    const effort = screen.getByRole("combobox", {
      name: "Top model default effort",
    });
    await waitFor(() =>
      expect(
        within(effort).getByRole("option", { selected: true }),
      ).toHaveTextContent("Unknown until provider metadata is available"),
    );
    expect(effort).toHaveValue("");
    expect(effort).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save order" })).toBeDisabled();
  });

  it("resolves the Sol wire model, saves Extra high, and restores it on remount", async () => {
    vi.mocked(
      codexSubagentV2Api.resolveModelReasoningCapability,
    ).mockImplementation(async (_settings, _provider, model) =>
      model === "gpt-6.1-sol"
        ? modelReasoningResolution(model, [
            "none",
            "low",
            "medium",
            "high",
            "xhigh",
          ])
        : modelReasoningResolution(model),
    );
    const { source, plan, snapshot, elementFor, rendered } = renderModelOrder({
      models: [
        {
          model: "gpt-6.1-sol-sublyx",
          upstreamModel: "gpt-6.1-sol",
          displayName: "[Subly] gpt-6.1-sol",
        },
      ],
      config: 'model = "gpt-6.1-sol-sublyx"\n',
    });
    const effort = screen.getByRole("combobox", {
      name: "Top model default effort",
    });
    await waitFor(() => expect(effort).toBeEnabled());
    expect(effort).toHaveValue("medium");
    expect(
      within(effort).getByRole("option", { name: "Extra high (xhigh)" }),
    ).toHaveValue("xhigh");
    expect(
      codexSubagentV2Api.resolveModelReasoningCapability,
    ).toHaveBeenCalledWith(source.settingsConfig, source.id, "gpt-6.1-sol");
    expect(screen.getByRole("button", { name: "Save order" })).toBeDisabled();
    const user = userEvent.setup();
    await user.selectOptions(effort, "xhigh");
    await user.click(screen.getByRole("button", { name: "Save order" }));
    await screen.findByText(/Saved the display order for 1 models/);
    const saved = vi.mocked(providersApi.update).mock.calls[0][0];
    expect(saved.id).toBe(plan.id);
    expect(saved.settingsConfig.codexRouting.defaultReasoningEffort).toBe(
      "xhigh",
    );
    expect(saved.settingsConfig.config).toBe(plan.settingsConfig.config);
    expect(saved.settingsConfig.modelCatalog).toBeUndefined();
    expect(JSON.stringify({ source, plan })).toBe(snapshot);
    rendered.unmount();
    renderWorkspace(elementFor([source, saved]));
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Top model default effort" }),
      ).toHaveValue("xhigh"),
    );
    expect(screen.getByRole("button", { name: "Save order" })).toBeDisabled();
  });

  it("saves Sol as the favorite with Extra high after moving it above Luna", async () => {
    vi.mocked(
      codexSubagentV2Api.resolveModelReasoningCapability,
    ).mockImplementation(async (_settings, _provider, model) =>
      ["gpt-5.6-luna", "gpt-6.1-sol"].includes(model)
        ? modelReasoningResolution(model, ["low", "medium", "high", "xhigh"])
        : modelReasoningResolution(model),
    );
    renderModelOrder({
      models: [
        { model: "gpt-5.6-luna-sublyx", upstreamModel: "gpt-5.6-luna" },
        { model: "gpt-6.1-sol-sublyx", upstreamModel: "gpt-6.1-sol" },
      ],
      config:
        'model = "gpt-5.6-luna-sublyx"\nmodel_reasoning_effort = "high"\n',
    });
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", {
        name: "Make gpt-6.1-sol-sublyx the favorite model",
      }),
    );
    const effort = screen.getByRole("combobox", {
      name: "Top model default effort",
    });
    await waitFor(() => expect(effort).toBeEnabled());
    await user.selectOptions(effort, "xhigh");
    await user.click(screen.getByRole("button", { name: "Save order" }));
    await screen.findByText(/Saved the display order for 2 models/);
    const saved = vi.mocked(providersApi.update).mock.calls[0][0];
    expect(saved.settingsConfig.codexRouting).toMatchObject({
      modelOrder: ["gpt-6.1-sol-sublyx", "gpt-5.6-luna-sublyx"],
      defaultReasoningEffort: "xhigh",
    });
    expect(saved.settingsConfig.config).toBe('model = "gpt-6.1-sol-sublyx"\n');
  });

  it("ignores a stale Sol capability response after a different model becomes first", async () => {
    const sol = createDeferred<CodexModelReasoningResolution>();
    vi.mocked(
      codexSubagentV2Api.resolveModelReasoningCapability,
    ).mockImplementation(async (_settings, _provider, model) =>
      model === "gpt-6.1-sol" ? sol.promise : modelReasoningResolution(model),
    );
    renderModelOrder({
      models: [{ model: "gpt-6.1-sol" }, { model: "order-b" }],
      routing: { defaultReasoningEffort: "xhigh" },
    });
    await waitFor(() =>
      expect(
        codexSubagentV2Api.resolveModelReasoningCapability,
      ).toHaveBeenCalled(),
    );
    await userEvent.click(
      screen.getByRole("button", {
        name: "Make order-b the favorite model",
      }),
    );
    await act(async () =>
      sol.resolve(modelReasoningResolution("gpt-6.1-sol", ["medium", "xhigh"])),
    );
    const effort = screen.getByRole("combobox", {
      name: "Top model default effort",
    });
    await waitFor(() => expect(effort).toHaveValue(""));
    expect(effort).toBeDisabled();
    expect(
      within(effort).queryByRole("option", { name: "Extra high (xhigh)" }),
    ).not.toBeInTheDocument();
  });

  it.each(["confirmed_unsupported", "boolean", "empty"] as const)(
    "does not override an explicit %s declaration with inferred tiers",
    async (kind) => {
      const declared = {
        ...reasoning(["low", "high"], "low"),
        ...(kind === "confirmed_unsupported"
          ? { supportStatus: "confirmed_unsupported" as const }
          : kind === "boolean"
            ? { controlKind: "boolean" as const }
            : { supportedEfforts: [] }),
      };
      renderModelOrder({
        models: [{ model: "gpt-6.1-sol", reasoning: declared }],
      });
      const effort = screen.getByRole("combobox", {
        name: "Top model default effort",
      });
      expect(effort).toBeDisabled();
      expect(effort).toHaveValue("");
      expect(
        codexSubagentV2Api.resolveModelReasoningCapability,
      ).not.toHaveBeenCalled();
    },
  );

  it("clears an old preference when reordering to a model with unknown reasoning instead of inventing tiers", async () => {
    renderModelOrder({
      models: [
        { model: "order-a", reasoning: reasoning(["low", "high"], "low") },
        { model: "order-b" },
      ],
      routing: { defaultReasoningEffort: "high" },
      config:
        '# Keep this comment\nmodel = "order-a"\nmodel_reasoning_effort = "high"\n' +
        '[model_providers.source]\nmodel_reasoning_effort = "low"\n',
    });
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Make order-b the favorite model" }),
    );
    const effort = screen.getByRole("combobox", {
      name: "Top model default effort",
    });
    expect(effort).toBeDisabled();
    expect(within(effort).getAllByRole("option")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Save order" }));
    await screen.findByText(/Saved the display order for 2 models/);
    const saved = vi.mocked(providersApi.update).mock.calls[0][0];
    expect(
      saved.settingsConfig.codexRouting.defaultReasoningEffort,
    ).toBeUndefined();
    expect(saved.settingsConfig.config).toMatch(/^model = "order-b"/m);
    expect(saved.settingsConfig.config).toBe(
      '# Keep this comment\nmodel = "order-b"\n' +
        '[model_providers.source]\nmodel_reasoning_effort = "low"\n',
    );
  });

  it.each(["pending", "not_required", "error"] as const)(
    "distinguishes a saved router order from a %s live projection",
    async (state) => {
      renderModelOrder();
      if (state === "error") {
        vi.mocked(
          providersApi.inspectCodexMultiRouterProjection,
        ).mockRejectedValue(new Error("projection_write_failed"));
      } else {
        const status = {
          schemaVersion: 1 as const,
          routerProviderId: "codex-multirouter",
          state,
          warnings: [],
          routes: [],
          lastError: null,
          lastErrorCode: null,
          dependencyFingerprint: "test-fingerprint",
          generatedAt: "2026-10-06T00:00:00Z",
        };
        vi.mocked(
          providersApi.inspectCodexMultiRouterProjection,
        ).mockResolvedValue(status);
        vi.mocked(
          providersApi.retryCodexMultiRouterProjection,
        ).mockResolvedValue(status);
      }
      const user = userEvent.setup();
      await user.click(
        screen.getByRole("button", { name: "Make order-b the favorite model" }),
      );
      await user.click(screen.getByRole("button", { name: "Save order" }));
      const expected =
        state === "pending"
          ? "Order saved, but live projection is still pending. Retry projection from Status."
          : state === "not_required"
            ? "Order saved for this router. It will be projected when this router is activated."
            : /Order saved, but projection is pending:/;
      await screen.findByText(expected);
      expect(providersApi.update).toHaveBeenCalledTimes(1);
      expect(
        vi.mocked(providersApi.update).mock.calls[0][0].settingsConfig
          .codexRouting.modelOrder,
      ).toEqual(["order-b", "order-a", "order-c"]);
      expect(
        screen.queryByText(/Failed to save model order/),
      ).not.toBeInTheDocument();
      if (state === "pending")
        expect(
          providersApi.retryCodexMultiRouterProjection,
        ).toHaveBeenCalledOnce();
      else
        expect(
          providersApi.retryCodexMultiRouterProjection,
        ).not.toHaveBeenCalled();
    },
  );
});

describe("Model order presentation helpers", () => {
  const models: CodexCatalogModel[] = [
    { model: "z", providerName: "Zulu" },
    { model: "b", providerName: "Alpha" },
    { model: "a", providerName: "Alpha" },
  ];
  it("groups providers stably and sorts models only in the requested mode", () => {
    expect(
      sortCodexCatalogModels(models, "provider").map((model) => model.model),
    ).toEqual(["b", "a", "z"]);
    expect(
      sortCodexCatalogModels(models, "provider-model").map(
        (model) => model.model,
      ),
    ).toEqual(["a", "b", "z"]);
    expect(sortCodexCatalogModels(models, "custom")).toEqual(models);
  });
  it("formats the three picker styles without double provider prefixes", () => {
    const model = {
      model: "alias",
      providerName: "OpenRouter",
      displayName: "[ORter] Friendly",
    };
    expect(formatCodexCatalogModelLabel(model, "provider-model")).toBe(
      "[ORter] Friendly",
    );
    expect(formatCodexCatalogModelLabel(model, "model-provider")).toBe(
      "Friendly · ORter",
    );
    expect(formatCodexCatalogModelLabel(model, "model")).toBe("Friendly");
  });
  it("prioritizes coding suitability rather than fabricating popularity or mutating metadata", () => {
    const candidates = [
      { model: "embedding-old", providerName: "Alpha" },
      { model: "coding-6", providerName: "Alpha", contextWindow: 262144 },
      { model: "generic", providerName: "Beta" },
    ];
    const snapshot = JSON.stringify(candidates);
    expect(
      recommendCodexCatalogModels(candidates, 2).map((model) => model.model),
    ).toEqual(["coding-6", "generic"]);
    expect(JSON.stringify(candidates)).toBe(snapshot);
  });

  it("prioritizes observed Codex requests over provider preference, cost and fallback suitability", () => {
    const candidates = [
      { model: "coding-6", providerName: "Preferred" },
      {
        model: "favorite-alias",
        upstreamModel: "gpt-5.6",
        providerName: "Other",
      },
      { model: "provider-popular", providerName: "Preferred" },
    ];
    const stat = (
      model: string,
      providerName: string,
      requestCount: number,
    ): ModelStats => ({
      model,
      providerName,
      requestCount,
      totalTokens: requestCount * 100,
      totalCost: "0",
      avgCostPerRequest: "0",
    });
    expect(
      recommendCodexCatalogModels(candidates, 3, ["Preferred"], {
        codex: [stat("gpt-5.6", "Other", 8)],
        providers: [stat("provider-popular", "Preferred", 1000)],
      }).map((model) => model.model),
    ).toEqual(["favorite-alias", "provider-popular", "coding-6"]);
    expect(recommendCodexCatalogModels(candidates, 0)).toEqual([]);
  });
});

it("没有 MultiRouter 方案时打开工作台不会读取 null settingsConfig", async () => {
  const provider: Provider = {
    id: "valid-provider",
    name: "Valid Provider",
    settingsConfig: {},
  };

  expect(() =>
    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [provider],
        isProxyRunning: false,
        isCodexTakeoverActive: false,
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    ),
  ).not.toThrow();
  expect(
    screen.getByText("Codex multi-model routing workspace"),
  ).toBeInTheDocument();
  expect(
    screen.getByText("Codex egress environment monitoring"),
  ).toBeInTheDocument();
  expect(await screen.findByText("Monitoring healthy")).toBeInTheDocument();
});

describe("Codex MultiRouter workspace route persistence helpers", () => {
  it("puts session consumption before diagnostic request samples in the traffic view", async () => {
    const provider: Provider = {
      id: "traffic-layout",
      name: "Traffic layout",
      settingsConfig: { modelCatalog: { models: [{ model: "model-a" }] } },
    };
    const plan = withEnabledProviderRoute(
      createDraftRoutingPlan([provider], [provider]),
      provider,
    );
    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [provider, plan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "status",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /Traffic/ }),
    );
    const samples = await screen.findByText(
      "Today’s recent request samples (child provider / model)",
    );
    const sync = screen.getByRole("button", { name: /Sync session usage now/ });
    expect(
      sync.compareDocumentPosition(samples) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
  it("keeps proxy input, cache, and output token dimensions separate", () => {
    const provider: Provider = {
      id: "traffic-provider",
      name: "Traffic Provider",
      settingsConfig: { modelCatalog: { models: [{ model: "model-a" }] } },
    };
    const plan = withEnabledProviderRoute(
      createDraftRoutingPlan([provider], [provider]),
      provider,
    );
    const routing = readCodexRouting(plan);
    const routes = routing?.routes ?? [];
    const rows = buildRouteTrafficRows({
      logs: [
        createCodexProxyLog({
          providerId: provider.id,
          model: "model-a",
          requestModel: "model-a",
          inputTokens: 120,
          cacheReadTokens: 80,
          cacheCreationTokens: 20,
          outputTokens: 40,
        }),
      ],
      routes: routes.map((route, index) => ({
        provider: plan,
        route,
        index,
      })),
      selectedPlan: plan,
      providersById: new Map([[provider.id, provider]]),
    });

    expect(rows[0]!).toMatchObject({
      inputTokens: 40,
      cacheReadTokens: 80,
      cacheCreationTokens: 20,
      outputTokens: 40,
    });
  });
  it.each(["deepseek-flash", "deepseek-flash-opencode-go"])(
    "preserves declared reasoning for saved route %s when another provider has the same model",
    async (visibleModel) => {
      const reasoning = {
        schemaVersion: 2 as const,
        supportStatus: "confirmed_supported" as const,
        controlKind: "graded" as const,
        supportedEfforts: ["low", "high", "max"],
        defaultEffort: "max",
        disableAllowed: false,
        upstream: {
          format: "string",
          parameter: "reasoning_effort",
          effortMap: { low: "low", high: "high", max: "max" },
        },
        source: "user",
      };
      const source: Provider = {
        id: "opencode-go",
        name: "OpenCode Go 原生",
        settingsConfig: {
          modelCatalog: { models: [{ model: "deepseek-flash", reasoning }] },
        },
      };
      const duplicate: Provider = {
        ...source,
        id: "deepseek",
        name: "DeepSeek",
        settingsConfig: {
          modelCatalog: { models: [{ model: "deepseek-flash" }] },
        },
      };
      const plan: Provider = {
        id: "codex-multirouter",
        name: "Codex MultiRouter",
        settingsConfig: {
          codexRouting: {
            schemaVersion: 2,
            enabled: true,
            subagentVersion: "v2",
            routes: [
              {
                id: "go-route",
                enabled: true,
                targetProviderId: source.id,
                modelSelection: { mode: "include", models: [visibleModel] },
                ...(visibleModel !== "deepseek-flash"
                  ? { aliases: { [visibleModel]: "deepseek-flash" } }
                  : {}),
              },
            ],
            subagentV2: { schemaVersion: 2, profiles: {} },
          },
        },
      };
      renderWorkspace(
        React.createElement(CodexRouterWorkspacePage, {
          providers: [duplicate, source, plan],
          activeProviderId: plan.id,
          isProxyRunning: true,
          isCodexTakeoverActive: true,
          initialProviderId: plan.id,
          initialTab: "subagents",
          onEditProvider: vi.fn(),
          onDeletePlan: vi.fn(),
          onCreateProvider: vi.fn(),
        }),
      );
      await waitFor(() => {
        expect(
          codexSubagentV2Api.getReasoningCapabilities,
        ).toHaveBeenCalledWith(
          expect.objectContaining({
            modelCatalog: expect.objectContaining({
              models: expect.arrayContaining([
                expect.objectContaining({ model: visibleModel, reasoning }),
              ]),
            }),
          }),
        );
      });
    },
  );
  it("explains safe metadata refresh refusal without implying a network failure", () => {
    expect(
      workspaceErrorMessage("codex_provider_set_probe_required"),
    ).toContain("Probe and explicitly save");
    expect(
      workspaceErrorMessage("codex_provider_set_split_confirmation_required"),
    ).toContain("setup wizard");
    expect(
      workspaceErrorMessage("codex_provider_set_split_confirmation_required"),
    ).toContain("no probe was sent automatically");
  });

  it("turns backend route validation codes into Chinese messages", () => {
    expect(
      workspaceErrorMessage(
        new Error(
          "include_models_empty: include selection requires at least one model",
        ),
      ),
    ).toBe("Select at least one upstream model");
    expect(
      workspaceErrorMessage(
        new Error(
          "legacy_route_requires_migration: Provider p1 is referenced by legacy MultiRouter r1",
        ),
      ),
    ).toBe(
      "This is a legacy route configuration; complete migration before saving",
    );
  });

  it("previews include selection as a strict allowlist", async () => {
    const official: Provider = {
      id: "official-source",
      name: "OpenAI Official",
      category: "official",
      settingsConfig: {
        modelCatalog: {
          models: [{ model: "gpt-5.4" }, { model: "gpt-5.6-sol" }],
        },
      },
    };
    const plan: Provider = {
      id: "strict-router",
      name: "Strict Router",
      category: "custom",
      settingsConfig: {
        codexRouting: {
          schemaVersion: 2,
          enabled: true,
          routes: [
            {
              id: "official-route",
              enabled: true,
              targetProviderId: official.id,
              modelSelection: {
                mode: "include",
                models: ["gpt-5.6-sol"],
              },
              match: { models: ["gpt-5.6-sol"], prefixes: ["gpt"] },
              matchPrefixes: ["gpt"],
            },
          ],
        },
      },
    };

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [official, plan],
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "test",
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(/gpt-5\.4-mini/), "gpt-5.4");
    await user.click(screen.getByRole("button", { name: "Preview match" }));

    expect(screen.getByText(/gpt-5\.4.*cannot be routed/i)).toBeInTheDocument();
  });

  it("previews routes from the selected plan only", async () => {
    const source: Provider = {
      id: "shared-source",
      name: "Shared Source",
      category: "custom",
      settingsConfig: {
        modelCatalog: { models: [{ model: "shared-model" }] },
      },
    };
    const otherPlan: Provider = {
      id: "other-router",
      name: "Other Router",
      category: "custom",
      settingsConfig: {
        codexRouting: {
          schemaVersion: 2,
          enabled: true,
          routes: [
            {
              id: "other-route",
              label: "Other Route",
              enabled: true,
              targetProviderId: source.id,
              modelSelection: { mode: "include", models: ["shared-model"] },
              match: { models: ["shared-model"], prefixes: [] },
            },
          ],
        },
      },
    };
    const selectedPlan: Provider = {
      id: "selected-router",
      name: "Selected Router",
      category: "custom",
      settingsConfig: {
        codexRouting: {
          schemaVersion: 2,
          enabled: true,
          routes: [],
        },
      },
    };

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [source, otherPlan, selectedPlan],
        activeProviderId: selectedPlan.id,
        initialProviderId: selectedPlan.id,
        initialTab: "test",
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    const user = userEvent.setup();
    await user.type(
      screen.getByPlaceholderText(/gpt-5\.4-mini/),
      "shared-model",
    );
    await user.click(screen.getByRole("button", { name: "Preview match" }));

    expect(
      screen.getByText(/shared-model.*cannot be routed/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Other Route/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "shared-model" }),
    ).not.toBeInTheDocument();
  });

  it.each(["exact", "prefix", "alias"] as const)(
    "rejects excluded models in %s previews and suggests only included models",
    async (matchKind) => {
      const source: Provider = {
        id: "curated-preview-source",
        name: "Curated Preview Source",
        settingsConfig: {
          model: "hidden-model",
          modelCatalog: {
            models: [
              { model: "kept-model" },
              { model: "hidden-model", enabled: false },
            ],
          },
        },
      };
      const requestedModel =
        matchKind === "alias" ? "hidden-alias" : "hidden-model";
      const plan: Provider = {
        id: "curated-preview-router",
        name: "Curated Preview Router",
        settingsConfig: {
          codexRouting: {
            schemaVersion: 2,
            enabled: true,
            routes: [
              {
                id: "curated-route",
                enabled: true,
                targetProviderId: source.id,
                modelSelection: { mode: "all" },
                match: {
                  models:
                    matchKind === "prefix"
                      ? []
                      : ["kept-model", requestedModel],
                  prefixes: matchKind === "prefix" ? ["hidden-", "kept-"] : [],
                },
                ...(matchKind === "alias"
                  ? { aliases: { "hidden-alias": "hidden-model" } }
                  : {}),
              },
            ],
          },
        },
      };
      renderWorkspace(
        React.createElement(CodexRouterWorkspacePage, {
          providers: [source, plan],
          activeProviderId: plan.id,
          initialProviderId: plan.id,
          initialTab: "test",
          isProxyRunning: true,
          isCodexTakeoverActive: true,
          onEditProvider: vi.fn(),
          onDeletePlan: vi.fn(),
          onCreateProvider: vi.fn(),
        }),
      );
      expect(screen.getByRole("button", { name: "kept-model" })).toBeVisible();
      expect(
        screen.queryByRole("button", { name: requestedModel }),
      ).not.toBeInTheDocument();
      const user = userEvent.setup();
      await user.type(
        screen.getByPlaceholderText(/gpt-5\.4-mini/),
        requestedModel,
      );
      await user.click(screen.getByRole("button", { name: "Preview match" }));
      expect(
        screen.getByText(
          `${requestedModel} cannot be routed: it did not match any enabled model rule in the current plan.`,
        ),
      ).toBeVisible();
      expect(providersApi.update).not.toHaveBeenCalled();
    },
  );

  it("does not revive excluded models through saved defaults, exact routes or aliases", () => {
    const source: Provider = {
      id: "curated-projection-source",
      name: "Curated Projection Source",
      settingsConfig: {
        model: "hidden-model",
        config: 'model = "hidden-model"',
        modelCatalog: {
          models: [
            { model: "kept-model" },
            { model: "hidden-model", enabled: false },
          ],
        },
      },
    };
    const plan: Provider = {
      id: "curated-projection-router",
      name: "Curated Projection Router",
      settingsConfig: {
        codexRouting: {
          schemaVersion: 2,
          enabled: true,
          spawnAgentModels: ["hidden-model", "hidden-alias", "kept-model"],
          routes: [
            {
              id: "curated-route",
              enabled: true,
              targetProviderId: source.id,
              modelSelection: { mode: "all" },
              match: {
                models: ["kept-model", "hidden-model", "hidden-alias"],
                prefixes: ["hidden-"],
              },
              aliases: { "hidden-alias": "hidden-model" },
            },
          ],
        },
        modelCatalog: {
          models: [{ model: "hidden-model" }, { model: "hidden-alias" }],
        },
      },
    };
    const projection = projectCodexModelCatalog(
      plan,
      new Map([[source.id, source]]),
    );
    expect(projection.models.map((model) => model.model)).toEqual([
      "kept-model",
    ]);
    expect(projection.spawnAgentModels).toEqual(["kept-model"]);
    expect(plan.settingsConfig.codexRouting.routes[0].match.models).toContain(
      "hidden-model",
    );

    const allExcluded: Provider = {
      ...source,
      settingsConfig: {
        ...source.settingsConfig,
        modelCatalog: {
          models: source.settingsConfig.modelCatalog.models.map(
            (model: CodexCatalogModel) => ({
              ...model,
              enabled: false,
            }),
          ),
        },
      },
    };
    const emptyProjection = projectCodexModelCatalog(
      plan,
      new Map([[source.id, allExcluded]]),
    );
    expect(emptyProjection.models).toEqual([]);
    expect(emptyProjection.spawnAgentModels).toEqual([]);
  });

  it("shows a readable warning instead of an active default-route control for legacy plans", async () => {
    const relay: Provider = {
      id: "relay-provider",
      name: "DeepSeek Relay",
      category: "custom",
      settingsConfig: {
        modelCatalog: { models: [{ model: "deepseek-v4-flash" }] },
      },
    };
    const legacyRouteId = "router-5626e6b9-33cb-4c3b-8d16-af8176e16209";
    const plan: Provider = {
      id: "legacy-router",
      name: "Legacy Router",
      category: "custom",
      settingsConfig: {
        codexRouting: {
          schemaVersion: 2,
          enabled: true,
          defaultRouteId: legacyRouteId,
          routes: [
            {
              id: legacyRouteId,
              label: legacyRouteId,
              enabled: true,
              targetProviderId: relay.id,
              modelSelection: { mode: "all" },
              match: { models: ["deepseek-v4-flash"], prefixes: [] },
            },
          ],
        },
      },
    };

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [relay, plan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "routes",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    const user = userEvent.setup();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Edit matching rules" }),
      ).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: "Rename" }));

    expect(
      screen.queryByText("Default route", { selector: "label" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/Legacy default route disabled/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/The legacy config points to.*DeepSeek Relay/),
    ).toBeInTheDocument();
    expect(screen.queryByText(legacyRouteId)).not.toBeInTheDocument();
  });

  it("uses the target Provider name when a legacy route label is only its UUID", () => {
    expect(
      routeSummaryDisplayName(
        "router-5626e6b9-33cb-4c3b-8d16-af8176e16209",
        "router-5626e6b9-33cb-4c3b-8d16-af8176e16209",
        "DeepSeek Relay",
      ),
    ).toBe("DeepSeek Relay");
    expect(
      routeSummaryDisplayName(
        undefined,
        "router-5626e6b9-33cb-4c3b-8d16-af8176e16209",
        undefined,
      ),
    ).toBe("router-5626e6b9-33cb-4c3b-8d16-af8176e16209");
  });

  it("keeps an opaque legacy route label out of the persisted edit draft", () => {
    const routeId = "router-5626e6b9-33cb-4c3b-8d16-af8176e16209";
    const draft = createRoutePolicyDraft({
      id: routeId,
      route: {
        id: routeId,
        label: routeId,
        targetProviderId: "deepseek-relay",
      },
      provider: {
        id: "deepseek-relay",
        name: "DeepSeek Relay",
      },
      isExisting: true,
      matchModels: [],
      matchPrefixes: [],
    } as any);

    expect(draft.route.id).toBe(routeId);
    expect(draft.route.label).toBe(routeId);
    expect(serializeCodexRouteV2(draft.route, 0).label).toBe(routeId);
    expect(
      routeSummaryDisplayName(draft.route.label, routeId, "DeepSeek Relay"),
    ).toBe("DeepSeek Relay");
  });

  it("serializes only schema v2 route policy and drops inherited secrets and capabilities", () => {
    const route = serializeCodexRouteV2(
      {
        id: "qwen-route",
        label: "Qwen",
        enabled: true,
        targetProviderId: "qwen-provider",
        modelSelection: { mode: "include", models: ["qwen3.8"] },
        match: { models: ["Qwen 3.8"], prefixes: ["qwen"] },
        aliases: { "Qwen 3.8": "qwen3.8" },
        authPolicy: {
          source: "managed_codex_oauth",
          authProvider: "codex_oauth",
          accountId: "account-1",
        } as unknown as CodexRoutingAuthPolicy,
        upstream: {
          baseUrl: "https://must-not-persist.invalid/v1",
          apiFormat: "openai_chat",
          auth: { source: "provider_config" },
          modelMap: { "Qwen 3.8": "qwen3.8" },
        },
        capabilities: {
          textOnly: true,
          supportsReasoning: true,
        },
      },
      0,
    );

    expect(route).toEqual({
      id: "qwen-route",
      label: "Qwen",
      enabled: true,
      targetProviderId: "qwen-provider",
      modelSelection: { mode: "include", models: ["qwen3.8"] },
      matchPrefixes: ["qwen"],
      aliases: { "Qwen 3.8": "qwen3.8" },
      authPolicy: {
        source: "managed_codex_oauth",
        accountId: "account-1",
      },
    });
    expect(route).not.toHaveProperty("upstream");
    expect(route).not.toHaveProperty("capabilities");
  });

  it("does not re-persist authentication policy for the canonical official route", () => {
    const route = serializeCodexRouteV2(
      {
        id: "official-route",
        enabled: true,
        targetProviderId: "codex-official",
        modelSelection: { mode: "all" },
        matchPrefixes: ["gpt"],
        authPolicy: { source: "provider_config" },
      },
      0,
    );

    expect(route).not.toHaveProperty("authPolicy");
    expect(route.matchPrefixes).toEqual(["gpt"]);
  });

  it("normalizes merged v2 routes that are missing modelSelection", () => {
    const plan = {
      id: "merged-router",
      name: "Merged Router",
      category: "custom",
      settingsConfig: {
        codexRouting: {
          schemaVersion: 2,
          enabled: true,
          routes: [
            {
              id: "merged-route",
              enabled: true,
              targetProviderId: "target-provider",
              matchPrefixes: ["qwen"],
            },
          ],
        },
      },
    } as Provider;

    expect(readCodexRouting(plan)?.routes?.[0]).toMatchObject({
      modelSelection: { mode: "all" },
      match: { models: [], prefixes: ["qwen"] },
    });
  });

  it("edits and saves only schema v2 route policy with canonical include models", async () => {
    const qwen: Provider = {
      id: "codex-qwen-policy",
      name: "Qwen Policy",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [
            { model: "qwen-visible", upstreamModel: "qwen3.8" },
            { model: "qwen3.8-coder" },
          ],
        },
      },
    };
    const plan = withEnabledProviderRoute(
      createDraftRoutingPlan([qwen], [qwen]),
      qwen,
    );

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [qwen, plan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "routes",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Edit matching rules" }),
    );
    await user.selectOptions(
      screen.getByLabelText("Model selection scope: Qwen Policy"),
      "include",
    );
    expect(
      screen.getByLabelText("Select upstream models qwen-visible"),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Select upstream models qwen3.8"),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByLabelText("Select upstream models qwen3.8-coder"),
    );
    await user.clear(screen.getByLabelText("Match prefixes: Qwen Policy"));
    await user.type(
      screen.getByLabelText("Match prefixes: Qwen Policy"),
      "qwen, qw",
    );
    await user.clear(
      screen.getByLabelText("Visible alias mapping: Qwen Policy"),
    );
    await user.type(
      screen.getByLabelText("Visible alias mapping: Qwen Policy"),
      "Qwen Latest=qwen-visible",
    );
    await user.selectOptions(
      screen.getByLabelText("authentication policy: Qwen Policy"),
      "managed_codex_oauth",
    );
    await user.type(
      screen.getByLabelText("Managed OAuth account ID: Qwen Policy"),
      "oauth-account-1",
    );

    expect(screen.queryByLabelText(/Base URL/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/API Key/i)).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText(/Upstream protocol/i),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Capabilities/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save rules" }));

    await waitFor(() => expect(providersApi.update).toHaveBeenCalled());
    const savedPlan = vi.mocked(providersApi.update).mock.calls.at(-1)?.[0];
    const savedRoute = (
      savedPlan?.settingsConfig.codexRouting as { routes?: unknown[] }
    )?.routes?.[0] as Record<string, unknown> | undefined;
    expect(savedRoute).toMatchObject({
      label: "Qwen Policy",
      targetProviderId: qwen.id,
      modelSelection: { mode: "include", models: ["qwen-visible"] },
      matchPrefixes: ["qwen", "qw"],
      aliases: { "Qwen Latest": "qwen-visible" },
      authPolicy: {
        source: "managed_codex_oauth",
        accountId: "oauth-account-1",
      },
    });
    expect(savedRoute).not.toHaveProperty("upstream");
    expect(savedRoute).not.toHaveProperty("capabilities");
  });

  it("keeps official route matching editable while authentication is inherited", async () => {
    const official: Provider = {
      id: "codex-official",
      name: "OpenAI Official",
      category: "official",
      settingsConfig: {
        modelCatalog: { models: [{ model: "gpt-5.6-sol" }] },
      },
    };
    const plan = withEnabledProviderRoute(
      createDraftRoutingPlan([official], [official]),
      official,
    );

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [official, plan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "routes",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Edit matching rules" }),
    );

    expect(
      screen.getByLabelText("Match prefixes: OpenAI Official"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Visible alias mapping: OpenAI Official"),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText(
        "Authentication policy reference: OpenAI Official",
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/Authentication is inherited from OpenAI Official/),
    ).toBeInTheDocument();
  });

  it("lets a fixed route switch back to automatic Provider following immediately", async () => {
    const deepseek: Provider = {
      id: "codex-deepseek-vision",
      name: "DeepSeek Responses",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [
            { model: "deepseek-v4-flash" },
            { model: "deepseek-v4-flash-vision-exp" },
            { model: "deepseek-v4-pro" },
          ],
        },
      },
    };
    const plan: Provider = {
      id: "codex-multirouter",
      name: "New Codex MultiRouter",
      category: "custom",
      settingsConfig: {
        codexRouting: {
          schemaVersion: 2,
          enabled: true,
          routes: [
            {
              id: "router-deepseek",
              label: "DeepSeek Responses",
              enabled: true,
              targetProviderId: deepseek.id,
              modelSelection: {
                mode: "include",
                models: ["deepseek-v4-flash", "deepseek-v4-pro"],
              },
              authPolicy: { source: "provider_config" },
            },
          ],
        },
      },
    };

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [deepseek, plan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "routes",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    expect(
      screen.getByText(
        "Connected 2/3 models; Not connected: deepseek-v4-flash-vision-exp",
      ),
    ).toBeInTheDocument();

    await userEvent
      .setup()
      .click(
        screen.getByRole("button", { name: "Follow all models automatically" }),
      );

    await waitFor(() => expect(providersApi.update).toHaveBeenCalledOnce());
    const savedPlan = vi.mocked(providersApi.update).mock.calls[0]?.[0];
    expect(
      savedPlan.settingsConfig?.codexRouting?.routes?.[0]?.modelSelection,
    ).toEqual({ mode: "all" });
  });

  it("does not block saving an inactive route whose fixed model selection is empty", async () => {
    const source: Provider = {
      id: "default",
      name: "default",
      category: "custom",
      settingsConfig: { modelCatalog: { models: [] } },
    };
    const plan: Provider = {
      id: "codex-multirouter",
      name: "New Codex MultiRouter",
      category: "custom",
      settingsConfig: {
        codexRouting: {
          schemaVersion: 2,
          enabled: true,
          routes: [
            {
              id: "router-default",
              label: "default",
              enabled: false,
              targetProviderId: source.id,
              modelSelection: { mode: "include", models: [] },
              authPolicy: { source: "provider_config" },
            },
          ],
        },
      },
    };

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [source, plan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "routes",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Edit matching rules" }),
    );
    await user.click(screen.getByRole("button", { name: "Save rules" }));

    await waitFor(() => expect(providersApi.update).toHaveBeenCalled());
    expect(
      screen.queryByText("Select at least one upstream model"),
    ).not.toBeInTheDocument();
  });

  it("blocks saving when an alias target is not a canonical provider model", async () => {
    const qwen: Provider = {
      id: "codex-qwen-invalid-alias",
      name: "Qwen Invalid Alias",
      category: "custom",
      settingsConfig: {
        modelCatalog: { models: [{ model: "qwen3.8" }] },
      },
    };
    const plan = withEnabledProviderRoute(
      createDraftRoutingPlan([qwen], [qwen]),
      qwen,
    );

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [qwen, plan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "routes",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Edit matching rules" }),
    );
    await user.type(
      screen.getByLabelText("Visible alias mapping: Qwen Invalid Alias"),
      "Broken=missing-model",
    );
    await user.click(screen.getByRole("button", { name: "Save rules" }));

    expect(
      screen.getByText(
        "Alias target “missing-model” is not in the target provider upstream model list",
      ),
    ).toBeInTheDocument();
    expect(providersApi.update).not.toHaveBeenCalled();
  });

  it("shows a redacted migration preview before editing a schema v1 plan", async () => {
    const source: Provider = {
      id: "qwen",
      name: "Qwen",
      category: "custom",
      settingsConfig: {
        baseUrl: "https://private.invalid/v1",
        auth: { OPENAI_API_KEY: "must-not-render" },
        modelCatalog: { models: [{ model: "qwen3.8" }] },
      },
    };
    const legacyPlan: Provider = {
      id: "legacy-router",
      name: "Legacy Router",
      category: "custom",
      settingsConfig: {
        codexRouting: {
          enabled: true,
          routes: [
            {
              id: "qwen-route",
              targetProviderId: "qwen",
              match: { models: ["qwen3.8"] },
              upstream: {
                apiFormat: "openai_chat",
                apiKey: "legacy-secret",
                auth: { source: "provider_config" },
              },
            },
          ],
        },
      },
    };
    vi.mocked(providersApi.getCodexMultiRouterRevision).mockResolvedValue(
      "revision-1",
    );
    vi.mocked(providersApi.previewCodexMultiRouterMigration).mockResolvedValue({
      schemaVersion: 2,
      providerId: legacyPlan.id,
      expectedRevision: "revision-1",
      planToken: "opaque-plan-token",
      diff: {
        removedRouteFields: ["upstream.apiFormat", "upstream.apiKey"],
        createdProviderIds: ["qwen-migrated"],
        changedRouteIds: ["qwen-route"],
      },
      warnings: ["需要创建迁移 Provider"],
      generatedProviders: [
        {
          id: "qwen-migrated",
          name: "Qwen migrated",
          migrationGenerated: true,
          sourceProviderId: "qwen",
        },
      ],
    });

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [source, legacyPlan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: legacyPlan.id,
        initialProviderId: legacyPlan.id,
        initialTab: "routes",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Edit matching rules" }));

    expect(
      await screen.findByRole("heading", {
        name: "Migrate legacy MultiRouter to schema v2",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("需要创建迁移 Provider")).toBeInTheDocument();
    expect(screen.getByText(/Qwen migrated/)).toBeInTheDocument();
    expect(screen.queryByText("legacy-secret")).not.toBeInTheDocument();
    expect(screen.queryByText("must-not-render")).not.toBeInTheDocument();
    expect(providersApi.update).not.toHaveBeenCalled();
  });

  it("normalizes missing and invalid subagent versions to V2 while preserving V1", () => {
    const planWith = (subagentVersion?: unknown): Provider => ({
      id: `router-${String(subagentVersion)}`,
      name: "Router",
      category: "custom",
      settingsConfig: {
        codexRouting: {
          enabled: true,
          routes: [],
          ...(subagentVersion === undefined ? {} : { subagentVersion }),
        },
      },
    });

    expect((readCodexRouting(planWith()) as any)?.subagentVersion).toBe("v2");
    expect(
      (readCodexRouting(planWith("unexpected")) as any)?.subagentVersion,
    ).toBe("v2");
    expect((readCodexRouting(planWith("v1")) as any)?.subagentVersion).toBe(
      "v1",
    );
  });

  it("does not infer a legacy route target from an ambiguous shared model", () => {
    const providerA = {
      id: "relay-a",
      name: "Relay A",
      settingsConfig: {
        modelCatalog: { models: [{ model: "shared-model" }] },
      },
    } as Provider;
    const providerB = {
      id: "relay-b",
      name: "Relay B",
      settingsConfig: {
        modelCatalog: { models: [{ model: "shared-model" }] },
      },
    } as Provider;
    const routes = [
      {
        id: "legacy-route",
        label: "legacy-route",
        match: { models: ["shared-model"] },
      },
      {
        id: "relay-a-route",
        targetProviderId: "relay-a",
        match: { models: ["shared-model"] },
      },
    ];

    expect(
      dedupeCodexRoutesBySemanticProvider(routes, [providerA, providerB]),
    ).toEqual(routes);
  });

  it("按 Router 官方认证与账号池 Desktop 成员展示生成门面", () => {
    expect(
      resolveCodexRouterAuthFacadeLabel({ mode: "desktop_current_login" }),
    ).toBe("Desktop / hybrid authentication");
    expect(resolveCodexRouterAuthFacadeLabel({ mode: "managed_oauth" })).toBe(
      "CCSM-managed authentication",
    );
    expect(
      resolveCodexRouterAuthFacadeLabel(
        { mode: "account_pool" },
        {
          enabled: true,
          entries: [
            {
              accountId: "native_codex_auth",
              enabled: true,
              reservePercent: 5,
            },
          ],
        },
      ),
    ).toBe("Desktop / hybrid authentication");
    expect(
      resolveCodexRouterAuthFacadeLabel(
        { mode: "account_pool" },
        {
          enabled: true,
          entries: [
            {
              accountId: "native_codex_auth",
              enabled: false,
              reservePercent: 5,
            },
          ],
        },
      ),
    ).toBe("CCSM-managed authentication");
    expect(resolveCodexRouterAuthFacadeLabel({ mode: "account_pool" })).toBe(
      "Pending confirmation",
    );
  });

  it("refreshes an official OAuth Provider without rewriting its MultiRouter route", async () => {
    vi.mocked(fetchCodexOauthModels).mockResolvedValue([
      { id: "gpt-5.5", ownedBy: "openai", contextWindow: 272000 },
      { id: "gpt-5.6-sol", ownedBy: "openai", contextWindow: 272000 },
    ]);
    const provider: Provider = {
      id: "openai-official",
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
        modelCatalog: {
          models: [
            {
              model: "gpt-5.5",
              upstreamModel: "gpt-5.5",
              contextWindow: 272000,
            },
          ],
        },
      },
    };
    const planDraft = createDraftRoutingPlan([provider], [provider]);
    const route = normalizeCodexRouteForSave(
      {
        label: provider.name,
        targetProviderId: provider.id,
        match: { models: ["gpt-5.5"] },
      },
      0,
      new Set<string>(),
    );
    const plan: Provider = {
      ...planDraft,
      settingsConfig: {
        ...planDraft.settingsConfig,
        codexRouting: {
          enabled: true,
          defaultRouteId: route.id,
          routes: [route],
        },
      },
    };

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [provider, plan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "routes",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    await waitFor(() =>
      expect(fetchCodexOauthModels).toHaveBeenCalledWith("account-56"),
    );
    await waitFor(() => {
      const savedProvider = vi
        .mocked(providersApi.update)
        .mock.calls.map(([updated]) => updated)
        .find((updated) => updated.id === provider.id);
      expect(
        savedProvider?.settingsConfig?.modelCatalog?.models.map(
          (model: { model: string }) => model.model,
        ),
      ).toEqual(["gpt-5.5", "gpt-5.6-sol"]);

      expect(
        vi
          .mocked(providersApi.update)
          .mock.calls.some(([updated]) => updated.id === plan.id),
      ).toBe(false);
    });
    expect(fetchModelsForConfig).not.toHaveBeenCalled();
  });

  it("refreshes only providers referenced by enabled routes", async () => {
    vi.mocked(fetchCodexOauthModels).mockResolvedValue([
      { id: "gpt-5.6-sol", ownedBy: "openai", contextWindow: 272000 },
    ]);
    const enabledProvider: Provider = {
      id: "openai-enabled",
      name: "OpenAI Enabled",
      category: "official",
      meta: {
        providerType: "codex_oauth",
        authBinding: {
          source: "managed_codex_oauth",
          accountId: "account-enabled",
        },
      },
      settingsConfig: {
        modelCatalog: { models: [{ model: "gpt-5.5" }] },
      },
    };
    const disabledProvider: Provider = {
      id: "openai-disabled",
      name: "OpenAI Disabled",
      category: "official",
      meta: {
        providerType: "codex_oauth",
        authBinding: {
          source: "managed_codex_oauth",
          accountId: "account-disabled",
        },
      },
      settingsConfig: {
        modelCatalog: { models: [{ model: "gpt-5.4" }] },
      },
    };
    const planDraft = createDraftRoutingPlan(
      [enabledProvider, disabledProvider],
      [enabledProvider, disabledProvider],
    );
    const plan: Provider = {
      ...planDraft,
      settingsConfig: {
        ...planDraft.settingsConfig,
        codexRouting: {
          enabled: true,
          routes: [
            {
              id: "enabled-route",
              enabled: true,
              targetProviderId: enabledProvider.id,
              match: { models: ["gpt-5.5"], prefixes: [] },
              upstream: {},
            },
            {
              id: "disabled-route",
              enabled: false,
              targetProviderId: disabledProvider.id,
              match: { models: ["gpt-5.4"], prefixes: [] },
              upstream: {},
            },
          ],
        },
      },
    };

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [enabledProvider, disabledProvider, plan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "routes",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    await waitFor(() =>
      expect(fetchCodexOauthModels).toHaveBeenCalledWith("account-enabled"),
    );
    expect(fetchCodexOauthModels).not.toHaveBeenCalledWith("account-disabled");
  });

  it("clears disabled provider refresh state and refreshes again after re-enabling", async () => {
    vi.mocked(fetchModelsForConfig).mockImplementation(
      () => new Promise(() => {}),
    );
    const provider: Provider = {
      id: "toggle-refresh-provider",
      name: "Toggle Refresh Provider",
      category: "custom",
      settingsConfig: {
        baseUrl: "https://toggle-refresh.example/v1",
        auth: { OPENAI_API_KEY: "toggle-key" },
        modelCatalog: { models: [{ model: "toggle-model" }] },
      },
    };
    const basePlan = withEnabledProviderRoute(
      createDraftRoutingPlan([provider], [provider]),
      provider,
    );

    /// 在同一工作台实例中切换 route，覆盖停用Status清理和重新启用刷新。
    function RefreshToggleHarness() {
      const [enabled, setEnabled] = React.useState(true);
      const routes = readCodexRouting(basePlan)?.routes ?? [];
      const plan: Provider = {
        ...basePlan,
        settingsConfig: {
          ...basePlan.settingsConfig,
          codexRouting: {
            ...readCodexRouting(basePlan),
            enabled: true,
            routes: routes.map((route) => ({ ...route, enabled })),
          },
        },
      };
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(
          "button",
          { type: "button", onClick: () => setEnabled((value) => !value) },
          "切换测试路由",
        ),
        React.createElement(CodexRouterWorkspacePage, {
          providers: [provider, plan],
          isProxyRunning: true,
          isCodexTakeoverActive: true,
          activeProviderId: plan.id,
          initialProviderId: plan.id,
          initialTab: "routes",
          onEditProvider: vi.fn(),
          onDeletePlan: vi.fn(),
          onCreateProvider: vi.fn(),
        }),
      );
    }

    renderWorkspace(React.createElement(RefreshToggleHarness));
    await waitFor(() => expect(fetchModelsForConfig).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Reading model list...")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "切换测试路由" }));
    await waitFor(() =>
      expect(
        screen.queryByText("Reading model list..."),
      ).not.toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: "切换测试路由" }));
    await waitFor(() => expect(fetchModelsForConfig).toHaveBeenCalledTimes(2));
  });

  it("invalidates an in-flight refresh before saving a disabled route", async () => {
    const modelRefresh = createDeferred<FetchedModel[]>();
    const routeSave = createDeferred<boolean>();
    vi.mocked(fetchModelsForConfig).mockReturnValue(modelRefresh.promise);
    const provider: Provider = {
      id: "save-race-provider",
      name: "Save Race Provider",
      category: "custom",
      settingsConfig: {
        baseUrl: "https://save-race.example/v1",
        auth: { OPENAI_API_KEY: "save-race-key" },
        modelCatalog: { models: [{ model: "old-model" }] },
      },
    };
    const plan = withEnabledProviderRoute(
      createDraftRoutingPlan([provider], [provider]),
      provider,
    );
    vi.mocked(providersApi.update).mockImplementation((updated) =>
      updated.id === plan.id ? routeSave.promise : Promise.resolve(true),
    );

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [provider, plan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "routes",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    await waitFor(() => expect(fetchModelsForConfig).toHaveBeenCalledTimes(1));
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Edit matching rules" }),
    );
    await user.click(screen.getByRole("button", { name: "Already Enabled" }));
    await user.click(screen.getByRole("button", { name: "Save rules" }));

    await waitFor(() => {
      const savedPlan = vi
        .mocked(providersApi.update)
        .mock.calls.map(([updated]) => updated)
        .find((updated) => updated.id === plan.id);
      expect(savedPlan).toBeDefined();
      if (!savedPlan) throw new Error("未捕获到停用 route 的保存请求");
      expect(readCodexRouting(savedPlan)?.routes?.[0]?.enabled).toBe(false);
      expect(savedPlan.settingsConfig).not.toHaveProperty("modelCatalog");
    });

    await act(async () => {
      modelRefresh.resolve([
        { id: "late-model", ownedBy: "save-race", contextWindow: 128000 },
      ]);
      await Promise.resolve();
    });
    expect(
      vi
        .mocked(providersApi.update)
        .mock.calls.some(([updated]) => updated.id === provider.id),
    ).toBe(false);

    await act(async () => {
      routeSave.resolve(true);
      await Promise.resolve();
    });
  });

  it("keeps a legacy inline OAuth route read-only during Provider catalog refresh", async () => {
    vi.mocked(fetchCodexOauthModels).mockResolvedValue([
      { id: "gpt-5.5", ownedBy: "openai", contextWindow: 272000 },
      { id: "gpt-5.6-luna", ownedBy: "openai", contextWindow: 272000 },
      { id: "gpt-5.6-sol", ownedBy: "openai", contextWindow: 272000 },
      { id: "gpt-5.6-terra", ownedBy: "openai", contextWindow: 272000 },
    ]);
    const official: Provider = {
      id: "codex-official",
      name: "OpenAI Official",
      category: "official",
      settingsConfig: {
        modelCatalog: { models: [{ model: "gpt-5.5" }] },
      },
    };
    const planDraft = createDraftRoutingPlan([], []);
    const legacyRoute = normalizeCodexRouteForSave(
      {
        label: official.name,
        match: { models: ["gpt-5.5"], prefixes: ["gpt-"] },
      },
      0,
      new Set<string>(),
    );
    delete legacyRoute.targetProviderId;
    legacyRoute.upstream!.auth = { source: "managed_codex_oauth" };
    const legacyPlan: Provider = {
      ...planDraft,
      id: "codex-openai-router",
      name: "OpenAI Multi-Model Router",
      settingsConfig: {
        ...planDraft.settingsConfig,
        modelCatalog: {
          models: [{ model: "gpt-5.5" }],
          spawnAgentModels: ["gpt-5.5"],
        },
        codexRouting: {
          enabled: true,
          defaultRouteId: legacyRoute.id,
          routes: [legacyRoute],
        },
      },
    };

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [official, legacyPlan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: legacyPlan.id,
        initialProviderId: legacyPlan.id,
        initialTab: "routes",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    await waitFor(() =>
      expect(
        vi
          .mocked(providersApi.update)
          .mock.calls.some(([updated]) => updated.id === official.id),
      ).toBe(true),
    );
    expect(
      vi
        .mocked(providersApi.update)
        .mock.calls.some(([updated]) => updated.id === legacyPlan.id),
    ).toBe(false);
  });

  it("finishes later provider refreshes after an earlier refresh rerenders the routes page", async () => {
    const firstRefresh = createDeferred<FetchedModel[]>();
    const secondRefresh = createDeferred<FetchedModel[]>();
    vi.mocked(fetchModelsForConfig)
      .mockReturnValueOnce(firstRefresh.promise)
      .mockReturnValueOnce(secondRefresh.promise);
    const providerA: Provider = {
      id: "codex-source-a",
      name: "Provider A",
      category: "custom",
      settingsConfig: {
        baseUrl: "https://a.example/v1",
        auth: { OPENAI_API_KEY: "key-a" },
        modelCatalog: { models: [{ model: "old-a" }] },
      },
    };
    const providerB: Provider = {
      id: "codex-source-b",
      name: "Provider B",
      category: "custom",
      settingsConfig: {
        baseUrl: "https://b.example/v1",
        auth: { OPENAI_API_KEY: "key-b" },
        modelCatalog: { models: [{ model: "old-b" }] },
      },
    };
    const plan = createDraftRoutingPlan(
      [providerA, providerB],
      [providerA, providerB],
    );
    const usedRouteIds = new Set<string>();
    const routes = [
      normalizeCodexRouteForSave(
        {
          label: providerA.name,
          targetProviderId: providerA.id,
          match: { models: ["model-a"] },
        },
        0,
        usedRouteIds,
      ),
      normalizeCodexRouteForSave(
        {
          label: providerB.name,
          targetProviderId: providerB.id,
          match: { models: ["model-b"] },
        },
        1,
        usedRouteIds,
      ),
    ];
    const routedPlan: Provider = {
      ...plan,
      settingsConfig: {
        ...plan.settingsConfig,
        codexRouting: {
          enabled: true,
          defaultRouteId: routes[0].id,
          routes,
        },
      },
    };

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [providerA, providerB, routedPlan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: routedPlan.id,
        initialProviderId: routedPlan.id,
        initialTab: "routes",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    await waitFor(() => expect(fetchModelsForConfig).toHaveBeenCalledTimes(2));

    firstRefresh.resolve([{ id: "model-a", ownedBy: null }]);
    await waitFor(() =>
      expect(
        vi
          .mocked(providersApi.update)
          .mock.calls.some(([provider]) => provider.id === providerA.id),
      ).toBe(true),
    );

    secondRefresh.resolve([{ id: "model-b", ownedBy: null }]);
    await waitFor(() =>
      expect(
        vi
          .mocked(providersApi.update)
          .mock.calls.some(([provider]) => provider.id === providerB.id),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(screen.getAllByText("Read and updated 0 models.")).toHaveLength(2),
    );
  });

  it("reports a later provider refresh error after an earlier refresh rerenders the routes page", async () => {
    const firstRefresh = createDeferred<FetchedModel[]>();
    const secondRefresh = createDeferred<FetchedModel[]>();
    vi.mocked(fetchModelsForConfig)
      .mockReturnValueOnce(firstRefresh.promise)
      .mockReturnValueOnce(secondRefresh.promise);
    const providerA: Provider = {
      id: "codex-error-source-a",
      name: "Provider A",
      category: "custom",
      settingsConfig: {
        baseUrl: "https://a.example/v1",
        auth: { OPENAI_API_KEY: "key-a" },
        modelCatalog: { models: [{ model: "old-a" }] },
      },
    };
    const providerB: Provider = {
      id: "codex-error-source-b",
      name: "Provider B",
      category: "custom",
      settingsConfig: {
        baseUrl: "https://b.example/v1",
        auth: { OPENAI_API_KEY: "key-b" },
        modelCatalog: { models: [{ model: "old-b" }] },
      },
    };
    const plan = createDraftRoutingPlan(
      [providerA, providerB],
      [providerA, providerB],
    );
    const usedRouteIds = new Set<string>();
    const routes = [
      normalizeCodexRouteForSave(
        {
          label: providerA.name,
          targetProviderId: providerA.id,
          match: { models: ["model-a"] },
        },
        0,
        usedRouteIds,
      ),
      normalizeCodexRouteForSave(
        {
          label: providerB.name,
          targetProviderId: providerB.id,
          match: { models: ["model-b"] },
        },
        1,
        usedRouteIds,
      ),
    ];
    const routedPlan: Provider = {
      ...plan,
      settingsConfig: {
        ...plan.settingsConfig,
        codexRouting: {
          enabled: true,
          defaultRouteId: routes[0].id,
          routes,
        },
      },
    };

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [providerA, providerB, routedPlan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: routedPlan.id,
        initialProviderId: routedPlan.id,
        initialTab: "routes",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    await waitFor(() => expect(fetchModelsForConfig).toHaveBeenCalledTimes(2));

    firstRefresh.resolve([{ id: "model-a", ownedBy: null }]);
    await waitFor(() =>
      expect(
        vi
          .mocked(providersApi.update)
          .mock.calls.some(([provider]) => provider.id === providerA.id),
      ).toBe(true),
    );

    secondRefresh.reject(new Error("network timeout"));
    await waitFor(() =>
      expect(
        screen.getByText(
          "Model catalog read or write did not complete: Operation failed. Check the current configuration or see the logs for details.",
        ),
      ).toBeInTheDocument(),
    );
  });

  it("restarts provider refresh when the api key changes and ignores the stale request", async () => {
    const staleRefresh = createDeferred<FetchedModel[]>();
    const currentRefresh = createDeferred<FetchedModel[]>();
    vi.mocked(fetchModelsForConfig)
      .mockReturnValueOnce(staleRefresh.promise)
      .mockReturnValueOnce(currentRefresh.promise);
    const provider: Provider = {
      id: "codex-keyed-source",
      name: "Keyed Source",
      category: "custom",
      settingsConfig: {
        baseUrl: "https://keyed.example/v1",
        auth: { OPENAI_API_KEY: "old-key" },
        modelCatalog: { models: [{ model: "old-catalog" }] },
      },
    };
    const plan = createDraftRoutingPlan([provider], [provider]);
    const usedRouteIds = new Set<string>();
    const route = normalizeCodexRouteForSave(
      {
        label: provider.name,
        targetProviderId: provider.id,
        match: { models: ["new-model"] },
      },
      0,
      usedRouteIds,
    );
    const routedPlan: Provider = {
      ...plan,
      settingsConfig: {
        ...plan.settingsConfig,
        codexRouting: {
          enabled: true,
          defaultRouteId: route.id,
          routes: [route],
        },
      },
    };
    const props = {
      providers: [provider, routedPlan],
      isProxyRunning: true,
      isCodexTakeoverActive: true,
      activeProviderId: routedPlan.id,
      initialProviderId: routedPlan.id,
      initialTab: "routes" as const,
      onEditProvider: vi.fn(),
      onDeletePlan: vi.fn(),
      onCreateProvider: vi.fn(),
    };

    const { rerender } = renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, props),
    );
    await waitFor(() => expect(fetchModelsForConfig).toHaveBeenCalledTimes(1));

    const providerWithNewKey: Provider = {
      ...provider,
      settingsConfig: {
        ...provider.settingsConfig,
        auth: { OPENAI_API_KEY: "new-key" },
      },
    };
    rerender(
      React.createElement(
        QueryClientProvider,
        {
          client: new QueryClient({
            defaultOptions: { queries: { retry: false } },
          }),
        },
        React.createElement(CodexRouterWorkspacePage, {
          ...props,
          providers: [providerWithNewKey, routedPlan],
        }),
      ),
    );
    await waitFor(() => expect(fetchModelsForConfig).toHaveBeenCalledTimes(2));

    staleRefresh.resolve([{ id: "stale-model", ownedBy: null }]);
    await Promise.resolve();
    expect(
      vi
        .mocked(providersApi.update)
        .mock.calls.some(([savedProvider]) =>
          JSON.stringify(savedProvider.settingsConfig).includes("stale-model"),
        ),
    ).toBe(false);

    currentRefresh.resolve([
      { id: "old-catalog", ownedBy: null, contextWindow: 131072 },
    ]);
    await waitFor(() =>
      expect(
        vi
          .mocked(providersApi.update)
          .mock.calls.some(
            ([savedProvider]) =>
              savedProvider.id === provider.id &&
              JSON.stringify(savedProvider.settingsConfig).includes("131072"),
          ),
      ).toBe(true),
    );
    expect(
      vi
        .mocked(providersApi.update)
        .mock.calls.some(([savedProvider]) =>
          JSON.stringify(savedProvider.settingsConfig).includes("stale-model"),
        ),
    ).toBe(false);
  });

  it("settles a provider refresh when the model fetch ipc never returns", async () => {
    vi.useFakeTimers();
    vi.mocked(fetchModelsForConfig).mockReturnValue(new Promise(() => {}));
    const provider: Provider = {
      id: "codex-timeout-source",
      name: "Timeout Source",
      category: "custom",
      settingsConfig: {
        baseUrl: "https://timeout.example/v1",
        auth: { OPENAI_API_KEY: "key-timeout" },
        modelCatalog: { models: [{ model: "old-timeout" }] },
      },
    };
    const plan = withEnabledProviderRoute(
      createDraftRoutingPlan([provider], [provider]),
      provider,
    );

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [provider, plan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "routes",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchModelsForConfig).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      screen.getByText(
        /Model catalog read or write did not complete: Operation failed/i,
      ),
    ).toBeInTheDocument();
  });

  it("settles a provider refresh when saving fetched models never returns", async () => {
    vi.useFakeTimers();
    const saveRefresh = createDeferred<boolean>();
    vi.mocked(fetchModelsForConfig).mockResolvedValueOnce([
      { id: "model-from-upstream", ownedBy: null },
    ]);
    vi.mocked(providersApi.update).mockReturnValue(saveRefresh.promise);
    const provider: Provider = {
      id: "codex-save-timeout-source",
      name: "Save Timeout Source",
      category: "custom",
      settingsConfig: {
        baseUrl: "https://save-timeout.example/v1",
        auth: { OPENAI_API_KEY: "key-save-timeout" },
        modelCatalog: { models: [{ model: "old-save-timeout" }] },
      },
    };
    const plan = withEnabledProviderRoute(
      createDraftRoutingPlan([provider], [provider]),
      provider,
    );

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [provider, plan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "routes",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchModelsForConfig).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText("Read 1 models; writing them to local configuration..."),
    ).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      screen.getByText(
        /Model catalog read or write did not complete: Operation failed/i,
      ),
    ).toBeInTheDocument();

    saveRefresh.resolve(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(
      screen.queryByText("Read and updated 1 models."),
    ).not.toBeInTheDocument();
  });

  it("refreshes visible route picker candidates after provider catalog save without parent refetch", async () => {
    const refresh = createDeferred<FetchedModel[]>();
    vi.mocked(fetchModelsForConfig).mockReturnValueOnce(refresh.promise);
    const provider: Provider = {
      id: "codex-empty-catalog-source",
      name: "Empty Catalog Source",
      category: "custom",
      settingsConfig: {
        baseUrl: "https://empty-catalog.example/v1",
        auth: { OPENAI_API_KEY: "key-empty-catalog" },
        modelCatalog: { models: [] },
      },
    };
    const plan = withEnabledProviderRoute(
      createDraftRoutingPlan([provider], [provider]),
      provider,
    );

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [provider, plan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "routes",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    await waitFor(() => expect(fetchModelsForConfig).toHaveBeenCalledTimes(1));
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Edit matching rules" }));
    expect(
      screen.getByText(
        /No model catalog found\. Save first, then add a catalog in the model source\./,
      ),
    ).toBeInTheDocument();

    refresh.resolve([{ id: "fresh-route-model", ownedBy: null }]);
    await waitFor(() =>
      expect(
        vi
          .mocked(providersApi.update)
          .mock.calls.some(
            ([savedProvider]) =>
              savedProvider.id === provider.id &&
              JSON.stringify(savedProvider.settingsConfig).includes(
                "fresh-route-model",
              ),
          ),
      ).toBe(true),
    );

    await waitFor(() =>
      expect(screen.getByText("fresh-route-model")).toBeInTheDocument(),
    );
    expect(
      screen.queryByText(
        /No model catalog found\. Save first, then add a catalog in the model source\./,
      ),
    ).not.toBeInTheDocument();
  });

  it("persists a successful empty remote catalog instead of retaining routable stale models", async () => {
    vi.mocked(fetchModelsForConfig).mockResolvedValueOnce([]);
    const source: Provider = {
      id: "empty-remote-source",
      name: "Empty Remote Source",
      category: "custom",
      settingsConfig: {
        baseUrl: "https://empty.example/v1",
        auth: { OPENAI_API_KEY: "test-only-key" },
        config: 'model = "removed-model"\n',
        modelCatalog: {
          models: [{ model: "removed-model" }],
          spawnAgentModels: ["removed-model"],
        },
      },
    };
    const plan = withEnabledProviderRoute(
      createDraftRoutingPlan([source], [source]),
      source,
    );
    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [source, plan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "routes",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    await waitFor(() => expect(providersApi.update).toHaveBeenCalledOnce());
    const saved = vi.mocked(providersApi.update).mock.calls[0][0];
    expect(saved.id).toBe(source.id);
    expect(saved.settingsConfig.modelCatalog.models).toEqual([
      { model: "removed-model", enabled: false },
    ]);
    expect(saved.settingsConfig.modelCatalog.spawnAgentModels).toEqual([]);
    expect(saved.settingsConfig.config).not.toMatch(/^model\s*=/m);
    await screen.findByText("Read and updated 0 models.");
    await waitFor(() =>
      expect(
        screen.queryByText(/remote returned an empty list/),
      ).not.toBeInTheDocument(),
    );
  });

  it("preserves the saved catalog when OAuth fails and its fallback is empty", async () => {
    vi.mocked(fetchCodexOauthModels).mockRejectedValueOnce(
      new Error("offline"),
    );
    vi.mocked(fetchCodexOfficialFallbackModels).mockResolvedValueOnce([]);
    const source: Provider = {
      id: "failed-oauth-source",
      name: "Failed OAuth Source",
      category: "official",
      meta: {
        providerType: "codex_oauth",
        authBinding: {
          source: "managed_codex_oauth",
          accountId: "test-account",
        },
      },
      settingsConfig: {
        config: 'model = "saved-model"\n',
        modelCatalog: {
          models: [
            { model: "saved-model" },
            { model: "hidden-model", enabled: false },
          ],
          spawnAgentModels: ["saved-model"],
        },
      },
    };
    const plan = withEnabledProviderRoute(
      createDraftRoutingPlan([source], [source]),
      source,
    );
    const snapshot = JSON.stringify(source);
    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [source, plan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "routes",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    await screen.findByText(/the fallback official catalog also has no models/);
    expect(fetchCodexOauthModels).toHaveBeenCalledWith("test-account");
    expect(fetchCodexOfficialFallbackModels).toHaveBeenCalledOnce();
    expect(providersApi.update).not.toHaveBeenCalled();
    expect(JSON.stringify(source)).toBe(snapshot);
  });

  it("repairs a removed source default during successful refresh without selecting an excluded model", () => {
    const source: Provider = {
      id: "source-default",
      name: "Source Default",
      settingsConfig: {
        config: 'model = "removed-model"\nmodel_reasoning_effort = "medium"\n',
        model_catalog: {
          models: [
            { model: "removed-model" },
            { model: "hidden-model", enabled: false },
            { model: "included-model" },
          ],
        },
      },
    };
    const saved = providerWithFetchedModelCatalog(source, [
      { id: "hidden-model", ownedBy: null },
      { id: "included-model", ownedBy: null },
    ]);
    expect(saved.settingsConfig.config).toBe(
      'model = "included-model"\nmodel_reasoning_effort = "medium"\n',
    );
    expect(saved.settingsConfig.modelCatalog.models[0]).toMatchObject({
      model: "removed-model",
      enabled: false,
    });
    expect(saved.settingsConfig.modelCatalog.models[1]).toMatchObject({
      model: "hidden-model",
      enabled: false,
    });
    expect(source.settingsConfig.config).toContain('model = "removed-model"');
  });

  it("updates the Provider catalog without mutating a stale MultiRouter projection", async () => {
    vi.mocked(fetchModelsForConfig).mockResolvedValueOnce([
      { id: "kept-model", ownedBy: null, contextWindow: 128000 },
      { id: "removed-model", ownedBy: null, contextWindow: 64000 },
    ]);
    const provider: Provider = {
      id: "codex-curated-source",
      name: "Curated Source",
      category: "custom",
      settingsConfig: {
        baseUrl: "https://curated.example/v1",
        auth: { OPENAI_API_KEY: "key-curated" },
        modelCatalog: {
          models: [{ model: "kept-model" }],
          spawnAgentModels: ["kept-model", "removed-model"],
        },
      },
    };
    const plan = createDraftRoutingPlan([provider], [provider]);
    const route = normalizeCodexRouteForSave(
      {
        label: provider.name,
        targetProviderId: provider.id,
        match: { models: ["kept-model", "removed-model"] },
      },
      0,
      new Set<string>(),
    );
    const stalePlan: Provider = {
      ...plan,
      settingsConfig: {
        ...plan.settingsConfig,
        modelCatalog: {
          models: [{ model: "kept-model" }, { model: "removed-model" }],
          spawnAgentModels: ["removed-model"],
        },
        codexRouting: {
          enabled: true,
          defaultRouteId: route.id,
          routes: [route],
        },
      },
    };

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [provider, stalePlan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: stalePlan.id,
        initialProviderId: stalePlan.id,
        initialTab: "routes",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    await waitFor(() => expect(providersApi.update).toHaveBeenCalled());
    const savedProvider = vi
      .mocked(providersApi.update)
      .mock.calls.map(([saved]) => saved)
      .find((saved) => saved.id === provider.id)!;
    expect(
      savedProvider.settingsConfig.modelCatalog.models.map(
        (model: { model: string }) => model.model,
      ),
    ).toEqual(["kept-model"]);
    expect(savedProvider.settingsConfig.modelCatalog.spawnAgentModels).toEqual([
      "kept-model",
    ]);

    expect(
      vi
        .mocked(providersApi.update)
        .mock.calls.some(([saved]) => saved.id === stalePlan.id),
    ).toBe(false);
  });

  it("opens the Codex add-source flow when route picker has no model sources", async () => {
    const onCreateProvider = vi.fn();
    const plan = createDraftRoutingPlan([], []);
    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [plan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "routes",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider,
      }),
    );

    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Edit matching rules" }),
    );
    await user.click(screen.getByRole("button", { name: "Add model source" }));

    expect(onCreateProvider).toHaveBeenCalledTimes(1);
  });

  it("scrolls to the inline route picker after opening route editing", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    const provider: Provider = {
      id: "codex-qwen-scroll",
      name: "Qwen Scroll Source",
      category: "custom",
      settingsConfig: {
        modelCatalog: { models: [{ model: "qwen3.6" }] },
      },
    };
    const plan = createDraftRoutingPlan([provider], [provider]);
    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [provider, plan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "routes",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Edit matching rules" }));

    await waitFor(() =>
      expect(scrollIntoView).toHaveBeenCalledWith({
        behavior: "smooth",
        block: "nearest",
      }),
    );
  });

  it("resets the workspace scroll position when jumping between multirouter tabs", async () => {
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });
    const provider: Provider = {
      id: "codex-scroll-tab-source",
      name: "Scroll Tab Source",
      category: "custom",
      settingsConfig: {
        modelCatalog: { models: [{ model: "qwen3.6" }] },
      },
    };
    const plan = createDraftRoutingPlan([provider], [provider]);
    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [provider, plan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "overview",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    scrollTo.mockClear();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "View link status" }));

    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(0, 0));
  });

  it("keeps a visible alias when route page refreshes provider models from upstream ids", async () => {
    vi.mocked(fetchModelsForConfig).mockResolvedValueOnce([
      { id: "gpt-5.5", ownedBy: null, contextWindow: 272000 },
    ]);
    const provider: Provider = {
      id: "codex-thirdparty-gpt",
      name: "Third-party GPT",
      category: "custom",
      settingsConfig: {
        baseUrl: "https://thirdparty.example/v1",
        auth: { OPENAI_API_KEY: "key-thirdparty" },
        modelCatalog: {
          models: [
            {
              model: "gpt-5.5-thirdparty",
              upstreamModel: "gpt-5.5",
              displayName: "Third-party GPT",
            },
          ],
        },
      },
    };
    const plan = withEnabledProviderRoute(
      createDraftRoutingPlan([provider], [provider]),
      provider,
    );

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [provider, plan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "routes",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    await waitFor(() =>
      expect(
        vi.mocked(providersApi.update).mock.calls.some(([savedProvider]) => {
          if (savedProvider.id !== provider.id) return false;
          return (
            JSON.stringify(savedProvider.settingsConfig.modelCatalog.models) ===
            JSON.stringify([
              {
                model: "gpt-5.5-thirdparty",
                upstreamModel: "gpt-5.5",
                displayName: "Third-party GPT",
                contextWindow: 272000,
              },
            ])
          );
        }),
      ).toBe(true),
    );
  });

  it("uses Volcengine OpenAPI when the routes page refreshes AgentPlan models", async () => {
    vi.mocked(fetchModelsForConfig).mockResolvedValueOnce([
      { id: "ark-code-latest", ownedBy: "volcengine", contextWindow: 262144 },
    ]);
    const provider: Provider = {
      id: "codex-volcengine-agentplan",
      name: "火山 AgentPlan",
      category: "custom",
      meta: {
        partnerPromotionKey: "volcengine_agentplan",
        usage_script: {
          enabled: true,
          language: "javascript",
          code: "",
          accessKeyId: "ak-route-refresh",
          secretAccessKey: "sk-route-refresh",
        },
      },
      settingsConfig: {
        baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
        auth: {},
        modelCatalog: { models: [] },
      },
    };
    const plan = withEnabledProviderRoute(
      createDraftRoutingPlan([provider], [provider]),
      provider,
    );

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [provider, plan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "routes",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    await waitFor(() => expect(fetchModelsForConfig).toHaveBeenCalledTimes(1));
    expect(fetchModelsForConfig).toHaveBeenCalledWith(
      "https://ark.cn-beijing.volces.com/api/coding/v3",
      "",
      false,
      undefined,
      undefined,
      {
        action: "ListArkAgentPlanModel",
        accessKeyId: "ak-route-refresh",
        secretAccessKey: "sk-route-refresh",
      },
    );
    await waitFor(() =>
      expect(
        vi.mocked(providersApi.update).mock.calls.some(([savedProvider]) => {
          if (savedProvider.id !== provider.id) return false;
          return JSON.stringify(savedProvider.settingsConfig).includes(
            "ark-code-latest",
          );
        }),
      ).toBe(true),
    );
  });

  it("falls back to data-plane models for AgentPlan routes when AK/SK is missing but API Key exists", async () => {
    vi.mocked(fetchModelsForConfig).mockResolvedValueOnce([
      { id: "ark-code-latest", ownedBy: "volcengine", contextWindow: 262144 },
    ]);
    const provider: Provider = {
      id: "codex-volcengine-agentplan-api-key",
      name: "火山 AgentPlan",
      category: "custom",
      meta: {
        partnerPromotionKey: "volcengine_agentplan",
      },
      settingsConfig: {
        baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
        auth: { OPENAI_API_KEY: "sk-volc-route" },
        modelCatalog: { models: [] },
      },
    };
    const plan = withEnabledProviderRoute(
      createDraftRoutingPlan([provider], [provider]),
      provider,
    );

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [provider, plan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "routes",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    await waitFor(() => expect(fetchModelsForConfig).toHaveBeenCalledTimes(1));
    expect(fetchModelsForConfig).toHaveBeenCalledWith(
      "https://ark.cn-beijing.volces.com/api/coding/v3",
      "sk-volc-route",
      false,
      undefined,
      undefined,
      undefined,
    );
    await waitFor(() =>
      expect(
        vi.mocked(providersApi.update).mock.calls.some(([savedProvider]) => {
          if (savedProvider.id !== provider.id) return false;
          return JSON.stringify(savedProvider.settingsConfig).includes(
            "ark-code-latest",
          );
        }),
      ).toBe(true),
    );
  });

  it("does not force the workspace back to routes after the initial jump is consumed", async () => {
    const source: Provider = {
      id: "codex-qwen",
      name: "Qwen Local",
      category: "custom",
      settingsConfig: {
        modelCatalog: { models: [{ model: "qwen3.6" }] },
      },
    };
    const plan = createDraftRoutingPlan([source], [source]);
    const providers = [source, plan];
    const props = {
      providers,
      isProxyRunning: true,
      isCodexTakeoverActive: true,
      activeProviderId: plan.id,
      initialProviderId: plan.id,
      initialTab: "routes" as const,
      onEditProvider: vi.fn(),
      onDeletePlan: vi.fn(),
      onCreateProvider: vi.fn(),
    };

    const { rerender } = renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, props),
    );

    expect(screen.getByRole("tab", { name: "Route rules" })).toHaveAttribute(
      "data-state",
      "active",
    );

    const user = userEvent.setup();
    const statusTab = screen.getByRole("tab", { name: "Status" });
    await user.click(statusTab);
    await waitFor(() =>
      expect(statusTab).toHaveAttribute("data-state", "active"),
    );

    rerender(
      React.createElement(
        QueryClientProvider,
        {
          client: new QueryClient({
            defaultOptions: { queries: { retry: false } },
          }),
        },
        React.createElement(CodexRouterWorkspacePage, {
          ...props,
          providers: [...providers],
        }),
      ),
    );

    await waitFor(() =>
      expect(statusTab).toHaveAttribute("data-state", "active"),
    );
  });

  function createSubagentWorkspaceFixture() {
    const source: Provider = {
      id: "codex-deepseek",
      name: "DeepSeek",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [
            { model: "deepseek-v4-flash" },
            { model: "deepseek-v4-pro" },
            { model: "qwen3.8" },
          ],
        },
      },
    };
    const draftPlan = withEnabledProviderRoute(
      createDraftRoutingPlan([source], [source]),
      source,
    );
    const plan: Provider = {
      ...draftPlan,
      settingsConfig: {
        ...draftPlan.settingsConfig,
        modelCatalog: {
          models: [
            { model: "deepseek-v4-pro" },
            { model: "deepseek-v4-flash" },
            { model: "qwen3.8" },
          ],
          spawnAgentModels: ["deepseek-v4-pro", "deepseek-v4-flash"],
        },
        codexRouting: {
          ...draftPlan.settingsConfig?.codexRouting,
          subagentVersion: "v2",
          spawnAgentModels: ["deepseek-v4-pro", "deepseek-v4-flash"],
          subagentV2: {
            schemaVersion: 1,
            selectionPolicy: "balanced",
            profiles: {
              "deepseek-v4-flash": {
                model: "deepseek-v4-flash",
                enabled: true,
                questionnaire: {
                  taskStrengths: ["repository_exploration"],
                  optimization: "speed",
                  writeScope: "read_only",
                  preference: "preferred",
                  reasoningEffort: "medium",
                },
              },
            },
          },
        },
      },
    };
    return { source, plan };
  }

  function renderSubagentWorkspace(source: Provider, plan: Provider) {
    return renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [source, plan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "routes",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );
  }

  it.each([
    "settings",
    "rules",
    "follow-all",
    "candidates",
    "protocol",
  ] as const)(
    "reconciles stale catalog references through the %s save path",
    async (action) => {
      const fixture = createSubagentWorkspaceFixture();
      const source: Provider = {
        ...fixture.source,
        settingsConfig: {
          ...fixture.source.settingsConfig,
          modelCatalog: {
            models: [
              { model: "deepseek-v4-pro" },
              { model: "deepseek-v4-flash", enabled: false },
              { model: "qwen3.8" },
            ],
          },
        },
      };
      const plan: Provider = {
        ...fixture.plan,
        settingsConfig: {
          ...fixture.plan.settingsConfig,
          config: 'model = "removed-model"\n',
          codexRouting: {
            ...fixture.plan.settingsConfig.codexRouting,
            modelOrder: ["removed-model", "deepseek-v4-pro"],
            routes: fixture.plan.settingsConfig.codexRouting.routes.map(
              (route: Record<string, unknown>) => ({
                ...route,
                modelSelection: {
                  mode: "include",
                  models: [
                    "deepseek-v4-pro",
                    "deepseek-v4-flash",
                    "removed-model",
                  ],
                },
                aliases: { stale: "removed-model" },
              }),
            ),
          },
        },
      };
      const snapshot = JSON.stringify({ source, plan });
      renderSubagentWorkspace(source, plan);
      const user = userEvent.setup();
      if (action === "settings") {
        await user.click(screen.getByRole("button", { name: "Rename" }));
        await user.click(screen.getByRole("button", { name: "Save settings" }));
      } else if (action === "rules") {
        await user.click(
          screen.getByRole("button", { name: "Edit matching rules" }),
        );
        await user.click(screen.getByRole("button", { name: "Save rules" }));
      } else if (action === "follow-all") {
        await user.click(
          screen.getByRole("button", {
            name: "Follow all models automatically",
          }),
        );
      } else {
        await user.click(screen.getByRole("tab", { name: "Sub-Agent" }));
        if (action === "candidates") {
          await user.click(
            screen.getByRole("button", {
              name: /deepseek-v4-pro Top five #1/i,
            }),
          );
        }
        await user.click(
          screen.getByRole("button", {
            name: action === "protocol" ? "Enable V1" : "Save ordering",
          }),
        );
      }

      await waitFor(() => expect(providersApi.update).toHaveBeenCalledOnce());
      const saved = vi.mocked(providersApi.update).mock.calls[0][0];
      const routing = saved.settingsConfig.codexRouting;
      expect(saved.id).toBe(plan.id);
      expect(routing.routes[0].modelSelection).toEqual(
        action === "follow-all"
          ? { mode: "all" }
          : { mode: "include", models: ["deepseek-v4-pro"] },
      );
      expect(routing.routes[0].aliases).toEqual({});
      expect(routing.modelOrder).toEqual(["deepseek-v4-pro"]);
      expect(routing.spawnAgentModels).not.toContain("deepseek-v4-flash");
      expect(routing.subagentV2.profiles).not.toHaveProperty(
        "deepseek-v4-flash",
      );
      expect(saved.settingsConfig.config).toBe('model = "deepseek-v4-pro"\n');
      expect(saved.settingsConfig.modelCatalog).toBeUndefined();
      expect(JSON.stringify({ source, plan })).toBe(snapshot);
    },
  );

  it("disables an emptied include route and removes its default rather than broadening it to all", () => {
    const { source, plan } = createSubagentWorkspaceFixture();
    const hiddenSource: Provider = {
      ...source,
      settingsConfig: {
        ...source.settingsConfig,
        modelCatalog: {
          models: [{ model: "deepseek-v4-flash", enabled: false }],
        },
      },
    };
    const stalePlan: Provider = {
      ...plan,
      settingsConfig: {
        ...plan.settingsConfig,
        config:
          'model = "deepseek-v4-flash"\nmodel_reasoning_effort = "high"\n',
        codexRouting: {
          ...plan.settingsConfig.codexRouting,
          modelOrder: ["deepseek-v4-flash"],
          routes: plan.settingsConfig.codexRouting.routes.map(
            (route: Record<string, unknown>) => ({
              ...route,
              modelSelection: {
                mode: "include",
                models: ["deepseek-v4-flash"],
              },
            }),
          ),
        },
      },
    };
    const snapshot = JSON.stringify(stalePlan);
    const saved = reconcileCodexRoutingPlanForSave(
      stalePlan,
      new Map([[hiddenSource.id, hiddenSource]]),
    );
    expect(saved.settingsConfig.codexRouting.routes[0]).toMatchObject({
      enabled: false,
      modelSelection: { mode: "include", models: [] },
    });
    expect(saved.settingsConfig.codexRouting.modelOrder).toEqual([]);
    expect(saved.settingsConfig.codexRouting.spawnAgentModels).toEqual([]);
    expect(saved.settingsConfig.codexRouting.subagentV2.profiles).toEqual({});
    expect(saved.settingsConfig.config).toBe(
      'model_reasoning_effort = "high"\n',
    );
    expect(JSON.stringify(stalePlan)).toBe(snapshot);
  });

  it("moves Step 1: Configure V2 sub-agent models and capabilities into a dedicated top-level workspace tab", async () => {
    const { source, plan } = createSubagentWorkspaceFixture();
    renderSubagentWorkspace(source, plan);

    expect(
      within(screen.getByRole("tablist"))
        .getAllByRole("tab")
        .map((tab) => tab.textContent?.trim()),
    ).toEqual([
      "Overview",
      "Model sources",
      "Route rules",
      "Model order",
      "Sub-Agent",
      "Status",
      "Test release",
    ]);
    expect(
      screen.queryByText(
        "Step 1: Configure V2 sub-agent models and capabilities",
      ),
    ).not.toBeInTheDocument();

    await userEvent
      .setup()
      .click(screen.getByRole("tab", { name: "Sub-Agent" }));
    expect(
      await screen.findByText(
        "Step 1: Configure V2 sub-agent models and capabilities",
      ),
    ).toBeInTheDocument();
  });

  it("renders the active protocol as disabled and the inactive protocol as actionable", async () => {
    const { source, plan } = createSubagentWorkspaceFixture();
    const existingRoutes = plan.settingsConfig?.codexRouting?.routes ?? [];
    const existingV2 = plan.settingsConfig?.codexRouting?.subagentV2;
    renderSubagentWorkspace(source, plan);
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Sub-Agent" }));

    const activeV2 = screen.getByRole("button", { name: "V2 enabled" });
    const inactiveV1 = screen.getByRole("button", { name: "Enable V1" });
    expect(activeV2).toBeDisabled();
    expect(activeV2).toHaveClass("bg-muted");
    expect(inactiveV1).toBeEnabled();
    expect(inactiveV1).toHaveClass("bg-blue-600");
    expect(inactiveV1.closest('[data-subagent-protocol="v1"]')).toHaveClass(
      "border-sky-200",
      "bg-sky-50/70",
      "dark:border-sky-500/40",
      "dark:bg-sky-950/20",
    );
    expect(activeV2.closest('[data-subagent-protocol="v2"]')).toHaveClass(
      "border-emerald-300",
      "bg-emerald-50",
      "dark:border-emerald-500/60",
      "dark:bg-emerald-500/10",
    );

    await user.click(inactiveV1);

    await waitFor(() => expect(providersApi.update).toHaveBeenCalledOnce());
    const [updatedProvider, appType] = vi.mocked(providersApi.update).mock
      .calls[0];
    expect(appType).toBe("codex");
    expect(updatedProvider.settingsConfig?.codexRouting).toMatchObject({
      subagentVersion: "v1",
      routes: existingRoutes,
      subagentV2: existingV2,
    });
    expect(updatedProvider.settingsConfig).not.toHaveProperty("modelCatalog");
    expect(
      updatedProvider.settingsConfig?.codexRouting?.spawnAgentModels,
    ).toEqual(["deepseek-v4-pro", "deepseek-v4-flash"]);
    expect(screen.getByRole("button", { name: "V1 enabled" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Enable V2" })).toBeEnabled();
    expect(
      screen.getByText(
        /restart Codex Desktop\/app-server and create a new session/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText(/V1 direct model override/).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByText("Top five draggable candidates"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Save ordering" }),
    ).toBeInTheDocument();
  });

  it("configures V2 capabilities before selecting and saving the shared advertised model order", async () => {
    const { source, plan } = createSubagentWorkspaceFixture();
    const existingRouting = plan.settingsConfig?.codexRouting;
    renderSubagentWorkspace(source, plan);
    const user = userEvent.setup();

    await user.click(screen.getByRole("tab", { name: "Sub-Agent" }));

    const configureHeading = screen.getByText(
      "Step 1: Configure V2 sub-agent models and capabilities",
    );
    const orderHeading = screen.getByText(
      "Step 2: Choose the top five models shown in V2 tool instructions",
    );
    expect(
      configureHeading.compareDocumentPosition(orderHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.getByText("Top five draggable candidates"),
    ).toBeInTheDocument();

    expect(
      screen.getByRole("button", { name: "Drag qwen3.8" }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: /deepseek-v4-flash Top five #2/i }),
    );
    await user.click(screen.getByRole("button", { name: "Save ordering" }));

    await waitFor(() => expect(providersApi.update).toHaveBeenCalledOnce());
    const [savedProvider, appType] = vi.mocked(providersApi.update).mock
      .calls[0];
    expect(appType).toBe("codex");
    expect(savedProvider.settingsConfig).not.toHaveProperty("modelCatalog");
    expect(savedProvider.settingsConfig?.codexRouting).toMatchObject({
      enabled: existingRouting?.enabled,
      routes: existingRouting?.routes,
      subagentVersion: existingRouting?.subagentVersion,
      subagentV2: existingRouting?.subagentV2,
      spawnAgentModels: ["deepseek-v4-pro", "qwen3.8"],
    });
    expect(savedProvider.settingsConfig?.codexRouting.defaultRouteId).toBe(
      existingRouting?.defaultRouteId,
    );
  });

  it("disables protocol actions while switching and keeps the previous protocol after failure", async () => {
    const { source, plan } = createSubagentWorkspaceFixture();
    const switching = createDeferred<boolean>();
    vi.mocked(providersApi.update).mockReturnValueOnce(switching.promise);
    renderSubagentWorkspace(source, plan);
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Sub-Agent" }));

    await user.click(screen.getByRole("button", { name: "Enable V1" }));
    expect(screen.getByRole("button", { name: "Switching…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "V2 enabled" })).toBeDisabled();

    switching.reject(new Error("persist failed"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Switch failed:Operation failed. Check the current configuration or see the logs for details.",
    );
    expect(screen.getByRole("button", { name: "V2 enabled" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Enable V1" })).toBeEnabled();
    expect(
      screen.queryByText(/V1 direct model override/),
    ).not.toBeInTheDocument();
  });

  it("shows a missing V2 role model without hiding the routable role", async () => {
    const source: Provider = {
      id: "codex-deepseek-flash-only",
      name: "DeepSeek Flash only",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [{ model: "deepseek-v4-flash" }],
        },
      },
    };
    const plan = withEnabledProviderRoute(
      createDraftRoutingPlan([source], [source]),
      source,
    );

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [source, plan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "routes",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    await userEvent.click(screen.getByRole("tab", { name: "Sub-Agent" }));

    expect(screen.getByText("Routable")).toBeInTheDocument();
    expect(screen.getByText("Missing from catalog")).toBeInTheDocument();
  });

  it("recognizes alias-suffixed flash/pro role models as routable", async () => {
    const source: Provider = {
      id: "codex-deepseek-alias",
      name: "DeepSeek alias",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [
            { model: "DeepSeek-V4-Flash-DeepSeek" },
            { model: "DeepSeek-V4-Pro-DeepSeek" },
            { model: "deepseek-v4-flash-vision-exp" },
          ],
        },
      },
    };
    const plan = withEnabledProviderRoute(
      createDraftRoutingPlan([source], [source]),
      source,
    );

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [source, plan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "routes",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    await userEvent.click(screen.getByRole("tab", { name: "Sub-Agent" }));

    expect(screen.getAllByText("Routable")).toHaveLength(2);
    expect(screen.queryByText("Missing from catalog")).not.toBeInTheDocument();
  });

  it("treats the official deepseek-flash/deepseek-pro slugs as the role models", async () => {
    const source: Provider = {
      id: "codex-deepseek-official-slugs",
      name: "DeepSeek official slugs",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [{ model: "deepseek-flash" }, { model: "deepseek-pro" }],
        },
      },
    };
    const plan = withEnabledProviderRoute(
      createDraftRoutingPlan([source], [source]),
      source,
    );

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [source, plan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "routes",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    await userEvent.click(screen.getByRole("tab", { name: "Sub-Agent" }));

    expect(screen.getAllByText("Routable")).toHaveLength(2);
    expect(screen.queryByText("Missing from catalog")).not.toBeInTheDocument();
  });

  it("keeps the missing badge for the pro role when only the flash alias exists", async () => {
    const source: Provider = {
      id: "codex-deepseek-flash-alias-only",
      name: "DeepSeek flash alias only",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [{ model: "deepseek-flash" }],
        },
      },
    };
    const plan = withEnabledProviderRoute(
      createDraftRoutingPlan([source], [source]),
      source,
    );

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [source, plan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "routes",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    await userEvent.click(screen.getByRole("tab", { name: "Sub-Agent" }));

    expect(screen.getByText("Routable")).toBeInTheDocument();
    expect(screen.getByText("Missing from catalog")).toBeInTheDocument();
  });

  it("exposes a delete action for routing plans inside the workspace", async () => {
    const source: Provider = {
      id: "codex-qwen",
      name: "Qwen Local",
      category: "custom",
      settingsConfig: {
        modelCatalog: { models: [{ model: "qwen3.6" }] },
      },
    };
    const plan = createDraftRoutingPlan([source], [source]);
    const onDeletePlan = vi.fn();

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [source, plan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "routes",
        onEditProvider: vi.fn(),
        onDeletePlan,
        onCreateProvider: vi.fn(),
      }),
    );

    await userEvent
      .setup()
      .click(screen.getAllByRole("button", { name: "Delete" })[0]);

    expect(onDeletePlan).toHaveBeenCalledWith(plan);
  });

  it("creates a real routing plan instead of a plain model source", () => {
    const openai: Provider = {
      id: "codex-openai",
      name: "OpenAI",
      category: "official",
      settingsConfig: {
        modelCatalog: {
          models: [
            {
              model: "gpt-5.4-mini",
              displayName: "GPT 5.4 Mini",
              contextWindow: 128000,
            },
          ],
        },
      },
      meta: { apiFormat: "openai_responses" },
    };
    const qwen: Provider = {
      id: "codex-qwen",
      name: "Qwen Local",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [
            {
              model: "qwen3.6",
              displayName: "Qwen 3.6",
              contextWindow: 262144,
            },
          ],
        },
      },
      meta: { apiFormat: "openai_chat" },
    };

    const plan = createDraftRoutingPlan([openai, qwen], [openai, qwen]);

    expect(plan.id).toBe("codex-multirouter");
    expect(isRoutingPlan(plan)).toBe(true);
    expect(plan.settingsConfig.base_url).toBe("http://127.0.0.1:15721/v1");
    expect(plan.settingsConfig.baseUrl).toBe("http://127.0.0.1:15721/v1");
    expect(readCodexRouting(plan)?.enabled).toBe(true);
    expect(readCodexRouting(plan)?.routes).toEqual([]);
    expect(plan.settingsConfig).not.toHaveProperty("modelCatalog");
    expect(plan.settingsConfig.codexRouting).toMatchObject({
      schemaVersion: 2,
      spawnAgentModels: ["gpt-5.4-mini", "qwen3.6"],
    });
  });

  it("preserves catalog upstream models when creating and rebuilding routing plans", () => {
    const thirdParty: Provider = {
      id: "codex-thirdparty-gpt",
      name: "Third-party GPT",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [
            {
              model: "gpt-5.5-thirdparty",
              upstreamModel: "gpt-5.5",
              displayName: "Third-party GPT",
              contextWindow: 272000,
            },
          ],
        },
      },
      meta: { apiFormat: "openai_responses" },
    };

    const plan = createDraftRoutingPlan([thirdParty], [thirdParty]);
    const routes = [
      normalizeCodexRouteForSave(
        {
          label: thirdParty.name,
          targetProviderId: thirdParty.id,
          match: { models: ["gpt-5.5-thirdparty"], prefixes: [] },
        },
        0,
        new Set<string>(),
      ),
    ];

    expect(plan.settingsConfig).not.toHaveProperty("modelCatalog");
    expect(
      buildModelCatalogForRoutes(
        plan,
        routes,
        new Map([[thirdParty.id, thirdParty]]),
      ).models,
    ).toEqual([
      {
        model: "gpt-5.5-thirdparty",
        upstreamModel: "gpt-5.5",
        displayName: "Third-party GPT",
        contextWindow: 272000,
        apiFormat: "openai_responses",
        apiFormatSource: "provider",
        providerName: thirdParty.name,
      },
    ]);
  });

  it("prunes outdated releases only for an explicit model-order reset", () => {
    const source: Provider = {
      id: "catalog-source",
      name: "Catalog source",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [
            { model: "gpt-5.4" },
            { model: "gpt-5.5" },
            { model: "custom-alias" },
          ],
        },
      },
    };
    const plan = createDraftRoutingPlan([source], [source]);
    const route = {
      id: "catalog-route",
      enabled: true,
      targetProviderId: source.id,
      modelSelection: { mode: "all" as const },
      match: { models: [], prefixes: [] },
    };
    const providers = new Map([[source.id, source]]);

    expect(
      buildModelCatalogForRoutes(plan, [route], providers).models.map(
        (model) => model.model,
      ),
    ).toEqual(["gpt-5.4", "gpt-5.5", "custom-alias"]);
    const resetCatalog = buildModelCatalogForRoutes(plan, [route], providers, {
      pruneOutdatedModels: true,
    });
    expect(resetCatalog.models.map((model) => model.model)).toEqual([
      "gpt-5.5",
      "custom-alias",
    ]);
  });

  it("aliases duplicate provider models when saving manual multirouter routes", async () => {
    const official: Provider = {
      id: "codex-official",
      name: "OpenAI Official",
      category: "official",
      settingsConfig: {
        modelCatalog: { models: [{ model: "gpt-5.5" }] },
      },
      meta: { apiFormat: "openai_responses" },
    };
    const relay: Provider = {
      id: "codex-relay-gpt",
      name: "Relay GPT",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [
            {
              model: "gpt-5.5",
              displayName: "Relay GPT 5.5",
              upstreamModel: "gpt-5.5",
            },
          ],
        },
      },
      meta: { apiFormat: "openai_chat" },
    };
    const plan = createDraftRoutingPlan([official, relay], [official, relay]);
    const officialRoute = normalizeCodexRouteForSave(
      {
        label: official.name,
        targetProviderId: official.id,
        match: { models: ["gpt-5.5"], prefixes: ["gpt"] },
        upstream: { apiFormat: "openai_responses" },
      },
      0,
      new Set<string>(),
    );
    const routedPlan: Provider = {
      ...plan,
      settingsConfig: {
        ...plan.settingsConfig,
        codexRouting: {
          schemaVersion: 2,
          enabled: true,
          routes: [
            serializeCodexRouteV2(
              { ...officialRoute, modelSelection: { mode: "all" } },
              0,
            ),
          ],
        },
      },
    };

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [official, relay, routedPlan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: routedPlan.id,
        initialProviderId: routedPlan.id,
        initialTab: "routes",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Edit matching rules" }),
    );
    await user.click(screen.getByRole("button", { name: "Enabled" }));
    await user.click(screen.getByRole("button", { name: "Save rules" }));

    await waitFor(() => expect(providersApi.update).toHaveBeenCalled());
    const updateCalls = vi.mocked(providersApi.update).mock.calls;
    const savedPlan = updateCalls[updateCalls.length - 1]?.[0] as Provider;
    const savedRoutes = readCodexRouting(savedPlan)?.routes ?? [];
    const relayRoute = savedRoutes.find(
      (route) => route.targetProviderId === relay.id,
    );

    expect(savedPlan.settingsConfig).not.toHaveProperty("modelCatalog");
    expect(relayRoute?.modelSelection).toEqual({ mode: "all" });
    expect(relayRoute?.aliases).toEqual({
      "gpt-5.5-relay-gpt": "gpt-5.5",
    });
  });

  it("repairs duplicate exact route models before saving manual routes", () => {
    const official: Provider = {
      id: "codex-official",
      name: "OpenAI Official",
      category: "official",
      settingsConfig: {
        modelCatalog: { models: [{ model: "gpt-5.5" }] },
      },
      meta: { apiFormat: "openai_responses" },
    };
    const relay: Provider = {
      id: "codex-relay-gpt",
      name: "Relay GPT",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [
            {
              model: "gpt-5.5-relay-gpt",
              displayName: "Relay GPT 5.5",
              upstreamModel: "gpt-5.5",
            },
          ],
        },
      },
      meta: { apiFormat: "openai_chat" },
    };
    const plan = createDraftRoutingPlan([official, relay], [official, relay]);
    const usedRouteIds = new Set<string>();
    const badRoutes = [
      normalizeCodexRouteForSave(
        {
          id: "router-official",
          label: official.name,
          targetProviderId: official.id,
          match: { models: ["gpt-5.5"], prefixes: ["gpt"] },
          upstream: { apiFormat: "openai_responses" },
        },
        0,
        usedRouteIds,
      ),
      normalizeCodexRouteForSave(
        {
          id: "router-relay",
          label: relay.name,
          targetProviderId: relay.id,
          match: { models: ["gpt-5.5"], prefixes: ["gpt"] },
          upstream: { apiFormat: "openai_chat" },
        },
        1,
        usedRouteIds,
      ),
    ];

    const normalizedRoutes = normalizeCodexRoutesForVisibleModelAliases(
      plan,
      badRoutes,
      new Map([
        [official.id, official],
        [relay.id, relay],
      ]),
    );
    const catalog = buildModelCatalogForRoutes(
      plan,
      normalizedRoutes,
      new Map([
        [official.id, official],
        [relay.id, relay],
      ]),
    );

    expect(normalizedRoutes[0].match?.models).toEqual(["gpt-5.5"]);
    expect(normalizedRoutes[1].match?.models).toEqual(["gpt-5.5-relay-gpt"]);
    expect(normalizedRoutes[1].upstream?.modelMap).toEqual({
      "gpt-5.5-relay-gpt": "gpt-5.5",
    });
    expect(catalog.models.map((model) => model.model)).toEqual([
      "gpt-5.5",
      "gpt-5.5-relay-gpt",
    ]);
  });

  it("does not use a stale Router catalog to rewrite schema v2 route policy", () => {
    const source: Provider = {
      id: "relay",
      name: "Relay",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [
            {
              model: "new-visible",
              upstreamModel: "canonical-model",
            },
          ],
        },
      },
    };
    const plan: Provider = {
      id: "router",
      name: "Router",
      category: "custom",
      settingsConfig: {
        codexRouting: {
          schemaVersion: 2,
          enabled: true,
          routes: [],
        },
        modelCatalog: {
          models: [
            {
              model: "old-visible",
              upstreamModel: "canonical-model",
            },
          ],
        },
      },
    };
    const routes = [
      {
        id: "relay-route",
        enabled: true,
        targetProviderId: source.id,
        modelSelection: { mode: "include", models: ["old-visible"] },
        match: { models: ["old-visible"], prefixes: [] },
      },
    ] satisfies Parameters<
      typeof normalizeCodexRoutesForVisibleModelAliases
    >[1];

    const normalized = normalizeCodexRoutesForVisibleModelAliases(
      plan,
      routes,
      new Map([[source.id, source]]),
    );

    expect(normalized[0].match?.models).toEqual(["old-visible"]);
    expect(normalized[0].aliases ?? {}).toEqual({});
    expect(normalized[0].upstream?.modelMap).toBeUndefined();
  });

  it("treats an explicitly empty target catalog as authoritative", () => {
    const source: Provider = {
      id: "empty-catalog-source",
      name: "Empty Catalog Source",
      category: "custom",
      settingsConfig: {
        model: "stale-top-level-model",
        modelCatalog: { models: [] },
      },
    };
    const plan = createDraftRoutingPlan([source], [source]);
    const routes = [
      {
        id: "empty-source-route",
        enabled: true,
        targetProviderId: source.id,
        modelSelection: { mode: "all" },
        match: {
          models: ["stale-top-level-model"],
          prefixes: ["stale-"],
        },
      },
    ] satisfies Parameters<typeof buildModelCatalogForRoutes>[1];

    const rebuilt = buildModelCatalogForRoutes(
      plan,
      routes,
      new Map([[source.id, source]]),
    );

    expect(rebuilt.models).toEqual([]);
  });

  it("projects every Provider model capability with model overrides taking precedence", () => {
    const official: Provider = {
      id: "codex-official",
      name: "OpenAI Official",
      category: "official",
      settingsConfig: {
        contextWindow: 400000,
        inputModalities: ["text", "image"],
        codexCache: {
          cacheMode: "openai_prompt_cache",
          supportsPromptCacheKey: true,
        },
        reasoning: {
          supported: true,
          supportedEfforts: ["low", "medium", "high"],
          disableAllowed: false,
          upstream: { format: "none", parameter: "none" },
        },
        modelCatalog: {
          models: [
            {
              model: "gpt-5.6-luna",
              contextWindow: 272000,
              apiFormat: "openai_responses",
              supportsParallelToolCalls: true,
              baseInstructions: "Use the Provider model instructions.",
              codexUltra: { enabled: true, providerEffort: "max" },
              reasoning: {
                supported: true,
                supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
                disableAllowed: false,
                upstream: { format: "none", parameter: "none" },
              },
            },
          ],
        },
      },
      meta: { apiFormat: "openai_responses" },
    };
    const plan: Provider = {
      id: "codex-multirouter",
      name: "MultiRouter",
      category: "custom",
      settingsConfig: {
        codexRouting: {
          enabled: true,
          routes: [
            {
              id: "official",
              enabled: true,
              targetProviderId: official.id,
              modelSelection: { mode: "all" },
            },
          ],
        },
      },
    };

    const catalog = buildModelCatalogForRoutes(
      plan,
      readCodexRouting(plan)?.routes ?? [],
      new Map([[official.id, official]]),
    );

    expect(
      catalog.models.find((model) => model.model === "gpt-5.6-luna")?.reasoning
        ?.supportedEfforts,
    ).toContain("max");
    expect(
      catalog.models.find((model) => model.model === "gpt-5.6-luna"),
    ).toEqual(
      expect.objectContaining({
        contextWindow: 272000,
        inputModalities: ["text", "image"],
        apiFormat: "openai_responses",
        supportsParallelToolCalls: true,
        baseInstructions: "Use the Provider model instructions.",
        codexCache: {
          cacheMode: "openai_prompt_cache",
          supportsPromptCacheKey: true,
        },
        codexUltra: { enabled: true, providerEffort: "max" },
      }),
    );
  });

  it("does not expose provider catalog models that no saved route can match", () => {
    const official: Provider = {
      id: "codex-official",
      name: "OpenAI Official",
      category: "official",
      settingsConfig: {
        modelCatalog: { models: [{ model: "gpt-5.5" }] },
      },
      meta: { apiFormat: "openai_responses" },
    };
    const longnows: Provider = {
      id: "codex-longnows",
      name: "LongNows",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [
            { model: "claude-opus-4-8", contextWindow: 200000 },
            {
              model: "gpt-5.5-longnows-gpt",
              upstreamModel: "gpt-5.5",
              displayName: "LongNows GPT",
              contextWindow: 272000,
            },
          ],
        },
      },
      meta: { apiFormat: "openai_chat" },
    };
    const plan = createDraftRoutingPlan(
      [official, longnows],
      [official, longnows],
    );
    const routes = [
      normalizeCodexRouteForSave(
        {
          id: "router-codex-official",
          label: official.name,
          targetProviderId: official.id,
          match: { models: ["gpt-5.5"], prefixes: ["gpt"] },
          upstream: { apiFormat: "openai_responses" },
        },
        0,
        new Set<string>(),
      ),
      normalizeCodexRouteForSave(
        {
          id: "router-longnows-claude",
          label: longnows.name,
          targetProviderId: longnows.id,
          match: { models: ["claude-opus-4-8"], prefixes: ["claude"] },
          upstream: { apiFormat: "openai_chat" },
        },
        1,
        new Set<string>(),
      ),
    ];

    const catalog = buildModelCatalogForRoutes(
      plan,
      routes,
      new Map([
        [official.id, official],
        [longnows.id, longnows],
      ]),
    );

    expect(catalog.models.map((model) => model.model)).toEqual([
      "gpt-5.5",
      "claude-opus-4-8",
    ]);
    expect(
      catalog.models.find((model) => model.model === "gpt-5.5-longnows-gpt"),
    ).toBeUndefined();
  });

  it("reads legacy array codexRouting without clearing routes", () => {
    const plan: Provider = {
      id: "codex-multirouter",
      name: "Codex GPT + DeepSeek 自动路由",
      category: "custom",
      settingsConfig: {
        codexRouting: [
          {
            id: "router-codex-official",
            label: "OpenAI Official",
            providerId: "codex-official",
            models: ["gpt-5.5"],
          },
          {
            id: "router-deepseek",
            label: "DeepSeek",
            providerId: "codex-deepseek",
            modelPrefixes: ["deepseek-"],
          },
        ],
      },
    };

    const routing = readCodexRouting(plan);

    expect(isRoutingPlan(plan)).toBe(true);
    expect(routing?.enabled).toBe(true);
    expect(routing?.routes).toHaveLength(2);
    expect(routing?.routes?.[0].id).toBe("router-codex-official");
    expect(routing?.routes?.[0].targetProviderId).toBe("codex-official");
    expect(routing?.routes?.[0].match?.models).toEqual(["gpt-5.5"]);
    expect(routing?.routes?.[1].match?.prefixes).toEqual(["deepseek-"]);
  });

  it("keeps legacy provider references and dedupes equivalent route candidates", () => {
    const deepseek: Provider = {
      id: "deepseek",
      name: "DeepSeek",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [{ model: "deepseek-v4-flash" }],
        },
      },
    };
    const plan: Provider = {
      id: "codex-multirouter",
      name: "Legacy Router",
      category: "custom",
      settingsConfig: {
        codexRouting: [
          {
            id: "legacy-deepseek",
            label: "DeepSeek",
            provider: "deepseek",
            models: ["deepseek-v4-flash"],
          },
          {
            id: "router-deepseek",
            label: "DeepSeek",
            targetProviderId: "deepseek",
            match: { models: ["deepseek-v4-flash"] },
          },
        ],
      },
    };

    const routes = readCodexRouting(plan)?.routes ?? [];
    const deduped = dedupeCodexRoutesBySemanticProvider(routes, [deepseek]);

    expect(routes[0].targetProviderId).toBe("deepseek");
    expect(deduped).toHaveLength(1);
    expect(deduped[0].id).toBe("legacy-deepseek");
  });

  it("normalizes selected router candidates into visible routes and catalog models", () => {
    const qwen: Provider = {
      id: "codex-qwen",
      name: "Qwen Local",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [
            {
              model: "qwen3.6",
              displayName: "Qwen 3.6",
              contextWindow: 262144,
            },
          ],
        },
      },
      meta: { apiFormat: "openai_chat" },
    };
    const deepseek: Provider = {
      id: "codex-deepseek",
      name: "DeepSeek",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [
            {
              model: "deepseek-v4-flash",
              contextWindow: 1000000,
              inputModalities: ["text"],
              textOnly: true,
              supportsImage: false,
            },
          ],
        },
      },
      meta: { apiFormat: "openai_chat" },
    };
    const plan = createDraftRoutingPlan([qwen, deepseek], [qwen, deepseek]);
    const usedRouteIds = new Set<string>();
    const routes = [
      normalizeCodexRouteForSave(
        {
          label: "Qwen Local",
          targetProviderId: qwen.id,
          match: { models: ["qwen3.6"], prefixes: ["qwen"] },
          upstream: { apiFormat: "openai_chat" },
        },
        0,
        usedRouteIds,
      ),
      normalizeCodexRouteForSave(
        {
          label: "DeepSeek",
          targetProviderId: deepseek.id,
          match: { models: ["deepseek-v4-flash"], prefixes: ["deepseek"] },
          upstream: { apiFormat: "openai_chat" },
        },
        1,
        usedRouteIds,
      ),
    ];
    const savedPlan: Provider = {
      ...plan,
      settingsConfig: {
        ...plan.settingsConfig,
        modelCatalog: buildModelCatalogForRoutes(
          plan,
          routes,
          new Map([
            [qwen.id, qwen],
            [deepseek.id, deepseek],
          ]),
        ),
        codexRouting: {
          enabled: true,
          defaultRouteId: routes[0].id,
          routes,
        },
      },
    };

    expect(isRoutingPlan(savedPlan)).toBe(true);
    expect(readCodexRouting(savedPlan)?.routes).toHaveLength(2);
    expect(
      (readCodexRouting(savedPlan)?.routes ?? []).map((route) => route.id),
    ).toEqual(["codex-qwen", "codex-deepseek"]);
    expect(savedPlan.settingsConfig.modelCatalog.models).toEqual([
      {
        model: "qwen3.6",
        displayName: "Qwen 3.6",
        contextWindow: 262144,
        apiFormat: "openai_chat",
        apiFormatSource: "provider",
        providerName: qwen.name,
      },
      {
        model: "deepseek-v4-flash",
        contextWindow: 1000000,
        inputModalities: ["text"],
        textOnly: true,
        supportsImage: false,
        apiFormat: "openai_chat",
        apiFormatSource: "provider",
        providerName: deepseek.name,
        capabilities: { inputModalities: ["text"], textOnly: true },
      },
    ]);
    expect(savedPlan.settingsConfig.modelCatalog.spawnAgentModels).toEqual([
      "qwen3.6",
      "deepseek-v4-flash",
    ]);
  });

  it("adds and enables a new provider candidate without using select-all", async () => {
    const openai: Provider = {
      id: "codex-openai",
      name: "OpenAI Official",
      category: "custom",
      settingsConfig: {
        modelCatalog: { models: [{ model: "gpt-5.5" }] },
      },
    };
    const qwen: Provider = {
      id: "codex-qwen-local",
      name: "Qwen Local vLLM",
      category: "custom",
      settingsConfig: {
        modelCatalog: { models: [{ model: "qwen3.6" }] },
      },
    };
    const plan = createDraftRoutingPlan([openai, qwen], [openai, qwen]);
    const openaiRoute = normalizeCodexRouteForSave(
      {
        label: openai.name,
        targetProviderId: openai.id,
        match: { models: ["gpt-5.5"], prefixes: ["gpt"] },
      },
      0,
      new Set<string>(),
    );
    const routedPlan: Provider = {
      ...plan,
      settingsConfig: {
        ...plan.settingsConfig,
        codexRouting: {
          schemaVersion: 2,
          enabled: true,
          routes: [
            serializeCodexRouteV2(
              { ...openaiRoute, modelSelection: { mode: "all" } },
              0,
            ),
          ],
        },
      },
    };

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [openai, qwen, routedPlan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: routedPlan.id,
        initialProviderId: routedPlan.id,
        initialTab: "routes",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Edit matching rules" }),
    );
    await user.click(screen.getByRole("button", { name: "Enabled" }));
    await user.click(screen.getByRole("button", { name: "Save rules" }));

    await waitFor(() => expect(providersApi.update).toHaveBeenCalled());
    const updateCalls = vi.mocked(providersApi.update).mock.calls;
    const savedPlan = updateCalls[updateCalls.length - 1]?.[0];
    const savedRoutes = readCodexRouting(savedPlan as Provider)?.routes ?? [];
    const qwenRoute = savedRoutes.find(
      (route) => route.targetProviderId === qwen.id,
    );

    expect(savedRoutes).toHaveLength(2);
    expect(qwenRoute?.enabled).toBe(true);
    expect(qwenRoute?.modelSelection).toEqual({ mode: "all" });
  });

  it("rebuilds route catalog from current targets instead of keeping stale fallback models", () => {
    const qwen: Provider = {
      id: "codex-qwen-local",
      name: "Qwen Local vLLM",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [
            {
              model: "qwen3.6",
              displayName: "Qwen 3.6",
              contextWindow: 262144,
            },
          ],
        },
      },
    };
    const plan = createDraftRoutingPlan([], []);
    const stalePlan: Provider = {
      ...plan,
      settingsConfig: {
        ...plan.settingsConfig,
        modelCatalog: {
          models: [
            { model: "gpt-5.5" },
            { model: "gpt-5.4" },
            { model: "gpt-5.4-mini" },
            { model: "gpt-5.3-codex-spark" },
          ],
          spawnAgentModels: ["gpt-5.5", "gpt-5.4"],
        },
      },
    };
    const routes = [
      normalizeCodexRouteForSave(
        {
          label: qwen.name,
          targetProviderId: qwen.id,
          match: { models: ["qwen3.6"], prefixes: ["qwen"] },
        },
        0,
        new Set<string>(),
      ),
    ];

    const rebuilt = buildModelCatalogForRoutes(
      stalePlan,
      routes,
      new Map([[qwen.id, qwen]]),
    );

    expect(rebuilt.models).toEqual([
      {
        model: "qwen3.6",
        displayName: "Qwen 3.6",
        contextWindow: 262144,
        apiFormatSource: "provider",
        providerName: qwen.name,
      },
    ]);
    expect(rebuilt.spawnAgentModels).toEqual(["qwen3.6"]);
  });

  it("treats an explicit model selection as authoritative over stale match models", () => {
    const source: Provider = {
      id: "selection-source",
      name: "Selection Source",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [{ model: "alpha" }, { model: "beta" }],
        },
      },
    };
    const plan = createDraftRoutingPlan([], []);
    const route = {
      id: "selection-route",
      enabled: true,
      targetProviderId: source.id,
      modelSelection: { mode: "include" as const, models: ["alpha"] },
      match: { models: ["alpha", "beta"], prefixes: [""] },
    };

    expect(
      buildModelCatalogForRoutes(
        plan,
        [route],
        new Map([[source.id, source]]),
      ).models.map((model) => model.model),
    ).toEqual(["alpha"]);
  });

  it("projects only the current enabled provider catalog for automatic routes", () => {
    const source: Provider = {
      id: "automatic-source",
      name: "Automatic Source",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [{ model: "alpha" }, { model: "beta", enabled: false }],
        },
      },
    };
    const plan = createDraftRoutingPlan([], []);
    const route = {
      id: "automatic-route",
      enabled: true,
      targetProviderId: source.id,
      modelSelection: { mode: "all" as const },
      match: { models: ["alpha", "beta", "removed"], prefixes: [""] },
    };

    expect(
      buildModelCatalogForRoutes(
        plan,
        [route],
        new Map([[source.id, source]]),
      ).models.map((model) => model.model),
    ).toEqual(["alpha"]);
  });

  it.each(["all", "include", "historical-alias"] as const)(
    "projects only selected, available aliases targeting upstream IDs (%s)",
    (mode) => {
      const source: Provider = {
        id: "upstream-alias-source",
        name: "Upstream Alias Source",
        settingsConfig: {
          modelCatalog: {
            models: [
              { model: "picker-model", upstreamModel: "wire-model" },
              {
                model: "hidden-model",
                upstreamModel: "wire-hidden",
                enabled: false,
              },
            ],
          },
        },
      };
      const plan: Provider = {
        ...createDraftRoutingPlan([source], [source]),
        settingsConfig: {
          config: 'model = "fast"\n',
          codexRouting: {
            schemaVersion: 2,
            enabled: true,
            modelOrder: ["fast"],
            spawnAgentModels: ["fast"],
            routes: [
              {
                id: "alias-route",
                targetProviderId: source.id,
                modelSelection:
                  mode === "all"
                    ? { mode }
                    : {
                        mode: "include",
                        models:
                          mode === "historical-alias"
                            ? ["FAST", "hidden", "removed"]
                            : ["picker-model"],
                      },
                aliases: {
                  fast: "WIRE-MODEL",
                  hidden: "wire-hidden",
                  removed: "wire-removed",
                },
              },
            ],
          },
        },
      };
      const providers = new Map([[source.id, source]]);
      const snapshot = JSON.stringify(plan);
      expect(projectCodexModelCatalog(plan, providers).models).toEqual([
        expect.objectContaining({ model: "fast", upstreamModel: "wire-model" }),
      ]);
      const saved = reconcileCodexRoutingPlanForSave(plan, providers);
      expect(saved.settingsConfig.codexRouting).toMatchObject({
        modelOrder: ["fast"],
        spawnAgentModels: ["fast"],
        routes: [{ aliases: { fast: "WIRE-MODEL" } }],
      });
      expect(
        saved.settingsConfig.codexRouting.routes[0].modelSelection,
      ).toEqual(
        mode === "all"
          ? { mode: "all" }
          : { mode: "include", models: ["picker-model"] },
      );
      expect(saved.settingsConfig.config).toBe('model = "fast"\n');
      expect(reconcileCodexRoutingPlanForSave(saved, providers)).toEqual(saved);
      expect(JSON.stringify(plan)).toBe(snapshot);
    },
  );

  it("uses target provider catalogs when building routed sub-agent candidates", () => {
    const source: Provider = {
      id: "candidate-source",
      name: "Candidate Source",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [{ model: "alpha" }, { model: "beta" }],
        },
      },
    };
    const router: Provider = {
      id: "candidate-router",
      name: "Candidate Router",
      category: "custom",
      settingsConfig: {},
    };
    const routes = [
      {
        provider: router,
        index: 0,
        route: {
          id: "candidate-route",
          enabled: true,
          targetProviderId: source.id,
          modelSelection: { mode: "include" as const, models: ["alpha"] },
          match: { models: ["alpha", "beta"], prefixes: [""] },
        },
      },
    ];

    expect(
      collectRoutedCatalogModels(
        routes,
        [{ model: "alpha" }, { model: "beta" }],
        new Map([
          [router.id, router],
          [source.id, source],
        ]),
      ),
    ).toEqual(["alpha"]);
  });

  it("excludes stale aliases and legacy matches from routed sub-agent candidates", () => {
    const source: Provider = {
      id: "candidate-source",
      name: "Candidate Source",
      settingsConfig: {
        modelCatalog: {
          models: [
            { model: "alpha", upstreamModel: "wire-alpha" },
            { model: "hidden", enabled: false },
          ],
        },
      },
    };
    const router = createDraftRoutingPlan([], []);
    const providers = new Map([[source.id, source]]);
    const catalog = [
      { model: "alpha" },
      { model: "fast" },
      { model: "removed-alias" },
      { model: "hidden" },
      { model: "removed" },
    ];
    const includeRoute = {
      id: "include",
      targetProviderId: source.id,
      modelSelection: {
        mode: "include" as const,
        models: ["alpha", "removed", "hidden"],
      },
      aliases: { fast: "wire-alpha", "removed-alias": "removed" },
    };
    const legacyRoute = {
      id: "legacy",
      upstream: {
        providerId: source.id,
        modelMap: { fast: "wire-alpha", "removed-alias": "removed" },
      },
      match: {
        models: ["fast", "removed-alias", "hidden", "removed"],
        prefixes: ["removed"],
      },
    };

    expect(
      collectRoutedCatalogModels(
        [{ provider: router, index: 0, route: includeRoute }],
        catalog,
        providers,
      ),
    ).toEqual(["alpha", "fast"]);
    expect(
      collectRoutedCatalogModels(
        [{ provider: router, index: 0, route: legacyRoute }],
        catalog,
        providers,
      ),
    ).toEqual(["fast"]);
  });

  it("does not resurrect stale v2 match models when a target catalog is empty", () => {
    const source: Provider = {
      id: "empty-target",
      name: "Empty Target",
      category: "custom",
      settingsConfig: {
        modelCatalog: { models: [] },
      },
    };
    const plan = createDraftRoutingPlan([], []);
    const route = {
      id: "empty-target-route",
      enabled: true,
      targetProviderId: source.id,
      modelSelection: { mode: "all" as const },
      match: { models: ["removed-model"], prefixes: ["removed-"] },
    };

    expect(
      buildModelCatalogForRoutes(plan, [route], new Map([[source.id, source]]))
        .models,
    ).toEqual([]);
    expect(
      collectRoutedCatalogModels(
        [{ provider: plan, index: 0, route }],
        [{ model: "removed-model" }],
        new Map([[source.id, source]]),
      ),
    ).toEqual([]);
  });

  it("does not resurrect stale v2 match models when the target catalog is missing", () => {
    const source: Provider = {
      id: "missing-target",
      name: "Missing Target",
      category: "custom",
      settingsConfig: {},
    };
    const plan: Provider = {
      ...createDraftRoutingPlan([], []),
      settingsConfig: {
        ...createDraftRoutingPlan([], []).settingsConfig,
        codexRouting: {
          schemaVersion: 2,
          enabled: true,
          routes: [],
        },
      },
    };
    const route = {
      id: "missing-target-route",
      enabled: true,
      targetProviderId: source.id,
      modelSelection: { mode: "all" as const },
      match: { models: ["removed-model"], prefixes: ["removed-"] },
    };

    expect(
      buildModelCatalogForRoutes(plan, [route], new Map([[source.id, source]]))
        .models,
    ).toEqual([]);
  });

  it("keeps OpenAI/Codex providers empty until their OAuth catalog is fetched", () => {
    const officialBackup: Provider = {
      id: "codex-official-backup",
      name: "OpenAI Official Backup",
      category: "official",
      settingsConfig: { auth: {}, config: "" },
    };

    const plan = createDraftRoutingPlan([officialBackup], [officialBackup]);

    expect(plan.settingsConfig).not.toHaveProperty("modelCatalog");
    expect(plan.settingsConfig.codexRouting.spawnAgentModels ?? []).toEqual([]);
  });

  it("rebuilds an official route from the dynamically persisted OAuth catalog", () => {
    const officialBackup: Provider = {
      id: "codex-official-backup",
      name: "OpenAI Official Backup",
      category: "official",
      settingsConfig: {
        auth: {},
        config: "",
        modelCatalog: {
          models: [{ model: "gpt-5.6-sol", contextWindow: 372000 }],
        },
      },
    };
    const plan = createDraftRoutingPlan([officialBackup], [officialBackup]);
    const routes = [
      normalizeCodexRouteForSave(
        {
          label: officialBackup.name,
          targetProviderId: officialBackup.id,
          match: { models: ["gpt-5.6-sol"], prefixes: ["gpt-"] },
        },
        0,
        new Set<string>(),
      ),
    ];

    const rebuilt = buildModelCatalogForRoutes(
      plan,
      routes,
      new Map([[officialBackup.id, officialBackup]]),
    );

    expect(rebuilt.models).toContainEqual({
      model: "gpt-5.6-sol",
      contextWindow: 372000,
      apiFormatSource: "provider",
      providerName: officialBackup.name,
    });
  });

  it("excludes disabled routes from the injected model catalog", () => {
    const enabled: Provider = {
      id: "qwen-enabled",
      name: "Qwen Enabled",
      category: "custom",
      settingsConfig: {
        modelCatalog: { models: [{ model: "qwen3.6" }] },
      },
    };
    const disabled: Provider = {
      id: "openai-disabled",
      name: "OpenAI Disabled",
      category: "official",
      settingsConfig: {
        modelCatalog: { models: [{ model: "gpt-5.5" }] },
      },
    };
    const plan = createDraftRoutingPlan(
      [enabled, disabled],
      [enabled, disabled],
    );

    const rebuilt = buildModelCatalogForRoutes(
      plan,
      [
        {
          id: "qwen-route",
          enabled: true,
          targetProviderId: enabled.id,
          match: { models: ["qwen3.6"], prefixes: [] },
          upstream: { apiFormat: "openai_responses" },
        },
        {
          id: "openai-route",
          enabled: false,
          targetProviderId: disabled.id,
          match: { models: ["gpt-5.5"], prefixes: ["gpt-"] },
          upstream: { apiFormat: "openai_responses" },
        },
      ],
      new Map([
        [enabled.id, enabled],
        [disabled.id, disabled],
      ]),
    );

    expect(rebuilt.models.map((model) => model.model)).toEqual(["qwen3.6"]);
  });

  it("ignores a stale Router catalog and follows Provider order and routing policy", () => {
    const source: Provider = {
      id: "sorted-source",
      name: "Sorted Source",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [
            { model: "model-a", sortIndex: 0 },
            { model: "model-b", sortIndex: 1 },
          ],
        },
      },
    };
    const plan: Provider = {
      ...createDraftRoutingPlan([source], [source]),
      settingsConfig: {
        codexRouting: {
          schemaVersion: 2,
          enabled: true,
          spawnAgentModels: ["model-b"],
          routes: [],
        },
        modelCatalog: {
          models: [
            { model: "model-a", sortIndex: 1 },
            { model: "model-b", sortIndex: 0 },
          ],
          spawnAgentModels: ["model-a"],
        },
      },
    };

    const rebuilt = buildModelCatalogForRoutes(
      plan,
      [
        {
          id: "sorted-route",
          enabled: true,
          targetProviderId: source.id,
          match: { models: ["model-a", "model-b"], prefixes: [] },
          upstream: { apiFormat: "openai_responses" },
        },
      ],
      new Map([[source.id, source]]),
    );

    expect(rebuilt.models).toEqual([
      expect.objectContaining({
        model: "model-a",
        providerName: source.name,
        apiFormatSource: "provider",
      }),
      expect.objectContaining({
        model: "model-b",
        providerName: source.name,
        apiFormatSource: "provider",
      }),
    ]);
    expect(rebuilt.models.every((model) => model.sortIndex === undefined)).toBe(
      true,
    );
    expect(rebuilt.spawnAgentModels).toEqual(["model-b", "model-a"]);
  });

  it("repairs stale aliases while resetting router ordering without changing the source", async () => {
    const source: Provider = {
      id: "order-source",
      name: "Order Source",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [
            { model: "model-a", sortIndex: 0 },
            { model: "model-b", sortIndex: 1 },
          ],
        },
      },
    };
    const plan = withEnabledProviderRoute(
      createDraftRoutingPlan([source], [source]),
      source,
    );
    const unavailableUpstreamModel = "stale-model";
    const route = normalizeCodexRouteForSave(
      {
        label: source.name,
        enabled: true,
        targetProviderId: source.id,
        modelSelection: { mode: "all" },
        match: {
          models: ["model-a", "model-b"],
          prefixes: [],
        },
        aliases: { "model-b": unavailableUpstreamModel },
        upstream: { auth: { source: "provider_config" } },
      },
      0,
      new Set<string>(),
    );
    const routedPlan: Provider = {
      ...plan,
      settingsConfig: {
        ...plan.settingsConfig,
        codexRouting: {
          ...plan.settingsConfig.codexRouting,
          modelOrder: ["model-b", "model-a"],
          routes: [serializeCodexRouteV2(route, 0)],
        },
      },
    };

    expect(
      projectCodexModelCatalog(
        routedPlan,
        new Map([[source.id, source]]),
      ).models.map((model) => model.model),
    ).toEqual(["model-b", "model-a"]);

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [source, routedPlan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: routedPlan.id,
        initialProviderId: routedPlan.id,
        initialTab: "model-order",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Restore default" }));

    await screen.findByText(/Restored newest-first model order/);
    expect(providersApi.update).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(providersApi.update).mock.calls[0][0];
    expect(saved.id).toBe(routedPlan.id);
    expect(saved.settingsConfig.codexRouting.modelOrder).toEqual([
      "model-a",
      "model-b",
    ]);
    expect(saved.settingsConfig.codexRouting.routes).toEqual(
      routedPlan.settingsConfig.codexRouting.routes.map(
        (route: Record<string, unknown>) => ({ ...route, aliases: {} }),
      ),
    );
    expect(source.settingsConfig.modelCatalog.models[0].sortIndex).toBe(0);
  });

  it.each([
    ["modelCatalog", true],
    ["model_catalog", true],
    ["modelCatalog", false],
    ["model_catalog", false],
  ] as const)(
    "reconciles source references when hiding a model (%s, remaining=%s)",
    async (catalogKey, hasRemainingModel) => {
      const source: Provider = {
        id: "visibility-source",
        name: "Visibility Source",
        category: "custom",
        settingsConfig: {
          config: 'model = "model-a"\nmodel_reasoning_effort = "high"\n',
          [catalogKey]: {
            models: [
              { model: "model-a" },
              ...(hasRemainingModel ? [{ model: "model-b" }] : []),
            ],
            spawn_agent_models: ["model-a", "model-b"],
            displayNameStyle: "model-provider",
            customMetadata: { preserved: true },
          },
          codexApiKeyGroups: [
            {
              id: "shared",
              apiKeys: ["test-key"],
              models: ["model-a", "model-b"],
            },
          ],
        },
        meta: {
          codexProtocolOverrides: {
            "model-a": "openai_chat",
            "model-b": "openai_responses",
          },
        },
      };
      const plan = withEnabledProviderRoute(
        createDraftRoutingPlan([source], [source]),
        source,
      );
      const snapshot = JSON.stringify(source);
      vi.spyOn(window, "confirm").mockReturnValue(true);

      renderWorkspace(
        React.createElement(CodexRouterWorkspacePage, {
          providers: [source, plan],
          isProxyRunning: true,
          isCodexTakeoverActive: true,
          activeProviderId: plan.id,
          initialProviderId: plan.id,
          initialTab: "model-order",
          onEditProvider: vi.fn(),
          onDeletePlan: vi.fn(),
          onCreateProvider: vi.fn(),
        }),
      );

      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "Remove model-a" }));

      await waitFor(() => expect(providersApi.update).toHaveBeenCalledOnce());
      const [saved, appType] = vi.mocked(providersApi.update).mock.calls[0];
      expect(appType).toBe("codex");
      expect(saved.id).toBe(source.id);
      expect(saved.settingsConfig.modelCatalog).toMatchObject({
        models: [
          { model: "model-a", enabled: false },
          ...(hasRemainingModel ? [{ model: "model-b" }] : []),
        ],
        spawnAgentModels: hasRemainingModel ? ["model-b"] : [],
        displayNameStyle: "model-provider",
        customMetadata: { preserved: true },
      });
      expect(saved.settingsConfig.modelCatalog).not.toHaveProperty(
        "spawn_agent_models",
      );
      expect(saved.settingsConfig).not.toHaveProperty("model_catalog");
      expect(saved.settingsConfig.config).toBe(
        hasRemainingModel
          ? 'model = "model-b"\nmodel_reasoning_effort = "high"\n'
          : 'model_reasoning_effort = "high"\n',
      );
      expect(saved.settingsConfig.codexApiKeyGroups[0].models).toEqual(
        hasRemainingModel ? ["model-b"] : [],
      );
      expect(saved.meta?.codexProtocolOverrides).toEqual(
        hasRemainingModel ? { "model-b": "openai_responses" } : {},
      );
      expect(JSON.stringify(source)).toBe(snapshot);
      expect(screen.getByText(/Hidden model-a;/)).toBeInTheDocument();
    },
  );

  it("reconciles source-owned policies and preserves metadata during catalog refresh", () => {
    const source: Provider = {
      id: "refresh-policy-source",
      name: "Refresh Policy Source",
      settingsConfig: {
        config: 'model = "removed"\n',
        model_catalog: {
          models: [
            { model: "kept", upstream_model: "wire-kept" },
            { model: "removed" },
          ],
          spawn_agent_models: ["removed", "wire-kept"],
          displayNameStyle: "provider-model",
          customMetadata: { preserved: true },
        },
        codexRouting: {
          schemaVersion: 2,
          enabled: true,
          routes: [
            {
              id: "local",
              targetProviderId: "refresh-policy-source",
              modelSelection: {
                mode: "include",
                models: ["removed", "wire-kept"],
              },
              aliases: { fast: "wire-kept", stale: "removed" },
            },
            {
              id: "unloaded",
              targetProviderId: "unloaded-source",
              modelSelection: { mode: "include", models: ["external-model"] },
            },
          ],
          modelOrder: ["removed", "wire-kept"],
          spawnAgentModels: ["removed", "wire-kept"],
          subagentV2: {
            profiles: {
              removed: { model: "removed" },
              kept: { model: "wire-kept" },
            },
          },
        },
      },
    };
    const snapshot = JSON.stringify(source);
    const saved = providerWithFetchedModelCatalog(source, [
      { id: "wire-kept", ownedBy: null },
    ]);

    expect(saved.settingsConfig.modelCatalog).toMatchObject({
      spawnAgentModels: ["kept"],
      displayNameStyle: "provider-model",
      customMetadata: { preserved: true },
    });
    expect(saved.settingsConfig).not.toHaveProperty("model_catalog");
    expect(saved.settingsConfig.codexRouting).toMatchObject({
      routes: [
        {
          id: "local",
          modelSelection: { mode: "include", models: ["kept"] },
          aliases: { fast: "kept" },
        },
        source.settingsConfig.codexRouting.routes[1],
      ],
      modelOrder: ["kept"],
      spawnAgentModels: ["kept"],
      subagentV2: { profiles: { kept: { model: "kept" } } },
    });
    expect(saved.settingsConfig.config).toBe('model = "kept"\n');
    expect(JSON.stringify(source)).toBe(snapshot);
  });

  it("hides an included picker model through its upstream route alias", async () => {
    const source: Provider = {
      id: "hide-alias-source",
      name: "Hide Alias Source",
      settingsConfig: {
        config: 'model = "picker-model"\n',
        modelCatalog: {
          models: [
            { model: "picker-model", upstreamModel: "wire-model" },
            { model: "not-selected" },
          ],
        },
      },
    };
    const plan: Provider = {
      ...createDraftRoutingPlan([source], [source]),
      settingsConfig: {
        codexRouting: {
          schemaVersion: 2,
          enabled: true,
          routes: [
            {
              id: "alias-route",
              targetProviderId: source.id,
              modelSelection: { mode: "include", models: ["picker-model"] },
              aliases: { fast: "WIRE-MODEL" },
            },
          ],
        },
      },
    };
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [source, plan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "model-order",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Remove fast" }));
    await waitFor(() => expect(providersApi.update).toHaveBeenCalledOnce());
    const saved = vi.mocked(providersApi.update).mock.calls[0][0];
    expect(saved.id).toBe(source.id);
    expect(saved.settingsConfig.modelCatalog.models).toEqual([
      { model: "picker-model", upstreamModel: "wire-model", enabled: false },
      { model: "not-selected" },
    ]);
    expect(saved.settingsConfig.config).toBe('model = "not-selected"\n');
  });

  it("does not resurrect a hidden model when refreshing the upstream catalog", () => {
    const source: Provider = {
      id: "refresh-hidden-source",
      name: "Refresh Hidden Source",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [{ model: "hidden-model", enabled: false, sortIndex: 3 }],
        },
      },
    };

    const refreshed = providerWithFetchedModelCatalog(source, [
      { id: "hidden-model", ownedBy: null, supportsImage: true },
    ]);

    expect(refreshed.settingsConfig?.modelCatalog?.models).toContainEqual(
      expect.objectContaining({
        model: "hidden-model",
        enabled: false,
        sortIndex: 3,
        supportsImage: true,
      }),
    );
  });

  it("disables a previously enabled model omitted by the refreshed upstream catalog", () => {
    const source: Provider = {
      id: "refresh-removed-source",
      name: "Refresh Removed Source",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [{ model: "kept-model" }, { model: "removed-model" }],
          spawnAgentModels: ["removed-model", "kept-model"],
        },
      },
    };

    const refreshed = providerWithFetchedModelCatalog(source, [
      { id: "kept-model", ownedBy: null },
    ]);

    expect(refreshed.settingsConfig?.modelCatalog?.models).toEqual([
      expect.objectContaining({ model: "kept-model" }),
      expect.objectContaining({ model: "removed-model", enabled: false }),
    ]);
    expect(refreshed.settingsConfig?.modelCatalog?.spawnAgentModels).toEqual([
      "kept-model",
    ]);
  });

  it("keeps independent key-group inventory during a single-key catalog refresh", () => {
    const source: Provider = {
      id: "grouped-source",
      name: "Grouped Source",
      settingsConfig: {
        codexApiKeyGroups: [
          { id: "other", apiKeys: ["other-key"], models: ["other-model"] },
        ],
        modelCatalog: {
          models: [{ model: "primary-model" }, { model: "other-model" }],
        },
      },
    };

    const refreshed = providerWithFetchedModelCatalog(source, [
      { id: "primary-model", ownedBy: null },
    ]);
    expect(refreshed.settingsConfig.modelCatalog.models).toEqual([
      { model: "primary-model" },
      { model: "other-model" },
    ]);
  });

  it("keeps newly discovered official models excluded when a curated inventory already exists", () => {
    const source: Provider = {
      id: "curated-official-refresh",
      name: "Curated Official",
      category: "official",
      settingsConfig: {
        auth: {},
        config: "",
        modelCatalog: {
          models: [
            { model: "kept-model" },
            { model: "hidden-model", enabled: false },
          ],
          spawnAgentModels: ["hidden-model", "kept-model"],
        },
      },
    };
    const refreshed = providerWithFetchedModelCatalog(source, [
      { id: "kept-model", ownedBy: null },
      { id: "hidden-model", ownedBy: null },
      { id: "new-model", ownedBy: null },
    ]);
    expect(refreshed.settingsConfig.modelCatalog.models).toEqual([
      expect.objectContaining({ model: "kept-model" }),
      expect.objectContaining({ model: "hidden-model", enabled: false }),
      expect.objectContaining({ model: "new-model", enabled: false }),
    ]);
    expect(refreshed.settingsConfig.modelCatalog.spawnAgentModels).toEqual([
      "kept-model",
    ]);
    const plan = withEnabledProviderRoute(
      createDraftRoutingPlan([refreshed], [refreshed]),
      refreshed,
    );
    expect(
      projectCodexModelCatalog(
        plan,
        new Map([[refreshed.id, refreshed]]),
      ).models.map((model) => model.model),
    ).toEqual(["kept-model"]);
  });

  it("refreshes an aliased catalog row by its upstream identity", () => {
    const source: Provider = {
      id: "aliased-refresh-source",
      name: "Aliased Refresh Source",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [
            {
              model: "gpt-6.1-sol-sublyx",
              upstreamModel: "gpt-6.1-sol",
              canonicalSlug: "gpt-6.1-sol",
            },
          ],
        },
      },
    };

    const refreshed = providerWithFetchedModelCatalog(source, [
      {
        id: "GPT-6.1-SOL",
        ownedBy: "OpenAI",
        contextWindow: 256000,
      },
    ]);

    expect(refreshed.settingsConfig?.modelCatalog?.models).toEqual([
      expect.objectContaining({
        model: "gpt-6.1-sol-sublyx",
        upstreamModel: "gpt-6.1-sol",
        contextWindow: 256000,
      }),
    ]);
  });

  it("applies official reasoning metadata when refreshing an OAuth model", () => {
    const source: Provider = {
      id: "official-source",
      name: "OpenAI Official",
      category: "official",
      settingsConfig: {
        modelCatalog: { models: [{ model: "gpt-6-astra" }] },
      },
    };
    const reasoning = {
      schemaVersion: 2,
      supportStatus: "confirmed_supported",
      controlKind: "graded",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "low",
      disableAllowed: false,
      upstream: {
        format: "string",
        parameter: "reasoning_effort",
        effortMap: { none: "low", minimal: "low" },
      },
      source: "official",
      confidence: "authoritative",
    };

    const refreshed = providerWithFetchedModelCatalog(source, [
      {
        id: "gpt-6-astra",
        ownedBy: "Codex",
        reasoning,
      } as unknown as FetchedModel,
    ]);

    expect(
      refreshed.settingsConfig?.modelCatalog?.models?.[0]?.reasoning,
    ).toEqual(reasoning);
  });

  it.each(["modelCatalog", "model_catalog"])(
    "restores the only hidden model without losing %s metadata",
    async (catalogKey) => {
      const source: Provider = {
        id: "hidden-only-source",
        name: "Hidden Only Source",
        category: "custom",
        settingsConfig: {
          config: 'model = "wire-hidden"\n',
          [catalogKey]: {
            models: [
              {
                model: "hidden-model",
                upstream_model: "wire-hidden",
                enabled: false,
              },
            ],
            spawn_agent_models: ["wire-hidden"],
            displayNameStyle: "provider-model",
            customMetadata: { preserved: true },
          },
        },
      };
      const plan = withEnabledProviderRoute(
        createDraftRoutingPlan([source], [source]),
        source,
      );

      renderWorkspace(
        React.createElement(CodexRouterWorkspacePage, {
          providers: [source, plan],
          isProxyRunning: true,
          isCodexTakeoverActive: true,
          activeProviderId: plan.id,
          initialProviderId: plan.id,
          initialTab: "model-order",
          onEditProvider: vi.fn(),
          onDeletePlan: vi.fn(),
          onCreateProvider: vi.fn(),
        }),
      );

      expect(
        await screen.findByText(/Hidden models \(1\)/),
      ).toBeInTheDocument();
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "Restore" }));

      await waitFor(() => {
        const updated = vi.mocked(providersApi.update).mock.calls.at(-1)?.[0];
        expect(updated?.id).toBe(source.id);
        expect(updated?.settingsConfig?.modelCatalog?.models).toEqual([
          { model: "hidden-model", upstream_model: "wire-hidden" },
        ]);
        expect(updated?.settingsConfig?.modelCatalog).toMatchObject({
          spawnAgentModels: ["hidden-model"],
          displayNameStyle: "provider-model",
          customMetadata: { preserved: true },
        });
        expect(updated?.settingsConfig).not.toHaveProperty("model_catalog");
        expect(updated?.settingsConfig?.config).toBe(
          'model = "hidden-model"\n',
        );
      });
    },
  );

  it("keeps unsaved route picker enabled draft state across candidate refreshes", () => {
    const currentEnabledIds = new Set(["openai-route"]);

    expect(
      Array.from(
        mergeRoutePickerDraftIds(
          currentEnabledIds,
          ["openai-route", "qwen-route"],
          ["openai-route", "qwen-route"],
          ["qwen-route"],
        ),
      ),
    ).toEqual(["openai-route"]);
  });

  it("applies route picker defaults only to newly discovered candidates", () => {
    const currentEnabledIds = new Set(["openai-route"]);

    expect(
      Array.from(
        mergeRoutePickerDraftIds(
          currentEnabledIds,
          ["openai-route", "qwen-route"],
          ["openai-route", "qwen-route", "deepseek-route"],
          ["qwen-route", "deepseek-route"],
        ),
      ),
    ).toEqual(["openai-route", "deepseek-route"]);
  });

  it("updates multirouter settings without dropping routes or model catalog", () => {
    const qwen: Provider = {
      id: "codex-qwen",
      name: "Qwen Local",
      category: "custom",
      settingsConfig: {
        modelCatalog: { models: [{ model: "qwen3.6" }] },
      },
    };
    const plan = createDraftRoutingPlan([qwen], [qwen]);
    const savedPlan: Provider = {
      ...plan,
      name: "Old MultiRouter",
      notes: "old notes",
      settingsConfig: {
        ...plan.settingsConfig,
        modelCatalog: {
          models: [{ model: "qwen3.6" }],
          spawnAgentModels: ["qwen3.6"],
        },
        codexRouting: {
          enabled: true,
          defaultRouteId: "codex-qwen",
          routes: [
            {
              id: "codex-qwen",
              label: "Qwen Local",
              enabled: true,
              targetProviderId: qwen.id,
              match: { models: ["qwen3.6"] },
            },
          ],
        },
      },
    };

    const updated = applyMultiRouterSettingsDraft(savedPlan, {
      name: "Daily MultiRouter",
      notes: "primary plan",
      enabled: false,
      hostedTools: {
        webSearch: false,
        imageGeneration: true,
      },
    });

    expect(updated.name).toBe("Daily MultiRouter");
    expect(updated.notes).toBe("primary plan");
    expect(updated.settingsConfig.base_url).toBe("http://127.0.0.1:15721/v1");
    expect(updated.settingsConfig.baseUrl).toBe("http://127.0.0.1:15721/v1");
    expect(updated.settingsConfig.modelCatalog).toEqual(
      savedPlan.settingsConfig.modelCatalog,
    );
    expect(readCodexRouting(updated)?.enabled).toBe(false);
    expect(readCodexRouting(updated)?.routes).toEqual(
      readCodexRouting(savedPlan)?.routes,
    );
    expect(readCodexRouting(updated)?.defaultRouteId).toBeUndefined();
    expect(updated.settingsConfig.hostedTools).toEqual({
      webSearch: { enabled: false },
      imageGeneration: { enabled: true },
    });
  });

  it("removes a stale derived catalog when saving schema v2 Router settings", () => {
    const plan: Provider = {
      id: "router-v2",
      name: "Router V2",
      category: "custom",
      settingsConfig: {
        codexRouting: {
          schemaVersion: 2,
          enabled: true,
          routes: [],
        },
        modelCatalog: {
          models: [{ model: "stale-model" }],
          spawnAgentModels: ["stale-model"],
        },
      },
    };

    const updated = applyMultiRouterSettingsDraft(plan, {
      name: plan.name,
      enabled: true,
      hostedTools: {
        webSearch: false,
        imageGeneration: false,
      },
    });

    expect(updated.settingsConfig).not.toHaveProperty("modelCatalog");
    expect(updated.settingsConfig).not.toHaveProperty("model_catalog");
  });

  it("normalizes listener config into a usable Codex proxy base url", () => {
    expect(buildCodexProxyBaseUrl("0.0.0.0", 15721)).toBe(
      "http://127.0.0.1:15721/v1",
    );
    expect(buildCodexProxyBaseUrl("::", 15721)).toBe("http://[::1]:15721/v1");

    expect(validateProxyListenDraft("127.0.0.1", "15721")).toEqual({
      ok: true,
      listenAddress: "127.0.0.1",
      listenPort: 15721,
      baseUrl: "http://127.0.0.1:15721/v1",
    });
    expect(validateProxyListenDraft("127.0.0.1", "abc")).toEqual({
      ok: false,
      error: "The listen port must be a number from 1024 to 65535.",
    });
  });

  it("preserves legacy authentication fields when saving unrelated Router settings", () => {
    const plan: Provider = {
      id: "legacy-router",
      name: "Legacy Router",
      category: "custom",
      settingsConfig: {
        codexRouting: {
          enabled: true,
          routes: [
            {
              id: "official",
              targetProviderId: "codex-official",
              match: { models: ["gpt-5.6"] },
              upstream: {
                apiFormat: "openai_responses",
                auth: {
                  source: "managed_codex_oauth",
                  authProvider: "codex_oauth",
                  accountId: "acct-old",
                },
              },
            },
            {
              id: "qwen",
              targetProviderId: "qwen",
              match: { models: ["qwen3.6"] },
              upstream: {
                apiFormat: "openai_chat",
                auth: { source: "provider_config" },
              },
            },
          ],
        },
      },
    };

    const updated = applyMultiRouterSettingsDraft(plan, {
      name: plan.name,
      enabled: true,
      hostedTools: {
        webSearch: true,
        imageGeneration: false,
      },
    });
    const routing = readCodexRouting(updated)!;

    expect(routing.officialAuth).toBeUndefined();
    expect(routing.routes?.[0].upstream?.auth).toEqual({
      source: "managed_codex_oauth",
      authProvider: "codex_oauth",
      accountId: "acct-old",
    });
    expect(routing.routes?.[1].upstream?.auth).toEqual({
      source: "provider_config",
    });
  });

  it("reports multirouter runtime state from current provider and takeover status", () => {
    const plan = createDraftRoutingPlan([], []);

    expect(
      buildMultiRouterRuntimeStatus({
        selectedPlan: plan,
        selectedRouting: readCodexRouting(plan),
        enabledRouteCount: 1,
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: "other-router",
      }).label,
    ).toBe("Not published");

    expect(
      buildMultiRouterRuntimeStatus({
        selectedPlan: plan,
        selectedRouting: readCodexRouting(plan),
        enabledRouteCount: 1,
        isProxyRunning: false,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
      }).label,
    ).toBe("Proxy not running");

    expect(
      buildMultiRouterRuntimeStatus({
        selectedPlan: plan,
        selectedRouting: readCodexRouting(plan),
        enabledRouteCount: 0,
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
      }).label,
    ).toBe("No enabled rules");

    expect(
      buildMultiRouterRuntimeStatus({
        selectedPlan: plan,
        selectedRouting: readCodexRouting(plan),
        enabledRouteCount: 1,
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
      }),
    ).toMatchObject({
      running: true,
      label: "Running",
      tone: "ok",
    });
  });

  it("keeps request health and stream retry activity in dedicated status views", async () => {
    const source: Provider = {
      id: "status-observability-source",
      name: "Status observability source",
      category: "custom",
      settingsConfig: {
        modelCatalog: { models: [{ model: "status-model" }] },
      },
    };
    const plan = withEnabledProviderRoute(
      createDraftRoutingPlan([source], [source]),
      source,
    );

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [source, plan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "status",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    expect(
      screen.queryByText("Live stream retry activity"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("stream-retry-header-toggle"),
    ).not.toBeInTheDocument();

    await userEvent.setup().click(
      screen.getByRole("button", {
        name: /request health|settings\.requestHealth\.title/i,
      }),
    );

    await waitFor(() =>
      expect(proxyApi.getRequestHealthDiagnostics).toHaveBeenCalledOnce(),
    );
    expect(
      screen.getByText(
        /request size and history|settings\.requestHealth\.monitoring/i,
      ),
    ).toBeInTheDocument();

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: /Live reconnect activity/i }));

    expect(screen.getAllByText("Live stream retry activity")).toHaveLength(1);
    expect(screen.getAllByTestId("stream-retry-activity-panel")).toHaveLength(
      1,
    );
  });

  // 当本地代理、Codex 接管、当前方案路由和最新真实转发都成功时，
  // Status页应在原地给出完成结果，不再触发 App 进入历史修复。
  it("shows runtime validation success in the workspace without a post-setup callback", async () => {
    const source: Provider = {
      id: "codex-online-source",
      name: "Online Source",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [{ model: "test-model" }],
        },
      },
    };
    const plan = createDraftRoutingPlan([source], [source]);
    const routes = [
      normalizeCodexRouteForSave(
        {
          label: source.name,
          targetProviderId: source.id,
          match: { models: ["test-model"] },
        },
        0,
        new Set<string>(),
      ),
    ];
    const routedPlan: Provider = {
      ...plan,
      settingsConfig: {
        ...plan.settingsConfig,
        codexRouting: {
          enabled: true,
          defaultRouteId: routes[0].id,
          routes,
        },
      },
    };
    requestLogsFixture.value = {
      data: {
        data: [
          createCodexProxyLog({
            providerId: "codex-online-source",
            model: "test-model",
            requestModel: "test-model",
          }),
        ],
        total: 1,
        page: 0,
        pageSize: 500,
      },
      isLoading: false,
    };

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [source, routedPlan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: routedPlan.id,
        initialProviderId: routedPlan.id,
        initialTab: "status",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    await waitFor(() =>
      expect(
        screen.getByText("MultiRouter verified with a real request"),
      ).toBeInTheDocument(),
    );
  });

  it("shows stale projection details and lets the user resync with readable provider names", async () => {
    const source: Provider = {
      id: "5626e6b9-33cb-4c3b-8d16-af8176e16209",
      name: "DeepSeek Relay",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [
            {
              model: "deepseek-v4-flash",
              upstreamModel: "deepseek-v4-flash-0731",
            },
          ],
        },
      },
    };
    const plan = createDraftRoutingPlan([source], [source]);
    const staleStatus: CodexRoutingProjectionStatus = {
      schemaVersion: 1,
      routerProviderId: plan.id,
      state: "pending",
      dependencyFingerprint: "stale-fingerprint",
      generatedAt: "2026-08-21T00:00:00Z",
      warnings: [],
      routes: [
        {
          routeId: `router-${source.id}`,
          routeLabel: `router-${source.id}`,
          targetProviderId: source.id,
          targetProviderName: source.name,
          visibleModel: "deepseek-v4-flash",
          canonicalModel: "deepseek-v4-flash",
          upstreamModel: "deepseek-v4-flash-0731",
          apiFormat: "openai_responses",
          apiFormatSource: "provider",
          authOwner: "provider_config",
          capabilitySources: {
            contextWindow: "provider_model",
            inputModalities: "provider_model",
            reasoning: "provider_model",
            codexCache: "provider_model",
          },
        },
      ],
      lastErrorCode: "projection_stale",
      lastError:
        "Codex MultiRouter projection dependencies changed and regeneration is required",
    };
    vi.mocked(
      providersApi.inspectCodexMultiRouterProjection,
    ).mockResolvedValueOnce(staleStatus);
    vi.mocked(
      providersApi.retryCodexMultiRouterProjection,
    ).mockResolvedValueOnce({
      ...staleStatus,
      state: "ready",
      dependencyFingerprint: "fresh-fingerprint",
      lastErrorCode: null,
      lastError: null,
    });

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [source, plan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "status",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    await waitFor(() =>
      expect(
        screen.getByText("MultiRouter catalog projection:Pending sync"),
      ).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByText("Current active mappings")).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/DeepSeek Relay \/ DeepSeek Relay/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/deepseek-v4-flash → deepseek-v4-flash-0731/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(`router-${source.id}`, { exact: true }),
    ).not.toBeInTheDocument();

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Resync catalog" }));

    await waitFor(() =>
      expect(providersApi.retryCodexMultiRouterProjection).toHaveBeenCalledWith(
        plan.id,
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByText("MultiRouter catalog projection:Synchronized"),
      ).toBeInTheDocument(),
    );
  });

  it("shows a visible result after refreshing multirouter validation state", async () => {
    const source: Provider = {
      id: "codex-refresh-source",
      name: "Refresh Source",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [{ model: "refresh-model" }],
        },
      },
    };
    const plan = createDraftRoutingPlan([source], [source]);

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [source, plan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "status",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Refresh validation" }));

    await waitFor(() =>
      expect(
        screen.getByText(/Validation status refreshed/i),
      ).toBeInTheDocument(),
    );
  });

  it("forces an official catalog refresh and reports the projection outcome", async () => {
    const source: Provider = {
      id: "official-refresh-source",
      name: "Official Source",
      category: "custom",
      settingsConfig: { modelCatalog: { models: [{ model: "gpt-6-sol" }] } },
    };
    const plan = createDraftRoutingPlan([source], [source]);
    vi.mocked(refreshCodexOfficialModelCatalog).mockResolvedValueOnce({
      source: "openai_codex_models_json",
      fetchedAt: "2026-09-23T03:00:00Z",
      modelCount: 11,
      usedStaleCache: false,
      projectionApplied: true,
      projectionReason: null,
      refreshError: null,
    });
    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [source, plan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "status",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );
    await userEvent.setup().click(
      screen.getByRole("button", {
        name: "Force refresh official model catalog",
      }),
    );
    await waitFor(() =>
      expect(refreshCodexOfficialModelCatalog).toHaveBeenCalledTimes(1),
    );
    expect(
      screen.getByText(
        /Official catalog refreshed successfully; the takeover catalog was regenerated/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/11 models/)).toBeInTheDocument();
    expect(screen.getByText(/2026-09-23T03:00:00Z/)).toBeInTheDocument();
    expect(
      screen.getByText(/Refresh the Codex model picker/),
    ).toBeInTheDocument();
  });

  it("keeps a stale official cache visibly distinct from a successful reprojection", async () => {
    const source: Provider = {
      id: "stale-refresh-source",
      name: "Stale Source",
      category: "custom",
      settingsConfig: { modelCatalog: { models: [{ model: "gpt-6-sol" }] } },
    };
    const plan = createDraftRoutingPlan([source], [source]);
    vi.mocked(refreshCodexOfficialModelCatalog).mockResolvedValueOnce({
      source: "stale_cache",
      fetchedAt: "2026-09-22T03:00:00Z",
      modelCount: 9,
      usedStaleCache: true,
      projectionApplied: false,
      projectionReason: "refresh_failed",
      refreshError: "upstream unavailable",
    });
    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [source, plan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "status",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );
    await userEvent.setup().click(
      screen.getByRole("button", {
        name: "Force refresh official model catalog",
      }),
    );
    await waitFor(() =>
      expect(refreshCodexOfficialModelCatalog).toHaveBeenCalledTimes(1),
    );
    expect(
      screen.getByText(/Official catalog refresh failed/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Using the previous cache for this run./),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Refresh the Codex model picker/),
    ).not.toBeInTheDocument();
  });

  it("does not claim both generated artifacts stayed unchanged after a projection error", async () => {
    const source: Provider = {
      id: "projection-error-source",
      name: "Projection Error Source",
      category: "custom",
      settingsConfig: { modelCatalog: { models: [{ model: "gpt-6-sol" }] } },
    };
    const plan = createDraftRoutingPlan([source], [source]);
    vi.mocked(refreshCodexOfficialModelCatalog).mockResolvedValueOnce({
      source: "openai_codex_models_json",
      fetchedAt: "2026-09-23T03:00:00Z",
      modelCount: 11,
      usedStaleCache: false,
      projectionApplied: false,
      projectionReason: "projection_outputs_unconfirmed",
      refreshError: "Catalog projection failed",
    });
    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [source, plan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "status",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );
    await userEvent.setup().click(
      screen.getByRole("button", {
        name: "Force refresh official model catalog",
      }),
    );
    await waitFor(() =>
      expect(refreshCodexOfficialModelCatalog).toHaveBeenCalledTimes(1),
    );
    expect(
      screen.getByText(
        /Catalog regeneration failed; dual-catalog sync was not confirmed/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/本次未修改 Codex 生成目录/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Refresh the Codex model picker/),
    ).not.toBeInTheDocument();
  });

  // Unlock model picker是 issue #10 的关键Restore动作，必须同时固定提示文案和真实 API 调用。
  it("explains and triggers the Codex model picker unlock action", async () => {
    const source: Provider = {
      id: "codex-unlock-source",
      name: "Unlock Source",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [{ model: "unlock-model" }],
        },
      },
    };
    const plan = createDraftRoutingPlan([source], [source]);
    vi.mocked(proxyApi.unlockCodexModelPicker).mockResolvedValueOnce({
      attemptedPorts: [9222],
      debugPort: 9222,
      targetId: "target-1",
      targetTitle: "Codex",
      targetUrl: "app://codex",
      modelCount: 1,
      modelNames: ["unlock-model"],
      injected: true,
      launched: false,
      codexExecutable: null,
      message: "已注入模型菜单白名单",
    });

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [source, plan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "status",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    expect(
      screen.getByText(
        /After enabling or confirming Codex takeover, CCSwitchMulti tries once automatically.*Unlock model menu.*CLI\/app-server catalog repair/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /CLI\/app-server catalog repair uses live config, model_catalog_json, and local \/v1\/models; lowercase codex\.exe does not need to be treated as a Desktop launch\./i,
      ),
    ).toBeInTheDocument();

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Unlock model picker" }));

    await waitFor(() =>
      expect(proxyApi.unlockCodexModelPicker).toHaveBeenCalledTimes(1),
    );
    expect(proxyApi.unlockCodexModelPicker).toHaveBeenCalledWith();
    expect(
      screen.getByText("Model picker allowlist injected"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        /After enabling or confirming Codex takeover, CCSwitchMulti tries once automatically.*Unlock model menu.*CLI\/app-server catalog repair/i,
      ),
    ).not.toBeInTheDocument();
  });

  // Desktop 主程序发现属于后端自动探测；前端只展示诊断路径，不记忆也不回传 exe。
  it("keeps Codex Desktop executable discovery owned by the backend", async () => {
    const source: Provider = {
      id: "codex-desktop-retry-source",
      name: "Desktop Retry Source",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [{ model: "desktop-model" }],
        },
      },
    };
    const plan = createDraftRoutingPlan([source], [source]);
    const codexExecutable =
      "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.623.141536.0_x64__2p2nqsd0c76g0\\app\\Codex.exe";
    vi.mocked(proxyApi.unlockCodexModelPicker)
      .mockResolvedValueOnce({
        attemptedPorts: [9229],
        debugPort: null,
        targetId: null,
        targetTitle: null,
        targetUrl: null,
        modelCount: 1,
        modelNames: ["desktop-model"],
        injected: false,
        launched: false,
        codexExecutable,
        message:
          "Codex Desktop is already running without an injectable CDP port.",
      })
      .mockResolvedValueOnce({
        attemptedPorts: [9229],
        debugPort: 9229,
        targetId: "desktop-target",
        targetTitle: "Codex",
        targetUrl: "app://codex",
        modelCount: 1,
        modelNames: ["desktop-model"],
        injected: true,
        launched: true,
        codexExecutable,
        message: "Codex Desktop model picker whitelist patch was injected.",
      });

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [source, plan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "status",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Unlock model picker" }),
    );

    await waitFor(() =>
      expect(
        screen.getByText("Model picker allowlist not injected"),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText(/Codex Desktop main process/)).toBeInTheDocument();
    expect(
      screen.getByText(/The Desktop path was captured.*Unlock model picker/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /switching third-party API keys does not require unlocking again/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /CLI\/app-server continues using live config, model_catalog_json, and the local \/v1\/models path\./i,
      ),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Unlock model picker" }),
    );

    await waitFor(() =>
      expect(proxyApi.unlockCodexModelPicker).toHaveBeenCalledTimes(2),
    );
    expect(proxyApi.unlockCodexModelPicker).toHaveBeenNthCalledWith(1);
    expect(proxyApi.unlockCodexModelPicker).toHaveBeenNthCalledWith(2);
    expect(
      screen.getByText("Model picker allowlist injected"),
    ).toBeInTheDocument();
  });

  // 找不到 Desktop 时只展示失败原因，避免把 CCSwitchMulti portable 误解成 Codex Desktop portable。
  it("shows unlock failures without offering a manual Codex.exe picker", async () => {
    const source: Provider = {
      id: "codex-desktop-missing-source",
      name: "Desktop Missing Source",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [{ model: "missing-desktop-model" }],
        },
      },
    };
    const plan = createDraftRoutingPlan([source], [source]);
    vi.mocked(proxyApi.unlockCodexModelPicker).mockRejectedValueOnce(
      new Error(
        "Codex Desktop executable was not found. Install the Codex Windows app from Microsoft Store.",
      ),
    );

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [source, plan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "status",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Unlock model picker" }),
    );

    await waitFor(() =>
      expect(
        screen.getByText(/Model picker unlock failed/),
      ).toBeInTheDocument(),
    );
    expect(proxyApi.unlockCodexModelPicker).toHaveBeenCalledWith();
    expect(
      screen.queryByRole("button", {
        name: "Unlock after selecting Codex.exe",
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/ccswitch\.codexDesktopExecutablePath/),
    ).not.toBeInTheDocument();
  });

  // 即使最近一条 Codex 代理日志成功，只要它没有命中当前 MultiRouter 方案的 route，
  // 就不能显示当前方案已通过真实请求验证。
  it("does not show runtime validation success when the latest request is outside the selected route", async () => {
    const source: Provider = {
      id: "codex-online-source",
      name: "Online Source",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [{ model: "test-model" }],
        },
      },
    };
    const unrelatedSource: Provider = {
      id: "codex-unrelated-source",
      name: "Unrelated Source",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [{ model: "other-model" }],
        },
      },
    };
    const plan = createDraftRoutingPlan([source], [source]);
    const routes = [
      normalizeCodexRouteForSave(
        {
          label: source.name,
          targetProviderId: source.id,
          match: { models: ["test-model"] },
        },
        0,
        new Set<string>(),
      ),
    ];
    const routedPlan: Provider = {
      ...plan,
      settingsConfig: {
        ...plan.settingsConfig,
        codexRouting: {
          enabled: true,
          defaultRouteId: routes[0].id,
          routes,
        },
      },
    };
    requestLogsFixture.value = {
      data: {
        data: [
          createCodexProxyLog({
            providerId: unrelatedSource.id,
            providerName: unrelatedSource.name,
            model: "other-model",
            requestModel: "other-model",
            statusCode: 200,
          }),
        ],
        total: 1,
        page: 0,
        pageSize: 500,
      },
      isLoading: false,
    };

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [source, unrelatedSource, routedPlan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: routedPlan.id,
        initialProviderId: routedPlan.id,
        initialTab: "status",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    await waitFor(() =>
      expect(screen.getByText("Success 200")).toBeInTheDocument(),
    );
    expect(
      screen.queryByText("Current plan succeeded"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("MultiRouter verified with a real request"),
    ).not.toBeInTheDocument();
  });
});
