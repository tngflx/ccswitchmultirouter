import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CodexConfigSection } from "@/components/providers/forms/CodexConfigSections";

vi.mock("@/components/JsonEditor", () => ({
  default: ({ value }: { value: string }) => (
    <textarea aria-label="codex-config" value={value} readOnly />
  ),
}));

describe("CodexConfigSection 1M context controls", () => {
  it("writes and removes the paired context fields", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <CodexConfigSection
        value=""
        onChange={onChange}
        useCommonConfig={false}
        onCommonConfigToggle={() => {}}
      />,
    );

    fireEvent.click(
      screen.getByRole("checkbox", { name: "codexConfig.contextWindow1M" }),
    );
    const enabled = onChange.mock.calls.at(-1)?.[0] as string;
    expect(enabled).toContain("model_context_window = 1000000");
    expect(enabled).toContain("model_auto_compact_token_limit = 900000");

    rerender(
      <CodexConfigSection
        value={enabled}
        onChange={onChange}
        useCommonConfig={false}
        onCommonConfigToggle={() => {}}
      />,
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "codexConfig.contextWindow1M" }),
    );
    const disabled = onChange.mock.calls.at(-1)?.[0] as string;
    expect(disabled).not.toContain("model_context_window");
    expect(disabled).not.toContain("model_auto_compact_token_limit");
  });
});
