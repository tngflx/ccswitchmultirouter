import { StrictMode } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchdogApi, type WatchdogStatus } from "@/lib/api/watchdog";
import { WatchdogStatusPanel } from "./WatchdogStatusPanel";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
  }),
}));

vi.mock("@/lib/api/watchdog", () => ({
  watchdogApi: { getStatus: vi.fn() },
}));

const healthy: WatchdogStatus = {
  enabled: true,
  supervisorMode: "rust",
  appPid: 4242,
  supervisorPid: 5151,
  supervisorAlive: true,
  supervisorPath: "C:/App/cc-switch.exe",
  restartsInWindow: 1,
  port: 15721,
  listenerPid: 4242,
  listenerPath: "C:/App/cc-switch.exe",
  portReady: true,
  portDiagnosis: "端口 15721 占用诊断：LISTEN ipv4 127.0.0.1:15721 pid=4242",
  recentEvents: [
    {
      timestamp: "2026-09-15T00:00:00.000+08:00",
      level: "info",
      event: "supervisor-watching",
    },
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("WatchdogStatusPanel", () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("shows loading rather than a false failure before the first read resolves", () => {
    vi.mocked(watchdogApi.getStatus).mockReturnValue(new Promise(() => {}));
    render(<WatchdogStatusPanel />);

    expect(screen.getByText("settings.watchdogLoading")).toBeInTheDocument();
    expect(screen.queryByText("settings.watchdogLoadFailed")).toBeNull();
    expect(
      screen.getByRole("button", { name: "settings.watchdogRefresh" }),
    ).toBeDisabled();
  });

  it("refreshes authoritative status when the completed save version changes", async () => {
    vi.mocked(watchdogApi.getStatus)
      .mockResolvedValueOnce(healthy)
      .mockResolvedValueOnce({ ...healthy, enabled: false });
    const { rerender } = render(<WatchdogStatusPanel refreshVersion={0} />);
    await screen.findByText("settings.watchdogStateRunning");

    rerender(<WatchdogStatusPanel refreshVersion={1} />);

    await screen.findByText("settings.watchdogStateDisabled");
    expect(watchdogApi.getStatus).toHaveBeenCalledTimes(2);
  });

  it("ignores an older read that resolves after the post-save refresh", async () => {
    const beforeSave = deferred<WatchdogStatus>();
    const afterSave = deferred<WatchdogStatus>();
    vi.mocked(watchdogApi.getStatus)
      .mockReturnValueOnce(beforeSave.promise)
      .mockReturnValueOnce(afterSave.promise);
    const { rerender } = render(<WatchdogStatusPanel refreshVersion={0} />);
    rerender(<WatchdogStatusPanel refreshVersion={1} />);
    await act(async () => afterSave.resolve({ ...healthy, enabled: false }));
    await screen.findByText("settings.watchdogStateDisabled");

    await act(async () => beforeSave.resolve(healthy));

    expect(
      screen.getByText("settings.watchdogStateDisabled"),
    ).toBeInTheDocument();
    expect(screen.queryByText("settings.watchdogStateRunning")).toBeNull();
  });

  it("ignores reads invalidated by effect cleanup", async () => {
    const beforeCleanup = deferred<WatchdogStatus>();
    const afterCleanup = deferred<WatchdogStatus>();
    vi.mocked(watchdogApi.getStatus)
      .mockReturnValueOnce(beforeCleanup.promise)
      .mockReturnValueOnce(afterCleanup.promise);
    render(
      <StrictMode>
        <WatchdogStatusPanel />
      </StrictMode>,
    );
    expect(watchdogApi.getStatus).toHaveBeenCalledTimes(2);
    await act(async () => afterCleanup.resolve({ ...healthy, enabled: false }));
    await screen.findByText("settings.watchdogStateDisabled");

    await act(async () => beforeCleanup.resolve(healthy));

    expect(
      screen.getByText("settings.watchdogStateDisabled"),
    ).toBeInTheDocument();
    expect(screen.queryByText("settings.watchdogStateRunning")).toBeNull();
  });

  it("shows a generic initial read failure without leaking native error text", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(watchdogApi.getStatus).mockRejectedValue(
      new Error("private-watchdog-native-error"),
    );
    render(<WatchdogStatusPanel />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "settings.watchdogLoadFailed",
    );
    expect(screen.queryByText(/private-watchdog-native-error/)).toBeNull();
    expect(screen.queryByText("settings.watchdogLoading")).toBeNull();
    expect(log).not.toHaveBeenCalled();
  });

  it("keeps the last authoritative status when a refresh fails without exposing native errors", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(watchdogApi.getStatus)
      .mockResolvedValueOnce(healthy)
      .mockRejectedValueOnce(new Error("private-watchdog-native-error"));
    render(<WatchdogStatusPanel />);
    await screen.findByText("settings.watchdogStateRunning");

    fireEvent.click(
      screen.getByRole("button", { name: "settings.watchdogRefresh" }),
    );

    await screen.findByText("settings.watchdogLoadFailed");
    expect(
      screen.getByText("settings.watchdogStateRunning"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/private-watchdog-native-error/)).toBeNull();
    expect(log).not.toHaveBeenCalled();
  });

  it("shows the supervisor, restarts and ready port", async () => {
    vi.mocked(watchdogApi.getStatus).mockResolvedValue(healthy);
    render(<WatchdogStatusPanel />);

    await waitFor(() =>
      expect(screen.getByText("settings.watchdogStateRunning")).toBeTruthy(),
    );
    expect(screen.getByText("settings.watchdogPortReady")).toBeTruthy();
    expect(screen.getByText("127.0.0.1:15721")).toBeTruthy();
    expect(screen.getByText("supervisor-watching")).toBeTruthy();
  });

  it("surfaces the port diagnosis when the listener is not ours", async () => {
    vi.mocked(watchdogApi.getStatus).mockResolvedValue({
      ...healthy,
      portReady: false,
      supervisorAlive: false,
      supervisorPid: null,
      restartsInWindow: 0,
      recentEvents: [],
    });
    render(<WatchdogStatusPanel />);

    await waitFor(() =>
      expect(screen.getByText("settings.watchdogPortNotReady")).toBeTruthy(),
    );
    expect(screen.getByText("settings.watchdogStateStopped")).toBeTruthy();
    expect(screen.getByText("settings.watchdogNoEvents")).toBeTruthy();
    expect(screen.getByText(/LISTEN ipv4/)).toBeTruthy();
  });

  it("labels development recovery as owned by pnpm dev", async () => {
    vi.mocked(watchdogApi.getStatus).mockResolvedValue({
      ...healthy,
      supervisorMode: "pnpm-dev",
      supervisorAlive: false,
      supervisorPid: null,
    });
    render(<WatchdogStatusPanel />);

    await waitFor(() =>
      expect(screen.getByText("settings.watchdogStateDevManaged")).toBeTruthy(),
    );
    expect(screen.getByText("settings.watchdogDevSupervisor")).toBeTruthy();
  });

  it.each([true, false])(
    "explains an effective dev override (%s) independently of the saved switch",
    async (enabledOverride) => {
      vi.mocked(watchdogApi.getStatus).mockResolvedValue({
        ...healthy,
        supervisorMode: "pnpm-dev",
        enabled: enabledOverride,
        configuredEnabled: !enabledOverride,
        enabledOverride,
      });
      render(<WatchdogStatusPanel />);

      expect(
        await screen.findByText(
          enabledOverride
            ? "settings.watchdogDevOverrideEnabled"
            : "settings.watchdogDevOverrideDisabled",
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByText("settings.watchdogDevOverrideDescription"),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          enabledOverride
            ? "settings.watchdogConfiguredDisabled"
            : "settings.watchdogConfiguredEnabled",
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          enabledOverride
            ? "settings.watchdogStateRunning"
            : "settings.watchdogStateDisabled",
        ),
      ).toBeInTheDocument();
    },
  );

  it("does not invent an override for older status payloads", async () => {
    vi.mocked(watchdogApi.getStatus).mockResolvedValue({
      ...healthy,
      supervisorMode: "pnpm-dev",
    });
    render(<WatchdogStatusPanel />);

    await screen.findByText("settings.watchdogStateRunning");
    expect(
      screen.queryByText("settings.watchdogDevOverrideDescription"),
    ).toBeNull();
  });

  it("collapses healthy diagnostics to keep the status panel compact", async () => {
    vi.mocked(watchdogApi.getStatus).mockResolvedValue(healthy);
    render(<WatchdogStatusPanel />);

    await waitFor(() =>
      expect(screen.getByText("settings.watchdogDiagnostics")).toBeTruthy(),
    );
    const details = screen
      .getByText("settings.watchdogDiagnostics")
      .closest("details");
    expect(details?.hasAttribute("open")).toBe(false);
  });

  it("opens diagnostics automatically when the port is not ready", async () => {
    vi.mocked(watchdogApi.getStatus).mockResolvedValue({
      ...healthy,
      portReady: false,
    });
    render(<WatchdogStatusPanel />);

    await waitFor(() =>
      expect(screen.getByText("settings.watchdogDiagnostics")).toBeTruthy(),
    );
    const details = screen
      .getByText("settings.watchdogDiagnostics")
      .closest("details");
    expect(details?.hasAttribute("open")).toBe(true);
  });
});
