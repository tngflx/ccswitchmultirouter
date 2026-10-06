import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManagerPage } from "@/components/sessions/SessionManagerPage";
import { piApi } from "@/lib/api/pi";
import { sessionsApi } from "@/lib/api/sessions";
import type { SessionMessage, SessionMeta } from "@/types";
import { setSessionFixtures } from "../msw/state";

const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();
const GROUP_EXPANSION_STORAGE_KEY =
  "cc-switch.sessionManager.groupExpansionState";

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

vi.mock("@/components/sessions/SessionToc", () => ({
  SessionTocSidebar: () => null,
  SessionTocDialog: () => null,
}));

vi.mock("@/components/ConfirmDialog", () => ({
  ConfirmDialog: ({
    isOpen,
    title,
    message,
    confirmText,
    cancelText,
    onConfirm,
    onCancel,
  }: {
    isOpen: boolean;
    title: string;
    message: string;
    confirmText: string;
    cancelText: string;
    onConfirm: () => void;
    onCancel: () => void;
  }) =>
    isOpen ? (
      <div data-testid="confirm-dialog">
        <div>{title}</div>
        <div>{message}</div>
        <button onClick={onConfirm}>{confirmText}</button>
        <button onClick={onCancel}>{cancelText}</button>
      </div>
    ) : null,
}));

const renderPage = (appId = "codex") => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <SessionManagerPage appId={appId} />
      </QueryClientProvider>,
    ),
  };
};

/// 渲染 SessionManagerPage 并显式传入 initialCodexHistoryRepair；
/// 用于验证独立调用方请求打开历史修复页面时的一次性消费流程。
function renderPageWithRepair({
  appId = "codex",
  initialCodexHistoryRepair = false,
  onInitialCodexHistoryRepairConsumed,
  onCodexHistoryRepairCompleted,
}: {
  appId?: string;
  initialCodexHistoryRepair?: boolean;
  onInitialCodexHistoryRepairConsumed?: () => void;
  onCodexHistoryRepairCompleted?: () => void | Promise<void>;
} = {}) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <SessionManagerPage
          appId={appId}
          initialCodexHistoryRepair={initialCodexHistoryRepair}
          onInitialCodexHistoryRepairConsumed={
            onInitialCodexHistoryRepairConsumed
          }
          onCodexHistoryRepairCompleted={onCodexHistoryRepairCompleted}
        />
      </QueryClientProvider>,
    ),
  };
}

const openSearch = () => {
  const searchButton = Array.from(screen.getAllByRole("button")).find(
    (button) => button.querySelector(".lucide-search"),
  );

  if (!searchButton) {
    throw new Error("Search button not found");
  }

  fireEvent.click(searchButton);
};

const closeSearch = () => {
  const closeButton = Array.from(screen.getAllByRole("button")).find((button) =>
    button.querySelector(".lucide-x"),
  );

  if (!closeButton) {
    throw new Error("Search close button not found");
  }

  fireEvent.click(closeButton);
};

const openViewModeMenu = async () => {
  await userEvent.click(screen.getByRole("combobox", { name: /View mode/i }));
};

const switchToGroupedView = async () => {
  await openViewModeMenu();
  const groupedOption = await screen.findByRole("option", { name: /Grouped/i });
  await userEvent.click(groupedOption);
  await waitFor(() =>
    expect(
      screen.queryByRole("option", { name: /Grouped/i }),
    ).not.toBeInTheDocument(),
  );
};

const switchProviderFilter = async (providerLabel: RegExp) => {
  const providerFilterTrigger = screen.getByRole("combobox", {
    name: /Provider filter/i,
  });

  await userEvent.click(providerFilterTrigger);
  await userEvent.click(
    await screen.findByRole("option", { name: providerLabel }),
  );
};

const enterGroupedBatchMode = async () => {
  await switchToGroupedView();
  fireEvent.click(screen.getByRole("button", { name: /Bulk manage/i }));
};

const collapseAllGroups = () => {
  fireEvent.click(screen.getByRole("button", { name: /Collapse all/i }));
};

