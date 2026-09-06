import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { PagedModelList } from "@/components/providers/forms/shared/PagedModelList";

it("loads bounded editors and preserves original indices after filtering, paging and additions", async () => {
  const items = Array.from({ length: 431 }, (_, index) => `model-${index}`);
  const edit = vi.fn();
  const renderList = (models: string[]) => (
    <PagedModelList items={models} searchText={(model) => model}>
      {(model, index) => (
        <button key={model} onClick={() => edit(index)}>
          {model}
        </button>
      )}
    </PagedModelList>
  );
  const view = render(renderList(items));
  expect(screen.getByRole("status")).toBeInTheDocument();
  await screen.findByRole("button", { name: "model-0" });
  expect(screen.getAllByRole("button").length).toBe(22);
  fireEvent.click(screen.getByRole("button", { name: "opencode.nextModels" }));
  fireEvent.click(screen.getByRole("button", { name: "model-20" }));
  expect(edit).toHaveBeenLastCalledWith(20);
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "model-430" },
  });
  fireEvent.click(screen.getByRole("button", { name: "model-430" }));
  expect(edit).toHaveBeenLastCalledWith(430);
  view.rerender(renderList([...items, "new-model"]));
  fireEvent.click(screen.getByRole("button", { name: "new-model" }));
  expect(edit).toHaveBeenLastCalledWith(431);
  view.rerender(renderList(["remaining"]));
  expect(screen.getByRole("button", { name: "remaining" })).toBeInTheDocument();
});
