import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CodexModelReasoningSummary } from "./CodexModelReasoningSummary";

describe("CodexModelReasoningSummary", () => {
  it.each(["xiaomi/mimo-v2.6-flash", "xiaomi/mimo-v2.6-pro"])(
    "labels known Boolean %s as thinking on/off instead of undeclared effort",
    (model) => {
      render(
        <CodexModelReasoningSummary
          model={model}
          source="detection"
          supportKind="boolean_only"
          selectableEfforts={[]}
          defaultEffort="medium"
          ultraEnabled={false}
          ultraEfforts={[]}
          onUltraChange={vi.fn()}
          expanded={false}
          onToggle={vi.fn()}
        />,
      );

      expect(
        screen.getByText("Reasoning control: Thinking on/off"),
      ).toBeInTheDocument();
      expect(screen.queryByText(/Not declared/)).toBeNull();
      expect(screen.queryByText(/Default: medium/)).toBeNull();
      expect(screen.queryByText(/Codex levels:/)).toBeNull();
      expect(
        screen.getByText("Capability source: Automatic detection"),
      ).toBeInTheDocument();
    },
  );

  it("keeps unknown capability distinct from known Boolean reasoning", () => {
    render(
      <CodexModelReasoningSummary
        model="unknown-model"
        source="automatic"
        supportKind="unknown"
        selectableEfforts={[]}
        ultraEnabled={false}
        ultraEfforts={[]}
        onUltraChange={vi.fn()}
        expanded={false}
        onToggle={vi.fn()}
      />,
    );

    expect(screen.getByText("Codex levels: Not declared")).toBeInTheDocument();
    expect(screen.getByText("Default: Model default")).toBeInTheDocument();
    expect(screen.queryByText(/Thinking on\/off/)).toBeNull();
  });

  it("preserves explicit graded levels and their provider default", () => {
    render(
      <CodexModelReasoningSummary
        model="graded-model"
        source="library"
        supportKind="effort_levels"
        selectableEfforts={["low", "high", "max"]}
        defaultEffort="high"
        ultraEnabled={false}
        ultraEfforts={["low", "high", "max"]}
        onUltraChange={vi.fn()}
        expanded={false}
        onToggle={vi.fn()}
      />,
    );

    expect(
      screen.getByText("Codex levels: low / high / max"),
    ).toBeInTheDocument();
    expect(screen.getByText("Default: high")).toBeInTheDocument();
    expect(screen.queryByText(/Thinking on\/off/)).toBeNull();
  });

  it("keeps each model concise until the user opens its configuration", () => {
    const onToggle = vi.fn();
    const onUltraChange = vi.fn();

    render(
      <div>
        <CodexModelReasoningSummary
          model="qwen3.8"
          source="Automatic detection"
          selectableEfforts={["low", "medium", "high"]}
          defaultEffort="medium"
          ultraEnabled={false}
          ultraEfforts={["low", "medium", "high"]}
          onUltraChange={onUltraChange}
          expanded={false}
          onToggle={onToggle}
        />
        <CodexModelReasoningSummary
          model="qwen3.8-coder"
          source="User declaration"
          selectableEfforts={["low", "high"]}
          defaultEffort="high"
          ultraEnabled
          ultraEffort="high"
          ultraEfforts={["low", "high"]}
          onUltraChange={onUltraChange}
          expanded={false}
          onToggle={onToggle}
        />
      </div>,
    );

    expect(screen.getByText("qwen3.8")).toBeInTheDocument();
    expect(screen.getByText("qwen3.8-coder")).toBeInTheDocument();
    expect(screen.getAllByText("Configure reasoning")).toHaveLength(2);
    expect(
      screen.getByText("Codex levels: low / medium / high"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "Unlock Ultra for qwen3.8" }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("checkbox", {
        name: "Unlock Ultra for qwen3.8-coder",
      }),
    ).toBeChecked();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Configure reasoning capabilities for qwen3.8",
      }),
    );
    expect(onToggle).toHaveBeenCalledOnce();

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Unlock Ultra for qwen3.8" }),
    );
    expect(onUltraChange).toHaveBeenNthCalledWith(1, {
      enabled: true,
      providerEffort: undefined,
    });
  });

  it("allows Ultra to be unlocked before Provider effort discovery and opens the required configuration", () => {
    const onToggle = vi.fn();
    const onUltraChange = vi.fn();

    render(
      <CodexModelReasoningSummary
        model="glm-4.5"
        source="Automatic discovery or server default"
        selectableEfforts={[]}
        ultraEnabled={false}
        ultraEfforts={[]}
        onUltraChange={onUltraChange}
        expanded={false}
        onToggle={onToggle}
      />,
    );

    const unlock = screen.getByRole("checkbox", {
      name: "Unlock Ultra for glm-4.5",
    });
    expect(unlock).toBeEnabled();

    fireEvent.click(unlock);

    expect(onUltraChange).toHaveBeenCalledWith({
      enabled: true,
      providerEffort: undefined,
    });
    expect(onToggle).toHaveBeenCalledOnce();
    expect(
      screen.getByText(
        "Confirm this model's supported reasoning levels before saving.",
      ),
    ).toBeInTheDocument();
  });

  it("shows a supported native max Ultra target as selected and usable", () => {
    const onUltraChange = vi.fn();
    render(
      <CodexModelReasoningSummary
        model="gpt-6.1"
        source="User declaration"
        selectableEfforts={["low", "high", "max"]}
        ultraEnabled
        ultraEffort="max"
        ultraEfforts={["low", "high", "max"]}
        onUltraChange={onUltraChange}
        expanded={false}
        onToggle={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("combobox", {
        name: "Send Ultra as (gpt-6.1)",
      }),
    ).toHaveValue("max");
    expect(screen.getByText("Main agent Ultra")).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Max", selected: true }),
    ).toBeEnabled();
    expect(onUltraChange).not.toHaveBeenCalled();
  });

  it("shows an unavailable saved max target until the user chooses a supported effort", () => {
    const onUltraChange = vi.fn();
    render(
      <CodexModelReasoningSummary
        model="gpt-6.1"
        source="User declaration"
        selectableEfforts={["low", "high", "xhigh"]}
        ultraEnabled
        ultraEffort="max"
        ultraEfforts={["low", "high", "xhigh"]}
        onUltraChange={onUltraChange}
        expanded={false}
        onToggle={vi.fn()}
      />,
    );

    const effort = screen.getByRole("combobox", {
      name: "Send Ultra as (gpt-6.1)",
    });
    expect(effort).toHaveValue("max");
    expect(
      screen.getByRole("option", { name: "Max (unavailable)", selected: true }),
    ).toBeDisabled();
    expect(
      screen.getByRole("option", { name: "Extra High (xhigh)" }),
    ).toBeEnabled();
    expect(
      screen.getByText(
        "Saved provider level Max is unavailable. Choose a currently supported level before saving.",
      ),
    ).toBeInTheDocument();
    expect(onUltraChange).not.toHaveBeenCalled();

    fireEvent.change(effort, { target: { value: "xhigh" } });
    expect(onUltraChange).toHaveBeenCalledWith({
      enabled: true,
      providerEffort: "xhigh",
      providerEffortSource: "user",
    });
  });

  it("retains a manually selected Ultra target when locking Ultra again", () => {
    const onUltraChange = vi.fn();
    render(
      <CodexModelReasoningSummary
        model="gpt-6.2-sol"
        source="library"
        selectableEfforts={["xhigh", "max"]}
        ultraEnabled
        ultraEffort="xhigh"
        ultraEffortSource="user"
        ultraEfforts={["xhigh", "max"]}
        onUltraChange={onUltraChange}
        expanded={false}
        onToggle={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: /Unlock Ultra/ }));
    expect(onUltraChange).toHaveBeenCalledWith({
      enabled: false,
      providerEffort: "xhigh",
      providerEffortSource: "user",
    });
  });

  it("retains an unavailable saved max when no provider efforts are available", () => {
    const onUltraChange = vi.fn();
    render(
      <CodexModelReasoningSummary
        model="gpt-6.1"
        source="Automatic detection"
        selectableEfforts={[]}
        ultraEnabled
        ultraEffort="max"
        ultraEfforts={[]}
        onUltraChange={onUltraChange}
        expanded={false}
        onToggle={vi.fn()}
      />,
    );

    const effort = screen.getByRole("combobox", {
      name: "Send Ultra as (gpt-6.1)",
    });
    expect(effort).toHaveValue("max");
    expect(effort).toBeDisabled();
    expect(
      screen.getByRole("option", { name: "Max (unavailable)", selected: true }),
    ).toBeDisabled();
    expect(
      screen.getByText(
        "Saved provider level Max is unavailable. Confirm this model's reasoning capabilities, then choose a supported level before saving.",
      ),
    ).toBeInTheDocument();
    expect(onUltraChange).not.toHaveBeenCalled();
  });
});
