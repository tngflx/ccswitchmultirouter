import { useId, useRef, useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  Info,
  Loader2,
  RadioTower,
  RefreshCw,
  Settings2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { useSettingsQuery } from "@/lib/query";
import { cn } from "@/lib/utils";
import {
  clampStreamRetryMaxAttempts,
  persistStreamRetryPatch,
  resolveStreamRetryMode,
  streamRetryModePatch,
  type StreamRetrySettingsPatch,
} from "@/lib/streamRetryPolicy";

interface StreamRetryHeaderToggleProps {
  className?: string;
  onOpenActivity?: () => void;
}

const modes = ["off", "safe", "aggressive"] as const;
type Mode = (typeof modes)[number];

interface CodexUsageLimitResumeCount {
  count: number;
  complete: boolean;
}

interface CodexUsageLimitResumeResult {
  submitted: number;
  deferred: number;
  skipped: number;
  uncertain: number;
}

interface CodexUsageLimitResumeButtonProps {
  className?: string;
  visible?: boolean;
}

export function CodexUsageLimitResumeButton({
  className,
  visible = true,
}: CodexUsageLimitResumeButtonProps) {
  const { t } = useTranslation();
  const countQuery = useQuery({
    queryKey: ["codexUsageLimitResumeCount"],
    queryFn: () =>
      invoke<CodexUsageLimitResumeCount>("get_codex_usage_limit_resume_count"),
    enabled: visible,
    // Local IPC is available offline. The next poll can retry a failed read.
    networkMode: "always",
    retry: false,
    refetchInterval: 5_000,
    refetchIntervalInBackground: true,
    refetchOnMount: "always",
  });
  const submitting = useRef(false);
  const [pendingCount, setPendingCount] =
    useState<CodexUsageLimitResumeCount | null>(null);
  if (!visible) return null;

  const hasResult = !countQuery.isError && countQuery.data !== undefined;
  const availableCount = hasResult ? countQuery.data : null;
  const canResume = availableCount !== null && availableCount.count > 0;
  const displayedCount = pendingCount ?? availableCount;
  const isChecking = countQuery.isFetching && !hasResult;
  const isRefreshing = countQuery.isFetching && hasResult;
  const busy = pendingCount !== null || isChecking;

  let label: string;
  let description: string;
  let status: string;
  if (!hasResult && isChecking) {
    label = t("streamRetry.usageLimitResume.checking");
    description = t("streamRetry.usageLimitResume.description");
    status = t("streamRetry.usageLimitResume.checkingStatus");
  } else if (countQuery.isError) {
    label = t("streamRetry.usageLimitResume.unavailable");
    description = t("streamRetry.usageLimitResume.unavailableDescription");
    status = t("streamRetry.usageLimitResume.unavailableStatus");
  } else if (displayedCount && displayedCount.count > 0) {
    label = t("streamRetry.usageLimitResume.action", {
      count: displayedCount.count,
    });
    description = displayedCount.complete
      ? t("streamRetry.usageLimitResume.description")
      : t("streamRetry.usageLimitResume.partialDescription");
    status = displayedCount.complete
      ? t("streamRetry.usageLimitResume.readyStatus", {
          count: displayedCount.count,
        })
      : t("streamRetry.usageLimitResume.partialStatus", {
          count: displayedCount.count,
        });
  } else if (displayedCount?.complete) {
    label = t("streamRetry.usageLimitResume.emptyAction");
    description = t("streamRetry.usageLimitResume.emptyDescription");
    status = t("streamRetry.usageLimitResume.emptyStatus");
  } else {
    label = t("streamRetry.usageLimitResume.emptyAction");
    description = t("streamRetry.usageLimitResume.partialDescription");
    status = t("streamRetry.usageLimitResume.partialEmptyStatus");
  }

  const resume = async () => {
    if (submitting.current || !canResume) return;

    submitting.current = true;
    setPendingCount(availableCount);
    try {
      const result = await invoke<CodexUsageLimitResumeResult>(
        "resume_codex_usage_limited_turns",
      );
      toast.info(t("streamRetry.usageLimitResume.result", { ...result }));
    } catch {
      toast.error(t("streamRetry.usageLimitResume.failed"));
    } finally {
      try {
        await countQuery.refetch();
      } finally {
        submitting.current = false;
        setPendingCount(null);
      }
    }
  };

  const unavailable = busy || !canResume;
  const countValue = displayedCount?.count ?? null;
  const countLabel =
    countValue === null
      ? t("streamRetry.usageLimitResume.countChecking")
      : t("streamRetry.usageLimitResume.countLabel", { count: countValue });
  const scanState = countQuery.isError
    ? t("streamRetry.usageLimitResume.unavailableStatus")
    : isChecking
      ? t("streamRetry.usageLimitResume.checkingStatus")
      : displayedCount?.complete
        ? t("streamRetry.usageLimitResume.scanComplete")
        : t("streamRetry.usageLimitResume.scanPartial");
  const details =
    countValue === 0
      ? displayedCount?.complete
        ? t("streamRetry.usageLimitResume.zeroDetails")
        : t("streamRetry.usageLimitResume.partialZeroDetails")
      : description;
  const statusIcon = isChecking ? (
    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
  ) : countQuery.isError ? (
    <CircleAlert className="h-3.5 w-3.5 text-amber-500" aria-hidden="true" />
  ) : canResume ? (
    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" aria-hidden="true" />
  ) : (
    <CircleAlert
      className="h-3.5 w-3.5 text-muted-foreground"
      aria-hidden="true"
    />
  );

  return (
    <div
      data-testid="codex-usage-limit-resume-control"
      className={cn("flex min-w-0 items-center gap-2", className)}
      aria-busy={busy || isRefreshing}
    >
      <div
        data-testid="codex-usage-limit-resume-status"
        className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
        role="status"
        aria-live="polite"
      >
        {statusIcon}
        <span
          className="truncate"
          data-testid="codex-usage-limit-resume-status-text"
        >
          {status}
        </span>
        {isRefreshing && !busy && (
          <Loader2
            className="h-3 w-3 shrink-0 animate-spin text-muted-foreground"
            aria-label={t("streamRetry.usageLimitResume.refreshing")}
          />
        )}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <span
          data-testid="codex-usage-limit-resume-count"
          aria-label={countLabel}
          className={cn(
            "inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1.5 text-xs font-semibold tabular-nums",
            canResume
              ? "bg-primary/15 text-primary"
              : "bg-muted text-muted-foreground",
          )}
        >
          {countValue ?? "…"}
        </span>
        <span
          className="inline-flex"
          title={description}
          tabIndex={unavailable ? 0 : undefined}
          aria-label={unavailable ? description : undefined}
        >
          <Button
            type="button"
            size="sm"
            data-testid="codex-usage-limit-resume-button"
            className={cn(
              "h-7 shrink-0 gap-1 px-2 text-xs",
              canResume && "bg-primary text-primary-foreground shadow-sm",
            )}
            title={description}
            aria-busy={busy}
            disabled={unavailable}
            onClick={() => void resume()}
          >
            {busy && <Loader2 className="h-3 w-3 animate-spin" />}
            {label}
          </Button>
        </span>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              data-testid="codex-usage-limit-details-button"
              aria-label={t("streamRetry.usageLimitResume.details")}
              title={t("streamRetry.usageLimitResume.details")}
            >
              <Info className="h-3.5 w-3.5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" sideOffset={6} className="w-80 p-3">
            <div className="space-y-3">
              <div>
                <div className="text-sm font-medium">
                  {t("streamRetry.usageLimitResume.detailsTitle")}
                </div>
                <p className="mt-1 text-xs leading-4 text-muted-foreground">
                  {t("streamRetry.usageLimitResume.detailsDescription")}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2 rounded-md bg-muted/50 p-2 text-xs">
                <div>
                  <div className="text-muted-foreground">
                    {t("streamRetry.usageLimitResume.readyLabel")}
                  </div>
                  <div className="font-semibold tabular-nums">
                    {countValue ?? "—"}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground">
                    {t("streamRetry.usageLimitResume.scanLabel")}
                  </div>
                  <div className="font-medium">{scanState}</div>
                </div>
              </div>
              <p className="text-[11px] leading-4 text-muted-foreground">
                {details}
              </p>
            </div>
          </PopoverContent>
        </Popover>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          data-testid="codex-usage-limit-refresh-button"
          aria-label={t("streamRetry.usageLimitResume.refresh")}
          title={t("streamRetry.usageLimitResume.refresh")}
          disabled={countQuery.isFetching || pendingCount !== null}
          onClick={() => void countQuery.refetch()}
        >
          <RefreshCw
            className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")}
          />
        </Button>
      </div>
    </div>
  );
}

export function StreamRetryHeaderToggle({
  className,
  onOpenActivity,
}: StreamRetryHeaderToggleProps) {
  const { t } = useTranslation();
  const unlimitedReconnectsId = useId();
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useSettingsQuery();
  const mode = resolveStreamRetryMode(
    settings?.streamRetryMode,
    settings?.enableStreamRetry,
  );
  const attempts = clampStreamRetryMaxAttempts(
    settings?.streamRetryMaxAttempts,
  );
  const label = t("streamRetry.label", { defaultValue: "Stream Retry" });
  const modeLabel = t(`streamRetry.mode.${mode}`, { defaultValue: mode });
  const [isSaving, setIsSaving] = useState(false);
  const busy = !settings || isLoading || isSaving;

  const update = async (patch: StreamRetrySettingsPatch) => {
    if (!settings) return;
    setIsSaving(true);
    try {
      await persistStreamRetryPatch(queryClient, patch);
    } catch {
      toast.error(t("settings.saveFailedGeneric"));
    } finally {
      setIsSaving(false);
    }
  };
  const setMode = (next: Mode) => void update(streamRetryModePatch(next));

  return (
    <div
      data-testid="stream-retry-header-toggle"
      className={cn(
        "flex h-8 shrink-0 items-center gap-1 rounded-lg bg-muted/50 px-1.5",
        className,
      )}
      title={t(`streamRetry.help.${mode}`)}
    >
      {busy ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : (
        <RefreshCw
          className={cn(
            "h-4 w-4 transition-colors",
            mode === "off"
              ? "text-muted-foreground"
              : mode === "aggressive"
                ? "text-amber-500"
                : "text-sky-500",
          )}
        />
      )}
      <span className="whitespace-nowrap text-xs font-medium text-foreground/80">
        {label}
      </span>
      <Switch
        checked={mode !== "off"}
        onCheckedChange={(enabled) => setMode(enabled ? "safe" : "off")}
        disabled={busy}
        aria-label={label}
      />
      <span className="whitespace-nowrap text-[11px] text-muted-foreground">
        {modeLabel}
      </span>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={busy}
            aria-label={`${label}: ${modeLabel}`}
            title={t(`streamRetry.help.${mode}`)}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-black/5 dark:hover:bg-white/5"
          >
            <Settings2 className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" sideOffset={6} className="w-64 p-3">
          <div className="space-y-3">
            <div>
              <div className="text-sm font-medium">
                {t("streamRetry.title", { defaultValue: "Turn recovery" })}
              </div>
              <div className="text-xs leading-4 text-muted-foreground">
                {t("streamRetry.description", {
                  defaultValue: "Choose how interrupted streams recover.",
                })}
              </div>
            </div>
            <div
              className="grid grid-cols-3 gap-1"
              role="group"
              aria-label={label}
            >
              {modes.map((item) => (
                <button
                  key={item}
                  type="button"
                  aria-pressed={mode === item}
                  disabled={busy}
                  onClick={() => setMode(item)}
                  className={cn(
                    "rounded-md px-2 py-1.5 text-xs",
                    mode === item
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t(`streamRetry.mode.${item}`, { defaultValue: item })}
                </button>
              ))}
            </div>
            {mode === "aggressive" && (
              <div
                className="flex items-center justify-between gap-3 text-xs"
                title={t("streamRetry.unlimitedReconnectsHelp")}
              >
                <label htmlFor={unlimitedReconnectsId}>
                  {t("streamRetry.unlimitedReconnects")}
                </label>
                <Switch
                  id={unlimitedReconnectsId}
                  checked={settings?.streamRetryUnlimitedReconnects ?? false}
                  disabled={busy}
                  onCheckedChange={(enabled) =>
                    void update({ streamRetryUnlimitedReconnects: enabled })
                  }
                />
              </div>
            )}
            <label
              className={cn(
                "flex items-center justify-between gap-3 text-xs",
                mode !== "aggressive" && "opacity-50",
              )}
            >
              <span>
                {t("streamRetry.maxAttempts", {
                  defaultValue: "Desktop continuation attempts",
                })}
                : {attempts}
              </span>
              <input
                aria-label={t("streamRetry.maxAttempts", {
                  defaultValue: "Desktop continuation attempts",
                })}
                type="range"
                min={1}
                max={3}
                step={1}
                value={attempts}
                disabled={mode !== "aggressive" || busy}
                onChange={(event) =>
                  update({ streamRetryMaxAttempts: Number(event.target.value) })
                }
                className="w-24 accent-primary"
              />
            </label>
            <div className="text-[11px] leading-4 text-muted-foreground">
              {t(`streamRetry.help.${mode}`)}
            </div>
          </div>
        </PopoverContent>
      </Popover>
      {onOpenActivity ? (
        <button
          type="button"
          onClick={onOpenActivity}
          aria-label={t("streamRetry.activity.open", {
            defaultValue: "Open stream retry activity",
          })}
          title={t("streamRetry.activity.open", {
            defaultValue: "Open stream retry activity",
          })}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/5"
        >
          <RadioTower className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
}
