import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codexSubagentV2Api } from "@/lib/api/codexSubagentV2";
import type { Provider } from "@/types";
import {
  createDefaultCodexSubagentV2Config,
  type CodexSubagentProfilePreview,
  type CodexSubagentProfileStatuses,
  type CodexSubagentReasoningCapabilities,
  type CodexSubagentReasoningCapability,
} from "@/types/codexSubagentV2";
import { CodexSubagentProfileEditor } from "./CodexSubagentProfileEditor";

vi.mock("@/lib/api/codexSubagentV2", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/codexSubagentV2")>()),
  codexSubagentV2Api: {
    getReasoningCapabilities: vi.fn(),
    getProfileStatuses: vi.fn(),
    previewProfile: vi.fn(),
  },
}));

const capability: CodexSubagentReasoningCapability = {
  supportKind: "effort_levels",
  confidence: "confirmed",
  source: "test",
  codexSelectableEfforts: ["low", "high", "max"],
  providerAcceptedEfforts: ["low", "high", "max"],
  providerDefaultEffort: "high",
  disableAllowed: false,
  effortMap: { low: "low", high: "high", max: "max" },
};

const capabilities: CodexSubagentReasoningCapabilities = {
  "deepseek-v4-flash": capability,
  "deepseek-v4-pro": capability,
};

const preview: CodexSubagentProfilePreview = {
  providerKind: "third_party",
  requestedRoleName: "repository-scout",
  effectiveRoleName: "repository-scout",
  editableDescription: "Current preview",
  description: "Current preview",
  editableDeveloperInstructions: "Current instructions",
  developerInstructions: "Current instructions",
  nicknameCandidates: ["Scout"],
  model: "deepseek-v4-flash",
  modelProvider: "codex_model_router_v2",
  modelReasoningEffort: "max",
  reasoningPolicy: "fixed",
  reasoningCapability: capability,
  modelContextWindow: 128000,
  tomlPreview: "Current TOML",
  warnings: [],
};

const statuses: CodexSubagentProfileStatuses = {
  mode: "v2",
  generationSource: "configured_profiles",
  profiles: ["deepseek-v4-flash", "deepseek-v4-pro"].map((model) => ({
    profileKey: model,
    model,
    enabled: true,
    routable: true,
    status: "generated",
    warnings: [],
  })),
  warnings: [],
};

