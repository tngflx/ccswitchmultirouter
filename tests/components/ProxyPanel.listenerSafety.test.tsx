import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProxyPanel } from "@/components/proxy/ProxyPanel";
import type { GlobalProxyConfig } from "@/types/proxy";

const state = vi.hoisted(() => ({
  config: {} as GlobalProxyConfig,
  running: false,
  statusLoaded: true,
  mutateAsync: vi.fn(),
  error: vi.fn(),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: state.error } }));
vi.mock("@/lib/query/proxy", () => ({
  useProxyStatusQuery: () => ({
    data: state.statusLoaded
      ? {
          running: state.running,
          active_targets: [],
          address: state.config.listenAddress,
          port: 15721,
          uptime_seconds: 0,
          success_rate: 0,
          total_requests: 0,
          success_requests: 0,
          failed_requests: 0,
          active_connections: 0,
        }
      : undefined,
  }),
  useProxyTakeoverStatus: () => ({ data: {} }),
  useSetProxyTakeoverForApp: () => ({ mutateAsync: vi.fn() }),
  useGlobalProxyConfig: () => ({ data: state.config }),
  useUpdateGlobalProxyConfig: () => ({ mutateAsync: state.mutateAsync }),
  proxyKeys: {},
}));
vi.mock("@/lib/query/failover", () => ({
  useFailoverQueue: () => ({ data: [] }),
  useProviderHealth: () => ({}),
}));
function showPanel() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ProxyPanel
        enableLocalProxy
        onEnableLocalProxyChange={vi.fn()}
        onToggleProxy={vi.fn()}
        isProxyPending={false}
      />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  state.config = {
    proxyEnabled: true,
    listenAddress: "0.0.0.0",
    listenPort: 15721,
    enableLogging: false,
    codexRespectSystemProxy: true,
  };
  state.running = false;
  state.statusLoaded = true;
  state.mutateAsync.mockReset().mockResolvedValue(undefined);
  state.error.mockReset();
});
describe("takeover listener safety", () => {
  it("repairs a legacy network bind through canonical settings without changing other fields", async () => {
    showPanel();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "proxy.settings.loopbackOnly",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "proxy.settings.useLocalhost" }),
    );
    await waitFor(() =>
      expect(state.mutateAsync).toHaveBeenCalledWith({
        ...state.config,
        listenAddress: "127.0.0.1",
      }),
    );
    expect(
      screen.getByLabelText("proxy.settings.fields.listenAddress.label"),
    ).toHaveValue("127.0.0.1");
  });
  it("does not silently rebind a running listener", () => {
    state.running = true;
    showPanel();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "proxy.settings.stopBeforeRepair",
    );
    expect(
      screen.getByRole("button", { name: "proxy.settings.useLocalhost" }),
    ).toBeDisabled();
    expect(state.mutateAsync).not.toHaveBeenCalled();
  });
  it("does not treat an unloaded runtime status as a stopped listener", () => {
    state.statusLoaded = false;
    showPanel();
    expect(
      screen.getByRole("button", { name: "proxy.settings.useLocalhost" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "common.save" })).toBeDisabled();
  });
  it("saves canonical IPv6 loopback without changing unrelated settings", async () => {
    state.config.listenAddress = "127.0.0.1";
    showPanel();
    fireEvent.change(
      screen.getByLabelText("proxy.settings.fields.listenAddress.label"),
      { target: { value: "0:0:0:0:0:0:0:1" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "common.save" }));
    await waitFor(() =>
      expect(state.mutateAsync).toHaveBeenCalledWith({
        ...state.config,
        listenAddress: "::1",
      }),
    );
  });
  it("retains legacy settings and reports a failed repair", async () => {
    state.mutateAsync.mockRejectedValueOnce(new Error("synthetic failure"));
    showPanel();
    fireEvent.click(
      screen.getByRole("button", { name: "proxy.settings.useLocalhost" }),
    );
    await waitFor(() => expect(state.error).toHaveBeenCalled());
    expect(
      screen.getByLabelText("proxy.settings.fields.listenAddress.label"),
    ).toHaveValue("0.0.0.0");
  });
  it("rejects a new non-loopback bind before saving", async () => {
    state.config.listenAddress = "127.0.0.1";
    showPanel();
    fireEvent.change(
      screen.getByLabelText("proxy.settings.fields.listenAddress.label"),
      { target: { value: "192.0.2.1" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "common.save" }));
    await waitFor(() =>
      expect(state.error).toHaveBeenCalledWith("proxy.settings.loopbackOnly"),
    );
    expect(state.mutateAsync).not.toHaveBeenCalled();
  });
});
