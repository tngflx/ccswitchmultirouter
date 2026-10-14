import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RequestHealthPanel } from "@/components/settings/RequestHealthPanel";
import { proxyApi } from "@/lib/api/proxy";
import { settingsApi } from "@/lib/api/settings";
import type { RequestHealthSnapshot } from "@/types/proxy";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: toastMock }));

vi.mock("@/lib/api/settings", () => ({
  settingsApi: { get: vi.fn(), save: vi.fn() },
}));

vi.mock("@/lib/api/proxy", () => ({
  proxyApi: { checkOpenAIResponsesContract: vi.fn() },
}));

const snapshot: RequestHealthSnapshot = {
  config: {
    enabled: true,
    optimizationMode: "safe",
    largeRequestThresholdBytes: 393_216,
    maxCodexInputTokens: 200_000,
    reviewTimeoutSeconds: 60,
    reviewMode: "first_large_request",
    summarizeAndRestartEnabled: true,
    windowsNotificationsEnabled: true,
    windowsNotificationSnoozeHours: 4,
    windowsNotificationsSnoozedUntilMs: null,
  },
  contract: {
    version: 1,
    source:
      "https://developers.openai.com/api/reference/resources/responses/methods/create.md",
    verifiedAt: "2026-10-08",
    coverage:
      "Conservative Responses create field types and selected replay invariants",
    declarationsSha256: "a".repeat(64),
    status: "not_checked",
    checkedAt: null,
    changedSections: [],
    error: null,
  },
  diagnostics: [
    {
      generatedAt: "2026-09-01T00:34:31+08:00",
      traceId: "trace-large-request",
      sessionId: "session-1",
      appType: "codex",
      providerId: "router",
      providerName: "Codex MultiRouter",
      model: "gpt-5.6-sol",
      endpoint: "/v1/responses",
      clientRequestBytes: 1_430_000,
      originalBytes: 1_430_000,
      optimizedBytes: 1_430_000,
      bytesRemoved: 0,
      thresholdBytes: 393_216,
      thresholdExceeded: true,
      estimatedInputTokens: 357_500,
      maxInputTokens: 200_000,
      tokenLimitExceeded: true,
      blocked: false,
      itemCount: 350,
      largestItemBytes: 248_581,
      largestItemCategory: "message",
      mediaBytes: 0,
      mediaItems: 0,
      mediaDominated: false,
      dominantCategory: "tool_calls",
      recommendedAction: "summarize_and_restart",
      optimizationMode: "safe",
      optimizationApplied: false,
      compactionRequest: true,
      compactionRecommended: true,
      sessionClientProvided: true,
      findings: [],
      breakdown: [],
    },
  ],
};

