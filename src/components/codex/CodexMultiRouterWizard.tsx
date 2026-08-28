import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CheckCircle2,
  Database,
  GitBranch,
  RefreshCw,
  Route,
  Server,
  ShieldAlert,
  Wand2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { Provider } from "@/types";
import type {
  CodexCatalogModel,
  CodexOfficialAuthConfig,
  CodexOfficialAuthMode,
  CodexRoutingRouteV2,
} from "@/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { providersApi } from "@/lib/api/providers";
import type { CodexMultiRouterMigrationPreview } from "@/lib/api/providers";
import { codexSubagentV2Api } from "@/lib/api/codexSubagentV2";
import {
  fetchCodexOauthCachedModels,
  fetchCodexOauthModels,
  fetchModelsForConfig,
  probeCodexChatForConfig,
  probeCodexResponsesForConfig,
  type FetchedModel,
} from "@/lib/api/model-fetch";
import {
  CODEX_MULTI_ROUTER_DEFAULT_NAME,
  CODEX_MULTI_ROUTER_DEFAULT_ID,
  CODEX_MULTI_ROUTER_WIZARD_DISMISSED_KEY,
  DEFAULT_CODEX_OFFICIAL_AUTH,
  applyWizardConnectivityApiFormatOverrides,
  buildCodexMultiRouterWizardPlan,
  initialWizardCatalogModelOrder,
  initialWizardSelectedSourceIds,
  buildWizardModelCatalog,
  canContinueAfterConnectivity,
  classifyWizardDualProtocolConnectivityResult,
  classifyWizardConnectivityResult,
  collectWizardModelNameCollisions,
  collectWizardRouteAliasSelectionIssues,
  defaultWizardModelSources,
  getWizardConnectivityProbeModels,
  getWizardConfigIssues,
  getWizardModelFetchConfig,
  isWizardCatalogOnlyModelSource,
  isWizardCodexOAuthSource,
  inferCodexOfficialAuth,
  inferWizardApiFormat,
  isCodexMultiRouterPlan,
  mergeFetchedModelsIntoWizardProvider,
  readWizardCodexOAuthAccountId,
  readWizardModelCatalog,
  readWizardProviderBaseUrl,
  resolveWizardModelNameCollisions,
  skippedWizardConnectivityResult,
  wizardRouteDisplayLabel,
  type WizardConnectivityResult,
  type WizardModelFetchConfig,
} from "@/lib/codexMultiRouterWizard";
import {
  DEFAULT_HOSTED_TOOLS_CONFIG,
  readHostedToolsConfig,
} from "@/lib/hostedTools";
import type { WorkspaceTab } from "@/components/codex/CodexRouterWorkspacePage";
import { codexCatalogOnlyPlanModelFetchMessage } from "@/utils/codexPlanModelFetch";
import { useCodexOauth } from "@/components/providers/forms/hooks/useCodexOauth";

interface CodexMultiRouterWizardProps {
  open: boolean;
  providers: Provider[];
  mode?: "create" | "edit";
  planId?: string;
  onOpenChange: (open: boolean) => void;
  onCreateProvider: () => void;
  onOpenProviderConfig?: (provider: Provider) => void;
  onOpenWorkspace: (provider: Provider, tab: WorkspaceTab) => void;
  onEnablePlan: (provider: Provider) => void | Promise<void>;
}

type WizardStepKey = "sources" | "prepare" | "review" | "activate";

interface WizardStep {
  key: WizardStepKey;
  title: string;
  description: string;
  icon: typeof Wand2;
}

interface WizardIssue {
  id: string;
  stage: WizardStepKey;
  severity: "error" | "warning";
  title: string;
  detail: string;
  canContinue: boolean;
  providerName?: string;
}

type ModelFetchCardStatus =
  | "idle"
  | "loading"
  | "updated"
  | "unchanged"
  | "skipped"
  | "error";

interface ModelFetchDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

interface ModelFetchCardState {
  status: ModelFetchCardStatus;
  message: string;
  modelCount: number;
  diff?: ModelFetchDiff;
}

const STEPS: WizardStep[] = [
  {
    key: "sources",
    title: "codexWizard.step1.title",
    description: "codexWizard.step1.description",
    icon: Server,
  },
  {
    key: "prepare",
    title: "codexWizard.step2.title",
    description: "codexWizard.step2.description",
    icon: RefreshCw,
  },
  {
    key: "review",
    title: "codexWizard.step3.title",
    description: "codexWizard.step3.description",
    icon: GitBranch,
  },
  {
    key: "activate",
    title: "codexWizard.step4.title",
    description: "codexWizard.step4.description",
    icon: CheckCircle2,
  },
];

type WizardFlowStatus =
  | "opened"
  | "needSources"
  | "reviewProviderConfig"
  | "configIncomplete"
  | "readyToFetchModels"
  | "fetchingModels"
  | "modelFetchPartial"
  | "modelsFetched"
  | "probingConnectivity"
  | "connectivityPassed"
  | "connectivityPartial"
  | "connectivityFailed"
  | "collisionReviewRequired"
  | "routePreview"
  | "savingPlan"
  | "saveFailed"
  | "published"
  | "enablePrompt"
  | "enabling"
  | "enableFailed"
  | "enabled"
  | "completed"
  | "dismissed";

interface WizardFlowState {
  status: WizardFlowStatus;
  stepKey: WizardStepKey;
  lastError?: string;
  fetchSummary?: {
    successCount: number;
    skippedCount: number;
    failedCount: number;
  };
  connectivitySummary?: {
    passCount: number;
    warnCount: number;
    skippedCount: number;
    failCount: number;
  };
}

type WizardFlowEvent =
  | { type: "INIT"; hasSources: boolean }
  | { type: "GOTO_STEP"; stepKey: WizardStepKey }
  | { type: "NEXT"; nextStatus: WizardFlowStatus; nextStepKey: WizardStepKey }
  | { type: "FETCH_START" }
  | {
      type: "FETCH_DONE";
      partial: boolean;
      summary: WizardFlowState["fetchSummary"];
    }
  | { type: "PROBE_START" }
  | {
      type: "PROBE_DONE";
      canContinue: boolean;
      hasWarnings: boolean;
      summary: WizardFlowState["connectivitySummary"];
    }
  | { type: "SAVE_START" }
  | { type: "SAVE_SUCCESS" }
  | { type: "SAVE_ERROR"; error: string }
  | { type: "ENABLE_START" }
  | { type: "ENABLE_SUCCESS" }
  | { type: "ENABLE_ERROR"; error: string }
  | { type: "DISMISS" }
  | { type: "COMPLETE" };

const INITIAL_FLOW_STATE: WizardFlowState = {
  status: "opened",
  stepKey: "sources",
};

// 将左侧教程步骤映射到业务状态；手动跳步也会进入对应的状态分支，避免 UI 步骤和流程状态脱节。
function statusForStep(stepKey: WizardStepKey): WizardFlowStatus {
  switch (stepKey) {
    case "sources":
      return "reviewProviderConfig";
    case "prepare":
      return "readyToFetchModels";
    case "review":
      return "routePreview";
    case "activate":
      return "enablePrompt";
    default:
      return "opened";
  }
}

// reducer 是向导的状态机核心；所有异步动作只发事件，不直接改流程状态。
function wizardFlowReducer(
  state: WizardFlowState,
  event: WizardFlowEvent,
): WizardFlowState {
  switch (event.type) {
    case "INIT":
      return {
        status: event.hasSources ? "opened" : "needSources",
        stepKey: "sources",
      };
    case "GOTO_STEP":
      return {
        ...state,
        status: statusForStep(event.stepKey),
        stepKey: event.stepKey,
        lastError: undefined,
      };
    case "NEXT":
      return {
        ...state,
        status: event.nextStatus,
        stepKey: event.nextStepKey,
        lastError: undefined,
      };
    case "FETCH_START":
      return { ...state, status: "fetchingModels", lastError: undefined };
    case "FETCH_DONE":
      return {
        ...state,
        status: event.partial ? "modelFetchPartial" : "modelsFetched",
        stepKey: "prepare",
        fetchSummary: event.summary,
      };
    case "PROBE_START":
      return {
        ...state,
        status: "probingConnectivity",
        stepKey: "prepare",
        lastError: undefined,
      };
    case "PROBE_DONE":
      return {
        ...state,
        status: event.canContinue
          ? event.hasWarnings
            ? "connectivityPartial"
            : "connectivityPassed"
          : "connectivityFailed",
        stepKey: event.canContinue ? "review" : "prepare",
        connectivitySummary: event.summary,
      };
    case "SAVE_START":
      return { ...state, status: "savingPlan", lastError: undefined };
    case "SAVE_SUCCESS":
      return { ...state, status: "published", stepKey: "activate" };
    case "SAVE_ERROR":
      return {
        ...state,
        status: "saveFailed",
        stepKey: "activate",
        lastError: event.error,
      };
    case "ENABLE_START":
      return { ...state, status: "enabling", lastError: undefined };
    case "ENABLE_SUCCESS":
      return { ...state, status: "enabled", stepKey: "activate" };
    case "ENABLE_ERROR":
      return {
        ...state,
        status: "enableFailed",
        stepKey: "activate",
        lastError: event.error,
      };
    case "DISMISS":
      return { ...state, status: "dismissed" };
    case "COMPLETE":
      return { ...state, status: "completed" };
    default:
      return state;
  }
}

// 将模型源的模型目录数量转成人可扫读的摘要，避免向导卡片暴露底层 JSON。
function modelSourceSummary(t: TFunction, provider: Provider): string {
  const models = readWizardModelCatalog(provider);
  if (models.length === 0) return t("codexWizard.sources.summary.noModels");
  return t("codexWizard.sources.summary.models", {
    modelCount: models.length,
  });
}

function modelSourceStatusDetails(t: TFunction, provider: Provider): string[] {
  const models = readWizardModelCatalog(provider);
  const fetchConfig = getWizardModelFetchConfig(provider);
  const auth = isWizardCodexOAuthSource(provider)
    ? t("codexWizard.sources.details.oauthBound")
    : fetchConfig?.apiKey
      ? t("codexWizard.sources.details.apiKeyConfigured")
      : t("codexWizard.sources.details.credentialsMissing");
  const protocol = inferWizardApiFormat(provider);
  const capabilityCount = models.filter(
    (model) =>
      model.contextWindow !== undefined ||
      model.supportsImage === true ||
      model.vision === true ||
      model.textOnly !== undefined,
  ).length;
  const tools = provider.settingsConfig?.hostedTools
    ? t("codexWizard.sources.details.toolsDeclared")
    : t("codexWizard.sources.details.toolsFromProvider");
  const projection = provider.settingsConfig?.codexRouting
    ? t("codexWizard.sources.details.projectionWritten")
    : t("codexWizard.sources.details.projectionPending");
  return [
    t("codexWizard.sources.details.authLine", { value: auth }),
    t("codexWizard.sources.details.modelCatalogLine", {
      modelCount: models.length,
    }),
    t("codexWizard.sources.details.protocolLine", { value: protocol }),
    t("codexWizard.sources.details.capabilityLine", {
      capabilityCount,
      modelCount: models.length,
    }),
    t("codexWizard.sources.details.oauthLine", {
      value: isWizardCodexOAuthSource(provider)
        ? t("codexWizard.common.yes")
        : t("codexWizard.common.no"),
    }),
    t("codexWizard.sources.details.toolsProjectionLine", {
      tools,
      projection,
    }),
  ];
}

