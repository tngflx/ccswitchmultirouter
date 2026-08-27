import { RefreshCw, Loader2, Settings2 } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useSaveSettingsMutation, useSettingsQuery } from "@/lib/query";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import type { Settings } from "@/types";

interface StreamRetryToggleProps {
  className?: string;
}

const modes = ["off", "safe", "aggressive"] as const;
type Mode = (typeof modes)[number];

export function StreamRetryToggle({ className }: StreamRetryToggleProps) {
  const { t } = useTranslation();
  const { data: settings, isLoading } = useSettingsQuery();
  const saveSettings = useSaveSettingsMutation();
  const mode: Mode = (settings?.streamRetryMode ??
    (settings?.enableStreamRetry === false ? "off" : "safe")) as Mode;
  const attempts = Math.min(
    3,
    Math.max(1, settings?.streamRetryMaxAttempts ?? 3),
  );
  const label = t("streamRetry.compactLabel", { defaultValue: "Retry" });
  const modeLabel = t(`streamRetry.mode.${mode}`, { defaultValue: mode });

  const update = (patch: Partial<Settings>) => {
    if (!settings) return;
    saveSettings.mutate({ ...settings, ...patch });
  };
  const setMode = (next: Mode) =>
    update({
      streamRetryMode: next,
      enableStreamRetry: next !== "off",
    });
  const busy = !settings || isLoading || saveSettings.isPending;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={busy}
          aria-label={`${label}: ${modeLabel}`}
          title={t(`streamRetry.help.${mode}`)}
          className={cn(
            "inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-medium hover:bg-black/5 dark:hover:bg-white/5",
            className,
          )}
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : (
            <RefreshCw
              className={cn(
                "h-4 w-4",
                mode === "off"
                  ? "text-muted-foreground"
                  : mode === "aggressive"
                    ? "text-amber-500"
                    : "text-sky-500",
              )}
            />
          )}
          <span className="hidden sm:inline">{label}</span>
          <span className="text-[11px] text-muted-foreground">{modeLabel}</span>
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
                defaultValue: "Choose how interrupted Codex turns recover.",
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
  );
}
