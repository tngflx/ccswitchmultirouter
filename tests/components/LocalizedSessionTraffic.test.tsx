import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import type { i18n } from "i18next";
import { I18nextProvider } from "react-i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodexSessionTrafficPanel } from "@/components/codex/CodexSessionTrafficPanel";
import type { CodexSubagentUsageStats } from "@/types/usage";
import { createLocalizedTestI18n } from "../utils/localizedTestI18n";

function snapshot(): CodexSubagentUsageStats {
  return {
    codexHome: "",
    totalAgents: 3,
    observedUsageAgents: 2,
    missingUsageAgents: 1,
    proxyUsageIncluded: false,
    agents: [
      {
        sessionId: "child-observed",
        title: "Saved task title",
        parentThreadId: "raw-parent-id",
        models: ["zeta-priced"],
        primaryModel: "zeta-priced",
        requestCount: 2,
        inputTokens: 60,
        cacheReadTokens: 20,
        cacheCreationTokens: 0,
        outputTokens: 20,
        totalTokens: 100,
        totalCost: "0.02",
        usageStatus: "observed",
        usageSource: "session_sync",
      },
      {
        sessionId: "child-missing",
        title: "",
        parentThreadId: "raw-parent-id",
        models: ["missing-model"],
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
      {
        sessionId: "unlinked-id",
        title: "",
        models: ["alpha-unpriced"],
        requestCount: 1,
        inputTokens: 50,
        cacheReadTokens: 10,
        cacheCreationTokens: 0,
        outputTokens: 10,
        totalTokens: 70,
        totalCost: "0",
        usageStatus: "observed",
        usageSource: "rollout",
      },
    ],
    modelStats: [
      {
        model: "zeta-priced",
        agentCount: 1,
        observedUsageAgents: 1,
        missingUsageAgents: 0,
        requestCount: 2,
        inputTokens: 60,
        cacheReadTokens: 20,
        cacheCreationTokens: 0,
        outputTokens: 20,
        totalTokens: 100,
        totalCost: "0.02",
      },
      {
        model: "alpha-unpriced",
        agentCount: 1,
        observedUsageAgents: 1,
        missingUsageAgents: 0,
        requestCount: 1,
        inputTokens: 50,
        cacheReadTokens: 10,
        cacheCreationTokens: 0,
        outputTokens: 10,
        totalTokens: 70,
        totalCost: "0",
      },
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
        parentSessionId: "raw-parent-id",
        childSessionCount: 2,
        observedUsageChildren: 1,
        missingUsageChildren: 1,
        childRequestCount: 2,
        childInputTokens: 60,
        childCacheReadTokens: 20,
        childCacheCreationTokens: 0,
        childOutputTokens: 20,
        childTotalTokens: 100,
        parentDirectUsage: {
          requestCount: 999,
          inputTokens: 999,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 0,
          totalTokens: 999,
        },
        parentDirectUsageSource: "session_sync",
        parentUsageStatus: "unknown_may_overlap",
      },
    ],
  };
}

