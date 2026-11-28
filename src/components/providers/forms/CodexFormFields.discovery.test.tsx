import type { ComponentProps, ReactNode } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { CodexCatalogModel } from "@/types";
import { codexProviderPresets } from "@/config/codexProviderPresets";
import { providersApi } from "@/lib/api/providers";
import {
  fetchCodexOauthModels,
  fetchCodexOfficialFallbackModels,
  fetchModelsForConfig,
  fetchXaiOauthModels,
  showFetchModelsError,
  type FetchedModel,
} from "@/lib/api/model-fetch";
import { CodexFormFields } from "./CodexFormFields";
import { CodexCatalogSyncReview } from "./CodexCatalogSyncReview";
import type { CodexProviderReadinessSection } from "./CodexProviderReadinessSection";

type ReadinessProps = ComponentProps<typeof CodexProviderReadinessSection>;
const view = vi.hoisted(() => ({ readiness: null as ReadinessProps | null }));
vi.mock("./CodexProviderReadinessSection", () => ({
  CodexProviderReadinessSection: (props: ReadinessProps) => {
    view.readiness = props;
    return null;
  },
}));
vi.mock("@/components/ui/form", () => ({
  FormLabel: ({ children }: { children?: ReactNode }) => (
    <label>{children}</label>
  ),
}));
// Observe existing default-model options without a removed readiness counter
// or opening the dropdown's unrelated popup implementation.
vi.mock("./shared", async (importOriginal) => {
  const original = await importOriginal<typeof import("./shared")>();
  return {
    ...original,
    ModelDropdown: ({ models }: { models: FetchedModel[] }) => (
      <output aria-label="Available default models">
        {JSON.stringify(models)}
      </output>
    ),
  };
});
vi.mock("./XaiOAuthSection", () => ({ XaiOAuthSection: () => null }));
vi.mock("./CodexKeyGroupModels", () => ({
  CodexKeyGroupModels: () => null,
  CommaSeparatedListInput: () => null,
}));
vi.mock("./CodexCatalogViewport", () => ({ CodexCatalogViewport: () => null }));
vi.mock("@/lib/api/model-fetch", () => ({
  fetchModelsForConfig: vi.fn(),
  fetchXaiOauthModels: vi.fn(),
  fetchCodexOauthModels: vi.fn(),
  fetchCodexOfficialFallbackModels: vi.fn(),
  showFetchModelsError: vi.fn(),
}));
vi.mock("@/lib/api/providers", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api/providers")>();
  return {
    ...original,
    providersApi: {
      ...original.providersApi,
      bindCodexPresetReasoningEvidence: vi.fn(),
    },
  };
});
vi.mock("sonner", () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

function readiness(): ReadinessProps {
  if (!view.readiness) throw new Error("Readiness mock has not rendered");
  return view.readiness;
}

function catalogModelIds(): string[] {
  return readiness().models.map((model) => model.model);
}

async function findModelSyncReview() {
  return within(
    await screen.findByRole("dialog", { name: "Review model sync" }),
  );
}

function availableDefaultModels(): FetchedModel[] {
  return JSON.parse(
    screen.getByLabelText("Available default models").textContent ?? "[]",
  ) as FetchedModel[];
}

afterEach(() => vi.restoreAllMocks());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

type FormProps = ComponentProps<typeof CodexFormFields>;
function formProps(overrides: Partial<FormProps> = {}): FormProps {
  return {
    providerId: "provider-a",
    providerName: "Provider A",
    codexApiKey: "redacted-test-credential",
    codexBaseUrl: "https://models.example.invalid/v1",
    onApiKeyChange: vi.fn(),
    onBaseUrlChange: vi.fn(),
    shouldShowApiKeyLink: false,
    websiteUrl: "",
    shouldShowSpeedTest: false,
    isFullUrl: false,
    onFullUrlChange: vi.fn(),
    isEndpointModalOpen: false,
    onEndpointModalToggle: vi.fn(),
    autoSelect: false,
    onAutoSelectChange: vi.fn(),
    apiFormat: "openai_responses",
    onApiFormatChange: vi.fn(),
    speedTestEndpoints: [],
    customUserAgent: "",
    onCustomUserAgentChange: vi.fn(),
    localProxyHeadersOverride: "",
    onLocalProxyHeadersOverrideChange: vi.fn(),
    localProxyBodyOverride: "",
    onLocalProxyBodyOverrideChange: vi.fn(),
    catalogModels: [{ model: "wire-old" }],
    onCatalogModelsChange: vi.fn(),
    ...overrides,
  };
}

const response: FetchedModel[] = [{ id: "wire-new", ownedBy: null }];

describe("Codex form discovery request ownership", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    view.readiness = null;
  });

  it.each([
    ["provider", { providerId: "provider-b" }],
    ["endpoint", { codexBaseUrl: "https://other.example.invalid/v1" }],
    ["full URL mode", { isFullUrl: true }],
    ["API key", { codexApiKey: "redacted-replacement-credential" }],
    ["user agent", { customUserAgent: "synthetic-user-agent" }],
    ["website", { websiteUrl: "https://other.example.invalid" }],
    ["key group mode", { apiKeyGroupMode: "round_robin" }],
    ["xAI preset", { isXaiOauthPreset: true }],
    ["xAI authentication", { isXaiOauthAuthenticated: true }],
    ["xAI account", { selectedXaiAccountId: "account-b" }],
    ["official provider", { isCanonicalOfficial: true }],
    ["official account", { officialAccountId: "account-b" }],
    ["official OAuth mode", { officialManagedOAuth: true }],
    ["provider name", { providerName: "Provider B" }],
    ["partner", { partnerPromotionKey: "another-partner" }],
    ["plan access key", { planAccessKeyId: "redacted-new-access" }],
    ["plan secret", { planSecretAccessKey: "redacted-new-secret" }],
    [
      "key groups",
      { apiKeyGroups: [{ id: "group-b", apiKeys: ["redacted-group"] }] },
    ],
  ] as Array<[string, Partial<FormProps>]>)(
    "rejects an old directory response after changing %s",
    async (_label, changed) => {
      const pending = deferred<FetchedModel[]>();
      vi.mocked(fetchModelsForConfig).mockReturnValue(pending.promise);
      const props = formProps();
      const { rerender } = render(<CodexFormFields {...props} />);
      act(() => readiness().onSyncModels());
      rerender(<CodexFormFields {...props} {...changed} />);
      await act(async () => pending.resolve(response));
      expect(props.onCatalogModelsChange).not.toHaveBeenCalled();
      expect(catalogModelIds()).toEqual(["wire-old"]);
    },
  );

  it("does not revive A's directory after changing A to B to A", async () => {
    // The canonical model remains configured across provider identity changes.
    // Its free flag is discovery-only dropdown metadata, so it proves whether
    // the old fetch cache survives without confusing it with catalog rows.
    vi.mocked(fetchModelsForConfig).mockResolvedValue([
      { id: "wire-old", ownedBy: null, isFree: true, contextWindow: 12_345 },
    ]);
    const props = formProps({ onModelChange: vi.fn() });
    const { rerender } = render(<CodexFormFields {...props} />);
    act(() => readiness().onSyncModels());
    const review = await findModelSyncReview();
    fireEvent.click(review.getByRole("button", { name: "Apply to draft" }));
    await waitFor(() =>
      expect(availableDefaultModels()).toContainEqual(
        expect.objectContaining({ id: "wire-old", isFree: true }),
      ),
    );
    expect(catalogModelIds()).toEqual(["wire-old"]);
    rerender(<CodexFormFields {...props} providerId="provider-b" />);
    expect(availableDefaultModels()).toEqual([
      { id: "wire-old", ownedBy: null },
    ]);
    rerender(<CodexFormFields {...props} />);
    expect(availableDefaultModels()).toEqual([
      { id: "wire-old", ownedBy: null },
    ]);
    expect(catalogModelIds()).toEqual(["wire-old"]);
    expect(fetchModelsForConfig).toHaveBeenCalledTimes(1);
  });

  it("rejects a stale sync callback after provider identity changes", () => {
    vi.mocked(fetchModelsForConfig).mockResolvedValue([]);
    const props = formProps();
    const { rerender } = render(<CodexFormFields {...props} />);
    const staleSync = readiness().onSyncModels;
    rerender(<CodexFormFields {...props} providerId="provider-b" />);
    act(() => staleSync());
    expect(fetchModelsForConfig).not.toHaveBeenCalled();
  });

  it("preserves the last usable catalog when the current request fails", async () => {
    vi.mocked(fetchModelsForConfig).mockRejectedValue(
      new Error("redacted failure"),
    );
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const props = formProps();
    render(<CodexFormFields {...props} />);
    act(() => readiness().onSyncModels());
    await waitFor(() => expect(readiness().isSyncingModels).toBe(false));
    expect(props.onCatalogModelsChange).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("dialog", { name: "Review model sync" }),
    ).toBeNull();
    warning.mockRestore();
  });
});

