import { describe, expect, it, vi } from "vitest";

import { providersApi } from "@/lib/api/providers";
import type { QueryClient } from "@tanstack/react-query";
import {
  createProviderSwitchFailureToastOptions,
  refreshProviderSwitchQueries,
} from "./mutations";

describe("provider switch force repair action", () => {
  it("schedules switch cache refreshes without awaiting a slow query", async () => {
    let finishRefresh!: () => void;
    const slowRefresh = new Promise<boolean>((resolve) => {
      finishRefresh = () => resolve(true);
    });
    const invalidateQueries = vi.fn(() => slowRefresh);
    const trayMenu = vi
      .spyOn(providersApi, "updateTrayMenu")
      .mockReturnValue(slowRefresh);

    try {
      const queryClient = { invalidateQueries } as unknown as QueryClient;
      expect(
        refreshProviderSwitchQueries(queryClient, "codex"),
      ).toBeUndefined();
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: ["providers", "codex"],
      });
      expect(trayMenu).toHaveBeenCalledTimes(1);
    } finally {
      finishRefresh();
      trayMenu.mockRestore();
    }
  });

  it("offers copy and force repair together for a failed Codex switch", async () => {
    const copy = vi.fn();
    const forceRepair = vi.fn().mockResolvedValue(undefined);

    const options = createProviderSwitchFailureToastOptions({
      appId: "codex",
      providerId: "deepseek-provider",
      detail: "duplicate field max_concurrent_threads_per_session",
      copy,
      forceRepair,
      t: (_key, fallback) => fallback,
    });

    expect(options.action?.label).toBe("Copy");
    expect(options.cancel?.label).toBe("Force repair");
    options.action?.onClick();
    await options.cancel?.onClick();
    expect(copy).toHaveBeenCalledWith(
      "duplicate field max_concurrent_threads_per_session",
    );
    expect(forceRepair).toHaveBeenCalledWith("deepseek-provider");
  });

  it("does not offer force repair for non-Codex providers", () => {
    const options = createProviderSwitchFailureToastOptions({
      appId: "claude",
      providerId: "claude-provider",
      detail: "switch failed",
      copy: vi.fn(),
      forceRepair: vi.fn(),
      t: (_key, fallback) => fallback,
    });

    expect(options.action?.label).toBe("Copy");
    expect(options.cancel).toBeUndefined();
  });
});
