import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  Clock3,
  Loader2,
  Network,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  codexEgressTimezoneApi,
  type CodexEgressMonitorStatus,
} from "@/lib/api/codexEgressTimezone";

function translate(
  t: TFunction,
  key: string,
  defaultValue: string,
  options?: Record<string, unknown>,
) {
  return t(key, { ...options, defaultValue });
}

function stateLabel(t: TFunction, status: CodexEgressMonitorStatus) {
  switch (status.state) {
    case "disabled":
      return translate(t, "codexEgressTimezone.status.disabled", "Not enabled");
    case "not_tested":
      return translate(
        t,
        "codexEgressTimezone.status.notTested",
        "Waiting for first check",
      );
    case "checking":
      return translate(
        t,
        "codexEgressTimezone.status.checking",
        "Checking egress",
      );
    case "ready":
      return translate(
        t,
        "codexEgressTimezone.status.ready",
        "Monitoring healthy",
      );
    case "restart_required":
      return translate(
        t,
        "codexEgressTimezone.status.restartRequired",
        "Egress changed; refresh Codex",
      );
    case "error":
      return translate(
        t,
        "codexEgressTimezone.status.error",
        "Automatic check failed",
      );
  }
}

function triggerLabel(t: TFunction, trigger?: string) {
  switch (trigger) {
    case "startup":
      return translate(
        t,
        "codexEgressTimezone.trigger.startup",
        "Startup check",
      );
    case "periodic":
      return translate(
        t,
        "codexEgressTimezone.trigger.periodic",
        "Scheduled check",
      );
    case "proxy_failure":
      return translate(
        t,
        "codexEgressTimezone.trigger.proxyFailure",
        "Proxy failure trigger",
      );
    case "network_resume":
      return translate(
        t,
        "codexEgressTimezone.trigger.networkResume",
        "Network/sleep recovery trigger",
      );
    case "manual":
      return translate(t, "codexEgressTimezone.trigger.manual", "Manual check");
    default:
      return translate(t, "codexEgressTimezone.trigger.none", "No record");
  }
}

interface CodexEgressTimezoneStatusCardProps {
  onOpenCodexStatus?: () => void;
}

export function CodexEgressTimezoneStatusCard({
  onOpenCodexStatus,
}: CodexEgressTimezoneStatusCardProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<CodexEgressMonitorStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [requestError, setRequestError] = useState("");

  const refresh = useCallback(async () => {
    try {
      setStatus(await codexEgressTimezoneApi.monitorStatus());
      setRequestError("");
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const probeNow = async () => {
    setLoading(true);
    setRequestError("");
    try {
      setStatus(await codexEgressTimezoneApi.triggerAutomaticProbe());
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  const warning = status?.state === "restart_required";
  const failed = status?.state === "error" || Boolean(requestError);
  return (
    <section
      className={`rounded-lg border px-4 py-3 ${
        warning
          ? "border-amber-500/40 bg-amber-500/10"
          : failed
            ? "border-destructive/40 bg-destructive/10"
            : "border-border bg-card"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-2">
          <div className="flex items-center gap-2 text-sm font-semibold">
            {warning || failed ? (
              <TriangleAlert className="h-4 w-4 text-amber-500" />
            ) : (
              <Network className="h-4 w-4 text-emerald-500" />
            )}
            {translate(
              t,
              "codexEgressTimezone.statusCard.title",
              "Codex egress environment monitoring",
            )}
            <span className="rounded-full border bg-background/70 px-2 py-0.5 text-xs font-normal">
              {loading && !status
                ? translate(
                    t,
                    "codexEgressTimezone.statusCard.loading",
                    "Loading",
                  )
                : status
                  ? stateLabel(t, status)
                  : translate(
                      t,
                      "codexEgressTimezone.statusCard.unavailable",
                      "Unavailable",
                    )}
            </span>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            {status?.state === "disabled"
              ? translate(
                  t,
                  "codexEgressTimezone.statusCard.descriptionDisabled",
                  "Enable “Automatic egress monitoring” in Settings → General. It checks at startup, after proxy or network recovery, and on the configured schedule.",
                )
              : status?.detectedTimezone
                ? translate(
                    t,
                    "codexEgressTimezone.statusCard.descriptionDetected",
                    "Current egress {{ip}} · {{timezone}}; {{trigger}}, with a fallback check every {{minutes}} minutes.",
                    {
                      ip:
                        status.detectedEgressIp ??
                        translate(
                          t,
                          "codexEgressTimezone.values.unknown",
                          "unknown",
                        ),
                      timezone: status.detectedTimezone,
                      trigger: triggerLabel(t, status.lastTrigger),
                      minutes: status.monitorIntervalMinutes,
                    },
                  )
                : translate(
                    t,
                    "codexEgressTimezone.statusCard.descriptionNoTimezone",
                    "No egress timezone has been detected; automatic monitoring does not block model requests.",
                  )}
          </p>
          {warning && (
            <p className="text-xs font-medium text-amber-800 dark:text-amber-200">
              {translate(
                t,
                "codexEgressTimezone.statusCard.warning",
                "A new result is saved, but the running app-server still uses the old TZ. CCSM will not force-stop tasks; use the safe refresh on the Codex status page when no task is running.",
              )}
            </p>
          )}
          {(requestError || status?.lastError) && (
            <p
              className="text-xs text-destructive"
              role="status"
              aria-live="polite"
            >
              {requestError || status?.lastError}
            </p>
          )}
          <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Clock3 className="h-3 w-3" />
            {translate(
              t,
              "codexEgressTimezone.statusCard.cdpNote",
              "Detection does not depend on CDP; CDP is only used for optional Codex page timezone synchronization and verification.",
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {warning && onOpenCodexStatus && (
            <Button type="button" size="sm" onClick={onOpenCodexStatus}>
              {translate(
                t,
                "codexEgressTimezone.statusCard.openSafeRefresh",
                "Open safe refresh",
              )}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={loading || status?.state === "disabled"}
            onClick={() => void probeNow()}
          >
            {loading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            {translate(
              t,
              "codexEgressTimezone.statusCard.checkNow",
              "Check now",
            )}
          </Button>
        </div>
      </div>
    </section>
  );
}
