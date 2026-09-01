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

/** Resolve a persisted icon value from an explicit choice or provider URLs. */
export function inferProviderIcon(
  explicitIcon?: string,
  apiUrl?: string,
  websiteUrl?: string,
): string | undefined {
  const explicit = explicitIcon?.trim();
  if (explicit) return explicit;

  const source = apiUrl?.trim() || websiteUrl?.trim();
  if (!source) return undefined;

  try {
    const parsed = new URL(source);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    if (parsed.hostname.toLowerCase().endsWith("sublyx.org")) {
      return "https://sublyx.org/favicon.ico";
    }
    return providerFaviconUrl(parsed.origin);
  } catch {
    return undefined;
  }
}

export function inferProviderIconFromConfig(
  explicitIcon: string | undefined,
  settingsConfig: unknown,
  websiteUrl?: string,
): string | undefined {
  if (typeof settingsConfig === "string") {
    try {
      return inferProviderIconFromConfig(
        explicitIcon,
        JSON.parse(settingsConfig),
        websiteUrl,
      );
    } catch {
      return inferProviderIcon(explicitIcon, undefined, websiteUrl);
    }
  }
  const urls: string[] = [];
  const visit = (value: unknown, key = "") => {
    if (typeof value === "string") {
      if (/(base.?url|api.?url|endpoint)/i.test(key)) {
        if (/^https?:\/\//i.test(value.trim())) urls.push(value);
      } else if (key === "config") {
        const match = value.match(/base_url\s*=\s*"([^"]+)"/i);
        if (match?.[1]) urls.push(match[1]);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, key));
      return;
    }
    if (value && typeof value === "object") {
      Object.entries(value as Record<string, unknown>).forEach(
        ([childKey, childValue]) => visit(childValue, childKey),
      );
    }
  };
  visit(settingsConfig);
  return inferProviderIcon(explicitIcon, urls[0], websiteUrl);
}
