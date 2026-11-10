import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormLabel } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { toast } from "sonner";
import {
  ChevronDown,
  ChevronRight,
  ArrowDown,
  ArrowUp,
  AlertTriangle,
  Plus,
  Trash2,
  RefreshCw,
} from "lucide-react";
import EndpointSpeedTest from "./EndpointSpeedTest";
import { ApiKeySection, EndpointField, ModelDropdown } from "./shared";
import { XaiOAuthSection } from "./XaiOAuthSection";
import {
  fetchModelsForConfig,
  fetchXaiOauthModels,
  fetchCodexOauthModels,
  fetchCodexOfficialFallbackModels,
  showFetchModelsError,
  type FetchedModel,
} from "@/lib/api/model-fetch";
import {
  preflightCodexProviderProtocolCompatibility,
  type CodexProtocolProbeProgressEvent,
  type CodexProviderProtocolPreflightOutcome,
} from "@/lib/api/protocol-compatibility";
import { CodexProtocolProbeProgressDialog } from "./CodexProtocolProbeProgressDialog";
import { CodexProtocolAdvancedSettings } from "./CodexProtocolAdvancedSettings";
import { CustomUserAgentField } from "./CustomUserAgentField";
import { LocalProxyRequestOverridesField } from "./LocalProxyRequestOverridesField";
import { CodexProviderReadinessSection } from "./CodexProviderReadinessSection";
import {
  CodexKeyGroupModels,
  CommaSeparatedListInput,
} from "./CodexKeyGroupModels";
import { CodexCatalogViewport } from "./CodexCatalogViewport";
import { CodexModelReasoningCard } from "./CodexModelReasoningCard";
import { CodexModelReasoningEditor } from "./CodexModelReasoningEditor";
import { CodexModelReasoningSummary } from "./CodexModelReasoningSummary";
import { CodexOfficialContextRow } from "./CodexOfficialContextRow";
import { cn } from "@/lib/utils";
import {
  codexReasoningProviderIdentity,
  resolveCodexCatalogUltraDisplay,
} from "@/lib/codexReasoningProviderIdentity";
import { buildCodexProtocolProbeProviderDraft } from "@/lib/codexProtocolSettings";
import {
  migrateCodexProtocolOverrideKey,
  normalizeCodexPublicModelKey,
  setCodexProtocolOverride,
  type CodexProtocolChoiceInput,
} from "@/lib/protocol-lab/codex-overrides";
import { resolveFetchedCodexModelContextWindow } from "@/utils/codexModelContext";
import {
  catalogModelIdentity,
  isCompleteCodexCatalogFetch,
  isExplicitCodexReasoningCapability,
  reconcileFetchedCodexCatalogRows,
} from "@/lib/codexCatalogReconciliation";
import { enableOnlyConfirmedFreeCatalogModels } from "@/lib/freeModelCatalog";
import { pruneOutdatedCodexCatalogModels } from "@/lib/codexCatalogVersionPruning";
import {
  modelIdentityValues,
  normalizeModelIdentityMetadata,
} from "@/lib/modelIdentities";
import {
  buildCodexInputCapabilityReferenceMap,
  codexInputCapabilityPatch,
  codexInputCapabilityState,
  hydrateCodexInputCapabilities,
} from "./codexInputCapability";
import {
  codexPlanModelListAction,
  codexCatalogOnlyPlanModelFetchMessage,
  isCodexCatalogOnlyPlanModelFetch,
} from "@/utils/codexPlanModelFetch";
import type {
  ClaudeApiKeyField,
  CodexApiKeyGroup,
  CodexApiKeyGroupMode,
  CodexApiFormat,
  CodexCatalogModel,
  CodexChatReasoning,
  CodexModelReasoningCapability,
  CodexReasoningEffort,
  CodexRoutingConfig,
  PromptCacheRoutingMode,
  CodexProtocolMode,
  CodexProtocolOverride,
  CodexReasoningProjection,
  CodexToolSchemaDialect,
  CodexHistoryReplay,
  CodexTrafficPolicy,
  Provider,
  ProviderCategory,
} from "@/types";
import type { CodexProviderEditorSnapshot } from "@/lib/api/protocol-compatibility";
import type { AppId } from "@/lib/api";
import { providersApi } from "@/lib/api/providers";
import { readCodexCatalogSettings } from "@/lib/codexCatalogSchema";
import { codexProviderPresets } from "@/config/codexProviderPresets";
import { codexSubagentV2Api } from "@/lib/api/codexSubagentV2";
import {
  customCodexTrafficPolicySeed,
  normalizeCodexTrafficPolicy,
  resolveCodexTrafficPolicy,
} from "./codexTrafficPolicy";
import type {
  CodexModelReasoningResolution,
  CodexReasoningDiscoveryOutcome,
} from "@/types/codexSubagentV2";

const EMPTY_CODEX_API_KEY_GROUPS: CodexApiKeyGroup[] = [];

interface EndpointCandidate {
  url: string;
}

const PROVIDER_REASONING_EFFORT_CHOICES: CodexReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const ignoreProtocolProbeReceiptIds = (_receiptIds: string[]) => undefined;

export type CodexReasoningCapabilitySourceMode =
  "automatic" | "builtin" | "manual";

export function applyCodexReasoningCapabilitySource(
  mode: CodexReasoningCapabilitySourceMode,
  current?: CodexModelReasoningCapability,
  maintained?: CodexModelReasoningCapability,
  discovered?: CodexModelReasoningCapability,
): CodexModelReasoningCapability | undefined {
  if (mode === "automatic") return undefined;
  if (mode === "builtin") {
    return maintained ? structuredClone(maintained) : undefined;
  }
  const seed = current ?? maintained ?? discovered;
  if (seed) return { ...structuredClone(seed), source: "user" };
  return {
    schemaVersion: 2,
    supportStatus: "confirmed_supported",
    controlKind: "none",
    supportedEfforts: [],
    disableAllowed: false,
    upstream: { format: "none", parameter: "none" },
    source: "user",
  };
}

export function validateCodexReasoningCapabilityDraft(
  capability: CodexModelReasoningCapability,
): void {
  const allowed = new Set<CodexReasoningEffort>(
    PROVIDER_REASONING_EFFORT_CHOICES,
  );
  if (
    !Array.isArray(capability.supportedEfforts) ||
    capability.supportedEfforts.some((effort) => !allowed.has(effort))
  ) {
    throw new Error(
      "Supported reasoning efforts contain an unknown or Codex-only level",
    );
  }
  // schema v2 用 supportStatus；legacy 数据用 supported。至少声明其一，
  // 同时存在时不得矛盾。
  if (
    capability.supportStatus === undefined &&
    typeof capability.supported !== "boolean"
  ) {
    throw new Error("The model must declare whether it supports reasoning");
  }
  if (
    capability.supportStatus !== undefined &&
    typeof capability.supported === "boolean" &&
    (capability.supportStatus === "confirmed_supported") !==
      capability.supported
  ) {
    throw new Error("Legacy and current reasoning support states conflict");
  }
  if (
    capability.defaultEffort !== undefined &&
    !capability.supportedEfforts.includes(capability.defaultEffort)
  ) {
    throw new Error(
      "The default reasoning effort is not supported by the provider",
    );
  }
  if (typeof capability.disableAllowed !== "boolean") {
    throw new Error("Whether reasoning can be disabled must be a boolean");
  }
  if (
    !capability.upstream ||
    typeof capability.upstream.parameter !== "string" ||
    !capability.upstream.parameter.trim()
  ) {
    throw new Error("The upstream reasoning parameter name cannot be empty");
  }
  for (const target of Object.values(capability.upstream.effortMap ?? {})) {
    if (target && !capability.supportedEfforts.includes(target)) {
      throw new Error(
        `Mapping target ${target} is not supported by the provider`,
      );
    }
  }
  const requiresEffortMap =
    (capability.supportStatus !== undefined
      ? capability.supportStatus === "confirmed_supported"
      : capability.supported === true) &&
    (capability.controlKind ??
      (capability.supportedEfforts.length > 0 ? "graded" : "unknown")) ===
      "graded" &&
    capability.upstream.format !== "none" &&
    capability.upstream.format !== "boolean";
  if (requiresEffortMap) {
    const missing = capability.supportedEfforts.filter(
      (effort) => !capability.upstream.effortMap?.[effort],
    );
    if (missing.length > 0) {
      throw new Error(
        `Reasoning-effort mapping is missing ${missing.join(", ")}`,
      );
    }
  }
  if (capability.codexUltraOrchestration?.enabled) {
    const ultraTarget =
      capability.codexUltraOrchestration.providerEffort ??
      capability.upstream.effortMap?.max;
    if (!ultraTarget || !capability.supportedEfforts.includes(ultraTarget)) {
      throw new Error(
        "Unlocking Ultra requires a valid provider reasoning-effort mapping",
      );
    }
  }
}

interface CodexFormFieldsProps {
  codexProviderEditorSnapshot?: CodexProviderEditorSnapshot | null;
  appId?: AppId;
  providerId?: string;
  // 当前表单里的 provider 名称；自动生成混合协议 route 标签时使用。
  providerName?: string;
  /** Current TOML draft: only its selected provider may establish transport identity. */
  codexConfig?: string;
  // xAI OAuth 托管预设（Grok 订阅）：隐藏 API Key / 端点输入，挂账号选择区块
  isXaiOauthPreset?: boolean;
  isMaintainedPreset?: boolean;
  isCanonicalOfficial?: boolean;
  officialAccountId?: string | null;
  officialManagedOAuth?: boolean;
  isXaiOauthAuthenticated?: boolean;
  selectedXaiAccountId?: string | null;
  onXaiAccountSelect?: (accountId: string | null) => void;
  // API Key
  codexApiKey: string;
  onApiKeyChange: (key: string) => void;
  apiKeyGroups?: CodexApiKeyGroup[];
  onApiKeyGroupsChange?: (groups: CodexApiKeyGroup[]) => void;
  apiKeyGroupMode?: CodexApiKeyGroupMode;
  onApiKeyGroupModeChange?: (mode: CodexApiKeyGroupMode) => void;
  codexTrafficPolicy?: CodexTrafficPolicy;
  onCodexTrafficPolicyChange?: (value: CodexTrafficPolicy | undefined) => void;
  category?: ProviderCategory;
  shouldShowApiKeyLink: boolean;
  websiteUrl: string;
  isPartner?: boolean;
  partnerPromotionKey?: string;
  planAccessKeyId?: string;
  planSecretAccessKey?: string;

  // Base URL
  shouldShowSpeedTest: boolean;
  codexBaseUrl: string;
  onBaseUrlChange: (url: string) => void;
  isFullUrl: boolean;
  onFullUrlChange: (value: boolean) => void;
  isEndpointModalOpen: boolean;
  onEndpointModalToggle: (open: boolean) => void;
  onCustomEndpointsChange?: (endpoints: string[]) => void;
  autoSelect: boolean;
  onAutoSelectChange: (checked: boolean) => void;

  // Codex 菜单映射开关；仅控制是否把目录投射到 /model 菜单，不再控制目录/上下文的编辑和保存。
  takeoverEnabled?: boolean;
  onTakeoverEnabledChange?: (enabled: boolean) => void;
  allowModelMenuProjectionToggle?: boolean;

  codexModel?: string;
  onModelChange?: (model: string) => void;

  // API Format
  // Note: wire_api is always "responses" for Codex; apiFormat controls proxy-layer conversion
  apiFormat: CodexApiFormat;
  onApiFormatChange: (format: CodexApiFormat) => void;
  anthropicAuthField?: ClaudeApiKeyField;
  onAnthropicAuthFieldChange?: (value: ClaudeApiKeyField) => void;
  impersonateClaudeCode?: boolean;
  onImpersonateClaudeCodeChange?: (value: boolean) => void;
  maxOutputTokens?: string;
  onMaxOutputTokensChange?: (value: string) => void;
  codexChatReasoning?: CodexChatReasoning;
  onCodexChatReasoningChange?: (value: CodexChatReasoning) => void;
  promptCacheRouting?: PromptCacheRoutingMode;
  onPromptCacheRoutingChange?: (value: PromptCacheRoutingMode) => void;
  protocolMode?: CodexProtocolMode;
  onProtocolModeChange?: (value: CodexProtocolMode) => void;
  protocolOverrides?: Record<string, CodexProtocolOverride>;
  onProtocolOverridesChange?: (
    value: Record<string, CodexProtocolOverride>,
  ) => void;
  reasoningProjection?: CodexReasoningProjection;
  onReasoningProjectionChange?: (value: CodexReasoningProjection) => void;
  toolSchemaDialect?: CodexToolSchemaDialect;
  onToolSchemaDialectChange?: (value: CodexToolSchemaDialect) => void;
  historyReplay?: CodexHistoryReplay;
  onHistoryReplayChange?: (value: CodexHistoryReplay) => void;
  /** Current deep-probe leases for the outer Provider save coordinator. */
  onProtocolProbeReceiptIdsChange?: (receiptIds: string[]) => void;

  // Model Catalog
  catalogModels?: CodexCatalogModel[];
  // Current maintained preset baseline, used only for explicit override/restore.
  presetCatalogModels?: CodexCatalogModel[];
  // Original maintained transport; never replace this with the edited draft endpoint.
  presetConfig?: string;
  // Maintained and saved catalog inventory used only to hydrate missing,
  // unambiguous input-capability metadata.
  knownCatalogModels?: CodexCatalogModel[];
  onCatalogModelsChange?: (models: CodexCatalogModel[]) => void;
  catalogValidationError?: { model: string; message: string } | null;
  saveError?: string | null;
  spawnAgentModels?: string[];
  onSpawnAgentModelsChange?: (models: string[]) => void;
  codexRouting?: CodexRoutingConfig;
  onCodexRoutingChange?: (routing: CodexRoutingConfig) => void;

  // Speed Test Endpoints
  speedTestEndpoints: EndpointCandidate[];

  // Local proxy User-Agent override
  customUserAgent: string;
  onCustomUserAgentChange: (value: string) => void;
  localProxyHeadersOverride: string;
  onLocalProxyHeadersOverrideChange: (value: string) => void;
  localProxyBodyOverride: string;
  onLocalProxyBodyOverrideChange: (value: string) => void;
}

export function CodexFormSaveFeedback({
  catalogValidationError,
  saveError,
}: {
  catalogValidationError?: { model: string; message: string } | null;
  saveError?: string | null;
}) {
  if (!catalogValidationError && !saveError) return null;
  return (
    <div className="space-y-2">
      {catalogValidationError && (
        <div
          role="alert"
          className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive"
        >
          {catalogValidationError.message}
          <span className="mt-1 block text-xs">
            API Key, endpoint, and other edits remain in the current draft, but
            none of these changes were saved.
          </span>
        </div>
      )}
      {saveError && (
        <div
          role="alert"
          className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive"
        >
          {saveError}
          <span className="mt-1 block text-xs">
            API Key and other inputs remain in the current draft and are not
            shown in this error.
          </span>
        </div>
      )}
    </div>
  );
}

export function capabilityFromReasoningDetection(
  outcome: CodexReasoningDiscoveryOutcome,
): CodexModelReasoningCapability | undefined {
  if (typeof outcome !== "object" || !("found" in outcome)) return undefined;
  const reasoning = outcome.found.reasoning;
  if (!reasoning) return undefined;
  const supportedEfforts = reasoning.supportedEfforts.filter(
    (effort): effort is CodexReasoningEffort =>
      ["none", ...PROVIDER_REASONING_EFFORT_CHOICES].includes(effort),
  );
  // A provider can advertise reasoning output without advertising any
  // selectable effort. That is not enough evidence to persist a Codex
  // effort-capability declaration or to guess a boolean wire parameter.
  if (!supportedEfforts.some((effort) => effort !== "none")) return undefined;
  return {
    schemaVersion: 2,
    supportStatus: "confirmed_supported",
    controlKind: supportedEfforts.length > 0 ? "graded" : "boolean",
    supportedEfforts,
    defaultEffort: supportedEfforts.includes(
      reasoning.defaultEffort as CodexReasoningEffort,
    )
      ? (reasoning.defaultEffort as CodexReasoningEffort)
      : undefined,
    disableAllowed: !reasoning.mandatory,
    upstream: {
      format:
        reasoning.upstreamFormat === "object"
          ? "reasoning_object"
          : (reasoning.upstreamFormat ?? "reasoning_object"),
      parameter: reasoning.upstreamParameter ?? "reasoning.effort",
      effortMap: Object.fromEntries(
        supportedEfforts.map((effort) => [effort, effort]),
      ),
    },
    outputFormat: reasoning.outputFormat ?? undefined,
    source: "user_confirmed_detection",
    confidence: "authoritative",
    providerKey: outcome.found.providerKey,
    evidenceScope: outcome.found.evidenceScope ?? undefined,
  };
}

function unknownReasoningResolution(
  model: string,
): CodexModelReasoningResolution {
  return {
    model,
    capability: null,
    source: "unknown",
    fingerprint: "",
    resolved: {
      supportKind: "unknown",
      confidence: "unverified",
      codexSelectableEfforts: [],
      providerAcceptedEfforts: [],
      providerDefaultEffort: null,
      disableAllowed: false,
      effortMap: {},
    },
    hasDetectionCandidate: false,
    detection: null,
  };
}

type CodexCatalogRow = CodexCatalogModel & { rowId: string };

