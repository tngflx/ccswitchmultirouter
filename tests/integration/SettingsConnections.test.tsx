import { QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { ThemeProvider } from "@/components/theme-provider";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { ownerRemoteApi, type OwnerRemoteStatus } from "@/lib/api/ownerRemote";
import { watchdogApi } from "@/lib/api/watchdog";
import { settingsApi } from "@/lib/api/settings";
import { getSettings, setSettings } from "../msw/state";
import { server } from "../msw/server";
import { createTestQueryClient } from "../utils/testQueryClient";
import {
  createLocalizedTestI18n,
  testLocaleResources,
} from "../utils/localizedTestI18n";

vi.mock("@/lib/api/ownerRemote", () => ({
  ownerRemoteApi: {
    getStatus: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    createInvite: vi.fn(),
  },
}));
vi.mock("@/lib/api/watchdog", () => ({
  watchdogApi: { getStatus: vi.fn() },
}));

const remoteOff: OwnerRemoteStatus = {
  enabled: false,
  running: false,
  httpsOrigin: null,
  loopbackAddress: "127.0.0.1:15723",
};

async function mount(
  defaultTab = "general",
  language: "en" | "zh" | "zh-TW" | "ja" = "en",
) {
  setSettings({ language });
  const client = createTestQueryClient();
  const i18n = await createLocalizedTestI18n(language);
  const content = (tab: string, revision: number) => (
    <I18nextProvider i18n={i18n}>
      <ThemeProvider
        defaultTheme="light"
        storageKey="settings-connections-test-theme"
      >
        <QueryClientProvider client={client}>
          <SettingsPage
            open
            onOpenChange={vi.fn()}
            defaultTab={tab}
            navigationRevision={revision}
          />
        </QueryClientProvider>
      </ThemeProvider>
    </I18nextProvider>
  );
  const view = render(content(defaultTab, 0));
  return {
    ...view,
    navigate: (tab: string, revision: number) =>
      view.rerender(content(tab, revision)),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  server.use(
    http.post("http://tauri.local/set_window_theme", () =>
      HttpResponse.json(null),
    ),
  );
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
  setSettings({ language: "en", watchdogEnabled: true });
  vi.mocked(ownerRemoteApi.getStatus).mockResolvedValue(remoteOff);
  vi.mocked(ownerRemoteApi.stop).mockResolvedValue(remoteOff);
  vi.mocked(ownerRemoteApi.start).mockImplementation(async (httpsOrigin) => ({
    ...remoteOff,
    enabled: true,
    running: true,
    httpsOrigin,
  }));
  vi.mocked(watchdogApi.getStatus).mockImplementation(async () => ({
    enabled: getSettings().watchdogEnabled !== false,
    supervisorMode: "pnpm-dev",
    appPid: 100,
    supervisorPid: null,
    supervisorAlive: false,
    restartsInWindow: 0,
    port: 15721,
    portReady: true,
    portDiagnosis: "test harness",
    recentEvents: [],
  }));
});

describe("Settings connections and recovery", () => {
  it("makes the existing controls discoverable without mounting hidden runtime panels in General", async () => {
    await mount();
    const shortcut = await screen.findByRole("button", {
      name: /Remote connection & crash recovery/,
    });
    expect(screen.getAllByRole("tab")).toHaveLength(7);
    expect(
      screen.queryByRole("switch", {
        name: "Auto-recover from crashes (watchdog)",
      }),
    ).not.toBeInTheDocument();
    expect(ownerRemoteApi.getStatus).not.toHaveBeenCalled();
    expect(watchdogApi.getStatus).not.toHaveBeenCalled();

    fireEvent.click(shortcut);

    expect(
      await screen.findByRole("heading", { name: "Connections & recovery" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("switch", {
        name: "Remote connection (owner access)",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("switch", {
        name: "Auto-recover from crashes (watchdog)",
      }),
    ).toHaveLength(1);
    expect(
      screen.getByRole("tab", { name: "Connections & recovery" }),
    ).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("Dev supervisor")).toBeInTheDocument();
    expect(
      screen.getByText("Diagnostics").closest("details"),
    ).not.toHaveAttribute("open");
    expect(
      screen.queryByRole("button", { name: "Enable automatic monitoring" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: /Codex egress environment/ }),
    );
    expect(
      await screen.findByRole("button", {
        name: "Enable automatic monitoring",
      }),
    ).toBeInTheDocument();
  });

  it.each(["zh", "zh-TW", "ja"] as const)(
    "makes navigation and both independent switches discoverable in %s",
    async (language) => {
      const strings = testLocaleResources[language].translation.settings;
      await mount("general", language);
      const shortcut = await screen.findByRole("button", {
        name: (name) => name.startsWith(strings.connectionsShortcutTitle),
      });
      expect(screen.getAllByRole("tab")).toHaveLength(7);
      expect(ownerRemoteApi.getStatus).not.toHaveBeenCalled();
      expect(watchdogApi.getStatus).not.toHaveBeenCalled();

      fireEvent.click(shortcut);

      expect(
        await screen.findByRole("heading", {
          name: strings.tabConnectionsRecovery,
        }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("tab", { name: strings.tabConnectionsRecovery }),
      ).toHaveAttribute("aria-selected", "true");
      expect(
        await screen.findByRole("switch", { name: strings.ownerRemote.title }),
      ).toHaveAttribute("aria-checked", "false");
      expect(
        screen.getAllByRole("switch", { name: strings.watchdogEnabled }),
      ).toHaveLength(1);
      expect(
        screen.getByRole("switch", { name: strings.watchdogEnabled }),
      ).toHaveAttribute("aria-checked", "true");
      expect(
        screen.getByText(strings.crashRecoveryIndependent),
      ).toBeInTheDocument();
      expect(ownerRemoteApi.start).not.toHaveBeenCalled();
      expect(ownerRemoteApi.stop).not.toHaveBeenCalled();
    },
  );

  it.each(["connections", "proxy"])(
    "preserves %s settings deep links",
    async (defaultTab) => {
      await mount(defaultTab);
      expect(
        await screen.findByRole("heading", { name: "Connections & recovery" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("tab", { name: "Connections & recovery" }),
      ).toHaveAttribute("aria-selected", "true");
      expect(
        screen.getAllByRole("switch", {
          name: "Auto-recover from crashes (watchdog)",
        }),
      ).toHaveLength(1);
    },
  );

  it("reselects the same deep-link destination after an internal tab change", async () => {
    const view = await mount("connections");
    await screen.findByRole("heading", { name: "Connections & recovery" });
    fireEvent.mouseDown(screen.getByRole("tab", { name: "General" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(screen.getByRole("tab", { name: "General" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    view.navigate("connections", 1);

    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: "Connections & recovery" }),
      ).toHaveAttribute("aria-selected", "true"),
    );
  });

  it("falls back to General rather than showing an empty unknown tab", async () => {
    await mount("not-a-settings-tab");
    expect(
      await screen.findByRole("button", {
        name: /Remote connection & crash recovery/,
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "General" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(ownerRemoteApi.getStatus).not.toHaveBeenCalled();
    expect(watchdogApi.getStatus).not.toHaveBeenCalled();
  });

  it("persists both directions of the existing watchdog setting and refreshes native status without enabling remote access", async () => {
    const save = vi.spyOn(settingsApi, "save");
    await mount("connections");
    await screen.findByText("Dev supervisor");
    const toggle = screen.getByRole("switch", {
      name: "Auto-recover from crashes (watchdog)",
    });
    fireEvent.click(toggle);
    await waitFor(() => expect(getSettings().watchdogEnabled).toBe(false));
    await waitFor(() => expect(toggle).not.toBeDisabled());
    expect(await screen.findByText("Disabled")).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-checked", "false");

    fireEvent.click(toggle);
    await waitFor(() => expect(getSettings().watchdogEnabled).toBe(true));
    await waitFor(() => expect(toggle).not.toBeDisabled());
    expect(await screen.findByText("Dev supervisor")).toBeInTheDocument();
    expect(save).toHaveBeenCalledTimes(2);
    expect(ownerRemoteApi.start).not.toHaveBeenCalled();
    expect(ownerRemoteApi.stop).not.toHaveBeenCalled();
    save.mockRestore();
  });

  it("refreshes authoritative watchdog status after a pending save survives a tab round trip", async () => {
    let finishSave!: () => void;
    const pendingSave = new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    const persist = settingsApi.save;
    const save = vi
      .spyOn(settingsApi, "save")
      .mockImplementation(async (settings) => {
        await pendingSave;
        return persist(settings);
      });
    await mount("connections");
    await screen.findByText("Dev supervisor");
    fireEvent.click(
      screen.getByRole("switch", {
        name: "Auto-recover from crashes (watchdog)",
      }),
    );
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    fireEvent.mouseDown(screen.getByRole("tab", { name: "General" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(
      screen.queryByRole("switch", {
        name: "Auto-recover from crashes (watchdog)",
      }),
    ).toBeNull();
    fireEvent.mouseDown(
      screen.getByRole("tab", { name: "Connections & recovery" }),
      { button: 0, ctrlKey: false },
    );
    await screen.findByText("Dev supervisor");
    expect(getSettings().watchdogEnabled).toBe(true);
    expect(watchdogApi.getStatus).toHaveBeenCalledTimes(2);

    await act(async () => finishSave());

    await waitFor(() => expect(getSettings().watchdogEnabled).toBe(false));
    expect(await screen.findByText("Disabled")).toBeInTheDocument();
    expect(watchdogApi.getStatus).toHaveBeenCalledTimes(3);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("retains a pending watchdog save lock when its card remounts", async () => {
    let finishSave!: () => void;
    const pendingSave = new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    const persist = settingsApi.save;
    const save = vi
      .spyOn(settingsApi, "save")
      .mockImplementation(async (settings) => {
        await pendingSave;
        return persist(settings);
      });
    await mount("connections");
    await screen.findByText("Dev supervisor");
    fireEvent.click(
      screen.getByRole("switch", {
        name: "Auto-recover from crashes (watchdog)",
      }),
    );
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    fireEvent.mouseDown(screen.getByRole("tab", { name: "General" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.mouseDown(
      screen.getByRole("tab", { name: "Connections & recovery" }),
      { button: 0, ctrlKey: false },
    );
    const toggle = await screen.findByRole("switch", {
      name: "Auto-recover from crashes (watchdog)",
    });
    expect(toggle).toBeDisabled();
    expect(
      screen.getByText("Saving crash recovery setting…"),
    ).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(save).toHaveBeenCalledTimes(1);

    await act(async () => finishSave());

    await waitFor(() => expect(toggle).not.toBeDisabled());
    expect(await screen.findByText("Disabled")).toBeInTheDocument();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("preserves a failed watchdog save message across tab remounts", async () => {
    server.use(
      http.post(
        "http://tauri.local/save_settings",
        () => new HttpResponse("save unavailable", { status: 503 }),
      ),
    );
    await mount("connections");
    await screen.findByText("Dev supervisor");
    fireEvent.click(
      screen.getByRole("switch", {
        name: "Auto-recover from crashes (watchdog)",
      }),
    );
    await screen.findByText("Could not save crash recovery. Please try again.");

    fireEvent.mouseDown(screen.getByRole("tab", { name: "General" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.mouseDown(
      screen.getByRole("tab", { name: "Connections & recovery" }),
      { button: 0, ctrlKey: false },
    );

    expect(
      await screen.findByText(
        "Could not save crash recovery. Please try again.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("switch", {
        name: "Auto-recover from crashes (watchdog)",
      }),
    ).toHaveAttribute("aria-checked", "true");
    expect(getSettings().watchdogEnabled).toBe(true);
    expect(await screen.findByText("Dev supervisor")).toBeInTheDocument();
  });

  it("keeps remote start and stop separate from crash recovery persistence", async () => {
    const save = vi.spyOn(settingsApi, "save");
    await mount("connections");
    const remote = await screen.findByRole("switch", {
      name: "Remote connection (owner access)",
    });
    await waitFor(() =>
      expect(
        screen.getByLabelText("Exact HTTPS website origin"),
      ).not.toBeDisabled(),
    );
    expect(remote).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Exact HTTPS website origin"), {
      target: { value: "https://owner.test/" },
    });
    fireEvent.click(remote);
    await waitFor(() => expect(remote).toHaveAttribute("aria-checked", "true"));
    expect(ownerRemoteApi.start).toHaveBeenCalledTimes(1);
    expect(ownerRemoteApi.start).toHaveBeenCalledWith("https://owner.test");
    expect(getSettings().watchdogEnabled).toBe(true);
    fireEvent.click(remote);
    await waitFor(() =>
      expect(remote).toHaveAttribute("aria-checked", "false"),
    );
    expect(ownerRemoteApi.stop).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
    expect(ownerRemoteApi.createInvite).not.toHaveBeenCalled();
    save.mockRestore();
  });

  it.each(["start", "stop"] as const)(
    "publishes authoritative remote %s completion after a delayed IPC tab round trip",
    async (action) => {
      let finishDispatch!: () => void;
      const dispatch = new Promise<void>((resolve) => {
        finishDispatch = resolve;
      });
      let nativeStatus: OwnerRemoteStatus = {
        ...remoteOff,
        httpsOrigin: "https://owner.test",
        enabled: action === "stop",
        running: action === "stop",
      };
      vi.mocked(ownerRemoteApi.getStatus).mockImplementation(async () => ({
        ...nativeStatus,
      }));
      vi.mocked(ownerRemoteApi[action]).mockImplementation(async () => {
        // Before IPC dispatch, a status read may legitimately return the old snapshot.
        await dispatch;
        nativeStatus = {
          ...nativeStatus,
          enabled: action === "start",
          running: action === "start",
        };
        return { ...nativeStatus };
      });
      await mount("connections");
      await screen.findByText(action === "start" ? "Off" : "Listening locally");
      fireEvent.click(
        screen.getByRole("switch", {
          name: "Remote connection (owner access)",
        }),
      );
      await waitFor(() =>
        expect(ownerRemoteApi[action]).toHaveBeenCalledTimes(1),
      );
      fireEvent.mouseDown(screen.getByRole("tab", { name: "General" }), {
        button: 0,
        ctrlKey: false,
      });
      fireEvent.mouseDown(
        screen.getByRole("tab", { name: "Connections & recovery" }),
        { button: 0, ctrlKey: false },
      );
      await screen.findByText(action === "start" ? "Off" : "Listening locally");
      await act(async () => finishDispatch());
      await waitFor(() =>
        expect(
          screen.getByRole("switch", {
            name: "Remote connection (owner access)",
          }),
        ).toHaveAttribute("aria-checked", String(action === "start")),
      );
      expect(
        await screen.findByText(
          action === "start" ? "Listening locally" : "Off",
        ),
      ).toBeInTheDocument();
      expect(ownerRemoteApi[action]).toHaveBeenCalledTimes(1);
    },
  );

  it("retains the pending remote mutation lock without overlapping a remount status read", async () => {
    let finishDispatch!: () => void;
    const dispatch = new Promise<void>((resolve) => {
      finishDispatch = resolve;
    });
    const configuredOff = { ...remoteOff, httpsOrigin: "https://owner.test" };
    vi.mocked(ownerRemoteApi.getStatus).mockResolvedValue(configuredOff);
    vi.mocked(ownerRemoteApi.start).mockImplementation(async () => {
      await dispatch;
      return { ...configuredOff, enabled: true, running: true };
    });
    await mount("connections");
    await screen.findByText("Off");
    fireEvent.click(
      screen.getByRole("switch", { name: "Remote connection (owner access)" }),
    );
    await waitFor(() => expect(ownerRemoteApi.start).toHaveBeenCalledTimes(1));
    fireEvent.mouseDown(screen.getByRole("tab", { name: "General" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.mouseDown(
      screen.getByRole("tab", { name: "Connections & recovery" }),
      { button: 0, ctrlKey: false },
    );
    await screen.findByText("Off");
    const remote = screen.getByRole("switch", {
      name: "Remote connection (owner access)",
    });
    expect(remote).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Refresh status" }),
    ).toBeDisabled();
    expect(ownerRemoteApi.getStatus).toHaveBeenCalledTimes(1);
    fireEvent.click(remote);
    expect(ownerRemoteApi.start).toHaveBeenCalledTimes(1);
    await act(async () => finishDispatch());
    expect(await screen.findByText("Listening locally")).toBeInTheDocument();
    expect(remote).not.toBeDisabled();
    expect(ownerRemoteApi.start).toHaveBeenCalledTimes(1);
  });

  it("rolls back a failed watchdog save without reporting recovery disabled", async () => {
    server.use(
      http.post(
        "http://tauri.local/save_settings",
        () => new HttpResponse("save unavailable", { status: 503 }),
      ),
    );
    await mount("connections");
    await screen.findByText("Dev supervisor");
    const toggle = screen.getByRole("switch", {
      name: "Auto-recover from crashes (watchdog)",
    });
    fireEvent.click(toggle);
    expect(
      await screen.findByText(
        "Could not save crash recovery. Please try again.",
      ),
    ).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(getSettings().watchdogEnabled).toBe(true);
    expect(screen.queryByText("Disabled")).not.toBeInTheDocument();
    expect(watchdogApi.getStatus).toHaveBeenCalledTimes(1);
    expect(ownerRemoteApi.start).not.toHaveBeenCalled();
  });
});
