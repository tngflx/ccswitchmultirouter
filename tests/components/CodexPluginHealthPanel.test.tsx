import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CodexPluginHealthPanel } from "@/components/settings/CodexPluginHealthPanel";
import { settingsApi } from "@/lib/api/settings";
import type { CodexPluginHealthReport } from "@/lib/api/settings";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/api/settings", () => ({
  settingsApi: {
    inspectCodexPluginHealth: vi.fn(),
    repairCodexPluginRegistration: vi.fn(),
    openExternal: vi.fn(),
  },
}));

const report: CodexPluginHealthReport = {
  browser: {
    pluginInstalled: true,
    pluginEnabled: true,
    browserFamily: "chrome",
    browserName: "Google Chrome",
    browserInstalled: true,
    browserRunning: true,
    extensionInstalled: false,
    extensionEnabled: false,
    nativeHostCorrect: false,
    storeUrl: "https://example.test/chrome-store",
    extensionManagementUrl: "chrome://extensions",
    problems: ["browserExtensionMissing", "nativeHostMissing"],
  },
  repairablePlugins: [
    {
      id: "example-plugin",
      name: "Example plugin",
      version: "1.0.0",
      manifestPath: "C:/plugins/example/manifest.json",
      sourcePath: "C:/plugins/example",
      marketplacePath: "C:/plugins/marketplace.json",
      repairAction: "registerMarketplace",
    },
  ],
};

describe("CodexPluginHealthPanel", () => {
  beforeEach(() => {
    vi.mocked(settingsApi.inspectCodexPluginHealth).mockReset();
    vi.mocked(settingsApi.repairCodexPluginRegistration).mockReset();
    vi.mocked(settingsApi.openExternal).mockReset();
  });

  it("renders browser diagnostics and offers the extension store", async () => {
    vi.mocked(settingsApi.inspectCodexPluginHealth).mockResolvedValue(report);

    render(<CodexPluginHealthPanel />);

    expect(
      screen.getByText("settings.codexPluginHealth.loading"),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByText("settings.codexPluginHealth.browserExtension"),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByText(
        "settings.codexPluginHealth.problems.browserExtensionMissing",
      ),
    ).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", {
        name: "settings.codexPluginHealth.openExtensionStore",
      }),
    );
    expect(settingsApi.openExternal).toHaveBeenCalledWith(
      "https://example.test/chrome-store",
    );
  });

  it("repairs a personal plugin and refreshes the report", async () => {
    const repaired = report.repairablePlugins[0];
    vi.mocked(settingsApi.inspectCodexPluginHealth)
      .mockResolvedValueOnce(report)
      .mockResolvedValueOnce({ ...report, repairablePlugins: [] });
    vi.mocked(settingsApi.repairCodexPluginRegistration).mockResolvedValue(
      repaired,
    );

    const user = userEvent.setup();
    render(<CodexPluginHealthPanel />);

    await user.click(
      await screen.findByRole("button", {
        name: "settings.codexPluginHealth.repair",
      }),
    );

    await waitFor(() =>
      expect(settingsApi.repairCodexPluginRegistration).toHaveBeenCalledWith(
        "example-plugin",
      ),
    );
    await waitFor(() =>
      expect(settingsApi.inspectCodexPluginHealth).toHaveBeenCalledTimes(2),
    );
  });
});
