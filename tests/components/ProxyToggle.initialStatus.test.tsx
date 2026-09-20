import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProxyToggle } from "@/components/proxy/ProxyToggle";

const useProxyStatusMock = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/useProxyStatus", () => ({
  useProxyStatus: useProxyStatusMock,
}));

describe("ProxyToggle initial status", () => {
  beforeEach(() => useProxyStatusMock.mockReset());

  it("does not allow takeover before initial status resolves", () => {
    const state = {
      isRunning: false,
      takeoverStatus: undefined,
      setTakeoverForApp: vi.fn(),
      isPending: false,
      isInitialStatusPending: true,
      status: undefined,
    };
    useProxyStatusMock.mockImplementation(() => state);
    const { rerender } = render(<ProxyToggle activeApp="claude" />);
    expect(screen.getByRole("switch")).toBeDisabled();

    state.isInitialStatusPending = false;
    rerender(<ProxyToggle activeApp="claude" />);
    expect(screen.getByRole("switch")).toBeEnabled();
  });
});
