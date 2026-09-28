import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  invalidateAutoModelRefresh,
  modelRefreshCredentialFingerprint,
  rememberModelRefreshSnapshot,
  useAutoModelRefresh,
} from "@/hooks/useAutoModelRefresh";

describe("useAutoModelRefresh", () => {
  beforeEach(() => {
    invalidateAutoModelRefresh();
    localStorage.clear();
  });

  it("deduplicates concurrent refreshes and reuses the fresh result", async () => {
    const fetcher = vi.fn().mockResolvedValue(["model-a"]);
    const firstSuccess = vi.fn();
    const secondSuccess = vi.fn();

    renderHook(() =>
      useAutoModelRefresh({
        cacheKey: "provider:model",
        enabled: true,
        fetcher,
        onSuccess: firstSuccess,
      }),
    );
    renderHook(() =>
      useAutoModelRefresh({
        cacheKey: "provider:model",
        enabled: true,
        fetcher,
        onSuccess: secondSuccess,
      }),
    );

    await waitFor(() =>
      expect(secondSuccess).toHaveBeenCalledWith(["model-a"]),
    );
    expect(firstSuccess).toHaveBeenCalledWith(["model-a"]);
    expect(fetcher).toHaveBeenCalledTimes(1);

    const cachedSuccess = vi.fn();
    renderHook(() =>
      useAutoModelRefresh({
        cacheKey: "provider:model",
        enabled: true,
        fetcher,
        onSuccess: cachedSuccess,
      }),
    );
    await waitFor(() =>
      expect(cachedSuccess).toHaveBeenCalledWith(["model-a"]),
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps failures silent and does not cache them", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(["model-b"]);

    const firstSuccess = vi.fn();
    const first = renderHook(() =>
      useAutoModelRefresh({
        cacheKey: "provider:retry",
        enabled: true,
        fetcher,
        onSuccess: firstSuccess,
      }),
    );
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(firstSuccess).not.toHaveBeenCalled();
    first.unmount();

    const secondSuccess = vi.fn();
    renderHook(() =>
      useAutoModelRefresh({
        cacheKey: "provider:retry",
        enabled: true,
        fetcher,
        onSuccess: secondSuccess,
      }),
    );
    await waitFor(() =>
      expect(secondSuccess).toHaveBeenCalledWith(["model-b"]),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not treat a cached result as a new upstream observation", async () => {
    const fetcher = vi.fn().mockResolvedValue([{ id: "model-new" }]);
    renderHook(() =>
      useAutoModelRefresh({
        cacheKey: "provider:cached-diff",
        enabled: true,
        fetcher,
        onSuccess: vi.fn(),
      }),
    );
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    const onDiff = vi.fn();
    const onSuccess = vi.fn();
    renderHook(() =>
      useAutoModelRefresh({
        cacheKey: "provider:cached-diff",
        enabled: true,
        fetcher,
        snapshotKey: "cached-diff",
        onDiff,
        onSuccess,
      }),
    );

    await waitFor(() =>
      expect(onSuccess).toHaveBeenCalledWith([{ id: "model-new" }]),
    );
    expect(onDiff).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reports membership changes while refreshing metadata silently", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce([
        { id: "kept", ownedBy: "old" },
        { id: "removed", ownedBy: "same" },
      ])
      .mockResolvedValueOnce([
        { id: "kept", ownedBy: "new" },
        { id: "added", ownedBy: "same" },
      ]);
    const firstDiff = vi.fn();
    const first = renderHook(() =>
      useAutoModelRefresh({
        cacheKey: "provider:snapshot",
        snapshotKey: "provider:snapshot",
        enabled: true,
        fetcher,
        onSuccess: vi.fn(),
        onDiff: firstDiff,
        ttlMs: 0,
      }),
    );
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(localStorage.getItem("model-catalog:provider:snapshot")).toContain(
        "removed",
      ),
    );
    expect(firstDiff).not.toHaveBeenCalled();
    first.unmount();

    const secondDiff = vi.fn();
    renderHook(() =>
      useAutoModelRefresh({
        cacheKey: "provider:snapshot",
        snapshotKey: "provider:snapshot",
        enabled: true,
        fetcher,
        onSuccess: vi.fn(),
        onDiff: secondDiff,
        ttlMs: 0,
      }),
    );
    await waitFor(() =>
      expect(secondDiff).toHaveBeenCalledWith(["added"], ["removed"], []),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not notify for metadata-only changes", async () => {
    localStorage.setItem(
      "model-catalog:metadata-only",
      JSON.stringify([{ id: "kept", contextWindow: 128 }]),
    );
    const onDiff = vi.fn();
    const onSuccess = vi.fn();
    renderHook(() =>
      useAutoModelRefresh({
        cacheKey: "provider:metadata-only",
        snapshotKey: "metadata-only",
        enabled: true,
        fetcher: () => Promise.resolve([{ id: "kept", contextWindow: 256 }]),
        onSuccess,
        onDiff,
        ttlMs: 0,
      }),
    );

    await waitFor(() =>
      expect(onSuccess).toHaveBeenCalledWith([
        { id: "kept", contextWindow: 256 },
      ]),
    );
    expect(onDiff).not.toHaveBeenCalled();
    expect(localStorage.getItem("model-catalog:metadata-only")).toContain(
      "256",
    );
  });

  it("uses the first successful fetch as a silent baseline", async () => {
    const onDiff = vi.fn();
    renderHook(() =>
      useAutoModelRefresh({
        cacheKey: "provider:catalog-first",
        snapshotKey: "catalog-first",
        enabled: true,
        fetcher: () => Promise.resolve([{ id: "saved" }, { id: "new" }]),
        onSuccess: vi.fn(),
        onDiff,
        ttlMs: 0,
      }),
    );
    await waitFor(() =>
      expect(localStorage.getItem("model-catalog:catalog-first")).toContain(
        '"new"',
      ),
    );
    expect(onDiff).not.toHaveBeenCalled();
  });

  it("does not notify on repeated identical fetches", async () => {
    const fetcher = vi.fn().mockResolvedValue([{ id: "remote-only" }]);
    const first = renderHook(() =>
      useAutoModelRefresh({
        cacheKey: "provider:repeat",
        snapshotKey: "repeat",
        enabled: true,
        fetcher,
        onSuccess: vi.fn(),
        onDiff: vi.fn(),
        ttlMs: 0,
      }),
    );
    await waitFor(() =>
      expect(localStorage.getItem("model-catalog:repeat")).toContain(
        "remote-only",
      ),
    );
    first.unmount();

    const onDiff = vi.fn();
    renderHook(() =>
      useAutoModelRefresh({
        cacheKey: "provider:repeat",
        snapshotKey: "repeat",
        enabled: true,
        fetcher,
        onSuccess: vi.fn(),
        onDiff,
        ttlMs: 0,
      }),
    );
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(onDiff).not.toHaveBeenCalled();
  });

  it("lets a manual fetch advance the comparison baseline", async () => {
    rememberModelRefreshSnapshot("manual", [{ id: "old" }]);
    rememberModelRefreshSnapshot("manual", [{ id: "new" }]);
    const onDiff = vi.fn();
    const onSuccess = vi.fn();
    renderHook(() =>
      useAutoModelRefresh({
        cacheKey: "provider:manual",
        snapshotKey: "manual",
        enabled: true,
        fetcher: () => Promise.resolve([{ id: "new" }]),
        onSuccess,
        onDiff,
        ttlMs: 0,
      }),
    );
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(onDiff).not.toHaveBeenCalled();
  });

  it("does not replace a good snapshot or report removals for an empty response", async () => {
    localStorage.setItem(
      "model-catalog:empty",
      JSON.stringify([{ id: "saved" }]),
    );
    const onDiff = vi.fn();
    const onSuccess = vi.fn();
    renderHook(() =>
      useAutoModelRefresh({
        cacheKey: "provider:empty",
        snapshotKey: "empty",
        enabled: true,
        fetcher: () => Promise.resolve([]),
        onSuccess,
        onDiff,
        ttlMs: 0,
      }),
    );
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith([]));
    expect(onDiff).not.toHaveBeenCalled();
    expect(localStorage.getItem("model-catalog:empty")).toBe(
      '[{"id":"saved"}]',
    );
  });

  it("reports a prior upstream removal even when it was never saved", async () => {
    localStorage.setItem(
      "model-catalog:overlap",
      JSON.stringify([
        { id: "gpt-5.6-sol", contextWindow: 1 },
        { id: "gpt-6-luna", contextWindow: 1 },
      ]),
    );
    const onDiff = vi.fn();
    renderHook(() =>
      useAutoModelRefresh({
        cacheKey: "provider:overlap",
        snapshotKey: "overlap",
        enabled: true,
        fetcher: () =>
          Promise.resolve([{ id: "gpt-5.6-sol", contextWindow: 2 }]),
        onSuccess: vi.fn(),
        onDiff,
        ttlMs: 0,
      }),
    );

    await waitFor(() => expect(onDiff).toHaveBeenCalled());
    const [, removed, updated] = onDiff.mock.calls[0];
    expect(removed).toContain("gpt-6-luna");
    expect(updated).not.toContain("gpt-6-luna");
  });

  it("reports upstream churn only once, independently of saved selections", async () => {
    // The previous fetch offered thirteen models the catalog never saved.
    localStorage.setItem(
      "model-catalog:churn",
      JSON.stringify([
        { id: "gpt-5.2" },
        { id: "gpt-5.3-codex-spark" },
        { id: "gpt-5.4" },
        { id: "gpt-5.4-mini" },
        { id: "gpt-5.6" },
        { id: "gpt-5.6-luna" },
        { id: "gpt-6-luna" },
        { id: "gpt-5.6-sol" },
        { id: "gpt-image-1.5" },
        { id: "gpt-image-2" },
        { id: "gpt-image-2.5-flare" },
        { id: "gpt-image-2.5-sunburst" },
        { id: "gpt-reserve" },
      ]),
    );
    const onDiff = vi.fn();
    renderHook(() =>
      useAutoModelRefresh({
        cacheKey: "provider:churn",
        snapshotKey: "churn",
        enabled: true,
        fetcher: () =>
          Promise.resolve([{ id: "gpt-5.6-sol" }, { id: "gpt-reserve" }]),
        onSuccess: vi.fn(),
        onDiff,
        ttlMs: 0,
      }),
    );

    await waitFor(() => expect(onDiff).toHaveBeenCalled());
    const [added, removed] = onDiff.mock.calls[0];
    expect(removed).toHaveLength(11);
    expect(removed).not.toContain("gpt-6-astra");
    expect(added).toEqual([]);
  });

  it("compares metadata by id rather than array position", async () => {
    localStorage.setItem(
      "model-catalog:reorder",
      JSON.stringify([
        { id: "first", contextWindow: 1 },
        { id: "second", contextWindow: 2 },
      ]),
    );
    const onDiff = vi.fn();
    const fetcher = vi.fn().mockResolvedValue([
      { id: "second", contextWindow: 2 },
      { id: "first", contextWindow: 1 },
    ]);
    renderHook(() =>
      useAutoModelRefresh({
        cacheKey: "provider:reorder",
        snapshotKey: "reorder",
        enabled: true,
        // Same models, reversed order, no metadata change at all.
        fetcher,
        onSuccess: vi.fn(),
        onDiff,
        ttlMs: 0,
      }),
    );

    // Reordering the remote list changes nothing, so there is no diff to
    // report at all. Index-based pairing used to report every model as
    // "updated" here.
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onDiff).not.toHaveBeenCalled();
  });

  it("ignores metadata key and modality ordering changes", async () => {
    localStorage.setItem(
      "model-catalog:metadata-order",
      JSON.stringify([
        {
          id: "same",
          ownedBy: "provider",
          inputModalities: ["text", "image"],
        },
      ]),
    );
    const onDiff = vi.fn();
    renderHook(() =>
      useAutoModelRefresh({
        cacheKey: "provider:metadata-order",
        snapshotKey: "metadata-order",
        enabled: true,
        fetcher: () =>
          Promise.resolve([
            {
              inputModalities: ["image", "text"],
              ownedBy: "provider",
              id: "same",
            },
          ]),
        onSuccess: vi.fn(),
        onDiff,
        ttlMs: 0,
      }),
    );

    await waitFor(() =>
      expect(localStorage.getItem("model-catalog:metadata-order")).toContain(
        '"same"',
      ),
    );
    expect(onDiff).not.toHaveBeenCalled();
  });

  it("changes the credential identity without exposing the credential", () => {
    const first = modelRefreshCredentialFingerprint("sk-first-secret");
    const second = modelRefreshCredentialFingerprint("sk-second-secret");
    expect(first).not.toBe(second);
    expect(first).not.toContain("secret");
  });

  it("does not apply an automatic result invalidated by a manual refresh", async () => {
    let resolveFetch: (value: string[]) => void = () => undefined;
    const fetcher = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const onSuccess = vi.fn();
    renderHook(() =>
      useAutoModelRefresh({
        cacheKey: "provider:manual-wins",
        enabled: true,
        fetcher,
        onSuccess,
      }),
    );
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    invalidateAutoModelRefresh();
    resolveFetch(["stale-model"]);
    await Promise.resolve();
    await Promise.resolve();

    expect(onSuccess).not.toHaveBeenCalled();
  });
});
