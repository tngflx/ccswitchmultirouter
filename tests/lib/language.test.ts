import { describe, expect, it } from "vitest";
import {
  DEFAULT_LANGUAGE,
  normalizeLanguage,
  parseSupportedLanguage,
} from "@/i18n/language";

describe("language contract", () => {
  it("uses english as the default language", () => {
    expect(DEFAULT_LANGUAGE).toBe("en");
    expect(normalizeLanguage(undefined)).toBe("en");
    expect(normalizeLanguage("unsupported-locale")).toBe("en");
  });

  it.each([
    ["en-US", "en"],
    ["ja-JP", "ja"],
    ["zh-CN", "zh"],
    ["zh_Hant", "zh-TW"],
    ["zh-HK", "zh-TW"],
    ["zh-TW-u-ca-chinese", "zh-TW"],
  ] as const)("normalizes %s to %s", (input, expected) => {
    expect(parseSupportedLanguage(input)).toBe(expected);
  });
});
