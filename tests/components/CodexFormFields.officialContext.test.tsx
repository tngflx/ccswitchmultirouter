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
import { I18nextProvider } from "react-i18next";
import { createLocalizedTestI18n } from "../utils/localizedTestI18n";
import { CodexFormFields } from "@/components/providers/forms/CodexFormFields";
import {
  fetchCodexOauthModels,
  fetchCodexOfficialFallbackModels,
  fetchModelsForConfig,
  type FetchedModel,
} from "@/lib/api/model-fetch";
import type { CodexCatalogModel } from "@/types";

let testI18n: Awaited<ReturnType<typeof createLocalizedTestI18n>>;

vi.mock("@/lib/api/model-fetch", () => ({
  fetchCodexOauthModels: vi.fn(),
  fetchCodexOfficialFallbackModels: vi.fn(),
  fetchModelsForConfig: vi.fn(),
  fetchXaiOauthModels: vi.fn(),
  probeCodexChatForConfig: vi.fn(),
  probeCodexResponsesForConfig: vi.fn(),
  showFetchModelsError: vi.fn(),
}));

vi.mock("@/lib/api/codexSubagentV2", () => ({
  codexSubagentV2Api: {
    resolveModelReasoningCapability: vi.fn(async () => null),
    triggerModelReasoningDetection: vi.fn(),
  },
}));

