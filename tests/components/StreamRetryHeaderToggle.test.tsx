import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StreamRetryHeaderToggle } from "@/components/proxy/StreamRetryHeaderToggle";

const { mutate, query, mutation } = vi.hoisted(() => ({
  mutate: vi.fn(),
  query: vi.fn(),
  mutation: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/query", () => ({
  useSettingsQuery: query,
  useSaveSettingsMutation: mutation,
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
  mutation.mockReturnValue({ mutate, isPending: false });
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

    expect(mutate).toHaveBeenCalledWith({
      ...settings,
      streamRetryMode: "safe",
      enableStreamRetry: true,
    });
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

    expect(mutate).toHaveBeenCalledWith({
      ...settings,
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

    expect(mutate).toHaveBeenCalledWith({
      ...settings,
      enableStreamRetry: true,
      streamRetryMode: "aggressive",
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

  it("disables settings changes while persistence is pending", () => {
    mutation.mockReturnValue({ mutate, isPending: true });
    render(<StreamRetryHeaderToggle />);

    expect(screen.getByRole("switch")).toBeDisabled();
    expect(
      screen.getByRole("button", {
        name: "streamRetry.label: streamRetry.mode.off",
      }),
    ).toBeDisabled();
  });
});
