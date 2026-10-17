import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bot,
  CheckCircle2,
  Database,
  GitBranch,
  GripVertical,
  History,
  RefreshCw,
  Route,
  Server,
  ShieldAlert,
  SlidersHorizontal,
  Wand2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import type { CodexCatalogModel, CodexRoutingRouteV2, Provider } from "@/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { providersApi } from "@/lib/api/providers";
import { restoreCodexProviderProtocolEvidence } from "@/lib/api/protocol-compatibility";
import type { CodexMultiRouterMigrationPreview } from "@/lib/api/providers";
import {
  fetchCodexOfficialFallbackModels,
  fetchCodexOauthModels,
  fetchModelsForConfig,
} from "@/lib/api/model-fetch";
import {
  type CodexProviderProtocolPreflightOutcome,
  type CodexProviderSetBatchPreview,
} from "@/lib/api/protocol-compatibility";
import {
  codexProviderModelsRequiringProtocolProbe,
  createBatchCodexProtocolLabAdapter,
  providerHasAutomaticCodexModels,
  type CodexProviderSetBatchDraft,
  type CodexProviderSetBatchProbeOutcome,
} from "@/lib/protocol-lab/codex-adapters";
import {
  ProtocolLabCancelled,
  useProtocolLabWorkflow,
} from "@/lib/protocol-lab/useProtocolLabWorkflow";
import {
  CODEX_MULTI_ROUTER_DEFAULT_NAME,
  CODEX_MULTI_ROUTER_DEFAULT_ID,
  CODEX_MULTI_ROUTER_WIZARD_DISMISSED_KEY,
  buildCodexMultiRouterWizardPlan,
  initialWizardCatalogModelOrder,
  initialWizardSelectedSourceIds,
  initialWizardSpawnAgentModels,
  buildWizardModelCatalog,
  canContinueAfterConnectivity,
  collectWizardModelNameCollisions,
  collectWizardRouteAliasSelectionIssues,
  defaultWizardModelSources,
  getWizardConnectivityProbeModels,
  getWizardConfigIssues,
  getWizardModelFetchConfig,
  isWizardCatalogOnlyModelSource,
  isWizardCodexOAuthSource,
  inferWizardApiFormat,
  isCodexMultiRouterPlan,
  mergeFetchedModelsIntoWizardProvider,
  readWizardCodexOAuthAccountId,
  readWizardModelCatalog,
  readIncludedWizardModelCatalog,
  readWizardProviderBaseUrl,
  resolveWizardModelNameCollisions,
  wizardRouteDisplayLabel,
  type WizardConnectivityResult,
  type WizardModelFetchConfig,
} from "@/lib/codexMultiRouterWizard";
import { readCodexCatalogSettings } from "@/lib/codexCatalogSchema";
import {
  codexModelProtocolDeclarationStatus,
  readCodexModelProtocolCapability,
} from "@/lib/codexProtocolCapability";
import { normalizeCodexPublicModelKey } from "@/lib/protocol-lab/codex-overrides";
import i18n from "@/i18n";
import {
  DEFAULT_HOSTED_TOOLS_CONFIG,
  readHostedToolsConfig,
} from "@/lib/hostedTools";
import type { WorkspaceTab } from "@/components/codex/CodexRouterWorkspacePage";
import { codexCatalogOnlyPlanModelFetchMessage } from "@/utils/codexPlanModelFetch";
import { useCodexOauth } from "@/components/providers/forms/hooks/useCodexOauth";
import { CodexProtocolProbeProgressDialog } from "@/components/providers/forms/CodexProtocolProbeProgressDialog";
import { CodexProviderSetPreviewDialog } from "@/components/providers/forms/CodexProviderSetPreviewDialog";
import {
  buildWizardPageSequence,
  canEnterWizardPage,
  requiredWizardPrerequisite,
  type WizardFlowContext,
  type WizardPageKey,
} from "@/lib/codexMultiRouterWizardFlow";

interface CodexMultiRouterWizardProps {
  open: boolean;
  providers: Provider[];
  mode?: "create" | "edit";
  planId?: string;
  newlyCreatedProviderIds?: string[];
  onOpenChange: (open: boolean) => void;
  onCreateProvider: () => void;
  onOpenProviderConfig?: (provider: Provider) => void;
  onOpenHistoryRepair?: () => void;
  onOpenWorkspace: (provider: Provider, tab: WorkspaceTab) => void;
  onEnablePlan: (provider: Provider) => void | Promise<void>;
}

interface WizardStep {
  key: WizardPageKey;
  title: string;
  description: string;
  icon: typeof Wand2;
}

interface WizardIssue {
  id: string;
  stage: WizardPageKey;
  severity: "error" | "warning";
  title: string;
  detail: string;
  canContinue: boolean;
  providerName?: string;
}

type ModelFetchCardStatus =
  "idle" | "loading" | "updated" | "unchanged" | "skipped" | "error";

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

