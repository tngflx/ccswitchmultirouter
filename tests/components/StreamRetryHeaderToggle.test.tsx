import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  focusManager,
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CodexUsageLimitResumeButton,
  StreamRetryHeaderToggle,
} from "@/components/proxy/StreamRetryHeaderToggle";

const {
  patch,
  get,
  query,
  showError,
  showInfo,
  translate,
  invoke,
  cancelQueries,
  setQueryData,
} = vi.hoisted(() => ({
  patch: vi.fn(),
  get: vi.fn(),
  query: vi.fn(),
  showError: vi.fn(),
  showInfo: vi.fn(),
  translate: vi.fn((key: string) => key),
  invoke: vi.fn(),
  cancelQueries: vi.fn(),
  setQueryData: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: showError, info: showInfo } }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: translate }),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => ({ cancelQueries, setQueryData }),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

vi.mock("@/lib/query", () => ({
  useSettingsQuery: query,
}));

vi.mock("@/lib/api", () => ({
  settingsApi: { patch, get },
}));

const settings = {
  enableStreamRetry: false,
  streamRetryMode: "safe" as const,
  streamRetryMaxAttempts: 3,
  language: "en",
};

beforeEach(() => {
  query.mockReturnValue({
    data: settings,
    isLoading: false,
  });
  patch.mockReset();
  patch.mockResolvedValue(undefined);
  get.mockReset();
  get.mockResolvedValue(settings);
  cancelQueries.mockReset();
  cancelQueries.mockResolvedValue(undefined);
  setQueryData.mockReset();
  showError.mockReset();
  showInfo.mockReset();
  translate.mockClear();
  invoke.mockReset();
});

function renderCodexHeader(
  client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  }),
) {
  render(
    <QueryClientProvider client={client}>
      <CodexUsageLimitResumeButton />
    </QueryClientProvider>,
  );
  return client;
}

