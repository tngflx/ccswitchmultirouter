import { Loader2, RadioTower, RefreshCw, Settings2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { useSaveSettingsMutation, useSettingsQuery } from "@/lib/query";
import { cn } from "@/lib/utils";
import type { Settings } from "@/types";

interface StreamRetryHeaderToggleProps {
  className?: string;
  onOpenActivity?: () => void;
}

const modes = ["off", "safe", "aggressive"] as const;
type Mode = (typeof modes)[number];

const resolveMode = (
  mode: Settings["streamRetryMode"],
  legacyEnabled: boolean | undefined,
): Mode => {
  if (legacyEnabled === false && (mode === undefined || mode === "safe")) {
    return "off";
  }
  return mode ?? "safe";
};

export function StreamRetryHeaderToggle({
  className,
  onOpenActivity,
}: StreamRetryHeaderToggleProps) {
  const { t } = useTranslation();
  const { data: settings, isLoading } = useSettingsQuery();
  const saveSettings = useSaveSettingsMutation();
  const mode = resolveMode(
    settings?.streamRetryMode,
    settings?.enableStreamRetry,
  );
  const attempts = Math.min(
    3,
    Math.max(1, settings?.streamRetryMaxAttempts ?? 3),
  );
  const label = t("streamRetry.label", { defaultValue: "Stream Retry" });
  const modeLabel = t(`streamRetry.mode.${mode}`, { defaultValue: mode });
  const busy = !settings || isLoading || saveSettings.isPending;

  const update = (patch: Partial<Settings>) => {
    if (!settings) return;
    saveSettings.mutate({ ...settings, ...patch });
  };
  const setMode = (next: Mode) =>
    update({
      streamRetryMode: next,
      enableStreamRetry: next !== "off",
    });

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
            <label
              className={cn(
                "flex items-center justify-between gap-3 text-xs",
                mode !== "aggressive" && "opacity-50",
              )}
            >
              <span>
                {t("streamRetry.maxAttempts", {
                  defaultValue: "Continue attempts",
                })}
                : {attempts}
              </span>
              <input
                aria-label={t("streamRetry.maxAttempts", {
                  defaultValue: "Continue attempts",
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
