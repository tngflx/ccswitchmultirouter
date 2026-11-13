import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CodexModelReasoningSummary } from "./CodexModelReasoningSummary";

describe("CodexModelReasoningSummary", () => {
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
        "First confirm that this model accepts reasoning levels. The capability editor is open; complete it before saving.",
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
        name: "Provider reasoning effort used by gpt-6.1 Ultra",
      }),
    ).toHaveValue("max");
    expect(screen.getByRole("option", { name: "max" })).toBeEnabled();
    expect(screen.getByText("Unlocked; uses max")).toBeInTheDocument();
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
      name: "Provider reasoning effort used by gpt-6.1 Ultra",
    });
    expect(effort).toHaveValue("max");
    expect(
      screen.getByRole("option", { name: "max (unavailable)" }),
    ).toBeDisabled();
    expect(screen.queryByText("Unlocked; uses max")).toBeNull();
    expect(
      screen.getByText(
        "Saved provider level max is unavailable. Choose a currently supported level before saving.",
      ),
    ).toBeInTheDocument();
    expect(onUltraChange).not.toHaveBeenCalled();

    fireEvent.change(effort, { target: { value: "xhigh" } });
    expect(onUltraChange).toHaveBeenCalledWith({
      enabled: true,
      providerEffort: "xhigh",
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
      name: "Provider reasoning effort used by gpt-6.1 Ultra",
    });
    expect(effort).toHaveValue("max");
    expect(effort).toBeDisabled();
    expect(
      screen.getByRole("option", { name: "max (unavailable)" }),
    ).toBeDisabled();
    expect(
      screen.getByText(
        "Saved provider level max is unavailable. Confirm this model's reasoning capabilities, then choose a supported level before saving.",
      ),
    ).toBeInTheDocument();
    expect(onUltraChange).not.toHaveBeenCalled();
  });
});
