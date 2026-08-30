import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  CheckCircle2,
  Circle,
  Loader2,
  MinusCircle,
  Square,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type {
  CodexProtocolCompatibilityRecord,
  CodexProtocolProbeProgressEvent,
  CodexProtocolProbeFailure,
  CodexProtocolProbeReadiness,
  CodexProtocolProbeStage,
  CodexProtocolProbeStageStatus,
  CodexProtocolTransport,
  CodexProviderProtocolPreflightOutcome,
  CodexReasoningSemantic,
  CodexReasoningSource,
} from "@/lib/api/protocol-compatibility";

type VisibleStageStatus = CodexProtocolProbeStageStatus | "pending" | "running";

interface BranchProgress {
  touched: boolean;
  stages: Record<CodexProtocolProbeStage, VisibleStageStatus>;
  reasoningSemantic: CodexReasoningSemantic | null;
  reasoningSource: CodexReasoningSource | null;
  readiness: CodexProtocolProbeReadiness | null;
  failures: CodexProtocolProbeFailure[];
}

interface ModelProgress {
  model: string;
  branches: Record<CodexProtocolTransport, BranchProgress>;
  selectedTransport: CodexProtocolTransport | null;
  readiness: CodexProtocolProbeReadiness | null;
}

interface CodexProtocolProbeProgressDialogProps {
  open: boolean;
  running: boolean;
  expectedModels?: string[];
  events: CodexProtocolProbeProgressEvent[];
  outcome: CodexProviderProtocolPreflightOutcome | null;
  error: string;
  onOpenChange: (open: boolean) => void;
  onStop?: () => void;
  stopping?: boolean;
  onRetry?: () => void;
}

const STAGES: Array<{
  id: CodexProtocolProbeStage;
  label: string;
  labelKey: string;
}> = [
  { id: "baseline", label: "基础响应", labelKey: "codexProbe.stageBaseline" },
  { id: "streaming", label: "流式 SSE", labelKey: "codexProbe.stageStreaming" },
  { id: "reasoning", label: "思考内容", labelKey: "codexProbe.stageReasoning" },
  {
    id: "forced_tool",
    label: "工具调用",
    labelKey: "codexProbe.stageForcedTool",
  },
  {
    id: "continuation",
    label: "工具续轮",
    labelKey: "codexProbe.stageContinuation",
  },
];

const TRANSPORTS: CodexProtocolTransport[] = [
  "open_ai_responses",
  "open_ai_chat",
];

function emptyBranch(): BranchProgress {
  return {
    touched: false,
    stages: {
      baseline: "pending",
      streaming: "pending",
      reasoning: "pending",
      forced_tool: "pending",
      continuation: "pending",
    },
    reasoningSemantic: null,
    reasoningSource: null,
    readiness: null,
    failures: [],
  };
}

function emptyModel(model: string): ModelProgress {
  return {
    model,
    branches: {
      open_ai_responses: emptyBranch(),
      open_ai_chat: emptyBranch(),
    },
    selectedTransport: null,
    readiness: null,
  };
}

function applyRecord(
  model: ModelProgress,
  record: CodexProtocolCompatibilityRecord,
) {
  model.selectedTransport = record.result.selected_transport;
  model.readiness = record.result.readiness;
  for (const branch of record.result.branches) {
    const target = model.branches[branch.assessment.transport];
    target.touched = true;
    target.stages.baseline = branch.assessment.baseline;
    target.stages.streaming = branch.assessment.streaming;
    target.stages.forced_tool = branch.assessment.forced_tool;
    target.stages.continuation = branch.assessment.continuation;
    target.stages.reasoning =
      branch.reasoning_shape.semantic === "none"
        ? branch.assessment.baseline === "passed"
          ? "unsupported"
          : "skipped"
        : "passed";
    target.reasoningSemantic = branch.reasoning_shape.semantic;
    target.reasoningSource = branch.reasoning_shape.source;
    target.failures = branch.failures ?? [];
  }
}