describe("Codex xAI OAuth catalog sync", () => {
  beforeEach(() => vi.resetAllMocks());

  it("reconciles a complete directory, disables removed models and refreshes automatic metadata", async () => {
    vi.mocked(fetchXaiOauthModels).mockResolvedValue([
      { id: "wire-current", ownedBy: null },
      { id: "wire-new", ownedBy: null },
    ]);
    const props = formProps({
      isXaiOauthPreset: true,
      isXaiOauthAuthenticated: true,
      selectedXaiAccountId: "account-a",
      catalogModels: [
        { model: "wire-old", enabled: true },
        {
          model: "wire-current",
          enabled: true,
          reasoning: {
            supported: true,
            supportedEfforts: ["max"],
            defaultEffort: "max",
            disableAllowed: false,
            upstream: { format: "string", parameter: "reasoning_effort" },
            source: "detection",
          },
        },
        {
          model: "user-choice",
          upstreamModel: "wire-current",
          reasoning: {
            supported: true,
            supportedEfforts: ["high"],
            defaultEffort: "high",
            disableAllowed: false,
            upstream: { format: "string", parameter: "reasoning_effort" },
            source: "user",
          },
        },
      ],
    });
    render(<CodexFormFields {...props} />);
    act(() => readiness().onSyncModels());
    await waitFor(() => expect(props.onCatalogModelsChange).toHaveBeenCalled());
    const rows = vi
      .mocked(props.onCatalogModelsChange!)
      .mock.calls.at(-1)![0] as CodexCatalogModel[];
    expect(rows.find((row) => row.model === "wire-old")?.enabled).toBe(false);
    expect(rows.find((row) => row.model === "wire-new")).toBeDefined();
    expect(rows.find((row) => row.model === "wire-current")).not.toHaveProperty(
      "reasoning",
    );
    expect(
      rows.find((row) => row.model === "user-choice")?.reasoning?.source,
    ).toBe("user");
  });
});

