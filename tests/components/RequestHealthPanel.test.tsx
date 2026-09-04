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
      reviewTimeoutSeconds: 60,
      reviewMode: "first_large_request",
      summarizeAndRestartEnabled: true,
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
        breakdown: [
          { category: "tool_calls", itemCount: 12, bytes: 48_000 },
          { category: "reasoning", itemCount: 4, bytes: 12_000 },
        ],
        reviewAction: "blocked",
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

  it("exposes first-request review and compact-new-session controls", () => {
    render(
      <RequestHealthPanel
        snapshot={snapshot()}
        isRefreshing={false}
        onRefresh={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    expect(screen.getByText("1396.5 KB / 384.0 KB")).toBeInTheDocument();
    expect(
      screen.getByText("codexRouterWorkspace.requestHealth.reviewMode"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "codexRouterWorkspace.requestHealth.summarizeAndRestartEnabled",
      ),
    ).toBeInTheDocument();
  });

  it("shows authoritative cache usage and sustained-growth anomalies", () => {
    const health = snapshot();
    health.diagnostics[0] = {
      ...health.diagnostics[0],
      actualInputTokens: 120_000,
      cachedInputTokens: 10_000,
      freshInputTokens: 110_000,
      cacheHitRatio: 10_000 / 120_000,
      anomaly: {
        code: "sustained_uncached_input_growth",
        severity: "warning",
        count: 3,
        detail: "Fresh input kept growing while cache hits stayed low.",
      },
    };

    render(
      <RequestHealthPanel
        snapshot={health}
        isRefreshing={false}
        onRefresh={() => {}}
        onSaved={() => {}}
      />,
    );

    expect(
      screen.getByText(/Fresh input kept growing while cache hits stayed low/),
    ).toBeInTheDocument();
  });

  it("adds semantic icons to request breakdown categories", () => {
    render(
      <RequestHealthPanel
        snapshot={snapshot()}
        isRefreshing={false}
        onRefresh={() => {}}
        onSaved={() => {}}
      />,
    );

    const toolCalls = screen.getByText("tool_calls");
    expect(toolCalls.parentElement?.querySelector("svg")).toBeTruthy();
  });

  it("keeps the incident timeline and action visible", () => {
    render(
      <RequestHealthPanel
        snapshot={snapshot()}
        isRefreshing={false}
        onRefresh={() => {}}
        onSaved={() => {}}
      />,
    );

    expect(
      screen.getByText("codexRouterWorkspace.requestHealth.timeline"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("codexRouterWorkspace.requestHealth.action.blocked"),
    ).toBeInTheDocument();
  });
});
