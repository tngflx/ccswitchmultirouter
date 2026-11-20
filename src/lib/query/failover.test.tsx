import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { failoverApi } from "@/lib/api/failover";
import { useAddToFailoverQueue, useRemoveFromFailoverQueue } from "./failover";

vi.mock("@/lib/api/failover", () => ({
  failoverApi: {
    addToFailoverQueue: vi.fn(),
    removeFromFailoverQueue: vi.fn(),
  },
}));

function createWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe("failover queue mutations", () => {
  beforeEach(() => {
    vi.mocked(failoverApi.addToFailoverQueue).mockReset();
    vi.mocked(failoverApi.removeFromFailoverQueue).mockReset();
  });

  it("serializes add and remove writes across mutation hook instances", async () => {
    let finishAdd!: () => void;
    const addPending = new Promise<void>((resolve) => {
      finishAdd = resolve;
    });
    vi.mocked(failoverApi.addToFailoverQueue).mockReturnValue(addPending);
    vi.mocked(failoverApi.removeFromFailoverQueue).mockResolvedValue();

    const wrapper = createWrapper();
    const { result: add } = renderHook(() => useAddToFailoverQueue(), {
      wrapper,
    });
    const { result: remove } = renderHook(() => useRemoveFromFailoverQueue(), {
      wrapper,
    });

    let addPromise!: Promise<unknown>;
    let removePromise!: Promise<unknown>;
    await act(async () => {
      addPromise = add.current.mutateAsync({
        appType: "claude",
        providerId: "provider-a",
      });
      removePromise = remove.current.mutateAsync({
        appType: "claude",
        providerId: "provider-a",
      });
      await vi.waitFor(() =>
        expect(failoverApi.addToFailoverQueue).toHaveBeenCalledOnce(),
      );
    });

    expect(failoverApi.removeFromFailoverQueue).not.toHaveBeenCalled();

    await act(async () => {
      finishAdd();
      await Promise.all([addPromise, removePromise]);
    });
    expect(failoverApi.removeFromFailoverQueue).toHaveBeenCalledWith(
      "claude",
      "provider-a",
    );
  });
});
