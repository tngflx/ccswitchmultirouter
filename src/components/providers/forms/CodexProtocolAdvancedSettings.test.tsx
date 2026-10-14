import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CodexProtocolAdvancedSettings } from "./CodexProtocolAdvancedSettings";

const selectChangeHandlers = vi.hoisted(
  () => new Map<string, (value: string) => void>(),
);

vi.mock("@/components/ui/select", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui/select")>(
    "@/components/ui/select",
  );
  return {
    ...actual,
    Select: (props: ComponentProps<typeof actual.Select>) => {
      if (props.value && props.onValueChange) {
        selectChangeHandlers.set(props.value, props.onValueChange);
      }
      return <actual.Select {...props} />;
    },
  };
});

type ProtocolSettingsProps = ComponentProps<
  typeof CodexProtocolAdvancedSettings
>;

describe("CodexProtocolAdvancedSettings", () => {
  beforeEach(() => {
    selectChangeHandlers.clear();
  });

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

  it.each([
    {
      control: "protocol mode",
      callback: "onModeChange",
      selected: "manual",
      values: ["auto", "manual"],
      rejected: ["unknown", ""],
      apiFormat: "openai_chat",
    },
    {
      control: "runtime API format",
      callback: "onApiFormatChange",
      selected: "openai_chat",
      values: ["openai_chat", "openai_responses"],
      rejected: ["unknown", "anthropic", "openai_messages"],
      apiFormat: "openai_chat",
    },
    {
      control: "tool schema",
      callback: "onToolSchemaDialectChange",
      selected: "openai",
      values: ["openai", "moonshot_mfjs"],
      rejected: ["unknown", ""],
      apiFormat: "openai_chat",
    },
    {
      control: "Chat reasoning display",
      callback: "onReasoningProjectionChange",
      selected: "none",
      values: ["none", "raw_reasoning_text"],
      rejected: ["unknown", "reasoning_summary"],
      apiFormat: "openai_chat",
    },
    {
      control: "Responses history continuation",
      callback: "onHistoryReplayChange",
      selected: "native_only",
      values: [
        "native_only",
        "responses_reasoning_text_content",
        "responses_reasoning_summary_only",
        "omit",
      ],
      rejected: ["unknown", "chat_reasoning_content"],
      apiFormat: "openai_responses",
    },
  ] as const)(
    "accepts only listed $control values from the select callback",
    ({ callback, selected, values, rejected, apiFormat }) => {
      const onChange = vi.fn();
      const props: ProtocolSettingsProps = {
        mode: "manual",
        apiFormat,
        reasoningProjection: "none",
        toolSchemaDialect: "openai",
        historyReplay: "native_only",
        onModeChange: vi.fn(),
        onApiFormatChange: vi.fn(),
        onReasoningProjectionChange: vi.fn(),
        onToolSchemaDialectChange: vi.fn(),
        onHistoryReplayChange: vi.fn(),
        [callback]: onChange,
      };
      render(<CodexProtocolAdvancedSettings {...props} />);
      const onValueChange = selectChangeHandlers.get(selected);
      expect(onValueChange).toBeDefined();

      act(() => {
        for (const value of rejected) onValueChange?.(value);
      });
      expect(onChange).not.toHaveBeenCalled();

      for (const value of values) {
        act(() => onValueChange?.(value));
        expect(onChange).toHaveBeenLastCalledWith(value);
      }
      expect(onChange).toHaveBeenCalledTimes(values.length);
    },
  );
});
