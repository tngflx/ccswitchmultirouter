import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  DatabaseZap,
  RefreshCw,
  Save,
  ShieldCheck,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { settingsApi } from "@/lib/api/settings";
import { cn } from "@/lib/utils";
import type { RequestHealthConfig, RequestHealthSnapshot } from "@/types/proxy";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(1)} KB`;
}

export function RequestHealthPanel({
  snapshot,
  isRefreshing,
  onRefresh,
  onSaved,
}: {
  snapshot?: RequestHealthSnapshot;
  isRefreshing: boolean;
  onRefresh: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<RequestHealthConfig | null>(null);
  const [thresholdKb, setThresholdKb] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [timeoutSeconds, setTimeoutSeconds] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!snapshot?.config) return;
    setDraft(snapshot.config);
    setThresholdKb(
      String(Math.round(snapshot.config.largeRequestThresholdBytes / 1024)),
    );
    setMaxTokens(String(snapshot.config.maxCodexInputTokens));
    setTimeoutSeconds(String(snapshot.config.reviewTimeoutSeconds));
  }, [snapshot?.config]);

  const update = <K extends keyof RequestHealthConfig>(
    key: K,
    value: RequestHealthConfig[K],
  ) =>
    setDraft((current) => (current ? { ...current, [key]: value } : current));

  async function save() {
    if (!draft) return;
    setIsSaving(true);
    setSaveMessage(null);
    try {
      const settings = await settingsApi.get();
      await settingsApi.save({ ...settings, requestHealth: draft });
      setSaveMessage(t("settings.requestHealth.saved"));
      onSaved();
    } catch (error) {
      setSaveMessage(errorMessage(error));
    } finally {
      setIsSaving(false);
    }
  }

  const latest = snapshot?.diagnostics[0];
  const diagnostics = snapshot?.diagnostics ?? [];
  const hasWarnings = diagnostics.some(
    (item) =>
      item.thresholdExceeded ||
      item.tokenLimitExceeded ||
      item.findings.length > 0 ||
      item.anomaly,
  );
  const ratio = latest
    ? Math.min(1, latest.optimizedBytes / Math.max(1, latest.thresholdBytes))
    : 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-cyan-200/70 bg-cyan-50/50 p-4 dark:border-cyan-800/50 dark:bg-cyan-950/20">
        <div className="flex min-w-0 items-start gap-3">
          <ShieldCheck className="mt-0.5 h-6 w-6 shrink-0 text-cyan-600 dark:text-cyan-300" />
          <div>
            <h4 className="text-sm font-semibold">
              {t("settings.requestHealth.title")}
            </h4>
            <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">
              {t("settings.requestHealth.description")}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
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
          <Button
            size="sm"
            onClick={() => void save()}
            disabled={!draft || isSaving}
          >
            <Save className="mr-2 h-4 w-4" />
            {t("settings.requestHealth.save")}
          </Button>
        </div>
      </div>

      {draft ? (
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
                value={thresholdKb}
                onChange={(event) => {
                  setThresholdKb(event.target.value);
                  const value = Number(event.target.value);
                  if (Number.isFinite(value) && value > 0)
                    update(
                      "largeRequestThresholdBytes",
                      Math.min(16384, Math.max(64, value)) * 1024,
                    );
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
                value={maxTokens}
                onChange={(event) => {
                  setMaxTokens(event.target.value);
                  const value = Number(event.target.value);
                  if (Number.isFinite(value) && value > 0)
                    update(
                      "maxCodexInputTokens",
                      Math.min(2000000, Math.max(1000, Math.round(value))),
                    );
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
                value={timeoutSeconds}
                onChange={(event) => {
                  setTimeoutSeconds(event.target.value);
                  const value = Number(event.target.value);
                  if (Number.isFinite(value) && value > 0)
                    update(
                      "reviewTimeoutSeconds",
                      Math.min(300, Math.max(15, Math.round(value))),
                    );
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

      {saveMessage ? (
        <div className="text-xs text-muted-foreground">{saveMessage}</div>
      ) : null}
      {hasWarnings ? (
        <div
          role="status"
          className="flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50 px-3 py-3 text-sm text-amber-900 dark:border-amber-700/50 dark:bg-amber-950/20 dark:text-amber-100"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {t("settings.requestHealth.historyWarning")}
        </div>
      ) : null}

      {latest ? (
        <div className="space-y-3 rounded-md border border-border bg-background/50 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-semibold">
              {latest.thresholdExceeded || latest.anomaly ? (
                <AlertTriangle className="h-4 w-4 text-amber-500" />
              ) : (
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              )}
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
          {latest.findings.length > 0 ? (
            <div className="space-y-1 text-xs">
              {latest.findings.map((finding) => (
                <div
                  key={finding.code}
                  className="text-amber-700 dark:text-amber-300"
                >
                  <strong>{finding.code}</strong>: {finding.detail}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
          {t("settings.requestHealth.empty")}
        </div>
      )}

      {diagnostics.length > 0 ? (
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
