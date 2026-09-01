import type { Ref } from "react";
import { CheckCircle2, Download, Loader2, Route, Server } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { CodexApiFormat, CodexCatalogModel } from "@/types";
import type { ResolvedCodexTrafficPolicy } from "./codexTrafficPolicy";

type ValidationTone = "muted" | "success" | "warning" | "error";

interface CodexProviderReadinessSectionProps {
  models: CodexCatalogModel[];
  defaultModel?: string;
  apiFormat: CodexApiFormat;
  trafficPolicy?: ResolvedCodexTrafficPolicy;
  isMaintainedPreset: boolean;
  isSyncingModels: boolean;
  isRefreshingModels?: boolean;
  isValidatingConnection: boolean;
  validationSummary?: string;
  validationTone?: ValidationTone;
  highlightSync?: boolean;
  syncButtonRef?: Ref<HTMLButtonElement>;
  sectionRef?: Ref<HTMLElement>;
  onSyncModels: () => void;
  onFillMissingFields?: () => void;
  onValidateConnection: () => void;
}

function apiFormatLabel(apiFormat: CodexApiFormat): string {
  switch (apiFormat) {
    case "openai_responses":
      return "Responses";
    case "anthropic":
      return "Anthropic Messages";
    default:
      return "Chat Completions";
  }
}

