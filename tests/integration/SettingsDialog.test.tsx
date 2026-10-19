import React, { Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { SettingsPage } from "@/components/settings/SettingsPage";
import type { Settings } from "@/types";
import type { RequestHealthConfig } from "@/types/proxy";
import {
  resetProviderState,
  getSettings,
  setSettings,
  getAppConfigDirOverride,
} from "../msw/state";
import { server } from "../msw/server";

const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: any) =>
    open ? <div data-testid="dialog-root">{children}</div> : null,
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogFooter: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
  DialogDescription: ({ children }: any) => <div>{children}</div>,
}));

const TabsContext = React.createContext<{
  value: string;
  onValueChange?: (value: string) => void;
}>({
  value: "general",
});

vi.mock("@/components/ui/tabs", () => {
  return {
    Tabs: ({ value, onValueChange, children }: any) => (
      <TabsContext.Provider value={{ value, onValueChange }}>
        {children}
      </TabsContext.Provider>
    ),
    TabsList: ({ children }: any) => <div>{children}</div>,
    TabsTrigger: ({ value, children }: any) => {
      const ctx = React.useContext(TabsContext);
      return (
        <button type="button" onClick={() => ctx.onValueChange?.(value)}>
          {children}
        </button>
      );
    },
    TabsContent: ({ value, children }: any) => {
      const ctx = React.useContext(TabsContext);
      return ctx.value === value ? (
        <div data-testid={`tab-${value}`}>{children}</div>
      ) : null;
    },
  };
});

vi.mock("@/components/settings/LanguageSettings", () => ({
  LanguageSettings: ({ value, onChange }: any) => (
    <div>
      <span>language:{value}</span>
      <button onClick={() => onChange("en")}>change-language</button>
    </div>
  ),
}));

vi.mock("@/components/settings/ThemeSettings", () => ({
  ThemeSettings: () => <div data-testid="theme-settings">theme</div>,
}));

vi.mock("@/components/settings/WindowSettings", () => ({
  WindowSettings: ({ onChange }: any) => (
    <button onClick={() => onChange({ minimizeToTrayOnClose: false })}>
      window-settings
    </button>
  ),
}));

vi.mock("@/components/settings/DirectorySettings", async () => {
  const actual = await vi.importActual<
    typeof import("@/components/settings/DirectorySettings")
  >("@/components/settings/DirectorySettings");
  return actual;
});

vi.mock("@/components/settings/ImportExportSection", () => ({
  ImportExportSection: ({
    status,
    selectedFile,
    errorMessage,
    isImporting,
    onSelectFile,
    onImport,
    onExport,
    onClear,
  }: any) => (
    <div>
      <div data-testid="import-status">{status}</div>
      <div data-testid="selected-file">{selectedFile || "none"}</div>
      <button onClick={onSelectFile}>settings.selectConfigFile</button>
      <button onClick={onImport} disabled={!selectedFile || isImporting}>
        {isImporting ? "settings.importing" : "settings.import"}
      </button>
      <button onClick={onExport}>settings.exportConfig</button>
      <button onClick={onClear}>common.clear</button>
      {errorMessage ? <span>{errorMessage}</span> : null}
    </div>
  ),
}));

vi.mock("@/components/settings/AboutSection", () => ({
  AboutSection: ({ isPortable }: any) => <div>about:{String(isPortable)}</div>,
}));

