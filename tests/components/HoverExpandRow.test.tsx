import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HoverExpandRow } from "@/components/providers/forms/shared/HoverExpandRow";

function hover(element: HTMLElement, pointerType = "mouse") {
  fireEvent(
    element,
    Object.assign(new Event("pointerover", { bubbles: true }), { pointerType }),
  );
}

afterEach(() => vi.useRealTimers());

describe("HoverExpandRow", () => {
  it("opens after a deliberate mouse hover and stays open on leave", () => {
    vi.useFakeTimers();
    const onExpand = vi.fn();
    render(<HoverExpandRow onExpand={onExpand}>Model</HoverExpandRow>);
    const row = screen.getByText("Model");
    hover(row);
    act(() => vi.advanceTimersByTime(299));
    expect(onExpand).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onExpand).toHaveBeenCalledTimes(1);
    fireEvent.pointerLeave(row);
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it("cancels pass-through hovers, manual clicks, and unmounted rows", () => {
    vi.useFakeTimers();
    const onExpand = vi.fn();
    const { unmount } = render(
      <HoverExpandRow onExpand={onExpand}>
        <button>Model</button>
      </HoverExpandRow>,
    );
    const row = screen.getByRole("button");
    hover(row);
    fireEvent.pointerLeave(row);
    act(() => vi.advanceTimersByTime(300));
    expect(onExpand).not.toHaveBeenCalled();
    hover(row);
    fireEvent.click(row);
    act(() => vi.advanceTimersByTime(300));
    expect(onExpand).not.toHaveBeenCalled();
    hover(row);
    unmount();
    act(() => vi.advanceTimersByTime(300));
    expect(onExpand).not.toHaveBeenCalled();
  });

  it("does not auto-expand for touch input", () => {
    vi.useFakeTimers();
    const onExpand = vi.fn();
    render(<HoverExpandRow onExpand={onExpand}>Model</HoverExpandRow>);
    hover(screen.getByText("Model"), "touch");
    act(() => vi.advanceTimersByTime(300));
    expect(onExpand).not.toHaveBeenCalled();
  });
});
