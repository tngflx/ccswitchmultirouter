import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleX,
  Clock3,
  DatabaseZap,
  Info,
  RefreshCw,
  Save,
  ShieldCheck,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { proxyApi } from "@/lib/api/proxy";
import { settingsApi } from "@/lib/api/settings";
import { cn } from "@/lib/utils";
import type {
  OpenAIResponsesContractStatus,
  RequestHealthConfig,
  RequestHealthDiagnostic,
  RequestHealthFinding,
  RequestHealthSnapshot,
} from "@/types/proxy";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(1)} KB`;
}

type DiagnosticSeverity = "error" | "warning" | "info" | "healthy";

function findingSeverity(finding: RequestHealthFinding): DiagnosticSeverity {
  if (finding.severity === "error" || finding.severity === "info") {
    return finding.severity;
  }
  return "warning";
}

function diagnosticSeverity(
  diagnostic: RequestHealthDiagnostic,
): DiagnosticSeverity {
  const findings = diagnostic.anomaly
    ? [...diagnostic.findings, diagnostic.anomaly]
    : diagnostic.findings;
  if (
    diagnostic.blocked ||
    diagnostic.tokenLimitExceeded ||
    findings.some((finding) => findingSeverity(finding) === "error")
  ) {
    return "error";
  }
  if (
    diagnostic.thresholdExceeded ||
    findings.some((finding) => findingSeverity(finding) === "warning")
  ) {
    return "warning";
  }
  return findings.length > 0 ? "info" : "healthy";
}

function findingClass(severity: DiagnosticSeverity): string {
  if (severity === "error") return "text-red-800 dark:text-red-200";
  if (severity === "warning") return "text-amber-700 dark:text-amber-300";
  return "text-muted-foreground";
}

function newerContract(
  current: OpenAIResponsesContractStatus | undefined,
  incoming: OpenAIResponsesContractStatus,
): OpenAIResponsesContractStatus {
  if (
    current?.checkedAt &&
    (!incoming.checkedAt ||
      Date.parse(current.checkedAt) > Date.parse(incoming.checkedAt))
  ) {
    return current;
  }
  return incoming;
}

function validNumber(
  value: string,
  min: number,
  max: number,
  integer = true,
): boolean {
  const number = Number(value);
  return (
    value.trim() !== "" &&
    Number.isFinite(number) &&
    (!integer || Number.isInteger(number)) &&
    number >= min &&
    number <= max
  );
}

export function RequestHealthPanel({
  snapshot,
  isRefreshing,
  loadError,
  onRefresh,
  onSaved,
  onSaveConfig,
  mode = "full",
}: {
  snapshot?: RequestHealthSnapshot;
  isRefreshing: boolean;
  loadError?: string | null;
  onRefresh: () => void;
  onSaved?: (config: RequestHealthConfig) => void;
  onSaveConfig?: (
    config: RequestHealthConfig,
  ) => Promise<RequestHealthConfig | null>;
  mode?: "full" | "settings" | "status";
}) {
  const { t } = useTranslation();
  const showSettings = mode !== "status";
  const showStatus = mode !== "settings";
  const [draft, setDraft] = useState<RequestHealthConfig | null>(null);
  const [thresholdKb, setThresholdKb] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [timeoutSeconds, setTimeoutSeconds] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [contract, setContract] = useState<
    OpenAIResponsesContractStatus | undefined
  >(snapshot?.contract);
  const [isCheckingContract, setIsCheckingContract] = useState(false);
  const [contractActionError, setContractActionError] = useState<string | null>(
    null,
  );
  const saving = useRef(false);
  const editVersion = useRef(0);
  const fieldEditVersions = useRef(
    new Map<keyof RequestHealthConfig, number>(),
  );
  const checkingContract = useRef(false);
  const contractCheckBaseline = useRef<string | null>(null);

  const adoptConfig = useCallback(
    (
      config: RequestHealthConfig,
      preserveFields: Array<keyof RequestHealthConfig> = [],
    ) => {
      setDraft((current) => ({
        ...config,
        ...Object.fromEntries(
          preserveFields.map((key) => [key, current?.[key] ?? config[key]]),
        ),
      }));
      if (!preserveFields.includes("largeRequestThresholdBytes")) {
        setThresholdKb(String(config.largeRequestThresholdBytes / 1024));
      }
      if (!preserveFields.includes("maxCodexInputTokens")) {
        setMaxTokens(String(config.maxCodexInputTokens));
      }
      if (!preserveFields.includes("reviewTimeoutSeconds")) {
        setTimeoutSeconds(String(config.reviewTimeoutSeconds));
      }
    },
    [],
  );

  useEffect(() => {
    if (!snapshot?.config || saving.current) return;
    adoptConfig(snapshot.config, [...fieldEditVersions.current.keys()]);
  }, [snapshot?.config, adoptConfig]);

  useEffect(() => {
    if (snapshot?.contract) {
      const incoming = snapshot.contract;
      setContract((current) => newerContract(current, incoming));
      if (
        !checkingContract.current &&
        incoming.checkedAt &&
        (!contractCheckBaseline.current ||
          Date.parse(incoming.checkedAt) >
            Date.parse(contractCheckBaseline.current))
      ) {
        setContractActionError(null);
      }
    }
  }, [snapshot?.contract]);

  const markEdited = (key: keyof RequestHealthConfig) => {
    fieldEditVersions.current.set(key, ++editVersion.current);
    setSaveMessage(null);
  };

  const update = <K extends keyof RequestHealthConfig>(
    key: K,
    value: RequestHealthConfig[K],
  ) => {
    markEdited(key);
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  };

  const numericInputsValid =
    validNumber(thresholdKb, 64, 16384, false) &&
    validNumber(maxTokens, 1000, 2000000) &&
    validNumber(timeoutSeconds, 15, 300);

  async function save() {
    if (saving.current) return;
    if (!draft || !numericInputsValid) {
      const message = t("settings.saveFailedGeneric", {
        defaultValue: "Save failed, please try again",
      });
      setSaveMessage(message);
      toast.error(message, { closeButton: true });
      return;
    }
    const submittedVersion = editVersion.current;
    saving.current = true;
    setIsSaving(true);
    setSaveMessage(null);
    try {
      const saved = await (onSaveConfig ?? settingsApi.saveRequestHealthConfig)(
        draft,
      );
      if (!saved || typeof saved.enabled !== "boolean") {
        throw new Error(
          t("settings.saveFailedGeneric", {
            defaultValue: "Save failed, please try again",
          }),
        );
      }
      // Keep edits made after submission while adopting backend normalization.
      for (const [key, version] of fieldEditVersions.current) {
        if (version <= submittedVersion) fieldEditVersions.current.delete(key);
      }
      const editedDuringSave = [...fieldEditVersions.current.keys()];
      adoptConfig(saved, editedDuringSave);
      const message = t(
        editedDuringSave.length > 0
          ? "settings.requestHealth.savedPendingEdits"
          : "settings.requestHealth.saved",
      );
      setSaveMessage(message);
      toast.success(message, { closeButton: true });
      onSaved?.(saved);
    } catch (error) {
      const message = errorMessage(error);
      setSaveMessage(message);
      toast.error(message, { closeButton: true });
    } finally {
      saving.current = false;
      setIsSaving(false);
    }
  }

  async function checkContract() {
    if (checkingContract.current) return;
    checkingContract.current = true;
    contractCheckBaseline.current = contract?.checkedAt ?? null;
    setIsCheckingContract(true);
    setContractActionError(null);
    try {
      const checked = await proxyApi.checkOpenAIResponsesContract();
      setContract((current) => newerContract(current, checked));
    } catch (error) {
      setContractActionError(errorMessage(error));
    } finally {
      checkingContract.current = false;
      setIsCheckingContract(false);
    }
  }

  const diagnostics =
    snapshot?.config.enabled === true ? (snapshot?.diagnostics ?? []) : [];
  const latest = diagnostics[0];
  const latestAnomaly = latest?.anomaly;
  const latestFindings = latest
    ? latestAnomaly &&
      !latest.findings.some(
        (finding) =>
          finding.code === latestAnomaly.code &&
          finding.detail === latestAnomaly.detail,
      )
      ? [...latest.findings, latestAnomaly]
      : latest.findings
    : [];
  const latestSeverity = latest ? diagnosticSeverity(latest) : "healthy";
  const hasErrors = diagnostics.some(
    (item) => diagnosticSeverity(item) === "error",
  );
  const hasWarnings = diagnostics.some((item) =>
    ["error", "warning"].includes(diagnosticSeverity(item)),
  );
  const severityLabel = {
    error: t("settings.requestHealth.severityError"),
    warning: t("settings.requestHealth.severityWarning"),
    info: t("settings.requestHealth.severityInfo"),
    healthy: t("settings.requestHealth.severityHealthy"),
  };
  const ratio = latest
    ? Math.min(1, latest.optimizedBytes / Math.max(1, latest.thresholdBytes))
    : 0;
  const contractStatus = contractActionError
    ? "check_failed"
    : (contract?.status ?? "not_checked");
  const contractStatusLabel =
    contractStatus === "up_to_date"
      ? t("settings.requestHealth.contractStatusCurrent")
      : contractStatus === "drift_detected"
        ? t("settings.requestHealth.contractStatusDrift")
        : contractStatus === "check_failed"
          ? t("settings.requestHealth.contractStatusFailed")
          : t("settings.requestHealth.contractStatusNotChecked");
  const contractStatusClass =
    contractStatus === "up_to_date"
      ? "border-emerald-300/70 bg-emerald-50/70 text-emerald-800 dark:border-emerald-700/50 dark:bg-emerald-950/20 dark:text-emerald-200"
      : contractStatus === "drift_detected" || contractStatus === "check_failed"
        ? "border-amber-300/70 bg-amber-50/70 text-amber-900 dark:border-amber-700/50 dark:bg-amber-950/20 dark:text-amber-100"
        : "border-border bg-background/50 text-muted-foreground";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-cyan-200/70 bg-cyan-50/50 p-4 dark:border-cyan-800/50 dark:bg-cyan-950/20">
        <div className="flex min-w-0 items-start gap-3">
          <ShieldCheck className="mt-0.5 h-6 w-6 shrink-0 text-cyan-600 dark:text-cyan-300" />
          <div>
            <h4 className="text-sm font-semibold">
              {mode === "settings"
                ? t("settings.tabRequestHealthSettings")
                : t("settings.requestHealth.title")}
            </h4>
            <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">
              {t("settings.requestHealth.description")}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          {showStatus ? (
            <Button
              size="sm"
              variant="outline"
              onClick={onRefresh}
              disabled={isRefreshing}
            >
              <RefreshCw
                className={cn("mr-2 h-4 w-4", isRefreshing && "animate-spin")}
              />
              {t("settings.requestHealth.refresh")}
            </Button>
          ) : null}
          {showSettings ? (
            <Button
              size="sm"
              onClick={() => void save()}
              disabled={!draft || !numericInputsValid || isSaving}
            >
              <Save className="mr-2 h-4 w-4" />
              {t("settings.requestHealth.save")}
            </Button>
          ) : null}
        </div>
      </div>

      {loadError ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-red-300/70 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-700/50 dark:bg-red-950/20 dark:text-red-200"
        >
          <span>
            {t("settings.requestHealth.loadFailed", { message: loadError })}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={onRefresh}
            disabled={isRefreshing}
          >
            <RefreshCw className="h-4 w-4" />
            {t("settings.requestHealth.retry")}
          </Button>
        </div>
      ) : showSettings && !draft ? (
        <div role="status" className="text-xs text-muted-foreground">
          {t("common.loading")}
        </div>
      ) : null}

      {showSettings && draft ? (
        <div className="rounded-md border border-border bg-background/50 p-3">
          <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <DatabaseZap className="h-4 w-4 text-cyan-500" />
            {t("settings.requestHealth.mode")}
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="flex items-center gap-2 rounded-md border border-border p-3 text-sm">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) => update("enabled", event.target.checked)}
              />
              {t("settings.requestHealth.enabled")}
            </label>
            <label className="rounded-md border border-border p-3 text-sm">
              <span className="mb-2 block font-medium">
                {t("settings.requestHealth.mode")}
              </span>
              <select
                className="w-full rounded-md border border-input bg-background px-2 py-1.5"
                value={draft.optimizationMode}
                onChange={(event) =>
                  update(
                    "optimizationMode",
                    event.target
                      .value as RequestHealthConfig["optimizationMode"],
                  )
                }
              >
                <option value="off">
                  {t("settings.requestHealth.modeOff")}
                </option>
                <option value="diagnose">
                  {t("settings.requestHealth.modeDiagnose")}
                </option>
                <option value="safe">
                  {t("settings.requestHealth.modeSafe")}
                </option>
              </select>
            </label>
            <label className="rounded-md border border-border p-3 text-sm">
              <span className="mb-2 block font-medium">
                {t("settings.requestHealth.threshold")}
              </span>
              <input
                className="w-full rounded-md border border-input bg-background px-2 py-1.5"
                type="number"
                min={64}
                max={16384}
                step="any"
                aria-invalid={!validNumber(thresholdKb, 64, 16384, false)}
                value={thresholdKb}
                onChange={(event) => {
                  setThresholdKb(event.target.value);
                  const value = Number(event.target.value);
                  if (Number.isFinite(value) && value > 0) {
                    update(
                      "largeRequestThresholdBytes",
                      Math.round(Math.min(16384, Math.max(64, value)) * 1024),
                    );
                  } else {
                    markEdited("largeRequestThresholdBytes");
                  }
                }}
              />
            </label>
            <label className="rounded-md border border-border p-3 text-sm">
              <span className="mb-2 block font-medium">
                {t("settings.requestHealth.maxInputTokens")}
              </span>
              <input
                className="w-full rounded-md border border-input bg-background px-2 py-1.5"
                type="number"
                min={1000}
                max={2000000}
                step={1}
                aria-invalid={!validNumber(maxTokens, 1000, 2000000)}
                value={maxTokens}
                onChange={(event) => {
                  setMaxTokens(event.target.value);
                  const value = Number(event.target.value);
                  if (Number.isFinite(value) && value > 0) {
                    update(
                      "maxCodexInputTokens",
                      Math.min(2000000, Math.max(1000, Math.round(value))),
                    );
                  } else {
                    markEdited("maxCodexInputTokens");
                  }
                }}
              />
            </label>
            <label className="rounded-md border border-border p-3 text-sm">
              <span className="mb-2 block font-medium">
                {t("settings.requestHealth.reviewMode")}
              </span>
              <select
                className="w-full rounded-md border border-input bg-background px-2 py-1.5"
                value={draft.reviewMode}
                onChange={(event) =>
                  update(
                    "reviewMode",
                    event.target.value as RequestHealthConfig["reviewMode"],
                  )
                }
              >
                <option value="off">
                  {t("settings.requestHealth.reviewModeOff")}
                </option>
                <option value="first_large_request">
                  {t("settings.requestHealth.reviewModeFirst")}
                </option>
                <option value="sustained_growth">
                  {t("settings.requestHealth.reviewModeSustained")}
                </option>
              </select>
            </label>
            <label className="rounded-md border border-border p-3 text-sm">
              <span className="mb-2 block font-medium">
                {t("settings.requestHealth.reviewTimeout")}
              </span>
              <input
                className="w-full rounded-md border border-input bg-background px-2 py-1.5"
                type="number"
                min={15}
                max={300}
                step={1}
                aria-invalid={!validNumber(timeoutSeconds, 15, 300)}
                value={timeoutSeconds}
                onChange={(event) => {
                  setTimeoutSeconds(event.target.value);
                  const value = Number(event.target.value);
                  if (Number.isFinite(value) && value > 0) {
                    update(
                      "reviewTimeoutSeconds",
                      Math.min(300, Math.max(15, Math.round(value))),
                    );
                  } else {
                    markEdited("reviewTimeoutSeconds");
                  }
                }}
              />
            </label>
            <label className="flex items-center gap-2 rounded-md border border-border p-3 text-sm">
              <input
                type="checkbox"
                checked={draft.summarizeAndRestartEnabled}
                onChange={(event) =>
                  update("summarizeAndRestartEnabled", event.target.checked)
                }
              />
              {t("settings.requestHealth.summarizeAndRestartEnabled")}
            </label>
            <label className="flex items-center gap-2 rounded-md border border-border p-3 text-sm">
              <input
                type="checkbox"
                checked={draft.windowsNotificationsEnabled}
                onChange={(event) =>
                  update("windowsNotificationsEnabled", event.target.checked)
                }
              />
              {t("settings.requestHealth.windowsNotificationsEnabled")}
            </label>
          </div>
          {draft.summarizeAndRestartEnabled &&
          !draft.windowsNotificationsEnabled ? (
            <div
              role="alert"
              className="mt-3 rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700/50 dark:bg-amber-950/20 dark:text-amber-100"
            >
              {t("settings.requestHealth.summarizeRequiresNotifications")}
            </div>
          ) : null}
        </div>
      ) : null}

      {showSettings && saveMessage ? (
        <div role="status" className="text-xs text-muted-foreground">
          {saveMessage}
        </div>
      ) : null}

      {showStatus ? (
        <section className="rounded-md border border-border bg-background/50 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-3">
              <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-cyan-600 dark:text-cyan-300" />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className="text-sm font-semibold">
                    {t("settings.requestHealth.contractTitle")}
                  </h4>
                  <Badge
                    variant="outline"
                    className={cn("border", contractStatusClass)}
                  >
                    {contractStatusLabel}
                  </Badge>
                </div>
                <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">
                  {t("settings.requestHealth.contractDescription")}
                </p>
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void checkContract()}
              disabled={isCheckingContract}
            >
              <RefreshCw
                className={cn("h-4 w-4", isCheckingContract && "animate-spin")}
              />
              {t("settings.requestHealth.contractCheck")}
            </Button>
          </div>
          {contract ? (
            <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
              <div className="rounded-md border border-border/70 px-3 py-2">
                <div className="text-muted-foreground">
                  {t("settings.requestHealth.contractSnapshot")}
                </div>
                <div className="mt-1 font-medium">
                  v{contract.version} · {contract.verifiedAt}
                </div>
              </div>
              <div className="rounded-md border border-border/70 px-3 py-2">
                <div className="text-muted-foreground">
                  {t("settings.requestHealth.contractLastChecked")}
                </div>
                <div className="mt-1 flex items-center gap-1 font-medium">
                  <Clock3 className="h-3.5 w-3.5 text-muted-foreground" />
                  {contract.checkedAt ??
                    t("settings.requestHealth.contractNeverChecked")}
                </div>
              </div>
              <div className="rounded-md border border-border/70 px-3 py-2 sm:col-span-2">
                <div className="text-muted-foreground">
                  {t("settings.requestHealth.contractCoverage")}
                </div>
                <div className="mt-1">{contract.coverage}</div>
                <div className="mt-2 break-all font-mono text-[11px] text-muted-foreground">
                  {contract.source}
                </div>
              </div>
            </div>
          ) : (
            <div className="mt-3 text-xs text-muted-foreground">
              {t("settings.requestHealth.contractLoading")}
            </div>
          )}
          {contract?.changedSections.length ? (
            <div
              role="alert"
              className="mt-3 rounded-md border border-amber-300/70 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700/50 dark:bg-amber-950/20 dark:text-amber-100"
            >
              <div className="font-semibold">
                {t("settings.requestHealth.contractChanged")}
              </div>
              <div className="mt-1">{contract.changedSections.join(", ")}</div>
            </div>
          ) : null}
          {contract?.error || contractActionError ? (
            <div
              role="alert"
              className="mt-3 rounded-md border border-red-300/70 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-700/50 dark:bg-red-950/20 dark:text-red-200"
            >
              {contractActionError ?? contract?.error}
            </div>
          ) : null}
        </section>
      ) : null}

      {showStatus && hasWarnings ? (
        <div
          role="status"
          className={cn(
            "flex items-start gap-2 rounded-md border px-3 py-3 text-sm",
            hasErrors
              ? "border-red-300/70 bg-red-50 text-red-800 dark:border-red-700/50 dark:bg-red-950/20 dark:text-red-200"
              : "border-amber-300/60 bg-amber-50 text-amber-900 dark:border-amber-700/50 dark:bg-amber-950/20 dark:text-amber-100",
          )}
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {t("settings.requestHealth.historyWarning")}
        </div>
      ) : null}

      {showStatus && latest ? (
        <div className="space-y-3 rounded-md border border-border bg-background/50 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <span role="img" aria-label={severityLabel[latestSeverity]}>
                {latestSeverity === "error" ? (
                  <CircleX className="h-4 w-4 text-red-600 dark:text-red-300" />
                ) : latestSeverity === "warning" ? (
                  <AlertTriangle className="h-4 w-4 text-amber-500" />
                ) : latestSeverity === "info" ? (
                  <Info className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                )}
              </span>
              {latest.providerName} · {latest.model}
            </div>
            <Badge variant="outline">{bytes(latest.optimizedBytes)}</Badge>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-md border border-border p-3">
              <div className="text-xs text-muted-foreground">
                {t("settings.requestHealth.items")}
              </div>
              <div className="mt-1 font-semibold">{latest.itemCount}</div>
            </div>
            <div className="rounded-md border border-border p-3">
              <div className="text-xs text-muted-foreground">
                {t("settings.requestHealth.removed")}
              </div>
              <div className="mt-1 font-semibold">
                {bytes(latest.bytesRemoved)}
              </div>
            </div>
            <div className="rounded-md border border-border p-3">
              <div className="text-xs text-muted-foreground">
                {t("settings.requestHealth.estimatedInputTokens")}
              </div>
              <div className="mt-1 font-semibold">
                {latest.estimatedInputTokens.toLocaleString()}
              </div>
            </div>
            <div className="rounded-md border border-border p-3">
              <div className="text-xs text-muted-foreground">
                {t("settings.requestHealth.mediaBytes")}
              </div>
              <div className="mt-1 font-semibold">
                {bytes(latest.mediaBytes)}
              </div>
            </div>
          </div>
          <div className="text-xs text-muted-foreground">
            {bytes(latest.optimizedBytes)} / {bytes(latest.thresholdBytes)}
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                "h-full rounded-full",
                ratio >= 1 ? "bg-amber-500" : "bg-cyan-500",
              )}
              style={{ width: `${Math.max(3, ratio * 100)}%` }}
            />
          </div>
          {latestFindings.length > 0 ? (
            <div className="space-y-1 text-xs">
              {latestFindings.map((finding, index) => (
                <div
                  key={`${finding.code}-${index}`}
                  className={findingClass(findingSeverity(finding))}
                >
                  <span className="mr-2 font-semibold">
                    {severityLabel[findingSeverity(finding)]}
                  </span>
                  <strong>{finding.code}</strong>: {finding.detail}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : showStatus ? (
        <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
          {t("settings.requestHealth.empty")}
        </div>
      ) : null}

      {showStatus && diagnostics.length > 0 ? (
        <div className="rounded-md border border-border bg-background/50 p-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("settings.requestHealth.timeline")}
          </div>
          <div className="space-y-2">
            {diagnostics.slice(0, 12).map((item) => (
              <div
                key={`${item.traceId ?? item.sessionId}-${item.generatedAt}`}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border/70 px-3 py-2 text-xs"
              >
                <span className="font-mono text-muted-foreground">
                  {item.generatedAt}
                </span>
                <span className="font-medium">
                  {item.providerName} · {item.model}
                </span>
                <span className="text-muted-foreground">
                  {item.reviewAction ?? t("settings.requestHealth.actionNone")}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
