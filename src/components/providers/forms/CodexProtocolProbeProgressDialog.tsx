import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  CheckCircle2,
  ChevronDown,
  Circle,
  Loader2,
  MinusCircle,
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
  CodexCompatibilityRule,
  CodexAdaptationChange,
  CodexAdaptationOutcome,
  CodexAdaptationTrigger,
  CodexProtocolCompatibilityRecord,
  CodexProtocolProbeFailure,
  CodexProtocolProbeReadiness,
  CodexProtocolProbeStage,
  CodexProtocolProbeStageStatus,
  CodexProtocolTransport,
  CodexProviderProtocolPreflightOutcome,
  CodexReasoningSemantic,
  CodexReasoningSource,
  CodexToolSchemaEvidence,
} from "@/lib/api/protocol-compatibility";
import type {
  CodexProviderProtocolProbeTarget,
  CodexProviderScopedProtocolProbeProgressEvent,
} from "@/lib/protocol-lab/codex-adapters";
import type { CodexHistoryReplay, CodexToolSchemaDialect } from "@/types";
import { CodexCompatibilitySummary } from "./CodexCompatibilitySummary";
import { normalizeCodexPublicModelKey } from "@/lib/protocol-lab/codex-overrides";

type VisibleStageStatus = CodexProtocolProbeStageStatus | "pending" | "running";

interface BranchProgress {
  retries: CodexCompatibilityRule[];
  touched: boolean;
  stages: Record<CodexProtocolProbeStage, VisibleStageStatus>;
  reasoningSemantic: CodexReasoningSemantic | null;
  reasoningSource: CodexReasoningSource | null;
  readiness: CodexProtocolProbeReadiness | null;
  failures: CodexProtocolProbeFailure[];
  toolSchemaDialect: CodexToolSchemaDialect | null;
  toolSchemaEvidence: CodexToolSchemaEvidence | null;
  historyReplay: CodexHistoryReplay | null;
  adaptations: Array<{
    trigger: CodexAdaptationTrigger;
    change: CodexAdaptationChange;
    outcome: CodexAdaptationOutcome | "trying";
  }>;
}

interface ModelProgress {
  key: string;
  model: string;
  providerId: string | null;
  providerName: string | null;
  branches: Record<CodexProtocolTransport, BranchProgress>;
  selectedTransport: CodexProtocolTransport | null;
  readiness: CodexProtocolProbeReadiness | null;
}

interface CodexProtocolProbeProgressDialogProps {
  open: boolean;
  running: boolean;
  actionRequired?: boolean;
  expectedModels?: string[];
  expectedTargets?: CodexProviderProtocolProbeTarget[];
  events: CodexProviderScopedProtocolProbeProgressEvent[];
  outcome: CodexProviderProtocolPreflightOutcome | null;
  outcomes?: CodexProviderProtocolPreflightOutcome[];
  storedRecords?: CodexProtocolCompatibilityRecord[];
  manualSelections?: Record<string, CodexProtocolTransport>;
  error: string;
  onOpenChange: (open: boolean) => void;
  onRetry?: () => void;
  onSelectTransport?: (input: {
    model: string;
    providerId: string | null;
    transport: CodexProtocolTransport;
    readiness: CodexProtocolProbeReadiness;
  }) => void;
}

function stages(
  t: TFunction,
): Array<{ id: CodexProtocolProbeStage; label: string }> {
  return [
    {
      id: "baseline",
      label: t("codexProtocolProbe.baseline", {
        defaultValue: "Baseline response",
      }),
    },
    {
      id: "streaming",
      label: t("codexProtocolProbe.streaming", {
        defaultValue: "Streaming SSE",
      }),
    },
    {
      id: "reasoning",
      label: t("codexProtocolProbe.reasoning", {
        defaultValue: "Reasoning content",
      }),
    },
    {
      id: "forced_tool",
      label: t("codexProtocolProbe.forcedTool", { defaultValue: "Tool call" }),
    },
    {
      id: "continuation",
      label: t("codexProtocolProbe.continuation", {
        defaultValue: "Tool continuation",
      }),
    },
  ];
}

const TRANSPORTS: CodexProtocolTransport[] = [
  "open_ai_responses",
  "open_ai_chat",
];

function emptyBranch(): BranchProgress {
  return {
    retries: [],
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
    toolSchemaDialect: null,
    toolSchemaEvidence: null,
    historyReplay: null,
    adaptations: [],
  };
}

function progressKey(model: string, providerId?: string | null): string {
  return providerId ? `${providerId}\u0000${model}` : model;
}

function selectedTransportFor(
  model: ModelProgress,
  manualSelections?: Record<string, CodexProtocolTransport>,
): CodexProtocolTransport | null {
  const manual = manualSelections?.[normalizeCodexPublicModelKey(model.model)];
  if (manual) return manual;
  return model.readiness === "verified" ? model.selectedTransport : null;
}

function emptyModel(
  model: string,
  providerId?: string | null,
  providerName?: string | null,
): ModelProgress {
  return {
    key: progressKey(model, providerId),
    model,
    providerId: providerId ?? null,
    providerName: providerName ?? null,
    branches: {
      open_ai_responses: emptyBranch(),
      open_ai_chat: emptyBranch(),
    },
    selectedTransport: null,
    readiness: null,
  };
}

