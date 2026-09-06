import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ModelDropdown } from "@/components/providers/forms/shared/ModelDropdown";
import { ModelInputWithFetch } from "@/components/providers/forms/shared/ModelInputWithFetch";

describe("ModelDropdown", () => {
  it("keeps a literal all model distinct from the clear-filter option", async () => {
    const onSelect = vi.fn();
    render(
      <ModelDropdown
        label="All models"
        models={[
          { id: "all", ownedBy: null },
          { id: "v:all", ownedBy: null },
        ]}
        getLabel={(id) => (id === "all" ? "All models" : id.slice(2))}
        onSelect={onSelect}
      />,
    );
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "All models" }));
    await userEvent
      .setup()
      .click(await screen.findByRole("option", { name: "all" }));
    expect(onSelect).toHaveBeenCalledWith("v:all");
  });
  it("does not build fetched model choices until the menu opens", async () => {
    const models = Array.from({ length: 430 }, (_, index) => ({
      id: `openrouter/model-${index + 1}`,
      ownedBy: "OpenRouter",
    }));

    const onSelect = vi.fn();
    render(<ModelDropdown models={models} onSelect={onSelect} />);

    expect(screen.queryByText("openrouter/model-430")).toBeNull();
    await userEvent.setup().click(screen.getByRole("button"));
    await screen.findByRole("combobox");
    expect(await screen.findAllByRole("option")).toHaveLength(20);
    expect(screen.queryByText("openrouter/model-430")).toBeNull();
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "model-430" },
    });
    await userEvent.setup().click(await screen.findByRole("option"));
    expect(onSelect).toHaveBeenCalledWith("openrouter/model-430");
  });

  it("shows refresh loading even when a previous catalog is cached", () => {
    render(
      <ModelInputWithFetch
        id="model"
        value="kept-model"
        onChange={vi.fn()}
        fetchedModels={[{ id: "cached", ownedBy: null }]}
        isLoading
      />,
    );
    expect(
      screen.getByRole("button", { name: "common.loading" }),
    ).toBeDisabled();
    expect(screen.getByDisplayValue("kept-model")).toBeInTheDocument();
  });
});
