import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCodexOfficialContextDefault } from "@/config/codexOfficialContextDefaults";
import { getCodexOfficialModelSpec } from "@/config/codexOfficialModelSpecs";
import type { FetchedModel } from "@/lib/api/model-fetch";
import { CodexOfficialContextRow } from "./CodexOfficialContextRow";

vi.mock("@/config/codexOfficialContextDefaults", () => ({
  getCodexOfficialContextDefault: vi.fn(),
}));
vi.mock("@/config/codexOfficialModelSpecs", () => ({
  getCodexOfficialModelSpec: vi.fn(),
}));

const discovered: FetchedModel = {
  id: "synthetic-official-model",
  ownedBy: "openai",
  contextWindow: 272_000,
  maxContextWindow: 872_000,
};

function renderRow(
  metadata: Partial<FetchedModel> = {},
  value = "",
  maximumIsTrusted = true,
) {
  const onChange = vi.fn();
  const result = render(
    <CodexOfficialContextRow
      model="Visible model"
      upstreamModel="synthetic-official-model"
      value={value}
      discovered={{ ...discovered, ...metadata }}
      maximumIsTrusted={maximumIsTrusted}
      onChange={onChange}
    />,
  );
  return { ...result, onChange };
}

function presetValues() {
  return within(screen.getByRole("combobox"))
    .getAllByRole("option")
    .map((option) => (option as HTMLOptionElement).value);
}

