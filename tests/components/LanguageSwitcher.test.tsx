import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom";
import i18n from "i18next";
import { LanguageSwitcher } from "@/components/settings/LanguageSwitcher";

const useSettingsQueryMock = vi.fn();
const useSaveSettingsMutationMock = vi.fn();
const settingsData = {
  showInTray: true,
  minimizeToTrayOnClose: true,
  language: "zh",
};
const mutateMock = vi.fn();

vi.mock("@/lib/query", () => ({
  useSettingsQuery: () => useSettingsQueryMock(),
  useSaveSettingsMutation: () => useSaveSettingsMutationMock(),
}));

describe("LanguageSwitcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    (i18n as any).language = "zh";
    useSettingsQueryMock.mockReturnValue({ data: settingsData });
    useSaveSettingsMutationMock.mockReturnValue({
      mutate: mutateMock,
      isPending: false,
    });
  });

  it("changes the UI language and persists it to device settings", async () => {
    render(<LanguageSwitcher />);

    const user = userEvent.setup();
    await user.click(screen.getByTitle("Language"));
    await user.click(await screen.findByRole("menuitem", { name: "English" }));

    expect(window.localStorage.getItem("language")).toBe("en");
    expect(mutateMock).toHaveBeenCalledWith(
      expect.objectContaining({ language: "en" }),
      expect.objectContaining({ onError: expect.any(Function) }),
    );
  });
});