// 生成模型目录对比签名；只比较会影响路由、展示、上下文和多模态能力的字段。
function modelCatalogSignature(model: CodexCatalogModel): string {
  const displayName = model.displayName?.trim() || model.model;
  const upstreamModel =
    (typeof model.upstreamModel === "string" && model.upstreamModel.trim()
      ? model.upstreamModel.trim()
      : "") ||
    (typeof model.upstream_model === "string" && model.upstream_model.trim()
      ? model.upstream_model.trim()
      : "") ||
    model.model;
  return JSON.stringify({
    upstreamModel,
    displayName,
    contextWindow:
      model.contextWindow === undefined ? null : String(model.contextWindow),
    inputModalities: model.inputModalities ?? model.input_modalities ?? [],
    textOnly: model.textOnly ?? model.text_only ?? null,
    supportsImage: model.supportsImage ?? model.supports_image ?? null,
    vision: model.vision ?? null,
  });
}

// 比较刷新前后的目录，用于在 provider 卡片上标注“有更新/无更新”。
function diffWizardModelCatalog(
  beforeModels: CodexCatalogModel[],
  afterModels: CodexCatalogModel[],
): ModelFetchDiff {
  const beforeByModel = new Map(
    beforeModels.map((model) => [
      model.model.trim().toLowerCase(),
      modelCatalogSignature(model),
    ]),
  );
  const afterByModel = new Map(
    afterModels.map((model) => [
      model.model.trim().toLowerCase(),
      modelCatalogSignature(model),
    ]),
  );
  const added = afterModels
    .map((model) => model.model)
    .filter((model) => !beforeByModel.has(model.trim().toLowerCase()));
  const removed = beforeModels
    .map((model) => model.model)
    .filter((model) => !afterByModel.has(model.trim().toLowerCase()));
  const changed = afterModels
    .map((model) => model.model)
    .filter(
      (model) =>
        beforeByModel.has(model.trim().toLowerCase()) &&
        beforeByModel.get(model.trim().toLowerCase()) !==
          afterByModel.get(model.trim().toLowerCase()),
    );
  return { added, removed, changed };
}

// 判断一次 /models 读取是否实际改变了目录内容。
function hasModelFetchDiff(diff: ModelFetchDiff): boolean {
  return (
    diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0
  );
}

// 只展示少量变化样例，避免 provider 卡片被很长的模型列表撑高。
function formatModelFetchDiff(
  t: TFunction,
  diff?: ModelFetchDiff,
): string | null {
  if (!diff || !hasModelFetchDiff(diff)) return null;
  const parts: string[] = [];
  if (diff.added.length > 0) {
    parts.push(
      t("codexWizard.fetch.diff.added", {
        count: diff.added.length,
        samples: diff.added.slice(0, 3).join(", "),
      }),
    );
  }
  if (diff.removed.length > 0) {
    parts.push(
      t("codexWizard.fetch.diff.removed", {
        count: diff.removed.length,
        samples: diff.removed.slice(0, 3).join(", "),
      }),
    );
  }
  if (diff.changed.length > 0) {
    parts.push(
      t("codexWizard.fetch.diff.updated", {
        count: diff.changed.length,
        samples: diff.changed.slice(0, 3).join(", "),
      }),
    );
  }
  return parts.join("；");
}

// 给未刷新过的 provider 卡片提供稳定默认状态。
function defaultModelFetchCardState(
  t: TFunction,
  provider: Provider,
): ModelFetchCardState {
  return {
    status: "idle",
    message: t("codexWizard.fetch.card.idle"),
    modelCount: readWizardModelCatalog(provider).length,
  };
}

// 模型读取状态的 badge 统一在这里收口，保证顶部按钮和卡片语义一致。
function modelFetchStatusLabel(
  t: TFunction,
  status: ModelFetchCardStatus,
): string {
  switch (status) {
    case "loading":
      return t("codexWizard.fetch.status.loading");
    case "updated":
      return t("codexWizard.fetch.status.updated");
    case "unchanged":
      return t("codexWizard.fetch.status.unchanged");
    case "skipped":
      return t("codexWizard.fetch.status.skipped");
    case "error":
      return t("codexWizard.fetch.status.error");
    case "idle":
    default:
      return t("codexWizard.fetch.status.idle");
  }
}

// 根据结果选择 badge 风格；失败用 destructive，其它状态保持低干扰。
function modelFetchBadgeVariant(
  status: ModelFetchCardStatus,
): "outline" | "secondary" | "destructive" {
  if (status === "error") return "destructive";
  if (status === "updated" || status === "unchanged") return "secondary";
  return "outline";
}

// 把模型列表抓取参数格式化成安全摘要，不展示真实 API Key 或 AK/SK。
function fetchConfigSummary(
  t: TFunction,
  config: WizardModelFetchConfig | null,
): string {
  if (!config) return t("codexWizard.fetch.summary.missingConfig");
  if (config.volcengineModelListAction) {
    return t("codexWizard.fetch.summary.volcengine", {
      action: config.volcengineModelListAction,
      baseUrl: config.baseUrl,
    });
  }
  return `${config.baseUrl}${
    config.isFullUrl ? t("codexWizard.fetch.summary.fullUrlSuffix") : ""
  }`;
}

// 生成官方 Codex OAuth 动态目录读取文案；失败时保留最后一次成功目录，不清空用户配置。
function codexOAuthModelFetchMessage(
  t: TFunction,
  hasModelCatalog: boolean,
  hasCodexOauthAccount: boolean,
) {
  const catalogText = hasModelCatalog
    ? t("codexWizard.fetch.oauth.catalogKept")
    : t("codexWizard.fetch.oauth.noCatalog");
  const authText = hasCodexOauthAccount
    ? t("codexWizard.fetch.oauth.accountDetected")
    : t("codexWizard.fetch.oauth.noAccount");
  return t("codexWizard.fetch.oauth.message", { catalogText, authText });
}

// 生成 Plan provider 在线模型列表不可用时的回退文案，避免把火山缺 AK/SK 误写成永久不支持。
function catalogOnlyPlanMessage(provider: Provider, hasModelCatalog: boolean) {
  return codexCatalogOnlyPlanModelFetchMessage(hasModelCatalog, {
    baseUrl: readWizardProviderBaseUrl(provider),
    partnerPromotionKey: provider.meta?.partnerPromotionKey,
    providerName: provider.name,
    accessKeyId: provider.meta?.usage_script?.accessKeyId,
    secretAccessKey: provider.meta?.usage_script?.secretAccessKey,
  });
}

// 将内部状态机状态转换为用户能理解的短句，便于在向导顶部持续暴露当前进度。
function wizardStatusText(t: TFunction, state: WizardFlowState): string {
  switch (state.status) {
    case "needSources":
      return t("codexWizard.status.needSources");
    case "configIncomplete":
      return t("codexWizard.status.configIncomplete");
    case "readyToFetchModels":
      return t("codexWizard.status.readyToFetchModels");
    case "fetchingModels":
      return t("codexWizard.status.fetchingModels");
    case "modelFetchPartial":
      return t("codexWizard.status.modelFetchPartial");
    case "modelsFetched":
      return t("codexWizard.status.modelsFetched");
    case "probingConnectivity":
      return t("codexWizard.status.probingConnectivity");
    case "connectivityPassed":
      return t("codexWizard.status.connectivityPassed");
    case "connectivityPartial":
      return t("codexWizard.status.connectivityPartial");
    case "connectivityFailed":
      return t("codexWizard.status.connectivityFailed");
    case "collisionReviewRequired":
      return t("codexWizard.status.collisionReviewRequired");
    case "routePreview":
      return t("codexWizard.status.routePreview");
    case "savingPlan":
      return t("codexWizard.status.savingPlan");
    case "saveFailed":
      return t("codexWizard.status.saveFailed");
    case "published":
      return t("codexWizard.status.published");
    case "enabling":
      return t("codexWizard.status.enabling");
    case "enableFailed":
      return t("codexWizard.status.enableFailed");
    case "enabled":
      return t("codexWizard.status.enabled");
    case "completed":
      return t("codexWizard.status.completed");
    case "dismissed":
      return t("codexWizard.status.dismissed");
    case "opened":
    case "enablePrompt":
    default:
      return t("codexWizard.status.default");
  }
}

