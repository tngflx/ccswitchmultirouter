import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  useSetProxyTakeoverForApp,
  proxyKeys,
  proxyStatusPollInterval,
} from "@/lib/query/proxy";
import { proxyApi } from "@/lib/api/proxy";
import { createTestQueryClient } from "../../utils/testQueryClient";

vi.mock("@/lib/api/proxy", () => ({
  proxyApi: {
    setProxyTakeoverForApp: vi.fn(),
  },
}));

describe("proxy takeover mutation", () => {
  it("keeps checking stopped status for external startup recovery", () => {
    expect(proxyStatusPollInterval(undefined)).toBe(5000);
    expect(proxyStatusPollInterval(false)).toBe(5000);
    expect(proxyStatusPollInterval(true)).toBe(2000);
  });

  it("refreshes service and takeover status after enabling or disabling an app", async () => {
    vi.mocked(proxyApi.setProxyTakeoverForApp).mockResolvedValue(undefined);
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useSetProxyTakeoverForApp(), {
      wrapper,
    });

    await act(async () => {
      await result.current.mutateAsync({ appType: "claude", enabled: true });
      await result.current.mutateAsync({ appType: "claude", enabled: false });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: proxyKeys.status });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: proxyKeys.takeoverStatus,
    });
    expect(
      invalidateSpy.mock.calls.filter(
        ([args]) => args?.queryKey === proxyKeys.status,
      ),
    ).toHaveLength(2);
    expect(
      invalidateSpy.mock.calls.filter(
        ([args]) => args?.queryKey === proxyKeys.takeoverStatus,
      ),
    ).toHaveLength(2);
  });
});
