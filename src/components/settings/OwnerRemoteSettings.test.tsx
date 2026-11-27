import { StrictMode } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OwnerRemoteSettings,
  useOwnerRemoteController,
} from "./OwnerRemoteSettings";
import { ownerRemoteApi, type OwnerRemoteStatus } from "@/lib/api/ownerRemote";
import { tailscaleApi, type TailscaleStatus } from "@/lib/api/tailscale";
import en from "@/i18n/locales/en.json";
import zh from "@/i18n/locales/zh.json";
import zhTW from "@/i18n/locales/zh-TW.json";
import ja from "@/i18n/locales/ja.json";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/lib/api/ownerRemote", () => ({
  ownerRemoteApi: {
    getStatus: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    createInvite: vi.fn(),
  },
}));
vi.mock("@/lib/api/tailscale", () => ({
  tailscaleApi: {
    getStatus: vi.fn(),
    connect: vi.fn(),
    verifyOwnerRemote: vi.fn(),
  },
}));

const stopped: OwnerRemoteStatus = {
  enabled: false,
  running: false,
  httpsOrigin: null,
  loopbackAddress: "127.0.0.1:15723",
};
const running: OwnerRemoteStatus = {
  ...stopped,
  enabled: true,
  running: true,
  httpsOrigin: "https://owner.test",
};
const tailscaleMissing: TailscaleStatus = {
  state: "missing",
  reachable: false,
};
const tailscaleReady: TailscaleStatus = {
  state: "ready",
  reachable: false,
};
const tailscaleReachable: TailscaleStatus = {
  state: "reachable",
  reachable: true,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

const toggle = () =>
  screen.getByRole("switch", { name: "settings.ownerRemote.title" });
const originInput = () => screen.getByLabelText("settings.ownerRemote.origin");
const inviteButton = () =>
  screen.getByRole("button", { name: "settings.ownerRemote.invite" });
const connectButton = () =>
  screen.getByRole("button", { name: "settings.ownerRemote.tailscaleConnect" });

function OwnerRemoteHarness({ active = true }: { active?: boolean }) {
  const controller = useOwnerRemoteController(active);
  return active ? <OwnerRemoteSettings controller={controller} /> : null;
}

async function mount(status = stopped, tailscale = tailscaleMissing) {
  vi.mocked(ownerRemoteApi.getStatus).mockResolvedValue(status);
  vi.mocked(tailscaleApi.getStatus).mockResolvedValue(tailscale);
  const view = render(<OwnerRemoteHarness />);
  await waitFor(() => expect(originInput()).not.toBeDisabled());
  return view;
}

async function createInvite() {
  vi.mocked(ownerRemoteApi.createInvite).mockResolvedValue({
    invitationSecret: "a".repeat(43),
    expiresInSeconds: 60,
  });
  fireEvent.click(inviteButton());
  return screen.findByLabelText("settings.ownerRemote.inviteExpires");
}

describe("OwnerRemoteSettings", () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.useRealTimers());

  it("shows an opt-in switch and first-time setup without starting or enrolling", async () => {
    await mount();
    expect(toggle()).not.toBeChecked();
    expect(toggle()).toBeDisabled();
    expect(ownerRemoteApi.start).not.toHaveBeenCalled();
    expect(ownerRemoteApi.stop).not.toHaveBeenCalled();
    expect(ownerRemoteApi.createInvite).not.toHaveBeenCalled();
    expect(inviteButton()).toBeDisabled();
    expect(originInput().closest("details")).toHaveAttribute("open");
    expect(
      screen.getByText("settings.ownerRemote.setupRequired"),
    ).toBeVisible();
    expect(
      screen.getByText("settings.ownerRemote.privateNetwork"),
    ).toBeVisible();
    expect(screen.getByText("settings.ownerRemote.security")).toBeVisible();
    expect(screen.getByText("settings.ownerRemote.boundary")).toBeVisible();
  });

  it("offers a transport-neutral setup guide without changing the owner service", async () => {
    await mount();

    const tailscaleTab = screen.getByRole("tab", {
      name: "settings.ownerRemote.transportTailscale",
    });
    const cloudflareTab = screen.getByRole("tab", {
      name: "settings.ownerRemote.transportCloudflare",
    });
    const teamViewerTab = screen.getByRole("tab", {
      name: "settings.ownerRemote.transportTeamViewer",
    });

    expect(tailscaleTab).toHaveAttribute("aria-selected", "true");
    expect(cloudflareTab).toHaveAttribute("aria-selected", "false");
    expect(teamViewerTab).toHaveAttribute("aria-selected", "false");
    expect(
      screen.getByRole("tabpanel", {
        name: "",
      }),
    ).toHaveTextContent("settings.ownerRemote.privateNetwork");

    fireEvent.click(cloudflareTab);
    expect(cloudflareTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent(
      "settings.ownerRemote.cloudflareFullDescription",
    );
    expect(
      screen.getByRole("link", {
        name: "settings.ownerRemote.cloudflareDashboard",
      }),
    ).toHaveAttribute("href", "https://dash.cloudflare.com/");

    fireEvent.click(teamViewerTab);
    expect(teamViewerTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent(
      "settings.ownerRemote.teamViewerDescription",
    );
    expect(
      screen.getByRole("link", { name: "settings.ownerRemote.teamViewerOpen" }),
    ).toHaveAttribute("href", "https://web.teamviewer.com/");
    expect(ownerRemoteApi.start).not.toHaveBeenCalled();
    expect(ownerRemoteApi.createInvite).not.toHaveBeenCalled();
  });

  it("reads Tailscale status without connecting or verifying on mount", async () => {
    await mount(stopped, tailscaleMissing);
    expect(tailscaleApi.getStatus).toHaveBeenCalledTimes(1);
    expect(connectButton()).toBeEnabled();
    expect(tailscaleApi.connect).not.toHaveBeenCalled();
    expect(tailscaleApi.verifyOwnerRemote).not.toHaveBeenCalled();
  });

  it("connects once and refreshes listener state and enrollment actions from native status", async () => {
    await mount();
    const connection = deferred<TailscaleStatus>();
    vi.mocked(tailscaleApi.connect).mockReturnValue(connection.promise);
    vi.mocked(ownerRemoteApi.getStatus).mockResolvedValue(running);
    const button = connectButton();
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(tailscaleApi.connect).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText("settings.ownerRemote.tailscaleActionConnect"),
    ).toBeVisible();
    expect(inviteButton()).toBeDisabled();
    await act(async () => connection.resolve(tailscaleReachable));
    expect(ownerRemoteApi.getStatus).toHaveBeenCalledTimes(2);
    expect(ownerRemoteApi.start).not.toHaveBeenCalled();
    expect(toggle()).toBeChecked();
    expect(inviteButton()).toBeEnabled();
    expect(
      screen.getByText("settings.ownerRemote.tailscaleReachable"),
    ).toBeVisible();
    expect(
      screen.getByText("settings.ownerRemote.tailscaleEnrollDevice"),
    ).toBeVisible();
  });

  it("verifies only by request and clears proof when the listener stops", async () => {
    await mount(running, tailscaleReady);
    vi.mocked(tailscaleApi.verifyOwnerRemote).mockResolvedValue(
      tailscaleReachable,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "settings.ownerRemote.tailscaleVerify",
      }),
    );
    expect(
      await screen.findByText("settings.ownerRemote.tailscaleReachable"),
    ).toBeVisible();
    expect(tailscaleApi.verifyOwnerRemote).toHaveBeenCalledTimes(1);
    const stopping = deferred<OwnerRemoteStatus>();
    vi.mocked(ownerRemoteApi.stop).mockReturnValue(stopping.promise);
    fireEvent.click(toggle());
    expect(toggle()).toBeChecked();
    expect(
      screen.queryByText("settings.ownerRemote.tailscaleReachable"),
    ).toBeNull();
    await act(async () => stopping.resolve(stopped));
    await waitFor(() => expect(toggle()).not.toBeChecked());
    expect(
      screen.queryByText("settings.ownerRemote.tailscaleReachable"),
    ).toBeNull();
    expect(
      screen.queryByText("settings.ownerRemote.tailscaleEnrollDevice"),
    ).toBeNull();
    expect(inviteButton()).toBeDisabled();
  });

  it("clears verified status when the listener stops externally and then restarts", async () => {
    await mount(running, tailscaleReachable);
    const refresh = screen.getByRole("button", {
      name: "settings.ownerRemote.refreshStatus",
    });
    expect(
      screen.getByText("settings.ownerRemote.tailscaleReachable"),
    ).toBeVisible();

    vi.mocked(ownerRemoteApi.getStatus).mockResolvedValue(stopped);
    fireEvent.click(refresh);
    await waitFor(() => expect(toggle()).not.toBeChecked());

    vi.mocked(ownerRemoteApi.getStatus).mockResolvedValue(running);
    fireEvent.click(refresh);
    await waitFor(() => expect(toggle()).toBeChecked());
    expect(
      screen.queryByText("settings.ownerRemote.tailscaleReachable"),
    ).toBeNull();
    expect(
      screen.queryByText("settings.ownerRemote.tailscaleEnrollDevice"),
    ).toBeNull();
  });

  it("clears verified status when a Tailscale refresh observes a disconnect", async () => {
    await mount(running, tailscaleReachable);
    const checking = deferred<TailscaleStatus>();
    vi.mocked(tailscaleApi.getStatus).mockReturnValue(checking.promise);
    fireEvent.click(
      screen.getByRole("button", {
        name: "settings.ownerRemote.tailscaleRefresh",
      }),
    );
    expect(
      screen.queryByText("settings.ownerRemote.tailscaleEnrollDevice"),
    ).toBeNull();
    await act(async () =>
      checking.resolve({ state: "needsLogin", reachable: false }),
    );
    expect(
      screen.getByText("settings.ownerRemote.tailscaleNeedsLogin"),
    ).toBeVisible();
    expect(
      screen.queryByText("settings.ownerRemote.tailscaleReachable"),
    ).toBeNull();
    expect(connectButton()).toBeEnabled();
  });

  it("reports the native Tailscale sign-in timeout", async () => {
    await mount();
    vi.mocked(tailscaleApi.connect).mockResolvedValue({
      state: "needsLogin",
      reachable: false,
      error: "tailscale_login_timeout",
    });
    fireEvent.click(connectButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "settings.ownerRemote.tailscaleLoginTimeout",
    );
  });

  it("shows ordered Tailscale-first setup without installing or changing access", async () => {
    await mount();
    const steps = screen.getByRole("list", {
      name: "settings.ownerRemote.tailscaleSteps",
    });
    expect(
      Array.from(steps.querySelectorAll("li"), (item) => item.textContent),
    ).toEqual([
      "settings.ownerRemote.setupStepDevices",
      "settings.ownerRemote.setupStepAccess",
      "settings.ownerRemote.setupStepServe" +
        "tailscale serve --bg http://127.0.0.1:15723",
      "settings.ownerRemote.setupStepOrigin",
      "settings.ownerRemote.setupStepEnroll",
    ]);
    expect(
      screen
        .getByText("settings.ownerRemote.cloudflareOptional")
        .closest("details"),
    ).not.toHaveAttribute("open");
    expect(
      screen.getByText("settings.ownerRemote.cloudflareDnsOnly"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("settings.ownerRemote.cloudflareCertificate"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("settings.ownerRemote.cloudflareNoSecrets"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "settings.ownerRemote.openWebsite" }),
    ).toBeNull();
    expect(ownerRemoteApi.start).not.toHaveBeenCalled();
    expect(ownerRemoteApi.stop).not.toHaveBeenCalled();
    expect(ownerRemoteApi.createInvite).not.toHaveBeenCalled();
  });

  it("opens only the normalized pinned website through an explicit safe link", async () => {
    await mount({ ...running, httpsOrigin: "https://OWNER.test:443/" });
    const link = screen.getByRole("link", {
      name: "settings.ownerRemote.openWebsite",
    });
    expect(link).toHaveAttribute("href", "https://owner.test/remote/");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText("settings.ownerRemote.listenerOnly")).toBeVisible();
    expect(ownerRemoteApi.start).not.toHaveBeenCalled();
    expect(ownerRemoteApi.createInvite).not.toHaveBeenCalled();
  });

  it.each([
    stopped,
    { ...stopped, httpsOrigin: running.httpsOrigin },
    { ...running, running: false },
    { ...running, enabled: false },
    { ...running, httpsOrigin: "http://owner.test" },
    { ...running, httpsOrigin: "https://owner.test/other" },
    { ...running, httpsOrigin: "https://owner.test/?token=private" },
    { ...running, httpsOrigin: "https://user:private@owner.test" },
    { ...running, httpsOrigin: "https://owner.test/#private" },
  ])(
    "never offers a website link for unavailable or unsafe status %#",
    async (status) => {
      await mount(status);
      expect(
        screen.queryByRole("link", {
          name: "settings.ownerRemote.openWebsite",
        }),
      ).toBeNull();
    },
  );

  it("withdraws the website link when listener status becomes unknown", async () => {
    await mount(running);
    expect(
      screen.getByRole("link", { name: "settings.ownerRemote.openWebsite" }),
    ).toBeVisible();
    vi.mocked(ownerRemoteApi.getStatus).mockRejectedValueOnce(
      new Error("private-status-error"),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "settings.ownerRemote.refreshStatus",
      }),
    );
    await screen.findByRole("alert");
    expect(
      screen.queryByRole("link", { name: "settings.ownerRemote.openWebsite" }),
    ).toBeNull();
    expect(screen.queryByText("settings.ownerRemote.listenerOnly")).toBeNull();
  });

  it.each(Object.entries({ en, zh, zhTW, ja }))(
    "localizes the private-network setup in %s",
    (_locale, messages) => {
      const keys = [
        "tailscaleSteps",
        "setupStepDevices",
        "setupStepAccess",
        "setupStepServe",
        "setupStepOrigin",
        "setupStepEnroll",
        "cloudflareOptional",
        "cloudflareDnsOnly",
        "cloudflareCertificate",
        "cloudflareNoSecrets",
        "openWebsite",
        "listenerOnly",
        "tailscaleConnect",
        "tailscaleActionConnect",
        "tailscaleNeedsApproval",
        "tailscaleReady",
        "tailscaleReachable",
        "tailscaleEnrollDevice",
      ];
      const copy = messages.settings.ownerRemote as Record<string, unknown>;
      for (const key of keys) {
        expect(copy[key], key).toEqual(expect.any(String));
        expect((copy[key] as string).trim().length, key).toBeGreaterThan(0);
      }
    },
  );

  it("shows loading instead of a false Off state before status is known", async () => {
    const status = deferred<OwnerRemoteStatus>();
    vi.mocked(ownerRemoteApi.getStatus).mockReturnValue(status.promise);
    render(<OwnerRemoteHarness />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "settings.ownerRemote.loading",
    );
    expect(screen.getByRole("status")).not.toHaveTextContent(
      "settings.ownerRemote.off",
    );
    expect(toggle()).toBeDisabled();
    await act(async () => status.resolve(stopped));
    expect(screen.getByRole("status")).toHaveTextContent(
      "settings.ownerRemote.off",
    );
  });

  it.each([
    "http://owner.test",
    "https://owner.test/path",
    "https://user:password@owner.test",
    "https://owner.test/?token=private",
    "https://owner.test/#private",
    "not a URL",
  ])("does not enable with an unsafe origin %s", async (origin) => {
    await mount();
    fireEvent.change(originInput(), { target: { value: origin } });
    expect(toggle()).toBeDisabled();
    expect(ownerRemoteApi.start).not.toHaveBeenCalled();
  });

  it("starts only on an explicit switch action and normalizes a root HTTPS URL", async () => {
    await mount();
    const start = deferred<OwnerRemoteStatus>();
    vi.mocked(ownerRemoteApi.start).mockReturnValue(start.promise);
    fireEvent.change(originInput(), {
      target: { value: " https://owner.test/ " },
    });
    expect(ownerRemoteApi.start).not.toHaveBeenCalled();
    expect(toggle()).not.toBeDisabled();
    fireEvent.click(toggle());
    expect(ownerRemoteApi.start).toHaveBeenCalledTimes(1);
    expect(ownerRemoteApi.start).toHaveBeenCalledWith("https://owner.test");
    expect(toggle()).not.toBeChecked();
    expect(toggle()).toBeDisabled();
    await act(async () => start.resolve(running));
    expect(toggle()).toBeChecked();
    expect(screen.getByRole("status")).toHaveTextContent(
      "settings.ownerRemote.running",
    );
    expect(ownerRemoteApi.createInvite).not.toHaveBeenCalled();
  });

  it("restores the persisted enabled state without starting another listener", async () => {
    await mount(running);
    expect(toggle()).toBeChecked();
    expect(ownerRemoteApi.start).not.toHaveBeenCalled();
    expect(ownerRemoteApi.getStatus).toHaveBeenCalledTimes(1);
    vi.mocked(ownerRemoteApi.stop).mockResolvedValue(stopped);
    fireEvent.click(toggle());
    await waitFor(() => expect(toggle()).not.toBeChecked());
    expect(ownerRemoteApi.stop).toHaveBeenCalledTimes(1);
    expect(ownerRemoteApi.start).not.toHaveBeenCalled();
  });

  it("does not optimistically report enabled when starting fails", async () => {
    await mount();
    vi.mocked(ownerRemoteApi.start).mockRejectedValue(
      new Error("private-origin-provider-token"),
    );
    fireEvent.change(originInput(), {
      target: { value: "https://owner.test" },
    });
    fireEvent.click(toggle());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "settings.ownerRemote.error",
    );
    expect(toggle()).not.toBeChecked();
    expect(toggle()).not.toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "settings.ownerRemote.off",
    );
    expect(document.body.textContent).not.toContain(
      "private-origin-provider-token",
    );
  });

  it("uses returned canonical status rather than a second local enabled flag", async () => {
    await mount();
    vi.mocked(ownerRemoteApi.start).mockResolvedValue({
      ...stopped,
      httpsOrigin: "https://owner.test",
      error: "owner_remote_listener_unavailable",
    });
    fireEvent.change(originInput(), {
      target: { value: "https://owner.test" },
    });
    fireEvent.click(toggle());
    await screen.findByRole("alert");
    expect(toggle()).not.toBeChecked();
    expect(toggle()).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "settings.ownerRemote.statusUnavailable",
    );
  });

  it("keeps persisted intent and redacted errors while refreshing a failed stop", async () => {
    await mount(running);
    await createInvite();
    vi.mocked(ownerRemoteApi.stop).mockRejectedValue(
      new Error("private-stop-provider-token"),
    );
    vi.mocked(ownerRemoteApi.getStatus).mockResolvedValue({
      ...running,
      running: false,
    });
    fireEvent.click(toggle());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "settings.ownerRemote.error",
    );
    await waitFor(() => expect(toggle()).not.toBeDisabled());
    expect(toggle()).toBeChecked();
    expect(screen.getByRole("status")).toHaveTextContent(
      "settings.ownerRemote.unavailable",
    );
    expect(inviteButton()).toBeDisabled();
    expect(
      screen.queryByLabelText("settings.ownerRemote.inviteExpires"),
    ).toBeNull();
    expect(document.body.textContent).not.toContain(
      "private-stop-provider-token",
    );
  });
  it("can disable enabled-but-unavailable access even with an invalid saved origin", async () => {
    await mount({
      ...running,
      running: false,
      httpsOrigin: "http://invalid-saved-origin.test",
      error: "owner_remote_listener_unavailable",
    });
    expect(toggle()).toBeChecked();
    expect(toggle()).not.toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "settings.ownerRemote.unavailable",
    );
    expect(inviteButton()).toBeDisabled();
    vi.mocked(ownerRemoteApi.stop).mockResolvedValue(stopped);
    fireEvent.click(toggle());
    await waitFor(() => expect(toggle()).not.toBeChecked());
    expect(ownerRemoteApi.stop).toHaveBeenCalledTimes(1);
    expect(ownerRemoteApi.start).not.toHaveBeenCalled();
  });

  it("keeps first-time origin edits as a draft until explicitly enabled", async () => {
    await mount();
    expect(originInput()).not.toHaveAttribute("readonly");
    fireEvent.change(originInput(), {
      target: { value: "https://another.test/" },
    });
    expect(toggle()).not.toBeChecked();
    expect(ownerRemoteApi.start).not.toHaveBeenCalled();
    expect(ownerRemoteApi.stop).not.toHaveBeenCalled();
    expect(inviteButton()).toBeDisabled();
    vi.mocked(ownerRemoteApi.start).mockResolvedValue({
      ...running,
      httpsOrigin: "https://another.test",
    });
    fireEvent.click(toggle());
    await waitFor(() => expect(inviteButton()).not.toBeDisabled());
    expect(ownerRemoteApi.start).toHaveBeenCalledWith("https://another.test");
    expect(ownerRemoteApi.start).toHaveBeenCalledTimes(1);
    expect(originInput()).toHaveValue("https://another.test");
    expect(originInput()).toHaveAttribute("readonly");
    expect(toggle()).toBeChecked();
  });

  it("can switch access off without editing its pinned website", async () => {
    await mount(running);
    expect(originInput()).toHaveAttribute("readonly");
    expect(toggle()).not.toBeDisabled();
    vi.mocked(ownerRemoteApi.stop).mockResolvedValue({
      ...running,
      enabled: false,
      running: false,
    });
    fireEvent.click(toggle());
    await waitFor(() => expect(toggle()).not.toBeChecked());
    expect(ownerRemoteApi.stop).toHaveBeenCalledTimes(1);
    expect(ownerRemoteApi.start).not.toHaveBeenCalled();
    expect(originInput()).toHaveValue("https://owner.test");
    expect(originInput()).toHaveAttribute("readonly");
  });
  it("allows a configured unavailable listener to retry without toggling it off", async () => {
    await mount({ ...running, running: false });
    vi.mocked(ownerRemoteApi.start).mockResolvedValue(running);
    expect(toggle()).toBeChecked();
    fireEvent.click(
      screen.getByRole("button", {
        name: "settings.ownerRemote.retryListener",
      }),
    );
    await waitFor(() =>
      expect(ownerRemoteApi.start).toHaveBeenCalledWith("https://owner.test"),
    );
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "settings.ownerRemote.running",
      ),
    );
    expect(ownerRemoteApi.start).toHaveBeenCalledTimes(1);
    expect(ownerRemoteApi.stop).not.toHaveBeenCalled();
  });

  it("shows unknown status on read failure and permits a safe explicit retry", async () => {
    vi.mocked(ownerRemoteApi.getStatus)
      .mockRejectedValueOnce(new Error("private-status-provider-token"))
      .mockResolvedValueOnce(running);
    render(<OwnerRemoteHarness />);
    await screen.findByRole("alert");
    expect(screen.getByRole("status")).toHaveTextContent(
      "settings.ownerRemote.statusUnavailable",
    );
    expect(screen.getByRole("status")).not.toHaveTextContent(
      "settings.ownerRemote.off",
    );
    expect(toggle()).toBeDisabled();
    expect(document.body.textContent).not.toContain(
      "private-status-provider-token",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "settings.ownerRemote.retryStatus" }),
    );
    await waitFor(() => expect(toggle()).toBeChecked());
    expect(screen.getByRole("status")).toHaveTextContent(
      "settings.ownerRemote.running",
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(ownerRemoteApi.getStatus).toHaveBeenCalledTimes(2);
    expect(ownerRemoteApi.start).not.toHaveBeenCalled();
  });

  it("does not call a native configuration read error an Off state", async () => {
    await mount({
      ...stopped,
      error: "owner_remote_configuration_unavailable",
    });
    fireEvent.change(originInput(), {
      target: { value: "https://owner.test" },
    });
    expect(toggle()).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "settings.ownerRemote.statusUnavailable",
    );
    vi.mocked(ownerRemoteApi.getStatus).mockResolvedValue({
      ...stopped,
      httpsOrigin: "https://owner.test",
    });
    fireEvent.click(
      screen.getByRole("button", { name: "settings.ownerRemote.retryStatus" }),
    );
    await waitFor(() => expect(toggle()).not.toBeDisabled());
    expect(toggle()).not.toBeChecked();
    expect(screen.getByRole("status")).toHaveTextContent(
      "settings.ownerRemote.off",
    );
    expect(ownerRemoteApi.start).not.toHaveBeenCalled();
  });

  it("keeps disabling available when a refreshed status cannot be read", async () => {
    await mount(running);
    vi.mocked(ownerRemoteApi.getStatus).mockRejectedValueOnce(
      new Error("private-refresh-provider-token"),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "settings.ownerRemote.refreshStatus",
      }),
    );
    await screen.findByRole("alert");
    expect(screen.getByRole("status")).toHaveTextContent(
      "settings.ownerRemote.statusUnavailable",
    );
    expect(toggle()).toBeChecked();
    expect(toggle()).not.toBeDisabled();
    expect(document.body.textContent).not.toContain(
      "private-refresh-provider-token",
    );
    vi.mocked(ownerRemoteApi.stop).mockResolvedValue(stopped);
    fireEvent.click(toggle());
    await waitFor(() => expect(toggle()).not.toBeChecked());
    expect(screen.getByRole("status")).toHaveTextContent(
      "settings.ownerRemote.off",
    );
    expect(ownerRemoteApi.stop).toHaveBeenCalledTimes(1);
  });
  it("prevents duplicate starts and overlapping refreshes while a mutation is pending", async () => {
    await mount();
    const start = deferred<OwnerRemoteStatus>();
    vi.mocked(ownerRemoteApi.start).mockReturnValue(start.promise);
    fireEvent.change(originInput(), {
      target: { value: "https://owner.test" },
    });
    act(() => {
      fireEvent.click(toggle());
      fireEvent.click(toggle());
      fireEvent.click(
        screen.getByRole("button", {
          name: "settings.ownerRemote.refreshStatus",
        }),
      );
    });
    expect(ownerRemoteApi.start).toHaveBeenCalledTimes(1);
    expect(ownerRemoteApi.getStatus).toHaveBeenCalledTimes(1);
    expect(ownerRemoteApi.stop).not.toHaveBeenCalled();
    await act(async () => start.resolve(running));
    expect(toggle()).toBeChecked();
  });

  it("ignores a stale status response after StrictMode cleanup and a newer read", async () => {
    const oldStatus = deferred<OwnerRemoteStatus>();
    const currentStatus = deferred<OwnerRemoteStatus>();
    vi.mocked(ownerRemoteApi.getStatus)
      .mockReturnValueOnce(oldStatus.promise)
      .mockReturnValueOnce(currentStatus.promise);
    render(
      <StrictMode>
        <OwnerRemoteHarness />
      </StrictMode>,
    );
    expect(ownerRemoteApi.getStatus).toHaveBeenCalledTimes(2);
    await act(async () => currentStatus.resolve(stopped));
    expect(screen.getByRole("status")).toHaveTextContent(
      "settings.ownerRemote.off",
    );
    await act(async () => oldStatus.resolve(running));
    expect(toggle()).not.toBeChecked();
    expect(originInput()).toHaveValue("");
    expect(screen.getByRole("status")).toHaveTextContent(
      "settings.ownerRemote.off",
    );
  });

  it("creates a short-lived enrollment link only when explicitly requested", async () => {
    await mount(running);
    const link = await createInvite();
    expect(link).toHaveValue(
      `https://owner.test/remote/#invite=${"a".repeat(43)}`,
    );
    expect(ownerRemoteApi.createInvite).toHaveBeenCalledTimes(1);
    expect(ownerRemoteApi.start).not.toHaveBeenCalled();
    expect(ownerRemoteApi.stop).not.toHaveBeenCalled();
  });

  it("expires and removes an enrollment link", async () => {
    await mount(running);
    vi.useFakeTimers();
    vi.mocked(ownerRemoteApi.createInvite).mockResolvedValue({
      invitationSecret: "b".repeat(43),
      expiresInSeconds: 1,
    });
    await act(async () => fireEvent.click(inviteButton()));
    expect(
      screen.getByLabelText("settings.ownerRemote.inviteExpires"),
    ).toBeVisible();
    act(() => vi.advanceTimersByTime(1000));
    expect(
      screen.queryByLabelText("settings.ownerRemote.inviteExpires"),
    ).toBeNull();
  });

  it("does not reflect secret-bearing setup exceptions", async () => {
    await mount(running);
    vi.mocked(ownerRemoteApi.createInvite).mockRejectedValue(
      new Error("private-secret-provider-token"),
    );
    fireEvent.click(inviteButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "settings.ownerRemote.error",
    );
    expect(document.body.textContent).not.toContain(
      "private-secret-provider-token",
    );
  });

  it("disables access explicitly and does not leave the invite visible", async () => {
    await mount(running);
    await createInvite();
    vi.mocked(ownerRemoteApi.stop).mockResolvedValue(stopped);
    fireEvent.click(toggle());
    await waitFor(() => expect(toggle()).not.toBeChecked());
    expect(ownerRemoteApi.stop).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent(
      "settings.ownerRemote.off",
    );
    expect(
      screen.queryByLabelText("settings.ownerRemote.inviteExpires"),
    ).toBeNull();
  });

  it.each([
    { invitationSecret: "not/a/safe/fragment", expiresInSeconds: 60 },
    { invitationSecret: "c".repeat(43), expiresInSeconds: 600 },
    { invitationSecret: "c".repeat(43), expiresInSeconds: 0 },
    { invitationSecret: "c".repeat(43), expiresInSeconds: Number.NaN },
  ])("rejects malformed enrollment results %#", async (invitation) => {
    await mount(running);
    vi.mocked(ownerRemoteApi.createInvite).mockResolvedValue(invitation);
    fireEvent.click(inviteButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "settings.ownerRemote.error",
    );
    expect(
      screen.queryByLabelText("settings.ownerRemote.inviteExpires"),
    ).toBeNull();
  });

  it("pins a configured website even when remote access is disabled", async () => {
    await mount({ ...running, enabled: false, running: false });
    expect(originInput()).toHaveAttribute("readonly");
    expect(
      screen.getByText("settings.ownerRemote.originPinned"),
    ).toBeInTheDocument();
    fireEvent.change(originInput(), {
      target: { value: "https://another.test" },
    });
    expect(originInput()).toHaveValue("https://owner.test");
    expect(
      screen.queryByRole("button", {
        name: "settings.ownerRemote.applyOrigin",
      }),
    ).not.toBeInTheDocument();
    vi.mocked(ownerRemoteApi.start).mockResolvedValue(running);
    fireEvent.click(toggle());
    await waitFor(() => expect(toggle()).toBeChecked());
    expect(ownerRemoteApi.start).toHaveBeenCalledTimes(1);
    expect(ownerRemoteApi.start).toHaveBeenCalledWith("https://owner.test");
  });

  it("pins a running deployment instead of offering an impossible origin update", async () => {
    await mount(running);
    expect(originInput()).toHaveAttribute("readonly");
    fireEvent.change(originInput(), {
      target: { value: "https://another.test" },
    });
    expect(originInput()).toHaveValue("https://owner.test");
    expect(
      screen.queryByRole("button", {
        name: "settings.ownerRemote.applyOrigin",
      }),
    ).not.toBeInTheDocument();
    expect(ownerRemoteApi.start).not.toHaveBeenCalled();
    expect(ownerRemoteApi.stop).not.toHaveBeenCalled();
  });

  it("reconciles a rejected stop with the backend's closed listener and retained opt-in", async () => {
    await mount(running);
    await createInvite();
    vi.mocked(ownerRemoteApi.stop).mockRejectedValue(
      new Error("private-persistence-provider-token"),
    );
    vi.mocked(ownerRemoteApi.getStatus).mockResolvedValue({
      ...running,
      running: false,
    });
    fireEvent.click(toggle());
    await waitFor(() =>
      expect(ownerRemoteApi.getStatus).toHaveBeenCalledTimes(2),
    );
    await waitFor(() => expect(toggle()).not.toBeDisabled());
    expect(toggle()).toBeChecked();
    expect(screen.getByRole("status")).toHaveTextContent(
      "settings.ownerRemote.unavailable",
    );
    expect(inviteButton()).toBeDisabled();
    expect(
      screen.queryByLabelText("settings.ownerRemote.inviteExpires"),
    ).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "settings.ownerRemote.error",
    );
    expect(document.body.textContent).not.toContain(
      "private-persistence-provider-token",
    );
  });

  it("keeps its mutation lock during authoritative failure reconciliation", async () => {
    await mount(running);
    const status = deferred<OwnerRemoteStatus>();
    vi.mocked(ownerRemoteApi.stop).mockRejectedValue(
      new Error("stop unavailable"),
    );
    vi.mocked(ownerRemoteApi.getStatus).mockReturnValue(status.promise);
    fireEvent.click(toggle());
    await waitFor(() =>
      expect(ownerRemoteApi.getStatus).toHaveBeenCalledTimes(2),
    );
    expect(toggle()).toBeDisabled();
    expect(inviteButton()).toBeDisabled();
    fireEvent.click(toggle());
    expect(ownerRemoteApi.stop).toHaveBeenCalledTimes(1);
    await act(async () => status.resolve({ ...running, running: false }));
    expect(toggle()).not.toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "settings.ownerRemote.unavailable",
    );
  });

  it.each(["start", "stop"] as const)(
    "shows runtime unknown after a rejected %s and failed reconciliation read",
    async (action) => {
      await mount(action === "start" ? stopped : running);
      if (action === "start") {
        fireEvent.change(originInput(), {
          target: { value: "https://owner.test" },
        });
      }
      vi.mocked(ownerRemoteApi[action]).mockRejectedValue(
        new Error("private-mutation-provider-token"),
      );
      vi.mocked(ownerRemoteApi.getStatus).mockRejectedValue(
        new Error("private-reconciliation-provider-token"),
      );
      fireEvent.click(toggle());
      await waitFor(() =>
        expect(screen.getByRole("status")).toHaveTextContent(
          "settings.ownerRemote.statusUnavailable",
        ),
      );
      expect(ownerRemoteApi.getStatus).toHaveBeenCalledTimes(2);
      expect(inviteButton()).toBeDisabled();
      expect(
        screen.queryByText(/settings.ownerRemote.consoleAddress/),
      ).toBeNull();
      expect(
        screen.getByRole("button", {
          name: "settings.ownerRemote.retryStatus",
        }),
      ).not.toBeDisabled();
      expect(toggle()).toHaveAttribute(
        "aria-checked",
        String(action === "stop"),
      );
      expect(document.body.textContent).not.toContain(
        "private-mutation-provider-token",
      );
      expect(document.body.textContent).not.toContain(
        "private-reconciliation-provider-token",
      );
    },
  );
  it.each(["start", "stop"] as const)(
    "defers rejected %s reconciliation while its settings tab is inactive",
    async (action) => {
      const mutation = deferred<OwnerRemoteStatus>();
      vi.mocked(ownerRemoteApi[action]).mockReturnValue(mutation.promise);
      const configuredOff = { ...stopped, httpsOrigin: running.httpsOrigin };
      const view = await mount(action === "stop" ? running : configuredOff);
      fireEvent.click(toggle());
      await waitFor(() =>
        expect(ownerRemoteApi[action]).toHaveBeenCalledTimes(1),
      );
      view.rerender(<OwnerRemoteHarness active={false} />);

      await act(async () => mutation.reject(new Error("private-native-error")));

      expect(ownerRemoteApi.getStatus).toHaveBeenCalledTimes(1);
      vi.mocked(ownerRemoteApi.getStatus).mockResolvedValue(configuredOff);
      view.rerender(<OwnerRemoteHarness />);
      await waitFor(() =>
        expect(ownerRemoteApi.getStatus).toHaveBeenCalledTimes(2),
      );
      await waitFor(() => expect(toggle()).not.toBeDisabled());
      expect(toggle()).not.toBeChecked();
      expect(inviteButton()).toBeDisabled();
      expect(
        screen.queryByText("private-native-error"),
      ).not.toBeInTheDocument();
    },
  );

  it("queues one fresh status read when reactivation meets an older pending read", async () => {
    const initial = deferred<OwnerRemoteStatus>();
    const refreshed = deferred<OwnerRemoteStatus>();
    vi.mocked(ownerRemoteApi.getStatus)
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(refreshed.promise);
    const view = render(<OwnerRemoteHarness />);
    await waitFor(() =>
      expect(ownerRemoteApi.getStatus).toHaveBeenCalledTimes(1),
    );
    view.rerender(<OwnerRemoteHarness active={false} />);
    view.rerender(<OwnerRemoteHarness />);
    view.rerender(<OwnerRemoteHarness active={false} />);
    view.rerender(<OwnerRemoteHarness />);
    expect(ownerRemoteApi.getStatus).toHaveBeenCalledTimes(1);

    await act(async () => initial.resolve(stopped));

    await waitFor(() =>
      expect(ownerRemoteApi.getStatus).toHaveBeenCalledTimes(2),
    );
    expect(toggle()).toBeDisabled();
    await act(async () => refreshed.resolve(running));
    await waitFor(() => expect(toggle()).not.toBeDisabled());
    expect(toggle()).toBeChecked();
    expect(ownerRemoteApi.getStatus).toHaveBeenCalledTimes(2);
  });

  it("does not read status until its settings tab becomes active", async () => {
    vi.mocked(ownerRemoteApi.getStatus).mockResolvedValue(stopped);
    const view = render(<OwnerRemoteHarness active={false} />);
    expect(ownerRemoteApi.getStatus).not.toHaveBeenCalled();
    expect(ownerRemoteApi.start).not.toHaveBeenCalled();

    view.rerender(<OwnerRemoteHarness />);

    await waitFor(() => expect(originInput()).not.toBeDisabled());
    expect(ownerRemoteApi.getStatus).toHaveBeenCalledTimes(1);
    expect(ownerRemoteApi.start).not.toHaveBeenCalled();
  });

  it("discards a pending enrollment response across a hidden-tab round trip", async () => {
    const view = await mount(running);
    const invitation = deferred<{
      invitationSecret: string;
      expiresInSeconds: number;
    }>();
    vi.mocked(ownerRemoteApi.createInvite).mockReturnValue(invitation.promise);
    fireEvent.click(inviteButton());
    view.rerender(<OwnerRemoteHarness active={false} />);
    view.rerender(<OwnerRemoteHarness />);
    expect(inviteButton()).toBeDisabled();
    expect(ownerRemoteApi.getStatus).toHaveBeenCalledTimes(1);

    await act(async () =>
      invitation.resolve({
        invitationSecret: "d".repeat(43),
        expiresInSeconds: 60,
      }),
    );

    expect(
      screen.queryByLabelText("settings.ownerRemote.inviteExpires"),
    ).toBeNull();
    expect(inviteButton()).not.toBeDisabled();
    expect(ownerRemoteApi.createInvite).toHaveBeenCalledTimes(1);
  });

  it("does not publish an enrollment response after unmount", async () => {
    const first = await mount(running);
    const invitation = deferred<{
      invitationSecret: string;
      expiresInSeconds: number;
    }>();
    vi.mocked(ownerRemoteApi.createInvite).mockReturnValue(invitation.promise);
    fireEvent.click(inviteButton());
    first.unmount();
    await mount(running);
    await act(async () =>
      invitation.resolve({
        invitationSecret: "d".repeat(43),
        expiresInSeconds: 60,
      }),
    );
    expect(
      screen.queryByLabelText("settings.ownerRemote.inviteExpires"),
    ).toBeNull();
    expect(inviteButton()).not.toBeDisabled();
  });
});
