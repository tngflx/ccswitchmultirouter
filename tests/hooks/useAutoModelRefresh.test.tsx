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