function reasoningStageStatus(
  semantic: CodexReasoningSemantic,
  baseline: VisibleStageStatus,
): VisibleStageStatus {
  if (semantic === "readable" || semantic === "summary") return "passed";
  if (semantic === "opaque") return "unsupported";
  return baseline === "passed" ? "unsupported" : "skipped";
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
    target.stages.reasoning = reasoningStageStatus(
      branch.reasoning_shape.semantic,
      branch.assessment.baseline,
    );
    target.reasoningSemantic = branch.reasoning_shape.semantic;
    target.reasoningSource = branch.reasoning_shape.source;
    target.toolSchemaDialect = branch.tool_schema_dialect ?? null;
    target.toolSchemaEvidence = branch.tool_schema_evidence ?? null;
    target.historyReplay = branch.history_replay ?? null;
    target.adaptations = branch.adaptations ?? [];
    target.readiness = [
      branch.assessment.baseline,
      branch.assessment.streaming,
      branch.assessment.forced_tool,
      branch.assessment.continuation,
    ].every((status) => status === "passed")
      ? "verified"
      : branch.assessment.baseline === "passed"
        ? "partial"
        : "unverified";
    target.failures = branch.failures ?? [];
  }
}

function buildProgress(
  expectedModels: string[],
  expectedTargets: CodexProviderProtocolProbeTarget[],
  events: CodexProviderScopedProtocolProbeProgressEvent[],
  outcomes: CodexProviderProtocolPreflightOutcome[],
  storedRecords: CodexProtocolCompatibilityRecord[],
): ModelProgress[] {
  const models = new Map<string, ModelProgress>();
  const scoped =
    expectedTargets.length > 0 ||
    events.some((event) => Boolean(event.providerId));
  const ensure = (
    model: string,
    providerId?: string | null,
    providerName?: string | null,
  ) => {
    const key = progressKey(model, scoped ? providerId : null);
    const current =
      models.get(key) ??
      emptyModel(model, scoped ? providerId : null, providerName);
    models.set(key, current);
    return current;
  };

  if (expectedTargets.length > 0) {
    for (const target of expectedTargets) {
      ensure(target.model, target.providerId, target.providerName);
    }
  } else {
    for (const model of expectedModels) ensure(model);
  }

  for (const event of events) {
    if (!("model" in event)) continue;
    const model = ensure(event.model, event.providerId, event.providerName);
    if (event.kind === "candidate_started") continue;
    if (event.kind === "candidate_finished") {
      model.selectedTransport = event.selectedTransport;
      model.readiness = event.readiness;
      continue;
    }
    const branch = model.branches[event.transport];
    branch.touched = true;
    if (event.kind === "compatibility_retry") {
      branch.retries.push(event.rule);
      branch.adaptations.push({
        trigger: event.trigger,
        change: event.change,
        outcome: "trying",
      });
      branch.stages[event.stage] = "running";
    } else if (event.kind === "stage_started") {
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
      branch.stages.reasoning = reasoningStageStatus(
        event.reasoningSemantic,
        branch.stages.baseline,
      );
    } else if (event.kind === "branch_finished") {
      branch.readiness = event.readiness;
    }
  }

  for (const outcome of outcomes) {
    for (const record of outcome.records) {
      const model = ensure(
        record.target.public_model,
        scoped ? outcome.provider.id : null,
        scoped ? outcome.provider.name : null,
      );
      applyRecord(model, record);
    }
  }
  for (const record of storedRecords) {
    const model = ensure(record.target.public_model);
    applyRecord(model, record);
  }
  return [...models.values()];
}

function aggregateProbeUsage(
  outcomes: CodexProviderProtocolPreflightOutcome[],
) {
  const summaries = outcomes.flatMap((outcome) =>
    outcome.probeUsage ? [outcome.probeUsage] : [],
  );
  if (summaries.length === 0) return undefined;
  const estimatedCosts = summaries
    .flatMap((summary) =>
      summary.estimatedCostUsd === null
        ? []
        : [Number(summary.estimatedCostUsd)],
    )
    .filter(Number.isFinite);
  const estimatedCost = estimatedCosts.reduce((sum, cost) => sum + cost, 0);
  return {
    inputTokens: summaries.reduce(
      (sum, summary) => sum + summary.inputTokens,
      0,
    ),
    outputTokens: summaries.reduce(
      (sum, summary) => sum + summary.outputTokens,
      0,
    ),
    cacheReadTokens: summaries.reduce(
      (sum, summary) => sum + summary.cacheReadTokens,
      0,
    ),
    cacheCreationTokens: summaries.reduce(
      (sum, summary) => sum + summary.cacheCreationTokens,
      0,
    ),
    totalTokens: summaries.reduce(
      (sum, summary) => sum + summary.totalTokens,
      0,
    ),
    reportedResponses: summaries.reduce(
      (sum, summary) => sum + summary.reportedResponses,
      0,
    ),
    successfulResponses: summaries.reduce(
      (sum, summary) => sum + summary.successfulResponses,
      0,
    ),
    estimatedCostUsd:
      estimatedCosts.length > 0
        ? estimatedCost.toFixed(10).replace(/0+$/, "").replace(/\.$/, "")
        : null,
    pricedModels: [
      ...new Set(summaries.flatMap((summary) => summary.pricedModels)),
    ],
    unpricedModels: [
      ...new Set(summaries.flatMap((summary) => summary.unpricedModels)),
    ],
  };
}

function statusPresentation(t: TFunction, status: VisibleStageStatus) {
  if (status === "running") {
    return {
      label: t("codexProtocolProbe.checking", { defaultValue: "Checking" }),
      icon: Loader2,
      className: "text-sky-600 animate-spin",
    };
  }
  if (status === "passed") {
    return {
      label: t("codexProtocolProbe.passed", { defaultValue: "Passed" }),
      icon: CheckCircle2,
      className: "text-emerald-600",
    };
  }
  if (status === "failed") {
    return {
      label: t("codexProtocolProbe.failed", { defaultValue: "Failed" }),
      icon: XCircle,
      className: "text-destructive",
    };
  }
  if (status === "unsupported") {
    return {
      label: t("codexProtocolProbe.unsupported", {
        defaultValue: "Unsupported",
      }),
      icon: MinusCircle,
      className: "text-amber-600",
    };
  }
  if (status === "skipped") {
    return {
      label: t("codexProtocolProbe.skipped", { defaultValue: "Skipped" }),
      icon: MinusCircle,
      className: "text-muted-foreground",
    };
  }
  return {
    label: t("codexProtocolProbe.waiting", { defaultValue: "Waiting" }),
    icon: Circle,
    className: "text-muted-foreground/60",
  };
}

