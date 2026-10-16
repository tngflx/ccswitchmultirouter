import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import * as modelFetchApi from "@/lib/api/model-fetch";
import { describe, expect, it, vi } from "vitest";
import type { Provider } from "@/types";
import type { CodexProviderProtocolPreflightOutcome } from "@/lib/api/protocol-compatibility";
import type { ComponentProps } from "react";
import { providersApi } from "@/lib/api/providers";
import {
  buildWizardConnectivityResultsFromBatchOutcome,
  CodexMultiRouterWizard,
} from "./CodexMultiRouterWizard";

const {
  preflightCodexProviderProtocolCompatibility,
  prepareCodexProviderSetBatch,
  commitCodexProviderSetBatch,
  restoreCodexProviderProtocolEvidence,
} = vi.hoisted(() => ({
  preflightCodexProviderProtocolCompatibility: vi.fn(),
  prepareCodexProviderSetBatch: vi.fn(),
  commitCodexProviderSetBatch: vi.fn(),
  restoreCodexProviderProtocolEvidence: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/api/protocol-compatibility", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/api/protocol-compatibility")
  >()),
  preflightCodexProviderProtocolCompatibility,
  prepareCodexProviderSetBatch,
  commitCodexProviderSetBatch,
  restoreCodexProviderProtocolEvidence,
}));

vi.mock("@/components/providers/forms/hooks/useCodexOauth", () => ({
  useCodexOauth: () => ({
    accounts: [],
    hasAnyAccount: false,
    isLoadingStatus: false,
  }),
}));

vi.mock("@/lib/api/providers", () => ({
  providersApi: {
    getCodexMultiRouterRevision: vi.fn().mockResolvedValue("revision-1"),
    previewCodexMultiRouterMigration: vi.fn().mockResolvedValue({
      schemaVersion: 2,
      providerId: "router-b",
      expectedRevision: "revision-1",
      planToken: "opaque-token",
      diff: {
        removedRouteFields: ["upstream.apiFormat"],
        createdProviderIds: [],
        changedRouteIds: ["router-b-route"],
      },
      warnings: [],
      generatedProviders: [],
    }),
    applyCodexMultiRouterMigration: vi.fn(),
    getAll: vi.fn(),
    update: vi.fn(),
    add: vi.fn(),
  },
}));

function renderWizard(
  providers: Provider[],
  options?: {
    mode?: "create" | "edit";
    planId?: string;
    newlyCreatedProviderIds?: string[];
    onEnablePlan?: (provider: Provider) => Promise<void>;
    onOpenChange?: (open: boolean) => void;
    onOpenWorkspace?: ComponentProps<
      typeof CodexMultiRouterWizard
    >["onOpenWorkspace"];
  },
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = (
    open = true,
    nextProviders = providers,
    nextOptions = options,
  ) => (
    <QueryClientProvider client={queryClient}>
      <CodexMultiRouterWizard
        open={open}
        providers={nextProviders}
        mode={nextOptions?.mode ?? "create"}
        planId={nextOptions?.planId}
        newlyCreatedProviderIds={nextOptions?.newlyCreatedProviderIds}
        onOpenChange={nextOptions?.onOpenChange ?? vi.fn()}
        onCreateProvider={vi.fn()}
        onOpenProviderConfig={vi.fn()}
        onOpenWorkspace={nextOptions?.onOpenWorkspace ?? vi.fn()}
        onEnablePlan={nextOptions?.onEnablePlan ?? vi.fn()}
      />
    </QueryClientProvider>
  );
  const rendered = render(view());
  return {
    ...rendered,
    rerenderWizard: (
      open = true,
      nextProviders = providers,
      nextOptions = options,
    ) => rendered.rerender(view(open, nextProviders, nextOptions)),
  };
}

function protocolOutcome(
  source: Provider,
  models: Array<{
    model: string;
    transport: "open_ai_responses" | "open_ai_chat";
    verified?: boolean;
  }>,
  receiptModels: Record<string, string>,
): CodexProviderProtocolPreflightOutcome {
  return {
    provider: source,
    protocolApplied: false,
    adaptationPreview: {
      persistence: "single",
      status: "partial",
      effectiveTransport: null,
      models: [],
    },
    observations: [],
    receiptIds: Object.keys(receiptModels),
    receiptModels,
    records: models.map(({ model, transport, verified = true }) => ({
      probeVersion: 1,
      testedAt: 100,
      expiresAt: 4102444800,
      target: {
        provider_id: source.id,
        route_id: null,
        public_model: model,
        upstream_model: model,
        transport,
        authentication_kind: "bearer",
        endpoint_fingerprint: "endpoint",
        credential_fingerprint: "credential",
        request_policy_fingerprint: "policy",
      },
      result: {
        readiness: verified ? "verified" : "unverified",
        selected_transport: verified ? transport : null,
        branches: [],
      },
    })),
  };
}

function savedProtocolPlan(source: Provider): Provider {
  return {
    id: "partial-evidence-plan",
    name: "Partial Evidence Plan",
    settingsConfig: {
      codexRouting: {
        schemaVersion: 2,
        enabled: true,
        routes: [
          {
            id: "partial-route",
            targetProviderId: source.id,
            modelSelection: { mode: "all" },
          },
        ],
      },
    },
  };
}

