import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CodexProtocolAdvancedSettings } from "./CodexProtocolAdvancedSettings";

describe("CodexProtocolAdvancedSettings", () => {
  it("keeps ordinary users on automatic probing without exposing manual knobs", () => {
    render(
      <CodexProtocolAdvancedSettings
        mode="auto"
        apiFormat="openai_responses"
        reasoningProjection="none"
        toolSchemaDialect="openai"
        historyReplay="native_only"
        onModeChange={vi.fn()}
        onApiFormatChange={vi.fn()}
        onReasoningProjectionChange={vi.fn()}
        onToolSchemaDialectChange={vi.fn()}
        onHistoryReplayChange={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/CCSM tests Responses and Chat/),
    ).toBeInTheDocument();
    expect(screen.queryByText("Tool schema")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Responses history continuation"),
    ).not.toBeInTheDocument();
  });

  it("shows protocol-specific manual controls and an explicit risk warning", () => {
    const onApiFormatChange = vi.fn();
    const { rerender } = render(
      <CodexProtocolAdvancedSettings
        mode="manual"
        apiFormat="openai_chat"
        reasoningProjection="raw_reasoning_text"
        toolSchemaDialect="moonshot_mfjs"
        historyReplay="omit"
        onModeChange={vi.fn()}
        onApiFormatChange={onApiFormatChange}
        onReasoningProjectionChange={vi.fn()}
        onToolSchemaDialectChange={vi.fn()}
        onHistoryReplayChange={vi.fn()}
      />,
    );

    expect(screen.getByText("Tool schema")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("combobox", { name: "Protocol used at runtime" }),
    );
    fireEvent.click(screen.getByText("Responses"));
    expect(onApiFormatChange).toHaveBeenCalledWith("openai_responses");
    expect(screen.getByText("Chat reasoning display")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("combobox", { name: "Chat reasoning display" }),
    );
    expect(
      screen.queryByText("Native upstream summary"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        /Chat history continuation always writes reasoning_content/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/may cause HTTP 400/)).toBeInTheDocument();

    rerender(
      <CodexProtocolAdvancedSettings
        mode="manual"
        apiFormat="openai_responses"
        reasoningProjection="reasoning_summary"
        toolSchemaDialect="openai"
        historyReplay="responses_reasoning_text_content"
        onModeChange={vi.fn()}
        onApiFormatChange={vi.fn()}
        onReasoningProjectionChange={vi.fn()}
        onToolSchemaDialectChange={vi.fn()}
        onHistoryReplayChange={vi.fn()}
      />,
    );
    expect(
      screen.getByText("Responses history continuation"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Chat reasoning display"),
    ).not.toBeInTheDocument();
  });
});
