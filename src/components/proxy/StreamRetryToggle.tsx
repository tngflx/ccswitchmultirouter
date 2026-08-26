import { RefreshCw, Loader2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { useSaveSettingsMutation, useSettingsQuery } from "@/lib/query";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

interface StreamRetryToggleProps {
  className?: string;
}

export function StreamRetryToggle({ className }: StreamRetryToggleProps) {
  const { t } = useTranslation();
  const { data: settings, isLoading } = useSettingsQuery();
  const saveSettings = useSaveSettingsMutation();
  const enabled = settings?.enableStreamRetry ?? true;

  const label = t("streamRetry.label", {
    defaultValue: "Stream Retry",
  });
  const tooltipText = enabled
    ? t("streamRetry.tooltip.enabled", {
        defaultValue:
          "Stream retry is enabled. Eligible upstream SSE drops are retried up to 5 times before a terminal error is returned.",
      })
    : t("streamRetry.tooltip.disabled", {
        defaultValue:
          "Stream retry is disabled. A dropped stream is reported immediately.",
      });

  const handleToggle = (checked: boolean) => {
    if (!settings) return;
    saveSettings.mutate({
      ...settings,
      enableStreamRetry: checked,
    });
  };

  return (
    <div
      className={cn(
        "flex items-center gap-1 px-1.5 h-8 rounded-lg bg-muted/50 transition-all",
        className,
      )}
      title={tooltipText}
    >
      {saveSettings.isPending || isLoading ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : (
        <RefreshCw
          className={cn(
            "h-4 w-4 transition-colors",
            enabled ? "text-sky-500" : "text-muted-foreground",
          )}
        />
      )}
      <span className="whitespace-nowrap text-xs font-medium text-foreground/80">
        {label}
      </span>
      <Switch
        checked={enabled}
        onCheckedChange={handleToggle}
        disabled={!settings || saveSettings.isPending || isLoading}
        aria-label={label}
      />
    </div>
  );
}