describe("CodexMultiRouterWizard", () => {
  it("can repair a failed API-declared model without probing healthy declarations", async () => {
    const source: Provider = {
      id: "incorrect-api",
      name: "Incorrect API",
      settingsConfig: {
        baseUrl: "https://example.invalid/v1",
        auth: { OPENAI_API_KEY: "test-only" },
        modelCatalog: {
          models: ["incorrect", "healthy"].map((model) => ({
            model,
            protocolCapability: {
              schemaVersion: 1,
              source: "provider_api",
              baseUrl: "https://example.invalid/v1",
              upstreamModel: model,
              supportedEndpoints: ["openai_responses"],
            },
          })),
        },
      },
    };
    const plan = savedProtocolPlan(source);
    restoreCodexProviderProtocolEvidence.mockResolvedValueOnce(
      protocolOutcome(
        source,
        [
          {
            model: "incorrect",
            transport: "open_ai_responses",
            verified: false,
          },
        ],
        {},
      ),
    );
    let complete!: (outcome: CodexProviderProtocolPreflightOutcome) => void;
    preflightCodexProviderProtocolCompatibility.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    renderWizard([source, plan], { mode: "edit", planId: plan.id });
    fireEvent.click(
      screen.getByRole("button", { name: "Protocol deep probe" }),
    );
    await screen.findByText(/Saved records checked: reusing 1/);
    expect(
      screen.getByRole("button", { name: "Choose models" }),
    ).toHaveAttribute("data-read-only", "true");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Run compatibility deep probe again",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm test" }));
    await screen.findByText(/Validating models 0\/1;/);
    expect(preflightCodexProviderProtocolCompatibility).toHaveBeenCalledTimes(
      1,
    );
    await act(async () =>
      complete(
        protocolOutcome(
          source,
          [{ model: "incorrect", transport: "open_ai_chat" }],
          { "corrected-receipt": "incorrect" },
        ),
      ),
    );
    await screen.findByText("State machine:connectivityPartial");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Save and enable" }));
    expect(
      screen.getByRole("button", { name: "Save and publish" }),
    ).toBeEnabled();
  });

  it("keeps receipt associations when partial restoration has records without receipts", async () => {
    const source: Provider = {
      id: "partial-receipts",
      name: "Partial Receipts",
      settingsConfig: {
        baseUrl: "https://example.invalid/v1",
        auth: { OPENAI_API_KEY: "test-only" },
        modelCatalog: { models: [{ model: "a" }, { model: "b" }] },
      },
    };
    const plan = savedProtocolPlan(source);
    restoreCodexProviderProtocolEvidence.mockResolvedValueOnce(
      protocolOutcome(
        source,
        [
          { model: "a", transport: "open_ai_chat", verified: false },
          { model: "b", transport: "open_ai_responses" },
        ],
        { "receipt-b": "b" },
      ),
    );
    prepareCodexProviderSetBatch.mockResolvedValue({
      digest: "partial-receipts",
      sourcePreviews: [],
      blocked: false,
    });
    commitCodexProviderSetBatch.mockImplementation(async (sources, router) => ({
      router,
      editorRouter: router,
      sourceSnapshots: sources.map((item: { provider: Provider }) => ({
        logicalProvider: item.provider,
      })),
      projections: [],
      status: "committed",
    }));
    renderWizard([source, plan], { mode: "edit", planId: plan.id });
    fireEvent.click(
      screen.getByRole("button", { name: "Protocol deep probe" }),
    );
    await screen.findByText(/Saved records checked: reusing 1/);
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Keep Partial Receipts / a" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save and enable" }));
    fireEvent.click(screen.getByRole("button", { name: "Save and publish" }));
    await screen.findByText("State machine:published");
    expect(
      prepareCodexProviderSetBatch.mock.calls.at(-1)![0][0].receiptIds,
    ).toEqual(["receipt-b"]);
    expect(preflightCodexProviderProtocolCompatibility).not.toHaveBeenCalled();
  });

  it("preserves stronger saved evidence for API-declared models while probing unresolved models", async () => {
    const source: Provider = {
      id: "partial-model-evidence",
      name: "Partial Model Evidence",
      settingsConfig: {
        baseUrl: "https://example.invalid/v1",
        auth: { OPENAI_API_KEY: "test-only" },
        modelCatalog: {
          models: [
            {
              model: "a",
              protocolCapability: {
                schemaVersion: 1,
                source: "provider_api",
                baseUrl: "https://example.invalid/v1",
                upstreamModel: "a",
                supportedEndpoints: ["openai_responses"],
              },
            },
            { model: "b" },
          ],
        },
      },
    };
    const plan = savedProtocolPlan(source);
    restoreCodexProviderProtocolEvidence.mockResolvedValueOnce(
      protocolOutcome(source, [{ model: "a", transport: "open_ai_chat" }], {
        "receipt-a": "a",
      }),
    );
    preflightCodexProviderProtocolCompatibility.mockResolvedValueOnce(
      protocolOutcome(
        source,
        [{ model: "b", transport: "open_ai_responses" }],
        { "receipt-b": "b" },
      ),
    );
    renderWizard([source, plan], { mode: "edit", planId: plan.id });
    fireEvent.click(
      screen.getByRole("button", { name: "Protocol deep probe" }),
    );
    await screen.findByText(/Saved records checked: reusing 1/);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Run compatibility deep probe again",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm test" }));
    await screen.findByText("State machine:connectivityPassed");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Protocol deep probe" }),
    );
    expect(
      screen.getByText(
        "Full Codex transaction verified; selected Chat Completions.",
      ),
    ).toBeVisible();
    expect(
      screen.getByText("Full Codex transaction verified; selected Responses."),
    ).toBeVisible();
    expect(screen.queryByText(/Provider API declares/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save and enable" }));
    fireEvent.click(screen.getByRole("button", { name: "Save and publish" }));
    await screen.findByText("State machine:published");
    expect(
      prepareCodexProviderSetBatch.mock.calls.at(-1)![0][0].receiptIds,
    ).toEqual(["receipt-a", "receipt-b"]);
  });

  it("restores partial evidence, probes only the unresolved model, and reuses refreshed receipts", async () => {
    const source: Provider = {
      id: "partial-restoration",
      name: "Partial Restoration",
      settingsConfig: {
        baseUrl: "https://example.invalid/v1",
        auth: { OPENAI_API_KEY: "test-only" },
        modelCatalog: {
          models: [
            { model: "a" },
            { model: "b" },
            { model: "excluded", enabled: false },
          ],
        },
      },
    };
    const plan = savedProtocolPlan(source);
    const restoredA = protocolOutcome(
      source,
      [{ model: "a", transport: "open_ai_chat" }],
      { "receipt-a": "a" },
    );
    const probedB = protocolOutcome(
      source,
      [{ model: "b", transport: "open_ai_responses" }],
      { "receipt-b": "b" },
    );
    const restoredBoth = protocolOutcome(
      source,
      [
        { model: "a", transport: "open_ai_chat" },
        { model: "b", transport: "open_ai_responses" },
      ],
      { "fresh-receipt-a": "a", "fresh-receipt-b": "b" },
    );
    restoreCodexProviderProtocolEvidence
      .mockResolvedValueOnce(restoredA)
      .mockResolvedValueOnce(restoredBoth);
    const progressModels: string[] = [];
    let complete!: (outcome: CodexProviderProtocolPreflightOutcome) => void;
    preflightCodexProviderProtocolCompatibility.mockImplementationOnce(
      (_provider, onProgress) =>
        new Promise((resolve) => {
          onProgress({ kind: "candidate_started", model: "b" });
          progressModels.push("b");
          complete = resolve;
        }),
    );
    prepareCodexProviderSetBatch.mockImplementation(async () => ({
      digest: "partial-restoration",
      sourcePreviews: [],
      blocked: false,
    }));
    commitCodexProviderSetBatch.mockImplementation(async (sources, router) => ({
      router,
      editorRouter: router,
      sourceSnapshots: sources.map((item: { provider: Provider }) => ({
        logicalProvider: item.provider,
      })),
      projections: [],
      status: "committed",
    }));

    renderWizard([source, plan], { mode: "edit", planId: plan.id });
    fireEvent.click(
      screen.getByRole("button", { name: "Protocol deep probe" }),
    );
    await screen.findByText(/Saved records checked: reusing 1/);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Run compatibility deep probe again",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm test" }));

    expect(await screen.findByText(/Validating models 0\/1;/)).toBeVisible();
    expect(
      screen.queryByText(/Validating models 0\/2;/),
    ).not.toBeInTheDocument();
    expect(preflightCodexProviderProtocolCompatibility).toHaveBeenCalledTimes(
      1,
    );
    expect(progressModels).toEqual(["b"]);
    await act(async () => complete(probedB));
    expect(
      await screen.findByText(
        "Completed 1 models: Verified 1, Partial 0, Failed 0.",
      ),
    ).toBeVisible();
    expect(screen.queryByText(/Completed 2 models:/)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Validating models 1\/2;/),
    ).not.toBeInTheDocument();
    await screen.findByText("State machine:connectivityPassed");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    fireEvent.click(
      screen.getByRole("button", { name: "Protocol deep probe" }),
    );
    expect(
      screen.getByText(
        "Full Codex transaction verified; selected Chat Completions.",
      ),
    ).toBeVisible();
    expect(
      screen.getByText("Full Codex transaction verified; selected Responses."),
    ).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Save and enable" }));
    fireEvent.click(screen.getByRole("button", { name: "Save and publish" }));
    await screen.findByText("State machine:published");
    const [firstSources] = prepareCodexProviderSetBatch.mock.calls.at(-1)!;
    expect(firstSources[0].receiptIds).toEqual(["receipt-a", "receipt-b"]);
    expect(firstSources[0].provider.settingsConfig.modelCatalog.models).toEqual(
      source.settingsConfig.modelCatalog.models,
    );
    const [firstCommitSources] = commitCodexProviderSetBatch.mock.calls[0]!;
    expect(firstCommitSources[0].receiptIds).toEqual([
      "receipt-a",
      "receipt-b",
    ]);
    expect(
      firstCommitSources[0].provider.settingsConfig.modelCatalog.models,
    ).toEqual(source.settingsConfig.modelCatalog.models);

    fireEvent.click(screen.getByRole("button", { name: "Save and enable" }));
    fireEvent.click(screen.getByRole("button", { name: "Save and publish" }));
    await waitFor(() =>
      expect(commitCodexProviderSetBatch).toHaveBeenCalledTimes(2),
    );
    const [secondSources] = prepareCodexProviderSetBatch.mock.calls.at(-1)!;
    expect(secondSources[0].receiptIds).toEqual([
      "fresh-receipt-a",
      "fresh-receipt-b",
    ]);
    expect(
      secondSources[0].provider.settingsConfig.modelCatalog.models,
    ).toEqual(source.settingsConfig.modelCatalog.models);
    const [secondCommitSources] = commitCodexProviderSetBatch.mock.calls[1]!;
    expect(secondCommitSources[0].receiptIds).toEqual([
      "fresh-receipt-a",
      "fresh-receipt-b",
    ]);
    expect(restoreCodexProviderProtocolEvidence).toHaveBeenCalledTimes(2);
    expect(preflightCodexProviderProtocolCompatibility).toHaveBeenCalledTimes(
      1,
    );
  });

  it("restores new receipts after a stale-retry commit instead of re-probing a second save", async () => {
    const source: Provider = {
      id: "retry-receipts",
      name: "Retry Receipts",
      settingsConfig: {
        baseUrl: "https://example.invalid/v1",
        auth: { OPENAI_API_KEY: "test-only" },
        modelCatalog: { models: [{ model: "known" }] },
      },
    };
    const committedSource: Provider = {
      ...source,
      meta: { apiFormat: "openai_responses" },
    };
    const plan = savedProtocolPlan(source);
    restoreCodexProviderProtocolEvidence
      .mockResolvedValueOnce(
        protocolOutcome(
          source,
          [{ model: "known", transport: "open_ai_chat" }],
          { "old-receipt": "known" },
        ),
      )
      .mockResolvedValueOnce(
        protocolOutcome(
          committedSource,
          [{ model: "known", transport: "open_ai_responses" }],
          { "restored-after-commit": "known" },
        ),
      );
    preflightCodexProviderProtocolCompatibility.mockResolvedValue(
      protocolOutcome(
        source,
        [{ model: "known", transport: "open_ai_responses" }],
        { "retry-receipt": "known" },
      ),
    );
    let firstPrepare = true;
    const consumedReceipts = new Set<string>();
    prepareCodexProviderSetBatch.mockImplementation(async (sources) => {
      if (firstPrepare) {
        firstPrepare = false;
        throw new Error("codex_provider_set_dependency_changed");
      }
      if (
        sources.some((source: { receiptIds: string[] }) =>
          source.receiptIds.some((id) => consumedReceipts.has(id)),
        )
      ) {
        throw new Error("codex_provider_set_probe_required");
      }
      return { digest: "retry-receipts", sourcePreviews: [], blocked: false };
    });
    commitCodexProviderSetBatch.mockImplementation(async (sources, router) => {
      sources
        .flatMap((source: { receiptIds: string[] }) => source.receiptIds)
        .forEach((id: string) => consumedReceipts.add(id));
      return {
        router,
        editorRouter: router,
        sourceSnapshots: [{ logicalProvider: committedSource }],
        projections: [],
        status: "committed",
      };
    });
    renderWizard([source, plan], { mode: "edit", planId: plan.id });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Choose models" }),
      ).not.toHaveAttribute("data-read-only", "true"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save and enable" }));
    fireEvent.click(screen.getByRole("button", { name: "Save and publish" }));
    await screen.findByText("State machine:published");
    expect(preflightCodexProviderProtocolCompatibility).toHaveBeenCalledTimes(
      1,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Protocol deep probe" }),
    );
    expect(
      screen.getByText("Full Codex transaction verified; selected Responses."),
    ).toBeVisible();
    expect(
      screen.queryByText(
        "Full Codex transaction verified; selected Chat Completions.",
      ),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save and enable" }));
    fireEvent.click(screen.getByRole("button", { name: "Save and publish" }));
    await waitFor(() =>
      expect(commitCodexProviderSetBatch).toHaveBeenCalledTimes(2),
    );
    expect(
      prepareCodexProviderSetBatch.mock.calls.at(-1)![0][0].receiptIds,
    ).toEqual(["restored-after-commit"]);
    expect(preflightCodexProviderProtocolCompatibility).toHaveBeenCalledTimes(
      1,
    );
    preflightCodexProviderProtocolCompatibility.mockReset();
  });

  it.each([2, 28, 101])(
    "reopens and saves all %i API-declared models without requiring complete probe receipts",
    async (modelCount) => {
      const source: Provider = {
        id: "api-declared",
        name: "API Declared",
        settingsConfig: {
          baseUrl: "https://example.invalid/v1",
          auth: { OPENAI_API_KEY: "test-only" },
          modelCatalog: {
            models: Array.from({ length: modelCount }, (_, index) => ({
              model: `model-${index}`,
              protocolCapability: {
                schemaVersion: 1,
                source: "provider_api",
                baseUrl: "https://example.invalid/v1",
                upstreamModel: `model-${index}`,
                supportedEndpoints: [
                  index % 2 === 0 ? "openai_chat" : "openai_responses",
                ],
                supportsTools: true,
              },
            })),
          },
        },
      };
      const plan: Provider = {
        id: "api-plan",
        name: "API Plan",
        settingsConfig: {
          codexRouting: {
            schemaVersion: 2,
            enabled: true,
            routes: [
              {
                id: "api-route",
                targetProviderId: source.id,
                modelSelection: { mode: "all" },
              },
            ],
          },
        },
      };
      restoreCodexProviderProtocolEvidence.mockResolvedValueOnce(null);
      prepareCodexProviderSetBatch.mockResolvedValue({
        digest: "api-declared",
        sourcePreviews: [],
        blocked: false,
      });
      commitCodexProviderSetBatch.mockImplementation(
        async (sources, router) => ({
          router,
          editorRouter: router,
          sourceSnapshots: sources.map((item: { provider: Provider }) => ({
            logicalProvider: item.provider,
          })),
          projections: [],
          status: "committed",
        }),
      );
      const probeCalls =
        preflightCodexProviderProtocolCompatibility.mock.calls.length;
      renderWizard([source, plan], { mode: "edit", planId: plan.id });
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Choose models" }),
        ).not.toHaveAttribute("data-read-only", "true"),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Protocol deep probe" }),
      );
      expect(screen.getAllByText(/Provider API declares/)).toHaveLength(
        modelCount,
      );
      expect(screen.queryByText(/Full Codex transaction verified/)).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Save and enable" }));
      expect(
        screen.getByRole("button", { name: "Save and publish" }),
      ).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: "Save and publish" }));
      await screen.findByText("State machine:published");
      const [sources] = prepareCodexProviderSetBatch.mock.calls.at(-1)!;
      expect(sources[0].receiptIds).toEqual([]);
      expect(sources[0].provider.settingsConfig.modelCatalog.models).toEqual(
        source.settingsConfig.modelCatalog.models,
      );
      expect(
        preflightCodexProviderProtocolCompatibility.mock.calls.length,
      ).toBe(probeCalls);
    },
  );

  it("uses refreshed API declarations immediately and keeps them after a failed refresh", async () => {
    const source: Provider = {
      id: "fetch-declared",
      name: "Fetch Declared",
      settingsConfig: {
        baseUrl: "https://example.invalid/v1",
        auth: { OPENAI_API_KEY: "test-only" },
        modelCatalog: { models: [{ model: "known" }] },
      },
    };
    const fetchSpy = vi
      .spyOn(modelFetchApi, "fetchModelsForConfig")
      .mockResolvedValueOnce([
        {
          id: "known",
          ownedBy: null,
          protocolCapability: {
            schemaVersion: 1,
            source: "provider_api",
            baseUrl: "https://example.invalid/v1",
            upstreamModel: "known",
            supportedEndpoints: ["openai_chat"],
          },
        },
      ])
      .mockRejectedValueOnce(new Error("catalog unavailable"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const probeCalls =
      preflightCodexProviderProtocolCompatibility.mock.calls.length;
    try {
      renderWizard([source]);
      fireEvent.click(screen.getByRole("button", { name: "Save and enable" }));
      expect(
        screen.getByRole("button", { name: "Save and publish" }),
      ).toBeDisabled();
      fireEvent.click(
        screen.getByRole("button", { name: "Sync model catalogs" }),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Fetch model lists automatically" }),
      );
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Choose models" }),
        ).not.toHaveAttribute("data-read-only", "true"),
      );
      fireEvent.click(screen.getByRole("button", { name: "Save and enable" }));
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Save and publish" }),
        ).toBeEnabled(),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Sync model catalogs" }),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Fetch model lists automatically" }),
      );
      await screen.findByText("Model-list fetch failed");
      fireEvent.click(screen.getByRole("button", { name: "Save and enable" }));
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Save and publish" }),
        ).toBeEnabled(),
      );
      expect(
        preflightCodexProviderProtocolCompatibility.mock.calls.length,
      ).toBe(probeCalls);
      expect(source.settingsConfig.modelCatalog.models[0]).not.toHaveProperty(
        "protocolCapability",
      );
    } finally {
      fetchSpy.mockRestore();
      consoleError.mockRestore();
    }
  });

  it("requires fallback evidence for each unresolved model without reproving API-declared rows", async () => {
    const source: Provider = {
      id: "partial-api",
      name: "Partial API",
      settingsConfig: {
        baseUrl: "https://example.invalid/v1",
        auth: { OPENAI_API_KEY: "test-only" },
        modelCatalog: {
          models: [
            {
              model: "declared",
              protocolCapability: {
                schemaVersion: 1,
                source: "provider_api",
                baseUrl: "https://example.invalid/v1",
                upstreamModel: "declared",
                supportedEndpoints: ["openai_chat"],
              },
            },
            { model: "unknown-a" },
            { model: "unknown-b" },
            { model: "excluded", enabled: false },
          ],
        },
      },
    };
    const outcome: CodexProviderProtocolPreflightOutcome = {
      provider: source,
      receiptIds: ["only-unknown-a"],
      observations: [],
      protocolApplied: false,
      adaptationPreview: {
        persistence: "single",
        status: "partial",
        effectiveTransport: "open_ai_chat",
        models: [],
      },
      records: [
        {
          probeVersion: 1,
          testedAt: 100,
          expiresAt: 4102444800,
          target: {
            provider_id: source.id,
            route_id: null,
            public_model: "unknown-a",
            upstream_model: "unknown-a",
            transport: "open_ai_chat",
            authentication_kind: "bearer",
            endpoint_fingerprint: "endpoint",
            credential_fingerprint: "credential",
            request_policy_fingerprint: "policy",
          },
          result: {
            readiness: "verified",
            selected_transport: "open_ai_chat",
            branches: [],
          },
        },
      ],
    };
    expect(
      buildWizardConnectivityResultsFromBatchOutcome(
        [source],
        {
          sources: [{ provider: source, receiptIds: outcome.receiptIds }],
          outcomes: [{ providerId: source.id, inputProvider: source, outcome }],
        },
        false,
      ).map(({ model, canContinue, status }) => ({
        model,
        canContinue,
        status,
      })),
    ).toEqual([
      { model: "declared", canContinue: true, status: "skipped" },
      { model: "unknown-a", canContinue: true, status: "pass" },
      { model: "unknown-b", canContinue: false, status: "fail" },
    ]);
  });

  it("keeps official authentication out of the routing review step", () => {
    const official: Provider = {
      id: "codex-official",
      name: "OpenAI Official",
      category: "official",
      settingsConfig: { modelCatalog: { models: [{ model: "gpt-5.6" }] } },
    };
    renderWizard([official]);
    fireEvent.click(screen.getByRole("button", { name: "Review routing" }));
    expect(
      screen.queryByText("Official ChatGPT authentication"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/Official routes use OpenAI Official authentication/),
    ).toBeVisible();
  });

  it.each(["Accept later", "Open the status page to finish acceptance"])(
    "dismisses the acceptance overlay through %s without claiming acceptance",
    async (button) => {
      const plan: Provider = {
        id: "acceptance-plan",
        name: "Acceptance Plan",
        settingsConfig: {
          codexRouting: { schemaVersion: 2, enabled: true, routes: [] },
        },
      };
      const onOpenChange = vi.fn();
      const onOpenWorkspace = vi.fn();
      renderWizard([plan], {
        mode: "edit",
        planId: plan.id,
        onEnablePlan: vi.fn().mockResolvedValue(undefined),
        onOpenChange,
        onOpenWorkspace,
      });
      fireEvent.click(screen.getByRole("button", { name: "Save and enable" }));
      fireEvent.click(
        screen.getByRole("button", { name: "Enable this multi-route plan" }),
      );
      await screen.findByText("State machine:enabled");
      fireEvent.click(screen.getByRole("button", { name: button }));
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(screen.getByText("State machine:enabled")).toBeInTheDocument();
      expect(
        screen.queryByText("State machine:completed"),
      ).not.toBeInTheDocument();
      if (button === "Open the status page to finish acceptance") {
        expect(onOpenWorkspace).toHaveBeenCalledWith(plan, "status");
      }
    },
  );

  it.each([false, true])(
    "reopens a saved plan and saves with reusable evidence (initial prepare failure: %s)",
    async (failFirstPrepare) => {
      const source: Provider = {
        id: "saved-source",
        name: "Saved Source",
        settingsConfig: {
          baseUrl: "https://example.invalid/v1",
          auth: { OPENAI_API_KEY: "test-only" },
          modelCatalog: { models: [{ model: "good" }] },
        },
      };
      const plan: Provider = {
        id: "saved-plan",
        name: "Saved Plan",
        settingsConfig: {
          codexRouting: {
            schemaVersion: 2,
            enabled: true,
            routes: [
              {
                id: "saved-route",
                targetProviderId: source.id,
                modelSelection: { mode: "all" },
                aliases: { "legacy-good": "good" },
                authPolicy: { source: "provider_config" },
              },
            ],
          },
        },
      };
      const restoredOutcome = {
        provider: source,
        receiptIds: ["restored-receipt"],
        observations: [],
        protocolApplied: false,
        adaptationPreview: {
          persistence: "single",
          status: "ready",
          models: [],
        },
        records: [
          {
            probeVersion: 1,
            testedAt: 100,
            expiresAt: 4102444800,
            target: {
              provider_id: source.id,
              public_model: "good",
              upstream_model: "good",
              transport: "open_ai_responses",
              endpoint_fingerprint: "endpoint",
              credential_fingerprint: "credential",
              request_policy_fingerprint: "policy",
            },
            result: {
              readiness: "verified",
              selected_transport: "open_ai_responses",
              branches: [],
            },
          },
        ],
      };
      restoreCodexProviderProtocolEvidence.mockResolvedValueOnce(
        restoredOutcome,
      );
      prepareCodexProviderSetBatch.mockResolvedValue({
        digest: "saved",
        sourcePreviews: [],
        blocked: false,
      });
      if (failFirstPrepare) {
        prepareCodexProviderSetBatch.mockRejectedValueOnce(
          new Error("candidate-invalid"),
        );
      }
      commitCodexProviderSetBatch.mockResolvedValue({
        router: {
          ...plan,
          settingsConfig: {
            ...plan.settingsConfig,
            codexRouting: {
              ...plan.settingsConfig.codexRouting,
              routes: [
                {
                  targetProviderId: `${source.id}--ccsm-responses`,
                  aliases: { "legacy-good": "good" },
                },
              ],
            },
          },
        },
        editorRouter: plan,
        sourceSnapshots: [{ logicalProvider: source }],
        projections: [],
        status: "committed",
      });
      const probeCalls =
        preflightCodexProviderProtocolCompatibility.mock.calls.length;
      renderWizard([source, plan], { mode: "edit", planId: plan.id });
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Choose models" }),
        ).not.toHaveAttribute("data-read-only"),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Protocol deep probe" }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      expect(screen.getByText("Step 7 of 13")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Save and enable" }));
      fireEvent.click(screen.getByRole("button", { name: "Save and publish" }));
      if (failFirstPrepare) {
        await screen.findByText("candidate-invalid");
        await screen.findByText("State machine:saveFailed");
        fireEvent.click(
          screen.getByRole("button", { name: "Save and publish" }),
        );
      }
      await waitFor(() =>
        expect(commitCodexProviderSetBatch).toHaveBeenCalled(),
      );
      expect(
        prepareCodexProviderSetBatch.mock.calls.at(-1)![0][0].receiptIds,
      ).toEqual(["restored-receipt"]);
      expect(
        preflightCodexProviderProtocolCompatibility.mock.calls.length,
      ).toBe(probeCalls);
      await screen.findByText("State machine:published");
      restoreCodexProviderProtocolEvidence.mockResolvedValueOnce({
        ...restoredOutcome,
        receiptIds: ["restored-again"],
      });
      const commits = commitCodexProviderSetBatch.mock.calls.length;
      fireEvent.click(screen.getByRole("button", { name: "Save and publish" }));
      await waitFor(() =>
        expect(commitCodexProviderSetBatch.mock.calls.length).toBe(commits + 1),
      );
      expect(
        prepareCodexProviderSetBatch.mock.calls.at(-1)![0][0].receiptIds,
      ).toEqual(["restored-again"]);
      expect(
        prepareCodexProviderSetBatch.mock.calls.at(-1)![1].settingsConfig
          .codexRouting.routes[0].aliases,
      ).toEqual({ "legacy-good": "good" });
      expect(
        preflightCodexProviderProtocolCompatibility.mock.calls.length,
      ).toBe(probeCalls);
      fireEvent.click(
        screen.getByRole("button", { name: "Protocol deep probe" }),
      );
      expect(
        screen.getByRole("button", {
          name: "Run compatibility deep probe again",
        }),
      ).toBeEnabled();
      fireEvent.click(
        screen.getByRole("button", {
          name: "Run compatibility deep probe again",
        }),
      );
      expect(
        screen.getByRole("button", { name: "Confirm test" }),
      ).toBeVisible();
    },
  );
  it("keeps later steps gated when persisted evidence is missing without starting a probe", async () => {
    const source: Provider = {
      id: "no-evidence",
      name: "No Evidence",
      settingsConfig: {
        baseUrl: "https://example.invalid/v1",
        auth: { OPENAI_API_KEY: "test" },
        modelCatalog: { models: [{ model: "good" }] },
      },
    };
    const plan: Provider = {
      id: "old-plan",
      name: "Old Plan",
      settingsConfig: {
        codexRouting: {
          schemaVersion: 2,
          enabled: true,
          routes: [
            {
              id: "r",
              targetProviderId: source.id,
              modelSelection: { mode: "all" },
              authPolicy: { source: "provider_config" },
            },
          ],
        },
      },
    };
    restoreCodexProviderProtocolEvidence.mockResolvedValueOnce(null);
    const calls = preflightCodexProviderProtocolCompatibility.mock.calls.length;
    renderWizard([source, plan], { mode: "edit", planId: plan.id });
    fireEvent.click(
      screen.getByRole("button", { name: "Protocol deep probe" }),
    );
    await screen.findByText(/Saved records checked: reusing 0/);
    expect(
      screen.getByRole("button", { name: "Choose models" }),
    ).toHaveAttribute("data-read-only", "true");
    expect(
      screen.getByRole("button", { name: "Start compatibility deep probe" }),
    ).toBeEnabled();
    expect(preflightCodexProviderProtocolCompatibility.mock.calls.length).toBe(
      calls,
    );
  });
  it("rechecks saved evidence after an unchanged model refresh instead of discarding the protocol gate", async () => {
    const source: Provider = {
      id: "refresh-source",
      name: "Refresh Source",
      settingsConfig: {
        baseUrl: "https://example.invalid/v1",
        auth: { OPENAI_API_KEY: "test" },
        modelCatalog: { models: [{ model: "good" }] },
      },
    };
    const plan: Provider = {
      id: "refresh-plan",
      name: "Refresh Plan",
      settingsConfig: {
        codexRouting: {
          schemaVersion: 2,
          enabled: true,
          routes: [
            {
              id: "refresh-route",
              targetProviderId: source.id,
              modelSelection: { mode: "all" },
              authPolicy: { source: "provider_config" },
            },
          ],
        },
      },
    };
    const restoredEvidence = {
      provider: source,
      receiptIds: ["refresh-receipt"],
      observations: [],
      protocolApplied: false,
      adaptationPreview: {
        persistence: "single" as const,
        status: "ready" as const,
        models: [],
      },
      records: [
        {
          probeVersion: 1,
          testedAt: 100,
          expiresAt: 4102444800,
          target: {
            provider_id: source.id,
            public_model: "good",
            upstream_model: "good",
            transport: "open_ai_responses",
            endpoint_fingerprint: "endpoint",
            credential_fingerprint: "credential",
            request_policy_fingerprint: "policy",
          },
          result: {
            readiness: "verified" as const,
            selected_transport: "open_ai_responses" as const,
            branches: [],
          },
        },
      ],
    };
    const fetchSpy = vi
      .spyOn(modelFetchApi, "fetchModelsForConfig")
      .mockResolvedValueOnce([{ id: "good", ownedBy: null }]);
    restoreCodexProviderProtocolEvidence.mockReset();
    restoreCodexProviderProtocolEvidence
      .mockResolvedValueOnce(restoredEvidence)
      .mockResolvedValueOnce(restoredEvidence);

    try {
      renderWizard([source, plan], { mode: "edit", planId: plan.id });
      fireEvent.click(
        screen.getByRole("button", { name: "Protocol deep probe" }),
      );
      await screen.findByText(/Saved records checked: reusing 1/);
      const restoreCallsBeforeRefresh =
        restoreCodexProviderProtocolEvidence.mock.calls.length;
      const probeCallsBeforeRefresh =
        preflightCodexProviderProtocolCompatibility.mock.calls.length;

      fireEvent.click(
        screen.getByRole("button", { name: "Sync model catalogs" }),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Fetch model lists automatically" }),
      );

      await waitFor(() =>
        expect(restoreCodexProviderProtocolEvidence.mock.calls.length).toBe(
          restoreCallsBeforeRefresh + 1,
        ),
      );
      expect(
        preflightCodexProviderProtocolCompatibility.mock.calls.length,
      ).toBe(probeCallsBeforeRefresh);
      expect(
        screen.getByRole("button", { name: "Choose models" }),
      ).not.toHaveAttribute("data-read-only", "true");

      fireEvent.click(screen.getByRole("button", { name: "Choose models" }));
      const followAll = screen.getByRole("button", {
        name: "Follow all models automatically",
      });
      fireEvent.click(screen.getByRole("button", { name: "Deselect all" }));
      await waitFor(() => expect(followAll).toBeEnabled());
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      expect(
        screen.getByRole("heading", { name: "Choose models" }),
      ).toBeVisible();
      expect(
        screen.getByRole("button", { name: "Choose models" }),
      ).not.toHaveAttribute("data-read-only", "true");

      // Reproduce the native workflow: leave the empty selection, revisit the
      // model page, then recover it through the automatic-follow action.
      fireEvent.click(
        screen.getByRole("button", { name: "Protocol deep probe" }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Choose models" }));
      const reopenedFollowAll = screen.getByRole("button", {
        name: "Follow all models automatically",
      });
      expect(reopenedFollowAll).toBeEnabled();
      fireEvent.click(reopenedFollowAll);
      expect(screen.getByText("Follow provider automatically")).toBeVisible();
    } finally {
      fetchSpy.mockRestore();
      restoreCodexProviderProtocolEvidence.mockReset();
      restoreCodexProviderProtocolEvidence.mockResolvedValue(null);
    }
  });

  it("ignores late saved evidence after a newly created source is integrated", async () => {
    const source: Provider = {
      id: "saved",
      name: "Saved",
      settingsConfig: {
        baseUrl: "https://example.invalid/v1",
        auth: { OPENAI_API_KEY: "test" },
        modelCatalog: { models: [{ model: "good" }] },
      },
    };
    const added: Provider = {
      ...source,
      id: "added",
      name: "Added",
      settingsConfig: {
        ...source.settingsConfig,
        modelCatalog: { models: [{ model: "new-model" }] },
      },
    };
    const plan: Provider = {
      id: "old-plan",
      name: "Old Plan",
      settingsConfig: {
        codexRouting: {
          schemaVersion: 2,
          enabled: true,
          routes: [
            {
              id: "r",
              targetProviderId: source.id,
              modelSelection: { mode: "all" },
              authPolicy: { source: "provider_config" },
            },
          ],
        },
      },
    };
    let finish!: (value: unknown) => void;
    restoreCodexProviderProtocolEvidence.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { rerenderWizard } = renderWizard([source, plan], {
      mode: "edit",
      planId: plan.id,
    });
    rerenderWizard(true, [source, added, plan], {
      mode: "edit",
      planId: plan.id,
      newlyCreatedProviderIds: [added.id],
    });
    await act(async () =>
      finish({
        provider: source,
        receiptIds: ["old-receipt"],
        observations: [],
        protocolApplied: false,
        adaptationPreview: {
          persistence: "single",
          status: "ready",
          models: [],
        },
        records: [
          {
            probeVersion: 1,
            testedAt: 100,
            expiresAt: 4102444800,
            target: {
              provider_id: source.id,
              public_model: "good",
              upstream_model: "good",
              transport: "open_ai_responses",
              endpoint_fingerprint: "endpoint",
              credential_fingerprint: "credential",
              request_policy_fingerprint: "policy",
            },
            result: {
              readiness: "verified",
              selected_transport: "open_ai_responses",
              branches: [],
            },
          },
        ],
      }),
    );
    expect(
      screen.getByRole("button", { name: "Choose models" }),
    ).toHaveAttribute("data-read-only", "true");
    fireEvent.click(
      screen.getByRole("button", { name: "Protocol deep probe" }),
    );
    expect(
      screen.getByRole("button", { name: "Start compatibility deep probe" }),
    ).toBeEnabled();
  });
  it("does not mark a new draft enabled when the previous target finishes enabling", async () => {
    const plan: Provider = {
      id: "pending-enable",
      name: "Pending Enable",
      settingsConfig: {
        codexRouting: { schemaVersion: 2, enabled: true, routes: [] },
      },
    };
    let completeEnable!: () => void;
    const onEnablePlan = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          completeEnable = resolve;
        }),
    );
    const { rerenderWizard } = renderWizard([plan], {
      mode: "edit",
      planId: plan.id,
      onEnablePlan,
    });
    fireEvent.click(screen.getByRole("button", { name: "Save and enable" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Enable this multi-route plan" }),
    );
    expect(onEnablePlan).toHaveBeenCalledWith(plan);
    rerenderWizard(false);
    rerenderWizard(true, [plan], { mode: "create" });
    const statusBefore = screen.getByText(/State machine:/).textContent;
    await act(async () => {
      completeEnable();
    });
    expect(screen.queryByText("State machine:enabled")).not.toBeInTheDocument();
    expect(screen.getByText(/State machine:/).textContent).toBe(statusBefore);
  });

  it("isolates an edited plan from a new draft and ignores its late model fetch", async () => {
    const source: Provider = {
      id: "isolated-source",
      name: "Isolated Source",
      meta: { codexProtocolMode: "manual", apiFormat: "openai_responses" },
      settingsConfig: {
        baseUrl: "https://example.invalid/v1",
        auth: { OPENAI_API_KEY: "test-only" },
        modelCatalog: { models: [{ model: "original" }] },
      },
    };
    const plan: Provider = {
      id: "existing-router",
      name: "Existing Router",
      settingsConfig: {
        codexRouting: {
          schemaVersion: 2,
          enabled: true,
          routes: [
            {
              id: "route",
              targetProviderId: source.id,
              modelSelection: { mode: "all" },
              authPolicy: { source: "provider_config" },
            },
          ],
        },
      },
    };
    let finishFetch!: (models: modelFetchApi.FetchedModel[]) => void;
    const fetchSpy = vi
      .spyOn(modelFetchApi, "fetchModelsForConfig")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFetch = resolve;
          }),
      );
    prepareCodexProviderSetBatch.mockResolvedValue({
      digest: "isolated",
      sourcePreviews: [],
      blocked: false,
    });
    commitCodexProviderSetBatch.mockImplementation(
      async (_sources, router) => ({
        router,
        editorRouter: router,
        sourceSnapshots: [],
        projections: [],
        status: "committed",
      }),
    );
    const providers = [
      source,
      { ...source, id: "second-source", name: "Second Source" },
      plan,
    ];
    const { rerenderWizard } = renderWizard(providers, {
      mode: "edit",
      planId: plan.id,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Sync model catalogs" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Fetch model lists automatically" }),
    );
    expect(fetchSpy).toHaveBeenCalled();
    rerenderWizard(false);
    rerenderWizard(true, providers, { mode: "create" });
    await act(async () => {
      finishFetch([{ id: "late-model", ownedBy: null }]);
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Protocol deep probe" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Start compatibility deep probe" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm test" }));
    await screen.findByText("State machine:connectivityPartial");
    fireEvent.click(screen.getByRole("button", { name: "Save and enable" }));
    fireEvent.click(screen.getByRole("button", { name: "Save and publish" }));
    await waitFor(() => expect(commitCodexProviderSetBatch).toHaveBeenCalled());
    const [sources, router] = commitCodexProviderSetBatch.mock.calls.at(-1)!;
    expect(router.id).not.toBe(plan.id);
    expect(sources).toHaveLength(2);
    expect(
      sources[0].provider.settingsConfig.modelCatalog.models.map(
        (model: { model: string }) => model.model,
      ),
    ).toEqual(["original"]);
    fetchSpy.mockRestore();
  });

  it("retains the draft page when closed and reopened in the same application session", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const source: Provider = {
      id: "cache-source",
      name: "Cache Source",
      settingsConfig: {
        baseUrl: "https://example.invalid/v1",
        auth: { OPENAI_API_KEY: "test-only" },
        modelCatalog: { models: [{ model: "model-a" }] },
      },
    };
    const props = {
      providers: [source],
      mode: "create" as const,
      onOpenChange: vi.fn(),
      onCreateProvider: vi.fn(),
      onOpenProviderConfig: vi.fn(),
      onOpenWorkspace: vi.fn(),
      onEnablePlan: vi.fn(),
    };
    const view = (open: boolean) => (
      <QueryClientProvider client={queryClient}>
        <CodexMultiRouterWizard {...props} open={open} />
      </QueryClientProvider>
    );
    const { rerender } = render(view(true));
    fireEvent.click(
      screen.getByRole("button", { name: "Protocol deep probe" }),
    );
    rerender(view(false));
    rerender(view(true));
    expect(
      screen.getByRole("heading", { name: "Protocol deep probe" }),
    ).toBeVisible();
  });

  it("can exclude a failed model and save verified receipts without probing again", async () => {
    const source: Provider = {
      id: "mixed-probe",
      name: "Mixed Probe",
      settingsConfig: {
        baseUrl: "https://example.invalid/v1",
        auth: { OPENAI_API_KEY: "test-only" },
        modelCatalog: { models: [{ model: "good" }, { model: "bad" }] },
      },
    };
    preflightCodexProviderProtocolCompatibility.mockResolvedValueOnce({
      provider: source,
      receiptIds: ["receipt-good", "receipt-bad"],
      observations: [],
      protocolApplied: false,
      adaptationPreview: {
        persistence: "blocked",
        status: "blocked",
        models: [],
      },
      records: ["good", "bad"].map((model) => ({
        target: {
          public_model: model,
          upstream_model: model,
          transport: "open_ai_responses",
        },
        result: {
          readiness: model === "good" ? "verified" : "unverified",
          selected_transport: model === "good" ? "open_ai_responses" : null,
          branches: [],
        },
      })),
    });
    prepareCodexProviderSetBatch.mockResolvedValue({
      digest: "selected",
      sourcePreviews: [],
      blocked: false,
    });
    commitCodexProviderSetBatch.mockImplementation(async (sources, router) => ({
      router,
      editorRouter: router,
      sourceSnapshots: sources.map((item: { provider: Provider }) => ({
        logicalProvider: {
          ...item.provider,
          meta: { ...item.provider.meta, apiFormat: "openai_responses" },
        },
        adaptation: {
          persistence: "single",
          status: "ready",
          effectiveTransport: "open_ai_responses",
          models: [],
        },
      })),
      projections: [],
      status: "committed",
    }));
    const { rerenderWizard } = renderWizard([source]);
    fireEvent.click(
      screen.getByRole("button", { name: "Protocol deep probe" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Start compatibility deep probe" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm test" }));
    await screen.findByText("State machine:connectivityFailed");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    rerenderWizard(false);
    rerenderWizard(true, [{ ...source, name: "Renamed Probe" }]);
    expect(
      screen.getByRole("heading", { name: "Protocol deep probe" }),
    ).toBeVisible();
    expect(
      screen.getByRole("checkbox", { name: "Keep Mixed Probe / bad" }),
    ).toBeChecked();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Keep Mixed Probe / bad" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(
      screen.getByRole("heading", { name: "Choose models" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Save and enable" }));
    fireEvent.click(screen.getByRole("button", { name: "Save and publish" }));
    await waitFor(() => expect(commitCodexProviderSetBatch).toHaveBeenCalled());
    const sources = commitCodexProviderSetBatch.mock.calls.at(-1)![0];
    expect(sources[0].provider.name).toBe("Renamed Probe");
    expect(sources[0].receiptIds).toEqual(["receipt-good"]);
    expect(sources[0].provider.settingsConfig.modelCatalog.models).toEqual([
      { model: "good" },
      { model: "bad", enabled: false },
    ]);
    expect(preflightCodexProviderProtocolCompatibility).toHaveBeenCalledTimes(
      1,
    );
    expect(
      source.settingsConfig.modelCatalog.models[1].enabled,
    ).toBeUndefined();
    await screen.findByText("State machine:published");
    const committed =
      await commitCodexProviderSetBatch.mock.results.at(-1)!.value;
    // A query can still render its previous snapshot before the save refetch arrives.
    rerenderWizard(true, [{ ...source, name: "Renamed Probe" }]);
    expect(
      screen.getByRole("button", { name: "Enable this multi-route plan" }),
    ).toBeEnabled();
    rerenderWizard(true, [
      ...committed.sourceSnapshots.map(
        (snapshot: { logicalProvider: Provider }) => snapshot.logicalProvider,
      ),
      committed.router,
    ]);
    expect(
      screen.getByRole("button", { name: "Enable this multi-route plan" }),
    ).toBeEnabled();
    expect(
      screen.queryByText("This step cannot be edited yet"),
    ).not.toBeInTheDocument();
    const savedSource = committed.sourceSnapshots[0].logicalProvider;
    rerenderWizard(true, [
      {
        ...savedSource,
        settingsConfig: {
          ...savedSource.settingsConfig,
          baseUrl: "https://changed.invalid/v1",
        },
      },
      committed.router,
    ]);
    expect(
      screen.getByRole("button", { name: "Enable this multi-route plan" }),
    ).toBeDisabled();
  });

  it("invalidates only the edited source and never allows an empty retained selection", async () => {
    const makeSource = (id: string): Provider => ({
      id,
      name: id,
      meta:
        id === "source-a"
          ? { apiFormat: "openai_responses" }
          : { codexProtocolMode: "manual", apiFormat: "openai_responses" },
      settingsConfig: {
        baseUrl: "https://example.invalid/v1",
        auth: { OPENAI_API_KEY: "test-only" },
        modelCatalog: {
          models: [
            {
              model: `${id}-model`,
              ...(id === "source-a"
                ? {
                    protocolCapability: {
                      schemaVersion: 1,
                      source: "provider_api",
                      baseUrl: "https://example.invalid/v1",
                      upstreamModel: `${id}-model`,
                      supportedEndpoints: ["openai_responses"],
                    },
                  }
                : {}),
            },
          ],
        },
      },
    });
    const a = makeSource("source-a");
    const b = makeSource("source-b");
    const { rerenderWizard } = renderWizard([a, b]);
    fireEvent.click(
      screen.getByRole("button", { name: "Protocol deep probe" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Start compatibility deep probe" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm test" }));
    await screen.findByText("State machine:connectivityPartial");
    rerenderWizard(false);
    const changed = {
      ...a,
      settingsConfig: {
        ...a.settingsConfig,
        baseUrl: "https://changed.invalid/v1",
      },
    };
    rerenderWizard(true, [changed, b]);
    fireEvent.click(
      screen.getByRole("button", { name: "Protocol deep probe" }),
    );
    expect(
      screen.getByText(
        /The model source changed, so previous probe results are stale/,
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("checkbox", { name: "Keep source-b / *" }),
    ).toBeChecked();
    fireEvent.click(
      screen.getByRole("button", { name: "Deselect all failed models" }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Keep source-b / *" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(
      screen.getByRole("heading", { name: "Protocol deep probe" }),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Keep source-b / *" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(
      screen.getByRole("heading", { name: "Choose models" }),
    ).toBeVisible();
  });

  it("turns a missing batch probe source into a named failure instead of an all-zero summary", () => {
    const source: Provider = {
      id: "qwen-local",
      name: "Qwen Local",
      category: "custom",
      settingsConfig: {
        baseUrl: "https://example.invalid/v1",
        auth: { OPENAI_API_KEY: "test-only" },
        modelCatalog: { models: [{ model: "qwen3.8" }] },
      },
    };

    expect(
      buildWizardConnectivityResultsFromBatchOutcome(
        [source],
        { outcomes: [], sources: [] },
        false,
      ),
    ).toEqual([
      expect.objectContaining({
        providerId: "qwen-local",
        providerName: "Qwen Local",
        status: "fail",
        canContinue: false,
        detail:
          "The backend returned no compatibility result for this model source.",
      }),
    ]);
  });

  it("keeps legacy V1 controls out while exposing the dedicated Sub-Agent page", () => {
    renderWizard([
      {
        id: "codex-deepseek",
        name: "DeepSeek",
        category: "custom",
        settingsConfig: {
          baseUrl: "https://example.invalid/v1",
          auth: { OPENAI_API_KEY: "test-only" },
          modelCatalog: {
            models: [
              { model: "deepseek-v4-flash" },
              { model: "deepseek-v4-pro" },
            ],
          },
        },
      },
    ]);

    expect(
      screen.queryByRole("button", { name: /Sub-Agent V1/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Sub-Agent and tools" }),
    ).toBeVisible();
  });

  it("presents the complete guided setup as single-responsibility pages", () => {
    renderWizard([
      {
        id: "codex-deepseek",
        name: "DeepSeek",
        category: "custom",
        settingsConfig: {
          baseUrl: "https://example.invalid/v1",
          auth: { OPENAI_API_KEY: "test-only" },
          modelCatalog: {
            models: [{ model: "deepseek-v4-flash" }],
          },
        },
      },
    ]);

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
    expect(
      screen.getByText(
        /Current Codex configuration is not enabled or overwritten before final confirmation./,
      ),
    ).toBeVisible();
  });

  it("explains the production-equivalent deep-probe contract without legacy shallow-probe limits", () => {
    renderWizard([
      {
        id: "codex-deepseek",
        name: "DeepSeek",
        category: "custom",
        settingsConfig: {
          baseUrl: "https://example.invalid/v1",
          auth: { OPENAI_API_KEY: "test-only" },
          modelCatalog: {
            models: [{ model: "deepseek-v4-flash" }],
          },
        },
      },
    ]);

    fireEvent.click(
      screen.getByRole("button", { name: "Protocol deep probe" }),
    );

    const contract = screen.getByText(
      /Each unresolved provider\/model verifies Responses and Chat/,
    );
    expect(contract).toHaveTextContent("streaming SSE");
    expect(contract).toHaveTextContent("reasoning semantics");
    expect(contract).toHaveTextContent("forced tool calls");
    expect(contract).toHaveTextContent("tool-result continuation");
    expect(screen.queryByText(/shallow probe|1024/)).not.toBeInTheDocument();
  });

  it("previews a blocked future page without mutating workflow progress", () => {
    renderWizard([
      {
        id: "codex-deepseek",
        name: "DeepSeek",
        category: "custom",
        settingsConfig: {
          baseUrl: "https://example.invalid/v1",
          auth: { OPENAI_API_KEY: "test-only" },
          modelCatalog: {
            models: [{ model: "deepseek-v4-flash" }],
          },
        },
      },
    ]);

    expect(screen.getByText("State machine:opened")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Save and enable" }));

    expect(
      screen.getByRole("heading", { name: "Save and enable" }),
    ).toBeVisible();
    expect(screen.getByText("This step cannot be edited yet")).toBeVisible();
    expect(screen.getByText("State machine:opened")).toBeVisible();
    expect(
      screen.queryByText("State machine:enablePrompt"),
    ).not.toBeInTheDocument();
  });

  it("counts only automatic models in the deep-probe progress denominator", async () => {
    preflightCodexProviderProtocolCompatibility.mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    const { unmount } = renderWizard([
      {
        id: "qwen-local",
        name: "Qwen Local",
        category: "custom",
        settingsConfig: {
          baseUrl: "https://example.invalid/v1",
          auth: { OPENAI_API_KEY: "test-only" },
          modelCatalog: { models: [{ model: "qwen3.8" }] },
        },
      },
      {
        id: "codex-official",
        name: "OpenAI Official",
        category: "official",
        meta: { providerType: "codex_oauth" },
        settingsConfig: {
          modelCatalog: {
            models: [{ model: "gpt-5.6-sol" }, { model: "gpt-5.6-luna" }],
          },
        },
      },
      {
        id: "mixed-manual",
        name: "Mixed Manual",
        category: "custom",
        meta: {
          codexProtocolMode: "manual",
          codexProtocolOverrides: { "kimi-k3": "openai_chat" },
        },
        settingsConfig: {
          baseUrl: "https://example.invalid/v1",
          auth: { OPENAI_API_KEY: "test-only" },
          modelCatalog: {
            models: [{ model: "kimi-k3" }, { model: "glm-5.3" }],
          },
        },
      },
    ]);

    fireEvent.click(
      screen.getByRole("button", { name: "Protocol deep probe" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Start compatibility deep probe" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm test" }));

    expect(
      await screen.findByText(/Validating models 0\/2;/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Validating models 0\/5;/),
    ).not.toBeInTheDocument();
    unmount();
  });

  it("keeps the final save entry visible when no model source exists", () => {
    renderWizard([]);

    fireEvent.click(screen.getByRole("button", { name: "Save and enable" }));

    expect(
      screen.getByRole("button", { name: "Save and publish" }),
    ).toBeVisible();
    expect(
      screen.getByText(/No model source is selected\. Return to/),
    ).toBeVisible();
    expect(screen.getByText("This step cannot be edited yet")).toBeVisible();
  });

  it("coalesces rapid saves and updates the same plan after the first save", async () => {
    let resolveCommit:
      | ((value: {
          preview: Record<string, unknown>;
          router: Provider;
          editorRouter: Provider;
          sourceSnapshots: never[];
          projections: never[];
          status: "committed";
          projectionErrorCode: null;
        }) => void)
      | undefined;
    const firstCommit = new Promise<{
      preview: Record<string, unknown>;
      router: Provider;
      editorRouter: Provider;
      sourceSnapshots: never[];
      projections: never[];
      status: "committed";
      projectionErrorCode: null;
    }>((resolve) => {
      resolveCommit = resolve;
    });
    prepareCodexProviderSetBatch.mockImplementation(
      async (_sources: unknown, router: Provider) => ({
        digest: `digest:${router.id}`,
        sourcePreviews: [],
        routerProviderId: router.id,
        requiresSplitConfirmation: false,
        blocked: false,
      }),
    );
    commitCodexProviderSetBatch.mockImplementationOnce(() => firstCommit);
    commitCodexProviderSetBatch.mockImplementation(
      async (_sources: unknown, router: Provider, digest: string) => ({
        preview: {
          digest,
          sourcePreviews: [],
          routerProviderId: router.id,
          requiresSplitConfirmation: false,
          blocked: false,
        },
        router,
        sourceSnapshots: [],
        editorRouter: router,
        projections: [],
        status: "committed" as const,
        projectionErrorCode: null,
      }),
    );
    const source: Provider = {
      id: "relay",
      name: "Relay",
      category: "custom",
      meta: {
        codexProtocolMode: "manual",
        apiFormat: "openai_responses",
      },
      settingsConfig: {
        baseUrl: "https://example.invalid/v1",
        auth: { OPENAI_API_KEY: "test-only" },
        modelCatalog: { models: [{ model: "relay-model" }] },
      },
    };

    renderWizard([source]);
    fireEvent.click(
      screen.getByRole("button", { name: "Protocol deep probe" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Start compatibility deep probe" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm test" }));
    await screen.findByText("State machine:connectivityPartial");
    fireEvent.click(screen.getByRole("button", { name: "Save and enable" }));
    const saveButton = screen.getByRole("button", { name: "Save and publish" });

    fireEvent.click(saveButton);
    fireEvent.click(saveButton);
    await waitFor(() =>
      expect(commitCodexProviderSetBatch).toHaveBeenCalledTimes(1),
    );

    const firstRouter = commitCodexProviderSetBatch.mock
      .calls[0]?.[1] as Provider;
    resolveCommit?.({
      preview: {
        digest: `digest:${firstRouter.id}`,
        sourcePreviews: [],
        routerProviderId: firstRouter.id,
        requiresSplitConfirmation: false,
        blocked: false,
      },
      router: firstRouter,
      editorRouter: firstRouter,
      sourceSnapshots: [],
      projections: [],
      status: "committed",
      projectionErrorCode: null,
    });
    await waitFor(() =>
      expect(screen.getByText("State machine:published")).toBeVisible(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Save and publish" }));
    await waitFor(() =>
      expect(commitCodexProviderSetBatch).toHaveBeenCalledTimes(2),
    );
    const secondRouter = commitCodexProviderSetBatch.mock
      .calls[1]?.[1] as Provider;
    expect(secondRouter.id).toBe(firstRouter.id);
    expect(providersApi.add).not.toHaveBeenCalled();
    expect(providersApi.update).not.toHaveBeenCalled();
  });

  it("does not require users to choose subagent models in the main wizard", () => {
    renderWizard([
      {
        id: "codex-deepseek",
        name: "DeepSeek",
        category: "custom",
        settingsConfig: {
          baseUrl: "https://example.invalid/v1",
          auth: { OPENAI_API_KEY: "test-only" },
          modelCatalog: {
            models: [
              { model: "deepseek-v4-flash" },
              { model: "deepseek-v4-pro" },
            ],
          },
        },
      },
    ]);

    expect(screen.queryByText("Sub-Agent candidates")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Choose and order up to 5 Sub-Agent candidate models/),
    ).not.toBeInTheDocument();
  });

  it("edits the explicitly selected plan instead of the first cached routing plan", () => {
    const routingPlan = (id: string, name: string): Provider => ({
      id,
      name,
      category: "custom",
      settingsConfig: {
        codexRouting: { enabled: true, routes: [{ id: `${id}-route` }] },
        modelCatalog: { models: [{ model: `${id}-model` }] },
      },
    });

    renderWizard(
      [
        routingPlan("router-a", "旧方案 A"),
        routingPlan("router-b", "目标方案 B"),
      ],
      { mode: "edit", planId: "router-b" },
    );

    expect(screen.getByText("Editing: 目标方案 B")).toBeVisible();
    expect(screen.getByText("router-b")).toBeVisible();
    expect(screen.queryByText("Editing: 旧方案 A")).not.toBeInTheDocument();
  });

  it("selects only the Providers referenced by an existing schema-v2 plan", () => {
    const source = (id: string, name: string): Provider => ({
      id,
      name,
      category: "custom",
      settingsConfig: {
        baseUrl: "https://example.invalid/v1",
        auth: { OPENAI_API_KEY: "test-only" },
        modelCatalog: { models: [{ model: `${id}-model` }] },
      },
    });
    const used = source("used-source", "Used source");
    const unused = source("unused-source", "Unused source");
    const plan: Provider = {
      id: "router-v2",
      name: "Router V2",
      category: "custom",
      settingsConfig: {
        codexRouting: {
          schemaVersion: 2,
          enabled: true,
          routes: [
            {
              id: "used-route",
              targetProviderId: used.id,
              modelSelection: { mode: "all" },
              authPolicy: { source: "provider_config" },
            },
          ],
        },
      },
    };

    renderWizard([used, unused, plan], { mode: "edit", planId: plan.id });

    fireEvent.click(
      screen.getByRole("button", { name: "Choose model sources" }),
    );
    expect(
      screen.getByText(/Selected 1 \/ 2 Codex providers as sources/),
    ).toBeVisible();
    expect(
      screen.getByRole("checkbox", {
        name: "Use Used source as a model source",
      }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", {
        name: "Use Unused source as a model source",
      }),
    ).not.toBeChecked();
  });

  it("requires an explicit redacted migration preview before editing a v1 plan", async () => {
    const legacyPlan: Provider = {
      id: "legacy-plan",
      name: "Legacy Plan",
      category: "custom",
      settingsConfig: {
        auth: { OPENAI_API_KEY: "must-not-render" },
        codexRouting: {
          enabled: true,
          routes: [
            {
              id: "legacy-route",
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

    renderWizard([legacyPlan], { mode: "edit", planId: legacyPlan.id });

    expect(
      await screen.findByRole("heading", {
        name: "Migrate legacy MultiRouter before editing",
      }),
    ).toBeVisible();
    expect(providersApi.getCodexMultiRouterRevision).toHaveBeenCalledWith(
      legacyPlan.id,
    );
    expect(screen.queryByText("legacy-secret")).not.toBeInTheDocument();
    expect(screen.queryByText("must-not-render")).not.toBeInTheDocument();
  });

  it("keeps provider-owned protocol and hosted-tool controls out of source selection", () => {
    renderWizard([
      {
        id: "third-party",
        name: "Third party source",
        category: "custom",
        settingsConfig: {
          baseUrl: "https://example.invalid/v1",
          auth: { OPENAI_API_KEY: "test-only" },
          modelCatalog: { models: [{ model: "third-party-model" }] },
        },
      },
    ]);

    fireEvent.click(
      screen.getByRole("button", { name: "Choose model sources" }),
    );
    expect(screen.queryByText("OpenAI Hosted Tools")).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Third party source API format"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Configure Third party source" }),
    ).toBeVisible();
  });

  it("shows provider-owned readiness details in the model source card", () => {
    renderWizard([
      {
        id: "ready-source",
        name: "Ready source",
        category: "custom",
        settingsConfig: {
          baseUrl: "https://example.invalid/v1",
          apiFormat: "openai_responses",
          auth: { OPENAI_API_KEY: "test-only" },
          modelCatalog: {
            models: [
              {
                model: "ready-model",
                contextWindow: 128000,
                supportsImage: true,
              },
            ],
          },
        },
      },
    ]);

    fireEvent.click(
      screen.getByRole("button", { name: "Model source readiness" }),
    );
    expect(screen.getByText(/Auth: API key configured/)).toBeVisible();
    expect(screen.getByText(/Model catalog: 1/)).toBeVisible();
    expect(screen.getByText(/Protocol: openai_responses/)).toBeVisible();
    expect(
      screen.getByText(/Capabilities: 1\/1 models have capability summaries/),
    ).toBeVisible();
    expect(screen.getByText(/Tools\/projection:/)).toBeVisible();
  });

  it("reviews schema v2 route policy without inherited endpoint, protocol, or capabilities", () => {
    renderWizard([
      {
        id: "qwen-provider",
        name: "Qwen Provider",
        category: "custom",
        settingsConfig: {
          baseUrl: "https://secret-upstream.invalid/v1",
          apiFormat: "openai_chat",
          auth: { OPENAI_API_KEY: "must-not-render" },
          modelCatalog: {
            models: [
              {
                model: "qwen3.8",
                apiFormat: "openai_responses",
                codexCache: { cacheMode: "qwen_context_cache" },
              },
            ],
          },
        },
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Review routing" }));

    const providerBadge = screen.getByTitle("Provider ID: qwen-provider");
    expect(providerBadge).toHaveTextContent("Qwen Provider");
    expect(screen.getByText(/routes do not store these fields/)).toBeVisible();
    expect(screen.queryByText("openai_chat")).not.toBeInTheDocument();
    expect(screen.queryByText("openai_responses")).not.toBeInTheDocument();
    expect(
      screen.queryByText("https://secret-upstream.invalid/v1"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("must-not-render")).not.toBeInTheDocument();
  });

  it("updates the open wizard from the latest Provider model catalog", () => {
    const source: Provider = {
      id: "codex-deepseek",
      name: "DeepSeek Responses",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [
            { model: "deepseek-v4-flash", contextWindow: 128000 },
            { model: "deepseek-v4-pro", contextWindow: 128000 },
          ],
        },
      },
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wizard = (providers: Provider[]) => (
      <QueryClientProvider client={queryClient}>
        <CodexMultiRouterWizard
          open
          providers={providers}
          mode="create"
          onOpenChange={vi.fn()}
          onCreateProvider={vi.fn()}
          onOpenProviderConfig={vi.fn()}
          onOpenWorkspace={vi.fn()}
          onEnablePlan={vi.fn()}
        />
      </QueryClientProvider>
    );
    const view = render(wizard([source]));

    fireEvent.click(screen.getByRole("button", { name: "Choose models" }));
    expect(
      screen.queryByRole("checkbox", {
        name: "Keep deepseek-v4-flash-vision-exp",
      }),
    ).not.toBeInTheDocument();

    view.rerender(
      wizard([
        {
          ...source,
          settingsConfig: {
            ...source.settingsConfig,
            modelCatalog: {
              models: [
                { model: "deepseek-v4-flash", contextWindow: 1000000 },
                {
                  model: "deepseek-v4-flash-vision-exp",
                  contextWindow: 1000000,
                  inputModalities: ["text", "image"],
                },
                { model: "deepseek-v4-pro", contextWindow: 1000000 },
              ],
            },
          },
        },
      ]),
    );

    expect(
      screen.getByRole("checkbox", {
        name: "Keep deepseek-v4-flash-vision-exp",
      }),
    ).toBeChecked();
    expect(screen.getAllByText("1000000 ctx")).toHaveLength(3);
  });
});
