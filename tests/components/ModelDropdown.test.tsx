import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ModelDropdown } from "@/components/providers/forms/shared/ModelDropdown";

describe("ModelDropdown", () => {
  it("does not build fetched model choices until the menu opens", async () => {
    const models = Array.from({ length: 430 }, (_, index) => ({
      id: `openrouter/model-${index + 1}`,
      ownedBy: "OpenRouter",
    }));

    render(<ModelDropdown models={models} onSelect={vi.fn()} />);

    expect(screen.queryByText("openrouter/model-430")).toBeNull();
    await userEvent.setup().click(screen.getByRole("button"));
    expect(screen.getByText("openrouter/model-430")).toBeInTheDocument();
  });
});
