import { Channel, invoke } from "@tauri-apps/api/core";

import type { Provider } from "@/types";

export type CodexProtocolTransport = "open_ai_responses" | "open_ai_chat";
export type CodexProtocolProbeStage =
  "baseline" | "streaming" | "reasoning" | "forced_tool" | "continuation";
export type CodexProtocolProbeStageStatus =
  "passed" | "unsupported" | "failed" | "skipped";
export type CodexProtocolProbeReadiness = "verified" | "partial" | "unverified";
export type CodexProtocolProbeMode = "light" | "deep";
export type CodexReasoningSemantic = "readable" | "summary" | "opaque" | "none";
export type CodexReasoningSource =
  | "reasoning_content"
  | "reasoning"
  | "reasoning_details"
  | "think_tags"
  | "native_responses"
  | "none";

export type CodexProtocolProbeFailureKind =
  | "http_status"
  | "tool_schema_rejected"
  | "reasoning_replay_rejected"
  | "timeout"
  | "network"
  | "response_too_large"
  | "invalid_response"
  | "invalid_request";

export type CodexProtocolProbeAdaptation = "tool_schema_safe_fallback";
export type CodexProtocolCompatibilityRule =
  "tool_schema" | "reasoning_text_replay" | "omit_reasoning";
export type CodexProtocolAdaptationTrigger =
  | "explicit_tool_schema_rejection"
  | "ambiguous_request_rejection"
  | "missing_valid_tool_call"
  | "reasoning_replay_rejection"
  | "adapted_replay_rejection";
export type CodexProtocolAdaptationChange =
  | "tool_schema_moonshot_mfjs"
  | "replay_reasoning_text_content"
  | "omit_incompatible_reasoning";
export type CodexProtocolToolSchemaDialect = "open_ai" | "moonshot_mfjs";
export type CodexProtocolToolSchemaEvidence =
  | "unspecified"
  | "explicit_rejection"
  | "ambiguous_rejection"
  | "negotiated_tool_call";
export type CodexProtocolHistoryReplay =
  | "chat_reasoning_content"
  | "responses_reasoning_text_content"
  | "omit"
  | "native_only";

export interface CodexProtocolProbeFailure {
  stage: CodexProtocolProbeStage;
  kind: CodexProtocolProbeFailureKind;
  status_code?: number;
}

export type CodexProtocolProbeProgressEvent =
  | {
      kind: "compatibility_retry";
      model: string;
      transport: CodexProtocolTransport;
      stage: CodexProtocolProbeStage;
      rule: CodexProtocolCompatibilityRule;
      trigger: CodexProtocolAdaptationTrigger;
      change: CodexProtocolAdaptationChange;
    }
  | { kind: "candidate_started"; model: string }
  | {
      kind: "stage_started";
      model: string;
      transport: CodexProtocolTransport;
      stage: CodexProtocolProbeStage;
    }
  | {
      kind: "stage_finished";
      model: string;
      transport: CodexProtocolTransport;
      stage: CodexProtocolProbeStage;
      stageStatus: CodexProtocolProbeStageStatus;
      failure?: CodexProtocolProbeFailure;
    }
  | {
      kind: "reasoning_classified";
      model: string;
      transport: CodexProtocolTransport;
      stage: "reasoning";
      reasoningSemantic: CodexReasoningSemantic;
      reasoningSource: CodexReasoningSource;
    }
  | {
      kind: "branch_finished";
      model: string;
      transport: CodexProtocolTransport;
      readiness: CodexProtocolProbeReadiness;
    }
  | {
      kind: "candidate_finished";
      model: string;
      selectedTransport: CodexProtocolTransport | null;
      readiness: CodexProtocolProbeReadiness;
    }
  | {
      kind: "batch_finished";
      total: number;
      verified: number;
      partial: number;
      failed: number;
    };

export interface CodexProtocolProbeBranch {
  assessment: {
    transport: CodexProtocolTransport;
    baseline: CodexProtocolProbeStageStatus;
    streaming: CodexProtocolProbeStageStatus;
    forced_tool: CodexProtocolProbeStageStatus;
    continuation: CodexProtocolProbeStageStatus;
  };
  reasoning_shape: {
    semantic: CodexReasoningSemantic;
    source: CodexReasoningSource;
    pre_tool_visible_content: "absent" | "present";
  };
  tool_schema_dialect?: CodexProtocolToolSchemaDialect;
  tool_schema_evidence?: CodexProtocolToolSchemaEvidence;
  history_replay?: CodexProtocolHistoryReplay;
  failures?: CodexProtocolProbeFailure[];
  adaptations?: CodexProtocolProbeAdaptation[];
}

export interface CodexProtocolCompatibilityRecord {
  probeVersion: number;
  target: {
    provider_id: string;
    route_id: string | null;
    public_model: string;
    upstream_model: string;
    transport: CodexProtocolTransport;
    endpoint_fingerprint: string;
    authentication_kind: string;
    credential_fingerprint: string;
  };
  result: {
    selected_transport: CodexProtocolTransport | null;
    readiness: CodexProtocolProbeReadiness;
    branches: CodexProtocolProbeBranch[];
  };
  testedAt: number;
  expiresAt: number;
}

export interface CodexProviderProtocolPreflightOutcome {
  provider: Provider;
  records: CodexProtocolCompatibilityRecord[];
  protocolApplied: boolean;
}

export async function preflightCodexProviderProtocolCompatibility(
  provider: Provider,
  probeId: string,
  mode: CodexProtocolProbeMode,
  onProgress: (event: CodexProtocolProbeProgressEvent) => void,
): Promise<CodexProviderProtocolPreflightOutcome> {
  const onEvent = new Channel<CodexProtocolProbeProgressEvent>();
  onEvent.onmessage = onProgress;
  return invoke<CodexProviderProtocolPreflightOutcome>(
    "preflight_codex_provider_protocol_compatibility",
    { provider, probeId, mode, onEvent },
  );
}

export async function cancelCodexProviderProtocolProbe(
  probeId: string,
): Promise<boolean> {
  return invoke<boolean>("cancel_codex_provider_protocol_probe", { probeId });
}