const expandDirectoryGroup = (provider: string, directory: string) => {
  fireEvent.click(
    screen.getByRole("button", {
      name: new RegExp(`Expand or collapse the ${provider} provider group`),
    }),
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: new RegExp(`Expand or collapse the ${directory} directory group`),
    }),
  );
};

describe("SessionManagerPage", () => {
  beforeEach(() => {
    toastSuccessMock.mockReset();
    toastErrorMock.mockReset();
    Element.prototype.scrollIntoView = vi.fn();
    window.localStorage.removeItem("cc-switch.sessionManager.listViewMode");
    window.localStorage.removeItem(GROUP_EXPANSION_STORAGE_KEY);

    const sessions: SessionMeta[] = [
      {
        providerId: "codex",
        sessionId: "codex-session-1",
        title: "Alpha Session",
        summary: "Alpha summary",
        projectDir: "/mock/codex",
        createdAt: 2,
        lastActiveAt: 20,
        sourcePath: "/mock/codex/session-1.jsonl",
        resumeCommand: "codex resume codex-session-1",
      },
      {
        providerId: "codex",
        sessionId: "codex-session-2",
        title: "Beta Session",
        summary: "Beta summary",
        projectDir: "/mock/codex",
        createdAt: 1,
        lastActiveAt: 10,
        sourcePath: "/mock/codex/session-2.jsonl",
        resumeCommand: "codex resume codex-session-2",
      },
      {
        providerId: "claude",
        sessionId: "claude-session-1",
        title: "Claude Session",
        summary: "Claude summary",
        projectDir: "/mock/claude",
        createdAt: 3,
        lastActiveAt: 30,
        sourcePath: "/mock/claude/session-1.jsonl",
        resumeCommand: "claude --resume claude-session-1",
      },
      {
        providerId: "codex",
        sessionId: "codex-session-3",
        title: "Gamma Session",
        summary: "Gamma summary",
        projectDir: null,
        createdAt: 0,
        lastActiveAt: 5,
        sourcePath: "/mock/codex/session-3.jsonl",
        resumeCommand: "codex resume codex-session-3",
      },
    ];
    const messages: Record<string, SessionMessage[]> = {
      "codex:/mock/codex/session-1.jsonl": [
        { role: "user", content: "alpha", ts: 20 },
      ],
      "codex:/mock/codex/session-2.jsonl": [
        { role: "user", content: "beta", ts: 10 },
      ],
      "codex:/mock/codex/session-3.jsonl": [
        { role: "user", content: "gamma", ts: 5 },
      ],
      "claude:/mock/claude/session-1.jsonl": [
        { role: "user", content: "claude", ts: 30 },
      ],
    };

    setSessionFixtures(sessions, messages);
  });

  it("surfaces a relative Pi sessionDir instead of presenting an empty scan as authoritative", async () => {
    const discovery = vi.spyOn(piApi, "getSessionDiscovery").mockResolvedValue({
      status: "requires_project_context",
      configuredPath: ".pi/sessions",
    });

    renderPage("pi");

    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent(".pi/sessions");
    expect(discovery).toHaveBeenCalledTimes(1);
    discovery.mockRestore();
  });

  it("deletes the selected session and selects the next visible session", async () => {
    renderPage();

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Alpha Session" }),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /Delete session/i }));

    const dialog = screen.getByTestId("confirm-dialog");
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText(/Alpha Session/)).toBeInTheDocument();

    fireEvent.click(
      within(dialog).getByRole("button", { name: /Delete session/i }),
    );

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Beta Session" }),
      ).toBeInTheDocument(),
    );

    expect(screen.queryByText("Alpha Session")).not.toBeInTheDocument();
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).toHaveBeenCalled();
  });

  it("removes a deleted session from filtered search results", async () => {
    renderPage();

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Alpha Session" }),
      ).toBeInTheDocument(),
    );

    openSearch();

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Alpha" },
    });

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Alpha Session" }),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /Delete session/i }));

    const dialog = screen.getByTestId("confirm-dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: /Delete session/i }),
    );

    await waitFor(() =>
      expect(screen.queryByText("Alpha Session")).not.toBeInTheDocument(),
    );

    expect(
      screen.getByText("sessionManager.selectSession"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("sessionManager.emptySession"),
    ).not.toBeInTheDocument();
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).toHaveBeenCalled();
  });

  it("restores batch delete controls when deleteMany rejects", async () => {
    const deleteManySpy = vi
      .spyOn(sessionsApi, "deleteMany")
      .mockRejectedValueOnce(new Error("network error"));

    renderPage();

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Alpha Session" }),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /Bulk manage/i }));
    fireEvent.click(
      screen.getByRole("button", { name: /Select all visible/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Bulk delete/i }));

    const dialog = screen.getByTestId("confirm-dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: /Delete selected sessions/i }),
    );

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith("network error"),
    );

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Bulk delete/i }),
      ).not.toBeDisabled(),
    );

    deleteManySpy.mockRestore();
  });

  it("exposes a dedicated archived-session purge flow", async () => {
    setSessionFixtures(
      [
        {
          providerId: "codex",
          sessionId: "archived-session-1",
          title: "Archived Session",
          projectDir: "/mock/codex",
          sourcePath:
            "C:\\Users\\test\\.codex\\archived_sessions\\archived-session-1.jsonl",
          resumeCommand: "codex resume archived-session-1",
        },
      ],
      {},
    );
    const purgeSpy = vi.spyOn(sessionsApi, "purgeArchived").mockResolvedValue({
      attempted: 1,
      deleted: 1,
      failed: 0,
      indexCleanupWarnings: 0,
      errors: [],
    });

    renderPage();

    const purgeButton = await screen.findByRole("button", {
      name: /Delete all archived Codex sessions/i,
    });
    fireEvent.click(purgeButton);

    const dialog = screen.getByTestId("confirm-dialog");
    expect(dialog).toHaveTextContent("Delete all archived Codex sessions");
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: /Delete all archived/i,
      }),
    );

    await waitFor(() => expect(purgeSpy).toHaveBeenCalledWith("codex"));
    expect(toastSuccessMock).toHaveBeenCalled();
    expect(toastErrorMock).not.toHaveBeenCalled();

    purgeSpy.mockRestore();
  });

  it("keeps the exit batch mode button visible when search hides all sessions", async () => {
    renderPage();

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Alpha Session" }),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /Bulk manage/i }));
    openSearch();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "NoSuchSession" },
    });

    await waitFor(() => expect(screen.queryByText("Alpha Session")).toBeNull());

    expect(
      screen.getByRole("button", { name: /Exit bulk management/i }),
    ).toBeVisible();
  });

  it("drops hidden selections when search narrows the result set", async () => {
    renderPage();

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Alpha Session" }),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /Bulk manage/i }));
    fireEvent.click(
      screen.getByRole("button", { name: /Select all visible/i }),
    );

    expect(screen.getByText("3 selected")).toBeInTheDocument();

    openSearch();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Alpha" },
    });

    await waitFor(() =>
      expect(screen.queryByText("Beta Session")).not.toBeInTheDocument(),
    );

    closeSearch();

    await waitFor(() =>
      expect(screen.getByText("1 selected")).toBeInTheDocument(),
    );
  });

  it("removes successfully deleted sessions from the UI before refetch completes", async () => {
    const view = renderPage();
    let resolveInvalidate!: () => void;
    const invalidateSpy = vi
      .spyOn(view.client, "invalidateQueries")
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveInvalidate = () => resolve(undefined);
          }),
      );

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Alpha Session" }),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /Bulk manage/i }));
    fireEvent.click(
      screen.getByRole("button", { name: /Select all visible/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Bulk delete/i }));

    const dialog = screen.getByTestId("confirm-dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: /Delete selected sessions/i }),
    );

    await waitFor(() => {
      expect(screen.queryByText("Alpha Session")).not.toBeInTheDocument();
      expect(screen.queryByText("Beta Session")).not.toBeInTheDocument();
    });

    await act(async () => {
      resolveInvalidate();
    });
    invalidateSpy.mockRestore();
  });

  // initialCodexHistoryRepair=true 且 appId="codex" 时：按调用方显式请求打开面板，并消费一次性标记。
  it("honors and consumes an explicit initialCodexHistoryRepair request for codex", async () => {
    const onConsumed = vi.fn();
    const onRepairCompleted = vi.fn();

    renderPageWithRepair({
      appId: "codex",
      initialCodexHistoryRepair: true,
      onInitialCodexHistoryRepairConsumed: onConsumed,
      onCodexHistoryRepairCompleted: onRepairCompleted,
    });

    // 等待 SessionManagerPage 的 useEffect 渲染 CodexHistoryRepairPanel
    await waitFor(() => {
      expect(screen.getByText("Codex history repair")).toBeInTheDocument();
    });

    expect(
      screen.getByText(
        "MultiRouter is configured. Fully exit the Codex / ChatGPT app before repairing.",
      ),
    ).toBeInTheDocument();

    // 一次性标记应已被消费
    expect(onConsumed).toHaveBeenCalledTimes(1);

    // 回调已传递到面板（面板在此测试环境中不会真正触发 Tauri 调用，所以还未调用）
    expect(onRepairCompleted).not.toHaveBeenCalled();
  });

  // 非 codex appId 即使 initialCodexHistoryRepair=true 也不应打开历史修复面板。
  it("does not open CodexHistoryRepairPanel when appId is not codex", async () => {
    const onConsumed = vi.fn();

    renderPageWithRepair({
      appId: "claude",
      initialCodexHistoryRepair: true,
      onInitialCodexHistoryRepairConsumed: onConsumed,
    });

    // 等待 SessionManagerPage 渲染；不应出现 Codex 历史修复 UI
    await waitFor(() => {
      expect(
        screen.getByText("sessionManager.sessionList"),
      ).toBeInTheDocument();
    });

    expect(screen.queryByText("Codex history repair")).not.toBeInTheDocument();
    expect(onConsumed).not.toHaveBeenCalled();
  });

  it("switches to grouped view collapsed by default and shows collapse control", async () => {
    renderPage("all");

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Claude Session" }),
      ).toBeInTheDocument(),
    );

    await switchToGroupedView();

    expect(
      screen.getByRole("button", { name: /Collapse all/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /Expand or collapse the codex provider group/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /Expand or collapse the claude provider group/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: /Expand or collapse the codex directory group/,
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Alpha Session/ }),
    ).not.toBeInTheDocument();
  });

  it("persists manual expansion and collapses all grouped sessions", async () => {
    renderPage();

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Alpha Session" }),
      ).toBeInTheDocument(),
    );

    await switchToGroupedView();
    expandDirectoryGroup("codex", "codex");

    expect(
      screen.getByRole("button", {
        name: /Expand or collapse the codex directory group/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Alpha Session/ }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        JSON.parse(window.localStorage.getItem(GROUP_EXPANSION_STORAGE_KEY)!),
      ).toEqual({
        expandedProviderIds: ["codex"],
        expandedDirectoryKeys: ["codex:/mock/codex"],
      }),
    );

    collapseAllGroups();

    await waitFor(() =>
      expect(
        screen.queryByRole("button", {
          name: /Expand or collapse the codex directory group/,
        }),
      ).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(
        JSON.parse(window.localStorage.getItem(GROUP_EXPANSION_STORAGE_KEY)!),
      ).toEqual({
        expandedProviderIds: [],
        expandedDirectoryKeys: [],
      }),
    );
  });

  it("keeps filtered grouped sessions collapsed until expanding the group", async () => {
    renderPage("all");

    await waitFor(() =>
      expect(screen.getByText("Alpha Session")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /Alpha Session/ }));
    await switchToGroupedView();
    await switchProviderFilter(/Claude Code/i);

    await waitFor(() =>
      expect(screen.queryByText("Alpha Session")).not.toBeInTheDocument(),
    );

    expect(
      screen.getByRole("heading", { name: "Claude Session" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /Expand or collapse the claude provider group/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: /Expand or collapse the claude directory group/,
      }),
    ).not.toBeInTheDocument();

    expandDirectoryGroup("claude", "claude");

    expect(
      screen.getByRole("button", {
        name: /Expand or collapse the claude directory group/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Claude Session/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Gamma Session")).not.toBeInTheDocument();
  });

  it("supports batch deletion from grouped view", async () => {
    renderPage();

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Alpha Session" }),
      ).toBeInTheDocument(),
    );

    await switchToGroupedView();
    fireEvent.click(screen.getByRole("button", { name: /Bulk manage/i }));
    fireEvent.click(
      screen.getByRole("button", { name: /Select all visible/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Bulk delete/i }));

    const dialog = screen.getByTestId("confirm-dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: /Delete selected sessions/i }),
    );

    await waitFor(() => {
      expect(screen.queryByText("Alpha Session")).not.toBeInTheDocument();
      expect(screen.queryByText("Beta Session")).not.toBeInTheDocument();
      expect(screen.queryByText("Gamma Session")).not.toBeInTheDocument();
    });

    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).toHaveBeenCalled();
  });

  it("selects visible deletable sessions by provider group in grouped batch mode", async () => {
    renderPage("all");

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Claude Session" }),
      ).toBeInTheDocument(),
    );

    await enterGroupedBatchMode();

    const codexProviderCheckbox = screen.getByRole("checkbox", {
      name: /Select sessions in the codex provider group/,
    });
    const claudeProviderCheckbox = screen.getByRole("checkbox", {
      name: /Select sessions in the claude provider group/,
    });

    fireEvent.click(codexProviderCheckbox);

    expect(codexProviderCheckbox).toBeChecked();
    expect(claudeProviderCheckbox).not.toBeChecked();
    expect(screen.getByText("3 selected")).toBeInTheDocument();

    fireEvent.click(codexProviderCheckbox);

    expect(codexProviderCheckbox).not.toBeChecked();
    expect(screen.getByText("0 selected")).toBeInTheDocument();
  });

  it("selects visible deletable sessions by directory group and marks the provider as mixed", async () => {
    renderPage();

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Alpha Session" }),
      ).toBeInTheDocument(),
    );

    await enterGroupedBatchMode();
    expandDirectoryGroup("codex", "codex");

    const providerCheckbox = screen.getByRole("checkbox", {
      name: /Select sessions in the codex provider group/,
    });
    const codexDirectoryCheckbox = screen.getByRole("checkbox", {
      name: /Select sessions in the codex directory group/,
    });

    fireEvent.click(codexDirectoryCheckbox);

    expect(codexDirectoryCheckbox).toBeChecked();
    expect(providerCheckbox).toHaveAttribute("aria-checked", "mixed");
    expect(screen.getByText("2 selected")).toBeInTheDocument();
  });

  it("marks grouped batch checkboxes as mixed when only one session is selected", async () => {
    renderPage();

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Alpha Session" }),
      ).toBeInTheDocument(),
    );

    await enterGroupedBatchMode();
    expandDirectoryGroup("codex", "codex");

    fireEvent.click(
      screen.getAllByRole("checkbox", { name: "Select session" })[0],
    );

    expect(
      screen.getByRole("checkbox", {
        name: /Select sessions in the codex provider group/,
      }),
    ).toHaveAttribute("aria-checked", "mixed");
    expect(
      screen.getByRole("checkbox", {
        name: /Select sessions in the codex directory group/,
      }),
    ).toHaveAttribute("aria-checked", "mixed");
    expect(screen.getByText("1 selected")).toBeInTheDocument();
  });

  it("batch deletes only sessions selected from a grouped directory", async () => {
    renderPage();

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Alpha Session" }),
      ).toBeInTheDocument(),
    );

    await enterGroupedBatchMode();
    expandDirectoryGroup("codex", "codex");
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /Select sessions in the codex directory group/,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Bulk delete/i }));

    const dialog = screen.getByTestId("confirm-dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: /Delete selected sessions/i }),
    );

    await waitFor(() => {
      expect(screen.queryByText("Alpha Session")).not.toBeInTheDocument();
      expect(screen.queryByText("Beta Session")).not.toBeInTheDocument();
    });

    expect(
      screen.getByRole("button", {
        name: /Expand or collapse the Unknown directory directory group/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", { name: "Select session" }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", {
        name: /Expand or collapse the Unknown directory directory group/,
      }),
    );
    expect(
      screen.getByRole("checkbox", { name: "Select session" }),
    ).toBeInTheDocument();
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).toHaveBeenCalled();
  });
});