function buildProgress(
  expectedModels: string[],
  events: CodexProtocolProbeProgressEvent[],
  outcome: CodexProviderProtocolPreflightOutcome | null,
): ModelProgress[] {
  const models = new Map<string, ModelProgress>();
  const ensure = (model: string) => {
    const current = models.get(model) ?? emptyModel(model);
    models.set(model, current);
    return current;
  };

  for (const model of expectedModels) ensure(model);

  for (const event of events) {
    if (!("model" in event)) continue;
    const model = ensure(event.model);
    if (event.kind === "candidate_started") continue;
    if (event.kind === "candidate_finished") {
      model.selectedTransport = event.selectedTransport;
      model.readiness = event.readiness;
      continue;
    }
    const branch = model.branches[event.transport];
    branch.touched = true;
    if (event.kind === "stage_started") {
      branch.stages[event.stage] = "running";
    } else if (event.kind === "stage_finished") {
      branch.stages[event.stage] = event.stageStatus;
      if (event.failure) {
        branch.failures = [
          ...branch.failures.filter(
            (failure) => failure.stage !== event.failure?.stage,
          ),
          event.failure,
        ];
      }
    } else if (event.kind === "reasoning_classified") {
      branch.reasoningSemantic = event.reasoningSemantic;
      branch.reasoningSource = event.reasoningSource;
      branch.stages.reasoning =
        event.reasoningSemantic === "none"
          ? branch.stages.baseline === "passed"
            ? "unsupported"
            : "skipped"
          : "passed";
    } else if (event.kind === "branch_finished") {
      branch.readiness = event.readiness;
    }
  }

  for (const record of outcome?.records ?? []) {
    const model = ensure(record.target.public_model);
    applyRecord(model, record);
  }
  return [...models.values()];
}

type TranslateFn = (key: string, opts?: Record<string, unknown>) => string;

function statusPresentation(status: VisibleStageStatus, t: TranslateFn) {
  if (status === "running") {
    return {
      label: t("codexProbe.statusRunning", { defaultValue: "检测中" }),
      icon: Loader2,
      className: "text-sky-600 animate-spin",
    };
  }
  if (status === "passed") {
    return {
      label: t("codexProbe.statusPassed", { defaultValue: "通过" }),
      icon: CheckCircle2,
      className: "text-emerald-600",
    };
  }
  if (status === "failed") {
    return {
      label: t("codexProbe.statusFailed", { defaultValue: "失败" }),
      icon: XCircle,
      className: "text-destructive",
    };
  }
  if (status === "unsupported") {
    return {
      label: t("codexProbe.statusUnsupported", { defaultValue: "不支持" }),
      icon: MinusCircle,
      className: "text-amber-600",
    };
  }
  if (status === "skipped") {
    return {
      label: t("codexProbe.statusSkipped", { defaultValue: "已跳过" }),
      icon: MinusCircle,
      className: "text-muted-foreground",
    };
  }
  return {
    label: t("codexProbe.statusPending", { defaultValue: "等待" }),
    icon: Circle,
    className: "text-muted-foreground/60",
  };
}

function reasoningLabel(
  semantic: CodexReasoningSemantic | null,
  status: VisibleStageStatus,
  t: TranslateFn,
) {
  if (semantic === "readable") {
    return t("codexProbe.reasoningReadable", { defaultValue: "可读正文" });
  }
  if (semantic === "summary") {
    return t("codexProbe.reasoningSummary", { defaultValue: "摘要" });
  }
  if (semantic === "opaque") {
    return t("codexProbe.reasoningOpaque", {
      defaultValue: "加密/不透明",
    });
  }
  if (semantic === "none") {
    return status === "skipped"
      ? t("codexProbe.reasoningNoneSkipped", { defaultValue: "未检测" })
      : t("codexProbe.reasoningNone", { defaultValue: "未返回" });
  }
  return t("codexProbe.reasoningPending", { defaultValue: "待识别" });
}

