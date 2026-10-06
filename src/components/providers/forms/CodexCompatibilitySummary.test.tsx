import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CodexCompatibilitySummary } from "./CodexCompatibilitySummary";

describe("CodexCompatibilitySummary", () => {
  it("does not classify unavailable responses as missing reasoning", () => {
    render(
      <CodexCompatibilitySummary
        transport="open_ai_responses"
        readiness="unverified"
        baselinePassed={false}
        reasoningSemantic="none"
        reasoningSource="none"
        toolSchemaDialect="openai"
        historyReplay="native_only"
        retries={[]}
        running={false}
        selected={false}
      />,
    );
    expect(
      screen.queryByText(/The upstream returned no displayable reasoning text/),
    ).not.toBeInTheDocument();
  });
  it("does not call native opaque reasoning repaired or invent visible thinking", () => {
    render(
      <CodexCompatibilitySummary
        transport="open_ai_responses"
        readiness="verified"
        baselinePassed
        reasoningSemantic="opaque"
        reasoningSource="native_responses"
        toolSchemaDialect="openai"
        historyReplay="native_only"
        retries={[]}
        running={false}
        selected
      />,
    );
    expect(screen.getByText("This check passed")).toBeInTheDocument();
    expect(
      screen.queryByText("Passed after adaptation"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        /does not generate, decrypt, or fabricate thinking content/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/not proof that the current configuration is active/),
    ).toBeInTheDocument();
  });
  it("does not infer a repair from an in-flight baseline request", () => {
    render(
      <CodexCompatibilitySummary
        transport="open_ai_chat"
        readiness={null}
        baselinePassed={false}
        reasoningSemantic={null}
        reasoningSource={null}
        toolSchemaDialect={null}
        historyReplay={null}
        retries={[]}
        running
        selected={false}
      />,
    );
    expect(
      screen.getByText("Checking response and protocol differences"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Automatically adapting and retrying"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/The upstream uses the Chat response shape/),
    ).not.toBeInTheDocument();
  });
});
