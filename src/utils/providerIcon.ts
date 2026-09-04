import type { AppId } from "@/lib/api/types";

const PROVIDER_ICON_DOMAINS: ReadonlyArray<readonly [string, string]> = [
  ["sublyx.org", "sublyx"],
  ["openrouter.ai", "openrouter"],
  ["anthropic.com", "anthropic"],
  ["openai.com", "openai"],
  ["deepseek.com", "deepseek"],
  ["siliconflow.cn", "siliconflow"],
  ["siliconflow.com", "siliconflow"],
  ["googleapis.com", "gemini"],
];

const PROVIDER_ICON_NAMES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bsublyx\b/i, "sublyx"],
  [/\bopenrouter\b/i, "openrouter"],
  [/\banthropic\b/i, "anthropic"],
  [/\bopenai\b/i, "openai"],
  [/\bdeepseek\b/i, "deepseek"],
  [/\bsilicon\s*flow\b/i, "siliconflow"],
];

function knownProviderIcon(url?: string): string | undefined {
  if (!url?.trim()) return undefined;
  try {
    const hostname = new URL(url.trim()).hostname.toLowerCase();
    return PROVIDER_ICON_DOMAINS.find(
      ([domain]) => hostname === domain || hostname.endsWith(`.${domain}`),
    )?.[1];
  } catch {
    return undefined;
  }
}

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

/** Resolve a persisted icon value from an explicit choice or provider URLs. */
export function inferProviderIcon(
  explicitIcon?: string,
  apiUrl?: string,
  websiteUrl?: string,
  providerName?: string,
): string | undefined {
  const explicit = explicitIcon?.trim();
  if (explicit) {
    if (/^https:\/\/sublyx\.org\/favicon\.ico(?:[?#].*)?$/i.test(explicit)) {
      return "sublyx";
    }
    return explicit;
  }

  const knownIcon = knownProviderIcon(apiUrl) ?? knownProviderIcon(websiteUrl);
  if (knownIcon) return knownIcon;

  const iconFromName = providerName
    ? PROVIDER_ICON_NAMES.find(([pattern]) => pattern.test(providerName))?.[1]
    : undefined;
  if (iconFromName) return iconFromName;

  return undefined;
}

export function inferProviderIconFromConfig(
  explicitIcon: string | undefined,
  settingsConfig: unknown,
  websiteUrl?: string,
  providerName?: string,
): string | undefined {
  if (typeof settingsConfig === "string") {
    try {
      return inferProviderIconFromConfig(
        explicitIcon,
        JSON.parse(settingsConfig),
        websiteUrl,
        providerName,
      );
    } catch {
      return inferProviderIcon(
        explicitIcon,
        undefined,
        websiteUrl,
        providerName,
      );
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
  return inferProviderIcon(explicitIcon, urls[0], websiteUrl, providerName);
}

/** Shared display resolution for provider forms, cards, and legacy records. */
export function resolveProviderDisplayIcon(
  appId: AppId,
  provider: {
    icon?: string;
    iconColor?: string;
    settingsConfig?: unknown;
    websiteUrl?: string;
    name: string;
  },
): string | undefined {
  return inferProviderIconFromConfig(
    resolveProviderIcon(appId, provider.icon, provider.iconColor),
    provider.settingsConfig,
    provider.websiteUrl,
    provider.name,
  );
}
