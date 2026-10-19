import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RequestHealthPanel } from "@/components/settings/RequestHealthPanel";
import { proxyApi } from "@/lib/api/proxy";
import { settingsApi } from "@/lib/api/settings";
import type { RequestHealthConfig, RequestHealthSnapshot } from "@/types/proxy";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: toastMock }));

vi.mock("@/lib/api/settings", () => ({
  settingsApi: {
    get: vi.fn(),
    save: vi.fn(),
    saveRequestHealthConfig: vi.fn(),
    setRequestHealthEnabled: vi.fn(),
  },
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
    vi.mocked(settingsApi.saveRequestHealthConfig).mockReset();
    vi.mocked(settingsApi.setRequestHealthEnabled)
      .mockReset()
      .mockImplementation(async (enabled) => ({ ...snapshot.config, enabled }));
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

  it.each(["schema", "tokens", "blocked"] as const)(
    "never labels a request healthy when it has a %s error",
    (kind) => {
      render(
        <RequestHealthPanel
          mode="status"
          snapshot={{
            ...snapshot,
            diagnostics: [
              {
                ...snapshot.diagnostics[0],
                thresholdExceeded: false,
                tokenLimitExceeded: kind === "tokens",
                blocked: kind === "blocked",
                findings:
                  kind === "schema"
                    ? [
                        {
                          code: "responses_field_type",
                          severity: "error",
                          count: 1,
                          detail: "Wrong field type at model; values redacted",
                        },
                      ]
                    : [],
              },
            ],
          }}
          isRefreshing={false}
          onRefresh={vi.fn()}
        />,
      );

      expect(
        screen.getByRole("img", {
          name: "settings.requestHealth.severityError",
        }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("img", {
          name: "settings.requestHealth.severityHealthy",
        }),
      ).not.toBeInTheDocument();
      if (kind === "schema") {
        expect(
          screen.getByText("responses_field_type").parentElement,
        ).toHaveClass("text-red-800");
      }
    },
  );

  it("renders informational findings without reporting warnings or a healthy status", () => {
    render(
      <RequestHealthPanel
        mode="status"
        snapshot={{
          ...snapshot,
          diagnostics: [
            {
              ...snapshot.diagnostics[0],
              thresholdExceeded: false,
              tokenLimitExceeded: false,
              findings: [
                {
                  code: "metadata_removed",
                  severity: "info",
                  count: 1,
                  detail: "Removed a known request metadata field",
                },
              ],
            },
          ],
        }}
        isRefreshing={false}
        onRefresh={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("img", {
        name: "settings.requestHealth.severityInfo",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("settings.requestHealth.historyWarning"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("metadata_removed").parentElement).toHaveClass(
      "text-muted-foreground",
    );
  });

  it("renders a growth anomaly with warning severity and its diagnostic detail", () => {
    render(
      <RequestHealthPanel
        mode="status"
        snapshot={{
          ...snapshot,
          diagnostics: [
            {
              ...snapshot.diagnostics[0],
              thresholdExceeded: false,
              tokenLimitExceeded: false,
              findings: [],
              anomaly: {
                code: "sustained_growth",
                severity: "warning",
                count: 1,
                detail: "Input size grew across recent requests",
              },
            },
          ],
        }}
        isRefreshing={false}
        onRefresh={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("img", {
        name: "settings.requestHealth.severityWarning",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("sustained_growth").parentElement).toHaveClass(
      "text-amber-700",
    );
    expect(
      screen.getByText(/Input size grew across recent requests/),
    ).toBeInTheDocument();
  });

  it("keeps diagnostics active when review mode is Never prompt", () => {
    render(
      <RequestHealthPanel
        mode="status"
        snapshot={{
          ...snapshot,
          config: { ...snapshot.config, reviewMode: "off" },
        }}
        isRefreshing={false}
        onRefresh={vi.fn()}
      />,
    );

    expect(
      screen.getByText("settings.requestHealth.timeline"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("settings.requestHealth.historyWarning"),
    ).toBeInTheDocument();
  });

  it("preserves unsaved edits when a diagnostics refresh returns", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <RequestHealthPanel
        mode="settings"
        snapshot={snapshot}
        isRefreshing={false}
        onRefresh={vi.fn()}
      />,
    );
    const mode = screen.getByRole("combobox", {
      name: "settings.requestHealth.mode",
    });
    await user.selectOptions(mode, "diagnose");

    rerender(
      <RequestHealthPanel
        mode="settings"
        snapshot={{
          ...snapshot,
          config: { ...snapshot.config, maxCodexInputTokens: 300_000 },
        }}
        isRefreshing={false}
        onRefresh={vi.fn()}
      />,
    );

    expect(mode).toHaveValue("diagnose");
    expect(
      screen.getByRole("spinbutton", {
        name: "settings.requestHealth.maxInputTokens",
      }),
    ).toHaveValue(300_000);
  });

  it.each([true, false])(
    "uses saved diagnostics enabled=%s while the master switch is pending",
    async (enabled) => {
      const user = userEvent.setup();
      render(
        <RequestHealthPanel
          snapshot={{
            ...snapshot,
            config: { ...snapshot.config, enabled },
          }}
          isRefreshing={false}
          onRefresh={vi.fn()}
          onSetEnabled={() => new Promise(() => {})}
        />,
      );
      await user.click(
        screen.getByRole("checkbox", {
          name: "settings.requestHealth.enabled",
        }),
      );
      if (enabled) {
        expect(
          screen.getByText("settings.requestHealth.timeline"),
        ).toBeInTheDocument();
      } else {
        expect(
          screen.queryByText("settings.requestHealth.timeline"),
        ).not.toBeInTheDocument();
      }
    },
  );

  it("persists the master switch immediately without publishing other drafts", async () => {
    const user = userEvent.setup();
    let finishSave!: (config: RequestHealthConfig) => void;
    vi.mocked(settingsApi.setRequestHealthEnabled).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSave = resolve;
        }),
    );
    const onSaved = vi.fn();
    render(
      <RequestHealthPanel
        mode="settings"
        snapshot={snapshot}
        isRefreshing={false}
        onRefresh={vi.fn()}
        onSaved={onSaved}
      />,
    );
    const threshold = screen.getByRole("spinbutton", {
      name: "settings.requestHealth.threshold",
    });
    await user.clear(threshold);
    const enabled = screen.getByRole("checkbox", {
      name: "settings.requestHealth.enabled",
    });
    await user.click(enabled);

    expect(settingsApi.setRequestHealthEnabled).toHaveBeenCalledWith(false);
    expect(settingsApi.saveRequestHealthConfig).not.toHaveBeenCalled();
    expect(enabled).not.toBeChecked();
    expect(enabled).toBeDisabled();
    expect(enabled).toHaveAttribute("aria-busy", "true");
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "settings.requestHealth.save" }),
    ).toBeDisabled();
    const mode = screen.getByRole("combobox", {
      name: "settings.requestHealth.mode",
    });
    await user.selectOptions(mode, "diagnose");

    const canonical = { ...snapshot.config, enabled: false };
    await act(async () => finishSave(canonical));

    expect(enabled).not.toBeDisabled();
    expect(enabled).not.toBeChecked();
    expect(mode).toHaveValue("diagnose");
    expect(threshold).toHaveValue(null);
    expect(threshold).toHaveAttribute("aria-invalid", "true");
    expect(onSaved).toHaveBeenCalledWith(canonical);
    expect(
      screen.getByText("settings.requestHealth.savedPendingEdits"),
    ).toBeInTheDocument();
  });

  it("rolls back a failed master switch save without losing other drafts", async () => {
    const user = userEvent.setup();
    const onSetEnabled = vi.fn().mockRejectedValue(new Error("save failed"));
    const onSaved = vi.fn();
    render(
      <RequestHealthPanel
        mode="settings"
        snapshot={snapshot}
        isRefreshing={false}
        onRefresh={vi.fn()}
        onSetEnabled={onSetEnabled}
        onSaved={onSaved}
      />,
    );
    const mode = screen.getByRole("combobox", {
      name: "settings.requestHealth.mode",
    });
    await user.selectOptions(mode, "diagnose");
    const enabled = screen.getByRole("checkbox", {
      name: "settings.requestHealth.enabled",
    });
    await user.click(enabled);
    await screen.findByText("save failed");

    expect(onSetEnabled).toHaveBeenCalledWith(false);
    expect(settingsApi.setRequestHealthEnabled).not.toHaveBeenCalled();
    expect(settingsApi.saveRequestHealthConfig).not.toHaveBeenCalled();
    expect(enabled).toBeChecked();
    expect(enabled).not.toBeDisabled();
    expect(mode).toHaveValue("diagnose");
    expect(onSaved).not.toHaveBeenCalled();
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(toastMock.error).toHaveBeenCalledWith("save failed", {
      closeButton: true,
    });
  });

  it.each([
    ["settings.requestHealth.threshold", "12"],
    ["settings.requestHealth.maxInputTokens", "0"],
    ["settings.requestHealth.reviewTimeout", "600"],
    ["settings.requestHealth.threshold", ""],
  ])("does not silently save an invalid %s input", async (name, value) => {
    const user = userEvent.setup();
    const { rerender } = render(
      <RequestHealthPanel
        mode="settings"
        snapshot={snapshot}
        isRefreshing={false}
        onRefresh={vi.fn()}
      />,
    );
    const input = screen.getByRole("spinbutton", { name });
    await user.clear(input);
    if (value) await user.type(input, value);
    rerender(
      <RequestHealthPanel
        mode="settings"
        snapshot={{ ...snapshot, config: { ...snapshot.config } }}
        isRefreshing={false}
        onRefresh={vi.fn()}
      />,
    );

    expect(input).toHaveAttribute("aria-invalid", "true");
    const save = screen.getByRole("button", {
      name: "settings.requestHealth.save",
    });
    expect(save).toBeDisabled();
    await user.click(save);
    expect(settingsApi.saveRequestHealthConfig).not.toHaveBeenCalled();
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it("offers retry after settings fail to load", async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    render(
      <RequestHealthPanel
        mode="settings"
        loadError="offline"
        isRefreshing={false}
        onRefresh={onRefresh}
      />,
    );

    expect(
      screen.getByText("settings.requestHealth.loadFailed"),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", {
        name: "settings.requestHealth.retry",
      }),
    );
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("uses canonical saved settings without discarding edits made during the save", async () => {
    const user = userEvent.setup();
    let finishSave!: (config: RequestHealthConfig) => void;
    const onSaved = vi.fn();
    vi.mocked(settingsApi.saveRequestHealthConfig).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSave = resolve;
        }),
    );
    render(
      <RequestHealthPanel
        mode="settings"
        snapshot={snapshot}
        isRefreshing={false}
        onRefresh={vi.fn()}
        onSaved={onSaved}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "settings.requestHealth.save" }),
    );
    const mode = screen.getByRole("combobox", {
      name: "settings.requestHealth.mode",
    });
    await user.selectOptions(mode, "diagnose");

    const canonicalConfig = {
      ...snapshot.config,
      largeRequestThresholdBytes: 512 * 1024,
      windowsNotificationsSnoozedUntilMs: 123_456,
    };
    await act(async () => finishSave(canonicalConfig));

    expect(onSaved).toHaveBeenCalledWith(canonicalConfig);
    expect(mode).toHaveValue("diagnose");
    expect(
      screen.getByRole("spinbutton", {
        name: "settings.requestHealth.threshold",
      }),
    ).toHaveValue(512);
    expect(settingsApi.get).not.toHaveBeenCalled();
    expect(settingsApi.save).not.toHaveBeenCalled();
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
      screen.getByRole("heading", {
        name: "settings.tabRequestHealthSettings",
      }),
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
    vi.mocked(settingsApi.saveRequestHealthConfig).mockImplementation(
      async (config) => config,
    );

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
      expect(settingsApi.saveRequestHealthConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          windowsNotificationsEnabled: true,
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
    vi.mocked(settingsApi.saveRequestHealthConfig).mockRejectedValue(
      new Error("disk full"),
    );

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

  it.each([
    true,
    false,
    { settingsSaved: true },
    { settingsSaved: false },
    null,
    undefined,
    {},
  ])("rejects an unsuccessful or malformed save result: %j", async (result) => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    vi.mocked(settingsApi.saveRequestHealthConfig).mockResolvedValue(
      result as never,
    );

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
    expect(screen.getByText("settings.saveFailedGeneric")).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it("saves edited fields only through the dedicated request-health command", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    vi.mocked(settingsApi.saveRequestHealthConfig).mockImplementation(
      async (config) => config,
    );
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
    expect(settingsApi.saveRequestHealthConfig).toHaveBeenCalledTimes(1);
    expect(settingsApi.saveRequestHealthConfig).toHaveBeenCalledWith(config);
    expect(settingsApi.get).not.toHaveBeenCalled();
    expect(settingsApi.save).not.toHaveBeenCalled();
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
  });

  it("reports a failed shared save and permits a successful retry", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const onSaveConfig = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(snapshot.config);
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

  it("points settings users to schema diagnostics without mixing the status and settings surfaces", () => {
    render(
      <RequestHealthPanel
        mode="settings"
        snapshot={snapshot}
        isRefreshing={false}
        onRefresh={vi.fn()}
      />,
    );
    expect(
      screen.getByText("settings.requestHealth.statusLocation"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("settings.requestHealth.contractTitle"),
    ).not.toBeInTheDocument();
    expect(proxyApi.checkOpenAIResponsesContract).not.toHaveBeenCalled();
  });

  it("explains contract drift with bounded public declaration details and safe next steps", () => {
    render(
      <RequestHealthPanel
        mode="status"
        snapshot={{
          ...snapshot,
          contract: {
            ...snapshot.contract!,
            status: "drift_detected",
            changedSections: ["declarations"],
            declarationChanges: {
              addedCount: 1,
              removedCount: 1,
              added: ["10:url: optional string or null"],
              removed: ["10:url: string"],
            },
          },
        }}
        isRefreshing={false}
        onRefresh={vi.fn()}
      />,
    );
    expect(
      screen.getByText("settings.requestHealth.contractDriftHelp"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("+ 10:url: optional string or null"),
    ).toBeInTheDocument();
    expect(screen.getByText("- 10:url: string")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /auto.?fix|refresh.*baseline/i }),
    ).not.toBeInTheDocument();
  });

  it.each([
    ["responses_field_type", "schema"],
    ["undeclared_tool_choice", "tools"],
    ["orphaned_tool_output", "history"],
    ["responses_unverified_extension", "extension"],
    ["codex_input_token_limit", "size"],
    ["future_finding", "general"],
  ])("shows actionable, non-destructive help for %s", (code, help) => {
    render(
      <RequestHealthPanel
        mode="status"
        snapshot={{
          ...snapshot,
          diagnostics: [
            {
              ...snapshot.diagnostics[0],
              findings: [
                {
                  code,
                  severity: "warning",
                  count: 1,
                  detail: "Values are redacted",
                },
              ],
            },
          ],
        }}
        isRefreshing={false}
        onRefresh={vi.fn()}
      />,
    );
    expect(
      screen.getByText(`settings.requestHealth.findingHelp.${help}`),
    ).toBeInTheDocument();
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

  it("does not replace a checked contract with an older diagnostics snapshot", async () => {
    const user = userEvent.setup();
    vi.mocked(proxyApi.checkOpenAIResponsesContract).mockResolvedValue({
      ...snapshot.contract!,
      status: "drift_detected",
      checkedAt: "2026-10-15T00:00:00Z",
      changedSections: ["top-level fields"],
    });
    const { rerender } = render(
      <RequestHealthPanel
        mode="status"
        snapshot={snapshot}
        isRefreshing={false}
        onRefresh={vi.fn()}
      />,
    );
    await user.click(
      screen.getByRole("button", {
        name: "settings.requestHealth.contractCheck",
      }),
    );
    await screen.findByText("settings.requestHealth.contractStatusDrift");

    rerender(
      <RequestHealthPanel
        mode="status"
        snapshot={{
          ...snapshot,
          contract: { ...snapshot.contract! },
        }}
        isRefreshing={false}
        onRefresh={vi.fn()}
      />,
    );
    expect(
      screen.getByText("settings.requestHealth.contractStatusDrift"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("settings.requestHealth.contractStatusNotChecked"),
    ).not.toBeInTheDocument();
  });

  it("shows the latest manual contract failure instead of an older backend error", async () => {
    const user = userEvent.setup();
    vi.mocked(proxyApi.checkOpenAIResponsesContract).mockRejectedValue(
      new Error("current network failure"),
    );
    render(
      <RequestHealthPanel
        mode="status"
        snapshot={{
          ...snapshot,
          contract: {
            ...snapshot.contract!,
            status: "check_failed",
            error: "old network failure",
          },
        }}
        isRefreshing={false}
        onRefresh={vi.fn()}
      />,
    );
    await user.click(
      screen.getByRole("button", {
        name: "settings.requestHealth.contractCheck",
      }),
    );

    expect(
      await screen.findByText("current network failure"),
    ).toBeInTheDocument();
    expect(screen.queryByText("old network failure")).not.toBeInTheDocument();
    expect(
      screen.getByText("settings.requestHealth.contractStatusFailed"),
    ).toBeInTheDocument();
  });

  it("clears a failed manual check when Refresh supplies a newer successful contract", async () => {
    const user = userEvent.setup();
    vi.mocked(proxyApi.checkOpenAIResponsesContract).mockRejectedValue(
      new Error("current network failure"),
    );
    const { rerender } = render(
      <RequestHealthPanel
        mode="status"
        snapshot={snapshot}
        isRefreshing={false}
        onRefresh={vi.fn()}
      />,
    );
    await user.click(
      screen.getByRole("button", {
        name: "settings.requestHealth.contractCheck",
      }),
    );
    await screen.findByText("current network failure");
    rerender(
      <RequestHealthPanel
        mode="status"
        snapshot={{
          ...snapshot,
          contract: {
            ...snapshot.contract!,
            status: "up_to_date",
            checkedAt: "2026-10-15T00:00:00Z",
          },
        }}
        isRefreshing={false}
        onRefresh={vi.fn()}
      />,
    );

    expect(
      screen.getByText("settings.requestHealth.contractStatusCurrent"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("settings.requestHealth.contractStatusFailed"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("current network failure"),
    ).not.toBeInTheDocument();
  });

  it("uses the shared settings save pipeline when hosted by Settings", async () => {
    const user = userEvent.setup();
    const onSaveConfig = vi.fn(async (config: RequestHealthConfig) => config);
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
    expect(settingsApi.saveRequestHealthConfig).not.toHaveBeenCalled();
  });
});
