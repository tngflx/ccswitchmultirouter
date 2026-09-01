import type { AppId } from "@/lib/api/types";

/**
 * Grok Build providers created before the provider-icon rules were aligned
 * received the Grok app icon automatically. The icon picker records the
 * selected icon's default color (`currentColor` for Grok), so an empty color
 * identifies the old automatic value without hiding an explicit user choice.
 */
export function resolveProviderIcon(
  appId: AppId,
  icon?: string,
  iconColor?: string,
): string | undefined {
  const normalizedIcon = icon?.trim();
  if (!normalizedIcon) return undefined;

  if (
    appId === "grokbuild" &&
    normalizedIcon === "grok" &&
    !iconColor?.trim()
  ) {
    return undefined;
  }

  return normalizedIcon;
}

/** Build a stable remote favicon URL from a provider API endpoint. */
export function providerFaviconUrl(apiUrl?: string): string | undefined {
  if (!apiUrl?.trim()) return undefined;
  try {
    const parsed = new URL(apiUrl.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return `https://www.google.com/s2/favicons?domain_url=${encodeURIComponent(
      parsed.origin,
    )}&sz=64`;
  } catch {
    return undefined;
  }
}