export function CodexProviderReadinessSection({
  models,
  defaultModel,
  apiFormat,
  trafficPolicy = {
    source: "safe_default",
    admissionEnabled: false,
    maxInFlight: 8,
    maxQueueWaitMs: 30_000,
    rateLimitMaxRetries: 5,
    rejectionRetryMode: "disabled",
    rejectionMaxRetries: 0,
    rejectionInitialDelayMs: 750,
    rejectionMaxDelayMs: 5000,
  },
  isMaintainedPreset,
  isSyncingModels,
  isRefreshingModels = false,
  isValidatingConnection,
  validationSummary = "",
  validationTone = "muted",
  highlightSync = false,
  syncButtonRef,
  sectionRef,
  onSyncModels,
  onFillMissingFields,
  onValidateConnection,
}: CodexProviderReadinessSectionProps) {
  const { t } = useTranslation();
  const tr = (
    key: string,
    defaultValue: string,
    values?: Record<string, number>,
  ) => t(`codexConfig.providerReadiness.${key}`, { defaultValue, ...values });
  const normalizedModels = models.filter((model) => model.model.trim());
  const includedCount = normalizedModels.filter(
    (model) => model.enabled !== false,
  ).length;
  const excludedCount = normalizedModels.length - includedCount;
  const selectedModel =
    defaultModel?.trim() ||
    normalizedModels[0]?.model.trim() ||
    tr("notSelected", "Not selected");
  const hasModels = normalizedModels.length > 0;
  const responsesModels = normalizedModels.filter(
    (model) => (model.apiFormat ?? model.api_format) === "openai_responses",
  );
  const chatModels = normalizedModels.filter(
    (model) => (model.apiFormat ?? model.api_format) === "openai_chat",
  );
  const responsesCount = responsesModels.length;
  const chatCount = chatModels.length;
  const validationPassed = validationTone === "success";
  const ready = hasModels && validationPassed;
  const isCatalogActionRunning = isSyncingModels || isRefreshingModels;
  const readinessLabel = !hasModels
    ? tr("syncNeeded", "Sync models needed")
    : ready
      ? tr("canJoin", "Can join MultiRouter")
      : validationTone === "error"
        ? tr("checkFailed", "Connection check failed")
        : tr("verifyFirst", "Verify connection first");

  return (
    <section
      ref={sectionRef}
      aria-labelledby="codex-model-readiness-title"
      className="space-y-4 rounded-lg border border-border-default bg-muted/10 p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h3
            id="codex-model-readiness-title"
            className="text-sm font-semibold text-foreground"
          >
            {tr("title", "Models & Compatibility")}
          </h3>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {tr(
              "description",
              "Sync the models available from this source and verify that Codex and MultiRouter can use them correctly.",
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            ref={syncButtonRef}
            type="button"
            size="sm"
            onClick={() => onSyncModels()}
            disabled={isCatalogActionRunning}
            className={cn(
              "h-8 gap-1 border border-blue-700 bg-blue-600 px-3 text-white shadow-sm hover:bg-blue-700 dark:border-blue-400 dark:bg-blue-500 dark:hover:bg-blue-600",
              highlightSync &&
                "border-blue-500 bg-blue-50 text-blue-700 shadow-[0_0_0_3px_rgba(59,130,246,0.18)] dark:bg-blue-950/40 dark:text-blue-200",
            )}
          >
            {isSyncingModels ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            {tr("syncModels", "Sync Models")}
          </Button>
          {onFillMissingFields && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 gap-1"
              onClick={onFillMissingFields}
              disabled={isCatalogActionRunning}
              title={tr(
                "fillMissingTitle",
                "Refresh provider metadata for existing models without adding, renaming, reordering, or re-enabling models",
              )}
            >
              {isRefreshingModels ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              {tr("fillMissing", "Refresh Existing")}
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-1"
            disabled={isValidatingConnection}
            onClick={onValidateConnection}
          >
            {isValidatingConnection ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Route className="h-3.5 w-3.5" />
            )}
            {tr("verifyConnection", "Verify Connection")}
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-md border border-border-default bg-background/70 p-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Server className="h-3.5 w-3.5" />
            {tr("modelCatalog", "Model Catalog")}
          </div>
          <p className="mt-1 text-sm font-medium text-foreground">
            {hasModels
              ? tr("includedCount", "{{included}}/{{total}} included", {
                  included: includedCount,
                  total: normalizedModels.length,
                })
              : tr("notSynced", "Not synced")}
            {excludedCount > 0 && (
              <span className="ml-1 text-xs text-muted-foreground">
                {tr("excludedCount", "({{count}} excluded)", {
                  count: excludedCount,
                })}
              </span>
            )}
          </p>
        </div>
        <div className="rounded-md border border-border-default bg-background/70 p-3">
          <p className="text-xs text-muted-foreground">
            {tr("defaultModel", "Default Model")}
          </p>
          <p className="mt-1 truncate text-sm font-medium text-foreground">
            {selectedModel}
          </p>
        </div>
        <div className="rounded-md border border-border-default bg-background/70 p-3">
          <p className="text-xs text-muted-foreground">
            {tr("upstreamProtocol", "Upstream Protocol")}
          </p>
          <p className="mt-1 text-sm font-medium text-foreground">
            {responsesCount > 0 && chatCount > 0
              ? tr("mixedProtocol", "Mixed (per model)")
              : apiFormatLabel(apiFormat)}
          </p>
        </div>
        <div className="rounded-md border border-border-default bg-background/70 p-3">
          <p className="text-xs text-muted-foreground">
            {tr("trafficPolicy", "Traffic Policy")}
          </p>
          <p className="mt-1 text-sm font-medium text-foreground">
            {trafficPolicy.admissionEnabled
              ? tr("trafficLimited", "{{count}} in flight", {
                  count: trafficPolicy.maxInFlight,
                })
              : tr("trafficUnlimited", "No local limit")}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {trafficPolicy.source === "recommended"
              ? tr("trafficRecommended", "Recommended")
              : trafficPolicy.source === "custom"
                ? tr("trafficCustom", "Custom")
                : tr("trafficUnknown", "Capacity unknown")}
            {" · "}
            {tr(
              "trafficRetrySummary",
              "429: {{rateLimit}} · rejection: {{rejection}}",
              {
                rateLimit: trafficPolicy.rateLimitMaxRetries,
                rejection: trafficPolicy.rejectionMaxRetries,
              },
            )}
          </p>
        </div>
        {responsesCount > 0 && chatCount > 0 && (
          <div className="rounded-md border border-border-default bg-background/70 p-3 sm:col-span-2 lg:col-span-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                {tr("protocolGroups", "Protocol groups")}
              </p>
              <span className="text-xs text-muted-foreground">
                {tr("automaticRouting", "Automatic per-model routing")}
              </span>
            </div>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <div className="min-w-0 rounded border border-emerald-500/30 bg-emerald-500/10 px-3 py-2">
                <p className="text-sm font-medium text-foreground">
                  {tr("responsesGroup", "Responses: {{count}} models", {
                    count: responsesCount,
                  })}
                </p>
                <p
                  className="mt-1 truncate font-mono text-[11px] text-muted-foreground"
                  title={responsesModels.map((model) => model.model).join(", ")}
                >
                  {responsesModels
                    .slice(0, 4)
                    .map((model) => model.model)
                    .join(", ")}
                  {responsesCount > 4 ? ` +${responsesCount - 4}` : ""}
                </p>
              </div>
              <div className="min-w-0 rounded border border-sky-500/30 bg-sky-500/10 px-3 py-2">
                <p className="text-sm font-medium text-foreground">
                  {tr("chatGroup", "Chat Completions: {{count}} models", {
                    count: chatCount,
                  })}
                </p>
                <p
                  className="mt-1 truncate font-mono text-[11px] text-muted-foreground"
                  title={chatModels.map((model) => model.model).join(", ")}
                >
                  {chatModels
                    .slice(0, 4)
                    .map((model) => model.model)
                    .join(", ")}
                  {chatCount > 4 ? ` +${chatCount - 4}` : ""}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="rounded-md border border-border-default bg-background/70 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-1">
            <p className="text-xs font-medium text-foreground">
              {tr("readiness", "Readiness")}
            </p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {isMaintainedPreset
                ? tr(
                    "maintainedDescription",
                    "Protocol, context, reasoning tiers, and the /model catalog are maintained by CCSwitchMulti.",
                  )
                : tr(
                    "customDescription",
                    "Verify Connection automatically tests both Chat and Responses. Use a manual override in Advanced Settings only when automatic detection fails.",
                  )}
            </p>
          </div>
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium",
              ready
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                : validationTone === "error"
                  ? "border-destructive/40 bg-destructive/10 text-destructive"
                  : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
            )}
          >
            {ready && <CheckCircle2 className="h-3.5 w-3.5" />}
            {readinessLabel}
          </span>
        </div>
        {isMaintainedPreset && (
          <p className="mt-2 text-xs font-medium text-blue-700 dark:text-blue-300">
            {tr("maintainedBy", "Maintained by CCSwitchMulti")}
          </p>
        )}
        {validationSummary && (
          <p
            role={validationTone === "error" ? "alert" : "status"}
            className={cn(
              "mt-2 text-xs leading-relaxed",
              validationTone === "success" &&
                "text-emerald-700 dark:text-emerald-300",
              validationTone === "warning" &&
                "text-amber-700 dark:text-amber-300",
              validationTone === "error" && "text-destructive",
              validationTone === "muted" && "text-muted-foreground",
            )}
          >
            {validationSummary}
          </p>
        )}
      </div>
    </section>
  );
}