function reasoningLabel(
  t: TFunction,
  semantic: CodexReasoningSemantic | null,
  status: VisibleStageStatus,
) {
  if (semantic === "readable")
    return t("codexProtocolProbe.rawReasoning", {
      defaultValue: "Raw reasoning text",
    });
  if (semantic === "summary")
    return t("codexProtocolProbe.nativeSummary", {
      defaultValue: "Native upstream summary",
    });
  if (semantic === "opaque")
    return t("codexProtocolProbe.opaqueReasoning", {
      defaultValue: "Encrypted/opaque (not displayable by Codex)",
    });
  if (semantic === "none")
    return status === "skipped"
      ? t("codexProtocolProbe.notChecked", { defaultValue: "Not checked" })
      : t("codexProtocolProbe.notReturned", { defaultValue: "Not returned" });
  return t("codexProtocolProbe.unidentified", { defaultValue: "Unidentified" });
}

function failureLabel(t: TFunction, failure: CodexProtocolProbeFailure) {
  if (failure.kind === "http_status") {
    if (failure.status_code === 521)
      return t("codexProtocolProbe.http521", {
        defaultValue: "HTTP 521 · Upstream unreachable",
      });
    if (failure.status_code === 401)
      return t("codexProtocolProbe.http401", {
        defaultValue: "HTTP 401 · Authentication failed",
      });
    if (failure.status_code === 403)
      return t("codexProtocolProbe.http403", {
        defaultValue: "HTTP 403 · Current credentials are not authorized",
      });
    if (failure.status_code === 429)
      return t("codexProtocolProbe.http429", {
        defaultValue: "HTTP 429 · Rate limited or insufficient quota",
      });
    if ([404, 405, 415].includes(failure.status_code ?? 0)) {
      return t("codexProtocolProbe.httpEndpoint", {
        defaultValue: "HTTP {{arg0}} · Endpoint unsupported",
        arg0: failure.status_code,
      });
    }
    if ((failure.status_code ?? 0) >= 500) {
      return t("codexProtocolProbe.httpService", {
        defaultValue: "HTTP {{arg0}} · Upstream service error",
        arg0: failure.status_code,
      });
    }
    return failure.status_code
      ? t("codexProtocolProbe.httpRequest", {
          defaultValue: "HTTP {{arg0}} · Upstream request failed",
          arg0: failure.status_code,
        })
      : t("codexProtocolProbe.requestFailed", {
          defaultValue: "Upstream request failed",
        });
  }
  if (failure.kind === "timeout")
    return t("codexProtocolProbe.timeout", {
      defaultValue: "Request timed out",
    });
  if (failure.kind === "network")
    return t("codexProtocolProbe.network", {
      defaultValue: "Network connection failed",
    });
  if (failure.kind === "response_too_large")
    return t("codexProtocolProbe.responseLimit", {
      defaultValue: "Response exceeds probe limit",
    });
  if (failure.kind === "invalid_request")
    return t("codexProtocolProbe.invalidEndpoint", {
      defaultValue: "Invalid probe endpoint",
    });
  return t("codexProtocolProbe.invalidResponse", {
    defaultValue: "Invalid response format",
  });
}

function readinessLabel(
  t: TFunction,
  readiness: CodexProtocolProbeReadiness | null,
) {
  if (readiness === "verified")
    return t("codexProtocolProbe.verified", { defaultValue: "Verified" });
  if (readiness === "partial")
    return t("codexProtocolProbe.partial", { defaultValue: "Partial" });
  if (readiness === "unverified")
    return t("codexProtocolProbe.failed", { defaultValue: "Failed" });
  return t("codexProtocolProbe.pendingAssessment", {
    defaultValue: "Pending assessment",
  });
}

function transportLabel(transport: CodexProtocolTransport) {
  return transport === "open_ai_responses" ? "Responses" : "Chat Completions";
}

function toolSchemaLabel(
  t: TFunction,
  dialect: CodexToolSchemaDialect | null,
  evidence: CodexToolSchemaEvidence | null,
  status: VisibleStageStatus,
) {
  if (status !== "passed" || dialect === null)
    return t("codexProtocolProbe.unconfirmed", { defaultValue: "Unconfirmed" });
  if (dialect === "openai") return "OpenAI";
  if (evidence === "explicit_rejection") {
    return t("codexProtocolProbe.schemaExplicit", {
      defaultValue: "Moonshot MFJS (negotiated after explicit rejection)",
    });
  }
  if (evidence === "ambiguous_rejection") {
    return t("codexProtocolProbe.schemaAmbiguous", {
      defaultValue: "Moonshot MFJS (fully verified after ambiguous rejection)",
    });
  }
  if (evidence === "negotiated_tool_call") {
    return t("codexProtocolProbe.schemaBehavior", {
      defaultValue: "Moonshot MFJS (verified after behavioral negotiation)",
    });
  }
  return t("codexProtocolProbe.schemaUnknown", {
    defaultValue: "Moonshot MFJS (no source; not applied automatically)",
  });
}

function historyReplayLabel(
  t: TFunction,
  replay: CodexHistoryReplay | null,
  status: VisibleStageStatus,
) {
  if (status !== "passed" || replay === null)
    return t("codexProtocolProbe.unconfirmed", { defaultValue: "Unconfirmed" });
  if (replay === "chat_reasoning_content") return "reasoning_content";
  if (replay === "responses_reasoning_text_content") {
    return "reasoning_text content";
  }
  if (replay === "omit")
    return t("codexProtocolProbe.omitReplay", {
      defaultValue: "Do not replay reasoning items",
    });
  return "Native Responses";
}