describe("session traffic with production locale resources", () => {
  let locale: i18n;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <I18nextProvider i18n={locale}>{children}</I18nextProvider>
  );
  beforeEach(async () => {
    locale = await createLocalizedTestI18n();
  });
  const props = (
    overrides: Partial<ComponentProps<typeof CodexSessionTrafficPanel>> = {},
  ): ComponentProps<typeof CodexSessionTrafficPanel> => ({
    stats: snapshot(),
    rangeLabel: "Saved range",
    isLoading: false,
    error: null,
    isSyncing: false,
    onSync: vi.fn(),
    ...overrides,
  });

  it("keeps the filter, query, sort and unknown values when the locale changes", async () => {
    const input = props();
    const original = structuredClone(input.stats);
    const { container } = render(<CodexSessionTrafficPanel {...input} />, {
      wrapper,
    });
    expect(container.textContent).not.toMatch(/\p{Script=Han}/u);
    expect(screen.getByText("codex_session").tagName).toBe("CODE");
    fireEvent.click(screen.getByRole("button", { name: "Sort by model name" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search models" }), {
      target: { value: "model" },
    });
    fireEvent.click(screen.getByRole("combobox", { name: "Filter models" }));
    fireEvent.click(
      screen.getByRole("option", { name: "Includes uncollected sessions" }),
    );
    for (const language of ["en", "zh", "zh-TW", "ja"]) {
      await act(() => locale.changeLanguage(language));
      expect(
        screen.getByRole("textbox", {
          name: locale.t("codexSessionTraffic.search"),
        }),
      ).toHaveValue("model");
      expect(
        screen.getByRole("button", {
          name: locale.t("codexSessionTraffic.sortModel"),
        }),
      ).toHaveAttribute("aria-pressed", "true");
      expect(
        screen.getByRole("combobox", {
          name: locale.t("codexSessionTraffic.filter"),
        }),
      ).toHaveTextContent(locale.t("codexSessionTraffic.missingModels"));
      const rows = within(screen.getByTestId("model-rows"));
      expect(rows.getAllByRole("button")).toHaveLength(1);
      const row = rows.getByRole("button", { name: /missing-model/ });
      expect(row).toHaveTextContent(
        locale.t("codexSessionTraffic.missingCount", { total: 1 }),
      );
      expect(
        within(row).getAllByText(locale.t("codexSessionTraffic.uncollected")),
      ).toHaveLength(5);
      expect(row).not.toHaveTextContent("$0");
      expect(
        screen.getByText(locale.t("codexSessionTraffic.observedTokens"))
          .parentElement,
      ).toHaveTextContent("170");
      expect(
        screen.getByText(locale.t("codexSessionTraffic.observedRequests"))
          .parentElement,
      ).toHaveTextContent("3");
      expect(
        screen.getByText(locale.t("codexSessionTraffic.partialPrice")),
      ).toBeInTheDocument();
    }
    expect(input.stats).toEqual(original);
    expect(input.onSync).not.toHaveBeenCalled();
  });

  it("keeps explicit task selection and an open detail sheet without double counting parents", async () => {
    const input = props();
    const original = structuredClone(input.stats);
    render(<CodexSessionTrafficPanel {...input} />, { wrapper });
    fireEvent.mouseDown(screen.getByRole("tab", { name: "By task" }), {
      button: 0,
    });
    expect(screen.getByText("session_meta.parent_thread_id").tagName).toBe(
      "CODE",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "View raw-parent-id Details" }),
    );
    for (const language of ["en", "zh", "zh-TW", "ja"]) {
      await act(() => locale.changeLanguage(language));
      const dialog = screen.getByRole("dialog");
      expect(dialog).toHaveAccessibleName(
        locale.t("codexSessionTraffic.taskDetails", { id: "raw-parent-id" }),
      );
      expect(dialog).toHaveTextContent(
        locale.t("codexSessionTraffic.parentOverlap"),
      );
      expect(dialog).toHaveTextContent(
        locale.t("codexSessionTraffic.incompleteSource"),
      );
      expect(dialog).toHaveTextContent("child-observed");
      expect(dialog).toHaveTextContent("child-missing");
      expect(dialog).toHaveTextContent("Saved task title");
      expect(dialog).not.toHaveTextContent("999");
      expect(
        within(dialog).getByText(
          locale.t("codexSessionTraffic.totalTokens", { total: "100" }),
        ),
      ).toBeInTheDocument();
    }
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: locale.t("codexSessionTraffic.close"),
      }),
    );
    expect(
      screen.getByRole("tab", { name: locale.t("codexSessionTraffic.byTask") }),
    ).toHaveAttribute("aria-selected", "true");
    fireEvent.click(
      screen.getByRole("button", {
        name: locale.t("codexSessionTraffic.viewDetails", {
          id: "child-missing",
        }),
      }),
    );
    for (const language of ["en", "zh", "zh-TW", "ja"]) {
      await act(() => locale.changeLanguage(language));
      const dialog = screen.getByRole("dialog");
      expect(dialog).toHaveTextContent(
        locale.t("codexSessionTraffic.noEvidence"),
      );
      expect(dialog).toHaveTextContent(
        locale.t("codexSessionTraffic.unpriced"),
      );
      expect(dialog).toHaveTextContent("child-missing");
      expect(dialog).not.toHaveTextContent(
        locale.t("codexSessionTraffic.breakdown"),
      );
    }
    expect(input.stats).toEqual(original);
  });

  it("translates collector presentation but preserves raw diagnostics and explicit sync behavior", async () => {
    const input = props({
      syncMessage: "raw-sync-result",
      error: new Error("raw-read-error"),
      collectionStatus: {
        revision: 3,
        phase: "degraded",
        imported: 2,
        deferred: 3,
        errorsCount: 1,
        lastErrorSummary: "raw-diagnostic-123",
        intervalSecs: 60,
      },
    });
    const { rerender } = render(<CodexSessionTrafficPanel {...input} />, {
      wrapper,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Collection diagnostics" }),
    );
    for (const language of ["en", "zh", "zh-TW", "ja"]) {
      await act(() => locale.changeLanguage(language));
      expect(
        screen.getByText(locale.t("codexSessionTraffic.collectorDegraded")),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          locale.t("codexSessionTraffic.collectorTimes", {
            started: locale.t("codexSessionTraffic.notRecorded"),
            completed: locale.t("codexSessionTraffic.notRecorded"),
          }),
          { exact: false },
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          locale.t("codexSessionTraffic.errorSummary", {
            error: "raw-diagnostic-123",
          }),
        ),
      ).toBeInTheDocument();
      expect(screen.getByText("raw-sync-result")).toBeInTheDocument();
      expect(
        screen.getByText(
          locale.t("codexSessionTraffic.readFailed", {
            error: "raw-read-error",
          }),
        ),
      ).toBeInTheDocument();
    }
    expect(input.onSync).not.toHaveBeenCalled();
    const syncButton = screen.getByRole("button", {
      name: locale.t("codexSessionTraffic.sync"),
    });
    fireEvent.click(syncButton);
    expect(input.onSync).toHaveBeenCalledTimes(1);
    expect(input.onSync).toHaveBeenCalledWith(
      expect.objectContaining({ type: "click", target: syncButton }),
    );
    rerender(<CodexSessionTrafficPanel {...input} isSyncing />);
    expect(
      screen.getByRole("button", {
        name: locale.t("codexSessionTraffic.sync"),
      }),
    ).toBeDisabled();
    fireEvent.click(syncButton);
    expect(input.onSync).toHaveBeenCalledTimes(1);
  });

  it.each(["en", "zh", "zh-TW", "ja"])(
    "keeps absent, loading and missing-only summaries unknown in %s",
    async (language) => {
      await locale.changeLanguage(language);
      const input = props({ stats: undefined, isLoading: true });
      const { rerender } = render(<CodexSessionTrafficPanel {...input} />, {
        wrapper,
      });
      const summary = () =>
        screen.getByText(locale.t("codexSessionTraffic.observedTokens"))
          .parentElement;
      expect(summary()).toHaveTextContent(
        locale.t("codexSessionTraffic.loading"),
      );
      rerender(<CodexSessionTrafficPanel {...input} isLoading={false} />);
      expect(summary()).toHaveTextContent("—");
      const missing = snapshot();
      missing.agents = [missing.agents[1]];
      missing.modelStats = [missing.modelStats[2]];
      missing.observedUsageAgents = 0;
      missing.missingUsageAgents = 1;
      rerender(
        <CodexSessionTrafficPanel
          {...input}
          stats={missing}
          isLoading={false}
        />,
      );
      expect(summary()).toHaveTextContent("—");
      expect(
        screen.getByText(locale.t("codexSessionTraffic.missingTokens")),
      ).toBeInTheDocument();
      expect(
        screen.getByText(locale.t("codexSessionTraffic.missingCost")),
      ).toBeInTheDocument();
    },
  );
});
