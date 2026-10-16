import { renderHook, act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRequestHealthDiagnostics } from "@/hooks/useRequestHealthDiagnostics";
import type { RequestHealthSnapshot } from "@/types/proxy";

const getRequestHealthDiagnosticsMock = vi.fn();

vi.mock("@/lib/api/proxy", () => ({
  proxyApi: {
    getRequestHealthDiagnostics: (...args: unknown[]) =>
      getRequestHealthDiagnosticsMock(...args),
  },
}));

const snapshot: RequestHealthSnapshot = {
  config: {
    enabled: true,
    optimizationMode: "diagnose",
    largeRequestThresholdBytes: 64 * 1024,
    maxCodexInputTokens: 128_000,
    reviewMode: "first_large_request",
    reviewTimeoutSeconds: 30,
    summarizeAndRestartEnabled: false,
    windowsNotificationsEnabled: false,
    windowsNotificationSnoozeHours: 4,
    windowsNotificationsSnoozedUntilMs: null,
  },
  diagnostics: [],
};

describe("useRequestHealthDiagnostics", () => {
  beforeEach(() => {
    getRequestHealthDiagnosticsMock.mockReset();
  });

  it("loads automatically only while enabled and supports manual refresh", async () => {
    getRequestHealthDiagnosticsMock.mockResolvedValue(snapshot);
    const { result, rerender } = renderHook(
      ({ enabled }) => useRequestHealthDiagnostics(enabled),
      { initialProps: { enabled: false } },
    );

    expect(getRequestHealthDiagnosticsMock).not.toHaveBeenCalled();

    rerender({ enabled: true });
    await waitFor(() => expect(result.current.snapshot).toEqual(snapshot));
    expect(getRequestHealthDiagnosticsMock).toHaveBeenCalledTimes(1);
    expect(result.current.isRefreshing).toBe(false);

    await act(async () => {
      await result.current.refresh();
    });
    expect(getRequestHealthDiagnosticsMock).toHaveBeenCalledTimes(2);
  });

  it("clears the loading state when a refresh fails", async () => {
    getRequestHealthDiagnosticsMock.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useRequestHealthDiagnostics(true));

    await waitFor(() => expect(result.current.isRefreshing).toBe(false));
    expect(result.current.snapshot).toBeUndefined();
    expect(result.current.error).toBe("offline");
  });

  it("keeps the newest result when overlapping refreshes finish out of order", async () => {
    let finishFirst!: (value: RequestHealthSnapshot) => void;
    let finishSecond!: (value: RequestHealthSnapshot) => void;
    getRequestHealthDiagnosticsMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishSecond = resolve;
          }),
      );
    const { result } = renderHook(() => useRequestHealthDiagnostics(true));
    let secondRefresh!: Promise<void>;
    act(() => {
      secondRefresh = result.current.refresh();
    });
    const newest = {
      ...snapshot,
      config: { ...snapshot.config, maxCodexInputTokens: 200_000 },
    };

    await act(async () => {
      finishSecond(newest);
      await secondRefresh;
    });
    expect(result.current.snapshot).toEqual(newest);
    await act(async () => finishFirst(snapshot));
    expect(result.current.snapshot).toEqual(newest);
    expect(result.current.isRefreshing).toBe(false);
  });

  it("ignores a pending refresh after the diagnostics view is closed", async () => {
    let finish!: (value: RequestHealthSnapshot) => void;
    getRequestHealthDiagnosticsMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { result, rerender } = renderHook(
      ({ enabled }) => useRequestHealthDiagnostics(enabled),
      { initialProps: { enabled: true } },
    );

    expect(result.current.isRefreshing).toBe(true);
    rerender({ enabled: false });
    expect(result.current.isRefreshing).toBe(false);
    await act(async () => finish(snapshot));
    expect(result.current.snapshot).toBeUndefined();
  });

  it("does not clear the current loading state when an older refresh finishes", async () => {
    let finishFirst!: (value: RequestHealthSnapshot) => void;
    let finishSecond!: (value: RequestHealthSnapshot) => void;
    getRequestHealthDiagnosticsMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishSecond = resolve;
          }),
      );
    const { result } = renderHook(() => useRequestHealthDiagnostics(true));
    let secondRefresh!: Promise<void>;
    act(() => {
      secondRefresh = result.current.refresh();
    });

    await act(async () => finishFirst(snapshot));
    expect(result.current.isRefreshing).toBe(true);
    expect(result.current.snapshot).toBeUndefined();
    await act(async () => {
      finishSecond(snapshot);
      await secondRefresh;
    });
    expect(result.current.isRefreshing).toBe(false);
  });

  it("keeps canonical saved config when a pre-save refresh finishes later", async () => {
    let finish!: (value: RequestHealthSnapshot) => void;
    getRequestHealthDiagnosticsMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { result } = renderHook(() => useRequestHealthDiagnostics(true));
    const savedConfig = { ...snapshot.config, enabled: false };

    act(() => result.current.acceptSavedConfig(savedConfig));
    expect(result.current.snapshot?.config).toEqual(savedConfig);
    expect(result.current.isRefreshing).toBe(false);
    await act(async () => finish(snapshot));
    expect(result.current.snapshot?.config).toEqual(savedConfig);
  });

  it("preserves the last usable snapshot on failure and clears errors on retry", async () => {
    getRequestHealthDiagnosticsMock
      .mockResolvedValueOnce(snapshot)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(snapshot);
    const { result } = renderHook(() => useRequestHealthDiagnostics(true));
    await waitFor(() => expect(result.current.snapshot).toEqual(snapshot));

    await act(async () => result.current.refresh());
    expect(result.current.error).toBe("offline");
    expect(result.current.snapshot).toEqual(snapshot);
    await act(async () => result.current.refresh());
    expect(result.current.error).toBeNull();
    expect(result.current.snapshot).toEqual(snapshot);
  });
});
