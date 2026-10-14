import { isUserCodexRoutingPlan as isRoutingPlan } from "@/lib/codexProviderKind";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  rectSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bot,
  Bug,
  CheckCircle2,
  Clipboard,
  Database,
  FileClock,
  GitFork,
  GitBranch,
  GripVertical,
  Info,
  Layers3,
  Pencil,
  Play,
  Plus,
  RadioTower,
  RefreshCw,
  Route,
  Save,
  Search,
  Star,
  Server,
  Settings2,
  ShieldCheck,
  Trash2,
  Wand2,
  XCircle,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { Input } from "@/components/ui/input";
import { applyCodexCatalogModelOrder } from "@/lib/codexModelCatalogOrder";
import {
  codexCatalogModelUsage,
  defaultCodexCatalogModelOrder,
  type CodexCatalogUsageHistory,
} from "@/lib/codexModelCatalogRecommendations";

function tr(key: string, options?: Record<string, unknown>): string {
  return String(i18n.t(key, options));
}

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { providersApi } from "@/lib/api";
import type {
  CodexMultiRouterMigrationPreview,
  CodexRoutingProjectionStatus,
} from "@/lib/api/providers";
import type { CodexAccountPoolPolicy } from "@/lib/api/auth";
import {
  fetchCodexOfficialFallbackModels,
  fetchCodexOauthModels,
  fetchModelsForConfig,
  refreshCodexOfficialModelCatalog,
  type CodexOfficialCatalogRefreshResult,
  type FetchedModel,
} from "@/lib/api/model-fetch";
import type { CodexGuardianStatus } from "@/types/proxy";
import { proxyApi } from "@/lib/api/proxy";
import {
  isWizardCodexOAuthSource,
  readWizardCodexOAuthAccountId,
  resolveWizardModelNameCollisions,
} from "@/lib/codexMultiRouterWizard";
import {
  DEFAULT_HOSTED_TOOLS_CONFIG,
  readHostedToolsConfig,
  writeHostedToolsConfig,
} from "@/lib/hostedTools";
import { usageApi } from "@/lib/api/usage";
import { getUsageRangePresetLabel } from "@/lib/usageRange";
import {
  usageKeys,
  useCodexSubagentUsageStats,
  useRequestLogs,
  useSessionCollectionStatus,
} from "@/lib/query/usage";
import { cn } from "@/lib/utils";
import {
  catalogHasRoleModel,
  deepSeekRoleForModel,
} from "@/utils/deepseekRoleModels";
import {
  catalogModelLabel,
  CODEX_SPAWN_AGENT_PRIORITY_MODELS,
  normalizeCodexSpawnAgentModels,
  normalizeSpawnAgentCandidateSelection,
  readCodexModelCatalog,
  readIncludedCodexModelCatalog,
  reorderSpawnAgentCandidates,
  validateSpawnAgentCandidates,
  type CodexCatalogModel,
} from "@/utils/codexSpawnAgentCandidates";
import {
  extractCodexModelName,
  extractCodexExperimentalBearerToken,
  getCodexBaseUrl,
  removeCodexTopLevelField,
  setCodexModelName,
} from "@/utils/providerConfigUtils";
import {
  codexCatalogOnlyPlanModelFetchMessage,
  codexPlanModelListAction,
  isCodexCatalogOnlyPlanModelFetch,
} from "@/utils/codexPlanModelFetch";
import { normalizeCodexSubagentVersion } from "@/utils/codexSubagentVersion";
import {
  modelBindingIdentityValues,
  modelIdentityValues,
} from "@/lib/modelIdentities";
import {
  isCompleteCodexCatalogFetch,
  reconcileFetchedCodexCatalogRows,
} from "@/lib/codexCatalogReconciliation";
import {
  hasCodexCatalog,
  readCodexCatalogSettings,
} from "@/lib/codexCatalogSchema";
import {
  buildCodexModelReferenceIndex,
  canonicalizeCodexModelReferences,
  resolveCodexRouteModelReference,
  sanitizeCodexApiKeyGroups,
  sanitizeCodexProtocolOverrides,
  sanitizeCodexRoutingConfig,
} from "@/lib/codexConfigSanitizer";
import { pruneOutdatedCodexCatalogModels } from "@/lib/codexCatalogVersionPruning";
import { HostedToolsSwitchPanel } from "./HostedToolsSwitchPanel";
import { CodexSubagentProfileEditor } from "./CodexSubagentProfileEditor";
import { CodexEgressTimezoneStatusCard } from "./CodexEgressTimezoneStatusCard";
import { CodexSessionTrafficPanel } from "./CodexSessionTrafficPanel";
import { StreamRetryActivityPanel } from "./StreamRetryActivityPanel";
import { RequestHealthPanel } from "@/components/settings/RequestHealthPanel";
import type {
  CodexModelDisplayStyle,
  CodexOfficialAuthConfig,
  CodexReasoningEffort,
  CodexRoutingAuth,
  CodexRoutingAuthPolicy,
  CodexRoutingConfigV2,
  CodexRoutingRouteV2,
  CodexSubagentVersion,
  Provider,
} from "@/types";
import { getFreshInputTokens, type RequestLog } from "@/types/usage";
import { codexSubagentV2Api } from "@/lib/api/codexSubagentV2";
import type {
  CodexDiagnosticCheck,
  CodexDiagnosticStatus,
  CodexModelPickerUnlockResult,
  CodexMultiRouterDiagnostics,
  CodexRouteSummary,
  CodexRouterLogEvent,
  GlobalProxyConfig,
  ProxyStatus,
  RequestHealthSnapshot,
} from "@/types/proxy";

export type WorkspaceTab =
  | "overview"
  | "sources"
  | "routes"
  | "model-order"
  | "subagents"
  | "status"
  | "test";

type StatusView =
  | "link"
  | "protocol"
  | "debug"
  | "providers"
  | "traffic"
  | "request-health"
  | "stream-retry";

type SpawnAgentCandidateView = "selected" | "routed" | "priority" | "all";

// 模型菜单解锁只处理 Codex Desktop renderer 白名单，不改变 MultiRouter 路由或凭据。
const MODEL_PICKER_UNLOCK_TOOLTIP =
  "After enabling or confirming Codex takeover, CCSwitchMulti tries once automatically. Only a normally started Codex Desktop without remote debugging needs a full exit before using this action; after a CDP launch, switching a third-party API key does not require another unlock. This only patches the Desktop renderer model allowlist and does not change routes, API keys, or catalogs; CLI/app-server still use config.toml, model_catalog_json, local /v1/models, and MultiRouter routes.";

// 链路页需要给出明确下一步，避免用户只看到诊断异常却不知道要触发解锁。
const MODEL_PICKER_UNLOCK_HINT =
  "After enabling or confirming Codex takeover, CCSwitchMulti tries once automatically. If Desktop was started normally and the menu still only shows “Custom,” fully exit Codex Desktop and use “Unlock model menu.” CLI/app-server catalog repair uses live config, model_catalog_json, and local /v1/models; lowercase codex.exe does not need to be treated as a Desktop launch.";

type CodexRoute = {
  id?: string;
  label?: string;
  enabled?: boolean;
  targetProviderId?: string;
  target_provider_id?: string;
  providerId?: string;
  provider_id?: string;
  upstreamProviderId?: string;
  upstream_provider_id?: string;
  provider?: string;
  match?: {
    models?: string[];
    prefixes?: string[];
  };
  modelSelection?: { mode: "all" } | { mode: "include"; models: string[] };
  matchPrefixes?: string[];
  aliases?: Record<string, string>;
  authPolicy?: CodexRoutingAuthPolicy;
  upstream?: {
    baseUrl?: string;
    base_url?: string;
    apiFormat?: string;
    apiFormatSource?: "provider" | "route_override";
    wireApi?: string;
    wire_api?: string;
    targetProviderId?: string;
    target_provider_id?: string;
    providerId?: string;
    provider_id?: string;
    upstreamProviderId?: string;
    upstream_provider_id?: string;
    provider?: string;
    auth?: {
      source?: string;
      authProvider?: "codex_oauth";
      accountId?: string;
    };
    modelMap?: Record<string, string>;
  };
  capabilities?: {
    textOnly?: boolean;
    supportsReasoning?: boolean;
    inputModalities?: string[];
  };
};

type CodexRouteCapabilities = NonNullable<CodexRoute["capabilities"]>;

type CodexRouting = {
  schemaVersion?: 2;
  enabled?: boolean;
  defaultRouteId?: string;
  officialAuth?: CodexOfficialAuthConfig;
  subagentVersion?: CodexSubagentVersion;
  subagentV2?: CodexRoutingConfigV2["subagentV2"];
  spawnAgentModels?: string[];
  modelOrder?: string[];
  modelDisplayStyle?: CodexModelDisplayStyle;
  defaultReasoningEffort?: CodexReasoningEffort;
  routes?: CodexRoute[];
};

type RouteEntry = {
  provider: Provider;
  route: CodexRoute;
  index: number;
};

type RouteTrafficRow = {
  providerId: string;
  providerName: string;
  model: string;
  routeId: string | null;
  routeLabel: string | null;
  configuredProtocol: string | null;
  configuredProtocolSource: string | null;
  configuredProtocolDetail: string | null;
  lastObservedProtocol: string | null;
  lastObservedAt: string | null;
  lastObservedUpstreamUrl: string | null;
  lastObservedEndpoint: string | null;
  requestCount: number;
  successCount: number;
  failedCount: number;
  /** Cache-normalized fresh input; raw Codex input includes cache reads. */
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
};

type RouteTrafficTarget = {
  providerId: string;
  providerName: string;
};

type MultiRouterRuntimeStatus = {
  running: boolean;
  label: string;
  detail: string;
  tone: "ok" | "warn";
};

type RouteCandidate = {
  id: string;
  route: CodexRoute;
  provider?: Provider;
  canonicalProvider?: Provider;
  isExisting: boolean;
  matchModels: string[];
  matchPrefixes: string[];
};

type RoutePolicyDraft = {
  route: CodexRoute;
  prefixesText: string;
  aliasesText: string;
};

function parseRoutePolicyList(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[,\n]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function parseRouteAliases(value: string): {
  aliases: Record<string, string>;
  error?: string;
} {
  const aliases: Record<string, string> = {};
  for (const entry of value.split(/[,\n]/)) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0 || separator === trimmed.length - 1) {
      return {
        aliases,
        error: `Invalid alias format: ${trimmed}. Use “visible-model=upstream-model”.`,
      };
    }
    const visible = trimmed.slice(0, separator).trim();
    const canonical = trimmed.slice(separator + 1).trim();
    if (!visible || !canonical) {
      return {
        aliases,
        error: `Invalid alias format: ${trimmed}. Use “visible-model=upstream-model”.`,
      };
    }
    aliases[visible] = canonical;
  }
  return { aliases };
}

function routeAliasesText(aliases?: Record<string, string>): string {
  return Object.entries(aliases ?? {})
    .map(([visible, canonical]) => `${visible}=${canonical}`)
    .join("\n");
}

function collectProviderCanonicalModelIds(provider?: Provider): string[] {
  return provider ? collectProviderModelIds(provider) : [];
}

function normalizedModelIdentity(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function modelSelectionMatchesCatalogModel(
  selectedModels: Iterable<string>,
  catalogModel: CodexCatalogModel,
): boolean {
  const selected = new Set(
    Array.from(selectedModels).map(normalizedModelIdentity).filter(Boolean),
  );
  return modelIdentityValues(catalogModel).some((identity) =>
    selected.has(identity),
  );
}

function providerHasModelIdentity(
  provider: Provider,
  modelIdentity: string,
): boolean {
  const normalized = normalizedModelIdentity(modelIdentity);
  if (!normalized) return false;
  const catalogModels = readIncludedCodexModelCatalog(provider).models;
  if (providerHasCodexModelCatalog(provider)) {
    return catalogModels.some((model) =>
      modelIdentityValues(model).includes(normalized),
    );
  }
  return collectProviderCanonicalModelIds(provider).some(
    (model) => normalizedModelIdentity(model) === normalized,
  );
}

function providerModelIdentityMatchesSelection(
  provider: Provider | undefined,
  selectedModels: Iterable<string>,
  modelIdentity: string,
): boolean {
  const normalized = normalizedModelIdentity(modelIdentity);
  if (!normalized) return false;
  if (!provider) {
    return Array.from(selectedModels).some(
      (selected) => normalizedModelIdentity(selected) === normalized,
    );
  }
  const catalogModel = readCodexModelCatalog(provider).models.find(
    (model) =>
      model.enabled !== false &&
      modelIdentityValues(model).includes(normalized),
  );
  return catalogModel
    ? modelSelectionMatchesCatalogModel(selectedModels, catalogModel)
    : Array.from(selectedModels).some(
        (selected) => normalizedModelIdentity(selected) === normalized,
      );
}

// 编辑草稿必须保持持久化 route 的身份字段不变。展示名由渲染层解析，不能借
// 创建草稿的机会写回 label，否则一次仅为查看/保存的 UI 操作会改变旧 route 的
// 语义回退路径。
export function createRoutePolicyDraft(
  candidate: RouteCandidate,
): RoutePolicyDraft {
  const route = candidate.route;
  return {
    route: {
      ...route,
      modelSelection: route.modelSelection ?? { mode: "all" },
      matchPrefixes: route.matchPrefixes ?? route.match?.prefixes ?? [],
      aliases: route.aliases ?? route.upstream?.modelMap ?? {},
      authPolicy: route.authPolicy ??
        (route.upstream?.auth as CodexRoutingAuth | undefined) ?? {
          source: "provider_config",
        },
    },
    prefixesText: (route.matchPrefixes ?? route.match?.prefixes ?? []).join(
      ", ",
    ),
    aliasesText: routeAliasesText(route.aliases ?? route.upstream?.modelMap),
  };
}

/// 将用于人眼识别的 route/provider 文本规整成稳定 key，供旧配置和新 provider 做语义匹配。
function normalizedRouteIdentityText(value?: string | null): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

/// 收集 provider 可暴露的模型集合；旧 inline route 没有 targetProviderId 时用它判断是否与新增 provider 等价。
function providerRouteModelIdentitySet(provider: Provider): Set<string> {
  return new Set(
    [
      ...readIncludedCodexModelCatalog(provider).models.map(
        (model) => model.model,
      ),
      ...collectProviderModelIds(provider),
      ...inferProviderPrefixes(provider, collectProviderModelIds(provider)),
    ]
      .map(normalizedRouteIdentityText)
      .filter(Boolean),
  );
}

/// 旧版 route 可能只保存 label/match/upstream，没有 targetProviderId；这里用名称和模型交集找回对应模型源。
function findSemanticRouteProvider(
  route: CodexRoute,
  modelSources: Provider[],
): Provider | undefined {
  const targetProviderId = routeTargetProviderId(route);
  if (targetProviderId) {
    return modelSources.find((source) => source.id === targetProviderId);
  }

  const routeNames = [
    route.label,
    route.id,
    route.upstream?.provider,
    route.upstream?.providerId,
    route.upstream?.provider_id,
  ]
    .map(normalizedRouteIdentityText)
    .filter(Boolean);
  const routeModels = [
    ...(route.match?.models ?? []),
    ...(route.match?.prefixes ?? []),
  ]
    .map(normalizedRouteIdentityText)
    .filter(Boolean);

  const providerNameMatches = modelSources.filter((source) => {
    const providerNames = [source.id, source.name, source.meta?.providerType]
      .map((value) =>
        typeof value === "string" ? normalizedRouteIdentityText(value) : "",
      )
      .filter(Boolean);
    return (
      routeNames.some((name) => providerNames.includes(name)) ||
      providerNames.some((name) => routeNames.includes(name))
    );
  });
  if (providerNameMatches.length === 1) return providerNameMatches[0];
  if (providerNameMatches.length > 1) return undefined;

  const providerModelMatches = modelSources.filter((source) => {
    const providerModels = providerRouteModelIdentitySet(source);
    return routeModels.some((model) => providerModels.has(model));
  });
  return providerModelMatches.length === 1
    ? providerModelMatches[0]
    : undefined;
}

/// route 去重以真实目标 provider 优先；没有目标 provider 的旧 route 则退回到语义匹配出的 provider。
function routeSemanticProviderId(
  route: CodexRoute,
  modelSources: Provider[],
): string | undefined {
  return (
    routeTargetProviderId(route) ??
    findSemanticRouteProvider(route, modelSources)?.id
  );
}

/// 已保存 route 中可能同时存在“旧 inline 规则”和“复用供应商配置规则”；展示和保存前都要归并。
export function dedupeCodexRoutesBySemanticProvider(
  routes: CodexRoute[],
  modelSources: Provider[],
): CodexRoute[] {
  const seenProviderIds = new Set<string>();
  const result: CodexRoute[] = [];
  for (const route of routes) {
    const semanticProviderId = routeSemanticProviderId(route, modelSources);
    if (semanticProviderId) {
      if (seenProviderIds.has(semanticProviderId)) continue;
      seenProviderIds.add(semanticProviderId);
    }
    result.push(route);
  }
  return result;
}

type MultiRouterSettingsDraft = {
  name: string;
  notes?: string;
  enabled: boolean;
  hostedTools: {
    webSearch: boolean;
    imageGeneration: boolean;
  };
};

export function resolveCodexRouterAuthFacadeLabel(
  officialAuth: CodexOfficialAuthConfig,
  poolPolicy?: CodexAccountPoolPolicy,
  translate?: (
    key: string,
    options: { defaultValue: string; [key: string]: unknown },
  ) => string,
): string {
  if (officialAuth.mode === "desktop_current_login") {
    return (
      translate?.("codexRouterAuth.facadeNativeMixed", {
        defaultValue: "Desktop / hybrid authentication",
      }) ?? "Desktop / hybrid authentication"
    );
  }
  if (officialAuth.mode === "managed_oauth") {
    return (
      translate?.("codexRouterAuth.facadeManaged", {
        defaultValue: "CCSM-managed authentication",
      }) ?? "CCSM-managed authentication"
    );
  }
  if (!poolPolicy)
    return (
      translate?.("codexRouterAuth.facadePending", {
        defaultValue: "Pending confirmation",
      }) ?? "Pending confirmation"
    );
  const nativeMixed =
    poolPolicy.enabled &&
    poolPolicy.entries.some(
      (entry) => entry.accountId === "native_codex_auth" && entry.enabled,
    );
  return nativeMixed
    ? (translate?.("codexRouterAuth.facadeNativeMixed", {
        defaultValue: "Desktop / hybrid authentication",
      }) ?? "Desktop / hybrid authentication")
    : (translate?.("codexRouterAuth.facadeManaged", {
        defaultValue: "CCSM-managed authentication",
      }) ?? "CCSM-managed authentication");
}

type ProviderModelRefreshState = {
  status: "loading" | "success" | "error" | "skipped";
  message: string;
  modelCount?: number;
};

// 自动刷新事务的内部结果；读取和写回分开返回，便于统一控制 loading 终态。
type ProviderModelRefreshResult =
  | { status: "stale" }
  | { status: "empty"; message?: string }
  | {
      status: "updated";
      models: FetchedModel[];
      nextProvider: Provider;
      usedCodexFallback?: boolean;
      onlineErrorMessage?: string;
    };

type ProviderModelFetchConfig = {
  baseUrl: string;
  apiKey: string;
  isFullUrl: boolean;
  customUserAgent?: string;
  volcengineModelListAction?: string;
  volcengineAccessKeyId?: string;
  volcengineSecretAccessKey?: string;
  codexOAuthAccountId?: string;
  useCodexOAuth?: boolean;
  skipReason?: string;
};

type ProxyListenDraftValidation =
  | {
      ok: true;
      listenAddress: string;
      listenPort: number;
      baseUrl: string;
    }
  | {
      ok: false;
      error: string;
    };

type CodexCatalogModelDraft = {
  model: string;
  upstreamModel?: string;
  upstream_model?: string;
  canonicalSlug?: string;
  canonical_slug?: string;
  slug?: string;
  aliases?: string[] | Record<string, string>;
  displayName?: string;
  display_name?: string;
  providerName?: string;
  provider_name?: string;
  apiFormatSource?: string;
  api_format_source?: string;
  contextWindow?: string | number;
  context_window?: string | number;
  inputModalities?: string[];
  input_modalities?: string[];
  textOnly?: boolean;
  text_only?: boolean;
  supportsImage?: boolean;
  supports_image?: boolean;
  vision?: boolean;
  supportsParallelToolCalls?: boolean;
  supports_parallel_tool_calls?: boolean;
  baseInstructions?: string;
  base_instructions?: string;
  apiFormat?: CodexCatalogModel["apiFormat"];
  api_format?: CodexCatalogModel["api_format"];
  codexCache?: CodexCatalogModel["codexCache"];
  codex_cache?: CodexCatalogModel["codex_cache"];
  sortIndex?: number;
  enabled?: boolean;
  reasoning?: CodexCatalogModel["reasoning"];
  codexUltra?: CodexCatalogModel["codexUltra"];
  capabilities?: CodexRouteCapabilities;
};

/// 读取 catalog 条目的真实上游模型名；未配置别名映射时，上游模型名就是可见模型名。
function catalogDraftUpstreamModel(model: {
  model?: string;
  upstreamModel?: string;
  upstream_model?: string;
  canonicalSlug?: string;
  canonical_slug?: string;
  slug?: string;
}): string {
  return (
    model.upstreamModel ??
    model.upstream_model ??
    model.canonicalSlug ??
    model.canonical_slug ??
    model.slug ??
    model.model ??
    ""
  ).trim();
}

type CodexModelCatalogDraft = {
  displayNameStyle?: CodexModelDisplayStyle;
  models: CodexCatalogModelDraft[];
  spawnAgentModels?: string[];
};

const DEFAULT_CODEX_PROXY_LISTEN_ADDRESS = "127.0.0.1";
const DEFAULT_CODEX_PROXY_LISTEN_PORT = 15721;
const MODEL_REFRESH_TIMEOUT_MS = 30_000;

/// 生成候选 provider /models 刷新的去重键；API Key 用短哈希参与比较，避免换 key 后仍复用旧请求。
function buildProviderModelRefreshAttemptKey(
  providerId: string,
  fetchConfig: ProviderModelFetchConfig,
): string {
  return [
    providerId,
    fetchConfig.baseUrl,
    hashSensitiveAttemptPart(fetchConfig.apiKey),
    fetchConfig.isFullUrl,
    fetchConfig.customUserAgent ?? "",
    fetchConfig.volcengineModelListAction ?? "",
    hashSensitiveAttemptPart(fetchConfig.volcengineAccessKeyId ?? ""),
    hashSensitiveAttemptPart(fetchConfig.volcengineSecretAccessKey ?? ""),
    fetchConfig.useCodexOAuth ?? false,
    hashSensitiveAttemptPart(fetchConfig.codexOAuthAccountId ?? ""),
  ].join("|");
}

/// 为敏感字段生成仅用于内存比较的稳定短哈希，避免把完整 API Key 塞进刷新状态键。
function hashSensitiveAttemptPart(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${value.length}:${(hash >>> 0).toString(16)}`;
}

/// 给前端自动刷新加一层兜底超时；后端正常有 timeout，但 IPC 异常挂起时也必须让 UI 退出 loading。
function withModelRefreshTimeout<T>(
  promise: Promise<T>,
  timeoutMs = MODEL_REFRESH_TIMEOUT_MS,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      onTimeout?.();
      reject(
        new Error(
          `Reading or writing the model list exceeded ${Math.round(timeoutMs / 1000)} seconds. Check the network, the provider /models endpoint, or local config write status.`,
        ),
      );
    }, timeoutMs);

    promise.then(resolve, reject).finally(() => window.clearTimeout(timeoutId));
  });
}

/// 将后端机器码集中翻译为用户可执行的中文信息；原始详情仍保留在后端日志中。
export function workspaceErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const knownMessages: Array<[string, string]> = [
    [
      "codex_provider_set_probe_required",
      "Compatibility evidence is missing, stale, or does not match the current configuration; no probe was sent automatically. Probe and explicitly save it in the model-source editor or setup wizard.",
    ],
    [
      "codex_provider_set_split_confirmation_required",
      "This model source supports multiple protocols and needs explicit confirmation in the model-source editor or setup wizard. Valid evidence can be reused; no probe was sent automatically. The existing configuration is unchanged.",
    ],
    ["include_models_empty", "Select at least one upstream model"],
    [
      "include_models_duplicate_or_empty",
      "The upstream model list contains empty or duplicate entries; choose again",
    ],
    [
      "alias_target_not_selected",
      "An alias target must be one of the currently selected upstream models",
    ],
    ["route_target_provider_required", "This route has no target provider"],
    [
      "legacy_route_requires_migration",
      "This is a legacy route configuration; complete migration before saving",
    ],
  ];
  const matched = knownMessages.find(([code]) => message.includes(code));
  if (matched) return matched[1];
  if (/[^\x00-\x7f]/.test(message)) return message;

  const errorCode = message.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/)?.[0];
  return errorCode
    ? `Operation failed. See the logs for details (error code: ${errorCode}).`
    : "Operation failed. Check the current configuration or see the logs for details.";
}

/// 读取 provider 模型列表；官方 OAuth 不可用时回退到无需 OAuth 的可信官方目录。
async function fetchProviderModelsWithFallback(
  fetchConfig: ProviderModelFetchConfig,
): Promise<{
  models: FetchedModel[];
  usedCodexFallback: boolean;
  onlineErrorMessage?: string;
}> {
  if (!fetchConfig.useCodexOAuth) {
    return {
      models: await fetchModelsForConfig(
        fetchConfig.baseUrl,
        fetchConfig.apiKey,
        fetchConfig.isFullUrl,
        undefined,
        fetchConfig.customUserAgent,
        fetchConfig.volcengineModelListAction
          ? {
              action: fetchConfig.volcengineModelListAction,
              accessKeyId: fetchConfig.volcengineAccessKeyId ?? "",
              secretAccessKey: fetchConfig.volcengineSecretAccessKey ?? "",
            }
          : undefined,
      ),
      usedCodexFallback: false,
    };
  }

  try {
    return {
      models: await fetchCodexOauthModels(fetchConfig.codexOAuthAccountId),
      usedCodexFallback: false,
    };
  } catch (error) {
    const onlineErrorMessage = workspaceErrorMessage(error);
    const fallbackModels = await fetchCodexOfficialFallbackModels();
    return {
      models: fallbackModels,
      usedCodexFallback: fallbackModels.length > 0,
      onlineErrorMessage,
    };
  }
}

/// 提取普通 Codex provider 的 /models 读取配置；官方 OAuth/缺少普通端点的 provider 不走这里。
function getProviderModelFetchConfig(
  provider: Provider,
): ProviderModelFetchConfig {
  const settings = provider.settingsConfig ?? {};
  const configText = typeof settings.config === "string" ? settings.config : "";
  const auth =
    settings.auth &&
    typeof settings.auth === "object" &&
    !Array.isArray(settings.auth)
      ? (settings.auth as Record<string, unknown>)
      : {};
  const baseUrl = String(
    settings.base_url ??
      settings.baseURL ??
      settings.baseUrl ??
      getCodexBaseUrl(provider) ??
      "",
  ).trim();
  const apiKey = String(
    auth.OPENAI_API_KEY ??
      settings.apiKey ??
      settings.api_key ??
      extractCodexExperimentalBearerToken(configText) ??
      "",
  ).trim();
  const planFetchSource = {
    baseUrl,
    partnerPromotionKey: provider.meta?.partnerPromotionKey,
    providerName: provider.name,
    apiKey,
    accessKeyId: provider.meta?.usage_script?.accessKeyId,
    secretAccessKey: provider.meta?.usage_script?.secretAccessKey,
  };
  const planModelListAction = codexPlanModelListAction(planFetchSource);
  const isCatalogOnlyPlan = isCodexCatalogOnlyPlanModelFetch(planFetchSource);
  const isOfficialLike = isWizardCodexOAuthSource(provider);

  if (isOfficialLike) {
    return {
      baseUrl,
      apiKey,
      isFullUrl: false,
      useCodexOAuth: true,
      codexOAuthAccountId: readWizardCodexOAuthAccountId(provider),
    };
  }
  if (!baseUrl) {
    return {
      baseUrl,
      apiKey,
      isFullUrl: false,
      skipReason: "Base URL is missing; the model list cannot be read.",
    };
  }
  if (isCatalogOnlyPlan) {
    const hasModelCatalog = readCodexModelCatalog(provider).models.some(
      (model) => (model.model ?? "").trim(),
    );
    return {
      baseUrl,
      apiKey,
      isFullUrl: false,
      skipReason: codexCatalogOnlyPlanModelFetchMessage(
        hasModelCatalog,
        planFetchSource,
      ),
    };
  }
  if (!apiKey && !planModelListAction) {
    return {
      baseUrl,
      apiKey,
      isFullUrl: false,
      skipReason: "API key is missing; the model list cannot be read.",
    };
  }

  return {
    baseUrl,
    apiKey,
    isFullUrl: Boolean(provider.meta?.isFullUrl ?? settings.isFullUrl),
    customUserAgent:
      typeof provider.meta?.customUserAgent === "string"
        ? provider.meta.customUserAgent
        : typeof settings.customUserAgent === "string"
          ? settings.customUserAgent
          : undefined,
    ...(planModelListAction
      ? {
          volcengineModelListAction: planModelListAction,
          volcengineAccessKeyId: planFetchSource.accessKeyId,
          volcengineSecretAccessKey: planFetchSource.secretAccessKey,
        }
      : {}),
  };
}

/// 将远端模型结果写回 provider 的 modelCatalog；普通源保留用户筛选，OAuth 源则追加官方新发布模型。
export function providerWithFetchedModelCatalog(
  provider: Provider,
  fetchedModels: FetchedModel[],
): Provider {
  const currentCatalog = readCodexModelCatalog(provider);
  const fetchConfig = getProviderModelFetchConfig(provider);
  const shouldAppendFetchedModels =
    currentCatalog.models.length === 0 || isWizardCodexOAuthSource(provider);
  const result = reconcileFetchedCodexCatalogRows(
    currentCatalog.models,
    fetchedModels,
    {
      providerId: provider.id,
      providerName: provider.name,
      baseUrl: fetchConfig.baseUrl,
    },
    {
      appendNew: shouldAppendFetchedModels,
      createRow: (seed) => seed as CodexCatalogModel,
      existingMetadataMode: "refresh",
      // A successful fetch is the source of truth for routing. Rows omitted
      // by it remain editable but are disabled so "follow all" cannot revive
      // removed upstream IDs.
      removeMissingRemote: isCompleteCodexCatalogFetch(
        provider.settingsConfig?.codexApiKeyGroups,
      ),
      includeUnboundRemoteRows: true,
      markMissingRemoteDisabled: true,
      newRowEnabled: currentCatalog.models.length === 0,
      contextWindowFormat: "number",
    },
  );
  return providerWithReconciledModelCatalog(provider, result.rows);
}

/** Catalog mutations must update source-owned references in the same save. */
function providerWithReconciledModelCatalog(
  provider: Provider,
  models: CodexCatalogModel[],
  providersById?: Map<string, Provider>,
): Provider {
  const settings = provider.settingsConfig;
  const catalog = (readCodexCatalogSettings(settings) ?? {}) as Record<
    string,
    any
  >;
  const index = buildCodexModelReferenceIndex(models);
  const nextCatalog: Record<string, any> = {
    ...catalog,
    models,
    spawnAgentModels: normalizeCodexSpawnAgentModels(
      canonicalizeCodexModelReferences(
        catalog.spawnAgentModels ?? catalog.spawn_agent_models,
        index,
        5,
      ),
      models,
    ),
  };
  delete nextCatalog.spawn_agent_models;
  const nextSettings: Record<string, any> = {
    ...settings,
    modelCatalog: nextCatalog,
  };
  delete nextSettings.model_catalog;
  if (settings.codexRouting) {
    nextSettings.codexRouting = sanitizeCodexRoutingConfig(
      settings.codexRouting,
      index,
      (targetProviderId) => {
        if (targetProviderId === provider.id) return index;
        const target = providersById?.get(targetProviderId);
        return target && providerHasCodexModelCatalog(target)
          ? buildCodexModelReferenceIndex(
              readIncludedCodexModelCatalog(target).models,
            )
          : undefined;
      },
    );
  }
  if (Array.isArray(settings.codexApiKeyGroups)) {
    nextSettings.codexApiKeyGroups = sanitizeCodexApiKeyGroups(
      settings.codexApiKeyGroups,
      index,
    );
  }
  return {
    ...provider,
    settingsConfig: withReconciledCodexDefaultModel(nextSettings, models),
    ...(provider.meta?.codexProtocolOverrides
      ? {
          meta: {
            ...provider.meta,
            codexProtocolOverrides: sanitizeCodexProtocolOverrides(
              provider.meta.codexProtocolOverrides,
              index,
            ),
          },
        }
      : {}),
  };
}

/// 把监听地址转换成客户端可连接的 host；0.0.0.0/:: 只能绑定，不能直接作为 Codex base_url。
export function codexProxyConnectHost(listenAddress: string): string {
  const trimmed = listenAddress.trim();
  if (trimmed === "0.0.0.0") return "127.0.0.1";
  if (trimmed === "::") return "::1";
  return trimmed || DEFAULT_CODEX_PROXY_LISTEN_ADDRESS;
}

/// 根据监听地址和端口生成 Codex Desktop 实际使用的 OpenAI Responses base_url。
export function buildCodexProxyBaseUrl(
  listenAddress: string,
  listenPort: number,
): string {
  const connectHost = codexProxyConnectHost(listenAddress);
  const hostForUrl =
    connectHost.includes(":") && !connectHost.startsWith("[")
      ? `[${connectHost}]`
      : connectHost;
  return `http://${hostForUrl}:${listenPort}/v1`;
}

/// 校验 MultiRouter 设置页里的本地代理监听草稿，避免保存空地址或非法端口导致接管配置不可用。
export function validateProxyListenDraft(
  listenAddress: string,
  listenPort: string,
): ProxyListenDraftValidation {
  const address = listenAddress.trim() || DEFAULT_CODEX_PROXY_LISTEN_ADDRESS;
  const portText = listenPort.trim();
  if (!/^\d+$/.test(portText)) {
    return {
      ok: false,
      error: "The listen port must be a number from 1024 to 65535.",
    };
  }
  const port = Number.parseInt(portText, 10);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return {
      ok: false,
      error: "The listen port must be a number from 1024 to 65535.",
    };
  }
  return {
    ok: true,
    listenAddress: address,
    listenPort: port,
    baseUrl: buildCodexProxyBaseUrl(address, port),
  };
}

function codexRouteUsesOfficialAuthentication(route: CodexRoute): boolean {
  const source = route.upstream?.auth?.source;
  if (
    source === "native_codex_auth" ||
    source === "managed_codex_oauth" ||
    source === "managed_account" ||
    source === "account_pool"
  ) {
    return true;
  }
  return routeTargetProviderId(route) === "codex-official";
}

/// 汇总当前 MultiRouter 的运行态；只有当前方案已发布为 Codex provider 且代理/接管/入口/规则齐全才算运行中。
export function buildMultiRouterRuntimeStatus({
  selectedPlan,
  selectedRouting,
  enabledRouteCount,
  isProxyRunning,
  isCodexTakeoverActive,
  activeProviderId,
}: {
  selectedPlan: Provider | null;
  selectedRouting: CodexRouting | null;
  enabledRouteCount: number;
  isProxyRunning: boolean;
  isCodexTakeoverActive: boolean;
  activeProviderId?: string;
}): MultiRouterRuntimeStatus {
  if (!selectedPlan) {
    return {
      running: false,
      label: "Not selected",
      detail: "No MultiRouter is selected.",
      tone: "warn",
    };
  }
  if (activeProviderId !== selectedPlan.id) {
    return {
      running: false,
      label: "Not published",
      detail: `The current Codex provider is ${activeProviderId || "not set"}, not ${selectedPlan.id}.`,
      tone: "warn",
    };
  }
  if (!isProxyRunning) {
    return {
      running: false,
      label: "Proxy not running",
      detail:
        "The local takeover proxy is not listening on 15721, so Codex requests will not enter MultiRouter.",
      tone: "warn",
    };
  }
  if (!isCodexTakeoverActive) {
    return {
      running: false,
      label: "Codex not taken over",
      detail: "Codex live config does not point to the local proxy.",
      tone: "warn",
    };
  }
  if (selectedRouting?.enabled === false) {
    return {
      running: false,
      label: "Entry disabled",
      detail:
        "The MultiRouter entry is disabled; rules are retained but do not route traffic.",
      tone: "warn",
    };
  }
  if (enabledRouteCount === 0) {
    return {
      running: false,
      label: "No enabled rules",
      detail:
        "The current MultiRouter has no enabled routing rules, so Codex requests cannot be split by model.",
      tone: "warn",
    };
  }
  return {
    running: true,
    label: "Running",
    detail:
      "The current MultiRouter is running as the Codex provider; Codex requests enter the local proxy for routing.",
    tone: "ok",
  };
}

/// 从 Provider 私有配置里读取 Codex 多模型路由配置；没有配置时返回 null，避免把普通模型源误判成路由方案。
export function readCodexRouting(
  provider: Provider | null | undefined,
): CodexRouting | null {
  if (!provider) return null;
  const routing = provider.settingsConfig?.codexRouting;
  if (!routing || typeof routing !== "object") return null;
  if (Array.isArray(routing)) {
    return {
      enabled: true,
      subagentVersion: "v2",
      routes: routing.map(normalizeLegacyCodexRoutingRoute),
    };
  }
  if ((routing as { schemaVersion?: unknown }).schemaVersion === 2) {
    const v2 = routing as CodexRoutingConfigV2;
    return {
      schemaVersion: 2,
      enabled: v2.enabled,
      defaultRouteId: v2.defaultRouteId,
      officialAuth: v2.officialAuth,
      modelOrder: v2.modelOrder,
      modelDisplayStyle: v2.modelDisplayStyle,
      defaultReasoningEffort: v2.defaultReasoningEffort,
      subagentVersion: normalizeCodexSubagentVersion(v2.subagentVersion),
      subagentV2: v2.subagentV2,
      spawnAgentModels: v2.spawnAgentModels ?? [],
      routes: v2.routes.map((route) => {
        const modelSelection = route.modelSelection ?? { mode: "all" as const };
        return {
          ...route,
          modelSelection,
          match: {
            models:
              modelSelection.mode === "include" ? modelSelection.models : [],
            prefixes: route.matchPrefixes ?? [],
          },
          upstream: {
            auth: route.authPolicy,
            modelMap: route.aliases,
          },
        };
      }),
    };
  }
  return {
    ...(routing as Omit<CodexRouting, "subagentVersion">),
    subagentVersion: normalizeCodexSubagentVersion(
      (routing as { subagentVersion?: unknown }).subagentVersion,
    ),
  };
}

/// 将旧版扁平 route 数组条目转换成新版 `codexRouting.routes[]` 条目，避免保存时清空历史路由。
function normalizeLegacyCodexRoutingRoute(
  route: any,
  index: number,
): CodexRoute {
  const models = Array.isArray(route?.models)
    ? route.models.filter(
        (item: unknown): item is string => typeof item === "string",
      )
    : Array.isArray(route?.match?.models)
      ? route.match.models.filter(
          (item: unknown): item is string => typeof item === "string",
        )
      : [];
  const prefixes = Array.isArray(route?.modelPrefixes)
    ? route.modelPrefixes
    : Array.isArray(route?.model_prefixes)
      ? route.model_prefixes
      : Array.isArray(route?.match?.prefixes)
        ? route.match.prefixes
        : [];
  const upstream = route?.upstream ?? {};
  return {
    id: String(route?.id || `route-${index + 1}`),
    label: typeof route?.label === "string" ? route.label : route?.name,
    enabled: route?.enabled !== false,
    targetProviderId:
      route?.targetProviderId ??
      route?.target_provider_id ??
      route?.providerId ??
      route?.provider_id ??
      upstream?.targetProviderId ??
      upstream?.target_provider_id ??
      upstream?.providerId ??
      upstream?.provider_id ??
      route?.provider ??
      upstream?.provider,
    match: {
      models,
      prefixes: prefixes.filter(
        (item: unknown): item is string => typeof item === "string",
      ),
    },
    upstream: {
      baseUrl:
        upstream?.baseUrl ??
        upstream?.baseURL ??
        upstream?.base_url ??
        route?.baseUrl ??
        route?.baseURL ??
        route?.base_url,
      apiFormat:
        upstream?.apiFormat ??
        upstream?.wireApi ??
        upstream?.wire_api ??
        route?.apiFormat ??
        route?.wireApi ??
        route?.wire_api,
      auth: upstream?.auth ?? route?.auth,
      modelMap: upstream?.modelMap ?? route?.modelMap,
    },
    capabilities: route?.capabilities,
  };
}

/// 判断一个 Provider 是否已经承载 Codex 多模型路由；即使暂时关闭，只要有规则也归为路由方案方便继续编辑。
export { isUserCodexRoutingPlan as isRoutingPlan } from "@/lib/codexProviderKind";

/// 提取 route 的上游协议名，兼容历史字段和 UI 字段。
function routeApiFormat(route: CodexRoute): string {
  return (
    route.upstream?.apiFormat ??
    route.upstream?.wireApi ??
    route.upstream?.wire_api ??
    "openai_chat"
  );
}

/// 提取 route 引用的真实目标 Provider ID。
function routeTargetProviderId(route: CodexRoute): string | undefined {
  return [
    route.targetProviderId,
    route.target_provider_id,
    route.providerId,
    route.provider_id,
    route.upstreamProviderId,
    route.upstream_provider_id,
    route.provider,
    route.upstream?.targetProviderId,
    route.upstream?.target_provider_id,
    route.upstream?.providerId,
    route.upstream?.provider_id,
    route.upstream?.upstreamProviderId,
    route.upstream?.upstream_provider_id,
    route.upstream?.provider,
  ]
    .map((value) => value?.trim())
    .find(Boolean);
}

/// 查找 route 引用的真实目标 Provider。
function routeTargetProvider(
  route: CodexRoute,
  providersById: Map<string, Provider>,
): Provider | undefined {
  const targetProviderId = routeTargetProviderId(route);
  return targetProviderId ? providersById.get(targetProviderId) : undefined;
}

/// Distinguish an explicitly empty catalog from a provider that predates the
/// catalog contract. An empty catalog is authoritative and must not revive
/// legacy route match fields.
function providerHasCodexModelCatalog(provider: Provider | undefined): boolean {
  return hasCodexCatalog(provider?.settingsConfig);
}

/// 规则名称优先使用用户可读 label；历史 route 缺少 label 时跟随目标 Provider 名称，最后才暴露稳定 ID。
function routeDisplayName(
  route: CodexRoute,
  providersById: Map<string, Provider>,
  fallback = "Unnamed rule",
): string {
  const label = route.label?.trim();
  const routeId = route.id?.trim();
  if (label && (!routeId || label.toLowerCase() !== routeId.toLowerCase())) {
    return label;
  }
  const providerName = routeTargetProvider(route, providersById)?.name?.trim();
  return providerName || label || routeId || fallback;
}

export function routeSummaryDisplayName(
  label: string | null | undefined,
  routeId: string | null | undefined,
  providerName: string | null | undefined,
  fallback = "Unnamed rule",
): string {
  const normalizedLabel = label?.trim();
  const normalizedRouteId = routeId?.trim();
  if (
    normalizedLabel &&
    (!normalizedRouteId ||
      normalizedLabel.toLowerCase() !== normalizedRouteId.toLowerCase())
  ) {
    return normalizedLabel;
  }
  return (
    providerName?.trim() || normalizedLabel || normalizedRouteId || fallback
  );
}

function routeDisplayTitle(
  routeName: string,
  routeId: string | null | undefined,
): string | undefined {
  const normalizedRouteId = routeId?.trim();
  if (!normalizedRouteId || routeName === normalizedRouteId) return undefined;
  return `${routeName} (ID: ${normalizedRouteId})`;
}

/// 把 provider 或 route 标识清理成稳定的路由 ID 片段；空值回退到 fallback，避免保存后出现不可选规则。
function safeRouteIdPart(value: string | undefined, fallback: string): string {
  const normalized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

/// 在候选路由集合内生成不冲突的 ID；已有配置优先保留，新增 provider 才追加序号。
function uniqueRouteId(preferredId: string, usedIds: Set<string>): string {
  const base = safeRouteIdPart(preferredId, "route");
  if (!usedIds.has(base)) {
    usedIds.add(base);
    return base;
  }

  let index = 2;
  while (usedIds.has(`${base}-${index}`)) index += 1;
  const nextId = `${base}-${index}`;
  usedIds.add(nextId);
  return nextId;
}

/// 从真实模型目录里推断精确模型名；没有目录时只读取显式单模型字段，不能伪造 OAuth 模型权限。
function collectProviderModelIds(provider: Provider): string[] {
  const catalogModels = readIncludedCodexModelCatalog(provider)
    .models.map((model) => model.model?.trim())
    .filter((model): model is string => Boolean(model));
  if (providerHasCodexModelCatalog(provider)) {
    return Array.from(new Set(catalogModels));
  }
  const singleModelFields = [
    provider.settingsConfig?.model,
    provider.settingsConfig?.defaultModel,
    provider.settingsConfig?.default_model,
  ].filter(
    (model): model is string => typeof model === "string" && !!model.trim(),
  );
  return Array.from(new Set([...catalogModels, ...singleModelFields]));
}

/// 从 provider 的 catalog 生成 route 级别模型映射；MultiRouter 后端只物化目标 provider，
/// 因此可见别名必须随 route 保存，不能依赖未改写的源 provider catalog。
function buildRouteModelMapFromProvider(
  provider: Provider,
): Record<string, string> | undefined {
  const entries = readIncludedCodexModelCatalog(provider)
    .models.map((model) => {
      const visibleModel = model.model?.trim();
      const upstreamModel = (
        model.upstreamModel ??
        model.upstream_model ??
        model.model ??
        ""
      ).trim();
      return visibleModel && upstreamModel && visibleModel !== upstreamModel
        ? [visibleModel, upstreamModel]
        : null;
    })
    .filter((entry): entry is [string, string] => Boolean(entry));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/// 归一化模型名尾段，用于保守识别已知纯文本模型，避免 provider 名称大小写或平台前缀影响判断。
function normalizeModelTailForCapability(model: string): string {
  const normalized = model.trim().toLowerCase();
  return normalized.split("/").pop() ?? normalized;
}

/// 少量内置纯文本模型兜底；只在 provider/catalog 没有显式能力声明时使用，避免把未知多模态模型误降级。
function modelNameLooksTextOnly(model: string): boolean {
  const tail = normalizeModelTailForCapability(model);
  const exactTextOnlyModels = new Set([
    "ark-code-latest",
    "deepseek-chat",
    "deepseek-reasoner",
    "deepseek-v4-flash",
    "deepseek-v4-pro",
    "glm-5.1",
    "kat-coder",
    "kat-coder-pro",
    "kat-coder-pro-v1",
    "kat-coder-pro-v2",
    "ling-2.5-1t",
    "longcat-flash-chat",
    "mimo-v2.5-pro",
    "us.deepseek.r1-v1",
  ]);
  return (
    // DeepSeek 文本角色族（flash/pro，含日期版本），与 Rust 侧口径一致；
    // *-vision* 是视觉模型，不走该文本兜底。
    deepSeekRoleForModel(tail) !== null ||
    exactTextOnlyModels.has(tail) ||
    tail.startsWith("minimax-m2.7") ||
    tail.startsWith("qwen3-coder") ||
    tail.startsWith("step-3.5-flash")
  );
}

/// 从单个 catalog 模型条目读取图片输入能力；显式字段优先于模型名兜底。
function imageSupportFromCatalogModel(
  model: CodexCatalogModel | CodexCatalogModelDraft,
): boolean | undefined {
  const supportsImage = model.supportsImage ?? model.supports_image;
  if (typeof supportsImage === "boolean") return supportsImage;
  if (typeof model.vision === "boolean") return model.vision;
  const textOnly = model.textOnly ?? model.text_only;
  if (typeof textOnly === "boolean") return !textOnly;
  const modalities = model.inputModalities ?? model.input_modalities;
  if (Array.isArray(modalities)) {
    return modalities.some((item) => item.toLowerCase() === "image");
  }
  return undefined;
}

/// 把图片能力结论转成 route/catalog 都能消费的统一能力对象。
function capabilitiesFromImageSupport(
  supportsImage: boolean | undefined,
): CodexRouteCapabilities | undefined {
  if (supportsImage === undefined) return undefined;
  return supportsImage
    ? { inputModalities: ["text", "image"], textOnly: false }
    : { inputModalities: ["text"], textOnly: true };
}

/// 基于目标 provider 的 catalog 和 route 匹配模型推断能力；不会把未知模型默认标成图文。
function inferRouteCapabilitiesFromProvider(
  provider: Provider,
  modelIds: string[],
): CodexRouteCapabilities | undefined {
  const catalogModels = readIncludedCodexModelCatalog(provider).models;
  const modelSet = new Set(
    modelIds.map((model) => model.trim()).filter(Boolean),
  );
  const relevantCatalogModels =
    modelSet.size > 0
      ? catalogModels.filter(
          (model) => model.model && modelSet.has(model.model),
        )
      : catalogModels;
  const imageSupport = relevantCatalogModels
    .map(imageSupportFromCatalogModel)
    .find((value): value is boolean => value !== undefined);
  if (imageSupport !== undefined) {
    return capabilitiesFromImageSupport(imageSupport);
  }

  const relevantModelIds =
    modelSet.size > 0
      ? Array.from(modelSet)
      : catalogModels
          .map((model) => model.model?.trim())
          .filter((model): model is string => Boolean(model));
  if (
    relevantModelIds.length > 0 &&
    relevantModelIds.every(modelNameLooksTextOnly)
  ) {
    return capabilitiesFromImageSupport(false);
  }
  return undefined;
}

/// 旧版 MultiRouter 候选曾经给所有 route 写入“图文 + 推理”的默认能力；这不是用户显式配置。
function isLegacyDefaultRouteCapabilities(
  capabilities?: CodexRouteCapabilities,
): boolean {
  if (!capabilities) return false;
  const modalities = capabilities.inputModalities ?? [];
  return (
    capabilities.textOnly === false &&
    capabilities.supportsReasoning === true &&
    modalities.length === 2 &&
    modalities.includes("text") &&
    modalities.includes("image")
  );
}

/// 用目标 provider 的真实能力修正 route；保留用户显式写入的非旧默认能力。
function normalizeRouteCapabilitiesFromProvider(
  route: CodexRoute,
  provider?: Provider,
): CodexRoute {
  if (!provider) return route;
  const inferred = inferRouteCapabilitiesFromProvider(
    provider,
    route.match?.models ?? collectProviderModelIds(provider),
  );
  if (!inferred) return route;
  if (
    route.capabilities &&
    !isLegacyDefaultRouteCapabilities(route.capabilities)
  ) {
    return route;
  }
  return { ...route, capabilities: inferred };
}

/// 从模型源 catalog 条目构造 MultiRouter 自己的 catalog 草稿；保留上下文窗口字段供 Codex 与第三方 API 继续透传。
function catalogDraftFromSourceModel(
  id: string,
  source?: CodexCatalogModelDraft | CodexCatalogModel,
  provider?: Provider,
): CodexCatalogModelDraft {
  const settings = provider?.settingsConfig;
  const displayName = source?.displayName ?? source?.display_name;
  const upstreamModel = source?.upstreamModel ?? source?.upstream_model;
  const contextWindow =
    source?.contextWindow ??
    source?.context_window ??
    settings?.contextWindow ??
    settings?.context_window ??
    settings?.modelContextWindow;
  const inputModalities =
    source?.inputModalities ??
    source?.input_modalities ??
    settings?.inputModalities ??
    settings?.input_modalities;
  const reasoning =
    source?.reasoning ??
    settings?.reasoning ??
    settings?.codexChatReasoning ??
    settings?.codex_chat_reasoning ??
    provider?.meta?.codexChatReasoning;
  const codexCache =
    source?.codexCache ??
    source?.codex_cache ??
    settings?.codexCache ??
    settings?.codex_cache ??
    provider?.meta?.codexCache;
  const apiFormat =
    source?.apiFormat ??
    source?.api_format ??
    provider?.meta?.apiFormat ??
    settings?.apiFormat ??
    settings?.api_format;
  const effectiveSource = {
    ...(source ?? {}),
    model: id,
    ...(inputModalities ? { inputModalities } : {}),
  };
  const capabilities = capabilitiesFromImageSupport(
    source || inputModalities
      ? imageSupportFromCatalogModel(effectiveSource)
      : undefined,
  );
  return {
    model: id,
    ...(upstreamModel && upstreamModel !== id ? { upstreamModel } : {}),
    ...(source?.canonicalSlug
      ? { canonicalSlug: source.canonicalSlug }
      : source?.canonical_slug
        ? { canonical_slug: source.canonical_slug }
        : {}),
    ...(source?.slug ? { slug: source.slug } : {}),
    ...(source?.aliases ? { aliases: source.aliases } : {}),
    ...(displayName ? { displayName } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(inputModalities ? { inputModalities } : {}),
    ...(source?.textOnly !== undefined ? { textOnly: source.textOnly } : {}),
    ...(source?.text_only !== undefined ? { text_only: source.text_only } : {}),
    ...(source?.supportsImage !== undefined
      ? { supportsImage: source.supportsImage }
      : {}),
    ...(source?.supports_image !== undefined
      ? { supports_image: source.supports_image }
      : {}),
    ...(source?.vision !== undefined ? { vision: source.vision } : {}),
    ...(source?.supportsParallelToolCalls !== undefined
      ? { supportsParallelToolCalls: source.supportsParallelToolCalls }
      : source?.supports_parallel_tool_calls !== undefined
        ? { supportsParallelToolCalls: source.supports_parallel_tool_calls }
        : {}),
    ...(source?.baseInstructions
      ? { baseInstructions: source.baseInstructions }
      : source?.base_instructions
        ? { baseInstructions: source.base_instructions }
        : {}),
    ...(provider ? { providerName: provider.name } : {}),
    apiFormatSource:
      source?.apiFormatSource ??
      source?.api_format_source ??
      (source?.apiFormat || source?.api_format ? "provider_model" : "provider"),
    ...(apiFormat ? { apiFormat } : {}),
    ...(codexCache ? { codexCache } : {}),
    ...(source?.codexUltra ? { codexUltra: source.codexUltra } : {}),
    ...(source?.sortIndex !== undefined ? { sortIndex: source.sortIndex } : {}),
    ...(capabilities ? { capabilities } : {}),
  };
}

/// 汇总所有模型源的模型目录；对象 catalog 优先，字符串模型名作为无元数据兜底。
function buildModelCatalogDraftFromSources(
  modelSources: Provider[],
): CodexCatalogModelDraft[] {
  const byModel = new Map<string, CodexCatalogModelDraft>();

  for (const provider of modelSources) {
    const sourceCatalogModels = readIncludedCodexModelCatalog(provider).models;
    for (const catalogModel of sourceCatalogModels) {
      const id = catalogModel.model?.trim();
      if (!id || byModel.has(id)) continue;
      byModel.set(id, catalogDraftFromSourceModel(id, catalogModel, provider));
    }

    for (const model of collectProviderModelIds(provider)) {
      const id = model.trim();
      if (!id || byModel.has(id)) continue;
      byModel.set(id, { model: id });
    }
  }

  return Array.from(byModel.values());
}

/// 根据 provider 名称和模型名推断少量前缀；只作为无精确模型目录时的兜底，避免把路由规则做成空匹配。
function inferProviderPrefixes(
  provider: Provider,
  modelIds: string[],
): string[] {
  const text = `${provider.id} ${provider.name}`.toLowerCase();
  const prefixes = new Set<string>();
  const knownPrefixes = [
    "gpt",
    "o1",
    "o3",
    "o4",
    "qwen",
    "deepseek",
    "glm",
    "gemini",
    "claude",
  ];
  for (const prefix of knownPrefixes) {
    if (
      text.includes(prefix) ||
      modelIds.some((model) => model.toLowerCase().startsWith(prefix))
    ) {
      prefixes.add(prefix);
    }
  }
  if (text.includes("openai")) {
    ["gpt", "o1", "o3", "o4"].forEach((prefix) => prefixes.add(prefix));
  }
  return Array.from(prefixes);
}

/// 已保存的历史 route 可能没有 match 条件；编辑时用目标 Provider 的目录和名称推断一次，保存后写回稳定规则。
function enrichRouteMatchFromProvider(
  route: CodexRoute,
  provider?: Provider,
): CodexRoute {
  const existingModels = route.match?.models ?? [];
  const existingPrefixes = route.match?.prefixes ?? [];
  if (!provider || existingModels.length > 0 || existingPrefixes.length > 0) {
    return route;
  }
  const modelIds = collectProviderModelIds(provider);
  return {
    ...route,
    match: {
      models: modelIds,
      prefixes: inferProviderPrefixes(provider, modelIds),
    },
  };
}

/// 为普通模型源创建一条引用 provider 配置的路由；不复制 API Key/Base URL，避免工作台把来源配置写散。
function createRouteFromProvider(
  provider: Provider,
  usedIds: Set<string>,
): CodexRoute {
  const modelIds = collectProviderModelIds(provider);
  const prefixes = inferProviderPrefixes(provider, modelIds);
  const modelMap = buildRouteModelMapFromProvider(provider);
  const authPolicy = { source: "provider_config" as const };
  return {
    id: uniqueRouteId(`router-${provider.id}`, usedIds),
    label: provider.name,
    enabled: true,
    targetProviderId: provider.id,
    modelSelection: { mode: "all" },
    matchPrefixes: prefixes,
    aliases: modelMap,
    authPolicy,
    match: {
      models: modelIds,
      prefixes,
    },
    upstream: {
      auth: authPolicy,
      ...(modelMap ? { modelMap } : {}),
    },
  };
}

/// 合并现有 route 和所有普通模型源，给规则页提供“直接勾选候选 router”的完整候选列表。
function buildRouteCandidates(
  selectedPlan: Provider | null,
  modelSources: Provider[],
): RouteCandidate[] {
  const routableModelSources = resolveWizardModelNameCollisions(modelSources);
  const usedIds = new Set<string>();
  const candidates: RouteCandidate[] = [];
  const existingRoutes = selectedPlan
    ? dedupeCodexRoutesBySemanticProvider(
        readCodexRouting(selectedPlan)?.routes ?? [],
        routableModelSources,
      )
    : [];

  for (const route of existingRoutes) {
    const targetProviderId = routeTargetProviderId(route);
    const id = uniqueRouteId(
      route.id ?? targetProviderId ?? route.label ?? "route",
      usedIds,
    );
    const normalizedRoute: CodexRoute = { ...route, id };
    const provider =
      (targetProviderId
        ? routableModelSources.find((source) => source.id === targetProviderId)
        : undefined) ??
      findSemanticRouteProvider(normalizedRoute, routableModelSources);
    const canonicalProvider = provider
      ? modelSources.find((source) => source.id === provider.id)
      : findSemanticRouteProvider(normalizedRoute, modelSources);
    const routeWithInferredMatch = enrichRouteMatchFromProvider(
      normalizedRoute,
      provider,
    );
    const routeWithInferredCapabilities =
      normalizeRouteCapabilitiesFromProvider(routeWithInferredMatch, provider);
    candidates.push({
      id,
      route: routeWithInferredCapabilities,
      provider,
      canonicalProvider,
      isExisting: true,
      matchModels: routeWithInferredCapabilities.match?.models ?? [],
      matchPrefixes: routeWithInferredCapabilities.match?.prefixes ?? [],
    });
  }

  const existingProviderIds = new Set(
    candidates
      .map(
        (candidate) =>
          candidate.provider?.id ?? routeTargetProviderId(candidate.route),
      )
      .filter((id): id is string => Boolean(id)),
  );
  for (const provider of routableModelSources) {
    if (existingProviderIds.has(provider.id)) continue;
    const route = createRouteFromProvider(provider, usedIds);
    candidates.push({
      id: route.id!,
      route,
      provider,
      canonicalProvider: modelSources.find(
        (source) => source.id === provider.id,
      ),
      isExisting: false,
      matchModels: route.match?.models ?? [],
      matchPrefixes: route.match?.prefixes ?? [],
    });
  }

  return candidates;
}

/// 初次打开候选选择器时，根据已保存规则和入口意图生成“是否加入”的本地草稿。
function buildInitialRoutePickerSelectedIds(
  candidates: RouteCandidate[],
  selectAllByDefault?: boolean,
): Set<string> {
  return new Set(
    candidates
      .filter((candidate) => selectAllByDefault || candidate.isExisting)
      .map((candidate) => candidate.id),
  );
}

/// 初次打开候选选择器时，根据已保存规则和入口意图生成“是否启用”的本地草稿。
function buildInitialRoutePickerEnabledIds(
  candidates: RouteCandidate[],
  selectAllByDefault?: boolean,
): Set<string> {
  return new Set(
    candidates
      .filter(
        (candidate) => selectAllByDefault || candidate.route.enabled !== false,
      )
      .map((candidate) => candidate.id),
  );
}

/// 候选列表刷新时只为新出现的 router 应用默认值，已有候选保留用户尚未保存的勾选/启用草稿。
export function mergeRoutePickerDraftIds(
  currentIds: Set<string>,
  previousCandidateIds: string[],
  nextCandidateIds: string[],
  defaultIncludedIds: string[],
): Set<string> {
  const previousCandidateIdSet = new Set(previousCandidateIds);
  const nextCandidateIdSet = new Set(nextCandidateIds);
  const nextIds = new Set(
    Array.from(currentIds).filter((id) => nextCandidateIdSet.has(id)),
  );

  for (const id of defaultIncludedIds) {
    if (!previousCandidateIdSet.has(id) && nextCandidateIdSet.has(id)) {
      nextIds.add(id);
    }
  }

  return nextIds;
}

/// 把候选选择器里的宽松 route 规整成后端路由器可直接消费的稳定结构。
export function normalizeCodexRouteForSave(
  route: CodexRoute,
  index: number,
  usedIds: Set<string>,
): CodexRoute {
  const id = uniqueRouteId(
    route.id ??
      routeTargetProviderId(route) ??
      route.label ??
      `route-${index + 1}`,
    usedIds,
  );
  return {
    ...route,
    id,
    enabled: route.enabled !== false,
    targetProviderId: routeTargetProviderId(route),
    match: {
      models: route.match?.models ?? [],
      prefixes: route.match?.prefixes ?? [],
    },
    upstream: {
      ...route.upstream,
      apiFormat: routeApiFormat(route),
      auth: route.upstream?.auth ?? { source: "provider_config" },
    },
  };
}

/// 将工作台内部兼容视图收敛为 schema v2 Route；任何地址、密钥、协议和能力字段都会在此边界被丢弃。
export function serializeCodexRouteV2(
  route: CodexRoute,
  index: number,
): CodexRoutingRouteV2 {
  const targetProviderId = routeTargetProviderId(route);
  if (!targetProviderId) {
    throw new Error(`route_target_provider_required:${route.id ?? index}`);
  }
  const aliases = route.aliases ?? route.upstream?.modelMap ?? {};
  const requestedModels = route.match?.models ?? [];
  const canonicalModels = Array.from(
    new Set(
      requestedModels
        .map((model) => aliases[model] ?? model)
        .map((model) => model.trim())
        .filter(Boolean),
    ),
  );
  const modelSelection =
    route.modelSelection?.mode === "all"
      ? ({ mode: "all" } as const)
      : ({
          mode: "include" as const,
          models:
            route.modelSelection?.mode === "include"
              ? route.modelSelection.models
              : canonicalModels,
        } as const);
  const authPolicy: CodexRoutingAuthPolicy = route.authPolicy ??
    (route.upstream?.auth as CodexRoutingAuth | undefined) ?? {
      source: "provider_config",
    };
  return {
    id: route.id ?? `route-${index + 1}`,
    ...(route.label ? { label: route.label } : {}),
    enabled: route.enabled !== false,
    targetProviderId,
    modelSelection,
    matchPrefixes: route.matchPrefixes ?? route.match?.prefixes ?? [],
    aliases: Object.fromEntries(
      Object.entries(aliases).filter(
        ([visible, canonical]) =>
          visible.trim() !== "" &&
          canonical.trim() !== "" &&
          visible !== canonical,
      ),
    ),
    ...(targetProviderId === "codex-official"
      ? {}
      : {
          authPolicy: {
            source: authPolicy.source,
            ...(authPolicy.accountId?.trim()
              ? { accountId: authPolicy.accountId.trim() }
              : {}),
          },
        }),
  };
}

function serializeCodexRoutingV2(routing: CodexRouting): CodexRoutingConfigV2 {
  return {
    schemaVersion: 2,
    enabled: routing.enabled,
    defaultRouteId: routing.defaultRouteId,
    officialAuth: routing.officialAuth,
    modelOrder: routing.modelOrder,
    modelDisplayStyle: routing.modelDisplayStyle,
    defaultReasoningEffort: routing.defaultReasoningEffort,
    subagentVersion: routing.subagentVersion,
    subagentV2: routing.subagentV2,
    spawnAgentModels: routing.spawnAgentModels ?? [],
    routes: (routing.routes ?? []).map(serializeCodexRouteV2),
  };
}

/// 建立当前方案里已有 catalog 的索引；修复旧 route 时用它找回可见名背后的真实上游模型。
function buildExistingCatalogByModel(
  plan: Provider,
): Map<string, CodexCatalogModelDraft> {
  const existingModels = readCodexModelCatalog(plan)
    .models as CodexCatalogModelDraft[];
  const existingModelById = new Map<string, CodexCatalogModelDraft>();
  for (const model of existingModels) {
    const id = model.model?.trim();
    if (id) existingModelById.set(id, model);
  }
  return existingModelById;
}

/// 解析 route 中某个可见模型真正要发给上游的模型名；route modelMap 优先于聚合 catalog。
function routeModelUpstreamForAliasRepair(
  route: CodexRoute,
  visibleModel: string,
  existingModelById: Map<string, CodexCatalogModelDraft>,
): string {
  const catalogModel = existingModelById.get(visibleModel);
  return (
    route.upstream?.modelMap?.[visibleModel] ??
    catalogModel?.upstreamModel ??
    catalogModel?.upstream_model ??
    visibleModel
  ).trim();
}

/// 手动保存 routes 前按 collision-resolved provider catalog 修复可见模型名。
///
/// 运行时只能根据 `request.model` 字符串匹配 route；如果官方和中转同时保存
/// `gpt-*` 这类同名 exact match，就会按 route 顺序抢路由。这里在保存前把非
/// canonical provider 的可见模型改成稳定别名，并同步写回 route 级 modelMap。
export function normalizeCodexRoutesForVisibleModelAliases(
  plan: Provider,
  routes: CodexRoute[],
  providersById: Map<string, Provider>,
): CodexRoute[] {
  const legacyModelById =
    readCodexRouting(plan)?.schemaVersion === 2
      ? new Map<string, CodexCatalogModelDraft>()
      : buildExistingCatalogByModel(plan);
  return routes.map((route) => {
    const targetProvider = routeTargetProvider(route, providersById);
    const targetCatalogModels = targetProvider
      ? readIncludedCodexModelCatalog(targetProvider).models
      : [];
    if (!targetProvider || targetCatalogModels.length === 0) return route;

    const targetModelByUpstream = new Map<
      string,
      CodexCatalogModel | CodexCatalogModelDraft
    >();
    const targetModelByVisible = new Map<
      string,
      CodexCatalogModel | CodexCatalogModelDraft
    >();
    for (const model of targetCatalogModels) {
      const visible = model.model?.trim();
      if (!visible) continue;
      targetModelByVisible.set(visible, model);
      const upstream = catalogDraftUpstreamModel(model);
      if (upstream && !targetModelByUpstream.has(upstream)) {
        targetModelByUpstream.set(upstream, model);
      }
    }

    const nextModels: string[] = [];
    for (const visibleModel of route.match?.models ?? []) {
      const trimmedVisible = visibleModel.trim();
      if (!trimmedVisible) continue;
      const upstream = routeModelUpstreamForAliasRepair(
        route,
        trimmedVisible,
        legacyModelById,
      );
      const targetModel =
        targetModelByUpstream.get(upstream) ??
        targetModelByVisible.get(trimmedVisible);
      const nextVisible = targetModel?.model?.trim() ?? trimmedVisible;
      if (nextVisible && !nextModels.includes(nextVisible)) {
        nextModels.push(nextVisible);
      }
    }

    const nextModelMapEntries = nextModels
      .map((visibleModel) => {
        const targetModel = targetModelByVisible.get(visibleModel);
        const upstream = targetModel
          ? catalogDraftUpstreamModel(targetModel)
          : routeModelUpstreamForAliasRepair(
              route,
              visibleModel,
              legacyModelById,
            );
        return upstream && upstream !== visibleModel
          ? [visibleModel, upstream]
          : null;
      })
      .filter((entry): entry is [string, string] => Boolean(entry));
    const nextModelMap =
      nextModelMapEntries.length > 0
        ? Object.fromEntries(nextModelMapEntries)
        : undefined;
    const nextAliases = {
      ...(nextModelMap ?? {}),
      ...(route.aliases ?? {}),
    };
    const { modelMap: _modelMap, ...upstreamWithoutModelMap } =
      route.upstream ?? {};

    return {
      ...route,
      aliases: nextAliases,
      match: {
        ...(route.match ?? {}),
        models: nextModels,
      },
      upstream: {
        ...upstreamWithoutModelMap,
        ...(nextModelMap ? { modelMap: nextModelMap } : {}),
      },
    };
  });
}

/// 判断某个 catalog 可见模型是否真的会被当前 route 接住。
///
/// MultiRouter runtime 只按请求里的可见模型字符串做 exact/prefix 匹配；如果 catalog
/// 暴露了 route 不匹配的模型，Codex 选择器会让用户选到一个随后落入其他 route 的模型。
function routeCanMatchVisibleCatalogModel(
  route: CodexRoute,
  catalogModel: string | CodexCatalogModel,
): boolean {
  const model =
    typeof catalogModel === "string"
      ? catalogModel.trim()
      : catalogModel.model.trim();
  if (!model) return false;
  const identities =
    typeof catalogModel === "string"
      ? [model.toLowerCase()]
      : modelIdentityValues(catalogModel);
  if (route.modelSelection?.mode === "include") {
    // Schema-v2 modelSelection is authoritative. Legacy match.models can
    // survive in older drafts, but must not widen an explicit allowlist.
    return modelSelectionMatchesCatalogModel(
      route.modelSelection.models,
      typeof catalogModel === "string" ? { model } : catalogModel,
    );
  }
  const exactModels = route.match?.models ?? [];
  if (
    exactModels.some((matchedModel) =>
      identities.includes(normalizedModelIdentity(matchedModel)),
    )
  ) {
    return true;
  }
  const prefixMatched = (route.match?.prefixes ?? []).some((prefix) => {
    const normalizedPrefix = prefix.trim().toLowerCase();
    return (
      normalizedPrefix &&
      identities.some((identity) => identity.startsWith(normalizedPrefix))
    );
  });
  if (!prefixMatched) return false;
  return true;
}

/// route 能力比 provider catalog 更接近最终路由结果；写入聚合 catalog，确保 Codex 看到的模型能力与规则一致。
function applyRouteCapabilitiesToCatalogModel(
  model: CodexCatalogModelDraft,
  route: CodexRoute,
): CodexCatalogModelDraft {
  if (!route.capabilities) return model;
  return {
    ...model,
    capabilities: route.capabilities,
    inputModalities:
      route.capabilities.inputModalities ?? model.inputModalities,
    textOnly: route.capabilities.textOnly ?? model.textOnly,
  };
}

/// 从已选 route 和目标模型源汇总 MultiRouter 的模型目录；Codex 选择器和 spawn_agent 都依赖这个目录。
export function buildModelCatalogForRoutes(
  plan: Provider,
  routes: CodexRoute[],
  providersById: Map<string, Provider>,
  options?: {
    pruneOutdatedModels?: boolean;
    ignorePersistedModelOrder?: boolean;
  },
): CodexModelCatalogDraft {
  const routing = readCodexRouting(plan);
  const isSchemaV2 = routing?.schemaVersion === 2;
  const existingCatalog = readCodexCatalogSettings(plan.settingsConfig);
  const legacyModelById = isSchemaV2
    ? new Map<string, CodexCatalogModelDraft>()
    : buildExistingCatalogByModel(plan);

  const byModel = new Map<string, CodexCatalogModelDraft>();
  for (const route of routes) {
    if (route.enabled === false) continue;
    const targetProvider = routeTargetProviderId(route)
      ? providersById.get(routeTargetProviderId(route)!)
      : undefined;
    const targetProviderId = routeTargetProviderId(route);
    const hasTargetCatalog = providerHasCodexModelCatalog(targetProvider);
    const targetCatalogModels = targetProvider
      ? readIncludedCodexModelCatalog(targetProvider).models
      : [];
    const aliases = Object.entries(
      route.aliases ?? route.upstream?.modelMap ?? {},
    );
    const sourceIndex = buildCodexModelReferenceIndex(targetCatalogModels);
    const selectedSourceModels =
      isSchemaV2 && route.modelSelection?.mode === "include"
        ? new Set(
            route.modelSelection.models
              .map((model) =>
                resolveCodexRouteModelReference(
                  model,
                  sourceIndex,
                  route.aliases,
                ),
              )
              .filter((model): model is string => Boolean(model)),
          )
        : undefined;
    if (!isSchemaV2) {
      for (const [visible, upstream] of aliases) {
        if (targetCatalogModels.some((entry) => entry.model === visible))
          continue;
        const source = targetCatalogModels.find(
          (entry) =>
            normalizedModelIdentity(entry.model) ===
              normalizedModelIdentity(upstream) ||
            normalizedModelIdentity(catalogDraftUpstreamModel(entry)) ===
              normalizedModelIdentity(upstream),
        );
        if (source) {
          targetCatalogModels.push({
            ...source,
            model: visible.trim(),
            upstreamModel: catalogDraftUpstreamModel(source),
          });
        }
      }
    }
    const selectedCatalogModels =
      route.modelSelection?.mode === "all"
        ? targetCatalogModels.filter(
            (catalogModel) => catalogModel.enabled !== false,
          )
        : targetCatalogModels.filter(
            (catalogModel) =>
              catalogModel.enabled !== false &&
              (selectedSourceModels
                ? selectedSourceModels.has(catalogModel.model)
                : routeCanMatchVisibleCatalogModel(route, catalogModel)),
          );
    // The v2 compiler replaces a selected row's visible name with its explicit
    // aliases. Alias targets may use either its picker ID or its upstream ID.
    const routableCatalogModels = isSchemaV2
      ? selectedCatalogModels.flatMap((model) => {
          const upstream = catalogDraftUpstreamModel(model);
          const visibleAliases = aliases.filter(
            ([visible, target]) =>
              visible.trim() &&
              (normalizedModelIdentity(target) ===
                normalizedModelIdentity(model.model) ||
                normalizedModelIdentity(target) ===
                  normalizedModelIdentity(upstream)),
          );
          return visibleAliases.length > 0
            ? visibleAliases.map(([visible]) => ({
                ...model,
                model: visible.trim(),
                upstreamModel: upstream,
              }))
            : [model];
        })
      : selectedCatalogModels;
    for (const catalogModel of routableCatalogModels) {
      const id = catalogModel.model?.trim();
      if (!id || byModel.has(id)) continue;
      byModel.set(
        id,
        applyRouteCapabilitiesToCatalogModel(
          catalogDraftFromSourceModel(id, catalogModel, targetProvider),
          route,
        ),
      );
    }
    const fallbackModels =
      hasTargetCatalog || (isSchemaV2 && Boolean(targetProviderId))
        ? []
        : route.modelSelection?.mode === "include"
          ? route.modelSelection.models
          : (route.match?.models ?? []);
    for (const model of fallbackModels) {
      const id = model.trim();
      if (!id || byModel.has(id)) continue;
      // A persisted route is policy, not evidence that an excluded model exists.
      if (legacyModelById.get(id)?.enabled === false) continue;
      byModel.set(
        id,
        applyRouteCapabilitiesToCatalogModel(
          legacyModelById.get(id) ?? { model: id },
          route,
        ),
      );
    }
  }

  const routingSpawnAgentModels = routing?.spawnAgentModels;
  const existingSpawnAgentModels = Array.isArray(routingSpawnAgentModels)
    ? routingSpawnAgentModels
    : !isSchemaV2 && Array.isArray(existingCatalog?.spawnAgentModels)
      ? (existingCatalog.spawnAgentModels as string[])
      : [];
  const projectedModels = applyCodexCatalogModelOrder(
    Array.from(byModel.values()),
    options?.ignorePersistedModelOrder ? [] : (routing?.modelOrder ?? []),
  );
  const models = options?.pruneOutdatedModels
    ? pruneOutdatedCodexCatalogModels(projectedModels).kept
    : projectedModels;
  const modelIds = models.map((model) => model.model);
  const modelIdSet = new Set(modelIds);
  const spawnAgentModels = existingSpawnAgentModels
    .filter((model) => modelIdSet.has(model))
    .concat(
      modelIds.filter((model) => !existingSpawnAgentModels.includes(model)),
    )
    .slice(0, 5);
  return {
    models,
    spawnAgentModels,
    displayNameStyle: routing?.modelDisplayStyle ?? "provider-model",
  };
}

/// 工作台只读使用 compiler 等价投影，不把聚合 catalog 写回 Router Provider。
export function projectCodexModelCatalog(
  plan: Provider | null,
  providersById: Map<string, Provider>,
): CodexModelCatalogDraft {
  if (!plan) return { models: [], spawnAgentModels: [] };
  const projected = buildModelCatalogForRoutes(
    plan,
    readCodexRouting(plan)?.routes ?? [],
    providersById,
  );
  const models = projected.models.filter((model) => model.enabled !== false);
  const modelIds = new Set(models.map((model) => model.model));
  return {
    ...projected,
    models,
    spawnAgentModels: (projected.spawnAgentModels ?? []).filter((model) =>
      modelIds.has(model),
    ),
  };
}

/** Reconcile persisted policy against source catalogs before strict router saves. */
export function reconcileCodexRoutingPlanForSave(
  plan: Provider,
  providersById: Map<string, Provider>,
): Provider {
  const routing = plan.settingsConfig?.codexRouting;
  if (routing?.schemaVersion !== 2) return plan;
  const resolveRouteIndex = (providerId: string) => {
    const provider = providersById.get(providerId);
    return providerHasCodexModelCatalog(provider) && provider
      ? buildCodexModelReferenceIndex(
          readIncludedCodexModelCatalog(provider).models,
        )
      : undefined;
  };
  const options = { preserveUpstreamReferences: true };
  const routeReconciledRouting = sanitizeCodexRoutingConfig(
    routing,
    buildCodexModelReferenceIndex(
      projectCodexModelCatalog(plan, providersById).models,
    ),
    resolveRouteIndex,
    options,
  );
  const reconciledPlan: Provider = {
    ...plan,
    settingsConfig: {
      ...withoutDerivedRouterCatalog(plan.settingsConfig),
      codexRouting: {
        ...routing,
        routes: routeReconciledRouting?.routes,
      },
    },
  };
  // Pruned aliases or emptied selections can shrink the router's own catalog.
  const catalog = projectCodexModelCatalog(reconciledPlan, providersById);
  const index = buildCodexModelReferenceIndex(catalog.models);
  reconciledPlan.settingsConfig.codexRouting = sanitizeCodexRoutingConfig(
    reconciledPlan.settingsConfig.codexRouting,
    index,
    resolveRouteIndex,
    options,
  );
  reconciledPlan.settingsConfig = withReconciledCodexDefaultModel(
    reconciledPlan.settingsConfig,
    catalog.models,
  );
  return reconciledPlan;
}

function withReconciledCodexDefaultModel(
  settingsConfig: Record<string, any>,
  models: CodexCatalogModel[],
): Record<string, any> {
  const config = settingsConfig.config;
  if (typeof config === "string") {
    const defaultModel = extractCodexModelName(config);
    const resolvedDefault =
      buildCodexModelReferenceIndex(models).resolve(defaultModel);
    if (defaultModel && resolvedDefault !== defaultModel) {
      const nextDefault =
        resolvedDefault ??
        models.find((model) => model.enabled !== false)?.model;
      return {
        ...settingsConfig,
        config: nextDefault
          ? setCodexModelName(config, nextDefault)
          : removeCodexTopLevelField(config, "model"),
      };
    }
  }
  return settingsConfig;
}

/// 生成工作台专用的新 MultiRouter provider；它只承载路由配置，不再让用户填写无关的上游密钥表单。
export function createDraftRoutingPlan(
  providers: Provider[],
  modelSources: Provider[],
): Provider {
  const routableModelSources = resolveWizardModelNameCollisions(modelSources);
  const existingIds = new Set(providers.map((provider) => provider.id));
  const id = uniqueRouteId("codex-multirouter", existingIds);
  const catalogModels = buildModelCatalogDraftFromSources(routableModelSources);
  const sourceModels = catalogModels.map((model) => model.model);
  return {
    id,
    name: "New Codex MultiRouter",
    category: "custom",
    settingsConfig: {
      auth: {},
      base_url: buildCodexProxyBaseUrl(
        DEFAULT_CODEX_PROXY_LISTEN_ADDRESS,
        DEFAULT_CODEX_PROXY_LISTEN_PORT,
      ),
      baseUrl: buildCodexProxyBaseUrl(
        DEFAULT_CODEX_PROXY_LISTEN_ADDRESS,
        DEFAULT_CODEX_PROXY_LISTEN_PORT,
      ),
      config: null,
      codexRouting: {
        schemaVersion: 2,
        enabled: true,
        subagentVersion: "v2",
        spawnAgentModels: Array.from(new Set(sourceModels)).slice(0, 5),
        routes: [],
      },
      hostedTools: DEFAULT_HOSTED_TOOLS_CONFIG,
    },
    createdAt: Date.now(),
  };
}

function withoutDerivedRouterCatalog(
  settingsConfig: Record<string, any>,
): Record<string, any> {
  const next = { ...settingsConfig };
  delete next.modelCatalog;
  delete next.model_catalog;
  return next;
}

/// MultiRouter 设置页只允许修改方案元信息和入口开关；路由规则、模型目录和本地代理接管配置都继续由工作台自动维护。
export function applyMultiRouterSettingsDraft(
  plan: Provider,
  draft: MultiRouterSettingsDraft,
): Provider {
  const currentRouting = readCodexRouting(plan) ?? {};
  const nextRouting: CodexRouting = {
    ...currentRouting,
    enabled: draft.enabled,
  };
  delete nextRouting.defaultRouteId;

  return {
    ...plan,
    name: draft.name.trim() || plan.name,
    notes: draft.notes?.trim() || undefined,
    settingsConfig: writeHostedToolsConfig(
      {
        ...(nextRouting.schemaVersion === 2
          ? withoutDerivedRouterCatalog(plan.settingsConfig)
          : plan.settingsConfig),
        auth: plan.settingsConfig?.auth ?? {},
        base_url:
          plan.settingsConfig?.base_url ??
          buildCodexProxyBaseUrl(
            DEFAULT_CODEX_PROXY_LISTEN_ADDRESS,
            DEFAULT_CODEX_PROXY_LISTEN_PORT,
          ),
        baseUrl:
          plan.settingsConfig?.baseUrl ??
          plan.settingsConfig?.base_url ??
          buildCodexProxyBaseUrl(
            DEFAULT_CODEX_PROXY_LISTEN_ADDRESS,
            DEFAULT_CODEX_PROXY_LISTEN_PORT,
          ),
        config: plan.settingsConfig?.config ?? null,
        codexRouting:
          nextRouting.schemaVersion === 2
            ? serializeCodexRoutingV2(nextRouting)
            : nextRouting,
      },
      {
        webSearch: { enabled: draft.hostedTools.webSearch },
        imageGeneration: { enabled: draft.hostedTools.imageGeneration },
      },
    ),
  };
}

/// 提取 route 的上游地址；引用真实 Provider 时展示目标 Provider 的配置。
function routeBaseUrl(
  route: CodexRoute,
  providersById?: Map<string, Provider>,
): string {
  const target = providersById
    ? routeTargetProvider(route, providersById)
    : undefined;
  if (target) {
    const config = target.settingsConfig ?? {};
    return (
      config.base_url ??
      config.baseURL ??
      config.baseUrl ??
      `Reuse provider configuration: ${target.name}`
    );
  }
  return (
    route.upstream?.baseUrl ??
    route.upstream?.base_url ??
    "Inherit model-source endpoint"
  );
}

/// 把内部认证枚举翻译成页面可理解的中文说明，避免把 provider_config 这类工程词直接丢给用户。
function authSourceLabel(source?: string): string {
  switch (source) {
    case "managed_codex_oauth":
      return "Managed Codex OAuth";
    case "native_codex_auth":
      return "Current Codex login";
    case "account_pool":
      return "OAuth account pool";
    case "managed_account":
      return "Managed account";
    case "provider_config":
      return "Use route API key";
    default:
      return "Inherit model-source credentials";
  }
}

/// 把内部协议枚举翻译成用户能识别的接口类型。
function apiFormatLabel(format: string): string {
  switch (format) {
    case "openai_responses":
      return "OpenAI Responses";
    case "openai_messages":
      return "OpenAI Messages";
    case "openai_chat":
      return "OpenAI Chat";
    default:
      return format;
  }
}

/// 把后端协议判定来源翻译成用户能直接理解的说明。
function protocolDecisionSourceLabel(source?: string | null): string {
  switch (source) {
    case "managed_codex_oauth":
      return "Official Codex OAuth";
    case "provider_meta_api_format":
      return "Provider meta.apiFormat";
    case "settings_api_format":
      return "Provider apiFormat";
    case "known_chat_completions_only_url":
      return "Known Chat-only endpoint";
    case "config_wire_api":
      return "config.toml wire_api";
    case "default_responses":
      return "Default Responses";
    default:
      return source || "Not probed";
  }
}

/// 汇总 route 可匹配的模型名和前缀，用于列表和测试页展示。
function routeMatchSummary(route: CodexRoute): string {
  const models = route.match?.models?.filter(Boolean) ?? [];
  const prefixes = route.match?.prefixes?.filter(Boolean) ?? [];
  const parts = [
    models.length > 0 ? `Exact models: ${models.join(", ")}` : "",
    prefixes.length > 0 ? `Model prefixes: ${prefixes.join(", ")}` : "",
  ].filter(Boolean);
  return parts.join("; ") || "No match conditions set";
}

/// 将固定白名单与 Provider 当前模型目录对照展示，避免 Provider 新增模型后看起来像“没有刷新”。
function routeProviderModelSyncSummary(
  route: CodexRoute,
  provider?: Provider,
): string | null {
  if (!provider) return null;
  const providerModels = collectProviderCanonicalModelIds(provider);
  if (route.modelSelection?.mode !== "include") {
    return `Connected ${providerModels.length}/${providerModels.length} models (follow provider automatically)`;
  }

  const selected = route.modelSelection.models;
  const providerCatalogModels = readCodexModelCatalog(provider).models.filter(
    (model) => model.enabled !== false,
  );
  const connected = providerModels.filter((model) =>
    providerModelIdentityMatchesSelection(provider, selected, model),
  );
  const excluded = providerModels.filter(
    (model) =>
      !providerModelIdentityMatchesSelection(provider, selected, model),
  );
  const stale = selected.filter((model) =>
    providerCatalogModels.length > 0
      ? !providerCatalogModels.some((catalogModel) =>
          modelSelectionMatchesCatalogModel([model], catalogModel),
        )
      : !providerModels.some(
          (providerModel) =>
            normalizedModelIdentity(providerModel) ===
            normalizedModelIdentity(model),
        ),
  );
  const parts = [
    `Connected ${connected.length}/${providerModels.length} models`,
  ];
  if (excluded.length > 0) parts.push(`Not connected: ${excluded.join(", ")}`);
  if (stale.length > 0) parts.push(`No longer available: ${stale.join(", ")}`);
  return parts.join("; ");
}

/// 根据当前 MultiRouter 规则反查 catalog 中真实存在的模型，用于子 Agent 候选页的“路由命中”选项卡。
export function collectRoutedCatalogModels(
  routes: RouteEntry[],
  catalogModels: CodexCatalogModel[],
  providersById: Map<string, Provider>,
): string[] {
  const exactModels = new Set<string>();
  const prefixes: string[] = [];

  for (const { route } of routes) {
    if (route.enabled === false) continue;
    const targetProviderId = routeTargetProviderId(route);
    const targetProvider = routeTargetProvider(route, providersById);
    const hasTargetCatalog = providerHasCodexModelCatalog(targetProvider);
    const targetCatalogModels = targetProvider
      ? readIncludedCodexModelCatalog(targetProvider).models
      : [];

    if (hasTargetCatalog) {
      for (const model of targetCatalogModels) {
        if (
          route.modelSelection?.mode === "all" ||
          routeCanMatchVisibleCatalogModel(route, model)
        ) {
          const normalized = model.model?.trim();
          if (normalized) exactModels.add(normalized);
        }
      }
      for (const [visible, upstream] of Object.entries(
        route.aliases ?? route.upstream?.modelMap ?? {},
      )) {
        const hasSelectedTarget = targetCatalogModels.some(
          (model) =>
            modelIdentityValues(model).includes(
              normalizedModelIdentity(upstream),
            ) &&
            (route.modelSelection?.mode === "all" ||
              (route.modelSelection?.mode === "include"
                ? modelSelectionMatchesCatalogModel(
                    route.modelSelection.models,
                    model,
                  )
                : routeCanMatchVisibleCatalogModel(route, visible))),
        );
        if (hasSelectedTarget) {
          const normalized = visible.trim();
          if (normalized) exactModels.add(normalized);
        }
      }
      continue;
    }

    // Schema-v2 routes are catalog-bound even when the target provider has
    // not produced a catalog yet. Do not resurrect stale match fields while
    // the source is empty or unavailable.
    if (route.modelSelection && targetProviderId) continue;

    // A missing catalog is the only case where legacy route text is still the
    // available evidence. Once a catalog exists, stale match fields cannot
    // resurrect models removed from that catalog.
    const fallbackModels =
      route.modelSelection?.mode === "include"
        ? route.modelSelection.models
        : (route.match?.models ?? []);
    for (const model of fallbackModels) {
      const normalized = model.trim();
      if (normalized) exactModels.add(normalized);
    }
    if (route.modelSelection?.mode !== "include") {
      for (const prefix of route.match?.prefixes ?? []) {
        const normalized = prefix.trim();
        if (normalized) prefixes.push(normalized);
      }
    }
  }

  const routed = catalogModels
    .filter((model) => model.enabled !== false)
    .map((model) => model.model?.trim())
    .filter((model): model is string => Boolean(model))
    .filter(
      (model) =>
        exactModels.has(model) ||
        prefixes.some((prefix) => model.startsWith(prefix)),
    );

  return Array.from(new Set(routed));
}

/// 判断请求模型是否命中某条 route；状态页用它把外层 router 日志重新归属到子 provider。
function routeMatchesModel(route: CodexRoute, model: string): boolean {
  const normalized = model.trim();
  if (!normalized) return false;
  const models = route.match?.models ?? [];
  const prefixes = route.match?.prefixes ?? [];
  return (
    models.includes(normalized) ||
    prefixes.some((prefix) => normalized.startsWith(prefix))
  );
}

/// 收集当前多路方案引用到的子 provider，避免状态页把普通 Codex provider 和 route target 混在一起。
function collectTargetProviderIds(
  routes: RouteEntry[],
  selectedPlan?: Provider | null,
): Set<string> {
  const ids = new Set<string>();
  for (const entry of routes) {
    if (selectedPlan && entry.provider.id !== selectedPlan.id) continue;
    const targetProviderId = routeTargetProviderId(entry.route);
    if (targetProviderId) ids.add(targetProviderId);
  }
  return ids;
}

/// 为内联 route 生成稳定统计 ID。内联 route 没有真实 providerId，但在状态页里
/// 仍然应该作为一个“子 Provider”展示，否则 Qwen/DeepSeek 会被统计成 0。
function routeTrafficId(entry: RouteEntry): string {
  const routeId =
    entry.route.id?.trim() ||
    entry.route.label?.trim() ||
    `route-${entry.index + 1}`;
  return `route:${entry.provider.id}:${routeId}`;
}

/// 把 route 映射成状态页可聚合的流量目标；优先使用真实 target provider，
/// 没有 targetProviderId 时退化为内联 route 自身。
function routeTrafficTarget(
  entry: RouteEntry,
  providersById: Map<string, Provider>,
): RouteTrafficTarget {
  const targetProviderId = routeTargetProviderId(entry.route);
  const targetProvider = targetProviderId
    ? providersById.get(targetProviderId)
    : undefined;
  if (targetProviderId) {
    return {
      providerId: targetProviderId,
      providerName: targetProvider?.name ?? targetProviderId,
    };
  }
  return {
    providerId: routeTrafficId(entry),
    providerName:
      entry.route.label?.trim() ||
      entry.route.id?.trim() ||
      `Route ${entry.index + 1}`,
  };
}

/// 从 router 日志反推 route id，兼容旧日志只写 effective_provider 的情况。
function routeIdFromRouterEvent(event: CodexRouterLogEvent): string | null {
  if (event.routeId?.trim()) return event.routeId.trim();
  const provider = event.effectiveProvider ?? event.provider ?? "";
  const marker = "::route::";
  const index = provider.indexOf(marker);
  return index >= 0
    ? provider.slice(index + marker.length).trim() || null
    : null;
}

/// 为 route 生成和后端诊断 route summary 对齐的稳定 key。
function routeEntryStatusKey(entry: RouteEntry): string {
  return (
    entry.route.id?.trim() ||
    entry.route.label?.trim() ||
    `route-${entry.index + 1}`
  );
}

/// 为后端返回的 route summary 生成稳定 key，便于前端合并协议探测结果。
function routeSummaryStatusKey(
  route: CodexRouteSummary,
  index: number,
): string {
  return route.id?.trim() || route.label?.trim() || `route-${index + 1}`;
}

/// 建立当前诊断 route summary 的查找表，避免状态页自己重复猜协议。
function buildRouteSummaryMap(
  diagnostics: CodexMultiRouterDiagnostics | null,
): Map<string, CodexRouteSummary> {
  return new Map(
    (diagnostics?.routePlan.routeSummaries ?? []).map((route, index) => [
      routeSummaryStatusKey(route, index),
      route,
    ]),
  );
}

/// 根据 route_id 或 model 匹配 router 日志对应的 route。
function routeEntryForRouterEvent(
  event: CodexRouterLogEvent,
  routes: RouteEntry[],
): RouteEntry | undefined {
  const routeId = routeIdFromRouterEvent(event);
  if (routeId) {
    const byId = routes.find(
      ({ route }) => route.id?.trim().toLowerCase() === routeId.toLowerCase(),
    );
    if (byId) return byId;
  }
  const model = event.model?.trim();
  return model
    ? routes.find(({ route }) => routeMatchesModel(route, model))
    : undefined;
}

/// router 诊断事件没有完整 token 和 latency 信息，只把可确认的 route/model
/// 请求计入请求数和失败数，避免把“没有外部 targetProviderId”误报为无流量。
function routerEventStatusCode(event: CodexRouterLogEvent): number {
  const parsed = Number.parseInt(event.status ?? "", 10);
  if (Number.isFinite(parsed)) return parsed;
  return event.event.includes("error") ? 500 : 0;
}

/// 把 route 的配置协议探测结果附着到统计行里。
function applyRouteProtocolMetadata(
  row: RouteTrafficRow,
  entry: RouteEntry | undefined,
  routeSummaries: Map<string, CodexRouteSummary>,
) {
  if (!entry) return;
  row.routeId = entry.route.id?.trim() || null;
  row.routeLabel = routeSummaryDisplayName(
    entry.route.label,
    entry.route.id,
    entry.provider.name,
    "",
  );
  const summary = routeSummaries.get(routeEntryStatusKey(entry));
  if (!summary) return;
  row.configuredProtocol ??= summary.configuredProtocol;
  row.configuredProtocolSource ??= summary.configuredProtocolSource;
  row.configuredProtocolDetail ??= summary.configuredProtocolDetail;
}

/// 用最近的 request_prepared 事件覆盖统计行的真实出站协议。
function updateRouteObservedProtocol(
  row: RouteTrafficRow,
  event: CodexRouterLogEvent,
) {
  if (!event.actualProtocol) return;
  if (
    row.lastObservedAt &&
    event.timestamp.localeCompare(row.lastObservedAt) <= 0
  ) {
    return;
  }
  row.lastObservedProtocol = event.actualProtocol;
  row.lastObservedAt = event.timestamp;
  row.lastObservedUpstreamUrl = event.upstreamUrl;
  row.lastObservedEndpoint = event.effectiveEndpoint ?? event.endpoint;
}

/// 从请求日志聚合 MultiRouter 子 provider / model 流量；无法归属的日志留给状态页单独提示。
export function buildRouteTrafficRows({
  logs,
  routerEvents = [],
  routes,
  selectedPlan,
  providersById,
  routeSummaries = new Map<string, CodexRouteSummary>(),
}: {
  logs: RequestLog[];
  routerEvents?: CodexRouterLogEvent[];
  routes: RouteEntry[];
  selectedPlan: Provider | null;
  providersById: Map<string, Provider>;
  routeSummaries?: Map<string, CodexRouteSummary>;
}): RouteTrafficRow[] {
  const selectedRoutes = selectedPlan
    ? routes.filter((entry) => entry.provider.id === selectedPlan.id)
    : routes;
  const targetProviderIds = collectTargetProviderIds(routes, selectedPlan);
  const buckets = new Map<
    string,
    RouteTrafficRow & { latencyTotalMs: number }
  >();

  function addTrafficSample(
    target: RouteTrafficTarget,
    model: string,
    statusCode: number,
    tokenUsage: Pick<
      RequestLog,
      | "appType"
      | "inputTokens"
      | "cacheReadTokens"
      | "cacheCreationTokens"
      | "outputTokens"
    >,
    latencyMs: number,
    matchedRoute?: RouteEntry,
  ) {
    const key = `${target.providerId}::${model}`;
    const current =
      buckets.get(key) ??
      ({
        providerId: target.providerId,
        providerName: target.providerName,
        model,
        routeId: null,
        routeLabel: null,
        configuredProtocol: null,
        configuredProtocolSource: null,
        configuredProtocolDetail: null,
        lastObservedProtocol: null,
        lastObservedAt: null,
        lastObservedUpstreamUrl: null,
        lastObservedEndpoint: null,
        requestCount: 0,
        successCount: 0,
        failedCount: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        avgLatencyMs: 0,
        latencyTotalMs: 0,
      } satisfies RouteTrafficRow & { latencyTotalMs: number });

    applyRouteProtocolMetadata(current, matchedRoute, routeSummaries);
    current.requestCount += 1;
    if (statusCode >= 200 && statusCode < 400) {
      current.successCount += 1;
    } else if (statusCode >= 400) {
      current.failedCount += 1;
    }
    const freshInputTokens = getFreshInputTokens(tokenUsage);
    current.inputTokens += freshInputTokens;
    current.cacheReadTokens += tokenUsage.cacheReadTokens;
    current.cacheCreationTokens += tokenUsage.cacheCreationTokens;
    current.outputTokens += tokenUsage.outputTokens;
    current.totalTokens +=
      freshInputTokens +
      tokenUsage.cacheReadTokens +
      tokenUsage.cacheCreationTokens +
      tokenUsage.outputTokens;
    current.latencyTotalMs += latencyMs;
    current.avgLatencyMs = Math.round(
      current.latencyTotalMs / current.requestCount,
    );
    buckets.set(key, current);
  }

  for (const log of logs) {
    if (log.appType !== "codex") continue;
    if ((log.dataSource ?? "proxy") !== "proxy") continue;
    const requestedModel = log.requestModel || log.model;
    const matchedRoute = selectedRoutes.find(({ route }) =>
      routeMatchesModel(route, requestedModel),
    );
    const model = requestedModel || log.model || "unknown";
    const target = matchedRoute
      ? routeTrafficTarget(matchedRoute, providersById)
      : targetProviderIds.has(log.providerId)
        ? {
            providerId: log.providerId,
            providerName:
              providersById.get(log.providerId)?.name ??
              log.providerName ??
              log.providerId,
          }
        : undefined;
    if (!target) continue;

    addTrafficSample(
      target,
      model,
      log.statusCode,
      log,
      log.latencyMs,
      matchedRoute,
    );
  }

  const terminalRouterEvents = routerEvents.filter((event) =>
    ["upstream_status", "upstream_error", "upstream_send_error"].includes(
      event.event,
    ),
  );
  const countableRouterEvents =
    terminalRouterEvents.length > 0
      ? terminalRouterEvents
      : routerEvents.filter((event) =>
          ["route_resolved", "request_prepared"].includes(event.event),
        );

  for (const event of countableRouterEvents) {
    const matchedRoute = routeEntryForRouterEvent(event, selectedRoutes);
    if (!matchedRoute) continue;
    addTrafficSample(
      routeTrafficTarget(matchedRoute, providersById),
      event.model || matchedRoute.route.match?.models?.[0] || "unknown",
      routerEventStatusCode(event),
      {
        appType: "codex",
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 0,
      },
      0,
      matchedRoute,
    );
  }

  for (const event of routerEvents.filter((entry) =>
    Boolean(entry.actualProtocol),
  )) {
    const matchedRoute = routeEntryForRouterEvent(event, selectedRoutes);
    if (!matchedRoute) continue;
    const target = routeTrafficTarget(matchedRoute, providersById);
    const model =
      event.model || matchedRoute.route.match?.models?.[0] || "unknown";
    const key = `${target.providerId}::${model}`;
    const current =
      buckets.get(key) ??
      ({
        providerId: target.providerId,
        providerName: target.providerName,
        model,
        routeId: null,
        routeLabel: null,
        configuredProtocol: null,
        configuredProtocolSource: null,
        configuredProtocolDetail: null,
        lastObservedProtocol: null,
        lastObservedAt: null,
        lastObservedUpstreamUrl: null,
        lastObservedEndpoint: null,
        requestCount: 0,
        successCount: 0,
        failedCount: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        avgLatencyMs: 0,
        latencyTotalMs: 0,
      } satisfies RouteTrafficRow & { latencyTotalMs: number });
    applyRouteProtocolMetadata(current, matchedRoute, routeSummaries);
    updateRouteObservedProtocol(current, event);
    buckets.set(key, current);
  }

  return Array.from(buckets.values())
    .map(({ latencyTotalMs: _latencyTotalMs, ...row }) => row)
    .sort((a, b) => b.requestCount - a.requestCount);
}

/// 显示 Codex 多模型路由工作台；它只复用 Provider 配置，不创建第二套数据库。
/// 注意：要让 Codex 请求真正进入路由，仍然必须开启 Codex app takeover，把 Codex live 配置指向本地代理。
export function CodexRouterWorkspacePage({
  providers,
  proxyStatus,
  isProxyRunning,
  isCodexTakeoverActive,
  activeProviderId,
  initialProviderId,
  initialTab = "status",
  onEditProvider,
  onDeletePlan,
  onCreateProvider,
}: {
  providers: Provider[];
  proxyStatus?: ProxyStatus;
  isProxyRunning: boolean;
  isCodexTakeoverActive: boolean;
  activeProviderId?: string;
  initialProviderId?: string | null;
  initialTab?: WorkspaceTab;
  onEditProvider: (provider: Provider) => void;
  onDeletePlan: (provider: Provider) => void;
  onCreateProvider: () => void;
}) {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>(initialTab);
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [selectedRouteKey, setSelectedRouteKey] = useState<string | null>(null);
  const [testModel, setTestModel] = useState("");
  const [testResult, setTestResult] = useState<string | null>(null);
  const [isRoutePickerOpen, setIsRoutePickerOpen] = useState(false);
  const [isPlanSettingsOpen, setIsPlanSettingsOpen] = useState(false);
  const [routePickerMessage, setRoutePickerMessage] = useState<string | null>(
    null,
  );
  const [routePickerError, setRoutePickerError] = useState<string | null>(null);
  const [isSavingRoutes, setIsSavingRoutes] = useState(false);
  const [isSavingPlanSettings, setIsSavingPlanSettings] = useState(false);
  const [migrationPreview, setMigrationPreview] =
    useState<CodexMultiRouterMigrationPreview | null>(null);
  const [migrationTargetPlan, setMigrationTargetPlan] =
    useState<Provider | null>(null);
  const [migrationPendingAction, setMigrationPendingAction] = useState<
    "routes" | "settings" | null
  >(null);
  const [isLoadingMigration, setIsLoadingMigration] = useState(false);
  const [isApplyingMigration, setIsApplyingMigration] = useState(false);
  const [migrationError, setMigrationError] = useState<string | null>(null);
  const [routePickerSelectAll, setRoutePickerSelectAll] = useState(false);
  const [optimisticRoutingPlan, setOptimisticRoutingPlan] =
    useState<Provider | null>(null);
  const [optimisticModelSourcesById, setOptimisticModelSourcesById] = useState<
    Record<string, Provider>
  >({});
  const [providerModelRefreshStates, setProviderModelRefreshStates] = useState<
    Record<string, ProviderModelRefreshState>
  >({});
  const appliedInitialNavigationRef = useRef<string | null>(null);
  const workspaceScrollRef = useRef<HTMLDivElement | null>(null);
  const modelRefreshAttemptedKeysRef = useRef<Set<string>>(new Set());
  // 记录每个 provider 当前最新的 /models 刷新 attempt；普通 rerender 会触发 effect cleanup，不能因此吞掉同批并发请求的终态。
  const modelRefreshActiveAttemptKeysRef = useRef<Record<string, string>>({});
  // 记录已超时的 attempt，避免后台迟到的 IPC 继续把 loading/error 覆盖成 success。
  const modelRefreshTimedOutAttemptKeysRef = useRef<Set<string>>(new Set());
  useTranslation();
  const queryClient = useQueryClient();

  /// 按下一版启用 Provider 集合同步失效旧刷新，避免路由保存窗口内迟到结果写回旧 catalog。
  function invalidateModelRefreshesOutside(
    enabledProviderIds: ReadonlySet<string>,
  ) {
    setProviderModelRefreshStates((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([providerId]) =>
          enabledProviderIds.has(providerId),
        ),
      );
      return Object.keys(next).length === Object.keys(current).length
        ? current
        : next;
    });
    for (const [providerId, attemptKey] of Object.entries(
      modelRefreshActiveAttemptKeysRef.current,
    )) {
      if (enabledProviderIds.has(providerId)) continue;
      delete modelRefreshActiveAttemptKeysRef.current[providerId];
      modelRefreshAttemptedKeysRef.current.delete(attemptKey);
      modelRefreshTimedOutAttemptKeysRef.current.delete(attemptKey);
    }
  }

  const effectiveProviders = useMemo(() => {
    const optimisticSourceEntries = Object.entries(optimisticModelSourcesById);
    const hasOptimisticSources = optimisticSourceEntries.length > 0;
    if (!optimisticRoutingPlan && !hasOptimisticSources) return providers;

    const replaced = providers.map((provider) =>
      provider.id === optimisticRoutingPlan?.id
        ? optimisticRoutingPlan
        : (optimisticModelSourcesById[provider.id] ?? provider),
    );
    if (!optimisticRoutingPlan) return replaced;
    const withRoutingPlan = providers.some(
      (provider) => provider.id === optimisticRoutingPlan.id,
    )
      ? replaced
      : [...providers, optimisticRoutingPlan];
    return withRoutingPlan;
  }, [optimisticModelSourcesById, optimisticRoutingPlan, providers]);
  const routingPlans = useMemo(
    () => effectiveProviders.filter(isRoutingPlan),
    [effectiveProviders],
  );
  const routingPlanIdSet = useMemo(
    () => new Set(routingPlans.map((provider) => provider.id)),
    [routingPlans],
  );
  const modelSources = useMemo(
    () => effectiveProviders.filter((provider) => !isRoutingPlan(provider)),
    [effectiveProviders],
  );
  const routableModelSources = useMemo(
    () => resolveWizardModelNameCollisions(modelSources),
    [modelSources],
  );
  const providersById = useMemo(
    () =>
      new Map(effectiveProviders.map((provider) => [provider.id, provider])),
    [effectiveProviders],
  );
  const routableProvidersById = useMemo(() => {
    const byId = new Map(
      effectiveProviders.map((provider) => [provider.id, provider]),
    );
    for (const source of routableModelSources) {
      byId.set(source.id, source);
    }
    return byId;
  }, [effectiveProviders, routableModelSources]);
  // 模型刷新目标必须来自当前方案的启用 route；旧 inline route 仅做语义定位，
  // 不能因缺少 targetProviderId 退回到刷新全部候选 Provider。
  const selectedPlanForModelRefresh =
    routingPlans.find((provider) => provider.id === selectedPlanId) ??
    routingPlans.find((provider) => provider.id === activeProviderId) ??
    routingPlans[0] ??
    null;
  const enabledModelSourceIdsForRefresh = useMemo(() => {
    const ids = new Set<string>();
    const routes = dedupeCodexRoutesBySemanticProvider(
      readCodexRouting(selectedPlanForModelRefresh)?.routes ?? [],
      modelSources,
    );
    for (const route of routes) {
      if (route.enabled === false) continue;
      const providerId = routeSemanticProviderId(route, modelSources);
      if (providerId) ids.add(providerId);
    }
    return ids;
  }, [modelSources, selectedPlanForModelRefresh]);

  // route 停用后立即移除旧刷新卡片，并让进行中的结果失效；同时释放最新去重键，
  // 保证用户重新启用该 route 时可以重新读取模型，而不是被历史 attempt 永久拦截。
  useEffect(() => {
    invalidateModelRefreshesOutside(enabledModelSourceIdsForRefresh);
  }, [enabledModelSourceIdsForRefresh]);

  // 进入路由页时只刷新当前方案已启用的模型源；停用候选不能借刷新副作用
  // 重新进入聚合 catalog，OAuth 与普通 /models 仍共用后续写回事务。
  useEffect(() => {
    if (activeTab !== "routes") return;
    if (enabledModelSourceIdsForRefresh.size === 0) return;

    for (const provider of modelSources.filter((source) =>
      enabledModelSourceIdsForRefresh.has(source.id),
    )) {
      const fetchConfig = getProviderModelFetchConfig(provider);
      const attemptKey = buildProviderModelRefreshAttemptKey(
        provider.id,
        fetchConfig,
      );
      if (modelRefreshAttemptedKeysRef.current.has(attemptKey)) continue;
      modelRefreshAttemptedKeysRef.current.add(attemptKey);
      modelRefreshActiveAttemptKeysRef.current[provider.id] = attemptKey;
      modelRefreshTimedOutAttemptKeysRef.current.delete(attemptKey);

      if (fetchConfig.skipReason) {
        setProviderModelRefreshStates((current) => ({
          ...current,
          [provider.id]: {
            status: "skipped",
            message: fetchConfig.skipReason!,
          },
        }));
        continue;
      }

      setProviderModelRefreshStates((current) => ({
        ...current,
        [provider.id]: {
          status: "loading",
          message: "Reading model list...",
        },
      }));

      const isCurrentAttempt = () =>
        modelRefreshActiveAttemptKeysRef.current[provider.id] === attemptKey &&
        !modelRefreshTimedOutAttemptKeysRef.current.has(attemptKey);

      // 将模型目录读取、provider catalog 写回、受影响路由方案重建视为一个事务；
      // 任何阶段卡住都必须让刷新卡片落到终态，不能只保护最前面的网络请求。
      const refreshTask = (async (): Promise<ProviderModelRefreshResult> => {
        const { models, usedCodexFallback, onlineErrorMessage } =
          await fetchProviderModelsWithFallback(fetchConfig);
        if (!isCurrentAttempt()) {
          return { status: "stale" };
        }
        if (models.length === 0 && onlineErrorMessage) {
          return {
            status: "empty",
            message: `OAuth online model-list fetch failed: ${onlineErrorMessage}; the fallback official catalog also has no models.`,
          };
        }

        const nextProvider = providerWithFetchedModelCatalog(provider, models);
        setProviderModelRefreshStates((current) => ({
          ...current,
          [provider.id]: {
            status: "loading",
            message: usedCodexFallback
              ? `OAuth online read failed; read ${models.length} models from the fallback official catalog and write them to local configuration...`
              : `Read ${models.length} models; writing them to local configuration...`,
            modelCount: models.length,
          },
        }));

        await providersApi.update(nextProvider, "codex");
        if (!isCurrentAttempt()) {
          return { status: "stale" };
        }

        return {
          status: "updated",
          models,
          nextProvider,
          usedCodexFallback,
          onlineErrorMessage,
        };
      })();

      withModelRefreshTimeout(refreshTask, MODEL_REFRESH_TIMEOUT_MS, () =>
        modelRefreshTimedOutAttemptKeysRef.current.add(attemptKey),
      )
        .then(async (result) => {
          if (result.status === "stale") return;
          if (result.status === "empty") {
            setProviderModelRefreshStates((current) => ({
              ...current,
              [provider.id]: {
                status: "error",
                message:
                  result.message ??
                  "OAuth online model-list fetch failed and the fallback official catalog also has no models.",
                modelCount: 0,
              },
            }));
            return;
          }
          if (!isCurrentAttempt()) return;
          setOptimisticModelSourcesById((current) => ({
            ...current,
            [result.nextProvider.id]: result.nextProvider,
          }));
          queryClient.setQueryData(["providers", "codex"], (current: any) => ({
            ...(current ?? { currentProviderId: "" }),
            providers: {
              ...Object.fromEntries(providersById),
              ...(current?.providers ?? {}),
              [result.nextProvider.id]: result.nextProvider,
            },
          }));
          setProviderModelRefreshStates((current) => ({
            ...current,
            [provider.id]: {
              status: "success",
              message: result.usedCodexFallback
                ? `OAuth online read failed; updated ${
                    readIncludedCodexModelCatalog(result.nextProvider).models
                      .length
                  }  models. Online error:${result.onlineErrorMessage}`
                : `Read and updated ${
                    readIncludedCodexModelCatalog(result.nextProvider).models
                      .length
                  }  models.`,
              modelCount: readIncludedCodexModelCatalog(result.nextProvider)
                .models.length,
            },
          }));
          await queryClient.invalidateQueries({
            queryKey: ["providers", "codex"],
          });
        })
        .catch((error) => {
          if (
            modelRefreshActiveAttemptKeysRef.current[provider.id] !== attemptKey
          ) {
            return;
          }
          setProviderModelRefreshStates((current) => ({
            ...current,
            [provider.id]: {
              status: "error",
              message: `Model catalog read or write did not complete: ${workspaceErrorMessage(error)}`,
            },
          }));
        });
    }
  }, [
    activeTab,
    enabledModelSourceIdsForRefresh,
    modelSources,
    providersById,
    queryClient,
    routingPlans,
    selectedPlanId,
  ]);

  const routeEntries = routingPlans.flatMap((provider) =>
    dedupeCodexRoutesBySemanticProvider(
      readCodexRouting(provider)?.routes ?? [],
      modelSources,
    ).map((route, index) => ({
      provider,
      route,
      index,
    })),
  );
  const selectedPlan =
    routingPlans.find((provider) => provider.id === selectedPlanId) ??
    routingPlans.find((provider) => provider.id === activeProviderId) ??
    routingPlans[0] ??
    null;
  const selectedRouting = selectedPlan ? readCodexRouting(selectedPlan) : null;
  const selectedProjectedCatalog = useMemo(
    () => projectCodexModelCatalog(selectedPlan, providersById),
    [selectedPlan, providersById],
  );
  const routeModels = selectedProjectedCatalog.models.map(
    (model) => model.model,
  );
  const selectedPlanRouteEntries = selectedPlan
    ? routeEntries.filter(({ provider }) => provider.id === selectedPlan.id)
    : routeEntries;
  const selectedRoute =
    selectedPlanRouteEntries.find(
      ({ provider, route, index }) =>
        `${provider.id}:${route.id ?? index}` === selectedRouteKey,
    ) ?? selectedPlanRouteEntries[0];

  // 从主页或 Provider 列表跳转进来时，直接定位到指定 MultiRouter 和目标功能页。
  useEffect(() => {
    if (!initialProviderId) return;
    const navigationKey = `${initialProviderId}:${initialTab}`;
    if (appliedInitialNavigationRef.current === navigationKey) return;
    if (!routingPlanIdSet.has(initialProviderId)) return;
    setSelectedPlanId(initialProviderId);
    setSelectedRouteKey(null);
    setActiveTab(initialTab);
    appliedInitialNavigationRef.current = navigationKey;
  }, [initialProviderId, initialTab, routingPlanIdSet]);

  // 工作台不同页签内容高度差异很大；切换页签时回到顶部，避免沿用上一页滚动位置导致目标页像没有跳转。
  useEffect(() => {
    const scrollTo = workspaceScrollRef.current?.scrollTo;
    if (typeof scrollTo !== "function") return;
    scrollTo.call(workspaceScrollRef.current, 0, 0);
  }, [activeTab]);

  useEffect(() => {
    const persistedPlan = optimisticRoutingPlan
      ? providers.find((provider) => provider.id === optimisticRoutingPlan.id)
      : null;
    if (
      persistedPlan &&
      JSON.stringify(persistedPlan.settingsConfig?.codexRouting) ===
        JSON.stringify(optimisticRoutingPlan?.settingsConfig?.codexRouting) &&
      JSON.stringify(readCodexCatalogSettings(persistedPlan.settingsConfig)) ===
        JSON.stringify(
          readCodexCatalogSettings(optimisticRoutingPlan?.settingsConfig),
        )
    ) {
      setOptimisticRoutingPlan(null);
    }
  }, [optimisticRoutingPlan, providers]);

  // 普通 provider 的 /models 刷新会先写 DB，再等待父级 query refetch；这里保留短期覆盖层，
  // 确保候选 router 和空 match route 立即消费新 catalog，同时在配置变化或父级追上后自动释放。
  useEffect(() => {
    setOptimisticModelSourcesById((current) => {
      let changed = false;
      const next = { ...current };
      for (const [providerId, optimisticProvider] of Object.entries(current)) {
        const persistedProvider = providers.find(
          (provider) => provider.id === providerId,
        );
        if (!persistedProvider) {
          delete next[providerId];
          changed = true;
          continue;
        }

        const persistedAttemptKey = buildProviderModelRefreshAttemptKey(
          providerId,
          getProviderModelFetchConfig(persistedProvider),
        );
        const optimisticAttemptKey = buildProviderModelRefreshAttemptKey(
          providerId,
          getProviderModelFetchConfig(optimisticProvider),
        );
        const catalogPersisted =
          JSON.stringify(
            readCodexCatalogSettings(persistedProvider.settingsConfig),
          ) ===
          JSON.stringify(
            readCodexCatalogSettings(optimisticProvider.settingsConfig),
          );
        if (persistedAttemptKey !== optimisticAttemptKey || catalogPersisted) {
          delete next[providerId];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [providers]);

  /// 新建 MultiRouter 直接创建带 codexRouting 的工作台 provider，不再打开普通供应商表单。
  async function handleCreatePlan() {
    const nextPlan = createDraftRoutingPlan(providers, modelSources);
    setIsSavingRoutes(true);
    setRoutePickerError(null);
    setRoutePickerMessage(null);
    try {
      await providersApi.add(nextPlan, "codex", false);
      const initializedPlan = await codexSubagentV2Api.initializeProviderConfig(
        nextPlan.id,
      );
      queryClient.setQueryData(["providers", "codex"], (current: any) => ({
        ...(current ?? { currentProviderId: "" }),
        providers: {
          ...Object.fromEntries(
            providers.map((provider) => [provider.id, provider]),
          ),
          ...(current?.providers ?? {}),
          [initializedPlan.id]: initializedPlan,
        },
      }));
      await queryClient.invalidateQueries({ queryKey: ["providers", "codex"] });
      await queryClient.refetchQueries({
        queryKey: ["providers", "codex"],
        type: "active",
      });
      setOptimisticRoutingPlan(initializedPlan);
      setSelectedPlanId(initializedPlan.id);
      setSelectedRouteKey(null);
      setActiveTab("routes");
      setRoutePickerSelectAll(true);
      setIsRoutePickerOpen(true);
      setRoutePickerMessage(
        "Created a new multi-route plan; choose candidate routers to connect.",
      );
    } catch (error) {
      setRoutePickerError(workspaceErrorMessage(error));
    } finally {
      setIsSavingRoutes(false);
    }
  }

  /// MultiRouter 方案只打开工作台专用设置；普通模型源仍进入通用 Provider 表单。
  function handleEditPlan(provider: Provider) {
    if (isRoutingPlan(provider)) {
      setSelectedPlanId(provider.id);
      setActiveTab("routes");
      setRoutePickerError(null);
      setRoutePickerMessage(null);
      setIsPlanSettingsOpen(true);
      return;
    }
    onEditProvider(provider);
  }

  /// 保存方案设置时保留有效 policy，仅清理已从模型源目录移除的引用。
  async function handleSavePlanSettings(
    plan: Provider,
    draft: MultiRouterSettingsDraft,
  ) {
    const nextProvider = reconcileCodexRoutingPlanForSave(
      applyMultiRouterSettingsDraft(plan, draft),
      providersById,
    );
    setIsSavingPlanSettings(true);
    setRoutePickerError(null);
    setRoutePickerMessage(null);
    try {
      await providersApi.update(nextProvider, "codex");
      queryClient.setQueryData(["providers", "codex"], (current: any) =>
        current?.providers
          ? {
              ...current,
              providers: {
                ...current.providers,
                [nextProvider.id]: nextProvider,
              },
            }
          : current,
      );
      await queryClient.invalidateQueries({ queryKey: ["providers", "codex"] });
      await queryClient.refetchQueries({
        queryKey: ["providers", "codex"],
        type: "active",
      });
      setOptimisticRoutingPlan(nextProvider);
      setSelectedPlanId(nextProvider.id);
      setIsPlanSettingsOpen(false);
      setRoutePickerMessage(
        "Multi-route settings saved; takeover configuration will continue to be maintained automatically.",
      );
    } catch (error) {
      setRoutePickerError(workspaceErrorMessage(error));
    } finally {
      setIsSavingPlanSettings(false);
    }
  }

  /// 路由规则编辑只更新 codexRouting.routes，不再进入通用 Provider 表单，避免“添加 router”卡死路径。
  async function handleSaveRoutingRoutes(plan: Provider, routes: CodexRoute[]) {
    const currentRouting = readCodexRouting(plan) ?? {};
    const usedRouteIds = new Set<string>();
    const normalizedRouteDrafts = dedupeCodexRoutesBySemanticProvider(
      routes.map((route, index) =>
        normalizeCodexRouteForSave(route, index, usedRouteIds),
      ),
      routableModelSources,
    );
    const normalizedRoutes = normalizeCodexRoutesForVisibleModelAliases(
      plan,
      normalizedRouteDrafts,
      routableProvidersById,
    );
    const nextRouting: CodexRouting = {
      ...currentRouting,
      schemaVersion: 2,
      enabled: currentRouting.enabled ?? true,
      routes: normalizedRoutes,
    };
    delete nextRouting.defaultRouteId;
    const nextProvider = reconcileCodexRoutingPlanForSave(
      {
        ...plan,
        settingsConfig: {
          ...withoutDerivedRouterCatalog(plan.settingsConfig),
          codexRouting: serializeCodexRoutingV2(nextRouting),
        },
      },
      providersById,
    );
    const nextEnabledProviderIds = new Set<string>();
    for (const route of readCodexRouting(nextProvider)?.routes ?? []) {
      if (route.enabled === false) continue;
      const providerId = routeSemanticProviderId(route, modelSources);
      if (providerId) nextEnabledProviderIds.add(providerId);
    }

    // 必须在持久化前同步失效旧 attempt；否则保存等待期间迟到的 /models
    // 结果仍会按旧 routingPlans 写回 provider 和 plan catalog。
    invalidateModelRefreshesOutside(nextEnabledProviderIds);
    setOptimisticRoutingPlan(nextProvider);
    setSelectedPlanId(plan.id);
    setIsSavingRoutes(true);
    setRoutePickerError(null);
    setRoutePickerMessage(null);
    try {
      await providersApi.update(nextProvider, "codex");
      queryClient.setQueryData(["providers", "codex"], (current: any) =>
        current?.providers
          ? {
              ...current,
              providers: {
                ...current.providers,
                [nextProvider.id]: nextProvider,
              },
            }
          : current,
      );
      await queryClient.invalidateQueries({ queryKey: ["providers", "codex"] });
      await queryClient.refetchQueries({
        queryKey: ["providers", "codex"],
        type: "active",
      });
      setSelectedRouteKey(
        normalizedRoutes[0]?.id ? `${plan.id}:${normalizedRoutes[0].id}` : null,
      );
      setRoutePickerMessage(
        "Route rules saved; candidate router selection was written to the current multi-route plan.",
      );
      setRoutePickerSelectAll(false);
      setIsRoutePickerOpen(false);
    } catch (error) {
      // 保存失败时回滚原方案；启用集合恢复后刷新 effect 会重新读取被失效的 Provider。
      setOptimisticRoutingPlan(plan);
      setRoutePickerError(workspaceErrorMessage(error));
    } finally {
      setIsSavingRoutes(false);
    }
  }

  /// 选择方案只改变工作台焦点，不修改数据库。
  function handleSelectPlan(provider: Provider) {
    setSelectedPlanId(provider.id);
    setActiveTab("routes");
  }

  /// 选择规则后跳转到规则页，让卡片产生明确的可操作反馈。
  function handleSelectRoute(entry: RouteEntry) {
    setSelectedPlanId(entry.provider.id);
    setSelectedRouteKey(
      `${entry.provider.id}:${entry.route.id ?? entry.index}`,
    );
    setActiveTab("routes");
  }

  async function previewLegacyPlanMigration(
    plan: Provider,
    action: "routes" | "settings",
  ) {
    setMigrationTargetPlan(plan);
    setMigrationPendingAction(action);
    setMigrationPreview(null);
    setMigrationError(null);
    setIsLoadingMigration(true);
    try {
      const revision = await providersApi.getCodexMultiRouterRevision(plan.id);
      const preview = await providersApi.previewCodexMultiRouterMigration(
        plan.id,
        revision,
      );
      setMigrationPreview(preview);
    } catch (error) {
      setMigrationError(workspaceErrorMessage(error));
    } finally {
      setIsLoadingMigration(false);
    }
  }

  async function applyLegacyPlanMigration() {
    if (!migrationPreview || !migrationTargetPlan) return;
    setIsApplyingMigration(true);
    setMigrationError(null);
    try {
      await providersApi.applyCodexMultiRouterMigration(
        migrationTargetPlan.id,
        migrationPreview.expectedRevision,
        migrationPreview.planToken,
      );
      const refreshedProviders = await providersApi.getAll("codex");
      const migratedPlan = refreshedProviders[migrationTargetPlan.id];
      if (
        !migratedPlan ||
        readCodexRouting(migratedPlan)?.schemaVersion !== 2
      ) {
        throw new Error("migration_readback_failed");
      }
      setOptimisticRoutingPlan(migratedPlan);
      setSelectedPlanId(migratedPlan.id);
      const action = migrationPendingAction;
      setMigrationPreview(null);
      setMigrationTargetPlan(null);
      setMigrationPendingAction(null);
      if (action === "routes") {
        setActiveTab("routes");
        setRoutePickerError(null);
        setRoutePickerMessage(
          "The legacy plan was migrated to schema v2; review it before saving rules.",
        );
        setRoutePickerSelectAll(false);
        setIsRoutePickerOpen(true);
      } else if (action === "settings") {
        setIsPlanSettingsOpen(true);
      }
      await queryClient.invalidateQueries({ queryKey: ["providers", "codex"] });
    } catch (error) {
      setMigrationError(workspaceErrorMessage(error));
    } finally {
      setIsApplyingMigration(false);
    }
  }

  /// 从任何规则入口打开候选选择器时，先切到规则页并清理上一次保存提示。
  function handleOpenRoutePicker(provider?: Provider | null) {
    const targetPlan = provider ?? selectedPlan;
    if (targetPlan && readCodexRouting(targetPlan)?.schemaVersion !== 2) {
      void previewLegacyPlanMigration(targetPlan, "routes");
      return;
    }
    if (targetPlan) setSelectedPlanId(targetPlan.id);
    setActiveTab("routes");
    setRoutePickerError(null);
    setRoutePickerMessage(null);
    setRoutePickerSelectAll(false);
    setIsRoutePickerOpen(true);
  }

  function handlePlanSettingsOpenChange(open: boolean) {
    if (open && selectedPlan && selectedRouting?.schemaVersion !== 2) {
      void previewLegacyPlanMigration(selectedPlan, "settings");
      return;
    }
    setIsPlanSettingsOpen(open);
  }

  /// 页面内测试只做规则匹配预览，不发真实上游请求，避免误触发计费或账号请求。
  function handlePreviewRoute() {
    const model = testModel.trim();
    if (!model) {
      setTestResult(
        "Enter a model from a Codex request, such as gpt-5.4-mini or qwen3.6.",
      );
      return;
    }

    const matched = selectedPlanRouteEntries.find(({ route }) => {
      if (route.enabled === false) return false;
      const target = routeTargetProvider(route, providersById);
      const upstream =
        Object.entries(route.aliases ?? route.upstream?.modelMap ?? {}).find(
          ([alias]) =>
            normalizedModelIdentity(alias) === normalizedModelIdentity(model),
        )?.[1] ?? model;
      if (
        target &&
        providerHasCodexModelCatalog(target) &&
        !providerHasModelIdentity(target, upstream)
      ) {
        return false;
      }
      if (routeCanMatchVisibleCatalogModel(route, model)) return true;
      if (route.modelSelection?.mode !== "all") return false;

      const aliases = route.aliases ?? route.upstream?.modelMap ?? {};
      if (
        Object.keys(aliases).some(
          (alias) => alias.trim().toLowerCase() === model.toLowerCase(),
        )
      ) {
        return true;
      }
      return readIncludedCodexModelCatalog(target ?? null).models.some(
        (catalogModel) => {
          const candidate = catalogModel.model?.trim();
          const upstream = (
            catalogModel.upstreamModel ?? catalogModel.upstream_model
          )?.trim();
          return [candidate, upstream].some(
            (value) => value?.toLowerCase() === model.toLowerCase(),
          );
        },
      );
    });

    if (matched) {
      const result = `${model} matches “${routeDisplayName(matched.route, providersById)}”; upstream: ${routeBaseUrl(matched.route, providersById)}.`;
      setTestResult(result);
      return;
    }

    setTestResult(
      `${model} cannot be routed: it did not match any enabled model rule in the current plan.`,
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden px-6 py-4">
      <div
        ref={workspaceScrollRef}
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-2"
      >
        <HeaderPanel
          onCreatePlan={handleCreatePlan}
          onJump={(tab) => setActiveTab(tab)}
        />
        <CodexEgressTimezoneStatusCard
          onOpenCodexStatus={() => setActiveTab("status")}
        />

        <Tabs
          value={activeTab}
          onValueChange={(value) => setActiveTab(value as WorkspaceTab)}
        >
          <div className="sticky top-0 z-10 -mx-1 bg-background/95 px-1 py-2 backdrop-blur">
            <TabsList className="grid w-full grid-cols-3 bg-muted p-1 dark:bg-slate-950/40 lg:grid-cols-7">
              <WorkspaceTabTrigger
                value="overview"
                icon={Layers3}
                label="Overview"
              />
              <WorkspaceTabTrigger
                value="sources"
                icon={Server}
                label="Model sources"
              />
              <WorkspaceTabTrigger
                value="routes"
                icon={Route}
                label="Route rules"
              />
              <WorkspaceTabTrigger
                value="model-order"
                icon={GripVertical}
                label="Model order"
              />
              <WorkspaceTabTrigger
                value="subagents"
                icon={Bot}
                label="Sub-Agent"
              />
              <WorkspaceTabTrigger
                value="status"
                icon={Activity}
                label="Status"
              />
              <WorkspaceTabTrigger
                value="test"
                icon={Play}
                label="Test release"
              />
            </TabsList>
          </div>

          <TabsContent value="overview" className="mt-3">
            <OverviewTab
              routingPlans={routingPlans}
              routeEntries={routeEntries}
              modelSources={modelSources}
              onCreatePlan={handleCreatePlan}
              onSelectPlan={handleSelectPlan}
              onEditPlan={handleEditPlan}
              onDeletePlan={onDeletePlan}
              onSelectRoute={handleSelectRoute}
              providersById={providersById}
              onJump={setActiveTab}
            />
          </TabsContent>

          <TabsContent value="sources" className="mt-3">
            <SourcesTab
              modelSources={modelSources}
              routingPlans={routingPlans}
              onCreatePlan={handleCreatePlan}
              onCreateProvider={onCreateProvider}
              onEditPlan={handleEditPlan}
              onSelectPlan={handleSelectPlan}
            />
          </TabsContent>

          <TabsContent value="routes" className="mt-3">
            <RoutesTab
              routingPlans={routingPlans}
              routeEntries={routeEntries}
              selectedPlan={selectedPlan}
              selectedRoute={selectedRoute}
              modelSources={modelSources}
              onCreatePlan={handleCreatePlan}
              onCreateProvider={onCreateProvider}
              onOpenRoutePicker={handleOpenRoutePicker}
              onSaveRoutes={handleSaveRoutingRoutes}
              onSelectPlan={handleSelectPlan}
              onSelectRoute={handleSelectRoute}
              onEditProvider={onEditProvider}
              onEditPlan={handleEditPlan}
              onDeletePlan={onDeletePlan}
              providersById={providersById}
              proxyStatus={proxyStatus}
              isProxyRunning={isProxyRunning}
              isCodexTakeoverActive={isCodexTakeoverActive}
              activeProviderId={activeProviderId}
              providerModelRefreshStates={providerModelRefreshStates}
              isRoutePickerOpen={isRoutePickerOpen}
              isSavingRoutes={isSavingRoutes}
              isPlanSettingsOpen={isPlanSettingsOpen}
              isSavingPlanSettings={isSavingPlanSettings}
              onPlanSettingsOpenChange={handlePlanSettingsOpenChange}
              onSavePlanSettings={handleSavePlanSettings}
              routePickerSelectAll={routePickerSelectAll}
              routePickerMessage={routePickerMessage}
              routePickerError={routePickerError}
              onRoutePickerOpenChange={setIsRoutePickerOpen}
            />
          </TabsContent>

          <TabsContent value="model-order" className="mt-3">
            <ModelOrderTab
              selectedPlan={selectedPlan}
              catalog={selectedProjectedCatalog}
              selectedRoutes={selectedPlanRouteEntries}
              providersById={providersById}
              onCreatePlan={handleCreatePlan}
            />
          </TabsContent>

          <TabsContent value="subagents" className="mt-3">
            <SubagentsTab
              selectedPlan={selectedPlan}
              selectedRoutes={selectedPlanRouteEntries}
              catalog={selectedProjectedCatalog}
              providersById={providersById}
              onCreatePlan={handleCreatePlan}
            />
          </TabsContent>

          <TabsContent value="status" className="mt-3">
            <StatusTab
              selectedPlan={selectedPlan}
              selectedRouting={selectedRouting}
              routeEntries={routeEntries}
              providersById={providersById}
              proxyStatus={proxyStatus}
              isProxyRunning={isProxyRunning}
              isCodexTakeoverActive={isCodexTakeoverActive}
              activeProviderId={activeProviderId}
              onEditPlan={handleEditPlan}
              onDeletePlan={onDeletePlan}
            />
          </TabsContent>

          <TabsContent value="test" className="mt-3">
            <TestTab
              selectedPlan={selectedPlan}
              selectedRouting={selectedRouting}
              routeModels={routeModels}
              testModel={testModel}
              testResult={testResult}
              onModelChange={setTestModel}
              onPreviewRoute={handlePreviewRoute}
              onEditPlan={handleEditPlan}
            />
          </TabsContent>
        </Tabs>
      </div>
      <Dialog
        open={Boolean(migrationTargetPlan)}
        onOpenChange={(open) => {
          if (open || isApplyingMigration) return;
          setMigrationTargetPlan(null);
          setMigrationPreview(null);
          setMigrationPendingAction(null);
          setMigrationError(null);
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Migrate legacy MultiRouter to schema v2</DialogTitle>
            <DialogDescription>
              Explicit migration is required before editing or enabling a legacy
              plan. The preview only shows reference changes and field
              categories; it never shows API keys, tokens, or OAuth credentials.
            </DialogDescription>
          </DialogHeader>
          {isLoadingMigration ? (
            <div className="rounded-md border p-3 text-sm text-muted-foreground">
              Generating migration preview…
            </div>
          ) : migrationPreview ? (
            <div className="space-y-3 text-sm">
              <div className="grid gap-2 sm:grid-cols-3">
                <DetailRow
                  label="Redundant fields removed"
                  value={String(
                    migrationPreview.diff.removedRouteFields.length,
                  )}
                />
                <DetailRow
                  label="Route reference changes"
                  value={String(migrationPreview.diff.changedRouteIds.length)}
                />
                <DetailRow
                  label="Providers created by migration"
                  value={String(migrationPreview.generatedProviders.length)}
                />
              </div>
              {migrationPreview.generatedProviders.length > 0 ? (
                <div className="rounded-md border p-3">
                  <div className="font-medium">Providers to create</div>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
                    {migrationPreview.generatedProviders.map((provider) => (
                      <li key={provider.id}>
                        {provider.name} ({provider.id}); source{" "}
                        {provider.sourceProviderId}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {migrationPreview.warnings.length > 0 ? (
                <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-100">
                  <div className="font-medium">Migration warning</div>
                  <ul className="mt-2 list-disc space-y-1 pl-5">
                    {migrationPreview.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
          {migrationError ? (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
            >
              {migrationError}
            </div>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={isApplyingMigration}
              onClick={() => {
                setMigrationTargetPlan(null);
                setMigrationPreview(null);
                setMigrationPendingAction(null);
                setMigrationError(null);
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={!migrationPreview || isApplyingMigration}
              onClick={() => void applyLegacyPlanMigration()}
            >
              {isApplyingMigration
                ? "Applying…"
                : "Apply migration and continue"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/// 顶部工作台只保留定位说明和主要动作；运行态证据统一放到状态页，避免两处重复。
function HeaderPanel({
  onCreatePlan,
  onJump,
}: {
  onCreatePlan: () => void;
  onJump: (tab: WorkspaceTab) => void;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card dark:border-slate-700/80 dark:bg-slate-950/30">
      <div className="flex flex-wrap items-center justify-between gap-3 bg-gradient-to-r from-blue-50 via-background to-emerald-50 px-4 py-3 dark:from-blue-950/45 dark:via-slate-900 dark:to-emerald-950/30">
        <div className="min-w-0 space-y-2">
          <div className="flex items-center gap-2 text-base font-semibold">
            <GitBranch className="h-4 w-4 text-blue-600 dark:text-blue-300" />
            Codex multi-model routing workspace
          </div>
          <p className="max-w-4xl text-xs leading-5 text-muted-foreground dark:text-slate-400">
            Configure how Codex selects multiple upstream models by model name.
            Codex still connects to one CC Switch local proxy; routing rules
            send gpt, qwen, deepseek, and other model names to different
            upstreams.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={onCreatePlan}
              size="sm"
              className="gap-2 bg-blue-600 hover:bg-blue-500"
            >
              <Plus className="h-4 w-4" />
              Create multi-route plan
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onJump("routes")}
              className="gap-2"
            >
              <Settings2 className="h-4 w-4" />
              Manage route rules
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onJump("status")}
              className="gap-2"
            >
              <Activity className="h-4 w-4" />
              View link status
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/// 选项卡触发器封装，统一图标和可点击态。
function WorkspaceTabTrigger({
  value,
  icon: Icon,
  label,
}: {
  value: WorkspaceTab;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <TabsTrigger value={value} className="min-w-0 gap-2">
      <Icon className="h-4 w-4 flex-shrink-0" />
      <span className="hidden truncate sm:inline">{label}</span>
    </TabsTrigger>
  );
}

/// 总览页展示当前方案、关键规则和下一步动作，避免用户只看到一堆不可操作卡片。
function OverviewTab({
  routingPlans,
  routeEntries,
  modelSources,
  providersById,
  onCreatePlan,
  onSelectPlan,
  onEditPlan,
  onDeletePlan,
  onSelectRoute,
  onJump,
}: {
  routingPlans: Provider[];
  routeEntries: RouteEntry[];
  modelSources: Provider[];
  providersById: Map<string, Provider>;
  onCreatePlan: () => void;
  onSelectPlan: (provider: Provider) => void;
  onEditPlan: (provider: Provider, detail?: string) => void;
  onDeletePlan: (provider: Provider) => void;
  onSelectRoute: (entry: RouteEntry) => void;
  onJump: (tab: WorkspaceTab) => void;
}) {
  return (
    <div className="grid gap-4 xl:grid-cols-[1.05fr_0.95fr]">
      <section className="rounded-lg border border-blue-200 bg-blue-50/70 p-4 dark:border-blue-700/40 dark:bg-blue-950/15">
        <SectionHeader
          icon={Layers3}
          title="Multi-route plans"
          detail="Each multi-route plan is a local proxy entry that Codex can connect to."
          action={
            <Button
              size="sm"
              onClick={onCreatePlan}
              className="gap-2 bg-blue-600 hover:bg-blue-500"
            >
              <Plus className="h-4 w-4" />
              Create multi-route plan
            </Button>
          }
        />
        <div className="mt-3 grid gap-3">
          {routingPlans.length === 0 ? (
            <EmptyState
              icon={Wand2}
              title="No multi-route plans yet"
              detail="Create a multi-route plan, then attach model sources to it."
              actionLabel="Create multi-route plan"
              onAction={onCreatePlan}
            />
          ) : (
            routingPlans.map((provider) => (
              <div
                key={provider.id}
                className="group rounded-lg border border-blue-200 bg-card p-4 text-left transition hover:border-blue-400 hover:bg-blue-50 hover:shadow-[0_0_0_1px_rgba(96,165,250,0.25)] dark:border-blue-600/40 dark:bg-slate-950/40 dark:hover:bg-blue-950/30 dark:hover:shadow-[0_0_0_1px_rgba(96,165,250,0.35)]"
              >
                <PlanCardContent
                  provider={provider}
                  providersById={providersById}
                />
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => onSelectPlan(provider)}
                    className="gap-2"
                  >
                    <Route className="h-4 w-4" />
                    Route rules
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => onEditPlan(provider, "Rename MultiRouter")}
                    className="gap-2"
                  >
                    <Pencil className="h-4 w-4" />
                    Rename/settings
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => onDeletePlan(provider)}
                    className="gap-2 border-rose-300 bg-background/70 text-rose-700 hover:bg-rose-50 dark:border-rose-500/50 dark:bg-rose-500/10 dark:text-rose-100 dark:hover:bg-rose-500/20"
                  >
                    <Trash2 className="h-4 w-4" />
                    Delete
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="rounded-lg border border-emerald-200 bg-emerald-50/70 p-4 dark:border-emerald-700/40 dark:bg-emerald-950/10">
        <SectionHeader
          icon={Route}
          title="Recent route rules"
          detail="Click a rule to view details and test it."
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={() => onJump("routes")}
              className="gap-2"
            >
              View all
              <ArrowRight className="h-4 w-4" />
            </Button>
          }
        />
        <div className="mt-3 grid gap-2">
          {routeEntries.slice(0, 4).map((entry) => (
            <RouteListButton
              key={`${entry.provider.id}-${entry.route.id ?? entry.index}`}
              entry={entry}
              providersById={providersById}
              onClick={() => onSelectRoute(entry)}
            />
          ))}
          {routeEntries.length === 0 && (
            <EmptyState
              icon={Route}
              title="No rules yet"
              detail="After creating a multi-route plan, add model matching rules in the editor."
              actionLabel="Create multi-route plan"
              onAction={onCreatePlan}
            />
          )}
        </div>
      </section>

      <section className="rounded-lg border border-amber-200 bg-amber-50/70 p-4 dark:border-amber-700/40 dark:bg-amber-950/10 xl:col-span-2">
        <SectionHeader
          icon={Server}
          title="Available model sources"
          detail="These are upstream model sources that routing plans can connect; they are not a separate provider type."
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={() => onJump("sources")}
            >
              Choose model sources
            </Button>
          }
        />
        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {modelSources.slice(0, 8).map((provider) => (
            <SourceMiniCard key={provider.id} provider={provider} />
          ))}
        </div>
      </section>
    </div>
  );
}

/// 模型源页展示可被纳入路由的上游，并把“编辑后接入”作为明确操作。
function SourcesTab({
  modelSources,
  routingPlans,
  onCreatePlan,
  onCreateProvider,
  onEditPlan,
  onSelectPlan,
}: {
  modelSources: Provider[];
  routingPlans: Provider[];
  onCreatePlan: () => void;
  onCreateProvider: () => void;
  onEditPlan: (provider: Provider, detail?: string) => void;
  onSelectPlan: (provider: Provider) => void;
}) {
  const providersById = new Map(
    [...routingPlans, ...modelSources].map((provider) => [
      provider.id,
      provider,
    ]),
  );
  return (
    <div className="grid gap-4 xl:grid-cols-[0.8fr_1.2fr]">
      <section className="rounded-lg border border-blue-200 bg-blue-50/70 p-4 dark:border-blue-700/40 dark:bg-blue-950/15">
        <SectionHeader
          icon={Layers3}
          title="Multi-route plan"
          detail="This is the route entry Codex ultimately connects to. Open “Route rules” to attach model sources."
          action={
            <Button
              size="sm"
              onClick={onCreatePlan}
              className="gap-2 bg-blue-600 hover:bg-blue-500"
            >
              <Plus className="h-4 w-4" />
              Create multi-route plan
            </Button>
          }
        />
        <div className="mt-3 grid gap-2">
          {routingPlans.map((provider) => (
            <div
              key={provider.id}
              className="rounded-lg border border-blue-200 bg-card p-3 text-left transition hover:border-blue-400 hover:bg-blue-50 dark:border-blue-700/40 dark:bg-slate-950/40 dark:hover:bg-blue-950/30"
            >
              <PlanCardContent
                provider={provider}
                providersById={providersById}
                compact
              />
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onSelectPlan(provider)}
                  className="gap-2"
                >
                  <Route className="h-4 w-4" />
                  Route rules
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onEditPlan(provider, "Rename MultiRouter")}
                  className="gap-2"
                >
                  <Pencil className="h-4 w-4" />
                  Rename/settings
                </Button>
              </div>
            </div>
          ))}
          {routingPlans.length === 0 && (
            <EmptyState
              icon={Layers3}
              title="No multi-route plans yet"
              detail="Create a Codex multi-model route entry first, then attach sources in “Choose model sources”."
              actionLabel="Create multi-route plan"
              onAction={onCreatePlan}
            />
          )}
        </div>
      </section>

      <section className="rounded-lg border border-amber-200 bg-amber-50/70 p-4 dark:border-amber-700/40 dark:bg-amber-950/10">
        <SectionHeader
          icon={Server}
          title="Choose model sources"
          detail="Choose upstream model sources for this MultiRouter here; click a card to configure it."
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={onCreateProvider}
              className="gap-2"
            >
              <Plus className="h-4 w-4" />
              Add model source
            </Button>
          }
        />
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {modelSources.map((provider) => (
            <button
              key={provider.id}
              type="button"
              onClick={() =>
                onEditPlan(
                  provider,
                  "Select and edit a model source for MultiRouter",
                )
              }
              className="group rounded-lg border border-amber-200 bg-card p-4 text-left transition hover:border-amber-400 hover:bg-amber-50 hover:shadow-[0_0_0_1px_rgba(251,191,36,0.18)] dark:border-amber-700/40 dark:bg-slate-950/40 dark:hover:bg-amber-950/20 dark:hover:shadow-[0_0_0_1px_rgba(251,191,36,0.25)]"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-foreground dark:text-slate-100">
                    {provider.name}
                  </div>
                  <div className="mt-1 truncate text-xs text-muted-foreground dark:text-slate-400">
                    ID: {provider.id}
                  </div>
                </div>
                <Badge className="border-amber-200 bg-amber-100 text-amber-800 dark:border-amber-500/50 dark:bg-amber-500/15 dark:text-amber-100">
                  Optional
                </Badge>
              </div>
              <div className="mt-4 flex items-center justify-between text-xs">
                <span className="text-muted-foreground dark:text-slate-400">
                  Select this model source
                </span>
                <span className="inline-flex items-center gap-1 text-amber-700 opacity-80 group-hover:opacity-100 dark:text-amber-200">
                  Select
                  <Pencil className="h-3.5 w-3.5" />
                </span>
              </div>
            </button>
          ))}
          {modelSources.length === 0 && (
            <EmptyState
              icon={Server}
              title="No model sources yet"
              detail="Add a standard Codex model source, then connect it to a multi-route plan."
              actionLabel="Add model source"
              onAction={onCreateProvider}
            />
          )}
        </div>
      </section>
    </div>
  );
}

/// 子 Agent 使用独立工作区承载协议与模型能力，避免用户在路由规则页尾部寻找配置入口。
function SubagentsTab({
  selectedPlan,
  selectedRoutes,
  catalog,
  providersById,
  onCreatePlan,
}: {
  selectedPlan: Provider | null;
  selectedRoutes: RouteEntry[];
  catalog: CodexModelCatalogDraft;
  providersById: Map<string, Provider>;
  onCreatePlan: () => void;
}) {
  if (!selectedPlan) {
    return (
      <EmptyState
        icon={Bot}
        title="No configurable MultiRouter"
        detail="Create or select a multi-route plan, then configure its sub-agent protocol and model capabilities."
        actionLabel="Create multi-route plan"
        onAction={onCreatePlan}
      />
    );
  }

  return (
    <div className="space-y-3">
      <section
        aria-label="Current Sub-Agent plan"
        className="rounded-lg border border-blue-200 bg-blue-50/70 p-3 dark:border-blue-700/40 dark:bg-blue-950/15"
      >
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-blue-800 dark:text-blue-100">
          <Bot className="h-4 w-4" />
          Current MultiRouter
        </div>
        <PlanCardContent
          provider={selectedPlan}
          providersById={
            new Map(
              selectedRoutes.map(({ provider }) => [provider.id, provider]),
            )
          }
          compact
        />
      </section>
      <SpawnAgentCandidatesPanel
        selectedPlan={selectedPlan}
        selectedRoutes={selectedRoutes}
        catalog={catalog}
        providersById={providersById}
      />
    </div>
  );
}

export type { CodexModelDisplayStyle } from "@/types";
export type CodexModelSortMode =
  "custom" | "model" | "provider" | "provider-model";

const DEFAULT_CODEX_MODEL_DISPLAY_STYLE: CodexModelDisplayStyle =
  "provider-model";
const RANKED_MODEL_LIMIT = 8;

export function codexCatalogProviderName(
  model: Pick<CodexCatalogModel, "providerName" | "provider_name">,
): string {
  return (model.providerName ?? model.provider_name ?? "").trim();
}

export function isCodexProtocolFallback(model: CodexCatalogModel): boolean {
  const source = model.apiFormatSource ?? model.api_format_source;
  return !source || source === "provider" || source === "default";
}

function stripBracketedProviderPrefix(label: string): string {
  if (!label.startsWith("[")) return label;
  const closeIndex = label.indexOf("]");
  return closeIndex < 0 ? label : label.slice(closeIndex + 1).trimStart();
}

export function compactCodexProviderLabel(providerName: string): string {
  const trimmed = providerName.trim();
  const alphanumeric = Array.from(trimmed)
    .filter((character) => /[\p{L}\p{N}]/u.test(character))
    .join("");
  if (alphanumeric.toLocaleLowerCase() === "openrouter") return "ORter";
  if (alphanumeric.toLocaleLowerCase() === "opencodezen") return "OCzen";
  if (Array.from(alphanumeric).length <= 5) return alphanumeric;

  const words = trimmed
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (words.length < 2) return Array.from(alphanumeric).slice(0, 5).join("");
  if (words.length >= 5) {
    return words
      .slice(0, 5)
      .map((word) => Array.from(word)[0]?.toLocaleUpperCase() ?? "")
      .join("");
  }
  const prefixCount = Math.min(words.length - 1, 4);
  const prefix = words
    .slice(0, prefixCount)
    .map((word) => Array.from(word)[0]?.toLocaleUpperCase() ?? "")
    .join("");
  const suffixBudget = Math.max(0, 5 - Array.from(prefix).length);
  const suffix = Array.from(words.at(-1) ?? "")
    .slice(-suffixBudget)
    .join("");
  return `${prefix}${suffix}`;
}

export function formatCodexCatalogModelLabel(
  model: CodexCatalogModel,
  style: CodexModelDisplayStyle = DEFAULT_CODEX_MODEL_DISPLAY_STYLE,
): string {
  const id = model.model?.trim() ?? "";
  const provider = codexCatalogProviderName(model);
  const rawDisplay =
    (model.displayName ?? model.display_name ?? id).trim() || id;
  const compactProvider = compactCodexProviderLabel(provider);
  const display = provider
    ? [provider, compactProvider].reduce(
        (label, candidate) =>
          label.replace(
            new RegExp(
              `^\\[${candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\s*`,
              "i",
            ),
            "",
          ),
        rawDisplay,
      )
    : stripBracketedProviderPrefix(rawDisplay);
  if (!provider || style === "model") return display;
  return style === "provider-model"
    ? `[${compactProvider}] ${display}`
    : `${display} · ${compactProvider}`;
}

export function sortCodexCatalogModels(
  models: CodexCatalogModel[],
  mode: CodexModelSortMode,
): CodexCatalogModel[] {
  if (mode === "custom") return models.slice();
  return models.slice().sort((left, right) => {
    const leftModel = (left.model ?? "").trim();
    const rightModel = (right.model ?? "").trim();
    const leftProvider = codexCatalogProviderName(left).toLocaleLowerCase();
    const rightProvider = codexCatalogProviderName(right).toLocaleLowerCase();
    const by = (a: string, b: string) =>
      a.localeCompare(b, undefined, { sensitivity: "base" });
    if (mode === "provider" || mode === "provider-model") {
      const providerResult = by(leftProvider, rightProvider);
      if (providerResult) return providerResult;
    }
    // "provider" groups by provider but preserves the current model order
    // inside each group. "provider-model" also sorts models alphabetically.
    if (mode === "provider-model" || mode === "model") {
      const modelResult = by(
        leftModel.toLocaleLowerCase(),
        rightModel.toLocaleLowerCase(),
      );
      if (modelResult) return modelResult;
    }
    return 0;
  });
}

function codexModelRecommendationScore(model: CodexCatalogModel): number {
  const id = (model.model ?? "").trim().toLocaleLowerCase();
  const label =
    `${id} ${model.displayName ?? model.display_name ?? ""}`.toLocaleLowerCase();
  let score = 0;
  if (/(codex|coder|coding|code-|sonnet|opus)/.test(label)) score += 60;
  if (model.reasoning?.supportStatus === "confirmed_supported") score += 24;
  if ((model.reasoning?.supportedEfforts?.length ?? 0) >= 3) score += 12;
  const contextWindow = Number(
    model.contextWindow ?? model.context_window ?? 0,
  );
  if (contextWindow >= 200_000) score += 12;
  else if (contextWindow >= 100_000) score += 6;
  if (
    (model.inputModalities ?? model.input_modalities ?? []).includes("image")
  ) {
    score += 4;
  }
  const versions = id.match(/\d+(?:\.\d+)*/g) ?? [];
  score += versions.reduce((total, version) => {
    const [major = 0, minor = 0] = version.split(".").map(Number);
    return total + Math.min(major, 20) + Math.min(minor, 20) / 10;
  }, 0);
  if (
    /(embedding|rerank|moderation|guard|audio|speech|tts|transcri|image-gen|realtime)/.test(
      label,
    )
  ) {
    score -= 120;
  }
  if (/(deprecated|legacy|old)/.test(label)) score -= 80;
  return score;
}

export function recommendCodexCatalogModels(
  models: CodexCatalogModel[],
  limit = RANKED_MODEL_LIMIT,
  preferredProviders: string[] = [],
  history?: CodexCatalogUsageHistory,
): CodexCatalogModel[] {
  if (limit <= 0) return [];
  const usage = codexCatalogModelUsage(models, history);
  const defaultRank = new Map(
    defaultCodexCatalogModelOrder(models).map((model, index) => [
      model.model,
      index,
    ]),
  );
  const providerRank = new Map(
    preferredProviders.map((provider, index) => [
      provider.trim().toLocaleLowerCase(),
      index,
    ]),
  );
  const ranked = models
    .map((model, index) => ({
      model,
      index,
      provider: codexCatalogProviderName(model) || "unknown",
      score: codexModelRecommendationScore(model),
      usage: usage.get(model.model.trim().toLowerCase()),
    }))
    .sort(
      (left, right) =>
        (right.usage?.codexRequests ?? 0) - (left.usage?.codexRequests ?? 0) ||
        (right.usage?.codexTokens ?? 0) - (left.usage?.codexTokens ?? 0) ||
        (right.usage?.providerRequests ?? 0) -
          (left.usage?.providerRequests ?? 0) ||
        (right.usage?.providerTokens ?? 0) -
          (left.usage?.providerTokens ?? 0) ||
        (providerRank.get(left.provider.toLocaleLowerCase()) ?? 999) -
          (providerRank.get(right.provider.toLocaleLowerCase()) ?? 999) ||
        right.score - left.score ||
        (defaultRank.get(left.model.model) ?? 0) -
          (defaultRank.get(right.model.model) ?? 0) ||
        left.index - right.index,
    );
  return ranked.slice(0, limit).map(({ model }) => model);
}

type ModelOrderReasoning = {
  efforts: CodexReasoningEffort[];
  defaultEffort?: CodexReasoningEffort | null;
};

const UNKNOWN_MODEL_ORDER_REASONING: ModelOrderReasoning = { efforts: [] };

function declaredModelOrderReasoning(
  model?: CodexCatalogModel,
): ModelOrderReasoning | undefined {
  const reasoning = model?.reasoning;
  if (!reasoning) return undefined;
  if (
    reasoning.supportStatus === "confirmed_unsupported" ||
    reasoning.supported === false ||
    reasoning.controlKind === "boolean" ||
    reasoning.controlKind === "none"
  ) {
    return UNKNOWN_MODEL_ORDER_REASONING;
  }
  return {
    efforts: reasoning.supportedEfforts.filter((effort) => effort !== "ultra"),
    defaultEffort: reasoning.defaultEffort,
  };
}

function modelOrderReasoningQueryOptions(
  model: CodexCatalogModel | undefined,
  selectedRoutes: RouteEntry[],
  providersById: Map<string, Provider>,
) {
  let source: Provider | undefined;
  let upstream = model ? catalogDraftUpstreamModel(model) : "";
  if (model) {
    const identities = modelIdentityValues(model);
    for (const { route } of selectedRoutes) {
      if (route.enabled === false) continue;
      const provider = providersById.get(routeTargetProviderId(route) ?? "");
      if (!provider) continue;
      const sourceModel = readIncludedCodexModelCatalog(provider).models.find(
        (entry) =>
          modelIdentityValues(entry).some((identity) =>
            identities.includes(identity),
          ),
      );
      // An explicit catalog is authoritative, including an empty catalog.
      // Do not resolve stale router models against legacy route fields when
      // the target provider no longer exposes that model.
      if (providerHasCodexModelCatalog(provider) && !sourceModel) {
        continue;
      }
      if (
        !routeCanMatchVisibleCatalogModel(route, model) &&
        !(route.modelSelection?.mode === "all" && sourceModel)
      ) {
        continue;
      }
      source = provider;
      upstream =
        (route.aliases ?? route.upstream?.modelMap)?.[model.model] ??
        (sourceModel ? catalogDraftUpstreamModel(sourceModel) : upstream);
      break;
    }
  }
  return {
    queryKey: [
      "codexModelOrderReasoning",
      model?.model,
      upstream,
      source?.id,
      source?.settingsConfig,
    ],
    retry: false,
    staleTime: 60_000,
    queryFn: async (): Promise<ModelOrderReasoning> => {
      if (!source || !model) return UNKNOWN_MODEL_ORDER_REASONING;
      let resolution = await codexSubagentV2Api.resolveModelReasoningCapability(
        source.settingsConfig,
        source.id,
        model.model,
      );
      // Preserve visible-model overrides before falling back to the wire identity.
      if (resolution.source === "unknown" && upstream !== model.model) {
        resolution = await codexSubagentV2Api.resolveModelReasoningCapability(
          source.settingsConfig,
          source.id,
          upstream,
        );
      }
      return {
        efforts:
          resolution.resolved.supportKind === "effort_levels"
            ? resolution.resolved.codexSelectableEfforts.filter(
                (effort) => effort !== "ultra",
              )
            : [],
        defaultEffort: resolution.resolved.providerDefaultEffort,
      };
    },
  };
}

export function ModelOrderTab({
  selectedPlan,
  catalog,
  selectedRoutes,
  providersById,
  onCreatePlan,
}: {
  selectedPlan: Provider | null;
  catalog: CodexModelCatalogDraft;
  selectedRoutes: RouteEntry[];
  providersById: Map<string, Provider>;
  onCreatePlan: () => void;
}) {
  useTranslation();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draftModels, setDraftModels] = useState<CodexCatalogModel[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [isRecommending, setIsRecommending] = useState(false);
  const [recommendationUsage, setRecommendationUsage] =
    useState<CodexCatalogUsageHistory>();
  const recommendationRequest = useRef(0);
  const [displayStyle, setDisplayStyle] = useState<CodexModelDisplayStyle>(
    DEFAULT_CODEX_MODEL_DISPLAY_STYLE,
  );
  const [sortMode, setSortMode] = useState<CodexModelSortMode>("custom");
  const [modelSearch, setModelSearch] = useState("");
  const configuredDefaultReasoningEffort =
    selectedPlan?.settingsConfig?.codexRouting?.defaultReasoningEffort;
  const [defaultReasoningEffort, setDefaultReasoningEffort] = useState<
    CodexReasoningEffort | undefined
  >(configuredDefaultReasoningEffort);
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const catalogKey = [
    catalog.displayNameStyle ?? "",
    ...catalog.models.map((model) => JSON.stringify(model)),
  ].join("\n");
  const persistedModelOrder = useMemo<string[]>(() => {
    const order = selectedPlan?.settingsConfig?.codexRouting?.modelOrder;
    return Array.isArray(order)
      ? order.filter(
          (model): model is string =>
            typeof model === "string" && Boolean(model.trim()),
        )
      : [];
  }, [selectedPlan?.settingsConfig?.codexRouting?.modelOrder]);
  const defaultModels = useMemo(
    () =>
      selectedPlan
        ? defaultCodexCatalogModelOrder(
            buildModelCatalogForRoutes(
              selectedPlan,
              selectedRoutes.map(({ route }) => route),
              providersById,
              { ignorePersistedModelOrder: true },
            ).models,
          )
        : [],
    [selectedPlan, selectedRoutes, providersById],
  );
  const providerNamesByModel = useMemo(() => {
    const names = new Map<string, string>();
    for (const { route } of selectedRoutes) {
      if (route.enabled === false) continue;
      const provider = providersById.get(routeTargetProviderId(route) ?? "");
      if (!provider) continue;
      for (const source of readIncludedCodexModelCatalog(provider).models) {
        for (const value of [
          source.model,
          source.upstreamModel,
          source.upstream_model,
        ]) {
          const id = value?.trim();
          if (id && !names.has(id)) names.set(id, provider.name);
        }
      }
    }
    return names;
  }, [selectedRoutes, providersById]);
  const orderedDraftModels = useMemo(
    () =>
      sortCodexCatalogModels(
        draftModels.map((model) => {
          if (codexCatalogProviderName(model)) return model;
          const providerName = providerNamesByModel.get(
            model.model?.trim() ?? "",
          );
          return providerName ? { ...model, providerName } : model;
        }),
        sortMode,
      ),
    [draftModels, providerNamesByModel, sortMode],
  );
  const visibleDraftModels = useMemo(() => {
    const query = modelSearch.trim().toLocaleLowerCase();
    if (!query) return orderedDraftModels;
    return orderedDraftModels.filter((model) =>
      [
        model.model,
        model.displayName,
        model.display_name,
        codexCatalogProviderName(model),
        catalogDraftUpstreamModel(model),
      ].some((value) => value?.toLocaleLowerCase().includes(query)),
    );
  }, [modelSearch, orderedDraftModels]);
  const latestDraftModels = useRef(orderedDraftModels);
  latestDraftModels.current = orderedDraftModels;
  const defaultOrderKey = defaultModels.map((model) => model.model).join("\n");
  const canRestoreDefault =
    orderedDraftModels.map((model) => model.model).join("\n") !==
      defaultOrderKey ||
    (persistedModelOrder.length > 0 &&
      persistedModelOrder.join("\n") !== defaultOrderKey);
  const globalRankByModel = useMemo(
    () =>
      new Map(
        orderedDraftModels.map((model, index) => [model.model?.trim(), index]),
      ),
    [orderedDraftModels],
  );
  const topModels = orderedDraftModels.slice(0, RANKED_MODEL_LIMIT);
  const remainingModels = visibleDraftModels.filter(
    (model) =>
      !topModels.some(
        (topModel) => topModel.model?.trim() === model.model?.trim(),
      ),
  );
  const sortableModels = [...topModels, ...remainingModels];
  const recommendedModelIds = useMemo(
    () =>
      new Set(
        recommendCodexCatalogModels(
          orderedDraftModels,
          RANKED_MODEL_LIMIT,
          selectedRoutes
            .map(({ route }) =>
              providersById.get(routeTargetProviderId(route) ?? ""),
            )
            .filter((provider): provider is Provider => Boolean(provider))
            .map((provider) => provider.name),
          recommendationUsage,
        ).map((model) => model.model?.trim()),
      ),
    [orderedDraftModels, providersById, selectedRoutes, recommendationUsage],
  );
  const topModel = orderedDraftModels[0];
  const declaredTopReasoning = declaredModelOrderReasoning(topModel);
  const topReasoningQuery = useQuery({
    ...modelOrderReasoningQueryOptions(topModel, selectedRoutes, providersById),
    enabled: Boolean(topModel) && !declaredTopReasoning,
  });
  const topReasoning =
    declaredTopReasoning ??
    topReasoningQuery.data ??
    UNKNOWN_MODEL_ORDER_REASONING;
  const topReasoningEfforts = topReasoning.efforts;
  const topDefaultReasoningEffort =
    topReasoning.defaultEffort &&
    topReasoningEfforts.includes(topReasoning.defaultEffort)
      ? topReasoning.defaultEffort
      : topReasoningEfforts[0];
  const selectedDefaultReasoningEffort =
    defaultReasoningEffort &&
    topReasoningEfforts.includes(defaultReasoningEffort)
      ? defaultReasoningEffort
      : topDefaultReasoningEffort;
  const effectiveConfiguredDefaultReasoningEffort =
    configuredDefaultReasoningEffort &&
    topReasoningEfforts.includes(configuredDefaultReasoningEffort)
      ? configuredDefaultReasoningEffort
      : topDefaultReasoningEffort;
  const fallbackProtocolCount = visibleDraftModels.filter(
    isCodexProtocolFallback,
  ).length;
  const styleDirty =
    displayStyle !==
    (catalog.displayNameStyle ?? DEFAULT_CODEX_MODEL_DISPLAY_STYLE);
  const effortDirty =
    topReasoningEfforts.length > 0 &&
    selectedDefaultReasoningEffort !==
      effectiveConfiguredDefaultReasoningEffort;
  const hasChanges =
    styleDirty ||
    effortDirty ||
    orderedDraftModels.map((model) => model.model).join("\n") !==
      catalog.models.map((model) => model.model).join("\n");

  useEffect(() => {
    recommendationRequest.current += 1;
    setIsRecommending(false);
    setRecommendationUsage(undefined);
    setSortMode("custom");
    setMessage(null);
    setError(null);
    setDisplayStyle(
      catalog.displayNameStyle ?? DEFAULT_CODEX_MODEL_DISPLAY_STYLE,
    );
    setDraftModels(
      catalog.models
        .slice()
        .sort(
          (left, right) =>
            (left.sortIndex ?? Number.MAX_SAFE_INTEGER) -
            (right.sortIndex ?? Number.MAX_SAFE_INTEGER),
        ),
    );
    setDefaultReasoningEffort(configuredDefaultReasoningEffort);
  }, [selectedPlan?.id, catalogKey, configuredDefaultReasoningEffort]);

  useEffect(
    () => () => {
      recommendationRequest.current += 1;
    },
    [],
  );

  const hiddenCatalogModels = useMemo(() => {
    const hidden: Array<{
      model: string;
      upstream?: string;
      providerId: string;
      providerName: string;
    }> = [];
    const seenProviders = new Set<string>();
    for (const { route } of selectedRoutes) {
      const targetProviderId = routeTargetProviderId(route);
      if (!targetProviderId || seenProviders.has(targetProviderId)) continue;
      seenProviders.add(targetProviderId);
      const source = providersById.get(targetProviderId);
      if (!source) continue;
      for (const model of readCodexModelCatalog(source).models) {
        if (model.enabled !== false) continue;
        const modelId = model.model?.trim();
        if (!modelId) continue;
        hidden.push({
          model: modelId,
          upstream: model.upstreamModel ?? model.upstream_model,
          providerId: targetProviderId,
          providerName: source.name,
        });
      }
    }
    return hidden;
  }, [selectedRoutes, providersById]);

  function handleDragEnd(event: DragEndEvent) {
    const activeModel = String(event.active.id);
    const overModel = event.over ? String(event.over.id) : "";
    if (!overModel || activeModel === overModel) return;
    // A manual drag is an explicit custom order. Switching back to custom here
    // prevents the selected alphabetical/provider sort from immediately undoing it.
    setSortMode("custom");
    setDraftModels(() => {
      const activeIndex = orderedDraftModels.findIndex(
        (model) => model.model?.trim() === activeModel,
      );
      const overIndex = orderedDraftModels.findIndex(
        (model) => model.model?.trim() === overModel,
      );
      if (activeIndex < 0 || overIndex < 0) return draftModels;
      const next = [...orderedDraftModels];
      const [moved] = next.splice(activeIndex, 1);
      next.splice(overIndex, 0, moved);
      return next;
    });
  }

  async function applyRecommendations() {
    if (isRecommending || isSaving) return;
    const request = ++recommendationRequest.current;
    setIsRecommending(true);
    setMessage(null);
    setError(null);
    try {
      let syncIncomplete = false;
      try {
        const sync = await usageApi.syncSessionUsage();
        syncIncomplete = sync.errors.length > 0 || sync.deferredFiles > 0;
      } catch {
        syncIncomplete = true;
      }
      if (request !== recommendationRequest.current) return;
      const results = await Promise.allSettled([
        usageApi.getModelStats(undefined, undefined, "codex"),
        usageApi.getModelStats(),
      ]);
      if (request !== recommendationRequest.current) return;
      if (results.every((result) => result.status === "rejected")) {
        throw new Error(
          results
            .filter((result) => result.status === "rejected")
            .map((result) => workspaceErrorMessage(result.reason))
            .join("; "),
        );
      }
      const history: CodexCatalogUsageHistory = {
        codex: results[0].status === "fulfilled" ? results[0].value : [],
        providers: results[1].status === "fulfilled" ? results[1].value : [],
      };
      const models = latestDraftModels.current;
      const matchedUsage = codexCatalogModelUsage(models, history);
      const preferredProviders = selectedRoutes
        .filter(({ route }) => route.enabled !== false)
        .map(({ route }) =>
          providersById.get(routeTargetProviderId(route) ?? ""),
        )
        .filter((provider): provider is Provider => Boolean(provider))
        .map((provider) => provider.name);
      setRecommendationUsage(history);
      setSortMode("custom");
      setDraftModels(
        recommendCodexCatalogModels(
          models,
          models.length,
          preferredProviders,
          history,
        ),
      );
      const partial =
        syncIncomplete ||
        results.some((result) => result.status === "rejected");
      setMessage(
        (matchedUsage.size
          ? tr("codexRouterWorkspace.recommendationsFromUsage", {
              defaultValue:
                "Recommendations applied from usage history for {{count}} models.",
              count: matchedUsage.size,
            })
          : tr("codexRouterWorkspace.recommendationsNoUsage", {
              defaultValue:
                "No matching usage history; applied coding-capability recommendations.",
            })) +
          (partial
            ? ` ${tr("codexRouterWorkspace.recommendationsPartialUsage", {
                defaultValue:
                  "Some usage could not be refreshed; available history was used.",
              })}`
            : ""),
      );
      void queryClient.invalidateQueries({ queryKey: usageKeys.all });
    } catch (recommendationError) {
      if (request !== recommendationRequest.current) return;
      setError(
        tr("codexRouterWorkspace.recommendationsUsageFailed", {
          defaultValue:
            "Could not read usage history. Model order was not changed: {{error}}",
          error: workspaceErrorMessage(recommendationError),
        }),
      );
    } finally {
      if (request === recommendationRequest.current) setIsRecommending(false);
    }
  }

  function moveModelToPosition(modelId: string, position: number) {
    const target = modelId.trim();
    if (!target) return;
    const targetIndex = Math.min(
      Math.max(Math.trunc(position) - 1, 0),
      Math.max(orderedDraftModels.length - 1, 0),
    );
    setSortMode("custom");
    setDraftModels((current) => {
      const ordered = sortCodexCatalogModels(current, sortMode);
      const index = ordered.findIndex(
        (model) => model.model?.trim() === target,
      );
      if (index < 0 || index === targetIndex) return ordered;
      const [moved] = ordered.splice(index, 1);
      ordered.splice(targetIndex, 0, moved);
      return ordered;
    });
  }

  function moveModelToTop(modelId: string) {
    moveModelToPosition(modelId, 1);
  }

  async function saveOrder(reset = false) {
    if (!selectedPlan) return;
    setIsSaving(true);
    setMessage(null);
    setError(null);
    try {
      const models = reset ? defaultModels : orderedDraftModels;
      const orderChanged =
        models.map((model) => model.model).join("\n") !==
        catalog.models.map((model) => model.model).join("\n");
      const persistOrder = reset || orderChanged;
      const currentRouting = selectedPlan.settingsConfig?.codexRouting;
      const currentConfig = selectedPlan.settingsConfig?.config;
      const reasoning =
        declaredModelOrderReasoning(models[0]) ??
        (await queryClient.fetchQuery<ModelOrderReasoning>(
          modelOrderReasoningQueryOptions(
            models[0],
            selectedRoutes,
            providersById,
          ),
        ));
      const declaredEfforts = reasoning.efforts;
      const declaredDefault = reasoning.defaultEffort;
      const sameTopModel =
        models[0] &&
        topModel &&
        (models[0].model === topModel.model ||
          (Boolean(codexCatalogProviderName(topModel)) &&
            codexCatalogProviderName(models[0]).toLowerCase() ===
              codexCatalogProviderName(topModel).toLowerCase() &&
            modelBindingIdentityValues(models[0]).some((identity) =>
              modelBindingIdentityValues(topModel).includes(identity),
            )));
      const nextEffort =
        (!reset || sameTopModel) &&
        selectedDefaultReasoningEffort &&
        declaredEfforts.includes(selectedDefaultReasoningEffort)
          ? selectedDefaultReasoningEffort
          : declaredDefault && declaredEfforts.includes(declaredDefault)
            ? declaredDefault
            : declaredEfforts[0];
      const routingBase =
        currentRouting &&
        typeof currentRouting === "object" &&
        !Array.isArray(currentRouting)
          ? { ...currentRouting }
          : serializeCodexRoutingV2(readCodexRouting(selectedPlan) ?? {});
      if (persistOrder || effortDirty)
        delete routingBase.defaultReasoningEffort;
      await providersApi.update(
        reconcileCodexRoutingPlanForSave(
          {
            ...selectedPlan,
            settingsConfig: {
              ...withoutDerivedRouterCatalog(selectedPlan.settingsConfig),
              ...(persistOrder && models[0]?.model
                ? {
                    config: setCodexModelName(
                      removeCodexTopLevelField(
                        typeof currentConfig === "string" ? currentConfig : "",
                        "model_reasoning_effort",
                      ),
                      models[0].model,
                    ),
                  }
                : {}),
              codexRouting: {
                ...routingBase,
                ...(persistOrder
                  ? {
                      // Persist the calculated default too: the live compiler
                      // otherwise reuses the upstream catalog's unsorted order.
                      modelOrder: models.map((model) => model.model),
                    }
                  : {}),
                modelDisplayStyle: displayStyle,
                ...(nextEffort && (persistOrder || effortDirty)
                  ? { defaultReasoningEffort: nextEffort }
                  : {}),
              },
            },
          },
          providersById,
        ),
        "codex",
      );
      await queryClient.invalidateQueries({ queryKey: ["providers", "codex"] });
      if (reset) setSortMode("custom");
      setDraftModels(models);
      try {
        let projection = await providersApi.inspectCodexMultiRouterProjection(
          selectedPlan.id,
        );
        if (projection.state === "pending") {
          projection = await providersApi.retryCodexMultiRouterProjection(
            selectedPlan.id,
          );
        }
        queryClient.setQueryData(
          ["codexMultiRouterProjection", selectedPlan.id],
          projection,
        );
        if (projection.state === "pending") {
          setMessage(
            tr("codexRouterWorkspace.modelOrderPending", {
              defaultValue:
                "Order saved, but live projection is still pending. Retry projection from Status.",
            }),
          );
          return;
        }
        if (projection.state === "not_required") {
          setMessage(
            tr("codexRouterWorkspace.modelOrderInactive", {
              defaultValue:
                "Order saved for this router. It will be projected when this router is activated.",
            }),
          );
          return;
        }
      } catch (projectionError) {
        setError(
          tr("codexRouterWorkspace.modelOrderProjectionFailed", {
            defaultValue: "Order saved, but projection is pending: {{error}}",
            error: workspaceErrorMessage(projectionError),
          }),
        );
        return;
      }
      setMessage(
        reset
          ? tr("codexRouterWorkspace.modelOrderDefaultsRestored", {
              defaultValue:
                "Restored newest-first model order within each provider.",
            })
          : tr("codexRouterWorkspace.s128", {
              defaultValue:
                "Saved the display order for {{arg0}} models to this router.",
              arg0: models.length,
            }),
      );
    } catch (saveError) {
      setError(
        tr("codexRouterWorkspace.s129", {
          defaultValue: "Failed to save model order:{{arg0}}",
          arg0: workspaceErrorMessage(saveError),
        }),
      );
    } finally {
      setIsSaving(false);
    }
  }

  async function hideModel(visibleModel: string) {
    const trimmed = visibleModel.trim();
    if (!trimmed) return;
    const confirmed = window.confirm(
      tr("codexRouterWorkspace.hideModelConfirm", {
        defaultValue:
          "Remove {{model}} from the Codex model picker?\n\nThe model will not appear in the picker or match MultiRouter routes. Restore it from Hidden models on this page.",
        model: trimmed,
      }),
    );
    if (!confirmed) return;
    setIsSaving(true);
    setMessage(null);
    setError(null);
    try {
      let nextProvider: Provider | null = null;
      for (const { route } of selectedRoutes) {
        if (route.enabled === false) continue;
        const targetProviderId = routeTargetProviderId(route);
        if (!targetProviderId) continue;
        const aliases = route.aliases ?? route.upstream?.modelMap ?? {};
        const canonicalModel = aliases[trimmed] ?? trimmed;
        const source = providersById.get(targetProviderId);
        if (!source) continue;
        const sourceModels = readCodexModelCatalog(source).models;
        const sourceIndex = sourceModels.findIndex(
          (model) =>
            normalizedModelIdentity(model.model) ===
              normalizedModelIdentity(canonicalModel) ||
            normalizedModelIdentity(catalogDraftUpstreamModel(model)) ===
              normalizedModelIdentity(canonicalModel),
        );
        if (sourceIndex < 0) continue;
        if (
          route.modelSelection?.mode === "include" &&
          !modelSelectionMatchesCatalogModel(
            route.modelSelection.models,
            sourceModels[sourceIndex],
          )
        )
          continue;
        nextProvider = providerWithReconciledModelCatalog(
          source,
          sourceModels.map((model, index) =>
            index === sourceIndex ? { ...model, enabled: false } : model,
          ),
          providersById,
        );
        break;
      }
      if (!nextProvider) {
        setError(
          tr("codexRouterWorkspace.hideModelNotFound", {
            defaultValue: "No removable model entry found for {{model}}.",
            model: trimmed,
          }),
        );
        return;
      }
      await providersApi.update(nextProvider, "codex");
      setDraftModels((current) =>
        current.filter((model) => model.model?.trim() !== trimmed),
      );
      setMessage(
        tr("codexRouterWorkspace.hideModelSuccess", {
          defaultValue:
            "Hidden {{model}}; it can be restored from Hidden models.",
          model: trimmed,
        }),
      );
      await queryClient.invalidateQueries({ queryKey: ["providers", "codex"] });
    } catch (saveError) {
      setError(
        tr("codexRouterWorkspace.hideModelFailed", {
          defaultValue: "Failed to hide model:{{error}}",
          error: workspaceErrorMessage(saveError),
        }),
      );
    } finally {
      setIsSaving(false);
    }
  }

  async function restoreHiddenModel(target: {
    model: string;
    providerId: string;
  }) {
    const source = providersById.get(target.providerId);
    if (!source) return;
    setIsSaving(true);
    setMessage(null);
    setError(null);
    try {
      const models = readCodexModelCatalog(source).models.map((model) => {
        if (
          model.model?.trim() !== target.model &&
          model.upstreamModel?.trim() !== target.model &&
          model.upstream_model?.trim() !== target.model
        ) {
          return model;
        }
        const restored = { ...model };
        delete restored.enabled;
        return restored;
      });
      await providersApi.update(
        providerWithReconciledModelCatalog(source, models, providersById),
        "codex",
      );
      setMessage(
        tr("codexRouterWorkspace.restoreModelSuccess", {
          defaultValue:
            "Restored {{model}}; it will reappear in the Codex picker after projection refresh.",
          model: target.model,
        }),
      );
      await queryClient.invalidateQueries({ queryKey: ["providers", "codex"] });
    } catch (saveError) {
      setError(
        tr("codexRouterWorkspace.restoreModelFailed", {
          defaultValue: "Failed to restore model:{{error}}",
          error: workspaceErrorMessage(saveError),
        }),
      );
    } finally {
      setIsSaving(false);
    }
  }

  if (!selectedPlan) {
    return (
      <EmptyState
        icon={GripVertical}
        title={tr("codexRouterWorkspace.s130", {
          defaultValue: "No sortable MultiRouter yet",
        })}
        detail={tr("codexRouterWorkspace.s131", {
          defaultValue:
            "Create or select a multi-route plan, then adjust the full model order in the Codex picker.",
        })}
        actionLabel={tr("codexRouterWorkspace.s097", {
          defaultValue: "Create multi-route plan",
        })}
        onAction={onCreatePlan}
      />
    );
  }

  if (catalog.models.length === 0 && hiddenCatalogModels.length === 0) {
    return (
      <EmptyState
        icon={GripVertical}
        title={tr("codexRouterWorkspace.s132", {
          defaultValue: "The current plan has no model catalog",
        })}
        detail={tr("codexRouterWorkspace.s133", {
          defaultValue:
            "Attach model sources in “Route rules” and save; you can order models here after the catalog is generated.",
        })}
        actionLabel={tr("codexRouterWorkspace.s134", {
          defaultValue: "Go to Route rules",
        })}
      />
    );
  }

  return (
    <section className="rounded-lg border border-blue-200 bg-blue-50/50 p-4 dark:border-blue-700/40 dark:bg-blue-950/10">
      <SectionHeader
        icon={GripVertical}
        title={tr("codexRouterWorkspace.s135", {
          defaultValue: "Codex model ordering",
        })}
        detail={tr("codexRouterWorkspace.s136", {
          defaultValue:
            "Drag or rank models in the Codex picker. Saving an order makes the first model the default; routes and Sub-Agent selections stay unchanged.",
        })}
        action={
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={
                isSaving || isRecommending || orderedDraftModels.length < 2
              }
              onClick={() => void applyRecommendations()}
              className="gap-2"
            >
              {isRecommending ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : (
                <Wand2 className="h-4 w-4" />
              )}
              {isRecommending
                ? tr("codexRouterWorkspace.queryingRecommendationUsage", {
                    defaultValue: "Querying usage...",
                  })
                : tr("codexRouterWorkspace.applyRecommendations", {
                    defaultValue: "Apply recommendations",
                  })}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={isSaving || isRecommending || !canRestoreDefault}
              onClick={() => void saveOrder(true)}
            >
              {tr("codexRouterWorkspace.s137", {
                defaultValue: "Restore default",
              })}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={isSaving || isRecommending || !hasChanges}
              onClick={() => void saveOrder()}
              className="gap-2 bg-blue-600 hover:bg-blue-500"
            >
              <Save className="h-4 w-4" />
              {tr("codexRouterWorkspace.s138", { defaultValue: "Save order" })}
            </Button>
          </div>
        }
      />

      <div className="mt-4 flex flex-wrap items-start gap-3 rounded-md border border-blue-200/70 bg-background/60 p-3 dark:border-blue-800/50 dark:bg-slate-950/30">
        <label className="grid min-w-0 max-w-full gap-1 text-xs font-medium text-muted-foreground">
          <span>
            {tr("codexRouterWorkspace.modelDisplayStyle", {
              defaultValue: "Model display",
            })}
          </span>
          <select
            value={displayStyle}
            disabled={isSaving || isRecommending}
            onChange={(event) =>
              setDisplayStyle(event.target.value as CodexModelDisplayStyle)
            }
            className="h-8 min-w-0 rounded border border-input bg-background px-2 text-sm text-foreground"
          >
            <option value="model">
              {tr("codexRouterWorkspace.modelOnly", {
                defaultValue: "Model only",
              })}
            </option>
            <option value="model-provider">
              {tr("codexRouterWorkspace.modelThenProvider", {
                defaultValue: "Model · Provider",
              })}
            </option>
            <option value="provider-model">
              {tr("codexRouterWorkspace.providerThenModel", {
                defaultValue: "Provider · Model",
              })}
            </option>
          </select>
        </label>
        <label className="grid min-w-0 max-w-full gap-1 text-xs font-medium text-muted-foreground">
          <span>
            {tr("codexRouterWorkspace.modelSort", {
              defaultValue: "Sort models",
            })}
          </span>
          <select
            value={sortMode}
            disabled={isSaving || isRecommending}
            onChange={(event) =>
              setSortMode(event.target.value as CodexModelSortMode)
            }
            className="h-8 min-w-0 rounded border border-input bg-background px-2 text-sm text-foreground"
          >
            <option value="custom">
              {tr("codexRouterWorkspace.currentOrder", {
                defaultValue: "Current order (drag)",
              })}
            </option>
            <option value="model">
              {tr("codexRouterWorkspace.sortByModel", {
                defaultValue: "Model name",
              })}
            </option>
            <option value="provider">
              {tr("codexRouterWorkspace.sortByProvider", {
                defaultValue: "Provider",
              })}
            </option>
            <option value="provider-model">
              {tr("codexRouterWorkspace.sortByProviderModel", {
                defaultValue: "Provider, then model",
              })}
            </option>
          </select>
        </label>
        <label className="grid w-64 min-w-0 max-w-full gap-1 text-xs font-medium text-muted-foreground">
          <span>
            {tr("codexRouterWorkspace.topModelDefaultEffort", {
              defaultValue: "Top model default effort",
            })}
          </span>
          <select
            value={selectedDefaultReasoningEffort ?? ""}
            disabled={
              isSaving || isRecommending || topReasoningEfforts.length === 0
            }
            onChange={(event) =>
              setDefaultReasoningEffort(
                event.target.value as CodexReasoningEffort,
              )
            }
            aria-label={tr("codexRouterWorkspace.topModelDefaultEffort", {
              defaultValue: "Top model default effort",
            })}
            className="h-8 min-w-0 rounded border border-input bg-background px-2 text-sm text-foreground"
          >
            {topReasoningEfforts.length > 0 ? (
              topReasoningEfforts.map((effort) => (
                <option key={effort} value={effort}>
                  {effort === "xhigh"
                    ? tr("codexRouterWorkspace.extraHighEffort", {
                        defaultValue: "Extra high (xhigh)",
                      })
                    : effort}
                </option>
              ))
            ) : (
              <option value="" disabled>
                {!declaredTopReasoning && topReasoningQuery.isFetching
                  ? tr("common.loading", { defaultValue: "Loading..." })
                  : tr("codexRouterWorkspace.reasoningUnknown", {
                      defaultValue:
                        "Unknown until provider metadata is available",
                    })}
              </option>
            )}
          </select>
          <span className="break-words font-normal text-muted-foreground">
            {tr("codexRouterWorkspace.topModelDefaultEffortHint", {
              defaultValue: "Used by new threads when {{model}} is first.",
              model: topModel?.model ?? "—",
            })}
          </span>
        </label>
      </div>

      {fallbackProtocolCount > 0 ? (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-100">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {tr("codexRouterWorkspace.protocolFallbackWarning", {
              defaultValue:
                "{{count}} models still inherit the provider fallback protocol. Re-run protocol detection on their model source before relying on automatic per-model routing.",
              count: fallbackProtocolCount,
            })}
          </span>
        </div>
      ) : null}

      <div className="relative mt-4">
        <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          value={modelSearch}
          onChange={(event) => setModelSearch(event.target.value)}
          placeholder={tr("codexRouterWorkspace.searchModels", {
            defaultValue: "Search models or providers",
          })}
          aria-label={tr("codexRouterWorkspace.searchModels", {
            defaultValue: "Search models or providers",
          })}
          className="pl-9"
        />
        {modelSearch ? (
          <span className="mt-1 block text-xs text-muted-foreground">
            {tr("codexRouterWorkspace.searchResults", {
              defaultValue: "{{count}} results. Rank numbers remain global.",
              count: visibleDraftModels.length,
            })}
          </span>
        ) : null}
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={sortableModels
            .map((model) => model.model?.trim())
            .filter((model): model is string => Boolean(model))}
          strategy={rectSortingStrategy}
        >
          <div className="mt-4 grid min-w-0 gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.4fr)]">
            <section
              aria-label={tr("codexRouterWorkspace.topModels", {
                defaultValue: "Ranked models",
              })}
              className="min-w-0 border-y border-amber-300/70 bg-amber-50/40 p-3 dark:border-amber-700/50 dark:bg-amber-950/10"
            >
              <div className="mb-3 flex items-center justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    <Star
                      className="h-4 w-4 text-amber-500"
                      fill="currentColor"
                    />
                    {tr("codexRouterWorkspace.rankedModels", {
                      defaultValue: "Ranked models",
                    })}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {tr("codexRouterWorkspace.rankedModelsHint", {
                      defaultValue:
                        "The first eight models shown in the Codex picker.",
                    })}
                  </p>
                </div>
                <Badge variant="outline" className="shrink-0 tabular-nums">
                  {topModels.length}/{RANKED_MODEL_LIMIT}
                </Badge>
              </div>
              <div className="space-y-2">
                {topModels.map((model, index) => (
                  <SortableCatalogModel
                    key={model.model}
                    model={model}
                    index={index}
                    displayStyle={displayStyle}
                    onDelete={(modelId) => void hideModel(modelId)}
                    onMoveToTop={moveModelToTop}
                    onMoveToPosition={moveModelToPosition}
                    dragDisabled={isSaving || isRecommending}
                    modelCount={orderedDraftModels.length}
                    isTop={index === 0}
                    recommended={recommendedModelIds.has(model.model?.trim())}
                  />
                ))}
              </div>
            </section>

            <section
              aria-label={tr("codexRouterWorkspace.availableModels", {
                defaultValue: "Available models",
              })}
              className="min-w-0 border-y border-blue-200/70 bg-background/60 p-3 dark:border-blue-800/50 dark:bg-slate-950/30"
            >
              <div className="mb-3">
                <div className="text-sm font-semibold">
                  {tr("codexRouterWorkspace.availableModels", {
                    defaultValue: "Available models",
                  })}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {tr("codexRouterWorkspace.availableModelsHint", {
                    defaultValue:
                      "Drag a model into the ranked column or place it at an exact rank.",
                  })}
                </p>
              </div>
              <div className="max-h-[480px] space-y-2 overflow-auto pr-1">
                {remainingModels.map((model) => {
                  const index = globalRankByModel.get(model.model?.trim()) ?? 0;
                  return (
                    <SortableCatalogModel
                      key={model.model}
                      model={model}
                      index={index}
                      displayStyle={displayStyle}
                      onDelete={(modelId) => void hideModel(modelId)}
                      onMoveToTop={moveModelToTop}
                      onMoveToPosition={moveModelToPosition}
                      dragDisabled={isSaving || isRecommending}
                      modelCount={orderedDraftModels.length}
                      isTop={false}
                      recommended={recommendedModelIds.has(model.model?.trim())}
                    />
                  );
                })}
              </div>
            </section>
          </div>
        </SortableContext>
      </DndContext>
      {hiddenCatalogModels.length > 0 ? (
        <details
          open={draftModels.length === 0}
          className="mt-4 rounded-lg border border-slate-200 bg-slate-50/60 p-3 dark:border-slate-700/60 dark:bg-slate-950/30"
        >
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground dark:text-slate-300">
            {tr("codexRouterWorkspace.hiddenModels", {
              defaultValue:
                "Hidden models ({{count}}) — removed from the picker and routes",
              count: hiddenCatalogModels.length,
            })}
          </summary>
          <ul className="mt-2 space-y-1.5">
            {hiddenCatalogModels.map((hidden) => (
              <li
                key={`${hidden.providerId}:${hidden.model}`}
                className="flex items-center justify-between gap-3 rounded border border-border/60 bg-background/70 px-2.5 py-1.5 text-xs dark:border-slate-700/50 dark:bg-slate-900/40"
              >
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium text-foreground dark:text-slate-100">
                    {hidden.model}
                  </span>
                  {hidden.upstream ? (
                    <span className="ml-2 font-mono text-muted-foreground dark:text-slate-400">
                      {hidden.upstream}
                    </span>
                  ) : null}
                  <span className="ml-2 text-muted-foreground dark:text-slate-400">
                    {tr("codexRouterWorkspace.hiddenModelSource", {
                      defaultValue: "Source:{{name}}",
                      name: hidden.providerName,
                    })}
                  </span>
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={isSaving || isRecommending}
                  onClick={() => void restoreHiddenModel(hidden)}
                  className="shrink-0"
                >
                  {tr("codexRouterWorkspace.restoreModel", {
                    defaultValue: "Restore",
                  })}
                </Button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {message ? (
        <p className="mt-3 text-xs text-emerald-700 dark:text-emerald-200">
          {message}
        </p>
      ) : null}
      {error ? (
        <p className="mt-3 text-xs text-rose-700 dark:text-rose-200">{error}</p>
      ) : null}
    </section>
  );
}

/// 路由规则页提供方案选择、规则列表和右侧详情，形成真实的“查/改/删入口”工作流。
function RoutesTab({
  routingPlans,
  routeEntries,
  selectedPlan,
  selectedRoute,
  modelSources,
  providersById,
  onCreatePlan,
  onCreateProvider,
  onOpenRoutePicker,
  onSaveRoutes,
  onSelectPlan,
  onSelectRoute,
  onEditProvider,
  onEditPlan,
  onDeletePlan,
  proxyStatus,
  isProxyRunning,
  isCodexTakeoverActive,
  activeProviderId,
  providerModelRefreshStates,
  isRoutePickerOpen,
  isSavingRoutes,
  isPlanSettingsOpen,
  isSavingPlanSettings,
  onPlanSettingsOpenChange,
  onSavePlanSettings,
  routePickerSelectAll,
  routePickerMessage,
  routePickerError,
  onRoutePickerOpenChange,
}: {
  routingPlans: Provider[];
  routeEntries: RouteEntry[];
  selectedPlan: Provider | null;
  selectedRoute?: RouteEntry;
  modelSources: Provider[];
  providersById: Map<string, Provider>;
  onCreatePlan: () => void;
  onCreateProvider: () => void;
  onOpenRoutePicker: (provider?: Provider | null) => void;
  onSaveRoutes: (plan: Provider, routes: CodexRoute[]) => Promise<void>;
  onSelectPlan: (provider: Provider) => void;
  onSelectRoute: (entry: RouteEntry) => void;
  onEditProvider: (provider: Provider) => void;
  onEditPlan: (provider: Provider, detail?: string) => void;
  onDeletePlan: (provider: Provider) => void;
  proxyStatus?: ProxyStatus;
  isProxyRunning: boolean;
  isCodexTakeoverActive: boolean;
  activeProviderId?: string;
  providerModelRefreshStates: Record<string, ProviderModelRefreshState>;
  isRoutePickerOpen: boolean;
  isSavingRoutes: boolean;
  isPlanSettingsOpen: boolean;
  isSavingPlanSettings: boolean;
  onPlanSettingsOpenChange: (open: boolean) => void;
  onSavePlanSettings: (
    plan: Provider,
    draft: MultiRouterSettingsDraft,
  ) => Promise<void>;
  routePickerSelectAll: boolean;
  routePickerMessage: string | null;
  routePickerError: string | null;
  onRoutePickerOpenChange: (open: boolean) => void;
}) {
  const actionPanelRef = useRef<HTMLDivElement | null>(null);
  const selectedPlanRoutes = selectedPlan
    ? routeEntries.filter(({ provider }) => provider.id === selectedPlan.id)
    : routeEntries;
  const enabledPlanRouteCount = selectedPlanRoutes.filter(
    ({ route }) => route.enabled !== false,
  ).length;
  const selectedRouting = selectedPlan ? readCodexRouting(selectedPlan) : null;
  const effectiveActiveProviderId =
    activeProviderId ?? proxyStatus?.current_provider_id ?? undefined;
  const { data: globalProxyConfig } = useQuery({
    queryKey: ["globalProxyConfig"],
    queryFn: () => proxyApi.getGlobalProxyConfig(),
  });
  const configuredListenAddress = globalProxyConfig
    ? `${globalProxyConfig.listenAddress}:${globalProxyConfig.listenPort}`
    : `${DEFAULT_CODEX_PROXY_LISTEN_ADDRESS}:${DEFAULT_CODEX_PROXY_LISTEN_PORT}`;
  const runtimeStatus = buildMultiRouterRuntimeStatus({
    selectedPlan,
    selectedRouting,
    enabledRouteCount: enabledPlanRouteCount,
    isProxyRunning,
    isCodexTakeoverActive,
    activeProviderId: effectiveActiveProviderId,
  });

  // 候选 router 选择器和设置面板都是行内展开；打开后主动定位到面板，避免用户停在上方规则区误以为没有响应。
  useEffect(() => {
    if (!isRoutePickerOpen && !isPlanSettingsOpen) return;
    window.setTimeout(() => {
      const scrollIntoView = actionPanelRef.current?.scrollIntoView;
      if (typeof scrollIntoView !== "function") return;
      scrollIntoView.call(actionPanelRef.current, {
        behavior: "smooth",
        block: "nearest",
      });
    }, 0);
  }, [isPlanSettingsOpen, isRoutePickerOpen, selectedPlan?.id]);

  return (
    <div className="space-y-3">
      <MultiRouterCurrentStatus
        selectedPlan={selectedPlan}
        totalRouteCount={selectedPlanRoutes.length}
        enabledRouteCount={enabledPlanRouteCount}
        runtimeStatus={runtimeStatus}
        proxyStatus={proxyStatus}
        configuredListenAddress={configuredListenAddress}
        isProxyRunning={isProxyRunning}
        isCodexTakeoverActive={isCodexTakeoverActive}
        activeProviderId={effectiveActiveProviderId}
      />
      <div className="grid gap-3 xl:grid-cols-[300px_minmax(0,1fr)]">
        <section className="rounded-lg border border-blue-200 bg-blue-50/70 p-3 dark:border-blue-700/40 dark:bg-blue-950/15">
          <SectionHeader
            icon={Layers3}
            title="Select MultiRouter"
            detail="Each MultiRouter can contain multiple routing rules."
            action={
              <Button
                size="sm"
                onClick={onCreatePlan}
                className="gap-2 bg-blue-600 hover:bg-blue-500"
              >
                <Plus className="h-4 w-4" />
                Create multi-route plan
              </Button>
            }
          />
          <div className="mt-2 grid gap-2">
            {routingPlans.map((provider) => {
              const active = selectedPlan?.id === provider.id;
              return (
                <div
                  key={provider.id}
                  className={cn(
                    "rounded-lg border p-2.5 text-left transition",
                    active
                      ? "border-blue-400 bg-blue-50 text-blue-900 shadow-[0_0_0_1px_rgba(96,165,250,0.25)] dark:bg-blue-600/20 dark:text-blue-100 dark:shadow-[0_0_0_1px_rgba(96,165,250,0.35)]"
                      : "border-border bg-card text-foreground hover:border-blue-400 hover:bg-blue-50 dark:border-slate-700 dark:bg-slate-950/40 dark:hover:border-blue-500 dark:hover:bg-blue-950/20",
                  )}
                >
                  <PlanCardContent
                    provider={provider}
                    providersById={providersById}
                    compact
                  />
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant={active ? "default" : "outline"}
                      onClick={() => onSelectPlan(provider)}
                      className={cn(
                        "h-8 gap-1.5 px-2.5",
                        active ? "bg-blue-600 hover:bg-blue-500" : "",
                      )}
                    >
                      <CheckCircle2 className="h-4 w-4" />
                      {active ? "Selected" : "Select"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => onEditPlan(provider, "Rename MultiRouter")}
                      className="h-8 gap-1.5 px-2.5"
                    >
                      <Pencil className="h-4 w-4" />
                      Rename
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => onDeletePlan(provider)}
                      className="h-8 gap-1.5 border-rose-300 bg-background/70 px-2.5 text-rose-700 hover:bg-rose-50 dark:border-rose-500/50 dark:bg-rose-500/10 dark:text-rose-100 dark:hover:bg-rose-500/20"
                    >
                      <Trash2 className="h-4 w-4" />
                      Delete
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 p-3 dark:border-emerald-700/40 dark:bg-emerald-950/10">
            <SectionHeader
              icon={Route}
              title="Rule list"
              detail="Click a rule for details. “Enabled” means it participates in matching; it does not start a service."
              action={
                selectedPlan ? (
                  <Button
                    size="sm"
                    onClick={() => onOpenRoutePicker(selectedPlan)}
                    className="gap-2 bg-emerald-600 hover:bg-emerald-500"
                  >
                    <Pencil className="h-4 w-4" />
                    Edit matching rules
                  </Button>
                ) : null
              }
            />
            <div className="mt-2 grid gap-2">
              {selectedPlanRoutes.map((entry) => (
                <RouteListButton
                  key={`${entry.provider.id}-${entry.route.id ?? entry.index}`}
                  entry={entry}
                  providersById={providersById}
                  active={
                    selectedRoute?.provider.id === entry.provider.id &&
                    selectedRoute.index === entry.index
                  }
                  onClick={() => onSelectRoute(entry)}
                />
              ))}
              {selectedPlanRoutes.length === 0 && (
                <EmptyState
                  icon={Route}
                  title="This plan has no rules yet"
                  detail="Click edit rules and select candidate routers to attach."
                  actionLabel="Edit MultiRouter"
                  onAction={() =>
                    selectedPlan
                      ? onOpenRoutePicker(selectedPlan)
                      : onCreatePlan()
                  }
                />
              )}
            </div>
          </div>

          <RouteDetailPanel
            selectedRoute={selectedRoute}
            selectedPlan={selectedPlan}
            providersById={providersById}
            onOpenRoutePicker={onOpenRoutePicker}
            onEditProvider={onEditProvider}
            onFollowAllModels={async () => {
              if (!selectedPlan || !selectedRoute) return;
              const routes = readCodexRouting(selectedPlan)?.routes ?? [];
              await onSaveRoutes(
                selectedPlan,
                routes.map((route, index) =>
                  index === selectedRoute.index
                    ? { ...route, modelSelection: { mode: "all" } }
                    : route,
                ),
              );
            }}
          />
        </section>
      </div>

      <div ref={actionPanelRef}>
        {selectedPlan && isRoutePickerOpen ? (
          <RouteCandidatePicker
            selectedPlan={selectedPlan}
            modelSources={modelSources}
            providerModelRefreshStates={providerModelRefreshStates}
            onSaveRoutes={onSaveRoutes}
            onCreateProvider={onCreateProvider}
            onClose={() => onRoutePickerOpenChange(false)}
            isSaving={isSavingRoutes}
            selectAllByDefault={routePickerSelectAll}
          />
        ) : null}

        {selectedPlan && isPlanSettingsOpen ? (
          <MultiRouterSettingsPanel
            selectedPlan={selectedPlan}
            selectedRoutes={selectedPlanRoutes}
            providersById={providersById}
            onSave={onSavePlanSettings}
            onClose={() => onPlanSettingsOpenChange(false)}
            isSaving={isSavingPlanSettings}
          />
        ) : null}
      </div>

      {(routePickerMessage || routePickerError) && (
        <div
          className={cn(
            "rounded-lg border p-3 text-sm",
            routePickerError
              ? "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-100"
              : "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-100",
          )}
        >
          {routePickerError ?? routePickerMessage}
        </div>
      )}

      <ProviderModelRefreshPanel
        modelSources={modelSources}
        states={providerModelRefreshStates}
      />
    </div>
  );
}

/// 路由页顶部的当前 MultiRouter 状态带，明确区分“页面选中”和“已经作为 Codex provider 运行”。
function MultiRouterCurrentStatus({
  selectedPlan,
  totalRouteCount,
  enabledRouteCount,
  runtimeStatus,
  proxyStatus,
  configuredListenAddress,
  isProxyRunning,
  isCodexTakeoverActive,
  activeProviderId,
}: {
  selectedPlan: Provider | null;
  totalRouteCount: number;
  enabledRouteCount: number;
  runtimeStatus: MultiRouterRuntimeStatus;
  proxyStatus?: ProxyStatus;
  configuredListenAddress: string;
  isProxyRunning: boolean;
  isCodexTakeoverActive: boolean;
  activeProviderId?: string;
}) {
  const listenAddress = proxyStatus
    ? `${proxyStatus.address}:${proxyStatus.port}`
    : "Not listening";
  const runtimeClass =
    runtimeStatus.tone === "ok"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/50 dark:bg-emerald-500/15 dark:text-emerald-100"
      : "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/50 dark:bg-amber-500/15 dark:text-amber-100";
  return (
    <section className="rounded-lg border border-blue-200 bg-blue-50/70 p-3 dark:border-blue-700/40 dark:bg-slate-950/55">
      <div className="grid gap-2 xl:grid-cols-[minmax(220px,0.75fr)_minmax(0,1.6fr)]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <RadioTower className="h-4 w-4 text-blue-600 dark:text-blue-300" />
            <span className="text-sm font-semibold text-foreground dark:text-slate-100">
              Current MultiRouter
            </span>
            <Badge className={cn("border", runtimeClass)}>
              {runtimeStatus.label}
            </Badge>
          </div>
          <div className="mt-1 truncate text-base font-semibold text-foreground dark:text-slate-50">
            {selectedPlan?.name ?? "No MultiRouter selected"}
          </div>
          <div
            className="mt-0.5 truncate text-xs text-muted-foreground dark:text-slate-400"
            title={runtimeStatus.detail}
          >
            {runtimeStatus.detail}
          </div>
        </div>
        <div className="grid min-w-0 gap-1.5 text-xs sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
          <StatusInlineItem
            label="Selected plan"
            value={selectedPlan?.id ?? "None"}
            ok={Boolean(selectedPlan)}
          />
          <StatusInlineItem
            label="Current provider"
            value={activeProviderId ?? "Not set"}
            ok={Boolean(selectedPlan && activeProviderId === selectedPlan.id)}
          />
          <StatusInlineItem
            label="Listener configuration"
            value={configuredListenAddress}
            ok={Boolean(configuredListenAddress)}
          />
          <StatusInlineItem
            label="Running listener"
            value={isProxyRunning ? listenAddress : "Not running"}
            ok={isProxyRunning}
          />
          <StatusInlineItem
            label="Codex takeover"
            value={isCodexTakeoverActive ? "Taken over" : "Not taken over"}
            ok={isCodexTakeoverActive}
          />
          <StatusInlineItem
            label="Enabled rules"
            value={`${enabledRouteCount} / ${totalRouteCount}  rules`}
            ok={enabledRouteCount > 0}
          />
          <StatusInlineItem
            label="Entry status"
            value={selectedPlan ? runtimeStatus.label : "Not selected"}
            ok={runtimeStatus.running}
          />
        </div>
      </div>
    </section>
  );
}

/// 状态带内的短字段，避免把关键运行信号藏进长说明文本。
function StatusInlineItem({
  label,
  value,
  ok,
}: {
  label: string;
  value: string;
  ok: boolean;
}) {
  return (
    <div className="min-w-0 rounded-md border border-border bg-background/80 px-2 py-1.5 dark:border-slate-800 dark:bg-slate-950/60">
      <div className="text-[11px] text-muted-foreground dark:text-slate-500">
        {label}
      </div>
      <div
        className={cn(
          "mt-0.5 truncate font-mono text-[11px]",
          ok
            ? "text-emerald-700 dark:text-emerald-200"
            : "text-amber-700 dark:text-amber-200",
        )}
        title={value}
      >
        {value}
      </div>
    </div>
  );
}

/// MultiRouter 专用设置面板：只暴露方案级元信息和入口状态，避免用户误填普通供应商 API 字段。
function MultiRouterSettingsPanel({
  selectedPlan,
  selectedRoutes,
  providersById,
  onSave,
  onClose,
  isSaving,
}: {
  selectedPlan: Provider;
  selectedRoutes: RouteEntry[];
  providersById: Map<string, Provider>;
  onSave: (plan: Provider, draft: MultiRouterSettingsDraft) => Promise<void>;
  onClose: () => void;
  isSaving: boolean;
}) {
  const queryClient = useQueryClient();
  const selectedRouting = readCodexRouting(selectedPlan) ?? {};
  const hasLegacyOfficialAuth =
    Boolean(selectedRouting.officialAuth) ||
    (selectedRouting.routes ?? []).some(codexRouteUsesOfficialAuthentication);
  const [name, setName] = useState(selectedPlan.name);
  const [notes, setNotes] = useState(selectedPlan.notes ?? "");
  const [enabled, setEnabled] = useState(selectedRouting.enabled !== false);
  const initialHostedTools = readHostedToolsConfig(selectedPlan);
  const [webSearchEnabled, setWebSearchEnabled] = useState(
    initialHostedTools.webSearch.enabled,
  );
  const [imageGenerationEnabled, setImageGenerationEnabled] = useState(
    initialHostedTools.imageGeneration.enabled,
  );
  const { data: globalProxyConfig, error: globalProxyConfigError } = useQuery<
    GlobalProxyConfig,
    Error
  >({
    queryKey: ["globalProxyConfig"],
    queryFn: () => proxyApi.getGlobalProxyConfig(),
  });
  const [listenAddress, setListenAddress] = useState(
    DEFAULT_CODEX_PROXY_LISTEN_ADDRESS,
  );
  const [listenPort, setListenPort] = useState(
    String(DEFAULT_CODEX_PROXY_LISTEN_PORT),
  );
  const [listenerError, setListenerError] = useState<string | null>(null);
  const [isSavingListener, setIsSavingListener] = useState(false);

  useEffect(() => {
    const routing = readCodexRouting(selectedPlan) ?? {};
    setName(selectedPlan.name);
    setNotes(selectedPlan.notes ?? "");
    setEnabled(routing.enabled !== false);
    const hostedTools = readHostedToolsConfig(selectedPlan);
    setWebSearchEnabled(hostedTools.webSearch.enabled);
    setImageGenerationEnabled(hostedTools.imageGeneration.enabled);
  }, [selectedPlan]);

  useEffect(() => {
    if (!globalProxyConfig) return;
    setListenAddress(
      globalProxyConfig.listenAddress || DEFAULT_CODEX_PROXY_LISTEN_ADDRESS,
    );
    setListenPort(
      String(globalProxyConfig.listenPort || DEFAULT_CODEX_PROXY_LISTEN_PORT),
    );
    setListenerError(null);
  }, [globalProxyConfig]);

  useEffect(() => {
    if (!globalProxyConfigError) return;
    setListenerError(workspaceErrorMessage(globalProxyConfigError));
  }, [globalProxyConfigError]);

  /// 保存前同时写回方案草稿和全局监听配置；API Key 仍不在 MultiRouter 页面直接编辑。
  async function handleSave() {
    const listener = validateProxyListenDraft(listenAddress, listenPort);
    if (!listener.ok) {
      setListenerError(listener.error);
      return;
    }

    setIsSavingListener(true);
    setListenerError(null);
    try {
      const currentConfig =
        globalProxyConfig ?? (await proxyApi.getGlobalProxyConfig());
      if (
        currentConfig.listenAddress !== listener.listenAddress ||
        currentConfig.listenPort !== listener.listenPort
      ) {
        const nextConfig = {
          ...currentConfig,
          listenAddress: listener.listenAddress,
          listenPort: listener.listenPort,
        };
        await proxyApi.updateGlobalProxyConfig(nextConfig);
        queryClient.setQueryData(["globalProxyConfig"], nextConfig);
        queryClient.invalidateQueries({ queryKey: ["globalProxyConfig"] });
        queryClient.invalidateQueries({ queryKey: ["proxyConfig"] });
        queryClient.invalidateQueries({ queryKey: ["proxyStatus"] });
      }
    } catch (error) {
      setListenerError(workspaceErrorMessage(error));
      setIsSavingListener(false);
      return;
    }

    await onSave(selectedPlan, {
      name,
      notes,
      enabled,
      hostedTools: {
        webSearch: webSearchEnabled,
        imageGeneration: imageGenerationEnabled,
      },
    });
    setIsSavingListener(false);
  }

  const legacyDefaultRoute = selectedRouting.defaultRouteId
    ? selectedRoutes.find(
        ({ route }) => route.id === selectedRouting.defaultRouteId,
      )
    : undefined;
  const legacyDefaultRouteName = legacyDefaultRoute
    ? routeDisplayName(legacyDefaultRoute.route, providersById)
    : undefined;
  const listenerPreview = validateProxyListenDraft(listenAddress, listenPort);
  const previewBaseUrl = listenerPreview.ok
    ? listenerPreview.baseUrl
    : buildCodexProxyBaseUrl(
        DEFAULT_CODEX_PROXY_LISTEN_ADDRESS,
        DEFAULT_CODEX_PROXY_LISTEN_PORT,
      );
  const autoManagedRows = [
    {
      label: "Codex provider id",
      value: "codex_model_router_v2",
      detail:
        "One stable bucket; multiple MultiRouters do not need separate entries",
    },
    {
      label: "base_url",
      value: previewBaseUrl,
      detail:
        "CC Switch projects this into Codex live config when switching or taking over",
    },
    {
      label: "wire_api",
      value: "responses",
      detail:
        "Codex connects to the local proxy over HTTP Responses; each route determines the actual upstream protocol",
    },
    {
      label: "supports_websockets",
      value: "false",
      detail:
        "Disable WebSocket and fall back to HTTP so each request can select a route by model",
    },
    {
      label: "model_catalog_json",
      value: "cc-switch-model-catalog.json",
      detail:
        "Generated automatically from the current plan routes/modelCatalog",
    },
  ];

  return (
    <section className="rounded-lg border border-blue-200 bg-card p-4 shadow-[0_0_0_1px_rgba(59,130,246,0.10)] dark:border-blue-700/50 dark:bg-slate-950/70 dark:shadow-[0_0_0_1px_rgba(59,130,246,0.15)]">
      <SectionHeader
        icon={Settings2}
        title="MultiRouter settings"
        detail="Configure the MultiRouter name and local proxy listener here; upstream API keys remain owned by each route target source."
        action={
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={onClose}
              disabled={isSaving || isSavingListener}
            >
              Disabled
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={isSaving || isSavingListener}
              className="gap-2 bg-blue-600 hover:bg-blue-500"
            >
              <Save className="h-4 w-4" />
              {isSaving || isSavingListener ? "Saving" : "Save settings"}
            </Button>
          </div>
        }
      />

      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_1fr]">
        <div className="space-y-3">
          <div className="grid gap-2">
            <label className="text-xs font-semibold text-muted-foreground dark:text-slate-300">
              Plan name
            </label>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="h-10 rounded-md border border-blue-200 bg-background px-3 text-sm outline-none transition placeholder:text-muted-foreground focus:border-blue-400 focus:ring-2 focus:ring-blue-500/20 dark:border-blue-700/50 dark:bg-slate-950/80 dark:placeholder:text-slate-500 dark:focus:ring-blue-500/30"
              placeholder="For example: Codex MultiRouter"
              disabled={isSaving || isSavingListener}
            />
          </div>
          <div className="grid gap-2">
            <label className="text-xs font-semibold text-muted-foreground dark:text-slate-300">
              Notes
            </label>
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              rows={3}
              className="min-h-[84px] resize-y rounded-md border border-blue-200 bg-background px-3 py-2 text-sm outline-none transition placeholder:text-muted-foreground focus:border-blue-400 focus:ring-2 focus:ring-blue-500/20 dark:border-blue-700/50 dark:bg-slate-950/80 dark:placeholder:text-slate-500 dark:focus:ring-blue-500/30"
              placeholder="For example: Default Codex multi-model route"
              disabled={isSaving || isSavingListener}
            />
          </div>
          <label className="flex items-start justify-between gap-3 rounded-lg border border-border bg-muted/40 p-3 dark:border-slate-700 dark:bg-slate-950/50">
            <span>
              <span className="block text-sm font-semibold text-foreground dark:text-slate-100">
                MultiRouter entry
              </span>
              <span className="mt-1 block text-xs leading-5 text-muted-foreground dark:text-slate-400">
                When disabled, this plan will not route Codex models, but its
                routes are preserved.
              </span>
            </span>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
              className="mt-1 h-5 w-5 accent-blue-500"
              disabled={isSaving || isSavingListener}
            />
          </label>
          <HostedToolsSwitchPanel
            webSearchEnabled={webSearchEnabled}
            imageGenerationEnabled={imageGenerationEnabled}
            onChange={(next) => {
              setWebSearchEnabled(next.webSearchEnabled);
              setImageGenerationEnabled(next.imageGenerationEnabled);
            }}
            disabled={isSaving || isSavingListener}
          />
          {selectedRouting.defaultRouteId && (
            <div className="grid gap-1 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-600/50 dark:bg-amber-950/20 dark:text-amber-100">
              <span className="font-semibold">
                Legacy default route disabled
              </span>
              <span className="leading-5">
                The legacy config points to “
                {legacyDefaultRouteName ?? "deleted route"}”. Strict routing
                will not use it; saving settings clears this compatibility
                field.
              </span>
            </div>
          )}
          <div className="grid gap-2 rounded-lg border border-blue-200 bg-blue-50/70 p-3 text-xs leading-5 text-muted-foreground dark:border-blue-700/40 dark:bg-blue-950/10 dark:text-slate-300">
            <span className="font-semibold text-foreground dark:text-slate-100">
              Official authentication is managed by OpenAI Official
            </span>
            <span>
              MultiRouter only routes models; the official route inherits
              authentication from OpenAI Official card settings; disabling
              MultiRouter does not change that authentication.
            </span>
            {hasLegacyOfficialAuth ? (
              <span className="rounded-md border border-amber-300 bg-amber-50 p-2 text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-100">
                This legacy router still contains official authentication
                fields. They are retained only as migration input; saving this
                page will not rewrite them. If multiple routers conflict, choose
                a value from OpenAI Official “Authentication settings”.
              </span>
            ) : null}
          </div>
          <div className="grid gap-3 rounded-lg border border-blue-200 bg-blue-50/70 p-3 dark:border-blue-700/40 dark:bg-blue-950/10 sm:grid-cols-[1fr_120px]">
            <div className="grid gap-2">
              <label className="text-xs font-semibold text-muted-foreground dark:text-slate-300">
                Listener address
              </label>
              <input
                value={listenAddress}
                onChange={(event) => setListenAddress(event.target.value)}
                className="h-10 rounded-md border border-blue-200 bg-background px-3 font-mono text-sm outline-none transition placeholder:text-muted-foreground focus:border-blue-400 focus:ring-2 focus:ring-blue-500/20 dark:border-blue-700/50 dark:bg-slate-950/80 dark:placeholder:text-slate-500 dark:focus:ring-blue-500/30"
                placeholder="127.0.0.1"
                disabled={isSaving || isSavingListener}
              />
            </div>
            <div className="grid gap-2">
              <label className="text-xs font-semibold text-muted-foreground dark:text-slate-300">
                Listener port
              </label>
              <input
                value={listenPort}
                onChange={(event) => setListenPort(event.target.value)}
                className="h-10 rounded-md border border-blue-200 bg-background px-3 font-mono text-sm outline-none transition placeholder:text-muted-foreground focus:border-blue-400 focus:ring-2 focus:ring-blue-500/20 dark:border-blue-700/50 dark:bg-slate-950/80 dark:placeholder:text-slate-500 dark:focus:ring-blue-500/30"
                placeholder="15721"
                inputMode="numeric"
                disabled={isSaving || isSavingListener}
              />
            </div>
            <div className="sm:col-span-2">
              <p className="break-all text-xs leading-5 text-muted-foreground dark:text-slate-500">
                Codex Desktop use: {previewBaseUrl}
              </p>
              {listenerError ? (
                <p className="mt-1 text-xs leading-5 text-rose-700 dark:text-rose-300">
                  {listenerError}
                </p>
              ) : null}
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-muted/40 p-3 dark:border-slate-700 dark:bg-slate-950/45">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground dark:text-slate-100">
            <Info className="h-4 w-4 text-blue-600 dark:text-blue-300" />
            Automatically maintained takeover settings
          </div>
          <div className="grid gap-2">
            {autoManagedRows.map((row) => (
              <div
                key={row.label}
                className="rounded-md border border-border bg-background/80 p-3 dark:border-slate-800 dark:bg-slate-950/70"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-muted-foreground dark:text-slate-400">
                    {row.label}
                  </span>
                  <Badge className="border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-500/50 dark:bg-blue-500/15 dark:text-blue-100">
                    Automatic
                  </Badge>
                </div>
                <div className="mt-1 break-all font-mono text-xs text-foreground dark:text-slate-100">
                  {row.value}
                </div>
                <div className="mt-1 text-xs leading-5 text-muted-foreground dark:text-slate-500">
                  {row.detail}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/// 进入路由页后自动读取候选 provider 的模型列表；这里集中展示成功/失败，避免候选缺失时无从判断。
function ProviderModelRefreshPanel({
  modelSources,
  states,
}: {
  modelSources: Provider[];
  states: Record<string, ProviderModelRefreshState>;
}) {
  const visibleRows = modelSources
    .map((provider) => ({ provider, state: states[provider.id] }))
    .filter(({ state }) => state && state.status !== "skipped");

  if (visibleRows.length === 0) return null;

  return (
    <section className="rounded-lg border border-border bg-card p-3 dark:border-slate-700 dark:bg-slate-950/45">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground dark:text-slate-100">
        <RefreshCw className="h-4 w-4 text-sky-600 dark:text-sky-300" />
        Refresh candidate provider model lists
      </div>
      <div className="grid gap-1.5 md:grid-cols-2 xl:grid-cols-4">
        {visibleRows.map(({ provider, state }) => {
          const tone =
            state.status === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-700/50 dark:bg-emerald-950/30 dark:text-emerald-100"
              : state.status === "loading"
                ? "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-700/50 dark:bg-sky-950/30 dark:text-sky-100"
                : "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-700/50 dark:bg-rose-950/30 dark:text-rose-100";
          return (
            <div
              key={provider.id}
              className={cn("rounded-md border px-2 py-1.5", tone)}
            >
              <div className="flex min-w-0 items-center justify-between gap-2">
                <span className="truncate text-xs font-semibold">
                  {provider.name}
                </span>
                <Badge className="shrink-0 border border-current bg-transparent text-[10px]">
                  {state.status === "success"
                    ? `${state.modelCount ?? 0}  models`
                    : state.status === "loading"
                      ? "Loading"
                      : "Failures"}
                </Badge>
              </div>
              <div className="mt-1 truncate text-xs" title={state.message}>
                {state.message}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/// 子 Agent 候选模型属于路由规则配置：前五个会进入 Codex spawn_agent 的可用模型窗口。
/// 规则选择器是工作台专用编辑界面：用户只勾选候选 router，保存时统一写回 codexRouting.routes。
function RouteCandidatePicker({
  selectedPlan,
  modelSources,
  providerModelRefreshStates,
  onSaveRoutes,
  onCreateProvider,
  onClose,
  isSaving,
  selectAllByDefault,
}: {
  selectedPlan: Provider;
  modelSources: Provider[];
  providerModelRefreshStates: Record<string, ProviderModelRefreshState>;
  onSaveRoutes: (plan: Provider, routes: CodexRoute[]) => Promise<void>;
  onCreateProvider: () => void;
  onClose: () => void;
  isSaving: boolean;
  selectAllByDefault?: boolean;
}) {
  const candidates = useMemo(
    () => buildRouteCandidates(selectedPlan, modelSources),
    [selectedPlan, modelSources],
  );
  const candidateIds = useMemo(
    () => candidates.map((candidate) => candidate.id),
    [candidates],
  );
  const candidateIdsKey = candidateIds.join("\n");
  const draftPlanIdRef = useRef<string | null>(null);
  const draftCandidateIdsRef = useRef<string[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() =>
    buildInitialRoutePickerSelectedIds(candidates, selectAllByDefault),
  );
  const [enabledIds, setEnabledIds] = useState<Set<string>>(() =>
    buildInitialRoutePickerEnabledIds(candidates, selectAllByDefault),
  );
  const [routeDraftsById, setRouteDraftsById] = useState<
    Record<string, RoutePolicyDraft>
  >(() =>
    Object.fromEntries(
      candidates.map((candidate) => [
        candidate.id,
        createRoutePolicyDraft(candidate),
      ]),
    ),
  );
  const [routePolicyError, setRoutePolicyError] = useState<string | null>(null);

  useEffect(() => {
    const currentPlanId = selectedPlan?.id ?? null;
    const previousPlanId = draftPlanIdRef.current;
    const previousCandidateIds = draftCandidateIdsRef.current;
    const selectedDefaults = Array.from(
      buildInitialRoutePickerSelectedIds(candidates, selectAllByDefault),
    );
    const enabledDefaults = Array.from(
      buildInitialRoutePickerEnabledIds(candidates, selectAllByDefault),
    );

    if (previousPlanId !== currentPlanId) {
      setSelectedIds(new Set(selectedDefaults));
      setEnabledIds(new Set(enabledDefaults));
      setRouteDraftsById(
        Object.fromEntries(
          candidates.map((candidate) => [
            candidate.id,
            createRoutePolicyDraft(candidate),
          ]),
        ),
      );
    } else {
      setSelectedIds((current) =>
        mergeRoutePickerDraftIds(
          current,
          previousCandidateIds,
          candidateIds,
          selectedDefaults,
        ),
      );
      setEnabledIds((current) =>
        mergeRoutePickerDraftIds(
          current,
          previousCandidateIds,
          candidateIds,
          enabledDefaults,
        ),
      );
      setRouteDraftsById((current) =>
        Object.fromEntries(
          candidates.map((candidate) => [
            candidate.id,
            current[candidate.id] ?? createRoutePolicyDraft(candidate),
          ]),
        ),
      );
    }

    setRoutePolicyError(null);

    draftPlanIdRef.current = currentPlanId;
    draftCandidateIdsRef.current = candidateIds;
  }, [candidateIdsKey, candidates, selectedPlan?.id, selectAllByDefault]);

  /// 切换 Set 状态时始终返回新实例，避免 React 因引用未变而跳过刷新。
  function toggleSetValue(
    setter: Dispatch<SetStateAction<Set<string>>>,
    id: string,
  ) {
    setter((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function updateRoutePolicyDraft(
    id: string,
    update: (draft: RoutePolicyDraft) => RoutePolicyDraft,
  ) {
    setRoutePolicyError(null);
    setRouteDraftsById((current) => {
      const candidate = candidates.find((item) => item.id === id);
      if (!candidate) return current;
      const draft = current[id] ?? createRoutePolicyDraft(candidate);
      return { ...current, [id]: update(draft) };
    });
  }

  /// 保存前只保留勾选项，并把启用状态同步到 route.enabled；取消勾选即删除该 route。
  async function handleSave() {
    const routes: CodexRoute[] = [];
    for (const candidate of candidates) {
      if (!selectedIds.has(candidate.id)) continue;
      const enabled = enabledIds.has(candidate.id);
      const draft =
        routeDraftsById[candidate.id] ?? createRoutePolicyDraft(candidate);
      const aliasesResult = parseRouteAliases(draft.aliasesText);
      if (aliasesResult.error) {
        setRoutePolicyError(aliasesResult.error);
        return;
      }
      for (const [alias, upstreamModel] of Object.entries(
        aliasesResult.aliases,
      )) {
        const persistedAliases =
          candidate.route.aliases ?? candidate.route.upstream?.modelMap ?? {};
        const isStalePersistedAlias =
          candidate.isExisting &&
          providerHasCodexModelCatalog(candidate.canonicalProvider) &&
          persistedAliases[alias] === upstreamModel;
        if (
          enabled &&
          !isStalePersistedAlias &&
          (!candidate.canonicalProvider ||
            !providerHasModelIdentity(
              candidate.canonicalProvider,
              upstreamModel,
            ))
        ) {
          setRoutePolicyError(
            `Alias target “${upstreamModel}” is not in the target provider upstream model list`,
          );
          return;
        }
      }
      if (
        enabled &&
        draft.route.modelSelection?.mode === "include" &&
        draft.route.modelSelection.models.length === 0
      ) {
        setRoutePolicyError("Select at least one upstream model");
        return;
      }
      routes.push({
        ...draft.route,
        enabled,
        matchPrefixes: parseRoutePolicyList(draft.prefixesText),
        aliases: aliasesResult.aliases,
      });
    }
    setRoutePolicyError(null);
    await onSaveRoutes(selectedPlan, routes);
  }

  return (
    <section className="rounded-lg border border-emerald-200 bg-card p-3 shadow-[0_0_0_1px_rgba(16,185,129,0.10)] dark:border-emerald-700/50 dark:bg-slate-950/70 dark:shadow-[0_0_0_1px_rgba(16,185,129,0.15)]">
      <SectionHeader
        icon={Route}
        title="Choose candidate routes"
        detail="Choose which model sources enter this MultiRouter. Unchecking removes them from the rules; the standard provider editor is not opened."
        action={
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setSelectedIds(
                  new Set(candidates.map((candidate) => candidate.id)),
                );
                setEnabledIds(
                  new Set(candidates.map((candidate) => candidate.id)),
                );
              }}
              disabled={candidates.length === 0 || isSaving}
            >
              Select all and enable
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setSelectedIds(
                  new Set(
                    candidates
                      .filter((candidate) => candidate.isExisting)
                      .map((candidate) => candidate.id),
                  ),
                );
                setEnabledIds(
                  new Set(
                    candidates
                      .filter(
                        (candidate) =>
                          candidate.isExisting &&
                          candidate.route.enabled !== false,
                      )
                      .map((candidate) => candidate.id),
                  ),
                );
              }}
              disabled={isSaving}
            >
              Keep current state only
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={onClose}
              disabled={isSaving}
            >
              Disabled
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={isSaving}
              className="gap-2 bg-emerald-600 hover:bg-emerald-500"
            >
              <Save className="h-4 w-4" />
              {isSaving ? "Saving" : "Save rules"}
            </Button>
          </div>
        }
      />

      {routePolicyError ? (
        <div
          role="alert"
          className="mt-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-700/50 dark:bg-rose-950/30 dark:text-rose-100"
        >
          {routePolicyError}
        </div>
      ) : null}

      <div className="mt-2 grid gap-2 md:grid-cols-2">
        {candidates.map((candidate) => {
          const checked = selectedIds.has(candidate.id);
          const enabled = enabledIds.has(candidate.id);
          const targetLabel =
            candidate.provider?.name ??
            routeTargetProviderId(candidate.route) ??
            "Custom route";
          const refreshState = candidate.provider
            ? providerModelRefreshStates[candidate.provider.id]
            : undefined;
          const draft =
            routeDraftsById[candidate.id] ?? createRoutePolicyDraft(candidate);
          const canonicalModels = collectProviderCanonicalModelIds(
            candidate.canonicalProvider,
          );
          const modelSelection = draft.route.modelSelection ?? { mode: "all" };
          const authPolicy = draft.route.authPolicy ?? {
            source: "provider_config" as const,
          };
          const inheritsOfficialAuth =
            routeTargetProviderId(draft.route) === "codex-official";
          return (
            <div
              key={candidate.id}
              className={cn(
                "rounded-lg border p-2.5 transition",
                checked
                  ? "border-emerald-300 bg-emerald-50 dark:border-emerald-500/60 dark:bg-emerald-500/10"
                  : "border-border bg-background dark:border-slate-700 dark:bg-slate-950/40",
              )}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <button
                  type="button"
                  onClick={() => toggleSetValue(setSelectedIds, candidate.id)}
                  className="flex min-w-0 flex-1 items-start gap-2 text-left"
                >
                  <span
                    className={cn(
                      "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border",
                      checked
                        ? "border-emerald-300 bg-emerald-500 text-slate-950"
                        : "border-border bg-muted dark:border-slate-600 dark:bg-slate-900",
                    )}
                  >
                    {checked ? <CheckCircle2 className="h-3.5 w-3.5" /> : null}
                  </span>
                  <span className="min-w-0">
                    <span className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-semibold text-foreground dark:text-slate-100">
                        {routeSummaryDisplayName(
                          candidate.route.label,
                          candidate.route.id,
                          candidate.provider?.name,
                          targetLabel,
                        )}
                      </span>
                      <Badge
                        className={cn(
                          "border text-[11px]",
                          !checked
                            ? "border-border bg-muted text-muted-foreground dark:border-slate-600 dark:bg-slate-900 dark:text-slate-300"
                            : enabled
                              ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/60 dark:bg-emerald-500/15 dark:text-emerald-100"
                              : "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/60 dark:bg-amber-500/15 dark:text-amber-100",
                        )}
                      >
                        {!checked
                          ? "Not added"
                          : enabled
                            ? "Added and enabled"
                            : "Added but disabled"}
                      </Badge>
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground dark:text-slate-400">
                      {targetLabel} ·{" "}
                      {candidate.isExisting
                        ? "Already in rules"
                        : "Candidate model source"}
                    </span>
                  </span>
                </button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    if (!checked) {
                      setSelectedIds(
                        (current) => new Set([...current, candidate.id]),
                      );
                      setEnabledIds(
                        (current) => new Set([...current, candidate.id]),
                      );
                      return;
                    }
                    toggleSetValue(setEnabledIds, candidate.id);
                  }}
                  disabled={isSaving}
                  className={cn(
                    "h-8 min-w-[78px] px-2",
                    enabled
                      ? "border-emerald-300 text-emerald-700 dark:border-emerald-500/50 dark:text-emerald-100"
                      : "border-amber-300 text-amber-700 dark:border-amber-500/50 dark:text-amber-100",
                  )}
                >
                  {!checked
                    ? "Enabled"
                    : enabled
                      ? "Already Enabled"
                      : "Disabled"}
                </Button>
              </div>
              {checked ? (
                <div className="mt-3 space-y-3 rounded-md border border-emerald-200/80 bg-background/80 p-2.5 dark:border-emerald-700/40 dark:bg-slate-950/50">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="space-y-1 text-xs text-muted-foreground">
                      <span>Route name</span>
                      <input
                        aria-label={`Route name: ${targetLabel}`}
                        value={draft.route.label ?? ""}
                        onChange={(event) =>
                          updateRoutePolicyDraft(candidate.id, (current) => ({
                            ...current,
                            route: {
                              ...current.route,
                              label: event.target.value,
                            },
                          }))
                        }
                        className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground"
                      />
                    </label>
                    <label className="space-y-1 text-xs text-muted-foreground">
                      <span>Model selection scope</span>
                      <select
                        aria-label={`Model selection scope: ${targetLabel}`}
                        value={modelSelection.mode}
                        onChange={(event) =>
                          updateRoutePolicyDraft(candidate.id, (current) => ({
                            ...current,
                            route: {
                              ...current.route,
                              modelSelection:
                                event.target.value === "include"
                                  ? {
                                      mode: "include",
                                      models: collectProviderCanonicalModelIds(
                                        candidate.canonicalProvider,
                                      ),
                                    }
                                  : { mode: "all" },
                            },
                          }))
                        }
                        className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground"
                      >
                        <option value="all">
                          All models (include new models automatically)
                        </option>
                        <option value="include">
                          Selected upstream models only
                        </option>
                      </select>
                    </label>
                  </div>

                  {modelSelection.mode === "include" ? (
                    <div className="space-y-1">
                      <div className="text-xs text-muted-foreground">
                        Provider upstream models
                      </div>
                      <div className="text-xs leading-5 text-muted-foreground">
                        {routeProviderModelSyncSummary(
                          draft.route,
                          candidate.canonicalProvider,
                        )}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {canonicalModels.map((model) => (
                          <label
                            key={model}
                            className="flex items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2 py-1 text-xs text-foreground"
                          >
                            <input
                              type="checkbox"
                              aria-label={`Select upstream models ${model}`}
                              checked={providerModelIdentityMatchesSelection(
                                candidate.canonicalProvider,
                                modelSelection.models,
                                model,
                              )}
                              onChange={(event) =>
                                updateRoutePolicyDraft(
                                  candidate.id,
                                  (current) => {
                                    const selection =
                                      current.route.modelSelection?.mode ===
                                      "include"
                                        ? current.route.modelSelection.models
                                        : [];
                                    const models = event.target.checked
                                      ? Array.from(
                                          new Set([...selection, model]),
                                        )
                                      : selection.filter(
                                          (item) =>
                                            !providerModelIdentityMatchesSelection(
                                              candidate.canonicalProvider,
                                              [item],
                                              model,
                                            ),
                                        );
                                    return {
                                      ...current,
                                      route: {
                                        ...current.route,
                                        modelSelection: {
                                          mode: "include",
                                          models,
                                        },
                                      },
                                    };
                                  },
                                )
                              }
                            />
                            {model}
                          </label>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="space-y-1 text-xs text-muted-foreground">
                      <span>Match prefixes (comma or newline separated)</span>
                      <textarea
                        aria-label={`Match prefixes: ${targetLabel}`}
                        value={draft.prefixesText}
                        onChange={(event) =>
                          updateRoutePolicyDraft(candidate.id, (current) => ({
                            ...current,
                            prefixesText: event.target.value,
                          }))
                        }
                        rows={2}
                        className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground"
                      />
                    </label>
                    <label className="space-y-1 text-xs text-muted-foreground">
                      <span>
                        Visible aliases (visible model = upstream model)
                      </span>
                      <textarea
                        aria-label={`Visible alias mapping: ${targetLabel}`}
                        value={draft.aliasesText}
                        onChange={(event) =>
                          updateRoutePolicyDraft(candidate.id, (current) => ({
                            ...current,
                            aliasesText: event.target.value,
                          }))
                        }
                        rows={2}
                        className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground"
                      />
                    </label>
                  </div>

                  {inheritsOfficialAuth ? (
                    <div className="rounded-md border border-blue-200 bg-blue-50/60 px-3 py-2 text-xs leading-5 text-muted-foreground dark:border-blue-800/60 dark:bg-blue-950/20">
                      Authentication is inherited from OpenAI Official; change
                      it from that provider’s “Authentication settings”. Router
                      authentication fields are not written here.
                    </div>
                  ) : (
                    <div className="grid gap-2 sm:grid-cols-2">
                      <label className="space-y-1 text-xs text-muted-foreground">
                        <span>Authentication policy reference</span>
                        <select
                          aria-label={`authentication policy: ${targetLabel}`}
                          value={authPolicy.source}
                          onChange={(event) => {
                            const source = event.target
                              .value as CodexRoutingAuth["source"];
                            updateRoutePolicyDraft(candidate.id, (current) => ({
                              ...current,
                              route: {
                                ...current.route,
                                authPolicy: {
                                  source,
                                  ...(source === "managed_codex_oauth" ||
                                  source === "managed_account" ||
                                  source === "account_pool"
                                    ? {
                                        accountId:
                                          current.route.authPolicy?.accountId,
                                      }
                                    : {}),
                                },
                              },
                            }));
                          }}
                          className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground"
                        >
                          <option value="provider_config">
                            Provider-configured auth
                          </option>
                          <option value="native_codex_auth">
                            Current Codex Desktop login
                          </option>
                          <option value="managed_codex_oauth">
                            Managed Codex OAuth
                          </option>
                          <option value="account_pool">
                            OAuth account pool
                          </option>
                        </select>
                      </label>
                      {authPolicy.source === "managed_codex_oauth" ||
                      authPolicy.source === "managed_account" ||
                      authPolicy.source === "account_pool" ? (
                        <label className="space-y-1 text-xs text-muted-foreground">
                          <span>
                            Account/policy reference ID (tokens are not stored)
                          </span>
                          <input
                            aria-label={`${
                              authPolicy.source === "managed_codex_oauth"
                                ? "Managed OAuth account ID"
                                : "Account pool policy ID"
                            }: ${targetLabel}`}
                            value={authPolicy.accountId ?? ""}
                            onChange={(event) =>
                              updateRoutePolicyDraft(
                                candidate.id,
                                (current) => ({
                                  ...current,
                                  route: {
                                    ...current.route,
                                    authPolicy: {
                                      source: authPolicy.source,
                                      accountId: event.target.value,
                                    },
                                  },
                                }),
                              )
                            }
                            className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground"
                          />
                        </label>
                      ) : null}
                    </div>
                  )}
                  <p className="text-xs leading-5 text-muted-foreground">
                    Address, API key, protocol, context, and capabilities are
                    maintained by the target provider/model entry; this stores
                    only keyless route policy.
                  </p>
                </div>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
                {candidate.matchModels.slice(0, 6).map((model) => (
                  <span
                    key={model}
                    className="rounded-full border border-border bg-muted px-2 py-0.5 text-muted-foreground dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
                  >
                    {model}
                  </span>
                ))}
                {candidate.matchModels.length > 6 ? (
                  <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-muted-foreground dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
                    +{candidate.matchModels.length - 6}
                  </span>
                ) : null}
                {candidate.matchPrefixes.map((prefix) => (
                  <span
                    key={prefix}
                    className="rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-blue-800 dark:border-blue-700/60 dark:bg-blue-950/40 dark:text-blue-100"
                  >
                    {prefix}*
                  </span>
                ))}
                {candidate.matchModels.length === 0 &&
                candidate.matchPrefixes.length === 0 ? (
                  <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-amber-800 dark:border-amber-600/60 dark:bg-amber-950/30 dark:text-amber-100">
                    No model catalog found. Save first, then add a catalog in
                    the model source.
                  </span>
                ) : null}
              </div>
              {refreshState && refreshState.status !== "skipped" ? (
                <div
                  className={cn(
                    "mt-2 rounded-md border px-2 py-1.5 text-xs leading-5",
                    refreshState.status === "success"
                      ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-700/50 dark:bg-emerald-950/30 dark:text-emerald-100"
                      : refreshState.status === "loading"
                        ? "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-700/50 dark:bg-sky-950/30 dark:text-sky-100"
                        : "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-700/50 dark:bg-rose-950/30 dark:text-rose-100",
                  )}
                >
                  {refreshState.message}
                </div>
              ) : null}
            </div>
          );
        })}
        {candidates.length === 0 ? (
          <EmptyState
            icon={Server}
            title="No routers available"
            detail="Add at least one Codex model source, then return here to choose candidate routers."
            actionLabel="Add model source"
            onAction={onCreateProvider}
          />
        ) : null}
      </div>
    </section>
  );
}

function SpawnAgentCandidatesPanel({
  selectedPlan,
  selectedRoutes,
  catalog,
  providersById,
}: {
  selectedPlan: Provider | null;
  selectedRoutes: RouteEntry[];
  catalog: CodexModelCatalogDraft;
  providersById: Map<string, Provider>;
}) {
  const [diagnostics, setDiagnostics] =
    useState<CodexMultiRouterDiagnostics | null>(null);
  const [candidateView, setCandidateView] =
    useState<SpawnAgentCandidateView>("selected");
  const [draftSpawnAgentModels, setDraftSpawnAgentModels] = useState<string[]>(
    [],
  );
  const [candidateSaveError, setCandidateSaveError] = useState<string | null>(
    null,
  );
  const [candidateSaveMessage, setCandidateSaveMessage] = useState<
    string | null
  >(null);
  const [candidateValidationMessage, setCandidateValidationMessage] = useState<
    string | null
  >(null);
  const [isSavingCandidates, setIsSavingCandidates] = useState(false);
  const [isValidatingCandidates, setIsValidatingCandidates] = useState(false);
  const persistedSubagentVersion =
    readCodexRouting(selectedPlan)?.subagentVersion ?? "v2";
  const [activeSubagentVersion, setActiveSubagentVersion] =
    useState<CodexSubagentVersion>(persistedSubagentVersion);
  const [isSavingSubagentVersion, setIsSavingSubagentVersion] = useState(false);
  const [pendingSubagentVersion, setPendingSubagentVersion] =
    useState<CodexSubagentVersion | null>(null);
  const [subagentVersionError, setSubagentVersionError] = useState<
    string | null
  >(null);
  const [subagentVersionMessage, setSubagentVersionMessage] = useState<
    string | null
  >(null);
  const queryClient = useQueryClient();
  const candidateSensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const selectedCatalog = {
    ...catalog,
    spawnAgentModels: catalog.spawnAgentModels ?? [],
  };
  const selectedCatalogModelKey = selectedCatalog.models
    .map((model) => model.model?.trim() ?? "")
    .join("\n");
  const selectedCatalogSpawnAgentKey =
    selectedCatalog.spawnAgentModels.join("\n");
  const selectedCatalogByModel = new Map(
    selectedCatalog.models
      .filter((model) => model.model?.trim())
      .map((model) => [model.model!.trim(), model]),
  );
  const spawnAgentVisibleLimit =
    diagnostics?.liveConfig.spawnAgentVisibleModelLimit ?? 5;
  const configuredSpawnAgentModels = selectedCatalog.spawnAgentModels
    .map((model) => selectedCatalogByModel.get(model) ?? { model })
    .slice(0, spawnAgentVisibleLimit);
  const generatedVisibleModels =
    diagnostics?.liveConfig.modelCatalogFirstModels
      ?.slice(0, spawnAgentVisibleLimit)
      .map((model) => selectedCatalogByModel.get(model) ?? { model }) ?? [];
  const previewVisibleModels =
    generatedVisibleModels.length > 0
      ? generatedVisibleModels
      : configuredSpawnAgentModels.length > 0
        ? configuredSpawnAgentModels
        : selectedCatalog.models.slice(0, spawnAgentVisibleLimit);
  const routedCatalogModelIds = useMemo(
    () =>
      collectRoutedCatalogModels(
        selectedRoutes,
        selectedCatalog.models,
        providersById,
      ),
    [providersById, selectedRoutes, selectedCatalog.models],
  );
  const draftVisibleModels = draftSpawnAgentModels.map(
    (model) => selectedCatalogByModel.get(model) ?? { model },
  );
  const candidateCatalog = {
    ...selectedCatalog,
    spawnAgentModels: draftSpawnAgentModels,
  };
  const localCandidateValidation = validateSpawnAgentCandidates(
    candidateCatalog,
    draftSpawnAgentModels.length > 0
      ? draftSpawnAgentModels
      : selectedCatalog.models
          .map((model) => model.model?.trim())
          .filter((model): model is string => Boolean(model))
          .slice(0, spawnAgentVisibleLimit),
    [],
    spawnAgentVisibleLimit,
  );
  const actualCandidateValidation = validateSpawnAgentCandidates(
    candidateCatalog,
    diagnostics?.liveConfig.modelCatalogFirstModels ?? [],
    [],
    spawnAgentVisibleLimit,
  );
  const candidateSourceModels = {
    selected: draftSpawnAgentModels,
    routed: routedCatalogModelIds,
    // “重点”名单按角色别名口径：catalog 有 deepseek-flash 时同样覆盖
    // deepseek-v4-flash 重点项。
    priority: CODEX_SPAWN_AGENT_PRIORITY_MODELS.filter((model) =>
      catalogHasRoleModel(selectedCatalog.models, model),
    ),
    all: selectedCatalog.models
      .map((model) => model.model?.trim())
      .filter((model): model is string => Boolean(model)),
  } satisfies Record<SpawnAgentCandidateView, string[]>;
  const selectedCandidateSet = new Set(draftSpawnAgentModels);
  const hasCandidateChanges =
    draftSpawnAgentModels.join("\n") !==
    selectedCatalog.spawnAgentModels.join("\n");
  const spawnAgentMissingPriorityModels =
    diagnostics?.liveConfig.spawnAgentMissingPriorityModels ?? [];
  // DeepSeek 角色 slug 别名（deepseek-flash ≡ deepseek-v4-flash）与 src-tauri
  // 同一口径判定，避免官方新 slug 被误报“目录中缺失”。
  const hasFlashRoleModel = selectedCatalog.models.some(
    (model) => deepSeekRoleForModel(model.model?.trim() ?? "") === "flash",
  );
  const hasProRoleModel = selectedCatalog.models.some(
    (model) => deepSeekRoleForModel(model.model?.trim() ?? "") === "pro",
  );

  useEffect(() => {
    setActiveSubagentVersion(persistedSubagentVersion);
    setSubagentVersionError(null);
    setSubagentVersionMessage(null);
    setPendingSubagentVersion(null);
  }, [persistedSubagentVersion, selectedPlan?.id]);

  useEffect(() => {
    setDraftSpawnAgentModels(
      normalizeSpawnAgentCandidateSelection(
        selectedCatalog.spawnAgentModels,
        selectedCatalog.models,
        spawnAgentVisibleLimit,
      ),
    );
    setCandidateSaveError(null);
    setCandidateSaveMessage(null);
    setCandidateValidationMessage(null);
  }, [
    selectedPlan?.id,
    selectedCatalogSpawnAgentKey,
    selectedCatalogModelKey,
    spawnAgentVisibleLimit,
  ]);

  /// 点击候选模型时只改变草稿；保存前不会写数据库，便于用户先检查和拖动排序。
  function toggleSpawnAgentCandidate(model: string) {
    setCandidateSaveError(null);
    setCandidateSaveMessage(null);
    setCandidateValidationMessage(null);
    setDraftSpawnAgentModels((current) => {
      if (current.includes(model)) {
        return current.filter((item) => item !== model);
      }
      return normalizeSpawnAgentCandidateSelection(
        [...current, model],
        selectedCatalog.models,
        spawnAgentVisibleLimit,
      );
    });
  }

  /// 拖拽结束后只重排当前草稿，并继续受 Codex spawn_agent 前五个可见模型限制保护。
  function handleSpawnAgentDragEnd(event: DragEndEvent) {
    const activeModel = String(event.active.id);
    const overModel = event.over ? String(event.over.id) : "";
    if (!overModel) return;
    setDraftSpawnAgentModels((current) =>
      reorderSpawnAgentCandidates(
        current,
        activeModel,
        overModel,
        spawnAgentVisibleLimit,
      ),
    );
  }

  /// schema v2 只保存用户选择的 spawn-agent policy；可见 catalog 由 compiler 重建。
  async function saveSpawnAgentCandidates() {
    if (!selectedPlan) return;
    setIsSavingCandidates(true);
    setCandidateSaveError(null);
    setCandidateSaveMessage(null);
    try {
      const normalized = normalizeSpawnAgentCandidateSelection(
        draftSpawnAgentModels,
        selectedCatalog.models,
        spawnAgentVisibleLimit,
      );
      const currentRouting = readCodexRouting(selectedPlan);
      if (currentRouting?.schemaVersion !== 2) {
        throw new Error("legacy_route_requires_migration");
      }
      const nextProvider = reconcileCodexRoutingPlanForSave(
        {
          ...selectedPlan,
          settingsConfig: {
            ...withoutDerivedRouterCatalog(selectedPlan.settingsConfig),
            codexRouting: serializeCodexRoutingV2({
              ...currentRouting,
              spawnAgentModels: normalized,
            }),
          },
        },
        providersById,
      );
      await providersApi.update(nextProvider, "codex");
      setDraftSpawnAgentModels(normalized);
      setCandidateSaveMessage(
        `Saved ${normalized.length} visible sub-agent candidates; restart Codex to apply.`,
      );
      await queryClient.invalidateQueries({ queryKey: ["providers", "codex"] });
    } catch (error) {
      setCandidateSaveError(workspaceErrorMessage(error));
    } finally {
      setIsSavingCandidates(false);
    }
  }

  /// V1/V2 是当前 MultiRouter 的会话级协议选择；切换时保留完整 schema v2 routing policy。
  async function saveSubagentVersion(version: CodexSubagentVersion) {
    if (!selectedPlan || version === activeSubagentVersion) return;
    setIsSavingSubagentVersion(true);
    setPendingSubagentVersion(version);
    setSubagentVersionError(null);
    setSubagentVersionMessage(null);
    try {
      const currentRouting = readCodexRouting(selectedPlan);
      if (currentRouting?.schemaVersion !== 2) {
        throw new Error("legacy_route_requires_migration");
      }
      const nextProvider = reconcileCodexRoutingPlanForSave(
        {
          ...selectedPlan,
          settingsConfig: {
            ...withoutDerivedRouterCatalog(selectedPlan.settingsConfig),
            codexRouting: serializeCodexRoutingV2({
              ...currentRouting,
              subagentVersion: version,
            }),
          },
        },
        providersById,
      );
      await providersApi.update(nextProvider, "codex");
      setActiveSubagentVersion(version);
      setSubagentVersionMessage(
        `Enabled ${version.toUpperCase()}; restart Codex/app-server and create a new session to apply.`,
      );
      await queryClient.invalidateQueries({ queryKey: ["providers", "codex"] });
    } catch (error) {
      setSubagentVersionError(workspaceErrorMessage(error));
    } finally {
      setIsSavingSubagentVersion(false);
      setPendingSubagentVersion(null);
    }
  }

  /// 校验分两步：先检查本地草稿窗口，再读取 live 诊断，确认 Codex 实际生成的前五个模型。
  async function validateSpawnAgentCandidateWindow() {
    setIsValidatingCandidates(true);
    setCandidateValidationMessage(null);
    try {
      const result = await proxyApi.diagnoseCodexMultiRouter(
        selectedPlan?.id ?? null,
      );
      setDiagnostics(result);
      const actual = validateSpawnAgentCandidates(
        candidateCatalog,
        result.liveConfig.modelCatalogFirstModels ?? [],
        [],
        result.liveConfig.spawnAgentVisibleModelLimit ?? spawnAgentVisibleLimit,
      );
      const missing = [
        ...new Set([
          ...actual.missingSelectedModels,
          ...actual.missingPriorityModels,
        ]),
      ];
      setCandidateValidationMessage(
        missing.length > 0
          ? `The live top ${actual.visibleModels.length} candidates are still missing: ${missing.join(", ")}`
          : `Validation passed: the live visible window covers the current selection; actual window: ${actual.visibleModels.join(", ") || "empty"}`,
      );
    } catch (error) {
      setCandidateValidationMessage(
        `Validation failed:${workspaceErrorMessage(error)}`,
      );
    } finally {
      setIsValidatingCandidates(false);
    }
  }

  return (
    <section className="rounded-xl border border-violet-200 bg-gradient-to-br from-violet-50/90 via-background to-cyan-50/70 p-3 shadow-sm dark:border-violet-500/35 dark:from-violet-950/25 dark:via-slate-950/40 dark:to-cyan-950/20">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-3xl">
          <div className="flex items-center gap-2 text-sm font-semibold text-violet-800 dark:text-violet-100">
            <Settings2 className="h-4 w-4" />
            Sub-agent settings
          </div>
          <p className="mt-1 text-xs leading-5 text-violet-700/80 dark:text-violet-200/80">
            V1 is for legacy Codex, manual submodel selection, and compatibility
            troubleshooting; V2 is for newer Codex and uses best-effort semantic
            role selection by the parent agent. Both configurations are
            preserved, but only one protocol is enabled per session.
          </p>
        </div>
        <Badge className="border border-violet-300 bg-background text-violet-800 dark:border-violet-500/50 dark:bg-violet-500/10 dark:text-violet-100">
          Currently using {activeSubagentVersion.toUpperCase()}
        </Badge>
      </div>

      <div className="mt-3 grid gap-2 lg:grid-cols-2">
        <div
          data-subagent-protocol="v1"
          className={cn(
            "rounded-lg border p-3 shadow-sm transition-colors",
            activeSubagentVersion === "v1"
              ? "border-blue-300 bg-blue-50 dark:border-blue-500/60 dark:bg-blue-950/25"
              : "border-sky-200 bg-sky-50/70 dark:border-sky-500/40 dark:bg-sky-950/20",
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-semibold">Sub-Agent V1</div>
            <Button
              size="sm"
              variant={activeSubagentVersion === "v1" ? "outline" : "default"}
              disabled={
                isSavingSubagentVersion || activeSubagentVersion === "v1"
              }
              className={cn(
                activeSubagentVersion === "v1"
                  ? "border-border bg-muted text-muted-foreground hover:bg-muted"
                  : "bg-blue-600 text-white hover:bg-blue-500",
              )}
              onClick={() => saveSubagentVersion("v1")}
            >
              {pendingSubagentVersion === "v1"
                ? "Switching…"
                : activeSubagentVersion === "v1"
                  ? "V1 enabled"
                  : "Enable V1"}
            </Button>
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Expose and order the top {spawnAgentVisibleLimit}
            candidates through direct model override. Useful for legacy Codex,
            compatibility troubleshooting, or cases requiring manual submodel
            control.
          </p>
        </div>
        <div
          data-subagent-protocol="v2"
          className={cn(
            "rounded-lg border p-3 shadow-sm transition-colors",
            activeSubagentVersion === "v2"
              ? "border-emerald-300 bg-emerald-50 dark:border-emerald-500/60 dark:bg-emerald-500/10"
              : "border-violet-200 bg-violet-50/70 dark:border-violet-500/40 dark:bg-violet-950/20",
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-semibold">Sub-Agent V2</div>
            <Button
              size="sm"
              variant={activeSubagentVersion === "v2" ? "outline" : "default"}
              disabled={
                isSavingSubagentVersion || activeSubagentVersion === "v2"
              }
              className={cn(
                activeSubagentVersion === "v2"
                  ? "border-border bg-muted text-muted-foreground hover:bg-muted"
                  : "bg-blue-600 text-white hover:bg-blue-500",
              )}
              onClick={() => saveSubagentVersion("v2")}
            >
              {pendingSubagentVersion === "v2"
                ? "Switching…"
                : activeSubagentVersion === "v2"
                  ? "V2 enabled"
                  : "Enable V2"}
            </Button>
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Using task paths, mailboxes, and follow-ups, Codex performs
            best-effort selection among built-in and custom roles. The
            capability questionnaire and role descriptions guide selection but
            do not guarantee Flash or Pro. Built-in default, worker, and
            explorer roles may still be selected. Recommended for newer Codex
            versions.
          </p>
        </div>
      </div>

      {subagentVersionError ? (
        <div
          role="alert"
          className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-700/50 dark:bg-rose-950/30 dark:text-rose-100"
        >
          Switch failed:{subagentVersionError}
        </div>
      ) : null}
      {subagentVersionMessage ? (
        <div
          aria-live="polite"
          className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-700/50 dark:bg-emerald-950/30 dark:text-emerald-100"
        >
          {subagentVersionMessage}
        </div>
      ) : null}
      <div className="mt-3 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs leading-5 text-sky-800 dark:border-sky-700/50 dark:bg-sky-950/25 dark:text-sky-100">
        After switching protocols, restart Codex Desktop/app-server and create a
        new session; existing sessions will not change sub-agent protocol
        mid-session.
      </div>

      {activeSubagentVersion === "v2" && selectedPlan ? (
        <div className="mt-3">
          <div className="mb-2">
            <div className="text-sm font-semibold text-emerald-800 dark:text-emerald-100">
              Step 1: Configure V2 sub-agent models and capabilities
            </div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Add models from the full routable catalog and configure role
              capabilities; after saving, select the top{" "}
              {spawnAgentVisibleLimit} models shown in Codex tool instructions.
            </p>
          </div>
          <CodexSubagentProfileEditor
            provider={selectedPlan}
            modelCatalog={selectedCatalog}
          />
        </div>
      ) : null}

      {activeSubagentVersion === "v2" ? (
        <div className="mt-3 grid gap-2 lg:grid-cols-2">
          <div className="rounded-md border border-emerald-200 bg-background/75 p-3 dark:border-emerald-700/50 dark:bg-slate-950/30">
            <div className="flex items-center justify-between gap-2">
              <code className="text-xs font-semibold">deepseek-flash</code>
              <Badge
                className={cn(
                  "border",
                  hasFlashRoleModel
                    ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-100"
                    : "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100",
                )}
              >
                {hasFlashRoleModel ? "Routable" : "Missing from catalog"}
              </Badge>
            </div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              Long-context reading, codebase scanning, architecture tracing,
              parallel evidence gathering, and lightweight verification.
            </p>
          </div>
          <div className="rounded-md border border-emerald-200 bg-background/75 p-3 dark:border-emerald-700/50 dark:bg-slate-950/30">
            <div className="flex items-center justify-between gap-2">
              <code className="text-xs font-semibold">deepseek-pro</code>
              <Badge
                className={cn(
                  "border",
                  hasProRoleModel
                    ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-100"
                    : "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100",
                )}
              >
                {hasProRoleModel ? "Routable" : "Missing from catalog"}
              </Badge>
            </div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              Complex debugging, cross-module reasoning, architecture decisions,
              high-risk review, and complex implementation.
            </p>
          </div>
          <p className="text-xs leading-5 text-violet-700/80 dark:text-violet-200/80 lg:col-span-2">
            V2 managed roles are still generated from the full routable model
            catalog; the top-five order only controls which direct models
            spawn_agent advertises to the parent agent. It does not delete the
            remaining roles or models.
          </p>
        </div>
      ) : null}

      {selectedPlan ? (
        <div className="mt-3 rounded-md border border-amber-200 bg-background/70 p-3 dark:border-amber-700/50 dark:bg-slate-950/30">
          <div className="text-sm font-semibold text-amber-800 dark:text-amber-100">
            {activeSubagentVersion === "v2"
              ? "Step 2: Choose the top five models shown in V2 tool instructions"
              : "V1 direct model override"}
          </div>
          <p className="mt-1 text-xs text-amber-700/80 dark:text-amber-200/80">
            {activeSubagentVersion === "v2"
              ? "Codex Multi-agent V2 currently shows only the top five models in spawn_agent tool instructions; remaining routable models can still be called explicitly. This stores the shared V1/V2 advertisement order."
              : "This ordering controls the V1 direct model override window and is retained in the current MultiRouter config; V2 reuses it when enabled."}
          </p>
          <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={validateSpawnAgentCandidateWindow}
                disabled={isValidatingCandidates || !selectedPlan}
                className="gap-2 border-emerald-300 bg-background/70 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-500/50 dark:bg-emerald-500/10 dark:text-emerald-100 dark:hover:bg-emerald-500/20"
              >
                {isValidatingCandidates ? (
                  <RefreshCw className="h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-4 w-4" />
                )}
                Validate candidates
              </Button>
              <Button
                size="sm"
                onClick={saveSpawnAgentCandidates}
                disabled={
                  isSavingCandidates || !selectedPlan || !hasCandidateChanges
                }
                className="gap-2 bg-violet-600 hover:bg-violet-500"
              >
                {isSavingCandidates ? (
                  <RefreshCw className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                Save ordering
              </Button>
            </div>
          </div>

          <div className="mt-2 grid items-stretch gap-2 xl:grid-cols-[minmax(0,1fr)_minmax(260px,0.65fr)]">
            <div className="space-y-2">
              <div>
                <div className="mb-1.5 text-xs font-semibold text-violet-800 dark:text-violet-100">
                  Top five models available to Codex spawn_agent
                </div>
                <div className="grid gap-1.5 md:grid-cols-5">
                  {previewVisibleModels.length > 0 ? (
                    previewVisibleModels.map((model, index) => (
                      <div
                        key={`${model.model ?? index}-${index}`}
                        className="min-w-0 rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 shadow-[0_0_0_1px_rgba(251,191,36,0.12)] dark:border-amber-400/70 dark:bg-amber-500/15 dark:shadow-[0_0_0_1px_rgba(251,191,36,0.18)]"
                      >
                        <div className="flex items-center justify-between gap-2 text-[10px] text-amber-700 dark:text-amber-200">
                          <span>#{index + 1}</span>
                          <span>spawn</span>
                        </div>
                        <div
                          className="mt-0.5 truncate font-mono text-[11px] text-foreground dark:text-slate-50"
                          title={catalogModelLabel(model)}
                        >
                          {catalogModelLabel(model)}
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="rounded-md border border-violet-200 bg-background/80 px-3 py-2 text-xs text-violet-800 dark:border-violet-800/60 dark:bg-slate-950/45 dark:text-violet-100 md:col-span-5">
                      The current MultiRouter provider has no modelCatalog. Add
                      OpenAI / Qwen / DeepSeek candidate models to the model
                      mapping first.
                    </div>
                  )}
                </div>
              </div>

              <div>
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <div className="text-xs font-semibold text-violet-800 dark:text-violet-100">
                    Top five draggable candidates
                  </div>
                  <Badge className="border border-violet-200 bg-violet-50 text-violet-800 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-violet-100">
                    {draftSpawnAgentModels.length} / {spawnAgentVisibleLimit}
                  </Badge>
                </div>
                <DndContext
                  sensors={candidateSensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleSpawnAgentDragEnd}
                >
                  <SortableContext
                    items={draftSpawnAgentModels}
                    strategy={verticalListSortingStrategy}
                  >
                    <div className="grid gap-1.5">
                      {draftVisibleModels.length > 0 ? (
                        draftVisibleModels.map((model, index) => (
                          <SortableSpawnAgentCandidate
                            key={model.model}
                            model={model}
                            index={index}
                            onRemove={toggleSpawnAgentCandidate}
                          />
                        ))
                      ) : (
                        <div className="rounded-md border border-dashed border-violet-200 bg-background/70 px-3 py-2 text-xs text-violet-800 dark:border-violet-700/60 dark:bg-slate-950/30 dark:text-violet-100">
                          No sub-agent candidates selected. Add from the
                          candidate pool on the right, up to{" "}
                          {spawnAgentVisibleLimit} items.
                        </div>
                      )}
                    </div>
                  </SortableContext>
                </DndContext>
              </div>
            </div>

            <div className="flex h-full min-h-0 flex-col rounded-md border border-violet-200 bg-background/70 p-2 dark:border-violet-800/50 dark:bg-slate-950/35">
              <Tabs
                value={candidateView}
                onValueChange={(value) =>
                  setCandidateView(value as SpawnAgentCandidateView)
                }
                className="flex h-full min-h-0 flex-col"
              >
                <TabsList className="grid w-full grid-cols-4 bg-muted p-1 dark:bg-slate-950/60">
                  <TabsTrigger value="selected">Selected</TabsTrigger>
                  <TabsTrigger value="routed">Routed</TabsTrigger>
                  <TabsTrigger value="priority">Priority</TabsTrigger>
                  <TabsTrigger value="all">All</TabsTrigger>
                </TabsList>
                {(["selected", "routed", "priority", "all"] as const).map(
                  (view) => (
                    <TabsContent
                      key={view}
                      value={view}
                      className="mt-2 min-h-0 flex-1"
                    >
                      <div className="max-h-[220px] min-h-[132px] space-y-1.5 overflow-y-auto pr-1 xl:max-h-[260px]">
                        {candidateSourceModels[view].length > 0 ? (
                          candidateSourceModels[view].map((model) => {
                            const catalogModel = selectedCatalogByModel.get(
                              model,
                            ) ?? { model };
                            const isSelected = selectedCandidateSet.has(model);
                            const selectedIndex =
                              draftSpawnAgentModels.indexOf(model);
                            return (
                              <button
                                key={`${view}-${model}`}
                                type="button"
                                onClick={() => toggleSpawnAgentCandidate(model)}
                                disabled={
                                  !isSelected &&
                                  draftSpawnAgentModels.length >=
                                    spawnAgentVisibleLimit
                                }
                                className={cn(
                                  "flex w-full items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-left text-xs transition",
                                  isSelected
                                    ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-400/70 dark:bg-amber-500/15 dark:text-amber-50"
                                    : "border-border bg-card text-foreground hover:border-violet-300 hover:bg-violet-50 dark:border-slate-700 dark:bg-slate-950/45 dark:text-slate-200 dark:hover:border-violet-500/60 dark:hover:bg-violet-500/10",
                                  !isSelected &&
                                    draftSpawnAgentModels.length >=
                                      spawnAgentVisibleLimit
                                    ? "cursor-not-allowed opacity-45"
                                    : "",
                                )}
                              >
                                <span className="min-w-0 truncate font-mono">
                                  {catalogModelLabel(catalogModel)}
                                </span>
                                <Badge
                                  className={cn(
                                    "shrink-0 border text-[10px]",
                                    isSelected
                                      ? "border-amber-300 bg-amber-100 text-amber-800 dark:border-amber-300/70 dark:bg-amber-200/10 dark:text-amber-50"
                                      : "border-border bg-muted text-muted-foreground dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300",
                                  )}
                                >
                                  {isSelected
                                    ? `Top five #${selectedIndex + 1}`
                                    : "Add"}
                                </Badge>
                              </button>
                            );
                          })
                        ) : (
                          <div className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground dark:border-slate-700 dark:text-slate-400">
                            This source has no available models.
                          </div>
                        )}
                      </div>
                    </TabsContent>
                  ),
                )}
              </Tabs>
            </div>
          </div>

          <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-violet-700/80 dark:text-violet-200/80">
            <Badge className="border border-violet-200 bg-violet-50 text-violet-800 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-violet-100">
              catalog: {selectedCatalog.models.length}
            </Badge>
            <Badge className="border border-violet-200 bg-violet-50 text-violet-800 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-violet-100">
              Route hits: {routedCatalogModelIds.length}
            </Badge>
            <Badge className="border border-violet-200 bg-violet-50 text-violet-800 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-violet-100">
              Source:{" "}
              {generatedVisibleModels.length > 0
                ? "Diagnostic observation"
                : "Configuration preview"}
            </Badge>
            <Badge
              className={cn(
                "border",
                localCandidateValidation.missingSelectedModels.length === 0
                  ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-100"
                  : "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100",
              )}
            >
              Local check:{" "}
              {localCandidateValidation.missingSelectedModels.length === 0
                ? "All selected are covered"
                : `${localCandidateValidation.missingSelectedModels.length} selected missing`}
            </Badge>
          </div>

          {candidateSaveError ? (
            <div className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700 dark:border-rose-700/50 dark:bg-rose-950/30 dark:text-rose-100">
              Save failed:{candidateSaveError}
            </div>
          ) : null}
          {candidateSaveMessage ? (
            <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs leading-5 text-emerald-800 dark:border-emerald-700/50 dark:bg-emerald-950/30 dark:text-emerald-100">
              {candidateSaveMessage}
            </div>
          ) : null}
          {candidateValidationMessage ? (
            <div className="mt-3 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs leading-5 text-sky-800 dark:border-sky-700/50 dark:bg-sky-950/30 dark:text-sky-100">
              {candidateValidationMessage}
            </div>
          ) : null}
          {actualCandidateValidation.missingSelectedModels.length > 0 ? (
            <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800 dark:border-amber-700/50 dark:bg-amber-950/30 dark:text-amber-100">
              The live visible window does not cover the selected models:
              {actualCandidateValidation.missingSelectedModels.join(", ")}.
              Restart Codex Desktop/app-server after saving, then validate
              again.
            </div>
          ) : null}
          {spawnAgentMissingPriorityModels.length > 0 ? (
            <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800 dark:border-amber-700/50 dark:bg-amber-950/30 dark:text-amber-100">
              Priority models are missing from the first{" "}
              {spawnAgentVisibleLimit} visible candidates:{" "}
              {spawnAgentMissingPriorityModels.join(", ")}. Add them to the
              sub-agent candidate list and restart Codex Desktop/app-server.
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function CodexProjectionStatusPanel({
  status,
  queryError,
  retryError,
  isRefreshing,
  onRetry,
}: {
  status?: CodexRoutingProjectionStatus;
  queryError: Error | null;
  retryError: string | null;
  isRefreshing: boolean;
  onRetry: () => void;
}) {
  const inactive = status?.state === "not_required";
  const pending = Boolean(queryError) || status?.state === "pending" || !status;
  const errorMessage =
    retryError ||
    status?.lastError ||
    (queryError instanceof Error ? queryError.message : null);
  const routeRows = (status?.routes ?? []).slice(0, 8);

  return (
    <div
      role="status"
      className={cn(
        "mt-3 rounded-lg border p-3 text-xs leading-5",
        pending
          ? "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-700/50 dark:bg-amber-950/25 dark:text-amber-100"
          : inactive
            ? "border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-600/50 dark:bg-slate-900/60 dark:text-slate-200"
            : "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-700/50 dark:bg-emerald-950/25 dark:text-emerald-100",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-semibold">
          MultiRouter catalog projection:
          {inactive
            ? "Generated on activation"
            : pending
              ? "Pending sync"
              : "Synchronized"}
        </div>
        {pending && !inactive ? (
          <Button
            size="sm"
            variant="outline"
            onClick={onRetry}
            disabled={isRefreshing}
            className="h-8 gap-1.5 border-amber-300 bg-background/70 text-amber-800 hover:bg-amber-100 dark:border-amber-500/50 dark:bg-amber-500/10 dark:text-amber-100 dark:hover:bg-amber-500/20"
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")}
            />
            {isRefreshing ? "Syncing…" : "Resync catalog"}
          </Button>
        ) : null}
      </div>
      <div className="mt-1">
        {inactive
          ? "This is not the active MultiRouter; it does not own the shared live file and is generated from the latest provider config when activated."
          : pending
            ? "The current provider/model catalog may differ from the Codex live projection; resync before sending requests."
            : `Confirmed ${status?.routes.length ?? 0} rule model mappings match the current provider catalog.`}
      </div>
      {errorMessage ? (
        <div className="mt-1">
          Reason:{errorMessage}
          {status?.lastErrorCode ? ` (${status.lastErrorCode})` : ""}
        </div>
      ) : null}
      {(status?.warnings ?? []).length > 0 ? (
        <div className="mt-2 space-y-1 border-t border-current/15 pt-2">
          <div className="font-medium">
            Policy references requiring attention
          </div>
          {status!.warnings.map((warning) => (
            <div key={warning}>{warning}</div>
          ))}
        </div>
      ) : null}
      {routeRows.length > 0 ? (
        <div className="mt-2 space-y-1 border-t border-current/15 pt-2">
          <div className="font-medium">Current active mappings</div>
          {routeRows.map((route) => {
            const routeLabel = routeSummaryDisplayName(
              route.routeLabel,
              route.routeId,
              route.targetProviderName,
            );
            return (
              <div
                key={`${route.routeId}:${route.visibleModel}`}
                title={`Route ID: ${route.routeId}; Provider ID: ${route.targetProviderId}`}
                className="font-mono text-[11px]"
              >
                {routeLabel} / {route.targetProviderName}: {route.visibleModel}{" "}
                → {route.upstreamModel}
              </div>
            );
          })}
          {status && status.routes.length > routeRows.length ? (
            <div>
              Remaining {status.routes.length - routeRows.length} rule mappings
              omitted.
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/// 状态页把代理运行态、Codex 接管态、路由配置态和最近流量放在同一视图里。
function StatusTab({
  selectedPlan,
  selectedRouting,
  routeEntries,
  providersById,
  proxyStatus,
  isProxyRunning,
  isCodexTakeoverActive,
  activeProviderId,
  onEditPlan,
  onDeletePlan,
}: {
  selectedPlan: Provider | null;
  selectedRouting: CodexRouting | null;
  routeEntries: RouteEntry[];
  providersById: Map<string, Provider>;
  proxyStatus?: ProxyStatus;
  isProxyRunning: boolean;
  isCodexTakeoverActive: boolean;
  activeProviderId?: string;
  onEditPlan: (provider: Provider, detail?: string) => void;
  onDeletePlan: (provider: Provider) => void;
}) {
  const queryClient = useQueryClient();
  const range = useMemo(() => ({ preset: "today" as const }), []);
  const [statusView, setStatusView] = useState<StatusView>("link");
  const trafficViewActive = statusView === "traffic";
  const requestHealthViewActive = statusView === "request-health";
  const [requestHealthSnapshot, setRequestHealthSnapshot] =
    useState<RequestHealthSnapshot>();
  const [requestHealthLoading, setRequestHealthLoading] = useState(false);
  const { data: requestLogs, isLoading } = useRequestLogs({
    filters: { appType: "codex" },
    range,
    page: 0,
    pageSize: 50,
    options: { refetchInterval: 30000 },
  });
  const {
    data: subagentUsage,
    isLoading: isLoadingSubagentUsage,
    error: subagentUsageError,
  } = useCodexSubagentUsageStats(range, 80, {
    // History/rollout parsing can be expensive. No periodic scan until the
    // backend exposes a cached-lightweight revision endpoint; manual sync
    // remains the explicit freshness control.
    refetchInterval: false,
    enabled: trafficViewActive,
  });
  const { data: collectionStatus, error: collectionStatusError } =
    useSessionCollectionStatus({ enabled: trafficViewActive });
  const [diagnostics, setDiagnostics] =
    useState<CodexMultiRouterDiagnostics | null>(null);
  const [diagnoseError, setDiagnoseError] = useState<string | null>(null);
  const [isDiagnosing, setIsDiagnosing] = useState(false);
  const [modelPickerUnlockResult, setModelPickerUnlockResult] =
    useState<CodexModelPickerUnlockResult | null>(null);
  const [isRefreshingOfficialCatalog, setIsRefreshingOfficialCatalog] =
    useState(false);
  const [officialCatalogRefreshResult, setOfficialCatalogRefreshResult] =
    useState<CodexOfficialCatalogRefreshResult | null>(null);
  const [officialCatalogRefreshError, setOfficialCatalogRefreshError] =
    useState<string | null>(null);

  const { data: guardianStatus } = useQuery<CodexGuardianStatus | null>({
    queryKey: ["codexGuardianStatus"],
    queryFn: () => proxyApi.getCodexGuardianStatus(),
    refetchInterval: 10_000,
  });
  const {
    data: projectionStatus,
    error: projectionError,
    isFetching: isRefreshingProjection,
  } = useQuery<CodexRoutingProjectionStatus>({
    queryKey: ["codexMultiRouterProjection", selectedPlan?.id],
    queryFn: () =>
      providersApi.inspectCodexMultiRouterProjection(selectedPlan!.id),
    enabled: Boolean(selectedPlan?.id),
    retry: false,
    refetchInterval: 15_000,
  });
  const [projectionRetryError, setProjectionRetryError] = useState<
    string | null
  >(null);
  const [isRetryingProjection, setIsRetryingProjection] = useState(false);
  const [modelPickerUnlockError, setModelPickerUnlockError] = useState<
    string | null
  >(null);
  const [isUnlockingModelPicker, setIsUnlockingModelPicker] = useState(false);
  const [isRefreshingValidation, setIsRefreshingValidation] = useState(false);
  const [validationRefreshMessage, setValidationRefreshMessage] = useState<
    string | null
  >(null);
  const [isSyncingSessionUsage, setIsSyncingSessionUsage] = useState(false);
  const [sessionSyncMessage, setSessionSyncMessage] = useState<string | null>(
    null,
  );

  async function refreshRequestHealth() {
    setRequestHealthLoading(true);
    try {
      setRequestHealthSnapshot(await proxyApi.getRequestHealthDiagnostics());
    } catch (error) {
      console.error(
        "[StatusTab] Failed to load request-health diagnostics",
        error,
      );
    } finally {
      setRequestHealthLoading(false);
    }
  }

  useEffect(() => {
    if (requestHealthViewActive) {
      void refreshRequestHealth();
    }
  }, [requestHealthViewActive]);

  const logs = requestLogs?.data ?? [];
  const proxyLogs = logs.filter(
    (log) => (log.dataSource ?? "proxy") === "proxy",
  );
  const sessionLogs = logs.filter(
    (log) => (log.dataSource ?? "proxy") !== "proxy",
  );
  const selectedRoutes = selectedPlan
    ? routeEntries.filter(({ provider }) => provider.id === selectedPlan.id)
    : routeEntries;
  const routerEvents = diagnostics?.routerLog.recentEvents ?? [];
  const routerRequestEvents = routerEvents.filter((event) =>
    [
      "route_resolved",
      "request_prepared",
      "upstream_send",
      "upstream_status",
      "upstream_error",
      "upstream_send_error",
    ].includes(event.event),
  );
  const routeTargetCount = new Set(
    selectedRoutes.map(
      (entry) => routeTrafficTarget(entry, providersById).providerId,
    ),
  ).size;
  const routeSummaryMap = useMemo(
    () => buildRouteSummaryMap(diagnostics),
    [diagnostics],
  );
  const trafficRows = buildRouteTrafficRows({
    logs: proxyLogs,
    routerEvents,
    routes: routeEntries,
    selectedPlan,
    providersById,
    routeSummaries: routeSummaryMap,
  });
  // The traffic section's request/token/latency metrics must come only from request_log;
  // diagnostic events have no usage or latency and would distort recent samples.
  // Keep the diagnostic-backed rows above for link/protocol evidence.
  const requestTrafficRows = buildRouteTrafficRows({
    logs: proxyLogs,
    routerEvents: [],
    routes: routeEntries,
    selectedPlan,
    providersById,
    routeSummaries: routeSummaryMap,
  });
  const protocolRows = trafficRows.filter(
    (row) =>
      row.configuredProtocol ||
      row.lastObservedProtocol ||
      row.requestCount > 0,
  );
  const routerLogs = routerEvents;
  const routedLogs = proxyLogs.filter((log) =>
    trafficRows.some(
      (row) =>
        row.providerId === log.providerId ||
        row.model === (log.requestModel || log.model),
    ),
  );
  const latestLog = proxyLogs[0];
  const latestForwardOk = latestLog
    ? latestLog.statusCode >= 200 && latestLog.statusCode < 400
    : false;
  // 配置成功不能只看“任意 Codex 请求成功”，必须看到当前 MultiRouter 方案的 route 有成功转发证据。
  const currentRouteForwardOk = trafficRows.some((row) => row.successCount > 0);
  const listenAddress = proxyStatus
    ? `${proxyStatus.address}:${proxyStatus.port}`
    : "Not started";
  const activeTargetLabel =
    activeProviderId && providersById.get(activeProviderId)
      ? `${providersById.get(activeProviderId)?.name} (${activeProviderId})`
      : activeProviderId || "No match";
  const routeEnabled = selectedRouting?.enabled !== false;
  const hasEnabledRoutes = selectedRoutes.some(
    ({ route }) => route.enabled !== false,
  );
  const runtimeStatus = buildMultiRouterRuntimeStatus({
    selectedPlan,
    selectedRouting,
    enabledRouteCount: selectedRoutes.filter(
      ({ route }) => route.enabled !== false,
    ).length,
    isProxyRunning,
    isCodexTakeoverActive,
    activeProviderId,
  });
  const configReady = Boolean(
    isProxyRunning &&
    isCodexTakeoverActive &&
    selectedPlan &&
    activeProviderId === selectedPlan.id &&
    routeEnabled &&
    hasEnabledRoutes,
  );
  const trafficVerified = currentRouteForwardOk;
  const linkOnline = Boolean(runtimeStatus.running && trafficVerified);
  const readinessIssues = [
    !isProxyRunning ? "Local proxy not listening" : "",
    !isCodexTakeoverActive ? "Codex live config not taken over" : "",
    !selectedPlan ? "Not selected MultiRouter provider" : "",
    selectedPlan && activeProviderId !== selectedPlan.id
      ? "The current Codex provider is not the selected MultiRouter"
      : "",
    selectedPlan && !routeEnabled ? "MultiRouter entryDisabled" : "",
    selectedPlan && routeEnabled && !hasEnabledRoutes
      ? "No enabled matching rule"
      : "",
  ].filter(Boolean);

  /// 配置完成返回状态页后，手动刷新所有校验数据，避免用户等待轮询才看到最新监听、接管和转发日志。
  async function refreshValidationState() {
    setIsRefreshingValidation(true);
    setValidationRefreshMessage(null);
    try {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["proxyStatus"] }),
        queryClient.invalidateQueries({ queryKey: ["proxyTakeoverStatus"] }),
        queryClient.invalidateQueries({ queryKey: ["providers", "codex"] }),
        queryClient.invalidateQueries({ queryKey: usageKeys.all }),
      ]);
      await Promise.all([
        queryClient.refetchQueries({
          queryKey: ["proxyStatus"],
          type: "active",
        }),
        queryClient.refetchQueries({
          queryKey: ["proxyTakeoverStatus"],
          type: "active",
        }),
        queryClient.refetchQueries({
          queryKey: ["providers", "codex"],
          type: "active",
        }),
        queryClient.refetchQueries({ queryKey: usageKeys.all, type: "active" }),
      ]);
      setValidationRefreshMessage(
        "Validation status refreshed. Check the link card and recent forwarding records.",
      );
    } catch (error) {
      setValidationRefreshMessage(
        `Failed to refresh validation:${workspaceErrorMessage(error)}`,
      );
    } finally {
      setIsRefreshingValidation(false);
    }
  }

  async function retryProjection() {
    if (!selectedPlan) return;
    setIsRetryingProjection(true);
    setProjectionRetryError(null);
    try {
      const refreshed = await providersApi.retryCodexMultiRouterProjection(
        selectedPlan.id,
      );
      queryClient.setQueryData(
        ["codexMultiRouterProjection", selectedPlan.id],
        refreshed,
      );
      await queryClient.invalidateQueries({ queryKey: ["providers", "codex"] });
    } catch (error) {
      setProjectionRetryError(workspaceErrorMessage(error));
    } finally {
      setIsRetryingProjection(false);
    }
  }

  /// 手动同步 Codex JSONL 会话用量，让子 Agent 统计立即看到最新 token_count。
  async function syncCodexSessionUsage() {
    setIsSyncingSessionUsage(true);
    setSessionSyncMessage(null);
    try {
      const result = await usageApi.syncSessionUsage();
      setSessionSyncMessage(
        result.imported > 0
          ? `Synchronized ${result.imported}  rulessession usage records`
          : "Session usage is up to date",
      );
      await queryClient.invalidateQueries({ queryKey: usageKeys.all });
    } catch (error) {
      setSessionSyncMessage(`Sync failed: ${workspaceErrorMessage(error)}`);
    } finally {
      setIsSyncingSessionUsage(false);
    }
  }

  /// 一键诊断只读取本地现场和 router 日志，不向真实上游发起模型请求。
  async function runDiagnostics(nextView: StatusView = "debug") {
    setStatusView(nextView);
    setIsDiagnosing(true);
    setDiagnoseError(null);
    try {
      const result = await proxyApi.diagnoseCodexMultiRouter(
        selectedPlan?.id ?? null,
      );
      setDiagnostics(result);
    } catch (error) {
      setDiagnoseError(workspaceErrorMessage(error));
    } finally {
      setIsDiagnosing(false);
    }
  }

  /// 明确的手动强制刷新：结果必须区分上游新快照、旧缓存与接管目录是否已重生成。
  async function refreshOfficialCatalog() {
    setIsRefreshingOfficialCatalog(true);
    setOfficialCatalogRefreshError(null);
    setOfficialCatalogRefreshResult(null);
    try {
      const result = await refreshCodexOfficialModelCatalog();
      setOfficialCatalogRefreshResult(result);
      if (result.projectionApplied) {
        await queryClient.invalidateQueries({
          queryKey: ["providers", "codex"],
        });
        await queryClient.invalidateQueries({
          queryKey: ["codexMultiRouterProjection"],
        });
      }
    } catch (error) {
      setOfficialCatalogRefreshError(workspaceErrorMessage(error));
    } finally {
      setIsRefreshingOfficialCatalog(false);
    }
  }

  /// Codex Desktop 模型菜单还会被 renderer 白名单二次过滤；这里显式触发 CDP 注入/启动修复。
  async function unlockModelPicker() {
    setIsUnlockingModelPicker(true);
    setModelPickerUnlockError(null);
    try {
      const result = await proxyApi.unlockCodexModelPicker();
      setModelPickerUnlockResult(result);
    } catch (error) {
      setModelPickerUnlockError(workspaceErrorMessage(error));
    } finally {
      setIsUnlockingModelPicker(false);
    }
  }

  return (
    <div className="space-y-4">
      <StatusViewSwitcher
        value={statusView}
        diagnostics={diagnostics}
        protocolCount={protocolRows.length}
        trafficCount={
          requestTrafficRows.length + (subagentUsage?.modelStats.length ?? 0)
        }
        providerCount={selectedRoutes.length}
        onChange={setStatusView}
      />

      {statusView === "link" && (
        <>
          <section className="rounded-lg border border-border bg-card p-4 dark:border-slate-700 dark:bg-slate-950/40">
            <SectionHeader
              icon={Activity}
              title="Link status"
              detail="Start here: Codex requests enter MultiRouter only when the listener, takeover, route entry, and at least one matching rule all pass."
              action={
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={refreshValidationState}
                    disabled={isRefreshingValidation}
                    className="gap-2 border-slate-300 bg-background/70 text-slate-700 hover:bg-slate-50 dark:border-slate-500/50 dark:bg-slate-500/10 dark:text-slate-100 dark:hover:bg-slate-500/20"
                  >
                    <RefreshCw
                      className={cn(
                        "h-4 w-4",
                        isRefreshingValidation ? "animate-spin" : "",
                      )}
                    />
                    {isRefreshingValidation
                      ? "Refreshing"
                      : "Refresh validation"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => runDiagnostics("debug")}
                    disabled={isDiagnosing}
                    className="gap-2 border-amber-300 bg-background/70 text-amber-700 hover:bg-amber-50 dark:border-amber-500/50 dark:bg-amber-500/10 dark:text-amber-100 dark:hover:bg-amber-500/20"
                  >
                    {isDiagnosing ? (
                      <RefreshCw className="h-4 w-4 animate-spin" />
                    ) : (
                      <Bug className="h-4 w-4" />
                    )}
                    Debug check
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => runDiagnostics("protocol")}
                    disabled={isDiagnosing}
                    className="gap-2 border-cyan-300 bg-background/70 text-cyan-700 hover:bg-cyan-50 dark:border-cyan-500/50 dark:bg-cyan-500/10 dark:text-cyan-100 dark:hover:bg-cyan-500/20"
                  >
                    {isDiagnosing ? (
                      <RefreshCw className="h-4 w-4 animate-spin" />
                    ) : (
                      <GitBranch className="h-4 w-4" />
                    )}
                    Protocol probe
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={refreshOfficialCatalog}
                    disabled={isRefreshingOfficialCatalog}
                    className="gap-2 border-sky-300 bg-background/70 text-sky-700 hover:bg-sky-50 dark:border-sky-500/50 dark:bg-sky-500/10 dark:text-sky-100"
                  >
                    <RefreshCw
                      className={cn(
                        "h-4 w-4",
                        isRefreshingOfficialCatalog && "animate-spin",
                      )}
                    />
                    {isRefreshingOfficialCatalog
                      ? "Refreshing official catalog"
                      : "Force refresh official model catalog"}
                  </Button>
                  <TooltipProvider delayDuration={200}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          className="inline-flex"
                          title={MODEL_PICKER_UNLOCK_TOOLTIP}
                        >
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={unlockModelPicker}
                            disabled={isUnlockingModelPicker}
                            className="gap-2 border-indigo-300 bg-background/70 text-indigo-700 hover:bg-indigo-50 dark:border-indigo-500/50 dark:bg-indigo-500/10 dark:text-indigo-100 dark:hover:bg-indigo-500/20"
                          >
                            {isUnlockingModelPicker ? (
                              <RefreshCw className="h-4 w-4 animate-spin" />
                            ) : (
                              <Wand2 className="h-4 w-4" />
                            )}
                            Unlock model picker
                          </Button>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent
                        side="bottom"
                        align="end"
                        className="max-w-80 whitespace-normal text-left leading-5"
                      >
                        {MODEL_PICKER_UNLOCK_TOOLTIP}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  {selectedPlan ? (
                    <>
                      <Button
                        size="sm"
                        onClick={() =>
                          onEditPlan(
                            selectedPlan,
                            "Open MultiRouter configuration",
                          )
                        }
                        className="gap-2 bg-blue-600 hover:bg-blue-500"
                      >
                        <Pencil className="h-4 w-4" />
                        Edit configuration
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onDeletePlan(selectedPlan)}
                        className="gap-2 border-rose-300 bg-background/70 text-rose-700 hover:bg-rose-50 dark:border-rose-500/50 dark:bg-rose-500/10 dark:text-rose-100 dark:hover:bg-rose-500/20"
                      >
                        <Trash2 className="h-4 w-4" />
                        Delete
                      </Button>
                    </>
                  ) : null}
                </div>
              }
            />
            <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
              <StatusCard
                ok={linkOnline}
                label="Current link"
                value={
                  linkOnline
                    ? "Online"
                    : configReady
                      ? "Pending request verification"
                      : "Not ready"
                }
                detail={
                  linkOnline
                    ? "Codex requests enter the local proxy and are routed by model"
                    : configReady
                      ? "Config and listener are ready; waiting for successful forwarding from the current plan"
                      : readinessIssues.join("; ") ||
                        "Waiting for status refresh"
                }
              />
              <StatusCard
                ok={isProxyRunning}
                label="Listener"
                value={isProxyRunning ? "Success" : "Not started"}
                detail={listenAddress}
              />
              <StatusCard
                ok={isCodexTakeoverActive}
                label="Codex takeover"
                value={isCodexTakeoverActive ? "Taken over" : "Not taken over"}
                detail="Codex requests must target the local proxy to be routed"
              />
              <StatusCard
                ok={Boolean(selectedPlan && routeEnabled)}
                label="Route entry"
                value={
                  selectedPlan
                    ? routeEnabled
                      ? "Already Enabled"
                      : "Disabled"
                    : "Not selected"
                }
                detail={selectedPlan?.name ?? "No MultiRouter provider"}
              />
              <StatusCard
                ok={currentRouteForwardOk}
                label="Recent forwarding"
                value={
                  currentRouteForwardOk
                    ? "Current plan succeeded"
                    : latestLog
                      ? latestForwardOk
                        ? `Success ${latestLog.statusCode}`
                        : `Failures ${latestLog.statusCode}`
                      : "No requests yet"
                }
                detail={
                  currentRouteForwardOk
                    ? "Confirmed a current MultiRouter route hit and upstream forwarding completed"
                    : latestLog?.errorMessage ||
                      latestLog?.requestModel ||
                      latestLog?.model ||
                      "Waiting for a Codex request"
                }
              />
            </div>
            {linkOnline ? (
              <div
                role="status"
                className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm leading-6 text-emerald-800 dark:border-emerald-700/50 dark:bg-emerald-950/25 dark:text-emerald-100"
              >
                <div className="font-semibold">
                  MultiRouter verified with a real request
                </div>
                <div className="text-xs">
                  Current provider, proxy listener, and Codex takeover, route
                  entry, and latest routed forwarding are healthy. You can stay
                  on this status page to observe traffic or adjust routing.
                </div>
              </div>
            ) : null}
            {selectedPlan ? (
              <CodexProjectionStatusPanel
                status={projectionStatus}
                queryError={projectionError}
                retryError={projectionRetryError}
                isRefreshing={isRefreshingProjection || isRetryingProjection}
                onRetry={retryProjection}
              />
            ) : null}
            {validationRefreshMessage ? (
              <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs leading-5 text-slate-700 dark:border-slate-600/50 dark:bg-slate-900/60 dark:text-slate-200">
                {validationRefreshMessage}
              </div>
            ) : null}
            {guardianStatus?.active ? (
              <div
                className={cn(
                  "mt-3 rounded-lg border p-3 text-xs leading-5",
                  guardianStatus.injected
                    ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-700/50 dark:bg-emerald-950/25 dark:text-emerald-100"
                    : guardianStatus.cdpAvailable
                      ? "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-700/50 dark:bg-amber-950/25 dark:text-amber-100"
                      : "border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-600/50 dark:bg-slate-900/60 dark:text-slate-300",
                )}
              >
                <div className="font-semibold flex items-center gap-2">
                  <span
                    className={cn(
                      "inline-block h-2 w-2 rounded-full",
                      guardianStatus.injected
                        ? "bg-emerald-500"
                        : guardianStatus.cdpAvailable
                          ? "bg-amber-400"
                          : "bg-slate-400",
                    )}
                  />
                  Model picker guardian
                  {guardianStatus.injected
                    ? " · injected"
                    : guardianStatus.cdpAvailable
                      ? " · pending injection"
                      : " · polling"}
                </div>
                <div className="mt-1">{guardianStatus.message}</div>
                <div className="mt-1 font-mono text-[11px] opacity-80">
                  codex=
                  {guardianStatus.codexRunning ? "Running" : "Not running"} cdp=
                  {guardianStatus.cdpAvailable
                    ? "Available"
                    : "Unavailable"}{" "}
                  targets=
                  {guardianStatus.injectedTargetCount}
                </div>
              </div>
            ) : isCodexTakeoverActive ? (
              <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs leading-5 text-slate-600 dark:border-slate-600/50 dark:bg-slate-900/60 dark:text-slate-300">
                Model picker guardian is not running; re-enable Codex takeover
                to activate it.
              </div>
            ) : null}
            {officialCatalogRefreshError ? (
              <div
                role="alert"
                className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800 dark:border-rose-700/50 dark:bg-rose-950/25 dark:text-rose-100"
              >
                Official catalog refresh did not complete:
                {officialCatalogRefreshError}
                .The existing catalog is unchanged.
              </div>
            ) : null}
            {officialCatalogRefreshResult ? (
              <div
                role="status"
                className={cn(
                  "mt-3 rounded-lg border p-3 text-xs leading-5",
                  officialCatalogRefreshResult.projectionApplied
                    ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-700/50 dark:bg-emerald-950/25 dark:text-emerald-100"
                    : "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-700/50 dark:bg-amber-950/25 dark:text-amber-100",
                )}
              >
                <div className="font-semibold">
                  {officialCatalogRefreshResult.source === "unavailable" ||
                  officialCatalogRefreshResult.usedStaleCache
                    ? "Official catalog refresh failed"
                    : officialCatalogRefreshResult.projectionApplied
                      ? "Official catalog refreshed successfully; the takeover catalog was regenerated"
                      : "Official snapshot refreshed, but the takeover catalog was not updated"}
                </div>
                <div>
                  Source:
                  {officialCatalogRefreshResult.source ===
                  "openai_codex_models_json"
                    ? "OpenAI Codex models.json"
                    : officialCatalogRefreshResult.source === "stale_cache"
                      ? "CCSM legacy official snapshot"
                      : officialCatalogRefreshResult.source === "unavailable"
                        ? "No snapshot available"
                        : officialCatalogRefreshResult.source}
                  ; {officialCatalogRefreshResult.modelCount} models; refresh
                  time:
                  {officialCatalogRefreshResult.fetchedAt ?? "None"}.
                  {officialCatalogRefreshResult.usedStaleCache
                    ? "Using the previous cache for this run."
                    : ""}
                </div>
                {officialCatalogRefreshResult.refreshError ? (
                  <div>
                    Upstream refresh failed:
                    {officialCatalogRefreshResult.refreshError}
                  </div>
                ) : null}
                {officialCatalogRefreshResult.projectionApplied ? (
                  <div>
                    Refresh the Codex model picker; if Desktop does not
                    hot-reload the new catalog, create a new task and check
                    again.
                  </div>
                ) : officialCatalogRefreshResult.projectionReason ===
                    "projection_failed" ||
                  officialCatalogRefreshResult.projectionReason ===
                    "projection_outputs_unconfirmed" ? (
                  <div>
                    Catalog regeneration failed; dual-catalog sync was not
                    confirmed. Outputs may be partially changed; inspect
                    diagnostics before use.
                  </div>
                ) : (
                  <div>
                    The generated Codex catalog was not modified in this run
                    {officialCatalogRefreshResult.projectionReason
                      ? ` (${
                          {
                            takeover_not_active: "Codex takeover is disabled",
                            catalog_not_cc_switch_owned:
                              "The current catalog is not managed by CCSwitchMulti",
                            refresh_failed: "upstream refresh failures",
                            projection_failed: "Catalog regeneration failed",
                            projection_outputs_unconfirmed:
                              "Dual-catalog update status was not confirmed",
                          }[officialCatalogRefreshResult.projectionReason] ??
                          officialCatalogRefreshResult.projectionReason
                        })`
                      : ""}
                    The snapshot update must not be treated as active runtime
                    state.
                  </div>
                )}
              </div>
            ) : null}
            {!modelPickerUnlockResult ? (
              <div className="mt-3 rounded-lg border border-indigo-200 bg-indigo-50 p-3 text-xs leading-5 text-indigo-800 dark:border-indigo-700/50 dark:bg-indigo-950/25 dark:text-indigo-100">
                {MODEL_PICKER_UNLOCK_HINT}
              </div>
            ) : null}
            {modelPickerUnlockError ? (
              <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs leading-5 text-rose-700 dark:border-rose-700/50 dark:bg-rose-950/30 dark:text-rose-100">
                Model picker unlock failed:{modelPickerUnlockError}
              </div>
            ) : null}
            {modelPickerUnlockResult ? (
              <div
                className={cn(
                  "mt-3 rounded-lg border p-3 text-xs leading-5",
                  modelPickerUnlockResult.injected
                    ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-700/50 dark:bg-emerald-950/25 dark:text-emerald-100"
                    : "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-700/50 dark:bg-amber-950/25 dark:text-amber-100",
                )}
              >
                <div className="font-semibold">
                  {modelPickerUnlockResult.injected
                    ? "Model picker allowlist injected"
                    : "Model picker allowlist not injected"}
                </div>
                <div className="mt-1">{modelPickerUnlockResult.message}</div>
                <div className="mt-1 font-mono text-[11px] opacity-80">
                  models={modelPickerUnlockResult.modelCount} port=
                  {modelPickerUnlockResult.debugPort ?? "-"} launched=
                  {String(modelPickerUnlockResult.launched)}
                </div>
                {modelPickerUnlockResult.codexExecutable ? (
                  <div className="mt-2 rounded-md border border-current/20 bg-white/40 p-2 text-[11px] leading-5 dark:bg-black/10">
                    Codex Desktop main process:
                    <span className="font-mono break-all">
                      {modelPickerUnlockResult.codexExecutable}
                    </span>
                    {!modelPickerUnlockResult.injected
                      ? "The Desktop path was captured. Fully exit Codex Desktop, then click “Unlock model picker” again so CCSwitchMulti starts the same Desktop with remote debugging. After successful injection, switching third-party API keys does not require unlocking again; CLI/app-server continues using live config, model_catalog_json, and the local /v1/models path."
                      : ""}
                  </div>
                ) : null}
              </div>
            ) : null}
            <div className="mt-4 grid gap-3 text-sm md:grid-cols-3">
              <DetailRow
                label="Current proxy target"
                value={activeTargetLabel}
              />
              <DetailRow
                label="Enabled matching rules"
                value={`${selectedRoutes.filter(({ route }) => route.enabled !== false).length} / ${selectedRoutes.length}`}
              />
              <DetailRow
                label="Total proxy requests"
                value={`${proxyStatus?.total_requests ?? 0}  requests, success rate  ${proxyStatus?.success_rate ?? 0}%`}
              />
            </div>
            <div className="mt-3">
              <DetailRow
                label="Latest error"
                value={
                  proxyStatus?.last_error || latestLog?.errorMessage || "None"
                }
              />
            </div>
          </section>
        </>
      )}

      {statusView === "debug" && (
        <DiagnosticsPanel
          diagnostics={diagnostics}
          isLoading={isDiagnosing}
          error={diagnoseError}
          onRun={() => runDiagnostics("debug")}
        />
      )}

      {statusView === "request-health" && (
        <RequestHealthPanel
          snapshot={requestHealthSnapshot}
          isRefreshing={requestHealthLoading}
          onRefresh={() => void refreshRequestHealth()}
          onSaved={() => void refreshRequestHealth()}
        />
      )}

      {statusView === "stream-retry" && <StreamRetryActivityPanel />}

      {statusView === "protocol" && (
        <section className="rounded-lg border border-cyan-200 bg-cyan-50/70 p-4 dark:border-cyan-700/40 dark:bg-cyan-950/10">
          <SectionHeader
            icon={GitBranch}
            title="Protocol probe"
            detail="Configured protocol comes from the shared backend decision; latest observed protocol comes from request_prepared logs and shows whether a model last used Responses, Chat, or Messages."
            action={
              <Button
                size="sm"
                variant="outline"
                onClick={() => runDiagnostics("protocol")}
                disabled={isDiagnosing}
                className="gap-2 border-cyan-300 bg-background/70 text-cyan-700 hover:bg-cyan-50 dark:border-cyan-500/50 dark:bg-cyan-500/10 dark:text-cyan-100 dark:hover:bg-cyan-500/20"
              >
                {isDiagnosing ? (
                  <RefreshCw className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                Probe again
              </Button>
            }
          />
          {!diagnostics && !isDiagnosing ? (
            <div className="mt-3 rounded-lg border border-border bg-muted/40 p-4 text-sm leading-6 text-muted-foreground dark:border-slate-700 dark:bg-slate-950/50 dark:text-slate-300">
              No protocol probe has run yet. Click the button in the upper right
              to read current MultiRouter routes and recent router logs, then
              show each model’s configured and latest observed outbound
              protocol.
            </div>
          ) : null}
          {protocolRows.length > 0 ? (
            <div className="mt-3 overflow-hidden rounded-lg border border-border dark:border-slate-700">
              <div className="grid grid-cols-[1.1fr_1fr_1fr_1fr_1.4fr] gap-2 bg-muted px-3 py-2 text-xs font-semibold text-muted-foreground dark:bg-slate-900/80 dark:text-slate-300">
                <span>Provider / Route</span>
                <span>Model</span>
                <span>Configured</span>
                <span>Latest observed</span>
                <span>Source</span>
              </div>
              {protocolRows.map((row) => (
                <div
                  key={`protocol-${row.providerId}-${row.model}`}
                  className="grid grid-cols-[1.1fr_1fr_1fr_1fr_1.4fr] gap-2 border-t border-border px-3 py-2 text-xs text-foreground dark:border-slate-800 dark:text-slate-300"
                >
                  <div className="min-w-0">
                    <div className="truncate">{row.providerName}</div>
                    <div className="truncate text-[11px] text-muted-foreground dark:text-slate-500">
                      {routeSummaryDisplayName(
                        row.routeLabel,
                        row.routeId,
                        row.providerName,
                      )}
                    </div>
                  </div>
                  <span className="truncate font-mono">{row.model}</span>
                  <div className="min-w-0">
                    <div className="truncate">
                      {row.configuredProtocol
                        ? apiFormatLabel(row.configuredProtocol)
                        : "Pending probe"}
                    </div>
                    <div
                      className="truncate text-[11px] text-muted-foreground dark:text-slate-500"
                      title={row.configuredProtocolDetail ?? undefined}
                    >
                      {protocolDecisionSourceLabel(
                        row.configuredProtocolSource,
                      )}
                    </div>
                  </div>
                  <div className="min-w-0">
                    <div className="truncate">
                      {row.lastObservedProtocol
                        ? apiFormatLabel(row.lastObservedProtocol)
                        : "No observation yet"}
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground dark:text-slate-500">
                      {row.lastObservedAt ?? "Waiting for a new request"}
                    </div>
                  </div>
                  <div className="min-w-0">
                    <div
                      className="truncate"
                      title={
                        row.lastObservedUpstreamUrl ??
                        row.lastObservedEndpoint ??
                        row.configuredProtocolDetail ??
                        undefined
                      }
                    >
                      {row.lastObservedUpstreamUrl ??
                        row.lastObservedEndpoint ??
                        row.configuredProtocolDetail ??
                        "None"}
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground dark:text-slate-500">
                      Recent requests {row.requestCount} requests, failures{" "}
                      {row.failedCount} times
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : diagnostics ? (
            <div className="mt-3 rounded-lg border border-border bg-muted/40 p-4 text-sm leading-6 text-muted-foreground dark:border-slate-700 dark:bg-slate-950/50 dark:text-slate-300">
              No attributable protocol probe results. Loaded{" "}
              {selectedRoutes.length}
              routes and {routerRequestEvents.length} router events. Have Codex
              make a real request, then probe again.
            </div>
          ) : null}
        </section>
      )}

      {statusView === "providers" && (
        <section className="rounded-lg border border-blue-200 bg-blue-50/70 p-4 dark:border-blue-700/40 dark:bg-blue-950/15">
          <SectionHeader
            icon={GitFork}
            title="Routed child providers"
            detail="These child providers come from current MultiRouter route targets; the adapter follows each provider config."
          />
          <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {selectedRoutes.map((entry) => {
              const targetProviderId = routeTargetProviderId(entry.route);
              const targetProvider = routeTargetProvider(
                entry.route,
                providersById,
              );
              return (
                <div
                  key={`${entry.provider.id}-${entry.route.id ?? entry.index}`}
                  className="rounded-lg border border-border bg-card p-3 dark:border-slate-700 dark:bg-slate-950/50"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-foreground dark:text-slate-100">
                        {targetProvider?.name ??
                          targetProviderId ??
                          "Inline upstream"}
                      </div>
                      <div className="mt-1 truncate text-xs text-muted-foreground dark:text-slate-400">
                        {routeDisplayName(entry.route, providersById)}
                      </div>
                    </div>
                    <Badge
                      className={cn(
                        "border",
                        entry.route.enabled === false
                          ? "border-slate-500/50 bg-slate-500/10 text-slate-200"
                          : "border-emerald-500/50 bg-emerald-500/15 text-emerald-100",
                      )}
                    >
                      {entry.route.enabled === false
                        ? "Disabled"
                        : "Already Enabled"}
                    </Badge>
                  </div>
                  <div className="mt-3 text-xs leading-5 text-muted-foreground dark:text-slate-400">
                    {routeMatchSummary(entry.route)}
                  </div>
                </div>
              );
            })}
            {selectedRoutes.length === 0 && (
              <EmptyState
                icon={Route}
                title="No routing rules yet"
                detail="After adding routes, each child provider and its models appear here."
                actionLabel="Edit MultiRouter"
                onAction={() => selectedPlan && onEditPlan(selectedPlan)}
              />
            )}
          </div>
        </section>
      )}

      {statusView === "traffic" && (
        <div className="space-y-4">
          <CodexSessionTrafficPanel
            stats={subagentUsage}
            isLoading={isLoadingSubagentUsage}
            error={subagentUsageError}
            rangeLabel={`${getUsageRangePresetLabel(range.preset, (_key, options) => options?.defaultValue ?? "Today")} (local calendar day)`}
            isSyncing={isSyncingSessionUsage}
            onSync={() => void syncCodexSessionUsage()}
            syncMessage={sessionSyncMessage}
            collectionStatus={collectionStatus}
            collectionStatusError={collectionStatusError}
          />
          <section className="rounded-lg border border-emerald-200 bg-emerald-50/70 p-4 dark:border-emerald-700/40 dark:bg-emerald-950/10">
            <SectionHeader
              icon={Database}
              title="Today’s recent request samples (child provider / model)"
              detail="Shows only the latest 50 loaded Codex request samples for today, not the full-day total; requestModel attribution is for reference and does not confirm the actual upstream."
            />
            <div className="mt-3 overflow-hidden rounded-lg border border-border dark:border-slate-700">
              <div className="grid grid-cols-[1.1fr_1.1fr_0.55fr_0.55fr_0.7fr_0.7fr_0.7fr_0.7fr_0.65fr] gap-2 bg-muted px-3 py-2 text-xs font-semibold text-muted-foreground dark:bg-slate-900/80 dark:text-slate-300">
                <span>Provider</span>
                <span>Model</span>
                <span className="text-right">Requests</span>
                <span className="text-right">Failures</span>
                <span className="text-right">Uncached input</span>
                <span className="text-right">Cache read</span>
                <span className="text-right">Cache write</span>
                <span className="text-right">Output</span>
                <span className="text-right">Latency</span>
              </div>
              {isLoading ? (
                <div className="p-4 text-sm text-muted-foreground">
                  Loading statistics…
                </div>
              ) : requestTrafficRows.length > 0 ? (
                requestTrafficRows.map((row) => (
                  <div
                    key={`${row.providerId}-${row.model}`}
                    className="grid grid-cols-[1.1fr_1.1fr_0.55fr_0.55fr_0.7fr_0.7fr_0.7fr_0.7fr_0.65fr] gap-2 border-t border-border px-3 py-2 text-xs text-foreground dark:border-slate-800 dark:text-slate-300"
                  >
                    <span className="truncate">{row.providerName}</span>
                    <span className="truncate font-mono">{row.model}</span>
                    <span className="text-right">{row.requestCount}</span>
                    <span className="text-right">{row.failedCount}</span>
                    <span className="text-right">
                      {row.inputTokens.toLocaleString()}
                    </span>
                    <span className="text-right">
                      {row.cacheReadTokens.toLocaleString()}
                    </span>
                    <span className="text-right">
                      {row.cacheCreationTokens.toLocaleString()}
                    </span>
                    <span className="text-right">
                      {row.outputTokens.toLocaleString()}
                    </span>
                    <span className="text-right">{row.avgLatencyMs}ms</span>
                  </div>
                ))
              ) : (
                <div className="p-4 text-sm leading-6 text-muted-foreground">
                  No request logs can currently be attributed to child
                  providers. Today’s Codex logs contain
                  {logs.length} entries, including {proxyLogs.length} real
                  proxy-forwarding entries, {sessionLogs.length} Codex
                  session-sync entries, and outer MultiRouter logs (
                  {routerLogs.length}); target provider count:
                  {routeTargetCount}.
                </div>
              )}
            </div>
            <div className="mt-3 text-xs text-muted-foreground">
              Loaded {logs.length} entries (API total
              {requestLogs?.total ?? logs.length}) of today’s Codex request
              samples; {routedLogs.length} entries attempted real proxy
              attribution and router diagnostics contain{" "}
              {routerRequestEvents.length} events. Diagnostic events are not
              usage records; codex_session history sync is not forwarding and is
              not added to session statistics.
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

/// 测试发布页只做本地匹配预览，并展示下一步如何发布到 Codex。
function TestTab({
  selectedPlan,
  selectedRouting,
  routeModels,
  testModel,
  testResult,
  onModelChange,
  onPreviewRoute,
  onEditPlan,
}: {
  selectedPlan: Provider | null;
  selectedRouting: CodexRouting | null;
  routeModels: string[];
  testModel: string;
  testResult: string | null;
  onModelChange: (value: string) => void;
  onPreviewRoute: () => void;
  onEditPlan: (provider: Provider, detail?: string) => void;
}) {
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_420px]">
      <section className="rounded-lg border border-purple-200 bg-purple-50/70 p-4 dark:border-purple-700/40 dark:bg-purple-950/10">
        <SectionHeader
          icon={Play}
          title="Match preview"
          detail="Enter the model from a Codex request to preview the matching rule locally."
        />
        <div className="mt-4 grid gap-3 md:grid-cols-[1fr_auto]">
          <input
            value={testModel}
            onChange={(event) => onModelChange(event.target.value)}
            placeholder="For example: gpt-5.4-mini, qwen3.6, deepseek-v4-flash"
            className="h-10 rounded-md border border-purple-200 bg-background px-3 text-sm outline-none transition placeholder:text-muted-foreground focus:border-purple-400 focus:ring-2 focus:ring-purple-500/20 dark:border-purple-700/50 dark:bg-slate-950/70 dark:placeholder:text-slate-500 dark:focus:ring-purple-500/30"
          />
          <Button
            onClick={onPreviewRoute}
            className="gap-2 bg-purple-600 hover:bg-purple-500"
          >
            <Play className="h-4 w-4" />
            Preview match
          </Button>
        </div>
        {routeModels.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {routeModels.slice(0, 10).map((model) => (
              <button
                key={model}
                type="button"
                onClick={() => onModelChange(model.replace(/\*$/, ""))}
                className="rounded-full border border-purple-200 bg-purple-50 px-3 py-1 text-xs text-purple-800 transition hover:border-purple-300 hover:bg-purple-100 dark:border-purple-500/40 dark:bg-purple-500/10 dark:text-purple-100 dark:hover:bg-purple-500/20"
              >
                {model}
              </button>
            ))}
          </div>
        )}
        <div className="mt-4 rounded-lg border border-purple-200 bg-background/80 p-4 dark:border-purple-700/40 dark:bg-slate-950/50">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <Activity className="h-4 w-4 text-purple-600 dark:text-purple-300" />
            Preview result
          </div>
          <p className="text-sm leading-6 text-muted-foreground dark:text-slate-300">
            {testResult ??
              "No preview run yet. This does not call a real upstream or consume quota."}
          </p>
        </div>
      </section>

      <section className="rounded-lg border border-emerald-200 bg-emerald-50/70 p-4 dark:border-emerald-700/40 dark:bg-emerald-950/10">
        <SectionHeader
          icon={RadioTower}
          title="Publish checklist"
          detail="Confirm this before saving in the configuration form."
          action={
            selectedPlan ? (
              <Button
                size="sm"
                onClick={() =>
                  onEditPlan(
                    selectedPlan,
                    "Open pre-publish configuration check",
                  )
                }
                className="gap-2 bg-emerald-600 hover:bg-emerald-500"
              >
                <Pencil className="h-4 w-4" />
                Edit MultiRouter
              </Button>
            ) : null
          }
        />
        <div className="mt-4 space-y-3">
          <ChecklistItem
            ok={Boolean(selectedPlan)}
            label="MultiRouter selected"
          />
          <ChecklistItem
            ok={selectedRouting?.enabled !== false}
            label="MultiRouter is enabled"
          />
          <ChecklistItem ok label="Unmatched models will be rejected" />
          <ChecklistItem
            ok={(selectedRouting?.routes?.length ?? 0) > 0}
            label="At least one route rule exists"
          />
          <ChecklistItem
            ok
            label="The current Codex provider will not change"
          />
        </div>
      </section>
    </div>
  );
}

/// 状态页内部的分段切换；一次只展开一个信息域，避免 Debug、Provider 和流量表挤在同一屏。
function StatusViewSwitcher({
  value,
  diagnostics,
  protocolCount,
  trafficCount,
  providerCount,
  onChange,
}: {
  value: StatusView;
  diagnostics: CodexMultiRouterDiagnostics | null;
  protocolCount: number;
  trafficCount: number;
  providerCount: number;
  onChange: (value: StatusView) => void;
}) {
  const failedCount =
    diagnostics?.checks.filter((check) => check.status === "fail").length ?? 0;
  const warnCount =
    diagnostics?.checks.filter((check) => check.status === "warn").length ?? 0;
  const debugBadge = diagnostics
    ? failedCount > 0
      ? `${failedCount} blocking`
      : warnCount > 0
        ? `${warnCount} Warnings`
        : "Checked"
    : "Not checked";

  const { t } = useTranslation();
  const items: Array<{
    value: StatusView;
    icon: React.ComponentType<{ className?: string }>;
    label: string;
    detail: string;
  }> = [
    {
      value: "link",
      icon: Activity,
      label: "Link",
      detail: "Listener / takeover / Entry",
    },
    {
      value: "protocol",
      icon: GitBranch,
      label: "Protocol",
      detail: `${protocolCount}  models`,
    },
    {
      value: "debug",
      icon: Bug,
      label: "Debug",
      detail: debugBadge,
    },
    {
      value: "providers",
      icon: GitFork,
      label: "Routing",
      detail: `${providerCount} targets`,
    },
    {
      value: "traffic",
      icon: Database,
      label: "Traffic",
      detail: `${trafficCount}  groupsstatistics`,
    },
    {
      value: "request-health",
      icon: ShieldCheck,
      label: t("settings.requestHealth.title"),
      detail: t("settings.requestHealth.monitoring"),
    },
    {
      value: "stream-retry",
      icon: RefreshCw,
      label: t("streamRetry.activity.tab", { defaultValue: "Stream retry" }),
      detail: t("streamRetry.activity.tabDescription", {
        defaultValue: "Live reconnect activity",
      }),
    },
  ];

  return (
    <div className="rounded-lg border border-border bg-card p-2 dark:border-slate-700 dark:bg-slate-950/40">
      <div className="grid gap-2 md:grid-cols-3 xl:grid-cols-7">
        {items.map((item) => {
          const Icon = item.icon;
          const active = value === item.value;
          return (
            <button
              key={item.value}
              type="button"
              onClick={() => onChange(item.value)}
              className={cn(
                "flex min-w-0 items-center gap-3 rounded-md border px-3 py-2 text-left transition",
                active
                  ? "border-blue-400 bg-blue-50 text-blue-800 dark:border-blue-500/60 dark:bg-blue-600/20 dark:text-blue-100"
                  : "border-border bg-background text-muted-foreground hover:border-blue-300 hover:bg-blue-50 dark:border-slate-700 dark:bg-slate-950/40 dark:text-slate-300 dark:hover:border-blue-500/50 dark:hover:bg-blue-950/20",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold">
                  {item.label}
                </span>
                <span className="block truncate text-xs opacity-70">
                  {item.detail}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/// MultiRouter Debug 面板展示后端真实检查结果，重点区分“没进入本地路由”和“进入后上游失败”。
function DiagnosticsPanel({
  diagnostics,
  isLoading,
  error,
  onRun,
}: {
  diagnostics: CodexMultiRouterDiagnostics | null;
  isLoading: boolean;
  error: string | null;
  onRun: () => void;
}) {
  const failedChecks =
    diagnostics?.checks.filter((check) => check.status === "fail") ?? [];
  const warningChecks =
    diagnostics?.checks.filter((check) => check.status === "warn") ?? [];
  const visibleCheckCards =
    diagnostics?.checks.filter(
      (check) => check.status !== "fail" && check.status !== "warn",
    ) ?? [];

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50/70 p-4 dark:border-amber-600/40 dark:bg-amber-950/10">
      <SectionHeader
        icon={Bug}
        title="Debug check"
        detail="Checks the local listener, Codex live config, WebSocket fallback, route rules, and router logs without sending model requests upstream."
        action={
          <Button
            size="sm"
            variant="outline"
            onClick={onRun}
            disabled={isLoading}
            className="gap-2 border-amber-300 bg-background/70 text-amber-700 hover:bg-amber-50 dark:border-amber-500/50 dark:bg-amber-500/10 dark:text-amber-100 dark:hover:bg-amber-500/20"
          >
            {isLoading ? (
              <RefreshCw className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Recheck
          </Button>
        }
      />

      {error && (
        <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-100">
          {error}
        </div>
      )}

      {!diagnostics && !error && (
        <div className="mt-3 rounded-lg border border-border bg-muted/40 p-3 text-sm leading-6 text-muted-foreground dark:border-slate-700 dark:bg-slate-950/50 dark:text-slate-300">
          No debug check is running yet. Click the button to read the live Codex
          config and local routing logs and confirm whether requests enter
          MultiRouter.
        </div>
      )}

      {diagnostics && (
        <div className="mt-4 space-y-4">
          <div
            className={cn(
              "rounded-lg border p-3",
              diagnostics.ready
                ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-100"
                : "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-100",
            )}
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold">
                  {diagnostics.ready
                    ? "Critical link passed"
                    : "Blocking items found"}
                </div>
                <div className="mt-1 text-xs leading-5 opacity-80">
                  {diagnostics.nextAction}
                </div>
              </div>
              <Badge
                className={cn(
                  "border",
                  diagnostics.ready
                    ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/50 dark:bg-emerald-500/15 dark:text-emerald-100"
                    : "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/50 dark:bg-rose-500/15 dark:text-rose-100",
                )}
              >
                {diagnostics.generatedAt}
              </Badge>
            </div>
          </div>

          {(failedChecks.length > 0 || warningChecks.length > 0) && (
            <div className="grid gap-3 md:grid-cols-2">
              {failedChecks.length > 0 && (
                <DebugIssueList
                  title="Blocking items"
                  tone="fail"
                  items={diagnostics.blockingIssues}
                />
              )}
              {warningChecks.length > 0 && (
                <DebugIssueList
                  title="Warnings"
                  tone="warn"
                  items={diagnostics.warnings}
                />
              )}
            </div>
          )}

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {visibleCheckCards.map((check) => (
              <DiagnosticCheckCard key={check.id} check={check} />
            ))}
          </div>

          <div className="grid gap-3 text-sm xl:grid-cols-4">
            <div className="rounded-lg border border-border bg-card p-3 dark:border-slate-700 dark:bg-slate-950/50">
              <div className="mb-3 flex items-center gap-2 font-semibold text-foreground dark:text-slate-100">
                <Settings2 className="h-4 w-4 text-blue-600 dark:text-blue-300" />
                Codex Live Config
              </div>
              <div className="space-y-2">
                <DetailRow
                  label="Config file"
                  value={diagnostics.liveConfig.path}
                />
                <DetailRow
                  label="model_provider"
                  value={diagnostics.liveConfig.modelProvider ?? "Not set"}
                />
                <DetailRow
                  label="active base_url"
                  value={diagnostics.liveConfig.activeBaseUrl ?? "Not set"}
                />
                <DetailRow
                  label="supports_websockets"
                  value={String(diagnostics.liveConfig.supportsWebsockets)}
                />
                <DetailRow
                  label="wire_api"
                  value={diagnostics.liveConfig.wireApi ?? "Not set"}
                />
                <DetailRow
                  label="model_catalog_json"
                  value={diagnostics.liveConfig.modelCatalogJson ?? "Not set"}
                />
                <DetailRow
                  label="catalog model count"
                  value={
                    diagnostics.liveConfig.modelCatalogModelCount == null
                      ? "Unknown"
                      : `${diagnostics.liveConfig.modelCatalogModelCount}`
                  }
                />
                <DetailRow
                  label="config modified time"
                  value={diagnostics.liveConfig.configModifiedAt ?? "Unknown"}
                />
                <DetailRow
                  label="catalog modified time"
                  value={
                    diagnostics.liveConfig.modelCatalogModifiedAt ?? "Unknown"
                  }
                />
              </div>
            </div>

            <div className="rounded-lg border border-border bg-card p-3 dark:border-slate-700 dark:bg-slate-950/50">
              <div className="mb-3 flex items-center gap-2 font-semibold text-foreground dark:text-slate-100">
                <Server className="h-4 w-4 text-violet-600 dark:text-violet-300" />
                Codex Desktop
              </div>
              <div className="space-y-2">
                <DetailRow
                  label="Processes"
                  value={
                    diagnostics.desktopRuntime?.running
                      ? `${diagnostics.desktopRuntime.processCount}  items`
                      : "Not detected"
                  }
                />
                <DetailRow
                  label="app-server"
                  value={
                    diagnostics.desktopRuntime?.appServerRunning
                      ? `${diagnostics.desktopRuntime.appServerCount}  items`
                      : "Not detected"
                  }
                />
                <DetailRow
                  label="Latest app-server start"
                  value={
                    diagnostics.desktopRuntime?.newestAppServerStartedAt ??
                    "Unknown"
                  }
                />
                <DetailRow
                  label="stale catalog"
                  value={
                    diagnostics.desktopRuntime?.mayHaveStaleModelCatalog
                      ? "Possible"
                      : "Not found"
                  }
                />
                <DetailRow
                  label="Detection error"
                  value={diagnostics.desktopRuntime?.detectionError ?? "None"}
                />
              </div>
            </div>

            <div className="rounded-lg border border-border bg-card p-3 dark:border-slate-700 dark:bg-slate-950/50">
              <div className="mb-3 flex items-center gap-2 font-semibold text-foreground dark:text-slate-100">
                <Route className="h-4 w-4 text-emerald-600 dark:text-emerald-300" />
                Route Plan
              </div>
              <div className="space-y-2">
                <DetailRow
                  label="Provider"
                  value={
                    diagnostics.routePlan.providerName ??
                    diagnostics.routePlan.providerId ??
                    "Not found"
                  }
                />
                <DetailRow
                  label="Entry status"
                  value={
                    diagnostics.routePlan.routingEnabled
                      ? "Enabled"
                      : "Disabled"
                  }
                />
                <DetailRow
                  label="Enabled rules"
                  value={`${diagnostics.routePlan.enabledRouteCount} / ${diagnostics.routePlan.routeCount}`}
                />
                <DetailRow
                  label="legacyDefaultRouted (Disabled)"
                  value={(() => {
                    const defaultRoute =
                      diagnostics.routePlan.routeSummaries.find(
                        (route) =>
                          route.id === diagnostics.routePlan.defaultRouteId,
                      );
                    const displayName = routeSummaryDisplayName(
                      defaultRoute?.label,
                      diagnostics.routePlan.defaultRouteId,
                      defaultRoute?.targetProviderName,
                      "None",
                    );
                    return diagnostics.routePlan.defaultRouteId
                      ? `${displayName} (not used for forwarding)`
                      : displayName;
                  })()}
                />
              </div>
            </div>

            <div className="rounded-lg border border-border bg-card p-3 dark:border-slate-700 dark:bg-slate-950/50">
              <div className="mb-3 flex items-center gap-2 font-semibold text-foreground dark:text-slate-100">
                <FileClock className="h-4 w-4 text-amber-600 dark:text-amber-300" />
                Router Log
              </div>
              <div className="space-y-2">
                <DetailRow
                  label="Log file"
                  value={diagnostics.routerLog.exists ? "Exists" : "Missing"}
                />
                <DetailRow
                  label="Scanned events"
                  value={`${diagnostics.routerLog.totalScanned}`}
                />
                <DetailRow
                  label="Matches current router"
                  value={`${diagnostics.routerLog.matchedScanned}`}
                />
                <DetailRow
                  label="Recent requests"
                  value={diagnostics.routerLog.latestRequestAt ?? "None"}
                />
                <DetailRow
                  label="Latest error"
                  value={diagnostics.routerLog.latestError ?? "None"}
                />
                <DetailRow
                  label="Hosted tool not called"
                  value={
                    diagnostics.routerLog.latestHostedToolWarning ?? "None"
                  }
                />
              </div>
            </div>
          </div>

          {diagnostics.routePlan.routeSummaries.length > 0 && (
            <div className="overflow-hidden rounded-lg border border-border dark:border-slate-700">
              <div className="grid grid-cols-[1fr_1fr_1fr_1fr_0.8fr] gap-2 bg-muted px-3 py-2 text-xs font-semibold text-muted-foreground dark:bg-slate-900/80 dark:text-slate-300">
                <span>Rule</span>
                <span>Target provider</span>
                <span>Configured protocol</span>
                <span>Decision source</span>
                <span>model</span>
              </div>
              {diagnostics.routePlan.routeSummaries.map((route, index) => (
                <div
                  key={`${route.id ?? index}-${route.targetProviderId ?? "inline"}`}
                  className="grid grid-cols-[1fr_1fr_1fr_1fr_0.8fr] gap-2 border-t border-border px-3 py-2 text-xs text-foreground dark:border-slate-800 dark:text-slate-300"
                >
                  <span className="truncate">
                    {routeSummaryDisplayName(
                      route.label,
                      route.id,
                      route.targetProviderName,
                      `Rule ${index + 1}`,
                    )}
                    {route.enabled ? "" : "(disabled)"}
                  </span>
                  <span className="truncate">
                    {route.targetProviderName ??
                      route.targetProviderId ??
                      "Inline config"}
                    {route.targetProviderId && !route.targetExists
                      ? " (Missing)"
                      : ""}
                  </span>
                  <span
                    className="truncate"
                    title={route.configuredProtocolDetail ?? undefined}
                  >
                    {route.configuredProtocol
                      ? apiFormatLabel(route.configuredProtocol)
                      : (route.apiFormat ?? "Follow")}
                  </span>
                  <span className="truncate">
                    {protocolDecisionSourceLabel(
                      route.configuredProtocolSource,
                    )}
                  </span>
                  <span className="truncate">
                    {[
                      ...route.models,
                      ...route.prefixes.map((prefix) => `${prefix}*`),
                    ]
                      .slice(0, 3)
                      .join(", ") || "Default"}
                  </span>
                </div>
              ))}
            </div>
          )}

          {diagnostics.routerLog.recentEvents.length > 0 && (
            <div className="overflow-hidden rounded-lg border border-border dark:border-slate-700">
              <div className="grid grid-cols-[1fr_0.9fr_0.8fr_0.9fr_0.6fr_1.6fr] gap-2 bg-muted px-3 py-2 text-xs font-semibold text-muted-foreground dark:bg-slate-900/80 dark:text-slate-300">
                <span>Time</span>
                <span>Event</span>
                <span>Protocol</span>
                <span>Provider</span>
                <span>Status</span>
                <span>Summary</span>
              </div>
              {diagnostics.routerLog.recentEvents.slice(0, 12).map((event) => (
                <div
                  key={`${event.timestamp}-${event.event}-${event.line}`}
                  className="grid grid-cols-[1fr_0.9fr_0.8fr_0.9fr_0.6fr_1.6fr] gap-2 border-t border-border px-3 py-2 text-xs text-foreground dark:border-slate-800 dark:text-slate-300"
                >
                  <span className="truncate">{event.timestamp}</span>
                  <span className="truncate font-mono">{event.event}</span>
                  <span className="truncate">
                    {event.actualProtocol
                      ? apiFormatLabel(event.actualProtocol)
                      : "-"}
                  </span>
                  <span className="truncate">
                    {event.outerProvider && event.effectiveProvider
                      ? `${event.outerProvider} -> ${event.effectiveProvider}`
                      : (event.provider ?? "-")}
                  </span>
                  <span className="truncate">{event.status ?? "-"}</span>
                  <span
                    className="truncate"
                    title={event.upstreamUrl ?? event.line}
                  >
                    {event.error ??
                      (event.event === "hosted_tool_not_called"
                        ? `${event.tool ?? "hosted tool"}: ${event.reason ?? "upstream did not make a call"}`
                        : null) ??
                      event.upstreamUrl ??
                      event.model ??
                      event.line}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/// Debug 阻塞项/警告列表，避免用户在检查卡片里逐项翻找最关键结论。
function DebugIssueList({
  title,
  tone,
  items,
}: {
  title: string;
  tone: "fail" | "warn";
  items: string[];
}) {
  return (
    <div
      className={cn(
        "rounded-lg border p-3 text-sm",
        tone === "fail"
          ? "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-100"
          : "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100",
      )}
    >
      <div className="mb-2 font-semibold">{title}</div>
      <div className="space-y-1 text-xs leading-5 opacity-85">
        {items.map((item) => (
          <div key={item}>{item}</div>
        ))}
      </div>
    </div>
  );
}

/// 单个 Debug 检查项卡片，展示状态、说明和后端返回的关键证据。
function DiagnosticCheckCard({ check }: { check: CodexDiagnosticCheck }) {
  const meta = diagnosticStatusMeta(check.status);
  const Icon = meta.icon;

  return (
    <div className={cn("rounded-lg border p-3", meta.className)}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{check.label}</div>
          <div className="mt-1 text-xs leading-5 opacity-80">
            {check.detail}
          </div>
        </div>
        <Icon className="h-4 w-4 shrink-0 opacity-85" />
      </div>
      {check.evidence.length > 0 && (
        <div className="mt-2 space-y-1 font-mono text-[11px] opacity-70">
          {check.evidence.slice(0, 3).map((item) => (
            <div key={item} className="truncate" title={item}>
              {item}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/// 将后端诊断状态映射成 UI 颜色和图标。
function diagnosticStatusMeta(status: CodexDiagnosticStatus): {
  icon: React.ComponentType<{ className?: string }>;
  className: string;
} {
  switch (status) {
    case "pass":
      return {
        icon: CheckCircle2,
        className:
          "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-100",
      };
    case "warn":
      return {
        icon: AlertTriangle,
        className:
          "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100",
      };
    case "fail":
      return {
        icon: XCircle,
        className:
          "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-100",
      };
    case "info":
    default:
      return {
        icon: Info,
        className:
          "border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-500/40 dark:bg-blue-500/10 dark:text-blue-100",
      };
  }
}

/// 状态卡用于表达在线/离线这类二值信号，避免用户在长文本里找关键状态。
function StatusCard({
  ok,
  label,
  value,
  detail,
}: {
  ok: boolean;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border p-3",
        ok
          ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-100"
          : "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs opacity-80">{label}</span>
        <span className="h-2.5 w-2.5 rounded-full bg-current" />
      </div>
      <div className="mt-2 text-lg font-semibold text-foreground dark:text-white">
        {value}
      </div>
      <div className="mt-1 truncate text-xs opacity-75" title={detail}>
        {detail}
      </div>
    </div>
  );
}

/// 通用标题行，统一不同页面区块的操作按钮位置。
function SectionHeader({
  icon: Icon,
  title,
  detail,
  action,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  detail: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-base font-semibold text-foreground dark:text-slate-100">
          <Icon className="h-4 w-4 text-blue-600 dark:text-blue-300" />
          {title}
        </div>
        <p className="mt-1 text-xs leading-5 text-muted-foreground dark:text-slate-400">
          {detail}
        </p>
      </div>
      {action}
    </div>
  );
}

/// 子 Agent 候选排序项封装 dnd-kit 绑定，保持拖拽句柄、删除按钮和模型标签的行为一致。
function SortableSpawnAgentCandidate({
  model,
  index,
  onRemove,
}: {
  model: CodexCatalogModel;
  index: number;
  onRemove: (model: string) => void;
}) {
  const modelId = model.model?.trim() ?? "";
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: modelId });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      className={cn(
        "flex items-center gap-2 rounded-md border border-violet-200 bg-background/80 px-2 py-2 text-xs dark:border-violet-800/60 dark:bg-slate-950/50",
        isDragging ? "opacity-60 shadow-lg shadow-violet-950/40" : "",
      )}
    >
      <button
        type="button"
        className="grid h-7 w-7 shrink-0 place-items-center rounded border border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100 dark:border-violet-700/60 dark:bg-violet-500/10 dark:text-violet-200 dark:hover:bg-violet-500/20"
        {...attributes}
        {...listeners}
        aria-label={`Drag ${modelId}`}
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <div className="w-8 shrink-0 text-[11px] text-violet-700 dark:text-violet-300">
        #{index + 1}
      </div>
      <div
        className="min-w-0 flex-1 truncate font-mono text-foreground dark:text-slate-100"
        title={catalogModelLabel(model)}
      >
        {catalogModelLabel(model)}
      </div>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => onRemove(modelId)}
        className="h-7 w-7 shrink-0 p-0 text-muted-foreground hover:bg-rose-50 hover:text-rose-700 dark:text-slate-300 dark:hover:bg-rose-500/15 dark:hover:text-rose-100"
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  );
}

function SortableCatalogModel({
  model,
  index,
  displayStyle = "model",
  onDelete,
  onMoveToTop,
  onMoveToPosition,
  modelCount = 1,
  dragDisabled = false,
  isTop = false,
  recommended = false,
}: {
  model: CodexCatalogModel;
  index: number;
  displayStyle?: CodexModelDisplayStyle;
  onDelete?: (modelId: string) => void;
  onMoveToTop?: (modelId: string) => void;
  onMoveToPosition?: (modelId: string, position: number) => void;
  modelCount?: number;
  dragDisabled?: boolean;
  isTop?: boolean;
  recommended?: boolean;
}) {
  useTranslation();
  const modelId = model.model?.trim() ?? "";
  const apiFormat = model.apiFormat ?? model.api_format;
  const apiFormatSource = model.apiFormatSource ?? model.api_format_source;
  const protocolLabel =
    apiFormat === "openai_responses"
      ? tr("codexRouterWorkspace.protocolResponses", {
          defaultValue: "Responses",
        })
      : apiFormat === "openai_chat"
        ? tr("codexRouterWorkspace.protocolChat", {
            defaultValue: "Chat",
          })
        : null;
  const protocolSourceLabel =
    apiFormatSource === "provider" ||
    apiFormatSource === "default" ||
    !apiFormatSource
      ? tr("codexRouterWorkspace.protocolDefault", {
          defaultValue: "fallback",
        })
      : tr("codexRouterWorkspace.protocolPerModel", {
          defaultValue: "per model",
        });
  const [rankValue, setRankValue] = useState(String(index + 1));
  useEffect(() => setRankValue(String(index + 1)), [index]);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: modelId, disabled: dragDisabled });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      className={cn(
        "flex min-h-11 items-center gap-3 rounded-md border border-blue-200 bg-background px-3 py-2 dark:border-blue-800/60 dark:bg-slate-950/50",
        isDragging ? "opacity-60 shadow-lg shadow-blue-950/30" : "",
      )}
    >
      <button
        type="button"
        className="grid h-7 w-7 shrink-0 place-items-center rounded border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 dark:border-blue-700/60 dark:bg-blue-500/10 dark:text-blue-200 dark:hover:bg-blue-500/20"
        {...attributes}
        {...listeners}
        disabled={dragDisabled}
        aria-label={tr("codexRouterWorkspace.s488", {
          defaultValue: "Drag {{arg0}}",
          arg0: modelId,
        })}
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <span className="w-7 shrink-0 text-right font-mono text-xs text-muted-foreground dark:text-slate-400">
        {index + 1}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <div
            className="min-w-0 truncate text-sm font-medium text-foreground dark:text-slate-100"
            title={`${formatCodexCatalogModelLabel(model, displayStyle)} (${modelId})`}
          >
            {formatCodexCatalogModelLabel(model, displayStyle)}
          </div>
          {protocolLabel ? (
            <Badge
              className={cn(
                "shrink-0 border px-1.5 py-0 text-[10px] font-medium",
                apiFormat === "openai_responses"
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200"
                  : "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-200",
              )}
            >
              {protocolLabel} · {protocolSourceLabel}
            </Badge>
          ) : null}
          {recommended ? (
            <Badge className="shrink-0 border border-amber-500/30 bg-amber-500/10 px-1.5 py-0 text-[10px] font-medium text-amber-700 dark:text-amber-200">
              {tr("codexRouterWorkspace.recommended", {
                defaultValue: "Recommended",
              })}
            </Badge>
          ) : null}
        </div>
        {modelId &&
        formatCodexCatalogModelLabel(model, displayStyle) !== modelId ? (
          <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground dark:text-slate-400">
            {modelId}
          </div>
        ) : null}
        {catalogDraftUpstreamModel(model) !== modelId ? (
          <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground dark:text-slate-400">
            {catalogDraftUpstreamModel(model)}
          </div>
        ) : null}
      </div>
      {onMoveToPosition ? (
        <form
          className="flex shrink-0 items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            const position = Number.parseInt(rankValue, 10);
            if (Number.isFinite(position)) {
              onMoveToPosition(modelId, position);
            }
          }}
        >
          <Input
            disabled={dragDisabled}
            type="number"
            min={1}
            max={modelCount}
            value={rankValue}
            onChange={(event) => setRankValue(event.target.value)}
            aria-label={tr("codexRouterWorkspace.rankModel", {
              defaultValue: "Rank for {{model}}",
              model: modelId,
            })}
            className="h-7 w-16 px-2 text-center text-xs tabular-nums"
          />
          <Button
            disabled={dragDisabled}
            type="submit"
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            aria-label={tr("codexRouterWorkspace.applyRank", {
              defaultValue: "Move {{model}} to rank {{rank}}",
              model: modelId,
              rank: rankValue,
            })}
            title={tr("codexRouterWorkspace.applyRankHint", {
              defaultValue: "Apply global rank",
            })}
          >
            <ArrowRight className="h-4 w-4" />
          </Button>
        </form>
      ) : null}
      {onMoveToTop ? (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={tr("codexRouterWorkspace.makeFavorite", {
            defaultValue: "Make {{model}} the favorite model",
            model: modelId,
          })}
          title={tr("codexRouterWorkspace.makeFavoriteHint", {
            defaultValue: "Move to the top of the Codex model picker",
          })}
          disabled={dragDisabled || !modelId || isTop}
          onClick={() => onMoveToTop(modelId)}
          className={cn(
            "h-7 w-7 shrink-0 p-0",
            isTop
              ? "text-amber-500"
              : "text-muted-foreground hover:bg-amber-50 hover:text-amber-600 dark:hover:bg-amber-500/15 dark:hover:text-amber-200",
          )}
        >
          <Star className="h-4 w-4" fill={isTop ? "currentColor" : "none"} />
        </Button>
      ) : null}
      {onDelete ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={tr("codexRouterWorkspace.hideModel", {
            defaultValue: "Remove {{model}}",
            model: modelId,
          })}
          title={tr("codexRouterWorkspace.hideModelHint", {
            defaultValue:
              "Remove from the Codex picker and routing; the model can be restored on this page.",
          })}
          disabled={dragDisabled || !modelId}
          onClick={() => onDelete(modelId)}
          className="h-7 w-7 shrink-0 p-0 text-rose-700 hover:bg-rose-50 dark:text-rose-200 dark:hover:bg-rose-500/15"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      ) : null}
    </div>
  );
}

/// 路由方案卡片内容；外层决定是按钮还是静态容器。
function PlanCardContent({
  provider,
  providersById,
  compact = false,
}: {
  provider: Provider;
  providersById?: Map<string, Provider>;
  compact?: boolean;
}) {
  const routing = readCodexRouting(provider);
  const routes = routing?.routes ?? [];
  const defaultRoute = routing?.defaultRouteId
    ? routes.find((route) => route.id === routing.defaultRouteId)
    : undefined;
  const defaultRouteName = defaultRoute
    ? routeDisplayName(defaultRoute, providersById ?? new Map())
    : undefined;

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="truncate font-semibold text-foreground dark:text-slate-100">
          {provider.name}
        </span>
        <Badge
          className={cn(
            "border",
            routing?.enabled === false
              ? "border-border bg-muted text-muted-foreground dark:border-slate-500/50 dark:bg-slate-500/10 dark:text-slate-200"
              : "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/50 dark:bg-emerald-500/15 dark:text-emerald-100",
          )}
        >
          {routing?.enabled === false ? "Entry disabled" : "Entry enabled"}
        </Badge>
      </div>
      <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground dark:text-slate-400">
        <span>Rule {routes.length} rules</span>
        {routing?.defaultRouteId && (
          <span
            title={routeDisplayTitle(
              defaultRouteName ?? "Default route",
              routing.defaultRouteId,
            )}
          >
            Legacy default (disabled){" "}
            {defaultRouteName ?? routing.defaultRouteId}
          </span>
        )}
        {!compact && <span>ID {provider.id}</span>}
      </div>
    </div>
  );
}

/// 路由规则按钮，比普通卡片有更明显的 hover 和 active 态。
function RouteListButton({
  entry,
  providersById,
  active = false,
  onClick,
}: {
  entry: RouteEntry;
  providersById: Map<string, Provider>;
  active?: boolean;
  onClick: () => void;
}) {
  const format = routeApiFormat(entry.route);
  const targetProvider = routeTargetProvider(entry.route, providersById);

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        // 路由卡片必须允许收缩到父级网格宽度，否则长模型名会把右侧详情栏挤出并遮挡。
        "group min-w-0 w-full rounded-lg border px-3 py-2 text-left transition",
        active
          ? "border-emerald-400 bg-emerald-50 shadow-[0_0_0_1px_rgba(52,211,153,0.20)] dark:bg-emerald-600/20 dark:shadow-[0_0_0_1px_rgba(52,211,153,0.3)]"
          : "border-border bg-card hover:border-emerald-400 hover:bg-emerald-50 dark:border-slate-700 dark:bg-slate-950/40 dark:hover:bg-emerald-950/20",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-foreground dark:text-slate-100">
            {routeDisplayName(entry.route, providersById)}
          </div>
          <div className="mt-1 truncate text-xs text-muted-foreground dark:text-slate-400">
            MultiRouter plan: {entry.provider.name}
          </div>
        </div>
        <Badge
          className={cn(
            "border",
            entry.route.enabled === false
              ? "border-border bg-muted text-muted-foreground dark:border-slate-500/50 dark:bg-slate-500/10 dark:text-slate-200"
              : "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/50 dark:bg-emerald-500/15 dark:text-emerald-100",
          )}
        >
          {entry.route.enabled === false ? "Disabled" : "Already Enabled"}
        </Badge>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
        <span className="rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-blue-800 dark:border-blue-500/40 dark:bg-blue-500/10 dark:text-blue-100">
          {targetProvider ? "Reuse provider config" : apiFormatLabel(format)}
        </span>
        <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-muted-foreground dark:border-slate-600 dark:bg-slate-900 dark:text-slate-300">
          {authSourceLabel(
            entry.route.authPolicy?.source ??
              entry.route.upstream?.auth?.source,
          )}
        </span>
      </div>
      <div className="mt-1.5 min-w-0 break-words whitespace-normal text-xs leading-5 text-muted-foreground dark:text-slate-400">
        {routeMatchSummary(entry.route)}
      </div>
      {routeProviderModelSyncSummary(entry.route, targetProvider) ? (
        <div className="mt-1 min-w-0 break-words whitespace-normal text-xs leading-5 text-amber-700 dark:text-amber-200">
          {routeProviderModelSyncSummary(entry.route, targetProvider)}
        </div>
      ) : null}
    </button>
  );
}

/// 右侧规则详情，把“查看、编辑、删除入口、复制模型名”分开展示，减少不可操作感。
function RouteDetailPanel({
  selectedRoute,
  selectedPlan,
  providersById,
  onOpenRoutePicker,
  onEditProvider,
  onFollowAllModels,
}: {
  selectedRoute?: RouteEntry;
  selectedPlan: Provider | null;
  providersById: Map<string, Provider>;
  onOpenRoutePicker: (provider?: Provider | null) => void;
  onEditProvider: (provider: Provider) => void;
  onFollowAllModels: () => Promise<void>;
}) {
  if (!selectedRoute) {
    return (
      <section className="rounded-lg border border-border bg-card p-3 dark:border-slate-700 dark:bg-slate-950/40">
        <EmptyState
          icon={Route}
          title="Select a rule"
          detail="Click a rule on the left to view its upstream, match conditions, and actions."
          actionLabel={
            selectedPlan ? "Edit MultiRouter" : "Create multi-route plan"
          }
          onAction={() => selectedPlan && onOpenRoutePicker(selectedPlan)}
        />
      </section>
    );
  }

  const route = selectedRoute.route;
  const matchedModels =
    route.modelSelection?.mode === "include"
      ? route.modelSelection.models
      : (route.match?.models ?? []);
  const targetProviderId = routeTargetProviderId(route);
  const targetProvider = routeTargetProvider(route, providersById);

  return (
    <section className="rounded-lg border border-emerald-200 bg-emerald-50/70 p-3 dark:border-emerald-700/40 dark:bg-slate-950/50">
      <SectionHeader
        icon={Database}
        title={routeDisplayName(route, providersById, "Rule details")}
        detail="This is a read-only summary of the current rule; open the candidate router picker to change its attachment scope."
        action={
          <Button
            size="sm"
            onClick={() => onOpenRoutePicker(selectedRoute.provider)}
            className="gap-2 bg-emerald-600 hover:bg-emerald-500"
          >
            <Pencil className="h-4 w-4" />
            Edit
          </Button>
        }
      />
      <div className="mt-3 space-y-2 text-sm">
        <DetailRow label="Match conditions" value={routeMatchSummary(route)} />
        {targetProviderId ? (
          <DetailRow
            label="Target provider"
            value={
              targetProvider
                ? `${targetProvider.name} (${targetProvider.id})`
                : `Target provider not found: ${targetProviderId}`
            }
          />
        ) : null}
        <DetailRow
          label="Model selection"
          value={
            route.modelSelection?.mode === "all"
              ? "All models from the target provider (include new models automatically)"
              : `${matchedModels.length} upstream models; ${routeProviderModelSyncSummary(route, targetProvider) ?? "Unable to read the provider’s current model catalog"}`
          }
        />
        <DetailRow
          label="Authentication"
          value={authSourceLabel(
            route.authPolicy?.source ?? route.upstream?.auth?.source,
          )}
        />
        {codexRouteUsesOfficialAuthentication(route) ? (
          <DetailRow
            label="Client transport"
            value="HTTP Responses (WebSocket disabled)"
          />
        ) : null}
        <DetailRow
          label="Configuration ownership"
          value="Address, credentials, protocol, and model capabilities are maintained by the target provider/model entry; the route stores only selection, prefixes, aliases, and auth policy."
        />
      </div>
      <div className="mt-3 grid gap-2">
        {route.modelSelection?.mode === "include" ? (
          <Button
            className="justify-start gap-2 bg-emerald-600 hover:bg-emerald-500"
            onClick={() => void onFollowAllModels()}
          >
            <RefreshCw className="h-4 w-4" />
            Follow all models automatically
          </Button>
        ) : null}
        {targetProvider ? (
          <Button
            variant="outline"
            className="justify-start gap-2"
            onClick={() => onEditProvider(targetProvider)}
          >
            <Settings2 className="h-4 w-4" />
            Edit target provider/model configuration
          </Button>
        ) : null}
        <Button
          variant="outline"
          className="justify-start gap-2"
          onClick={() =>
            navigator.clipboard?.writeText(matchedModels.join(", "))
          }
          disabled={matchedModels.length === 0}
        >
          <Clipboard className="h-4 w-4" />
          Copy exact model name
        </Button>
        <Button
          variant="outline"
          className="justify-start gap-2 text-rose-700 hover:bg-rose-50 hover:text-rose-800 dark:text-rose-200 dark:hover:text-rose-100"
          onClick={() => onOpenRoutePicker(selectedRoute.provider)}
        >
          <Trash2 className="h-4 w-4" />
          Uncheck in the candidate list
        </Button>
      </div>
    </section>
  );
}

/// 只读详情行，避免信息散落成难扫描的长段落。
function DetailRow({ label, value }: { label: string; value?: string }) {
  return (
    <div className="rounded-md border border-border bg-muted/40 p-3 dark:border-slate-800 dark:bg-slate-950/50">
      <div className="text-xs text-muted-foreground dark:text-slate-500">
        {label}
      </div>
      <div className="mt-1 break-words text-foreground dark:text-slate-200">
        {value || "Not configured"}
      </div>
    </div>
  );
}

/// 模型源迷你卡，仅用于总览页快速提示。
function SourceMiniCard({ provider }: { provider: Provider }) {
  return (
    <div className="rounded-lg border border-amber-200 bg-card p-3 dark:border-amber-700/30 dark:bg-slate-950/40">
      <div className="truncate text-sm font-semibold text-foreground dark:text-slate-100">
        {provider.name}
      </div>
      <div className="mt-1 truncate text-xs text-muted-foreground dark:text-slate-400">
        {provider.id}
      </div>
    </div>
  );
}

/// 发布检查项用色彩表达状态，避免所有信息都像普通文字。
function ChecklistItem({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border p-3 text-sm",
        ok
          ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-100"
          : "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100",
      )}
    >
      <CheckCircle2 className="h-4 w-4" />
      {label}
    </div>
  );
}

/// 空状态组件带明确动作按钮，让无数据场景仍可继续操作。
function EmptyState({
  icon: Icon,
  title,
  detail,
  actionLabel,
  onAction,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  detail: string;
  actionLabel: string;
  onAction?: () => void;
}) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-muted/40 p-5 dark:border-slate-700 dark:bg-slate-950/40">
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 h-5 w-5 text-muted-foreground dark:text-slate-400" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-foreground dark:text-slate-100">
            {title}
          </div>
          <p className="mt-1 text-sm leading-6 text-muted-foreground dark:text-slate-400">
            {detail}
          </p>
          {onAction && (
            <Button
              size="sm"
              variant="outline"
              onClick={onAction}
              className="mt-3"
            >
              {actionLabel}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
