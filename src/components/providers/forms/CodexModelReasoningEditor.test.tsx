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

const sublyxCapability: CodexModelReasoningCapability = {
  schemaVersion: 2,
  supportStatus: "confirmed_supported",
  controlKind: "graded",
  // Simulate a catalog row written before the provider-scoped contract was
  // introduced. The editor must hide and reconcile this stale native max.
  supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
  defaultEffort: "xhigh",
  disableAllowed: false,
  upstream: {
    format: "reasoning_object",
    parameter: "reasoning.effort",
    effortMap: {
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "xhigh",
    },
  },
  source: "sublyx",
  codexUltraOrchestration: {
    enabled: true,
    providerEffort: "xhigh",
  },
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
        expect(next.codexUltraOrchestration).toEqual({
          enabled: true,
          providerEffort: "high",
        });
        expect(next.upstream.effortMap.max).toBe("high");
      } else {
        expect(next).not.toHaveProperty("codexUltraOrchestration");
        expect(next.upstream.effortMap).not.toHaveProperty("max");
      }
      expect(JSON.stringify(capability)).toBe(snapshot);
    },
  );

  it("keeps an explicit Provider target when editing a Sublyx-style capability", () => {
    const onChange = vi.fn();
    render(
      <CodexModelReasoningEditor
        model="gpt-6.1-sol-sublyx"
        capability={{
          ...qwenCapability,
          supportedEfforts: ["low", "medium", "high", "xhigh"],
          defaultEffort: "medium",
          codexUltraOrchestration: {
            enabled: true,
            providerEffort: "xhigh",
          },
          upstream: {
            format: "reasoning_object",
            parameter: "reasoning.effort",
            effortMap: {
              low: "low",
              medium: "medium",
              high: "high",
              xhigh: "xhigh",
            },
          },
        }}
        readOnly={false}
        onChange={onChange}
      />,
    );

    fireEvent.change(
      screen.getByLabelText("gpt-6.1-sol-sublyx provider default effort"),
      { target: { value: "high" } },
    );

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultEffort: "high",
        codexUltraOrchestration: {
          enabled: true,
          providerEffort: "xhigh",
        },
        upstream: expect.objectContaining({
          effortMap: expect.not.objectContaining({ max: expect.anything() }),
        }),
      }),
    );
  });

  it("keeps a valid orchestration path when editing the provider default", () => {
    const onChange = vi.fn();
    render(
      <CodexModelReasoningEditor
        model="orchestrated-model"
        capability={{
          ...qwenCapability,
          codexUltraOrchestration: { enabled: true, providerEffort: "high" },
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
        codexUltraOrchestration: { enabled: true, providerEffort: "high" },
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

  it("locks the maintained Sublyx native wire contract without locking default or support decisions", () => {
    const onChange = vi.fn();
    render(
      <CodexModelReasoningEditor
        model="gpt-6.1"
        providerIdentity={{ baseUrl: "https://api.sublyx.org/v1" }}
        capability={sublyxCapability}
        readOnly={false}
        onChange={onChange}
      />,
    );
    expect(screen.getByLabelText("Provider-native effort high")).toBeDisabled();
    expect(screen.queryByLabelText("Add native provider level")).toBeNull();
    expect(
      screen.getByLabelText("gpt-6.1 upstream parameter format"),
    ).toBeDisabled();
    expect(
      screen.getByLabelText("gpt-6.1 upstream parameter name"),
    ).toHaveAttribute("readonly");
    expect(screen.getByLabelText("high mapping target")).toBeDisabled();
    expect(
      screen.getByLabelText("Provider supports explicitly disabling reasoning"),
    ).toBeDisabled();
    expect(
      screen.getByLabelText("gpt-6.1 provider default effort"),
    ).toBeEnabled();
    expect(screen.getByLabelText("gpt-6.1 reasoning control")).toBeEnabled();
    expect(
      screen.getByText(
        /Sublyx GPT native levels and wire settings are maintained automatically/,
      ),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("gpt-6.1 reasoning control"), {
      target: { value: "unknown" },
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        supportStatus: "unknown",
        controlKind: "unknown",
        source: "user",
      }),
    );
  });

  it("does not lock explicitly unconfirmed Sublyx declarations", () => {
    render(
      <CodexModelReasoningEditor
        model="gpt-6.1"
        providerIdentity={{ baseUrl: "https://api.sublyx.org/v1" }}
        capability={{ ...qwenCapability, supportStatus: "unknown" }}
        readOnly={false}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Provider-native effort high")).toBeEnabled();
    expect(
      screen.getByLabelText("gpt-6.1 upstream parameter format"),
    ).toBeEnabled();
    expect(screen.getByLabelText("high mapping target")).toBeEnabled();
  });

  it("keeps Sublyx max provider-scoped and exposes Ultra as xhigh", () => {
    const onChange = vi.fn();
    render(
      <CodexModelReasoningEditor
        model="gpt-6.1-sol-sublyx"
        capability={sublyxCapability}
        readOnly={false}
        onChange={onChange}
      />,
    );

    expect(screen.queryByLabelText("Provider-native effort max")).toBeNull();
    expect(screen.queryByLabelText("max mapping target")).toBeNull();
    expect(
      screen.getByLabelText("gpt-6.1-sol-sublyx provider default effort"),
    ).not.toHaveValue("max");
    expect(screen.queryByLabelText("Add native provider level")).toBeNull();
    expect(
      within(
        screen.getByRole("group", {
          name: "gpt-6.1-sol-sublyx Codex-to-provider mapping",
        }),
      ).getByLabelText("xhigh mapping target"),
    ).toHaveValue("xhigh");

    fireEvent.change(
      screen.getByLabelText("gpt-6.1-sol-sublyx provider default effort"),
      { target: { value: "xhigh" } },
    );
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "user",
        providerKey: "sublyx",
        supportedEfforts: ["low", "medium", "high", "xhigh"],
        defaultEffort: "xhigh",
        codexUltraOrchestration: {
          enabled: true,
          providerEffort: "xhigh",
        },
        upstream: expect.objectContaining({
          effortMap: expect.not.objectContaining({ max: expect.anything() }),
        }),
      }),
    );
  });

  it("preserves native max for generic providers", () => {
    render(
      <CodexModelReasoningEditor
        model="generic-model"
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
      screen.getByLabelText("Provider-native effort max"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("max mapping target")).toHaveValue("max");
  });
  it.each([
    {
      label: "explicit provider",
      providerIdentity: { baseUrl: "https://api.sublyx.org/v1" },
      providerKey: undefined,
    },
    {
      label: "capability provider key",
      providerIdentity: undefined,
      providerKey: "sublyx",
    },
  ])(
    "normalizes stale manual Sublyx GPT metadata using $label",
    ({ providerIdentity, providerKey }) => {
      const onChange = vi.fn();
      render(
        <CodexModelReasoningEditor
          model="gpt-6.1"
          providerIdentity={providerIdentity}
          capability={{
            ...sublyxCapability,
            source: "user",
            providerKey,
            defaultEffort: "max",
            codexUltraOrchestration: { enabled: true, providerEffort: "max" },
          }}
          readOnly={false}
          onChange={onChange}
        />,
      );
      expect(screen.queryByLabelText("Provider-native effort max")).toBeNull();
      expect(
        screen.getByLabelText("gpt-6.1 provider default effort"),
      ).toHaveValue("xhigh");
      fireEvent.change(
        screen.getByLabelText("gpt-6.1 provider default effort"),
        { target: { value: "high" } },
      );
      const next = onChange.mock.calls[0][0];
      expect(next).toMatchObject({
        source: "user",
        providerKey: "sublyx",
        defaultEffort: "high",
        codexUltraOrchestration: { enabled: true, providerEffort: "xhigh" },
      });
      expect(next.supportedEfforts).not.toContain("max");
      expect(next.upstream.effortMap).not.toHaveProperty("max");
      expect(Object.values(next.upstream.effortMap)).not.toContain("max");
    },
  );

  it("preserves OpenRouter native max despite stale Sublyx provenance", () => {
    const onChange = vi.fn();
    render(
      <CodexModelReasoningEditor
        model="gpt-6.1-sol-sublyx"
        providerIdentity={{ baseUrl: "https://openrouter.ai/api/v1" }}
        capability={{
          ...sublyxCapability,
          providerKey: "sublyx",
          upstream: {
            ...sublyxCapability.upstream,
            effortMap: { ...sublyxCapability.upstream.effortMap, max: "max" },
          },
        }}
        readOnly={false}
        onChange={onChange}
      />,
    );
    expect(
      screen.getByLabelText("Provider-native effort max"),
    ).toBeInTheDocument();
    fireEvent.change(
      screen.getByLabelText("gpt-6.1-sol-sublyx provider default effort"),
      { target: { value: "max" } },
    );
    expect(onChange.mock.calls[0][0]).toMatchObject({
      source: "user",
      defaultEffort: "max",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      upstream: { effortMap: { max: "max" } },
    });
  });

  it("does not apply the Sublyx GPT contract to a different model family", () => {
    render(
      <CodexModelReasoningEditor
        model="claude-sonnet"
        providerIdentity={{ baseUrl: "https://api.sublyx.org/v1" }}
        capability={sublyxCapability}
        readOnly={false}
        onChange={vi.fn()}
      />,
    );
    expect(
      screen.getByLabelText("Provider-native effort max"),
    ).toBeInTheDocument();
  });

  it("never infers a provider from the model suffix alone", () => {
    render(
      <CodexModelReasoningEditor
        model="gpt-6.1-sublyx"
        capability={{ ...sublyxCapability, source: "user" }}
        readOnly={false}
        onChange={vi.fn()}
      />,
    );
    expect(
      screen.getByLabelText("Provider-native effort max"),
    ).toBeInTheDocument();
  });

  it("uses the upstream GPT family for a public model alias", () => {
    render(
      <CodexModelReasoningEditor
        model="public-alias"
        upstreamModel="gpt-6.1"
        providerIdentity={{ baseUrl: "https://api.sublyx.org/v1" }}
        capability={{ ...sublyxCapability, source: "user" }}
        readOnly={false}
        onChange={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText("Provider-native effort max")).toBeNull();
  });

  it("does not apply the GPT contract to a GPT-looking public alias for a non-GPT wire model", () => {
    render(
      <CodexModelReasoningEditor
        model="gpt-public-alias"
        upstreamModel="claude-sonnet"
        providerIdentity={{ baseUrl: "https://api.sublyx.org/v1" }}
        capability={{ ...sublyxCapability, source: "user" }}
        readOnly={false}
        onChange={vi.fn()}
      />,
    );
    expect(
      screen.getByLabelText("Provider-native effort max"),
    ).toBeInTheDocument();
  });
});
