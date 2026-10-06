import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CodexProtocolProbeProgressDialog } from "@/components/providers/forms/CodexProtocolProbeProgressDialog";
import type {
  CodexProtocolProbeBranch,
  CodexProtocolProbeFailure,
  CodexProtocolProbeProgressEvent,
  CodexProviderProtocolPreflightOutcome,
} from "@/lib/api/protocol-compatibility";

function probeOutcome(
  branches: CodexProtocolProbeBranch[],
): CodexProviderProtocolPreflightOutcome {
  return {
    provider: {
      id: "fixture-provider",
      name: "Fixture provider",
      settingsConfig: {},
    },
    adaptationPreview: {
      persistence: "single",
      status: "ready",
      effectiveTransport: "open_ai_chat",
      models: [],
    },
    records: [
      {
        probeVersion: 1,
        target: {
          provider_id: "fixture-provider",
          route_id: null,
          public_model: "qwen3.8",
          upstream_model: "qwen3.8",
          transport: "open_ai_chat",
          endpoint_fingerprint: "redacted",
          authentication_kind: "bearer",
          credential_fingerprint: "redacted",
          request_policy_fingerprint: "redacted-policy",
        },
        result: {
          selected_transport: null,
          readiness: "unverified",
          branches,
        },
        testedAt: 1,
        expiresAt: 2,
      },
    ],
    observations: [],
    receiptIds: ["receipt-fixture-model"],
    protocolApplied: false,
  };
}

function branch(
  transport: "open_ai_responses" | "open_ai_chat",
  baseline: "passed" | "failed",
  failures: CodexProtocolProbeFailure[] = [],
): CodexProtocolProbeBranch {
  return {
    assessment: {
      transport,
      baseline,
      streaming: "skipped",
      forced_tool: "skipped",
      continuation: "skipped",
    },
    reasoning_shape: {
      semantic: "none",
      source: "none",
      pre_tool_visible_content: "absent",
    },
    failures,
  };
}

describe("CodexProtocolProbeProgressDialog", () => {
  it("shows the complete model denominator before later models start", () => {
    render(
      <CodexProtocolProbeProgressDialog
        open
        running
        expectedModels={["qwen3.8", "deepseek-v4"]}
        events={[
          {
            kind: "candidate_started",
            model: "qwen3.8",
          },
        ]}
        outcome={null}
        error=""
        onOpenChange={vi.fn()}
      />,
    );

    expect(screen.getByText(/Validating models 0\/2/)).toBeInTheDocument();
    expect(
      screen.getByRole("article", { name: "deepseek-v4 probe progress" }),
    ).toHaveTextContent("Waiting to start");
  });

  it("shows each model, transport, and deep-probe stage while probing", () => {
    const events: CodexProtocolProbeProgressEvent[] = [
      {
        kind: "candidate_started",
        model: "qwen3.8",
      },
      {
        kind: "stage_finished",
        model: "qwen3.8",
        transport: "open_ai_responses",
        stage: "baseline",
        stageStatus: "passed",
      },
      {
        kind: "stage_started",
        model: "qwen3.8",
        transport: "open_ai_responses",
        stage: "streaming",
      },
      {
        kind: "reasoning_classified",
        model: "qwen3.8",
        transport: "open_ai_responses",
        stage: "reasoning",
        reasoningSemantic: "summary",
        reasoningSource: "native_responses",
      },
    ];

    render(
      <CodexProtocolProbeProgressDialog
        open
        running
        events={events}
        outcome={null}
        error=""
        onOpenChange={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Codex deep compatibility probe" }),
    ).toBeInTheDocument();
    const modelCard = screen.getByRole("article", { name: "qwen3.8 probe progress" });
    expect(within(modelCard).getByText("Responses")).toBeInTheDocument();
    expect(within(modelCard).getByText("Baseline response")).toBeInTheDocument();
    expect(within(modelCard).getByText("Streaming SSE")).toBeInTheDocument();
    expect(within(modelCard).getByText("Reasoning content")).toBeInTheDocument();
    expect(within(modelCard).getByText("Tool call")).toBeInTheDocument();
    expect(within(modelCard).getByText("Tool continuation")).toBeInTheDocument();
    expect(within(modelCard).getByText("Native upstream summary")).toBeInTheDocument();
    expect(within(modelCard).getByText("Checking")).toBeInTheDocument();
  });

  it.each([
    { baseline: "failed" as const, expected: "Skipped", rejected: "Unsupported" },
    { baseline: "passed" as const, expected: "Unsupported", rejected: "Skipped" },
  ])(
    "maps reasoning with no content from a $baseline baseline to $expected",
    ({ baseline, expected, rejected }) => {
      render(
        <CodexProtocolProbeProgressDialog
          open
          running={false}
          events={[]}
          outcome={probeOutcome([
            branch("open_ai_responses", baseline),
            branch("open_ai_chat", baseline),
          ])}
          error=""
          onOpenChange={vi.fn()}
        />,
      );

      const modelCard = screen.getByRole("article", {
        name: "qwen3.8 probe progress",
      });
      const reasoningRows = within(modelCard).getAllByText("Reasoning content");
      for (const label of reasoningRows) {
        const row = label.parentElement;
        expect(row).toHaveTextContent(expected);
        expect(row).not.toHaveTextContent(rejected);
      }
    },
  );

  it("shows a redacted HTTP 521 upstream-unreachable failure", () => {
    render(
      <CodexProtocolProbeProgressDialog
        open
        running={false}
        events={[]}
        outcome={probeOutcome([
          branch("open_ai_responses", "failed", [
            {
              stage: "baseline",
              kind: "http_status",
              status_code: 521,
            },
          ]),
        ])}
        error=""
        onOpenChange={vi.fn()}
      />,
    );

    const modelCard = screen.getByRole("article", {
      name: "qwen3.8 probe progress",
    });
    expect(
      within(modelCard).getByText("HTTP 521 · Upstream unreachable"),
    ).toBeInTheDocument();
    expect(modelCard).not.toHaveTextContent("private upstream response body");
    expect(modelCard).not.toHaveTextContent("https://");
    expect(modelCard).not.toHaveTextContent("Bearer");
  });

  it("shows the redacted failure immediately from a progress event", () => {
    const events: CodexProtocolProbeProgressEvent[] = [
      {
        kind: "candidate_started",
        model: "qwen3.8",
      },
      {
        kind: "stage_finished",
        model: "qwen3.8",
        transport: "open_ai_responses",
        stage: "baseline",
        stageStatus: "failed",
        failure: {
          stage: "baseline",
          kind: "http_status",
          status_code: 521,
        },
      },
    ];

    render(
      <CodexProtocolProbeProgressDialog
        open
        running
        events={events}
        outcome={null}
        error=""
        onOpenChange={vi.fn()}
      />,
    );

    expect(screen.getByText("HTTP 521 · Upstream unreachable")).toBeInTheDocument();
  });
});
