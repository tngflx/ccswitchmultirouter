import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  RefreshCw,
  Wrench,
  XCircle,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { settingsApi, type CodexPluginHealthReport } from "@/lib/api/settings";

interface StatusRowProps {
  label: string;
  healthy: boolean;
}

function StatusRow({ label, healthy }: StatusRowProps) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-3 border-b border-border/50 py-2 last:border-b-0">
      <span className="text-sm text-foreground">{label}</span>
      {healthy ? (
        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
      ) : (
        <XCircle className="h-4 w-4 shrink-0 text-destructive" />
      )}
    </div>
  );
}

export function CodexPluginHealthPanel() {
  const { t } = useTranslation();
  const [report, setReport] = useState<CodexPluginHealthReport | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [repairingId, setRepairingId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState("");

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setLoadError("");
    try {
      setReport(await settingsApi.inspectCodexPluginHealth());
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const repair = useCallback(
    async (pluginId: string) => {
      setRepairingId(pluginId);
      try {
        const plugin =
          await settingsApi.repairCodexPluginRegistration(pluginId);
        toast.success(
          t("settings.codexPluginHealth.repairSuccess", {
            name: plugin.name,
          }),
          { closeButton: true },
        );
        await refresh();
      } catch (error) {
        toast.error(
          t("settings.codexPluginHealth.repairFailed", {
            message: error instanceof Error ? error.message : String(error),
          }),
          { closeButton: true },
        );
      } finally {
        setRepairingId(null);
      }
    },
    [refresh, t],
  );

  if (isLoading && !report) {
    return (
      <div
        role="status"
        className="flex items-center gap-2 text-sm text-muted-foreground"
      >
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("settings.codexPluginHealth.loading")}
      </div>
    );
  }

  if (!report) {
    return (
      <div className="space-y-3">
        <p role="alert" className="text-sm text-destructive">
          {t("settings.codexPluginHealth.loadFailed", { message: loadError })}
        </p>
        <Button
          type="button"
          variant="outline"
          className="gap-2"
          onClick={() => void refresh()}
        >
          <RefreshCw className="h-4 w-4" />
          {t("common.retry")}
        </Button>
      </div>
    );
  }

  const browserHealthy =
    report.browser.pluginInstalled &&
    report.browser.pluginEnabled &&
    report.browser.browserInstalled &&
    report.browser.browserRunning &&
    report.browser.extensionInstalled &&
    report.browser.extensionEnabled &&
    report.browser.nativeHostCorrect;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {browserHealthy ? (
            <CheckCircle2 className="h-5 w-5 text-emerald-500" />
          ) : (
            <AlertTriangle className="h-5 w-5 text-amber-500" />
          )}
          <span className="text-sm font-medium">
            {report.browser.browserName ??
              t("settings.codexPluginHealth.browserUnknown")}
          </span>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-2"
          disabled={isLoading}
          onClick={() => void refresh()}
        >
          {isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          {t("common.refresh")}
        </Button>
      </div>

      <div>
        <StatusRow
          label={t("settings.codexPluginHealth.browserPlugin")}
          healthy={
            report.browser.pluginInstalled && report.browser.pluginEnabled
          }
        />
        <StatusRow
          label={t("settings.codexPluginHealth.browserProcess")}
          healthy={
            report.browser.browserInstalled && report.browser.browserRunning
          }
        />
        <StatusRow
          label={t("settings.codexPluginHealth.browserExtension")}
          healthy={
            report.browser.extensionInstalled && report.browser.extensionEnabled
          }
        />
        <StatusRow
          label={t("settings.codexPluginHealth.nativeHost")}
          healthy={report.browser.nativeHostCorrect}
        />
      </div>

      {report.browser.problems.length > 0 && (
        <div className="space-y-2 border-l-2 border-amber-500/60 pl-3">
          {report.browser.problems.map((problem) => (
            <p
              key={problem}
              className="text-xs leading-5 text-muted-foreground"
            >
              {t(`settings.codexPluginHealth.problems.${problem}`)}
            </p>
          ))}
        </div>
      )}

      {!report.browser.extensionInstalled && report.browser.storeUrl && (
        <Button
          type="button"
          variant="outline"
          className="gap-2"
          onClick={() =>
            void settingsApi.openExternal(report.browser.storeUrl!)
          }
        >
          <ExternalLink className="h-4 w-4" />
          {t("settings.codexPluginHealth.openExtensionStore", {
            browser:
              report.browser.browserName ??
              t("settings.codexPluginHealth.browserUnknown"),
          })}
        </Button>
      )}

      {report.repairablePlugins.length > 0 && (
        <div className="space-y-3 border-t border-border/60 pt-4">
          <div>
            <p className="text-sm font-medium">
              {t("settings.codexPluginHealth.personalPlugins")}
            </p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {t("settings.codexPluginHealth.personalPluginsDescription")}
            </p>
          </div>
          {report.repairablePlugins.map((plugin) => (
            <div
              key={plugin.id}
              className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-2"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">
                  {plugin.name}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {plugin.version}
                </span>
              </span>
              <Button
                type="button"
                size="sm"
                className="shrink-0 gap-2"
                disabled={repairingId === plugin.id}
                onClick={() => void repair(plugin.id)}
              >
                {repairingId === plugin.id ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Wrench className="h-4 w-4" />
                )}
                {t("settings.codexPluginHealth.repair")}
              </Button>
            </div>
          ))}
        </div>
      )}

      {report.diagnosticsError && (
        <p role="alert" className="text-xs leading-5 text-destructive">
          {t("settings.codexPluginHealth.partialFailure", {
            message: report.diagnosticsError,
          })}
        </p>
      )}
    </div>
  );
}