describe("Codex form discovery lifecycle", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    view.readiness = null;
  });

  it.each(["success", "failure"] as const)(
    "does not publish a late %s after unmount",
    async (outcome) => {
      const pending = deferred<FetchedModel[]>();
      vi.mocked(fetchModelsForConfig).mockReturnValue(pending.promise);
      const warning = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const error = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const props = formProps();
      const { unmount } = render(<CodexFormFields {...props} />);
      act(() => readiness().onSyncModels());
      expect(readiness().isSyncingModels).toBe(true);
      unmount();
      warning.mockClear();
      error.mockClear();

      await act(async () => {
        if (outcome === "success") pending.resolve(response);
        else pending.reject(new Error("redacted late failure"));
      });

      expect(props.onCatalogModelsChange).not.toHaveBeenCalled();
      expect(showFetchModelsError).not.toHaveBeenCalled();
      expect(toast.info).not.toHaveBeenCalled();
      expect(toast.success).not.toHaveBeenCalled();
      expect(toast.warning).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
      expect(warning).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    },
  );

  it("does not let an older failure finish a newer request", async () => {
    const older = deferred<FetchedModel[]>();
    const newer = deferred<FetchedModel[]>();
    vi.mocked(fetchModelsForConfig)
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const props = formProps();
    render(<CodexFormFields {...props} />);
    act(() => readiness().onSyncModels());
    act(() => readiness().onSyncModels());
    expect(fetchModelsForConfig).toHaveBeenCalledTimes(2);

    await act(async () =>
      older.reject(new Error("redacted superseded failure")),
    );
    expect(readiness().isSyncingModels).toBe(true);
    expect(props.onCatalogModelsChange).not.toHaveBeenCalled();
    expect(showFetchModelsError).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();

    await act(async () => newer.resolve(response));
    expect(readiness().isSyncingModels).toBe(false);
    const review = await findModelSyncReview();
    expect(props.onCatalogModelsChange).not.toHaveBeenCalled();
    expect(catalogModelIds()).toEqual(["wire-old"]);
    expect(
      review.getByRole("radio", { name: /disable missing models/i }),
    ).toBeChecked();
    expect(
      review.getByRole("checkbox", { name: /include new models/i }),
    ).not.toBeChecked();
    fireEvent.click(review.getByRole("button", { name: "Apply to draft" }));
    expect(catalogModelIds()).toEqual(["wire-old", "wire-new"]);
    expect(
      readiness().models.find((model) => model.model === "wire-old"),
    ).toMatchObject({ enabled: false });
    expect(
      readiness().models.find((model) => model.model === "wire-new"),
    ).toMatchObject({ enabled: false });
    expect(props.onCatalogModelsChange).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it("does not make a partial response authoritative when key groups are removed midflight", async () => {
    const pending = deferred<FetchedModel[]>();
    vi.mocked(fetchModelsForConfig).mockReturnValue(pending.promise);
    const props = formProps({
      apiKeyGroups: [{ id: "group-a", apiKeys: ["redacted-group-credential"] }],
      catalogModels: [{ model: "wire-old", enabled: true }],
    });
    const { rerender } = render(<CodexFormFields {...props} />);
    act(() => readiness().onSyncModels());
    rerender(<CodexFormFields {...props} apiKeyGroups={[]} />);

    await act(async () => pending.resolve(response));
    expect(
      screen.queryByRole("dialog", { name: "Review model sync" }),
    ).toBeNull();
    expect(props.onCatalogModelsChange).not.toHaveBeenCalled();
    expect(catalogModelIds()).toEqual(["wire-old"]);
    expect(readiness().models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ model: "wire-old", enabled: true }),
      ]),
    );
  });

  it("applies a complete sync directly for an empty catalog", async () => {
    vi.mocked(fetchModelsForConfig).mockResolvedValue(response);
    const onCatalogModelsChange = vi.fn();
    const onModelChange = vi.fn();
    const props = formProps({
      catalogModels: [],
      onCatalogModelsChange,
      onModelChange,
    });
    render(<CodexFormFields {...props} />);
    act(() => readiness().onSyncModels());

    await waitFor(() => expect(onCatalogModelsChange).toHaveBeenCalledOnce());

    expect(
      screen.queryByRole("dialog", { name: "Review model sync" }),
    ).toBeNull();
    expect(catalogModelIds()).toEqual(["wire-new"]);
    expect(onCatalogModelsChange).toHaveBeenCalledWith([
      expect.objectContaining({ model: "wire-new", enabled: true }),
    ]);
    expect(onModelChange).toHaveBeenCalledWith("wire-new");
    expect(toast.success).toHaveBeenCalledTimes(1);
  });
});

