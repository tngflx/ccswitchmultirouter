import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { codexEgressTimezoneApi } from "@/lib/api/codexEgressTimezone";
import { createLocalizedTestI18n } from "../../../tests/utils/localizedTestI18n";
import { CodexEgressTimezoneSettings } from "./CodexEgressTimezoneSettings";

vi.mock("@/lib/api/codexEgressTimezone", () => ({
  codexEgressTimezoneApi: {
    detect: vi.fn(),
    triggerAutomaticProbe: vi.fn(),
    inspectRuntime: vi.fn(),
    validate: vi.fn(),
  },
}));

describe("CodexEgressTimezoneSettings", () => {
  beforeEach(() => {
    vi.mocked(codexEgressTimezoneApi.detect).mockReset();
    vi.mocked(codexEgressTimezoneApi.triggerAutomaticProbe).mockReset();
    vi.mocked(codexEgressTimezoneApi.inspectRuntime).mockReset();
    vi.mocked(codexEgressTimezoneApi.validate).mockReset();
    vi.mocked(codexEgressTimezoneApi.validate).mockResolvedValue(undefined);
  });

  it("enables automatic monitoring with one explicit privacy-aware action", async () => {
    vi.mocked(codexEgressTimezoneApi.triggerAutomaticProbe).mockResolvedValue({
      state: "not_tested",
      monitorIntervalMinutes: 15,
      restartRequired: false,
    });
    const onChange = vi.fn().mockResolvedValue(true);
    const i18n = await createLocalizedTestI18n();
    render(
      <I18nextProvider i18n={i18n}>
        <CodexEgressTimezoneSettings
          value={{ mode: "off" }}
          onChange={onChange}
        />
      </I18nextProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Enable automatic monitoring" }),
    );

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "auto", monitorIntervalMinutes: 15 }),
      ),
    );
    await waitFor(() =>
      expect(
        codexEgressTimezoneApi.triggerAutomaticProbe,
      ).toHaveBeenCalledOnce(),
    );
  });

  it("shows a failed automatic probe even when IPC resolves to an error state", async () => {
    vi.mocked(codexEgressTimezoneApi.triggerAutomaticProbe).mockResolvedValue({
      state: "error",
      lastError: "ChatGPT egress trace: timeout; path=system_or_transparent",
      monitorIntervalMinutes: 15,
      restartRequired: false,
    });
    const i18n = await createLocalizedTestI18n();
    render(
      <I18nextProvider i18n={i18n}>
        <CodexEgressTimezoneSettings
          value={{ mode: "off" }}
          onChange={vi.fn().mockResolvedValue(true)}
        />
      </I18nextProvider>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Enable automatic monitoring" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "ChatGPT egress trace: timeout",
    );
  });

  it("detects the real ChatGPT egress behind fake-IP DNS and lets the user opt in", async () => {
    vi.mocked(codexEgressTimezoneApi.detect).mockResolvedValue({
      targetHost: "chatgpt.com",
      dnsAddresses: ["198.18.0.14"],
      dnsUsesNonPublicAddress: true,
      egressIp: "2407:cdc0:…",
      countryCode: "TW",
      region: "Taipei",
      city: "Taipei",
      colo: "TPE",
      egressTimezone: "Asia/Taipei",
      currentTimezone: "Asia/Shanghai",
      egressUtcOffset: "+08:00",
      currentUtcOffset: "+08:00",
      timezoneMatch: "offset_match",
      checkedAt: 1_787_875_200,
      networkPath: "system_or_transparent",
    });
    const onChange = vi.fn().mockResolvedValue(true);

    const i18n = await createLocalizedTestI18n();
    render(
      <I18nextProvider i18n={i18n}>
        <CodexEgressTimezoneSettings
          value={{ mode: "off" }}
          onChange={onChange}
        />
      </I18nextProvider>,
    );

    expect(
      screen.getByText("Codex egress timezone monitoring"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /does not block model requests or change the Windows system timezone/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /There is no official evidence that a timezone mismatch causes model degradation/,
      ),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Detect egress timezone" }),
    );

    expect(await screen.findByText("Asia/Taipei")).toBeInTheDocument();
    expect(screen.getByText("Asia/Shanghai")).toBeInTheDocument();
    expect(
      screen.getByText(
        /The IANA names differ, but the current UTC offset matches/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /DNS returned 198\.18\.0\.14.*fake IP.*does not geolocate it/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/2407:cdc0:…/)).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Apply detection result" }),
    );
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "auto",
          detectedTimezone: "Asia/Taipei",
          detectedEgressIp: "2407:cdc0:…",
          detectedCountryCode: "TW",
        }),
      ),
    );

    vi.mocked(codexEgressTimezoneApi.detect).mockRejectedValue(
      "ChatGPT egress trace: timeout",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Detect egress timezone" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "ChatGPT egress trace: timeout",
    );
    expect(
      screen.queryByRole("button", { name: "Apply detection result" }),
    ).not.toBeInTheDocument();
  });

  it("supports an explicit IANA timezone override without touching the system timezone", async () => {
    const onChange = vi.fn().mockResolvedValue(true);
    const i18n = await createLocalizedTestI18n();
    render(
      <I18nextProvider i18n={i18n}>
        <CodexEgressTimezoneSettings
          value={{ mode: "off" }}
          onChange={onChange}
        />
      </I18nextProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Manual settings" }));
    fireEvent.change(screen.getByLabelText("IANA time zone"), {
      target: { value: "America/Los_Angeles" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save manual timezone" }),
    );

    await waitFor(() =>
      expect(codexEgressTimezoneApi.validate).toHaveBeenCalledWith(
        "America/Los_Angeles",
      ),
    );
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "manual",
          manualTimezone: "America/Los_Angeles",
        }),
      ),
    );
  });

  it("lets automatic mode choose a bounded periodic fallback interval", async () => {
    const onChange = vi.fn().mockResolvedValue(true);
    const i18n = await createLocalizedTestI18n();
    render(
      <I18nextProvider i18n={i18n}>
        <CodexEgressTimezoneSettings
          value={{
            mode: "auto",
            detectedTimezone: "Asia/Taipei",
            monitorIntervalMinutes: 15,
          }}
          onChange={onChange}
        />
      </I18nextProvider>,
    );

    expect(
      screen.getByText(/Automatic monitoring enabled/),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Automatic check interval"), {
      target: { value: "30" },
    });

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "auto",
          monitorIntervalMinutes: 30,
        }),
      ),
    );
  });

  it("rejects an unknown IANA timezone before settings are saved", async () => {
    vi.mocked(codexEgressTimezoneApi.validate).mockRejectedValue(
      new Error("未知的 IANA 时区: America/Fake"),
    );
    const onChange = vi.fn().mockResolvedValue(true);
    const i18n = await createLocalizedTestI18n();
    render(
      <I18nextProvider i18n={i18n}>
        <CodexEgressTimezoneSettings
          value={{ mode: "off" }}
          onChange={onChange}
        />
      </I18nextProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Manual settings" }));
    fireEvent.change(screen.getByLabelText("IANA time zone"), {
      target: { value: "America/Fake" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save manual timezone" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "未知的 IANA 时区: America/Fake",
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("verifies the timezone reported by the running Codex renderer", async () => {
    vi.mocked(codexEgressTimezoneApi.inspectRuntime).mockResolvedValue({
      runtimeTimezone: "Asia/Taipei",
      runtimeUtcOffset: "+08:00",
      configuredTimezone: "Asia/Taipei",
      matchesConfigured: true,
      timezoneMatch: "exact",
    });

    const i18n = await createLocalizedTestI18n();
    render(
      <I18nextProvider i18n={i18n}>
        <CodexEgressTimezoneSettings
          value={{ mode: "auto", detectedTimezone: "Asia/Taipei" }}
          onChange={vi.fn()}
        />
      </I18nextProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Inspect running Codex page" }),
    );

    expect(
      await screen.findByText(
        "Running Codex renderer: Asia/Taipei (+08:00), matching the current configuration.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /app-server inherits TZ only when CCSM launches it directly/,
      ),
    ).toBeInTheDocument();
  });
});
