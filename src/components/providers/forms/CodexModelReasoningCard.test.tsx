import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CodexModelReasoningResolution } from "@/types/codexSubagentV2";

import {
  CodexModelReasoningCard,
  describeFinalBehavior,
  reasoningCardStatus,
  reasoningControlKind,
} from "./CodexModelReasoningCard";

function resolution(
  supportKind: CodexModelReasoningResolution["resolved"]["supportKind"],
): CodexModelReasoningResolution {
  return {
    model: "qwen3.8",
    capability: null,
    source: "unknown",
    fingerprint: "",
    resolved: {
      supportKind,
      confidence: "unverified",
      codexSelectableEfforts: [],
      providerAcceptedEfforts: [],
      disableAllowed: false,
      effortMap: {},
    },
    hasDetectionCandidate: false,
    detection: null,
  };
}

describe("CodexModelReasoningCard", () => {
  it("keeps unknown distinct from confirmed unsupported", () => {
    expect(reasoningCardStatus(resolution("unknown"))).toBe("unknown");
    expect(reasoningCardStatus(resolution("unsupported"))).toBe("unsupported");
  });

  it("projects graded capability and explains the final behavior", () => {
    const value = resolution("effort_levels");
    value.capability = {
      supportStatus: "confirmed_supported",
      controlKind: "graded",
      supportedEfforts: ["low", "high"],
      defaultEffort: "high",
      disableAllowed: true,
      upstream: { format: "reasoning_object", parameter: "reasoning.effort" },
    };
    value.resolved.codexSelectableEfforts = ["low", "high"];
    value.resolved.providerAcceptedEfforts = ["low", "high"];
    value.resolved.providerDefaultEffort = "high";
    value.resolved.disableAllowed = true;

    expect(reasoningControlKind(value)).toBe("graded");
    expect(describeFinalBehavior(value)).toContain("reasoning effort");
    expect(describeFinalBehavior(value)).toContain("low / high");
  });
});

function renderCard(value: CodexModelReasoningResolution, redetecting = false) {
  const actions = {
    onRedetect: vi.fn(),
    onAdoptDetection: vi.fn(),
    onManualDeclare: vi.fn(),
    onRestoreBuiltin: vi.fn(),
  };
  render(
    <CodexModelReasoningCard
      resolution={value}
      hasBuiltinPreset={false}
      redetecting={redetecting}
      {...actions}
    />,
  );
  return actions;
}

describe("CodexModelReasoningCard metadata refresh", () => {
  it("lets known Boolean MiMo refresh metadata without inventing efforts or changing declarations", () => {
    const value = resolution("boolean_only");
    value.model = "xiaomi/mimo-v2.6-pro";
    value.source = "detection";
    value.capability = {
      supportStatus: "confirmed_supported",
      controlKind: "boolean",
      supportedEfforts: [],
      disableAllowed: true,
      upstream: { format: "boolean", parameter: "reasoning.enabled" },
    };
    value.resolved.disableAllowed = true;
    const before = structuredClone(value);
    const actions = renderCard(value);

    const refresh = screen.getByRole("button", { name: "Detect again" });
    expect(refresh).toHaveAttribute(
      "title",
      "Refresh provider metadata only; no model response is generated.",
    );
    expect(screen.getByText("Boolean toggle")).toBeInTheDocument();
    expect(screen.getByText("Model default")).toBeInTheDocument();
    expect(screen.queryByText(/^(low|medium|high|xhigh|max)$/i)).toBeNull();

    fireEvent.click(refresh);

    expect(actions.onRedetect).toHaveBeenCalledOnce();
    expect(actions.onAdoptDetection).not.toHaveBeenCalled();
    expect(actions.onManualDeclare).not.toHaveBeenCalled();
    expect(actions.onRestoreBuiltin).not.toHaveBeenCalled();
    expect(value).toEqual(before);
  });

  it("allows a known unsupported automatic result to refresh its metadata", () => {
    const value = resolution("unsupported");
    value.source = "detection";
    const actions = renderCard(value);

    fireEvent.click(screen.getByRole("button", { name: "Detect again" }));

    expect(actions.onRedetect).toHaveBeenCalledOnce();
    expect(screen.getByText("Reasoning unsupported")).toBeInTheDocument();
  });

  it("allows adoption of a confirmed Boolean detection without effort levels", () => {
    const value = resolution("unknown");
    value.hasDetectionCandidate = true;
    value.detection = {
      providerKey: "openrouter",
      model: value.model,
      fetchedAt: 1,
      source: "openrouter_api",
      reasoning: {
        supportedEfforts: [],
        mandatory: false,
        controlKind: "boolean",
        supportStatus: "confirmed_supported",
        disableAllowed: true,
        upstreamFormat: "boolean",
        upstreamParameter: "reasoning.enabled",
      },
    };
    const actions = renderCard(value);

    fireEvent.click(
      screen.getByRole("button", { name: "Use detected result" }),
    );

    expect(actions.onAdoptDetection).toHaveBeenCalledOnce();
  });

  it("keeps exactly one metadata refresh action for unknown models", () => {
    renderCard(resolution("unknown"));

    expect(
      screen.getAllByRole("button", { name: "Detect again" }),
    ).toHaveLength(1);
    expect(
      screen.getByText(/Refreshes provider metadata only/),
    ).toBeInTheDocument();
  });

  it("disables the single refresh action while metadata discovery is running", () => {
    const value = resolution("boolean_only");
    value.source = "detection";
    const actions = renderCard(value, true);
    const refresh = screen.getByRole("button", { name: "Detecting…" });

    expect(refresh).toBeDisabled();
    fireEvent.click(refresh);
    expect(actions.onRedetect).not.toHaveBeenCalled();
  });

  it("does not offer automatic refresh over a known manual declaration", () => {
    const value = resolution("boolean_only");
    value.source = "user";
    renderCard(value);

    expect(screen.queryByRole("button", { name: "Detect again" })).toBeNull();
  });
});
