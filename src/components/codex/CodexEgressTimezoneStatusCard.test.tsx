import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { codexEgressTimezoneApi } from "@/lib/api/codexEgressTimezone";
import { createLocalizedTestI18n } from "../../../tests/utils/localizedTestI18n";
import { CodexEgressTimezoneStatusCard } from "./CodexEgressTimezoneStatusCard";

vi.mock("@/lib/api/codexEgressTimezone", () => ({
  codexEgressTimezoneApi: {
    monitorStatus: vi.fn(),
    triggerAutomaticProbe: vi.fn(),
  },
}));

describe("CodexEgressTimezoneStatusCard", () => {
  beforeEach(() => {
    vi.mocked(codexEgressTimezoneApi.monitorStatus).mockReset();
    vi.mocked(codexEgressTimezoneApi.triggerAutomaticProbe).mockReset();
  });

  it("keeps automatic egress status visible in the Codex workspace", async () => {
    vi.mocked(codexEgressTimezoneApi.monitorStatus).mockResolvedValue({
      state: "ready",
      detectedTimezone: "Asia/Taipei",
      detectedEgressIp: "2407:cdc0:…",
      detectedAt: 2_000,
      lastAttemptAt: 2_000,
      lastTrigger: "periodic",
      nextCheckAt: 2_900,
      monitorIntervalMinutes: 15,
      restartRequired: false,
    });

    const i18n = await createLocalizedTestI18n();
    render(
      <I18nextProvider i18n={i18n}>
        <CodexEgressTimezoneStatusCard />
      </I18nextProvider>,
    );

    expect(
      await screen.findByText("Codex egress environment monitoring"),
    ).toBeInTheDocument();
    expect(screen.getByText("Monitoring healthy")).toBeInTheDocument();
    expect(screen.getByText(/Asia\/Taipei/)).toBeInTheDocument();
    expect(
      screen.getByText(/fallback check every 15 minutes/),
    ).toBeInTheDocument();
  });

  it("shows a safe-refresh warning and can recheck without requiring CDP", async () => {
    const onOpenCodexStatus = vi.fn();
    const restartRequired = {
      state: "restart_required" as const,
      detectedTimezone: "America/Los_Angeles",
      detectedEgressIp: "8.8.8.…",
      detectedAt: 2_000,
      lastAttemptAt: 2_000,
      lastTrigger: "proxy_failure",
      nextCheckAt: 2_900,
      monitorIntervalMinutes: 15,
      restartRequired: true,
    };
    vi.mocked(codexEgressTimezoneApi.monitorStatus).mockResolvedValue(
      restartRequired,
    );
    vi.mocked(codexEgressTimezoneApi.triggerAutomaticProbe).mockResolvedValue(
      restartRequired,
    );

    const i18n = await createLocalizedTestI18n();
    render(
      <I18nextProvider i18n={i18n}>
        <CodexEgressTimezoneStatusCard onOpenCodexStatus={onOpenCodexStatus} />
      </I18nextProvider>,
    );
    expect(
      await screen.findByText("Egress changed; refresh Codex"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open safe refresh" }));
    expect(onOpenCodexStatus).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    await waitFor(() =>
      expect(
        codexEgressTimezoneApi.triggerAutomaticProbe,
      ).toHaveBeenCalledOnce(),
    );
    expect(
      screen.getByText(/Detection does not depend on CDP/),
    ).toBeInTheDocument();
  });
});
