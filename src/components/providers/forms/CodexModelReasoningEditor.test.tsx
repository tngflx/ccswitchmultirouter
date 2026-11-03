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

  it("keeps an explicitly unconfirmed control mode unknown instead of claiming support", () => {
    const onChange = vi.fn();
    render(
      <CodexModelReasoningEditor
        model="qwen3.8"
        capability={qwenCapability}
        readOnly={false}
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByLabelText("qwen3.8 reasoning control"), {
      target: { value: "unknown" },
    });

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaVersion: 2,
        supportStatus: "unknown",
        controlKind: "unknown",
        supportedEfforts: [],
        defaultEffort: undefined,
        disableAllowed: false,
        upstream: { format: "none", parameter: "none", effortMap: {} },
        source: "user",
      }),
    );
  });

  it.each([
    [true, "none", "confirmed_unsupported"],
    [false, "boolean", "confirmed_supported"],
    [true, "unknown", "unknown"],
  ] as const)(
    "migrates legacy supported=%s when changing control mode to %s",
    (supported, controlKind, supportStatus) => {
      const onChange = vi.fn();
      render(
        <CodexModelReasoningEditor
          model="legacy-model"
          capability={{
            ...qwenCapability,
            schemaVersion: undefined,
            supportStatus: undefined,
            supported,
            ...(supported
              ? {}
              : {
                  controlKind: "none",
                  supportedEfforts: [],
                  defaultEffort: undefined,
                  upstream: { format: "none", parameter: "none" },
                }),
          }}
          readOnly={false}
          onChange={onChange}
        />,
      );

      fireEvent.change(
        screen.getByLabelText("legacy-model reasoning control"),
        {
          target: { value: controlKind },
        },
      );

      const next = onChange.mock.calls[0][0];
      expect(next).toMatchObject({
        schemaVersion: 2,
        supportStatus,
        controlKind,
      });
      expect(next).not.toHaveProperty("supported");
    },
  );

  it("preserves legacy support evidence when editing a field while writing only canonical support state", () => {
    const onChange = vi.fn();
    render(
      <CodexModelReasoningEditor
        model="legacy-model"
        capability={{
          ...qwenCapability,
          schemaVersion: undefined,
          supportStatus: undefined,
          supported: true,
        }}
        readOnly={false}
        onChange={onChange}
      />,
    );

    fireEvent.change(
      screen.getByLabelText("legacy-model provider default effort"),
      {
        target: { value: "high" },
      },
    );

    const next = onChange.mock.calls[0][0];
    expect(next).toMatchObject({
      schemaVersion: 2,
      supportStatus: "confirmed_supported",
      defaultEffort: "high",
      source: "user",
    });
    expect(next).not.toHaveProperty("supported");
  });
  it.each(["boolean", "budget", "none", "unknown"] as const)(
    "clears stale orchestration when switching to %s without an effort mapping",
    (controlKind) => {
      const onChange = vi.fn();
      render(
        <CodexModelReasoningEditor
          model="orchestrated-model"
          capability={{
            ...qwenCapability,
            codexUltraOrchestration: { enabled: true },
            upstream: {
              ...qwenCapability.upstream,
              effortMap: {
                low: "low",
                medium: "medium",
                high: "high",
                max: "high",
              },
            },
          }}
          readOnly={false}
          onChange={onChange}
        />,
      );

      fireEvent.change(
        screen.getByLabelText("orchestrated-model reasoning control"),
        {
          target: { value: controlKind },
        },
      );

      const next = onChange.mock.calls[0][0];
      expect(next.supportedEfforts).toEqual([]);
      expect(next.upstream.effortMap).toEqual({});
      expect(next).not.toHaveProperty("codexUltraOrchestration");
    },
  );

  it.each([
    ["high", false],
    ["medium", true],
  ] as const)(
    "reconciles the orchestration max path when removing native provider effort %s",
    (effort, preservesOrchestration) => {
      const onChange = vi.fn();
      const capability: CodexModelReasoningCapability = {
        ...qwenCapability,
        codexUltraOrchestration: { enabled: true },
        upstream: {
          ...qwenCapability.upstream,
          effortMap: {
            low: "low",
            medium: "medium",
            high: "high",
            max: "high",
          },
        },
      };
      const snapshot = JSON.stringify(capability);
      render(
        <CodexModelReasoningEditor
          model="orchestrated-model"
          capability={capability}
          readOnly={false}
          onChange={onChange}
        />,
      );

      fireEvent.click(
        screen.getByLabelText(`Provider-native effort ${effort}`),
      );

      const next = onChange.mock.calls[0][0];
      expect(next.supportedEfforts).not.toContain(effort);
      expect(Object.values(next.upstream.effortMap)).not.toContain(effort);
      if (preservesOrchestration) {
        expect(next.codexUltraOrchestration).toEqual({ enabled: true });
        expect(next.upstream.effortMap.max).toBe("high");
      } else {
        expect(next).not.toHaveProperty("codexUltraOrchestration");
        expect(next.upstream.effortMap).not.toHaveProperty("max");
      }
      expect(JSON.stringify(capability)).toBe(snapshot);
    },
  );

  it("keeps a valid orchestration path when editing the provider default", () => {
    const onChange = vi.fn();
    render(
      <CodexModelReasoningEditor
        model="orchestrated-model"
        capability={{
          ...qwenCapability,
          codexUltraOrchestration: { enabled: true },
          upstream: {
            ...qwenCapability.upstream,
            effortMap: {
              low: "low",
              medium: "medium",
              high: "high",
              max: "high",
            },
          },
        }}
        readOnly={false}
        onChange={onChange}
      />,
    );

    fireEvent.change(
      screen.getByLabelText("orchestrated-model provider default effort"),
      {
        target: { value: "high" },
      },
    );

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultEffort: "high",
        codexUltraOrchestration: { enabled: true },
        upstream: expect.objectContaining({
          effortMap: expect.objectContaining({ max: "high" }),
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
