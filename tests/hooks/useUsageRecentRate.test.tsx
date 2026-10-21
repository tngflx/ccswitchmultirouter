import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usageApi } from "@/lib/api/usage";
import { useUsageRecentRate, usageKeys } from "@/lib/query/usage";

vi.mock("@/lib/api/usage", () => ({
  usageApi: {
    getUsageSummary: vi.fn(),
  },
}));

const getUsageSummaryMock = vi.mocked(usageApi.getUsageSummary);

function createWrapper(
  client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  }),
) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

const summary = (
  inputTokens: number,
  outputTokens = 0,
  cacheCreation = 0,
  cacheRead = 0,
) => ({
  totalRequests: 1,
  totalCost: "0",
  totalInputTokens: inputTokens,
  totalOutputTokens: outputTokens,
  totalCacheCreationTokens: cacheCreation,
  totalCacheReadTokens: cacheRead,
  successRate: 100,
  realTotalTokens: inputTokens + outputTokens + cacheCreation + cacheRead,
  cacheHitRate: 0,
});

describe("useUsageRecentRate", () => {
  beforeEach(() => {
    getUsageSummaryMock.mockReset();
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_300_000);
    getUsageSummaryMock.mockResolvedValue(summary(600));
  });

  afterEach(() => vi.restoreAllMocks());

  it("queries a rolling five-minute window and derives tokens per second", async () => {
    const { result } = renderHook(
      () =>
        useUsageRecentRate("claude", "provider", "model", {
          refetchInterval: false,
        }),
      { wrapper: createWrapper() },
    );

    await waitFor(() =>
      expect(result.current.data?.inputTokensPerSecond).toBe(2),
    );
    expect(getUsageSummaryMock).toHaveBeenCalledWith(
      1_700_000_000,
      1_700_000_300,
      "claude",
      "provider",
      "model",
    );
  });

  it("resolves a fresh rolling window on each refetch", async () => {
    const { result } = renderHook(
      () =>
        useUsageRecentRate(undefined, undefined, undefined, {
          refetchInterval: false,
        }),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(result.current.data).toBeDefined());

    vi.mocked(Date.now).mockReturnValue(1_700_000_600_000);
    getUsageSummaryMock.mockResolvedValueOnce(summary(300, 30));
    await result.current.refetch();

    expect(getUsageSummaryMock).toHaveBeenLastCalledWith(
      1_700_000_300,
      1_700_000_600,
      undefined,
      undefined,
      undefined,
    );
    await waitFor(() => expect(result.current.data?.outputTokens).toBe(30));
  });

  it.each([
    ["application", { appType: "codex", providerName: "a", model: "m" }],
    ["provider", { appType: "claude", providerName: "b", model: "m" }],
    ["model", { appType: "claude", providerName: "a", model: "n" }],
  ] as const)(
    "loads separate rate data when the %s filter changes",
    async (_name, nextScope) => {
      getUsageSummaryMock
        .mockResolvedValueOnce(summary(300))
        .mockResolvedValueOnce(summary(600));
      const { result, rerender } = renderHook(
        ({ appType, providerName, model }) =>
          useUsageRecentRate(appType, providerName, model, {
            refetchInterval: false,
          }),
        {
          wrapper: createWrapper(),
          initialProps: { appType: "claude", providerName: "a", model: "m" },
        },
      );
      await waitFor(() =>
        expect(result.current.data?.inputTokensPerSecond).toBe(1),
      );

      rerender(nextScope);

      await waitFor(() =>
        expect(result.current.data?.inputTokensPerSecond).toBe(2),
      );
      expect(getUsageSummaryMock).toHaveBeenCalledTimes(2);
      expect(getUsageSummaryMock).toHaveBeenLastCalledWith(
        1_700_000_000,
        1_700_000_300,
        nextScope.appType,
        nextScope.providerName,
        nextScope.model,
      );
    },
  );

  it("keeps an inactive view dormant until enabled", async () => {
    const { result, rerender } = renderHook(
      ({ enabled }) =>
        useUsageRecentRate(undefined, undefined, undefined, {
          enabled,
          refetchInterval: false,
        }),
      { wrapper: createWrapper(), initialProps: { enabled: false } },
    );
    expect(result.current.isFetching).toBe(false);
    expect(getUsageSummaryMock).not.toHaveBeenCalled();

    rerender({ enabled: true });

    await waitFor(() =>
      expect(result.current.data?.inputTokensPerSecond).toBe(2),
    );
    expect(getUsageSummaryMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes the moving window through the shared usage invalidation", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(
      () => useUsageRecentRate("claude", "a", "m", { refetchInterval: false }),
      { wrapper: createWrapper(client) },
    );
    await waitFor(() =>
      expect(result.current.data?.inputTokensPerSecond).toBe(2),
    );
    vi.mocked(Date.now).mockReturnValue(1_700_000_900_000);
    getUsageSummaryMock.mockResolvedValueOnce(summary(300));

    await act(async () => {
      await client.invalidateQueries({ queryKey: usageKeys.all });
    });

    await waitFor(() =>
      expect(result.current.data?.inputTokensPerSecond).toBe(1),
    );
    expect(getUsageSummaryMock).toHaveBeenLastCalledWith(
      1_700_000_600,
      1_700_000_900,
      "claude",
      "a",
      "m",
    );
  });

  it("uses backend real-total semantics, including cache tokens", async () => {
    getUsageSummaryMock.mockResolvedValueOnce(summary(100, 40, 200, 150));
    const { result } = renderHook(
      () =>
        useUsageRecentRate("all", undefined, undefined, {
          refetchInterval: false,
        }),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(result.current.data?.inputTokens).toBe(450));
    expect(result.current.data?.inputTokensPerSecond).toBe(1.5);
    expect(result.current.data?.outputTokens).toBe(40);
    expect(result.current.data?.outputTokensPerSecond).toBeCloseTo(40 / 300);
    expect(getUsageSummaryMock).toHaveBeenLastCalledWith(
      1_700_000_000,
      1_700_000_300,
      undefined,
      undefined,
      undefined,
    );
  });

  it("leaves data undefined when the recent query fails", async () => {
    getUsageSummaryMock.mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(
      () =>
        useUsageRecentRate(undefined, undefined, undefined, {
          refetchInterval: false,
        }),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });

  it("reports zero for an empty window", async () => {
    getUsageSummaryMock.mockResolvedValueOnce(summary(0));
    const { result } = renderHook(() => useUsageRecentRate(), {
      wrapper: createWrapper(),
    });
    await waitFor(() =>
      expect(result.current.data?.inputTokensPerSecond).toBe(0),
    );
    expect(result.current.data?.outputTokensPerSecond).toBe(0);
  });
});
