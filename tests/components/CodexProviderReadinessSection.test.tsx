import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CodexProviderReadinessSection } from "@/components/providers/forms/CodexProviderReadinessSection";

describe("CodexProviderReadinessSection", () => {
  it("keeps model synchronization and connection validation in the main flow", () => {
    const onSyncModels = vi.fn();
    const onValidateConnection = vi.fn();

    render(
      <CodexProviderReadinessSection
        models={[{ model: "gpt-5.5", apiFormat: "openai_chat" }]}
        apiFormat="openai_chat"
        isMaintainedPreset={false}
        isSyncingModels={false}
        isValidatingConnection={false}
        onSyncModels={onSyncModels}
        onValidateConnection={onValidateConnection}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Models & Compatibility" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Readiness")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Sync the models available from this source and verify that Codex and MultiRouter can use them correctly.",
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sync Models" }));
    fireEvent.click(screen.getByRole("button", { name: "Verify Connection" }));

    expect(onSyncModels).toHaveBeenCalledTimes(1);
    expect(onValidateConnection).toHaveBeenCalledTimes(1);
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
    expect(screen.getByText("Verify connection first")).toBeInTheDocument();
    expect(screen.queryByText("Can join MultiRouter")).not.toBeInTheDocument();
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
        validationSummary="当前凭据和端点验证通过"
        validationTone="success"
        onSyncModels={vi.fn()}
        onValidateConnection={vi.fn()}
      />,
    );

    expect(screen.getByText("Can join MultiRouter")).toBeInTheDocument();
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
        /Verify Connection automatically tests both Chat and Responses/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Verify connection first")).toBeInTheDocument();
  });

  it("shows Responses and Chat as subgroups of one mixed provider", () => {
    render(
      <CodexProviderReadinessSection
        models={[
          { model: "gpt-5.5", apiFormat: "openai_responses" },
          { model: "gpt-5.4-mini", apiFormat: "openai_responses" },
          { model: "qwen3.6", apiFormat: "openai_chat" },
        ]}
        apiFormat="openai_responses"
        isMaintainedPreset={false}
        isSyncingModels={false}
        isValidatingConnection={false}
        onSyncModels={vi.fn()}
        onValidateConnection={vi.fn()}
      />,
    );

    expect(screen.getAllByText("Protocol groups")).toHaveLength(2);
    expect(screen.getByText("Mixed (per model)")).toBeInTheDocument();
    expect(screen.getByText("Responses: 2 models")).toBeInTheDocument();
    expect(screen.getByText("Chat Completions: 1 models")).toBeInTheDocument();
    expect(screen.getByText("Automatic per-model routing")).toBeInTheDocument();
  });

  it("renders recommended and custom provider traffic policy summaries", () => {
    const common = {
      models: [{ model: "ox-alpha-free" }],
      defaultModel: "ox-alpha-free",
      apiFormat: "openai_responses" as const,
      isMaintainedPreset: false,
      isSyncingModels: false,
      isValidatingConnection: false,
      onSyncModels: vi.fn(),
      onValidateConnection: vi.fn(),
    };
    const { rerender } = render(
      <CodexProviderReadinessSection
        {...common}
        trafficPolicy={{
          source: "recommended",
          admissionEnabled: true,
          maxInFlight: 4,
          maxQueueWaitMs: 30_000,
          rateLimitMaxRetries: 5,
          rejectionRetryMode: "opencode_endpoint_unavailable",
          rejectionMaxRetries: 2,
          rejectionInitialDelayMs: 750,
          rejectionMaxDelayMs: 5_000,
        }}
      />,
    );

    expect(screen.getByText("4 in flight")).toBeInTheDocument();
    expect(
      screen.getByText(/Recommended · 429: 5 · rejection: 2/),
    ).toBeInTheDocument();

    rerender(
      <CodexProviderReadinessSection
        {...common}
        trafficPolicy={{
          source: "custom",
          admissionEnabled: true,
          maxInFlight: 2,
          maxQueueWaitMs: 10_000,
          rateLimitMaxRetries: 1,
          rejectionRetryMode: "disabled",
          rejectionMaxRetries: 0,
          rejectionInitialDelayMs: 500,
          rejectionMaxDelayMs: 2_000,
        }}
      />,
    );
    expect(screen.getByText("2 in flight")).toBeInTheDocument();
    expect(
      screen.getByText(/Custom · 429: 1 · rejection: 0/),
    ).toBeInTheDocument();
  });

  it("uses accessible live regions for validation results", () => {
    const { rerender } = render(
      <CodexProviderReadinessSection
        models={[{ model: "private-model" }]}
        apiFormat="openai_chat"
        isMaintainedPreset={false}
        isSyncingModels={false}
        isValidatingConnection={false}
        validationSummary="Responses 和 Chat 均不可用"
        validationTone="error"
        onSyncModels={vi.fn()}
        onValidateConnection={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Responses 和 Chat 均不可用",
    );

    rerender(
      <CodexProviderReadinessSection
        models={[{ model: "private-model" }]}
        apiFormat="openai_chat"
        isMaintainedPreset={false}
        isSyncingModels={false}
        isValidatingConnection={false}
        validationSummary="Chat 验证通过"
        validationTone="success"
        onSyncModels={vi.fn()}
        onValidateConnection={vi.fn()}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Chat 验证通过");
  });

  it("shows a spinner only on the catalog action that is running", () => {
    const common = {
      models: [{ model: "model-a" }],
      apiFormat: "openai_chat" as const,
      isMaintainedPreset: false,
      isValidatingConnection: false,
      onSyncModels: vi.fn(),
      onFillMissingFields: vi.fn(),
      onValidateConnection: vi.fn(),
    };
    const { rerender } = render(
      <CodexProviderReadinessSection
        {...common}
        isSyncingModels
        isRefreshingModels={false}
      />,
    );

    expect(
      screen
        .getByRole("button", { name: "Sync Models" })
        .querySelector(".animate-spin"),
    ).not.toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Refresh Existing" })
        .querySelector(".animate-spin"),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Sync Models" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Refresh Existing" }),
    ).toBeDisabled();

    rerender(
      <CodexProviderReadinessSection
        {...common}
        isSyncingModels={false}
        isRefreshingModels
      />,
    );
    expect(
      screen
        .getByRole("button", { name: "Sync Models" })
        .querySelector(".animate-spin"),
    ).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Refresh Existing" })
        .querySelector(".animate-spin"),
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: "Sync Models" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Refresh Existing" }),
    ).toBeDisabled();
  });
});