function createCatalogRow(seed?: Partial<CodexCatalogModel>): CodexCatalogRow {
  const inputModalities = seed?.inputModalities ?? seed?.input_modalities;
  const supportsImage =
    seed?.supportsImage ?? seed?.supports_image ?? seed?.vision;
  return {
    rowId: crypto.randomUUID(),
    model: seed?.model ?? "",
    ...normalizeModelIdentityMetadata(seed ?? {}),
    upstreamModel: seed?.upstreamModel ?? seed?.upstream_model ?? "",
    displayName: seed?.displayName ?? "",
    contextWindow: seed?.contextWindow ?? "",
    // Carry native-profile overrides verbatim (not user-editable in the row UI,
    // but must survive load->save so the official catalog fidelity is kept).
    ...(seed?.supportsParallelToolCalls !== undefined
      ? { supportsParallelToolCalls: seed.supportsParallelToolCalls }
      : {}),
    ...(inputModalities !== undefined
      ? { inputModalities: [...inputModalities] }
      : {}),
    ...(supportsImage !== undefined ? { supportsImage } : {}),
    ...((seed?.textOnly ?? seed?.text_only) !== undefined
      ? { textOnly: seed?.textOnly ?? seed?.text_only }
      : {}),
    ...(seed?.baseInstructions
      ? { baseInstructions: seed.baseInstructions }
      : {}),
    ...(seed?.reasoning ? { reasoning: seed.reasoning } : {}),
    ...(seed?.codexUltra ? { codexUltra: seed.codexUltra } : {}),
    ...(seed?.apiFormat ? { apiFormat: seed.apiFormat } : {}),
    ...(seed?.protocolCapability
      ? { protocolCapability: seed.protocolCapability }
      : {}),
    ...(seed?.codexCache ? { codexCache: seed.codexCache } : {}),
    ...(seed?.enabled !== undefined ? { enabled: seed.enabled } : {}),
    ...(seed?.sortIndex !== undefined ? { sortIndex: seed.sortIndex } : {}),
  };
}

function catalogSupportsImage(model: CodexCatalogModel): boolean {
  return codexInputCapabilityState(model) === "text_image";
}

// 读取 catalog 行的真实上游模型名；为空时回退到可见模型名，兼容旧配置。
function catalogRowUpstreamModel(
  row: Pick<CodexCatalogModel, "model" | "upstreamModel" | "upstream_model">,
): string {
  return (
    (row.upstreamModel ?? row.upstream_model ?? "").trim() || row.model.trim()
  );
}

export function selectOnlyDiscoveredCodexCatalogRows<
  T extends CodexCatalogModel,
>(
  rows: readonly T[],
  discoveredModelIds: readonly string[],
): Array<T & { enabled: boolean }> {
  const discoveredIds = new Set(
    discoveredModelIds
      .map((model) => model.trim().toLowerCase())
      .filter(Boolean),
  );
  return rows.map((row) => ({
    ...row,
    // An explicit request binding owns the row; matching only its visible alias
    // must not turn on a model that was not present in this discovery.
    enabled: discoveredIds.has(catalogRowUpstreamModel(row).toLowerCase()),
  }));
}

// Compares rows (with rowId) to incoming models (without) by data fields only,
// so both sync effects can use the same equality definition. Hidden native-profile
// fields are included so switching between providers with identical visible fields
// but different base_instructions / tools / modalities still rebuilds the rows.
function catalogRowsMatchModels(
  rows: Array<
    Pick<
      CodexCatalogRow,
      | "model"
      | "upstreamModel"
      | "upstream_model"
      | "canonicalSlug"
      | "canonical_slug"
      | "slug"
      | "aliases"
      | "name"
      | "displayName"
      | "contextWindow"
      | "supportsParallelToolCalls"
      | "baseInstructions"
      | "inputModalities"
      | "supportsImage"
      | "textOnly"
      | "reasoning"
      | "codexUltra"
      | "apiFormat"
      | "protocolCapability"
      | "codexCache"
      | "enabled"
      | "sortIndex"
    >
  >,
  models: CodexCatalogModel[],
): boolean {
  if (rows.length !== models.length) return false;
  return rows.every((row, i) => {
    const incoming = models[i];
    return (
      row.model === (incoming.model ?? "") &&
      JSON.stringify(normalizeModelIdentityMetadata(row)) ===
        JSON.stringify(normalizeModelIdentityMetadata(incoming)) &&
      catalogRowUpstreamModel(row) === catalogRowUpstreamModel(incoming) &&
      (row.displayName ?? "") === (incoming.displayName ?? "") &&
      String(row.contextWindow ?? "") ===
        String(incoming.contextWindow ?? "") &&
      (row.supportsParallelToolCalls ?? null) ===
        (incoming.supportsParallelToolCalls ?? null) &&
      (row.baseInstructions ?? "") === (incoming.baseInstructions ?? "") &&
      JSON.stringify(row.inputModalities ?? []) ===
        JSON.stringify(
          incoming.inputModalities ?? incoming.input_modalities ?? [],
        ) &&
      (row.supportsImage ?? null) ===
        (incoming.supportsImage ??
          incoming.supports_image ??
          incoming.vision ??
          null) &&
      (row.textOnly ?? null) ===
        (incoming.textOnly ?? incoming.text_only ?? null) &&
      JSON.stringify(row.reasoning ?? null) ===
        JSON.stringify(incoming.reasoning ?? null) &&
      JSON.stringify(row.codexUltra ?? null) ===
        JSON.stringify(incoming.codexUltra ?? null) &&
      (row.apiFormat ?? null) ===
        (incoming.apiFormat ?? incoming.api_format ?? null) &&
      JSON.stringify(row.protocolCapability ?? null) ===
        JSON.stringify(incoming.protocolCapability ?? null) &&
      JSON.stringify(row.codexCache ?? null) ===
        JSON.stringify(incoming.codexCache ?? incoming.codex_cache ?? null) &&
      (row.enabled ?? true) === (incoming.enabled ?? true) &&
      (row.sortIndex ?? null) === (incoming.sortIndex ?? null)
    );
  });
}

interface CodexProviderReadinessIdentityInput {
  providerId?: string;
  providerName?: string;
  baseUrl: string;
  isFullUrl: boolean;
  apiKey: string;
  isXaiOauthPreset?: boolean;
  isXaiOauthAuthenticated?: boolean;
  selectedXaiAccountId?: string | null;
  partnerPromotionKey?: string;
  planAccessKeyId?: string;
  planSecretAccessKey?: string;
  customUserAgent: string;
  localProxyHeadersOverride: string;
  localProxyBodyOverride: string;
  anthropicAuthField: ClaudeApiKeyField;
  impersonateClaudeCode: boolean;
  maxOutputTokens: string;
  codexChatReasoning: CodexChatReasoning;
  promptCacheRouting: PromptCacheRoutingMode;
  defaultModel: string;
  catalogModels: CodexCatalogModel[];
}

// 连接验证结果只属于发起请求时的完整 Provider 身份。这里保留精确凭据值用于
// 内存内比较，但不会写入日志、DOM 或持久化；catalog 顺序也属于当前配置身份。
function buildCodexProviderReadinessIdentity({
  providerId,
  providerName,
  baseUrl,
  isFullUrl,
  apiKey,
  isXaiOauthPreset,
  isXaiOauthAuthenticated,
  selectedXaiAccountId,
  partnerPromotionKey,
  planAccessKeyId,
  planSecretAccessKey,
  customUserAgent,
  localProxyHeadersOverride,
  localProxyBodyOverride,
  anthropicAuthField,
  impersonateClaudeCode,
  maxOutputTokens,
  codexChatReasoning,
  promptCacheRouting,
  defaultModel,
  catalogModels,
}: CodexProviderReadinessIdentityInput): string {
  return JSON.stringify({
    provider: {
      id: providerId ?? null,
      name: providerName ?? null,
    },
    endpoint: {
      baseUrl: baseUrl.trim(),
      isFullUrl,
    },
    auth: {
      apiKey,
      isXaiOauthPreset: isXaiOauthPreset === true,
      isXaiOauthAuthenticated: isXaiOauthAuthenticated === true,
      selectedXaiAccountId: selectedXaiAccountId ?? null,
      partnerPromotionKey: partnerPromotionKey ?? null,
      planAccessKeyId: planAccessKeyId ?? null,
      planSecretAccessKey: planSecretAccessKey ?? null,
      anthropicAuthField,
    },
    requestOverrides: {
      customUserAgent,
      localProxyHeadersOverride,
      localProxyBodyOverride,
    },
    protocol: {
      impersonateClaudeCode,
      maxOutputTokens,
      codexChatReasoning,
      promptCacheRouting,
    },
    defaultModel: defaultModel.trim(),
    catalog: catalogModels.map((model) => ({
      model: model.model.trim(),
      upstreamModel: catalogRowUpstreamModel(model),
      displayName: (model.displayName ?? model.display_name ?? "").trim(),
      contextWindow: String(model.contextWindow ?? model.context_window ?? ""),
      inputModalities: model.inputModalities ?? model.input_modalities ?? null,
      supportsImage:
        model.supportsImage ?? model.supports_image ?? model.vision ?? null,
      textOnly: model.textOnly ?? model.text_only ?? null,
      supportsParallelToolCalls:
        model.supportsParallelToolCalls ??
        model.supports_parallel_tool_calls ??
        null,
      baseInstructions:
        model.baseInstructions ?? model.base_instructions ?? null,
      reasoning: model.reasoning ?? null,
      codexUltra: model.codexUltra ?? null,
      codexCache: model.codexCache ?? model.codex_cache ?? null,
      protocolCapability: model.protocolCapability ?? null,
      enabled: model.enabled !== false,
      sortIndex: model.sortIndex ?? null,
    })),
  });
}

// 将远端 /models 返回合并进 Codex 模型映射；已有行保留用户显示名和已填上下文，
// 同步服务端明确返回的能力字段，并追加新模型。
function mergeFetchedModelsIntoCatalogRows(
  rows: CodexCatalogRow[],
  fetchedModels: FetchedModel[],
  source: {
    providerId?: string;
    providerName?: string;
    baseUrl?: string;
    websiteUrl?: string;
  } = {},
  authoritative = false,
): CodexCatalogRow[] {
  const result = reconcileFetchedCodexCatalogRows(rows, fetchedModels, source, {
    appendNew: true,
    createRow: (seed) => createCatalogRow(seed),
    existingMetadataMode: authoritative ? "refresh" : "fill-missing",
    removeMissingRemote: authoritative,
    includeUnboundRemoteRows: true,
    markMissingRemoteDisabled: true,
  });
  return result.rows;
}

/** Bind only fresh maintained constants to their original, trusted transport. */
export async function bindFreshCodexPresetCatalogReasoning(
  config: string,
  models: CodexCatalogModel[],
): Promise<CodexCatalogModel[]> {
  const settings = await providersApi.bindCodexPresetReasoningEvidence({
    config,
    modelCatalog: { models: structuredClone(models) },
  });
  const catalog = readCodexCatalogSettings(settings);
  if (!catalog || !Array.isArray(catalog.models)) {
    throw new Error("Invalid fresh maintained preset catalog");
  }
  return catalog.models as CodexCatalogModel[];
}

/** Apply a model edit without turning a public alias rename into a wire rename. */
export function updateCodexCatalogRowModelBinding<T extends CodexCatalogModel>(
  row: T,
  patch: Partial<CodexCatalogModel>,
  fetched?: FetchedModel,
): T {
  const next = { ...row, ...patch };
  if (
    patch.model !== undefined &&
    patch.upstreamModel === undefined &&
    patch.upstream_model === undefined
  ) {
    const previousVisibleModel = row.model.trim();
    const previousUpstreamModel = catalogRowUpstreamModel(row);
    if (
      previousVisibleModel &&
      (!previousUpstreamModel || previousUpstreamModel === previousVisibleModel)
    ) {
      next.upstreamModel = previousVisibleModel;
    }
  }
  const previousWireModel = catalogRowUpstreamModel(row).trim().toLowerCase();
  const nextWireModel = catalogRowUpstreamModel(next).trim().toLowerCase();
  const hasExplicitReasoning = isExplicitCodexReasoningCapability(
    row.reasoning,
  );
  if (
    !hasExplicitReasoning &&
    !Object.prototype.hasOwnProperty.call(patch, "reasoning") &&
    (previousWireModel !== nextWireModel || fetched !== undefined)
  ) {
    // A provider declaration is evidence about its wire model, not the menu
    // alias. Never attach model A's automatic efforts to a newly bound B.
    // Keep the fetched evidenceScope intact for the shared backend resolver.
    if (fetched?.reasoning) next.reasoning = fetched.reasoning;
    else delete next.reasoning;
  }
  return next;
}

