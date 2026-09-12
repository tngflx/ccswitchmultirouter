import type { ReactNode } from "react";
import { act, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import {
  DeferredContent,
  DeferredRender,
} from "@/components/common/DeferredContent";
import { GlobalLoadingProvider } from "@/contexts/GlobalLoadingContext";

function renderWithGlobalLoading(children: ReactNode) {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <GlobalLoadingProvider delayMs={0}>{children}</GlobalLoadingProvider>
    </QueryClientProvider>,
  );
}

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

it.each([
  ["content", (child: ReactNode) => <DeferredContent>{child}</DeferredContent>],
  ["render", (child: ReactNode) => <DeferredRender render={() => child} />],
])(
  "clears global loading when deferred %s becomes ready",
  async (_name, deferred) => {
    vi.useFakeTimers();
    try {
      renderWithGlobalLoading(deferred(<div>Editor</div>));

      await act(async () => vi.advanceTimersByTime(0));
      expect(screen.getAllByRole("status")).toHaveLength(2);

      await act(async () => vi.runAllTimers());
      expect(screen.getByText("Editor")).toBeInTheDocument();
      expect(screen.queryByRole("status")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  },
);

it("uses a bounded fallback when animation frames are suspended", async () => {
  vi.useFakeTimers();
  const requestFrame = vi
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation(() => 1);
  const cancelFrame = vi
    .spyOn(window, "cancelAnimationFrame")
    .mockImplementation(() => {});
  try {
    render(
      <DeferredContent>
        <div>Editor</div>
      </DeferredContent>,
    );
    expect(screen.getByRole("status")).toBeInTheDocument();

    await act(async () => vi.advanceTimersByTime(100));
    await act(async () => vi.runAllTimers());

    expect(screen.getByText("Editor")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  } finally {
    requestFrame.mockRestore();
    cancelFrame.mockRestore();
    vi.useRealTimers();
  }
});
