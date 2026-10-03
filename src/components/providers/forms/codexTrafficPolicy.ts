import type { CodexTrafficPolicy } from "@/types";

export type CodexTrafficPolicySource =
  | "recommended"
  | "safe_default"
  | "custom";

export interface ResolvedCodexTrafficPolicy
  extends Required<CodexTrafficPolicy> {
  source: CodexTrafficPolicySource;
}

export const CODEX_TRAFFIC_POLICY_LIMITS = {
  maxInFlight: { min: 1, max: 64 },
  maxQueueWaitMs: { min: 100, max: 300_000 },
  retries: { min: 0, max: 5 },
  delayMs: { min: 100, max: 60_000 },
} as const;

const SAFE_DEFAULT: Omit<ResolvedCodexTrafficPolicy, "source"> = {
  admissionEnabled: false,
  maxInFlight: 8,
  maxQueueWaitMs: 30_000,
  rateLimitMaxRetries: 5,
  rejectionRetryMode: "disabled",
  rejectionMaxRetries: 0,
  rejectionInitialDelayMs: 750,
  rejectionMaxDelayMs: 5000,
};

function clampNumber(value: number | undefined, fallback: number, min: number, max: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value as number)));
}

export function normalizeCodexTrafficPolicy(
  policy: CodexTrafficPolicy,
  fallback: Omit<ResolvedCodexTrafficPolicy, "source"> = SAFE_DEFAULT,
): Omit<ResolvedCodexTrafficPolicy, "source"> {
  const rejectionRetryMode = policy.rejectionRetryMode ?? fallback.rejectionRetryMode;
  return {
    admissionEnabled: policy.admissionEnabled ?? fallback.admissionEnabled,
    maxInFlight: clampNumber(policy.maxInFlight, fallback.maxInFlight, 1, 64),
    maxQueueWaitMs: clampNumber(policy.maxQueueWaitMs, fallback.maxQueueWaitMs, 100, 300_000),
    rateLimitMaxRetries: clampNumber(policy.rateLimitMaxRetries, fallback.rateLimitMaxRetries, 0, 5),
    rejectionRetryMode,
    rejectionMaxRetries: rejectionRetryMode === "disabled"
      ? 0
      : clampNumber(policy.rejectionMaxRetries, fallback.rejectionMaxRetries, 0, 5),
    rejectionInitialDelayMs: clampNumber(policy.rejectionInitialDelayMs, fallback.rejectionInitialDelayMs, 100, 60_000),
    rejectionMaxDelayMs: clampNumber(policy.rejectionMaxDelayMs, fallback.rejectionMaxDelayMs, 100, 60_000),
  };
}

export function isOpenCodeZenBaseUrl(baseUrl: string): boolean {
  return baseUrl.trim().toLowerCase().includes("opencode.ai/zen/go");
}

export function resolveCodexTrafficPolicy(
  baseUrl: string,
  policy?: CodexTrafficPolicy,
): ResolvedCodexTrafficPolicy {
  const recommended = isOpenCodeZenBaseUrl(baseUrl)
    ? { ...SAFE_DEFAULT, admissionEnabled: true, maxInFlight: 4,
        rejectionRetryMode: "opencode_endpoint_unavailable" as const,
        rejectionMaxRetries: 2 }
    : SAFE_DEFAULT;
  return {
    ...normalizeCodexTrafficPolicy(policy ?? {}, recommended),
    source: policy ? "custom" : isOpenCodeZenBaseUrl(baseUrl) ? "recommended" : "safe_default",
  };
}

export function customCodexTrafficPolicySeed(baseUrl: string): CodexTrafficPolicy {
  const { source: _source, ...policy } = resolveCodexTrafficPolicy(baseUrl);
  return policy;
}
