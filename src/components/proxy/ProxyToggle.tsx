/**
 * 代理模式切换开关组件
 *
 * 放置在主界面头部，用于一键启用/关闭代理模式
 * 启用时自动接管 Live 配置，关闭时恢复原始配置
 */

import { Radio, Loader2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { useProxyStatus } from "@/hooks/useProxyStatus";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import type { AppId } from "@/lib/api";
import { proxyApi } from "@/lib/api/proxy";
import { toast } from "sonner";

interface ProxyToggleProps {
  className?: string;
  activeApp: AppId;
}

export function ProxyToggle({ className, activeApp }: ProxyToggleProps) {
  const { t } = useTranslation();
  const {
    isRunning,
    takeoverStatus,
    setTakeoverForApp,
    restartCodexDesktop,
    isPending,
    isInitialStatusPending,
    status,
  } = useProxyStatus();

  const handleToggle = async (checked: boolean) => {
    try {
      if (activeApp === "codex" && checked) {
        let running: boolean;
        try {
          running = await proxyApi.isCodexDesktopRunning();
        } catch (error) {
          console.error(
            "[ProxyToggle] Failed to inspect Codex Desktop processes:",
            error,
          );
          toast.error(
            t("proxy.takeover.processCheckFailed", {
              detail: String(error),
              defaultValue: `Could not inspect the running Codex Desktop process: ${String(error)}`,
            }),
          );
          return;
        }
        if (running) {
          const confirmed = window.confirm(
            t("proxy.takeover.restartCodexConfirm", {
              defaultValue:
                "Codex Desktop is running. Restart it now so the takeover change can apply? Unsaved Codex work may be interrupted.",
            }),
          );
          if (!confirmed) return;
          await restartCodexDesktop(checked);
          return;
        }
      }
      await setTakeoverForApp({ appType: activeApp, enabled: checked });
    } catch (error) {
      console.error("[ProxyToggle] Toggle takeover failed:", error);
    }
  };

  const takeoverEnabled = takeoverStatus?.[activeApp] || false;

  const appLabel =
    activeApp === "claude"
      ? "Claude"
      : activeApp === "codex"
        ? "Codex"
        : activeApp === "gemini"
          ? "Gemini"
          : activeApp === "grokbuild"
            ? "Grok Build"
            : "OpenCode";

  const tooltipText = takeoverEnabled
    ? isRunning
      ? t("proxy.takeover.tooltip.active", {
          appLabel,
          address: status?.address,
          port: status?.port,
          defaultValue: `${appLabel} 已接管 - ${status?.address}:${status?.port}\n切换该应用供应商为热切换`,
        })
      : t("proxy.takeover.tooltip.broken", {
          appLabel,
          defaultValue: `${appLabel} 已接管，但代理服务未运行`,
        })
    : t("proxy.takeover.tooltip.inactive", {
        appLabel,
        defaultValue: `接管 ${appLabel} 的 Live 配置，让该应用请求走本地代理`,
      });

  return (
    <div
      className={cn(
        "flex items-center gap-1 px-1.5 h-8 rounded-lg bg-muted/50 transition-all",
        className,
      )}
      title={tooltipText}
    >
      {isPending ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : (
        <Radio
          className={cn(
            "h-4 w-4 transition-colors",
            takeoverEnabled
              ? "text-emerald-500 status-heartbeat"
              : "text-muted-foreground",
          )}
        />
      )}
      <Switch
        checked={takeoverEnabled}
        onCheckedChange={handleToggle}
        disabled={isPending || isInitialStatusPending}
        aria-label={t("proxy.takeover.ariaLabel", { appLabel })}
      />
    </div>
  );
}