vi.mock("@/components/ui/form", () => ({
  FormLabel: ({ children }: { children: ReactNode }) => (
    <label>{children}</label>
  ),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function renderOfficial(
  catalog: CodexCatalogModel[],
  initial: { accountId?: string | null; managed?: boolean } = {},
) {
  let latest = catalog;
  function Harness({
    accountId = "account-a",
    managed = true,
  }: {
    accountId?: string | null;
    managed?: boolean;
  }) {
    const [models, setModels] = useState(catalog);
    return (
      <CodexFormFields
        providerId="codex-official"
        isCanonicalOfficial
        officialAccountId={accountId}
        officialManagedOAuth={managed}
        codexApiKey=""
        onApiKeyChange={vi.fn()}
        category="official"
        shouldShowApiKeyLink={false}
        websiteUrl=""
        shouldShowSpeedTest={false}
        codexBaseUrl=""
        onBaseUrlChange={vi.fn()}
        isFullUrl={false}
        onFullUrlChange={vi.fn()}
        isEndpointModalOpen={false}
        onEndpointModalToggle={vi.fn()}
        autoSelect={false}
        onAutoSelectChange={vi.fn()}
        takeoverEnabled={false}
        onTakeoverEnabledChange={vi.fn()}
        apiFormat="openai_responses"
        onApiFormatChange={vi.fn()}
        codexRouting={{ enabled: false, defaultRouteId: "", routes: [] }}
        speedTestEndpoints={[]}
        customUserAgent=""
        onCustomUserAgentChange={vi.fn()}
        localProxyHeadersOverride=""
        onLocalProxyHeadersOverrideChange={vi.fn()}
        localProxyBodyOverride=""
        onLocalProxyBodyOverrideChange={vi.fn()}
        catalogModels={models}
        onCatalogModelsChange={(next) => {
          latest = next;
          setModels(next);
        }}
      />
    );
  }
  const renderHarness = (source: {
    accountId?: string | null;
    managed?: boolean;
  }) => (
    <I18nextProvider i18n={testI18n}>
      <Harness {...source} />
    </I18nextProvider>
  );
  const view = render(renderHarness(initial));
  return {
    ...view,
    latest: () => latest,
    changeSource: (next: { accountId?: string | null; managed?: boolean }) =>
      view.rerender(renderHarness(next)),
  };
}

beforeEach(async () => {
  testI18n = await createLocalizedTestI18n();
  vi.mocked(fetchCodexOauthModels).mockReset();
  vi.mocked(fetchCodexOfficialFallbackModels).mockReset();
  vi.mocked(fetchModelsForConfig).mockReset();
});

describe("official provider context discovery", () => {
  it("waits for a resolved managed account instead of discovering an implicit backend default", () => {
    renderOfficial([{ model: "retained" }], { accountId: null });
    expect(
      screen.getByRole("button", { name: "Discover official models" }),
    ).toBeDisabled();
    expect(fetchCodexOauthModels).not.toHaveBeenCalled();
    expect(fetchCodexOfficialFallbackModels).not.toHaveBeenCalled();
  });

  it("clears trusted limits and rejects an old completion when the effective account changes", async () => {
    const old = deferred<FetchedModel[]>();
    vi.mocked(fetchCodexOauthModels)
      .mockResolvedValueOnce([
        {
          id: "retained",
          ownedBy: "openai",
          contextWindow: 128000,
          maxContextWindow: 900000,
        },
      ])
      .mockReturnValueOnce(old.promise)
      .mockRejectedValueOnce(new Error("new account unavailable"));
    const view = renderOfficial([
      { model: "retained", contextWindow: "64000" },
    ]);
    const discover = () => screen.getByRole("button", { name: /Discover/ });
    fireEvent.click(discover());
    await waitFor(() =>
      expect(
        screen.getByRole("option", { name: "Use maximum · 900,000" }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(discover());
    expect(discover()).toBeDisabled();
    view.changeSource({ accountId: "account-b" });
    expect(screen.queryByRole("option", { name: /Use maximum/ })).toBeNull();
    expect(screen.getByLabelText("retained Context window")).toBeDisabled();
    await act(async () =>
      old.resolve([
        {
          id: "stale-model",
          ownedBy: "openai",
          contextWindow: 128000,
          maxContextWindow: 1000000,
        },
      ]),
    );
    expect(view.latest()).toEqual([
      expect.objectContaining({ model: "retained", contextWindow: "64000" }),
    ]);
    expect(screen.queryByRole("group", { name: "stale-model" })).toBeNull();
    fireEvent.click(discover());
    await waitFor(() => expect(discover()).toBeEnabled());
    expect(fetchCodexOauthModels).toHaveBeenLastCalledWith("account-b");
    expect(fetchCodexOfficialFallbackModels).not.toHaveBeenCalled();
    expect(screen.getByLabelText("retained Context window")).toBeDisabled();
  });

  it("uses selected account metadata without persisting discovered defaults as overrides", async () => {
    vi.mocked(fetchCodexOauthModels).mockResolvedValue([
      {
        id: "upstream-a",
        ownedBy: "openai",
        contextWindow: 256000,
        maxContextWindow: 900000,
        maxInputTokens: 700000,
        maxOutputTokens: 20000,
      },
      {
        id: "new-model",
        ownedBy: "openai",
        contextWindow: 128000,
        maxContextWindow: 256000,
      },
      { id: "alias-collision", ownedBy: "openai", contextWindow: 128000 },
      { id: " ", ownedBy: "openai", contextWindow: 128000 },
    ]);
    const view = renderOfficial([
      {
        model: "custom-label",
        upstreamModel: "upstream-a",
        contextWindow: "128000",
        enabled: false,
      },
      {
        model: "alias-collision",
        upstreamModel: "other-upstream",
        contextWindow: "64000",
      },
    ]);
    expect(
      screen.getByRole("heading", { name: "Official model context windows" }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Discover official models" }),
    );
    await waitFor(() =>
      expect(fetchCodexOauthModels).toHaveBeenCalledWith("account-a"),
    );
    await waitFor(() => expect(view.latest()).toHaveLength(3));
    expect(view.latest()[0]).toMatchObject({
      model: "custom-label",
      contextWindow: "128000",
      enabled: false,
    });
    expect(
      view.latest().find((row) => row.model === "new-model")?.contextWindow ??
        "",
    ).toBe("");
    expect(screen.getByLabelText("custom-label Context window")).toHaveValue(
      "128000",
    );
    expect(
      within(screen.getByRole("group", { name: "custom-label" })).getByRole(
        "option",
        { name: "Use maximum · 900,000" },
      ),
    ).toHaveValue("900000");
    expect(fetchCodexOfficialFallbackModels).not.toHaveBeenCalled();
    expect(fetchModelsForConfig).not.toHaveBeenCalled();
  });

  it("uses an explicit public catalog for native or pooled authentication", async () => {
    vi.mocked(fetchCodexOfficialFallbackModels).mockResolvedValue([
      {
        id: "public-model",
        ownedBy: "openai",
        contextWindow: 128000,
        maxContextWindow: 1050000,
      },
    ]);
    const view = renderOfficial([], { managed: false });
    expect(
      screen.getByText(
        "Public official model catalog (not account authorization)",
      ),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Discover official models" }),
    );
    await waitFor(() => expect(view.latest()).toHaveLength(1));
    expect(fetchCodexOfficialFallbackModels).toHaveBeenCalledOnce();
    expect(fetchCodexOauthModels).not.toHaveBeenCalled();
    const row = within(screen.getByRole("group", { name: "public-model" }));
    expect(
      row.getByText("Directory maximum (unverified for this account)"),
    ).toBeInTheDocument();
    expect(row.queryByRole("option", { name: /Use maximum/ })).toBeNull();
    expect(row.queryByRole("option", { name: "1,000,000" })).toBeNull();
  });

  it("preserves the catalog on account discovery failure without silently using the public source", async () => {
    vi.mocked(fetchCodexOauthModels).mockRejectedValue(
      new Error("account unavailable"),
    );
    const view = renderOfficial([
      { model: "retained", contextWindow: "128000", enabled: false },
    ]);
    fireEvent.click(
      screen.getByRole("button", { name: "Discover official models" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Discover official models" }),
      ).toBeEnabled(),
    );
    expect(view.latest()).toEqual([
      expect.objectContaining({
        model: "retained",
        contextWindow: "128000",
        enabled: false,
      }),
    ]);
    expect(fetchCodexOfficialFallbackModels).not.toHaveBeenCalled();
  });

  it("invalidates an old account result and clears metadata when authentication changes", async () => {
    const old = deferred<FetchedModel[]>();
    vi.mocked(fetchCodexOauthModels).mockReturnValueOnce(old.promise);
    vi.mocked(fetchCodexOfficialFallbackModels).mockResolvedValue([
      { id: "retained", ownedBy: "openai", contextWindow: 128000 },
    ]);
    const view = renderOfficial([{ model: "retained" }]);
    fireEvent.click(
      screen.getByRole("button", { name: "Discover official models" }),
    );
    view.changeSource({ managed: false });
    await act(async () =>
      old.resolve([
        { id: "stale-account-model", ownedBy: "openai", contextWindow: 900000 },
      ]),
    );
    expect(view.latest().map((row) => row.model)).toEqual(["retained"]);
    fireEvent.click(
      screen.getByRole("button", { name: "Discover official models" }),
    );
    await waitFor(() =>
      expect(fetchCodexOfficialFallbackModels).toHaveBeenCalledOnce(),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("retained Context window")).toBeEnabled(),
    );
    view.changeSource({ accountId: "account-b", managed: true });
    expect(screen.getByLabelText("retained Context window")).toBeDisabled();
    expect(view.latest().map((row) => row.model)).toEqual(["retained"]);
  });
});
