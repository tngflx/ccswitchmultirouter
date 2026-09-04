import { useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  Boxes,
  CheckCircle2,
  CircleGauge,
  DatabaseZap,
  HardDrive,
  RefreshCw,
  Save,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { settingsApi } from "@/lib/api/settings";
import { cn } from "@/lib/utils";
import type { RequestHealthConfig, RequestHealthSnapshot } from "@/types/proxy";

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function MetricTile({
  icon: Icon,
  label,
  value,
  tone = "cyan",
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  tone?: "cyan" | "amber" | "emerald" | "violet";
}) {
  const tones = {
    cyan: "border-cyan-200/70 bg-cyan-50/70 text-cyan-700 dark:border-cyan-700/50 dark:bg-cyan-950/20 dark:text-cyan-200",
    amber:
      "border-amber-200/70 bg-amber-50/70 text-amber-700 dark:border-amber-700/50 dark:bg-amber-950/20 dark:text-amber-200",
    emerald:
      "border-emerald-200/70 bg-emerald-50/70 text-emerald-700 dark:border-emerald-700/50 dark:bg-emerald-950/20 dark:text-emerald-200",
    violet:
      "border-violet-200/70 bg-violet-50/70 text-violet-700 dark:border-violet-700/50 dark:bg-violet-950/20 dark:text-violet-200",
  };

  return (
    <div className={cn("rounded-md border p-3", tones[tone])}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium opacity-80">{label}</span>
        <Icon className="h-4 w-4 shrink-0 opacity-80" />
      </div>
      <div className="mt-2 text-lg font-semibold tracking-tight text-foreground">
        {value}
      </div>
    </div>
  );
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
  const [thresholdKbInput, setThresholdKbInput] = useState("");
  const [reviewTimeoutInput, setReviewTimeoutInput] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!snapshot?.config) return;
    setDraft(snapshot.config);
    setThresholdKbInput(
      String(Math.round(snapshot.config.largeRequestThresholdBytes / 1024)),
    );
    setReviewTimeoutInput(String(snapshot.config.reviewTimeoutSeconds));
  }, [snapshot?.config]);

  async function save() {
    if (!draft) return;
    setIsSaving(true);
    setSaveMessage(null);
    try {
      const settings = await settingsApi.get();
      await settingsApi.save({ ...settings, requestHealth: draft });
      setSaveMessage(t("codexRouterWorkspace.requestHealth.saved"));
      onSaved();
    } catch (error) {
      setSaveMessage(errorMessage(error));
    } finally {
      setIsSaving(false);
    }
  }

  const latest = snapshot?.diagnostics[0];
  const thresholdRatio = latest
    ? Math.min(1, latest.optimizedBytes / Math.max(1, latest.thresholdBytes))
    : 0;
  const maxBreakdownBytes = latest
    ? Math.max(...latest.breakdown.map((row) => row.bytes), 1)
    : 1;
  const isHealthy = latest
    ? !latest.thresholdExceeded && !latest.anomaly
    : true;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-cyan-200/70 bg-gradient-to-r from-cyan-50/80 via-background to-violet-50/70 p-4 dark:border-cyan-800/50 dark:from-cyan-950/30 dark:via-background dark:to-violet-950/20">
        <div className="flex min-w-0 items-start gap-3">
          <div className="rounded-md bg-cyan-500/15 p-2 text-cyan-600 dark:text-cyan-300">
            <ShieldCheck className="h-6 w-6" />
          </div>
          <div className="space-y-1">
            <h4 className="flex items-center gap-2 text-sm font-semibold">
              {t("codexRouterWorkspace.requestHealth.title")}
            </h4>
            <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">
              {t("codexRouterWorkspace.requestHealth.description")}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={onRefresh}
            disabled={isRefreshing}
          >
            <RefreshCw
              className={cn("mr-2 h-4 w-4", isRefreshing && "animate-spin")}
            />
            {t("codexRouterWorkspace.requestHealth.refresh")}
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={isSaving}>
            <Save className="mr-2 h-4 w-4" />
            {t("codexRouterWorkspace.requestHealth.save")}
          </Button>
        </div>
      </div>

      {draft ? (
        <div className="rounded-md border border-border bg-background/50 p-3">
          <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <CircleGauge className="h-4 w-4 text-cyan-500" />
            <span>{t("codexRouterWorkspace.requestHealth.mode")}</span>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="rounded-md border border-border bg-background/70 p-3 text-sm transition-colors hover:border-cyan-300 dark:hover:border-cyan-700">
              <span className="mb-2 flex items-center gap-2 font-medium">
                <Activity className="h-4 w-4 text-cyan-500" />
                {t("codexRouterWorkspace.requestHealth.enabled")}
              </span>
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) =>
                  setDraft({ ...draft, enabled: event.target.checked })
                }
                className="h-4 w-4"
              />
            </label>
            <label className="rounded-md border border-border bg-background/70 p-3 text-sm transition-colors hover:border-cyan-300 dark:hover:border-cyan-700">
              <span className="mb-2 block font-medium">
                {t("codexRouterWorkspace.requestHealth.mode")}
              </span>
              <select
                value={draft.optimizationMode}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    optimizationMode: event.target
                      .value as RequestHealthConfig["optimizationMode"],
                  })
                }
                className="w-full rounded-md border border-input bg-background px-2 py-1.5"
              >
                <option value="off">
                  {t("codexRouterWorkspace.requestHealth.modeOff")}
                </option>
                <option value="diagnose">
                  {t("codexRouterWorkspace.requestHealth.modeDiagnose")}
                </option>
                <option value="safe">
                  {t("codexRouterWorkspace.requestHealth.modeSafe")}
                </option>
              </select>
            </label>
            <label className="rounded-md border border-border bg-background/70 p-3 text-sm transition-colors hover:border-cyan-300 dark:hover:border-cyan-700">
              <span className="mb-2 block font-medium">
                {t("codexRouterWorkspace.requestHealth.threshold")}
              </span>
              <input
                type="number"
                min={64}
                max={16384}
                value={thresholdKbInput}
                onChange={(event) => {
                  const value = event.target.value;
                  setThresholdKbInput(value);
                  const parsed = Number(value);
                  if (Number.isFinite(parsed) && parsed > 0) {
                    setDraft({
                      ...draft,
                      largeRequestThresholdBytes:
                        Math.min(16384, Math.max(64, parsed)) * 1024,
                    });
                  }
                }}
                onBlur={() =>
                  setThresholdKbInput(
                    String(Math.round(draft.largeRequestThresholdBytes / 1024)),
                  )
                }
                className="w-full rounded-md border border-input bg-background px-2 py-1.5"
              />
            </label>
            <label className="rounded-md border border-border bg-background/70 p-3 text-sm transition-colors hover:border-cyan-300 dark:hover:border-cyan-700">
              <span className="mb-2 block font-medium">
                {t("codexRouterWorkspace.requestHealth.reviewMode")}
              </span>
              <select
                value={draft.reviewMode}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    reviewMode: event.target
                      .value as RequestHealthConfig["reviewMode"],
                  })
                }
                className="w-full rounded-md border border-input bg-background px-2 py-1.5"
              >
                <option value="off">
                  {t("codexRouterWorkspace.requestHealth.reviewModeOff")}
                </option>
                <option value="first_large_request">
                  {t("codexRouterWorkspace.requestHealth.reviewModeFirst")}
                </option>
                <option value="sustained_growth">
                  {t("codexRouterWorkspace.requestHealth.reviewModeSustained")}
                </option>
              </select>
            </label>
            <label className="rounded-md border border-border bg-background/70 p-3 text-sm transition-colors hover:border-cyan-300 dark:hover:border-cyan-700">
              <span className="mb-2 block font-medium">
                {t(
                  "codexRouterWorkspace.requestHealth.summarizeAndRestartEnabled",
                )}
              </span>
              <input
                type="checkbox"
                checked={draft.summarizeAndRestartEnabled}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    summarizeAndRestartEnabled: event.target.checked,
                  })
                }
                className="h-4 w-4"
              />
            </label>
            <label className="rounded-md border border-border bg-background/70 p-3 text-sm">
              <span className="mb-2 block font-medium">
                {t("codexRouterWorkspace.requestHealth.reviewTimeout")}
              </span>
              <input
                type="number"
                min={15}
                max={300}
                value={reviewTimeoutInput}
                onChange={(event) => {
                  const value = event.target.value;
                  setReviewTimeoutInput(value);
                  const parsed = Number(value);
                  if (Number.isFinite(parsed) && parsed > 0) {
                    setDraft({
                      ...draft,
                      reviewTimeoutSeconds: Math.min(
                        300,
                        Math.max(15, Math.round(parsed)),
                      ),
                    });
                  }
                }}
                onBlur={() =>
                  setReviewTimeoutInput(String(draft.reviewTimeoutSeconds))
                }
                className="w-full rounded-md border border-input bg-background px-2 py-1.5"
              />
            </label>
          </div>
        </div>
      ) : null}

      {saveMessage ? (
        <div className="text-xs text-muted-foreground">{saveMessage}</div>
      ) : null}

      {latest?.thresholdExceeded && latest.bytesRemoved === 0 && draft ? (
        <div
          role="status"
          className="flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50 px-3 py-3 text-sm text-amber-900 dark:border-amber-700/50 dark:bg-amber-950/20 dark:text-amber-100"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {t("codexRouterWorkspace.requestHealth.detectedOnlyWarning")}
        </div>
      ) : null}

      {latest ? (
        <div className="space-y-4 border-t border-border/50 pt-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-3">
              <div
                className={cn(
                  "rounded-md p-2",
                  isHealthy
                    ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300"
                    : "bg-amber-500/15 text-amber-600 dark:text-amber-300",
                )}
              >
                {isHealthy ? (
                  <CheckCircle2 className="h-5 w-5" />
                ) : (
                  <AlertTriangle className="h-5 w-5" />
                )}
              </div>
              <div>
                <h4 className="truncate text-sm font-semibold">
                  {latest.providerName} · {latest.model}
                </h4>
                <p className="mt-1 text-xs text-muted-foreground">
                  {latest.generatedAt} · {latest.appType} · {latest.endpoint}
                </p>
              </div>
            </div>
            <Badge
              className={cn(
                "border",
                latest.thresholdExceeded
                  ? "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-100"
                  : "border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-100",
              )}
            >
              {(latest.optimizedBytes / 1024).toFixed(1)} KB
            </Badge>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MetricTile
              icon={Boxes}
              label={t("codexRouterWorkspace.requestHealth.items")}
              value={String(latest.itemCount)}
            />
            <MetricTile
              icon={ArrowDown}
              label={t("codexRouterWorkspace.requestHealth.removed")}
              value={`${latest.bytesRemoved.toLocaleString()} B`}
              tone="emerald"
            />
            <MetricTile
              icon={HardDrive}
              label={t("codexRouterWorkspace.requestHealth.largestItem")}
              value={`${(latest.largestItemBytes / 1024).toFixed(1)} KB`}
              tone="violet"
            />
            <MetricTile
              icon={Sparkles}
              label={t("codexRouterWorkspace.requestHealth.compaction")}
              value={
                latest.compactionRecommended
                  ? t("codexRouterWorkspace.requestHealth.recommended")
                  : latest.compactionRequest
                    ? t("codexRouterWorkspace.requestHealth.detected")
                    : t("codexRouterWorkspace.requestHealth.notNeeded")
              }
              tone={latest.compactionRecommended ? "amber" : "cyan"}
            />
          </div>
          <div className="rounded-md border border-border bg-background/60 p-3">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="flex items-center gap-2 font-medium">
                <DatabaseZap className="h-4 w-4 text-cyan-500" />
                {t("codexRouterWorkspace.requestHealth.threshold")}
              </span>
              <span className="font-mono text-muted-foreground">
                {(latest.optimizedBytes / 1024).toFixed(1)} KB /{" "}
                {(latest.thresholdBytes / 1024).toFixed(1)} KB
              </span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "h-full rounded-full transition-all",
                  thresholdRatio >= 1 ? "bg-amber-500" : "bg-cyan-500",
                )}
                style={{ width: `${Math.max(3, thresholdRatio * 100)}%` }}
              />
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-4"></div>
          {latest.anomaly ? (
            <div className="rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700/50 dark:bg-amber-950/20 dark:text-amber-100">
              <span className="font-semibold">
                {t("codexRouterWorkspace.requestHealth.cacheAnomaly")}
              </span>
              : {latest.anomaly.detail}
            </div>
          ) : null}
          {latest.findings.map((finding) => (
            <div
              key={finding.code}
              className="flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700/50 dark:bg-amber-950/20 dark:text-amber-100"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="font-semibold">{finding.code}</span>:{" "}
              {finding.detail}
            </div>
          ))}
          <div className="overflow-hidden rounded-md border border-border bg-background/50">
            {latest.breakdown.slice(0, 12).map((row) => (
              <div
                key={row.category}
                className="border-t border-border px-3 py-2.5 first:border-t-0"
              >
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className="font-mono">{row.category}</span>
                  <span className="text-right text-muted-foreground">
                    {(row.bytes / 1024).toFixed(1)} KB ·{" "}
                    {t("codexRouterWorkspace.requestHealth.itemCount", {
                      count: row.itemCount,
                    })}
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-violet-500/80"
                    style={{
                      width: `${Math.max(3, (row.bytes / maxBreakdownBytes) * 100)}%`,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
          {t("codexRouterWorkspace.requestHealth.empty")}
        </div>
      )}
    </div>
  );
}
