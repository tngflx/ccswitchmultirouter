import type { PropsWithChildren } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSettings } from "@/hooks/useSettings";
import { settingsApi } from "@/lib/api";
import type { Settings } from "@/types";
import { getSettings, setSettings } from "../msw/state";
import { createTestQueryClient } from "../utils/testQueryClient";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useSettings persistence", () => {
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
