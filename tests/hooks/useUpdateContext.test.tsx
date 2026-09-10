import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UpdateProvider, useUpdate } from "@/contexts/UpdateContext";
import { checkForUpdate } from "@/lib/updater";

vi.mock("@/lib/updater", () => ({ checkForUpdate: vi.fn() }));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));

afterEach(() => vi.restoreAllMocks());

describe("update check failure details", () => {
  it.each([
    ["TLS certificate rejected", "TLS certificate rejected"],
    [{ message: "Proxy unavailable" }, "Proxy unavailable"],
    [new Error("Connection refused"), "Connection refused"],
    [{}, "update.checkFailed"],
  ])("preserves rejection details for %j", async (failure, expected) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(checkForUpdate).mockRejectedValueOnce(failure);
    const { result } = renderHook(() => useUpdate(), {
      wrapper: UpdateProvider,
    });

    await act(async () => {
      await expect(result.current.checkUpdate()).rejects.toBe(failure);
    });

    expect(result.current.error).toBe(expected);
    expect(result.current.isChecking).toBe(false);
    expect(result.current.hasUpdate).toBe(false);
  });
});
