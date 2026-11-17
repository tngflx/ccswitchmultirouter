import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Activity,
  CheckCircle2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { watchdogApi, type WatchdogStatus } from "@/lib/api/watchdog";

interface WatchdogStatusPanelProps {
  /** Advance only after a settings save has completed successfully. */
  refreshVersion?: number;
}

/**
 * 只读的“看门狗与端口自检”面板：守护进程是否在跑、最近自动拉起次数、
 * 当前端口归属与占用诊断。数据来自后端 get_watchdog_status 命令。
 */
export function WatchdogStatusPanel({
  refreshVersion = 0,
}: WatchdogStatusPanelProps = {}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<WatchdogStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const mountedRef = useRef(false);
  const requestVersionRef = useRef(0);

  const load = useCallback(async () => {
    const requestVersion = ++requestVersionRef.current;
    const isCurrent = () =>
      mountedRef.current && requestVersion === requestVersionRef.current;
    setLoading(true);
    try {
      const next = await watchdogApi.getStatus();
      if (!isCurrent()) return;
      setStatus(next);
      setFailed(false);
    } catch {
      // Native errors may contain private details; never render or log them.
      if (isCurrent()) setFailed(true);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
      // Invalidate pending reads on unmount and before a newer save refresh.
      requestVersionRef.current += 1;
    };
  }, [load, refreshVersion]);

  const supervisorBadge = !status
    ? null
    : !status.enabled
      ? {
          label: t("settings.watchdogStateDisabled"),
          variant: "secondary" as const,
        }
      : status.supervisorAlive
        ? {
            label: t("settings.watchdogStateRunning"),
            variant: "default" as const,
          }
        : status.supervisorMode === "pnpm-dev"
          ? {
              label: t("settings.watchdogStateDevManaged"),
              variant: "default" as const,
            }
          : {
              label: t("settings.watchdogStateStopped"),
              variant: "destructive" as const,
            };

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2 pb-2 border-b border-border/40">
        <Activity className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-medium">
          {t("settings.watchdogPanelTitle")}
        </h3>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="ml-auto h-7 w-7"
          title={t("settings.watchdogRefresh")}
          aria-label={t("settings.watchdogRefresh")}
          onClick={() => void load()}
          disabled={loading}
        >
          <RefreshCw
            className={loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"}
          />
        </Button>
      </div>

      {failed ? (
        <p role="alert" className="text-xs text-destructive">
          {t("settings.watchdogLoadFailed")}
        </p>
      ) : null}
      {!status && !failed ? (
        <p role="status" className="text-xs text-muted-foreground">
          {t("settings.watchdogLoading")}
        </p>
      ) : null}
      {status ? (
        <div className="space-y-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
            <span className="text-muted-foreground">
              {t("settings.watchdogSupervisor")}
            </span>
            {supervisorBadge ? (
              <Badge variant={supervisorBadge.variant}>
                {supervisorBadge.label}
              </Badge>
            ) : null}
            {status.supervisorMode === "pnpm-dev" ? (
              <div className="basis-full space-y-0.5 pl-5 text-muted-foreground">
                <p>{t("settings.watchdogDevSupervisor")}</p>
                <p>{t("settings.watchdogDevSupervisorDescription")}</p>
              </div>
            ) : null}
            {status.supervisorPid ? (
              <span className="font-mono text-muted-foreground">
                PID {status.supervisorPid}
              </span>
            ) : null}
          </div>

          {status.supervisorMode === "pnpm-dev" &&
          typeof status.enabledOverride === "boolean" ? (
            <div
              role="status"
              className="space-y-1 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-muted-foreground"
            >
              <p className="font-medium text-foreground">
                {t(
                  status.enabledOverride
                    ? "settings.watchdogDevOverrideEnabled"
                    : "settings.watchdogDevOverrideDisabled",
                )}
              </p>
              <p>{t("settings.watchdogDevOverrideDescription")}</p>
              {typeof status.configuredEnabled === "boolean" ? (
                <p>
                  {t(
                    status.configuredEnabled
                      ? "settings.watchdogConfiguredEnabled"
                      : "settings.watchdogConfiguredDisabled",
                  )}
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">
              {t("settings.watchdogRestartsWindow")}
            </span>
            <span className="font-mono">{status.restartsInWindow}</span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {status.portReady ? (
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
            ) : (
              <ShieldAlert className="h-3.5 w-3.5 text-amber-500" />
            )}
            <span className="text-muted-foreground">
              {t("settings.watchdogPortLabel")}
            </span>
            <span className="font-mono">
              {status.port > 0 ? `127.0.0.1:${status.port}` : "-"}
            </span>
            <Badge variant={status.portReady ? "default" : "destructive"}>
              {status.portReady
                ? t("settings.watchdogPortReady")
                : t("settings.watchdogPortNotReady")}
            </Badge>
            {status.listenerPid ? (
              <span className="font-mono text-muted-foreground">
                PID {status.listenerPid}
              </span>
            ) : null}
          </div>

          <details
            open={!status.portReady}
            className="rounded-md border border-border/40 px-3 py-2"
          >
            <summary className="cursor-pointer select-none text-muted-foreground">
              {t("settings.watchdogDiagnostics")}
            </summary>
            <div className="mt-2 space-y-3">
              {!status.portReady && status.portDiagnosis ? (
                <div className="space-y-1">
                  <p className="text-muted-foreground">
                    {t("settings.watchdogDiagnosis")}
                  </p>
                  <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/50 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                    {status.portDiagnosis}
                  </pre>
                </div>
              ) : null}

              <div className="space-y-1">
                <p className="text-muted-foreground">
                  {t("settings.watchdogRecentEvents")}
                </p>
                {status.recentEvents.length === 0 ? (
                  <p className="text-muted-foreground">
                    {t("settings.watchdogNoEvents")}
                  </p>
                ) : (
                  <ul className="space-y-0.5 font-mono text-[11px] text-muted-foreground">
                    {status.recentEvents.map((event, index) => (
                      <li key={`${event.timestamp}-${event.event}-${index}`}>
                        <span>{event.timestamp}</span>{" "}
                        <span
                          className={
                            event.level === "error" ? "text-destructive" : ""
                          }
                        >
                          {event.event}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </details>
        </div>
      ) : null}
    </section>
  );
}
