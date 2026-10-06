import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Clock3, Loader2, Network, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  codexEgressTimezoneApi,
  type CodexEgressTimezoneDetection,
  type CodexRuntimeTimezoneInspection,
} from "@/lib/api/codexEgressTimezone";
import type { CodexEgressTimezoneSettings as CodexEgressTimezoneValue } from "@/types";

interface CodexEgressTimezoneSettingsProps {
  value?: CodexEgressTimezoneValue;
  onChange: (
    value: CodexEgressTimezoneValue,
  ) => boolean | void | Promise<boolean | void>;
}

function comparisonLabel(t: TFunction, report: CodexEgressTimezoneDetection) {
  if (report.timezoneMatch === "exact") {
    return t("codexEgressTimezone.comparison.exact");
  }
  if (report.timezoneMatch === "offset_match") {
    return t("codexEgressTimezone.comparison.offsetMatch");
  }
  if (report.timezoneMatch === "mismatch") {
    return t("codexEgressTimezone.comparison.mismatch");
  }
  return t("codexEgressTimezone.comparison.unknown");
}

function locationLabel(report: CodexEgressTimezoneDetection) {
  return [report.countryCode, report.region, report.city, report.colo]
    .filter(Boolean)
    .join(" · ");
}

function looksLikeIanaTimezone(value: string) {
  return /^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+)+$/.test(value.trim());
}

