import { describe, expect, it, vi } from "vitest";
import {
  normalizeSettingsTab,
  OPEN_SETTINGS_TAB_EVENT,
  openSettingsTab,
  SETTINGS_TABS,
} from "@/lib/settingsNavigation";

describe("settings navigation", () => {
  it.each(SETTINGS_TABS)("preserves the valid %s destination", (tab) => {
    expect(normalizeSettingsTab(tab)).toBe(tab);
  });

  it("keeps legacy proxy links on the Connections page", () => {
    expect(normalizeSettingsTab("proxy")).toBe("connections");
  });

  it.each([undefined, null, "", "unknown", "__proto__", 1, {}])(
    "fails closed to General for an invalid tab %#",
    (tab) => {
      expect(normalizeSettingsTab(tab)).toBe("general");
    },
  );

  it("dispatches every request, including repeated destinations", () => {
    const listener = vi.fn();
    window.addEventListener(OPEN_SETTINGS_TAB_EVENT, listener);
    try {
      openSettingsTab("connections");
      openSettingsTab("connections");
      openSettingsTab("proxy");
      expect(listener).toHaveBeenCalledTimes(3);
      for (const [event] of listener.mock.calls) {
        expect((event as CustomEvent).detail).toEqual({ tab: "connections" });
      }
    } finally {
      window.removeEventListener(OPEN_SETTINGS_TAB_EVENT, listener);
    }
  });
});
