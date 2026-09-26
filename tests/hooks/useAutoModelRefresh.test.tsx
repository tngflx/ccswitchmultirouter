import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  invalidateAutoModelRefresh,
  modelRefreshCredentialFingerprint,
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

  it("reports model diffs when a fresh cached result is reused", async () => {
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
        compareIds: ["model-old"],
        onDiff,
        onSuccess,
      }),
    );

    await waitFor(() =>
      expect(onSuccess).toHaveBeenCalledWith([{ id: "model-new" }]),
    );
    expect(onDiff).toHaveBeenCalledWith([], ["model-old"], []);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("compares later fetches with the complete prior catalog, including metadata", async () => {
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
        compareIds: ["kept", "removed"],
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
        compareIds: ["kept", "removed"],
        onSuccess: vi.fn(),
        onDiff: secondDiff,
        ttlMs: 0,
      }),
    );
    await waitFor(() =>
      expect(secondDiff).toHaveBeenCalledWith(["added"], ["removed"], ["kept"]),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("reports initial additions only for forms with a saved complete catalog", async () => {
    const onDiff = vi.fn();
    renderHook(() =>
      useAutoModelRefresh({
        cacheKey: "provider:catalog-first",
        snapshotKey: "catalog-first",
        enabled: true,
        fetcher: () => Promise.resolve([{ id: "saved" }, { id: "new" }]),
        compareIds: ["saved", "removed"],
        reportInitialAdditions: true,
        onSuccess: vi.fn(),
        onDiff,
        ttlMs: 0,
      }),
    );
    await waitFor(() =>
      expect(onDiff).toHaveBeenCalledWith(["new"], ["removed"], []),
    );
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
        compareIds: ["saved"],
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

  it("never reports the same model as both removed and updated", async () => {
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
        // The catalog knows only gpt-5.6-sol. gpt-6-luna is present in the
        // previous fetch but in neither the catalog nor this response.
        compareIds: ["gpt-5.6-sol"],
        fetcher: () =>
          Promise.resolve([{ id: "gpt-5.6-sol", contextWindow: 2 }]),
        onSuccess: vi.fn(),
        onDiff,
        ttlMs: 0,
      }),
    );

    await waitFor(() => expect(onDiff).toHaveBeenCalled());
    const [, removed, updated] = onDiff.mock.calls[0];
    // gpt-6-luna was in the previous *fetch* but never in the saved catalog,
    // so it is not something the user lost and must not be reported at all.
    expect(removed).not.toContain("gpt-6-luna");
    expect(updated).not.toContain("gpt-6-luna");
  });

  it("does not report upstream churn as removals the user never had", async () => {
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
        // The saved catalog holds only these three.
        compareIds: ["gpt-5.6-sol", "gpt-6-sol", "gpt-6-astra"],
        fetcher: () =>
          Promise.resolve([{ id: "gpt-5.6-sol" }, { id: "gpt-reserve" }]),
        onSuccess: vi.fn(),
        onDiff,
        reportInitialAdditions: true,
        ttlMs: 0,
      }),
    );

    await waitFor(() => expect(onDiff).toHaveBeenCalled());
    const [added, removed] = onDiff.mock.calls[0];
    // gpt-5.6-sol and gpt-6-sol really are gone from the fetched list.
    expect(removed.sort()).toEqual(["gpt-6-astra", "gpt-6-sol"]);
    // gpt-reserve is new; the ten other vanished upstream models are not
    // reported as removed because the user never had them.
    expect(added).toEqual(["gpt-reserve"]);
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
        compareIds: ["first", "second"],
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