function runtimeAdaptationLabel(
  t: TFunction,
  transport: CodexProtocolTransport,
  reasoningSource: CodexReasoningSource | null,
  historyReplay: CodexHistoryReplay | null,
) {
  if (transport === "open_ai_chat") {
    const source =
      reasoningSource && reasoningSource !== "none"
        ? reasoningSource
        : t("codexProtocolProbe.identifiedField", {
            defaultValue: "identified reasoning field",
          });
    return t("codexProtocolProbe.runtimeChat", {
      defaultValue:
        "Runtime adaptation: convert Codex Responses to Chat Completions; read reasoning from {{arg0}} and project it back to Codex.",
      arg0: source,
    });
  }
  if (historyReplay === "responses_reasoning_text_content") {
    return t("codexProtocolProbe.runtimeText", {
      defaultValue:
        "Runtime adaptation: keep Responses requests in the native protocol; rebuild continuation reasoning as reasoning_text content.",
    });
  }
  if (historyReplay === "omit") {
    return t("codexProtocolProbe.runtimeOmit", {
      defaultValue:
        "Runtime adaptation: keep Responses requests in the native protocol; remove only incompatible reasoning items during continuation while preserving tool calls and outputs.",
    });
  }
  return t("codexProtocolProbe.runtimeNative", {
    defaultValue:
      "Runtime adaptation: keep Responses requests in the native protocol and replay native upstream reasoning items unchanged.",
  });
}

function adaptationTriggerLabel(t: TFunction, trigger: CodexAdaptationTrigger) {
  if (trigger === "explicit_tool_schema_rejection") {
    return t("codexProtocolProbe.triggerSchema", {
      defaultValue: "Upstream explicitly rejected the OpenAI tool schema",
    });
  }
  if (trigger === "ambiguous_request_rejection") {
    return t("codexProtocolProbe.triggerAmbiguous", {
      defaultValue:
        "Upstream returned 400/422 without identifying an incompatible field",
    });
  }
  if (trigger === "missing_valid_tool_call") {
    return t("codexProtocolProbe.triggerMissing", {
      defaultValue:
        "The response completed but did not return a tool call matching the probe constraints",
    });
  }
  if (trigger === "reasoning_replay_rejection") {
    return t("codexProtocolProbe.triggerReplay", {
      defaultValue: "Upstream rejected the native Responses reasoning history",
    });
  }
  return t("codexProtocolProbe.triggerAdjusted", {
    defaultValue: "The adjusted reasoning history was still rejected upstream",
  });
}

function adaptationChangeLabel(t: TFunction, change: CodexAdaptationChange) {
  if (change === "tool_schema_moonshot_mfjs") {
    return t("codexProtocolProbe.changeSchema", {
      defaultValue:
        "Re-request after compiling the dynamic OpenAI tool schema into the compatible MFJS object shape",
    });
  }
  if (change === "replay_reasoning_text_content") {
    return t("codexProtocolProbe.changeText", {
      defaultValue:
        "Rewrite reasoning history as content[type=reasoning_text] and retry the continuation",
    });
  }
  return t("codexProtocolProbe.changeOmit", {
    defaultValue:
      "Retry the continuation after removing only incompatible reasoning history while preserving tool calls and outputs",
  });
}

function adaptationOutcomeLabel(
  t: TFunction,
  outcome: CodexAdaptationOutcome | "trying",
) {
  if (outcome === "trying")
    return t("codexProtocolProbe.negotiating", {
      defaultValue: "Negotiating and re-validating",
    });
  if (outcome === "verified")
    return t("codexProtocolProbe.retestPassed", {
      defaultValue: "Full re-test passed",
    });
  return t("codexProtocolProbe.retestFailed", {
    defaultValue: "Re-test failed; cannot apply automatically",
  });
}

function compatibilityIssueLabels(t: TFunction, branch: BranchProgress) {
  const issues: string[] = [];
  for (const stage of stages(t)) {
    const status = branch.stages[stage.id];
    if (
      status === "failed" ||
      status === "unsupported" ||
      status === "skipped"
    ) {
      issues.push(
        stage.id === "reasoning" && branch.reasoningSemantic === "none"
          ? t("codexProtocolProbe.reasoningMissing", {
              defaultValue: "Reasoning content: Not returned",
            })
          : t("codexProtocolProbe.stageIssue", {
              defaultValue: "{{arg0}}: {{arg1}}",
              arg0: stage.label,
              arg1: statusPresentation(t, status).label,
            }),
      );
    }
  }
  if (
    branch.reasoningSemantic === "none" &&
    !issues.includes(
      t("codexProtocolProbe.reasoningMissing", {
        defaultValue: "Reasoning content: Not returned",
      }),
    )
  ) {
    issues.push(
      t("codexProtocolProbe.reasoningMissing", {
        defaultValue: "Reasoning content: Not returned",
      }),
    );
  }
  return issues;
}

