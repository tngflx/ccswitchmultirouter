import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  codexSubagentV2Api,
  type CodexSubagentV2MutationProvider,
} from "@/lib/api/codexSubagentV2";
import type { Provider } from "@/types";
import {
  createDefaultCodexSubagentV2Config,
  type CodexSubagentProfilePreview,
  type CodexSubagentProfileStatuses,
  type CodexSubagentReasoningCapability,
} from "@/types/codexSubagentV2";
import { CodexSubagentProfileEditor } from "./CodexSubagentProfileEditor";

vi.mock("@/lib/api/codexSubagentV2", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/codexSubagentV2")>()),
  codexSubagentV2Api: {
    getReasoningCapabilities: vi.fn(),
    getProfileStatuses: vi.fn(),
    previewProfile: vi.fn(),
    initializeProviderConfig: vi.fn(),
    reconcileProviderProfiles: vi.fn(),
    updateProviderConfig: vi.fn(),
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

function provider(
  id = "router-a",
  preference: "preferred" | "fallback" | "eligible" = "preferred",
  initialized = true,
): Provider {
  const config = createDefaultCodexSubagentV2Config();
  config.profiles["deepseek-v4-flash"].questionnaire.preference = preference;
  return {
    id,
    name: id,
    settingsConfig: {
      codexRouting: initialized ? { subagentV2: config } : {},
      modelCatalog: {
        models: [
          { model: "deepseek-v4-flash", enabled: true },
          { model: "deepseek-v4-pro", enabled: true },
        ],
      },
    },
  };
}

function mutationProvider(next = provider()): CodexSubagentV2MutationProvider {
  return {
    ...next,
    projection: { status: "not_required" },
    verification: {
      databasePersisted: true,
      roleFilesStatus: "not_required",
      roleFiles: [],
      activation: "restart_codex_and_start_new_session",
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function mount(
  initialProvider = provider(),
  options: {
    mutationCoordinator?: { acquire: () => boolean; release: () => void };
    mutationDisabled?: boolean;
    modelCatalog?: unknown;
    onPersisted?: (provider: Provider) => void;
  } = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const invalidate = vi
    .spyOn(queryClient, "invalidateQueries")
    .mockResolvedValue();
  const onPersisted = vi.fn(options.onPersisted);
  const view = (
    nextProvider: Provider,
    modelCatalog = options.modelCatalog,
  ) => (
    <QueryClientProvider client={queryClient}>
      <CodexSubagentProfileEditor
        provider={nextProvider}
        {...options}
        onPersisted={onPersisted}
        modelCatalog={modelCatalog}
      />
    </QueryClientProvider>
  );
  const result = render(view(initialProvider));
  return {
    ...result,
    invalidate,
    onPersisted,
    rerenderProvider: (
      nextProvider: Provider,
      modelCatalog = options.modelCatalog,
    ) => result.rerender(view(nextProvider, modelCatalog)),
  };
}

async function advance(ms = 120) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function preference() {
  return within(
    screen.getByRole("region", {
      name: "deepseek-v4-flash sub-agent configuration",
    }),
  ).getByLabelText("Model preference");
}

async function editThenSave() {
  fireEvent.change(preference(), { target: { value: "eligible" } });
  await advance();
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: "Save V2 sub-agent configuration" }),
    );
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.values(codexSubagentV2Api).forEach((method) =>
    vi.mocked(method).mockReset(),
  );
  vi.mocked(codexSubagentV2Api.getReasoningCapabilities).mockResolvedValue({
    "deepseek-v4-flash": capability,
    "deepseek-v4-pro": capability,
  });
  vi.mocked(codexSubagentV2Api.getProfileStatuses).mockResolvedValue(statuses);
  vi.mocked(codexSubagentV2Api.previewProfile).mockResolvedValue(preview);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Sub-Agent mutation scope", () => {
  it("does not adopt an initialized provider after the user selects another provider", async () => {
    const response = deferred<CodexSubagentV2MutationProvider>();
    vi.mocked(codexSubagentV2Api.initializeProviderConfig).mockReturnValue(
      response.promise,
    );
    const editor = mount(provider("router-a", "preferred", false));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Initialize V2 sub-agent capabilities",
      }),
    );
    editor.rerenderProvider(provider("router-b", "fallback"));
    await advance();

    await act(async () => response.resolve(mutationProvider()));

    expect(preference()).toHaveValue("fallback");
    expect(editor.onPersisted).not.toHaveBeenCalled();
    expect(editor.invalidate).toHaveBeenCalledWith({
      queryKey: ["providers", "codex"],
    });
    expect(
      screen.queryByText(/configuration initialized/),
    ).not.toBeInTheDocument();
  });

  it("does not adopt a reconciled provider or its projection warning after a provider switch", async () => {
    const response = deferred<CodexSubagentV2MutationProvider>();
    vi.mocked(codexSubagentV2Api.reconcileProviderProfiles).mockReturnValue(
      response.promise,
    );
    const editor = mount();
    await advance();
    fireEvent.click(
      screen.getByRole("button", { name: "Repair missing model profiles" }),
    );
    editor.rerenderProvider(provider("router-b", "fallback"));
    await advance();

    await act(async () =>
      response.resolve({
        ...mutationProvider(),
        projection: {
          status: "pending_retry",
          warning: {
            code: "codex_live_projection_pending_retry",
            message: "Stale provider projection warning",
          },
        },
      }),
    );

    expect(preference()).toHaveValue("fallback");
    expect(editor.onPersisted).not.toHaveBeenCalled();
    expect(editor.invalidate).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByText("Stale provider projection warning"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Missing model profiles repaired/),
    ).not.toBeInTheDocument();
  });

  it("does not start a stale save write after its validation completes for another provider", async () => {
    const validation = deferred<CodexSubagentProfileStatuses>();
    const editor = mount();
    await advance();
    fireEvent.change(preference(), { target: { value: "eligible" } });
    await advance();
    vi.mocked(codexSubagentV2Api.getProfileStatuses).mockReturnValueOnce(
      validation.promise,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Save V2 sub-agent configuration" }),
    );
    editor.rerenderProvider(provider("router-b", "fallback"));
    await advance();

    await act(async () => validation.resolve(statuses));

    expect(codexSubagentV2Api.updateProviderConfig).not.toHaveBeenCalled();
    expect(preference()).toHaveValue("fallback");
    expect(editor.onPersisted).not.toHaveBeenCalled();
    expect(
      screen.queryByText(/Backend did not return/),
    ).not.toBeInTheDocument();
  });

  it("lets an already-started save finish and invalidates cache without replacing another draft", async () => {
    const response = deferred<CodexSubagentV2MutationProvider>();
    vi.mocked(codexSubagentV2Api.updateProviderConfig).mockReturnValue(
      response.promise,
    );
    const editor = mount();
    await advance();
    await editThenSave();
    await advance(0);
    expect(codexSubagentV2Api.updateProviderConfig).toHaveBeenCalledTimes(1);
    editor.rerenderProvider(provider("router-b", "fallback"));
    await advance();

    await act(async () =>
      response.resolve(mutationProvider(provider("router-a", "eligible"))),
    );

    expect(preference()).toHaveValue("fallback");
    expect(editor.onPersisted).not.toHaveBeenCalled();
    expect(editor.invalidate).toHaveBeenCalledTimes(1);
  });

  it("ignores an earlier generation even after switching back to the same provider ID", async () => {
    const response = deferred<CodexSubagentV2MutationProvider>();
    vi.mocked(codexSubagentV2Api.reconcileProviderProfiles).mockReturnValue(
      response.promise,
    );
    const editor = mount();
    await advance();
    fireEvent.click(
      screen.getByRole("button", { name: "Repair missing model profiles" }),
    );
    editor.rerenderProvider(provider("router-b"));
    editor.rerenderProvider(provider("router-a", "fallback"));
    await advance();

    await act(async () => response.resolve(mutationProvider()));

    expect(preference()).toHaveValue("fallback");
    expect(editor.onPersisted).not.toHaveBeenCalled();
    expect(editor.invalidate).toHaveBeenCalledTimes(1);
  });

  it("does not display a stale mutation failure on a newly selected provider", async () => {
    const response = deferred<CodexSubagentV2MutationProvider>();
    vi.mocked(codexSubagentV2Api.reconcileProviderProfiles).mockReturnValue(
      response.promise,
    );
    const editor = mount();
    await advance();
    fireEvent.click(
      screen.getByRole("button", { name: "Repair missing model profiles" }),
    );
    editor.rerenderProvider(provider("router-b", "fallback"));
    await advance();

    await act(async () =>
      response.reject(new Error("Old provider write failed")),
    );

    expect(
      screen.queryByText("Old provider write failed"),
    ).not.toBeInTheDocument();
    expect(preference()).toHaveValue("fallback");
    expect(editor.invalidate).not.toHaveBeenCalled();
  });

  it("invalidates a successful write after unmount without notifying an inactive editor", async () => {
    const response = deferred<CodexSubagentV2MutationProvider>();
    vi.mocked(codexSubagentV2Api.initializeProviderConfig).mockReturnValue(
      response.promise,
    );
    const editor = mount(provider("router-a", "preferred", false));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Initialize V2 sub-agent capabilities",
      }),
    );
    editor.unmount();

    await act(async () => response.resolve(mutationProvider()));

    expect(editor.onPersisted).not.toHaveBeenCalled();
    expect(editor.invalidate).toHaveBeenCalledTimes(1);
  });

  it("holds the shared mutation lock through unmount until the database response settles", async () => {
    const response = deferred<CodexSubagentV2MutationProvider>();
    vi.mocked(codexSubagentV2Api.initializeProviderConfig).mockReturnValue(
      response.promise,
    );
    const coordinator = { acquire: vi.fn(() => true), release: vi.fn() };
    const editor = mount(provider("router-a", "preferred", false), {
      mutationCoordinator: coordinator,
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Initialize V2 sub-agent capabilities",
      }),
    );
    expect(coordinator.acquire).toHaveBeenCalledTimes(1);
    expect(coordinator.release).not.toHaveBeenCalled();
    editor.unmount();
    expect(coordinator.release).not.toHaveBeenCalled();

    await act(async () => response.resolve(mutationProvider()));

    expect(coordinator.release).toHaveBeenCalledTimes(1);
    expect(editor.onPersisted).not.toHaveBeenCalled();
    expect(editor.invalidate).toHaveBeenCalledTimes(1);
  });

  it("releases a validation-only operation on unmount without starting its write", async () => {
    const validation = deferred<CodexSubagentProfileStatuses>();
    const coordinator = { acquire: vi.fn(() => true), release: vi.fn() };
    const editor = mount(provider(), { mutationCoordinator: coordinator });
    await advance();
    fireEvent.change(preference(), { target: { value: "eligible" } });
    await advance();
    vi.mocked(codexSubagentV2Api.getProfileStatuses).mockReturnValueOnce(
      validation.promise,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Save V2 sub-agent configuration" }),
    );
    editor.unmount();
    expect(coordinator.release).not.toHaveBeenCalled();

    await act(async () => validation.resolve(statuses));

    expect(codexSubagentV2Api.updateProviderConfig).not.toHaveBeenCalled();
    expect(coordinator.release).toHaveBeenCalledTimes(1);
    expect(editor.invalidate).not.toHaveBeenCalled();
  });

  it("does not make a request or release another operation's unavailable shared lock", async () => {
    const coordinator = { acquire: vi.fn(() => false), release: vi.fn() };
    mount(provider("router-a", "preferred", false), {
      mutationCoordinator: coordinator,
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Initialize V2 sub-agent capabilities",
      }),
    );

    expect(coordinator.acquire).toHaveBeenCalledTimes(1);
    expect(codexSubagentV2Api.initializeProviderConfig).not.toHaveBeenCalled();
    expect(coordinator.release).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", {
        name: "Initialize V2 sub-agent capabilities",
      }),
    ).toBeEnabled();
  });

  it("honors the parent's disabled mutation state without acquiring its lock", () => {
    const coordinator = { acquire: vi.fn(() => true), release: vi.fn() };
    mount(provider("router-a", "preferred", false), {
      mutationCoordinator: coordinator,
      mutationDisabled: true,
    });
    const initialize = screen.getByRole("button", {
      name: "Initialize V2 sub-agent capabilities",
    });
    expect(initialize).toBeDisabled();
    fireEvent.click(initialize);

    expect(coordinator.acquire).not.toHaveBeenCalled();
    expect(codexSubagentV2Api.initializeProviderConfig).not.toHaveBeenCalled();
    expect(coordinator.release).not.toHaveBeenCalled();
  });

  it("does not let an old completion clear a newer provider's saving state", async () => {
    const first = deferred<CodexSubagentV2MutationProvider>();
    const second = deferred<CodexSubagentV2MutationProvider>();
    vi.mocked(codexSubagentV2Api.reconcileProviderProfiles)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const editor = mount();
    await advance();
    fireEvent.click(
      screen.getByRole("button", { name: "Repair missing model profiles" }),
    );
    editor.rerenderProvider(provider("router-b", "fallback"));
    await advance();
    fireEvent.click(
      screen.getByRole("button", { name: "Repair missing model profiles" }),
    );
    expect(codexSubagentV2Api.reconcileProviderProfiles).toHaveBeenCalledTimes(
      2,
    );

    await act(async () => first.resolve(mutationProvider()));

    expect(
      screen.getByRole("button", { name: "Repair missing model profiles" }),
    ).toBeDisabled();
    expect(editor.onPersisted).not.toHaveBeenCalled();
    await act(async () =>
      second.resolve(mutationProvider(provider("router-b", "fallback"))),
    );
    expect(
      screen.getByRole("button", { name: "Repair missing model profiles" }),
    ).toBeEnabled();
    expect(editor.onPersisted).toHaveBeenCalledTimes(1);
    expect(editor.onPersisted).toHaveBeenCalledWith(
      expect.objectContaining({ id: "router-b" }),
    );
  });

  it("rejects an unexpected provider response while still invalidating its successful write", async () => {
    vi.mocked(codexSubagentV2Api.reconcileProviderProfiles).mockResolvedValue(
      mutationProvider(provider("router-b", "fallback")),
    );
    const editor = mount();
    await advance();

    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: "Repair missing model profiles" }),
      ),
    );

    expect(preference()).toHaveValue("preferred");
    expect(editor.onPersisted).not.toHaveBeenCalled();
    expect(editor.invalidate).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Backend returned a different provider",
    );
  });

  it("does not adopt initialization over an externally refreshed config for the same provider ID", async () => {
    const response = deferred<CodexSubagentV2MutationProvider>();
    vi.mocked(codexSubagentV2Api.initializeProviderConfig).mockReturnValue(
      response.promise,
    );
    const editor = mount(provider("router-a", "preferred", false));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Initialize V2 sub-agent capabilities",
      }),
    );
    editor.rerenderProvider(provider("router-a", "fallback"));
    await advance();

    await act(async () => response.resolve(mutationProvider()));

    expect(preference()).toHaveValue("fallback");
    expect(editor.onPersisted).not.toHaveBeenCalled();
    expect(editor.invalidate).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByText(/configuration initialized/),
    ).not.toBeInTheDocument();
  });

  it("does not adopt reconciliation over an externally refreshed config for the same provider ID", async () => {
    const response = deferred<CodexSubagentV2MutationProvider>();
    vi.mocked(codexSubagentV2Api.reconcileProviderProfiles).mockReturnValue(
      response.promise,
    );
    const editor = mount();
    await advance();
    fireEvent.click(
      screen.getByRole("button", { name: "Repair missing model profiles" }),
    );
    editor.rerenderProvider(provider("router-a", "fallback"));
    await advance();

    await act(async () => response.resolve(mutationProvider()));

    expect(preference()).toHaveValue("fallback");
    expect(editor.onPersisted).not.toHaveBeenCalled();
    expect(editor.invalidate).toHaveBeenCalledTimes(1);
  });

  it("does not write after save validation when the same provider's canonical config changed", async () => {
    const validation = deferred<CodexSubagentProfileStatuses>();
    const editor = mount();
    await advance();
    fireEvent.change(preference(), { target: { value: "eligible" } });
    await advance();
    vi.mocked(codexSubagentV2Api.getProfileStatuses).mockReturnValueOnce(
      validation.promise,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Save V2 sub-agent configuration" }),
    );
    editor.rerenderProvider(provider("router-a", "fallback"));
    await advance();

    await act(async () => validation.resolve(statuses));

    expect(codexSubagentV2Api.updateProviderConfig).not.toHaveBeenCalled();
    expect(preference()).toHaveValue("fallback");
    expect(editor.onPersisted).not.toHaveBeenCalled();
  });

  it("does not adopt a started save over a same-ID external config refresh", async () => {
    const response = deferred<CodexSubagentV2MutationProvider>();
    vi.mocked(codexSubagentV2Api.updateProviderConfig).mockReturnValue(
      response.promise,
    );
    const editor = mount();
    await advance();
    await editThenSave();
    expect(codexSubagentV2Api.updateProviderConfig).toHaveBeenCalledTimes(1);
    editor.rerenderProvider(provider("router-a", "fallback"));
    await advance();

    await act(async () =>
      response.resolve(mutationProvider(provider("router-a", "eligible"))),
    );

    expect(preference()).toHaveValue("fallback");
    expect(editor.onPersisted).not.toHaveBeenCalled();
    expect(editor.invalidate).toHaveBeenCalledTimes(1);
  });

  it("does not save a validation snapshot after its canonical model catalog changes", async () => {
    const validation = deferred<CodexSubagentProfileStatuses>();
    const editor = mount();
    await advance();
    fireEvent.change(preference(), { target: { value: "eligible" } });
    await advance();
    vi.mocked(codexSubagentV2Api.getProfileStatuses).mockReturnValueOnce(
      validation.promise,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Save V2 sub-agent configuration" }),
    );
    const refreshed = provider();
    refreshed.settingsConfig = {
      ...refreshed.settingsConfig,
      modelCatalog: { models: [{ model: "deepseek-v4-flash", enabled: true }] },
    };
    editor.rerenderProvider(refreshed);
    await advance();

    await act(async () => validation.resolve(statuses));

    expect(codexSubagentV2Api.updateProviderConfig).not.toHaveBeenCalled();
    expect(editor.onPersisted).not.toHaveBeenCalled();
  });

  it("retains a successful mutation through its own adopted provider refresh", async () => {
    const saved = mutationProvider(provider("router-a", "fallback"));
    vi.mocked(codexSubagentV2Api.initializeProviderConfig).mockResolvedValue(
      saved,
    );
    const editor = mount(provider("router-a", "preferred", false), {
      onPersisted: (next) => editor.rerenderProvider(next),
    });
    const cacheRefresh = deferred<void>();
    editor.invalidate.mockReturnValue(cacheRefresh.promise);

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", {
          name: "Initialize V2 sub-agent capabilities",
        }),
      );
    });
    await advance();
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    await act(async () => cacheRefresh.resolve());

    expect(preference()).toHaveValue("fallback");
    expect(editor.onPersisted).toHaveBeenCalledTimes(1);
    expect(editor.invalidate).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText(/V2 sub-agent capability configuration initialized/),
    ).toBeInTheDocument();
  });

  it("invalidates save validation when the live projected model catalog prop changes", async () => {
    const validation = deferred<CodexSubagentProfileStatuses>();
    const current = provider();
    const editor = mount(current, {
      modelCatalog: {
        models: [
          { model: "deepseek-v4-flash", enabled: true },
          { model: "deepseek-v4-pro", enabled: true },
        ],
      },
    });
    await advance();
    fireEvent.change(preference(), { target: { value: "eligible" } });
    await advance();
    vi.mocked(codexSubagentV2Api.getProfileStatuses).mockReturnValueOnce(
      validation.promise,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Save V2 sub-agent configuration" }),
    );
    editor.rerenderProvider(current, {
      models: [{ model: "deepseek-v4-flash", enabled: true }],
    });
    await advance();

    await act(async () => validation.resolve(statuses));

    expect(codexSubagentV2Api.updateProviderConfig).not.toHaveBeenCalled();
    expect(editor.onPersisted).not.toHaveBeenCalled();
  });
});