export function CodexFormFields({
  codexProviderEditorSnapshot = null,
  appId = "codex",
  providerId,
  providerName,
  codexConfig = "",
  isXaiOauthPreset,
  isMaintainedPreset = false,
  isCanonicalOfficial = false,
  officialAccountId = null,
  officialManagedOAuth = false,
  isXaiOauthAuthenticated,
  selectedXaiAccountId,
  onXaiAccountSelect,
  codexApiKey,
  onApiKeyChange,
  apiKeyGroups = EMPTY_CODEX_API_KEY_GROUPS,
  onApiKeyGroupsChange,
  apiKeyGroupMode = "isolated",
  onApiKeyGroupModeChange,
  codexTrafficPolicy,
  onCodexTrafficPolicyChange = () => undefined,
  category,
  shouldShowApiKeyLink,
  websiteUrl,
  isPartner,
  partnerPromotionKey,
  planAccessKeyId,
  planSecretAccessKey,
  shouldShowSpeedTest,
  codexBaseUrl,
  onBaseUrlChange,
  isFullUrl,
  onFullUrlChange,
  isEndpointModalOpen,
  onEndpointModalToggle,
  onCustomEndpointsChange,
  autoSelect,
  onAutoSelectChange,
  takeoverEnabled = false,
  onTakeoverEnabledChange = () => undefined,
  allowModelMenuProjectionToggle = true,
  codexModel = "",
  onModelChange,
  apiFormat,
  onApiFormatChange,
  anthropicAuthField = "ANTHROPIC_AUTH_TOKEN",
  onAnthropicAuthFieldChange = () => undefined,
  impersonateClaudeCode = false,
  onImpersonateClaudeCodeChange = () => undefined,
  maxOutputTokens = "",
  onMaxOutputTokensChange = () => undefined,
  codexChatReasoning = {},
  onCodexChatReasoningChange,
  promptCacheRouting = "auto",
  onPromptCacheRoutingChange = () => undefined,
  protocolMode = "auto",
  onProtocolModeChange = () => undefined,
  protocolOverrides = {},
  onProtocolOverridesChange = () => undefined,
  reasoningProjection = "none",
  onReasoningProjectionChange = () => undefined,
  toolSchemaDialect = "openai",
  onToolSchemaDialectChange = () => undefined,
  historyReplay = "native_only",
  onHistoryReplayChange = () => undefined,
  onProtocolProbeReceiptIdsChange = ignoreProtocolProbeReceiptIds,
  catalogModels = [],
  presetCatalogModels = [],
  presetConfig,
  knownCatalogModels = [],
  onCatalogModelsChange,
  catalogValidationError = null,
  saveError = null,
  speedTestEndpoints,
  customUserAgent,
  onCustomUserAgentChange,
  localProxyHeadersOverride,
  onLocalProxyHeadersOverrideChange,
  localProxyBodyOverride,
  onLocalProxyBodyOverrideChange,
}: CodexFormFieldsProps) {
  const { t } = useTranslation();

  // Request inputs stay in memory only. Opaque generations avoid serializing
  // credentials and prevent A -> B -> A from reviving A's old model directory.
  const modelFetchIdentity = useMemo(
    () => Symbol("codex-model-discovery"),
    [
      providerId,
      providerName,
      codexBaseUrl,
      isFullUrl,
      codexApiKey,
      customUserAgent,
      partnerPromotionKey,
      planAccessKeyId,
      planSecretAccessKey,
      apiKeyGroups,
      apiKeyGroupMode,
      websiteUrl,
      isXaiOauthPreset,
      isXaiOauthAuthenticated,
      selectedXaiAccountId,
      isCanonicalOfficial,
      officialAccountId,
      officialManagedOAuth,
    ],
  );
  const modelFetchOwnershipRef = useRef({
    identity: modelFetchIdentity,
    sequence: 0,
    mounted: false,
  });
  const [modelDiscoveryState, setModelDiscoveryState] = useState(() => ({
    identity: modelFetchIdentity,
    models: [] as FetchedModel[],
    fetching: false,
  }));
  const fetchedModels =
    modelDiscoveryState.identity === modelFetchIdentity
      ? modelDiscoveryState.models
      : [];
  const isFetchingModels =
    modelDiscoveryState.identity === modelFetchIdentity &&
    modelDiscoveryState.fetching;

  useLayoutEffect(() => {
    const owner = modelFetchOwnershipRef.current;
    owner.identity = modelFetchIdentity;
    owner.mounted = true;
    setModelDiscoveryState((previous) =>
      previous.identity === modelFetchIdentity
        ? previous
        : { identity: modelFetchIdentity, models: [], fetching: false },
    );
    return () => {
      // Invalidate committed ownership before queued promise callbacks run,
      // while leaving abandoned renders unable to cancel the mounted owner.
      owner.mounted = false;
      owner.sequence += 1;
    };
  }, [modelFetchIdentity]);

  const beginModelFetch = useCallback(() => {
    const owner = modelFetchOwnershipRef.current;
    if (!owner.mounted || owner.identity !== modelFetchIdentity) return null;
    const sequence = ++owner.sequence;
    const isCurrent = () =>
      owner.mounted &&
      owner.identity === modelFetchIdentity &&
      owner.sequence === sequence;
    return {
      isCurrent,
      start: () =>
        setModelDiscoveryState((previous) =>
          isCurrent() ? { ...previous, fetching: true } : previous,
        ),
      setModels: (models: FetchedModel[]) =>
        setModelDiscoveryState((previous) =>
          isCurrent()
            ? { identity: modelFetchIdentity, models, fetching: true }
            : previous,
        ),
      finish: () =>
        setModelDiscoveryState((previous) =>
          isCurrent() ? { ...previous, fetching: false } : previous,
        ),
    };
  }, [modelFetchIdentity]);
  const [reasoningResolutionState, setReasoningResolutionState] = useState<{
    contextKey: string;
    models: Record<string, CodexModelReasoningResolution>;
  }>({ contextKey: "", models: {} });
  const [redetectingReasoningModel, setRedetectingReasoningModel] = useState<
    string | null
  >(null);
  const reasoningResolutionRequestRef = useRef(0);
  const reasoningDetectionRequestRef = useRef(0);
  const [isProtocolProbeConfirmOpen, setIsProtocolProbeConfirmOpen] =
    useState(false);
  const [isProbingProtocol, setIsProbingProtocol] = useState(false);
  const [protocolProbeSummary, setProtocolProbeSummary] = useState("");
  const [protocolProbeTone, setProtocolProbeTone] = useState<
    "muted" | "success" | "warning" | "error"
  >("muted");
  const [isProtocolProbeProgressOpen, setIsProtocolProbeProgressOpen] =
    useState(false);
  const [protocolProbeEvents, setProtocolProbeEvents] = useState<
    CodexProtocolProbeProgressEvent[]
  >([]);
  const [protocolProbeExpectedModels, setProtocolProbeExpectedModels] =
    useState<string[]>([]);
  const [protocolProbeOutcome, setProtocolProbeOutcome] =
    useState<CodexProviderProtocolPreflightOutcome | null>(null);
  const [protocolProbeError, setProtocolProbeError] = useState("");
  const [protocolProbeIdentity, setProtocolProbeIdentity] = useState<
    string | null
  >(null);
  const protocolProbeIdentityRef = useRef<string | null>(null);
  const protocolProbeSeqRef = useRef(0);
  const [shouldHighlightFetchModels, setShouldHighlightFetchModels] =
    useState(false);
  // 思考能力随 Chat 格式显示（仅 Chat Completions 转换路径用得上）；模型映射常驻
  //（填了才生成 catalog）。两者都已与「路由接管」概念解耦。
  const isChatFormat = apiFormat === "openai_chat";
  const isAnthropicFormat = apiFormat === "anthropic";
  const canEditCatalog = Boolean(onCatalogModelsChange);

  useEffect(() => {
    if (!catalogValidationError) return;
    document
      .getElementById("codex-catalog-validation-row")
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [catalogValidationError]);

  // 普通 Provider 表单只消费并原样回传历史 codexRouting；可见编辑入口统一收口到
  // CodexRouterWorkspacePage，避免与完整 MultiRouter 工作台形成两套配置界面。
  const canEditReasoning = Boolean(onCodexChatReasoningChange);
  const supportsThinking =
    codexChatReasoning.supportsThinking === true ||
    codexChatReasoning.supportsEffort === true;
  const supportsEffort = codexChatReasoning.supportsEffort === true;
  const hasLegacyProviderReasoningConfig =
    Object.keys(codexChatReasoning).length > 0;
  // 高级区在有任何可见配置时自动展开；只做折叠到展开，避免编辑旧 provider 时藏起关键状态。
  const hasRequestOverrides = Boolean(
    localProxyHeadersOverride.trim() || localProxyBodyOverride.trim(),
  );
  const hasAnyAdvancedValue =
    !!customUserAgent ||
    hasRequestOverrides ||
    (!isMaintainedPreset &&
      (isAnthropicFormat || supportsThinking || supportsEffort)) ||
    promptCacheRouting !== "auto" ||
    protocolMode === "manual" ||
    !!maxOutputTokens;
  const [advancedExpanded, setAdvancedExpanded] = useState(
    isXaiOauthPreset ? false : hasAnyAdvancedValue,
  );
  const [catalogMountElement, setCatalogMountElement] =
    useState<HTMLDivElement | null>(null);
  const resolvedTrafficPolicy = useMemo(
    () => resolveCodexTrafficPolicy(codexBaseUrl, codexTrafficPolicy),
    [codexBaseUrl, codexTrafficPolicy],
  );
  const updateTrafficPolicy = useCallback(
    (patch: Partial<CodexTrafficPolicy>) => {
      onCodexTrafficPolicyChange(
        normalizeCodexTrafficPolicy({
          ...(codexTrafficPolicy ?? customCodexTrafficPolicySeed(codexBaseUrl)),
          ...patch,
        }),
      );
    },
    [codexBaseUrl, codexTrafficPolicy, onCodexTrafficPolicyChange],
  );

  // 预设/编辑加载填充高级值后自动展开（仅从折叠→展开，不会自动折叠）；
  // xAI OAuth 托管预设的高级值都是预设自带的，无需展示，保持折叠
  useEffect(() => {
    if (isXaiOauthPreset) {
      return;
    }
    if (hasAnyAdvancedValue) {
      setAdvancedExpanded(true);
    }
  }, [hasAnyAdvancedValue, isXaiOauthPreset]);

  const inputCapabilityReferences = useMemo(
    () =>
      buildCodexInputCapabilityReferenceMap([
        presetCatalogModels,
        knownCatalogModels,
      ]),
    [knownCatalogModels, presetCatalogModels],
  );
  const [catalogRows, setCatalogRows] = useState<CodexCatalogRow[]>(() =>
    hydrateCodexInputCapabilities(
      catalogModels.map((model) => createCatalogRow(model)),
      inputCapabilityReferences,
    ),
  );
  const [selectedCatalogRowIds, setSelectedCatalogRowIds] = useState<
    Set<string>
  >(() => new Set());
  const [revealedCatalogRowId, setRevealedCatalogRowId] = useState<string>();
  const apiKeyGroupsRef = useRef(apiKeyGroups);
  apiKeyGroupsRef.current = apiKeyGroups;
  const hasLegacyMixedProtocolCatalog = useMemo(() => {
    let hasResponses = false;
    let hasChat = false;
    for (const row of catalogRows) {
      if (row.enabled === false) continue;
      if (row.apiFormat === "openai_responses") hasResponses = true;
      if (row.apiFormat === "openai_chat") hasChat = true;
      if (hasResponses && hasChat) return true;
    }
    return false;
  }, [catalogRows]);
  const [expandedReasoningRowId, setExpandedReasoningRowId] = useState<
    string | null
  >(null);
  const [visibleReasoningModels, setVisibleReasoningModels] = useState<
    string[]
  >([]);

  const catalogViewportItems = useMemo(
    () => catalogRows.map((row, index) => ({ row, index })),
    [catalogRows],
  );
  const includedCatalogViewportItems = useMemo(
    () => catalogViewportItems.filter(({ row }) => row.enabled !== false),
    [catalogViewportItems],
  );
  const includedModelOptions = useMemo(() => {
    if (catalogRows.length === 0) return fetchedModels;
    const fetchedByIdentity = new Map<
      string,
      FetchedModel & { isFree?: boolean | null }
    >();
    for (const fetched of fetchedModels) {
      for (const identity of modelIdentityValues(fetched)) {
        if (!fetchedByIdentity.has(identity)) {
          fetchedByIdentity.set(identity, fetched);
        }
      }
    }
    return catalogRows
      .filter((row) => row.enabled !== false && row.model.trim())
      .map((row) => {
        const fetched = modelIdentityValues(row)
          .map((identity) => fetchedByIdentity.get(identity))
          .find(Boolean);
        return {
          id: row.model,
          ownedBy: null,
          ...(typeof fetched?.isFree === "boolean"
            ? { isFree: fetched.isFree }
            : {}),
        };
      });
  }, [catalogRows, fetchedModels]);

  const reasoningSettingsConfig = useMemo(
    () => ({
      // The backend resolver needs the draft endpoint/name to select a
      // platform-specific maintained capability entry before the provider is
      // saved.
      providerName: providerName?.trim() || "",
      base_url: codexBaseUrl.trim(),
      config: codexConfig,
      modelCatalog: {
        models: catalogRows.filter((row) => row.enabled !== false),
      },
    }),
    [catalogRows, codexBaseUrl, codexConfig, providerName],
  );
  const reasoningDetectionProvider = useMemo<Provider>(
    () => ({
      id: providerId ?? "codex-draft",
      name: providerName?.trim() || "Codex provider",
      settingsConfig: {
        base_url: codexBaseUrl.trim(),
        config: codexConfig,
      },
      category,
    }),
    [providerId, providerName, codexBaseUrl, codexConfig, category],
  );
  const reasoningProviderIdentity = useMemo(
    () => codexReasoningProviderIdentity(reasoningDetectionProvider),
    [reasoningDetectionProvider],
  );

  // Product-level Ultra is a UI overlay on a provider capability. It may
  // trigger a fresh resolver call, but must not evict the native capability
  // snapshot between the checkbox and its provider-effort selection.
  const reasoningContextKey = JSON.stringify(
    {
      providerId: providerId ?? "codex-draft",
      settings: reasoningSettingsConfig,
    },
    (key, value) => (key === "codexUltra" ? undefined : value),
  );
  const reasoningContextKeyRef = useRef(reasoningContextKey);
  reasoningContextKeyRef.current = reasoningContextKey;
  const reasoningResolutions =
    reasoningResolutionState.contextKey === reasoningContextKey
      ? reasoningResolutionState.models
      : {};

  useEffect(() => {
    reasoningDetectionRequestRef.current += 1;
    setRedetectingReasoningModel(null);
    return () => {
      reasoningDetectionRequestRef.current += 1;
    };
  }, [reasoningContextKey]);

  useEffect(() => {
    const visibleModelSet = new Set(visibleReasoningModels);
    const models = catalogRows
      .filter((row) => row.enabled !== false)
      .map((row) => row.model.trim())
      .filter((model) => model && visibleModelSet.has(model));
    if (models.length === 0) {
      setReasoningResolutionState({
        contextKey: reasoningContextKey,
        models: {},
      });
      return;
    }
    const requestId = ++reasoningResolutionRequestRef.current;
    let cancelled = false;
    void Promise.all(
      models.map(async (model) => {
        try {
          return [
            model,
            await codexSubagentV2Api.resolveModelReasoningCapability(
              reasoningSettingsConfig,
              providerId ?? "codex-draft",
              model,
            ),
          ] as const;
        } catch {
          console.warn("[CodexFormFields] reasoning resolution failed", {
            model,
          });
          return [model, unknownReasoningResolution(model)] as const;
        }
      }),
    ).then((results) => {
      if (cancelled || requestId !== reasoningResolutionRequestRef.current) {
        return;
      }
      const next: Record<string, CodexModelReasoningResolution> = {};
      for (const result of results) {
        if (result) next[result[0]] = result[1];
      }
      setReasoningResolutionState({
        contextKey: reasoningContextKey,
        models: next,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [
    catalogRows,
    providerId,
    reasoningSettingsConfig,
    reasoningContextKey,
    visibleReasoningModels,
  ]);

  const handleVisibleReasoningItemsChange = useCallback(
    (items: { row: CodexCatalogRow; index: number }[]) => {
      const next = Array.from(
        new Set(items.map(({ row }) => row.model.trim()).filter(Boolean)),
      );
      setVisibleReasoningModels((current) =>
        current.length === next.length &&
        current.every((model, index) => model === next[index])
          ? current
          : next,
      );
    },
    [],
  );
  const catalogRowsRef = useRef<CodexCatalogRow[]>(catalogRows);
  const modelMappingSectionRef = useRef<HTMLDivElement | null>(null);
  const fetchModelsButtonRef = useRef<HTMLButtonElement | null>(null);
  // 记录上次发送给父组件的数据，避免重复触发
  const lastSentModelsRef = useRef<CodexCatalogModel[]>(catalogModels);
  const catalogPropKeyRef = useRef(JSON.stringify(catalogModels));
  const pendingCatalogSyncRef = useRef<CodexCatalogModel[] | null>(null);

  const repairDefaultModel = useCallback(
    (rows: readonly CodexCatalogRow[]) => {
      if (!onModelChange) return;
      const currentDefault = codexModel.trim().toLowerCase();
      const enabledRows = rows.filter((row) => row.enabled !== false);
      const currentDefaultStillEnabled = enabledRows.some((row) =>
        modelIdentityValues(row).includes(currentDefault),
      );
      if (currentDefaultStillEnabled) return;
      const nextDefault = enabledRows[0]
        ? enabledRows[0].model.trim() ||
          catalogRowUpstreamModel(enabledRows[0]).trim()
        : "";
      if (nextDefault !== codexModel) onModelChange(nextDefault);
    },
    [codexModel, onModelChange],
  );

  const reconcileProtocolOverrides = useCallback(
    (rows: readonly CodexCatalogRow[]) => {
      if (!onProtocolOverridesChange) return;
      const validModels = new Set(
        rows
          .map((row) => normalizeCodexPublicModelKey(row.model))
          .filter(Boolean),
      );
      const nextOverrides = Object.fromEntries(
        Object.entries(protocolOverrides).filter(([model]) =>
          validModels.has(normalizeCodexPublicModelKey(model)),
        ),
      );
      if (JSON.stringify(nextOverrides) !== JSON.stringify(protocolOverrides)) {
        onProtocolOverridesChange(nextOverrides);
      }
    },
    [onProtocolOverridesChange, protocolOverrides],
  );

  const commitCatalogRows = useCallback(
    (
      updater: (current: CodexCatalogRow[]) => CodexCatalogRow[],
      options: {
        repairDefault?: boolean;
        reconcileProtocolOverrides?: boolean;
      } = {},
    ) => {
      const nextRows = updater(catalogRowsRef.current);
      catalogRowsRef.current = nextRows;
      setCatalogRows(nextRows);
      if (options.repairDefault) repairDefaultModel(nextRows);
      if (options.reconcileProtocolOverrides)
        reconcileProtocolOverrides(nextRows);
      return nextRows;
    },
    [reconcileProtocolOverrides, repairDefaultModel],
  );

  // 保留最新的模型映射行给异步刷新回调用，避免点击“获取模型列表”时合并到旧闭包里的 catalogRows。
  useEffect(() => {
    catalogRowsRef.current = catalogRows;
  }, [catalogRows]);

  useEffect(() => {
    const validIds = new Set(catalogRows.map((row) => row.rowId));
    setSelectedCatalogRowIds((current) => {
      const next = new Set([...current].filter((id) => validIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [catalogRows]);

  const buildReadinessIdentityFor = useCallback(
    (nextCatalogModels: CodexCatalogModel[]) =>
      buildCodexProviderReadinessIdentity({
        providerId,
        providerName,
        baseUrl: codexBaseUrl,
        isFullUrl,
        apiKey: codexApiKey,
        isXaiOauthPreset,
        isXaiOauthAuthenticated,
        selectedXaiAccountId,
        partnerPromotionKey,
        planAccessKeyId,
        planSecretAccessKey,
        customUserAgent,
        localProxyHeadersOverride,
        localProxyBodyOverride,
        anthropicAuthField,
        impersonateClaudeCode,
        maxOutputTokens,
        codexChatReasoning,
        promptCacheRouting,
        defaultModel: codexModel,
        catalogModels: nextCatalogModels,
      }),
    [
      anthropicAuthField,
      codexApiKey,
      codexBaseUrl,
      codexChatReasoning,
      codexModel,
      customUserAgent,
      impersonateClaudeCode,
      isFullUrl,
      isXaiOauthAuthenticated,
      isXaiOauthPreset,
      localProxyBodyOverride,
      localProxyHeadersOverride,
      maxOutputTokens,
      partnerPromotionKey,
      planAccessKeyId,
      planSecretAccessKey,
      promptCacheRouting,
      providerId,
      providerName,
      selectedXaiAccountId,
    ],
  );
  const readinessIdentity = useMemo(
    () => buildReadinessIdentityFor(catalogRows),
    [buildReadinessIdentityFor, catalogRows],
  );
  const snapshotReadinessIdentityRef = useRef<{
    snapshot: CodexProviderEditorSnapshot;
    identity: string;
  } | null>(null);
  if (
    codexProviderEditorSnapshot &&
    snapshotReadinessIdentityRef.current?.snapshot !==
      codexProviderEditorSnapshot
  ) {
    snapshotReadinessIdentityRef.current = {
      snapshot: codexProviderEditorSnapshot,
      identity: readinessIdentity,
    };
  } else if (!codexProviderEditorSnapshot) {
    snapshotReadinessIdentityRef.current = null;
  }
  const readinessIdentityRef = useRef(readinessIdentity);
  readinessIdentityRef.current = readinessIdentity;
  const bindProtocolProbeIdentity = useCallback((identity: string) => {
    protocolProbeIdentityRef.current = identity;
    setProtocolProbeIdentity(identity);
  }, []);

  // 任一身份输入变化都立即使旧结果失效并取消其 UI ownership。异步请求本身可以
  // 自然结束，但 sequence/identity guard 会阻止旧进度与最终结果回写到新配置。
  useEffect(() => {
    if (protocolProbeIdentityRef.current !== readinessIdentity) {
      protocolProbeSeqRef.current += 1;
      protocolProbeIdentityRef.current = null;
      setProtocolProbeIdentity(null);
      setIsProbingProtocol(false);
      setIsProtocolProbeConfirmOpen(false);
      setIsProtocolProbeProgressOpen(false);
      setProtocolProbeTone("muted");
      setProtocolProbeSummary("");
      setProtocolProbeEvents([]);
      setProtocolProbeExpectedModels([]);
      setProtocolProbeOutcome(null);
      setProtocolProbeError("");
      onProtocolProbeReceiptIdsChange([]);
    }
  }, [onProtocolProbeReceiptIdsChange, readinessIdentity]);

  const isProtocolProbeStateCurrent =
    protocolProbeIdentity === readinessIdentity;
  const snapshotAdaptation = codexProviderEditorSnapshot?.adaptation ?? null;
  const displayedAdaptation =
    isProtocolProbeStateCurrent && protocolProbeOutcome?.adaptationPreview
      ? protocolProbeOutcome.adaptationPreview
      : snapshotAdaptation
        ? snapshotReadinessIdentityRef.current?.identity === readinessIdentity
          ? snapshotAdaptation
          : { ...snapshotAdaptation, status: "stale" as const }
        : null;
  const storedProtocolRecords = useMemo(() => {
    if (isProtocolProbeStateCurrent && protocolProbeOutcome) return [];
    const records = (displayedAdaptation?.models ?? []).flatMap((model) =>
      [model.responses, model.chat].filter(
        (record): record is NonNullable<typeof record> => record !== null,
      ),
    );
    const unique = new Map<string, (typeof records)[number]>();
    for (const record of records) {
      const target = record.target;
      const key = [
        target.provider_id,
        target.route_id ?? "",
        target.public_model,
        target.upstream_model,
        target.transport,
        target.endpoint_fingerprint,
        target.credential_fingerprint,
        target.request_policy_fingerprint,
        record.testedAt,
      ].join("\u0000");
      unique.set(key, record);
    }
    return [...unique.values()];
  }, [displayedAdaptation, isProtocolProbeStateCurrent, protocolProbeOutcome]);
  const revealModelCatalogFetchAction = useCallback(() => {
    bindProtocolProbeIdentity(readinessIdentity);
    setProtocolProbeTone("warning");
    setProtocolProbeSummary(
      "Sync models in “Models and compatibility” first, or enable/add at least one model in Advanced settings before validating.",
    );
    setShouldHighlightFetchModels(true);
    window.setTimeout(() => {
      modelMappingSectionRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
      fetchModelsButtonRef.current?.focus({ preventScroll: true });
    }, 0);
    window.setTimeout(() => setShouldHighlightFetchModels(false), 3000);
  }, [bindProtocolProbeIdentity, readinessIdentity]);

  // 父 → 子：仅当 prop 数据真的变化（预设切换 / 编辑加载）时才重建 rowId；
  // 同 shape 时保留现有 rowId，避免编辑过程中焦点丢失。
  useEffect(() => {
    const incomingCatalogKey = JSON.stringify(catalogModels);
    const isExternalCatalogChange =
      incomingCatalogKey !== catalogPropKeyRef.current;
    catalogPropKeyRef.current = incomingCatalogKey;
    if (isExternalCatalogChange) {
      const syncedRows = hydrateCodexInputCapabilities(
        catalogModels.map((model) => createCatalogRow(model)),
        inputCapabilityReferences,
      );
      // Gate stale echoes before React can defer the state updater. Compare
      // against hydrated rows so normalization cannot permanently block edits.
      pendingCatalogSyncRef.current = syncedRows;
      setCatalogRows((current) =>
        catalogRowsMatchModels(current, syncedRows) ? current : syncedRows,
      );
    }
    // 同步更新 ref，避免父组件传入新数据时子→父 effect 误判为本地修改
    lastSentModelsRef.current = catalogModels;
  }, [catalogModels, inputCapabilityReferences]);

  // 子 → 父：rowId 是视图层概念，不应进入持久化数据；剥离后再回传。
  // 注意：依赖数组不包含 catalogModels，避免父→子更新触发子→父回调形成循环。
  useEffect(() => {
    if (!onCatalogModelsChange) return;
    // 外部 catalog 同步进来时先等本地 rowId 重建完成，再允许子组件回写。
    if (pendingCatalogSyncRef.current) {
      if (!catalogRowsMatchModels(catalogRows, pendingCatalogSyncRef.current))
        return;
      pendingCatalogSyncRef.current = null;
    }
    const next: CodexCatalogModel[] = catalogRows.map(
      ({ rowId: _rowId, ...rest }) => rest,
    );
    // 只有当数据真的变化时才通知父组件
    if (catalogRowsMatchModels(catalogRows, lastSentModelsRef.current)) return;
    lastSentModelsRef.current = next;
    onCatalogModelsChange(next);
  }, [catalogRows, catalogModels, onCatalogModelsChange]);

  const handleReasoningThinkingChange = useCallback(
    (checked: boolean) => {
      if (!onCodexChatReasoningChange) return;
      onCodexChatReasoningChange({
        ...codexChatReasoning,
        supportsThinking: checked,
        supportsEffort: checked ? codexChatReasoning.supportsEffort : false,
      });
    },
    [codexChatReasoning, onCodexChatReasoningChange],
  );

  const handleReasoningEffortChange = useCallback(
    (checked: boolean) => {
      if (!onCodexChatReasoningChange) return;
      onCodexChatReasoningChange({
        ...codexChatReasoning,
        supportsThinking: checked ? true : codexChatReasoning.supportsThinking,
        supportsEffort: checked,
        effortParam: checked
          ? (codexChatReasoning.effortParam ?? "reasoning_effort")
          : "none",
      });
    },
    [codexChatReasoning, onCodexChatReasoningChange],
  );

  const handleFetchModels = useCallback(() => {
    const request = beginModelFetch();
    if (!request) return;
    if (isCanonicalOfficial) {
      // Bind account limits to an observed account identity. A null ID would
      // let the backend select a changing default outside this request key.
      if (officialManagedOAuth && !officialAccountId?.trim()) return;
      request.start();
      const modelsRequest = officialManagedOAuth
        ? fetchCodexOauthModels(officialAccountId)
        : fetchCodexOfficialFallbackModels();
      modelsRequest
        .then((models) => {
          if (!request.isCurrent()) return;
          request.setModels(models);
          // Official account/default/max context values remain discovery-only
          // UI metadata, not persisted overrides. Refresh all other explicit
          // capability metadata through the same canonical reconciliation as
          // other provider catalogs while retaining existing inclusion choices.
          const metadataModels = models
            .filter((fetched) => {
              const fetchedId = fetched.id.trim().toLowerCase();
              if (!fetchedId) return false;
              // A user-visible alias with an unrelated explicit upstream binding
              // remains the same row; do not append a second row merely because
              // the account directory also lists the visible alias as an ID.
              const existing = catalogRowsRef.current.find(
                (row) => row.model.trim().toLowerCase() === fetchedId,
              );
              if (!existing) return true;
              const upstream = catalogRowUpstreamModel(existing).toLowerCase();
              if (!upstream || upstream === fetchedId) return true;
              return modelIdentityValues(fetched).includes(upstream);
            })
            .map((fetched) => ({
              ...fetched,
              contextWindow: undefined,
            }));
          const { rows } = reconcileFetchedCodexCatalogRows(
            catalogRowsRef.current,
            metadataModels,
            { providerId, providerName, baseUrl: codexBaseUrl, websiteUrl },
            {
              appendNew: true,
              createRow: (seed) => createCatalogRow(seed),
              existingMetadataMode: "refresh",
              removeMissingRemote: false,
              newRowEnabled: true,
              inferContextWindow: false,
            },
          );
          commitCatalogRows(() => rows, { repairDefault: true });
          if (models.length === 0) {
            toast.info(t("providerForm.fetchModelsEmpty"));
          } else {
            toast.success(
              t("providerForm.fetchModelsSuccess", { count: models.length }),
            );
          }
        })
        .catch(() => {
          if (!request.isCurrent()) return;
          // The selected account remains authoritative even when discovery
          // fails; never silently substitute a public catalog or log auth data.
          toast.error(t("codexConfig.officialCatalogFailed"));
        })
        .finally(() => {
          request.finish();
        });
      return;
    }
    // xAI OAuth 托管预设不使用表单里的 Base URL 与 API Key。
    if (isXaiOauthPreset) {
      if (!isXaiOauthAuthenticated) {
        toast.error(
          t("xaiOauth.loginRequired", {
            defaultValue: "Sign in to your xAI account first",
          }),
        );
        return;
      }
      request.start();
      fetchXaiOauthModels(selectedXaiAccountId ?? null)
        .then(async (models) => {
          if (!request.isCurrent()) return;
          // The OAuth directory does not advertise effort controls. Regenerate
          // current maintained evidence from the fresh xAI constant, not from
          // this provider's old automatic declarations or edited endpoint.
          const preset = codexProviderPresets.find(
            (candidate) => candidate.presetKey === "xai-grok-oauth",
          );
          const fetchedIds = new Set(
            models.map((model) => catalogModelIdentity(model.id)),
          );
          const currentPresetRows = (preset?.modelCatalog ?? []).filter(
            (row) =>
              row.reasoning &&
              fetchedIds.has(
                catalogModelIdentity(catalogRowUpstreamModel(row)),
              ),
          );
          if (preset && currentPresetRows.length > 0) {
            const baseline = await bindFreshCodexPresetCatalogReasoning(
              preset.config,
              currentPresetRows,
            );
            if (!request.isCurrent()) return;
            models = models.map((model) => ({
              ...model,
              reasoning:
                model.reasoning ??
                baseline.find(
                  (row) =>
                    catalogModelIdentity(catalogRowUpstreamModel(row)) ===
                    catalogModelIdentity(model.id),
                )?.reasoning,
            }));
          }
          request.setModels(models);
          if (onCatalogModelsChange) {
            const rows = mergeFetchedModelsIntoCatalogRows(
              catalogRowsRef.current,
              models,
              { providerId, providerName, baseUrl: codexBaseUrl, websiteUrl },
              true,
            );
            commitCatalogRows(() => rows, { repairDefault: true });
          }
          if (models.length === 0) {
            toast.info(t("providerForm.fetchModelsEmpty"));
          } else {
            toast.success(
              t("providerForm.fetchModelsSuccess", { count: models.length }),
            );
          }
        })
        .catch((err) => {
          if (!request.isCurrent()) return;
          console.warn("[XaiOAuth] Failed to fetch models");
          showFetchModelsError(err, t);
        })
        .finally(() => {
          request.finish();
        });
      return;
    }

    const planFetchSource = {
      baseUrl: codexBaseUrl,
      partnerPromotionKey,
      providerName,
      apiKey: codexApiKey,
      accessKeyId: planAccessKeyId,
      secretAccessKey: planSecretAccessKey,
    };
    const planModelListAction = codexPlanModelListAction(planFetchSource);
    const isCatalogOnlyPlan = isCodexCatalogOnlyPlanModelFetch(planFetchSource);
    if (isCatalogOnlyPlan) {
      const hasModelCatalog = catalogRowsRef.current.some((row) =>
        row.model.trim(),
      );
      const message = codexCatalogOnlyPlanModelFetchMessage(
        hasModelCatalog,
        planFetchSource,
      );
      if (hasModelCatalog) {
        toast.info(message);
      } else {
        toast.warning(message);
      }
      return;
    }

    if (!codexBaseUrl || (!codexApiKey && !planModelListAction)) {
      showFetchModelsError(null, t, {
        hasApiKey: !!codexApiKey,
        hasBaseUrl: !!codexBaseUrl,
      });
      return;
    }
    request.start();
    fetchModelsForConfig(
      codexBaseUrl,
      codexApiKey,
      isFullUrl,
      undefined,
      customUserAgent,
      planModelListAction
        ? {
            action: planModelListAction,
            accessKeyId: planAccessKeyId ?? "",
            secretAccessKey: planSecretAccessKey ?? "",
          }
        : undefined,
    )
      .then((models) => {
        if (!request.isCurrent()) return;
        request.setModels(models);
        if (onCatalogModelsChange) {
          const mergedRows = mergeFetchedModelsIntoCatalogRows(
            catalogRowsRef.current,
            models,
            {
              providerId,
              providerName,
              baseUrl: codexBaseUrl,
              websiteUrl,
            },
            isCompleteCodexCatalogFetch(apiKeyGroups),
          );
          commitCatalogRows(() => mergedRows, { repairDefault: true });
        }
        if (models.length === 0) {
          toast.info(t("providerForm.fetchModelsEmpty"));
        } else {
          toast.success(
            t("providerForm.fetchModelsSuccess", { count: models.length }),
          );
        }
      })
      .catch((err) => {
        if (!request.isCurrent()) return;
        console.warn("[ModelFetch] Failed");
        showFetchModelsError(err, t);
      })
      .finally(() => {
        request.finish();
      });
  }, [
    beginModelFetch,
    apiKeyGroups,
    codexBaseUrl,
    codexApiKey,
    isFullUrl,
    customUserAgent,
    providerId,
    providerName,
    partnerPromotionKey,
    planAccessKeyId,
    planSecretAccessKey,
    websiteUrl,
    onCatalogModelsChange,
    commitCatalogRows,
    isXaiOauthPreset,
    isXaiOauthAuthenticated,
    selectedXaiAccountId,
    isCanonicalOfficial,
    officialAccountId,
    officialManagedOAuth,
    t,
  ]);

  const confirmedFreeModelCount = useMemo(
    () => fetchedModels.filter((model) => model.isFree === true).length,
    [fetchedModels],
  );
  const canUseFreeModelsOnly = isCompleteCodexCatalogFetch(apiKeyGroups);
  const handleUseFreeModelsOnly = useCallback(() => {
    if (!onCatalogModelsChange) return;
    const confirmedFreeModels = fetchedModels.filter(
      (model) => model.isFree === true,
    );
    if (confirmedFreeModels.length === 0) {
      toast.info(
        t("codexConfig.noConfirmedFreeModels", {
          defaultValue:
            "No models were explicitly confirmed as free by this provider.",
        }),
      );
      return;
    }
    if (!isCompleteCodexCatalogFetch(apiKeyGroupsRef.current)) {
      toast.info(
        t("codexConfig.freeModelsRequiresCompleteFetch", {
          defaultValue:
            "Use free models only after syncing a complete provider catalog.",
        }),
      );
      return;
    }

    const nextRows = enableOnlyConfirmedFreeCatalogModels(
      catalogRowsRef.current,
      confirmedFreeModels,
    );
    const enabledRows = nextRows.filter((row) => row.enabled !== false);
    if (enabledRows.length === 0) {
      toast.info(
        t("codexConfig.noConfirmedFreeCatalogMatches", {
          defaultValue:
            "The provider returned free models, but none matched the current catalog.",
        }),
      );
      return;
    }
    commitCatalogRows(() => nextRows, { repairDefault: true });
    toast.success(
      t("codexConfig.freeModelsOnlyApplied", {
        count: enabledRows.length,
        defaultValue: `Enabled ${enabledRows.length} confirmed free model(s).`,
      }),
    );
  }, [fetchedModels, onCatalogModelsChange, commitCatalogRows, t]);

  const handleUseOnlyDiscoveredModels = useCallback(() => {
    if (!onCatalogModelsChange) return;
    if (!isCompleteCodexCatalogFetch(apiKeyGroupsRef.current)) {
      toast.info(
        t("codexConfig.discoveredModelsRequiresCompleteFetch", {
          defaultValue:
            "Use this action only after syncing a complete provider catalog; grouped credentials may expose different model lists.",
        }),
      );
      return;
    }
    const discoveredIds = fetchedModels
      .flatMap((model) => modelIdentityValues(model))
      .filter(Boolean);
    if (discoveredIds.length === 0) {
      toast.info(
        t("codexConfig.noDiscoveredModels", {
          defaultValue: "Sync a model list first.",
        }),
      );
      return;
    }

    const nextRows = selectOnlyDiscoveredCodexCatalogRows(
      catalogRowsRef.current,
      discoveredIds,
    );
    const enabledCount = nextRows.filter((row) => row.enabled !== false).length;
    commitCatalogRows(() => nextRows, { repairDefault: true });
    toast.success(
      t("codexConfig.useOnlyDiscoveredModelsApplied", {
        count: enabledCount,
        defaultValue:
          "Enabled {{count}} model(s) returned by the latest API sync; older rows remain excluded in the catalog.",
      }),
    );
  }, [fetchedModels, onCatalogModelsChange, commitCatalogRows, t]);

  const handleReplaceCatalogFromDiscovery = useCallback(() => {
    if (!onCatalogModelsChange) return;
    if (!isCompleteCodexCatalogFetch(apiKeyGroupsRef.current)) {
      toast.info(
        t("codexConfig.discoveredModelsRequiresCompleteFetch", {
          defaultValue:
            "Use this action only after syncing a complete provider catalog; grouped credentials may expose different model lists.",
        }),
      );
      return;
    }
    if (fetchedModels.length === 0) {
      toast.info(
        t("codexConfig.noDiscoveredModels", {
          defaultValue: "Sync a model list first.",
        }),
      );
      return;
    }

    const result = reconcileFetchedCodexCatalogRows(
      [],
      fetchedModels,
      { providerId, providerName, baseUrl: codexBaseUrl, websiteUrl },
      {
        appendNew: true,
        createRow: (seed) => createCatalogRow(seed),
        existingMetadataMode: "refresh",
        removeMissingRemote: true,
        includeUnboundRemoteRows: true,
        markMissingRemoteDisabled: false,
        newRowEnabled: true,
        contextWindowFormat: "string",
        inferContextWindow: false,
      },
    );
    const nextRows = commitCatalogRows(() => result.rows, {
      repairDefault: true,
      reconcileProtocolOverrides: true,
    });
    toast.success(
      t("codexConfig.replaceCatalogApplied", {
        count: nextRows.length,
        defaultValue: "Rebuilt the catalog from {{count}} synced model(s).",
      }),
    );
  }, [
    codexBaseUrl,
    fetchedModels,
    onCatalogModelsChange,
    providerId,
    providerName,
    commitCatalogRows,
    t,
    websiteUrl,
  ]);

  const handleProtocolProbe = useCallback(async () => {
    if (!codexBaseUrl || !codexApiKey) {
      showFetchModelsError(null, t, {
        hasApiKey: !!codexApiKey,
        hasBaseUrl: !!codexBaseUrl,
      });
      return;
    }
    const probeModels = catalogRowsRef.current
      .filter(
        (row) =>
          row.enabled !== false &&
          (row.model.trim() || catalogRowUpstreamModel(row)),
      )
      .map((row) => {
        const { rowId: _rowId, ...model } = row;
        const publicModel =
          model.model.trim() || catalogRowUpstreamModel(model);
        return {
          ...model,
          model: publicModel,
          upstreamModel: catalogRowUpstreamModel(model) || publicModel,
        };
      });
    if (probeModels.length === 0) {
      setIsProtocolProbeConfirmOpen(false);
      toast.warning(
        "Click “Fetch model list” first, or add at least one model manually.",
      );
      revealModelCatalogFetchAction();
      return;
    }

    const probeIdentity = readinessIdentity;
    const probeSeq = ++protocolProbeSeqRef.current;
    const ownsCurrentIdentity = () =>
      probeSeq === protocolProbeSeqRef.current &&
      readinessIdentityRef.current === probeIdentity;
    bindProtocolProbeIdentity(probeIdentity);
    setIsProtocolProbeConfirmOpen(false);
    setIsProtocolProbeProgressOpen(true);
    setIsProbingProtocol(true);
    setProtocolProbeTone("muted");
    setProtocolProbeEvents([]);
    setProtocolProbeExpectedModels(probeModels.map((model) => model.model));
    setProtocolProbeOutcome(null);
    setProtocolProbeError("");
    setProtocolProbeSummary(
      `Deep-testing ${probeModels.length} model(s) across Responses / Chat, SSE, reasoning content, tool calls, and tool continuations.`,
    );
    try {
      const defaultModel =
        codexModel?.trim() ||
        probeModels[0].model ||
        probeModels[0].upstreamModel;
      const providerDraft: Provider = buildCodexProtocolProbeProviderDraft({
        providerId,
        providerName: providerName?.trim() || "Codex provider",
        baseUrl: codexBaseUrl,
        apiKey: codexApiKey,
        apiFormat,
        isFullUrl,
        defaultModel,
        models: probeModels,
        websiteUrl: websiteUrl || undefined,
        category,
        customUserAgent,
        localProxyHeadersOverride,
        localProxyBodyOverride,
        takeoverEnabled,
        codexChatReasoning,
        promptCacheRouting,
        protocolMode,
        reasoningProjection,
        toolSchemaDialect,
        historyReplay,
      });
      const outcome = await preflightCodexProviderProtocolCompatibility(
        providerDraft,
        (event) => {
          if (!ownsCurrentIdentity()) return;
          setProtocolProbeEvents((current) => [...current, event]);
        },
        "all_enabled_models",
      );
      if (!ownsCurrentIdentity()) return;
      const returnedModels = new Set(
        outcome.records.map((record) => record.target.public_model.trim()),
      );
      const missingModels = probeModels
        .map((model) => model.model.trim())
        .filter((model) => !returnedModels.has(model));
      if (missingModels.length > 0) {
        throw new Error(
          `The backend returned no probe result for enabled model(s): ${missingModels.join(", ")}`,
        );
      }
      setProtocolProbeOutcome(outcome);
      const verifiedRecords = outcome.records.filter(
        (record) =>
          record.result.readiness === "verified" &&
          record.result.selected_transport !== null,
      );
      const allVerified =
        outcome.records.length > 0 &&
        verifiedRecords.length === outcome.records.length;
      // A receipt is an automatic-save lease, not a record of an attempted
      // probe. Partial/failed batches cannot produce an executable Provider
      // Set, so passing their receipts to the save coordinator traps the form
      // in the blocked preview and prevents the explicit unverified-save path
      // from being used. Keep receipts only when every enabled model has a
      // verified transport selection.
      onProtocolProbeReceiptIdsChange(allVerified ? outcome.receiptIds : []);
      const allResponses =
        allVerified &&
        verifiedRecords.every(
          (record) => record.result.selected_transport === "open_ai_responses",
        );
      const allChat =
        allVerified &&
        verifiedRecords.every(
          (record) => record.result.selected_transport === "open_ai_chat",
        );
      const verified = outcome.records.filter(
        (record) => record.result.readiness === "verified",
      ).length;
      const partial = outcome.records.filter(
        (record) => record.result.readiness === "partial",
      ).length;
      const failed = outcome.records.length - verified - partial;
      const resultCounts = `Verified ${verified}, Partial ${partial}, Failed ${failed}`;

      if (allResponses) {
        const resultIdentity = buildReadinessIdentityFor(
          catalogRowsRef.current,
        );
        bindProtocolProbeIdentity(resultIdentity);
        const summary = `Deep probe complete: all models selected Responses; ${resultCounts}.`;
        const tone = failed > 0 || partial > 0 ? "warning" : "success";
        setProtocolProbeTone(tone);
        setProtocolProbeSummary(summary);
        if (tone === "warning") {
          toast.warning(summary, { closeButton: true });
        } else {
          toast.success(summary, { closeButton: true });
        }
        return;
      }
      if (allChat) {
        const resultIdentity = buildReadinessIdentityFor(
          catalogRowsRef.current,
        );
        bindProtocolProbeIdentity(resultIdentity);
        const summary = `Deep probe complete: all models selected Chat Completions; ${resultCounts}.`;
        const tone = failed > 0 || partial > 0 ? "warning" : "success";
        setProtocolProbeTone(tone);
        setProtocolProbeSummary(summary);
        if (tone === "warning") {
          toast.warning(summary, { closeButton: true });
        } else {
          toast.success(summary, { closeButton: true });
        }
        return;
      }

      const hasMixedVerifiedTransports =
        verifiedRecords.some(
          (record) => record.result.selected_transport === "open_ai_responses",
        ) &&
        verifiedRecords.some(
          (record) => record.result.selected_transport === "open_ai_chat",
        );
      const summary =
        allVerified && hasMixedVerifiedTransports
          ? `Deep probe complete: different models selected different protocols; ${resultCounts}. Saving will split them into two same-protocol providers while keeping them as one model source.`
          : `Deep probe complete: some models are Partial/Failed, so automatic protocol selection is unavailable; ${resultCounts}. Saving will use the declared protocol without deep verification. Review the failed stages and retry when you want automatic selection.`;
      const resultIdentity = buildReadinessIdentityFor(catalogRowsRef.current);
      bindProtocolProbeIdentity(resultIdentity);
      const tone = allVerified
        ? "success"
        : verifiedRecords.length > 0
          ? "warning"
          : "error";
      setProtocolProbeTone(tone);
      setProtocolProbeSummary(summary);
      if (tone === "success") {
        toast.success(summary, { closeButton: true });
      } else if (tone === "warning") {
        toast.warning(summary, { closeButton: true });
      } else {
        toast.error(summary, { closeButton: true });
      }
    } catch (error) {
      if (!ownsCurrentIdentity()) return;
      onProtocolProbeReceiptIdsChange([]);
      const detail = error instanceof Error ? error.message : String(error);
      const summary = `Protocol probe interrupted: ${detail}`;
      bindProtocolProbeIdentity(probeIdentity);
      setProtocolProbeTone("error");
      setProtocolProbeSummary(summary);
      setProtocolProbeError(detail);
      toast.error(summary, { closeButton: true });
    } finally {
      if (probeSeq === protocolProbeSeqRef.current) {
        setIsProbingProtocol(false);
      }
    }
  }, [
    bindProtocolProbeIdentity,
    buildReadinessIdentityFor,
    codexBaseUrl,
    codexApiKey,
    codexModel,
    apiFormat,
    category,
    codexChatReasoning,
    isFullUrl,
    localProxyBodyOverride,
    localProxyHeadersOverride,
    onApiFormatChange,
    onProtocolProbeReceiptIdsChange,
    providerName,
    providerId,
    readinessIdentity,
    reasoningProjection,
    revealModelCatalogFetchAction,
    t,
    takeoverEnabled,
    toolSchemaDialect,
    historyReplay,
    protocolMode,
    promptCacheRouting,
    customUserAgent,
    websiteUrl,
  ]);

  const handleAddCatalogRow = useCallback(() => {
    if (!onCatalogModelsChange) return;
    const row = createCatalogRow();
    commitCatalogRows((current) => [...current, row]);
    setRevealedCatalogRowId(row.rowId);
  }, [commitCatalogRows, onCatalogModelsChange]);

  const handlePruneOutdatedCatalogRows = useCallback(() => {
    // Use the full inventory to identify newer releases, but never delete an
    // explicitly excluded row from the editable catalog.
    const result = pruneOutdatedCodexCatalogModels(catalogRowsRef.current);
    const prunedIds = new Set(
      result.pruned
        .filter((row) => row.enabled !== false)
        .map((row) => row.rowId),
    );
    if (prunedIds.size === 0) {
      toast.info(t("catalogBrowser.noOutdated"));
      return;
    }
    commitCatalogRows(
      (current) => current.filter((row) => !prunedIds.has(row.rowId)),
      { repairDefault: true, reconcileProtocolOverrides: true },
    );
    toast.success(t("catalogBrowser.pruned", { count: prunedIds.size }));
  }, [commitCatalogRows, t]);

  const handleUpdateCatalogRow = useCallback(
    (index: number, patch: Partial<CodexCatalogModel>) => {
      const previousModel = catalogRowsRef.current[index]?.model ?? "";
      if (patch.model !== undefined && patch.model !== previousModel) {
        onProtocolOverridesChange(
          migrateCodexProtocolOverrideKey(
            protocolOverrides,
            previousModel,
            patch.model,
          ),
        );
      }
      commitCatalogRows(
        (current) =>
          current.map((row, i) => {
            if (i !== index) return row;
            const patchedWire = catalogRowUpstreamModel({ ...row, ...patch });
            const isBindingEdit =
              patch.model !== undefined ||
              patch.upstreamModel !== undefined ||
              patch.upstream_model !== undefined;
            const fetched = isBindingEdit
              ? fetchedModels.find(
                  (model) =>
                    model.id.trim().toLowerCase() ===
                    patchedWire.trim().toLowerCase(),
                )
              : undefined;
            return updateCodexCatalogRowModelBinding(row, patch, fetched);
          }),
        {
          // A single-row switch/edit must keep the default model and its
          // included-only projections aligned just like bulk catalog actions.
          repairDefault:
            patch.enabled !== undefined || patch.model !== undefined,
        },
      );
    },
    [
      commitCatalogRows,
      fetchedModels,
      onProtocolOverridesChange,
      protocolOverrides,
    ],
  );

  const handleUpdateCatalogReasoningJson = useCallback(
    (index: number, value: string) => {
      const trimmed = value.trim();
      if (!trimmed) {
        handleUpdateCatalogRow(index, { reasoning: undefined });
        return;
      }
      try {
        const reasoning = JSON.parse(trimmed) as CodexCatalogModel["reasoning"];
        if (!reasoning) {
          throw new Error(
            "Reasoning capability configuration must be an object",
          );
        }
        validateCodexReasoningCapabilityDraft(reasoning);
        handleUpdateCatalogRow(index, {
          reasoning: { ...reasoning, source: "user" },
        });
      } catch (error) {
        toast.error(
          `Invalid reasoning capability JSON; the draft was not changed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    [handleUpdateCatalogRow],
  );

  const reasoningRestoreSequenceRef = useRef(new Map<string, number>());
  const handleRestoreBuiltinReasoning = useCallback(
    async (index: number) => {
      const row = catalogRowsRef.current[index];
      if (!row || !presetConfig) return;
      const owner = modelFetchOwnershipRef.current;
      const identity = modelFetchIdentity;
      const sequence =
        (reasoningRestoreSequenceRef.current.get(row.rowId) ?? 0) + 1;
      reasoningRestoreSequenceRef.current.set(row.rowId, sequence);
      const wire = catalogModelIdentity(catalogRowUpstreamModel(row));
      const originalReasoning = row.reasoning;
      const current = () =>
        owner.mounted &&
        owner.identity === identity &&
        reasoningRestoreSequenceRef.current.get(row.rowId) === sequence;
      try {
        const baseline = await bindFreshCodexPresetCatalogReasoning(
          presetConfig,
          presetCatalogModels,
        );
        if (!current()) return;
        const reasoning = baseline.find(
          (candidate) =>
            catalogModelIdentity(catalogRowUpstreamModel(candidate)) === wire,
        )?.reasoning;
        if (!reasoning) return;
        commitCatalogRows((rows) =>
          rows.map((candidate) =>
            candidate.rowId === row.rowId &&
            catalogModelIdentity(catalogRowUpstreamModel(candidate)) === wire &&
            candidate.reasoning === originalReasoning
              ? { ...candidate, reasoning }
              : candidate,
          ),
        );
      } catch {
        if (current()) toast.error(t("providerForm.codexPresetPrepareFailed"));
      }
    },
    [
      commitCatalogRows,
      modelFetchIdentity,
      presetCatalogModels,
      presetConfig,
      t,
    ],
  );

  const presetReasoningByModel = useMemo(() => {
    const entries: Array<
      readonly [string, NonNullable<CodexCatalogModel["reasoning"]>]
    > = [];
    for (const model of presetCatalogModels) {
      if (!model.reasoning) continue;
      const visible = model.model.trim();
      const upstream = catalogRowUpstreamModel(model);
      if (visible) entries.push([visible, model.reasoning]);
      if (upstream && upstream !== visible) {
        entries.push([upstream, model.reasoning]);
      }
    }
    return new Map(entries);
  }, [presetCatalogModels]);

  const presetCatalogByModel = useMemo(() => {
    const entries = new Map<string, CodexCatalogModel>();
    for (const model of presetCatalogModels) {
      const visible = model.model.trim();
      const upstream = catalogRowUpstreamModel(model);
      if (visible) entries.set(visible, model);
      if (upstream && upstream !== visible) entries.set(upstream, model);
    }
    return entries;
  }, [presetCatalogModels]);

  const handleSelectFetchedCatalogModel = useCallback(
    (
      index: number,
      modelId: string,
      currentVisibleModel?: string,
      currentDisplayName?: string,
    ) => {
      const fetched = fetchedModels.find((model) => model.id === modelId);
      const contextWindow = fetched
        ? resolveFetchedCodexModelContextWindow(fetched, {
            providerId,
            baseUrl: codexBaseUrl,
            websiteUrl,
            existingModels: catalogRows,
          })
        : undefined;

      handleUpdateCatalogRow(index, {
        model: currentVisibleModel?.trim() ? currentVisibleModel : modelId,
        upstreamModel: modelId,
        displayName: currentDisplayName?.trim() ? currentDisplayName : modelId,
        ...(contextWindow ? { contextWindow: String(contextWindow) } : {}),
        ...(Array.isArray(fetched?.inputModalities)
          ? { inputModalities: [...fetched.inputModalities] }
          : {}),
        ...(typeof fetched?.supportsImage === "boolean"
          ? { supportsImage: fetched.supportsImage }
          : {}),
      });
    },
    [
      catalogRows,
      codexBaseUrl,
      fetchedModels,
      handleUpdateCatalogRow,
      providerId,
      websiteUrl,
    ],
  );

  const handleRemoveCatalogRow = useCallback(
    (index: number) => {
      commitCatalogRows((current) => current.filter((_, i) => i !== index), {
        repairDefault: true,
        reconcileProtocolOverrides: true,
      });
    },
    [commitCatalogRows],
  );

  // 移动模型目录行本身；单 provider 表格里的顺序代表保留下来的模型展示/路由顺序，不再混用子 Agent 候选顺序。
  const handleMoveCatalogRow = useCallback(
    (index: number, direction: -1 | 1) => {
      commitCatalogRows((current) => {
        const targetIndex = index + direction;
        if (index < 0 || targetIndex < 0 || targetIndex >= current.length) {
          return current;
        }
        const next = [...current];
        [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
        return next;
      });
    },
    [commitCatalogRows],
  );

  const renderCatalogActionButtons = (onAdd: () => void, addLabel: string) => (
    <div className="flex gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onAdd}
        className="h-7 gap-1"
      >
        <Plus className="h-3.5 w-3.5" />
        {addLabel}
      </Button>
    </div>
  );

  return (
    <>
      <Dialog
        open={isProtocolProbeConfirmOpen}
        onOpenChange={setIsProtocolProbeConfirmOpen}
      >
        <DialogContent className="max-w-lg" zIndex="top">
          <DialogHeader>
            <DialogTitle>Confirm Chat / Responses probe</DialogTitle>
            <DialogDescription className="space-y-2 text-left">
              <span className="block">
                This probe helps determine whether the provider should use
                Responses or Chat Completions. It sends real requests to models
                in the current catalog, consumes tokens, may incur charges or
                rate limits, and shows upstream-reported token usage and
                estimated cost when complete.
              </span>
              <span className="block">
                If there is no model catalog yet, click “Fetch model list” in
                “Model catalog and context” above, or add at least one model
                manually.
              </span>
              <span className="block">
                Each model is tested against its Responses and Chat Completions
                endpoints for a baseline response, SSE streaming, reasoning
                content, forced tool calls, and tool-result continuation. Up to
                8 small requests are sent per model, with a maximum output of
                128 tokens per request.
              </span>
              <span className="block">
                The page shows the current model, protocol, and failed stage in
                real time. If neither endpoint works, the issue may be the API
                Key, Base URL, model permissions, quota, network, rate limits,
                or an upstream outage rather than the protocol itself.
              </span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsProtocolProbeConfirmOpen(false)}
            >
              Cancel
            </Button>
            <Button type="button" onClick={handleProtocolProbe}>
              Confirm probe
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <CodexProtocolProbeProgressDialog
        open={isProtocolProbeProgressOpen}
        running={isProbingProtocol}
        expectedModels={protocolProbeExpectedModels}
        events={protocolProbeEvents}
        outcome={protocolProbeOutcome}
        storedRecords={storedProtocolRecords}
        manualSelections={Object.fromEntries(
          Object.entries(protocolOverrides).map(([model, choice]) => [
            model,
            choice === "openai_chat" ? "open_ai_chat" : "open_ai_responses",
          ]),
        )}
        error={protocolProbeError}
        onOpenChange={setIsProtocolProbeProgressOpen}
        onSelectTransport={({ model, transport, readiness }) => {
          const override =
            transport === "open_ai_chat" ? "openai_chat" : "openai_responses";
          onProtocolOverridesChange(
            setCodexProtocolOverride(protocolOverrides, model, override),
          );
          const transportName =
            transport === "open_ai_chat" ? "Chat Completions" : "Responses";
          if (readiness === "verified") {
            toast.success(
              `${model} selected ${transportName}; it takes effect after saving the provider.`,
            );
          } else {
            toast.warning(
              `${model} will use ${transportName} manually; detected capability gaps are retained and the choice takes effect after saving the provider.`,
            );
          }
        }}
        onRetry={() => {
          setIsProtocolProbeProgressOpen(false);
          setIsProtocolProbeConfirmOpen(true);
        }}
      />

      {hasLegacyMixedProtocolCatalog && (
        <div
          role="status"
          className="flex gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-amber-900 dark:text-amber-100"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-1">
            <div className="text-sm font-medium">
              Legacy mixed-protocol configuration; revalidation and migration
              required
            </div>
            <p className="text-xs leading-relaxed opacity-90">
              The current catalog still stores a protocol per model. A normal
              save reruns the dual-protocol deep probe and normalizes the result
              into one single-protocol provider, or one facade with two
              same-protocol internal leaves; the top-level protocol remains
              authoritative until migration completes.
            </p>
          </div>
        </div>
      )}

      {/* xAI OAuth 认证（Grok 订阅托管账号） */}
      {isXaiOauthPreset && (
        <XaiOAuthSection
          selectedAccountId={selectedXaiAccountId}
          onAccountSelect={onXaiAccountSelect}
        />
      )}

      {isCanonicalOfficial && canEditCatalog && (
        <section className="space-y-3 border-t border-border-default pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-sm font-medium">
                {t("codexConfig.officialContextTitle")}
              </h3>
              <p className="break-words text-xs text-muted-foreground">
                {officialManagedOAuth
                  ? `${t("codexConfig.officialAccountCatalog")} (${officialAccountId ?? t("codexConfig.officialDefaultAccount")})`
                  : t("codexConfig.officialPublicCatalog")}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={
                isFetchingModels ||
                (officialManagedOAuth && !officialAccountId?.trim())
              }
              onClick={handleFetchModels}
            >
              <RefreshCw className="mr-1 h-3.5 w-3.5" />
              {isFetchingModels
                ? t("codexConfig.officialCatalogFetching")
                : t("codexConfig.officialCatalogFetch")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("codexConfig.officialContextTokenBudget")}
          </p>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {t("codexConfig.officialModelSelectionHint", {
                count: catalogRows.filter((row) => row.enabled !== false)
                  .length,
                defaultValue:
                  "Select the models to keep in Codex /model ({{count}} enabled). Uncheck old models to remove them from the menu.",
              })}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isFetchingModels || fetchedModels.length === 0}
              onClick={() => {
                commitCatalogRows(
                  (current) =>
                    selectOnlyDiscoveredCodexCatalogRows(
                      current,
                      fetchedModels.map((model) => model.id),
                    ),
                  { repairDefault: true },
                );
              }}
            >
              {t("codexConfig.officialSelectDiscovered", {
                defaultValue: "Enable only models found in this discovery",
              })}
            </Button>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm">
              {t("codexConfig.officialMenuProjection")}
            </span>
            <Switch
              checked={takeoverEnabled}
              onCheckedChange={onTakeoverEnabledChange}
              aria-label={t("codexConfig.officialMenuProjection")}
            />
          </div>
          {catalogRows.map((row, index) => (
            <CodexOfficialContextRow
              key={row.rowId}
              model={row.model}
              upstreamModel={catalogRowUpstreamModel(row)}
              value={String(row.contextWindow ?? "")}
              maximumIsTrusted={officialManagedOAuth}
              enabled={row.enabled !== false}
              onEnabledChange={(enabled) =>
                handleUpdateCatalogRow(index, { enabled })
              }
              discovered={fetchedModels.find(
                (item) =>
                  item.id.trim().toLowerCase() ===
                  catalogRowUpstreamModel(row).toLowerCase(),
              )}
              onChange={(contextWindow) =>
                handleUpdateCatalogRow(index, { contextWindow })
              }
            />
          ))}
        </section>
      )}

      {/* Codex API Key 输入框（托管 OAuth 预设无需 Key） */}
      {!isXaiOauthPreset && (
        <ApiKeySection
          id="codexApiKey"
          label="API Key"
          value={codexApiKey}
          onChange={onApiKeyChange}
          category={category}
          shouldShowLink={shouldShowApiKeyLink}
          websiteUrl={websiteUrl}
          isPartner={isPartner}
          partnerPromotionKey={partnerPromotionKey}
          placeholder={{
            official: t("providerForm.codexOfficialNoApiKey", {
              defaultValue: "Official providers do not require an API Key",
            }),
            thirdParty: t("providerForm.codexApiKeyAutoFill", {
              defaultValue:
                "Enter an API Key; it will be filled into the configuration automatically",
            }),
          }}
        />
      )}

      {category !== "official" && onApiKeyGroupsChange ? (
        <section className="space-y-3 rounded-lg border border-border-default p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <FormLabel>{t("codexConfig.apiKeyGroupsTitle")}</FormLabel>
              <p className="text-xs text-muted-foreground">
                {t("codexConfig.apiKeyGroupsHint")}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                onApiKeyGroupsChange([
                  ...apiKeyGroups,
                  {
                    id: `group-${apiKeyGroups.length + 1}`,
                    apiKeys: [],
                    strategy: "fixed",
                  },
                ])
              }
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              {t("codexConfig.apiKeyGroupsAdd")}
            </Button>
          </div>
          {apiKeyGroups.map((group, index) => (
            <div
              key={`${group.id}-${index}`}
              className="space-y-2 rounded-md border p-3"
            >
              <div className="grid gap-2 md:grid-cols-[1fr_1fr_auto]">
                <Input
                  value={group.id}
                  aria-label={t("codexConfig.apiKeyGroupId")}
                  placeholder={t("codexConfig.apiKeyGroupId")}
                  onChange={(event) => {
                    const next = [...apiKeyGroups];
                    next[index] = { ...group, id: event.target.value };
                    onApiKeyGroupsChange(next);
                  }}
                />
                <CommaSeparatedListInput
                  type="password"
                  values={group.apiKeys}
                  label={t("codexConfig.apiKeyGroupKey")}
                  onChange={(apiKeys) => {
                    const next = [...apiKeyGroups];
                    next[index] = { ...group, apiKeys };
                    onApiKeyGroupsChange(next);
                  }}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t("codexConfig.apiKeyGroupRemove")}
                  onClick={() =>
                    onApiKeyGroupsChange(
                      apiKeyGroups.filter((_, item) => item !== index),
                    )
                  }
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              <CodexKeyGroupModels
                group={group}
                baseUrl={codexBaseUrl}
                isFullUrl={isFullUrl}
                customUserAgent={customUserAgent}
                onChange={(nextGroup) => {
                  const next = apiKeyGroupsRef.current.map((item) =>
                    item.id === group.id ? nextGroup : item,
                  );
                  apiKeyGroupsRef.current = next;
                  onApiKeyGroupsChange(next);
                }}
                onModelsFetched={(models) => {
                  const mergedRows = mergeFetchedModelsIntoCatalogRows(
                    catalogRowsRef.current,
                    models,
                    {
                      providerId,
                      providerName,
                      baseUrl: codexBaseUrl,
                      websiteUrl,
                    },
                  );
                  commitCatalogRows(() => mergedRows, { repairDefault: true });
                }}
              />
              <div className="flex items-center gap-2">
                <Switch
                  checked={group.enabled !== false}
                  aria-label={t("codexConfig.apiKeyGroupEnabled")}
                  onCheckedChange={(enabled) => {
                    const next = [...apiKeyGroups];
                    next[index] = { ...group, enabled };
                    onApiKeyGroupsChange(next);
                  }}
                />
                <span className="text-xs text-muted-foreground">
                  {t("codexConfig.apiKeyGroupEnabled")}
                </span>
              </div>
            </div>
          ))}
          {apiKeyGroups.length > 0 && onApiKeyGroupModeChange ? (
            <Select
              value={apiKeyGroupMode}
              onValueChange={(value) =>
                onApiKeyGroupModeChange(value as CodexApiKeyGroupMode)
              }
            >
              <SelectTrigger aria-label={t("codexConfig.apiKeyGroupMode")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="isolated">
                  {t("codexConfig.apiKeyGroupModeIsolated")}
                </SelectItem>
                <SelectItem value="round_robin">
                  {t("codexConfig.apiKeyGroupModeRoundRobin")}
                </SelectItem>
              </SelectContent>
            </Select>
          ) : null}
        </section>
      ) : null}

      {/* Codex Base URL 输入框（托管 OAuth 端点由 adapter 硬定向，不展示） */}
      {shouldShowSpeedTest && !isXaiOauthPreset && (
        <EndpointField
          id="codexBaseUrl"
          label={t("codexConfig.apiUrlLabel")}
          value={codexBaseUrl}
          onChange={onBaseUrlChange}
          placeholder={t("providerForm.codexApiEndpointPlaceholder")}
          hint={t("providerForm.codexApiHint")}
          showFullUrlToggle
          isFullUrl={isFullUrl}
          onFullUrlChange={onFullUrlChange}
          onManageClick={() => onEndpointModalToggle(true)}
        />
      )}

      {category !== "official" && onModelChange && (
        <div className="space-y-1.5">
          <FormLabel htmlFor="codexDefaultModel">
            {t("codexConfig.defaultModelLabel", {
              defaultValue: "Default model",
            })}
          </FormLabel>
          <div className="flex gap-1">
            <Input
              id="codexDefaultModel"
              value={codexModel}
              onChange={(event) => onModelChange(event.target.value)}
              placeholder={t("codexConfig.defaultModelPlaceholder", {
                defaultValue: "Example: gpt-5.6",
              })}
            />
            {includedModelOptions.length > 0 && (
              <ModelDropdown
                models={includedModelOptions}
                onSelect={(id) => onModelChange(id)}
              />
            )}
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t("codexConfig.defaultModelHint", {
              defaultValue:
                "The model Codex requests by default. Change it at any time without waiting for a preset update.",
            })}
          </p>
        </div>
      )}

      {category !== "official" && canEditCatalog && (
        <CodexProviderReadinessSection
          models={catalogRows}
          provider={{
            settingsConfig: {
              base_url: codexBaseUrl,
              apiFormat,
              modelCatalog: { models: catalogRows },
            },
            meta: {
              apiFormat,
              isFullUrl,
              codexProtocolMode: protocolMode,
              codexProtocolOverrides: protocolOverrides,
            },
          }}
          defaultModel={codexModel}
          apiFormat={apiFormat}
          adaptation={displayedAdaptation}
          isMaintainedPreset={isMaintainedPreset}
          isSyncingModels={isFetchingModels}
          confirmedFreeModelCount={confirmedFreeModelCount}
          canUseFreeModelsOnly={canUseFreeModelsOnly}
          onUseFreeModelsOnly={handleUseFreeModelsOnly}
          discoveredModelCount={fetchedModels.length}
          canUseOnlyDiscoveredModels={isCompleteCodexCatalogFetch(apiKeyGroups)}
          onUseOnlyDiscoveredModels={handleUseOnlyDiscoveredModels}
          canReplaceCatalog={isCompleteCodexCatalogFetch(apiKeyGroups)}
          onReplaceCatalog={handleReplaceCatalogFromDiscovery}
          isValidatingConnection={
            isProbingProtocol && isProtocolProbeStateCurrent
          }
          validationSummary={
            isProtocolProbeStateCurrent ? protocolProbeSummary : ""
          }
          validationTone={
            isProtocolProbeStateCurrent ? protocolProbeTone : "muted"
          }
          highlightSync={shouldHighlightFetchModels}
          syncButtonRef={fetchModelsButtonRef}
          sectionRef={modelMappingSectionRef}
          onSyncModels={handleFetchModels}
          onValidateConnection={() => {
            const hasProbeModel = catalogRowsRef.current.some(
              (row) =>
                row.enabled !== false &&
                Boolean(row.model.trim() || catalogRowUpstreamModel(row)),
            );
            if (!hasProbeModel) {
              revealModelCatalogFetchAction();
              return;
            }
            bindProtocolProbeIdentity(readinessIdentity);
            setProtocolProbeTone("muted");
            setProtocolProbeSummary(
              "The probe confirmation dialog is open; if you do not see it, press Esc and try again.",
            );
            setIsProtocolProbeConfirmOpen(true);
          }}
          onViewCompatibilityDetails={() => {
            setIsProbingProtocol(false);
            setProtocolProbeError("");
            setProtocolProbeEvents([]);
            setProtocolProbeExpectedModels(
              (protocolProbeOutcome?.records ?? storedProtocolRecords).map(
                (record) => record.target.public_model,
              ),
            );
            setIsProtocolProbeProgressOpen(true);
          }}
        />
      )}

      {category !== "official" && canEditCatalog && (
        <div ref={setCatalogMountElement} />
      )}

      {category !== "official" && canEditCatalog && (
        <section
          aria-labelledby="codex-model-reasoning-title"
          className="space-y-4 rounded-lg border border-border-default bg-muted/10 p-4"
        >
          <CodexFormSaveFeedback
            catalogValidationError={catalogValidationError}
            saveError={saveError}
          />
          <div className="space-y-1">
            <h3
              id="codex-model-reasoning-title"
              className="text-sm font-semibold text-foreground"
            >
              Model reasoning capabilities
            </h3>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Configure each model independently. This determines which
              reasoning efforts Codex can select and how requests are sent to
              the provider; incomplete capabilities block provider saves and
              identify the missing fields.
            </p>
          </div>

          {includedCatalogViewportItems.length === 0 ? (
            <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
              {t("catalogBrowser.noIncludedModels", {
                defaultValue: "No included models",
              })}
            </p>
          ) : (
            <div className="space-y-3">
              <CodexCatalogViewport
                items={includedCatalogViewportItems}
                compact={includedCatalogViewportItems.length > 20}
                selected={new Set()}
                onSelect={() => undefined}
                showSelection={false}
                onVisibleItemsChange={handleVisibleReasoningItemsChange}
              >
                {({ row, index }) => {
                  const model = row.model.trim();
                  const probeModel = catalogRowUpstreamModel(row) || model;
                  const reasoningResolution = reasoningResolutions[model];
                  const presetReasoning =
                    presetReasoningByModel.get(model) ??
                    presetReasoningByModel.get(catalogRowUpstreamModel(row));
                  const isBuiltinReasoning =
                    row.reasoning?.source === "builtin";
                  const isUserReasoning = isExplicitCodexReasoningCapability(
                    row.reasoning,
                  );
                  const isUserPresetOverride =
                    Boolean(presetReasoning) && isUserReasoning;
                  const reasoningSourceMode: CodexReasoningCapabilitySourceMode =
                    isBuiltinReasoning
                      ? "builtin"
                      : isUserReasoning
                        ? "manual"
                        : "automatic";
                  const isReasoningEditorExpanded =
                    expandedReasoningRowId === row.rowId;
                  const reasoningSourceLabel = isBuiltinReasoning
                    ? "CCSM-maintained declaration"
                    : isUserPresetOverride
                      ? "User declaration (overrides maintained value)"
                      : isUserReasoning
                        ? "User declaration"
                        : row.reasoning?.source === "detection"
                          ? "Automatic provider metadata"
                          : row.reasoning?.source === "library"
                            ? "Maintained capability catalog"
                            : row.reasoning
                              ? "Automatic provider metadata"
                              : reasoningResolution?.source === "detection"
                                ? "Automatic detection"
                                : reasoningResolution?.source === "library"
                                  ? "Maintained capability catalog"
                                  : "Automatic discovery or server default";
                  const selectableEfforts =
                    reasoningResolution?.resolved.codexSelectableEfforts ?? [];
                  const defaultEffort =
                    reasoningResolution?.resolved.providerDefaultEffort ??
                    undefined;
                  const effectiveUltra = resolveCodexCatalogUltraDisplay(
                    row,
                    reasoningResolution?.resolved,
                    reasoningProviderIdentity,
                  );
                  const discoveredReasoning = reasoningResolution?.capability
                    ? (reasoningResolution.capability as unknown as CodexModelReasoningCapability)
                    : undefined;

                  return (
                    <article
                      id={
                        catalogValidationError?.model === model
                          ? "codex-catalog-validation-row"
                          : undefined
                      }
                      key={`reasoning:${row.rowId}`}
                      className={`space-y-3 rounded-md border bg-background p-3 text-xs ${catalogValidationError?.model === model ? "border-destructive ring-1 ring-destructive" : ""}`}
                    >
                      <CodexModelReasoningSummary
                        model={
                          row.displayName?.trim() || model || "Unnamed model"
                        }
                        source={reasoningSourceLabel}
                        selectableEfforts={selectableEfforts}
                        defaultEffort={defaultEffort}
                        ultraEnabled={effectiveUltra.enabled}
                        ultraEffort={effectiveUltra.providerEffort}
                        ultraEfforts={
                          reasoningResolution?.resolved
                            .providerAcceptedEfforts ?? []
                        }
                        onUltraChange={(codexUltra) =>
                          handleUpdateCatalogRow(index, { codexUltra })
                        }
                        expanded={isReasoningEditorExpanded}
                        onToggle={() =>
                          setExpandedReasoningRowId((current) =>
                            current === row.rowId ? null : row.rowId,
                          )
                        }
                      />

                      {isReasoningEditorExpanded && (
                        <>
                          <label className="grid min-w-52 gap-1">
                            <span className="font-medium">
                              Capability source
                            </span>
                            <select
                              className="rounded-md border bg-background px-3 py-2"
                              value={reasoningSourceMode}
                              aria-label={`${model || "Model"} reasoning capability source`}
                              onChange={(event) => {
                                const mode = event.target
                                  .value as CodexReasoningCapabilitySourceMode;
                                if (mode === "builtin") {
                                  void handleRestoreBuiltinReasoning(index);
                                  return;
                                }
                                handleUpdateCatalogRow(index, {
                                  reasoning:
                                    applyCodexReasoningCapabilitySource(
                                      mode,
                                      row.reasoning,
                                      presetReasoning,
                                      discoveredReasoning,
                                    ),
                                });
                              }}
                            >
                              <option value="automatic">
                                Automatic discovery
                              </option>
                              <option
                                value="builtin"
                                disabled={!presetReasoning}
                              >
                                Use the CCSM-maintained declaration
                              </option>
                              <option value="manual">Manual declaration</option>
                            </select>
                            {reasoningSourceMode === "automatic" ? (
                              <span className="text-muted-foreground">
                                Automatic discovery resolves capabilities from
                                the current provider, model, and verified
                                declarations; it does not write to this model
                                configuration. Create a user override when you
                                need to adjust efforts, mappings, or enable
                                Ultra.
                              </span>
                            ) : null}
                          </label>

                          {reasoningResolution ? (
                            <CodexModelReasoningCard
                              resolution={reasoningResolution}
                              hasBuiltinPreset={Boolean(presetReasoning)}
                              redetecting={redetectingReasoningModel === model}
                              onRedetect={async () => {
                                const requestId =
                                  ++reasoningDetectionRequestRef.current;
                                const contextKey = reasoningContextKey;
                                const ownsCurrentContext = () =>
                                  requestId ===
                                    reasoningDetectionRequestRef.current &&
                                  reasoningContextKeyRef.current === contextKey;
                                setRedetectingReasoningModel(model);
                                try {
                                  const outcome =
                                    await codexSubagentV2Api.triggerModelReasoningDetection(
                                      reasoningDetectionProvider,
                                      probeModel,
                                    );
                                  if (!ownsCurrentContext()) return;
                                  if (
                                    typeof outcome === "object" &&
                                    "found" in outcome
                                  ) {
                                    const next =
                                      await codexSubagentV2Api.resolveModelReasoningCapability(
                                        reasoningSettingsConfig,
                                        providerId ?? "codex-draft",
                                        model,
                                      );
                                    if (!ownsCurrentContext()) return;
                                    setReasoningResolutionState((current) => ({
                                      contextKey,
                                      models: {
                                        ...(current.contextKey === contextKey
                                          ? current.models
                                          : {}),
                                        [model]: next,
                                      },
                                    }));
                                    toast.success(
                                      "Updated model reasoning capability detection result",
                                    );
                                  } else {
                                    toast.info(
                                      "No usable model reasoning declaration was found; continuing with the server default.",
                                    );
                                  }
                                } catch {
                                  if (!ownsCurrentContext()) return;
                                  console.error(
                                    "[CodexFormFields] reasoning detection failed",
                                    { model },
                                  );
                                  toast.error(
                                    "Model reasoning capability detection failed",
                                  );
                                } finally {
                                  if (ownsCurrentContext())
                                    setRedetectingReasoningModel(null);
                                }
                              }}
                              onAdoptDetection={() => {
                                const detected = reasoningResolution.detection
                                  ? capabilityFromReasoningDetection({
                                      found: reasoningResolution.detection,
                                    })
                                  : undefined;
                                if (!detected) {
                                  toast.info(
                                    "The current detection result has no usable reasoning-effort declaration.",
                                  );
                                  return;
                                }
                                handleUpdateCatalogRow(index, {
                                  reasoning: detected,
                                });
                                toast.success(
                                  "Detected reasoning capabilities adopted",
                                );
                              }}
                              onManualDeclare={() =>
                                handleUpdateCatalogRow(index, {
                                  reasoning:
                                    applyCodexReasoningCapabilitySource(
                                      "manual",
                                      row.reasoning,
                                      presetReasoning,
                                      discoveredReasoning,
                                    ),
                                })
                              }
                              onCustomizeEffective={
                                !row.reasoning && discoveredReasoning
                                  ? () =>
                                      handleUpdateCatalogRow(index, {
                                        reasoning:
                                          applyCodexReasoningCapabilitySource(
                                            "manual",
                                            row.reasoning,
                                            presetReasoning,
                                            discoveredReasoning,
                                          ),
                                      })
                                  : undefined
                              }
                              onRestoreBuiltin={() => {
                                void handleRestoreBuiltinReasoning(index);
                              }}
                            />
                          ) : (
                            <p className="text-muted-foreground">
                              Reading the unified reasoning capability result
                              for this model…
                            </p>
                          )}

                          {isUserPresetOverride ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                void handleRestoreBuiltinReasoning(index);
                              }}
                            >
                              Restore built-in default
                            </Button>
                          ) : null}
                          {isBuiltinReasoning && row.reasoning ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                handleUpdateCatalogRow(index, {
                                  reasoning:
                                    applyCodexReasoningCapabilitySource(
                                      "manual",
                                      row.reasoning,
                                      presetReasoning,
                                    ),
                                })
                              }
                            >
                              Create advanced override
                            </Button>
                          ) : null}

                          {row.reasoning ? (
                            <CodexModelReasoningEditor
                              model={model || "Model"}
                              upstreamModel={probeModel}
                              providerIdentity={reasoningProviderIdentity}
                              capability={row.reasoning}
                              readOnly={isBuiltinReasoning}
                              onChange={(reasoning) =>
                                handleUpdateCatalogRow(index, { reasoning })
                              }
                            />
                          ) : null}

                          <details>
                            <summary className="cursor-pointer text-muted-foreground">
                              Expert JSON
                            </summary>
                            <Textarea
                              key={`reasoning-json:${row.rowId}:${JSON.stringify(row.reasoning)}`}
                              className="mt-2 min-h-28 font-mono text-xs"
                              defaultValue={
                                row.reasoning
                                  ? JSON.stringify(row.reasoning, null, 2)
                                  : ""
                              }
                              onBlur={(event) => {
                                if (!isBuiltinReasoning) {
                                  handleUpdateCatalogReasoningJson(
                                    index,
                                    event.target.value,
                                  );
                                }
                              }}
                              readOnly={isBuiltinReasoning}
                              aria-label={`${model || "Model"} reasoning capability JSON`}
                            />
                          </details>
                        </>
                      )}
                    </article>
                  );
                }}
              </CodexCatalogViewport>
            </div>
          )}
        </section>
      )}

      {/* Advanced settings只Keep手动协议、请求覆盖和Model catalog details。 */}
      {category !== "official" && (
        <Collapsible
          open={advancedExpanded}
          onOpenChange={setAdvancedExpanded}
          className="rounded-lg border border-border-default p-4"
        >
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant={null}
              size="sm"
              className="h-8 w-full justify-start gap-1.5 px-0 text-sm font-medium text-foreground hover:opacity-70"
            >
              {advancedExpanded ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
              {t("providerForm.advancedOptionsToggle", {
                defaultValue: "Advanced settings",
              })}
            </Button>
          </CollapsibleTrigger>
          {!advancedExpanded && (
            <p className="mt-1 ml-1 text-xs text-muted-foreground">
              {t("codexConfig.advancedSectionHint", {
                defaultValue:
                  "Includes the model catalog, protocol detection, upstream format, Codex menu mapping, reasoning capabilities, and custom User-Agent; Chat Completions providers use local proxy conversion.",
              })}
            </p>
          )}
          <CollapsibleContent className="space-y-3 pt-3">
            {/* Upstream format与协议探测沿用 shouldShowSpeedTest 门控，
                cloud_provider 保持不可切换；xAI OAuth 托管预设格式固定为 Responses。 */}
            {shouldShowSpeedTest && !isXaiOauthPreset && (
              <div className="space-y-3">
                {/* Upstream format —— 顶层独立选择，与路由开关解耦 */}
                <div className="space-y-1.5">
                  <FormLabel htmlFor="codex-upstream-format">
                    {t("codexConfig.upstreamFormatLabel", {
                      defaultValue: "Upstream format",
                    })}
                  </FormLabel>
                  <Select
                    value={apiFormat}
                    onValueChange={(value) =>
                      onApiFormatChange(value as CodexApiFormat)
                    }
                  >
                    <SelectTrigger
                      id="codex-upstream-format"
                      className="w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="openai_chat">
                        {t("codexConfig.upstreamFormatChat", {
                          defaultValue:
                            "Chat Completions (local proxy conversion required)",
                        })}
                      </SelectItem>
                      <SelectItem value="openai_responses">
                        {t("codexConfig.upstreamFormatResponses", {
                          defaultValue: "Responses (native)",
                        })}
                      </SelectItem>
                      <SelectItem value="anthropic">
                        {t("codexConfig.upstreamFormatAnthropic", {
                          defaultValue: "Anthropic Messages (routing required)",
                        })}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {t("codexConfig.upstreamFormatHint", {
                      defaultValue:
                        "Choose Responses for a native Responses API provider, Chat for Chat Completions, or Anthropic when only Anthropic Messages is available. The latter two require local proxy conversion.",
                    })}
                  </p>
                  {isAnthropicFormat && (
                    <div className="space-y-3 rounded-md border border-border-default p-3">
                      <div className="space-y-1.5">
                        <FormLabel>
                          {t("codexConfig.anthropicAuthFieldLabel")}
                        </FormLabel>
                        <Select
                          value={anthropicAuthField}
                          onValueChange={(value) =>
                            onAnthropicAuthFieldChange(
                              value as ClaudeApiKeyField,
                            )
                          }
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="ANTHROPIC_AUTH_TOKEN">
                              {t("codexConfig.anthropicAuthFieldAuthToken")}
                            </SelectItem>
                            <SelectItem value="ANTHROPIC_API_KEY">
                              {t("codexConfig.anthropicAuthFieldApiKey")}
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <label className="flex items-center justify-between gap-3 text-sm">
                        {t("codexConfig.impersonateClaudeCodeLabel")}
                        <Switch
                          checked={impersonateClaudeCode}
                          onCheckedChange={onImpersonateClaudeCodeChange}
                        />
                      </label>
                      <div className="space-y-1.5">
                        <FormLabel htmlFor="codexMaxOutputTokens">
                          {t("codexConfig.maxOutputTokensLabel")}
                        </FormLabel>
                        <Input
                          id="codexMaxOutputTokens"
                          inputMode="numeric"
                          value={maxOutputTokens}
                          onChange={(event) =>
                            onMaxOutputTokensChange(
                              event.target.value.replace(/\D/g, ""),
                            )
                          }
                          placeholder="8192"
                        />
                      </div>
                    </div>
                  )}
                  {(isChatFormat || isAnthropicFormat) && (
                    <div className="space-y-1.5">
                      <FormLabel>
                        {t("codexConfig.promptCacheRoutingLabel")}
                      </FormLabel>
                      <Select
                        value={promptCacheRouting}
                        onValueChange={(value) =>
                          onPromptCacheRoutingChange(
                            value as PromptCacheRoutingMode,
                          )
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="auto">
                            {t("codexConfig.promptCacheRoutingAuto")}
                          </SelectItem>
                          <SelectItem value="enabled">
                            {t("codexConfig.promptCacheRoutingEnabled")}
                          </SelectItem>
                          <SelectItem value="disabled">
                            {t("codexConfig.promptCacheRoutingDisabled")}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-900 dark:text-amber-200">
                    The upstream format is usually determined by a maintained
                    preset or the main connection-validation flow. Override it
                    here only when automatic detection is wrong; validation
                    sends real model requests and may consume a small amount of
                    quota or traffic.
                  </div>
                  {(apiFormat === "openai_chat" ||
                    apiFormat === "openai_responses") && (
                    <CodexProtocolAdvancedSettings
                      mode={protocolMode}
                      apiFormat={apiFormat}
                      reasoningProjection={reasoningProjection}
                      toolSchemaDialect={toolSchemaDialect}
                      historyReplay={historyReplay}
                      onModeChange={onProtocolModeChange}
                      onApiFormatChange={onApiFormatChange}
                      onReasoningProjectionChange={onReasoningProjectionChange}
                      onToolSchemaDialectChange={onToolSchemaDialectChange}
                      onHistoryReplayChange={onHistoryReplayChange}
                    />
                  )}
                </div>
              </div>
            )}

            {takeoverEnabled &&
              isChatFormat &&
              canEditReasoning &&
              hasLegacyProviderReasoningConfig && (
                <details
                  className={cn(
                    "space-y-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-3",
                    shouldShowSpeedTest &&
                      "border-t border-border-default pt-3",
                  )}
                >
                  <summary className="cursor-pointer text-sm font-medium text-foreground">
                    Legacy compatibility fallback
                  </summary>
                  <div className="space-y-3 pt-2">
                    <div className="space-y-1">
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        This is a legacy provider-level reasoning configuration
                        that affects models without their own model-level
                        capability declaration. Prefer declaring capabilities
                        per model under “Model reasoning capabilities”; this
                        section remains only for compatibility editing of
                        existing configurations.
                      </p>
                    </div>
                    <div className="flex items-center justify-between gap-4">
                      <div className="space-y-1">
                        <FormLabel>
                          {t("codexConfig.reasoningModeToggle", {
                            defaultValue: "Supports thinking mode",
                          })}
                        </FormLabel>
                        <p className="text-xs leading-relaxed text-muted-foreground">
                          Legacy setting: enable the thinking switch for Chat
                          models without a model-level declaration.
                        </p>
                      </div>
                      <Switch
                        checked={supportsThinking}
                        onCheckedChange={handleReasoningThinkingChange}
                        aria-label={t("codexConfig.reasoningModeToggle", {
                          defaultValue: "Supports thinking mode",
                        })}
                      />
                    </div>
                    <div className="flex items-center justify-between gap-4 border-t border-border-default pt-3">
                      <div className="space-y-1">
                        <FormLabel>
                          {t("codexConfig.reasoningEffortToggle", {
                            defaultValue: "Supports thinking levels",
                          })}
                        </FormLabel>
                        <p className="text-xs leading-relaxed text-muted-foreground">
                          Legacy setting: enable effort parameter conversion for
                          Chat models without a model-level declaration.
                        </p>
                      </div>
                      <Switch
                        checked={supportsEffort}
                        onCheckedChange={handleReasoningEffortChange}
                        aria-label={t("codexConfig.reasoningEffortToggle", {
                          defaultValue: "Supports thinking levels",
                        })}
                      />
                    </div>
                  </div>
                </details>
              )}
          </CollapsibleContent>

          {/* Model映射 / Model目录 —— 与「路由接管」解耦，常驻显示（可编辑即渲染）。
                填了才生成 catalog：Chat 模式生成兼容路由、原生 Responses 生成
                model-catalogs.json；留空则不生成。排在自定义 UA 之前。 */}
          {catalogMountElement &&
            canEditCatalog &&
            createPortal(
              <div
                className={cn(
                  "space-y-4",
                  (shouldShowSpeedTest ||
                    (takeoverEnabled && isChatFormat && canEditReasoning)) &&
                    "border-t border-border-default pt-3",
                )}
              >
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-3">
                    <FormLabel>
                      {t("codexConfig.modelMappingTitle", {
                        defaultValue: "Model catalog details",
                      })}
                    </FormLabel>
                    {renderCatalogActionButtons(
                      handleAddCatalogRow,
                      t("codexConfig.addCatalogModel", {
                        defaultValue: "Add model",
                      }),
                    )}
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {t("codexConfig.modelMappingHint", {
                      defaultValue:
                        "This stores candidate models, real upstream model names, and context windows. When “Show in the Codex /model menu” is enabled, the menu label and upstream model name participate in Codex menu mapping; when disabled, they are still saved as catalog metadata.",
                    })}
                  </p>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {t("codexConfig.modelMappingInventoryHint", {
                      defaultValue:
                        "All includes retained excluded inventory for editing. Only Included models enter routes and model pickers; use “Enable only synced models” after a complete API sync when you want the latest fetched set enabled.",
                    })}
                  </p>
                </div>

                {catalogRows.length > 0 && (
                  <div className="space-y-2">
                    <CodexCatalogViewport
                      items={catalogViewportItems}
                      compact={catalogRows.length > 20}
                      revealRowId={revealedCatalogRowId}
                      selected={selectedCatalogRowIds}
                      onSelectionChange={setSelectedCatalogRowIds}
                      onSelect={(rowId, checked) =>
                        setSelectedCatalogRowIds((current) => {
                          const next = new Set(current);
                          if (checked) next.add(rowId);
                          else next.delete(rowId);
                          return next;
                        })
                      }
                      onToggleEnabled={(rowId, enabled) => {
                        const index = catalogRows.findIndex(
                          (row) => row.rowId === rowId,
                        );
                        if (index >= 0) {
                          handleUpdateCatalogRow(index, { enabled });
                        }
                      }}
                      onSetIncluded={(ids, enabled) => {
                        const matched = new Set(ids);
                        commitCatalogRows(
                          (current) =>
                            current.map((row) =>
                              matched.has(row.rowId)
                                ? { ...row, enabled }
                                : row,
                            ),
                          { repairDefault: true },
                        );
                      }}
                      onUseOnlySelected={(ids) => {
                        const selected = new Set(ids);
                        commitCatalogRows(
                          (current) =>
                            current.map((row) => ({
                              ...row,
                              enabled: selected.has(row.rowId),
                            })),
                          { repairDefault: true },
                        );
                      }}
                      onRemoveSelected={(ids) => {
                        const selected = new Set(ids);
                        commitCatalogRows(
                          (current) =>
                            current.filter((row) => !selected.has(row.rowId)),
                          {
                            repairDefault: true,
                            reconcileProtocolOverrides: true,
                          },
                        );
                      }}
                      onPruneOutdated={handlePruneOutdatedCatalogRows}
                    >
                      {({ row, index }) => {
                        const model = row.model.trim();
                        const presetCatalogModel =
                          presetCatalogByModel.get(model) ??
                          presetCatalogByModel.get(
                            catalogRowUpstreamModel(row),
                          );
                        const supportsImage = catalogSupportsImage(row);
                        const presetDeclaresInputCapability = Boolean(
                          presetCatalogModel &&
                          (presetCatalogModel.inputModalities !== undefined ||
                            presetCatalogModel.input_modalities !== undefined ||
                            presetCatalogModel.supportsImage !== undefined ||
                            presetCatalogModel.supports_image !== undefined ||
                            presetCatalogModel.vision !== undefined ||
                            presetCatalogModel.textOnly !== undefined ||
                            presetCatalogModel.text_only !== undefined),
                        );

                        return (
                          <div
                            key={row.rowId}
                            className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3"
                          >
                            <label className="min-w-0 space-y-1 text-xs">
                              <span className="text-muted-foreground">
                                {t("codexConfig.catalogColumnDisplay", {
                                  defaultValue: "Menu display name",
                                })}
                              </span>
                              <Input
                                value={row.displayName ?? ""}
                                onChange={(event) =>
                                  handleUpdateCatalogRow(index, {
                                    displayName: event.target.value,
                                  })
                                }
                                placeholder={t(
                                  "codexConfig.catalogDisplayNamePlaceholder",
                                  {
                                    defaultValue: "Example: DeepSeek V4 Flash",
                                  },
                                )}
                                aria-label={t(
                                  "codexConfig.catalogColumnDisplay",
                                  {
                                    defaultValue: "Menu display name",
                                  },
                                )}
                              />
                            </label>
                            <label className="min-w-0 space-y-1 text-xs">
                              <span className="text-muted-foreground">
                                {t("codexConfig.catalogColumnModel", {
                                  defaultValue: "Candidate model name",
                                })}
                              </span>
                              <Input
                                value={row.model}
                                onChange={(event) =>
                                  handleUpdateCatalogRow(index, {
                                    model: event.target.value,
                                  })
                                }
                                placeholder={t(
                                  "codexConfig.catalogModelPlaceholder",
                                  {
                                    defaultValue: "Example: gpt-5.5-thirdparty",
                                  },
                                )}
                                aria-label={t(
                                  "codexConfig.catalogColumnModel",
                                  {
                                    defaultValue: "Candidate model name",
                                  },
                                )}
                              />
                            </label>
                            <div className="min-w-0 space-y-1">
                              <label
                                className="text-xs text-muted-foreground"
                                htmlFor={`catalog-upstream-${row.rowId}`}
                              >
                                {t("codexConfig.catalogColumnUpstreamModel", {
                                  defaultValue: "Upstream model name",
                                })}
                              </label>
                              <div className="flex gap-1">
                                <Input
                                  id={`catalog-upstream-${row.rowId}`}
                                  value={
                                    row.upstreamModel ??
                                    row.upstream_model ??
                                    ""
                                  }
                                  onChange={(event) =>
                                    handleUpdateCatalogRow(index, {
                                      upstreamModel: event.target.value,
                                    })
                                  }
                                  placeholder={t(
                                    "codexConfig.catalogUpstreamModelPlaceholder",
                                    {
                                      defaultValue:
                                        "Leave blank to use the candidate model name",
                                    },
                                  )}
                                  aria-label={t(
                                    "codexConfig.catalogColumnUpstreamModel",
                                    {
                                      defaultValue: "Upstream model name",
                                    },
                                  )}
                                  className="min-w-0 flex-1"
                                />
                                {fetchedModels.length > 0 && (
                                  <ModelDropdown
                                    models={fetchedModels}
                                    onSelect={(id) =>
                                      handleSelectFetchedCatalogModel(
                                        index,
                                        id,
                                        row.model,
                                        row.displayName,
                                      )
                                    }
                                  />
                                )}
                              </div>
                            </div>
                            <label className="min-w-0 space-y-1 text-xs">
                              <span className="text-muted-foreground">
                                {t("codexConfig.catalogColumnContext", {
                                  defaultValue: "Context window",
                                })}
                              </span>
                              <Input
                                type="number"
                                min={1}
                                inputMode="numeric"
                                value={row.contextWindow ?? ""}
                                onChange={(event) =>
                                  handleUpdateCatalogRow(index, {
                                    contextWindow: event.target.value.replace(
                                      /[^\d]/g,
                                      "",
                                    ),
                                  })
                                }
                                placeholder={t(
                                  "codexConfig.contextWindowPlaceholder",
                                  {
                                    defaultValue: "Example: 128000",
                                  },
                                )}
                                aria-label={t(
                                  "codexConfig.catalogColumnContext",
                                  {
                                    defaultValue: "Context window",
                                  },
                                )}
                              />
                            </label>
                            <label className="min-w-0 space-y-1 text-xs">
                              <span className="text-muted-foreground">
                                {t("catalogBrowser.protocolOverride")}
                              </span>
                              <select
                                className="h-9 w-full min-w-0 rounded-md border border-border-default bg-background px-2 text-xs text-foreground"
                                aria-label={`${model || "Model"} protocol selection`}
                                value={
                                  protocolOverrides[
                                    normalizeCodexPublicModelKey(model)
                                  ] ?? "follow_auto"
                                }
                                onChange={(event) =>
                                  onProtocolOverridesChange(
                                    setCodexProtocolOverride(
                                      protocolOverrides,
                                      model,
                                      event.target
                                        .value as CodexProtocolChoiceInput,
                                    ),
                                  )
                                }
                              >
                                <option value="follow_auto">
                                  Follow automatic selection
                                </option>
                                <option value="openai_responses">
                                  Responses
                                </option>
                                <option value="openai_chat">Chat</option>
                              </select>
                            </label>
                            <div className="flex flex-col justify-end gap-1">
                              <span className="text-xs text-muted-foreground">
                                {t("codexConfig.catalogOrderColumn", {
                                  defaultValue: "Order",
                                })}
                              </span>
                              <div className="flex h-9 items-center gap-1">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 text-muted-foreground"
                                  disabled={index <= 0}
                                  onClick={() =>
                                    handleMoveCatalogRow(index, -1)
                                  }
                                  title={t("common.moveUp", {
                                    defaultValue: "Move up",
                                  })}
                                  aria-label={t("catalogBrowser.moveUp", {
                                    model: row.model,
                                  })}
                                >
                                  <ArrowUp className="h-4 w-4" />
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 text-muted-foreground"
                                  disabled={index >= catalogRows.length - 1}
                                  onClick={() => handleMoveCatalogRow(index, 1)}
                                  title={t("common.moveDown", {
                                    defaultValue: "Move down",
                                  })}
                                  aria-label={t("catalogBrowser.moveDown", {
                                    model: row.model,
                                  })}
                                >
                                  <ArrowDown className="h-4 w-4" />
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="h-9 w-9 text-muted-foreground hover:text-destructive"
                                  onClick={() => handleRemoveCatalogRow(index)}
                                  title={t("common.delete", {
                                    defaultValue: "Delete",
                                  })}
                                  aria-label={t("catalogBrowser.removeModel", {
                                    model: row.model,
                                  })}
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </div>
                            </div>
                            <fieldset
                              className="col-span-full flex flex-wrap items-center gap-2 border-t border-border-default pt-2 text-xs"
                              aria-label={`${model || "Model"} Input capability`}
                            >
                              <legend className="mr-1 font-medium">
                                Input capability
                              </legend>
                              <div
                                className="inline-flex overflow-hidden rounded-md border"
                                role="radiogroup"
                                aria-label={`${model || "Model"} input capability selection`}
                              >
                                <Button
                                  type="button"
                                  size="sm"
                                  variant={supportsImage ? "default" : "ghost"}
                                  className="rounded-none"
                                  aria-pressed={supportsImage}
                                  aria-label={`${model || "Model"} Text and image`}
                                  onClick={() =>
                                    handleUpdateCatalogRow(
                                      index,
                                      codexInputCapabilityPatch(
                                        "text_image",
                                        row,
                                      ),
                                    )
                                  }
                                >
                                  Text and image
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant={!supportsImage ? "default" : "ghost"}
                                  className="rounded-none border-l"
                                  aria-pressed={!supportsImage}
                                  aria-label={`${model || "Model"} Text only`}
                                  onClick={() =>
                                    handleUpdateCatalogRow(
                                      index,
                                      codexInputCapabilityPatch(
                                        "text_only",
                                        row,
                                      ),
                                    )
                                  }
                                >
                                  Text only
                                </Button>
                              </div>
                              <span className="text-muted-foreground">
                                Saving overrides the current provider preset; no
                                release update is required.
                              </span>
                              {presetDeclaresInputCapability &&
                              presetCatalogModel ? (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  aria-label={`${model || "Model"} restore CCSM input capability preset`}
                                  onClick={() =>
                                    handleUpdateCatalogRow(
                                      index,
                                      codexInputCapabilityPatch(
                                        catalogSupportsImage(presetCatalogModel)
                                          ? "text_image"
                                          : "text_only",
                                        presetCatalogModel,
                                      ),
                                    )
                                  }
                                >
                                  Restore CCSM preset
                                </Button>
                              ) : null}
                            </fieldset>
                          </div>
                        );
                      }}
                    </CodexCatalogViewport>
                  </div>
                )}
              </div>,
              catalogMountElement,
            )}

          <CollapsibleContent className="space-y-3 pt-3">
            <div
              className={cn(
                "space-y-3",
                (shouldShowSpeedTest ||
                  (isChatFormat && canEditReasoning) ||
                  canEditCatalog) &&
                  "border-t border-border-default pt-3",
              )}
            >
              <CustomUserAgentField
                id="codex-custom-user-agent"
                value={customUserAgent}
                onChange={onCustomUserAgentChange}
              />
              <div className="border-t border-border-default pt-3">
                <LocalProxyRequestOverridesField
                  headersJson={localProxyHeadersOverride}
                  bodyJson={localProxyBodyOverride}
                  onHeadersJsonChange={onLocalProxyHeadersOverrideChange}
                  onBodyJsonChange={onLocalProxyBodyOverrideChange}
                />
              </div>
            </div>

            <div
              className="space-y-3 rounded-md border border-border-default p-3"
              aria-labelledby="codex-traffic-policy-title"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <FormLabel id="codex-traffic-policy-title">
                    {t("codexConfig.trafficPolicy.title", {
                      defaultValue: "Traffic policy",
                    })}
                  </FormLabel>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {t("codexConfig.trafficPolicy.description", {
                      defaultValue:
                        "Limit local in-flight requests and replay only recognized upstream rejections. This policy is per provider.",
                    })}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {resolvedTrafficPolicy.source === "recommended"
                      ? t("codexConfig.trafficPolicy.zenRecommended", {
                          defaultValue:
                            "OpenCode Zen recommendation: 4 in flight, 5 rate-limit retries, and 2 recognized rejection retries.",
                        })
                      : resolvedTrafficPolicy.source === "custom"
                        ? t("codexConfig.trafficPolicy.customActive", {
                            defaultValue: "Custom policy is active.",
                          })
                        : t("codexConfig.trafficPolicy.unknownSafe", {
                            defaultValue:
                              "Unknown providers keep conservative defaults until you opt in.",
                          })}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    onCodexTrafficPolicyChange(
                      codexTrafficPolicy
                        ? undefined
                        : customCodexTrafficPolicySeed(codexBaseUrl),
                    )
                  }
                >
                  {codexTrafficPolicy
                    ? t("codexConfig.trafficPolicy.useRecommended", {
                        defaultValue: "Use recommendation",
                      })
                    : t("codexConfig.trafficPolicy.customize", {
                        defaultValue: "Customize",
                      })}
                </Button>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <label className="flex items-center justify-between gap-3 text-sm">
                  <span>
                    {t("codexConfig.trafficPolicy.limitConcurrency", {
                      defaultValue: "Limit concurrency",
                    })}
                  </span>
                  <Switch
                    checked={resolvedTrafficPolicy.admissionEnabled}
                    disabled={!codexTrafficPolicy}
                    onCheckedChange={(checked) =>
                      updateTrafficPolicy({ admissionEnabled: checked })
                    }
                  />
                </label>
                <label className="space-y-1.5 text-sm">
                  <span>
                    {t("codexConfig.trafficPolicy.maxInFlight", {
                      defaultValue: "Max in flight",
                    })}
                  </span>
                  <Input
                    type="number"
                    min={1}
                    max={64}
                    value={resolvedTrafficPolicy.maxInFlight}
                    disabled={
                      !codexTrafficPolicy ||
                      !resolvedTrafficPolicy.admissionEnabled
                    }
                    onChange={(event) =>
                      updateTrafficPolicy({
                        maxInFlight: Number(event.target.value),
                      })
                    }
                  />
                </label>
                <label className="space-y-1.5 text-sm">
                  <span>
                    {t("codexConfig.trafficPolicy.maxQueueWait", {
                      defaultValue: "Queue wait (ms)",
                    })}
                  </span>
                  <Input
                    type="number"
                    min={100}
                    max={300000}
                    value={resolvedTrafficPolicy.maxQueueWaitMs}
                    disabled={
                      !codexTrafficPolicy ||
                      !resolvedTrafficPolicy.admissionEnabled
                    }
                    onChange={(event) =>
                      updateTrafficPolicy({
                        maxQueueWaitMs: Number(event.target.value),
                      })
                    }
                  />
                </label>
                <label className="space-y-1.5 text-sm">
                  <span>
                    {t("codexConfig.trafficPolicy.rateLimitRetries", {
                      defaultValue: "429 retries",
                    })}
                  </span>
                  <Input
                    type="number"
                    min={0}
                    max={5}
                    value={resolvedTrafficPolicy.rateLimitMaxRetries}
                    disabled={!codexTrafficPolicy}
                    onChange={(event) =>
                      updateTrafficPolicy({
                        rateLimitMaxRetries: Number(event.target.value),
                      })
                    }
                  />
                </label>
              </div>
              <div className="grid gap-3 md:grid-cols-3">
                <label className="space-y-1.5 text-sm md:col-span-2">
                  <span>
                    {t("codexConfig.trafficPolicy.rejectionMode", {
                      defaultValue: "Recognized rejection replay",
                    })}
                  </span>
                  <Select
                    value={resolvedTrafficPolicy.rejectionRetryMode}
                    disabled={!codexTrafficPolicy}
                    onValueChange={(value) =>
                      updateTrafficPolicy({
                        rejectionRetryMode:
                          value as CodexTrafficPolicy["rejectionRetryMode"],
                      })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="disabled">
                        {t("codexConfig.trafficPolicy.disabled", {
                          defaultValue: "Disabled",
                        })}
                      </SelectItem>
                      <SelectItem value="opencode_endpoint_unavailable">
                        {t("codexConfig.trafficPolicy.opencodeSignature", {
                          defaultValue: "OpenCode endpoint unavailable",
                        })}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </label>
                <label className="space-y-1.5 text-sm">
                  <span>
                    {t("codexConfig.trafficPolicy.rejectionRetries", {
                      defaultValue: "Rejection retries",
                    })}
                  </span>
                  <Input
                    type="number"
                    min={0}
                    max={5}
                    value={resolvedTrafficPolicy.rejectionMaxRetries}
                    disabled={
                      !codexTrafficPolicy ||
                      resolvedTrafficPolicy.rejectionRetryMode === "disabled"
                    }
                    onChange={(event) =>
                      updateTrafficPolicy({
                        rejectionMaxRetries: Number(event.target.value),
                      })
                    }
                  />
                </label>
              </div>
              <p className="text-xs leading-relaxed text-amber-700 dark:text-amber-300">
                {t("codexConfig.trafficPolicy.safetyWarning", {
                  defaultValue:
                    "Only enable the OpenCode signature when the provider guarantees the same pre-inference rejection semantics. Arbitrary 5xx responses are never replayed.",
                })}
              </p>
            </div>

            {/* 仅自定义 Provider 可以退出 CCSwitchMulti 的目录管理；维护预设始终投影正确目录。 */}
            {appId === "codex" &&
              !isXaiOauthPreset &&
              allowModelMenuProjectionToggle && (
                <div className="flex items-center justify-between gap-4 rounded-md border border-blue-200 bg-blue-50/60 p-3 dark:border-blue-900/60 dark:bg-blue-950/20">
                  <div className="space-y-1.5">
                    <FormLabel>
                      {t("codexConfig.localRoutingToggle", {
                        defaultValue: "Show in the Codex /model menu",
                      })}
                    </FormLabel>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {t("codexConfig.localRoutingDescription", {
                        defaultValue:
                          "When enabled, CCSwitchMulti generates the model catalog loaded by Codex at startup, exposing these models, display names, context windows, and reasoning efforts in /model and mapping display names to real upstream models. It does not control provider, proxy, or MultiRouter availability; disable it only when maintaining your own model_catalog_json.",
                      })}
                    </p>
                    <p
                      className={cn(
                        "text-xs leading-relaxed",
                        takeoverEnabled
                          ? "text-muted-foreground"
                          : "text-amber-700 dark:text-amber-300",
                      )}
                    >
                      {takeoverEnabled
                        ? t("codexConfig.localRoutingOnHint", {
                            defaultValue:
                              "Keeping this enabled is recommended. The model catalog loads the next time Codex starts.",
                          })
                        : t("codexConfig.localRoutingOffHint", {
                            defaultValue:
                              "Currently disabled: the provider and directly specified real models still work, and catalog data continues to be saved, but Codex /model no longer receives these models, aliases, context windows, or reasoning efforts. Disable it only when maintaining your own model_catalog_json.",
                          })}
                    </p>
                  </div>
                  <Switch
                    checked={takeoverEnabled}
                    onCheckedChange={onTakeoverEnabledChange}
                    aria-label={t("codexConfig.localRoutingToggle", {
                      defaultValue: "Show in the Codex /model menu",
                    })}
                  />
                </div>
              )}
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* 端点测速弹窗 - Codex */}
      {shouldShowSpeedTest && isEndpointModalOpen && (
        <EndpointSpeedTest
          appId={appId}
          providerId={providerId}
          value={codexBaseUrl}
          onChange={onBaseUrlChange}
          initialEndpoints={speedTestEndpoints}
          visible={isEndpointModalOpen}
          onClose={() => onEndpointModalToggle(false)}
          autoSelect={autoSelect}
          onAutoSelectChange={onAutoSelectChange}
          onCustomEndpointsChange={onCustomEndpointsChange}
        />
      )}
    </>
  );
}