const ALL_STEPS: WizardStep[] = [
  {
    key: "welcome",
    title: "Start setup",
    description:
      "Learn what the wizard checks, when it sends test requests, and when changes are actually enabled.",
    icon: Wand2,
  },
  {
    key: "inventory",
    title: "Environment check",
    description:
      "Inspect existing providers, MultiRouter plans, and the current configuration scope.",
    icon: Database,
  },
  {
    key: "first-provider",
    title: "Connect the first model source",
    description:
      "No provider is available yet. Connect one model source before returning to validate it.",
    icon: Server,
  },
  {
    key: "readiness",
    title: "Model source readiness",
    description:
      "Review authentication, model catalogs, protocol evidence, capabilities, and repairable issues.",
    icon: ShieldAlert,
  },
  {
    key: "sources",
    title: "Choose model sources",
    description:
      "Choose connected providers, or add a new Codex model source first.",
    icon: Server,
  },
  {
    key: "catalog",
    title: "Sync model catalogs",
    description:
      "Read each source catalog and show changes; results stay in this draft until final confirmation.",
    icon: RefreshCw,
  },
  {
    key: "protocol",
    title: "Protocol deep probe",
    description:
      "Test Responses and Chat streaming, reasoning, tool calls, and continuation end to end.",
    icon: Route,
  },
  {
    key: "models",
    title: "Choose models",
    description:
      "Choose models visible to Codex and resolve duplicate names across sources.",
    icon: GitBranch,
  },
  {
    key: "model-order",
    title: "Model order",
    description: "Adjust the display order in the Codex model menu.",
    icon: ArrowDown,
  },
  {
    key: "reasoning",
    title: "Reasoning settings",
    description:
      "Review reasoning capabilities and defaults; advanced overrides remain in provider settings.",
    icon: Wand2,
  },
  {
    key: "subagents-tools",
    title: "Sub-Agent and tools",
    description:
      "Configure basic candidate models and Hosted Tools; manage advanced rules in the Sub-Agent workspace.",
    icon: Bot,
  },
  {
    key: "routing-review",
    title: "Review routing",
    description:
      "Review routes, authentication ownership, protocol choices, and all pending changes.",
    icon: GitBranch,
  },
  {
    key: "save-enable",
    title: "Save and enable",
    description:
      "Atomically save and enable MultiRouter, then continue with a real-request check.",
    icon: CheckCircle2,
  },
  {
    key: "acceptance",
    title: "Real-request acceptance",
    description:
      "Send one request from Codex and confirm a valid terminal event on the status page.",
    icon: Route,
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
  | "saveConfirmation"
  | "saveFailed"
  | "published"
  | "enablePrompt"
  | "enabling"
  | "enableFailed"
  | "enabled"
  | "dismissed";

interface WizardFlowState {
  status: WizardFlowStatus;
  stepKey: WizardPageKey;
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
  | { type: "GOTO_STEP"; stepKey: WizardPageKey }
  | { type: "NEXT"; nextStatus: WizardFlowStatus; nextStepKey: WizardPageKey }
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
  | { type: "DISMISS" };

const INITIAL_FLOW_STATE: WizardFlowState = {
  status: "opened",
  stepKey: "welcome",
};

// reducer 是向导的状态机核心；所有异步动作只发事件，不直接改流程状态。
function wizardFlowReducer(
  state: WizardFlowState,
  event: WizardFlowEvent,
): WizardFlowState {
  switch (event.type) {
    case "INIT":
      return {
        status: event.hasSources ? "opened" : "needSources",
        stepKey: "welcome",
      };
    case "GOTO_STEP":
      return {
        ...state,
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
        stepKey: "catalog",
        fetchSummary: event.summary,
      };
    case "PROBE_START":
      return {
        ...state,
        status: "probingConnectivity",
        stepKey: "protocol",
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
        stepKey: event.canContinue ? "models" : "protocol",
        connectivitySummary: event.summary,
      };
    case "SAVE_START":
      return { ...state, status: "savingPlan", lastError: undefined };
    case "SAVE_SUCCESS":
      return { ...state, status: "published", stepKey: "save-enable" };
    case "SAVE_ERROR":
      return {
        ...state,
        status: "saveFailed",
        stepKey: "save-enable",
        lastError: event.error,
      };
    case "ENABLE_START":
      return { ...state, status: "enabling", lastError: undefined };
    case "ENABLE_SUCCESS":
      return { ...state, status: "enabled", stepKey: "acceptance" };
    case "ENABLE_ERROR":
      return {
        ...state,
        status: "enableFailed",
        stepKey: "save-enable",
        lastError: event.error,
      };
    case "DISMISS":
      return { ...state, status: "dismissed" };
    default:
      return state;
  }
}

// 将模型源的模型目录数量转成人可扫读的摘要，避免向导卡片暴露底层 JSON。
function modelSourceSummary(provider: Provider): string {
  const models = readIncludedWizardModelCatalog(provider);
  if (models.length === 0) return "No models fetched";
  return `${models.length} models`;
}

function modelSourceStatusDetails(provider: Provider): string[] {
  const models = readIncludedWizardModelCatalog(provider);
  const fetchConfig = getWizardModelFetchConfig(provider);
  const auth = isWizardCodexOAuthSource(provider)
    ? "OAuth linked"
    : fetchConfig?.apiKey
      ? "API key configured"
      : "Credentials incomplete";
  const protocol = inferWizardApiFormat(provider);
  const capabilityCount = models.filter(
    (model) =>
      model.contextWindow !== undefined ||
      model.supportsImage === true ||
      model.vision === true ||
      model.textOnly !== undefined,
  ).length;
  const tools = provider.settingsConfig?.hostedTools
    ? "Tool configuration declared"
    : "Tools managed by provider";
  const projection = provider.settingsConfig?.codexRouting
    ? "Route projection exists"
    : "Route projection pending";
  return [
    `Auth: ${auth}`,
    `Model catalog: ${models.length}`,
    `Protocol: ${protocol}`,
    `Capabilities: ${capabilityCount}/${models.length} models have capability summaries`,
    `OAuth: ${isWizardCodexOAuthSource(provider) ? "Yes" : "No"}`,
    `Tools/projection: ${tools}; ${projection}`,
  ];
}

// 生成模型目录对比签名；只比较会影响路由、展示、上下文和多模态能力的字段。
function modelCatalogSignature(model: CodexCatalogModel): string {
  const displayName = model.displayName?.trim() || model.model;
  return JSON.stringify({
    enabled: model.enabled !== false,
    upstreamModel: model.upstreamModel ?? model.upstream_model ?? model.model,
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
    beforeModels.map((model) => [model.model, modelCatalogSignature(model)]),
  );
  const afterByModel = new Map(
    afterModels.map((model) => [model.model, modelCatalogSignature(model)]),
  );
  const added = afterModels
    .map((model) => model.model)
    .filter((model) => !beforeByModel.has(model));
  const removed = beforeModels
    .map((model) => model.model)
    .filter((model) => !afterByModel.has(model));
  const changed = afterModels
    .map((model) => model.model)
    .filter(
      (model) =>
        beforeByModel.has(model) &&
        beforeByModel.get(model) !== afterByModel.get(model),
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
function formatModelFetchDiff(diff?: ModelFetchDiff): string | null {
  if (!diff || !hasModelFetchDiff(diff)) return null;
  const parts: string[] = [];
  if (diff.added.length > 0) {
    parts.push(
      `Added ${diff.added.length}: ${diff.added.slice(0, 3).join(", ")}`,
    );
  }
  if (diff.removed.length > 0) {
    parts.push(
      `Removed ${diff.removed.length}: ${diff.removed.slice(0, 3).join(", ")}`,
    );
  }
  if (diff.changed.length > 0) {
    parts.push(
      `Changed ${diff.changed.length}: ${diff.changed.slice(0, 3).join(", ")}`,
    );
  }
  return parts.join("; ");
}

// 给未刷新过的 provider 卡片提供稳定默认状态。
function defaultModelFetchCardState(provider: Provider): ModelFetchCardState {
  return {
    status: "idle",
    message: "Waiting to read model list",
    modelCount: readIncludedWizardModelCatalog(provider).length,
  };
}

// 模型读取状态的 badge 统一在这里收口，保证顶部按钮和卡片语义一致。
function modelFetchStatusLabel(status: ModelFetchCardStatus): string {
  switch (status) {
    case "loading":
      return "Reading";
    case "updated":
      return "Model list updated";
    case "unchanged":
      return "No model list changes";
    case "skipped":
      return "Unable to read online";
    case "error":
      return "Fetch failed";
    case "idle":
    default:
      return "Waiting to read";
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
function fetchConfigSummary(config: WizardModelFetchConfig | null): string {
  if (!config) return "Missing Base URL or API key";
  if (config.volcengineModelListAction) {
    return `Volcengine OpenAPI ${config.volcengineModelListAction} (${config.baseUrl})`;
  }
  return `${config.baseUrl}${config.isFullUrl ? " (full URL)" : ""}`;
}

// 生成官方 Codex OAuth 动态目录读取文案；失败时保留最后一次成功目录，不清空用户配置。
function codexOAuthModelFetchMessage(
  hasModelCatalog: boolean,
  hasCodexOauthAccount: boolean,
) {
  const catalogText = hasModelCatalog
    ? "Kept the built-in official Codex catalog"
    : "No model catalog is available";
  const authText = hasCodexOauthAccount
    ? "ChatGPT OAuth account detected"
    : "No ChatGPT OAuth account detected; sign in during the setup step first";
  return `Official Codex OAuth refreshes through the dedicated ChatGPT model endpoint; ${catalogText}; ${authText}.`;
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
function wizardStatusText(state: WizardFlowState): string {
  switch (state.status) {
    case "needSources":
      return "Waiting for at least one model source.";
    case "configIncomplete":
      return "Some model sources cannot fetch models automatically; complete their configuration or continue with the existing catalog.";
    case "readyToFetchModels":
      return "Configuration is ready to fetch model lists.";
    case "fetchingModels":
      return "Reading model lists from providers.";
    case "modelFetchPartial":
      return "Some model lists succeeded; review failed or skipped providers.";
    case "modelsFetched":
      return "Model lists refreshed; resolve duplicate model names next.";
    case "probingConnectivity":
      return "Running a minimal /v1/responses probe for each provider/model.";
    case "connectivityPassed":
      return "All tested models responded directly to /v1/responses.";
    case "connectivityPartial":
      return "Connectivity checks have warnings; confirm Chat-only or skipped items are expected.";
    case "connectivityFailed":
      return "Deselect failed models or fix them and probe again before continuing.";
    case "collisionReviewRequired":
      return "Duplicate model names detected; confirm the alias strategy.";
    case "routePreview":
      return "Route preview is ready; continue to save and publish.";
    case "savingPlan":
      return "Saving the MultiRouter provider.";
    case "saveFailed":
      return "Save failed; fix the issues and try again.";
    case "published":
      return "MultiRouter provider saved.";
    case "enabling":
      return "Enabling this multi-route plan.";
    case "enableFailed":
      return "Enable failed; retry or check the local proxy status.";
    case "enabled":
      return "Enabled; the status page will wait for the latest Codex request to be forwarded successfully.";
    case "dismissed":
      return "Wizard skipped.";
    case "opened":
    case "enablePrompt":
    default:
      return "Complete multi-model routing step by step.";
  }
}

// 把异常转换成面向用户的短文本，同时保留 console 中的详细错误对象。
function formatWizardError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// 生成稳定但不依赖后端的异常 ID，方便 React 渲染和后续按阶段清理。
function createWizardIssueId(stage: WizardPageKey, title: string): string {
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
  const availableNames = availableModels
    .filter((model) => model.enabled !== false)
    .map((model) => model.model);
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

function protocolProbeProviderSignature(provider: Provider): string {
  return JSON.stringify({
    id: provider.id,
    category: provider.category ?? null,
    settingsConfig: provider.settingsConfig,
    meta: provider.meta ?? null,
  });
}

function skipsWizardDeepProtocolProbe(provider: Provider): boolean {
  return !providerHasAutomaticCodexModels(provider);
}

function wizardReceiptModels(
  outcome: CodexProviderProtocolPreflightOutcome,
): Record<string, string> {
  return (
    outcome.receiptModels ??
    Object.fromEntries(
      outcome.receiptIds.flatMap((receiptId, index) => {
        const model = outcome.records[index]?.target.public_model;
        return model ? [[receiptId, model]] : [];
      }),
    )
  );
}

function mergeWizardProtocolOutcomes(
  entries: CodexProviderSetBatchProbeOutcome["outcomes"],
): Map<string, CodexProviderSetBatchProbeOutcome["outcomes"][number]> {
  const byProvider = new Map<
    string,
    CodexProviderSetBatchProbeOutcome["outcomes"][number]
  >();
  for (const entry of entries) {
    const previous = byProvider.get(entry.providerId);
    if (!previous) {
      byProvider.set(entry.providerId, entry);
      continue;
    }
    const replacedModels = new Set(
      entry.outcome.records.map((record) => record.target.public_model),
    );
    const previousReceiptModels = wizardReceiptModels(previous.outcome);
    const retainedReceiptIds = previous.outcome.receiptIds.filter(
      (id) => !replacedModels.has(previousReceiptModels[id]),
    );
    const receiptModels = {
      ...Object.fromEntries(
        retainedReceiptIds.map((id) => [id, previousReceiptModels[id]]),
      ),
      ...wizardReceiptModels(entry.outcome),
    };
    const observations = new Map(
      [...previous.outcome.observations, ...entry.outcome.observations].map(
        (record) => [
          `${record.target.public_model}\u0000${record.target.transport}`,
          record,
        ],
      ),
    );
    byProvider.set(entry.providerId, {
      ...entry,
      outcome: {
        ...entry.outcome,
        records: [
          ...previous.outcome.records.filter(
            (record) => !replacedModels.has(record.target.public_model),
          ),
          ...entry.outcome.records,
        ],
        observations: [...observations.values()],
        receiptIds: [
          ...new Set([...retainedReceiptIds, ...entry.outcome.receiptIds]),
        ],
        receiptModels,
      },
    });
  }
  return byProvider;
}

async function restoreWizardProtocolEvidence(
  sources: Provider[],
): Promise<CodexProviderSetBatchProbeOutcome> {
  const outcomes = (
    await Promise.all(
      sources.map(async (provider) => {
        if (
          skipsWizardDeepProtocolProbe(provider) &&
          !readIncludedWizardModelCatalog(provider).some(
            (model) =>
              codexModelProtocolDeclarationStatus(provider, model) !==
              "unavailable",
          )
        )
          return null;
        try {
          const outcome = await restoreCodexProviderProtocolEvidence(provider);
          return outcome
            ? { providerId: provider.id, inputProvider: provider, outcome }
            : null;
        } catch {
          // Missing, expired, or mismatched evidence must leave the gate closed;
          // restoring evidence never falls back to a billable protocol probe.
          return null;
        }
      }),
    )
  ).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  return {
    outcomes,
    sources: sources.map((provider) => ({
      provider,
      receiptIds:
        outcomes.find((entry) => entry.providerId === provider.id)?.outcome
          .receiptIds ?? [],
    })),
  };
}

function skippedWizardDeepProbeResult(
  provider: Provider,
  detail: string,
): WizardConnectivityResult {
  const hasModels = readWizardModelCatalog(provider).some(
    (model) => model.enabled !== false,
  );
  return {
    providerId: provider.id,
    providerName: provider.name,
    model: "*",
    status: hasModels ? "skipped" : "fail",
    canContinue: hasModels,
    detail: hasModels
      ? detail
      : `${detail}; the current model catalog is empty, so no usable route can be generated.`,
  };
}

function deepProbeConnectivityResults(
  provider: Provider,
  outcome: CodexProviderProtocolPreflightOutcome,
): WizardConnectivityResult[] {
  if (outcome.records.length === 0) {
    return [
      skippedWizardDeepProbeResult(
        provider,
        "The backend generated no standard Codex model targets to verify.",
      ),
    ];
  }
  return outcome.records.map((record) => {
    const verified = record.result.readiness === "verified";
    const selected = record.result.selected_transport;
    return {
      providerId: provider.id,
      providerName: provider.name,
      model: record.target.public_model,
      status: verified ? "pass" : "fail",
      canContinue: verified,
      recommendedApiFormat:
        selected === "open_ai_responses"
          ? "openai_responses"
          : selected === "open_ai_chat"
            ? "openai_chat"
            : undefined,
      detail: verified
        ? `Full Codex transaction verified; selected ${
            selected === "open_ai_chat" ? "Chat Completions" : "Responses"
          }.`
        : `Deep probe result: ${record.result.readiness}; base response, streaming SSE, tool calls, and tool continuation did not all pass.`,
    };
  });
}

export function buildWizardConnectivityResultsFromBatchOutcome(
  expectedProviders: Provider[],
  outcome: CodexProviderSetBatchProbeOutcome,
  hasCodexOauthAccount: boolean,
): WizardConnectivityResult[] {
  const outcomeByProviderId = new Map(
    outcome.outcomes.map((entry) => [entry.providerId, entry.outcome]),
  );
  const outcomeSourceByProviderId = new Map(
    outcome.sources.map((source) => [source.provider.id, source.provider]),
  );
  const results: WizardConnectivityResult[] = [];
  // 以用户选中的预期来源为权威集合。后端少返回一个 source 时必须形成具名失败，
  // 不能因为遍历空响应而得到 Verified/Partial/Failed 全为 0 的矛盾终态。
  for (const expectedProvider of expectedProviders) {
    const provider =
      outcomeSourceByProviderId.get(expectedProvider.id) ?? expectedProvider;
    const models = getWizardConnectivityProbeModels(provider);
    const declaredModels = readIncludedWizardModelCatalog(provider).filter(
      (model) => readCodexModelProtocolCapability(provider, model),
    );
    const unsupportedModels = new Set(
      readIncludedWizardModelCatalog(provider)
        .filter(
          (model) =>
            codexModelProtocolDeclarationStatus(provider, model) ===
            "unsupported",
        )
        .map((model) => model.model.trim()),
    );
    const manualWholeProvider =
      provider.meta?.codexProtocolMode === "manual" &&
      Object.keys(provider.meta.codexProtocolOverrides ?? {}).length === 0;
    if (
      skipsWizardDeepProtocolProbe(provider) &&
      ((declaredModels.length === 0 && unsupportedModels.size === 0) ||
        manualWholeProvider)
    ) {
      results.push(
        skippedWizardDeepProbeResult(
          provider,
          provider.meta?.codexProtocolMode === "manual"
            ? "This provider locks its protocol in advanced mode; automatic probing will not override your choice."
            : hasCodexOauthAccount
              ? "Official or managed-account sources use Responses with account-manager authentication and do not send extra billable probes."
              : "Official or managed-account sources use Responses; the account is not signed in yet, so it must be linked after saving.",
        ),
      );
      continue;
    }
    if (models.length === 0) {
      results.push(
        skippedWizardDeepProbeResult(
          provider,
          "No probeable models are available, so deep-probe requests cannot be generated.",
        ),
      );
      continue;
    }
    const probeOutcome = outcomeByProviderId.get(provider.id);
    const probedModels = new Map(
      probeOutcome
        ? deepProbeConnectivityResults(provider, probeOutcome)
            .filter((result) => result.model !== "*")
            .map((result) => [result.model, result])
        : [],
    );
    const unresolvedModels = new Set(
      codexProviderModelsRequiringProtocolProbe(provider),
    );
    for (const model of models) {
      const manualTransport = Object.entries(
        provider.meta?.codexProtocolOverrides ?? {},
      ).find(
        ([key]) =>
          normalizeCodexPublicModelKey(key) ===
          normalizeCodexPublicModelKey(model),
      )?.[1];
      if (manualTransport) {
        results.push({
          providerId: provider.id,
          providerName: provider.name,
          model,
          status: "skipped",
          canContinue: true,
          detail: i18n.t("codexWizardProtocol.manualDeclared", {
            defaultValue:
              "The provider has an explicit protocol selection; automatic probing will not override it.",
          }),
        });
        continue;
      }
      const probed = probedModels.get(model);
      if (probed) {
        results.push(probed);
        continue;
      }
      const declared = readCodexModelProtocolCapability(provider, model);
      if (declared) {
        results.push({
          providerId: provider.id,
          providerName: provider.name,
          model,
          status: "skipped",
          canContinue: true,
          recommendedApiFormat: declared,
          detail: i18n.t("codexWizardProtocol.apiDeclared", {
            defaultValue:
              "Provider API declares {{protocol}} support; no complete probe is required. Live requests have not been verified.",
            protocol:
              declared === "openai_chat" ? "Chat Completions" : "Responses",
          }),
        });
      } else if (unsupportedModels.has(model)) {
        results.push({
          providerId: provider.id,
          providerName: provider.name,
          model,
          status: "fail",
          canContinue: false,
          detail: i18n.t("codexWizardProtocol.apiUnsupported", {
            defaultValue:
              "The provider API explicitly marks this model as incompatible with the automatic Codex route.",
          }),
        });
      } else if (!unresolvedModels.has(model)) {
        results.push({
          providerId: provider.id,
          providerName: provider.name,
          model,
          status: "skipped",
          canContinue: true,
          detail: i18n.t("codexWizardProtocol.manualDeclared", {
            defaultValue:
              "The provider has an explicit protocol selection; automatic probing will not override it.",
          }),
        });
      } else {
        results.push({
          providerId: provider.id,
          providerName: provider.name,
          model,
          status: "fail",
          canContinue: false,
          detail: probeOutcome
            ? i18n.t("codexWizardProtocol.unresolvedModel", {
                defaultValue:
                  "This model has neither a usable provider API protocol declaration nor reusable probe evidence.",
              })
            : "The backend returned no compatibility result for this model source.",
        });
      }
    }
  }
  return results;
}

export function CodexMultiRouterWizard({
  open,
  providers,
  mode,
  planId,
  newlyCreatedProviderIds = [],
  onOpenChange,
  onCreateProvider,
  onOpenProviderConfig,
  onOpenHistoryRepair,
  onOpenWorkspace,
  onEnablePlan,
}: CodexMultiRouterWizardProps) {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const batchProtocolLabAdapter = useMemo(
    () => createBatchCodexProtocolLabAdapter(),
    [],
  );
  const batchProtocolLab = useProtocolLabWorkflow(batchProtocolLabAdapter);
  const {
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
  const [webSearchEnabled, setWebSearchEnabled] = useState(true);
  const [imageGenerationEnabled, setImageGenerationEnabled] = useState(true);
  const [catalogModelOrder, setCatalogModelOrder] = useState<string[] | null>(
    null,
  );
  const [draftSpawnAgentModels, setDraftSpawnAgentModels] = useState<string[]>(
    [],
  );
  const [savedPlan, setSavedPlan] = useState<Provider | null>(null);
  const [lastConnectivityResults, setConnectivityResults] = useState<
    WizardConnectivityResult[]
  >([]);
  const [probeDialogOpen, setProbeDialogOpen] = useState(false);
  const [restoredEvidence, setRestoredEvidence] =
    useState<CodexProviderSetBatchProbeOutcome | null>(null);
  const [isRestoringEvidence, setIsRestoringEvidence] = useState(false);
  const [excludedProbeModels, setExcludedProbeModels] = useState<string[]>([]);
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
  const initializedTargetRef = useRef<string | null>(null);
  const draftGenerationRef = useRef(0);
  const targetGenerationRef = useRef(0);
  const latestProvidersRef = useRef(providers);
  latestProvidersRef.current = providers;
  const sourceFactsRef = useRef(new Map<string, string>());
  const committedSourceFactsRef = useRef(new Map<string, string>());
  const handledCreatedProviderIdsRef = useRef(new Set<string>());
  const createPlanIdRef = useRef<string | null>(null);
  const saveInFlightRef = useRef<Promise<void> | null>(null);
  const consumedReceiptIdsRef = useRef(new Set<string>());
  const lastProtocolLabIssueRef = useRef<string | null>(null);

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
  const existingPlan =
    resolvedMode === "edit" &&
    migratedPlanOverride?.id === storedExistingPlan?.id
      ? (migratedPlanOverride ?? storedExistingPlan)
      : storedExistingPlan;
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
  const configIssues = useMemo(
    () => getWizardConfigIssues(draftSources),
    [draftSources],
  );
  const modelCollisions = useMemo(
    () => collectWizardModelNameCollisions(draftSources),
    [draftSources],
  );
  const protocolLabOutcomeById = mergeWizardProtocolOutcomes(
    [
      ...(restoredEvidence?.outcomes ?? []),
      ...(batchProtocolLab.probeOutcome?.outcomes ?? []),
    ].filter((entry) =>
      draftSources.some(
        (provider) =>
          provider.id === entry.providerId &&
          protocolProbeProviderSignature(entry.inputProvider) ===
            protocolProbeProviderSignature(provider),
      ),
    ),
  );
  const currentProtocolOutcomes = [...protocolLabOutcomeById.values()];
  const connectivityResults = buildWizardConnectivityResultsFromBatchOutcome(
    draftSources,
    {
      outcomes: currentProtocolOutcomes,
      sources: currentProtocolOutcomes.map((entry) => ({
        provider: entry.outcome.provider,
        receiptIds: entry.outcome.receiptIds,
      })),
    },
    hasCodexOauthAccount,
  ).map((result) => {
    if (result.canContinue) return result;
    const previous = lastConnectivityResults.find(
      (item) =>
        item.providerId === result.providerId &&
        (item.model === result.model || item.model === "*") &&
        !item.canContinue,
    );
    return previous ? { ...result, detail: previous.detail } : result;
  });
  const excludedProbeModelSet = new Set(excludedProbeModels);
  const probeModelKey = (providerId: string, model: string) =>
    `${providerId}\u0000${model}`;
  const isProbeModelExcluded = (providerId: string, model: string) =>
    excludedProbeModelSet.has(probeModelKey(providerId, model)) ||
    excludedProbeModelSet.has(probeModelKey(providerId, "*"));
  const retainedConnectivityResults = connectivityResults.filter(
    (result) => !isProbeModelExcluded(result.providerId, result.model),
  );
  const probeAdjustedSources = draftSources
    .map((provider) => {
      const entry = protocolLabOutcomeById.get(provider.id);
      return entry &&
        protocolProbeProviderSignature(entry.inputProvider) ===
          protocolProbeProviderSignature(provider)
        ? {
            ...provider,
            settingsConfig: entry.outcome.provider.settingsConfig,
            meta: entry.outcome.provider.meta,
          }
        : provider;
    })
    .filter((provider) => !isProbeModelExcluded(provider.id, "*"))
    .map((provider) => ({
      ...provider,
      settingsConfig: {
        ...provider.settingsConfig,
        modelCatalog: {
          ...(readCodexCatalogSettings(provider.settingsConfig) ?? {}),
          models: readWizardModelCatalog(provider).map((model) =>
            isProbeModelExcluded(provider.id, model.model)
              ? { ...model, enabled: false }
              : model,
          ),
        },
      },
    }));
  const routeReadySources = probeAdjustedSources.filter((provider) =>
    readWizardModelCatalog(provider).some((model) => model.enabled !== false),
  );
  const availableCatalogModels = buildWizardModelCatalog(
    resolveWizardModelNameCollisions(probeAdjustedSources),
    { includeDisabled: true },
  ).models;
  const activeCatalogModelOrder = resolveActiveCatalogModelOrder(
    availableCatalogModels,
    catalogModelOrder,
  );
  // Disabled rows stay visible on the Models page so a user can understand
  // and recover a previously filtered catalog. They are not routeable,
  // however, and must not satisfy navigation or save gates.
  const routeableCatalogModelOrder = activeCatalogModelOrder.filter((model) =>
    availableCatalogModels.some(
      (catalogModel) =>
        catalogModel.model === model && catalogModel.enabled !== false,
    ),
  );
  const activeSpawnAgentModels = resolveActiveSpawnAgentModels(
    draftSpawnAgentModels,
    activeCatalogModelOrder,
  );
  const flowContext: WizardFlowContext = {
    providerCount: providerModelSources.length,
    selectedSourceCount: draftSources.length,
    allSelectedSourcesReady:
      draftSources.length > 0 && configIssues.length === 0,
    catalogPrepared:
      flowState.status === "modelsFetched" ||
      flowState.status === "modelFetchPartial" ||
      availableCatalogModels.length > 0,
    protocolProbeComplete:
      retainedConnectivityResults.length > 0 &&
      canContinueAfterConnectivity(retainedConnectivityResults),
    hasVisibleModels: routeableCatalogModelOrder.length > 0,
    planSaved: Boolean(savedPlan),
    planEnabled:
      flowState.status === "enabled" ||
      activePlan?.settingsConfig?.codexRouting?.enabled === true,
    acceptanceStatus: "waiting",
  };
  const pageSequence = buildWizardPageSequence(flowContext);
  const steps = ALL_STEPS.filter((step) => pageSequence.includes(step.key));
  const stepIndex = steps.findIndex((step) => step.key === flowState.stepKey);
  // 防御旧状态或条件页消失后的异常跳转，确保向导始终有可渲染页面。
  const currentStep = steps[stepIndex] ?? steps[0];
  const CurrentStepIcon = currentStep.icon;
  const currentStepPrerequisiteKey = requiredWizardPrerequisite(
    currentStep.key,
    flowContext,
  );
  const currentStepPrerequisite = currentStepPrerequisiteKey
    ? steps.find((step) => step.key === currentStepPrerequisiteKey)
    : undefined;
  const isRefreshingModels = flowState.status === "fetchingModels";
  const isProbingConnectivity = batchProtocolLab.state.phase === "probing";
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
      return;
    }
    const targetKey = `${resolvedMode}:${planId ?? storedExistingPlan?.id ?? "new"}`;
    if (initializedTargetRef.current !== targetKey)
      initializedOpenRef.current = false;
    if (initializedOpenRef.current) return;

    initializedOpenRef.current = true;
    draftGenerationRef.current += 1;
    targetGenerationRef.current += 1;
    initializedTargetRef.current = targetKey;
    handledCreatedProviderIdsRef.current.clear();
    committedSourceFactsRef.current.clear();
    sourceFactsRef.current = new Map(
      providerModelSources.map((provider) => [
        provider.id,
        protocolProbeProviderSignature(provider),
      ]),
    );
    setExcludedProbeModels([]);
    if (existingPlan) {
      createPlanIdRef.current = existingPlan.id;
    } else {
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
      initialWizardSpawnAgentModels(existingPlan).slice(0, 5),
    );
    setConnectivityResults([]);
    setRestoredEvidence(null);
    batchProtocolLab.reset();
    if (existingPlan?.settingsConfig?.codexRouting?.schemaVersion === 2) {
      const generation = draftGenerationRef.current;
      const restoreTargetGeneration = targetGenerationRef.current;
      const initialSources = providerModelSources.filter((source) =>
        initialSourceIdSet.has(source.id),
      );
      setIsRestoringEvidence(true);
      void restoreWizardProtocolEvidence(initialSources).then((restored) => {
        if (targetGenerationRef.current === restoreTargetGeneration)
          setIsRestoringEvidence(false);
        if (draftGenerationRef.current !== generation) return;
        setRestoredEvidence(restored);
        setConnectivityResults(
          buildWizardConnectivityResultsFromBatchOutcome(
            initialSources,
            restored,
            hasCodexOauthAccount,
          ).map((result) =>
            result.canContinue
              ? result
              : {
                  ...result,
                  detail:
                    "No reusable complete evidence was found (it may be missing, stale, or based on changed configuration); probe this source again.",
                },
          ),
        );
        setIsRestoringEvidence(false);
      });
    } else {
      setIsRestoringEvidence(false);
    }
    setProbeDialogOpen(false);
    setWizardIssues([]);
    setModelFetchCards(
      Object.fromEntries(
        providerModelSources.map((provider) => [
          provider.id,
          defaultModelFetchCardState(provider),
        ]),
      ),
    );
    dispatchFlow({
      type: "INIT",
      hasSources: initialSourceIds.length > 0,
    });
  }, [existingPlan, open, planId, providerModelSources, resolvedMode]);

  // Add Provider 对话框关闭后，App 会把本次新增 ID 传回。向导只选中真实新增项，
  // 不根据名称或数组顺序猜测，并回到就绪检查展示下一步。
  useEffect(() => {
    if (!open || newlyCreatedProviderIds.length === 0) return;
    const createdIdSet = new Set(
      newlyCreatedProviderIds.filter(
        (id) => !handledCreatedProviderIdsRef.current.has(id),
      ),
    );
    const createdProviders = providerModelSources.filter((provider) =>
      createdIdSet.has(provider.id),
    );
    if (createdProviders.length === 0) return;
    // Integrating a newly created source changes the probe target set too.
    // A pending restore for the previous set must not reopen the later steps.
    draftGenerationRef.current += 1;
    setIsRestoringEvidence(false);
    createdProviders.forEach((provider) =>
      handledCreatedProviderIdsRef.current.add(provider.id),
    );
    setSelectedSourceIds((currentIds) => [
      ...new Set([
        ...currentIds,
        ...createdProviders.map((provider) => provider.id),
      ]),
    ]);
    setDraftSources((currentSources) => {
      const byId = new Map(
        [...currentSources, ...createdProviders].map((provider) => [
          provider.id,
          provider,
        ]),
      );
      return [...byId.values()];
    });
    setConnectivityResults([]);
    batchProtocolLab.reset();
    dispatchFlow({ type: "GOTO_STEP", stepKey: "readiness" });
  }, [newlyCreatedProviderIds, open, providerModelSources]);

  // Provider 是模型事实的唯一来源。向导打开期间也必须采用父层查询的最新快照，
  // 否则 Provider 新增模型、上下文或能力变化只会在关闭并重开向导后出现。
  // 保留未保存的目录草稿，但外部事实变化必须使对应证据失效。
  useEffect(() => {
    if (!open || !initializedOpenRef.current) return;
    setSavedPlan((currentPlan) => existingPlan ?? currentPlan);
    const changedIds = new Set(
      providerModelSources
        .filter((provider) => {
          const previous = sourceFactsRef.current.get(provider.id);
          const next = protocolProbeProviderSignature(provider);
          if (previous === next) return false;
          // Only the exact atomic-save response is an expected change. Keep the
          // observed baseline until refetch arrives so old query renders remain safe.
          const committed = committedSourceFactsRef.current.get(provider.id);
          committedSourceFactsRef.current.delete(provider.id);
          return previous !== undefined && next !== committed;
        })
        .map((provider) => provider.id),
    );
    sourceFactsRef.current = new Map(
      providerModelSources.map((provider) => [
        provider.id,
        protocolProbeProviderSignature(provider),
      ]),
    );
    if (changedIds.size > 0) {
      draftGenerationRef.current += 1;
      if (isProbingConnectivity) batchProtocolLab.reset();
      if (isRefreshingModels) {
        dispatchFlow({
          type: "FETCH_DONE",
          partial: true,
          summary: {
            successCount: 0,
            skippedCount: 0,
            failedCount: changedIds.size,
          },
        });
      }
      setConnectivityResults((current) =>
        current
          .filter((result) => !changedIds.has(result.providerId))
          .concat(
            providerModelSources
              .filter(
                (provider) =>
                  changedIds.has(provider.id) &&
                  selectedSourceIds.includes(provider.id),
              )
              .map((provider) => ({
                providerId: provider.id,
                providerName: provider.name,
                model: "*",
                status: "fail" as const,
                canContinue: false,
                detail:
                  "The model source changed, so previous probe results are stale; probe it again or remove it.",
              })),
          ),
      );
    }
    setDraftSources((currentSources) => {
      const nextSourceById = new Map(
        providerModelSources.map((provider) => [provider.id, provider]),
      );
      return selectedSourceIds
        .map((providerId) => {
          const latest = nextSourceById.get(providerId);
          const retained = currentSources.find(
            (provider) => provider.id === providerId,
          );
          if (!latest || !retained || changedIds.has(providerId)) return latest;
          return {
            ...latest,
            settingsConfig: retained.settingsConfig,
            meta: retained.meta,
          };
        })
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
          currentCards[provider.id] ?? defaultModelFetchCardState(provider),
        ]),
      ),
    );
  }, [existingPlan, open, providerModelSources, selectedSourceIds]);

  // 选择只影响本次 MultiRouter 草稿，不修改 provider 数据库或其它已有路由方案。
  const toggleSourceProvider = (provider: Provider, checked: boolean) => {
    draftGenerationRef.current += 1;
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
    batchProtocolLab.reset();
  };

  // 所有异步 catch 都进入同一个问题列表，让 toast 之外的 UI 也能长期展示异常和继续策略。
  const recordWizardIssue = (issue: Omit<WizardIssue, "id">) => {
    setWizardIssues((current) => [
      ...current.filter(
        (existing) =>
          existing.stage !== issue.stage ||
          existing.title !== issue.title ||
          existing.providerName !== issue.providerName,
      ),
      {
        ...issue,
        id: createWizardIssueId(issue.stage, issue.title),
      },
    ]);
  };

  // 重新执行某个阶段时只清理该阶段旧问题，避免旧错误误导当前判断。
  const clearWizardIssuesForStage = (stage: WizardPageKey) => {
    setWizardIssues((current) =>
      current.filter((issue) => issue.stage !== stage),
    );
  };

  useEffect(() => {
    if (
      batchProtocolLab.state.phase !== "failed" &&
      batchProtocolLab.state.phase !== "blocked"
    ) {
      lastProtocolLabIssueRef.current = null;
      return;
    }
    const message =
      batchProtocolLab.state.phase === "blocked"
        ? "At least one model source has not passed the complete Codex transaction check."
        : batchProtocolLab.state.errorDetail ||
          "The compatibility workflow failed.";
    const signature = `${batchProtocolLab.state.phase}:${batchProtocolLab.state.pendingIntent}:${message}`;
    if (lastProtocolLabIssueRef.current === signature) return;
    lastProtocolLabIssueRef.current = signature;

    if (batchProtocolLab.state.pendingIntent === "validate") {
      const failedResults = (
        batchProtocolLab.state.draft?.sources ?? []
      ).map<WizardConnectivityResult>((source) => ({
        providerId: source.provider.id,
        providerName: source.provider.name,
        model: "*",
        status: "fail",
        canContinue: false,
        detail: `Compatibility deep probe interrupted: ${message}`,
      }));
      setConnectivityResults(failedResults);
      dispatchFlow({
        type: "PROBE_DONE",
        canContinue: false,
        hasWarnings: false,
        summary: {
          passCount: 0,
          warnCount: 0,
          skippedCount: 0,
          failCount: Math.max(1, failedResults.length),
        },
      });
      recordWizardIssue({
        stage: "protocol",
        severity: "error",
        title: "Compatibility deep probe interrupted",
        detail: message,
        canContinue: false,
      });
      return;
    }

    dispatchFlow({ type: "SAVE_ERROR", error: message });
    recordWizardIssue({
      stage: "save-enable",
      severity: "error",
      title: "MultiRouter save failed",
      detail: message,
      canContinue: false,
    });
    if (batchProtocolLab.state.phase === "failed") {
      toast.error(`MultiRouter save failed: ${message}`, { closeButton: true });
      // This page owns the save error and offers a new Save action, not the
      // protocol dialog's retry action. Settle the failed operation so its
      // pending promise cannot hold saveInFlightRef after the user fixes it.
      batchProtocolLab.cancel(new Error(message));
    }
  }, [
    batchProtocolLab.cancel,
    batchProtocolLab.state.draft,
    batchProtocolLab.state.errorDetail,
    batchProtocolLab.state.pendingIntent,
    batchProtocolLab.state.phase,
  ]);

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

  // Close/跳过时记录 dismissed；首页按钮仍可再次显式打开。
  const closeWizard = (dismissed = true) => {
    if (dismissed) {
      localStorage.setItem(CODEX_MULTI_ROUTER_WIZARD_DISMISSED_KEY, "true");
    }
    // Closing is not acceptance evidence, including "Accept later" and
    // migration cancellation. Leave the flow status unchanged.
    onOpenChange(false);
  };

  const openWizardStep = (step: WizardStep) => {
    dispatchFlow({ type: "GOTO_STEP", stepKey: step.key });
    const prerequisiteKey = requiredWizardPrerequisite(step.key, flowContext);
    if (!prerequisiteKey) return;
    const prerequisite = steps.find((item) => item.key === prerequisiteKey);
    toast.info(
      `“${step.title}” cannot be edited yet; complete “${prerequisite?.title ?? "the prerequisite step"}” first.`,
      { closeButton: true },
    );
  };

  // Next按钮按状态机 gate 推进；配置不完整时停在当前状态并给出可操作提示。
  const advanceWizard = () => {
    switch (currentStep.key) {
      case "welcome":
        dispatchFlow({
          type: "NEXT",
          nextStatus: "opened",
          nextStepKey: "inventory",
        });
        return;
      case "inventory":
        dispatchFlow({
          type: "NEXT",
          nextStatus:
            providerModelSources.length > 0
              ? "reviewProviderConfig"
              : "needSources",
          nextStepKey:
            providerModelSources.length > 0 ? "readiness" : "first-provider",
        });
        return;
      case "first-provider":
        if (providerModelSources.length === 0) {
          toast.info("Add at least one Codex model source first.", {
            closeButton: true,
          });
          return;
        }
        dispatchFlow({
          type: "NEXT",
          nextStatus: "reviewProviderConfig",
          nextStepKey: "readiness",
        });
        return;
      case "readiness":
        if (providerModelSources.length === 0) {
          dispatchFlow({ type: "GOTO_STEP", stepKey: "first-provider" });
          return;
        }
        dispatchFlow({
          type: "NEXT",
          nextStatus: "reviewProviderConfig",
          nextStepKey: "sources",
        });
        return;
      case "sources":
        if (draftSources.length === 0) {
          dispatchFlow({
            type: "NEXT",
            nextStatus: "needSources",
            nextStepKey: "sources",
          });
          toast.info(
            "Add at least one Codex provider as a model source first.",
            {
              closeButton: true,
            },
          );
          return;
        }
        dispatchFlow({
          type: "NEXT",
          nextStatus:
            configIssues.length > 0 ? "configIncomplete" : "readyToFetchModels",
          nextStepKey: "catalog",
        });
        if (hasUnauthenticatedCodexOAuthSources) {
          toast.warning(
            "The official Codex OAuth source is not signed in to ChatGPT. You can continue organizing third-party models, but official GPT/O routes require OAuth before real forwarding.",
            {
              closeButton: true,
            },
          );
        }
        if (configIssues.length > 0) {
          toast.warning(
            "Some providers cannot fetch models automatically; the existing modelCatalog will be used or you can complete the configuration.",
            {
              closeButton: true,
            },
          );
        }
        return;
      case "catalog":
        if (availableCatalogModels.length === 0) {
          toast.error("Sync at least one usable model first.", {
            closeButton: true,
          });
          return;
        }
        dispatchFlow({
          type: "NEXT",
          nextStatus: "readyToFetchModels",
          nextStepKey: "protocol",
        });
        return;
      case "protocol":
        if (connectivityResults.length === 0) {
          toast.info(
            "No usable compatibility evidence exists; restore a valid saved record or run a protocol deep probe first.",
            { closeButton: true },
          );
          return;
        }
        if (
          (connectivityResults.length > 0 &&
            !canContinueAfterConnectivity(retainedConnectivityResults)) ||
          retainedConnectivityResults.length === 0
        ) {
          dispatchFlow({
            type: "NEXT",
            nextStatus: "connectivityFailed",
            nextStepKey: "protocol",
          });
          recordWizardIssue({
            stage: "protocol",
            severity: "error",
            title: "Compatibility deep probe has blocking items",
            detail:
              "Some unverified models are still selected. Deselect failed items or fix and probe again; keep at least one verified model.",
            canContinue: false,
          });
          toast.error(
            "Deselect failed models or fix and probe again before continuing.",
            {
              closeButton: true,
            },
          );
          return;
        }
        dispatchFlow({
          type: "NEXT",
          nextStatus: "routePreview",
          nextStepKey: "models",
        });
        return;
      case "models":
        if (routeableCatalogModelOrder.length === 0) {
          toast.error("Keep at least one model.", { closeButton: true });
          return;
        }
        dispatchFlow({ type: "GOTO_STEP", stepKey: "model-order" });
        return;
      case "model-order":
        dispatchFlow({ type: "GOTO_STEP", stepKey: "reasoning" });
        return;
      case "reasoning":
        dispatchFlow({ type: "GOTO_STEP", stepKey: "subagents-tools" });
        return;
      case "subagents-tools":
        dispatchFlow({ type: "GOTO_STEP", stepKey: "routing-review" });
        return;
      case "routing-review":
        if (!draftPlanName.trim()) {
          toast.error("Enter a MultiRouter name first.", { closeButton: true });
          return;
        }
        if (routeableCatalogModelOrder.length === 0) {
          toast.error("Keep at least one model.", { closeButton: true });
          return;
        }
        dispatchFlow({
          type: "NEXT",
          nextStatus: "published",
          nextStepKey: "save-enable",
        });
        return;
      case "save-enable":
        if (flowState.status === "enabled") {
          dispatchFlow({ type: "GOTO_STEP", stepKey: "acceptance" });
          return;
        }
        toast.info("Save and enable the MultiRouter plan first.", {
          closeButton: true,
        });
        return;
      case "acceptance":
        closeWizard(true);
        return;
      default:
        return;
    }
  };

  // Back只改变教程步骤和对应状态，不回滚已经抓取/保存的草稿数据。
  const retreatWizard = () => {
    const previousStep = steps[Math.max(0, stepIndex - 1)];
    dispatchFlow({ type: "GOTO_STEP", stepKey: previousStep.key });
  };

  // 顺序抓取所有可抓模型源；失败不阻塞其它 provider，最终由保存页继续使用已成功目录。
  const refreshModelSources = async () => {
    const isCurrent = captureDraftOperation();
    dispatchFlow({ type: "FETCH_START" });
    clearWizardIssuesForStage("catalog");
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
                    ? "Reading ChatGPT OAuth models and refreshing the local catalog"
                    : config?.volcengineModelListAction
                      ? "Reading Volcengine OpenAPI models and refreshing the retained catalog"
                      : "Reading /models and refreshing the retained catalog",
                  modelCount: existingCount,
                }
              : {
                  status: "skipped",
                  message: isCodexOAuth
                    ? codexOAuthModelFetchMessage(
                        existingCount > 0,
                        hasCodexOauthAccount,
                      )
                    : isCatalogOnlyPlan
                      ? catalogOnlyPlanMessage(provider, existingCount > 0)
                      : "Missing Base URL or API key; cannot read online, so the existing catalog was kept.",
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
              message: "Reading the dedicated ChatGPT OAuth model list...",
              modelCount: beforeModels.length,
            },
          }));
          try {
            const fetchedModels = await fetchCodexOauthModels(
              readWizardCodexOAuthAccountId(provider),
            );
            if (!isCurrent()) return;
            if (fetchedModels.length === 0) {
              throw new Error(
                "The ChatGPT OAuth model endpoint returned an empty list",
              );
            }
            // OAuth 上游会持续发布新模型，因此成功响应必须追加新条目；已有别名、能力和子 Agent 选择仍由合并函数保留。
            const nextProvider = mergeFetchedModelsIntoWizardProvider(
              provider,
              fetchedModels,
            );
            const afterModels = readWizardModelCatalog(nextProvider);
            const diff = diffWizardModelCatalog(beforeModels, afterModels);
            const hasDiff = hasModelFetchDiff(diff);
            nextSources.push(nextProvider);
            successCount += 1;
            setModelFetchCards((current) => ({
              ...current,
              [provider.id]: {
                status: hasDiff ? "updated" : "unchanged",
                message: hasDiff
                  ? `OAuth catalog read succeeded; loaded ${afterModels.length} models into the draft.`
                  : `OAuth catalog read succeeded with no model-list changes; still ${afterModels.length} models.`,
                modelCount: afterModels.length,
                diff,
              },
            }));
          } catch (error) {
            if (!isCurrent()) return;
            const message = formatWizardError(error);
            let cacheFailureMessage: string | null = null;
            try {
              const fallbackModels = await fetchCodexOfficialFallbackModels();
              if (!isCurrent()) return;
              if (fallbackModels.length > 0) {
                // OAuth 不可用时使用无需 OAuth 的可信官方目录，避免新建 official 源被写成 0 模型。
                const nextProvider = mergeFetchedModelsIntoWizardProvider(
                  provider,
                  fallbackModels,
                );
                const afterModels = readWizardModelCatalog(nextProvider);
                const diff = diffWizardModelCatalog(beforeModels, afterModels);
                const hasDiff = hasModelFetchDiff(diff);
                nextSources.push(nextProvider);
                successCount += 1;
                recordWizardIssue({
                  stage: "catalog",
                  severity: "warning",
                  title:
                    "OAuth online model-list fetch failed; used the fallback official catalog",
                  detail: `The ChatGPT OAuth online model list is temporarily unavailable; restored ${afterModels.length} models from the fallback official catalog. Online error: ${message}`,
                  canContinue: true,
                  providerName: provider.name,
                });
                setModelFetchCards((current) => ({
                  ...current,
                  [provider.id]: {
                    status: hasDiff ? "updated" : "unchanged",
                    message: hasDiff
                      ? `OAuth online read failed; loaded ${afterModels.length} models from the fallback official catalog.`
                      : `OAuth online read failed; used the fallback official catalog with no model-list changes, still ${afterModels.length} models.`,
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
              stage: "catalog",
              severity: "warning",
              title: "OAuth model-list fetch failed",
              detail: `Failed to fetch the ChatGPT OAuth model list; kept the existing catalog: ${message}${
                cacheFailureMessage
                  ? `; fallback official catalog read also failed: ${cacheFailureMessage}`
                  : "; the fallback official catalog had no models to restore"
              }`,
              canContinue: true,
              providerName: provider.name,
            });
            setModelFetchCards((current) => ({
              ...current,
              [provider.id]: {
                status: "error",
                message: `OAuth model-list fetch failed; kept the existing catalog: ${message}${
                  beforeModels.length === 0
                    ? "; the fallback official catalog also had no models to restore; check the CCSwitchMulti global proxy or local Codex installation."
                    : ""
                }`,
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
              message:
                "Missing Base URL or API key; cannot read online, so the existing catalog was kept.",
              modelCount: beforeModels.length,
            },
          }));
          continue;
        }
        setModelFetchCards((current) => ({
          ...current,
          [provider.id]: {
            status: "loading",
            message: `Reading ${fetchConfigSummary(config)}`,
            modelCount: beforeModels.length,
          },
        }));
        try {
          const fetchedModels = await fetchModelsForConfig(
            config.baseUrl,
            config.apiKey,
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
          );
          if (!isCurrent()) return;
          const nextProvider = mergeFetchedModelsIntoWizardProvider(
            provider,
            fetchedModels,
            { preserveExistingSelection: true },
          );
          const afterModels = readWizardModelCatalog(nextProvider);
          const diff = diffWizardModelCatalog(beforeModels, afterModels);
          const hasDiff = hasModelFetchDiff(diff);
          nextSources.push(nextProvider);
          successCount += 1;
          setModelFetchCards((current) => ({
            ...current,
            [provider.id]: {
              status: hasDiff ? "updated" : "unchanged",
              message: hasDiff
                ? `Read succeeded; loaded ${afterModels.length} models into the draft.`
                : `Read succeeded with no model-list changes; still ${afterModels.length} models.`,
              modelCount: afterModels.length,
              diff,
            },
          }));
        } catch (error) {
          if (!isCurrent()) return;
          console.error("[CodexMultiRouterWizard] fetch models failed", error);
          const message = formatWizardError(error);
          recordWizardIssue({
            stage: "catalog",
            severity: "warning",
            title: "Model-list fetch failed",
            detail: `Model-list fetch failed; check the current provider configuration: ${message}`,
            canContinue: true,
            providerName: provider.name,
          });
          failedCount += 1;
          nextSources.push(provider);
          setModelFetchCards((current) => ({
            ...current,
            [provider.id]: {
              status: "error",
              message: `Model-list fetch failed; check the current provider configuration: ${message}`,
              modelCount: beforeModels.length,
            },
          }));
        }
      }
      if (!isCurrent()) return;
      const refreshedSources = nextSources.map((source) => ({
        ...latestProvidersRef.current.find(
          (provider) => provider.id === source.id,
        ),
        ...source,
        name:
          latestProvidersRef.current.find(
            (provider) => provider.id === source.id,
          )?.name ?? source.name,
      }));
      setDraftSources(refreshedSources);
      const nextAvailableModels = buildWizardModelCatalog(
        resolveWizardModelNameCollisions(refreshedSources),
        { includeDisabled: true },
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
      // Fetching a model directory changes presentation data, not necessarily
      // the actual probe target. Re-ask the backend to match the refreshed
      // draft against persisted ProbeTargetKey evidence before locking the
      // protocol step. This is read-only and cannot issue upstream requests.
      const restoreGeneration = ++draftGenerationRef.current;
      const restoreTargetGeneration = targetGenerationRef.current;
      setIsRestoringEvidence(true);
      batchProtocolLab.reset();
      const restored = await restoreWizardProtocolEvidence(refreshedSources);
      if (
        targetGenerationRef.current !== restoreTargetGeneration ||
        draftGenerationRef.current !== restoreGeneration
      ) {
        return;
      }
      setRestoredEvidence(restored);
      setConnectivityResults(
        buildWizardConnectivityResultsFromBatchOutcome(
          refreshedSources,
          restored,
          hasCodexOauthAccount,
        ).map((result) =>
          result.canContinue
            ? result
            : {
                ...result,
                detail:
                  "No reusable complete evidence was found after refresh (it may be missing, stale, or based on changed configuration); probe this source again.",
              },
        ),
      );
      setIsRestoringEvidence(false);
      dispatchFlow({
        type: "FETCH_DONE",
        partial: failedCount > 0 || skippedCount > 0,
        summary: { successCount, skippedCount, failedCount },
      });
      toast.success(
        `Model-list read complete: ${successCount} succeeded, ${skippedCount} were unreadable, ${failedCount} failed.`,
        { closeButton: true },
      );
    } catch (error) {
      if (!isCurrent()) return;
      const message = formatWizardError(error);
      recordWizardIssue({
        stage: "catalog",
        severity: "error",
        title: "Model-list refresh interrupted",
        detail: message,
        canContinue: false,
      });
      dispatchFlow({
        type: "FETCH_DONE",
        partial: true,
        summary: { successCount, skippedCount, failedCount },
      });
      toast.error(`Model-list refresh interrupted: ${message}`, {
        closeButton: true,
      });
    }
  };

  const buildBatchDraft = (
    reuseReceipts: boolean,
  ): CodexProviderSetBatchDraft => {
    const result = buildCodexMultiRouterWizardPlan(
      providers,
      routeReadySources,
      activePlan,
      {
        planId: activePlan?.id ?? createPlanIdRef.current ?? undefined,
        planName: draftPlanName,
        // `null` is the distinct "follow the provider catalog" mode. Do not
        // materialize it into an explicit allowlist or a later catalog refresh
        // can be frozen to stale model IDs.
        catalogModelOrder:
          catalogModelOrder === null ? undefined : activeCatalogModelOrder,
        spawnAgentModels: activeSpawnAgentModels,
        hostedTools: {
          webSearch: { enabled: webSearchEnabled },
          imageGeneration: { enabled: imageGenerationEnabled },
        },
      },
    );
    const currentInputSources = new Map(
      draftSources.map((source) => [source.id, source]),
    );
    const forceProbeTargets = retainedConnectivityResults.flatMap((result) => {
      const source = currentInputSources.get(result.providerId);
      if (!source || result.canContinue || result.model === "*") return [];
      const includedModel = readIncludedWizardModelCatalog(source).find(
        (model) =>
          normalizeCodexPublicModelKey(model.model) ===
          normalizeCodexPublicModelKey(result.model),
      );
      if (!includedModel) return [];
      const manualTransport = Object.entries(
        source.meta?.codexProtocolOverrides ?? {},
      ).find(
        ([key]) =>
          normalizeCodexPublicModelKey(key) ===
          normalizeCodexPublicModelKey(result.model),
      )?.[1];
      if (manualTransport) return [];
      return [
        {
          providerId: source.id,
          providerName: source.name,
          model: includedModel.model,
        },
      ];
    });
    const forceProbeSourceIds = [
      ...new Set(
        forceProbeTargets
          .filter((target) => {
            const source = currentInputSources.get(target.providerId);
            return (
              source && readCodexModelProtocolCapability(source, target.model)
            );
          })
          .map((target) => target.providerId),
      ),
    ];
    return {
      sources: routeReadySources.map((source) => {
        const entry = protocolLabOutcomeById.get(source.id);
        const includedModels = new Set(
          readIncludedWizardModelCatalog(source).map((model) => model.model),
        );
        const receiptModels = entry ? wizardReceiptModels(entry.outcome) : {};
        return {
          provider: source,
          receiptIds:
            reuseReceipts &&
            entry &&
            protocolProbeProviderSignature(entry.inputProvider) ===
              protocolProbeProviderSignature(
                currentInputSources.get(source.id) ?? source,
              )
              ? entry.outcome.receiptIds.filter((id) => {
                  const model = receiptModels[id];
                  return (
                    model &&
                    includedModels.has(model) &&
                    !consumedReceiptIdsRef.current.has(id) &&
                    !isProbeModelExcluded(source.id, model)
                  );
                })
              : [],
        };
      }),
      router: result.plan,
      forceProbeSourceIds,
      forceProbeTargets,
    };
  };

  const applyConnectivityProbeOutcome = (
    outcome: CodexProviderSetBatchProbeOutcome,
  ) => {
    const freshEntries = outcome.outcomes.map((entry) => ({
      ...entry,
      inputProvider:
        draftSources.find((source) => source.id === entry.providerId) ??
        entry.inputProvider,
    }));
    const combinedEntries = [
      ...mergeWizardProtocolOutcomes([
        ...currentProtocolOutcomes,
        ...freshEntries,
      ]).values(),
    ];
    const combinedOutcome = {
      ...outcome,
      outcomes: combinedEntries,
    };
    setRestoredEvidence(combinedOutcome);
    const results = buildWizardConnectivityResultsFromBatchOutcome(
      draftSources,
      combinedOutcome,
      hasCodexOauthAccount,
    );
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
      `Connectivity check complete: ${summary.passCount} passed, ${summary.warnCount} warnings, ${summary.skippedCount} skipped, ${summary.failCount} failed.`,
      { closeButton: true },
    );
  };

  function captureDraftOperation() {
    const generation = draftGenerationRef.current;
    const inputFacts = new Map(
      draftSources.map((source) => [
        source.id,
        providers.find((provider) => provider.id === source.id),
      ]),
    );
    return () =>
      draftGenerationRef.current === generation &&
      [...inputFacts].every(([id, original]) => {
        const latest = latestProvidersRef.current.find(
          (provider) => provider.id === id,
        );
        return (
          original &&
          latest &&
          protocolProbeProviderSignature(original) ===
            protocolProbeProviderSignature(latest)
        );
      });
  }

  const requestConnectivityProbe = () => {
    draftGenerationRef.current += 1;
    setIsRestoringEvidence(false);
    const isCurrent = captureDraftOperation();
    clearWizardIssuesForStage("protocol");
    const validation = batchProtocolLab.validate(buildBatchDraft(false));
    void validation
      .then((outcome) => {
        if (isCurrent()) applyConnectivityProbeOutcome(outcome);
      })
      .catch((error) => {
        if (!(error instanceof ProtocolLabCancelled)) {
          console.error("Wizard protocol validation failed", error);
        }
      });
  };

  const confirmConnectivityProbe = () => {
    if (batchProtocolLab.state.pendingIntent === "validate") {
      dispatchFlow({ type: "PROBE_START" });
    }
    setProbeDialogOpen(
      batchProtocolLab.state.draft
        ? batchProtocolLabAdapter.requiresProbe(
            batchProtocolLab.state.draft,
            [],
          )
        : false,
    );
    void batchProtocolLab.confirmProbe();
  };

  // 保存只调用统一 batch workflow：自动 Single/Split 都由后端规划并以 accept_auto
  // 原子提交；Blocked 保留草稿和预览，不再进入第二套 Split 确认状态。
  const saveMultiRouterPlan = () => {
    if (saveInFlightRef.current) return;
    const targetGeneration = targetGenerationRef.current;
    dispatchFlow({ type: "SAVE_START" });
    clearWizardIssuesForStage("save-enable");
    let draft: CodexProviderSetBatchDraft;
    try {
      draft = buildBatchDraft(true);
    } catch (error) {
      const message = formatWizardError(error);
      dispatchFlow({ type: "SAVE_ERROR", error: message });
      recordWizardIssue({
        stage: "save-enable",
        severity: "error",
        title: "MultiRouter save failed",
        detail: message,
        canContinue: false,
      });
      return;
    }
    const saveOperation = (async () => {
      // A successful commit consumes its receipts. Re-editing the same draft
      // must restore persisted evidence instead of spending tokens again.
      draft.sources = await Promise.all(
        draft.sources.map(async (source) => {
          if (
            source.receiptIds.length ||
            skipsWizardDeepProtocolProbe(source.provider)
          )
            return source;
          const evidence = await restoreCodexProviderProtocolEvidence(
            source.provider,
          );
          return evidence
            ? { ...source, receiptIds: evidence.receiptIds }
            : source;
        }),
      );
      if (targetGeneration !== targetGenerationRef.current)
        throw new ProtocolLabCancelled();
      return batchProtocolLab.save(
        draft,
        draft.sources.flatMap((source) => source.receiptIds),
      );
    })()
      .then(async (outcome) => {
        [
          ...draft.sources.flatMap((source) => source.receiptIds),
          ...(outcome.consumedReceiptIds ?? []),
        ].forEach((id) => consumedReceiptIdsRef.current.add(id));
        if (targetGeneration !== targetGenerationRef.current) return;
        setSavedPlan(outcome.editorRouter);
        // A successful atomic commit validates the backend's normalized source
        // snapshots. Keep that evidence applicable to the committed draft, but
        // do not reuse its consumed receipts for a subsequent save.
        const committedSources =
          outcome.sourceSnapshots.length > 0
            ? outcome.sourceSnapshots.map(
                (snapshot) => snapshot.logicalProvider,
              )
            : draft.sources.map((source) => source.provider);
        setRestoredEvidence({
          sources: committedSources.map((provider) => ({
            provider,
            receiptIds: [],
          })),
          outcomes: committedSources.flatMap((provider) => {
            const entry = protocolLabOutcomeById.get(provider.id);
            const committedOutcome =
              outcome.committedEvidence?.find(
                (evidence) => evidence.provider.id === provider.id,
              ) ?? entry?.outcome;
            if (!committedOutcome) return [];
            const models = readIncludedWizardModelCatalog(provider);
            return [
              {
                providerId: provider.id,
                inputProvider: provider,
                outcome: {
                  ...committedOutcome,
                  provider,
                  receiptIds: [],
                  receiptModels: {},
                  records: committedOutcome.records.filter((record) =>
                    models.some(
                      (model) =>
                        model.model === record.target.public_model &&
                        (model.upstreamModel ??
                          model.upstream_model ??
                          model.model) === record.target.upstream_model,
                    ),
                  ),
                },
              },
            ];
          }),
        });
        committedSourceFactsRef.current = new Map(
          outcome.sourceSnapshots.map((snapshot) => [
            snapshot.logicalProvider.id,
            protocolProbeProviderSignature(snapshot.logicalProvider),
          ]),
        );
        setDraftSources(committedSources);
        await queryClient.invalidateQueries({
          queryKey: ["providers", "codex"],
        });
        if (targetGeneration !== targetGenerationRef.current) return;
        if (outcome.status === "committed_with_projection_error") {
          toast.warning(
            "The model source and MultiRouter were saved atomically, but the Codex projection refresh failed; reactivate it from the status page.",
            { closeButton: true },
          );
        } else {
          toast.success(
            "Model source and MultiRouter saved in one operation.",
            {
              closeButton: true,
            },
          );
        }
        dispatchFlow({ type: "SAVE_SUCCESS" });
      })
      .catch((error) => {
        if (targetGeneration !== targetGenerationRef.current) return;
        if (error instanceof ProtocolLabCancelled) return;
        const message = formatWizardError(error);
        dispatchFlow({ type: "SAVE_ERROR", error: message });
      });
    saveInFlightRef.current = saveOperation.finally(() => {
      saveInFlightRef.current = null;
    });
  };

  const returnFromBlockedBatch = () => {
    batchProtocolLab.cancel();
    dispatchFlow({ type: "GOTO_STEP", stepKey: "routing-review" });
  };

  const retryBlockedBatchProbe = () => {
    setConnectivityResults([]);
    dispatchFlow({ type: "GOTO_STEP", stepKey: "protocol" });
    setProbeDialogOpen(true);
    batchProtocolLab.retry();
  };

  // 启用动作复用 App 里的 switchProvider 路径，保证 Codex 接管和 OAuth 保留逻辑保持一致。
  const enableSavedPlan = async () => {
    if (!savedPlan) return;
    const targetGeneration = targetGenerationRef.current;
    dispatchFlow({ type: "ENABLE_START" });
    clearWizardIssuesForStage("save-enable");
    try {
      await onEnablePlan(savedPlan);
      if (targetGeneration !== targetGenerationRef.current) return;
      dispatchFlow({ type: "ENABLE_SUCCESS" });
      toast.success(
        "Multi-model routing is enabled. Continue with history repair or open the independent model, Sub-Agent, and ordering settings.",
        {
          closeButton: true,
          duration: 12000,
        },
      );
    } catch (error) {
      if (targetGeneration !== targetGenerationRef.current) return;
      const message = formatWizardError(error);
      recordWizardIssue({
        stage: "save-enable",
        severity: "error",
        title: "Enable multi-route plan failed",
        detail: message,
        canContinue: false,
      });
      dispatchFlow({ type: "ENABLE_ERROR", error: message });
      toast.error(`Enable multi-route plan failed: ${message}`, {
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
      // Keep automatic-follow semantics intact in the preview as well as the
      // save path; the concrete active list is only a UI projection.
      catalogModelOrder:
        catalogModelOrder === null ? undefined : activeCatalogModelOrder,
      spawnAgentModels: activeSpawnAgentModels,
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
  const pendingSourcePreview =
    batchProtocolLab.state.phase === "blocked"
      ? ((
          batchProtocolLab.state
            .preparePreview as CodexProviderSetBatchPreview | null
        )?.sourcePreviews.find((preview) => preview.plan.kind === "blocked") ??
        null)
      : null;
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
        className="flex max-h-full w-[min(96vw,1280px)] min-h-0 flex-col overflow-hidden rounded-2xl border border-border/60 bg-background shadow-2xl"
      >
        <div className="flex shrink-0 items-start justify-between border-b border-border/60 bg-gradient-to-r from-blue-500/10 via-background to-violet-500/10 px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="rounded-md bg-primary/10 p-2 text-primary">
              <CurrentStepIcon className="h-5 w-5" />
            </div>
            <div>
              <div className="text-sm text-muted-foreground">
                Step {stepIndex + 1} of {steps.length}
              </div>
              <h2
                id="codex-multirouter-wizard-title"
                className="text-xl font-semibold"
              >
                {currentStep.title}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {currentStep.key === "protocol"
                  ? t("codexWizardProtocol.description", {
                      defaultValue:
                        "Resolve model protocols from provider API declarations or saved evidence; deep probing is the fallback for unresolved models.",
                    })
                  : currentStep.description}
              </p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => closeWizard(true)}
            aria-label="Close the multi-model setup wizard"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div
          data-testid="codex-multirouter-wizard-body"
          className="grid min-h-0 flex-1 grid-cols-[15rem_minmax(0,1fr)] overflow-hidden"
        >
          <div className="space-y-1 overflow-y-auto border-r border-border/60 bg-gradient-to-b from-blue-500/8 via-muted/25 to-violet-500/8 p-3">
            {steps.map((step, index) => {
              const StepIcon = step.icon;
              const canEditStep = canEnterWizardPage(step.key, flowContext);
              return (
                <button
                  key={step.key}
                  type="button"
                  className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm ${
                    index === stepIndex
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-muted"
                  }`}
                  onClick={() => openWizardStep(step)}
                  aria-current={index === stepIndex ? "step" : undefined}
                  data-read-only={canEditStep ? undefined : "true"}
                  title={
                    canEditStep
                      ? undefined
                      : "View only; complete the prerequisite before editing"
                  }
                >
                  <StepIcon className="h-4 w-4 shrink-0" />
                  <span className="truncate">{step.title}</span>
                  {!canEditStep && (
                    <span
                      aria-hidden="true"
                      className="ml-auto shrink-0 text-[10px] opacity-70"
                    >
                      Read only
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="min-h-0 overflow-y-auto p-5">
            <div
              role="status"
              aria-atomic="true"
              className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/60 bg-gradient-to-r from-blue-500/10 via-background to-violet-500/10 px-4 py-3"
            >
              <div>
                <div className="text-sm font-semibold">
                  {activePlan
                    ? `Editing: ${activePlan.name}`
                    : "Creating a new MultiRouter configuration"}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {activePlan
                    ? activePlan.id
                    : "The new configuration will not overwrite an existing MultiRouter; saving creates a separate plan."}
                </div>
              </div>
              <Badge variant="outline">
                {activePlan ? "Edit current plan" : "Create new configuration"}
              </Badge>
            </div>
            {editingTargetMissing ? (
              <div
                role="alert"
                className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
              >
                The target configuration no longer exists or is stale. Close the
                wizard and choose it again to edit: MultiRouter.
              </div>
            ) : null}
            <div role="status" aria-live="polite" className="sr-only">
              <span>State machine:{flowState.status}</span>
              <span>{wizardStatusText(flowState)}</span>
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
                  Captured issues and handling status
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
                          {issue.severity === "error" ? "Error" : "Warning"}
                        </Badge>
                        <span className="font-medium">{issue.title}</span>
                        {issue.providerName && (
                          <span className="text-xs text-muted-foreground">
                            {issue.providerName}
                          </span>
                        )}
                        <span className="text-xs text-muted-foreground">
                          {issue.canContinue
                            ? "Can continue"
                            : "Resolve before continuing"}
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
            {currentStepPrerequisite && (
              <div
                role="status"
                className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-100"
              >
                <div>
                  <div className="font-medium">
                    This step cannot be edited yet
                  </div>
                  <div className="mt-1 text-xs leading-5 opacity-90">
                    Complete “{currentStepPrerequisite.title}
                    ”. You can view this page; editing resumes after the
                    prerequisite is complete.
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => openWizardStep(currentStepPrerequisite)}
                >
                  Complete {currentStepPrerequisite.title}
                </Button>
              </div>
            )}
            <fieldset
              disabled={Boolean(currentStepPrerequisite)}
              aria-disabled={Boolean(currentStepPrerequisite)}
              className="m-0 min-w-0 border-0 p-0"
            >
              {currentStep.key === "welcome" && (
                <div className="space-y-4">
                  <div className="rounded-xl border border-blue-500/25 bg-gradient-to-r from-blue-500/10 via-background to-violet-500/10 p-5">
                    <div className="text-lg font-semibold">
                      MultiRouter setup wizard
                    </div>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                      The wizard checks local configuration, reads model
                      catalogs, then sends a small number of real requests to
                      the selected upstreams to verify Responses, Chat,
                      streaming, reasoning, tool calls, and continuation.
                    </p>
                  </div>
                  <div className="grid gap-3 md:grid-cols-3">
                    <div className="rounded-lg border p-4 text-sm">
                      <div className="font-medium">No early activation</div>
                      <p className="mt-2 leading-6 text-muted-foreground">
                        Current Codex configuration is not enabled or
                        overwritten before final confirmation.
                      </p>
                    </div>
                    <div className="rounded-lg border p-4 text-sm">
                      <div className="font-medium">Tests may incur charges</div>
                      <p className="mt-2 leading-6 text-muted-foreground">
                        Deep probes call real models and may consume a small
                        amount of quota or rate-limit capacity.
                      </p>
                    </div>
                    <div className="rounded-lg border p-4 text-sm">
                      <div className="font-medium">Real request acceptance</div>
                      <p className="mt-2 leading-6 text-muted-foreground">
                        After saving and enabling, complete one real Codex
                        request to finish setup.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {currentStep.key === "inventory" && (
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="rounded-lg border p-4">
                    <div className="text-sm font-medium">Codex Provider</div>
                    <div className="mt-2 text-2xl font-semibold">
                      {providerModelSources.length}
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground">
                      {providerModelSources.length > 0
                        ? "Model sources exist; the next step checks each source."
                        : "No model source exists; the wizard will connect a provider first."}
                    </p>
                  </div>
                  <div className="rounded-lg border p-4">
                    <div className="text-sm font-medium">
                      Existing MultiRouter
                    </div>
                    <div className="mt-2 text-2xl font-semibold">
                      {providers.filter(isCodexMultiRouterPlan).length}
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground">
                      {activePlan
                        ? `Editing ${activePlan.name}`
                        : "A separate plan will be created without overwriting existing routes."}
                    </p>
                  </div>
                </div>
              )}

              {currentStep.key === "first-provider" && (
                <div className="rounded-xl border border-dashed p-6 text-center">
                  <Server className="mx-auto h-10 w-10 text-primary" />
                  <div className="mt-3 font-semibold">
                    Connect a usable model source first
                  </div>
                  <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
                    The add page guides you through the service URL,
                    credentials, and connection test. After saving, it returns
                    here and selects the new source.
                  </p>
                  <Button className="mt-4" onClick={onCreateProvider}>
                    Open the add model source page
                  </Button>
                </div>
              )}

              {currentStep.key === "readiness" && (
                <div className="space-y-3">
                  {providerModelSources.map((provider) => {
                    const details = modelSourceStatusDetails(provider);
                    const issues = getWizardConfigIssues([provider]);
                    return (
                      <div key={provider.id} className="rounded-lg border p-4">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <div className="font-medium">{provider.name}</div>
                            <div className="mt-1 text-xs text-muted-foreground">
                              {provider.id}
                            </div>
                          </div>
                          <Badge
                            variant={
                              issues.length === 0 ? "secondary" : "outline"
                            }
                          >
                            {issues.length === 0
                              ? "Can continue"
                              : "Needs setup"}
                          </Badge>
                        </div>
                        <div className="mt-3 grid gap-1 text-xs leading-5 text-muted-foreground md:grid-cols-2">
                          {details.map((detail) => (
                            <div key={detail}>{detail}</div>
                          ))}
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="mt-3"
                          onClick={() => onOpenProviderConfig?.(provider)}
                        >
                          {issues.length === 0
                            ? "View advanced settings"
                            : "Complete provider configuration"}
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}

              {currentStep.key === "sources" && (
                <div className="space-y-4">
                  <div className="rounded-xl border border-border/60 bg-gradient-to-r from-sky-500/10 via-background to-cyan-500/10 p-4 text-sm leading-6">
                    <div className="font-medium">
                      This step only chooses model sources
                    </div>
                    <p className="mt-1 text-muted-foreground">
                      Credentials, catalogs, API protocols, reasoning, and tool
                      compatibility are maintained in each provider page. The
                      wizard only reads readiness and composes routes.
                    </p>
                  </div>
                </div>
              )}

              {currentStep.key === "sources" && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm text-muted-foreground">
                      Selected {draftSources.length} /{" "}
                      {providerModelSources.length} Codex providers as sources
                      for this plan; deselecting does not delete a provider.
                    </p>
                    <Button onClick={onCreateProvider}>
                      <Server className="mr-2 h-4 w-4" />
                      Add provider
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
                              aria-label={`Use ${provider.name} as a model source`}
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
                              {modelSourceSummary(provider)}
                            </Badge>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              aria-label={`Configure ${provider.name}`}
                              onClick={() => onOpenProviderConfig?.(provider)}
                            >
                              Configure provider
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                  {draftSources.length === 0 && (
                    <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                      The state machine is at NeedSources. Add a standard Codex
                      provider or close the wizard and import from existing
                      configuration.
                    </div>
                  )}
                </div>
              )}

              {currentStep.key === "reasoning" && (
                <div className="space-y-4">
                  <div className="rounded-lg border bg-muted/30 p-4 text-sm leading-6 text-muted-foreground">
                    The protocol page only confirms the reasoning semantics
                    returned by the upstream. This page shows current
                    capabilities and defaults. Model-level overrides are
                    maintained by each provider advanced settings and are not
                    mixed with automatic protocol selection.
                  </div>
                  {draftSources.map((provider) => (
                    <div
                      key={provider.id}
                      className="space-y-3 rounded-lg border p-4"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <div className="font-medium">{provider.name}</div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {inferWizardApiFormat(provider)} ·{" "}
                            {readIncludedWizardModelCatalog(provider).length}{" "}
                            models
                          </div>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          aria-label={`Edit advanced reasoning settings for ${provider.name}`}
                          onClick={() => onOpenProviderConfig?.(provider)}
                        >
                          Edit advanced reasoning settings
                        </Button>
                      </div>
                      <div className="grid gap-2 md:grid-cols-2">
                        {readIncludedWizardModelCatalog(provider).map(
                          (model) => {
                            const reasoning = model.reasoning;
                            const support =
                              reasoning?.supportStatus === "confirmed_supported"
                                ? "Reasoning support confirmed"
                                : reasoning?.supportStatus ===
                                    "confirmed_unsupported"
                                  ? "Reasoning support not confirmed"
                                  : "Capability unknown; use server default";
                            return (
                              <div
                                key={model.model}
                                className="rounded-md border bg-muted/20 p-3 text-xs"
                              >
                                <div className="font-medium text-foreground">
                                  {model.displayName ?? model.model}
                                </div>
                                <div className="mt-2 space-y-1 text-muted-foreground">
                                  <div>{support}</div>
                                  <div>
                                    Available efforts:
                                    {reasoning?.supportedEfforts?.join(" / ") ||
                                      "Not declared"}
                                  </div>
                                  <div>
                                    Default effort:
                                    {reasoning?.defaultEffort ??
                                      "Model default"}
                                  </div>
                                </div>
                              </div>
                            );
                          },
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {currentStep.key === "subagents-tools" && (
                <div className="space-y-4">
                  <div className="rounded-lg border bg-muted/30 p-4 text-sm leading-6 text-muted-foreground">
                    Basic mode supports up to five routable Sub-Agent candidates
                    and Hosted Tools. Roles, provider inheritance, and V2 rules
                    are maintained in the separate workspace and do not change
                    the primary model reasoning effort.
                  </div>
                  <div className="max-h-72 overflow-auto rounded-lg border">
                    {activeCatalogModelOrder.map((model) => {
                      const selected = activeSpawnAgentModels.includes(model);
                      return (
                        <label
                          key={model}
                          className="flex items-center gap-3 border-b px-3 py-2 text-sm last:border-b-0"
                        >
                          <input
                            type="checkbox"
                            checked={selected}
                            disabled={
                              !selected && activeSpawnAgentModels.length >= 5
                            }
                            onChange={(event) =>
                              setDraftSpawnAgentModels((current) =>
                                event.target.checked
                                  ? [
                                      ...current.filter(
                                        (item) => item !== model,
                                      ),
                                      model,
                                    ].slice(0, 5)
                                  : current.filter((item) => item !== model),
                              )
                            }
                            aria-label={`Use ${model} as a Sub-Agent candidate`}
                          />
                          <span>{model}</span>
                        </label>
                      );
                    })}
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <label className="flex items-center gap-3 rounded-lg border p-3 text-sm">
                      <input
                        type="checkbox"
                        checked={webSearchEnabled}
                        onChange={(event) =>
                          setWebSearchEnabled(event.target.checked)
                        }
                      />
                      Web Search Hosted Tool
                    </label>
                    <label className="flex items-center gap-3 rounded-lg border p-3 text-sm">
                      <input
                        type="checkbox"
                        checked={imageGenerationEnabled}
                        onChange={(event) =>
                          setImageGenerationEnabled(event.target.checked)
                        }
                      />
                      Image Generation Hosted Tool
                    </label>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!activePlan}
                    onClick={() =>
                      activePlan && onOpenWorkspace(activePlan, "subagents")
                    }
                  >
                    Open the Sub-Agent V2 advanced workspace
                  </Button>
                </div>
              )}

              {currentStep.key === "routing-review" && (
                <div className="space-y-4">
                  <div className="rounded-lg border p-4">
                    <label className="text-sm font-medium" htmlFor="plan-name">
                      MultiRouter name
                    </label>
                    <Input
                      id="plan-name"
                      className="mt-2"
                      value={draftPlanName}
                      onChange={(event) => setDraftPlanName(event.target.value)}
                      placeholder="Example: Codex MultiRouter - primary work route"
                    />
                    <p className="mt-2 text-xs leading-5 text-muted-foreground">
                      This name is saved to the provider list, status page, and
                      later enable prompts. Renaming only affects the
                      MultiRouter plan itself and does not rename individual
                      upstream providers.
                    </p>
                  </div>
                </div>
              )}

              {currentStep.key === "catalog" && (
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
                      Fetch model lists automatically
                    </Button>
                  </div>
                  <div className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
                    This step only syncs and compares catalogs. Results stay in
                    this draft; it does not rewrite protocols or enable the
                    current configuration.
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    {draftSources.map((provider) => {
                      const cardState =
                        modelFetchCards[provider.id] ??
                        defaultModelFetchCardState(provider);
                      const diffText = formatModelFetchDiff(cardState.diff);
                      return (
                        <button
                          key={provider.id}
                          type="button"
                          className="rounded-lg border p-3 text-left transition hover:border-primary/60 hover:bg-muted/40 focus:outline-none focus:ring-2 focus:ring-primary/40"
                          onClick={() => onOpenProviderConfig?.(provider)}
                          aria-label={`Open ${provider.name} settings`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="truncate font-medium">
                                {provider.name}
                              </div>
                              <div className="mt-2 text-sm text-muted-foreground">
                                {cardState.modelCount} models
                              </div>
                              <div className="mt-2 space-y-0.5 text-xs leading-5 text-muted-foreground">
                                {modelSourceStatusDetails(provider).map(
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
                              {modelFetchStatusLabel(cardState.status)}
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
                            Click to open the provider settings page
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {currentStep.key === "protocol" && (
                <div className="space-y-4">
                  <div className="rounded-lg border p-3 text-sm leading-6">
                    {t("codexWizardProtocol.summary", {
                      defaultValue:
                        "API-declared: {{declared}} models. Deep-verified: {{verified}} models. Unresolved: {{unresolved}} models.",
                      declared: connectivityResults.filter(
                        (result) =>
                          result.status === "skipped" &&
                          result.recommendedApiFormat,
                      ).length,
                      verified: connectivityResults.filter(
                        (result) => result.status === "pass",
                      ).length,
                      unresolved: retainedConnectivityResults.filter(
                        (result) => !result.canContinue,
                      ).length,
                    })}
                  </div>
                  {isRestoringEvidence && (
                    <p role="status">
                      Reading saved compatibility evidence without sending model
                      requests…
                    </p>
                  )}
                  {restoredEvidence && (
                    <p role="status">
                      {t("codexWizardProtocol.restoredSummary", {
                        defaultValue:
                          "Saved records checked: reusing {{count}} source evidence.",
                        count: restoredEvidence.outcomes.filter(
                          (entry) => entry.outcome.records.length > 0,
                        ).length,
                      })}
                    </p>
                  )}
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm leading-6 text-amber-900 dark:text-amber-200">
                    {t("codexWizardProtocol.fallbackScope", {
                      defaultValue:
                        "Each unresolved provider/model verifies Responses and Chat Completions base responses, streaming SSE, reasoning semantics, forced tool calls, and tool-result continuation when a deep probe is requested. Authentication failures, rate limits, network errors, and 5xx remain availability issues, not protocol incompatibility.",
                    })}
                  </div>
                  <Button
                    onClick={requestConnectivityProbe}
                    disabled={
                      isRefreshingModels ||
                      isProbingConnectivity ||
                      isRestoringEvidence ||
                      draftSources.length === 0
                    }
                  >
                    <Route
                      className={`mr-2 h-4 w-4 ${
                        isProbingConnectivity ? "animate-pulse" : ""
                      }`}
                    />
                    {isProbingConnectivity
                      ? "Running protocol deep probe"
                      : restoredEvidence?.outcomes.length
                        ? "Run compatibility deep probe again"
                        : "Start compatibility deep probe"}
                  </Button>
                  {connectivityResults.length > 0 && (
                    <Button
                      variant="outline"
                      disabled={isProbingConnectivity}
                      onClick={() => {
                        setExcludedProbeModels((current) => [
                          ...new Set([
                            ...current,
                            ...connectivityResults
                              .filter((result) => !result.canContinue)
                              .map((result) =>
                                probeModelKey(result.providerId, result.model),
                              ),
                          ]),
                        ]);
                        clearWizardIssuesForStage("protocol");
                      }}
                    >
                      Deselect all failed models
                    </Button>
                  )}
                  {connectivityResults.length > 0 && (
                    <div className="max-h-80 overflow-auto rounded-lg border">
                      {connectivityResults.map((result, index) => (
                        <div
                          key={`${result.providerId}:${result.model}:${index}`}
                          className="grid grid-cols-[7rem_1fr] gap-3 border-b px-3 py-2 text-sm last:border-b-0"
                        >
                          <Badge
                            variant={
                              result.status === "fail"
                                ? "destructive"
                                : "outline"
                            }
                            className="h-fit justify-center"
                          >
                            {result.status}
                          </Badge>
                          <div>
                            <label className="flex items-center gap-2">
                              <Checkbox
                                aria-label={`Keep ${result.providerName} / ${result.model}`}
                                checked={
                                  !isProbeModelExcluded(
                                    result.providerId,
                                    result.model,
                                  )
                                }
                                disabled={isProbingConnectivity}
                                onCheckedChange={(checked) => {
                                  const key = probeModelKey(
                                    result.providerId,
                                    result.model,
                                  );
                                  setExcludedProbeModels((current) =>
                                    checked
                                      ? current.filter((item) => item !== key)
                                      : [...new Set([...current, key])],
                                  );
                                  clearWizardIssuesForStage("protocol");
                                }}
                              />
                              {isProbeModelExcluded(
                                result.providerId,
                                result.model,
                              )
                                ? "Excluded (probe result unchanged)"
                                : "Keep this model"}
                            </label>
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

              {currentStep.key === "models" && (
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
                    Recompute duplicate aliases
                  </Button>
                  <div className="rounded-lg border p-4 text-sm text-muted-foreground">
                    Name policy: official/subscription models keep their names;
                    relay or third-party models use aliases such as
                    gpt-5.4-mini-relay ; upstreamModel still points to the real
                    upstream model.
                  </div>
                  {modelCollisions.length > 0 && (
                    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200">
                      Detected {modelCollisions.length} duplicate upstream
                      model-name groups. The alias policy is applied before
                      routes are generated.
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
                            ? `Upstream ${model.upstreamModel}`
                            : "Original name"}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {(currentStep.key === "models" ||
                currentStep.key === "model-order") && (
                <div className="space-y-4">
                  {currentStep.key === "models" && (
                    <div className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
                      Automatically follow the provider all available models;
                      deselecting a model switches to a fixed selection.
                      Ordering, reasoning, and Sub-Agent settings are handled on
                      later pages.
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    {currentStep.key === "models" && (
                      <>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => setCatalogModelOrder(null)}
                        >
                          Follow all models automatically
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => {
                            setCatalogModelOrder([]);
                            setDraftSpawnAgentModels([]);
                          }}
                        >
                          Deselect all
                        </Button>
                      </>
                    )}
                    <Badge variant="outline">
                      Kept {activeCatalogModelOrder.length} /{" "}
                      {availableCatalogModels.length}
                    </Badge>
                    <Badge
                      className={
                        catalogModelOrder === null
                          ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-500/50 dark:bg-emerald-500/10 dark:text-emerald-100"
                          : "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/50 dark:bg-amber-500/10 dark:text-amber-100"
                      }
                    >
                      {catalogModelOrder === null
                        ? "Follow provider automatically"
                        : "Fixed model selection"}
                    </Badge>
                  </div>
                  <div className="max-h-[min(50vh,34rem)] overflow-auto rounded-lg border">
                    {(currentStep.key === "model-order"
                      ? selectModelRows.filter((model) =>
                          activeCatalogModelOrder.includes(model.model),
                        )
                      : selectModelRows
                    ).map((model) => {
                      const kept = activeCatalogModelOrder.includes(
                        model.model,
                      );
                      const orderIndex = activeCatalogModelOrder.indexOf(
                        model.model,
                      );
                      return (
                        <div
                          key={`${model.model}:${model.upstreamModel ?? ""}`}
                          className={`grid items-center gap-3 border-b px-3 py-2 text-sm last:border-b-0 ${
                            currentStep.key === "models"
                              ? "grid-cols-[2rem_minmax(0,1fr)_8rem]"
                              : "grid-cols-[minmax(0,1fr)_8rem_5rem]"
                          }`}
                        >
                          {currentStep.key === "models" && (
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
                              aria-label={`Keep ${model.model}`}
                            />
                          )}
                          <div className="min-w-0">
                            <div className="truncate font-medium">
                              {model.model}
                            </div>
                            <div className="truncate text-xs text-muted-foreground">
                              {model.upstreamModel &&
                              model.upstreamModel !== model.model
                                ? `Upstream ${model.upstreamModel}`
                                : model.displayName || "Original name"}
                            </div>
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {model.contextWindow
                              ? `${model.contextWindow} ctx`
                              : "Context not declared"}
                          </div>
                          {currentStep.key === "model-order" && (
                            <div className="flex items-center gap-1">
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                disabled={!kept || orderIndex <= 0}
                                onClick={() =>
                                  moveCatalogModel(model.model, -1)
                                }
                                title="Move up"
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
                                  orderIndex >=
                                    activeCatalogModelOrder.length - 1
                                }
                                onClick={() => moveCatalogModel(model.model, 1)}
                                title="Move down"
                              >
                                <ArrowDown className="h-4 w-4" />
                              </Button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {currentStep.key === "routing-review" && (
                <div className="space-y-3">
                  <div className="grid gap-3 rounded-lg border bg-muted/30 p-4">
                    <div className="text-sm font-medium">
                      MultiRouter only configures model routing
                    </div>
                    <div className="text-xs leading-5 text-muted-foreground">
                      Official routes use OpenAI Official authentication; fixed
                      OAuth accounts and account pools do not depend on
                      MultiRouter. Change authentication from the OpenAI
                      Official card’s “Authentication settings.”
                    </div>
                    {existingPlan &&
                    existingPlan.settingsConfig?.codexRouting?.schemaVersion !==
                      2 ? (
                      <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs leading-5 text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-100 md:col-span-2">
                        This plan predates the upgrade; the current selection is
                        inferred from the old route. Preview and explicitly
                        apply the schema v2 migration before editing.
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
                        Model scope:
                        {route.modelSelection?.mode === "all"
                          ? "All models from the target provider"
                          : `${(route.modelSelection?.models ?? []).length} canonical models`}
                        ; prefixes{" "}
                        {(route.matchPrefixes ?? []).join(", ") || "None"}
                      </div>
                      <div className="mt-2 text-xs leading-5 text-muted-foreground">
                        Auth:
                        {route.authPolicy?.source === "native_codex_auth"
                          ? "Current Codex Desktop login"
                          : route.authPolicy?.source === "account_pool"
                            ? "OAuth account pool"
                            : route.authPolicy?.source === "managed_codex_oauth"
                              ? "CCSM OAuth"
                              : "Model source credentials"}
                        ; client transport: HTTP Responses
                      </div>
                      <div className="mt-2 rounded-md bg-muted px-3 py-2 text-xs leading-5 text-muted-foreground">
                        Protocols, endpoints, credentials, and model
                        capabilities are always read from the target
                        provider/model configuration; routes do not store these
                        fields.
                      </div>
                    </div>
                  ))}
                  {aliasSelectionIssues.length > 0 ? (
                    <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                      <div className="font-medium">Aliases need review</div>
                      <div className="mt-1 space-y-1 text-xs leading-5">
                        {aliasSelectionIssues.map((issue) => (
                          <div key={`${issue.routeId}:${issue.alias}`}>
                            Route {issue.routeLabel || issue.routeId}
                            {issue.routeLabel &&
                            issue.routeLabel !== issue.routeId
                              ? ` (${issue.routeId})`
                              : ""}
                            {issue.providerName
                              ? ` / Provider ${issue.providerName}`
                              : ""}
                            “{issue.alias}” → “{issue.canonicalModel}”:{" "}
                            {issue.reason}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              )}

              {currentStep.key === "save-enable" &&
                flowState.status !== "enabled" && (
                  <div className="space-y-4">
                    <div className="rounded-lg border p-4 text-sm text-muted-foreground">
                      Will save {previewRoutes.length} routes and{" "}
                      {previewModels.length} visible models to{" "}
                      {activePlan ? activePlan.name : "new MultiRouter"}.
                    </div>
                    {draftSources.length === 0 ? (
                      <div className="rounded-lg border border-dashed border-amber-500/40 bg-amber-500/10 p-4 text-sm leading-6 text-amber-900 dark:text-amber-100">
                        No model source is selected. Return to “Choose model
                        sources” and add/configure at least one provider before
                        saving.
                      </div>
                    ) : null}
                    <Button
                      onClick={saveMultiRouterPlan}
                      disabled={
                        isSavingPlan ||
                        isRestoringEvidence ||
                        editingTargetMissing ||
                        draftSources.length === 0 ||
                        aliasSelectionIssues.length > 0 ||
                        (connectivityResults.length > 0 &&
                          !canContinueAfterConnectivity(
                            retainedConnectivityResults,
                          ))
                      }
                    >
                      <Database className="mr-2 h-4 w-4" />
                      {isSavingPlan ? "Saving..." : "Save and publish"}
                    </Button>
                  </div>
                )}

              {currentStep.key === "save-enable" &&
                flowState.status !== "enabled" && (
                  <div className="space-y-4">
                    <div className="rounded-lg border p-4 text-sm leading-6 text-muted-foreground">
                      After saving, explicitly enable this multi-route plan.
                      After enabling, continue with independent settings, or
                      close the wizard and return to the MultiRouter status page
                      for real-request acceptance.
                    </div>
                    <div className="flex flex-wrap gap-3">
                      <Button
                        onClick={enableSavedPlan}
                        disabled={!savedPlan || isEnablingPlan}
                      >
                        <CheckCircle2 className="mr-2 h-4 w-4" />
                        Enable this multi-route plan
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
                        Open the status page to continue
                      </Button>
                    </div>
                  </div>
                )}

              {currentStep.key === "acceptance" && savedPlan && (
                <div className="space-y-4">
                  <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4">
                    <div className="flex items-start gap-3">
                      <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
                      <div>
                        <div className="font-medium text-emerald-900 dark:text-emerald-100">
                          MultiRouter enabled; waiting for real-request
                          acceptance
                        </div>
                        <div className="mt-1 text-sm leading-6 text-emerald-900/80 dark:text-emerald-100/80">
                          Send a real request in Codex . Completion requires a
                          route hit, upstream response, and valid terminal event
                          downstream. HTTP 200 or response headers alone do not
                          mean the request completed.
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-3">
                    <Button
                      type="button"
                      onClick={() => {
                        closeWizard(true);
                        onOpenWorkspace(savedPlan, "status");
                      }}
                    >
                      <Route className="mr-2 h-4 w-4" />
                      Open the status page to finish acceptance
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => closeWizard(false)}
                    >
                      Accept later
                    </Button>
                  </div>

                  <div className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
                    Acceptance is independent from the history repair,
                    reasoning, Sub-Agent, and model-order entries below; it does
                    not rerun protocol probes or split Provider.
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="h-auto justify-start gap-3 px-4 py-3 text-left"
                      disabled={!onOpenHistoryRepair}
                      onClick={() => {
                        onOpenChange(false);
                        onOpenHistoryRepair?.();
                      }}
                    >
                      <History className="h-5 w-5 shrink-0" />
                      <span>
                        <span className="block font-medium">
                          Repair Codex history
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          Open history repair to handle provider and
                          model-switch records
                        </span>
                      </span>
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-auto justify-start gap-3 px-4 py-3 text-left"
                      onClick={() => {
                        onOpenChange(false);
                        onOpenWorkspace(savedPlan, "sources");
                      }}
                    >
                      <SlidersHorizontal className="h-5 w-5 shrink-0" />
                      <span>
                        <span className="block font-medium">
                          Set model reasoning effort
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          Return to each model source to maintain reasoning
                          capabilities and efforts
                        </span>
                      </span>
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-auto justify-start gap-3 px-4 py-3 text-left"
                      onClick={() => {
                        onOpenChange(false);
                        onOpenWorkspace(savedPlan, "subagents");
                      }}
                    >
                      <Bot className="h-5 w-5 shrink-0" />
                      <span>
                        <span className="block font-medium">
                          Configure Sub-Agent
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          Open the independent Sub-Agent V1/V2 configuration
                          area
                        </span>
                      </span>
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-auto justify-start gap-3 px-4 py-3 text-left"
                      onClick={() => {
                        onOpenChange(false);
                        onOpenWorkspace(savedPlan, "model-order");
                      }}
                    >
                      <GripVertical className="h-5 w-5 shrink-0" />
                      <span>
                        <span className="block font-medium">
                          Adjust model order
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          Adjust the display order in the Codex model picker
                        </span>
                      </span>
                    </Button>
                  </div>
                </div>
              )}
            </fieldset>
          </div>
        </div>

        <CodexProtocolProbeProgressDialog
          open={probeDialogOpen}
          running={batchProtocolLab.state.phase === "probing"}
          expectedTargets={(() => {
            const draft = batchProtocolLab.state.draft;
            const forcedTargets = draft?.forceProbeTargets ?? [];
            const hasTargetSnapshot = Array.isArray(draft?.forceProbeTargets);
            return (draft?.sources ?? []).flatMap((source) => {
              const sourceTargets = forcedTargets
                .filter((target) => target.providerId === source.provider.id)
                .map((target) => target.model);
              const models = hasTargetSnapshot
                ? sourceTargets
                : codexProviderModelsRequiringProtocolProbe(source.provider);
              return [...new Set(models)].map((model) => ({
                providerId: source.provider.id,
                providerName: source.provider.name,
                model,
              }));
            });
          })()}
          events={batchProtocolLab.state.progress}
          outcome={
            batchProtocolLab.probeOutcome?.outcomes.at(-1)?.outcome ?? null
          }
          outcomes={(batchProtocolLab.probeOutcome?.outcomes ?? []).map(
            (entry) => entry.outcome,
          )}
          error={batchProtocolLab.state.errorDetail ?? ""}
          onOpenChange={setProbeDialogOpen}
          onRetry={() => {
            setProbeDialogOpen(true);
            batchProtocolLab.retry();
          }}
        />

        <CodexProviderSetPreviewDialog
          open={pendingSourcePreview !== null}
          preview={pendingSourcePreview}
          pending={isSavingPlan}
          onBack={returnFromBlockedBatch}
          onConfirmSplit={() => undefined}
          onRetry={retryBlockedBatchProbe}
        />

        <Dialog
          open={
            batchProtocolLab.state.phase === "awaiting_probe_consent" ||
            batchProtocolLab.state.phase === "stale_retry"
          }
          onOpenChange={(nextOpen) => {
            if (!nextOpen) batchProtocolLab.cancel();
          }}
        >
          <DialogContent className="max-w-lg" zIndex="top">
            <DialogHeader>
              <DialogTitle>Confirm compatibility deep probe</DialogTitle>
              <DialogDescription className="space-y-2 text-left">
                <span className="block">
                  Each standard provider/model verifies Responses and Chat
                  Completions. Probes send real requests upstream and consume
                  model tokens and may incur charges or rate limits; each
                  source’s token usage and estimated cost are shown when
                  complete.
                </span>
                <span className="block">
                  Each protocol must pass base response, streaming SSE,
                  reasoning fields, forced tool calls, and tool-result
                  continuation; only a complete transaction produces a saveable
                  receipt.
                </span>
                <span className="block">
                  401/403/429, network errors, and 5xx are shown as
                  authentication, quota, or upstream availability issues, not
                  protocol incompatibility. Official and managed-account sources
                  always use Responses and do not send these extra probes.
                </span>
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => batchProtocolLab.cancel()}
              >
                Cancel
              </Button>
              <Button type="button" onClick={confirmConnectivityProbe}>
                Confirm test
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
              <DialogTitle>
                Migrate legacy MultiRouter before editing
              </DialogTitle>
              <DialogDescription>
                schema v1 Read-only compatibility is preserved. Review and
                explicitly apply the migration preview before editing or
                enabling; the preview never shows keys or Token.
              </DialogDescription>
            </DialogHeader>
            {isLoadingMigration ? (
              <div className="rounded-md border p-3 text-sm text-muted-foreground">
                Generating migration preview…
              </div>
            ) : migrationPreview ? (
              <div className="space-y-3 text-sm">
                <div className="grid gap-2 sm:grid-cols-3">
                  <div className="rounded-md border p-3">
                    Redundant fields removed:
                    {migrationPreview.diff.removedRouteFields.length}
                  </div>
                  <div className="rounded-md border p-3">
                    Reference changes:
                    {migrationPreview.diff.changedRouteIds.length}
                  </div>
                  <div className="rounded-md border p-3">
                    Providers created:
                    {migrationPreview.generatedProviders.length}
                  </div>
                </div>
                {migrationPreview.generatedProviders.map((provider) => (
                  <div key={provider.id} className="rounded-md border p-3">
                    {provider.name} ({provider.id}), source{" "}
                    {provider.sourceProviderId}
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
                Cancel editing
              </Button>
              <Button
                disabled={!migrationPreview || isApplyingMigration}
                onClick={() => void applyLegacyMigration()}
              >
                {isApplyingMigration
                  ? "Applying…"
                  : "Apply migration and continue editing"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <div className="flex shrink-0 items-center justify-between border-t px-5 py-4">
          <Button variant="ghost" onClick={() => closeWizard(true)}>
            Save draft and close
          </Button>
          <Button
            variant="ghost"
            disabled={
              isProbingConnectivity ||
              isSavingPlan ||
              isRefreshingModels ||
              isEnablingPlan
            }
            onClick={() => {
              initializedOpenRef.current = false;
              draftGenerationRef.current += 1;
              batchProtocolLab.reset();
              onOpenChange(false);
            }}
          >
            Discard draft
          </Button>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={retreatWizard}
              disabled={stepIndex === 0}
            >
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back
            </Button>
            <Button onClick={advanceWizard}>
              {stepIndex === steps.length - 1 ? "Close" : "Next"}
              {stepIndex !== steps.length - 1 && (
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