// 把异常转换成面向用户的短文本，同时保留 console 中的详细错误对象。
function formatWizardError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// 生成稳定但不依赖后端的异常 ID，方便 React 渲染和后续按阶段清理。
function createWizardIssueId(stage: WizardStepKey, title: string): string {
  return `${stage}:${title}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

// 在有序列表中移动一项，供模型汇总列表和子 Agent 候选列表复用。
function moveOrderedItem(items: string[], item: string, direction: -1 | 1) {
  const index = items.indexOf(item);
  const targetIndex = index + direction;
  if (index < 0 || targetIndex < 0 || targetIndex >= items.length) {
    return items;
  }
  const next = [...items];
  [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
  return next;
}

// 用最新可用模型校正用户草稿顺序；未显式编辑时保留完整模型列表，显式编辑后不自动加回已剔除模型。
function resolveActiveCatalogModelOrder(
  availableModels: CodexCatalogModel[],
  draftOrder: string[] | null,
) {
  const availableNames = availableModels.map((model) => model.model);
  if (draftOrder === null) return availableNames;
  const availableSet = new Set(availableNames);
  return draftOrder.filter((model) => availableSet.has(model));
}

// 保存子 Agent 候选时必须先按最终模型池过滤，避免引用已经剔除的模型。
function resolveActiveSpawnAgentModels(
  draftModels: string[],
  catalogModelOrder: string[],
) {
  const catalogModelSet = new Set(catalogModelOrder);
  return draftModels.filter((model) => catalogModelSet.has(model)).slice(0, 5);
}

// 刷新模型列表后保留用户已经勾选的模型，只把真正新增的模型追加进去。
function reconcileCatalogModelOrderAfterFetch(
  currentOrder: string[] | null,
  previousAvailableModels: string[],
  nextAvailableModels: string[],
) {
  if (currentOrder === null) return null;
  const nextAvailableSet = new Set(nextAvailableModels);
  const previousAvailableSet = new Set(previousAvailableModels);
  const retained = currentOrder.filter((model) => nextAvailableSet.has(model));
  const added = nextAvailableModels.filter(
    (model) => !previousAvailableSet.has(model),
  );
  return [...retained, ...added];
}

export function CodexMultiRouterWizard({
  open,
  providers,
  mode,
  planId,
  onOpenChange,
  onCreateProvider,
  onOpenProviderConfig,
  onOpenWorkspace,
  onEnablePlan,
}: CodexMultiRouterWizardProps) {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const {
    accounts: codexOauthAccounts,
    hasAnyAccount: hasCodexOauthAccount,
    isLoadingStatus: isCodexOauthStatusLoading,
  } = useCodexOauth();
  const [flowState, dispatchFlow] = useReducer(
    wizardFlowReducer,
    INITIAL_FLOW_STATE,
  );
  const [draftSources, setDraftSources] = useState<Provider[]>([]);
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([]);
  const [draftPlanName, setDraftPlanName] = useState(
    CODEX_MULTI_ROUTER_DEFAULT_NAME,
  );
  const [draftOfficialAuth, setDraftOfficialAuth] =
    useState<CodexOfficialAuthConfig>(DEFAULT_CODEX_OFFICIAL_AUTH);
  const [webSearchEnabled, setWebSearchEnabled] = useState(true);
  const [imageGenerationEnabled, setImageGenerationEnabled] = useState(true);
  const [catalogModelOrder, setCatalogModelOrder] = useState<string[] | null>(
    null,
  );
  const [draftSpawnAgentModels, setDraftSpawnAgentModels] = useState<string[]>(
    [],
  );
  const [savedPlan, setSavedPlan] = useState<Provider | null>(null);
  const [connectivityResults, setConnectivityResults] = useState<
    WizardConnectivityResult[]
  >([]);
  const [isConnectivityConfirmOpen, setIsConnectivityConfirmOpen] =
    useState(false);
  const [wizardIssues, setWizardIssues] = useState<WizardIssue[]>([]);
  const [modelFetchCards, setModelFetchCards] = useState<
    Record<string, ModelFetchCardState>
  >({});
  const [migratedPlanOverride, setMigratedPlanOverride] =
    useState<Provider | null>(null);
  const [migrationPreview, setMigrationPreview] =
    useState<CodexMultiRouterMigrationPreview | null>(null);
  const [migrationError, setMigrationError] = useState<string | null>(null);
  const [isLoadingMigration, setIsLoadingMigration] = useState(false);
  const [isApplyingMigration, setIsApplyingMigration] = useState(false);
  const initializedOpenRef = useRef(false);
  const createPlanIdRef = useRef<string | null>(null);
  const saveInFlightRef = useRef<Promise<void> | null>(null);

  const resolvedMode =
    mode ??
    (planId || providers.some((provider) => isCodexMultiRouterPlan(provider))
      ? "edit"
      : "create");
  const storedExistingPlan = useMemo(() => {
    if (resolvedMode !== "edit") return undefined;
    return planId
      ? providers.find(
          (provider) =>
            provider.id === planId && isCodexMultiRouterPlan(provider),
        )
      : providers.find((provider) => isCodexMultiRouterPlan(provider));
  }, [planId, providers, resolvedMode]);
  const existingPlan = migratedPlanOverride ?? storedExistingPlan;
  const activePlan = savedPlan ?? existingPlan;
  const editingTargetMissing = resolvedMode === "edit" && !existingPlan;
  const providerModelSources = useMemo(
    () => defaultWizardModelSources(providers),
    [providers],
  );
  const hasCodexOAuthSources = useMemo(
    () => draftSources.some((provider) => isWizardCodexOAuthSource(provider)),
    [draftSources],
  );
  const selectedSourceIdSet = useMemo(
    () => new Set(selectedSourceIds),
    [selectedSourceIds],
  );
  const hasUnauthenticatedCodexOAuthSources =
    hasCodexOAuthSources && !isCodexOauthStatusLoading && !hasCodexOauthAccount;
  const stepIndex = STEPS.findIndex((step) => step.key === flowState.stepKey);
  // 防御旧状态或异常跳转写入未知步骤，确保向导始终有可渲染的首步。
  const currentStep = STEPS[stepIndex] ?? STEPS[0];
  const CurrentStepIcon = currentStep.icon;
  const configIssues = useMemo(
    () => getWizardConfigIssues(draftSources),
    [draftSources],
  );
  const modelCollisions = useMemo(
    () => collectWizardModelNameCollisions(draftSources),
    [draftSources],
  );
  const routeReadySources = applyWizardConnectivityApiFormatOverrides(
    draftSources,
    connectivityResults,
  );
  const availableCatalogModels = buildWizardModelCatalog(
    resolveWizardModelNameCollisions(routeReadySources),
  ).models;
  const activeCatalogModelOrder = resolveActiveCatalogModelOrder(
    availableCatalogModels,
    catalogModelOrder,
  );
  const activeSpawnAgentModels = resolveActiveSpawnAgentModels(
    draftSpawnAgentModels,
    activeCatalogModelOrder,
  );
  const isRefreshingModels = flowState.status === "fetchingModels";
  const isProbingConnectivity = flowState.status === "probingConnectivity";
  const isSavingPlan = flowState.status === "savingPlan";
  const isEnablingPlan = flowState.status === "enabling";

  useEffect(() => {
    if (!open) {
      setMigratedPlanOverride(null);
      setMigrationPreview(null);
      setMigrationError(null);
      return;
    }
    if (
      resolvedMode !== "edit" ||
      !storedExistingPlan ||
      storedExistingPlan.settingsConfig?.codexRouting?.schemaVersion === 2 ||
      migratedPlanOverride
    ) {
      return;
    }
    let cancelled = false;
    setIsLoadingMigration(true);
    setMigrationError(null);
    void providersApi
      .getCodexMultiRouterRevision(storedExistingPlan.id)
      .then((revision) =>
        providersApi.previewCodexMultiRouterMigration(
          storedExistingPlan.id,
          revision,
        ),
      )
      .then((preview) => {
        if (!cancelled) setMigrationPreview(preview);
      })
      .catch((error) => {
        if (!cancelled) setMigrationError(formatWizardError(error));
      })
      .finally(() => {
        if (!cancelled) setIsLoadingMigration(false);
      });
    return () => {
      cancelled = true;
    };
  }, [migratedPlanOverride, open, resolvedMode, storedExistingPlan]);

  const applyLegacyMigration = async () => {
    if (!migrationPreview || !storedExistingPlan) return;
    setIsApplyingMigration(true);
    setMigrationError(null);
    try {
      await providersApi.applyCodexMultiRouterMigration(
        storedExistingPlan.id,
        migrationPreview.expectedRevision,
        migrationPreview.planToken,
      );
      const refreshed = await providersApi.getAll("codex");
      const migrated = refreshed[storedExistingPlan.id];
      if (migrated?.settingsConfig?.codexRouting?.schemaVersion !== 2) {
        throw new Error("migration_readback_failed");
      }
      initializedOpenRef.current = false;
      setMigratedPlanOverride(migrated);
      setMigrationPreview(null);
      await queryClient.invalidateQueries({ queryKey: ["providers", "codex"] });
    } catch (error) {
      setMigrationError(formatWizardError(error));
    } finally {
      setIsApplyingMigration(false);
    }
  };

  // 每次打开向导只初始化一次。父组件 rerender 会传入新的 providers 数组，不能因此把用户从第 2 步重置回第 1 步。
  useEffect(() => {
    if (!open) {
      initializedOpenRef.current = false;
      createPlanIdRef.current = null;
      saveInFlightRef.current = null;
      return;
    }
    if (initializedOpenRef.current) return;

    initializedOpenRef.current = true;
    if (existingPlan) {
      createPlanIdRef.current = existingPlan.id;
    } else if (!createPlanIdRef.current) {
      const defaultId = CODEX_MULTI_ROUTER_DEFAULT_ID;
      createPlanIdRef.current = providers.some(
        (provider) => provider.id === defaultId,
      )
        ? `${defaultId}-${Date.now()}`
        : defaultId;
    }
    const initialSourceIds = initialWizardSelectedSourceIds(
      existingPlan,
      providerModelSources,
    );
    const initialSourceIdSet = new Set(initialSourceIds);
    setSavedPlan(existingPlan ?? null);
    setDraftSources(
      providerModelSources.filter((provider) =>
        initialSourceIdSet.has(provider.id),
      ),
    );
    setSelectedSourceIds(initialSourceIds);
    setDraftPlanName(existingPlan?.name ?? CODEX_MULTI_ROUTER_DEFAULT_NAME);
    setDraftOfficialAuth(
      inferCodexOfficialAuth(existingPlan?.settingsConfig?.codexRouting) ??
        DEFAULT_CODEX_OFFICIAL_AUTH,
    );
    const hostedTools = existingPlan
      ? readHostedToolsConfig(existingPlan)
      : DEFAULT_HOSTED_TOOLS_CONFIG;
    setWebSearchEnabled(hostedTools.webSearch.enabled);
    setImageGenerationEnabled(hostedTools.imageGeneration.enabled);
    // 复用统一的安全目录读取，历史方案中混入 null/原始值时不能让整个窗口白屏。
    setCatalogModelOrder(
      initialWizardCatalogModelOrder(existingPlan, providerModelSources),
    );
    setDraftSpawnAgentModels(
      existingPlan?.settingsConfig?.codexRouting?.schemaVersion === 2
        ? (existingPlan.settingsConfig.codexRouting.spawnAgentModels?.slice(
            0,
            5,
          ) ?? [])
        : (existingPlan?.settingsConfig?.modelCatalog?.spawnAgentModels?.slice(
            0,
            5,
          ) ?? []),
    );
    setConnectivityResults([]);
    setWizardIssues([]);
    setModelFetchCards(
      Object.fromEntries(
        providerModelSources.map((provider) => [
          provider.id,
          defaultModelFetchCardState(t, provider),
        ]),
      ),
    );
    dispatchFlow({
      type: "INIT",
      hasSources: initialSourceIds.length > 0,
    });
  }, [existingPlan, open, planId, providerModelSources, resolvedMode]);

  // Provider 是模型事实的唯一来源。向导打开期间也必须采用父层查询的最新快照，
  // 否则 Provider 新增模型、上下文或能力变化只会在关闭并重开向导后出现。
  // 向导自己的协议探测结果保存在 connectivityResults，模型刷新又会先持久化 Provider，
  // 因此这里不需要为完整 Provider 对象维护第二份长期草稿。
  useEffect(() => {
    if (!open || !initializedOpenRef.current) return;
    setSavedPlan((currentPlan) => existingPlan ?? currentPlan);
    setDraftSources(() => {
      const nextSourceById = new Map(
        providerModelSources.map((provider) => [provider.id, provider]),
      );
      return selectedSourceIds
        .map((providerId) => nextSourceById.get(providerId))
        .filter((provider): provider is Provider => Boolean(provider));
    });
    setSelectedSourceIds((currentIds) => {
      const nextIds = currentIds.filter((providerId) =>
        providerModelSources.some((provider) => provider.id === providerId),
      );
      return nextIds.length === currentIds.length ? currentIds : nextIds;
    });
    setModelFetchCards((currentCards) =>
      Object.fromEntries(
        providerModelSources.map((provider) => [
          provider.id,
          currentCards[provider.id] ?? defaultModelFetchCardState(t, provider),
        ]),
      ),
    );
  }, [existingPlan, open, providerModelSources, selectedSourceIds]);

  // 选择只影响本次 MultiRouter 草稿，不修改 provider 数据库或其它已有路由方案。
  const toggleSourceProvider = (provider: Provider, checked: boolean) => {
    setSelectedSourceIds((currentIds) => {
      if (checked) {
        return currentIds.includes(provider.id)
          ? currentIds
          : [...currentIds, provider.id];
      }
      return currentIds.filter((providerId) => providerId !== provider.id);
    });
    setDraftSources((currentSources) => {
      if (checked) {
        return currentSources.some((source) => source.id === provider.id)
          ? currentSources
          : [...currentSources, provider];
      }
      return currentSources.filter((source) => source.id !== provider.id);
    });
    setConnectivityResults([]);
  };

  // 所有异步 catch 都进入同一个问题列表，让 toast 之外的 UI 也能长期展示异常和继续策略。
  const recordWizardIssue = (issue: Omit<WizardIssue, "id">) => {
    setWizardIssues((current) => [
      ...current,
      {
        ...issue,
        id: createWizardIssueId(issue.stage, issue.title),
      },
    ]);
  };

  // 重新执行某个阶段时只清理该阶段旧问题，避免旧错误误导当前判断。
  const clearWizardIssuesForStage = (stage: WizardStepKey) => {
    setWizardIssues((current) =>
      current.filter((issue) => issue.stage !== stage),
    );
  };

  // 切换最终模型池里的保留状态；第一次编辑时从当前完整列表复制一份显式顺序。
  const toggleCatalogModel = (model: string, checked: boolean) => {
    setCatalogModelOrder((current) => {
      const base = current ?? availableCatalogModels.map((item) => item.model);
      if (checked) {
        return base.includes(model) ? base : [...base, model];
      }
      setDraftSpawnAgentModels((spawnModels) =>
        spawnModels.filter((item) => item !== model),
      );
      return base.filter((item) => item !== model);
    });
  };

  // 调整最终模型选择与顺序；schema v2 只把 all/include 策略写入 Router。
  const moveCatalogModel = (model: string, direction: -1 | 1) => {
    setCatalogModelOrder((current) =>
      moveOrderedItem(
        current ?? availableCatalogModels.map((item) => item.model),
        model,
        direction,
      ),
    );
  };

  // 关闭/跳过时记录 dismissed；首页按钮仍可再次显式打开。
  const closeWizard = (dismissed = true) => {
    if (dismissed) {
      localStorage.setItem(CODEX_MULTI_ROUTER_WIZARD_DISMISSED_KEY, "true");
      dispatchFlow({ type: "DISMISS" });
    } else {
      dispatchFlow({ type: "COMPLETE" });
    }
    onOpenChange(false);
  };

  // 下一步按钮按状态机 gate 推进；配置不完整时停在当前状态并给出可操作提示。
  const advanceWizard = () => {
    switch (currentStep.key) {
      case "sources":
        if (draftSources.length === 0) {
          dispatchFlow({
            type: "NEXT",
            nextStatus: "needSources",
            nextStepKey: "sources",
          });
          toast.info(t("codexWizard.toast.needSource"), {
            closeButton: true,
          });
          return;
        }
        dispatchFlow({
          type: "NEXT",
          nextStatus:
            configIssues.length > 0 ? "configIncomplete" : "readyToFetchModels",
          nextStepKey: "prepare",
        });
        if (hasUnauthenticatedCodexOAuthSources) {
          toast.warning(t("codexWizard.toast.oauthNotLoggedIn"), {
            closeButton: true,
          });
        }
        if (configIssues.length > 0) {
          toast.warning(t("codexWizard.toast.partialConfig"), {
            closeButton: true,
          });
        }
        return;
      case "prepare":
        if (
          connectivityResults.length > 0 &&
          !canContinueAfterConnectivity(connectivityResults)
        ) {
          dispatchFlow({
            type: "NEXT",
            nextStatus: "connectivityFailed",
            nextStepKey: "prepare",
          });
          recordWizardIssue({
            stage: "prepare",
            severity: "error",
            title: t("codexWizard.issues.responsesBlocked.title"),
            detail: t("codexWizard.issues.responsesBlocked.detail"),
            canContinue: false,
          });
          toast.error(t("codexWizard.toast.connectivityBlocked"), {
            closeButton: true,
          });
          return;
        }
        dispatchFlow({
          type: "NEXT",
          nextStatus: "routePreview",
          nextStepKey: "review",
        });
        return;
      case "review":
        if (!draftPlanName.trim()) {
          toast.error(t("codexWizard.toast.missingName"), {
            closeButton: true,
          });
          return;
        }
        if (activeCatalogModelOrder.length === 0) {
          toast.error(t("codexWizard.toast.needOneModel"), {
            closeButton: true,
          });
          return;
        }
        dispatchFlow({
          type: "NEXT",
          nextStatus: "published",
          nextStepKey: "activate",
        });
        return;
      case "activate":
        if (savedPlan) {
          closeWizard(false);
          return;
        }
        toast.info(t("codexWizard.toast.pressSave"), {
          closeButton: true,
        });
        return;
      default:
        return;
    }
  };

  // 上一步只改变教程步骤和对应状态，不回滚已经抓取/保存的草稿数据。
  const retreatWizard = () => {
    const previousStep = STEPS[Math.max(0, stepIndex - 1)];
    dispatchFlow({ type: "GOTO_STEP", stepKey: previousStep.key });
  };

  // 顺序抓取所有可抓模型源；失败不阻塞其它 provider，最终由保存页继续使用已成功目录。
  const refreshModelSources = async () => {
    dispatchFlow({ type: "FETCH_START" });
    clearWizardIssuesForStage("prepare");
    const previousAvailableModels = availableCatalogModels.map(
      (model) => model.model,
    );
    let successCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    setModelFetchCards(
      Object.fromEntries(
        draftSources.map((provider) => {
          const config = getWizardModelFetchConfig(provider);
          const existingCount = readWizardModelCatalog(provider).length;
          const isCatalogOnlyPlan = isWizardCatalogOnlyModelSource(provider);
          const isCodexOAuth = isWizardCodexOAuthSource(provider);
          return [
            provider.id,
            (config && !isCatalogOnlyPlan) || isCodexOAuth
              ? {
                  status: "loading",
                  message: isCodexOAuth
                    ? t("codexWizard.fetch.card.loadingOauth")
                    : config?.volcengineModelListAction
                      ? t("codexWizard.fetch.card.loadingVolc")
                      : t("codexWizard.fetch.card.loadingModels"),
                  modelCount: existingCount,
                }
              : {
                  status: "skipped",
                  message: isCodexOAuth
                    ? codexOAuthModelFetchMessage(
                        t,
                        existingCount > 0,
                        hasCodexOauthAccount,
                      )
                    : isCatalogOnlyPlan
                      ? catalogOnlyPlanMessage(provider, existingCount > 0)
                      : t("codexWizard.fetch.card.noConfigMessage"),
                  modelCount: existingCount,
                },
          ];
        }),
      ),
    );
    try {
      const nextSources: Provider[] = [];
      for (const provider of draftSources) {
        const config = getWizardModelFetchConfig(provider);
        const beforeModels = readWizardModelCatalog(provider);
        const isCatalogOnlyPlan = isWizardCatalogOnlyModelSource(provider);
        const isCodexOAuth = isWizardCodexOAuthSource(provider);
        if (isCodexOAuth) {
          setModelFetchCards((current) => ({
            ...current,
            [provider.id]: {
              status: "loading",
              message: t("codexWizard.fetch.card.loadingOauthList"),
              modelCount: beforeModels.length,
            },
          }));
          try {
            const fetchedModels = await fetchCodexOauthModels(
              readWizardCodexOAuthAccountId(provider),
            );
            if (fetchedModels.length === 0) {
              throw new Error(t("codexWizard.errors.emptyOauthList"));
            }
            // OAuth 上游会持续发布新模型，因此成功响应必须追加新条目；已有别名、能力和子 Agent 选择仍由合并函数保留。
            const nextProvider = mergeFetchedModelsIntoWizardProvider(
              provider,
              fetchedModels,
              { removeMissingRemote: true },
            );
            const afterModels = readWizardModelCatalog(nextProvider);
            const diff = diffWizardModelCatalog(beforeModels, afterModels);
            const hasDiff = hasModelFetchDiff(diff);
            await providersApi.update(nextProvider, "codex", undefined, true);
            nextSources.push(nextProvider);
            successCount += 1;
            setModelFetchCards((current) => ({
              ...current,
              [provider.id]: {
                status: hasDiff ? "updated" : "unchanged",
                message: hasDiff
                  ? t("codexWizard.fetch.card.oauthUpdated", {
                      modelCount: afterModels.length,
                    })
                  : t("codexWizard.fetch.card.oauthUnchanged", {
                      modelCount: afterModels.length,
                    }),
                modelCount: afterModels.length,
                diff,
              },
            }));
          } catch (error) {
            const message = formatWizardError(error);
            let cacheFailureMessage: string | null = null;
            try {
              const cachedModels = await fetchCodexOauthCachedModels();
              if (cachedModels.length > 0) {
                // 在线 OAuth 目录失败时使用 Codex 本地官方缓存兜底，避免新建 official 源被写成 0 模型。
                const nextProvider = mergeFetchedModelsIntoWizardProvider(
                  provider,
                  cachedModels,
                );
                const afterModels = readWizardModelCatalog(nextProvider);
                const diff = diffWizardModelCatalog(beforeModels, afterModels);
                const hasDiff = hasModelFetchDiff(diff);
                await providersApi.update(
                  nextProvider,
                  "codex",
                  undefined,
                  true,
                );
                nextSources.push(nextProvider);
                successCount += 1;
                recordWizardIssue({
                  stage: "prepare",
                  severity: "warning",
                  title: t("codexWizard.issues.oauthCacheFallback.title"),
                  detail: t("codexWizard.issues.oauthCacheFallback.detail", {
                    restoredCount: afterModels.length,
                    onlineError: message,
                  }),
                  canContinue: true,
                  providerName: provider.name,
                });
                setModelFetchCards((current) => ({
                  ...current,
                  [provider.id]: {
                    status: hasDiff ? "updated" : "unchanged",
                    message: hasDiff
                      ? t("codexWizard.fetch.card.oauthCacheUpdated", {
                          modelCount: afterModels.length,
                        })
                      : t("codexWizard.fetch.card.oauthCacheUnchanged", {
                          modelCount: afterModels.length,
                        }),
                    modelCount: afterModels.length,
                    diff,
                  },
                }));
                continue;
              }
            } catch (cacheError) {
              cacheFailureMessage = formatWizardError(cacheError);
            }
            failedCount += 1;
            nextSources.push(provider);
            recordWizardIssue({
              stage: "prepare",
              severity: "warning",
              title: t("codexWizard.issues.oauthFailed.title"),
              detail:
                t("codexWizard.issues.oauthFailed.detail", { message }) +
                (cacheFailureMessage
                  ? t("codexWizard.issues.oauthFailed.cacheFailSuffix", {
                      message: cacheFailureMessage,
                    })
                  : t("codexWizard.issues.oauthFailed.noCacheSuffix")),
              canContinue: true,
              providerName: provider.name,
            });
            setModelFetchCards((current) => ({
              ...current,
              [provider.id]: {
                status: "error",
                message:
                  t("codexWizard.fetch.card.oauthFailed", { message }) +
                  (beforeModels.length === 0
                    ? t("codexWizard.fetch.card.oauthFailedNoCacheExtra")
                    : ""),
                modelCount: beforeModels.length,
              },
            }));
          }
          continue;
        }
        if (isCatalogOnlyPlan) {
          skippedCount += 1;
          nextSources.push(provider);
          setModelFetchCards((current) => ({
            ...current,
            [provider.id]: {
              status: "skipped",
              message: catalogOnlyPlanMessage(
                provider,
                beforeModels.length > 0,
              ),
              modelCount: beforeModels.length,
            },
          }));
          continue;
        }
        if (!config) {
          skippedCount += 1;
          nextSources.push(provider);
          setModelFetchCards((current) => ({
            ...current,
            [provider.id]: {
              status: "skipped",
              message: t("codexWizard.fetch.card.noConfigMessage"),
              modelCount: beforeModels.length,
            },
          }));
          continue;
        }
        setModelFetchCards((current) => ({
          ...current,
          [provider.id]: {
            status: "loading",
            message: t("codexWizard.fetch.card.reading", {
              summary: fetchConfigSummary(t, config),
            }),
            modelCount: beforeModels.length,
          },
        }));
        try {
          const credentialKeys =
            config.apiKeys && config.apiKeys.length > 0
              ? config.apiKeys
              : [config.apiKey];
          const fetchResults = await Promise.allSettled(
            credentialKeys.map((apiKey) =>
              fetchModelsForConfig(
                config.baseUrl,
                apiKey,
                config.isFullUrl,
                config.modelsUrl,
                config.customUserAgent,
                config.volcengineModelListAction
                  ? {
                      action: config.volcengineModelListAction,
                      accessKeyId: config.volcengineAccessKeyId ?? "",
                      secretAccessKey: config.volcengineSecretAccessKey ?? "",
                    }
                  : undefined,
              ),
            ),
          );
          const fulfilledResults = fetchResults.filter(
            (result): result is PromiseFulfilledResult<FetchedModel[]> =>
              result.status === "fulfilled",
          );
          if (fulfilledResults.length === 0) {
            throw fetchResults.find((result) => result.status === "rejected")
              ?.reason;
          }
          const fetchedModels = Array.from(
            new Map(
              fulfilledResults
                .flatMap((result) => result.value)
                .filter((model) => model.id.trim())
                .map((model) => [model.id.trim().toLowerCase(), model]),
            ).values(),
          );
          const failedCredentialCount =
            fetchResults.length - fulfilledResults.length;
          const nextProvider = mergeFetchedModelsIntoWizardProvider(
            provider,
            fetchedModels,
            { removeMissingRemote: failedCredentialCount === 0 },
          );
          const afterModels = readWizardModelCatalog(nextProvider);
          const diff = diffWizardModelCatalog(beforeModels, afterModels);
          const hasDiff = hasModelFetchDiff(diff);
          await providersApi.update(nextProvider, "codex", undefined, true);
          nextSources.push(nextProvider);
          successCount += 1;
          setModelFetchCards((current) => ({
            ...current,
            [provider.id]: {
              status: hasDiff ? "updated" : "unchanged",
              message:
                failedCredentialCount > 0
                  ? t("codexWizard.fetch.card.partialCredentials", {
                      modelCount: afterModels.length,
                      failedCount: failedCredentialCount,
                    })
                  : hasDiff
                    ? t("codexWizard.fetch.card.updated", {
                        modelCount: afterModels.length,
                      })
                    : t("codexWizard.fetch.card.unchanged", {
                        modelCount: afterModels.length,
                      }),
              modelCount: afterModels.length,
              diff,
            },
          }));
          if (failedCredentialCount > 0) {
            recordWizardIssue({
              stage: "prepare",
              severity: "warning",
              title: t("codexWizard.issues.partialCredentialFetch.title"),
              detail: t("codexWizard.issues.partialCredentialFetch.detail", {
                failedCount: failedCredentialCount,
              }),
              canContinue: true,
              providerName: provider.name,
            });
          }
        } catch (error) {
          console.error("[CodexMultiRouterWizard] fetch models failed", error);
          const message = formatWizardError(error);
          recordWizardIssue({
            stage: "prepare",
            severity: "warning",
            title: t("codexWizard.issues.fetchFailed.title"),
            detail: t("codexWizard.issues.fetchFailed.detail", { message }),
            canContinue: true,
            providerName: provider.name,
          });
          failedCount += 1;
          nextSources.push(provider);
          setModelFetchCards((current) => ({
            ...current,
            [provider.id]: {
              status: "error",
              message: t("codexWizard.fetch.card.fetchFailed", { message }),
              modelCount: beforeModels.length,
            },
          }));
        }
      }
      setDraftSources(nextSources);
      const nextAvailableModels = buildWizardModelCatalog(
        resolveWizardModelNameCollisions(nextSources),
      ).models.map((model) => model.model);
      setCatalogModelOrder((current) =>
        reconcileCatalogModelOrderAfterFetch(
          current,
          previousAvailableModels,
          nextAvailableModels,
        ),
      );
      setDraftSpawnAgentModels((current) => {
        const nextAvailableSet = new Set(nextAvailableModels);
        return current
          .filter((model) => nextAvailableSet.has(model))
          .slice(0, 5);
      });
      setConnectivityResults([]);
      await queryClient.invalidateQueries({ queryKey: ["providers", "codex"] });
      dispatchFlow({
        type: "FETCH_DONE",
        partial: failedCount > 0 || skippedCount > 0,
        summary: { successCount, skippedCount, failedCount },
      });
      toast.success(
        t("codexWizard.toast.fetchComplete", {
          successCount,
          skippedCount,
          failedCount,
        }),
        { closeButton: true },
      );
    } catch (error) {
      const message = formatWizardError(error);
      recordWizardIssue({
        stage: "prepare",
        severity: "error",
        title: t("codexWizard.issues.fetchAborted.title"),
        detail: message,
        canContinue: false,
      });
      dispatchFlow({
        type: "FETCH_DONE",
        partial: true,
        summary: { successCount, skippedCount, failedCount },
      });
      toast.error(t("codexWizard.toast.fetchAborted", { message }), {
        closeButton: true,
      });
    }
  };

  // 对每个 provider 的每个可见模型发起 Responses + Chat 双协议探测；这是用户确认后的真实上游请求。
  const probeResponsesConnectivity = async () => {
    setIsConnectivityConfirmOpen(false);
    dispatchFlow({ type: "PROBE_START" });
    clearWizardIssuesForStage("prepare");
    const results: WizardConnectivityResult[] = [];
    for (const provider of draftSources) {
      const config = getWizardModelFetchConfig(provider);
      const models = getWizardConnectivityProbeModels(provider);
      if (isWizardCodexOAuthSource(provider)) {
        results.push(
          skippedWizardConnectivityResult(
            provider,
            hasCodexOauthAccount
              ? t("codexWizard.probe.skipOauthBound")
              : t("codexWizard.probe.skipOauthNotLoggedIn"),
          ),
        );
        continue;
      }
      if (!config || !config.apiKey) {
        results.push(
          skippedWizardConnectivityResult(
            provider,
            t("codexWizard.probe.skipNoConfig"),
          ),
        );
        continue;
      }
      if (models.length === 0) {
        results.push(
          skippedWizardConnectivityResult(
            provider,
            t("codexWizard.probe.skipNoModels"),
          ),
        );
        continue;
      }
      for (const model of models) {
        try {
          const responsesProbe = await probeCodexResponsesForConfig(
            config.baseUrl,
            config.apiKey,
            model,
            config.isFullUrl,
            config.customUserAgent,
          );
          const chatProbe = await probeCodexChatForConfig(
            config.baseUrl,
            config.apiKey,
            model,
            config.isFullUrl,
            config.customUserAgent,
          );
          results.push(
            classifyWizardDualProtocolConnectivityResult({
              provider,
              model,
              responses: {
                ok: responsesProbe.ok,
                detail: responsesProbe.detail,
                url: responsesProbe.url,
                httpStatus: responsesProbe.status,
              },
              chat: {
                ok: chatProbe.ok,
                detail: chatProbe.detail,
                url: chatProbe.url,
                httpStatus: chatProbe.status,
              },
            }),
          );
        } catch (error) {
          const message = formatWizardError(error);
          const classified = classifyWizardConnectivityResult({
            provider,
            model,
            ok: false,
            detail: message,
          });
          recordWizardIssue({
            stage: "prepare",
            severity: classified.canContinue ? "warning" : "error",
            title: t("codexWizard.issues.probeError.title"),
            detail: message,
            canContinue: classified.canContinue,
            providerName: provider.name,
          });
          results.push(classified);
        }
      }
    }

    const summary = {
      passCount: results.filter((result) => result.status === "pass").length,
      warnCount: results.filter((result) => result.status === "warn").length,
      skippedCount: results.filter((result) => result.status === "skipped")
        .length,
      failCount: results.filter((result) => result.status === "fail").length,
    };
    setConnectivityResults(results);
    dispatchFlow({
      type: "PROBE_DONE",
      canContinue: canContinueAfterConnectivity(results),
      hasWarnings: summary.warnCount > 0 || summary.skippedCount > 0,
      summary,
    });
    toast.success(
      t("codexWizard.toast.probeComplete", {
        pass: summary.passCount,
        warn: summary.warnCount,
        skipped: summary.skippedCount,
        failed: summary.failCount,
      }),
      { closeButton: true },
    );
  };

  // 保存 MultiRouter provider；这里才真正写入 DB，不会静默切换当前 Codex provider。
  const saveMultiRouterPlan = () => {
    if (saveInFlightRef.current) return;
    const saveOperation = (async () => {
      dispatchFlow({ type: "SAVE_START" });
      clearWizardIssuesForStage("activate");
      try {
        const routeReadySources = applyWizardConnectivityApiFormatOverrides(
          draftSources,
          connectivityResults,
        );
        const result = buildCodexMultiRouterWizardPlan(
          providers,
          routeReadySources,
          activePlan,
          {
            planId: activePlan?.id ?? createPlanIdRef.current ?? undefined,
            planName: draftPlanName,
            catalogModelOrder: activeCatalogModelOrder,
            spawnAgentModels: activeSpawnAgentModels,
            officialAuth: draftOfficialAuth,
            hostedTools: {
              webSearch: { enabled: webSearchEnabled },
              imageGeneration: { enabled: imageGenerationEnabled },
            },
          },
        );
        for (const source of routeReadySources) {
          const draftSource = draftSources.find(
            (item) => item.id === source.id,
          );
          if (
            draftSource &&
            JSON.stringify(draftSource.settingsConfig?.modelCatalog ?? null) !==
              JSON.stringify(source.settingsConfig?.modelCatalog ?? null)
          ) {
            await providersApi.update(source, "codex", undefined, true);
          }
        }
        let savedProvider = result.plan;
        if (activePlan) {
          await providersApi.update(result.plan, "codex", undefined, true);
        } else {
          await providersApi.add(result.plan, "codex", false, true);
          savedProvider = await codexSubagentV2Api.initializeProviderConfig(
            result.plan.id,
          );
        }
        setSavedPlan(savedProvider);
        setDraftSources(result.sourceProviders);
        await queryClient.invalidateQueries({
          queryKey: ["providers", "codex"],
        });
        toast.success(t("codexWizard.toast.saved"), { closeButton: true });
        dispatchFlow({ type: "SAVE_SUCCESS" });
      } catch (error) {
        const message = formatWizardError(error);
        recordWizardIssue({
          stage: "activate",
          severity: "error",
          title: t("codexWizard.issues.saveFailed.title"),
          detail: message,
          canContinue: false,
        });
        dispatchFlow({ type: "SAVE_ERROR", error: message });
        toast.error(t("codexWizard.toast.saveFailed", { message }), {
          closeButton: true,
        });
      }
    })();
    saveInFlightRef.current = saveOperation.finally(() => {
      saveInFlightRef.current = null;
    });
  };

  // 启用动作复用 App 里的 switchProvider 路径，保证 Codex 接管和 OAuth 保留逻辑保持一致。
  const enableSavedPlan = async () => {
    if (!savedPlan) return;
    dispatchFlow({ type: "ENABLE_START" });
    clearWizardIssuesForStage("activate");
    try {
      await onEnablePlan(savedPlan);
      dispatchFlow({ type: "ENABLE_SUCCESS" });
      toast.success(t("codexWizard.toast.enabled"), {
        closeButton: true,
        duration: 12000,
      });
      closeWizard(false);
    } catch (error) {
      const message = formatWizardError(error);
      recordWizardIssue({
        stage: "activate",
        severity: "error",
        title: t("codexWizard.issues.enableFailed.title"),
        detail: message,
        canContinue: false,
      });
      dispatchFlow({ type: "ENABLE_ERROR", error: message });
      toast.error(t("codexWizard.toast.enableFailed", { message }), {
        closeButton: true,
      });
    }
  };

  if (!open) return null;

  const planPreviewResult = buildCodexMultiRouterWizardPlan(
    providers,
    routeReadySources,
    activePlan,
    {
      planId: activePlan?.id ?? createPlanIdRef.current ?? undefined,
      planName: draftPlanName,
      catalogModelOrder: activeCatalogModelOrder,
      spawnAgentModels: activeSpawnAgentModels,
      officialAuth: draftOfficialAuth,
    },
  );
  const planPreview = planPreviewResult.plan;
  const previewRoutes = (planPreview.settingsConfig.codexRouting?.routes ??
    []) as CodexRoutingRouteV2[];
  const previewModels = buildWizardModelCatalog(
    resolveWizardModelNameCollisions(planPreviewResult.sourceProviders),
    { catalogModelOrder: activeCatalogModelOrder },
  ).models;
  const aliasSelectionIssues = collectWizardRouteAliasSelectionIssues(
    previewRoutes,
    routeReadySources,
  );
  const previewProvidersById = new Map(
    routeReadySources.map((provider) => [provider.id, provider]),
  );
  const availableModelByName = new Map(
    availableCatalogModels.map((model) => [model.model, model]),
  );
  const selectModelRows = [
    ...activeCatalogModelOrder
      .map((model) => availableModelByName.get(model))
      .filter((model): model is CodexCatalogModel => Boolean(model)),
    ...availableCatalogModels.filter(
      (model) => !activeCatalogModelOrder.includes(model.model),
    ),
  ];

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center overflow-hidden bg-black/70 p-3 text-foreground backdrop-blur-sm sm:p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="codex-multirouter-wizard-title"
        data-testid="codex-multirouter-wizard-shell"
        className="flex max-h-full min-h-0 w-full flex-col overflow-hidden rounded-xl border border-border/60 bg-background shadow-2xl sm:w-[min(96vw,1280px)] sm:rounded-2xl"
      >
        <div className="flex shrink-0 items-start justify-between border-b border-border/60 bg-gradient-to-r from-blue-500/10 via-background to-violet-500/10 px-4 py-3 sm:px-5 sm:py-4">
          <div className="flex items-start gap-3">
            <div className="rounded-md bg-primary/10 p-2 text-primary">
              <CurrentStepIcon className="h-5 w-5" />
            </div>
            <div>
              <div className="text-sm text-muted-foreground">
                {t("codexWizard.header.stepCounter", {
                  current: stepIndex + 1,
                  total: STEPS.length,
                })}
              </div>
              <h2
                id="codex-multirouter-wizard-title"
                className="text-lg font-semibold sm:text-xl"
              >
                {t(currentStep.title)}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {t(currentStep.description)}
              </p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => closeWizard(true)}
            aria-label={t("codexWizard.header.closeAria")}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div
          data-testid="codex-multirouter-wizard-body"
          className="flex min-h-0 flex-1 flex-col overflow-hidden sm:grid sm:grid-cols-[15rem_minmax(0,1fr)]"
        >
          <div className="grid shrink-0 grid-cols-2 gap-1 border-b border-border/60 bg-gradient-to-b from-blue-500/8 via-muted/25 to-violet-500/8 p-2 sm:block sm:space-y-1 sm:overflow-y-auto sm:border-b-0 sm:border-r sm:p-3">
            {STEPS.map((step, index) => {
              const StepIcon = step.icon;
              return (
                <button
                  key={step.key}
                  type="button"
                  className={`flex min-w-0 items-center gap-2 rounded-md px-3 py-2 text-left text-sm sm:w-full ${
                    index === stepIndex
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-muted"
                  }`}
                  onClick={() =>
                    dispatchFlow({ type: "GOTO_STEP", stepKey: step.key })
                  }
                >
                  <StepIcon className="h-4 w-4 shrink-0" />
                  <span className="truncate">{t(step.title)}</span>
                </button>
              );
            })}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-5">
            <div
              role="status"
              aria-atomic="true"
              className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/60 bg-gradient-to-r from-blue-500/10 via-background to-violet-500/10 px-4 py-3"
            >
              <div>
                <div className="text-sm font-semibold">
                  {activePlan
                    ? t("codexWizard.header.editingPlan", {
                        name: activePlan.name,
                      })
                    : t("codexWizard.header.creatingPlan")}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {activePlan
                    ? activePlan.id
                    : t("codexWizard.header.creatingHint")}
                </div>
              </div>
              <Badge variant="outline">
                {activePlan
                  ? t("codexWizard.header.badgeEdit")
                  : t("codexWizard.header.badgeCreate")}
              </Badge>
            </div>
            {editingTargetMissing ? (
              <div
                role="alert"
                className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
              >
                {t("codexWizard.header.targetMissing")}
              </div>
            ) : null}
            <div role="status" aria-live="polite" className="sr-only">
              <span>
                {t("codexWizard.header.stateMachineLabel")}
                {flowState.status}
              </span>
              <span>{wizardStatusText(t, flowState)}</span>
            </div>
            {flowState.lastError && wizardIssues.length === 0 ? (
              <div
                role="alert"
                className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
              >
                {flowState.lastError}
              </div>
            ) : null}
            {wizardIssues.length > 0 && (
              <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
                <div className="font-medium text-foreground">
                  {t("codexWizard.issues.panelTitle")}
                </div>
                <div className="mt-2 space-y-2">
                  {wizardIssues.map((issue) => (
                    <div
                      key={issue.id}
                      className="rounded-md border bg-background/80 p-2"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge
                          variant={
                            issue.severity === "error"
                              ? "destructive"
                              : "outline"
                          }
                        >
                          {issue.severity === "error"
                            ? t("codexWizard.issues.severityError")
                            : t("codexWizard.issues.severityWarning")}
                        </Badge>
                        <span className="font-medium">{issue.title}</span>
                        {issue.providerName && (
                          <span className="text-xs text-muted-foreground">
                            {issue.providerName}
                          </span>
                        )}
                        <span className="text-xs text-muted-foreground">
                          {issue.canContinue
                            ? t("codexWizard.issues.canContinue")
                            : t("codexWizard.issues.needsAttention")}
                        </span>
                      </div>
                      <div className="mt-1 break-words text-xs text-muted-foreground">
                        {issue.detail}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {currentStep.key === "sources" && (
              <div className="space-y-4">
                <div className="rounded-xl border border-border/60 bg-gradient-to-r from-sky-500/10 via-background to-cyan-500/10 p-4 text-sm leading-6">
                  <div className="font-medium">
                    {t("codexWizard.sources.onlyTitle")}
                  </div>
                  <p className="mt-1 text-muted-foreground">
                    {t("codexWizard.sources.onlyDescription")}
                  </p>
                </div>
              </div>
            )}

            {currentStep.key === "sources" && (
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm text-muted-foreground">
                    {t("codexWizard.sources.selectedSummary", {
                      selected: draftSources.length,
                      total: providerModelSources.length,
                    })}
                  </p>
                  <Button onClick={onCreateProvider}>
                    <Server className="mr-2 h-4 w-4" />
                    {t("codexWizard.sources.addProvider")}
                  </Button>
                </div>
                <div className="max-h-[min(42vh,28rem)] overflow-y-auto pr-2">
                  <div className="grid gap-3 md:grid-cols-2">
                    {providerModelSources.map((provider) => (
                      <div
                        key={provider.id}
                        className="rounded-xl border border-border/60 bg-card/70 p-3 shadow-sm"
                      >
                        <label className="flex cursor-pointer items-start gap-3">
                          <input
                            type="checkbox"
                            className="mt-1 h-4 w-4"
                            checked={selectedSourceIdSet.has(provider.id)}
                            onChange={(event) =>
                              toggleSourceProvider(
                                provider,
                                event.target.checked,
                              )
                            }
                            aria-label={t(
                              "codexWizard.sources.useAsSourceAria",
                              {
                                name: provider.name,
                              },
                            )}
                          />
                          <span className="min-w-0">
                            <span className="block font-medium">
                              {provider.name}
                            </span>
                            <span className="mt-1 block text-xs text-muted-foreground">
                              {provider.id}
                            </span>
                          </span>
                        </label>
                        <div className="mt-3 flex items-center justify-between gap-3">
                          <Badge variant="outline">
                            {modelSourceSummary(t, provider)}
                          </Badge>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            aria-label={t("codexWizard.sources.configureAria", {
                              name: provider.name,
                            })}
                            onClick={() => onOpenProviderConfig?.(provider)}
                          >
                            {t("codexWizard.sources.configureProvider")}
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                {draftSources.length === 0 && (
                  <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                    {t("codexWizard.sources.emptyNeedSources")}
                  </div>
                )}
              </div>
            )}

            {currentStep.key === "review" && (
              <div className="space-y-4">
                <div className="rounded-lg border p-4">
                  <label className="text-sm font-medium" htmlFor="plan-name">
                    {t("codexWizard.review.planNameLabel")}
                  </label>
                  <Input
                    id="plan-name"
                    className="mt-2"
                    value={draftPlanName}
                    onChange={(event) => setDraftPlanName(event.target.value)}
                    placeholder={t("codexWizard.review.planNamePlaceholder")}
                  />
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    {t("codexWizard.review.planNameHelp")}
                  </p>
                </div>
              </div>
            )}

            {currentStep.key === "prepare" && (
              <div className="space-y-4">
                <div className="flex flex-wrap gap-3">
                  <Button
                    onClick={refreshModelSources}
                    disabled={
                      isRefreshingModels ||
                      isProbingConnectivity ||
                      draftSources.length === 0
                    }
                  >
                    <RefreshCw
                      className={`mr-2 h-4 w-4 ${
                        isRefreshingModels ? "animate-spin" : ""
                      }`}
                    />
                    {t("codexWizard.prepare.fetchModelsButton")}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => setIsConnectivityConfirmOpen(true)}
                    disabled={
                      isRefreshingModels ||
                      isProbingConnectivity ||
                      draftSources.length === 0
                    }
                  >
                    <Route
                      className={`mr-2 h-4 w-4 ${
                        isProbingConnectivity ? "animate-pulse" : ""
                      }`}
                    />
                    {t("codexWizard.prepare.testConnectivityButton")}
                  </Button>
                </div>
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200">
                  {t("codexWizard.prepare.connectivityWarning")}
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  {draftSources.map((provider) => {
                    const cardState =
                      modelFetchCards[provider.id] ??
                      defaultModelFetchCardState(t, provider);
                    const diffText = formatModelFetchDiff(t, cardState.diff);
                    return (
                      <button
                        key={provider.id}
                        type="button"
                        className="rounded-lg border p-3 text-left transition hover:border-primary/60 hover:bg-muted/40 focus:outline-none focus:ring-2 focus:ring-primary/40"
                        onClick={() => onOpenProviderConfig?.(provider)}
                        aria-label={t("codexWizard.prepare.openConfigAria", {
                          name: provider.name,
                        })}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate font-medium">
                              {provider.name}
                            </div>
                            <div className="mt-2 text-sm text-muted-foreground">
                              {t("codexWizard.prepare.modelCountBadge", {
                                modelCount: cardState.modelCount,
                              })}
                            </div>
                            <div className="mt-2 space-y-0.5 text-xs leading-5 text-muted-foreground">
                              {modelSourceStatusDetails(t, provider).map(
                                (detail) => (
                                  <div key={detail}>{detail}</div>
                                ),
                              )}
                            </div>
                          </div>
                          <Badge
                            variant={modelFetchBadgeVariant(cardState.status)}
                            className="shrink-0 gap-1"
                          >
                            {cardState.status === "loading" && (
                              <RefreshCw className="h-3 w-3 animate-spin" />
                            )}
                            {modelFetchStatusLabel(t, cardState.status)}
                          </Badge>
                        </div>
                        <div className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">
                          {cardState.message}
                        </div>
                        {diffText && (
                          <div className="mt-2 line-clamp-2 rounded-md bg-primary/10 px-2 py-1 text-xs leading-5 text-primary">
                            {diffText}
                          </div>
                        )}
                        <div className="mt-2 text-xs text-muted-foreground">
                          {t("codexWizard.prepare.clickToOpenConfig")}
                        </div>
                      </button>
                    );
                  })}
                </div>
                {connectivityResults.length > 0 && (
                  <div className="max-h-80 overflow-auto rounded-lg border">
                    {connectivityResults.map((result, index) => (
                      <div
                        key={`${result.providerId}:${result.model}:${index}`}
                        className="grid grid-cols-[7rem_1fr] gap-3 border-b px-3 py-2 text-sm last:border-b-0"
                      >
                        <Badge
                          variant={
                            result.status === "fail" ? "destructive" : "outline"
                          }
                          className="h-fit justify-center"
                        >
                          {result.status}
                        </Badge>
                        <div>
                          <div className="font-medium">
                            {result.providerName} / {result.model}
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {result.detail}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {currentStep.key === "prepare" && (
              <div className="space-y-4">
                <Button
                  variant="outline"
                  onClick={() =>
                    setDraftSources(
                      resolveWizardModelNameCollisions(draftSources),
                    )
                  }
                >
                  <ShieldAlert className="mr-2 h-4 w-4" />
                  {t("codexWizard.prepare.recalcAliases")}
                </Button>
                <div className="rounded-lg border p-4 text-sm text-muted-foreground">
                  {t("codexWizard.prepare.aliasPolicyExplanation")}
                </div>
                {modelCollisions.length > 0 && (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200">
                    {t("codexWizard.prepare.collisionsDetected", {
                      collisionCount: modelCollisions.length,
                    })}
                  </div>
                )}
                <div className="max-h-72 overflow-auto rounded-lg border">
                  {previewModels.slice(0, 80).map((model) => (
                    <div
                      key={`${model.model}:${model.upstreamModel ?? ""}`}
                      className="flex items-center justify-between border-b px-3 py-2 text-sm last:border-b-0"
                    >
                      <span>{model.model}</span>
                      <span className="text-muted-foreground">
                        {model.upstreamModel &&
                        model.upstreamModel !== model.model
                          ? t("codexWizard.preview.upstreamModel", {
                              model: model.upstreamModel,
                            })
                          : t("codexWizard.preview.originalName")}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {currentStep.key === "review" && (
              <div className="space-y-4">
                <div className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
                  {t("codexWizard.select.followExplanation")}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setCatalogModelOrder(null)}
                  >
                    {t("codexWizard.select.followAllModels")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setCatalogModelOrder([]);
                      setDraftSpawnAgentModels([]);
                    }}
                  >
                    {t("codexWizard.select.clearAll")}
                  </Button>
                  <Badge variant="outline">
                    {t("codexWizard.select.keptCount", {
                      kept: activeCatalogModelOrder.length,
                      total: availableCatalogModels.length,
                    })}
                  </Badge>
                  <Badge
                    className={
                      catalogModelOrder === null
                        ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-500/50 dark:bg-emerald-500/10 dark:text-emerald-100"
                        : "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/50 dark:bg-amber-500/10 dark:text-amber-100"
                    }
                  >
                    {catalogModelOrder === null
                      ? t("codexWizard.select.autoFollowProvider")
                      : t("codexWizard.select.fixedFilter")}
                  </Badge>
                </div>
                <div className="max-h-[min(50vh,34rem)] overflow-auto rounded-lg border">
                  {selectModelRows.map((model) => {
                    const kept = activeCatalogModelOrder.includes(model.model);
                    const orderIndex = activeCatalogModelOrder.indexOf(
                      model.model,
                    );
                    return (
                      <div
                        key={`${model.model}:${model.upstreamModel ?? ""}`}
                        className="grid grid-cols-[2rem_minmax(0,1fr)_8rem_5rem] items-center gap-3 border-b px-3 py-2 text-sm last:border-b-0"
                      >
                        <input
                          type="checkbox"
                          className="h-4 w-4"
                          checked={kept}
                          onChange={(event) =>
                            toggleCatalogModel(
                              model.model,
                              event.target.checked,
                            )
                          }
                          aria-label={t("codexWizard.select.keepModelAria", {
                            model: model.model,
                          })}
                        />
                        <div className="min-w-0">
                          <div className="truncate font-medium">
                            {model.model}
                          </div>
                          <div className="truncate text-xs text-muted-foreground">
                            {model.upstreamModel &&
                            model.upstreamModel !== model.model
                              ? t("codexWizard.preview.upstreamModel", {
                                  model: model.upstreamModel,
                                })
                              : model.displayName ||
                                t("codexWizard.preview.originalName")}
                          </div>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {model.contextWindow
                            ? `${model.contextWindow} ctx`
                            : t("codexWizard.select.contextUnknown")}
                        </div>
                        <div className="flex items-center gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            disabled={!kept || orderIndex <= 0}
                            onClick={() => moveCatalogModel(model.model, -1)}
                            title={t("codexWizard.select.moveUp")}
                          >
                            <ArrowUp className="h-4 w-4" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            disabled={
                              !kept ||
                              orderIndex < 0 ||
                              orderIndex >= activeCatalogModelOrder.length - 1
                            }
                            onClick={() => moveCatalogModel(model.model, 1)}
                            title={t("codexWizard.select.moveDown")}
                          >
                            <ArrowDown className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {currentStep.key === "review" && (
              <div className="space-y-3">
                <div className="grid gap-3 rounded-lg border bg-muted/30 p-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">
                      {t("codexWizard.auth.modeLabel")}
                    </label>
                    <Select
                      value={draftOfficialAuth.mode}
                      onValueChange={(value) =>
                        setDraftOfficialAuth({
                          mode: value as CodexOfficialAuthMode,
                        })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="desktop_current_login">
                          {t("codexWizard.auth.desktopItem")}
                        </SelectItem>
                        <SelectItem value="managed_oauth">
                          {t("codexWizard.auth.ccsmItem")}
                        </SelectItem>
                        <SelectItem value="account_pool">
                          {t("codexWizard.auth.poolItem")}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {draftOfficialAuth.mode === "managed_oauth" ? (
                    <div className="space-y-2">
                      <label className="text-sm font-medium">
                        {t("codexWizard.auth.ccsmAccountLabel")}
                      </label>
                      <Select
                        value={draftOfficialAuth.accountId ?? "__default__"}
                        onValueChange={(value) =>
                          setDraftOfficialAuth({
                            mode: "managed_oauth",
                            ...(value !== "__default__"
                              ? { accountId: value }
                              : {}),
                          })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__default__">
                            {t("codexWizard.auth.defaultAccount")}
                          </SelectItem>
                          {draftOfficialAuth.accountId &&
                          !codexOauthAccounts.some(
                            (account) =>
                              account.id === draftOfficialAuth.accountId,
                          ) ? (
                            <SelectItem value={draftOfficialAuth.accountId}>
                              {t("codexWizard.auth.savedAccount", {
                                accountId: draftOfficialAuth.accountId,
                              })}
                            </SelectItem>
                          ) : null}
                          {codexOauthAccounts.map((account) => (
                            <SelectItem key={account.id} value={account.id}>
                              {account.login}
                              {account.is_default
                                ? t("codexWizard.auth.defaultSuffix")
                                : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ) : null}
                  <div className="text-xs leading-5 text-muted-foreground md:col-span-2">
                    {draftOfficialAuth.mode === "account_pool"
                      ? t("codexWizard.auth.accountPoolHelp")
                      : draftOfficialAuth.mode === "managed_oauth"
                        ? t("codexWizard.auth.managedOauthHelp")
                        : t("codexWizard.auth.desktopHelp")}
                  </div>
                  {existingPlan &&
                  existingPlan.settingsConfig?.codexRouting?.schemaVersion !==
                    2 ? (
                    <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs leading-5 text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-100 md:col-span-2">
                      {t("codexWizard.auth.legacyNotice")}
                    </div>
                  ) : null}
                </div>
                {previewRoutes.map((route) => (
                  <div key={route.id} className="rounded-lg border p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="font-medium">
                        {wizardRouteDisplayLabel(
                          route,
                          previewProvidersById.get(route.targetProviderId)
                            ?.name,
                        )}
                      </div>
                      <Badge
                        variant="outline"
                        title={`Provider ID: ${route.targetProviderId}`}
                      >
                        {previewProvidersById.get(route.targetProviderId)
                          ?.name ?? route.targetProviderId}
                      </Badge>
                    </div>
                    <div className="mt-2 text-sm text-muted-foreground">
                      {t("codexWizard.route.modelScopeLabel")}
                      {route.modelSelection?.mode === "all"
                        ? t("codexWizard.route.allModels")
                        : t("codexWizard.route.canonicalModelCount", {
                            modelCount: (route.modelSelection?.models ?? [])
                              .length,
                          })}
                      {t("codexWizard.route.prefixesLabel")}
                      {(route.matchPrefixes ?? []).join(", ") ||
                        t("codexWizard.route.none")}
                    </div>
                    <div className="mt-2 text-xs leading-5 text-muted-foreground">
                      {t("codexWizard.route.authLabel")}
                      {route.authPolicy?.source === "native_codex_auth"
                        ? t("codexWizard.auth.desktopItem")
                        : route.authPolicy?.source === "account_pool"
                          ? t("codexWizard.auth.poolItem")
                          : route.authPolicy?.source === "managed_codex_oauth"
                            ? t("codexWizard.auth.ccsmItem")
                            : t("codexWizard.route.sourceCredentials")}
                      {t("codexWizard.route.transportLabel")}
                    </div>
                    <div className="mt-2 rounded-md bg-muted px-3 py-2 text-xs leading-5 text-muted-foreground">
                      {t("codexWizard.route.configNote")}
                    </div>
                  </div>
                ))}
                {aliasSelectionIssues.length > 0 ? (
                  <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                    <div className="font-medium">
                      {t("codexWizard.aliases.title")}
                    </div>
                    <div className="mt-1 space-y-1 text-xs leading-5">
                      {aliasSelectionIssues.map((issue) => (
                        <div key={`${issue.routeId}:${issue.alias}`}>
                          Route {issue.routeLabel || issue.routeId}
                          {issue.routeLabel &&
                          issue.routeLabel !== issue.routeId
                            ? `（${issue.routeId}）`
                            : ""}
                          {issue.providerName
                            ? ` / Provider ${issue.providerName}`
                            : ""}
                          {t("codexWizard.aliases.issueConnector", {
                            alias: issue.alias,
                            canonicalModel: issue.canonicalModel,
                          })}
                          {issue.reason}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            )}

            {currentStep.key === "activate" && (
              <div className="space-y-4">
                <div className="rounded-lg border p-4 text-sm text-muted-foreground">
                  {t("codexWizard.activate.saveSummary", {
                    routeCount: previewRoutes.length,
                    modelCount: previewModels.length,
                    target: activePlan
                      ? activePlan.name
                      : t("codexWizard.activate.newPlanTarget"),
                  })}
                </div>
                {draftSources.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-amber-500/40 bg-amber-500/10 p-4 text-sm leading-6 text-amber-900 dark:text-amber-100">
                    {t("codexWizard.activate.noSourcesWarning")}
                  </div>
                ) : null}
                <Button
                  onClick={saveMultiRouterPlan}
                  disabled={
                    isSavingPlan ||
                    editingTargetMissing ||
                    draftSources.length === 0 ||
                    aliasSelectionIssues.length > 0 ||
                    (connectivityResults.length > 0 &&
                      !canContinueAfterConnectivity(connectivityResults))
                  }
                >
                  <Database className="mr-2 h-4 w-4" />
                  {isSavingPlan
                    ? t("codexWizard.activate.saving")
                    : t("codexWizard.activate.saveAndPublish")}
                </Button>
              </div>
            )}

            {currentStep.key === "activate" && (
              <div className="space-y-4">
                <div className="rounded-lg border p-4 text-sm leading-6 text-muted-foreground">
                  {t("codexWizard.activate.enableInstructions")}
                </div>
                <div className="flex flex-wrap gap-3">
                  <Button
                    onClick={enableSavedPlan}
                    disabled={!savedPlan || isEnablingPlan}
                  >
                    <CheckCircle2 className="mr-2 h-4 w-4" />
                    {t("codexWizard.activate.enableButton")}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={!savedPlan}
                    onClick={() => {
                      if (!savedPlan) return;
                      closeWizard(false);
                      onOpenWorkspace(savedPlan, "status");
                    }}
                  >
                    <Route className="mr-2 h-4 w-4" />
                    {t("codexWizard.activate.openStatusButton")}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>

        <Dialog
          open={isConnectivityConfirmOpen}
          onOpenChange={setIsConnectivityConfirmOpen}
        >
          <DialogContent className="max-w-lg" zIndex="top">
            <DialogHeader>
              <DialogTitle>{t("codexWizard.confirm.title")}</DialogTitle>
              <DialogDescription className="space-y-2 text-left">
                <span className="block">
                  {t("codexWizard.confirm.description1")}
                </span>
                <span className="block">
                  {t("codexWizard.confirm.description2")}
                </span>
                <span className="block">
                  {t("codexWizard.confirm.description3")}
                </span>
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsConnectivityConfirmOpen(false)}
              >
                {t("codexWizard.common.cancel")}
              </Button>
              <Button type="button" onClick={probeResponsesConnectivity}>
                {t("codexWizard.confirm.startButton")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog
          open={
            resolvedMode === "edit" &&
            Boolean(storedExistingPlan) &&
            storedExistingPlan?.settingsConfig?.codexRouting?.schemaVersion !==
              2 &&
            !migratedPlanOverride
          }
          onOpenChange={(nextOpen) => {
            if (!nextOpen && !isApplyingMigration) closeWizard(false);
          }}
        >
          <DialogContent className="max-w-2xl" zIndex="top">
            <DialogHeader>
              <DialogTitle>{t("codexWizard.migrate.title")}</DialogTitle>
              <DialogDescription>
                {t("codexWizard.migrate.description")}
              </DialogDescription>
            </DialogHeader>
            {isLoadingMigration ? (
              <div className="rounded-md border p-3 text-sm text-muted-foreground">
                {t("codexWizard.migrate.generating")}
              </div>
            ) : migrationPreview ? (
              <div className="space-y-3 text-sm">
                <div className="grid gap-2 sm:grid-cols-3">
                  <div className="rounded-md border p-3">
                    {t("codexWizard.migrate.removedFieldsLabel")}
                    {migrationPreview.diff.removedRouteFields.length}
                  </div>
                  <div className="rounded-md border p-3">
                    {t("codexWizard.migrate.changedRefsLabel")}
                    {migrationPreview.diff.changedRouteIds.length}
                  </div>
                  <div className="rounded-md border p-3">
                    {t("codexWizard.migrate.createdProvidersLabel")}
                    {migrationPreview.generatedProviders.length}
                  </div>
                </div>
                {migrationPreview.generatedProviders.map((provider) => (
                  <div key={provider.id} className="rounded-md border p-3">
                    {t("codexWizard.migrate.providerLine", {
                      name: provider.name,
                      id: provider.id,
                      source: provider.sourceProviderId,
                    })}
                  </div>
                ))}
                {migrationPreview.warnings.map((warning) => (
                  <div
                    key={warning}
                    className="rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-100"
                  >
                    {warning}
                  </div>
                ))}
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
                onClick={() => closeWizard(false)}
              >
                {t("codexWizard.migrate.cancelEdit")}
              </Button>
              <Button
                disabled={!migrationPreview || isApplyingMigration}
                onClick={() => void applyLegacyMigration()}
              >
                {isApplyingMigration
                  ? t("codexWizard.migrate.applying")
                  : t("codexWizard.migrate.applyAndContinue")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <div className="flex shrink-0 items-center justify-between border-t px-3 py-3 sm:px-5 sm:py-4">
          <Button variant="ghost" onClick={() => closeWizard(true)}>
            {t("codexWizard.footer.skip")}
          </Button>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={retreatWizard}
              disabled={stepIndex === 0}
            >
              <ArrowLeft className="mr-2 h-4 w-4" />
              {t("codexWizard.footer.prev")}
            </Button>
            <Button onClick={advanceWizard}>
              {stepIndex === STEPS.length - 1
                ? t("codexWizard.footer.close")
                : t("codexWizard.footer.next")}
              {stepIndex !== STEPS.length - 1 && (
                <ArrowRight className="ml-2 h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
