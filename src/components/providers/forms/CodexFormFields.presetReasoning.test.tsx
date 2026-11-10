import type { ComponentProps, ReactNode } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { codexProviderPresets } from "@/config/codexProviderPresets";
import { providersApi } from "@/lib/api/providers";
import type { CodexCatalogModel, CodexModelReasoningCapability } from "@/types";
import { CodexFormFields } from "./CodexFormFields";

vi.mock("@/lib/api/providers", () => ({
  providersApi: { bindCodexPresetReasoningEvidence: vi.fn() },
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
vi.mock("./CodexProviderReadinessSection", () => ({
  CodexProviderReadinessSection: () => null,
}));
vi.mock("./CodexCatalogViewport", () => ({
  CodexCatalogViewport: ({
    items,
    children,
  }: {
    items: { row: CodexCatalogModel & { rowId: string }; index: number }[];
    children: (item: {
      row: CodexCatalogModel & { rowId: string };
      index: number;
    }) => ReactNode;
  }) => (
    <>
      {items.map((item) => (
        <div key={item.row.rowId}>{children(item)}</div>
      ))}
    </>
  ),
}));
vi.mock("./CodexModelReasoningSummary", () => ({
  CodexModelReasoningSummary: ({ onToggle }: { onToggle: () => void }) => (
    <button onClick={onToggle}>Expand reasoning</button>
  ),
}));
vi.mock("./CodexModelReasoningEditor", () => ({
  CodexModelReasoningEditor: () => null,
}));
vi.mock("./CodexModelReasoningCard", () => ({
  CodexModelReasoningCard: () => null,
}));
vi.mock("sonner", () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

const preset = codexProviderPresets.find(
  (candidate) => candidate.presetKey === "xai-grok-oauth",
)!;
const maintainedModels = preset.modelCatalog!;
const evidenceScope = {
  transportFingerprint: "original-xai-transport",
  model: "grok-4.5",
};
const freshReasoning: CodexModelReasoningCapability = {
  ...maintainedModels[0].reasoning!,
  evidenceScope,
};
function boundSettings() {
  return {
    config: preset.config,
    modelCatalog: {
      models: [{ ...maintainedModels[0], reasoning: freshReasoning }],
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
type Props = ComponentProps<typeof CodexFormFields>;
function formProps(overrides: Partial<Props> = {}): Props {
  return {
    providerId: "provider-a",
    providerName: "Edited provider",
    codexApiKey: "redacted-credential",
    onApiKeyChange: vi.fn(),
    // A stale preset association must never bless its efforts for this endpoint.
    codexBaseUrl: "https://openrouter.ai/api/v1",
    codexConfig:
      'model_provider = "openrouter"\n[model_providers.openrouter]\nbase_url = "https://openrouter.ai/api/v1"',
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
    presetCatalogModels: maintainedModels,
    presetConfig: preset.config,
    catalogModels: [
      {
        model: "grok-4.5",
        reasoning: {
          ...freshReasoning,
          supportedEfforts: ["high"],
          source: "user",
        },
      },
    ],
    onCatalogModelsChange: vi.fn(),
    ...overrides,
  };
}
function restore() {
  fireEvent.click(screen.getByRole("button", { name: "Expand reasoning" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Restore built-in default" }),
  );
}

describe("Codex maintained reasoning restore", () => {
  beforeEach(() => vi.resetAllMocks());

  it("binds fresh baseline only to its original preset transport, never the edited endpoint", async () => {
    vi.mocked(providersApi.bindCodexPresetReasoningEvidence).mockResolvedValue(
      boundSettings(),
    );
    const props = formProps();
    render(<CodexFormFields {...props} />);
    vi.mocked(props.onCatalogModelsChange!).mockClear();
    restore();
    await waitFor(() => expect(props.onCatalogModelsChange).toHaveBeenCalled());
    expect(providersApi.bindCodexPresetReasoningEvidence).toHaveBeenCalledWith({
      config: preset.config,
      modelCatalog: { models: maintainedModels },
    });
    const rows = vi.mocked(props.onCatalogModelsChange!).mock.calls.at(-1)![0];
    expect(rows[0].reasoning).toEqual(freshReasoning);
    expect(rows[0].reasoning?.evidenceScope).toEqual(evidenceScope);
    expect(
      providersApi.bindCodexPresetReasoningEvidence,
    ).not.toHaveBeenCalledWith(
      expect.objectContaining({ base_url: props.codexBaseUrl }),
    );
  });

  it("does not restore into a different provider context after binding finishes", async () => {
    const pending = deferred<Record<string, unknown>>();
    vi.mocked(providersApi.bindCodexPresetReasoningEvidence).mockReturnValue(
      pending.promise,
    );
    const props = formProps();
    const { rerender } = render(<CodexFormFields {...props} />);
    vi.mocked(props.onCatalogModelsChange!).mockClear();
    restore();
    rerender(
      <CodexFormFields
        {...props}
        codexBaseUrl="https://another.example.invalid/v1"
      />,
    );
    await act(async () => pending.resolve(boundSettings()));
    expect(props.onCatalogModelsChange).not.toHaveBeenCalled();
  });

  it("does not overwrite a later explicit switch to automatic discovery", async () => {
    const pending = deferred<Record<string, unknown>>();
    vi.mocked(providersApi.bindCodexPresetReasoningEvidence).mockReturnValue(
      pending.promise,
    );
    const props = formProps();
    render(<CodexFormFields {...props} />);
    vi.mocked(props.onCatalogModelsChange!).mockClear();
    restore();
    fireEvent.change(
      screen.getByLabelText("grok-4.5 reasoning capability source"),
      { target: { value: "automatic" } },
    );
    await act(async () => pending.resolve(boundSettings()));
    const rows = vi.mocked(props.onCatalogModelsChange!).mock.calls.at(-1)![0];
    expect(rows[0].reasoning).toBeUndefined();
  });

  it("preserves the draft when fresh baseline preparation fails", async () => {
    vi.mocked(providersApi.bindCodexPresetReasoningEvidence).mockRejectedValue(
      new Error("redacted failure"),
    );
    const props = formProps();
    render(<CodexFormFields {...props} />);
    vi.mocked(props.onCatalogModelsChange!).mockClear();
    restore();
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(props.onCatalogModelsChange).not.toHaveBeenCalled();
  });

  it.each([undefined, "user_confirmed_detection"] as const)(
    "recognizes explicit source %s as manual and offers a maintained restore",
    (source) => {
      const props = formProps({
        catalogModels: [
          { model: "grok-4.5", reasoning: { ...freshReasoning, source } },
        ],
      });
      render(<CodexFormFields {...props} />);
      fireEvent.click(screen.getByRole("button", { name: "Expand reasoning" }));
      expect(
        screen.getByLabelText("grok-4.5 reasoning capability source"),
      ).toHaveValue("manual");
      expect(
        screen.getByRole("button", { name: "Restore built-in default" }),
      ).toBeInTheDocument();
    },
  );
});
