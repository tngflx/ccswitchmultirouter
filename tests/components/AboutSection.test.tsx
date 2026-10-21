import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AboutSection } from "@/components/settings/AboutSection";
import { emitTauriEvent } from "../msw/tauriMocks";

const getToolVersionsMock = vi.hoisted(() => vi.fn());
const checkUpdateMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());
const getToolAutoUpdateSettingsMock = vi.hoisted(() => vi.fn());
const setToolAutoUpdateMock = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({
  toast: { error: toastErrorMock, success: vi.fn(), info: vi.fn() },
}));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn().mockResolvedValue("3.20.1-1"),
}));

vi.mock("@/contexts/UpdateContext", () => ({
  useUpdate: () => ({
    hasUpdate: false,
    updateInfo: null,
    checkUpdate: checkUpdateMock,
    resetDismiss: vi.fn(),
    isChecking: false,
  }),
}));

vi.mock("@/lib/api", () => ({
  settingsApi: {
    getToolVersions: getToolVersionsMock,
    openExternal: vi.fn(),
    checkUpdates: vi.fn(),
    installUpdateAndRestart: vi.fn(),
    probeToolInstallations: vi.fn().mockResolvedValue([]),
    runToolLifecycleAction: vi.fn(),
    getToolAutoUpdateSettings: getToolAutoUpdateSettingsMock,
    setToolAutoUpdate: setToolAutoUpdateMock,
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  isWindows: () => true,
}));

vi.mock("framer-motion", () => ({
  motion: new Proxy(
    {},
    {
      get: (_target, tag: string) => tag,
    },
  ),
}));

describe("AboutSection", () => {
  beforeEach(() => {
    checkUpdateMock.mockReset().mockResolvedValue(false);
    toastErrorMock.mockReset();
    getToolVersionsMock.mockReset();
    getToolAutoUpdateSettingsMock.mockReset().mockResolvedValue({
      codex: true,
      gemini: false,
    });
    setToolAutoUpdateMock
      .mockReset()
      .mockImplementation(async (tool, enabled) => ({
        codex: true,
        [tool]: enabled,
      }));
    getToolVersionsMock.mockImplementation(async ([name]: [string]) => [
      {
        name,
        version: null,
        latest_version: null,
        error: null,
        installed_but_broken: false,
        env_type: "windows",
        wsl_distro: null,
      },
    ]);
  });

  it("includes Pi in the local tool lifecycle lookup", async () => {
    render(<AboutSection isPortable={false} />);

    await waitFor(() =>
      expect(getToolVersionsMock).toHaveBeenCalledWith(["pi"], {}),
    );
  });

  it("shows the updater plugin string rejection in the failure toast", async () => {
    checkUpdateMock.mockRejectedValue("TLS certificate expired");
    render(<AboutSection isPortable={false} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "settings.checkForUpdates" }),
    );
    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(
        "settings.checkUpdateFailed",
        expect.objectContaining({ description: "TLS certificate expired" }),
      ),
    );
  });

  it("shows a saved auto-update switch in every CLI card, including uninstalled tools", async () => {
    render(<AboutSection isPortable={false} />);

    const switches = await screen.findAllByRole("switch");
    expect(switches).toHaveLength(8);
    await waitFor(() =>
      expect(
        switches.every((control) => !control.hasAttribute("disabled")),
      ).toBe(true),
    );
    expect(switches[1]).toHaveAttribute("aria-checked", "true");
    expect(switches[2]).toHaveAttribute("aria-checked", "false");
  });

  it("saves only the selected CLI policy without changing other switches", async () => {
    render(<AboutSection isPortable={false} />);
    const switches = await screen.findAllByRole("switch");
    await waitFor(() => expect(switches[2]).not.toBeDisabled());

    fireEvent.click(switches[2]);

    await waitFor(() =>
      expect(setToolAutoUpdateMock).toHaveBeenCalledWith("gemini", true),
    );
    await waitFor(() =>
      expect(switches[2]).toHaveAttribute("aria-checked", "true"),
    );
    expect(switches[1]).toHaveAttribute("aria-checked", "true");
    expect(switches[0]).toHaveAttribute("aria-checked", "false");
  });

  it("keeps the saved policy unchanged and reports a failed save", async () => {
    setToolAutoUpdateMock.mockRejectedValue("settings file is read-only");
    render(<AboutSection isPortable={false} />);
    const switches = await screen.findAllByRole("switch");
    await waitFor(() => expect(switches[1]).not.toBeDisabled());

    fireEvent.click(switches[1]);

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(
        "settings.toolAutoUpdateFailed",
        expect.objectContaining({ description: "settings file is read-only" }),
      ),
    );
    expect(switches[1]).toHaveAttribute("aria-checked", "true");
    expect(switches[1]).not.toBeDisabled();
  });

  it("does not allow policy changes when loading the saved settings fails", async () => {
    getToolAutoUpdateSettingsMock.mockRejectedValue("settings unavailable");
    render(<AboutSection isPortable={false} />);
    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(
        "settings.toolAutoUpdateLoadFailed",
        expect.objectContaining({ description: "settings unavailable" }),
      ),
    );
    const switches = await screen.findAllByRole("switch");
    expect(switches.every((control) => control.hasAttribute("disabled"))).toBe(
      true,
    );
    fireEvent.click(switches[0]);
    expect(setToolAutoUpdateMock).not.toHaveBeenCalled();
  });

  it("retries loading auto-update settings when Refresh is clicked", async () => {
    getToolAutoUpdateSettingsMock.mockRejectedValueOnce("settings unavailable");
    render(<AboutSection isPortable={false} />);
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
    const refresh = screen.getByRole("button", { name: "common.refresh" });
    await waitFor(() => expect(refresh).not.toBeDisabled());
    fireEvent.click(refresh);
    const switches = await screen.findAllByRole("switch");
    await waitFor(() => expect(switches[1]).not.toBeDisabled());
    expect(switches[1]).toHaveAttribute("aria-checked", "true");
    expect(getToolAutoUpdateSettingsMock).toHaveBeenCalledTimes(2);
  });

  it("locks switches during a save and rejects duplicate submissions", async () => {
    let finishSave!: (policies: Record<string, boolean>) => void;
    setToolAutoUpdateMock.mockReturnValue(
      new Promise((resolve) => {
        finishSave = resolve;
      }),
    );
    render(<AboutSection isPortable={false} />);
    const switches = await screen.findAllByRole("switch");
    await waitFor(() => expect(switches[0]).not.toBeDisabled());
    fireEvent.click(switches[0]);
    fireEvent.click(switches[0]);
    expect(setToolAutoUpdateMock).toHaveBeenCalledTimes(1);
    expect(switches.every((control) => control.hasAttribute("disabled"))).toBe(
      true,
    );
    await act(async () => finishSave({ claude: true, codex: true }));
    await waitFor(() => expect(switches[0]).not.toBeDisabled());
    expect(switches[0]).toHaveAttribute("aria-checked", "true");
  });

  it("reloads persisted policies after the About tab remounts", async () => {
    const { unmount } = render(<AboutSection isPortable={false} />);
    let controls = await screen.findAllByRole("switch");
    await waitFor(() => expect(controls[1]).not.toBeDisabled());
    fireEvent.click(controls[1]);
    await waitFor(() =>
      expect(controls[1]).toHaveAttribute("aria-checked", "false"),
    );
    unmount();
    getToolAutoUpdateSettingsMock.mockResolvedValue({ codex: false });
    render(<AboutSection isPortable={false} />);
    controls = await screen.findAllByRole("switch");
    await waitFor(() => expect(controls[1]).not.toBeDisabled());
    expect(controls[1]).toHaveAttribute("aria-checked", "false");
    expect(getToolAutoUpdateSettingsMock).toHaveBeenCalledTimes(2);
  });

  it("refreshes the card when a background CLI update completes", async () => {
    render(<AboutSection isPortable={false} />);
    const controls = await screen.findAllByRole("switch");
    await waitFor(() => expect(controls[1]).not.toBeDisabled());
    act(() =>
      emitTauriEvent("tool-auto-update-completed", {
        name: "codex",
        version: "0.161.0",
        latest_version: "0.161.0",
        error: null,
        installed_but_broken: false,
        env_type: "windows",
        wsl_distro: null,
      }),
    );
    await waitFor(() => expect(screen.getAllByText("0.161.0")).toHaveLength(2));
  });

  it("rechecks enabled tools after updates complete while About is unmounted", async () => {
    const { unmount } = render(<AboutSection isPortable={false} />);
    await waitFor(() =>
      expect(screen.getAllByRole("switch")[1]).not.toBeDisabled(),
    );
    unmount();
    getToolVersionsMock.mockClear();
    getToolVersionsMock.mockImplementation(async ([name]: [string]) => [
      {
        name,
        version: "0.162.0",
        latest_version: "0.162.0",
        error: null,
        installed_but_broken: false,
        env_type: "windows",
        wsl_distro: null,
      },
    ]);
    render(<AboutSection isPortable={false} />);
    await waitFor(() => expect(screen.getAllByText("0.162.0")).toHaveLength(2));
    expect(getToolVersionsMock).toHaveBeenCalledWith(["codex"], undefined);
    expect(getToolVersionsMock).toHaveBeenCalledTimes(1);
  });

  it("shows the Windows Hermes installer through PowerShell 7", async () => {
    render(<AboutSection isPortable={false} />);
    await waitFor(() =>
      expect(screen.getAllByRole("switch")[0]).not.toBeDisabled(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "settings.manualInstallCommands" }),
    );
    const commands = screen.getByText(/# Claude Code/).textContent ?? "";
    expect(commands).toContain(
      "pwsh.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ",
    );
    expect(commands).not.toMatch(/\bpowershell(?:\.exe)?\s/i);
    const encoded = commands.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)?.[1];
    expect(encoded).toBeDefined();
    expect(atob(encoded!).replace(/\0/g, "")).toBe(
      "irm https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.ps1 | iex",
    );
  });
});
