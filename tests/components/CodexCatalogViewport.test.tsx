import {
  fireEvent,
  render as renderUI,
  screen,
  within,
} from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import userEvent from "@testing-library/user-event";
import type { CodexCatalogModel } from "@/types";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { CodexCatalogViewport } from "@/components/providers/forms/CodexCatalogViewport";
import { createLocalizedTestI18n } from "../utils/localizedTestI18n";

let i18n: Awaited<ReturnType<typeof createLocalizedTestI18n>>;
beforeAll(async () => {
  i18n = await createLocalizedTestI18n();
});
function render(node: ReactNode) {
  return renderUI(node, {
    wrapper: ({ children }) => (
      <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
    ),
  });
}

describe("large catalog viewport", () => {
  it.each([true, false])(
    "keeps selection actions after the model rows when compact=%s",
    async (compact) => {
      const user = userEvent.setup();
      const onUseOnlySelected = vi.fn();
      const rows = [
        { rowId: "first", model: "first" },
        { rowId: "last", model: "last", enabled: false },
      ];
      render(
        <CodexCatalogViewport
          items={rows.map((row, index) => ({ row, index }))}
          compact={compact}
          selected={new Set(["last"])}
          onSelect={vi.fn()}
          onToggleEnabled={vi.fn()}
          onUseOnlySelected={onUseOnlySelected}
        >
          {({ row }) => <span>{`editor-${row.model}`}</span>}
        </CodexCatalogViewport>,
      );
      const toolbar = screen.getByRole("group", {
        name: "Model selection actions",
      });
      const lastRow = screen.getByRole("checkbox", { name: "Select last" });
      expect(
        lastRow.compareDocumentPosition(toolbar) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(toolbar).toHaveClass("sticky", "bottom-0");
      expect(
        within(toolbar).getByRole("checkbox", { name: "Select matching" }),
      ).toBeEnabled();
      expect(
        within(toolbar).getByRole("button", { name: "Include selected" }),
      ).toBeEnabled();
      expect(
        within(toolbar).getByRole("button", { name: "Exclude selected" }),
      ).toBeEnabled();
      expect(
        within(toolbar).queryByRole("button", { name: "Include matching" }),
      ).not.toBeInTheDocument();
      expect(
        within(toolbar).queryByRole("button", { name: "Exclude matching" }),
      ).not.toBeInTheDocument();
      await user.click(
        within(toolbar).getByRole("button", { name: "Catalogue actions" }),
      );
      await user.click(
        screen.getByRole("menuitem", { name: "Use only selected" }),
      );
      expect(onUseOnlySelected).toHaveBeenCalledWith(["last"]);
    },
  );

  it("does not add an inclusion toolbar to generic or selection-free viewports", () => {
    const props = {
      items: [{ row: { rowId: "first", model: "first" }, index: 0 }],
      compact: true,
      selected: new Set<string>(),
      onSelect: vi.fn(),
      children: () => <span key="editor">editor</span>,
    };
    const { rerender } = render(<CodexCatalogViewport {...props} />);
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
    rerender(
      <CodexCatalogViewport
        {...props}
        showSelection={false}
        onToggleEnabled={vi.fn()}
      />,
    );
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
    expect(screen.getByRole("searchbox")).toBeVisible();
  });

  it("keeps latest versions visible and leaves removal in catalogue actions", async () => {
    const user = userEvent.setup();
    const onPruneOutdated = vi.fn();
    const onRemoveSelected = vi.fn();
    render(
      <CodexCatalogViewport
        items={[
          { row: { rowId: "old", model: "glm-4" }, index: 0 },
          { row: { rowId: "new", model: "glm-5" }, index: 1 },
        ]}
        compact
        selected={new Set(["old"])}
        onSelect={vi.fn()}
        onToggleEnabled={vi.fn()}
        onPruneOutdated={onPruneOutdated}
        onRemoveSelected={onRemoveSelected}
      >
        {({ row }) => <span>{row.model}</span>}
      </CodexCatalogViewport>,
    );

    const toolbar = screen.getByRole("group", {
      name: "Model selection actions",
    });
    await user.click(
      within(toolbar).getByRole("button", { name: "Keep latest versions" }),
    );
    expect(onPruneOutdated).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("menuitem", { name: "Keep latest versions" }),
    ).not.toBeInTheDocument();

    await user.click(
      within(toolbar).getByRole("button", { name: "Catalogue actions" }),
    );
    await user.click(
      screen.getByRole("menuitem", { name: "Remove selected models" }),
    );
    expect(onRemoveSelected).toHaveBeenCalledWith(["old"]);
  });

  it("opens only on explicit activation and keeps Include clickable", () => {
    const items = ["first", "second"].map((model, index) => ({
      row: { rowId: model, model },
      index,
    }));
    const onToggleEnabled = vi.fn();
    render(
      <CodexCatalogViewport
        items={items}
        compact
        selected={new Set()}
        onSelect={vi.fn()}
        onToggleEnabled={onToggleEnabled}
      >
        {({ row }) => (
          <input aria-label={`editor-${row.model}`} defaultValue="128000" />
        )}
      </CodexCatalogViewport>,
    );
    expect(screen.queryByLabelText("editor-first")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Include first" }));
    expect(onToggleEnabled).toHaveBeenCalledWith("first", false);
    expect(screen.queryByLabelText("editor-first")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit first" }));
    expect(screen.getByLabelText("editor-first")).toHaveValue("128000");
    fireEvent.click(screen.getByRole("button", { name: "Edit second" }));
    expect(screen.getByLabelText("editor-second")).toBeVisible();
    expect(screen.queryByLabelText("editor-first")).not.toBeInTheDocument();
  });

  it("pages 431 models and reveals a stable row after reordering", () => {
    const items = Array.from({ length: 431 }, (_, index) => ({
      index,
      row: {
        rowId: `row-${index}`,
        model: `model-${index}`,
        inputModalities: ["text", "file"],
      },
    }));
    const onSelect = vi.fn();
    const editor = ({ row }: (typeof items)[number]) => (
      <input aria-label={`editor-${row.model}`} defaultValue={row.model} />
    );
    const { rerender } = render(
      <CodexCatalogViewport
        items={items}
        compact
        selected={new Set(["row-430"])}
        onSelect={onSelect}
      >
        {editor}
      </CodexCatalogViewport>,
    );
    expect(screen.getAllByRole("checkbox")).toHaveLength(10);
    expect(screen.queryByLabelText("editor-model-0")).not.toBeInTheDocument();
    fireEvent.click(document.querySelector('button[aria-expanded="false"]')!);
    expect(screen.getByLabelText("editor-model-0")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next models" }));
    expect(screen.queryByLabelText("editor-model-0")).not.toBeInTheDocument();
    expect(screen.getByText("model-10")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Previous models" }));
    expect(screen.getByLabelText("editor-model-0")).toBeInTheDocument();
    rerender(
      <CodexCatalogViewport
        items={[items[430]]}
        compact
        selected={new Set(["row-430"])}
        onSelect={onSelect}
      >
        {editor}
      </CodexCatalogViewport>,
    );
    expect(screen.getByRole("checkbox")).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onSelect).toHaveBeenCalledWith("row-430", false);
    expect(screen.getAllByText("text, file")).toHaveLength(2);
    fireEvent.click(document.querySelector('button[aria-expanded="false"]')!);
    const input = screen.getByLabelText("editor-model-430");
    expect(input).toBeVisible();
    expect(input.closest('[style*="height"]')).toBeNull();
    expect(input.closest(".overflow-auto")).toBeNull();
    fireEvent.click(document.querySelector('button[aria-expanded="true"]')!);
    expect(screen.queryByLabelText("editor-model-430")).not.toBeInTheDocument();
    rerender(
      <CodexCatalogViewport
        items={items}
        compact
        selected={new Set()}
        onSelect={onSelect}
        revealRowId="row-430"
      >
        {editor}
      </CodexCatalogViewport>,
    );
    expect(screen.getByLabelText("editor-model-430")).toBeVisible();
    expect(screen.getByRole("button", { name: "Next models" })).toBeDisabled();
  });

  it("searches identities, aliases and display names without losing editor indices", () => {
    const items: {
      row: CodexCatalogModel & { rowId: string };
      index: number;
    }[] = [
      { row: { rowId: "hidden", model: "unused", enabled: false }, index: 0 },
      {
        row: {
          rowId: "matching",
          model: "visible-coder",
          upstreamModel: "wire-coder",
          displayName: "Fast Model",
          aliases: ["coding-alias"],
        },
        index: 17,
      },
    ];
    render(
      <CodexCatalogViewport
        items={items}
        compact={false}
        selected={new Set()}
        onSelect={vi.fn()}
        onToggleEnabled={vi.fn()}
      >
        {({ row, index }) => <span>{`editor-${row.model}-${index}`}</span>}
      </CodexCatalogViewport>,
    );
    for (const search of [
      "VISIBLE-CODER",
      "wire-coder",
      "coding-alias",
      "FAST model",
    ]) {
      fireEvent.change(
        screen.getByRole("searchbox", { name: "Search models" }),
        {
          target: { value: search },
        },
      );
      expect(screen.getByText("editor-visible-coder-17")).toBeVisible();
      expect(screen.queryByText("editor-unused-0")).not.toBeInTheDocument();
      expect(screen.getByText("1 matching models")).toBeVisible();
    }
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "absent" },
    });
    expect(screen.getByText("No matching models")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Include selected" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Exclude selected" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByText("editor-unused-0")).toBeVisible();
  });

  it("filters inclusion, resets paging and applies selected matches across all pages", () => {
    const initialRows = Array.from({ length: 31 }, (_, index) => ({
      rowId: `row-${index}`,
      model: `${index < 25 ? "coder" : "other"}-${index}`,
      enabled: index === 30,
    }));
    const onSetIncluded = vi.fn();
    const onToggleEnabled = vi.fn();
    function Harness() {
      const [rows, setRows] = useState(initialRows);
      const [selected, setSelected] = useState(new Set<string>());
      return (
        <CodexCatalogViewport
          items={rows.map((row, index) => ({ row, index }))}
          compact
          selected={selected}
          onSelect={(id, checked) =>
            setSelected((current) => {
              const next = new Set(current);
              if (checked) next.add(id);
              else next.delete(id);
              return next;
            })
          }
          onSelectionChange={setSelected}
          onToggleEnabled={onToggleEnabled}
          onSetIncluded={(ids, enabled) => {
            onSetIncluded(ids, enabled);
            setRows((current) =>
              current.map((row) =>
                ids.includes(row.rowId) ? { ...row, enabled } : row,
              ),
            );
          }}
        >
          {({ row }) => <span>{row.model}</span>}
        </CodexCatalogViewport>
      );
    }
    render(<Harness />);
    expect(screen.getByRole("tab", { name: "All 31" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "Included 1" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "Excluded 30" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Next models" }));
    expect(screen.getByText("coder-10")).toBeVisible();
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "coder" },
    });
    expect(screen.getByText("coder-0")).toBeVisible();
    expect(screen.getByText("25 matching models")).toBeVisible();
    expect(screen.getAllByRole("switch")).toHaveLength(10);
    const toolbar = screen.getByRole("group", {
      name: "Model selection actions",
    });
    fireEvent.click(
      within(toolbar).getByRole("checkbox", { name: "Select matching" }),
    );
    fireEvent.click(
      within(toolbar).getByRole("button", { name: "Include selected" }),
    );
    expect(onSetIncluded).toHaveBeenLastCalledWith(
      initialRows.slice(0, 25).map((row) => row.rowId),
      true,
    );
    expect(onToggleEnabled).not.toHaveBeenCalled();
    expect(screen.getByRole("tab", { name: "Included 26" })).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "Excluded 5" }));
    expect(screen.getByText("No matching models")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getAllByRole("switch")).toHaveLength(5);
    expect(screen.getByText("other-25")).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "Included 26" }));
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "coder" },
    });
    fireEvent.click(
      within(toolbar).getByRole("checkbox", { name: "Select matching" }),
    );
    fireEvent.click(
      within(toolbar).getByRole("button", { name: "Exclude selected" }),
    );
    expect(onSetIncluded).toHaveBeenLastCalledWith(
      initialRows.slice(0, 25).map((row) => row.rowId),
      false,
    );
    expect(screen.getByRole("tab", { name: "Included 1" })).toBeVisible();
    expect(screen.getByText("No matching models")).toBeVisible();
  });

  it("allows new searches after revealing a row and clears filters for the next reveal", () => {
    const items = Array.from({ length: 31 }, (_, index) => ({
      row: {
        rowId: `row-${index}`,
        model: `model-${index}`,
        enabled: index !== 30,
      },
      index,
    }));
    const props = {
      items,
      compact: true,
      selected: new Set<string>(),
      onSelect: vi.fn(),
      onToggleEnabled: vi.fn(),
      children: ({ row }: (typeof items)[number]) => (
        <span>{`editor-${row.model}`}</span>
      ),
    };
    const { rerender } = render(
      <CodexCatalogViewport {...props} revealRowId="row-30" />,
    );
    expect(screen.getByText("editor-model-30")).toBeVisible();
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "model-1" },
    });
    expect(screen.getByRole("searchbox")).toHaveValue("model-1");
    expect(screen.getByText("model-1")).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "Included 30" }));
    expect(screen.getByRole("tab", { name: "Included 30" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    rerender(<CodexCatalogViewport {...props} revealRowId="row-20" />);
    expect(screen.getByRole("searchbox")).toHaveValue("");
    expect(screen.getByRole("tab", { name: "All 31" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("editor-model-20")).toBeVisible();
  });

  it("supports individual-toggle bulk fallback and treats legacy rows as included", () => {
    const onToggleEnabled = vi.fn();
    const rows: (CodexCatalogModel & { rowId: string })[] = [
      { rowId: "legacy", model: "legacy" },
      { rowId: "excluded", model: "excluded", enabled: false },
    ];
    function Harness() {
      const [selected, setSelected] = useState(new Set<string>());
      return (
        <CodexCatalogViewport
          items={rows.map((row, index) => ({ row, index }))}
          compact
          selected={selected}
          onSelect={(id, checked) =>
            setSelected((current) => {
              const next = new Set(current);
              if (checked) next.add(id);
              else next.delete(id);
              return next;
            })
          }
          onSelectionChange={setSelected}
          onToggleEnabled={onToggleEnabled}
        >
          {({ row }) => <span>{row.model}</span>}
        </CodexCatalogViewport>
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select excluded" }));
    fireEvent.click(screen.getByRole("button", { name: "Include selected" }));
    expect(onToggleEnabled).toHaveBeenCalledTimes(1);
    expect(onToggleEnabled).toHaveBeenCalledWith("excluded", true);
    onToggleEnabled.mockClear();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select legacy" }));
    fireEvent.click(screen.getByRole("button", { name: "Exclude selected" }));
    expect(onToggleEnabled).toHaveBeenCalledTimes(1);
    expect(onToggleEnabled).toHaveBeenCalledWith("legacy", false);
  });

  it("stages matching selections across pages and filters without changing inclusion", async () => {
    const user = userEvent.setup();
    const rows = Array.from({ length: 31 }, (_, index) => ({
      rowId: `row-${index}`,
      model: `${index < 25 ? "coder" : "other"}-${index}`,
      enabled: index === 30,
    }));
    const onSetIncluded = vi.fn();
    function Harness() {
      const [selected, setSelected] = useState(new Set<string>());
      return (
        <CodexCatalogViewport
          items={rows.map((row, index) => ({ row, index }))}
          compact
          selected={selected}
          onSelect={(id, checked) =>
            setSelected((current) => {
              const next = new Set(current);
              if (checked) next.add(id);
              else next.delete(id);
              return next;
            })
          }
          onSelectionChange={setSelected}
          onToggleEnabled={vi.fn()}
          onSetIncluded={onSetIncluded}
        >
          {({ row }) => <span>{`editor-${row.model}`}</span>}
        </CodexCatalogViewport>
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select coder-0" }));
    expect(
      screen.getByRole("switch", { name: "Include coder-0" }),
    ).not.toBeChecked();
    expect(screen.getByText("1 selected")).toBeVisible();
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "other" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select matching" }));
    expect(screen.getByText("7 selected")).toBeVisible();
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "coder" },
    });
    expect(
      screen.getByRole("checkbox", { name: "Select matching" }),
    ).toHaveAttribute("aria-checked", "mixed");
    fireEvent.click(screen.getByRole("button", { name: "Next models" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select coder-10" }));
    expect(screen.getByText("8 selected")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Catalogue actions" }));
    await user.click(
      screen.getByRole("menuitem", { name: "Invert matching selection" }),
    );
    expect(screen.getByText("29 selected")).toBeVisible();
    expect(onSetIncluded).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.getByText("0 selected")).toBeVisible();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select matching" }));
    expect(screen.getByText("25 selected")).toBeVisible();
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "other" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Include selected" }));
    expect(onSetIncluded).toHaveBeenLastCalledWith(
      rows.slice(0, 25).map((row) => row.rowId),
      true,
    );
    expect(screen.getByText("0 selected")).toBeVisible();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select other-25" }));
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "coder" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Exclude selected" }));
    expect(onSetIncluded).toHaveBeenLastCalledWith(["row-25"], false);
    expect(screen.getByText("0 selected")).toBeVisible();
  });

  it("filters capabilities and sorts without rewriting original editor indices", () => {
    const rows: (CodexCatalogModel & { rowId: string })[] = [
      {
        rowId: "z",
        model: "zebra",
        inputModalities: ["text"],
        contextWindow: 128000,
      },
      {
        rowId: "a",
        model: "alpha",
        inputModalities: ["text", "image"],
        context_window: 256000,
      },
      { rowId: "b", model: "beta" },
    ];
    const visible = vi.fn();
    render(
      <CodexCatalogViewport
        items={rows.map((row, index) => ({ row, index }))}
        compact={false}
        selected={new Set(["z"])}
        onSelect={vi.fn()}
        onToggleEnabled={vi.fn()}
        onVisibleItemsChange={visible}
      >
        {({ row, index }) => <span>{`editor-${row.model}-${index}`}</span>}
      </CodexCatalogViewport>,
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Sort" }), {
      target: { value: "name" },
    });
    expect(
      visible.mock.lastCall![0].map(({ index }: { index: number }) => index),
    ).toEqual([1, 2, 0]);
    expect(
      screen.getByRole("checkbox", { name: "Select zebra" }),
    ).toBeChecked();
    fireEvent.change(screen.getByRole("combobox", { name: "Sort" }), {
      target: { value: "context" },
    });
    expect(
      visible.mock.lastCall![0].map(({ index }: { index: number }) => index),
    ).toEqual([1, 0, 2]);
    for (const [capability, model, index] of [
      ["text_only", "zebra", 0],
      ["text_image", "alpha", 1],
      ["unknown", "beta", 2],
    ]) {
      fireEvent.change(screen.getByRole("combobox", { name: "Input" }), {
        target: { value: capability },
      });
      expect(screen.getByText(`editor-${model}-${index}`)).toBeVisible();
      expect(visible.mock.lastCall![0]).toHaveLength(1);
    }
    fireEvent.change(screen.getByRole("combobox", { name: "Input" }), {
      target: { value: "all" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Sort" }), {
      target: { value: "order" },
    });
    expect(
      visible.mock.lastCall![0].map(({ index }: { index: number }) => index),
    ).toEqual([0, 1, 2]);
    expect(rows.map((row) => row.model)).toEqual(["zebra", "alpha", "beta"]);
  });
});
