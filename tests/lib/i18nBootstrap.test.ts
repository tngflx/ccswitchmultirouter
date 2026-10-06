import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("i18next", async (importOriginal) => {
  const { createInstance } = await importOriginal<typeof import("i18next")>();
  return { default: createInstance() };
});

async function initializeWithPreference(preference: string | null) {
  vi.resetModules();
  vi.spyOn(window.localStorage, "getItem").mockReturnValue(preference);
  const { default: i18n } = await import("@/i18n");
  return i18n;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("application language bootstrap", () => {
  it("starts in English even on a Chinese host without a saved preference", async () => {
    vi.spyOn(navigator, "language", "get").mockReturnValue("zh-CN");
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["zh-CN"]);
    const i18n = await initializeWithPreference(null);

    expect(i18n.language).toBe("en");
    expect(i18n.t("common.refresh")).toBe("Refresh");
  });

  it.each([
    ["en-US", "en", "Refresh"],
    ["zh-CN", "zh", "刷新"],
    ["zh-Hant", "zh-TW", "重新整理"],
    ["ja-JP", "ja", "更新"],
  ])("keeps the saved %s preference", async (preference, expected, label) => {
    const i18n = await initializeWithPreference(preference);
    expect(i18n.language).toBe(expected);
    expect(i18n.t("common.refresh")).toBe(label);
  });

  it("uses English for an unsupported saved language", async () => {
    const i18n = await initializeWithPreference("fr-FR");
    expect(i18n.language).toBe("en");
  });

  it("uses English when storage is unavailable", async () => {
    vi.resetModules();
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { default: i18n } = await import("@/i18n");

    expect(i18n.language).toBe("en");
    expect(warning).toHaveBeenCalledWith(
      "[i18n] Failed to read stored language preference",
      expect.any(Error),
    );
  });
});
