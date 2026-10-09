import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RequestHealthPanel } from "@/components/settings/RequestHealthPanel";
import { settingsApi } from "@/lib/api/settings";
import type { RequestHealthSnapshot } from "@/types/proxy";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/api/settings", () => ({
  settingsApi: { get: vi.fn(), save: vi.fn() },
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
  });
});
