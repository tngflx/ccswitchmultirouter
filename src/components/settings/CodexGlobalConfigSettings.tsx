import { useEffect, useState } from "react";
import { Loader2, RefreshCw, Save } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

import JsonEditor from "@/components/JsonEditor";
import { Button } from "@/components/ui/button";
import { configApi } from "@/lib/api";
import {
  isCodexGoalModeEnabled,
  setCodexGoalMode,
} from "@/utils/providerConfigUtils";

const DEFAULT_CODEX_GLOBAL_CONFIG = `# Shared Codex configuration
# Settings here are available to Codex providers that apply the common config.`;

export function CodexGlobalConfigSettings() {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<{
    operation: "load" | "save";
    message: string;
  } | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    setIsLoaded(false);
    setError(null);
    configApi
      .getCommonConfigSnippet("codex")
      .then((snippet) => {
        if (!active) return;
        setValue(snippet?.trim() ? snippet : DEFAULT_CODEX_GLOBAL_CONFIG);
        setIsLoaded(true);
        setError(null);
      })
      .catch((loadError) => {
        if (!active) return;
        setIsLoaded(false);
        setError({
          operation: "load",
          message:
            loadError instanceof Error ? loadError.message : String(loadError),
        });
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [loadAttempt]);

  async function save() {
    if (!isLoaded) return;
    setIsSaving(true);
    setError(null);
    try {
      await configApi.setCommonConfigSnippet("codex", value);
      toast.success(t("codexGlobalConfig.saved"));
    } catch (saveError) {
      const message =
        saveError instanceof Error ? saveError.message : String(saveError);
      setError({ operation: "save", message });
      toast.error(t("codexGlobalConfig.saveError", { error: message }));
    } finally {
      setIsSaving(false);
    }
  }

  if (isLoading) {
    return (
      <div
        role="status"
        className="flex items-center gap-2 text-sm text-muted-foreground"
      >
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("codexGlobalConfig.loading")}
      </div>
    );
  }

  if (!isLoaded) {
    return (
      <div className="space-y-3 rounded-md border border-destructive/30 bg-destructive/5 p-4">
        <p role="alert" className="text-sm text-destructive">
          {error &&
            t(`codexGlobalConfig.${error.operation}Error`, {
              error: error.message,
            })}
        </p>
        <Button
          type="button"
          variant="outline"
          className="gap-2"
          onClick={() => setLoadAttempt((attempt) => attempt + 1)}
        >
          <RefreshCw className="h-4 w-4" />
          {t("codexGlobalConfig.retry")}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-4">
        <p className="text-sm font-medium text-foreground">
          {t("codexGlobalConfig.sharedBehavior")}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {t("codexGlobalConfig.description")}
        </p>
      </div>

      <label className="flex items-start justify-between gap-4 rounded-md border border-border-default p-3">
        <span className="space-y-1">
          <span className="block text-sm font-medium text-foreground">
            {t("codexGlobalConfig.goalMode")}
          </span>
          <span className="block text-xs leading-relaxed text-muted-foreground">
            {t("codexGlobalConfig.goalModeDescription")}
          </span>
        </span>
        <input
          aria-label={t("codexGlobalConfig.goalMode")}
          type="checkbox"
          checked={isCodexGoalModeEnabled(value)}
          onChange={(event) =>
            setValue((current) =>
              setCodexGoalMode(current, event.target.checked),
            )
          }
          className="mt-0.5 h-4 w-4 rounded border-border-default text-blue-500 focus:ring-blue-500"
        />
      </label>

      <div className="space-y-2">
        <label
          className="text-sm font-medium text-foreground"
          htmlFor="codex-global-config"
        >
          {t("codexGlobalConfig.toml")}
        </label>
        <JsonEditor
          id="codex-global-config"
          ariaLabel={t("codexGlobalConfig.toml")}
          value={value}
          onChange={setValue}
          placeholder={DEFAULT_CODEX_GLOBAL_CONFIG}
          darkMode={document.documentElement.classList.contains("dark")}
          rows={12}
          showValidation={false}
          language="javascript"
        />
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {t(`codexGlobalConfig.${error.operation}Error`, {
            error: error.message,
          })}
        </p>
      )}

      <div className="flex justify-end">
        <Button
          type="button"
          onClick={() => void save()}
          disabled={isSaving}
          className="gap-2"
        >
          {isSaving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          {t("codexGlobalConfig.save")}
        </Button>
      </div>
    </div>
  );
}
