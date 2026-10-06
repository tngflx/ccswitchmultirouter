import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CodexProviderReadinessSection } from "@/components/providers/forms/CodexProviderReadinessSection";

describe("CodexProviderReadinessSection", () => {
  it("keeps model synchronization and connection validation in the main flow", () => {
    const onSyncModels = vi.fn();
    const onValidateConnection = vi.fn();

    render(
      <CodexProviderReadinessSection
        models={[]}
        apiFormat="openai_chat"
        isMaintainedPreset={false}
        isSyncingModels={false}
        isValidatingConnection={false}
        onSyncModels={onSyncModels}
        onValidateConnection={onValidateConnection}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Models and compatibility" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Readiness")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sync models" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sync models" }));
    expect(screen.getByText("Deep compatibility probe")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Validate connection" }));

    expect(onSyncModels).toHaveBeenCalledTimes(1);
    expect(onValidateConnection).toHaveBeenCalledTimes(1);
  });

  it("offers a read-only entry for persisted Responses and Chat evidence", () => {
    const onViewCompatibilityDetails = vi.fn();
    const record = {
      probeVersion: 1,
      target: {
        provider_id: "qwen",
        route_id: null,
        public_model: "qwen3.8",
        upstream_model: "qwen3.8",
        transport: "open_ai_chat" as const,
        endpoint_fingerprint: "endpoint",
        authentication_kind: "bearer",
        credential_fingerprint: "credential",
        request_policy_fingerprint: "policy",
      },
      result: {
        selected_transport: "open_ai_chat" as const,
        readiness: "verified" as const,
        branches: [],
      },
      testedAt: 1_787_875_200,
      expiresAt: 1_787_961_600,
    };

    render(
      <CodexProviderReadinessSection
        models={[{ model: "qwen3.8" }]}
        apiFormat="openai_chat"
        adaptation={{
          persistence: "single",
          status: "ready",
          effectiveTransport: "open_ai_chat",
          models: [
            {
              publicModel: "qwen3.8",
              upstreamModel: "qwen3.8",
              choice: "follow_auto",
              choiceSource: "automatic",
              effectiveTransport: "open_ai_chat",
              readiness: "verified",
              responses: null,
              chat: record,
            },
          ],
        }}
        isMaintainedPreset={false}
        isSyncingModels={false}
        isValidatingConnection={false}
        onSyncModels={vi.fn()}
        onValidateConnection={vi.fn()}
        onViewCompatibilityDetails={onViewCompatibilityDetails}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "View saved probe details" }),
    );
    expect(onViewCompatibilityDetails).toHaveBeenCalledOnce();
  });

  it("keeps maintained metadata ownership visible without treating unverified credentials as ready", () => {
    const { rerender } = render(
      <CodexProviderReadinessSection
        models={[{ model: "deepseek-v4-flash" }, { model: "deepseek-v4-pro" }]}
        defaultModel="deepseek-v4-flash"
        apiFormat="openai_responses"
        isMaintainedPreset
        isSyncingModels={false}
        isValidatingConnection={false}
        onSyncModels={vi.fn()}
        onValidateConnection={vi.fn()}
      />,
    );

    expect(screen.getByText("Maintained by CCSwitchMulti")).toBeInTheDocument();
    expect(screen.getByText("Validate the connection first")).toBeInTheDocument();
    expect(screen.queryByText("Ready for MultiRouter")).not.toBeInTheDocument();
    expect(screen.getByText("deepseek-v4-flash")).toBeInTheDocument();
    expect(screen.queryByText("请选择上游协议")).not.toBeInTheDocument();

    rerender(
      <CodexProviderReadinessSection
        models={[{ model: "deepseek-v4-flash" }, { model: "deepseek-v4-pro" }]}
        defaultModel="deepseek-v4-flash"
        apiFormat="openai_responses"
        isMaintainedPreset
        isSyncingModels={false}
        isValidatingConnection={false}
        validationSummary="Current credentials and endpoint validated"
        validationTone="success"
        onSyncModels={vi.fn()}
        onValidateConnection={vi.fn()}
      />,
    );

    expect(screen.getByText("Ready for MultiRouter")).toBeInTheDocument();
  });

  it("explains automatic protocol detection for custom providers", () => {
    render(
      <CodexProviderReadinessSection
        models={[{ model: "private-model" }]}
        apiFormat="openai_chat"
        isMaintainedPreset={false}
        isSyncingModels={false}
        isValidatingConnection={false}
        onSyncModels={vi.fn()}
        onValidateConnection={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        /The deep compatibility probe checks Chat and Responses automatically/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Validate the connection first")).toBeInTheDocument();
  });

  it("restores ready state from persisted protocol adaptation evidence", () => {
    render(
      <CodexProviderReadinessSection
        models={[{ model: "qwen3.8" }]}
        defaultModel="qwen3.8"
        apiFormat="openai_chat"
        adaptation={{
          persistence: "single",
          status: "ready",
          effectiveTransport: "open_ai_chat",
          testedAt: Math.floor(Date.now() / 1000) - 60,
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
          models: [],
        }}
        isMaintainedPreset={false}
        isSyncingModels={false}
        isValidatingConnection={false}
        onSyncModels={vi.fn()}
        onValidateConnection={vi.fn()}
      />,
    );

    expect(screen.getByText("Ready for MultiRouter")).toBeInTheDocument();
    expect(
      screen.queryByText("Validate the connection first"),
    ).not.toBeInTheDocument();
  });

  it("does not let stale evidence hide a current validation failure", () => {
    const readyAdaptation = {
      persistence: "single" as const,
      status: "ready" as const,
      effectiveTransport: "open_ai_chat" as const,
      testedAt: Math.floor(Date.now() / 1000) - 60,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      models: [],
    };
    const { rerender } = render(
      <CodexProviderReadinessSection
        models={[{ model: "qwen3.8" }]}
        apiFormat="openai_chat"
        adaptation={{ ...readyAdaptation, status: "stale" }}
        isMaintainedPreset={false}
        isSyncingModels={false}
        isValidatingConnection={false}
        onSyncModels={vi.fn()}
        onValidateConnection={vi.fn()}
      />,
    );

    expect(screen.getByText("Validate the connection first")).toBeInTheDocument();
    expect(screen.queryByText("Ready for MultiRouter")).not.toBeInTheDocument();

    rerender(
      <CodexProviderReadinessSection
        models={[{ model: "qwen3.8" }]}
        apiFormat="openai_chat"
        adaptation={readyAdaptation}
        isMaintainedPreset={false}
        isSyncingModels={false}
        isValidatingConnection={false}
        validationSummary="Current endpoint unavailable"
        validationTone="error"
        onSyncModels={vi.fn()}
        onValidateConnection={vi.fn()}
      />,
    );

    expect(screen.getByText("Connection validation failed")).toBeInTheDocument();
    expect(screen.queryByText("Ready for MultiRouter")).not.toBeInTheDocument();
  });

  it("distinguishes an all-disabled catalog from usable probe models", () => {
    const onValidateConnection = vi.fn();
    render(
      <CodexProviderReadinessSection
        models={[{ model: "disabled-model", enabled: false }]}
        defaultModel="disabled-model"
        apiFormat="openai_chat"
        isMaintainedPreset={false}
        isSyncingModels={false}
        isValidatingConnection={false}
        onSyncModels={vi.fn()}
        onValidateConnection={onValidateConnection}
      />,
    );

    expect(screen.getByText("0 enabled, 1 disabled")).toBeInTheDocument();
    expect(screen.getByText("Enable a model")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Validate connection" }));
    expect(onValidateConnection).toHaveBeenCalledOnce();
  });

  it("uses accessible live regions for validation results", () => {
    const { rerender } = render(
      <CodexProviderReadinessSection
        models={[{ model: "private-model" }]}
        apiFormat="openai_chat"
        isMaintainedPreset={false}
        isSyncingModels={false}
        isValidatingConnection={false}
        validationSummary="Responses and Chat are both unavailable"
        validationTone="error"
        onSyncModels={vi.fn()}
        onValidateConnection={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Responses and Chat are both unavailable",
    );

    rerender(
      <CodexProviderReadinessSection
        models={[{ model: "private-model" }]}
        apiFormat="openai_chat"
        isMaintainedPreset={false}
        isSyncingModels={false}
        isValidatingConnection={false}
        validationSummary="Chat validation passed"
        validationTone="success"
        onSyncModels={vi.fn()}
        onValidateConnection={vi.fn()}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Chat validation passed");
  });
});
