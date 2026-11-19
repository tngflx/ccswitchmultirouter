import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { failoverApi } from "./failover";

describe("failover API reads", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("times out a stuck queue read instead of leaving the provider page pending forever", async () => {
    invokeMock.mockReturnValue(new Promise(() => {}));

    const pending = failoverApi.getFailoverQueue("codex");
    const assertion = expect(pending).rejects.toThrow(
      "Timed out waiting for get_failover_queue",
    );

    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
  });

  it("clears the read timeout after a successful response", async () => {
    invokeMock.mockResolvedValue(true);

    await expect(failoverApi.getAutoFailoverEnabled("codex")).resolves.toEqual(
      true,
    );
    expect(vi.getTimerCount()).toBe(0);
    expect(invokeMock).toHaveBeenCalledWith("get_auto_failover_enabled", {
      appType: "codex",
    });
  });
});
