import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageSwitcher } from "@/components/settings/LanguageSwitcher";

const useSettingsQueryMock = vi.fn();
const useSaveSettingsMutationMock = vi.fn();
const mutateMock = vi.fn();
const settingsData = {
  showInTray: true,
  minimizeToTrayOnClose: true,
  language: "zh" as const,
};

vi.mock("@/lib/query", () => ({
  useSettingsQuery: () => useSettingsQueryMock(),
  useSaveSettingsMutation: () => useSaveSettingsMutationMock(),
}));

describe("LanguageSwitcher", () => {
  beforeEach(async () => {
    window.localStorage.clear();
    await i18n.changeLanguage("zh");
    useSettingsQueryMock.mockReturnValue({ data: settingsData });
    useSaveSettingsMutationMock.mockReturnValue({
      mutate: mutateMock,
      isPending: false,
    });
  });

  it("changes the UI language and persists it through the settings mutation", async () => {
    const user = userEvent.setup();
    render(<LanguageSwitcher />);

    await user.click(screen.getByTitle("settings.language"));
    await user.click(
      await screen.findByRole("menuitem", {
        name: "settings.languageOptionEnglish",
      }),
    );

    expect(i18n.language).toBe("en");
    expect(window.localStorage.getItem("language")).toBe("en");
    expect(mutateMock).toHaveBeenCalledWith(
      expect.objectContaining({ language: "en" }),
      expect.objectContaining({ onError: expect.any(Function) }),
    );
  });

  it("restores the previous language when the settings save fails", async () => {
    window.localStorage.setItem("language", "zh");
    const user = userEvent.setup();
    render(<LanguageSwitcher />);

    await user.click(screen.getByTitle("settings.language"));
    await user.click(
      await screen.findByRole("menuitem", {
        name: "settings.languageOptionEnglish",
      }),
    );

    const options = mutateMock.mock.calls[0][1];
    await act(async () => {
      options.onError(new Error("save failed"));
      await Promise.resolve();
    });

    expect(i18n.language).toBe("zh");
    expect(window.localStorage.getItem("language")).toBe("zh");
  });
});
