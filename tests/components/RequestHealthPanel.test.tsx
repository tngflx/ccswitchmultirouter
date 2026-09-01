import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RequestHealthPanel } from "@/components/settings/RequestHealthPanel";
import type { RequestHealthSnapshot } from "@/types/proxy";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/api/settings", () => ({
  settingsApi: {
    get: vi.fn(),
    save: vi.fn(),
  },
}));

function snapshot(): RequestHealthSnapshot {
  return {
    config: {
      enabled: true,
      optimizationMode: "safe",
      largeRequestThresholdBytes: 393_216,
      maxCodexInputTokens: 200_000,
    },
    diagnostics: [
      {
        generatedAt: "2026-09-01T00:34:31+08:00",
        traceId: "trace-large-request",
        sessionId: "01a0585a-73fe-7c93-b47d-aaf336381625",
        appType: "codex",
        providerId: "router",
        providerName: "Codex MultiRouter",
        model: "gpt-5.6-sol",
        endpoint: "/v1/responses",
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
}

describe("RequestHealthPanel", () => {
  it("explains when a large semantic request was detected but not reduced", () => {
    render(
      <RequestHealthPanel
        snapshot={snapshot()}
        isRefreshing={false}
        onRefresh={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        "codexRouterWorkspace.requestHealth.detectedOnlyWarning",
      ),
    ).toBeInTheDocument();
  });

  it("keeps oversized requests diagnostic-only", () => {
    render(
      <RequestHealthPanel
        snapshot={snapshot()}
        isRefreshing={false}
        onRefresh={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    expect(screen.getByText("357,500 / 200,000")).toBeInTheDocument();
    expect(
      screen.queryByText("codexRouterWorkspace.requestHealth.blockedNotice"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("codexRouterWorkspace.requestHealth.handoffNow"),
    ).not.toBeInTheDocument();
  });
});
