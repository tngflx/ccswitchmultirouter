import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CodexModelReasoningCapability } from "@/types";

import { CodexModelReasoningEditor } from "./CodexModelReasoningEditor";

const qwenCapability: CodexModelReasoningCapability = {
  schemaVersion: 2,
  supportStatus: "confirmed_supported",
  controlKind: "graded",
  supportedEfforts: ["low", "medium", "high"],
  defaultEffort: "medium",
  disableAllowed: false,
  upstream: {
    format: "string",
    parameter: "reasoning_effort",
    effortMap: { low: "low", medium: "medium", high: "high" },
  },
  source: "user",
};

describe("CodexModelReasoningEditor", () => {
  it("explains every manual configuration group", () => {
    render(
      <CodexModelReasoningEditor
        model="qwen3.8"
        capability={qwenCapability}
        readOnly={false}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByText("Native provider capability")).toBeInTheDocument();
    expect(screen.getByText("Provider default level")).toBeInTheDocument();
    expect(screen.getByText("Upstream parameter")).toBeInTheDocument();
    expect(screen.getByText("Codex → provider mapping")).toBeInTheDocument();
    expect(
      screen.getByText(
        /Same-named levels receive an identity mapping automatically/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/Example: reasoning_effort/)).toBeInTheDocument();
  });

  it("shows mapping rows only for this model's Provider-native efforts", () => {
    render(
      <CodexModelReasoningEditor
        model="qwen3.8"
        capability={qwenCapability}
        readOnly={false}
        onChange={vi.fn()}
      />,
    );

    const mapping = screen.getByRole("group", {
      name: "qwen3.8 Codex-to-provider mapping",
    });
    expect(within(mapping).getByLabelText("low mapping target")).toHaveValue(
      "low",
    );
    expect(within(mapping).getByLabelText("medium mapping target")).toHaveValue(
      "medium",
    );
    expect(within(mapping).getByLabelText("high mapping target")).toHaveValue(
      "high",
    );
    expect(within(mapping).queryByLabelText("xhigh mapping target")).toBeNull();
    expect(screen.queryByLabelText("Provider-native effort xhigh")).toBeNull();
  });

  it("fills the identity mapping when a native effort is selected", () => {
    const onChange = vi.fn();
    render(
      <CodexModelReasoningEditor
        model="qwen3.8"
        capability={{
          ...qwenCapability,
          supportedEfforts: ["low", "medium"],
          upstream: {
            ...qwenCapability.upstream,
            effortMap: { low: "low", medium: "medium" },
          },
        }}
        readOnly={false}
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByLabelText("Add native provider level"), {
      target: { value: "high" },
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        supportedEfforts: ["low", "medium", "high"],
        upstream: expect.objectContaining({
          effortMap: expect.objectContaining({ high: "high" }),
        }),
      }),
    );
  });

  it("keeps Ultra out of the Provider capability editor", () => {
    render(
      <CodexModelReasoningEditor
        model="qwen3.8"
        capability={{
          ...qwenCapability,
          supportedEfforts: ["low", "medium", "high", "max"],
          upstream: {
            ...qwenCapability.upstream,
            effortMap: {
              low: "low",
              medium: "medium",
              high: "high",
              max: "max",
            },
          },
        }}
        readOnly={false}
        onChange={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("checkbox", {
        name: "Enable Codex Ultra orchestration",
      }),
    ).toBeNull();
    expect(screen.queryByText("Codex Ultra orchestration")).toBeNull();
  });
});