function runtimeMappingRows(
  t: TFunction,
  transport: CodexProtocolTransport,
  reasoningSemantic: CodexReasoningSemantic | null,
  reasoningSource: CodexReasoningSource | null,
  historyReplay: CodexHistoryReplay | null,
) {
  if (transport === "open_ai_chat") {
    const source = (() => {
      if (reasoningSource === "reasoning_content") {
        return "choices[].delta.reasoning_content";
      }
      if (reasoningSource === "reasoning") {
        return t("codexProtocolProbe.chatReasoningShape", {
          defaultValue:
            "choices[].delta.reasoning (string or content/text/summary)",
        });
      }
      if (reasoningSource === "reasoning_details") {
        return "choices[].delta.reasoning_details[]";
      }
      if (reasoningSource === "think_tags") {
        return t("codexProtocolProbe.thinkTags", {
          defaultValue: "<think>...</think> inside choices[].delta.content",
        });
      }
      return t("codexProtocolProbe.chatField", {
        defaultValue: "Detected Chat reasoning field",
      });
    })();
    const projection =
      reasoningSemantic === "readable"
        ? "response.reasoning_text.delta"
        : reasoningSemantic === "summary"
          ? "response.reasoning_summary_text.delta"
          : t("codexProtocolProbe.noEvents", {
              defaultValue: "No visible reasoning events generated",
            });
    return [
      "Codex instructions → Chat messages[role=system]",
      "Codex input[] → Chat messages[]",
      "function_call / custom_tool_call → assistant.tool_calls[]",
      "function_call_output → role=tool + tool_call_id",
      t("codexProtocolProbe.chatTools", {
        defaultValue:
          "tools[] → Chat tools[].function (compiled using the detected schema dialect)",
      }),
      `${source} → ${projection}`,
      "choices[].delta.content → response.output_text.delta",
      t("codexProtocolProbe.chatCalls", {
        defaultValue:
          "Chat tool_calls[] → Responses function/custom/tool_search call items",
      }),
      "prompt/completion usage → input/output usage",
    ];
  }

  const replay =
    historyReplay === "responses_reasoning_text_content"
      ? "reasoning.content / readable summary → content[type=reasoning_text]; summary=[]"
      : historyReplay === "omit"
        ? t("codexProtocolProbe.omitMapping", {
            defaultValue:
              "Incompatible reasoning item → remove (reasoning only)",
          })
        : t("codexProtocolProbe.nativeMapping", {
            defaultValue:
              "reasoning item → Replay using the native upstream structure",
          });
  return [
    t("codexProtocolProbe.requestMapping", {
      defaultValue:
        "Codex Responses request → Responses upstream (protocol unchanged)",
    }),
    "system / developer message → top-level instructions",
    replay,
    t("codexProtocolProbe.toolMapping", {
      defaultValue:
        "tools[].parameters → compiled using the detected schema dialect",
    }),
    t("codexProtocolProbe.nativeTools", {
      defaultValue:
        "Tool calls and outputs keep the native Responses structure",
    }),
    t("codexProtocolProbe.normalizedEvents", {
      defaultValue:
        "SSE, reasoning events, and usage → normalized before returning to Codex",
    }),
  ];
}

