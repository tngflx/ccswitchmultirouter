import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CodexSessionTrafficPanel } from "./CodexSessionTrafficPanel";

describe("CodexSessionTrafficPanel", () => {
  it("labels an empty successful collector snapshot without inventing traffic", () => {
    render(
      <CodexSessionTrafficPanel
        isLoading={false}
        error={null}
        rangeLabel="今日"
        isSyncing={false}
        onSync={vi.fn()}
        collectionStatus={{
          revision: 4,
          phase: "idle",
          lastStartedAt: 1_700_000_000,
          lastCompletedAt: 1_700_000_004,
          lastSuccessAt: 1_700_000_004,
          imported: 0,
          deferred: 0,
          errorsCount: 0,
          lastErrorSummary: null,
          nextRunAt: 1_700_000_060,
          intervalSecs: 60,
        }}
      />,
    );

    expect(screen.getByText("Collector idle")).toBeInTheDocument();
    expect(
      screen.getByText(/Last success.*none added this run/),
    ).toBeInTheDocument();
    expect(screen.queryByText("Collection healthy")).not.toBeInTheDocument();
  });

  it("surfaces a degraded collector with its deferred work and error summary", () => {
    render(
      <CodexSessionTrafficPanel
        isLoading={false}
        error={null}
        rangeLabel="今日"
        isSyncing={false}
        onSync={vi.fn()}
        collectionStatus={{
          revision: 8,
          phase: "degraded",
          lastStartedAt: 1_700_000_000,
          lastCompletedAt: 1_700_000_004,
          lastSuccessAt: 1_699_999_940,
          imported: 2,
          deferred: 3,
          errorsCount: 1,
          lastErrorSummary: "rollout 文件仍在写入",
          nextRunAt: 1_700_000_060,
          intervalSecs: 60,
        }}
      />,
    );

    expect(screen.getByText("Collector degraded")).toBeInTheDocument();
    expect(screen.getByText(/deferred 3/)).toBeInTheDocument();
    expect(
      screen.getByText(/Error summary: rollout 文件仍在写入/),
    ).toBeInTheDocument();
  });

  it("does not present a not-started collector as an empty successful run", () => {
    render(
      <CodexSessionTrafficPanel
        isLoading={false}
        error={null}
        rangeLabel="今日"
        isSyncing={false}
        onSync={vi.fn()}
        collectionStatus={{
          revision: 0,
          phase: "not_started",
          lastStartedAt: null,
          lastCompletedAt: null,
          lastSuccessAt: null,
          imported: 0,
          deferred: 0,
          errorsCount: 0,
          lastErrorSummary: null,
          nextRunAt: null,
          intervalSecs: 60,
        }}
      />,
    );

    expect(screen.getByText("Collector not started")).toBeInTheDocument();
    expect(
      screen.getByText(/No successful collection yet; sync now/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/none added this run/)).not.toBeInTheDocument();
  });

  it("calls the existing manual sync path exactly once per click", () => {
    const onSync = vi.fn();
    render(
      <CodexSessionTrafficPanel
        isLoading={false}
        error={null}
        rangeLabel="今日"
        isSyncing={false}
        onSync={onSync}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Sync session usage now" }),
    );
    expect(onSync).toHaveBeenCalledTimes(1);
  });

  it("keeps session usage separate, exposes token dimensions, and marks missing usage unknown", () => {
    render(
      <CodexSessionTrafficPanel
        stats={{
          codexHome: "C:/Users/test/.codex",
          stateDbPath: "C:/private/session-usage.sqlite",
          totalAgents: 4,
          scannedHistoryAgents: 4,
          inRangeAgents: 3,
          unknownRangeAgents: 1,
          observedUsageAgents: 2,
          missingUsageAgents: 1,
          historyTruncated: false,
          proxyUsageIncluded: false,
          agents: [],
          parentGroups: [
            {
              parentSessionId: "observed-parent",
              childSessionCount: 1,
              observedUsageChildren: 1,
              missingUsageChildren: 0,
              childRequestCount: 3,
              childInputTokens: 80,
              childCacheReadTokens: 20,
              childCacheCreationTokens: 0,
              childOutputTokens: 40,
              childTotalTokens: 140,
              parentDirectUsage: {
                requestCount: 2,
                inputTokens: 50,
                cacheReadTokens: 10,
                cacheCreationTokens: 0,
                outputTokens: 30,
                totalTokens: 90,
              },
              parentDirectUsageSource: "session_sync",
            },
            {
              parentSessionId: "missing-parent",
              childSessionCount: 1,
              observedUsageChildren: 0,
              missingUsageChildren: 1,
              childRequestCount: 0,
              childInputTokens: 0,
              childCacheReadTokens: 0,
              childCacheCreationTokens: 0,
              childOutputTokens: 0,
              childTotalTokens: 0,
              parentDirectUsage: null,
              parentDirectUsageSource: "none",
              parentUsageStatus: "unknown_may_overlap",
            },
          ],
          modelStats: [
            {
              model: "gpt-5.6-sol",
              agentCount: 2,
              observedUsageAgents: 2,
              missingUsageAgents: 1,
              requestCount: 8,
              inputTokens: 120,
              cacheReadTokens: 30,
              cacheCreationTokens: 0,
              outputTokens: 60,
              totalTokens: 210,
              totalCost: "0",
            },
            {
              model: "unreported-model",
              agentCount: 1,
              observedUsageAgents: 0,
              missingUsageAgents: 1,
              requestCount: 0,
              inputTokens: 0,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              totalCost: "0",
            },
          ],
        }}
        isLoading={false}
        error={null}
        rangeLabel="今日（本地日历日）"
        isSyncing={false}
        onSync={vi.fn()}
      />,
    );

    expect(
      screen.getByText("今日（本地日历日） sub-agent session traffic"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /request and session totals are independent and must not be added together/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Observed requests")).toBeInTheDocument();
    expect(
      screen.getByText(
        /sessions have an unknown range and are excluded; they are not uncollected usage/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Uncached input")).toBeInTheDocument();
    expect(screen.getByText("Cache reads")).toBeInTheDocument();
    expect(screen.getByText("Output tokens")).toBeInTheDocument();
    expect(screen.getAllByText("Uncollected")).toHaveLength(5);
    fireEvent.mouseDown(screen.getByRole("tab", { name: "By task" }), {
      button: 0,
    });
    expect(
      screen.getByText(
        /Parent direct usage is recorded but is not added to child usage/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Parent sync records may include child usage; it is not counted for now/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Request latency is not collected reliably for sessions, so it is not shown as 0 ms/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Source: CCSM local session usage ledger/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/State database:|Not located/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("C:/private/session-usage.sqlite"),
    ).not.toBeInTheDocument();
  });

  it("shows an observed-only overview and keeps unpriced observed work out of a complete-cost claim", () => {
    render(
      <CodexSessionTrafficPanel
        stats={{
          codexHome: "",
          totalAgents: 2,
          agents: [],
          observedUsageAgents: 2,
          missingUsageAgents: 0,
          modelStats: [
            {
              model: "priced-model",
              agentCount: 1,
              observedUsageAgents: 1,
              missingUsageAgents: 0,
              requestCount: 3,
              inputTokens: 120,
              cacheReadTokens: 40,
              cacheCreationTokens: 0,
              outputTokens: 20,
              totalTokens: 180,
              totalCost: "0.0125",
            },
            {
              model: "unpriced-model",
              agentCount: 1,
              observedUsageAgents: 1,
              missingUsageAgents: 0,
              requestCount: 2,
              inputTokens: 80,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              outputTokens: 10,
              totalTokens: 90,
              totalCost: "0",
            },
          ],
        }}
        isLoading={false}
        error={null}
        rangeLabel="今日"
        isSyncing={false}
        onSync={vi.fn()}
      />,
    );

    expect(
      screen.getByText("Observed subtask tokens").parentElement,
    ).toHaveTextContent("270");
    expect(
      screen.getByText("Observed requests").parentElement,
    ).toHaveTextContent("5");
    expect(
      screen.getByText("Known price-table estimate").parentElement,
    ).toHaveTextContent("~ $0.0125");
    expect(
      screen.getByText(
        /Partially priced; some observed usage is still unpriced/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Total cost")).not.toBeInTheDocument();
  });

  it("does not turn loading, absent, or missing-only snapshots into observed zero traffic", () => {
    const { rerender } = render(
      <CodexSessionTrafficPanel
        isLoading
        error={null}
        rangeLabel="今日"
        isSyncing={false}
        onSync={vi.fn()}
      />,
    );
    expect(
      screen.getByText("Observed subtask tokens").parentElement,
    ).toHaveTextContent("Loading");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "By task" }), {
      button: 0,
    });
    expect(
      screen.getByText("Reading task relationships for this period…"),
    ).toBeInTheDocument();

    rerender(
      <CodexSessionTrafficPanel
        isLoading={false}
        error={null}
        rangeLabel="今日"
        isSyncing={false}
        onSync={vi.fn()}
      />,
    );
    expect(
      screen.getByText("Observed subtask tokens").parentElement,
    ).toHaveTextContent("—");
    expect(screen.getAllByText("No collected snapshot yet")).toHaveLength(2);

    rerender(
      <CodexSessionTrafficPanel
        stats={{
          codexHome: "",
          totalAgents: 1,
          observedUsageAgents: 0,
          missingUsageAgents: 1,
          agents: [],
          modelStats: [
            {
              model: "waiting-model",
              agentCount: 1,
              observedUsageAgents: 0,
              missingUsageAgents: 1,
              requestCount: 0,
              inputTokens: 0,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              totalCost: "0",
            },
          ],
        }}
        isLoading={false}
        error={null}
        rangeLabel="今日"
        isSyncing={false}
        onSync={vi.fn()}
      />,
    );
    expect(
      screen.getByText("Observed subtask tokens").parentElement,
    ).toHaveTextContent("—");
    expect(screen.getAllByText(/Only uncollected sessions/)).toHaveLength(2);
  });

  it("sorts and filters the model view without treating missing usage as zero", () => {
    render(
      <CodexSessionTrafficPanel
        stats={{
          codexHome: "",
          totalAgents: 3,
          agents: [],
          modelStats: [
            {
              model: "alpha-unpriced",
              agentCount: 1,
              observedUsageAgents: 1,
              missingUsageAgents: 0,
              requestCount: 1,
              inputTokens: 20,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              outputTokens: 2,
              totalTokens: 22,
              totalCost: "0",
            },
            {
              model: "zeta-priced",
              agentCount: 1,
              observedUsageAgents: 1,
              missingUsageAgents: 0,
              requestCount: 4,
              inputTokens: 100,
              cacheReadTokens: 20,
              cacheCreationTokens: 0,
              outputTokens: 10,
              totalTokens: 130,
              totalCost: "0.02",
            },
          ],
        }}
        isLoading={false}
        error={null}
        rangeLabel="今日"
        isSyncing={false}
        onSync={vi.fn()}
      />,
    );

    fireEvent.mouseDown(screen.getByRole("tab", { name: "By model" }), {
      button: 0,
    });
    fireEvent.click(screen.getByRole("button", { name: "Sort by model name" }));
    expect(screen.getByTestId("model-rows").textContent).toMatch(
      /alpha-unpriced[\s\S]*zeta-priced/,
    );

    fireEvent.click(screen.getByRole("combobox", { name: "Filter models" }));
    fireEvent.click(screen.getByRole("option", { name: "Unpriced only" }));
    expect(screen.getByText("alpha-unpriced")).toBeInTheDocument();
    expect(screen.queryByText("zeta-priced")).not.toBeInTheDocument();
    expect(
      screen.getByText(/Unpriced \/ needs verification/),
    ).toBeInTheDocument();
  });

  it("groups only explicit parents and opens a detail sheet with source and unknown attribution", () => {
    render(
      <CodexSessionTrafficPanel
        stats={{
          codexHome: "",
          totalAgents: 3,
          agents: [
            {
              sessionId: "child-a",
              title: "可追溯子任务",
              parentThreadId: "explicit-parent",
              primaryModel: "gpt-detail",
              models: ["gpt-detail"],
              requestCount: 2,
              inputTokens: 50,
              cacheReadTokens: 10,
              cacheCreationTokens: 0,
              outputTokens: 20,
              totalTokens: 80,
              totalCost: "0.01",
              usageStatus: "observed",
              usageSource: "session_sync",
            },
            {
              sessionId: "child-b",
              title: "同一父任务的子任务",
              parentThreadId: "explicit-parent",
              models: [],
              requestCount: 1,
              inputTokens: 6,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              outputTokens: 4,
              totalTokens: 10,
              totalCost: "0.002",
              usageStatus: "observed",
              usageSource: "rollout",
            },
            {
              sessionId: "unrelated",
              title: "未关联会话",
              models: [],
              requestCount: 0,
              inputTokens: 0,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              totalCost: "0",
              usageStatus: "missing",
              usageSource: "none",
            },
          ],
          modelStats: [],
          parentGroups: [
            {
              parentSessionId: "explicit-parent",
              childSessionCount: 2,
              observedUsageChildren: 2,
              missingUsageChildren: 0,
              childRequestCount: 3,
              childInputTokens: 56,
              childCacheReadTokens: 10,
              childCacheCreationTokens: 0,
              childOutputTokens: 24,
              childTotalTokens: 90,
              parentDirectUsage: null,
              parentDirectUsageSource: "none",
              parentUsageStatus: "unknown_may_overlap",
            },
          ],
        }}
        isLoading={false}
        error={null}
        rangeLabel="今日"
        isSyncing={false}
        onSync={vi.fn()}
      />,
    );

    fireEvent.mouseDown(screen.getByRole("tab", { name: "By task" }), {
      button: 0,
    });
    expect(screen.getByText(/Parent explicit-parent/)).toBeInTheDocument();
    expect(screen.getByText(/Unlinked sessions \(1\)/)).toBeInTheDocument();
    expect(screen.queryByText(/^Parent model:/)).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "View explicit-parent Details" }),
    );

    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Local session evidence (mixed sources)",
    );
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Parent sync records may include child usage; it is not counted for now",
    );
    expect(screen.getByRole("dialog")).toHaveTextContent("可追溯子任务");
  });

  it("keeps missing model, child, and parent-group detail values unknown even with a legacy parent direct record", () => {
    render(
      <CodexSessionTrafficPanel
        stats={{
          codexHome: "",
          totalAgents: 1,
          observedUsageAgents: 0,
          missingUsageAgents: 1,
          agents: [
            {
              sessionId: "missing-child",
              title: "未采集子任务",
              parentThreadId: "legacy-parent",
              models: [],
              requestCount: 0,
              inputTokens: 0,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              totalCost: "0",
              usageStatus: "missing",
              usageSource: "none",
            },
          ],
          modelStats: [
            {
              model: "missing-model",
              agentCount: 1,
              observedUsageAgents: 0,
              missingUsageAgents: 1,
              requestCount: 0,
              inputTokens: 0,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              totalCost: "0",
            },
          ],
          parentGroups: [
            {
              parentSessionId: "legacy-parent",
              childSessionCount: 1,
              observedUsageChildren: 0,
              missingUsageChildren: 1,
              childRequestCount: 0,
              childInputTokens: 0,
              childCacheReadTokens: 0,
              childCacheCreationTokens: 0,
              childOutputTokens: 0,
              childTotalTokens: 0,
              parentDirectUsage: {
                requestCount: 5,
                inputTokens: 10,
                cacheReadTokens: 4,
                cacheCreationTokens: 0,
                outputTokens: 3,
                totalTokens: 17,
              },
              parentDirectUsageSource: "session_sync",
              parentUsageStatus: "unknown_may_overlap",
            },
          ],
        }}
        isLoading={false}
        error={null}
        rangeLabel="今日"
        isSyncing={false}
        onSync={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /missing-model/ }));
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "No usage evidence yet",
    );
    expect(screen.getByRole("dialog")).not.toHaveTextContent("Token breakdown");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    fireEvent.mouseDown(screen.getByRole("tab", { name: "By task" }), {
      button: 0,
    });
    expect(
      screen.getByText(/Subtask usage is uncollected/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Parent sync records may include child usage; it is not counted for now/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Parent direct usage is recorded/),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "View legacy-parent Details" }),
    );
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "No usage evidence yet",
    );
    expect(screen.getByRole("dialog")).not.toHaveTextContent("Token breakdown");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(
      screen.getByRole("button", { name: "View missing-child Details" }),
    );
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "No usage evidence yet",
    );
    expect(screen.getByRole("dialog")).not.toHaveTextContent("Token breakdown");
  });
});
