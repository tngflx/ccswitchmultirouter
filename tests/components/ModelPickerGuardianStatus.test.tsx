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

const unverifiedEvidence = () => ({
  ...installed(),
  injectedTargetCount: 1,
  pickerStatus: "unverified" as const,
  pickerVerificationIssues: ["native_visibility_unverified"],
  pickerDiagnostics: {
    pickerObserverCount: 3,
    successObserverCount: 3,
    errorObserverCount: 0,
    pendingObserverCount: 0,
    unsupportedObserverCount: 0,
    unreadableObserverCount: 0,
    nativeVisibilityUnverifiedObserverCount: 3,
    effortMismatchCount: 0,
    flagMismatchCount: 0,
    missingMaxModelCount: 0,
    missingUltraModelCount: 0,
    selectedMaxModelCount: 13,
    selectedUltraModelCount: 13,
  },
});

it("explains the native visibility blocker even when every picker query succeeds", () => {
  render(<ModelPickerGuardianStatus status={unverifiedEvidence()} />);
  const panel = screen.getByRole("status");
  expect(panel).toHaveTextContent("Picker queries: 3 / 3 successful");
  expect(panel).toHaveTextContent(
    "The native reasoning menu visibility could not be verified",
  );
  expect(panel).toHaveTextContent("Native visibility unverified: 3");
  expect(panel).toHaveAttribute("data-picker-ready", "false");
  expect(panel.className).not.toContain("emerald");
});

it("explains how to produce a picker observation without asking for reinjection", () => {
  const status = unverifiedEvidence();
  status.pickerVerificationIssues = ["observer_not_found"];
  status.pickerDiagnostics.pickerObserverCount = 0;
  status.pickerDiagnostics.successObserverCount = 0;
  status.pickerDiagnostics.nativeVisibilityUnverifiedObserverCount = 0;
  render(<ModelPickerGuardianStatus status={status} />);
  expect(screen.getByRole("status")).toHaveTextContent(
    "No managed picker query has been observed. Open the Codex model picker once so the guardian can inspect it.",
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Picker queries: 0 / 0 successful",
  );
  expect(screen.getByRole("status")).toHaveAttribute(
    "data-picker-ready",
    "false",
  );
});

it.each([
  { cdpAvailable: false },
  { codexRunning: false },
  { active: false },
  { injected: false },
])(
  "does not show stale blocker details after currentness is lost: %j",
  (unavailable) => {
    render(
      <ModelPickerGuardianStatus
        status={{ ...unverifiedEvidence(), ...unavailable }}
      />,
    );
    const panel = screen.getByRole("status");
    expect(panel).not.toHaveTextContent("Picker queries:");
    expect(panel).not.toHaveTextContent("Native visibility unverified:");
    expect(panel).not.toHaveTextContent(
      "The native reasoning menu visibility could not be verified",
    );
  },
);

it("reports missing detailed evidence without fabricating a native blocker", () => {
  render(
    <ModelPickerGuardianStatus
      status={{ ...installed(), pickerStatus: "unverified" }}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "This native process did not return detailed verification evidence. Installation alone does not prove picker readiness.",
  );
  expect(screen.getByRole("status")).not.toHaveTextContent(
    "Native visibility unverified:",
  );
});

it("ignores unknown issue strings and never renders raw native diagnostic values", () => {
  const status = unverifiedEvidence();
  status.pickerVerificationIssues = [
    "private-diagnostic-value",
    "native_visibility_unverified",
    "native_visibility_unverified",
  ];
  render(<ModelPickerGuardianStatus status={status} />);
  expect(screen.getByRole("status")).not.toHaveTextContent(
    "private-diagnostic-value",
  );
  expect(
    screen.getAllByText(
      "The native reasoning menu visibility could not be verified",
    ),
  ).toHaveLength(1);
});

it("does not display malformed counts as verification evidence", () => {
  const status = unverifiedEvidence();
  status.pickerDiagnostics.pickerObserverCount = Number.NaN;
  status.pickerDiagnostics.successObserverCount = Number.POSITIVE_INFINITY;
  status.pickerDiagnostics.nativeVisibilityUnverifiedObserverCount = -1;
  render(<ModelPickerGuardianStatus status={status} />);
  const panel = screen.getByRole("status");
  expect(panel).toHaveTextContent("Picker queries: 0 / 0 successful");
  expect(panel).not.toHaveTextContent("NaN");
  expect(panel).not.toHaveTextContent("Infinity");
  expect(panel).not.toHaveTextContent("Native visibility unverified:");
  expect(panel).toHaveAttribute("data-picker-ready", "false");
});

it("explains unverified native Boolean controls even when every picker query succeeds", () => {
  const status = {
    ...unverifiedEvidence(),
    pickerVerificationIssues: ["boolean_control_unverified"],
    pickerDiagnostics: {
      ...unverifiedEvidence().pickerDiagnostics,
      nativeVisibilityUnverifiedObserverCount: 0,
      booleanControlUnverifiedModelCount: 2,
      booleanControlReadyModelCount: 1,
    },
  };
  const { rerender } = render(<ModelPickerGuardianStatus status={status} />);
  const panel = screen.getByRole("status");
  expect(panel).toHaveTextContent("Picker queries: 3 / 3 successful");
  expect(panel).toHaveTextContent(
    "The native reasoning on/off controls could not be verified for every Boolean model",
  );
  expect(panel).toHaveTextContent("Boolean controls unverified: 2");
  expect(panel).toHaveTextContent("Boolean controls verified: 1");
  expect(panel).toHaveAttribute("data-picker-ready", "false");
  expect(panel.className).not.toContain("emerald");
  rerender(
    <ModelPickerGuardianStatus status={{ ...status, cdpAvailable: false }} />,
  );
  expect(panel).not.toHaveTextContent("Boolean controls unverified:");
  expect(panel).not.toHaveTextContent("Boolean controls verified:");
  expect(panel).not.toHaveTextContent(
    "The native reasoning on/off controls could not be verified",
  );
});
