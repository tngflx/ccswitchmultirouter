import { describe, expect, it, vi } from "vitest";

import { createProviderSwitchFailureToastOptions } from "./mutations";

describe("provider switch force repair action", () => {
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

    expect(options.action?.label).toBe("复制");
    expect(options.cancel?.label).toBe("强制覆盖");
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

    expect(options.action?.label).toBe("复制");
    expect(options.cancel).toBeUndefined();
  });

  it("offers an explicit Desktop restart and switch for active Codex routing", async () => {
    const switchWithDesktopRestart = vi.fn().mockResolvedValue(undefined);
    const options = createProviderSwitchFailureToastOptions({
      appId: "codex",
      providerId: "provider",
      detail: "CODEX_DESKTOP_ACTIVE: still running",
      copy: vi.fn(),
      forceRepair: vi.fn(),
      switchWithDesktopRestart,
      t: (_key, fallback) => fallback,
    });

    expect(options.action?.label).toBe("Restart Desktop and switch");
    await options.action?.onClick();
    expect(switchWithDesktopRestart).toHaveBeenCalledOnce();
    expect(options.cancel?.label).toBe("Copy");
  });

  it("does not offer managed Desktop switch for unrelated errors", () => {
    const options = createProviderSwitchFailureToastOptions({
      appId: "codex",
      providerId: "provider",
      detail: "invalid model mapping",
      copy: vi.fn(),
      forceRepair: vi.fn(),
      switchWithDesktopRestart: vi.fn(),
      t: (_key, fallback) => fallback,
    });

    expect(options.action?.label).toBe("复制");
    expect(options.cancel?.label).toBe("强制覆盖");
  });
});
