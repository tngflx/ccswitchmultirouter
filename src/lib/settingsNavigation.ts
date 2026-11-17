export const OPEN_SETTINGS_TAB_EVENT = "cc-switch:open-settings-tab";

export const SETTINGS_TABS = [
  "general",
  "connections",
  "auth",
  "advanced",
  "about",
  "usage",
  "request-health",
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number];

/** Validate UI and external deep links, including the pre-Connections alias. */
export function normalizeSettingsTab(tab: unknown): SettingsTab {
  if (tab === "proxy") return "connections";
  return SETTINGS_TABS.includes(tab as SettingsTab)
    ? (tab as SettingsTab)
    : "general";
}

export function openSettingsTab(tab: SettingsTab | "proxy"): void {
  window.dispatchEvent(
    new CustomEvent(OPEN_SETTINGS_TAB_EVENT, {
      detail: { tab: normalizeSettingsTab(tab) },
    }),
  );
}
