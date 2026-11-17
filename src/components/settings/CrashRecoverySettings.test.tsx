import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsFormState } from "@/hooks/useSettings";
import { watchdogApi, type WatchdogStatus } from "@/lib/api/watchdog";
import {
  CrashRecoverySettings,
  useCrashRecoveryController,
} from "./CrashRecoverySettings";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/lib/api/watchdog", () => ({
  watchdogApi: { getStatus: vi.fn() },
}));

const baseSettings = (watchdogEnabled?: boolean) =>
  ({ watchdogEnabled }) as SettingsFormState;

const healthy: WatchdogStatus = {
  enabled: true,
  supervisorMode: "rust",
  appPid: 4242,
  supervisorPid: 5151,
  supervisorAlive: true,
  restartsInWindow: 1,
  port: 15721,
  portReady: true,
  portDiagnosis: "",
  recentEvents: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function RecoveryHarness({
  settings,
  onChange,
}: {
  settings: SettingsFormState;
  onChange: (updates: Partial<SettingsFormState>) => Promise<boolean>;
}) {
  const controller = useCrashRecoveryController(onChange);
  return <CrashRecoverySettings settings={settings} controller={controller} />;
}

const toggle = () =>
  screen.getByRole("switch", { name: "settings.watchdogEnabled" });

const statusLabel = (enabled: boolean) =>
  enabled ? "settings.watchdogStateRunning" : "settings.watchdogStateDisabled";

describe("CrashRecoverySettings", () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it.each([true, false])(
    "persists the canonical setting from %s and refreshes native status only after success",
    async (initialEnabled) => {
      const save = deferred<boolean>();
      const onChange = vi.fn().mockReturnValue(save.promise);
      vi.mocked(watchdogApi.getStatus)
        .mockResolvedValueOnce({ ...healthy, enabled: initialEnabled })
        .mockResolvedValueOnce({ ...healthy, enabled: !initialEnabled });
      const { rerender } = render(
        <RecoveryHarness
          settings={baseSettings(initialEnabled)}
          onChange={onChange}
        />,
      );
      await screen.findByText(statusLabel(initialEnabled));
      expect(toggle()).toHaveAttribute("aria-checked", String(initialEnabled));

      fireEvent.click(toggle());
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith({
        watchdogEnabled: !initialEnabled,
      });
      // SettingsPage optimistically updates the shared form before the save resolves.
      rerender(
        <RecoveryHarness
          settings={baseSettings(!initialEnabled)}
          onChange={onChange}
        />,
      );
      expect(toggle()).toHaveAttribute("aria-checked", String(!initialEnabled));
      expect(toggle()).toBeDisabled();
      expect(
        screen.getByText("settings.crashRecoverySaving"),
      ).toBeInTheDocument();
      expect(screen.getByText(statusLabel(initialEnabled))).toBeInTheDocument();
      expect(screen.queryByText(statusLabel(!initialEnabled))).toBeNull();
      expect(watchdogApi.getStatus).toHaveBeenCalledTimes(1);

      await act(async () => save.resolve(true));

      await screen.findByText(statusLabel(!initialEnabled));
      expect(watchdogApi.getStatus).toHaveBeenCalledTimes(2);
      expect(toggle()).not.toBeDisabled();
      expect(screen.queryByText("settings.crashRecoverySaving")).toBeNull();
      expect(screen.queryByText("settings.crashRecoverySaveFailed")).toBeNull();
    },
  );

  it("treats an absent persisted value as enabled without writing a default", async () => {
    const onChange = vi.fn();
    vi.mocked(watchdogApi.getStatus).mockResolvedValue(healthy);
    render(<RecoveryHarness settings={baseSettings()} onChange={onChange} />);

    expect(toggle()).toHaveAttribute("aria-checked", "true");
    await screen.findByText("settings.watchdogStateRunning");
    expect(onChange).not.toHaveBeenCalled();
    expect(
      screen.getAllByRole("switch", { name: "settings.watchdogEnabled" }),
    ).toHaveLength(1);
  });

  it.each(["unsuccessful", "rejected"])(
    "keeps prior native evidence and shows only a generic error for an %s save",
    async (outcome) => {
      const save = deferred<boolean>();
      const onChange = vi.fn().mockReturnValue(save.promise);
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(watchdogApi.getStatus).mockResolvedValue(healthy);
      const { rerender } = render(
        <RecoveryHarness settings={baseSettings(true)} onChange={onChange} />,
      );
      await screen.findByText("settings.watchdogStateRunning");
      fireEvent.click(toggle());
      rerender(
        <RecoveryHarness settings={baseSettings(false)} onChange={onChange} />,
      );
      expect(screen.queryByText("settings.watchdogStateDisabled")).toBeNull();

      await act(async () => {
        // The existing SettingsPage callback rolls its optimistic form value back.
        rerender(
          <RecoveryHarness settings={baseSettings(true)} onChange={onChange} />,
        );
        if (outcome === "unsuccessful") save.resolve(false);
        else save.reject(new Error("private-save-exception"));
      });

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "settings.crashRecoverySaveFailed",
      );
      expect(
        screen.getByText("settings.watchdogStateRunning"),
      ).toBeInTheDocument();
      expect(screen.queryByText("settings.watchdogStateDisabled")).toBeNull();
      expect(screen.queryByText(/private-save-exception/)).toBeNull();
      expect(log).not.toHaveBeenCalled();
      expect(watchdogApi.getStatus).toHaveBeenCalledTimes(1);
      expect(toggle()).toHaveAttribute("aria-checked", "true");
      expect(toggle()).not.toBeDisabled();
    },
  );

  it("serializes rapid inputs and permits a new save after the previous one finishes", async () => {
    const firstSave = deferred<boolean>();
    const secondSave = deferred<boolean>();
    const onChange = vi
      .fn()
      .mockReturnValueOnce(firstSave.promise)
      .mockReturnValueOnce(secondSave.promise);
    vi.mocked(watchdogApi.getStatus)
      .mockResolvedValueOnce(healthy)
      .mockResolvedValueOnce({ ...healthy, enabled: false })
      .mockResolvedValueOnce(healthy);
    const { rerender } = render(
      <RecoveryHarness settings={baseSettings(true)} onChange={onChange} />,
    );
    await screen.findByText("settings.watchdogStateRunning");

    act(() => {
      fireEvent.click(toggle());
      fireEvent.click(toggle());
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(toggle()).toBeDisabled();
    rerender(
      <RecoveryHarness settings={baseSettings(false)} onChange={onChange} />,
    );
    await act(async () => firstSave.resolve(true));
    await screen.findByText("settings.watchdogStateDisabled");

    fireEvent.click(toggle());
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith({ watchdogEnabled: true });
    rerender(
      <RecoveryHarness settings={baseSettings(true)} onChange={onChange} />,
    );
    await act(async () => secondSave.resolve(true));
    await screen.findByText("settings.watchdogStateRunning");
    expect(watchdogApi.getStatus).toHaveBeenCalledTimes(3);
    expect(toggle()).not.toBeDisabled();
  });

  it("does not refresh after the controller owner unmounts with an outstanding save", async () => {
    const save = deferred<boolean>();
    vi.mocked(watchdogApi.getStatus).mockResolvedValue(healthy);
    const { unmount } = render(
      <RecoveryHarness
        settings={baseSettings(true)}
        onChange={vi.fn().mockReturnValue(save.promise)}
      />,
    );
    await screen.findByText("settings.watchdogStateRunning");
    fireEvent.click(toggle());
    unmount();

    await act(async () => save.resolve(true));

    expect(watchdogApi.getStatus).toHaveBeenCalledTimes(1);
  });

  it("explains recovery triggers and independence from remote access without changing settings", async () => {
    const onChange = vi.fn();
    vi.mocked(watchdogApi.getStatus).mockResolvedValue(healthy);
    render(
      <RecoveryHarness settings={baseSettings(true)} onChange={onChange} />,
    );
    await screen.findByText("settings.watchdogStateRunning");

    fireEvent.click(screen.getByText("settings.crashRecoveryWhenTitle"));

    expect(
      screen.getByText("settings.crashRecoveryIndependent"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("settings.crashRecoveryUnexpected"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("settings.crashRecoveryManualQuit"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("settings.crashRecoveryRateLimit"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("settings.crashRecoveryDevOutput"),
    ).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    expect(watchdogApi.getStatus).toHaveBeenCalledTimes(1);
  });
});