function failureLabel(failure: CodexProtocolProbeFailure, t: TranslateFn) {
  if (failure.kind === "http_status") {
    if (failure.status_code === 521) {
      return t("codexProbe.failureHttp521", {
        defaultValue: "HTTP 521 · 上游不可达",
      });
    }
    if ([404, 405, 415].includes(failure.status_code ?? 0)) {
      return t("codexProbe.failureHttpUnsupported", {
        defaultValue: "HTTP {{code}} · 接口不支持",
        code: failure.status_code,
      });
    }
    return failure.status_code
      ? t("codexProbe.failureHttp", {
          defaultValue: "HTTP {{code}} · 上游请求失败",
          code: failure.status_code,
        })
      : t("codexProbe.failureHttpNoCode", {
          defaultValue: "上游请求失败",
        });
  }
  if (failure.kind === "timeout") {
    return t("codexProbe.failureTimeout", { defaultValue: "请求超时" });
  }
  if (failure.kind === "network") {
    return t("codexProbe.failureNetwork", { defaultValue: "网络连接失败" });
  }
  if (failure.kind === "response_too_large") {
    return t("codexProbe.failureTooLarge", {
      defaultValue: "响应超过探测上限",
    });
  }
  if (failure.kind === "invalid_request") {
    return t("codexProbe.failureInvalidRequest", {
      defaultValue: "探测地址无效",
    });
  }
  return t("codexProbe.failureInvalidFormat", { defaultValue: "响应格式无效" });
}

function readinessLabel(
  readiness: CodexProtocolProbeReadiness | null,
  t: TranslateFn,
) {
  if (readiness === "verified") {
    return t("codexProbe.readinessVerified", { defaultValue: "Verified" });
  }
  if (readiness === "partial") {
    return t("codexProbe.readinessPartial", { defaultValue: "Partial" });
  }
  if (readiness === "unverified") {
    return t("codexProbe.readinessFailed", { defaultValue: "Failed" });
  }
  return t("codexProbe.readinessPending", { defaultValue: "待评估" });
}

function transportLabel(transport: CodexProtocolTransport, t: TranslateFn) {
  return transport === "open_ai_responses"
    ? t("codexProbe.transportResponses", { defaultValue: "Responses" })
    : t("codexProbe.transportChat", { defaultValue: "Chat Completions" });
}

