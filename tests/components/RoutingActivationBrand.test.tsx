import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutingActivationBrand } from "@/components/proxy/RoutingActivationBrand";

const props = {
  href: "https://example.com",
  label: "CCSwitchMulti",
};

describe("RoutingActivationBrand", () => {
  afterEach(() => vi.useRealTimers());

  it("plays a short burst after routing activates", () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <RoutingActivationBrand
        {...props}
        active={false}
        contextKey="claude"
        ready
      />,
    );
    rerender(
      <RoutingActivationBrand
        {...props}
        active
        contextKey="claude"
        ready
      />,
    );

    expect(
      screen.getByTestId("routing-activation-particles"),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: props.label })).toHaveClass(
      "text-emerald-500",
    );

    act(() => vi.advanceTimersByTime(1_000));
    expect(
      screen.queryByTestId("routing-activation-particles"),
    ).not.toBeInTheDocument();
  });

  it("does not animate when initial status resolves active", () => {
    const { rerender } = render(
      <RoutingActivationBrand
        {...props}
        active={false}
        contextKey="claude"
        ready={false}
      />,
    );
    rerender(
      <RoutingActivationBrand
        {...props}
        active
        contextKey="claude"
        ready
      />,
    );
    expect(
      screen.queryByTestId("routing-activation-particles"),
    ).not.toBeInTheDocument();
  });
});
