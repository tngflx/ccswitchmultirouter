import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useSettingsQuery } from "@/lib/query";
import { proxyApi } from "@/lib/api/proxy";
import {
  persistStreamRetryPatch,
  resolveStreamRetryMode,
  streamRetryModePatch,
} from "@/lib/streamRetryPolicy";
import { Button } from "@/components/ui/button";
import { RadioTower, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useStreamRetryActivity } from "@/hooks/useStreamRetryActivity";
import type { StreamRetryActivity } from "@/types/proxy";
import { cn } from "@/lib/utils";

function eventTone(event: StreamRetryActivity["event"]): string {
  if (event === "reconnected" || event === "continuation_submitted") {
    return "text-emerald-700 dark:text-emerald-300";
  }
  if (
    event === "retries_exhausted" ||
    event === "reconnect_failed" ||
    event === "continuation_submit_failed" ||
    event === "continuation_outcome_unknown"
  ) {
    return "text-rose-700 dark:text-rose-300";
  }
  return "text-amber-700 dark:text-amber-300";
}

function stageLabel(stage: string, t: (key: string) => string): string {
  switch (stage) {
    case "desktop_continuation":
      return t("streamRetry.activity.stages.desktop_continuation");
    case "native_responses":
      return "Responses";
    case "anthropic_messages":
      return "Anthropic Messages";
    case "chat_completions":
      return "Chat Completions";
    default:
      return stage;
  }
}

export function StreamRetryActivityPanel() {
  const { t } = useTranslation();
  const activities = useStreamRetryActivity();
  const { data: settings } = useSettingsQuery();
  const queryClient = useQueryClient();
  const mode = resolveStreamRetryMode(
    settings?.streamRetryMode,
    settings?.enableStreamRetry,
  );
  const [saving, setSaving] = useState(false);
  const { data: guardian, isError: guardianError } = useQuery({
    queryKey: ["codexGuardianStatus"],
    queryFn: () => proxyApi.getCodexGuardianStatus(),
    enabled: mode === "aggressive",
    refetchInterval: 10_000,
  });
  const continuationNotice =
    mode !== "aggressive"
      ? "disabled"
      : guardianError || !guardian
        ? "readinessUnknown"
        : !guardian.active ||
            !guardian.codexRunning ||
            !guardian.cdpAvailable ||
            !guardian.injected
          ? "bridgeUnavailable"
          : "prerequisitesDetected";
  const continuationHelp =
    guardianError || !guardian
      ? "checkHelp"
      : guardian.cdpAvailable
        ? "repairHelp"
        : "launchHelp";
  const enableContinuation = async () => {
    setSaving(true);
    try {
      await persistStreamRetryPatch(
        queryClient,
        streamRetryModePatch("aggressive"),
      );
    } catch {
      toast.error(t("settings.saveFailedGeneric"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      data-testid="stream-retry-activity-panel"
      className="rounded-lg border border-amber-200 bg-amber-50/60 p-4 dark:border-amber-700/40 dark:bg-amber-950/10"
    >
      <div className="flex min-w-0 items-start gap-3">
        <RadioTower className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-300" />
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">
            {t("streamRetry.activity.title", {
              defaultValue: "Live stream retry activity",
            })}
          </h2>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
            {t("streamRetry.activity.description", {
              defaultValue:
                "Sanitized retry transitions from the running proxy. The feed keeps the latest 50 events in memory.",
            })}
          </p>
        </div>
      </div>

      <div
        role={
          continuationNotice === "prerequisitesDetected" ? "status" : "alert"
        }
        className="mt-4 space-y-2 rounded-md border border-amber-500/40 bg-background/70 p-3 text-sm"
      >
        <p>{t(`streamRetry.continuation.${continuationNotice}`)}</p>
        <p className="text-xs text-muted-foreground">
          {t("streamRetry.continuation.schedule")}
        </p>
        {mode === "aggressive" &&
          continuationNotice !== "prerequisitesDetected" && (
            <p className="text-xs">
              {t(`streamRetry.continuation.${continuationHelp}`)}
            </p>
          )}
        {mode !== "aggressive" && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={saving || !settings}
            onClick={() => void enableContinuation()}
          >
            {t("streamRetry.continuation.enable")}
          </Button>
        )}
      </div>

      {activities.length === 0 ? (
        <div className="mt-4 rounded-md border border-dashed border-amber-300/80 bg-background/60 p-4 text-sm text-muted-foreground dark:border-amber-700/50 dark:bg-slate-950/30">
          {t("streamRetry.activity.empty", {
            defaultValue:
              "No stream retry activity yet. This feed updates when an eligible stream is interrupted.",
          })}
        </div>
      ) : (
        <div className="mt-4 overflow-hidden rounded-md border border-border bg-background/70 dark:border-slate-700 dark:bg-slate-950/40">
          <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_auto] gap-2 border-b border-border px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground dark:border-slate-700">
            <span>{t("streamRetry.activity.eventColumn", "Event")}</span>
            <span>{t("streamRetry.activity.routeColumn", "Route")}</span>
            <span>{t("streamRetry.activity.attemptColumn", "Attempt")}</span>
          </div>
          <div className="divide-y divide-border dark:divide-slate-700">
            {activities.map((activity, index) => {
              const eventLabel = t(
                `streamRetry.activity.events.${activity.event}`,
                {
                  defaultValue: activity.event.replace(/_/g, " "),
                },
              );
              const routeLabel = [stageLabel(activity.stage, t), activity.model]
                .filter(Boolean)
                .join(" · ");
              const attemptLabel =
                activity.maxAttempts == null
                  ? `${activity.attempt} / ∞`
                  : `${activity.attempt} / ${activity.maxAttempts}`;
              const timestamp = new Date(activity.timestamp);
              const timeLabel = Number.isNaN(timestamp.getTime())
                ? activity.timestamp
                : timestamp.toLocaleTimeString();

              return (
                <div
                  key={`${activity.timestamp}-${activity.event}-${index}`}
                  className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_auto] items-center gap-2 px-3 py-2.5 text-xs"
                >
                  <div className="min-w-0">
                    <div
                      className={cn(
                        "font-medium capitalize",
                        eventTone(activity.event),
                      )}
                    >
                      {eventLabel}
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                      {timeLabel}
                      {activity.retryAfterSeconds != null &&
                        ` · ${t("streamRetry.continuation.waitSeconds", { seconds: activity.retryAfterSeconds })}`}
                      {activity.reasonClass
                        ? ` · ${activity.reasonClass.replace(/_/g, " ")}`
                        : ""}
                    </div>
                  </div>
                  <div className="min-w-0 truncate text-muted-foreground">
                    {routeLabel ||
                      t("common.unknown", { defaultValue: "Unknown" })}
                  </div>
                  <div className="inline-flex items-center gap-1 whitespace-nowrap font-mono text-[11px] text-foreground">
                    {activity.event === "retry_scheduled" ? (
                      <RefreshCw className="h-3.5 w-3.5 text-amber-500" />
                    ) : null}
                    {attemptLabel}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
