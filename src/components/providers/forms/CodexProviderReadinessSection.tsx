import type { Ref } from "react";
import {
  BadgeDollarSign,
  CheckCircle2,
  Download,
  Eye,
  Loader2,
  Route,
  Server,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { readCodexModelProtocolCapability } from "@/lib/codexProtocolCapability";
import { normalizeCodexPublicModelKey } from "@/lib/protocol-lab/codex-overrides";
import { cn } from "@/lib/utils";
import type {
  CodexApiFormat,
  CodexCatalogModel,
  CodexProtocolOverride,
  Provider,
} from "@/types";
import type { CodexProviderAdaptationView } from "@/lib/api/protocol-compatibility";

type ValidationTone = "muted" | "success" | "warning" | "error";

interface CodexProviderReadinessSectionProps {
  models: CodexCatalogModel[];
  provider?: Pick<Provider, "settingsConfig" | "meta">;
  defaultModel?: string;
  apiFormat: CodexApiFormat;
  adaptation?: CodexProviderAdaptationView | null;
  isMaintainedPreset: boolean;
  isSyncingModels: boolean;
  isValidatingConnection: boolean;
  validationSummary?: string;
  validationTone?: ValidationTone;
  highlightSync?: boolean;
  syncButtonRef?: Ref<HTMLButtonElement>;
  sectionRef?: Ref<HTMLElement>;
  onSyncModels: () => void;
  confirmedFreeModelCount?: number;
  canUseFreeModelsOnly?: boolean;
  onUseFreeModelsOnly?: () => void;
  onValidateConnection: () => void;
  onViewCompatibilityDetails?: () => void;
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
  provider,
  defaultModel,
  apiFormat,
  adaptation = null,
  isMaintainedPreset,
  isSyncingModels,
  isValidatingConnection,
  validationSummary = "",
  validationTone = "muted",
  highlightSync = false,
  syncButtonRef,
  sectionRef,
  onSyncModels,
  confirmedFreeModelCount = 0,
  canUseFreeModelsOnly = false,
  onUseFreeModelsOnly,
  onValidateConnection,
  onViewCompatibilityDetails,
}: CodexProviderReadinessSectionProps) {
  const { t } = useTranslation();
  const configuredModels = models.filter((model) => model.model.trim());
  const enabledModels = configuredModels.filter(
    (model) => model.enabled !== false,
  );
  const disabledModelCount = configuredModels.length - enabledModels.length;
  const configuredDefault = defaultModel?.trim() ?? "";
  const selectedModel =
    enabledModels
      .find((model) => model.model.trim() === configuredDefault)
      ?.model.trim() ||
    enabledModels[0]?.model.trim() ||
    (configuredModels.length > 0 ? "Not enabled" : "Not selected");
  const hasModels = enabledModels.length > 0;
  const evidenceExpired =
    adaptation?.status === "stale" ||
    (adaptation?.expiresAt != null &&
      adaptation.expiresAt <= Math.floor(Date.now() / 1000));
  const persistedEvidenceReady =
    adaptation?.status === "ready" && !evidenceExpired;
  const hasPersistedEvidence = Boolean(
    adaptation?.models.some((model) => model.responses || model.chat),
  );
  const explicitTransportFor = (
    model: CodexCatalogModel,
  ): CodexProtocolOverride | null => {
    const override =
      provider?.meta?.codexProtocolOverrides?.[
        normalizeCodexPublicModelKey(model.model)
      ];
    if (override === "openai_chat" || override === "openai_responses") {
      return override;
    }
    return provider?.meta?.codexProtocolMode === "manual" &&
      (apiFormat === "openai_chat" || apiFormat === "openai_responses")
      ? apiFormat
      : null;
  };
  const apiDeclaredModels = provider
    ? enabledModels.flatMap((model) => {
        const explicitTransport = explicitTransportFor(model);
        const transport = readCodexModelProtocolCapability(
          explicitTransport
            ? {
                ...provider,
                meta: { ...provider.meta, apiFormat: explicitTransport },
              }
            : provider,
          model,
        );
        return transport
          ? [
              {
                model: model.model.trim(),
                transport,
                appliesToSelection:
                  !explicitTransport || explicitTransport === transport,
              },
            ]
          : [];
      })
    : [];
  const apiDeclaredModelNames = new Set(
    apiDeclaredModels
      .filter((model) => model.appliesToSelection)
      .map((model) => model.model),
  );
  const hasCurrentProbeIssues =
    !evidenceExpired &&
    adaptation?.models.some(
      (evidence) =>
        evidence.readiness !== "verified" &&
        Boolean(evidence.responses || evidence.chat) &&
        enabledModels.some(
          (model) =>
            evidence.publicModel.trim() === model.model.trim() &&
            evidence.upstreamModel.trim() ===
              (
                model.upstreamModel ??
                model.upstream_model ??
                model.model
              ).trim(),
        ),
    );
  const capabilitiesReady =
    !hasCurrentProbeIssues &&
    enabledModels.every(
      (model) =>
        apiDeclaredModelNames.has(model.model.trim()) ||
        (!evidenceExpired &&
          adaptation?.models.some(
            (evidence) =>
              evidence.publicModel.trim() === model.model.trim() &&
              evidence.readiness === "verified" &&
              evidence.effectiveTransport !== null,
          )),
    );
  const validationPassed =
    validationTone === "success" ||
    (validationTone !== "error" && persistedEvidenceReady);
  const ready =
    hasModels &&
    validationTone !== "error" &&
    (validationPassed || capabilitiesReady);
  const readinessLabel =
    configuredModels.length === 0
      ? "Sync models"
      : !hasModels
        ? "Enable a model"
        : ready
          ? "Ready for MultiRouter"
          : validationTone === "error"
            ? "Connection validation failed"
            : "Validate the connection first";
  const hasExplicitTransport = enabledModels.some(
    (model) => explicitTransportFor(model) !== null,
  );
  const resolvedTransports = new Set(
    enabledModels.flatMap((model) => {
      const explicitTransport = explicitTransportFor(model);
      if (explicitTransport) return [explicitTransport];
      const verified = !evidenceExpired
        ? adaptation?.models.find(
            (evidence) =>
              evidence.publicModel.trim() === model.model.trim() &&
              evidence.readiness === "verified",
          )?.effectiveTransport
        : null;
      if (verified) {
        return [
          verified === "open_ai_responses"
            ? ("openai_responses" as const)
            : ("openai_chat" as const),
        ];
      }
      const declared = apiDeclaredModels.find(
        (declaration) => declaration.model === model.model.trim(),
      );
      return declared ? [declared.transport] : [];
    }),
  );
  const apiProtocolLabel =
    resolvedTransports.size > 1
      ? t("codexProviderReadiness.apiMixedProtocol", {
          defaultValue: "API-declared · Responses + Chat",
        })
      : resolvedTransports.has("openai_responses")
        ? "Responses"
        : "Chat";
  const effectiveProtocolLabel =
    hasExplicitTransport && hasModels
      ? resolvedTransports.size > 1
        ? t("codexProviderReadiness.manualMixedProtocol", {
            defaultValue: "Manual selection · Responses + Chat",
          })
        : apiFormatLabel([...resolvedTransports][0] ?? apiFormat)
      : !validationPassed && ready && apiDeclaredModels.length > 0
        ? apiProtocolLabel
        : adaptation
          ? adaptation.persistence === "split" ||
            adaptation.effectiveTransport === "mixed"
            ? "Automatic adaptation · Responses + Chat"
            : adaptation.effectiveTransport === "open_ai_responses"
              ? "Responses"
              : adaptation.effectiveTransport === "open_ai_chat"
                ? "Chat"
                : adaptation.persistence === "legacy_mixed"
                  ? "Legacy mixed protocol"
                  : apiFormatLabel(apiFormat)
          : apiFormatLabel(apiFormat);
  const evidenceTime = adaptation?.testedAt
    ? new Date(adaptation.testedAt * 1000).toLocaleString()
    : "Not validated";

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
            Models and compatibility
          </h3>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Sync the models available from this source and verify that Codex and
            MultiRouter can use them successfully.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            ref={syncButtonRef}
            type="button"
            size="sm"
            onClick={onSyncModels}
            disabled={isSyncingModels}
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
            Sync models
          </Button>
          {canUseFreeModelsOnly &&
            (confirmedFreeModelCount ?? 0) > 0 &&
            onUseFreeModelsOnly && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 gap-1"
                onClick={onUseFreeModelsOnly}
                disabled={isSyncingModels}
                title={t("codexConfig.useFreeModelsOnlyHint", {
                  defaultValue:
                    "Enable only models that the provider explicitly identifies as free.",
                })}
              >
                <BadgeDollarSign className="h-3.5 w-3.5" />
                {t("codexConfig.useFreeModelsOnly", {
                  defaultValue: "Use free models only",
                })}
                <span className="text-[11px] opacity-75">
                  ({confirmedFreeModelCount})
                </span>
              </Button>
            )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-1"
            disabled={isValidatingConnection}
            onClick={onValidateConnection}
            aria-label="Validate connection"
            title={t("codexProviderReadiness.optionalProbeHint", {
              defaultValue:
                "Optional live verification of credentials, streaming, tool calls, and tool continuations.",
            })}
          >
            {isValidatingConnection ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Route className="h-3.5 w-3.5" />
            )}
            Deep compatibility probe
          </Button>
          {hasPersistedEvidence && onViewCompatibilityDetails && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 gap-1"
              onClick={onViewCompatibilityDetails}
            >
              <Eye className="h-3.5 w-3.5" />
              View saved probe details
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <div className="rounded-md border border-border-default bg-background/70 p-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Server className="h-3.5 w-3.5" />
            Model catalog
          </div>
          <p className="mt-1 text-sm font-medium text-foreground">
            {configuredModels.length === 0
              ? "Not synced"
              : disabledModelCount > 0
                ? `${enabledModels.length} enabled, ${disabledModelCount} disabled`
                : `${enabledModels.length} models`}
          </p>
        </div>
        <div className="rounded-md border border-border-default bg-background/70 p-3">
          <p className="text-xs text-muted-foreground">Default model</p>
          <p className="mt-1 truncate text-sm font-medium text-foreground">
            {selectedModel}
          </p>
        </div>
        <div className="rounded-md border border-border-default bg-background/70 p-3">
          <p className="text-xs text-muted-foreground">Effective protocol</p>
          <p className="mt-1 text-sm font-medium text-foreground">
            {effectiveProtocolLabel}
          </p>
        </div>
        <div className="rounded-md border border-border-default bg-background/70 p-3">
          <p className="text-xs text-muted-foreground">
            Compatibility evidence
          </p>
          <p className="mt-1 text-sm font-medium text-foreground">
            {hasPersistedEvidence
              ? `${adaptation?.models.length ?? 0} models`
              : apiDeclaredModels.length > 0
                ? t("codexProviderReadiness.apiDeclaredModels", {
                    count: apiDeclaredModels.length,
                    defaultValue: "API-declared: {{count}} model(s)",
                  })
                : adaptation
                  ? `${adaptation.models.length} models`
                  : "Not loaded"}
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            {hasPersistedEvidence ||
            (adaptation && apiDeclaredModels.length === 0)
              ? `Evidence time: ${evidenceTime}${evidenceExpired ? " · expired" : ""}`
              : t("codexProviderReadiness.notLiveVerified", {
                  defaultValue: "No live probe verification",
                })}
          </p>
        </div>
      </div>

      {adaptation && adaptation.models.length > 0 && (
        <div
          className="flex flex-wrap gap-2"
          aria-label="Effective model protocol"
        >
          {adaptation.models.map((model) => (
            <span
              key={model.publicModel}
              className="rounded-full border border-border-default bg-background px-2.5 py-1 text-xs text-foreground"
            >
              {model.publicModel}:
              {model.effectiveTransport === "open_ai_responses"
                ? "Responses"
                : model.effectiveTransport === "open_ai_chat"
                  ? "Chat"
                  : "Unconfirmed"}
            </span>
          ))}
        </div>
      )}

      <div className="rounded-md border border-border-default bg-background/70 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-1">
            <p className="text-xs font-medium text-foreground">Readiness</p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {isMaintainedPreset
                ? "Protocol, context, reasoning levels, and the /model catalog are maintained by CCSwitchMulti."
                : t("codexProviderReadiness.automaticCapabilityReadiness", {
                    defaultValue:
                      "Provider API capabilities determine protocol readiness. Deep probing is needed when capability data is missing or incomplete.",
                  })}
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
            Maintained by CCSwitchMulti
          </p>
        )}
        {ready && (
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {validationPassed
              ? t("codexProviderReadiness.liveProbeVerified", {
                  defaultValue: "Live probe verified",
                })
              : t("codexProviderReadiness.apiDeclaredReady", {
                  defaultValue:
                    "API-declared capabilities; credentials and live tool transactions have not been verified.",
                })}
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
