import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StreamRetryToggle } from "@/components/proxy/StreamRetryToggle";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("StreamRetryToggle", () => {
  it("maps the disabled legacy setting to Off", () => {
    render(<StreamRetryToggle enableStreamRetry={false} onChange={vi.fn()} />);

    expect(
      screen.getByRole("radio", {
        name: "settings.advanced.proxy.streamRetryOff",
      }),
    ).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
  });

  it("writes the mode and compatibility flag together", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn().mockResolvedValue(true);
    render(
      <StreamRetryToggle
        mode="safe"
        enableStreamRetry={true}
        maxAttempts={2}
        onChange={onChange}
      />,
    );

    await user.click(
      screen.getByRole("radio", {
        name: "settings.advanced.proxy.streamRetryAggressive",
      }),
    );

    expect(onChange).toHaveBeenCalledWith({
      streamRetryMode: "aggressive",
      enableStreamRetry: true,
    });
  });

  it("clamps and persists aggressive continuation attempts", async () => {
    const onChange = vi.fn().mockResolvedValue(true);
    render(
      <StreamRetryToggle
        mode="aggressive"
        enableStreamRetry={true}
        maxAttempts={9}
        onChange={onChange}
      />,
    );

    const slider = screen.getByRole("slider");
    expect(slider).toHaveValue("3");
    fireEvent.change(slider, { target: { value: "1" } });

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ streamRetryMaxAttempts: 1 });
    });
  });
});
