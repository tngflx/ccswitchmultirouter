import { act, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CodexEgressTimezoneStatusCard } from "@/components/codex/CodexEgressTimezoneStatusCard";
import { CodexEgressTimezoneSettings } from "@/components/settings/CodexEgressTimezoneSettings";
import { codexEgressTimezoneApi } from "@/lib/api/codexEgressTimezone";
import { createLocalizedTestI18n } from "../utils/localizedTestI18n";

vi.mock("@/lib/api/codexEgressTimezone", () => ({
  codexEgressTimezoneApi: {
    monitorStatus: vi.fn(),
    triggerAutomaticProbe: vi.fn(),
    detect: vi.fn(),
    inspectRuntime: vi.fn(),
    validate: vi.fn(),
  },
}));

describe("egress timezone localization", () => {
  beforeEach(() => {
    vi.mocked(codexEgressTimezoneApi.monitorStatus).mockReset();
    vi.mocked(codexEgressTimezoneApi.triggerAutomaticProbe).mockReset();
    vi.mocked(codexEgressTimezoneApi.detect).mockReset();
    vi.mocked(codexEgressTimezoneApi.inspectRuntime).mockReset();
    vi.mocked(codexEgressTimezoneApi.validate).mockReset();
  });

  it("renders the status card in the selected locale without translating raw identifiers", async () => {
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
    const i18n = await createLocalizedTestI18n("zh");

    render(
      <I18nextProvider i18n={i18n}>
        <CodexEgressTimezoneStatusCard />
      </I18nextProvider>,
    );

    expect(await screen.findByText("Codex 出口环境自动监测")).toBeInTheDocument();
    expect(screen.getByText("监测正常")).toBeInTheDocument();
    expect(screen.getByText(/Asia\/Taipei/)).toBeInTheDocument();
    expect(screen.getByText(/2407:cdc0/)).toBeInTheDocument();
  });

  it("updates timezone settings presentation when the locale changes", async () => {
    const i18n = await createLocalizedTestI18n("en");
    render(
      <I18nextProvider i18n={i18n}>
        <CodexEgressTimezoneSettings
          value={{ mode: "off" }}
          onChange={vi.fn()}
        />
      </I18nextProvider>,
    );

    expect(
      screen.getByText("Codex egress timezone monitoring"),
    ).toBeInTheDocument();

    await act(async () => {
      await i18n.changeLanguage("ja");
    });

    await waitFor(() =>
      expect(
        screen.getByText("Codex 出口タイムゾーンの自動監視"),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/公式な証拠はありません/),
    ).toBeInTheDocument();
  });
});
