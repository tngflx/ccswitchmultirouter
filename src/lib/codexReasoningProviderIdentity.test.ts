import type { CodexModelReasoningCapability } from "@/types";
import { describe, expect, it } from "vitest";
import {
  codexReasoningProviderIdentity,
  isSublyxReasoningProvider,
  normalizeCodexReasoningCapabilityForProvider,
  resolveCodexCatalogUltraDisplay,
} from "./codexReasoningProviderIdentity";

const provider = (
  settingsConfig: Record<string, unknown>,
  name = "Gateway",
) => ({
  id: "gateway",
  name,
  settingsConfig,
});

const activeConfig = `model_provider = "openrouter"
[model_providers.openrouter]
name = "OpenRouter"
base_url = "https://openrouter.ai/api/v1"
[model_providers.sublyx]
name = "Sublyx"
base_url = "https://api.sublyx.com/v1"`;

describe("Codex reasoning provider identity", () => {
  it("recognizes only the selected TOML provider and ignores inactive tables", () => {
    const active = codexReasoningProviderIdentity(
      provider({ config: activeConfig }),
    );
    expect(isSublyxReasoningProvider("sublyx", active)).toBe(false);

    const sublyx = codexReasoningProviderIdentity(
      provider({
        config: activeConfig.replace(
          'model_provider = "openrouter"',
          'model_provider = "sublyx"',
        ),
      }),
    );
    expect(isSublyxReasoningProvider("user", sublyx)).toBe(true);

    const unrelated = codexReasoningProviderIdentity(
      provider({
        config: activeConfig.replace(
          'model_provider = "openrouter"',
          'model_provider = "missing"',
        ),
      }),
    );
    expect(isSublyxReasoningProvider("user", unrelated)).toBe(false);
  });

  it.each([
    ["vllm", "Gateway"],
    ["custom", "vLLM deployment"],
  ])(
    "uses recognized active TOML identity %s/%s before stale Sublyx display metadata",
    (key, name) => {
      const identity = codexReasoningProviderIdentity(
        provider(
          {
            config: `model_provider = "${key}"
[model_providers.${key}]
name = "${name}"
base_url = "https://gateway.example/v1"`,
          },
          "Sublyx stale display",
        ),
      );
      expect(identity.providerKind).toBe("vllm");
      expect(isSublyxReasoningProvider("sublyx", identity, "sublyx")).toBe(
        false,
      );
    },
  );

  it("preserves backend fallback labels for an unrecognized selected custom TOML identity", () => {
    const identity = codexReasoningProviderIdentity(
      provider(
        {
          config: `model_provider = "custom"
[model_providers.custom]
name = "Gateway"
base_url = "https://gateway.example/v1"`,
        },
        "Sublyx",
      ),
    );
    expect(isSublyxReasoningProvider("user", identity)).toBe(true);
  });

  it("uses active OpenRouter transport before stale Sublyx display identity and source", () => {
    const identity = codexReasoningProviderIdentity(
      provider({ config: activeConfig }, "Sublyx old"),
    );
    expect(isSublyxReasoningProvider("sublyx", identity)).toBe(false);
  });

  it("uses the actual top-level endpoint before a stale selected TOML endpoint", () => {
    const identity = codexReasoningProviderIdentity(
      provider(
        {
          base_url: "https://api.sublyx.com/v1",
          config: activeConfig,
        },
        "OpenRouter old",
      ),
    );
    expect(isSublyxReasoningProvider("user", identity)).toBe(true);
  });

  it("recognizes supported top-level URL/name spellings without consulting inactive tables", () => {
    expect(
      isSublyxReasoningProvider(
        "user",
        codexReasoningProviderIdentity(
          provider({
            baseURL: "https://api.sublyx.com/v1",
          }),
        ),
      ),
    ).toBe(true);
    expect(
      isSublyxReasoningProvider(
        "user",
        codexReasoningProviderIdentity(
          provider({
            provider_name: "Sublyx",
          }),
        ),
      ),
    ).toBe(true);
  });

  it("handles malformed TOML without letting it replace a valid endpoint", () => {
    expect(
      isSublyxReasoningProvider(
        "sublyx",
        codexReasoningProviderIdentity(
          provider({
            baseUrl: "https://openrouter.ai/api/v1",
            config: "model_provider = [invalid",
          }),
        ),
      ),
    ).toBe(false);
  });

  it("does not let stale Sublyx source override an explicit OpenRouter identity", () => {
    expect(
      isSublyxReasoningProvider("sublyx", {
        providerKind: "openrouter",
        providerKey: "sublyx",
      }),
    ).toBe(false);
  });
  it("uses the real endpoint over inconsistent explicit platform props", () => {
    expect(
      isSublyxReasoningProvider("sublyx", {
        providerKind: "sublyx",
        baseUrl: "https://openrouter.ai/api/v1",
      }),
    ).toBe(false);
  });

  it("never borrows a synthetic router wrapper identity when target markers are present", () => {
    const identity = codexReasoningProviderIdentity(
      provider(
        {
          codexResolvedTargetProviderId: "custom-target",
        },
        "Sublyx wrapper",
      ),
    );
    expect(isSublyxReasoningProvider("user", identity)).toBe(false);
  });

  it.each([
    { providerKind: "vllm" },
    { baseUrl: "https://gateway.example/v1", providerId: "generic-target" },
    { providerName: "Generic target" },
  ])(
    "does not reuse stale Sublyx metadata for an explicit other identity %j",
    (identity) => {
      expect(isSublyxReasoningProvider("sublyx", identity, "sublyx")).toBe(
        false,
      );
    },
  );

  it("rebuilds a supported graded Sublyx GPT native contract without native ultra or stale wire metadata", () => {
    const capability: CodexModelReasoningCapability = {
      supported: true,
      supportedEfforts: ["high", "max", "ultra"],
      defaultEffort: "ultra",
      disableAllowed: true,
      upstream: {
        format: "string",
        parameter: "reasoning_effort",
        effortMap: { high: "max", max: "max", ultra: "ultra" },
      },
      source: "user",
      confidence: "verified",
      fetchedAt: "2026-11-10T00:00:00Z",
      modelRevision: "gpt-revision",
      outputFormat: "reasoning_content",
      codexUltraOrchestration: { enabled: false, providerEffort: "ultra" },
    };
    const before = structuredClone(capability);
    expect(
      normalizeCodexReasoningCapabilityForProvider("gpt-6.1", capability, {
        baseUrl: "https://api.sublyx.com/v1",
      }),
    ).toEqual({
      schemaVersion: 2,
      supportStatus: "confirmed_supported",
      controlKind: "graded",
      supportedEfforts: ["low", "medium", "high", "xhigh"],
      defaultEffort: "xhigh",
      disableAllowed: false,
      upstream: {
        format: "reasoning_object",
        parameter: "reasoning.effort",
        effortMap: {
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
        },
      },
      source: "user",
      providerKey: "sublyx",
      confidence: "verified",
      fetchedAt: "2026-11-10T00:00:00Z",
      modelRevision: "gpt-revision",
      outputFormat: "reasoning_content",
      codexUltraOrchestration: { enabled: false, providerEffort: "xhigh" },
    });
    expect(capability).toEqual(before);
  });

  it.each([
    [undefined, "medium"],
    ["minimal", "medium"],
    ["high", "high"],
    ["max", "xhigh"],
  ] as const)(
    "normalizes Sublyx default %s and restores maintained Ultra",
    (defaultEffort, expected) => {
      const capability: CodexModelReasoningCapability = {
        supported: true,
        supportedEfforts: ["high"],
        defaultEffort,
        disableAllowed: true,
        upstream: { format: "string", parameter: "reasoning_effort" },
        source: "user",
      };
      const normalized = normalizeCodexReasoningCapabilityForProvider(
        "gpt-6.1",
        capability,
        {
          baseUrl: "https://api.sublyx.com/v1",
        },
      );
      expect(normalized.defaultEffort).toBe(expected);
      expect(normalized.codexUltraOrchestration).toEqual({
        enabled: true,
        providerEffort: "xhigh",
      });
    },
  );

  it("projects maintained Ultra without inventing an explicit persisted overlay", () => {
    const row = { model: "gpt-6.1" };
    expect(
      resolveCodexCatalogUltraDisplay(row, {
        codexUltraOrchestrationEnabled: true,
        effortMap: { ultra: "xhigh" },
      }),
    ).toEqual({ enabled: true, providerEffort: "xhigh" });
    expect(row).not.toHaveProperty("codexUltra");
  });

  it("keeps explicit Ultra disabled and reconciles a stale Sublyx overlay target", () => {
    expect(
      resolveCodexCatalogUltraDisplay(
        {
          model: "gpt-6.1",
          codexUltra: { enabled: false, providerEffort: "max" },
        },
        { codexUltraOrchestrationEnabled: true, effortMap: { ultra: "xhigh" } },
        {
          baseUrl: "https://api.sublyx.com/v1",
        },
      ),
    ).toEqual({ enabled: false, providerEffort: "xhigh" });
  });

  it.each([
    {
      supportStatus: "confirmed_unsupported" as const,
      controlKind: "none" as const,
    },
    { supportStatus: "unknown" as const, controlKind: "unknown" as const },
    {
      supportStatus: "confirmed_supported" as const,
      controlKind: "boolean" as const,
    },
  ])(
    "preserves explicit $supportStatus/$controlKind Sublyx declarations",
    (status) => {
      const capability: CodexModelReasoningCapability = {
        ...status,
        supportedEfforts: [],
        disableAllowed: false,
        upstream: { format: "none", parameter: "none", effortMap: {} },
        source: "user",
      };
      expect(
        normalizeCodexReasoningCapabilityForProvider("gpt-6.1", capability, {
          baseUrl: "https://api.sublyx.com/v1",
        }),
      ).toBe(capability);
    },
  );
});
