import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProxyTabContent } from "@/components/settings/ProxyTabContent";
import { useProxyStatus } from "@/hooks/useProxyStatus";
import { proxyApi } from "@/lib/api/proxy";
import type { SettingsFormState } from "@/hooks/useSettings";
import { toast } from "sonner";

vi.mock("@/hooks/useProxyStatus", () => ({ useProxyStatus: vi.fn() }));
vi.mock("@/lib/api/proxy", () => ({
  proxyApi: { isCodexDesktopRunning: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/components/proxy", () => ({
  ProxyPanel: ({
    onTakeoverChange,
  }: {
    onTakeoverChange: (app: string, enabled: boolean) => Promise<boolean>;
  }) => (
    <div>
      <button
        onClick={() => void onTakeoverChange("codex", true).catch(() => {})}
      >
        Codex on
      </button>
      <button
        onClick={() => void onTakeoverChange("codex", false).catch(() => {})}
      >
        Codex off
      </button>
      <button
        onClick={() => void onTakeoverChange("claude", true).catch(() => {})}
      >
        Claude on
      </button>
    </div>
  ),
}));
vi.mock("@/components/ui/accordion", () => ({
  Accordion: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AccordionItem: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AccordionTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AccordionContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("@/components/proxy/AutoFailoverConfigPanel", () => ({
  AutoFailoverConfigPanel: () => null,
}));
vi.mock("@/components/proxy/FailoverQueueManager", () => ({
  FailoverQueueManager: () => null,
}));
vi.mock("@/components/settings/RectifierConfigPanel", () => ({
  RectifierConfigPanel: () => null,
}));
vi.mock("@/components/settings/GlobalProxySettings", () => ({
  GlobalProxySettings: () => null,
}));

const restartCodexDesktop = vi.fn().mockResolvedValue(undefined);
const setTakeoverForApp = vi.fn().mockResolvedValue(undefined);

describe("Settings takeover lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useProxyStatus).mockReturnValue({
      isRunning: true,
      takeoverStatus: { codex: false },
      restartCodexDesktop,
      setTakeoverForApp,
      isPending: false,
    } as unknown as ReturnType<typeof useProxyStatus>);
  });

  const show = () =>
    render(
      <ProxyTabContent
        settings={{ proxyConfirmed: true } as SettingsFormState}
        onAutoSave={vi.fn()}
      />,
    );

  it("restarts running Codex after confirming Codex on", async () => {
    vi.mocked(proxyApi.isCodexDesktopRunning).mockResolvedValue(true);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    show();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Codex on" }));
    await waitFor(() =>
      expect(restartCodexDesktop).toHaveBeenCalledWith(true),
    );
    expect(confirm).toHaveBeenCalledOnce();
    expect(setTakeoverForApp).not.toHaveBeenCalled();
  });

  it("disables Codex takeover directly without restarting Desktop", async () => {
    vi.mocked(useProxyStatus).mockReturnValue({
      isRunning: true,
      takeoverStatus: { codex: true },
      restartCodexDesktop,
      setTakeoverForApp,
      isPending: false,
    } as unknown as ReturnType<typeof useProxyStatus>);
    show();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Codex off" }));
    await waitFor(() =>
      expect(setTakeoverForApp).toHaveBeenCalledWith({
        appType: "codex",
        enabled: false,
      }),
    );
    expect(proxyApi.isCodexDesktopRunning).not.toHaveBeenCalled();
    expect(restartCodexDesktop).not.toHaveBeenCalled();
  });

  it("does not change takeover when restart is declined", async () => {
    vi.mocked(proxyApi.isCodexDesktopRunning).mockResolvedValue(true);
    vi.spyOn(window, "confirm").mockReturnValue(false);
    show();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Codex on" }));
    await waitFor(() => expect(window.confirm).toHaveBeenCalledOnce());
    expect(restartCodexDesktop).not.toHaveBeenCalled();
    expect(setTakeoverForApp).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("does not change takeover when process inspection fails", async () => {
    vi.mocked(proxyApi.isCodexDesktopRunning).mockRejectedValue(
      new Error("CIM unavailable"),
    );
    show();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Codex on" }));
    await waitFor(() =>
      expect(proxyApi.isCodexDesktopRunning).toHaveBeenCalledOnce(),
    );
    expect(restartCodexDesktop).not.toHaveBeenCalled();
    expect(setTakeoverForApp).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledOnce();
  });

  it("uses ordinary mutation for other apps", async () => {
    show();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Claude on" }));
    await waitFor(() =>
      expect(setTakeoverForApp).toHaveBeenCalledWith({
        appType: "claude",
        enabled: true,
      }),
    );
    expect(proxyApi.isCodexDesktopRunning).not.toHaveBeenCalled();
  });
});
