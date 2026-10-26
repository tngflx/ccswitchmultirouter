import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { StreamRetryActivityPanel } from "@/components/codex/StreamRetryActivityPanel";
const mocks = vi.hoisted(() => ({
  settings: { streamRetryMode: "safe", enableStreamRetry: true },
  guardian: undefined as unknown,
  patch: vi.fn(),
  get: vi.fn(),
  toast: vi.fn(),
  events: [] as unknown[],
  setQueryData: vi.fn(),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("sonner", () => ({ toast: { error: mocks.toast } }));
vi.mock("@/lib/query", () => ({
  useSettingsQuery: () => ({ data: mocks.settings }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: mocks.guardian, isError: !mocks.guardian }),
  useQueryClient: () => ({
    cancelQueries: vi.fn(),
    setQueryData: mocks.setQueryData,
  }),
}));
vi.mock("@/lib/api", () => ({
  settingsApi: { patch: mocks.patch, get: mocks.get },
}));
vi.mock("@/hooks/useStreamRetryActivity", () => ({
  useStreamRetryActivity: () => mocks.events,
}));
beforeEach(() => {
  mocks.settings = { streamRetryMode: "safe", enableStreamRetry: true };
  mocks.events = [];
  mocks.guardian = undefined;
  mocks.patch.mockReset().mockResolvedValue(undefined);
  mocks.get.mockReset().mockResolvedValue({
    streamRetryMode: "aggressive",
    enableStreamRetry: true,
  });
  mocks.toast.mockReset();
});
it("explains that Safe does not continue a failed chat and enables it only through the canonical patch", async () => {
  render(<StreamRetryActivityPanel />);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "streamRetry.continuation.disabled",
  );
  expect(mocks.patch).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "streamRetry.continuation.enable" }),
  );
  await waitFor(() =>
    expect(mocks.patch).toHaveBeenCalledWith({
      streamRetryMode: "aggressive",
      enableStreamRetry: true,
    }),
  );
});
it("does not present Aggressive as working when the Desktop bridge is unavailable", () => {
  mocks.settings.streamRetryMode = "aggressive";
  mocks.guardian = { codexRunning: true, cdpAvailable: false, injected: false };
  render(<StreamRetryActivityPanel />);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "streamRetry.continuation.bridgeUnavailable",
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "streamRetry.continuation.launchHelp",
  );
});
it("offers bridge repair without telling a running Desktop with CDP to restart", () => {
  mocks.settings.streamRetryMode = "aggressive";
  mocks.guardian = {
    active: true,
    codexRunning: true,
    cdpAvailable: true,
    injected: false,
  };
  render(<StreamRetryActivityPanel />);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "streamRetry.continuation.repairHelp",
  );
  expect(screen.getByRole("alert")).not.toHaveTextContent(
    "streamRetry.continuation.launchHelp",
  );
});
it("does not report a usable bridge on an unknown or stale guardian result", () => {
  mocks.settings.streamRetryMode = "aggressive";
  render(<StreamRetryActivityPanel />);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "streamRetry.continuation.readinessUnknown",
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "streamRetry.continuation.checkHelp",
  );
  expect(screen.getByRole("alert")).not.toHaveTextContent(
    "streamRetry.continuation.launchHelp",
  );
});
it("shows logical continuation failures separately from stream replay", () => {
  mocks.events = [
    {
      timestamp: "2026-10-23T10:00:00Z",
      event: "continuation_submit_failed",
      stage: "desktop_continuation",
      attempt: 1,
      maxAttempts: 3,
      model: "fixture-model",
      reasonClass: "desktop_cdp_discovery_failed",
    },
  ];
  render(<StreamRetryActivityPanel />);
  expect(
    screen.getByText(/streamRetry.activity.stages.desktop_continuation/),
  ).toBeInTheDocument();
  expect(screen.getByText(/desktop cdp discovery failed/)).toBeInTheDocument();
});
it("reports a failed settings patch without pretending automatic continuation is enabled", async () => {
  mocks.patch.mockRejectedValueOnce(new Error("synthetic"));
  render(<StreamRetryActivityPanel />);
  fireEvent.click(
    screen.getByRole("button", { name: "streamRetry.continuation.enable" }),
  );
  await waitFor(() => expect(mocks.toast).toHaveBeenCalled());
  expect(mocks.get).not.toHaveBeenCalled();
});
