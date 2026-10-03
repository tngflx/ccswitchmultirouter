export const SUPPORTED_LANGUAGES = ["en", "zh", "zh-TW", "ja"] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const DEFAULT_LANGUAGE: SupportedLanguage = "en";

export function parseSupportedLanguage(
  value?: string | null,
): SupportedLanguage | undefined {
  const normalized = value?.trim().toLowerCase().replace(/_/g, "-");
  if (!normalized) return undefined;

  if (
    normalized.startsWith("zh-tw") ||
    normalized.startsWith("zh-hant") ||
    normalized.startsWith("zh-hk") ||
    normalized.startsWith("zh-mo")
  ) {
    return "zh-TW";
  }

  if (normalized === "zh" || normalized.startsWith("zh-")) return "zh";
  if (normalized === "ja" || normalized.startsWith("ja-")) return "ja";
  if (normalized === "en" || normalized.startsWith("en-")) return "en";

  return undefined;
}

export function normalizeLanguage(value?: string | null): SupportedLanguage {
  return parseSupportedLanguage(value) ?? DEFAULT_LANGUAGE;
}
