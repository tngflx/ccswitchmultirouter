import { useState } from "react";
import { CircleOff, ShieldCheck, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Settings } from "@/types";

type StreamRetryMode = NonNullable<Settings["streamRetryMode"]>;

export type StreamRetrySettingsUpdate = Partial<
  Pick<
    Settings,
    "enableStreamRetry" | "streamRetryMode" | "streamRetryMaxAttempts"
  >
>;

interface StreamRetryToggleProps {
  mode?: Settings["streamRetryMode"];
  enableStreamRetry?: boolean;
  maxAttempts?: number;
  disabled?: boolean;
  onChange: (
    updates: StreamRetrySettingsUpdate,
  ) => Promise<boolean | void> | boolean | void;
}

const MODES: Array<{
  value: StreamRetryMode;
  labelKey: string;
  descriptionKey: string;
  icon: typeof CircleOff;
}> = [
  {
    value: "off",
    labelKey: "settings.advanced.proxy.streamRetryOff",
    descriptionKey: "settings.advanced.proxy.streamRetryOffDescription",
    icon: CircleOff,
  },
  {
    value: "safe",
    labelKey: "settings.advanced.proxy.streamRetrySafe",
    descriptionKey: "settings.advanced.proxy.streamRetrySafeDescription",
    icon: ShieldCheck,
  },
  {
    value: "aggressive",
    labelKey: "settings.advanced.proxy.streamRetryAggressive",
    descriptionKey: "settings.advanced.proxy.streamRetryAggressiveDescription",
    icon: Zap,
  },
];

const resolveMode = (
  mode: Settings["streamRetryMode"],
  legacyEnabled: boolean | undefined,
): StreamRetryMode => {
  if (legacyEnabled === false && (mode === undefined || mode === "safe")) {
    return "off";
  }
  return mode ?? "safe";
};

const clampAttempts = (value: number | undefined): number =>
  Math.min(3, Math.max(1, value ?? 3));

export function StreamRetryToggle({
  mode,
  enableStreamRetry,
  maxAttempts,
  disabled = false,
  onChange,
}: StreamRetryToggleProps) {
  const { t } = useTranslation();
  const [isSaving, setIsSaving] = useState(false);
  const resolvedMode = resolveMode(mode, enableStreamRetry);
  const attempts = clampAttempts(maxAttempts);
  const selectedMode = MODES.find((option) => option.value === resolvedMode)!;
  const controlsDisabled = disabled || isSaving;

  const persist = async (updates: StreamRetrySettingsUpdate) => {
    setIsSaving(true);
    try {
      await onChange(updates);
    } finally {
      setIsSaving(false);
    }
  };

  const handleModeChange = (nextMode: StreamRetryMode) => {
    if (nextMode === resolvedMode || controlsDisabled) return;
    void persist({
      streamRetryMode: nextMode,
      enableStreamRetry: nextMode !== "off",
    });
  };

  const handleAttemptsChange = (value: number) => {
    const nextAttempts = clampAttempts(value);
    if (nextAttempts === attempts || controlsDisabled) return;
    void persist({ streamRetryMaxAttempts: nextAttempts });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-sky-500" />
        <div className="min-w-0">
          <h4 className="text-sm font-medium">
            {t("settings.advanced.proxy.streamRetryMode")}
          </h4>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {t("settings.advanced.proxy.streamRetryDescription")}
          </p>
        </div>
      </div>

      <div
        role="radiogroup"
        aria-label={t("settings.advanced.proxy.streamRetryMode")}
        className="grid grid-cols-3 gap-1 rounded-lg border border-border bg-muted/30 p-1"
      >
        {MODES.map((option) => {
          const Icon = option.icon;
          const selected = option.value === resolvedMode;
          return (
            <Button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              variant="ghost"
              size="sm"
              disabled={controlsDisabled}
              onClick={() => handleModeChange(option.value)}
              className={cn(
                "h-9 min-w-0 px-2",
                selected &&
                  "bg-background text-foreground shadow-sm hover:bg-background",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="truncate">{t(option.labelKey)}</span>
            </Button>
          );
        })}
      </div>

      <p className="text-xs leading-5 text-muted-foreground">
        {t(selectedMode.descriptionKey)}
      </p>

      {resolvedMode === "aggressive" && (
        <div className="space-y-2 border-t border-border/50 pt-3">
          <div className="flex items-center justify-between gap-4">
            <label
              htmlFor="stream-retry-max-attempts"
              className="text-sm font-medium"
            >
              {t("settings.advanced.proxy.streamRetryMaxAttempts")}
            </label>
            <span
              className="min-w-6 text-right text-sm font-semibold tabular-nums"
              aria-hidden="true"
            >
              {attempts}
            </span>
          </div>
          <input
            id="stream-retry-max-attempts"
            type="range"
            min={1}
            max={3}
            step={1}
            value={attempts}
            disabled={controlsDisabled}
            onChange={(event) =>
              handleAttemptsChange(Number(event.currentTarget.value))
            }
            className="h-2 w-full cursor-pointer accent-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          />
          <p className="text-xs leading-5 text-muted-foreground">
            {t("settings.advanced.proxy.streamRetryMaxAttemptsDescription")}
          </p>
        </div>
      )}
    </div>
  );
}
