import { act, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { DeferredContent } from "@/components/common/DeferredContent";

it("commits loading before invoking an expensive child and cancels unmounted work", async () => {
  vi.useFakeTimers();
  try {
    const child = vi.fn(() => <div>Editor</div>);
    const Child = child;
    const view = render(
      <DeferredContent>
        <Child />
      </DeferredContent>,
    );
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(child).not.toHaveBeenCalled();
    await act(async () => vi.runAllTimers());
    expect(screen.getByText("Editor")).toBeInTheDocument();
    view.unmount();
    child.mockClear();
    const cancelled = render(
      <DeferredContent>
        <Child />
      </DeferredContent>,
    );
    cancelled.unmount();
    await act(async () => vi.runAllTimers());
    expect(child).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
