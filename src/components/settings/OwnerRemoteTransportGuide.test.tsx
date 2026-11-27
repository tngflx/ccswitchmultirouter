import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OwnerRemoteTransportGuide } from "./OwnerRemoteTransportGuide";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe("OwnerRemoteTransportGuide", () => {
  it("defaults to the private Tailscale setup and keeps the loopback boundary visible", () => {
    render(<OwnerRemoteTransportGuide />);

    expect(
      screen.getByRole("tab", {
        name: "settings.ownerRemote.transportTailscale",
      }),
    ).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByText("settings.ownerRemote.privateNetwork"),
    ).toBeVisible();
    expect(
      screen.getByText("tailscale serve --bg http://127.0.0.1:15723"),
    ).toBeVisible();
    expect(
      screen.getByText("settings.ownerRemote.cloudflareOptional"),
    ).toBeVisible();
  });

  it("shows Cloudflare as a separate browser-only transport without asking CCSwitch for secrets", () => {
    render(<OwnerRemoteTransportGuide />);

    fireEvent.click(
      screen.getByRole("tab", {
        name: "settings.ownerRemote.transportCloudflare",
      }),
    );

    expect(
      screen.getByRole("tab", {
        name: "settings.ownerRemote.transportCloudflare",
      }),
    ).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByText("settings.ownerRemote.cloudflareFullStepRoute"),
    ).toBeVisible();
    expect(
      screen.getByText("settings.ownerRemote.cloudflareFullBoundary"),
    ).toBeVisible();
    expect(
      screen.getByRole("link", {
        name: "settings.ownerRemote.cloudflareDashboard",
      }),
    ).toHaveAttribute("href", "https://dash.cloudflare.com/");
  });

  it("labels TeamViewer as a desktop rescue path rather than the Continue transport", () => {
    render(<OwnerRemoteTransportGuide />);

    fireEvent.click(
      screen.getByRole("tab", {
        name: "settings.ownerRemote.transportTeamViewer",
      }),
    );

    expect(
      screen.getByText("settings.ownerRemote.teamViewerWarning"),
    ).toBeVisible();
    expect(
      screen.getByRole("link", {
        name: "settings.ownerRemote.teamViewerOpen",
      }),
    ).toHaveAttribute("href", "https://web.teamviewer.com/");
  });
});
