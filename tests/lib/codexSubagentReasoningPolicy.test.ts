import { describe, expect, it, vi } from "vitest";
import type {
  CodexSubagentReasoningCapability,
  CodexSubagentV2Profile,
} from "@/types/codexSubagentV2";
import {
  normalizeUnavailableFixedReasoningPolicies,
  normalizeUnavailableFixedReasoningPolicy,
} from "@/lib/codexSubagentReasoningPolicy";

const baseProfile = (
  reasoning: CodexSubagentV2Profile["reasoning"],
): CodexSubagentV2Profile => ({
  model: "xiaomi/mimo-v2.6-flash",
  enabled: true,
  questionnaire: {
    taskStrengths: ["repository_exploration"],
    optimization: "balanced",
    writeScope: "read_only",
    preference: "eligible",
  },
  reasoning,
  overrides: { roleName: "mimo-scout" },
});

const capability = (
  overrides: Partial<CodexSubagentReasoningCapability> = {},
): CodexSubagentReasoningCapability => ({
  supportKind: "boolean_only",
  source: "catalog",
  confidence: "confirmed",
  codexSelectableEfforts: [],
  providerAcceptedEfforts: ["none"],
  providerDefaultEffort: null,
  disableAllowed: true,
  effortMap: {},
  ...overrides,
});

describe("normalizeUnavailableFixedReasoningPolicy", () => {
  it("moves a stale fixed effort to delegated for boolean-only models without a provider default", () => {
    const profile = baseProfile({ policy: "fixed", effort: "medium" });
    const normalized = normalizeUnavailableFixedReasoningPolicy(
      profile,
      capability(),
    );

    expect(normalized).toEqual({
      ...profile,
      reasoning: { policy: "delegated" },
    });
    expect(profile.reasoning).toEqual({ policy: "fixed", effort: "medium" });
  });

  it("uses model_default when an empty selectable capability still declares a provider default", () => {
    const profile = baseProfile({ policy: "fixed", effort: "medium" });
    const normalized = normalizeUnavailableFixedReasoningPolicy(
      profile,
      capability({
        supportKind: "effort_levels",
        providerDefaultEffort: "high",
      }),
    );

    expect(normalized.reasoning).toEqual({ policy: "model_default" });
    expect(normalized.overrides).toEqual(profile.overrides);
  });

  it("does not rewrite a valid fixed graded profile", () => {
    const profile = baseProfile({ policy: "fixed", effort: "medium" });
    const normalized = normalizeUnavailableFixedReasoningPolicy(
      profile,
      capability({
        supportKind: "effort_levels",
        codexSelectableEfforts: ["low", "high"],
        providerDefaultEffort: "high",
      }),
    );

    expect(normalized).toBe(profile);
  });

  it("does not migrate while the capability remains unknown", () => {
    const profile = baseProfile({ policy: "fixed", effort: "medium" });
    const normalized = normalizeUnavailableFixedReasoningPolicy(
      profile,
      capability({ supportKind: "unknown" }),
    );

    expect(normalized).toBe(profile);
  });

  it.each([
    ["delegated", { policy: "delegated" }],
    ["model_default", { policy: "model_default" }],
    ["disabled", { policy: "disabled" }],
  ] as const)("leaves an existing %s policy untouched", (_label, reasoning) => {
    const profile = baseProfile(reasoning);
    expect(
      normalizeUnavailableFixedReasoningPolicy(profile, capability()),
    ).toBe(profile);
  });
});

describe("normalizeUnavailableFixedReasoningPolicies", () => {
  it("normalizes only profiles whose current model has a resolved empty capability", () => {
    const stale = baseProfile({ policy: "fixed", effort: "medium" });
    const valid = {
      ...baseProfile({ policy: "fixed", effort: "medium" }),
      model: "deepseek-v4-flash",
    };
    const config = {
      schemaVersion: 2 as const,
      selectionPolicy: "balanced" as const,
      profiles: { stale, valid },
    };

    const normalized = normalizeUnavailableFixedReasoningPolicies(
      config,
      (model) =>
        model === "xiaomi/mimo-v2.6-flash"
          ? capability()
          : capability({
              supportKind: "effort_levels",
              codexSelectableEfforts: ["low", "medium", "high"],
            }),
    );

    expect(normalized.profiles.stale.reasoning).toEqual({
      policy: "delegated",
    });
    expect(normalized.profiles.valid).toBe(valid);
    expect(config.profiles.stale.reasoning).toEqual({
      policy: "fixed",
      effort: "medium",
    });
  });

  it("leaves malformed entries untouched without resolving a missing model", () => {
    const invalid = { enabled: true };
    const config = {
      schemaVersion: 2 as const,
      selectionPolicy: "balanced" as const,
      profiles: {
        invalid: invalid as never,
      },
    };
    const resolve = vi.fn(() => capability());

    const normalized = normalizeUnavailableFixedReasoningPolicies(
      config,
      resolve,
    );

    expect(normalized).toBe(config);
    expect(normalized.profiles.invalid).toBe(invalid);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("leaves a malformed profiles container untouched", () => {
    const config = {
      schemaVersion: 2 as const,
      selectionPolicy: "balanced" as const,
      profiles: undefined as never,
    };

    expect(
      normalizeUnavailableFixedReasoningPolicies(config, () => capability()),
    ).toBe(config);
  });

  it("returns the same config when nothing needs migration", () => {
    const config = {
      schemaVersion: 2 as const,
      selectionPolicy: "balanced" as const,
      profiles: {
        stable: baseProfile({ policy: "fixed", effort: "medium" }),
      },
    };

    expect(
      normalizeUnavailableFixedReasoningPolicies(config, () =>
        capability({
          supportKind: "effort_levels",
          codexSelectableEfforts: ["low", "medium"],
        }),
      ),
    ).toBe(config);
  });
});
