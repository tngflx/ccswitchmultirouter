import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { settingsApi } from "@/lib/api/settings";

describe("native tool install command projection", () => {
  beforeEach(() => invokeMock.mockReset());

  it("reads the backend authority without requesting an installation or upgrade", async () => {
    const commands = "# Codex\nbackend-owned command";
    invokeMock.mockResolvedValueOnce(commands);
    expect(await settingsApi.getToolInstallCommands()).toBe(commands);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("get_tool_install_commands");
  });

  it("propagates lookup errors rather than returning a stale frontend fallback", async () => {
    invokeMock.mockRejectedValueOnce(new Error("unavailable"));
    await expect(settingsApi.getToolInstallCommands()).rejects.toThrow(
      "unavailable",
    );
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});
