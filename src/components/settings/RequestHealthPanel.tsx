import { useEffect, useState } from "react";
import { Activity, RefreshCw, Save } from "lucide-react";
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

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-background/70 px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 break-words text-sm font-medium">{value}</div>
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
  const [maxInputTokensInput, setMaxInputTokensInput] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!snapshot?.config) return;
    setDraft(snapshot.config);
    setThresholdKbInput(
      String(Math.round(snapshot.config.largeRequestThresholdBytes / 1024)),
    );
    setMaxInputTokensInput(String(snapshot.config.maxCodexInputTokens));
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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h4 className="flex items-center gap-2 text-sm font-semibold">
            <Activity className="h-4 w-4 text-cyan-500" />
            {t("codexRouterWorkspace.requestHealth.title")}
          </h4>
          <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">
            {t("codexRouterWorkspace.requestHealth.description")}
          </p>
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
        <div className="grid gap-3 md:grid-cols-2">
          <label className="rounded-md border border-border bg-background/70 p-3 text-sm">
            <span className="mb-2 block font-medium">
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
          <label className="rounded-md border border-border bg-background/70 p-3 text-sm">
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
          <label className="rounded-md border border-border bg-background/70 p-3 text-sm">
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
          <label className="rounded-md border border-border bg-background/70 p-3 text-sm">
            <span className="mb-2 block font-medium">
              {t("codexRouterWorkspace.requestHealth.maxInputTokens")}
            </span>
            <input
              type="number"
              min={10000}
              max={1000000}
              step={10000}
              value={maxInputTokensInput}
              onChange={(event) => {
                const value = event.target.value;
                setMaxInputTokensInput(value);
                const parsed = Number(value);
                if (Number.isFinite(parsed) && parsed > 0) {
                  setDraft({
                    ...draft,
                    maxCodexInputTokens: Math.min(
                      1_000_000,
                      Math.max(10_000, Math.round(parsed)),
                    ),
                  });
                }
              }}
              onBlur={() =>
                setMaxInputTokensInput(String(draft.maxCodexInputTokens))
              }
              className="w-full rounded-md border border-input bg-background px-2 py-1.5"
            />
          </label>
        </div>
      ) : null}

      {saveMessage ? (
        <div className="text-xs text-muted-foreground">{saveMessage}</div>
      ) : null}

      {latest?.thresholdExceeded && latest.bytesRemoved === 0 && draft ? (
        <div
          role="status"
          className="rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700/50 dark:bg-amber-950/20 dark:text-amber-100"
        >
          {t("codexRouterWorkspace.requestHealth.detectedOnlyWarning")}
        </div>
      ) : null}

      {latest ? (
        <div className="space-y-3 border-t border-border/50 pt-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h4 className="text-sm font-semibold">
                {latest.providerName} · {latest.model}
              </h4>
              <p className="mt-1 text-xs text-muted-foreground">
                {latest.generatedAt} · {latest.appType} · {latest.endpoint}
              </p>
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
          <div className="grid gap-3 md:grid-cols-4">
            <DetailRow
              label={t("codexRouterWorkspace.requestHealth.items")}
              value={String(latest.itemCount)}
            />
            <DetailRow
              label={t("codexRouterWorkspace.requestHealth.removed")}
              value={`${latest.bytesRemoved.toLocaleString()} B`}
            />
            <DetailRow
              label={t("codexRouterWorkspace.requestHealth.largestItem")}
              value={`${(latest.largestItemBytes / 1024).toFixed(1)} KB · ${
                latest.largestItemCategory ??
                t("codexRouterWorkspace.requestHealth.unknown")
              }`}
            />
            <DetailRow
              label={t("codexRouterWorkspace.requestHealth.compaction")}
              value={
                latest.compactionRecommended
                  ? t("codexRouterWorkspace.requestHealth.recommended")
                  : latest.compactionRequest
                    ? t("codexRouterWorkspace.requestHealth.detected")
                    : t("codexRouterWorkspace.requestHealth.notNeeded")
              }
            />
            <DetailRow
              label={t(
                "codexRouterWorkspace.requestHealth.estimatedInputTokens",
              )}
              value={`${latest.estimatedInputTokens.toLocaleString()} / ${latest.maxInputTokens.toLocaleString()}`}
            />
          </div>
          {latest.findings.map((finding) => (
            <div
              key={finding.code}
              className="rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700/50 dark:bg-amber-950/20 dark:text-amber-100"
            >
              <span className="font-semibold">{finding.code}</span>:{" "}
              {finding.detail}
            </div>
          ))}
          <div className="overflow-hidden rounded-md border border-border">
            {latest.breakdown.slice(0, 12).map((row) => (
              <div
                key={row.category}
                className="grid grid-cols-[1fr_auto_auto] gap-3 border-t border-border px-3 py-2 text-xs first:border-t-0"
              >
                <span className="font-mono">{row.category}</span>
                <span>
                  {t("codexRouterWorkspace.requestHealth.itemCount", {
                    count: row.itemCount,
                  })}
                </span>
                <span className="text-right">
                  {(row.bytes / 1024).toFixed(1)} KB
                </span>
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
