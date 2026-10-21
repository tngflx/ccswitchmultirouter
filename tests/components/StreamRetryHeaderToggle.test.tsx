import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StreamRetryHeaderToggle } from "@/components/proxy/StreamRetryHeaderToggle";

const { patch, get, query, showError, cancelQueries, setQueryData } =
  vi.hoisted(() => ({
    patch: vi.fn(),
    get: vi.fn(),
    query: vi.fn(),
    showError: vi.fn(),
    cancelQueries: vi.fn(),
    setQueryData: vi.fn(),
  }));

vi.mock("sonner", () => ({ toast: { error: showError } }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ cancelQueries, setQueryData }),
}));

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
});

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

  it("opens live activity from the main-page control", async () => {
    const user = userEvent.setup();
    const openActivity = vi.fn();
    render(<StreamRetryHeaderToggle onOpenActivity={openActivity} />);

    await user.click(
      screen.getByRole("button", { name: "streamRetry.activity.open" }),
    );

    expect(openActivity).toHaveBeenCalledOnce();
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
