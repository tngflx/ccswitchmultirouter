import { act, renderHook, waitFor } from "@testing-library/react";
import {
  invalidateAutoModelRefresh,
  modelRefreshCredentialFingerprint,
  rememberModelRefreshSnapshot,
  useAutoModelRefresh,
} from "@/hooks/useAutoModelRefresh";

describe("useAutoModelRefresh", () => {
  beforeEach(() => {
    localStorage.clear();
    invalidateAutoModelRefresh();
  });

  it("deduplicates concurrent requests and caches the result", async () => {
    let resolve!: (value: { id: string }[]) => void;
    const request = new Promise<{ id: string }[]>((next) => {
      resolve = next;
    });
    const fetcher = vi.fn(() => request);
    const first = vi.fn();
    const second = vi.fn();

    renderHook(() =>
      useAutoModelRefresh({
        cacheKey: "provider:one",
        enabled: true,
        fetcher,
        onSuccess: first,
      }),
    );
    renderHook(() =>
      useAutoModelRefresh({
        cacheKey: "provider:one",
        enabled: true,
        fetcher,
        onSuccess: second,
      }),
    );

    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => resolve([{ id: "model-a" }]));
    await waitFor(() =>
      expect(first).toHaveBeenCalledWith([{ id: "model-a" }]),
    );
    expect(second).toHaveBeenCalledWith([{ id: "model-a" }]);

    const cached = vi.fn();
    renderHook(() =>
      useAutoModelRefresh({
        cacheKey: "provider:one",
        enabled: true,
        fetcher,
        onSuccess: cached,
      }),
    );
    await waitFor(() =>
      expect(cached).toHaveBeenCalledWith([{ id: "model-a" }]),
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reports membership changes but ignores empty responses", async () => {
    rememberModelRefreshSnapshot("provider:two", [{ id: "old" }]);
    const onDiff = vi.fn();
    const onSuccess = vi.fn();
    renderHook(() =>
      useAutoModelRefresh({
        cacheKey: "provider:two",
        enabled: true,
        fetcher: async () => [{ id: "new" }],
        onSuccess,
        snapshotKey: "provider:two",
        onDiff,
        ttlMs: 0,
      }),
    );
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(onDiff).toHaveBeenCalledWith(["new"], ["old"], []);

    invalidateAutoModelRefresh();
    onDiff.mockClear();
    renderHook(() =>
      useAutoModelRefresh({
        cacheKey: "provider:three",
        enabled: true,
        fetcher: async () => [],
        onSuccess: vi.fn(),
        snapshotKey: "provider:two",
        onDiff,
        ttlMs: 0,
      }),
    );
    await act(async () => undefined);
    expect(onDiff).not.toHaveBeenCalled();
  });

  it("prevents an invalidated request from updating consumers", async () => {
    let resolve!: (value: { id: string }[]) => void;
    const request = new Promise<{ id: string }[]>((next) => {
      resolve = next;
    });
    const onSuccess = vi.fn();
    renderHook(() =>
      useAutoModelRefresh({
        cacheKey: "provider:four",
        enabled: true,
        fetcher: () => request,
        onSuccess,
      }),
    );
    invalidateAutoModelRefresh("provider:four");
    await act(async () => resolve([{ id: "stale" }]));
    await act(async () => undefined);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("fingerprints credentials without exposing the secret", () => {
    expect(modelRefreshCredentialFingerprint("secret-a")).not.toBe("secret-a");
    expect(modelRefreshCredentialFingerprint("secret-a")).toBe(
      modelRefreshCredentialFingerprint("secret-a"),
    );
    expect(modelRefreshCredentialFingerprint("secret-a")).not.toBe(
      modelRefreshCredentialFingerprint("secret-b"),
    );
  });
});
