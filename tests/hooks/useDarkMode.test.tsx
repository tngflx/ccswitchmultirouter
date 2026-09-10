import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useDarkMode } from "@/hooks/useDarkMode";

it("reads the initial theme, follows class changes, and disconnects on unmount", async () => {
  document.documentElement.classList.add("dark");
  const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
  const { result, unmount } = renderHook(useDarkMode);
  expect(result.current).toBe(true);
  await act(async () => {
    document.documentElement.classList.remove("dark");
  });
  await waitFor(() => expect(result.current).toBe(false));
  unmount();
  expect(disconnect).toHaveBeenCalled();
  disconnect.mockRestore();
});