describe("CodexOfficialContextRow", () => {
  beforeEach(() => {
    vi.mocked(getCodexOfficialContextDefault).mockReset();
    vi.mocked(getCodexOfficialModelSpec).mockReset();
  });

  it("bounds presets by the discovered maximum and preserves custom overrides", () => {
    const { onChange } = renderRow({}, "700000");
    expect(presetValues()).toEqual([
      "default",
      "128000",
      "256000",
      "512000",
      "272000",
      "872000",
      "custom",
    ]);
    expect(screen.getByRole("textbox")).toHaveValue("700000");
    expect(screen.getByRole("textbox")).toHaveAttribute(
      "aria-invalid",
      "false",
    );
    expect(screen.getByRole("combobox")).toHaveValue("custom");
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "872000" },
    });
    expect(onChange).toHaveBeenCalledWith("872000");
  });

  it("requires an explicit maximum before offering or accepting one million", () => {
    renderRow(
      { contextWindow: 1_050_000, maxContextWindow: undefined },
      "1000000",
    );
    expect(presetValues()).not.toContain("1000000");
    expect(presetValues()).not.toContain("1050000");
    expect(screen.getByRole("textbox")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("does not reinsert a published default rejected by the authenticated maximum guard", () => {
    vi.mocked(getCodexOfficialContextDefault).mockReturnValue({
      model: "synthetic-official-model",
      contextWindow: 1_000_000,
      source: "Synthetic official source",
      sourceDate: "2026-10-21",
      documentationUrl: "https://example.invalid/official-default",
    });
    const { rerender } = renderRow(
      { contextWindow: 1_050_000, maxContextWindow: undefined },
      "1000000",
      false,
    );
    expect(presetValues()).not.toContain("1000000");
    expect(screen.getByRole("textbox")).toHaveAttribute("aria-invalid", "true");

    rerender(
      <CodexOfficialContextRow
        model="Visible model"
        value="300000"
        discovered={{ ...discovered, maxContextWindow: 1_050_000 }}
        maximumIsTrusted={false}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("textbox")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("combobox")).toHaveValue("custom");
    expect(presetValues()).not.toContain("1000000");
  });

  it("requires an authenticated account maximum before enlarging beyond a public directory default", () => {
    const publicMetadata = { ...discovered, maxContextWindow: 1_050_000 };
    const { rerender } = renderRow(
      { maxContextWindow: 1_050_000 },
      "1000000",
      false,
    );
    expect(presetValues()).not.toContain("1000000");
    expect(presetValues()).not.toContain("1050000");
    expect(presetValues()).not.toContain("512000");
    expect(screen.getByRole("textbox")).toHaveAttribute("aria-invalid", "true");
    expect(
      screen.getByText("1,050,000", { selector: "dd" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("codexConfig.officialUnverifiedMax"),
    ).toBeInTheDocument();

    rerender(
      <CodexOfficialContextRow
        model="Visible model"
        value="1000000"
        discovered={publicMetadata}
        onChange={vi.fn()}
      />,
    );
    expect(presetValues()).not.toContain("1000000");
    expect(screen.getByRole("textbox")).toHaveAttribute("aria-invalid", "true");

    rerender(
      <CodexOfficialContextRow
        model="Visible model"
        value="1000000"
        discovered={publicMetadata}
        maximumIsTrusted
        onChange={vi.fn()}
      />,
    );
    expect(presetValues()).toContain("1000000");
    expect(presetValues()).toContain("1050000");
    expect(screen.getByRole("textbox")).toHaveAttribute(
      "aria-invalid",
      "false",
    );
  });

  it("never offers a directory default above a lower explicit maximum", () => {
    renderRow({ contextWindow: 872_000, maxContextWindow: 400_000 }, "872000");
    expect(presetValues()).not.toContain("872000");
    expect(presetValues()).toContain("400000");
    expect(screen.getByRole("textbox")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("combobox")).toHaveValue("custom");
  });

  it("shows documentation references without using them to enlarge an account limit", () => {
    vi.mocked(getCodexOfficialContextDefault).mockReturnValue({
      model: "synthetic-official-model",
      contextWindow: 500_000,
      source: "Synthetic official source",
      sourceDate: "2026-10-21",
      documentationUrl: "https://example.invalid/official-default",
    });
    vi.mocked(getCodexOfficialModelSpec).mockReturnValue({
      modelId: "synthetic-official-model",
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      verifiedAt: "2026-10-21",
      documentationUrl: "https://example.invalid/api-spec",
    });
    const { rerender } = renderRow({ maxContextWindow: 400_000 });
    expect(presetValues()).not.toContain("500000");
    expect(presetValues()).not.toContain("1000000");
    expect(screen.getByText("500,000")).toBeInTheDocument();
    expect(screen.getByText("1,050,000")).toBeInTheDocument();
    expect(screen.getByText("128,000", { selector: "dd" })).toBeInTheDocument();
    expect(getCodexOfficialModelSpec).toHaveBeenCalledWith(
      "synthetic-official-model",
    );
    expect(
      screen.getAllByRole("link").map((link) => link.getAttribute("href")),
    ).toContain("https://example.invalid/api-spec");
    rerender(
      <CodexOfficialContextRow
        model="Visible model"
        upstreamModel="synthetic-official-model"
        value="1000000"
        discovered={{ ...discovered, maxContextWindow: undefined }}
        onChange={vi.fn()}
      />,
    );
    expect(presetValues()).not.toContain("1000000");
    expect(presetValues()).not.toContain("500000");
    expect(screen.getByRole("textbox")).toHaveAttribute("aria-invalid", "true");
  });

  it("does not duplicate a published default equal to the discovered maximum", () => {
    vi.mocked(getCodexOfficialContextDefault).mockReturnValue({
      model: "synthetic-official-model",
      contextWindow: 500_000,
      source: "Synthetic official source",
      sourceDate: "2026-10-21",
      documentationUrl: "https://example.invalid/official-default",
    });
    renderRow({ contextWindow: 500_000, maxContextWindow: 500_000 });
    expect(presetValues().filter((value) => value === "500000")).toHaveLength(
      1,
    );
  });

  it("does not duplicate a published default equal to a standard preset", () => {
    vi.mocked(getCodexOfficialContextDefault).mockReturnValue({
      model: "synthetic-official-model",
      contextWindow: 256_000,
      source: "Synthetic official source",
      sourceDate: "2026-10-21",
      documentationUrl: "https://example.invalid/official-default",
    });
    renderRow();
    expect(presetValues().filter((value) => value === "256000")).toHaveLength(
      1,
    );
  });

  it("uses explicit directory output metadata before a documentation reference", () => {
    vi.mocked(getCodexOfficialModelSpec).mockReturnValue({
      modelId: "synthetic-official-model",
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      verifiedAt: "2026-10-21",
      documentationUrl: "https://example.invalid/api-spec",
    });
    renderRow({ maxInputTokens: 300_000, maxOutputTokens: 64_000 });
    expect(screen.getByText("300,000")).toBeInTheDocument();
    expect(screen.getByText("64,000")).toBeInTheDocument();
    expect(
      screen.queryByText("128,000", { selector: "dd" }),
    ).not.toBeInTheDocument();
  });

  it("does not infer unknown input or output budgets from the context window", () => {
    renderRow();
    const row = screen.getByRole("group", { name: "Visible model" });
    expect(within(row).getByRole("textbox")).toHaveValue("");
    expect(
      within(row).queryByText("128,000", { selector: "dd" }),
    ).not.toBeInTheDocument();
    expect(within(row).queryByRole("link")).not.toBeInTheDocument();
  });

  it("allows clearing an override even when no account metadata is available", () => {
    const { onChange } = renderRow(
      { contextWindow: undefined, maxContextWindow: undefined },
      "700000",
    );
    expect(screen.getByRole("textbox")).toBeDisabled();
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "default" },
    });
    expect(onChange).toHaveBeenCalledWith("");
    expect(presetValues()).toEqual(["default", "custom"]);
  });

  it("rejects nonpositive, unsafe or excessive custom token counts", () => {
    const { rerender } = renderRow({}, "0");
    for (const value of ["0", "9007199254740993", "872001"]) {
      rerender(
        <CodexOfficialContextRow
          model="Visible model"
          value={value}
          discovered={discovered}
          onChange={vi.fn()}
        />,
      );
      expect(screen.getByRole("textbox")).toHaveAttribute(
        "aria-invalid",
        "true",
      );
    }
  });

  it("treats malformed discovery values as unknown rather than authorizing presets", () => {
    renderRow({
      contextWindow: -1,
      maxContextWindow: Number.POSITIVE_INFINITY,
      maxInputTokens: -3,
      maxOutputTokens: 0,
    });
    expect(presetValues()).toEqual(["default", "custom"]);
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.queryByText("-3")).not.toBeInTheDocument();
    expect(screen.queryByText("∞")).not.toBeInTheDocument();
  });
});