export function CodexProtocolProbeProgressDialog({
  open,
  running,
  actionRequired = false,
  expectedModels = [],
  expectedTargets = [],
  events,
  outcome,
  outcomes = [],
  storedRecords = [],
  manualSelections,
  error,
  onOpenChange,
  onRetry,
  onSelectTransport,
}: CodexProtocolProbeProgressDialogProps) {
  const { t } = useTranslation();
  const [expandedMappings, setExpandedMappings] = useState<Set<string>>(
    () => new Set(),
  );
  const resolvedOutcomes = useMemo(
    () => (outcomes.length > 0 ? outcomes : outcome ? [outcome] : []),
    [outcome, outcomes],
  );
  const models = useMemo(
    () =>
      buildProgress(
        expectedModels,
        expectedTargets,
        events,
        resolvedOutcomes,
        // Saved evidence is a historical view, never the result of a new run.
        // Keep failed/incomplete retries visible instead of falling back to Verified.
        running || events.length > 0 || resolvedOutcomes.length > 0 || error
          ? []
          : storedRecords,
      ),
    [
      expectedModels,
      expectedTargets,
      events,
      resolvedOutcomes,
      storedRecords,
      running,
      error,
    ],
  );
  const completedModels = models.filter((model) => model.readiness !== null);
  const completed = completedModels.length;
  const modelSummary = {
    total: completed,
    verified: completedModels.filter((model) => model.readiness === "verified")
      .length,
    partial: completedModels.filter((model) => model.readiness === "partial")
      .length,
    failed: completedModels.filter((model) => model.readiness === "unverified")
      .length,
  };
  // Batch Protocol Lab forwards one batch_finished event per Provider. The
  // dialog owns the cross-Provider view, so its title must aggregate every
  // batch instead of treating the last Provider as the entire operation.
  const batchSummaries = events.filter(
    (event) => event.kind === "batch_finished",
  );
  const batchSummary = batchSummaries.reduce(
    (summary, batch) => ({
      total: summary.total + batch.total,
      verified: summary.verified + batch.verified,
      partial: summary.partial + batch.partial,
      failed: summary.failed + batch.failed,
    }),
    { total: 0, verified: 0, partial: 0, failed: 0 },
  );
  const completionSummary =
    batchSummaries.length > 0 ? batchSummary : modelSummary;
  const missingResultCount = models.filter(
    (model) => model.readiness === null,
  ).length;
  const hasMissingResults =
    !running &&
    !actionRequired &&
    missingResultCount > 0 &&
    (Boolean(error) ||
      batchSummaries.length > 0 ||
      resolvedOutcomes.length > 0);
  const probeUsage = useMemo(
    () => aggregateProbeUsage(resolvedOutcomes),
    [resolvedOutcomes],
  );
  const unreportedResponses = probeUsage
    ? Math.max(0, probeUsage.successfulResponses - probeUsage.reportedResponses)
    : 0;

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
            {t("codexProtocolProbe.title", {
              defaultValue: "Codex deep compatibility probe",
            })}
          </DialogTitle>
          <DialogDescription>
            {running
              ? t("codexProtocolProbe.validating", {
                  defaultValue:
                    "Validating models {{arg0}}/{{arg1}}; Responses and Chat run with limited concurrency, and tool continuations are checked sequentially.",
                  arg0: completed,
                  arg1: models.length || "…",
                })
              : actionRequired
                ? completed > 0
                  ? t("codexProtocolProbe.notApplied", {
                      defaultValue:
                        "Probe completed for {{arg0}} models; configuration was not applied.",
                      arg0: completed,
                    })
                  : t("codexProtocolProbe.notRun", {
                      defaultValue:
                        "No new probe was run; configuration was not applied.",
                    })
                : hasMissingResults
                  ? t("codexProtocolProbe.incomplete", {
                      defaultValue:
                        "Probe incomplete: {{arg0}} models have no result.",
                      arg0: missingResultCount,
                    })
                  : batchSummaries.length > 0 || completed > 0
                    ? t("codexProtocolProbe.completed", {
                        defaultValue:
                          "Completed {{arg0}} models: Verified {{arg1}}, Partial {{arg2}}, Failed {{arg3}}.",
                        arg0: completionSummary.total,
                        arg1: completionSummary.verified,
                        arg2: completionSummary.partial,
                        arg3: completionSummary.failed,
                      })
                    : t("codexProtocolProbe.finished", {
                        defaultValue: "Probe finished.",
                      })}
          </DialogDescription>
        </DialogHeader>

        <div
          className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1"
          role="status"
          aria-live="polite"
        >
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
            {t("codexProtocolProbe.chargeWarning", {
              defaultValue:
                "The deep probe sends multiple real requests to each model’s Responses and Chat endpoints. This consumes tokens and may incur charges. After a successful probe, CCSM applies the selected protocol’s request, reasoning, tool, and continuation mappings at runtime.",
            })}
          </div>
          {!running && resolvedOutcomes.length > 0 && (
            <div className="rounded-md border border-border-default bg-muted/20 p-3 text-sm">
              {probeUsage && probeUsage.reportedResponses > 0 ? (
                <div className="space-y-1">
                  <p className="font-medium text-foreground">
                    {t("codexProtocolProbe.reportedUsage", {
                      defaultValue:
                        "The upstream reported {{total}} tokens (input {{input}}, output {{output}})",
                      total: probeUsage.totalTokens.toLocaleString(),
                      input: probeUsage.inputTokens.toLocaleString(),
                      output: probeUsage.outputTokens.toLocaleString(),
                    })}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {probeUsage.estimatedCostUsd
                      ? t("codexProtocolProbe.estimate", {
                          defaultValue:
                            "Estimated cost is about US${{arg0}} using current model pricing and the provider multiplier.",
                          arg0: probeUsage.estimatedCostUsd,
                        })
                      : t("codexProtocolProbe.noPricing", {
                          defaultValue:
                            "No pricing is available for the current models, so cost cannot be estimated yet.",
                        })}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t("codexProtocolProbe.usageEvidence", {
                      defaultValue:
                        "Reported numeric usage is saved with this Responses/Chat dual-protocol evidence for later review; response bodies are not saved.",
                    })}
                  </p>
                  {unreportedResponses > 0 && (
                    <p className="text-xs text-amber-700 dark:text-amber-300">
                      {t("codexProtocolProbe.unreportedUsage", {
                        defaultValue:
                          "{{total}} successful responses returned no usage; the token and cost figures above cover only reported usage and actual consumption may be higher.",
                        total: unreportedResponses,
                      })}
                    </p>
                  )}
                  {probeUsage.unpricedModels.length > 0 && (
                    <p className="text-xs text-amber-700 dark:text-amber-300">
                      {t("codexProtocolProbe.unpricedModels", {
                        defaultValue:
                          "No pricing found: {{models}}; these models are excluded from the cost estimate.",
                        models: probeUsage.unpricedModels.join(", "),
                      })}
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-xs text-amber-700 dark:text-amber-300">
                  {t("codexProtocolProbe.noUsage", {
                    defaultValue:
                      "The upstream returned no usage, so token and cost totals are unreliable; the real requests may still have been billed.",
                  })}
                </p>
              )}
            </div>
          )}
          {actionRequired ? (
            <div
              className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200"
              role="alert"
            >
              {t("codexProtocolProbe.manualRequired", {
                defaultValue:
                  "Manual protocol mode is active, but neither Responses nor Chat Completions is selected. Close to skip this application, or choose a protocol and save without probing again.",
              })}
            </div>
          ) : error ? (
            <div
              className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
              role="alert"
            >
              {t("codexProtocolProbe.interrupted", {
                defaultValue: "Probe interrupted: {{error}}",
                error,
              })}
            </div>
          ) : null}
          {models.length === 0 && !error && (
            <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
              {t("codexProtocolProbe.preparing", {
                defaultValue: "Preparing models and probe requests…",
              })}
            </div>
          )}
          {models.map((model) => (
            <article
              key={model.key}
              aria-label={t("codexProtocolProbe.modelProgress", {
                defaultValue: "{{arg0}}{{arg1}} probe progress",
                arg0: model.providerName ? `${model.providerName} · ` : "",
                arg1: model.model,
              })}
              className="space-y-3 rounded-lg border border-border-default bg-muted/10 p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="font-medium text-foreground">{model.model}</h3>
                  {model.providerName && (
                    <p className="text-xs text-muted-foreground">
                      {model.providerName}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2 text-xs">
                  {selectedTransportFor(model, manualSelections) && (
                    <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-sky-700 dark:text-sky-300">
                      {t("codexProtocolProbe.selectedTransport", {
                        defaultValue: "Selected {{transport}}",
                        transport: transportLabel(
                          selectedTransportFor(model, manualSelections)!,
                        ),
                      })}
                    </span>
                  )}
                  <span className="rounded-full border px-2 py-0.5 text-muted-foreground">
                    {readinessLabel(t, model.readiness)}
                  </span>
                </div>
              </div>

              <div className="grid gap-3 lg:grid-cols-2">
                {TRANSPORTS.map((transport) => {
                  const branch = model.branches[transport];
                  const mappingKey = `${model.key}\u0000${transport}`;
                  const mappingExpanded = expandedMappings.has(mappingKey);
                  const displaySelected = selectedTransportFor(
                    model,
                    manualSelections,
                  );
                  return (
                    <section
                      key={transport}
                      className="rounded-md border bg-background/70 p-3"
                    >
                      <div className="mb-3 flex items-center justify-between gap-2">
                        <h4 className="text-sm font-medium">
                          {transportLabel(transport)}
                        </h4>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground">
                            {readinessLabel(t, branch.readiness)}
                          </span>
                          {!running &&
                            branch.readiness !== null &&
                            onSelectTransport && (
                              <Button
                                type="button"
                                variant={
                                  displaySelected === transport
                                    ? "secondary"
                                    : "outline"
                                }
                                size="sm"
                                className="h-7 px-2 text-xs"
                                aria-pressed={displaySelected === transport}
                                aria-label={t(
                                  "codexProtocolProbe.selectModelTransport",
                                  {
                                    defaultValue: "{{arg0}} {{arg1}} {{arg2}}",
                                    arg0: model.model,
                                    arg1:
                                      branch.readiness === "verified"
                                        ? t("codexProtocolProbe.select", {
                                            defaultValue: "Select",
                                          })
                                        : t("codexProtocolProbe.useAnyway", {
                                            defaultValue: "Use anyway",
                                          }),
                                    arg2: transportLabel(transport),
                                  },
                                )}
                                onClick={() =>
                                  onSelectTransport({
                                    model: model.model,
                                    providerId: model.providerId,
                                    transport,
                                    readiness: branch.readiness!,
                                  })
                                }
                              >
                                {displaySelected === transport
                                  ? t("codexProtocolProbe.selected", {
                                      defaultValue: "Selected",
                                    })
                                  : branch.readiness === "verified"
                                    ? t("codexProtocolProbe.selectTransport", {
                                        defaultValue: "Select {{arg0}}",
                                        arg0: transportLabel(transport),
                                      })
                                    : t("codexProtocolProbe.useTransport", {
                                        defaultValue: "Use anyway {{arg0}}",
                                        arg0: transportLabel(transport),
                                      })}
                              </Button>
                            )}
                        </div>
                      </div>
                      {!branch.touched ? (
                        <p className="text-xs text-muted-foreground">
                          {hasMissingResults && model.readiness === null
                            ? t("codexProtocolProbe.noResult", {
                                defaultValue: "No probe result returned",
                              })
                            : t("codexProtocolProbe.waitingStart", {
                                defaultValue: "Waiting to start",
                              })}
                        </p>
                      ) : (
                        <div className="space-y-2">
                          <CodexCompatibilitySummary
                            {...branch}
                            transport={transport}
                            baselinePassed={branch.stages.baseline === "passed"}
                            running={running}
                            selected={displaySelected === transport}
                          />
                          {stages(t).map((stage) => {
                            const status = statusPresentation(
                              t,
                              branch.stages[stage.id],
                            );
                            const Icon = status.icon;
                            return (
                              <div
                                key={stage.id}
                                className="flex items-center justify-between gap-3 text-sm"
                              >
                                <span>{stage.label}</span>
                                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                  {stage.id === "reasoning" && (
                                    <span>
                                      {reasoningLabel(
                                        t,
                                        branch.reasoningSemantic,
                                        branch.stages.reasoning,
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
                          <div className="space-y-1.5 rounded-md border border-border-default bg-muted/20 p-2 text-xs">
                            <p className="font-medium text-foreground">
                              {t("codexProtocolProbe.structureTitle", {
                                defaultValue: "Upstream response structure",
                              })}
                            </p>
                            <p className="text-muted-foreground">
                              {branch.readiness === "verified"
                                ? t("codexProtocolProbe.structureVerified", {
                                    defaultValue:
                                      "Normal responses, terminal SSE events, tool calls, and tool-result continuations were parsed and verified by the backend.",
                                  })
                                : branch.readiness === "partial"
                                  ? t("codexProtocolProbe.structurePartial", {
                                      defaultValue:
                                        "The response is reachable, but a structure or continuation stage failed; this is not a complete Codex compatibility result.",
                                    })
                                  : branch.readiness === "unverified"
                                    ? t("codexProtocolProbe.structureFailed", {
                                        defaultValue:
                                          "The baseline response structure failed validation and cannot be used for automatic Codex configuration.",
                                      })
                                    : t(
                                        "codexProtocolProbe.structureChecking",
                                        {
                                          defaultValue:
                                            "Checking response fields, terminal SSE events, and tool-call structure.",
                                        },
                                      )}
                            </p>
                            <p className="text-muted-foreground">
                              {t("codexProtocolProbe.reasoningStructure", {
                                defaultValue: "Reasoning structure:",
                              })}
                              {reasoningLabel(
                                t,
                                branch.reasoningSemantic,
                                branch.stages.reasoning,
                              )}
                            </p>
                          </div>
                          {branch.adaptations.length > 0 && (
                            <div className="space-y-2 rounded-md border border-sky-500/30 bg-sky-500/5 p-2 text-xs">
                              <p className="font-medium text-foreground">
                                {t("codexProtocolProbe.adaptationTitle", {
                                  defaultValue: "CCSM protocol adaptation",
                                })}
                              </p>
                              {branch.adaptations.map((adaptation, index) => (
                                <div
                                  key={`${adaptation.trigger}:${adaptation.change}:${index}`}
                                  className="space-y-0.5 border-l-2 border-sky-500/30 pl-2"
                                >
                                  <p className="text-muted-foreground">
                                    {t("codexProtocolProbe.detection", {
                                      defaultValue: "Detection:",
                                    })}
                                    {adaptationTriggerLabel(
                                      t,
                                      adaptation.trigger,
                                    )}
                                  </p>
                                  <p className="text-foreground/80">
                                    {t("codexProtocolProbe.adjustment", {
                                      defaultValue: "Adjustment:",
                                    })}
                                    {adaptationChangeLabel(
                                      t,
                                      adaptation.change,
                                    )}
                                  </p>
                                  <p
                                    className={cn(
                                      adaptation.outcome === "verified"
                                        ? "text-emerald-700 dark:text-emerald-300"
                                        : adaptation.outcome === "trying"
                                          ? "text-sky-700 dark:text-sky-300"
                                          : "text-destructive",
                                    )}
                                  >
                                    {t("codexProtocolProbe.result", {
                                      defaultValue: "Result:",
                                    })}
                                    {adaptationOutcomeLabel(
                                      t,
                                      adaptation.outcome,
                                    )}
                                  </p>
                                </div>
                              ))}
                            </div>
                          )}
                          {branch.readiness === "verified" && (
                            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-2 text-xs text-emerald-800 dark:text-emerald-200">
                              {t("codexProtocolProbe.backendPassed", {
                                defaultValue:
                                  "Backend verification passed: CCSM can apply this protocol branch to Codex; it takes effect after saving and enabling the provider.",
                              })}
                            </div>
                          )}
                          {branch.readiness !== null &&
                            branch.readiness !== "verified" && (
                              <div className="space-y-1 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-900 dark:text-amber-200">
                                <p className="font-medium">
                                  {t("codexProtocolProbe.manualAllowed", {
                                    defaultValue:
                                      "Automatic adaptation did not fully pass, but manual use is allowed",
                                  })}
                                </p>
                                <ul className="space-y-0.5">
                                  {compatibilityIssueLabels(t, branch).map(
                                    (issue) => (
                                      <li key={issue}>{issue}</li>
                                    ),
                                  )}
                                </ul>
                                <p>
                                  {t("codexProtocolProbe.manualGaps", {
                                    defaultValue:
                                      "Manual selection accepts these capability gaps; this branch is not marked Verified.",
                                  })}
                                </p>
                              </div>
                            )}
                          <div className="space-y-1 border-t pt-2 text-xs text-muted-foreground">
                            <p>
                              {t("codexProtocolProbe.schemaLabel", {
                                defaultValue: "Tool schema:",
                              })}
                              {toolSchemaLabel(
                                t,
                                branch.toolSchemaDialect,
                                branch.toolSchemaEvidence,
                                branch.stages.forced_tool,
                              )}
                            </p>
                            <p>
                              {t("codexProtocolProbe.historyLabel", {
                                defaultValue: "History continuation:",
                              })}
                              {historyReplayLabel(
                                t,
                                branch.historyReplay,
                                branch.stages.continuation,
                              )}
                            </p>
                            <p className="pt-1 text-foreground/80">
                              {runtimeAdaptationLabel(
                                t,
                                transport,
                                branch.reasoningSource,
                                branch.historyReplay,
                              )}
                            </p>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-auto w-full justify-between px-0 py-1 text-xs font-medium text-foreground/80 hover:bg-transparent"
                              aria-expanded={mappingExpanded}
                              onClick={() =>
                                setExpandedMappings((current) => {
                                  const next = new Set(current);
                                  if (next.has(mappingKey)) {
                                    next.delete(mappingKey);
                                  } else {
                                    next.add(mappingKey);
                                  }
                                  return next;
                                })
                              }
                            >
                              {t("codexProtocolProbe.viewMappings", {
                                defaultValue:
                                  "View field mappings and runtime behavior",
                              })}
                              <ChevronDown
                                className={cn(
                                  "h-3.5 w-3.5 transition-transform",
                                  mappingExpanded && "rotate-180",
                                )}
                                aria-hidden
                              />
                            </Button>
                            {mappingExpanded && (
                              <div className="space-y-2 rounded-md border border-border-default bg-muted/20 p-2 text-[11px] leading-5">
                                <p className="font-medium text-foreground">
                                  {t("codexProtocolProbe.mappingTitle", {
                                    defaultValue: "Runtime field mappings",
                                  })}
                                </p>
                                <ul className="space-y-0.5 font-mono text-muted-foreground">
                                  {runtimeMappingRows(
                                    t,
                                    transport,
                                    branch.reasoningSemantic,
                                    branch.reasoningSource,
                                    branch.historyReplay,
                                  ).map((row) => (
                                    <li key={row}>{row}</li>
                                  ))}
                                </ul>
                                <p className="border-t pt-2 font-sans text-muted-foreground">
                                  {t("codexProtocolProbe.mappingSaved", {
                                    defaultValue:
                                      "After saving and enabling the provider, mappings are applied automatically to each request; running a probe alone does not rewrite the current configuration.",
                                  })}
                                </p>
                              </div>
                            )}
                          </div>
                          {branch.failures.length > 0 && (
                            <div className="space-y-1 border-t pt-2 text-xs text-destructive">
                              {branch.failures.map((failure) => (
                                <p
                                  key={`${failure.stage}:${failure.kind}:${failure.status_code ?? ""}`}
                                >
                                  {failureLabel(t, failure)}
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
          {!running && onRetry && (
            <Button type="button" variant="outline" onClick={onRetry}>
              {t("codexProtocolProbe.retry", { defaultValue: "Probe again" })}
            </Button>
          )}
          <Button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={running}
          >
            {running
              ? t("codexProtocolProbe.running", {
                  defaultValue: "Probe running",
                })
              : t("codexProtocolProbe.close", { defaultValue: "Close" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
