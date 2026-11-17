import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { SettingsFormState } from "@/hooks/useSettings";
import { WindowSettings } from "./WindowSettings";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const baseSettings = (watchdogEnabled?: boolean) =>
  ({
    launchOnStartup: false,
    watchdogEnabled,
    launchCodexDesktopWithCcswitch: false,
    silentStartup: false,
    enableClaudePluginIntegration: false,
    skipClaudeOnboarding: false,
    minimizeToTrayOnClose: true,
    useAppWindowControls: false,
  }) as SettingsFormState;

describe("WindowSettings", () => {
  it("keeps window behavior separate from the canonical crash recovery control", () => {
    render(<WindowSettings settings={baseSettings(true)} onChange={vi.fn()} />);

    expect(
      screen.queryByRole("switch", { name: "settings.watchdogEnabled" }),
    ).toBeNull();
    expect(
      screen.getByRole("switch", { name: "settings.launchOnStartup" }),
    ).toHaveAttribute("aria-checked", "false");
    expect(
      screen.getByRole("switch", { name: "settings.minimizeToTray" }),
    ).toHaveAttribute("aria-checked", "true");
  });

  it("preserves the existing window behavior updates", () => {
    const onChange = vi.fn();
    render(
      <WindowSettings settings={baseSettings(false)} onChange={onChange} />,
    );

    fireEvent.click(
      screen.getByRole("switch", { name: "settings.minimizeToTray" }),
    );

    expect(onChange).toHaveBeenCalledWith({ minimizeToTrayOnClose: false });
  });
});
