import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { CodexGuardianStatus } from "@/types/proxy";

const safeCount = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;

const verificationIssueKeys = {
  runtime_not_current: "runtimeNotCurrent",
  catalog_unavailable: "catalogUnavailable",
  diagnostics_unavailable: "diagnosticsUnavailable",
  observer_not_found: "observerNotFound",
  observer_pending: "observerPending",
  observer_error: "observerError",
  observer_unsupported: "observerUnsupported",
  observer_unreadable: "observerUnreadable",
  native_visibility_unverified: "nativeVisibilityUnverified",
  boolean_control_unverified: "booleanControlUnverified",
  effort_mismatch: "effortMismatch",
  flag_mismatch: "flagMismatch",
} as const;

type VerificationIssue = keyof typeof verificationIssueKeys;

const isVerificationIssue = (value: unknown): value is VerificationIssue =>
  typeof value === "string" &&
  Object.prototype.hasOwnProperty.call(verificationIssueKeys, value);

const diagnosticCountKeys = {
  errorObserverCount: "errorQueries",
  pendingObserverCount: "pendingQueries",
  unsupportedObserverCount: "unsupportedQueries",
  unreadableObserverCount: "unreadableQueries",
  nativeVisibilityUnverifiedObserverCount: "nativeVisibilityCount",
  booleanControlUnverifiedModelCount: "booleanUnverifiedCount",
  booleanControlReadyModelCount: "booleanReadyCount",
  effortMismatchCount: "effortMismatchCount",
  flagMismatchCount: "flagMismatchCount",
  missingMaxModelCount: "missingMaxCount",
  missingUltraModelCount: "missingUltraCount",
} as const;

/** Installation and live picker verification are intentionally distinct. */
export function ModelPickerGuardianStatus({
  status,
}: {
  status: CodexGuardianStatus;
}) {
  const { t } = useTranslation();
  const installed = safeCount(status.injectedTargetCount);
  const readyCount = safeCount(status.pickerReadyTargetCount);
  const current =
    status.active &&
    status.codexRunning &&
    status.cdpAvailable &&
    status.injected;
  const ready =
    current &&
    installed > 0 &&
    status.pickerStatus === "ready" &&
    readyCount === installed;
  const observedLabel = ["pending", "error", "mismatch", "unverified"].includes(
    status.pickerStatus ?? "",
  )
    ? status.pickerStatus
    : "unverified";
  const label =
    !status.codexRunning || !status.cdpAvailable
      ? "polling"
      : status.pickerStatus === "not_required"
        ? "notRequired"
        : !status.injected
          ? "pendingInjection"
          : ready
            ? "ready"
            : observedLabel;

  // Never retain diagnostic evidence after the runtime loses currentness.
  const diagnostics = current ? status.pickerDiagnostics : null;
  const verificationIssues =
    current && !ready && Array.isArray(status.pickerVerificationIssues)
      ? [
          ...new Set(
            status.pickerVerificationIssues.filter(isVerificationIssue),
          ),
        ]
      : [];
  const showMissingEvidence =
    current &&
    !ready &&
    status.pickerStatus !== "not_required" &&
    !diagnostics &&
    verificationIssues.length === 0;

  return (
    <div
      role="status"
      data-testid="model-picker-guardian-status"
      data-picker-ready={String(ready)}
      className={cn(
        "mt-3 rounded-lg border p-3 text-xs leading-5",
        ready
          ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-700/50 dark:bg-emerald-950/25 dark:text-emerald-100"
          : status.cdpAvailable
            ? "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-700/50 dark:bg-amber-950/25 dark:text-amber-100"
            : "border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-600/50 dark:bg-slate-900/60 dark:text-slate-300",
      )}
    >
      <div className="flex items-center gap-2 font-semibold">
        <span
          className={cn(
            "inline-block h-2 w-2 rounded-full",
            ready
              ? "bg-emerald-500"
              : status.cdpAvailable
                ? "bg-amber-400"
                : "bg-slate-400",
          )}
        />
        {t("modelPickerGuardian.title")} · {t(`modelPickerGuardian.${label}`)}
      </div>
      <div className="mt-1">{status.message}</div>
      {verificationIssues.length > 0 && (
        <ul className="mt-1 list-disc space-y-0.5 pl-4">
          {verificationIssues.map((issue) => (
            <li key={issue}>
              {t(`modelPickerGuardian.issues.${verificationIssueKeys[issue]}`)}
            </li>
          ))}
        </ul>
      )}
      {showMissingEvidence && (
        <div className="mt-1">{t("modelPickerGuardian.missingEvidence")}</div>
      )}
      {diagnostics && (
        <div className="mt-1 flex flex-wrap gap-x-3 font-mono text-[11px] opacity-80">
          <span>
            {t("modelPickerGuardian.queries", {
              successful: safeCount(diagnostics.successObserverCount),
              total: safeCount(diagnostics.pickerObserverCount),
            })}
          </span>
          {Object.entries(diagnosticCountKeys).map(([key, labelKey]) => {
            const count = safeCount(
              diagnostics[key as keyof typeof diagnosticCountKeys],
            );
            return count > 0 ? (
              <span key={key}>
                {t(`modelPickerGuardian.${labelKey}`, { count })}
              </span>
            ) : null;
          })}
        </div>
      )}
      <div className="mt-1 font-mono text-[11px] opacity-80">
        {t("modelPickerGuardian.runtime", {
          running: t(
            `modelPickerGuardian.${status.codexRunning ? "running" : "notRunning"}`,
          ),
          available: t(
            `modelPickerGuardian.${status.cdpAvailable ? "available" : "unavailable"}`,
          ),
        })}{" "}
        ·{" "}
        {t("modelPickerGuardian.targets", {
          installed,
          ready: current ? readyCount : 0,
        })}
      </div>
    </div>
  );
}
