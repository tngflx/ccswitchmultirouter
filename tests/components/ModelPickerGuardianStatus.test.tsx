import { render, screen } from "@testing-library/react";
import i18n from "i18next";
import { beforeEach, expect, it } from "vitest";
import en from "@/i18n/locales/en.json";
import { ModelPickerGuardianStatus } from "@/components/codex/ModelPickerGuardianStatus";
import type { CodexGuardianStatus } from "@/types/proxy";

const installed = (): CodexGuardianStatus => ({
  active: true,
  codexRunning: true,
  cdpAvailable: true,
  injectedTargetCount: 2,
  injected: true,
  pickerReadyTargetCount: 0,
  pickerStatus: "pending",
  lastEvent: "Installed compatibility runtime",
  message: "Fixture diagnostics only",
});

beforeEach(async () => {
  i18n.addResourceBundle("en", "translation", en, true, true);
  await i18n.changeLanguage("en");
});

it("does not paint a fully installed but pending picker as ready", () => {
  render(<ModelPickerGuardianStatus status={installed()} />);
  const panel = screen.getByRole("status");
  expect(panel).toHaveAttribute("data-picker-ready", "false");
  expect(panel).toHaveTextContent(en.modelPickerGuardian.pending);
  expect(panel).toHaveTextContent("Installed: 2 · verified ready: 0");
  expect(panel.className).not.toContain("emerald");
});

it("requires fresh ready proof for every installed target", () => {
  const status = installed();
  status.pickerStatus = "ready";
  status.pickerReadyTargetCount = 1;
  const { rerender } = render(<ModelPickerGuardianStatus status={status} />);
  expect(screen.getByRole("status")).toHaveAttribute(
    "data-picker-ready",
    "false",
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    en.modelPickerGuardian.unverified,
  );
  rerender(
    <ModelPickerGuardianStatus
      status={{ ...status, pickerReadyTargetCount: 2 }}
    />,
  );
  expect(screen.getByRole("status")).toHaveAttribute(
    "data-picker-ready",
    "true",
  );
  expect(screen.getByRole("status").className).toContain("emerald");
});

it.each(["error", "mismatch", "unverified"] as const)(
  "surfaces %s instead of turning an installed runtime green",
  (pickerStatus) => {
    render(
      <ModelPickerGuardianStatus status={{ ...installed(), pickerStatus }} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      en.modelPickerGuardian[pickerStatus],
    );
    expect(screen.getByRole("status")).toHaveAttribute(
      "data-picker-ready",
      "false",
    );
  },
);

it("fails closed for an old native response without picker-readiness fields", () => {
  const status = installed();
  delete status.pickerStatus;
  delete status.pickerReadyTargetCount;
  render(<ModelPickerGuardianStatus status={status} />);
  expect(screen.getByRole("status")).toHaveTextContent(
    en.modelPickerGuardian.unverified,
  );
  expect(screen.getByRole("status")).toHaveAttribute(
    "data-picker-ready",
    "false",
  );
});

it("reports unknown future native statuses as unverified", () => {
  render(
    <ModelPickerGuardianStatus
      status={{ ...installed(), pickerStatus: "future-status" as never }}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    en.modelPickerGuardian.unverified,
  );
  expect(screen.getByRole("status")).toHaveAttribute(
    "data-picker-ready",
    "false",
  );
});

it("does not certify an empty or unmanaged catalog from a zero count", () => {
  render(
    <ModelPickerGuardianStatus
      status={{
        ...installed(),
        injectedTargetCount: 0,
        injected: false,
        pickerStatus: "not_required",
      }}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    en.modelPickerGuardian.notRequired,
  );
  expect(screen.getByRole("status")).toHaveAttribute(
    "data-picker-ready",
    "false",
  );
});

it("does not retain stale ready status when Codex or CDP becomes unavailable", () => {
  render(
    <ModelPickerGuardianStatus
      status={{
        ...installed(),
        codexRunning: false,
        cdpAvailable: false,
        pickerStatus: "ready",
        pickerReadyTargetCount: 2,
      }}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    en.modelPickerGuardian.polling,
  );
  expect(screen.getByRole("status")).toHaveTextContent("verified ready: 0");
  expect(screen.getByRole("status")).toHaveAttribute(
    "data-picker-ready",
    "false",
  );
});
