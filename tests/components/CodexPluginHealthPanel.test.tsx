import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CodexPluginHealthPanel } from "@/components/settings/CodexPluginHealthPanel";
import { settingsApi } from "@/lib/api/settings";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/api/settings", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/api/settings")>(
      "@/lib/api/settings",
    );
  return {
    ...actual,
    settingsApi: {
      ...actual.settingsApi,
      inspectCodexPluginHealth: vi.fn(),
      repairCodexPluginRegistration: vi.fn(),
      openExternal: vi.fn(),
    },
  };
});

const inspectMock = vi.mocked(settingsApi.inspectCodexPluginHealth);
const openExternalMock = vi.mocked(settingsApi.openExternal);

describe("CodexPluginHealthPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    inspectMock.mockResolvedValue({
      repairablePlugins: [],
      browser: {
        pluginInstalled: true,
        pluginEnabled: true,
        browserFamily: "brave",
        browserName: "Brave Browser",
        browserInstalled: true,
        browserRunning: true,
        extensionInstalled: false,
        extensionEnabled: false,
        nativeHostCorrect: false,
        storeUrl: "https://chromewebstore.google.com/example",
        extensionManagementUrl: "brave://extensions",
        problems: ["browserExtensionMissing", "nativeHostMissing"],
      },
    });
  });

  it("shows the actual Brave extension and native-host failures", async () => {
    render(<CodexPluginHealthPanel />);

    expect(await screen.findByText("Brave Browser")).toBeInTheDocument();
    expect(
      screen.getByText(
        "settings.codexPluginHealth.problems.browserExtensionMissing",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("settings.codexPluginHealth.problems.nativeHostMissing"),
    ).toBeInTheDocument();
  });

  it("opens the configured extension store from the explicit action", async () => {
    render(<CodexPluginHealthPanel />);

    fireEvent.click(
      await screen.findByText("settings.codexPluginHealth.openExtensionStore"),
    );

    await waitFor(() =>
      expect(openExternalMock).toHaveBeenCalledWith(
        "https://chromewebstore.google.com/example",
      ),
    );
  });
});
