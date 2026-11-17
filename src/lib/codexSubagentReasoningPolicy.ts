import type {
  CodexSubagentReasoningCapability,
  CodexSubagentV2Config,
  CodexSubagentV2Profile,
} from "@/types/codexSubagentV2";

/**
 * Fixed reasoning choices exposed by the Sub-Agent controls. Provider-native
 * catalogs and persisted schema still understand the full canonical effort
 * vocabulary; this product-level list intentionally keeps the Sub-Agent UI
 * to the two requested choices.
 */
export const SUBAGENT_FIXED_REASONING_EFFORTS = ["high", "max"] as const;

const EXPLICIT_REASONING_EFFORTS = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

function hasModelAndReasoningShape(
  value: unknown,
): value is Pick<CodexSubagentV2Profile, "model" | "reasoning"> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    model?: unknown;
    reasoning?: { policy?: unknown } | null;
  };
  return (
    typeof candidate.model === "string" &&
    typeof candidate.reasoning === "object" &&
    candidate.reasoning !== null &&
    typeof candidate.reasoning.policy === "string"
  );
}

/**
 * Replace a fixed effort that is no longer meaningful for the current model
 * capability. A graded capability with a narrower selectable list is kept
 * intact so users can review or deliberately repair an older saved choice.
 */
export function normalizeUnavailableFixedReasoningPolicy(
  profile: CodexSubagentV2Profile,
  capability?: CodexSubagentReasoningCapability,
): CodexSubagentV2Profile {
  if (profile.reasoning.policy !== "fixed" || !capability) return profile;
  if (capability.supportKind === "unknown") return profile;

  const selectableEfforts = capability.codexSelectableEfforts.filter((effort) =>
    EXPLICIT_REASONING_EFFORTS.has(effort),
  );
  if (selectableEfforts.length > 0) return profile;

  return {
    ...profile,
    reasoning:
      capability.supportKind === "effort_levels" &&
      capability.providerDefaultEffort !== undefined &&
      capability.providerDefaultEffort !== null
        ? { policy: "model_default" }
        : { policy: "delegated" },
  };
}

/**
 * Apply the model-capability migration to every valid profile in a config.
 * Unknown/malformed entries are left untouched for the existing diagnostics
 * and repair flows to handle.
 */
export function normalizeUnavailableFixedReasoningPolicies(
  config: CodexSubagentV2Config,
  capabilityForModel: (
    model: string,
  ) => CodexSubagentReasoningCapability | undefined,
): CodexSubagentV2Config {
  if (
    !config ||
    typeof config.profiles !== "object" ||
    config.profiles === null ||
    Array.isArray(config.profiles)
  ) {
    return config;
  }
  let changed = false;
  const profiles = Object.fromEntries(
    Object.entries(config.profiles).map(([profileKey, profile]) => {
      if (!hasModelAndReasoningShape(profile)) {
        return [profileKey, profile];
      }
      const normalized = normalizeUnavailableFixedReasoningPolicy(
        profile,
        capabilityForModel(profile.model),
      );
      if (normalized !== profile) changed = true;
      return [profileKey, normalized];
    }),
  ) as CodexSubagentV2Config["profiles"];
  return changed ? { ...config, profiles } : config;
}