describe("RequestHealthPanel", () => {
  beforeEach(() => {
    vi.mocked(settingsApi.get).mockReset();
    vi.mocked(settingsApi.save).mockReset();
    vi.mocked(proxyApi.checkOpenAIResponsesContract).mockReset();
    toastMock.success.mockReset();
    toastMock.error.mockReset();
  });

  it("renders the latest diagnostic and controls", () => {
    render(
      <RequestHealthPanel
        snapshot={snapshot}
        isRefreshing={false}
        onRefresh={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    expect(
      screen.getAllByText("Codex MultiRouter · gpt-5.6-sol").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByText("settings.requestHealth.reviewMode"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("settings.requestHealth.historyWarning"),
    ).toBeInTheDocument();
  });

  it("renders final-wire contract findings using the existing diagnostics surface", () => {
    const withContractFinding: RequestHealthSnapshot = {
      ...snapshot,
      diagnostics: [
        {
          ...snapshot.diagnostics[0],
          findings: [
            {
              code: "responses_field_type",
              severity: "error",
              count: 1,
              detail:
                "Contract v1: wrong field type at model; values are redacted",
            },
          ],
        },
      ],
    };
    render(
      <RequestHealthPanel
        snapshot={withContractFinding}
        isRefreshing={false}
        onRefresh={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByText("responses_field_type")).toBeInTheDocument();
    expect(screen.getByText(/wrong field type at model/)).toBeInTheDocument();
  });

  it("keeps settings mode focused on configuration instead of live diagnostics", () => {
    render(
      <RequestHealthPanel
        mode="settings"
        snapshot={snapshot}
        isRefreshing={false}
        onRefresh={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "settings.requestHealth.save" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "settings.requestHealth.refresh",
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("settings.requestHealth.contractTitle"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("settings.requestHealth.timeline"),
    ).not.toBeInTheDocument();
  });

  it("keeps status mode focused on diagnostics instead of editable settings", () => {
    render(
      <RequestHealthPanel
        mode="status"
        snapshot={snapshot}
        isRefreshing={false}
        onRefresh={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "settings.requestHealth.refresh" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "settings.requestHealth.save" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", {
        name: "settings.requestHealth.enabled",
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("settings.requestHealth.contractTitle"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("settings.requestHealth.timeline"),
    ).toBeInTheDocument();
  });

  it("hides stale diagnostics while request health advisories are disabled", () => {
    const disabledSnapshot: RequestHealthSnapshot = {
      ...snapshot,
      config: {
        ...snapshot.config,
        enabled: false,
      },
    };

    render(
      <RequestHealthPanel
        snapshot={disabledSnapshot}
        isRefreshing={false}
        onRefresh={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    expect(
      screen.queryByText("settings.requestHealth.historyWarning"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Codex MultiRouter · gpt-5.6-sol"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("settings.requestHealth.timeline"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("settings.requestHealth.empty"),
    ).toBeInTheDocument();
  });

  it("keeps diagnostics visible when only Windows notifications are disabled", () => {
    const notificationsOffSnapshot: RequestHealthSnapshot = {
      ...snapshot,
      config: {
        ...snapshot.config,
        windowsNotificationsEnabled: false,
      },
    };

    render(
      <RequestHealthPanel
        snapshot={notificationsOffSnapshot}
        isRefreshing={false}
        onRefresh={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    expect(
      screen.getAllByText("Codex MultiRouter · gpt-5.6-sol").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByText("settings.requestHealth.historyWarning"),
    ).toBeInTheDocument();
  });

  it("persists an updated Windows notification setting", async () => {
    const user = userEvent.setup();
    const settings = { requestHealth: snapshot.config };
    vi.mocked(settingsApi.get).mockResolvedValue(settings as never);
    vi.mocked(settingsApi.save).mockResolvedValue(true);

    const withNotificationsOff = {
      ...snapshot,
      config: { ...snapshot.config, windowsNotificationsEnabled: false },
    };
    render(
      <RequestHealthPanel
        snapshot={withNotificationsOff}
        isRefreshing={false}
        onRefresh={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("checkbox", {
        name: "settings.requestHealth.windowsNotificationsEnabled",
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "settings.requestHealth.save" }),
    );

    await waitFor(() =>
      expect(settingsApi.save).toHaveBeenCalledWith(
        expect.objectContaining({
          requestHealth: expect.objectContaining({
            windowsNotificationsEnabled: true,
          }),
        }),
      ),
    );
    expect(toastMock.success).toHaveBeenCalledWith(
      "settings.requestHealth.saved",
      { closeButton: true },
    );
  });

  it("reports a failed direct save instead of silently treating it as success", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    vi.mocked(settingsApi.get).mockResolvedValue({
      requestHealth: snapshot.config,
    } as never);
    vi.mocked(settingsApi.save).mockRejectedValue(new Error("disk full"));

    render(
      <RequestHealthPanel
        snapshot={snapshot}
        isRefreshing={false}
        onRefresh={vi.fn()}
        onSaved={onSaved}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "settings.requestHealth.save" }),
    );

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("disk full", {
        closeButton: true,
      }),
    );
    expect(screen.getByText("disk full")).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "settings.requestHealth.save" }),
    ).toBeEnabled();
  });

  it.each([false, { settingsSaved: false }, null, undefined, {}])(
    "rejects an unsuccessful or malformed save result: %j",
    async (result) => {
      const user = userEvent.setup();
      const onSaved = vi.fn();
      vi.mocked(settingsApi.get).mockResolvedValue({
        requestHealth: snapshot.config,
      } as never);
      vi.mocked(settingsApi.save).mockResolvedValue(result as never);

      render(
        <RequestHealthPanel
          snapshot={snapshot}
          isRefreshing={false}
          onRefresh={vi.fn()}
          onSaved={onSaved}
        />,
      );

      await user.click(
        screen.getByRole("button", { name: "settings.requestHealth.save" }),
      );

      await waitFor(() =>
        expect(toastMock.error).toHaveBeenCalledWith(
          "settings.saveFailedGeneric",
          { closeButton: true },
        ),
      );
      expect(
        screen.getByText("settings.saveFailedGeneric"),
      ).toBeInTheDocument();
      expect(onSaved).not.toHaveBeenCalled();
      expect(toastMock.success).not.toHaveBeenCalled();
    },
  );

  it.each([true, { settingsSaved: true }])(
    "saves edited fields and preserves other settings with acknowledgement %j",
    async (result) => {
      const user = userEvent.setup();
      const onSaved = vi.fn();
      const settings = { language: "en", requestHealth: snapshot.config };
      vi.mocked(settingsApi.get).mockResolvedValue(settings as never);
      vi.mocked(settingsApi.save).mockResolvedValue(result as never);
      const { unmount } = render(
        <RequestHealthPanel
          snapshot={snapshot}
          isRefreshing={false}
          onRefresh={vi.fn()}
          onSaved={onSaved}
        />,
      );
      await user.selectOptions(
        screen.getByRole("combobox", { name: "settings.requestHealth.mode" }),
        "diagnose",
      );
      await user.selectOptions(
        screen.getByRole("combobox", {
          name: "settings.requestHealth.reviewMode",
        }),
        "sustained_growth",
      );
      const threshold = screen.getByRole("spinbutton", {
        name: "settings.requestHealth.threshold",
      });
      await user.clear(threshold);
      await user.type(threshold, "512");
      const tokens = screen.getByRole("spinbutton", {
        name: "settings.requestHealth.maxInputTokens",
      });
      await user.clear(tokens);
      await user.type(tokens, "100000");
      const timeout = screen.getByRole("spinbutton", {
        name: "settings.requestHealth.reviewTimeout",
      });
      await user.clear(timeout);
      await user.type(timeout, "90");
      await user.click(
        screen.getByRole("checkbox", {
          name: "settings.requestHealth.summarizeAndRestartEnabled",
        }),
      );
      await user.click(
        screen.getByRole("button", { name: "settings.requestHealth.save" }),
      );
      const config = {
        ...snapshot.config,
        optimizationMode: "diagnose",
        reviewMode: "sustained_growth",
        largeRequestThresholdBytes: 512 * 1024,
        maxCodexInputTokens: 100000,
        reviewTimeoutSeconds: 90,
        summarizeAndRestartEnabled: false,
      };
      await waitFor(() => expect(onSaved).toHaveBeenCalledWith(config));
      expect(settingsApi.save).toHaveBeenCalledTimes(1);
      expect(settingsApi.save).toHaveBeenCalledWith({
        ...settings,
        requestHealth: config,
      });
      expect(toastMock.success).toHaveBeenCalledOnce();
      expect(toastMock.error).not.toHaveBeenCalled();
      unmount();
      render(
        <RequestHealthPanel
          snapshot={{ ...snapshot, config: onSaved.mock.calls[0][0] }}
          isRefreshing={false}
          onRefresh={vi.fn()}
          onSaved={vi.fn()}
        />,
      );
      expect(
        screen.getByRole("spinbutton", {
          name: "settings.requestHealth.threshold",
        }),
      ).toHaveValue(512);
      expect(
        screen.getByRole("combobox", { name: "settings.requestHealth.mode" }),
      ).toHaveValue("diagnose");
    },
  );

  it("reports a failed shared save and permits a successful retry", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const onSaveConfig = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    render(
      <RequestHealthPanel
        snapshot={snapshot}
        isRefreshing={false}
        onRefresh={vi.fn()}
        onSaved={onSaved}
        onSaveConfig={onSaveConfig}
      />,
    );
    const save = screen.getByRole("button", {
      name: "settings.requestHealth.save",
    });
    await user.click(save);
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledOnce());
    expect(onSaved).not.toHaveBeenCalled();
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(save).toBeEnabled();
    await user.click(save);
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(snapshot.config));
    expect(toastMock.success).toHaveBeenCalledOnce();
    expect(settingsApi.save).not.toHaveBeenCalled();
  });

  it("checks the official contract from the in-app panel and renders drift", async () => {
    const user = userEvent.setup();
    vi.mocked(proxyApi.checkOpenAIResponsesContract).mockResolvedValue({
      ...snapshot.contract!,
      status: "drift_detected",
      checkedAt: "2026-10-09T00:00:00Z",
      changedSections: ["top-level fields", "tool types"],
    });

    render(
      <RequestHealthPanel
        snapshot={snapshot}
        isRefreshing={false}
        onRefresh={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", {
        name: "settings.requestHealth.contractCheck",
      }),
    );

    await waitFor(() =>
      expect(
        screen.getByText("settings.requestHealth.contractStatusDrift"),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByText("top-level fields, tool types"),
    ).toBeInTheDocument();
    expect(proxyApi.checkOpenAIResponsesContract).toHaveBeenCalledOnce();
  });

  it("uses the shared settings save pipeline when hosted by Settings", async () => {
    const user = userEvent.setup();
    const onSaveConfig = vi.fn().mockResolvedValue(true);
    const onSaved = vi.fn();

    render(
      <RequestHealthPanel
        snapshot={snapshot}
        isRefreshing={false}
        onRefresh={vi.fn()}
        onSaveConfig={onSaveConfig}
        onSaved={onSaved}
      />,
    );

    await user.click(
      screen.getByRole("checkbox", {
        name: "settings.requestHealth.windowsNotificationsEnabled",
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "settings.requestHealth.save" }),
    );

    await waitFor(() => expect(onSaveConfig).toHaveBeenCalledOnce());
    expect(onSaveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ windowsNotificationsEnabled: false }),
    );
    expect(onSaved).toHaveBeenCalledWith(
      expect.objectContaining({ windowsNotificationsEnabled: false }),
    );
    expect(settingsApi.save).not.toHaveBeenCalled();
  });
});