export function CodexEgressTimezoneSettings({
  value = { mode: "off" },
  onChange,
}: CodexEgressTimezoneSettingsProps) {
  const { t } = useTranslation();
  const [report, setReport] = useState<CodexEgressTimezoneDetection | null>(
    null,
  );
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState("");
  const [runtime, setRuntime] = useState<CodexRuntimeTimezoneInspection | null>(
    null,
  );
  const [inspectingRuntime, setInspectingRuntime] = useState(false);
  const [manualVisible, setManualVisible] = useState(value.mode === "manual");
  const [manualTimezone, setManualTimezone] = useState(
    value.manualTimezone ?? "",
  );

  const detect = async () => {
    setDetecting(true);
    setError("");
    setReport(null);
    try {
      setReport(await codexEgressTimezoneApi.detect());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setDetecting(false);
    }
  };

  const applyDetection = async () => {
    if (!report) return;
    await onChange({
      ...value,
      mode: "auto",
      detectedTimezone: report.egressTimezone,
      detectedAt: report.checkedAt,
      detectedEgressIp: report.egressIp,
      detectedCountryCode: report.countryCode,
      detectedRegion: report.region,
      detectedCity: report.city,
      detectedColo: report.colo,
      monitorIntervalMinutes: value.monitorIntervalMinutes ?? 15,
    });
  };

  const enableAutomatic = async () => {
    setError("");
    try {
      const saved = await onChange({
        ...value,
        mode: "auto",
        monitorIntervalMinutes: value.monitorIntervalMinutes ?? 15,
      });
      if (saved !== false) {
        const status = await codexEgressTimezoneApi.triggerAutomaticProbe();
        if (status.state === "error") {
          setError(
            status.lastError ||
              t("codexEgressTimezone.errors.detectionFallback"),
          );
        }
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const inspectRuntime = async () => {
    setInspectingRuntime(true);
    setError("");
    try {
      setRuntime(await codexEgressTimezoneApi.inspectRuntime());
    } catch (caught) {
      setRuntime(null);
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setInspectingRuntime(false);
    }
  };

  const saveManual = async () => {
    const timezone = manualTimezone.trim();
    if (!looksLikeIanaTimezone(timezone)) {
      setError(t("codexEgressTimezone.errors.invalidManual"));
      return;
    }
    setError("");
    try {
      await codexEgressTimezoneApi.validate(timezone);
      await onChange({ ...value, mode: "manual", manualTimezone: timezone });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const activeTimezone =
    value.mode === "auto"
      ? value.detectedTimezone
      : value.mode === "manual"
        ? value.manualTimezone
        : undefined;

  return (
    <section className="space-y-4 rounded-xl border border-border/60 bg-muted/10 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Clock3 className="h-4 w-4 text-sky-500" />
            <h3 className="text-sm font-medium">
              {t("codexEgressTimezone.settings.title")}
            </h3>
          </div>
          <p className="max-w-3xl text-xs text-muted-foreground">
            {t("codexEgressTimezone.settings.description")}
          </p>
        </div>
        <span className="rounded-full border px-2 py-1 text-xs text-muted-foreground">
          {value.mode === "off"
            ? t("codexEgressTimezone.settings.modeDisabled")
            : `${value.mode === "auto" ? t("codexEgressTimezone.settings.modeAuto") : t("codexEgressTimezone.settings.modeManual")} · ${activeTimezone ?? t("codexEgressTimezone.values.notConfigured")}`}
        </span>
      </div>

      <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">
        <div className="flex gap-2">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{t("codexEgressTimezone.settings.disclaimer")}</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {value.mode === "off" && (
          <Button type="button" onClick={() => void enableAutomatic()}>
            {t("codexEgressTimezone.controls.enableAutomatic")}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          onClick={detect}
          disabled={detecting}
        >
          {detecting ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Network className="mr-2 h-4 w-4" />
          )}
          {detecting
            ? t("codexEgressTimezone.controls.detecting")
            : t("codexEgressTimezone.controls.detect")}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => setManualVisible((shown) => !shown)}
        >
          {t("codexEgressTimezone.controls.manualSettings")}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={inspectRuntime}
          disabled={inspectingRuntime}
        >
          {inspectingRuntime && (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          )}
          {inspectingRuntime
            ? t("codexEgressTimezone.controls.checkingRuntime")
            : t("codexEgressTimezone.controls.inspectRuntime")}
        </Button>
        {value.mode !== "off" && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => onChange({ ...value, mode: "off" })}
          >
            {t("codexEgressTimezone.controls.disable")}
          </Button>
        )}
      </div>

      {value.mode === "auto" && (
        <div className="max-w-xs space-y-1">
          <Label htmlFor="codex-egress-monitor-interval">
            {t("codexEgressTimezone.interval.label")}
          </Label>
          <select
            id="codex-egress-monitor-interval"
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={value.monitorIntervalMinutes ?? 15}
            onChange={(event) =>
              void onChange({
                ...value,
                monitorIntervalMinutes: Number(event.target.value),
              })
            }
          >
            <option value={5}>{t("codexEgressTimezone.interval.five")}</option>
            <option value={15}>
              {t("codexEgressTimezone.interval.fifteen")}
            </option>
            <option value={30}>
              {t("codexEgressTimezone.interval.thirty")}
            </option>
            <option value={60}>
              {t("codexEgressTimezone.interval.sixty")}
            </option>
          </select>
          <p className="text-xs text-muted-foreground">
            {t("codexEgressTimezone.interval.help")}
          </p>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        {t("codexEgressTimezone.privacy.trace")}
      </p>

      <p className="text-xs text-muted-foreground">
        {t("codexEgressTimezone.privacy.cdp")}
      </p>

      {error && (
        <p
          className="break-words rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive"
          role="alert"
        >
          {error}
        </p>
      )}

      {runtime && (
        <p className="rounded-md border border-border-default bg-background/70 p-2 text-xs">
          {runtime.matchesConfigured === true
            ? t("codexEgressTimezone.runtime.matches", {
                timezone: runtime.runtimeTimezone,
                offset: runtime.runtimeUtcOffset,
              })
            : runtime.timezoneMatch === "offset_match"
              ? t("codexEgressTimezone.runtime.offsetMatch", {
                  timezone: runtime.runtimeTimezone,
                  offset: runtime.runtimeUtcOffset,
                  configured: runtime.configuredTimezone,
                })
              : runtime.matchesConfigured === false
                ? t("codexEgressTimezone.runtime.mismatch", {
                    timezone: runtime.runtimeTimezone,
                    offset: runtime.runtimeUtcOffset,
                    configured:
                      runtime.configuredTimezone ??
                      t("codexEgressTimezone.values.disabled"),
                  })
                : t("codexEgressTimezone.runtime.disabled", {
                    timezone: runtime.runtimeTimezone,
                    offset: runtime.runtimeUtcOffset,
                  })}
        </p>
      )}

      {report && (
        <div className="space-y-3 rounded-lg border bg-background/70 p-3 text-xs">
          <div className="grid gap-2 sm:grid-cols-2">
            <p>
              <span className="text-muted-foreground">
                {t("codexEgressTimezone.report.currentTimezone")}
              </span>
              <strong>{report.currentTimezone}</strong> (
              {report.currentUtcOffset})
            </p>
            <p>
              <span className="text-muted-foreground">
                {t("codexEgressTimezone.report.egressTimezone")}
              </span>
              <strong>{report.egressTimezone}</strong> ({report.egressUtcOffset}
              )
            </p>
            <p>
              <span className="text-muted-foreground">
                {t("codexEgressTimezone.report.egressLocation")}
              </span>
              {locationLabel(report) || t("codexEgressTimezone.values.unknown")}
            </p>
            <p>
              <span className="text-muted-foreground">
                {t("codexEgressTimezone.report.publicEgress")}
              </span>
              {report.egressIp}
            </p>
          </div>
          <p className="font-medium">{comparisonLabel(t, report)}</p>
          {report.dnsUsesNonPublicAddress && (
            <p className="rounded bg-sky-500/10 p-2 text-sky-800 dark:text-sky-200">
              {t("codexEgressTimezone.report.dnsWarning", {
                addresses: report.dnsAddresses.join(", "),
              })}
            </p>
          )}
          <Button type="button" onClick={applyDetection}>
            {t("codexEgressTimezone.controls.applyDetection")}
          </Button>
        </div>
      )}

      {manualVisible && (
        <div className="flex flex-col gap-2 rounded-lg border bg-background/70 p-3 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-1">
            <Label htmlFor="codex-manual-timezone">
              {t("codexEgressTimezone.manual.label")}
            </Label>
            <Input
              id="codex-manual-timezone"
              value={manualTimezone}
              placeholder="Asia/Taipei"
              onChange={(event) => setManualTimezone(event.target.value)}
            />
          </div>
          <Button type="button" onClick={saveManual}>
            {t("codexEgressTimezone.controls.saveManual")}
          </Button>
        </div>
      )}
    </section>
  );
}