const renderDialog = (
  props?: Partial<React.ComponentProps<typeof SettingsPage>>,
) => {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <Suspense fallback={<div data-testid="loading">loading</div>}>
        <SettingsPage open onOpenChange={() => {}} {...props} />
      </Suspense>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  resetProviderState();
  toastSuccessMock.mockReset();
  toastErrorMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SettingsPage integration", () => {
  it("loads default settings from MSW", async () => {
    renderDialog();

    await waitFor(() =>
      expect(screen.getByText("language:zh")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText("settings.tabAdvanced"));
    fireEvent.click(screen.getByText("settings.advanced.configDir.title"));
    const appInput = await screen.findByPlaceholderText(
      "settings.browsePlaceholderApp",
    );
    expect((appInput as HTMLInputElement).value).toBe("/home/mock/.cc-switch");
  });

  it("imports configuration and triggers success callback", async () => {
    const onImportSuccess = vi.fn();
    renderDialog({ onImportSuccess });

    await waitFor(() =>
      expect(screen.getByText("language:zh")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByText("settings.tabAdvanced"));
    fireEvent.click(screen.getByText("settings.advanced.data.title"));
    fireEvent.click(screen.getByText("settings.selectConfigFile"));
    await waitFor(() =>
      expect(screen.getByTestId("selected-file").textContent).toContain(
        "/mock/import-settings.json",
      ),
    );

    fireEvent.click(screen.getByText("settings.import"));
    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalled());
    await waitFor(() => expect(onImportSuccess).toHaveBeenCalled(), {
      timeout: 4000,
    });
    expect(getSettings().language).toBe("en");
  });

  it("saves settings and handles restart prompt", async () => {
    renderDialog();

    await waitFor(() =>
      expect(screen.getByText("language:zh")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByText("settings.tabAdvanced"));
    fireEvent.click(screen.getByText("settings.advanced.configDir.title"));
    const appInput = await screen.findByPlaceholderText(
      "settings.browsePlaceholderApp",
    );
    fireEvent.change(appInput, { target: { value: "/custom/app" } });
    fireEvent.click(screen.getByText("common.save"));

    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalled());
    await screen.findByText("settings.restartRequired");
    fireEvent.click(screen.getByText("settings.restartLater"));
    await waitFor(() =>
      expect(
        screen.queryByText("settings.restartRequired"),
      ).not.toBeInTheDocument(),
    );

    expect(getAppConfigDirOverride()).toBe("/custom/app");
  });

  it("allows browsing and resetting directories", async () => {
    renderDialog();

    await waitFor(() =>
      expect(screen.getByText("language:zh")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByText("settings.tabAdvanced"));
    fireEvent.click(screen.getByText("settings.advanced.configDir.title"));

    const browseButtons = screen.getAllByTitle("settings.browseDirectory");
    const resetButtons = screen.getAllByTitle("settings.resetDefault");

    const appInput = (await screen.findByPlaceholderText(
      "settings.browsePlaceholderApp",
    )) as HTMLInputElement;
    expect(appInput.value).toBe("/home/mock/.cc-switch");

    fireEvent.click(browseButtons[0]);
    await waitFor(() =>
      expect(appInput.value).toBe("/home/mock/.cc-switch/picked"),
    );

    fireEvent.click(resetButtons[0]);
    await waitFor(() => expect(appInput.value).toBe("/home/mock/.cc-switch"));

    const claudeInput = (await screen.findByPlaceholderText(
      "settings.browsePlaceholderClaude",
    )) as HTMLInputElement;
    fireEvent.change(claudeInput, { target: { value: "/custom/claude" } });
    await waitFor(() => expect(claudeInput.value).toBe("/custom/claude"));

    fireEvent.click(browseButtons[1]);
    await waitFor(() =>
      expect(claudeInput.value).toBe("/custom/claude/picked"),
    );

    fireEvent.click(resetButtons[1]);
    await waitFor(() => expect(claudeInput.value).toBe("/home/mock/.claude"));
  });

  it("adopts canonical Request Health saves without discarding unsaved Advanced edits", async () => {
    const config: RequestHealthConfig = {
      enabled: true,
      optimizationMode: "diagnose",
      largeRequestThresholdBytes: 384 * 1024,
      maxCodexInputTokens: 200_000,
      reviewTimeoutSeconds: 60,
      reviewMode: "off",
      summarizeAndRestartEnabled: false,
      windowsNotificationsEnabled: false,
      windowsNotificationSnoozeHours: 4,
      windowsNotificationsSnoozedUntilMs: null,
    };
    setSettings({ requestHealth: config });
    const saveRequestHealth = vi.fn();
    const fullSave = vi.fn();
    const snoozedUntil = 123_456_789;
    server.use(
      http.post("http://tauri.local/get_request_health_diagnostics", () =>
        HttpResponse.json({
          config: getSettings().requestHealth,
          diagnostics: [],
        }),
      ),
      http.post(
        "http://tauri.local/save_request_health_settings",
        async ({ request }) => {
          const { config: submitted } = (await request.json()) as {
            config: RequestHealthConfig;
          };
          saveRequestHealth(submitted);
          const canonical = {
            ...submitted,
            windowsNotificationsSnoozedUntilMs: snoozedUntil,
          };
          setSettings({ requestHealth: canonical });
          return HttpResponse.json(canonical);
        },
      ),
      http.post("http://tauri.local/save_settings", async ({ request }) => {
        const { settings } = (await request.json()) as { settings: Settings };
        fullSave(settings);
        setSettings({
          ...settings,
          requestHealth: getSettings().requestHealth,
        });
        return HttpResponse.json(true);
      }),
    );
    renderDialog();
    await screen.findByText("language:zh");
    fireEvent.click(screen.getByText("settings.tabAdvanced"));
    fireEvent.click(screen.getByText("settings.advanced.configDir.title"));
    const initialInput = await screen.findByPlaceholderText(
      "settings.browsePlaceholderClaude",
    );
    fireEvent.change(initialInput, {
      target: { value: "/unsaved/claude-directory" },
    });

    fireEvent.click(screen.getByText("settings.tabRequestHealthSettings"));
    const threshold = await screen.findByRole("spinbutton", {
      name: "settings.requestHealth.threshold",
    });
    fireEvent.change(threshold, { target: { value: "512" } });
    fireEvent.click(
      screen.getByRole("button", { name: "settings.requestHealth.save" }),
    );
    await waitFor(() => expect(saveRequestHealth).toHaveBeenCalledOnce());
    await screen.findByText("settings.requestHealth.saved");
    expect(fullSave).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("settings.tabAdvanced"));
    fireEvent.click(screen.getByText("settings.advanced.configDir.title"));
    const preservedInput = await screen.findByPlaceholderText(
      "settings.browsePlaceholderClaude",
    );
    expect(preservedInput).toHaveValue("/unsaved/claude-directory");
    fireEvent.click(screen.getByText("common.save"));
    await waitFor(() => expect(fullSave).toHaveBeenCalledOnce());
    expect(fullSave).toHaveBeenCalledWith(
      expect.objectContaining({
        claudeConfigDir: "/unsaved/claude-directory",
        requestHealth: expect.objectContaining({
          largeRequestThresholdBytes: 512 * 1024,
          windowsNotificationsSnoozedUntilMs: snoozedUntil,
        }),
      }),
    );
  });

  it("acknowledges disabled Request Health before an unrelated General autosave", async () => {
    const config: RequestHealthConfig = {
      enabled: true,
      optimizationMode: "safe",
      largeRequestThresholdBytes: 384 * 1024,
      maxCodexInputTokens: 200_000,
      reviewTimeoutSeconds: 60,
      reviewMode: "first_large_request",
      summarizeAndRestartEnabled: true,
      windowsNotificationsEnabled: true,
      windowsNotificationSnoozeHours: 4,
      windowsNotificationsSnoozedUntilMs: null,
    };
    setSettings({ requestHealth: config });
    const fullSave = vi.fn();
    server.use(
      http.post("http://tauri.local/get_request_health_diagnostics", () =>
        HttpResponse.json({
          config: getSettings().requestHealth,
          diagnostics: [],
        }),
      ),
      http.post("http://tauri.local/save_settings", async ({ request }) => {
        const { settings } = (await request.json()) as { settings: Settings };
        fullSave(settings);
        setSettings({
          ...settings,
          requestHealth: getSettings().requestHealth,
        });
        return HttpResponse.json(true);
      }),
    );
    const first = renderDialog();
    await screen.findByText("language:zh");
    fireEvent.click(screen.getByText("settings.tabRequestHealthSettings"));
    fireEvent.click(
      await screen.findByRole("checkbox", {
        name: "settings.requestHealth.enabled",
      }),
    );
    await screen.findByText("settings.requestHealth.saved");

    fireEvent.click(screen.getByText("settings.tabGeneral"));
    fireEvent.click(await screen.findByText("window-settings"));
    await waitFor(() => expect(fullSave).toHaveBeenCalledOnce());
    expect(fullSave).toHaveBeenCalledWith(
      expect.objectContaining({
        requestHealth: expect.objectContaining({ enabled: false }),
      }),
    );
    expect(getSettings().requestHealth?.enabled).toBe(false);

    first.unmount();
    renderDialog({ defaultTab: "request-health" });
    expect(
      await screen.findByRole("checkbox", {
        name: "settings.requestHealth.enabled",
      }),
    ).not.toBeChecked();
  });

  it("recovers from an initial Request Health load failure using Retry", async () => {
    let attempts = 0;
    server.use(
      http.post("http://tauri.local/get_request_health_diagnostics", () => {
        attempts += 1;
        if (attempts === 1) {
          return new HttpResponse("offline", { status: 503 });
        }
        return HttpResponse.json({
          config: {
            enabled: true,
            optimizationMode: "diagnose",
            largeRequestThresholdBytes: 384 * 1024,
            maxCodexInputTokens: 200_000,
            reviewTimeoutSeconds: 60,
            reviewMode: "off",
            summarizeAndRestartEnabled: false,
            windowsNotificationsEnabled: false,
            windowsNotificationSnoozeHours: 4,
            windowsNotificationsSnoozedUntilMs: null,
          } satisfies RequestHealthConfig,
          diagnostics: [],
        });
      }),
    );
    renderDialog({ defaultTab: "request-health" });
    await screen.findByText("settings.requestHealth.loadFailed");
    expect(
      screen.getByRole("button", { name: "settings.requestHealth.save" }),
    ).toBeDisabled();

    fireEvent.click(
      screen.getByRole("button", { name: "settings.requestHealth.retry" }),
    );
    await screen.findByRole("checkbox", {
      name: "settings.requestHealth.enabled",
    });
    expect(
      screen.getByRole("button", { name: "settings.requestHealth.save" }),
    ).toBeEnabled();
    expect(
      screen.queryByText("settings.requestHealth.loadFailed"),
    ).not.toBeInTheDocument();
    expect(attempts).toBe(2);
  });

  it("notifies when export fails", async () => {
    renderDialog();

    await waitFor(() =>
      expect(screen.getByText("language:zh")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText("settings.tabAdvanced"));
    fireEvent.click(screen.getByText("settings.advanced.data.title"));

    server.use(
      http.post("http://tauri.local/save_file_dialog", () =>
        HttpResponse.json(null),
      ),
    );
    fireEvent.click(screen.getByText("settings.exportConfig"));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
    const cancelMessage = toastErrorMock.mock.calls.at(-1)?.[0] as string;
    expect(cancelMessage).toMatch(
      /settings\.selectFileFailed|请选择.*保存路径/,
    );

    toastErrorMock.mockClear();

    server.use(
      http.post("http://tauri.local/save_file_dialog", () =>
        HttpResponse.json("/mock/export-settings.json"),
      ),
      http.post("http://tauri.local/export_config_to_file", () =>
        HttpResponse.json({ success: false, message: "disk-full" }),
      ),
    );

    fireEvent.click(screen.getByText("settings.exportConfig"));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
    const exportMessage = toastErrorMock.mock.calls.at(-1)?.[0] as string;
    expect(exportMessage).toContain("disk-full");
    expect(toastSuccessMock).not.toHaveBeenCalled();
  });
});
