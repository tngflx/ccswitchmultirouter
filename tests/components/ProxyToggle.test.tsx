import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProxyToggle } from "@/components/proxy/ProxyToggle";
import { proxyApi } from "@/lib/api/proxy";
import { useProxyStatus } from "@/hooks/useProxyStatus";

vi.mock("@/hooks/useProxyStatus", () => ({
  useProxyStatus: vi.fn(),
}));

vi.mock("@/lib/api/proxy", () => ({
  proxyApi: {
    isCodexDesktopRunning: vi.fn(),
  },
}));

const setTakeoverForApp = vi.fn().mockResolvedValue(undefined);
const restartCodexDesktop = vi.fn().mockResolvedValue(undefined);

describe("ProxyToggle Codex restart flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useProxyStatus).mockReturnValue({
      isRunning: true,
      takeoverStatus: { codex: false },
      setTakeoverForApp,
      restartCodexDesktop,
      isPending: false,
      isInitialStatusPending: false,
      status: { address: "127.0.0.1", port: 15721 },
    } as unknown as ReturnType<typeof useProxyStatus>);
  });

  it("restarts a running Codex Desktop only after confirmation", async () => {
    vi.mocked(proxyApi.isCodexDesktopRunning).mockResolvedValue(true);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();

    render(<ProxyToggle activeApp="codex" />);
    await user.click(screen.getByRole("switch"));

    await waitFor(() => expect(restartCodexDesktop).toHaveBeenCalledWith(true));
    expect(confirm).toHaveBeenCalledOnce();
    expect(setTakeoverForApp).not.toHaveBeenCalled();
  });

  it("does not terminate Codex when the confirmation is declined", async () => {
    vi.mocked(proxyApi.isCodexDesktopRunning).mockResolvedValue(true);
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup();

    render(<ProxyToggle activeApp="codex" />);
    await user.click(screen.getByRole("switch"));

    await waitFor(() => expect(window.confirm).toHaveBeenCalledOnce());
    expect(restartCodexDesktop).not.toHaveBeenCalled();
    expect(setTakeoverForApp).not.toHaveBeenCalled();
  });

  it("does not mutate takeover when Codex process inspection fails", async () => {
    vi.mocked(proxyApi.isCodexDesktopRunning).mockRejectedValue(
      new Error("CIM unavailable"),
    );
    const user = userEvent.setup();

    render(<ProxyToggle activeApp="codex" />);
    await user.click(screen.getByRole("switch"));

    await waitFor(() =>
      expect(proxyApi.isCodexDesktopRunning).toHaveBeenCalledOnce(),
    );
    expect(restartCodexDesktop).not.toHaveBeenCalled();
    expect(setTakeoverForApp).not.toHaveBeenCalled();
  });
});
