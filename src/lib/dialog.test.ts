import { beforeEach, describe, expect, it, vi } from "vitest";
import { confirmDialog } from "@/lib/dialog";

const { tauriConfirm } = vi.hoisted(() => ({
  tauriConfirm: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: tauriConfirm,
}));

describe("confirmDialog", () => {
  beforeEach(() => {
    tauriConfirm.mockReset();
  });

  it("uses the Tauri dialog when the plugin is available", async () => {
    tauriConfirm.mockResolvedValueOnce(true);

    await expect(confirmDialog("Continue?")).resolves.toBe(true);
    expect(tauriConfirm).toHaveBeenCalledWith("Continue?", undefined);
  });

  it("falls back to the browser confirmation when the Tauri command is unavailable", async () => {
    tauriConfirm.mockRejectedValueOnce(new Error("Command not found"));
    const browserConfirm = vi
      .spyOn(window, "confirm")
      .mockReturnValueOnce(true);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(confirmDialog("Continue?")).resolves.toBe(true);

    expect(browserConfirm).toHaveBeenCalledWith("Continue?");
    expect(warning).toHaveBeenCalled();
    browserConfirm.mockRestore();
    warning.mockRestore();
  });
});
