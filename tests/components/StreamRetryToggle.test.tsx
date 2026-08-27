import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { StreamRetryToggle } from "@/components/proxy/StreamRetryToggle";
import type { Settings } from "@/types";

const useSettingsQueryMock = vi.fn();
const useSaveSettingsMutationMock = vi.fn();
const mutateMock = vi.fn();

vi.mock("@/lib/query", () => ({
  useSettingsQuery: () => useSettingsQueryMock(),
  useSaveSettingsMutation: () => useSaveSettingsMutationMock(),
}));

describe("StreamRetryToggle", () => {
  let settings: Settings;

  beforeEach(() => {
    settings = {
      enableStreamRetry: true,
      streamRetryMode: "safe",
      streamRetryMaxAttempts: 3,
    } as Settings;
    useSettingsQueryMock.mockImplementation(() => ({
      data: settings,
      isLoading: false,
    }));
    useSaveSettingsMutationMock.mockReturnValue({
      mutate: mutateMock,
      isPending: false,
    });
  });

  it("shows the compact tier and persists Off and Aggressive compatibility fields", async () => {
    const user = userEvent.setup();
    const view = render(<StreamRetryToggle />);

    expect(
      screen.getByRole("button", { name: /retry: safe/i }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /retry: safe/i }));

    expect(screen.getByRole("button", { name: /^safe$/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.getByRole("slider", { name: "Continue attempts" }),
    ).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /^aggressive$/i }));
    expect(mutateMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        streamRetryMode: "aggressive",
        enableStreamRetry: true,
      }),
    );

    await user.click(screen.getByRole("button", { name: /^off$/i }));
    expect(mutateMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        streamRetryMode: "off",
        enableStreamRetry: false,
      }),
    );

    settings = { ...settings, streamRetryMode: "aggressive" };
    view.rerender(<StreamRetryToggle />);
    const slider = screen.getByRole("slider", { name: "Continue attempts" });
    expect(slider).toBeEnabled();
    fireEvent.change(slider, { target: { value: "2" } });
    expect(mutateMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ streamRetryMaxAttempts: 2 }),
    );
  });

  it("clamps an out-of-range stored attempt count to the 1-3 control range", async () => {
    settings = {
      ...settings,
      streamRetryMode: "aggressive",
      streamRetryMaxAttempts: 99,
    };
    const user = userEvent.setup();
    render(<StreamRetryToggle />);

    await user.click(
      screen.getByRole("button", { name: /retry: aggressive/i }),
    );
    expect(
      screen.getByRole("slider", { name: "Continue attempts" }),
    ).toHaveValue("3");
  });
});