describe("Codex API-key model sync review", () => {
  beforeEach(() => vi.resetAllMocks());

  it("keeps Apply to draft enabled for a replaceable conflict without missing rows", () => {
    const onApply = vi.fn();
    render(
      <CodexCatalogSyncReview
        fetchedCount={1}
        addedModels={[]}
        conflictingModels={[{ model: "model-alias", canReplace: true }]}
        missingModels={[]}
        enabledMissingCount={0}
        hasMetadataChanges={false}
        coverage="complete"
        onApply={onApply}
        onCancel={vi.fn()}
      />,
    );

    const apply = screen.getByRole("button", { name: "Apply to draft" });
    expect(apply).toBeEnabled();

    fireEvent.click(apply);
    expect(onApply).toHaveBeenCalledWith("replace", false);
  });

  it("keeps Replace selectable when a replaceable conflict has another sync change", () => {
    const onApply = vi.fn();
    render(
      <CodexCatalogSyncReview
        fetchedCount={2}
        addedModels={["new-model"]}
        conflictingModels={[{ model: "model-alias", canReplace: true }]}
        missingModels={[]}
        enabledMissingCount={0}
        hasMetadataChanges={false}
        coverage="complete"
        onApply={onApply}
        onCancel={vi.fn()}
      />,
    );

    const replace = screen.getByRole("radio", { name: /replace catalog/i });
    fireEvent.click(replace);
    expect(replace).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
    expect(onApply).toHaveBeenCalledWith("replace", false);
  });

  it("does not offer replacement for a partial key-group sync", () => {
    render(
      <CodexCatalogSyncReview
        fetchedCount={1}
        addedModels={[]}
        conflictingModels={[{ model: "model-alias", canReplace: true }]}
        missingModels={[]}
        enabledMissingCount={0}
        hasMetadataChanges={false}
        coverage="key-groups"
        onApply={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("radio", { name: /replace catalog/i }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Apply to draft" })).toBeNull();
  });

  it("previews new and missing rows before replacing the catalog", async () => {
    vi.mocked(fetchModelsForConfig).mockResolvedValue([
      { id: "wire-current", ownedBy: null },
      ...response,
    ]);
    const props = formProps({
      codexModel: "wire-old",
      onModelChange: vi.fn(),
      protocolOverrides: {
        "wire-old": "openai_responses",
        "my-current": "openai_chat",
      },
      onProtocolOverridesChange: vi.fn(),
      catalogModels: [
        { model: "wire-old", enabled: true },
        {
          model: "my-current",
          upstreamModel: "wire-current",
          displayName: "Current custom name",
          enabled: false,
        },
      ],
    });
    render(<CodexFormFields {...props} />);
    act(() => readiness().onSyncModels());
    const review = await findModelSyncReview();
    expect(review.getByText("wire-new")).toBeInTheDocument();
    expect(review.getByText("wire-old")).toBeInTheDocument();
    expect(review.queryByText("my-current")).toBeNull();
    expect(props.onCatalogModelsChange).not.toHaveBeenCalled();
    expect(props.onModelChange).not.toHaveBeenCalled();
    expect(props.onProtocolOverridesChange).not.toHaveBeenCalled();

    fireEvent.click(review.getByRole("radio", { name: /replace catalog/i }));
    fireEvent.click(
      review.getByRole("checkbox", { name: /include new models/i }),
    );
    fireEvent.click(review.getByRole("button", { name: "Apply to draft" }));

    expect(catalogModelIds()).toEqual(["my-current", "wire-new"]);
    expect(props.onCatalogModelsChange).toHaveBeenCalledOnce();
    expect(props.onCatalogModelsChange).toHaveBeenCalledWith([
      expect.objectContaining({
        model: "my-current",
        upstreamModel: "wire-current",
        displayName: "Current custom name",
        enabled: false,
      }),
      expect.objectContaining({ model: "wire-new", enabled: true }),
    ]);
    expect(props.onModelChange).toHaveBeenCalledOnce();
    expect(props.onModelChange).toHaveBeenCalledWith("wire-new");
    expect(props.onProtocolOverridesChange).toHaveBeenCalledOnce();
    expect(props.onProtocolOverridesChange).toHaveBeenCalledWith({
      "my-current": "openai_chat",
    });
    expect(availableDefaultModels()).toEqual([
      { id: "wire-new", ownedBy: null },
    ]);
  });

  it("can keep missing rows included while adding new models", async () => {
    vi.mocked(fetchModelsForConfig).mockResolvedValue(response);
    const props = formProps({
      catalogModels: [{ model: "wire-old", enabled: true }],
    });
    render(<CodexFormFields {...props} />);
    act(() => readiness().onSyncModels());
    const review = await findModelSyncReview();
    fireEvent.click(
      review.getByRole("radio", { name: /keep missing models/i }),
    );
    fireEvent.click(review.getByRole("button", { name: "Apply to draft" }));

    expect(props.onCatalogModelsChange).toHaveBeenCalledOnce();
    expect(props.onCatalogModelsChange).toHaveBeenCalledWith([
      expect.objectContaining({ model: "wire-old", enabled: true }),
      expect.objectContaining({ model: "wire-new", enabled: false }),
    ]);
  });

  it("keeps Apply enabled for replacement when every missing model is already excluded", async () => {
    vi.mocked(fetchModelsForConfig).mockResolvedValue([
      { id: "wire-current", ownedBy: null },
    ]);
    const currentModel = {
      model: "wire-current",
      displayName: "Current custom name",
      enabled: true,
    };
    const props = formProps({
      codexModel: currentModel.model,
      onModelChange: vi.fn(),
      catalogModels: [
        { model: "wire-old-a", enabled: false },
        currentModel,
        { model: "wire-old-b", enabled: false },
      ],
    });
    render(<CodexFormFields {...props} />);
    act(() => readiness().onSyncModels());
    const review = await findModelSyncReview();

    expect(catalogModelIds()).toEqual([
      "wire-old-a",
      "wire-current",
      "wire-old-b",
    ]);
    expect(props.onCatalogModelsChange).not.toHaveBeenCalled();
    expect(props.onModelChange).not.toHaveBeenCalled();
    expect(
      review.getByText("All missing models are already excluded."),
    ).toBeInTheDocument();
    expect(review.getByText("wire-old-a")).toBeInTheDocument();
    expect(review.getByText("wire-old-b")).toBeInTheDocument();
    const replace = review.getByRole("radio", { name: /replace catalog/i });
    expect(replace).toBeChecked();
    const apply = review.getByRole("button", {
      name: "Apply to draft",
    });
    expect(apply).toBeEnabled();

    const disable = review.getByRole("radio", {
      name: /disable missing models/i,
    });
    const keep = review.getByRole("radio", { name: /keep missing models/i });
    expect(disable).toBeDisabled();
    expect(keep).toBeDisabled();
    fireEvent.click(disable);
    fireEvent.click(keep);
    expect(replace).toBeChecked();
    expect(apply).toBeEnabled();
    expect(props.onCatalogModelsChange).not.toHaveBeenCalled();

    fireEvent.click(apply);

    expect(catalogModelIds()).toEqual(["wire-current"]);
    expect(props.onCatalogModelsChange).toHaveBeenCalledOnce();
    expect(props.onCatalogModelsChange).toHaveBeenCalledWith([
      expect.objectContaining(currentModel),
    ]);
    expect(props.onModelChange).not.toHaveBeenCalled();
  });

  it.each([
    {
      choice: /keep missing models/i,
      initiallyIncluded: true,
      expectedIncluded: true,
      replacesAlias: false,
      changesCatalog: false,
    },
    {
      choice: /disable missing models/i,
      initiallyIncluded: true,
      expectedIncluded: false,
      replacesAlias: false,
      changesCatalog: true,
    },
    {
      choice: /replace catalog/i,
      initiallyIncluded: true,
      expectedIncluded: true,
      replacesAlias: true,
      changesCatalog: true,
    },
    {
      choice: /replace catalog/i,
      initiallyIncluded: false,
      expectedIncluded: true,
      replacesAlias: true,
      changesCatalog: true,
    },
  ])(
    "handles a new upstream ID that matches an existing public alias ($choice, included: $initiallyIncluded)",
    async ({
      choice,
      initiallyIncluded,
      expectedIncluded,
      replacesAlias,
      changesCatalog,
    }) => {
      vi.mocked(fetchModelsForConfig).mockResolvedValue(response);
      const props = formProps({
        catalogModels: [
          {
            model: "wire-new",
            upstreamModel: "wire-old",
            enabled: initiallyIncluded,
          },
        ],
        protocolOverrides: { "wire-new": "openai_chat" },
        onProtocolOverridesChange: vi.fn(),
      });
      render(<CodexFormFields {...props} />);
      act(() => readiness().onSyncModels());
      const review = await findModelSyncReview();
      if (!initiallyIncluded) {
        expect(
          review.getByRole("radio", { name: /keep missing models/i }),
        ).toBeInTheDocument();
        expect(
          review.getByRole("radio", { name: /disable missing models/i }),
        ).toBeInTheDocument();
      }
      const option = review.getByRole("radio", { name: choice });
      if (changesCatalog) {
        fireEvent.click(option);
      } else {
        expect(option).toBeDisabled();
      }
      const includeNew = review.queryByRole("checkbox", {
        name: /include new models/i,
      });
      if (replacesAlias) {
        expect(includeNew).toBeInTheDocument();
        fireEvent.click(includeNew!);
      } else {
        expect(includeNew).toBeNull();
      }
      const apply = review.getByRole("button", { name: "Apply to draft" });
      if (changesCatalog) {
        fireEvent.click(apply);
      } else {
        expect(apply).toBeEnabled();
        const conflicts = review.getByRole("list", {
          name: /model IDs already in use/i,
        });
        expect(within(conflicts).getByText("wire-new")).toBeInTheDocument();
        fireEvent.click(review.getByRole("button", { name: "Cancel" }));
        expect(props.onCatalogModelsChange).not.toHaveBeenCalled();
      }

      if (replacesAlias) {
        expect(props.onCatalogModelsChange).toHaveBeenCalledOnce();
        expect(props.onCatalogModelsChange).toHaveBeenCalledWith([
          expect.objectContaining({
            model: "wire-new",
            enabled: expectedIncluded,
          }),
        ]);
        expect(readiness().models[0]?.upstreamModel).not.toBe("wire-old");
        expect(props.onProtocolOverridesChange).toHaveBeenCalledOnce();
        expect(props.onProtocolOverridesChange).toHaveBeenCalledWith({});
      } else {
        expect(readiness().models).toEqual([
          expect.objectContaining({
            model: "wire-new",
            upstreamModel: "wire-old",
            enabled: expectedIncluded,
          }),
        ]);
        expect(props.onProtocolOverridesChange).not.toHaveBeenCalled();
      }
    },
  );

  it("preserves models outside the main key's directory when using key groups", async () => {
    vi.mocked(fetchModelsForConfig).mockResolvedValue(response);
    const props = formProps({
      apiKeyGroups: [{ id: "group-a", apiKeys: ["redacted-group-credential"] }],
      catalogModels: [{ model: "wire-old", enabled: true }],
    });
    render(<CodexFormFields {...props} />);
    act(() => readiness().onSyncModels());
    const review = await findModelSyncReview();
    expect(
      review.queryByRole("radio", { name: /disable missing models/i }),
    ).toBeNull();
    expect(
      review.queryByRole("radio", { name: /replace catalog/i }),
    ).toBeNull();
    fireEvent.click(review.getByRole("button", { name: "Apply to draft" }));

    expect(props.onCatalogModelsChange).toHaveBeenCalledOnce();
    expect(props.onCatalogModelsChange).toHaveBeenCalledWith([
      expect.objectContaining({ model: "wire-old", enabled: true }),
      expect.objectContaining({ model: "wire-new", enabled: false }),
    ]);
  });

  it("offers no missing-model actions after an empty response", async () => {
    vi.mocked(fetchModelsForConfig).mockResolvedValue([]);
    const props = formProps({
      catalogModels: [{ model: "wire-old", enabled: true }],
    });
    render(<CodexFormFields {...props} />);
    act(() => readiness().onSyncModels());
    const review = await findModelSyncReview();
    expect(
      review.getByText(/provider returned no models/i),
    ).toBeInTheDocument();
    expect(review.queryByRole("radio")).toBeNull();
    expect(review.queryByRole("button", { name: "Apply to draft" })).toBeNull();
    fireEvent.click(review.getByText("Close", { selector: "button" }));

    expect(props.onCatalogModelsChange).not.toHaveBeenCalled();
    expect(readiness().models).toEqual([
      expect.objectContaining({ model: "wire-old", enabled: true }),
    ]);
  });

  it("leaves the draft unchanged when a user cancels replacement", async () => {
    vi.mocked(fetchModelsForConfig).mockResolvedValue(response);
    const props = formProps();
    render(<CodexFormFields {...props} />);
    act(() => readiness().onSyncModels());
    const review = await findModelSyncReview();
    fireEvent.click(review.getByRole("radio", { name: /replace catalog/i }));
    fireEvent.click(review.getByRole("button", { name: "Cancel" }));

    expect(
      screen.queryByRole("dialog", { name: "Review model sync" }),
    ).toBeNull();
    expect(props.onCatalogModelsChange).not.toHaveBeenCalled();
    expect(catalogModelIds()).toEqual(["wire-old"]);
  });

  it.each([2, 512])(
    "reuses the emitted draft rows when the parent echoes a %i-model catalog",
    async (modelCount) => {
      const catalogModels = Array.from({ length: modelCount }, (_, index) => ({
        model: `existing-${index}`,
      }));
      vi.mocked(fetchModelsForConfig).mockResolvedValue([
        ...catalogModels.map(({ model }) => ({ id: model, ownedBy: null })),
        ...response,
      ]);
      const onCatalogModelsChange =
        vi.fn<(models: CodexCatalogModel[]) => void>();
      const props = formProps({ catalogModels, onCatalogModelsChange });
      const { rerender } = render(<CodexFormFields {...props} />);
      act(() => readiness().onSyncModels());
      const review = await findModelSyncReview();
      fireEvent.click(review.getByRole("button", { name: "Apply to draft" }));
      expect(onCatalogModelsChange).toHaveBeenCalledOnce();
      const [emittedModels] = onCatalogModelsChange.mock.calls[0];
      expect(emittedModels).toHaveLength(modelCount + 1);

      const createRowId = vi.spyOn(crypto, "randomUUID");
      rerender(<CodexFormFields {...props} catalogModels={emittedModels} />);

      expect(createRowId).not.toHaveBeenCalled();
      expect(onCatalogModelsChange).toHaveBeenCalledOnce();
      expect(catalogModelIds()).toContain("wire-new");
    },
  );

  it("applies replacement to newer draft rows while the review is open", async () => {
    vi.mocked(fetchModelsForConfig).mockResolvedValue([
      { id: "wire-shared", ownedBy: null },
      ...response,
    ]);
    const props = formProps({
      catalogModels: [{ model: "wire-old" }, { model: "wire-shared" }],
    });
    const { rerender } = render(<CodexFormFields {...props} />);
    act(() => readiness().onSyncModels());
    const review = await findModelSyncReview();
    fireEvent.click(review.getByRole("radio", { name: /replace catalog/i }));

    rerender(
      <CodexFormFields
        {...props}
        catalogModels={[
          { model: "wire-old" },
          { model: "wire-shared", displayName: "Edited during review" },
          { model: "wire-new", displayName: "Added during review" },
        ]}
      />,
    );

    const apply = review.getByRole("button", { name: "Apply to draft" });
    expect(apply).toBeEnabled();
    fireEvent.click(apply);
    expect(props.onCatalogModelsChange).toHaveBeenCalledOnce();
    expect(props.onCatalogModelsChange).toHaveBeenCalledWith([
      expect.objectContaining({
        model: "wire-shared",
        displayName: "Edited during review",
      }),
      expect.objectContaining({
        model: "wire-new",
        displayName: "Added during review",
      }),
    ]);
  });

  it("clears pending choices when credentials change and never revives them", async () => {
    vi.mocked(fetchModelsForConfig).mockResolvedValue(response);
    const props = formProps();
    const { rerender } = render(<CodexFormFields {...props} />);
    act(() => readiness().onSyncModels());
    const review = await findModelSyncReview();
    fireEvent.click(review.getByRole("radio", { name: /replace catalog/i }));

    rerender(<CodexFormFields {...props} codexApiKey="redacted-other-key" />);
    expect(
      screen.queryByRole("dialog", { name: "Review model sync" }),
    ).toBeNull();
    rerender(<CodexFormFields {...props} />);
    expect(
      screen.queryByRole("dialog", { name: "Review model sync" }),
    ).toBeNull();
    expect(props.onCatalogModelsChange).not.toHaveBeenCalled();
    expect(catalogModelIds()).toEqual(["wire-old"]);
  });
});

describe("Codex OAuth discovery identity", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    view.readiness = null;
  });

  it.each([
    ["account", { selectedXaiAccountId: "account-b" }],
    ["authentication", { isXaiOauthAuthenticated: false }],
    ["provider type", { isXaiOauthPreset: false }],
  ] as Array<[string, Partial<FormProps>]>)(
    "rejects an xAI response after changing its %s",
    async (_label, changed) => {
      const pending = deferred<FetchedModel[]>();
      vi.mocked(fetchXaiOauthModels).mockReturnValue(pending.promise);
      const props = formProps({
        isXaiOauthPreset: true,
        isXaiOauthAuthenticated: true,
        selectedXaiAccountId: "account-a",
      });
      const { rerender } = render(<CodexFormFields {...props} />);
      act(() => readiness().onSyncModels());
      expect(fetchXaiOauthModels).toHaveBeenCalledWith("account-a");
      rerender(<CodexFormFields {...props} {...changed} />);

      await act(async () => pending.resolve(response));
      expect(props.onCatalogModelsChange).not.toHaveBeenCalled();
      expect(catalogModelIds()).toEqual(["wire-old"]);
      expect(toast.success).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["account", { officialAccountId: "account-b" }],
    ["OAuth mode", { officialManagedOAuth: false }],
    ["official-provider status", { isCanonicalOfficial: false }],
  ] as Array<[string, Partial<FormProps>]>)(
    "rejects an official OAuth response after changing its %s",
    async (_label, changed) => {
      const pending = deferred<FetchedModel[]>();
      vi.mocked(fetchCodexOauthModels).mockReturnValue(pending.promise);
      const props = formProps({
        isCanonicalOfficial: true,
        officialManagedOAuth: true,
        officialAccountId: "account-a",
      });
      const { rerender } = render(<CodexFormFields {...props} />);
      act(() => readiness().onSyncModels());
      expect(fetchCodexOauthModels).toHaveBeenCalledWith("account-a");
      rerender(<CodexFormFields {...props} {...changed} />);

      await act(async () => pending.resolve(response));
      expect(props.onCatalogModelsChange).not.toHaveBeenCalled();
      expect(catalogModelIds()).toEqual(["wire-old"]);
      expect(toast.success).not.toHaveBeenCalled();
    },
  );

  it("rejects public official discovery after switching to managed OAuth", async () => {
    const pending = deferred<FetchedModel[]>();
    vi.mocked(fetchCodexOfficialFallbackModels).mockReturnValue(
      pending.promise,
    );
    const props = formProps({
      isCanonicalOfficial: true,
      officialManagedOAuth: false,
    });
    const { rerender } = render(<CodexFormFields {...props} />);
    act(() => readiness().onSyncModels());
    expect(fetchCodexOfficialFallbackModels).toHaveBeenCalledTimes(1);
    rerender(
      <CodexFormFields
        {...props}
        officialManagedOAuth
        officialAccountId="account-a"
      />,
    );

    await act(async () => pending.resolve(response));
    expect(props.onCatalogModelsChange).not.toHaveBeenCalled();
    expect(catalogModelIds()).toEqual(["wire-old"]);
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe("Codex xAI OAuth maintained reasoning regeneration", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    view.readiness = null;
  });

  function maintainedGrokBaseline() {
    const preset = codexProviderPresets.find(
      (candidate) => candidate.presetKey === "xai-grok-oauth",
    );
    const original = preset?.modelCatalog?.find(
      (model) => model.model === "grok-4.5",
    );
    if (!preset || !original?.reasoning) {
      throw new Error("The maintained xAI OAuth fixture is missing reasoning");
    }
    const fresh: CodexCatalogModel = {
      ...structuredClone(original),
      reasoning: {
        ...structuredClone(original.reasoning),
        evidenceScope: {
          transportFingerprint: "a".repeat(64),
          model: "grok-4.5",
        },
      },
    };
    return {
      preset,
      original,
      fresh,
      settings: { config: preset.config, modelCatalog: { models: [fresh] } },
    };
  }

  function xaiProps(overrides: Partial<FormProps> = {}): FormProps {
    return formProps({
      isXaiOauthPreset: true,
      isXaiOauthAuthenticated: true,
      selectedXaiAccountId: "account-a",
      ...overrides,
    });
  }

  it("binds only the fresh trusted preset and replaces stale automatic reasoning without overwriting a user declaration", async () => {
    const baseline = maintainedGrokBaseline();
    vi.mocked(fetchXaiOauthModels).mockResolvedValue([
      { id: "grok-4.5", ownedBy: null },
      { id: "wire-new", ownedBy: null },
    ]);
    vi.mocked(providersApi.bindCodexPresetReasoningEvidence).mockResolvedValue(
      baseline.settings,
    );
    const stale: CodexCatalogModel = {
      model: "grok-4.5",
      reasoning: {
        schemaVersion: 2,
        supportStatus: "confirmed_supported",
        controlKind: "graded",
        supportedEfforts: ["max"],
        defaultEffort: "max",
        disableAllowed: false,
        upstream: {
          format: "string",
          parameter: "reasoning_effort",
          effortMap: { max: "max" },
        },
        source: "detection",
        evidenceScope: {
          transportFingerprint: "b".repeat(64),
          model: "unrelated-old-model",
        },
      },
    };
    const explicit: CodexCatalogModel = {
      model: "my-grok-choice",
      upstreamModel: "grok-4.5",
      reasoning: {
        schemaVersion: 2,
        supportStatus: "confirmed_supported",
        controlKind: "graded",
        supportedEfforts: ["high"],
        defaultEffort: "high",
        disableAllowed: false,
        upstream: { format: "string", parameter: "reasoning_effort" },
        source: "user",
      },
    };
    const props = xaiProps({
      codexBaseUrl: "https://edited.example.invalid/v1",
      codexConfig:
        'model_provider = "edited"\n[model_providers.edited]\nbase_url = "https://edited.example.invalid/v1"',
      catalogModels: [stale, explicit],
    });
    render(<CodexFormFields {...props} />);
    act(() => readiness().onSyncModels());
    await waitFor(() => expect(props.onCatalogModelsChange).toHaveBeenCalled());

    expect(
      providersApi.bindCodexPresetReasoningEvidence,
    ).toHaveBeenCalledOnce();
    expect(providersApi.bindCodexPresetReasoningEvidence).toHaveBeenCalledWith({
      config: baseline.preset.config,
      modelCatalog: { models: [baseline.original] },
    });
    const rows = vi
      .mocked(props.onCatalogModelsChange!)
      .mock.calls.at(-1)![0] as CodexCatalogModel[];
    expect(rows.find((row) => row.model === "grok-4.5")?.reasoning).toEqual(
      baseline.fresh.reasoning,
    );
    expect(
      rows.find((row) => row.model === "my-grok-choice")?.reasoning,
    ).toEqual(explicit.reasoning);
    expect(stale.reasoning?.supportedEfforts).toEqual(["max"]);
    expect(catalogModelIds()).toEqual([
      "grok-4.5",
      "my-grok-choice",
      "wire-new",
    ]);
    expect(
      readiness().models.find((row) => row.model === "wire-new"),
    ).toMatchObject({ enabled: false });
  });

  it("rejects a bound baseline when the xAI account changes while binding is pending", async () => {
    const baseline = maintainedGrokBaseline();
    const pending = deferred<Record<string, unknown>>();
    vi.mocked(fetchXaiOauthModels).mockResolvedValue([
      { id: "grok-4.5", ownedBy: null },
    ]);
    vi.mocked(providersApi.bindCodexPresetReasoningEvidence).mockReturnValue(
      pending.promise,
    );
    const props = xaiProps();
    const { rerender } = render(<CodexFormFields {...props} />);
    act(() => readiness().onSyncModels());
    await waitFor(() =>
      expect(
        providersApi.bindCodexPresetReasoningEvidence,
      ).toHaveBeenCalledOnce(),
    );
    expect(readiness().isSyncingModels).toBe(true);
    expect(props.onCatalogModelsChange).not.toHaveBeenCalled();
    rerender(<CodexFormFields {...props} selectedXaiAccountId="account-b" />);

    await act(async () => pending.resolve(baseline.settings));
    expect(props.onCatalogModelsChange).not.toHaveBeenCalled();
    expect(catalogModelIds()).toEqual(["wire-old"]);
    expect(readiness().isSyncingModels).toBe(false);
    expect(toast.success).not.toHaveBeenCalled();
    expect(showFetchModelsError).not.toHaveBeenCalled();
  });

  it("preserves the last usable catalog when maintained evidence binding fails", async () => {
    const baseline = maintainedGrokBaseline();
    vi.mocked(fetchXaiOauthModels).mockResolvedValue([
      { id: "grok-4.5", ownedBy: null },
    ]);
    vi.mocked(providersApi.bindCodexPresetReasoningEvidence).mockRejectedValue(
      new Error("redacted evidence binding failure"),
    );
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const props = xaiProps({ catalogModels: [baseline.fresh] });
    render(<CodexFormFields {...props} />);
    // Mount-time image metadata hydration is separate from this failed sync.
    vi.mocked(props.onCatalogModelsChange!).mockClear();
    act(() => readiness().onSyncModels());
    await waitFor(() => expect(showFetchModelsError).toHaveBeenCalledOnce());

    expect(props.onCatalogModelsChange).not.toHaveBeenCalled();
    expect(readiness().models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          model: "grok-4.5",
          reasoning: baseline.fresh.reasoning,
        }),
      ]),
    );
    expect(catalogModelIds()).toEqual(["grok-4.5"]);
    expect(readiness().isSyncingModels).toBe(false);
    expect(toast.success).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith("[XaiOAuth] Failed to fetch models");
  });
});
