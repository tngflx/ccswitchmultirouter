import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import i18n from "i18next";
import { useSettingsForm } from "@/hooks/useSettingsForm";

const useSettingsQueryMock = vi.fn();

vi.mock("@/lib/query", () => ({
  useSettingsQuery: (...args: unknown[]) => useSettingsQueryMock(...args),
}));

let changeLanguageSpy: ReturnType<typeof vi.spyOn<any, any>>;

beforeEach(() => {
  useSettingsQueryMock.mockReset();
  window.localStorage.clear();
  (i18n as any).language = "zh";
  changeLanguageSpy = vi
    .spyOn(i18n, "changeLanguage")
    .mockImplementation(async (lang?: string) => {
      (i18n as any).language = lang;
      return i18n.t;
    });
});

afterEach(() => {
  changeLanguageSpy.mockRestore();
});

describe("useSettingsForm Hook", () => {
  it("should normalize settings and sync language on initialization", async () => {
    useSettingsQueryMock.mockReturnValue({
      data: {
        showInTray: undefined,
        minimizeToTrayOnClose: undefined,
        enableClaudePluginIntegration: undefined,
        claudeConfigDir: "  /Users/demo  ",
        codexConfigDir: "   ",
        language: "en",
      },
      isLoading: false,
    });

    const { result } = renderHook(() => useSettingsForm());

    await waitFor(() => {
      expect(result.current.settings).not.toBeNull();
    });

    const settings = result.current.settings!;
    expect(settings.showInTray).toBe(true);
    expect(settings.minimizeToTrayOnClose).toBe(true);
    expect(settings.enableClaudePluginIntegration).toBe(false);
    expect(settings.claudeConfigDir).toBe("/Users/demo");
    expect(settings.codexConfigDir).toBeUndefined();
    expect(settings.language).toBe("en");
    expect(result.current.initialLanguage).toBe("en");
    expect(changeLanguageSpy).toHaveBeenCalledWith("en");
  });

  it("should support japanese language preference from server data", async () => {
    useSettingsQueryMock.mockReturnValue({
      data: {
        showInTray: true,
        minimizeToTrayOnClose: true,
        enableClaudePluginIntegration: false,
        claudeConfigDir: "/Users/demo",
        codexConfigDir: null,
        language: "ja",
      },
      isLoading: false,
    });

    const { result } = renderHook(() => useSettingsForm());

    await waitFor(() => {
      expect(result.current.settings?.language).toBe("ja");
    });

    expect(result.current.initialLanguage).toBe("ja");
    expect(changeLanguageSpy).toHaveBeenCalledWith("ja");
  });

  it("normalizes legacy stream retry settings and attempt bounds", async () => {
    useSettingsQueryMock.mockReturnValue({
      data: {
        enableStreamRetry: false,
        streamRetryMode: "safe",
        streamRetryMaxAttempts: 99,
        language: "en",
      },
      isLoading: false,
    });

    const { result } = renderHook(() => useSettingsForm());

    await waitFor(() => {
      expect(result.current.settings?.streamRetryMode).toBe("off");
    });

    expect(result.current.settings?.streamRetryMaxAttempts).toBe(3);

    act(() => {
      result.current.resetSettings({
        showInTray: true,
        minimizeToTrayOnClose: true,
        enableStreamRetry: true,
        streamRetryMode: "aggressive",
        streamRetryMaxAttempts: -4,
        language: "en",
      });
    });

    expect(result.current.settings?.streamRetryMode).toBe("aggressive");
    expect(result.current.settings?.streamRetryMaxAttempts).toBe(1);
  });

  it("should support traditional chinese language preference aliases", async () => {
    useSettingsQueryMock.mockReturnValue({
      data: {
        showInTray: true,
        minimizeToTrayOnClose: true,
        enableClaudePluginIntegration: false,
        claudeConfigDir: "/Users/demo",
        codexConfigDir: null,
        language: "zh-Hant",
      },
      isLoading: false,
    });

    const { result } = renderHook(() => useSettingsForm());

    await waitFor(() => {
      expect(result.current.settings?.language).toBe("zh-TW");
    });

    expect(result.current.initialLanguage).toBe("zh-TW");
    expect(changeLanguageSpy).toHaveBeenCalledWith("zh-TW");
  });

  it("should prioritize reading language from local storage in readPersistedLanguage", () => {
    useSettingsQueryMock.mockReturnValue({
      data: null,
      isLoading: false,
    });
    window.localStorage.setItem("language", "en");

    const { result } = renderHook(() => useSettingsForm());

    const lang = result.current.readPersistedLanguage();
    expect(lang).toBe("en");
    expect(changeLanguageSpy).not.toHaveBeenCalled();
  });

  it("should fall back to english for an unknown language", () => {
    useSettingsQueryMock.mockReturnValue({
      data: null,
      isLoading: false,
    });
    (i18n as any).language = "unsupported-locale";

    const { result } = renderHook(() => useSettingsForm());

    expect(result.current.initialLanguage).toBe("en");
    expect(result.current.readPersistedLanguage()).toBe("en");
  });

  it("should update fields and sync language when language changes in updateSettings", () => {
    useSettingsQueryMock.mockReturnValue({
      data: null,
      isLoading: false,
    });

    const { result } = renderHook(() => useSettingsForm());

    act(() => {
      result.current.updateSettings({ showInTray: false });
    });

    expect(result.current.settings?.showInTray).toBe(false);

    changeLanguageSpy.mockClear();
    act(() => {
      result.current.updateSettings({ language: "en" });
    });

    expect(result.current.settings?.language).toBe("en");
    expect(changeLanguageSpy).toHaveBeenCalledWith("en");
  });

  it("should reset with server data and restore initial language in resetSettings", async () => {
    useSettingsQueryMock.mockReturnValue({
      data: {
        showInTray: true,
        minimizeToTrayOnClose: true,
        enableClaudePluginIntegration: false,
        claudeConfigDir: "/origin",
        codexConfigDir: null,
        language: "en",
      },
      isLoading: false,
    });

    const { result } = renderHook(() => useSettingsForm());

    await waitFor(() => {
      expect(result.current.settings).not.toBeNull();
    });

    changeLanguageSpy.mockClear();
    act(() => {
      result.current.updateSettings({ language: "zh" });
    });
    expect(result.current.settings?.language).toBe("zh");
    expect(changeLanguageSpy).toHaveBeenCalledWith("zh");
    changeLanguageSpy.mockClear();

    act(() => {
      result.current.resetSettings({
        showInTray: false,
        minimizeToTrayOnClose: false,
        enableClaudePluginIntegration: true,
        claudeConfigDir: "  /reset  ",
        codexConfigDir: "   ",
        language: "zh",
      });
    });

    const settings = result.current.settings!;
    expect(settings.showInTray).toBe(false);
    expect(settings.minimizeToTrayOnClose).toBe(false);
    expect(settings.enableClaudePluginIntegration).toBe(true);
    expect(settings.claudeConfigDir).toBe("/reset");
    expect(settings.codexConfigDir).toBeUndefined();
    expect(settings.language).toBe("zh");
    expect(result.current.initialLanguage).toBe("en");
    expect(changeLanguageSpy).toHaveBeenCalledWith("en");
  });

  it("should not call changeLanguage repeatedly when language is consistent in syncLanguage", async () => {
    useSettingsQueryMock.mockReturnValue({
      data: {
        showInTray: true,
        minimizeToTrayOnClose: true,
        enableClaudePluginIntegration: false,
        claudeConfigDir: null,
        codexConfigDir: null,
        language: "zh",
      },
      isLoading: false,
    });

    const { result } = renderHook(() => useSettingsForm());

    await waitFor(() => {
      expect(result.current.settings).not.toBeNull();
    });

    changeLanguageSpy.mockClear();
    (i18n as any).language = "zh";

    act(() => {
      result.current.syncLanguage("zh");
    });

    expect(changeLanguageSpy).not.toHaveBeenCalled();
  });

  it("preserves local drafts across language rerenders of the same query snapshot", () => {
    const saved = {
      showInTray: true,
      minimizeToTrayOnClose: true,
      language: "en" as const,
    };
    useSettingsQueryMock.mockReturnValue({ data: saved, isLoading: false });
    const { result, rerender } = renderHook(() => useSettingsForm());

    act(() => {
      result.current.updateSettings({ showInTray: false, language: "ja" });
    });
    rerender();

    expect(result.current.settings?.showInTray).toBe(false);
    expect(result.current.settings?.language).toBe("ja");
    expect(result.current.initialLanguage).toBe("en");
  });

  it("rebases a new persisted snapshot without discarding local drafts", () => {
    const saved = {
      showInTray: true,
      minimizeToTrayOnClose: true,
      claudeConfigDir: "/saved/claude",
      codexConfigDir: "/saved/codex",
      language: "en" as const,
    };
    useSettingsQueryMock.mockReturnValue({ data: saved, isLoading: false });
    const { result, rerender } = renderHook(() => useSettingsForm());

    act(() => {
      result.current.updateSettings({
        claudeConfigDir: "/draft/claude",
        language: "ja",
      });
    });
    useSettingsQueryMock.mockReturnValue({
      data: {
        ...saved,
        minimizeToTrayOnClose: false,
        codexConfigDir: "/latest/codex",
      },
      isLoading: false,
    });
    rerender();

    expect(result.current.settings?.claudeConfigDir).toBe("/draft/claude");
    expect(result.current.settings?.language).toBe("ja");
    expect(result.current.settings?.codexConfigDir).toBe("/latest/codex");
    expect(result.current.settings?.minimizeToTrayOnClose).toBe(false);
    expect(i18n.language).toBe("ja");
    expect(result.current.initialLanguage).toBe("en");

    act(() => {
      result.current.resetSettings({
        ...saved,
        minimizeToTrayOnClose: false,
        codexConfigDir: "/latest/codex",
      });
    });
    expect(result.current.settings?.claudeConfigDir).toBe("/saved/claude");
    expect(result.current.settings?.language).toBe("en");
  });

  it("adopts later canonical changes after a local draft is persisted", () => {
    const saved = {
      showInTray: true,
      minimizeToTrayOnClose: true,
      claudeConfigDir: "/saved/claude",
      language: "en" as const,
    };
    useSettingsQueryMock.mockReturnValue({ data: saved, isLoading: false });
    const { result, rerender } = renderHook(() => useSettingsForm());
    act(() => {
      result.current.updateSettings({ claudeConfigDir: "/draft/claude" });
    });

    useSettingsQueryMock.mockReturnValue({
      data: { ...saved, claudeConfigDir: "/draft/claude" },
      isLoading: false,
    });
    rerender();
    expect(result.current.settings?.claudeConfigDir).toBe("/draft/claude");

    useSettingsQueryMock.mockReturnValue({
      data: { ...saved, claudeConfigDir: "/external/claude" },
      isLoading: false,
    });
    rerender();
    expect(result.current.settings?.claudeConfigDir).toBe("/external/claude");
  });

  it("applies a newer query snapshot after an explicit reset", () => {
    const saved = {
      showInTray: true,
      minimizeToTrayOnClose: true,
      language: "en" as const,
    };
    useSettingsQueryMock.mockReturnValue({ data: saved, isLoading: false });
    const { result, rerender } = renderHook(() => useSettingsForm());

    act(() => {
      result.current.resetSettings({ ...saved, showInTray: false });
    });
    rerender();
    expect(result.current.settings?.showInTray).toBe(false);

    useSettingsQueryMock.mockReturnValue({
      data: { ...saved, language: "ja", claudeConfigDir: " /new-server " },
      isLoading: false,
    });
    rerender();

    expect(result.current.settings?.showInTray).toBe(true);
    expect(result.current.settings?.language).toBe("ja");
    expect(result.current.settings?.claudeConfigDir).toBe("/new-server");
    expect(result.current.initialLanguage).toBe("ja");
  });

  it("keeps a pre-hydration reset until an actual query snapshot arrives", () => {
    useSettingsQueryMock.mockReturnValue({ data: null, isLoading: true });
    const { result, rerender } = renderHook(() => useSettingsForm());

    act(() => {
      result.current.resetSettings({
        showInTray: false,
        minimizeToTrayOnClose: false,
        language: "ja",
      });
    });
    rerender();
    expect(result.current.settings?.showInTray).toBe(false);
    expect(result.current.settings?.language).toBe("ja");

    useSettingsQueryMock.mockReturnValue({
      data: { showInTray: true, minimizeToTrayOnClose: true, language: "en" },
      isLoading: false,
    });
    rerender();
    expect(result.current.settings?.showInTray).toBe(true);
    expect(result.current.initialLanguage).toBe("en");
  });
});