function provider(id = "router"): Provider {
  return {
    id,
    name: id,
    settingsConfig: {
      codexRouting: { subagentV2: createDefaultCodexSubagentV2Config() },
      modelCatalog: {
        models: [
          { model: "deepseek-v4-flash", enabled: true },
          { model: "deepseek-v4-pro", enabled: true },
        ],
      },
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function mount(initialProvider = provider()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = (nextProvider: Provider, modelCatalog?: unknown) => (
    <QueryClientProvider client={queryClient}>
      <CodexSubagentProfileEditor
        provider={nextProvider}
        modelCatalog={modelCatalog}
      />
    </QueryClientProvider>
  );
  const result = render(view(initialProvider));
  return {
    ...result,
    rerenderProvider: (nextProvider: Provider, modelCatalog?: unknown) =>
      result.rerender(view(nextProvider, modelCatalog)),
  };
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function flashRegion() {
  return within(
    screen.getByRole("region", {
      name: "deepseek-v4-flash sub-agent configuration",
    }),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(codexSubagentV2Api.getReasoningCapabilities).mockReset();
  vi.mocked(codexSubagentV2Api.getProfileStatuses).mockReset();
  vi.mocked(codexSubagentV2Api.previewProfile).mockReset();
  vi.mocked(codexSubagentV2Api.getReasoningCapabilities).mockResolvedValue(
    capabilities,
  );
  vi.mocked(codexSubagentV2Api.getProfileStatuses).mockResolvedValue(statuses);
  vi.mocked(codexSubagentV2Api.previewProfile).mockResolvedValue(preview);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Sub-Agent diagnostic scheduling", () => {
  it("coalesces rapid open-row edits into one preview and one diagnostics pair", async () => {
    mount();
    await advance(120);
    expect(codexSubagentV2Api.previewProfile).toHaveBeenCalledTimes(1);
    vi.mocked(codexSubagentV2Api.previewProfile).mockClear();
    vi.mocked(codexSubagentV2Api.getReasoningCapabilities).mockClear();
    vi.mocked(codexSubagentV2Api.getProfileStatuses).mockClear();

    const preference = flashRegion().getByLabelText("Model preference");
    fireEvent.change(preference, { target: { value: "fallback" } });
    await advance(40);
    fireEvent.change(preference, { target: { value: "eligible" } });
    await advance(40);
    fireEvent.change(preference, { target: { value: "preferred" } });
    await advance(119);

    expect(codexSubagentV2Api.previewProfile).not.toHaveBeenCalled();
    expect(codexSubagentV2Api.getReasoningCapabilities).not.toHaveBeenCalled();
    expect(codexSubagentV2Api.getProfileStatuses).not.toHaveBeenCalled();

    await advance(1);
    expect(codexSubagentV2Api.previewProfile).toHaveBeenCalledTimes(1);
    expect(codexSubagentV2Api.getReasoningCapabilities).toHaveBeenCalledTimes(
      1,
    );
    expect(codexSubagentV2Api.getProfileStatuses).toHaveBeenCalledTimes(1);
    expect(codexSubagentV2Api.previewProfile).toHaveBeenLastCalledWith(
      expect.objectContaining({
        codexRouting: expect.objectContaining({
          subagentV2: expect.objectContaining({
            profiles: expect.objectContaining({
              "deepseek-v4-flash": expect.objectContaining({
                questionnaire: expect.objectContaining({
                  preference: "preferred",
                }),
              }),
            }),
          }),
        }),
      }),
      "deepseek-v4-flash",
      expect.objectContaining({
        questionnaire: expect.objectContaining({ preference: "preferred" }),
      }),
    );
    await advance(500);
    expect(codexSubagentV2Api.previewProfile).toHaveBeenCalledTimes(1);
  });

  it("ignores old preview, capability, and status responses during the debounce window", async () => {
    const oldPreview = deferred<CodexSubagentProfilePreview>();
    const oldCapabilities = deferred<CodexSubagentReasoningCapabilities>();
    const oldStatuses = deferred<CodexSubagentProfileStatuses>();
    vi.mocked(codexSubagentV2Api.previewProfile).mockReturnValueOnce(
      oldPreview.promise,
    );
    vi.mocked(codexSubagentV2Api.getReasoningCapabilities).mockReturnValueOnce(
      oldCapabilities.promise,
    );
    vi.mocked(codexSubagentV2Api.getProfileStatuses).mockReturnValueOnce(
      oldStatuses.promise,
    );
    mount();
    fireEvent.change(flashRegion().getByLabelText("Model preference"), {
      target: { value: "fallback" },
    });
    await act(async () => {
      oldPreview.resolve({ ...preview, description: "Stale preview response" });
      oldCapabilities.resolve({
        "deepseek-v4-flash": {
          ...capability,
          codexSelectableEfforts: ["ultra"],
        },
      });
      oldStatuses.resolve({ ...statuses, warnings: ["Stale status response"] });
    });
    fireEvent.click(
      flashRegion().getByRole("button", { name: "Generated result and TOML" }),
    );
    expect(
      screen.queryByText("Stale preview response"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Stale status response")).not.toBeInTheDocument();
    expect(
      flashRegion().queryByRole("option", { name: /^ultra$/ }),
    ).not.toBeInTheDocument();

    await advance(120);
    expect(screen.getByText("Current preview")).toBeInTheDocument();
    expect(codexSubagentV2Api.previewProfile).toHaveBeenCalledTimes(2);
    expect(codexSubagentV2Api.getProfileStatuses).toHaveBeenCalledTimes(2);
  });

  it("refreshes only the open preview when a closed row changes shared compilation inputs", async () => {
    mount();
    await advance(120);
    vi.mocked(codexSubagentV2Api.previewProfile).mockClear();
    fireEvent.click(
      screen.getByRole("switch", {
        name: "Enable deepseek-v4-pro as a V2 sub-agent",
      }),
    );
    await advance(120);
    expect(codexSubagentV2Api.previewProfile).toHaveBeenCalledTimes(1);
    expect(codexSubagentV2Api.previewProfile).toHaveBeenLastCalledWith(
      expect.objectContaining({
        codexRouting: expect.objectContaining({
          subagentV2: expect.objectContaining({
            profiles: expect.objectContaining({
              "deepseek-v4-pro": expect.objectContaining({ enabled: false }),
            }),
          }),
        }),
      }),
      "deepseek-v4-flash",
      expect.any(Object),
    );
  });

  it("invalidates pending diagnostics when switching providers with identical settings", async () => {
    const oldPreview = deferred<CodexSubagentProfilePreview>();
    const oldStatuses = deferred<CodexSubagentProfileStatuses>();
    vi.mocked(codexSubagentV2Api.previewProfile).mockReturnValueOnce(
      oldPreview.promise,
    );
    vi.mocked(codexSubagentV2Api.getProfileStatuses).mockReturnValueOnce(
      oldStatuses.promise,
    );
    const mounted = mount(provider("first"));
    mounted.rerenderProvider(provider("second"));
    await act(async () => {
      oldPreview.resolve({
        ...preview,
        description: "Previous provider preview",
      });
      oldStatuses.resolve({
        ...statuses,
        warnings: ["Previous provider status"],
      });
    });
    fireEvent.click(
      flashRegion().getByRole("button", { name: "Generated result and TOML" }),
    );
    expect(
      screen.queryByText("Previous provider preview"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Previous provider status"),
    ).not.toBeInTheDocument();
    await advance(120);
    expect(codexSubagentV2Api.previewProfile).toHaveBeenCalledTimes(2);
    expect(codexSubagentV2Api.getProfileStatuses).toHaveBeenCalledTimes(2);
  });

  it("preserves matching diagnostics when a persisted refresh catches up to the current draft", async () => {
    const currentProvider = provider();
    const mounted = mount(currentProvider);
    await advance(120);
    fireEvent.change(flashRegion().getByLabelText("Model reasoning effort"), {
      target: { value: "high" },
    });
    await advance(120);
    fireEvent.click(
      flashRegion().getByRole("button", { name: "Generated result and TOML" }),
    );
    expect(screen.getByText("Current preview")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Use Max where supported" }),
    ).toBeEnabled();
    vi.mocked(codexSubagentV2Api.previewProfile).mockClear();
    vi.mocked(codexSubagentV2Api.getReasoningCapabilities).mockClear();
    vi.mocked(codexSubagentV2Api.getProfileStatuses).mockClear();

    const persistedProvider = JSON.parse(
      JSON.stringify(currentProvider),
    ) as Provider;
    persistedProvider.settingsConfig.codexRouting.subagentV2.profiles[
      "deepseek-v4-flash"
    ].reasoning = { policy: "fixed", effort: "high" };
    mounted.rerenderProvider(persistedProvider);
    await advance(500);

    expect(screen.getByText("Current preview")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Use Max where supported" }),
    ).toBeEnabled();
    expect(codexSubagentV2Api.previewProfile).not.toHaveBeenCalled();
    expect(codexSubagentV2Api.getReasoningCapabilities).not.toHaveBeenCalled();
    expect(codexSubagentV2Api.getProfileStatuses).not.toHaveBeenCalled();

    mounted.rerenderProvider(JSON.parse(JSON.stringify(persistedProvider)));
    await advance(500);
    expect(screen.getByText("Current preview")).toBeInTheDocument();
    expect(codexSubagentV2Api.previewProfile).not.toHaveBeenCalled();
    expect(codexSubagentV2Api.getReasoningCapabilities).not.toHaveBeenCalled();
    expect(codexSubagentV2Api.getProfileStatuses).not.toHaveBeenCalled();
  });

  it("does not re-read or serialize unchanged profile state for local search renders", async () => {
    const currentProvider = provider();
    const routing = currentProvider.settingsConfig.codexRouting;
    const config = routing.subagentV2;
    const readConfig = vi.fn(() => config);
    Object.defineProperty(routing, "subagentV2", {
      enumerable: true,
      get: readConfig,
    });
    const serialize = vi.spyOn(JSON, "stringify");
    try {
      mount(currentProvider);
      await advance(120);
      readConfig.mockClear();
      serialize.mockClear();

      fireEvent.change(screen.getByLabelText("Search sub-agent models"), {
        target: { value: "flash" },
      });
      fireEvent.change(screen.getByLabelText("Search sub-agent models"), {
        target: { value: "" },
      });
      await advance(500);

      expect(readConfig).not.toHaveBeenCalled();
      expect(
        serialize.mock.calls.filter(([input]) => input === config),
      ).toHaveLength(0);
    } finally {
      serialize.mockRestore();
    }
  });

  it("refreshes the open preview with the latest projected catalog after one debounce", async () => {
    const currentProvider = provider();
    const mounted = mount(currentProvider);
    await advance(120);
    vi.mocked(codexSubagentV2Api.previewProfile).mockClear();
    vi.mocked(codexSubagentV2Api.getReasoningCapabilities).mockClear();
    const latestCatalog = {
      models: [
        { model: "deepseek-v4-flash", enabled: true, contextWindow: 200000 },
      ],
    };
    mounted.rerenderProvider(currentProvider, latestCatalog);
    await advance(119);
    expect(codexSubagentV2Api.previewProfile).not.toHaveBeenCalled();
    await advance(1);
    expect(codexSubagentV2Api.previewProfile).toHaveBeenCalledTimes(1);
    expect(codexSubagentV2Api.previewProfile).toHaveBeenLastCalledWith(
      expect.objectContaining({
        modelCatalog: expect.objectContaining(latestCatalog),
      }),
      "deepseek-v4-flash",
      expect.any(Object),
    );
    expect(codexSubagentV2Api.getReasoningCapabilities).toHaveBeenCalledTimes(
      1,
    );
  });
});