describe("StreamRetryHeaderToggle", () => {
  it("shows the main-page switch as Off for a disabled legacy setting", () => {
    render(<StreamRetryHeaderToggle />);

    expect(
      screen.getByTestId("stream-retry-header-toggle"),
    ).toBeInTheDocument();
    expect(screen.getByRole("switch")).not.toBeChecked();
    expect(screen.getByText("streamRetry.mode.off")).toBeInTheDocument();
  });

  it("enables safe retries while preserving unrelated settings", async () => {
    const user = userEvent.setup();
    render(<StreamRetryHeaderToggle />);

    await user.click(screen.getByRole("switch"));

    expect(patch).toHaveBeenCalledWith({
      streamRetryMode: "safe",
      enableStreamRetry: true,
    });
  });

  it("reports a failed retry policy save and allows another attempt", async () => {
    patch.mockRejectedValueOnce(new Error("settings write failed"));
    const user = userEvent.setup();
    render(<StreamRetryHeaderToggle />);

    await user.click(screen.getByRole("switch"));

    await waitFor(() =>
      expect(showError).toHaveBeenCalledWith("settings.saveFailedGeneric"),
    );
    expect(screen.getByRole("switch")).not.toBeChecked();
    expect(screen.getByRole("switch")).toBeEnabled();
    expect(setQueryData).not.toHaveBeenCalled();
    await user.click(screen.getByRole("switch"));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    expect(showError).toHaveBeenCalledTimes(1);
    expect(setQueryData).toHaveBeenCalledTimes(1);
  });

  it("persists aggressive mode and the compatibility flag together", async () => {
    const user = userEvent.setup();
    render(<StreamRetryHeaderToggle />);

    await user.click(
      screen.getByRole("button", {
        name: "streamRetry.label: streamRetry.mode.off",
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "streamRetry.mode.aggressive" }),
    );

    expect(patch).toHaveBeenCalledWith({
      streamRetryMode: "aggressive",
      enableStreamRetry: true,
    });
    expect(screen.getByRole("slider")).toBeDisabled();
  });

  it("clamps and persists aggressive-mode slider attempts", async () => {
    const user = userEvent.setup();
    query.mockReturnValue({
      data: {
        ...settings,
        enableStreamRetry: true,
        streamRetryMode: "aggressive",
        streamRetryMaxAttempts: 9,
      },
      isLoading: false,
    });
    render(<StreamRetryHeaderToggle />);

    await user.click(
      screen.getByRole("button", {
        name: "streamRetry.label: streamRetry.mode.aggressive",
      }),
    );
    const slider = screen.getByRole("slider");
    expect(slider).toBeEnabled();
    expect(slider).toHaveValue("3");
    fireEvent.change(slider, { target: { value: "1" } });

    expect(patch).toHaveBeenCalledWith({
      streamRetryMaxAttempts: 1,
    });
  });

  it("writes and refreshes the separate unlimited reconnect preference", async () => {
    const user = userEvent.setup();
    const aggressive = {
      ...settings,
      enableStreamRetry: true,
      streamRetryMode: "aggressive",
      streamRetryUnlimitedReconnects: false,
    };
    query.mockReturnValue({ data: aggressive, isLoading: false });
    get.mockResolvedValue({
      ...aggressive,
      streamRetryUnlimitedReconnects: true,
    });
    render(<StreamRetryHeaderToggle />);

    await user.click(
      screen.getByRole("button", {
        name: "streamRetry.label: streamRetry.mode.aggressive",
      }),
    );
    const control = screen.getByRole("switch", {
      name: "streamRetry.unlimitedReconnects",
    });
    expect(control).not.toBeChecked();
    await user.click(control);

    expect(patch).toHaveBeenCalledWith({
      streamRetryUnlimitedReconnects: true,
    });
    await waitFor(() =>
      expect(setQueryData).toHaveBeenCalledWith(["settings"], {
        ...aggressive,
        streamRetryUnlimitedReconnects: true,
      }),
    );
    expect(screen.getByRole("slider")).toHaveValue("3");
  });

  it("opens live activity from the main-page control", async () => {
    const user = userEvent.setup();
    const openActivity = vi.fn();
    render(<StreamRetryHeaderToggle onOpenActivity={openActivity} />);

    await user.click(
      screen.getByRole("button", { name: "streamRetry.activity.open" }),
    );

    expect(openActivity).toHaveBeenCalledOnce();
  });

  it("only checks for interrupted Codex turns on the Codex header", () => {
    render(<StreamRetryHeaderToggle />);

    expect(invoke).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", {
        name: "streamRetry.usageLimitResume.action",
      }),
    ).not.toBeInTheDocument();
  });

  it("shows an explicit empty recovery state when no turns are eligible", async () => {
    const eligibility = { count: 0, complete: true };
    invoke.mockResolvedValue(eligibility);
    const client = renderCodexHeader();

    await waitFor(() =>
      expect(client.getQueryData(["codexUsageLimitResumeCount"])).toEqual(
        eligibility,
      ),
    );
    expect(invoke).toHaveBeenCalledWith("get_codex_usage_limit_resume_count");
    expect(
      screen.getByRole("button", {
        name: "streamRetry.usageLimitResume.emptyAction",
      }),
    ).toBeDisabled();
    expect(
      screen.getByTestId("codex-usage-limit-resume-status-text"),
    ).toHaveTextContent("streamRetry.usageLimitResume.emptyStatus");
    expect(
      screen.getByTestId("codex-usage-limit-refresh-button"),
    ).toBeEnabled();
  });

  it("exposes the live ready count and explains why an empty scan is safe", async () => {
    invoke.mockResolvedValue({ count: 0, complete: true });
    const user = userEvent.setup();
    renderCodexHeader();

    await waitFor(() =>
      expect(
        screen.getByTestId("codex-usage-limit-resume-count"),
      ).toHaveTextContent("0"),
    );
    expect(
      screen.getByTestId("codex-usage-limit-resume-count"),
    ).toHaveAccessibleName("streamRetry.usageLimitResume.countLabel");

    await user.click(
      screen.getByRole("button", {
        name: "streamRetry.usageLimitResume.details",
      }),
    );
    expect(
      screen.getByText("streamRetry.usageLimitResume.zeroDetails"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("streamRetry.usageLimitResume.detailsDescription"),
    ).toBeInTheDocument();
  });

  it("updates complete and partial usage limit counts without remounting", async () => {
    vi.useFakeTimers();
    let eligibility = { count: 0, complete: false };
    invoke.mockImplementation(async () => eligibility);
    const client = renderCodexHeader();
    const button = screen.getByTestId("codex-usage-limit-resume-button");
    const advance = (milliseconds: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(milliseconds);
      });

    try {
      expect(button).toHaveAccessibleName(
        "streamRetry.usageLimitResume.checking",
      );
      expect(button).toBeDisabled();
      await advance(20);
      expect(button).toHaveAccessibleName(
        "streamRetry.usageLimitResume.emptyAction",
      );
      expect(button).toHaveAttribute(
        "title",
        "streamRetry.usageLimitResume.partialDescription",
      );
      expect(button.parentElement).toHaveAttribute(
        "title",
        "streamRetry.usageLimitResume.partialDescription",
      );
      expect(button.parentElement).toHaveAttribute("tabindex", "0");
      expect(button).toBeDisabled();
      expect(
        screen.getByTestId("codex-usage-limit-resume-status-text"),
      ).toHaveTextContent("streamRetry.usageLimitResume.partialEmptyStatus");

      eligibility = { count: 0, complete: true };
      await advance(5_000);
      expect(button).toHaveAccessibleName(
        "streamRetry.usageLimitResume.emptyAction",
      );
      expect(
        screen.getByTestId("codex-usage-limit-resume-status-text"),
      ).toHaveTextContent("streamRetry.usageLimitResume.emptyStatus");
      expect(button).toBeDisabled();

      eligibility = { count: 2, complete: true };
      await advance(5_000);
      expect(translate).toHaveBeenCalledWith(
        "streamRetry.usageLimitResume.action",
        { count: 2 },
      );
      expect(
        screen.getByTestId("codex-usage-limit-resume-status-text"),
      ).toHaveTextContent("streamRetry.usageLimitResume.readyStatus");
      expect(button).toBeEnabled();

      eligibility = { count: 2, complete: false };
      await advance(5_000);
      expect(button).toHaveAccessibleName(
        "streamRetry.usageLimitResume.action",
      );
      expect(translate).toHaveBeenCalledWith(
        "streamRetry.usageLimitResume.action",
        { count: 2 },
      );
      expect(button).toHaveAttribute(
        "title",
        "streamRetry.usageLimitResume.partialDescription",
      );
      expect(
        screen.getByTestId("codex-usage-limit-resume-status-text"),
      ).toHaveTextContent("streamRetry.usageLimitResume.partialStatus");
      expect(button).toBeEnabled();

      eligibility = { count: 0, complete: false };
      await advance(5_000);
      expect(button).toHaveAccessibleName(
        "streamRetry.usageLimitResume.emptyAction",
      );
      expect(
        screen.getByTestId("codex-usage-limit-resume-status-text"),
      ).toHaveTextContent("streamRetry.usageLimitResume.partialEmptyStatus");
      expect(button).toBeDisabled();

      eligibility = { count: 0, complete: true };
      await advance(5_000);
      expect(button).toHaveAccessibleName(
        "streamRetry.usageLimitResume.emptyAction",
      );
      expect(button).toHaveAttribute(
        "title",
        "streamRetry.usageLimitResume.emptyDescription",
      );
      expect(
        screen.getByTestId("codex-usage-limit-resume-status-text"),
      ).toHaveTextContent("streamRetry.usageLimitResume.emptyStatus");
      expect(button).toBeDisabled();
      expect(invoke.mock.calls).toEqual(
        Array.from({ length: 6 }, () => ["get_codex_usage_limit_resume_count"]),
      );
    } finally {
      cleanup();
      client.clear();
      vi.useRealTimers();
    }
  });

  it("keeps discovering usage-limit sessions while the window is hidden", async () => {
    vi.useFakeTimers();
    const visibilityState = Object.getOwnPropertyDescriptor(
      document,
      "visibilityState",
    );
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    let count = 0;
    invoke.mockImplementation(async () => ({
      count: count++,
      complete: true,
    }));
    const client = renderCodexHeader();

    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20);
      });
      expect(invoke).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(invoke).toHaveBeenCalledTimes(2);
      expect(
        screen.getByTestId("codex-usage-limit-resume-button"),
      ).toHaveTextContent("streamRetry.usageLimitResume.action");
      expect(translate).toHaveBeenCalledWith(
        "streamRetry.usageLimitResume.action",
        { count: 1 },
      );
    } finally {
      client.clear();
      if (visibilityState) {
        Object.defineProperty(document, "visibilityState", visibilityState);
      } else {
        Reflect.deleteProperty(document, "visibilityState");
      }
      cleanup();
      vi.useRealTimers();
    }
  });

  it("polls and refreshes the local count after a resume while the webview is offline", async () => {
    vi.useFakeTimers();
    const wasOnline = onlineManager.isOnline();
    onlineManager.setOnline(false);
    invoke
      .mockResolvedValueOnce({ count: 0, complete: true })
      .mockResolvedValueOnce({ count: 1, complete: true })
      .mockResolvedValueOnce({
        submitted: 1,
        deferred: 0,
        skipped: 0,
        uncertain: 0,
      })
      .mockResolvedValueOnce({ count: 0, complete: true });
    const client = renderCodexHeader();
    const button = screen.getByTestId("codex-usage-limit-resume-button");
    const advance = (milliseconds: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(milliseconds);
      });

    try {
      await advance(20);
      expect(button).toHaveAccessibleName(
        "streamRetry.usageLimitResume.emptyAction",
      );
      expect(button).toBeDisabled();

      await advance(5_000);
      expect(button).toBeEnabled();

      fireEvent.click(button);
      await advance(20);
      expect(button).toBeDisabled();
      expect(invoke.mock.calls).toEqual([
        ["get_codex_usage_limit_resume_count"],
        ["get_codex_usage_limit_resume_count"],
        ["resume_codex_usage_limited_turns"],
        ["get_codex_usage_limit_resume_count"],
      ]);
    } finally {
      cleanup();
      client.clear();
      onlineManager.setOnline(wasOnline);
      vi.useRealTimers();
    }
  });

  it("disables a stale positive count after a failed hidden poll and recovers on the next poll", async () => {
    vi.useFakeTimers();
    const isFocused = vi
      .spyOn(focusManager, "isFocused")
      .mockReturnValue(false);
    invoke
      .mockResolvedValueOnce({ count: 2, complete: true })
      .mockRejectedValueOnce(new Error("local count read failed"))
      .mockResolvedValueOnce({ count: 1, complete: true });
    const client = renderCodexHeader(
      new QueryClient({ defaultOptions: { queries: { retry: 1 } } }),
    );
    const button = screen.getByTestId("codex-usage-limit-resume-button");
    const advance = (milliseconds: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(milliseconds);
      });

    try {
      await advance(20);
      expect(button).toBeEnabled();

      await advance(6_000);
      expect(button).toHaveAccessibleName(
        "streamRetry.usageLimitResume.unavailable",
      );
      expect(
        screen.getByTestId("codex-usage-limit-resume-status-text"),
      ).toHaveTextContent("streamRetry.usageLimitResume.unavailableStatus");
      expect(button).toBeDisabled();

      await advance(5_000);
      expect(button).toBeEnabled();
      expect(translate).toHaveBeenCalledWith(
        "streamRetry.usageLimitResume.action",
        { count: 1 },
      );
      expect(invoke.mock.calls).toEqual(
        Array.from({ length: 3 }, () => ["get_codex_usage_limit_resume_count"]),
      );
    } finally {
      cleanup();
      client.clear();
      isFocused.mockRestore();
      vi.useRealTimers();
    }
  });

  it("submits one bulk action, reports its four outcome counts, and refreshes eligibility", async () => {
    const result = { submitted: 2, deferred: 1, skipped: 1, uncertain: 1 };
    const eligibility = { count: 5, complete: true };
    let finishResume!: (value: typeof result) => void;
    const resume = new Promise<typeof result>((resolve) => {
      finishResume = resolve;
    });
    invoke
      .mockResolvedValueOnce(eligibility)
      .mockReturnValueOnce(resume)
      .mockResolvedValueOnce({ count: 1, complete: true });
    const client = renderCodexHeader();

    await waitFor(() =>
      expect(client.getQueryData(["codexUsageLimitResumeCount"])).toEqual(
        eligibility,
      ),
    );

    const button = await screen.findByRole("button", {
      name: "streamRetry.usageLimitResume.action",
    });
    expect(translate).toHaveBeenCalledWith(
      "streamRetry.usageLimitResume.action",
      {
        count: 5,
      },
    );
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(button).toBeDisabled();
    expect(invoke.mock.calls).toEqual([
      ["get_codex_usage_limit_resume_count"],
      ["resume_codex_usage_limited_turns"],
    ]);

    await act(async () => finishResume(result));

    await waitFor(() => expect(button).toBeEnabled());
    expect(translate).toHaveBeenCalledWith(
      "streamRetry.usageLimitResume.result",
      result,
    );
    expect(showInfo).toHaveBeenCalledWith(
      "streamRetry.usageLimitResume.result",
    );
    expect(invoke).toHaveBeenLastCalledWith(
      "get_codex_usage_limit_resume_count",
    );
    expect(translate).toHaveBeenCalledWith(
      "streamRetry.usageLimitResume.action",
      {
        count: 1,
      },
    );
  });

  it("reports a failed recovery submission without exposing the backend error", async () => {
    const eligibility = { count: 1, complete: true };
    invoke
      .mockResolvedValueOnce(eligibility)
      .mockRejectedValueOnce(new Error("resume failed"))
      .mockResolvedValueOnce(eligibility);
    const user = userEvent.setup();
    renderCodexHeader();

    const button = await screen.findByRole("button", {
      name: "streamRetry.usageLimitResume.action",
    });
    await user.click(button);

    await waitFor(() => expect(button).toBeEnabled());
    expect(showError).toHaveBeenCalledWith(
      "streamRetry.usageLimitResume.failed",
    );
    expect(showInfo).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenLastCalledWith(
      "get_codex_usage_limit_resume_count",
    );
  });

  it("disables settings changes while persistence is pending", async () => {
    let resolve!: () => void;
    patch.mockReturnValueOnce(
      new Promise<void>((res) => {
        resolve = res;
      }),
    );
    render(<StreamRetryHeaderToggle />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("switch"));
    expect(screen.getByRole("switch")).toBeDisabled();
    expect(
      screen.getByRole("button", {
        name: "streamRetry.label: streamRetry.mode.off",
      }),
    ).toBeDisabled();
    resolve();
  });
});
