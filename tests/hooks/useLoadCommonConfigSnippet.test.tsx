import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLoadCommonConfigSnippet } from "@/components/providers/forms/hooks/useLoadCommonConfigSnippet";

const { get, save } = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/api", () => ({
  configApi: { getCommonConfigSnippet: get, setCommonConfigSnippet: save },
}));

describe("common config persistence loading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    get.mockResolvedValue("");
    save.mockResolvedValue(undefined);
  });

  it("prefers the database over legacy storage", async () => {
    get.mockResolvedValue("stored");
    localStorage.setItem("legacy", "old");
    const setSnippet = vi.fn();
    const setLoading = vi.fn();
    renderHook(() =>
      useLoadCommonConfigSnippet("codex", "legacy", setSnippet, setLoading),
    );
    await waitFor(() => expect(setLoading).toHaveBeenLastCalledWith(false));
    expect(setSnippet).toHaveBeenCalledWith("stored");
    expect(save).not.toHaveBeenCalled();
  });

  it("removes legacy storage only after persistence succeeds", async () => {
    localStorage.setItem("legacy", "old");
    let finish!: () => void;
    save.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const setSnippet = vi.fn();
    const setLoading = vi.fn();
    renderHook(() =>
      useLoadCommonConfigSnippet("claude", "legacy", setSnippet, setLoading),
    );
    await waitFor(() => expect(save).toHaveBeenCalledWith("claude", "old"));
    expect(localStorage.getItem("legacy")).toBe("old");
    await act(async () => finish());
    expect(localStorage.getItem("legacy")).toBeNull();
    expect(setSnippet).toHaveBeenCalledWith("old");
  });

  it("retains legacy data on failed migration", async () => {
    localStorage.setItem("legacy", "old");
    save.mockRejectedValue(new Error("save failed"));
    const setSnippet = vi.fn();
    const setLoading = vi.fn();
    renderHook(() =>
      useLoadCommonConfigSnippet("codex", "legacy", setSnippet, setLoading),
    );
    await waitFor(() => expect(setLoading).toHaveBeenLastCalledWith(false));
    expect(localStorage.getItem("legacy")).toBe("old");
    expect(setSnippet).not.toHaveBeenCalled();
  });

  it("keeps rejected Gemini legacy snippets out of persistence", async () => {
    localStorage.setItem("legacy", "invalid");
    const setSnippet = vi.fn();
    const setLoading = vi.fn();
    const validate = () => ({ error: "invalid" });
    renderHook(() =>
      useLoadCommonConfigSnippet(
        "gemini",
        "legacy",
        setSnippet,
        setLoading,
        true,
        validate,
      ),
    );
    await waitFor(() => expect(setLoading).toHaveBeenLastCalledWith(false));
    expect(save).not.toHaveBeenCalled();
    expect(setSnippet).not.toHaveBeenCalled();
    expect(localStorage.getItem("legacy")).toBe("invalid");
  });

  it("waits for enablement and ignores results after unmount", async () => {
    let finish!: (value: string) => void;
    get.mockReturnValue(
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
    );
    const setSnippet = vi.fn();
    const setLoading = vi.fn();
    const hook = renderHook(
      ({ enabled }) =>
        useLoadCommonConfigSnippet(
          "claude",
          "legacy",
          setSnippet,
          setLoading,
          enabled,
        ),
      { initialProps: { enabled: false } },
    );
    expect(get).not.toHaveBeenCalled();
    hook.rerender({ enabled: true });
    expect(get).toHaveBeenCalledOnce();
    hook.unmount();
    await act(async () => finish("late"));
    expect(setSnippet).not.toHaveBeenCalled();
  });
});
