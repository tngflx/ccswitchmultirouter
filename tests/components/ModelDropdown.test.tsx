import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModelDropdown } from "@/components/providers/forms/shared/ModelDropdown";

describe("ModelDropdown", () => {
  it("exposes a labelled search input and filters by vendor", async () => {
    const onSelect = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();

    render(
      <ModelDropdown
        models={[
          { id: "gpt-5", ownedBy: "openai" },
          { id: "claude-sonnet", ownedBy: "anthropic" },
        ]}
        onSelect={onSelect}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Select model" }));

    const searchInput = screen.getByRole("combobox", {
      name: "Search models...",
    });
    expect(searchInput).toBeInTheDocument();

    fireEvent.change(searchInput, { target: { value: "openai" } });

    await waitFor(() => {
      expect(screen.getByRole("option", { name: "gpt-5" })).toBeVisible();
      expect(
        screen.queryByRole("option", { name: "claude-sonnet" }),
      ).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("option", { name: "gpt-5" }));
    expect(onSelect).toHaveBeenCalledWith("gpt-5");
  });

  it("filters only confirmed free models without inferring from model ids", async () => {
    const models = [
      Object.freeze({
        id: "vendor/confirmed-free",
        ownedBy: "vendor",
        isFree: true,
      }),
      Object.freeze({
        id: "vendor/paid:free",
        ownedBy: "vendor",
        isFree: false,
      }),
      Object.freeze({
        id: "vendor/unknown:free",
        ownedBy: "vendor",
      }),
      Object.freeze({
        id: "vendor/null-price",
        ownedBy: "vendor",
        isFree: null,
      }),
    ];

    render(<ModelDropdown models={models} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Select model" }));

    const freeOption = screen.getByRole("option", {
      name: "vendor/confirmed-free Free",
    });
    expect(within(freeOption).getByText("Free", { exact: true })).toBeVisible();
    expect(screen.getAllByText("Free", { exact: true })).toHaveLength(1);
    expect(
      screen.getByRole("option", { name: "vendor/paid:free" }),
    ).toBeVisible();
    expect(
      screen.getByRole("option", { name: "vendor/unknown:free" }),
    ).toBeVisible();

    const freeOnly = screen.getByRole("checkbox", {
      name: "Free models only",
    });
    expect(freeOnly).not.toBeChecked();
    fireEvent.click(freeOnly);

    await waitFor(() => {
      expect(freeOnly).toBeChecked();
      expect(screen.getAllByRole("option")).toHaveLength(1);
      expect(
        screen.getByRole("option", { name: "vendor/confirmed-free Free" }),
      ).toBeVisible();
      expect(
        screen.queryByRole("option", { name: "vendor/paid:free" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("option", { name: "vendor/unknown:free" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("option", { name: "vendor/null-price" }),
      ).not.toBeInTheDocument();
    });

    fireEvent.click(freeOnly);
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(4));
    expect(models.map((model) => model.id)).toEqual([
      "vendor/confirmed-free",
      "vendor/paid:free",
      "vendor/unknown:free",
      "vendor/null-price",
    ]);
  });

  it("keeps model and vendor searches working with the free filter and selects the exact id", async () => {
    const onSelect = vi.fn();
    render(
      <ModelDropdown
        models={[
          { id: "vendor/alpha", ownedBy: "acme", isFree: true },
          { id: "vendor/beta", ownedBy: "other", isFree: true },
          { id: "vendor/paid", ownedBy: "acme", isFree: false },
        ]}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Select model" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Free models only" }));

    const searchInput = screen.getByRole("combobox", {
      name: "Search models...",
    });
    fireEvent.change(searchInput, { target: { value: "beta" } });
    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(1);
      expect(
        screen.getByRole("option", { name: "vendor/beta Free" }),
      ).toBeVisible();
    });

    fireEvent.change(searchInput, { target: { value: "acme" } });
    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(1);
      expect(
        screen.getByRole("option", { name: "vendor/alpha Free" }),
      ).toBeVisible();
      expect(
        screen.queryByRole("option", { name: "vendor/paid" }),
      ).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("option", { name: "vendor/alpha Free" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("vendor/alpha");
    expect(
      screen.queryByRole("combobox", { name: "Search models..." }),
    ).not.toBeInTheDocument();
  });

  it("does not show the free filter when pricing is unknown", () => {
    render(
      <ModelDropdown
        models={[
          { id: "vendor/unknown:free", ownedBy: "vendor" },
          { id: "vendor/unknown-null", ownedBy: "vendor", isFree: null },
        ]}
        onSelect={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Select model" }));

    expect(
      screen.queryByRole("checkbox", { name: "Free models only" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Free", { exact: true })).not.toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("explains when there are no confirmed free models", async () => {
    render(
      <ModelDropdown
        models={[
          { id: "vendor/paid", ownedBy: "vendor", isFree: false },
          { id: "vendor/unknown", ownedBy: "vendor", isFree: null },
        ]}
        onSelect={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Select model" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Free models only" }));

    await waitFor(() => {
      expect(screen.queryByRole("option")).not.toBeInTheDocument();
      expect(screen.getByText("No confirmed free models.")).toBeVisible();
    });
  });
});