export function CodexProtocolProbeProgressDialog({
  open,
  running,
  expectedModels = [],
  events,
  outcome,
  error,
  onOpenChange,
  onStop,
  stopping = false,
  onRetry,
}: CodexProtocolProbeProgressDialogProps) {
  const { t } = useTranslation();
  const models = useMemo(
    () => buildProgress(expectedModels, events, outcome),
    [expectedModels, events, outcome],
  );
  const batch = [...events]
    .reverse()
    .find((event) => event.kind === "batch_finished");
  const completed = models.filter((model) => model.readiness !== null).length;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && running) return;
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        className="flex max-h-[88vh] max-w-5xl flex-col"
        zIndex="top"
      >
        <DialogHeader>
          <DialogTitle>
            {t("codexProbe.title", { defaultValue: "Codex 兼容性深度探测" })}
          </DialogTitle>
          <DialogDescription>
            {running
              ? t("codexProbe.runningSummary", {
                  defaultValue:
                    "正在验证模型 {{completed}}/{{total}}。每个模型会依次检查 Responses 与 Chat。",
                  completed,
                  total: models.length || "…",
                })
              : batch
                ? t("codexProbe.batchSummary", {
                    defaultValue:
                      "已完成 {{total}} 个模型：Verified {{verified}}，Partial {{partial}}，Failed {{failed}}。",
                    total: batch.total,
                    verified: batch.verified,
                    partial: batch.partial,
                    failed: batch.failed,
                  })
                : t("codexProbe.finishedSummary", {
                    defaultValue: "探测已结束。",
                  })}
          </DialogDescription>
        </DialogHeader>

        <div
          className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1"
          role="status"
          aria-live="polite"
        >
          {error && (
            <div
              className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
              role="alert"
            >
              {t("codexProbe.interrupted", {
                defaultValue: "探测中断：{{error}}",
                error,
              })}
            </div>
          )}
          {models.length === 0 && !error && (
            <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
              {t("codexProbe.preparing", {
                defaultValue: "正在准备模型和探测请求…",
              })}
            </div>
          )}
          {models.map((model) => (
            <article
              key={model.model}
              aria-label={t("codexProbe.modelAria", {
                defaultValue: "{{model}} 探测进度",
                model: model.model,
              })}
              className="space-y-3 rounded-lg border border-border-default bg-muted/10 p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-medium text-foreground">{model.model}</h3>
                <div className="flex items-center gap-2 text-xs">
                  {model.selectedTransport && (
                    <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-sky-700 dark:text-sky-300">
                      {t("codexProbe.selectedTransport", {
                        defaultValue: "选择 {{transport}}",
                        transport: transportLabel(model.selectedTransport, t),
                      })}
                    </span>
                  )}
                  <span className="rounded-full border px-2 py-0.5 text-muted-foreground">
                    {readinessLabel(model.readiness, t)}
                  </span>
                </div>
              </div>

              <div className="grid gap-3 lg:grid-cols-2">
                {TRANSPORTS.map((transport) => {
                  const branch = model.branches[transport];
                  return (
                    <section
                      key={transport}
                      className="rounded-md border bg-background/70 p-3"
                    >
                      <div className="mb-3 flex items-center justify-between gap-2">
                        <h4 className="text-sm font-medium">
                          {transportLabel(transport, t)}
                        </h4>
                        <span className="text-xs text-muted-foreground">
                          {readinessLabel(branch.readiness, t)}
                        </span>
                      </div>
                      {!branch.touched ? (
                        <p className="text-xs text-muted-foreground">
                          {t("codexProbe.waiting", {
                            defaultValue: "等待开始",
                          })}
                        </p>
                      ) : (
                        <div className="space-y-2">
                          {STAGES.map((stage) => {
                            const status = statusPresentation(
                              branch.stages[stage.id],
                              t,
                            );
                            const Icon = status.icon;
                            return (
                              <div
                                key={stage.id}
                                className="flex items-center justify-between gap-3 text-sm"
                              >
                                <span>
                                  {t(stage.labelKey, {
                                    defaultValue: stage.label,
                                  })}
                                </span>
                                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                  {stage.id === "reasoning" && (
                                    <span>
                                      {reasoningLabel(
                                        branch.reasoningSemantic,
                                        branch.stages.reasoning,
                                        t,
                                      )}
                                    </span>
                                  )}
                                  <Icon
                                    className={cn("h-4 w-4", status.className)}
                                    aria-hidden
                                  />
                                  <span>{status.label}</span>
                                </span>
                              </div>
                            );
                          })}
                          {branch.failures.length > 0 && (
                            <div className="space-y-1 border-t pt-2 text-xs text-destructive">
                              {branch.failures.map((failure) => (
                                <p
                                  key={`${failure.stage}:${failure.kind}:${failure.status_code ?? ""}`}
                                >
                                  {failureLabel(failure, t)}
                                </p>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </section>
                  );
                })}
              </div>
            </article>
          ))}
        </div>

        <DialogFooter>
          {running && onStop && (
            <Button
              type="button"
              variant="destructive"
              onClick={onStop}
              disabled={stopping}
            >
              {stopping ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Square className="mr-2 h-4 w-4" />
              )}
              {stopping
                ? t("codexProbe.stopping", { defaultValue: "Stopping…" })
                : t("codexProbe.stop", { defaultValue: "Stop probe" })}
            </Button>
          )}
          {!running && onRetry && (
            <Button type="button" variant="outline" onClick={onRetry}>
              {t("codexProbe.retry", { defaultValue: "重新探测" })}
            </Button>
          )}
          <Button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={running}
          >
            {running
              ? t("codexProbe.runningClose", { defaultValue: "探测进行中" })
              : t("codexProbe.close", { defaultValue: "关闭" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
