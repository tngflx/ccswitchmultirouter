import type { PropsWithChildren } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSettings } from "@/hooks/useSettings";
import { settingsApi } from "@/lib/api";
import type { Settings } from "@/types";
import type { RequestHealthConfig } from "@/types/proxy";
import { getSettings, setSettings } from "../msw/state";
import { createTestQueryClient } from "../utils/testQueryClient";

const requestHealthConfig: RequestHealthConfig = {
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useSettings persistence", () => {
  it("patches explicit stream retry changes without saving a stale settings snapshot", async () => {
    setSettings({
      claudeConfigDir: "/persisted/claude",
      enableStreamRetry: true,
      streamRetryMode: "safe",
      streamRetryMaxAttempts: 3,
    });
    const patch = vi.spyOn(settingsApi, "patch");
    const fullSave = vi.spyOn(settingsApi, "save");
    const client = createTestQueryClient();
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result, unmount } = renderHook(() => useSettings(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    act(() => {
      result.current.updateSettings({ claudeConfigDir: "/draft/claude" });
    });

    const retryPatch = {
      enableStreamRetry: true,
      streamRetryMode: "aggressive" as const,
      streamRetryMaxAttempts: 2,
    };
    await act(async () => {
      await result.current.autoSaveSettings(retryPatch);
    });

    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith(retryPatch);
    expect(fullSave).not.toHaveBeenCalled();
    expect(getSettings()).toMatchObject(retryPatch);
    expect(client.getQueryData<Settings>(["settings"])).toMatchObject(
      retryPatch,
    );
    await waitFor(() =>
      expect(result.current.settings).toMatchObject(retryPatch),
    );
    expect(result.current.settings?.claudeConfigDir).toBe("/draft/claude");
    expect(getSettings().claudeConfigDir).toBe("/persisted/claude");
    unmount();
    client.clear();
  });

  it("preserves a header retry patch through stale General and manual saves", async () => {
    setSettings({
      enableStreamRetry: true,
      streamRetryMode: "safe",
      streamRetryMaxAttempts: 3,
    });
    const client = createTestQueryClient();
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result, unmount } = renderHook(() => useSettings(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // The header writes a patch while this Settings form still has Safe.
    const retryPatch = {
      enableStreamRetry: true,
      streamRetryMode: "aggressive" as const,
      streamRetryMaxAttempts: 2,
    };
    await settingsApi.patch(retryPatch);
    await act(async () => {
      await result.current.autoSaveSettings({ showInTray: false });
      await result.current.saveSettings(undefined, { silent: true });
    });

    expect(getSettings()).toMatchObject(retryPatch);
    expect(result.current.settings).toMatchObject(retryPatch);
    unmount();
    client.clear();
  });

  it.each(["auto", "manual"] as const)(
    "patches only explicit retry keys in mixed %s saves",
    async (saveKind) => {
      setSettings({
        enableStreamRetry: true,
        streamRetryMode: "aggressive",
        streamRetryMaxAttempts: 3,
      });
      const patch = vi.spyOn(settingsApi, "patch");
      const fullSave = vi.spyOn(settingsApi, "save");
      const client = createTestQueryClient();
      const wrapper = ({ children }: PropsWithChildren) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      );
      const { result, unmount } = renderHook(() => useSettings(), { wrapper });
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        const updates = { streamRetryMaxAttempts: 1, showInTray: false };
        if (saveKind === "auto") {
          await result.current.autoSaveSettings(updates);
        } else {
          await result.current.saveSettings(updates, { silent: true });
        }
      });

      expect(patch).toHaveBeenCalledTimes(1);
      expect(patch).toHaveBeenCalledWith({ streamRetryMaxAttempts: 1 });
      expect(fullSave).toHaveBeenCalledTimes(1);
      expect(getSettings()).toMatchObject({
        enableStreamRetry: true,
        streamRetryMode: "aggressive",
        streamRetryMaxAttempts: 1,
        showInTray: false,
      });
      unmount();
      client.clear();
    },
  );

  it("does not publish retry or unrelated settings when a retry patch fails", async () => {
    setSettings({
      showInTray: true,
      enableStreamRetry: true,
      streamRetryMode: "safe",
      streamRetryMaxAttempts: 3,
    });
    vi.spyOn(settingsApi, "patch").mockRejectedValueOnce(
      new Error("retry patch failed"),
    );
    const fullSave = vi.spyOn(settingsApi, "save");
    const client = createTestQueryClient();
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result, unmount } = renderHook(() => useSettings(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await expect(
        result.current.autoSaveSettings({
          streamRetryMode: "aggressive",
          showInTray: false,
        }),
      ).rejects.toThrow("retry patch failed");
    });

    expect(fullSave).not.toHaveBeenCalled();
    expect(getSettings()).toMatchObject({
      showInTray: true,
      streamRetryMode: "safe",
      streamRetryMaxAttempts: 3,
    });
    expect(client.getQueryData<Settings>(["settings"])?.streamRetryMode).toBe(
      "safe",
    );
    unmount();
    client.clear();
  });

  it("acknowledges a durable master switch save before queued General saves", async () => {
    setSettings({
      claudeConfigDir: "/persisted/claude",
      requestHealth: requestHealthConfig,
    });
    let finishSave!: (config: RequestHealthConfig) => void;
    const saveEnabled = vi
      .spyOn(settingsApi, "setRequestHealthEnabled")
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            finishSave = (config) => {
              setSettings({ requestHealth: config });
              resolve(config);
            };
          }),
      );
    const generalSave = vi.spyOn(settingsApi, "save");
    const client = createTestQueryClient();
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result, unmount } = renderHook(() => useSettings(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    act(() => {
      result.current.updateSettings({ claudeConfigDir: "/draft/claude" });
    });

    let enabledSave!: Promise<RequestHealthConfig>;
    let queuedSave!: ReturnType<typeof result.current.autoSaveSettings>;
    act(() => {
      enabledSave = result.current.setRequestHealthEnabled(false);
      queuedSave = result.current.autoSaveSettings({ showInTray: false });
    });
    await waitFor(() => expect(saveEnabled).toHaveBeenCalledWith(false));
    expect(generalSave).not.toHaveBeenCalled();
    const canonical = {
      ...requestHealthConfig,
      enabled: false,
      windowsNotificationsSnoozedUntilMs: 123_456_789,
    };
    await act(async () => {
      finishSave(canonical);
      await enabledSave;
      await queuedSave;
    });

    expect(client.getQueryData<Settings>(["settings"])?.requestHealth).toEqual(
      canonical,
    );
    expect(generalSave).toHaveBeenCalledWith(
      expect.objectContaining({
        claudeConfigDir: "/persisted/claude",
        requestHealth: canonical,
      }),
    );
    expect(result.current.settings?.claudeConfigDir).toBe("/draft/claude");
    await waitFor(() =>
      expect(result.current.settings?.requestHealth).toEqual(canonical),
    );
    expect(getSettings().requestHealth).toEqual(canonical);
    unmount();
    client.clear();

    const reloaded = renderHook(() => useSettings(), { wrapper });
    await waitFor(() => expect(reloaded.result.current.isLoading).toBe(false));
    expect(reloaded.result.current.settings?.requestHealth?.enabled).toBe(
      false,
    );
    reloaded.unmount();
    client.clear();
  });

  it("acknowledges full Request Health saves without publishing Advanced drafts", async () => {
    setSettings({
      claudeConfigDir: "/persisted/claude",
      requestHealth: requestHealthConfig,
    });
    const generalSave = vi.spyOn(settingsApi, "save");
    const client = createTestQueryClient();
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result, unmount } = renderHook(() => useSettings(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    act(() => {
      result.current.updateSettings({ claudeConfigDir: "/draft/claude" });
    });
    const edited = {
      ...requestHealthConfig,
      largeRequestThresholdBytes: 512 * 1024,
    };
    await act(async () => {
      await result.current.saveRequestHealthSettings(edited);
    });

    expect(client.getQueryData<Settings>(["settings"])?.requestHealth).toEqual(
      edited,
    );
    expect(result.current.settings?.claudeConfigDir).toBe("/draft/claude");
    expect(getSettings().claudeConfigDir).toBe("/persisted/claude");
    expect(generalSave).not.toHaveBeenCalled();
    unmount();
    client.clear();
  });

  it("does not acknowledge a rejected master switch save", async () => {
    setSettings({
      claudeConfigDir: "/persisted/claude",
      requestHealth: requestHealthConfig,
    });
    vi.spyOn(settingsApi, "setRequestHealthEnabled").mockRejectedValue(
      new Error("persistence failed"),
    );
    const client = createTestQueryClient();
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result, unmount } = renderHook(() => useSettings(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    act(() => {
      result.current.updateSettings({ claudeConfigDir: "/draft/claude" });
    });
    await act(async () => {
      await expect(
        result.current.setRequestHealthEnabled(false),
      ).rejects.toThrow("persistence failed");
    });

    expect(client.getQueryData<Settings>(["settings"])?.requestHealth).toEqual(
      requestHealthConfig,
    );
    expect(result.current.settings?.requestHealth).toEqual(requestHealthConfig);
    expect(result.current.settings?.claudeConfigDir).toBe("/draft/claude");
    unmount();
    client.clear();
  });

  it("keeps Advanced directory edits local through a General autosave and syncs them on manual save", async () => {
    window.localStorage.clear();
    setSettings({
      claudeConfigDir: "/persisted/claude",
      codexConfigDir: "/persisted/codex",
    });
    const syncLive = vi
      .spyOn(settingsApi, "syncCurrentProvidersLive")
      .mockResolvedValue(undefined);
    const client = createTestQueryClient();
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result, unmount } = renderHook(() => useSettings(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      result.current.updateSettings({
        claudeConfigDir: "/draft/claude",
        codexConfigDir: "/draft/codex",
      });
    });
    await act(async () => {
      result.current.updateSettings({ minimizeToTrayOnClose: false });
      await result.current.autoSaveSettings({ minimizeToTrayOnClose: false });
    });

    expect(getSettings().minimizeToTrayOnClose).toBe(false);
    expect(getSettings().claudeConfigDir).toBe("/persisted/claude");
    expect(getSettings().codexConfigDir).toBe("/persisted/codex");
    expect(client.getQueryData<Settings>(["settings"])?.claudeConfigDir).toBe(
      "/persisted/claude",
    );
    expect(result.current.settings?.claudeConfigDir).toBe("/draft/claude");
    expect(result.current.settings?.codexConfigDir).toBe("/draft/codex");
    expect(result.current.settings?.minimizeToTrayOnClose).toBe(false);
    expect(syncLive).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.saveSettings(undefined, { silent: true });
    });

    expect(getSettings().claudeConfigDir).toBe("/draft/claude");
    expect(getSettings().codexConfigDir).toBe("/draft/codex");
    expect(syncLive).toHaveBeenCalledTimes(1);
    unmount();
    client.clear();
  });
});
