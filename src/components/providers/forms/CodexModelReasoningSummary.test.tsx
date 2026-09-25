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
          source="自动发现"
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
          source="用户声明"
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
    expect(screen.getAllByText("配置推理能力")).toHaveLength(2);
    expect(
      screen.getByText("Codex 档位：low / medium / high"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "为 qwen3.8 启用 Codex Ultra" }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("checkbox", {
        name: "为 qwen3.8-coder 启用 Codex Ultra",
      }),
    ).toBeChecked();

    fireEvent.click(
      screen.getByRole("button", { name: "配置 qwen3.8 的推理能力" }),
    );
    expect(onToggle).toHaveBeenCalledOnce();

    fireEvent.click(
      screen.getByRole("checkbox", { name: "为 qwen3.8 启用 Codex Ultra" }),
    );
    expect(onUltraChange).toHaveBeenNthCalledWith(1, {
      enabled: true,
      providerEffort: undefined,
    });
  });

  it("withholds Ultra until graded efforts are resolved while preserving configuration access", () => {
    const onToggle = vi.fn();
    const onUltraChange = vi.fn();

    render(
      <CodexModelReasoningSummary
        model="glm-4.5"
        source="自动发现或服务端默认"
        selectableEfforts={[]}
        ultraEnabled={false}
        ultraEfforts={[]}
        onUltraChange={onUltraChange}
        expanded={false}
        onToggle={onToggle}
      />,
    );

    expect(
      screen.queryByRole("checkbox", {
        name: "为 glm-4.5 启用 Codex Ultra",
      }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "配置 glm-4.5 的推理能力" }),
    );
    expect(onToggle).toHaveBeenCalledOnce();
    expect(onUltraChange).not.toHaveBeenCalled();
  });

  it("keeps an existing unresolved Ultra mapping visible so it can be turned off", () => {
    const onUltraChange = vi.fn();
    render(
      <CodexModelReasoningSummary
        model="legacy"
        source="unknown"
        selectableEfforts={[]}
        ultraEnabled
        ultraEfforts={[]}
        onUltraChange={onUltraChange}
        expanded={false}
        onToggle={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "为 legacy 启用 Codex Ultra" }),
    );
    expect(onUltraChange).toHaveBeenCalledWith({
      enabled: false,
      providerEffort: undefined,
    });
  });
});
