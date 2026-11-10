import type { ComponentProps, ReactNode } from "react";
import { act, render, waitFor } from "@testing-library/react";
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
      expect(readiness().discoveredModelCount).toBe(0);
    },
  );

  it("does not revive A's directory after changing A to B to A", async () => {
    vi.mocked(fetchModelsForConfig).mockResolvedValue(response);
    const props = formProps();
    const { rerender } = render(<CodexFormFields {...props} />);
    act(() => readiness().onSyncModels());
    await waitFor(() => expect(readiness().discoveredModelCount).toBe(1));
    rerender(<CodexFormFields {...props} providerId="provider-b" />);
    rerender(<CodexFormFields {...props} />);
    expect(readiness().discoveredModelCount).toBe(0);
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
    expect(readiness().discoveredModelCount).toBe(1);
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
    expect(props.onCatalogModelsChange).not.toHaveBeenCalled();
    expect(readiness().discoveredModelCount).toBe(0);
    expect(readiness().models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ model: "wire-old", enabled: true }),
      ]),
    );
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
      expect(readiness().discoveredModelCount).toBe(0);
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
      expect(readiness().discoveredModelCount).toBe(0);
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
    expect(readiness().discoveredModelCount).toBe(0);
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
    expect(readiness().discoveredModelCount).toBe(2);
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
    expect(readiness().discoveredModelCount).toBe(0);
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
    expect(readiness().discoveredModelCount).toBe(0);
    expect(readiness().isSyncingModels).toBe(false);
    expect(toast.success).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith("[XaiOAuth] Failed to fetch models");
  });
});
