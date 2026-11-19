import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ProviderCard } from "@/components/providers/ProviderCard";
import { usageApi } from "@/lib/api/usage";
import { KEEP_LAST_GOOD_MS } from "@/lib/query/queries";
import { usageKeys } from "@/lib/query/usage";
import { createUsageScript, type Provider } from "@/types";

const getProviderHealth = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api/failover", () => ({
  failoverApi: { getProviderHealth },
}));

const noop = () => undefined;
const actions = {
  onSwitch: noop,
  onEdit: noop,
  onDelete: noop,
  onDuplicate: noop,
  onConfigureUsage: noop,
  onOpenWebsite: noop,
};

const quotaProvider: Provider = {
  id: "quota-provider",
  name: "Quota provider",
  category: "custom",
  settingsConfig: { auth: { OPENAI_API_KEY: "test-placeholder" } },
  meta: { usage_script: createUsageScript({ enabled: true }) },
};

function renderQuotaCard(client: QueryClient, isCurrent: boolean) {
  return render(
    <QueryClientProvider client={client}>
      <ProviderCard
        appId="codex"
        provider={quotaProvider}
        isCurrent={isCurrent}
        isProxyRunning={false}
        {...actions}
      />
    </QueryClientProvider>,
  );
}

it("only observes provider health while the failover badge can be shown", async () => {
  const client = new QueryClient();
  const queryKey = ["providerHealth", "provider-1", "codex"];
  const provider = {
    id: "provider-1",
    name: "Test provider",
    category: "custom" as const,
    settingsConfig: {},
  };
  getProviderHealth.mockResolvedValue({
    consecutive_failures: 0,
    is_healthy: true,
  });

  const card = (isProxyRunning: boolean, isInFailoverQueue: boolean) => (
    <QueryClientProvider client={client}>
      <ProviderCard
        appId="codex"
        provider={provider}
        isCurrent={false}
        isProxyRunning={isProxyRunning}
        isInFailoverQueue={isInFailoverQueue}
        {...actions}
      />
    </QueryClientProvider>
  );

  const { rerender } = render(card(false, true));
  expect(client.getQueryCache().find({ queryKey })).toBeUndefined();
  expect(getProviderHealth).not.toHaveBeenCalled();

  rerender(card(true, false));
  expect(client.getQueryCache().find({ queryKey })).toBeUndefined();
  expect(getProviderHealth).not.toHaveBeenCalled();

  rerender(card(true, true));
  expect(await screen.findByText("Operational")).toBeInTheDocument();
  expect(getProviderHealth).toHaveBeenCalledTimes(1);
  expect(getProviderHealth).toHaveBeenCalledWith("provider-1", "codex");

  rerender(card(false, true));
  expect(screen.queryByText("Operational")).not.toBeInTheDocument();
  expect(client.getQueryCache().find({ queryKey })?.getObserversCount()).toBe(
    0,
  );
});

it("shares one usage observer between the card and its quota footer", async () => {
  const client = new QueryClient();
  const query = vi
    .spyOn(usageApi, "query")
    .mockResolvedValueOnce({ success: true, data: [{ remaining: 21 }] })
    .mockResolvedValueOnce({
      success: true,
      data: [{ remaining: 13 }, { remaining: 34 }],
    });

  try {
    renderQuotaCard(client, true);

    const usageObserverCount = () =>
      client
        .getQueryCache()
        .find({ queryKey: usageKeys.script(quotaProvider.id, "codex") })
        ?.getObserversCount();

    expect(await screen.findByText("21.00")).toBeInTheDocument();
    expect(usageObserverCount()).toBe(1);

    fireEvent.click(screen.getByTitle("usage.refreshUsage"));
    expect(await screen.findByText("34.00")).toBeInTheDocument();
    expect(usageObserverCount()).toBe(1);
    expect(query).toHaveBeenCalledTimes(2);
  } finally {
    query.mockRestore();
  }
});

it.each(["failure response", "rejected query"])(
  "expires cached quota after a transient %s without another fetch",
  async (failure) => {
    vi.useFakeTimers();
    const start = new Date("2026-01-01T00:00:00Z");
    vi.setSystemTime(start);
    const client = new QueryClient();
    const error = "Network error: connection reset";
    const query = vi
      .spyOn(usageApi, "query")
      .mockResolvedValueOnce({ success: true, data: [{ remaining: 21 }] });
    if (failure === "rejected query") {
      query.mockRejectedValue(new Error(error));
    } else {
      query.mockResolvedValue({ success: false, error });
    }

    const { unmount } = renderQuotaCard(client, false);
    const advance = (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });

    try {
      await advance(20);
      expect(screen.getByText("21.00")).toBeInTheDocument();
      const queryKey = usageKeys.script(quotaProvider.id, "codex");
      const updatedAt = client.getQueryState(queryKey)!.dataUpdatedAt;

      fireEvent.click(screen.getByTitle("usage.refreshUsage"));
      await advance(1_600);
      await advance(updatedAt + KEEP_LAST_GOOD_MS - Date.now() - 1);
      expect(screen.getByText("21.00")).toBeInTheDocument();

      await advance(1);
      expect(screen.queryByText("21.00")).not.toBeInTheDocument();
      expect(screen.getByText("usage.queryFailed")).toBeInTheDocument();
      expect(query).toHaveBeenCalledTimes(failure === "rejected query" ? 3 : 2);
    } finally {
      unmount();
      client.clear();
      query.mockRestore();
      vi.useRealTimers();
    }
  },
);
