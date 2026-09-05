import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CodexCatalogViewport } from "@/components/providers/forms/CodexCatalogViewport";

describe("large catalog viewport", () => {
  it("reveals the full editor on hover and protects a focused editor", async () => {
    const items = ["first", "second"].map((model, index) => ({
      row: { rowId: model, model },
      index,
    }));
    render(
      <CodexCatalogViewport
        items={items}
        compact
        selected={new Set()}
        onSelect={vi.fn()}
      >
        {({ row }) => (
          <input aria-label={`editor-${row.model}`} defaultValue="128000" />
        )}
      </CodexCatalogViewport>,
    );
    const hover = (name: string) =>
      fireEvent(
        screen.getByText(name),
        Object.assign(new Event("pointerover", { bubbles: true }), {
          pointerType: "mouse",
        }),
      );
    hover("first");
    const input = await screen.findByLabelText("editor-first");
    expect(input).toHaveValue("128000");
    input.focus();
    hover("second");
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(input).toHaveFocus();
    expect(screen.queryByLabelText("editor-second")).not.toBeInTheDocument();
    input.blur();
    fireEvent.pointerLeave(screen.getByText("second"));
    hover("second");
    await waitFor(() =>
      expect(screen.getByLabelText("editor-second")).toBeVisible(),
    );
  });

  it("pages 431 models and expands a filtered result without a clipped scroll container", () => {
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
    fireEvent.click(
      screen.getByRole("button", { name: "opencode.nextModels" }),
    );
    expect(screen.queryByLabelText("editor-model-0")).not.toBeInTheDocument();
    expect(screen.getByText("model-10")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "opencode.previousModels" }),
    );
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
    expect(screen.getByText("text, file")).toBeInTheDocument();
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
    expect(
      screen.getByRole("button", { name: "opencode.nextModels" }),
    ).toBeDisabled();
  });
});
