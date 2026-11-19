import type {
  CodexModelReasoningCapability,
  CodexReasoningEffort,
} from "@/types";
import { describe, expect, it } from "vitest";
import {
  codexReasoningProviderIdentity,
  isSublyxReasoningProvider,
  normalizeCodexReasoningCapabilityForProvider,
  normalizeCodexCatalogReasoningForProvider,
  readCodexProviderBaseUrl,
  resolveCodexCatalogUltraDisplay,
  usesSublyxGptReasoningContract,
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
base_url = "https://api.sublyx.org/v1"`;

const officialTransports = [
  ["openrouter", "https://openrouter.ai/api/v1"],
  ["openrouter", "https://edge.openrouter.ai/api/v1"],
  ["sublyx", "https://sublyx.org/v1"],
  ["sublyx", "https://api.sublyx.org/v1"],
  ["vllm", "http://vllm.local:8000/v1"],
  ["vllm", "http://vllm-roglinux:8000/v1"],
  ["deepseek", "https://api.deepseek.com/v1"],
  ["zhipu", "https://api.z.ai/api/paas/v4"],
  ["zhipu", "https://open.bigmodel.cn/api/paas/v4"],
  ["dashscope", "https://dashscope.aliyuncs.com/compatible-mode/v1"],
  ["dashscope", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"],
  ["dashscope", "https://tenant.maas.aliyuncs.com/compatible-mode/v1"],
] as const;

describe("Codex reasoning provider endpoint precedence", () => {
  it.each([
    [
      "root OpenAI endpoint without an active custom provider",
      {
        config:
          'openai_base_url = "https://openrouter.ai/api/v1"\nbase_url = "https://api.sublyx.org/v1"',
      },
      "https://openrouter.ai/api/v1",
      "openrouter",
    ],
    [
      "explicit OpenAI endpoint ahead of an OpenAI table",
      {
        config:
          'model_provider = "openai"\nopenai_base_url = "https://api.sublyx.org/v1"\n[model_providers.openai]\nbase_url = "https://openrouter.ai/api/v1"',
      },
      "https://api.sublyx.org/v1",
      "sublyx",
    ],
    [
      "active custom endpoint before root and inactive OpenAI endpoints",
      {
        config:
          'model_provider = " custom "\nopenai_base_url = "https://openrouter.ai/api/v1"\nbase_url = "https://openrouter.ai/api/v1"\n[model_providers.custom]\nbase_url = " "\nbaseURL = 42\nbaseUrl = "https://api.sublyx.org/v1"',
      },
      "https://api.sublyx.org/v1",
      "sublyx",
    ],
    [
      "root endpoint when selected custom table is missing",
      {
        config:
          'model_provider = "missing"\nbase_url = false\nbaseURL = " "\nbaseUrl = "https://openrouter.ai/api/v1"\n[model_providers.sublyx]\nbase_url = "https://api.sublyx.org/v1"',
      },
      "https://openrouter.ai/api/v1",
      "openrouter",
    ],
    [
      "root aliases when OpenAI and selected endpoint aliases are blank",
      {
        config:
          'model_provider = "openai"\nopenai_base_url = " "\nbaseURL = "https://api.sublyx.org/v1"\n[model_providers.openai]\nbase_url = " "',
      },
      "https://api.sublyx.org/v1",
      "sublyx",
    ],
    [
      "first nonblank settings endpoint over every TOML endpoint",
      {
        base_url: " ",
        baseURL: false,
        baseUrl: "https://api.sublyx.org/v1",
        config: 'openai_base_url = "https://openrouter.ai/api/v1"',
      },
      "https://api.sublyx.org/v1",
      "sublyx",
    ],
  ])("resolves %s", (_name, settings, endpoint, kind) => {
    expect(readCodexProviderBaseUrl(settings as Record<string, unknown>)).toBe(
      endpoint,
    );
    expect(
      codexReasoningProviderIdentity(
        provider(settings as Record<string, unknown>),
      ).providerKind,
    ).toBe(kind);
  });

  it("does not recover a TOML root endpoint from malformed config", () => {
    expect(
      readCodexProviderBaseUrl({
        config: 'base_url = "https://api.sublyx.org/v1"\n[unfinished',
      }),
    ).toBeUndefined();
  });
});

describe("Codex reasoning provider identity", () => {
  it.each(officialTransports)(
    "uses actual %s transport %s before stale selected, target, and display identity",
    (expected, baseUrl) => {
      const stale = expected === "sublyx" ? "openrouter" : "sublyx";
      const identity = codexReasoningProviderIdentity(
        provider(
          {
            base_url: baseUrl,
            config: `model_provider = "${stale}"
[model_providers.${stale}]
name = "${stale}"
base_url = "https://gateway.example/v1"`,
            codexResolvedTargetProviderId: stale,
            codexResolvedTargetProviderName: stale,
            providerName: stale,
          },
          stale,
        ),
      );
      expect(identity.providerKind).toBe(expected);
      expect(isSublyxReasoningProvider("sublyx", identity, "sublyx")).toBe(
        expected === "sublyx",
      );
      expect(
        isSublyxReasoningProvider(
          "sublyx",
          { baseUrl, providerKind: stale, providerKey: stale },
          "sublyx",
        ),
      ).toBe(expected === "sublyx");
    },
  );

  it.each(officialTransports)(
    "recognizes active selected %s transport %s before stale TOML and display labels",
    (expected, baseUrl) => {
      const stale = expected === "sublyx" ? "openrouter" : "sublyx";
      const identity = codexReasoningProviderIdentity(
        provider(
          {
            config: `model_provider = "${stale}"
[model_providers.${stale}]
name = "${stale}"
base_url = "${baseUrl}"`,
          },
          stale,
        ),
      );
      expect(identity.providerKind).toBe(expected);
      expect(isSublyxReasoningProvider("sublyx", identity, "sublyx")).toBe(
        expected === "sublyx",
      );
    },
  );

  it.each([
    "https://gateway.example/sublyx/v1",
    "https://gateway.example/v1?provider=sublyx",
    "https://sublyx@gateway.example/v1",
    "https://api.sublyx.org@gateway.example/v1",
    "https://api.sublyx.org.evil.example/v1",
    "https://not-sublyx.org/v1",
    "https://.sublyx.org/v1",
    "https://gateway.example/openrouter/v1",
    "https://gateway.example/v1?provider=openrouter",
    "https://openrouter.ai@gateway.example/v1",
    "https://openrouter.ai.evil.example/v1",
    "https://not-openrouter.ai/v1",
    "https://.openrouter.ai/v1",
    "https://gateway.example/vllm/v1",
    "https://notvllm.local/v1",
    "https://vllm-.local/v1",
    "https://api.deepseek.com.evil.example/v1",
    "https://api.z.ai.evil.example/v1",
    "https://open.bigmodel.cn.evil.example/v1",
    "https://dashscope.aliyuncs.com.evil.example/v1",
    "https://dashscope-intl.aliyuncs.com.evil.example/v1",
    "https://tenant.maas.aliyuncs.com.evil.example/v1",
    "https://maas.aliyuncs.com/v1",
    "https://.maas.aliyuncs.com/v1",
    "ftp://api.sublyx.org/v1",
    "ftp://openrouter.ai/api/v1",
    "file://api.z.ai/v1",
    "not a URL sublyx",
  ])(
    "never infers a platform from a spoofed or unsupported URL %s",
    (baseUrl) => {
      const identity = codexReasoningProviderIdentity(
        provider({ base_url: baseUrl }),
      );
      expect(identity.providerKind).toBe("unknown");
      expect(isSublyxReasoningProvider("sublyx", identity, "sublyx")).toBe(
        false,
      );
    },
  );

  it.each(officialTransports)(
    "normalizes host case and the terminal DNS dot for %s transport %s",
    (expected, baseUrl) => {
      const url = new URL(baseUrl);
      url.hostname = `${url.hostname.toUpperCase()}.`;
      const identity = codexReasoningProviderIdentity(
        provider({ base_url: url.href }),
      );
      expect(identity.providerKind).toBe(expected);
    },
  );

  it.each([
    ["openrouter", "OpenRouter proxy"],
    ["sublyx", "Sublyx custom deployment"],
    ["vllm", "vLLM deployment"],
  ])("preserves explicit %s custom-domain fallback %s", (expected, name) => {
    const identity = codexReasoningProviderIdentity(
      provider({ base_url: "https://gateway.example/v1" }, name),
    );
    expect(identity.providerKind).toBe(expected);
  });

  it("does not invent official Sublyx identity for a historical/custom .com endpoint", () => {
    const generic = codexReasoningProviderIdentity(
      provider({ base_url: "https://api.sublyx.com/v1" }),
    );
    expect(generic.providerKind).toBe("unknown");
    expect(isSublyxReasoningProvider("sublyx", generic, "sublyx")).toBe(false);
    const explicitlyNamed = codexReasoningProviderIdentity(
      provider({ base_url: "https://api.sublyx.com/v1" }, "Sublyx"),
    );
    expect(isSublyxReasoningProvider("user", explicitlyNamed)).toBe(true);
    expect(
      isSublyxReasoningProvider("user", {
        baseUrl: "https://api.sublyx.com/v1",
        providerKey: "sublyx",
      }),
    ).toBe(true);
  });

  it.each([
    {},
    { codexResolvedTargetProviderId: null },
    { codexResolvedTargetProviderId: "" },
    { codexResolvedTargetProviderName: "  " },
    {
      codexResolvedTargetProviderId: null,
      codexResolvedTargetProviderName: "",
    },
  ])(
    "blocks stale provenance for unknown authoritative context %j",
    (target) => {
      const hasTarget = Object.keys(target).length > 0;
      const identity = codexReasoningProviderIdentity(
        provider(target, hasTarget ? "Sublyx wrapper" : ""),
      );
      expect(identity.providerKind).toBe("unknown");
      expect(isSublyxReasoningProvider("sublyx", identity, "sublyx")).toBe(
        false,
      );
      if (hasTarget) {
        expect(identity.providerName).toBeUndefined();
        expect(identity.providerId).toBeUndefined();
      }
    },
  );

  it("does not identify an unknown gateway by model names, including provider-looking suffixes", () => {
    const identity = codexReasoningProviderIdentity(
      provider({ base_url: "https://gateway.example/v1" }),
    );
    expect(
      usesSublyxGptReasoningContract("gpt-6-sublyx", identity, {
        source: "sublyx",
        providerKey: "sublyx",
      }),
    ).toBe(false);
  });

  it.each(officialTransports.filter(([kind]) => kind !== "sublyx"))(
    "does not rewrite a %s capability as Sublyx from stale metadata at %s",
    (_, baseUrl) => {
      const capability: CodexModelReasoningCapability = {
        supported: true,
        supportedEfforts: ["high", "max"],
        defaultEffort: "max",
        disableAllowed: true,
        upstream: { format: "string", parameter: "reasoning_effort" },
        source: "sublyx",
        providerKey: "sublyx",
      };
      expect(
        normalizeCodexReasoningCapabilityForProvider(
          "gpt-6.1-sublyx",
          capability,
          { baseUrl, providerKind: "sublyx" },
        ),
      ).toBe(capability);
    },
  );

  it.each(["openrouter", "sublyx", "vllm"])(
    "uses active selected %s identity before projected target labels on custom transports",
    (expected) => {
      const identity = codexReasoningProviderIdentity(
        provider({
          base_url: "https://gateway.example/v1",
          config: `model_provider = "${expected}"
[model_providers.${expected}]
name = "Gateway"`,
          codexResolvedTargetProviderName:
            expected === "sublyx" ? "OpenRouter target" : "Sublyx target",
        }),
      );
      expect(identity.providerKind).toBe(expected);
    },
  );

  it.each([
    { codexResolvedTargetProviderId: "vllm-target" },
    { codexResolvedTargetProviderName: "vLLM deployment" },
    { providerName: "vLLM deployment" },
  ])(
    "preserves vLLM target/fallback identity on custom transports %j",
    (labels) => {
      const identity = codexReasoningProviderIdentity(
        provider({ base_url: "https://gateway.example/v1", ...labels }),
      );
      expect(identity.providerKind).toBe("vllm");
      expect(isSublyxReasoningProvider("sublyx", identity, "sublyx")).toBe(
        false,
      );
    },
  );

  it("uses the first nonblank supported label and endpoint alias", () => {
    const identity = codexReasoningProviderIdentity(
      provider({
        base_url: " ",
        baseURL: "https://gateway.example/v1",
        providerName: " ",
        provider_name: "vLLM deployment",
      }),
    );
    expect(identity.baseUrl).toBe("https://gateway.example/v1");
    expect(identity.providerKind).toBe("vllm");
    const selected = codexReasoningProviderIdentity(
      provider({
        config: `model_provider = "custom"
[model_providers.custom]
name = " "
provider_name = "vLLM deployment"
base_url = " "
baseURL = "https://gateway.example/v1"`,
      }),
    );
    expect(selected.baseUrl).toBe("https://gateway.example/v1");
    expect(selected.providerKind).toBe("vllm");
  });

  it("does not use a selected TOML key when its provider table is missing", () => {
    const identity = codexReasoningProviderIdentity(
      provider({ config: 'model_provider = "sublyx"' }),
    );
    expect(identity.providerKind).toBe("unknown");
    expect(isSublyxReasoningProvider("sublyx", identity, "sublyx")).toBe(false);
  });

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
          base_url: "https://api.sublyx.org/v1",
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
            baseURL: "https://api.sublyx.org/v1",
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

  it("repairs malformed explicit Sublyx native ultra metadata despite a max identity mapping", () => {
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
      normalizeCodexReasoningCapabilityForProvider("gpt-6.1-sol", capability, {
        baseUrl: "https://api.sublyx.org/v1",
      }),
    ).toEqual({
      schemaVersion: 2,
      supportStatus: "confirmed_supported",
      controlKind: "graded",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "max",
      disableAllowed: false,
      upstream: {
        format: "reasoning_object",
        parameter: "reasoning.effort",
        effortMap: {
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
          max: "max",
        },
      },
      source: "user",
      providerKey: "sublyx",
      confidence: "verified",
      fetchedAt: "2026-11-10T00:00:00Z",
      modelRevision: "gpt-revision",
      outputFormat: "reasoning_content",
      codexUltraOrchestration: { enabled: false, providerEffort: "max" },
    });
    expect(capability).toEqual(before);
  });

  it("defaults scoped Ultra to native Max when Max is available", () => {
    const capability: CodexModelReasoningCapability = {
      schemaVersion: 2,
      supportStatus: "confirmed_supported",
      controlKind: "graded",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "medium",
      disableAllowed: false,
      upstream: {
        format: "reasoning_object",
        parameter: "reasoning.effort",
        effortMap: {
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
          max: "max",
        },
      },
      source: "detection",
      confidence: "verified",
      providerKey: "sublyx",
      evidenceScope: {
        transportFingerprint: "a".repeat(64),
        model: "gpt-6.1-sol",
      },
    };
    const normalized = normalizeCodexReasoningCapabilityForProvider(
      "gpt-6.1-sol",
      capability,
      { baseUrl: "https://api.sublyx.org/v1" },
    );
    expect(normalized.supportedEfforts).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(normalized.defaultEffort).toBe("medium");
    expect(normalized.upstream.effortMap?.max).toBe("max");
    expect(normalized.codexUltraOrchestration).toEqual({
      enabled: true,
      providerEffort: "max",
    });
  });

  describe.each([
    ["gpt-6.1-sol", ["low", "medium", "high", "xhigh", "max"]],
    ["gpt-6.2-sol", ["low", "medium", "high", "xhigh", "max"]],
    ["gpt-6-future", ["low", "medium", "high", "xhigh"]],
  ] as const)("Sublyx native evidence for %s", (model, maintainedEfforts) => {
    const evidence = (
      patch: Partial<CodexModelReasoningCapability> = {},
    ): CodexModelReasoningCapability => ({
      schemaVersion: 2,
      supportStatus: "confirmed_supported",
      controlKind: "graded",
      supportedEfforts: ["low", "high", "max"],
      defaultEffort: "high",
      disableAllowed: false,
      upstream: {
        format: "reasoning_object",
        parameter: "reasoning.effort",
        effortMap: { low: "low", high: "high", max: "max" },
      },
      source: "detection",
      confidence: "verified",
      providerKey: "sublyx",
      evidenceScope: {
        transportFingerprint: "a".repeat(64),
        model,
      },
      ...patch,
    });
    const identity = { baseUrl: "https://api.sublyx.org/v1" };

    it.each([
      ["canonical verified detection", {}, true],
      ["provider source", { source: "provider" }, false],
      ["adopted user detection", { source: "user_confirmed_detection" }, true],
      ["manual source", { source: "user" }, true],
      ["authoritative confidence", { confidence: "authoritative" }, false],
      ["maintained confidence", { confidence: "maintained" }, false],
      ["inferred confidence", { confidence: "inferred" }, false],
      ["missing confidence", { confidence: undefined }, false],
      ["missing scope", { evidenceScope: undefined }, false],
      [
        "different wire model",
        {
          evidenceScope: {
            transportFingerprint: "a".repeat(64),
            model: "gpt-other",
          },
        },
        false,
      ],
      [
        "scope with extra whitespace",
        {
          evidenceScope: {
            transportFingerprint: "a".repeat(64),
            model: ` ${model} `,
          },
        },
        false,
      ],
      [
        "case-insensitive model scope",
        {
          evidenceScope: {
            transportFingerprint: "a".repeat(64),
            model: model.toUpperCase(),
          },
        },
        true,
      ],
      [
        "string effort wire contract",
        { upstream: { format: "string", parameter: "reasoning_effort" } },
        false,
      ],
      [
        "object alias is not the canonical Responses contract",
        { upstream: { format: "object", parameter: "reasoning.effort" } },
        false,
      ],
      [
        "wrong nested parameter",
        { upstream: { format: "reasoning_object", parameter: "reasoning" } },
        false,
      ],
      [
        "wire values normalized at the backend parser boundary",
        {
          upstream: {
            format: " REASONING_OBJECT ",
            parameter: " REASONING.EFFORT ",
          },
        },
        true,
      ],
    ] as Array<[string, Partial<CodexModelReasoningCapability>, boolean]>)(
      "preserves explicit manual overrides and validates automatic evidence for %s",
      (_name, patch, preserve) => {
        const capability = evidence(patch);
        const before = structuredClone(capability);
        const normalized = normalizeCodexReasoningCapabilityForProvider(
          model,
          capability,
          identity,
        );
        expect(normalized.supportedEfforts).toEqual(
          preserve ? ["low", "high", "max"] : maintainedEfforts,
        );
        expect(normalized.defaultEffort).toBe("high");
        expect(normalized.upstream.format).toBe("reasoning_object");
        expect(normalized.upstream.parameter).toBe("reasoning.effort");
        expect(capability).toEqual(before);
      },
    );

    it("retains native minimal/none, disable support, mappings and a valid explicit Ultra target", () => {
      const capability = evidence({
        supportedEfforts: ["none", "minimal", "low", "high", "max"],
        defaultEffort: "minimal",
        disableAllowed: true,
        upstream: {
          format: "reasoning_object",
          parameter: "reasoning.effort",
          effortMap: {
            minimal: "minimal",
            low: "high",
            high: "high",
            max: "max",
          },
        },
        codexUltraOrchestration: { enabled: true, providerEffort: "high" },
      });
      const normalized = normalizeCodexReasoningCapabilityForProvider(
        model,
        capability,
        identity,
      );
      expect(normalized).toEqual(capability);
      expect(normalized).not.toBe(capability);
      expect(normalized.upstream).not.toBe(capability.upstream);
    });

    it("migrates an automatic legacy Ultra xhigh target to native Max", () => {
      const normalized = normalizeCodexReasoningCapabilityForProvider(
        model,
        evidence({
          codexUltraOrchestration: { enabled: true, providerEffort: "xhigh" },
        }),
        identity,
      );
      expect(normalized.codexUltraOrchestration).toEqual({
        enabled: true,
        providerEffort: maintainedEfforts.includes("max") ? "max" : "xhigh",
      });
    });

    it("does not invent an unsupported Ultra target for verified low/high-only models", () => {
      const normalized = normalizeCodexReasoningCapabilityForProvider(
        model,
        evidence({
          supportedEfforts: ["low", "high"],
          upstream: {
            format: "reasoning_object",
            parameter: "reasoning.effort",
          },
        }),
        identity,
      );
      expect(normalized.supportedEfforts).toEqual(["low", "high"]);
      expect(normalized.defaultEffort).toBe("high");
      expect(normalized.upstream.effortMap).toEqual({
        low: "low",
        high: "high",
      });
      expect(normalized.codexUltraOrchestration?.enabled).not.toBe(true);
      expect(
        normalized.codexUltraOrchestration?.providerEffort,
      ).toBeUndefined();
    });

    it("does not rewrite a stale row overlay to an unsupported native xhigh", () => {
      const overlay = { enabled: true, providerEffort: "max" as const };
      const normalized = normalizeCodexCatalogReasoningForProvider(
        {
          model,
          reasoning: evidence({
            supportedEfforts: ["low", "high"],
            upstream: {
              format: "reasoning_object",
              parameter: "reasoning.effort",
            },
          }),
          codexUltra: overlay,
        },
        identity,
      );
      expect(normalized.reasoning?.supportedEfforts).toEqual(["low", "high"]);
      // Preserve the explicit row for backend validation instead of silently
      // replacing one invalid target with another invented native level.
      expect(normalized.codexUltra).toEqual(overlay);
    });

    it("does not invent a default absent from verified native evidence", () => {
      const normalized = normalizeCodexReasoningCapabilityForProvider(
        model,
        evidence({ defaultEffort: undefined }),
        identity,
      );
      expect(normalized.supportedEfforts).toEqual(["low", "high", "max"]);
      expect(normalized.defaultEffort).toBeUndefined();
    });

    it("preserves a legacy enabled Ultra mapping to a valid sparse native effort", () => {
      const normalized = normalizeCodexReasoningCapabilityForProvider(
        model,
        evidence({
          supportedEfforts: ["low", "high"],
          upstream: {
            format: "reasoning_object",
            parameter: "reasoning.effort",
            effortMap: { low: "low", high: "high", max: "high" },
          },
          codexUltraOrchestration: { enabled: true },
        }),
        identity,
      );
      expect(normalized.supportedEfforts).toEqual(["low", "high"]);
      expect(normalized.upstream.effortMap?.max).toBe("high");
      expect(normalized.codexUltraOrchestration).toEqual({ enabled: true });
    });

    it.each([
      ["unsupported default", { defaultEffort: "ultra" }],
      [
        "Codex-only native effort",
        { supportedEfforts: ["low", "high", "ultra"] },
      ],
      [
        "unadvertised map target",
        {
          upstream: {
            format: "reasoning_object",
            parameter: "reasoning.effort",
            effortMap: { low: "xhigh", high: "high", max: "max" },
          },
        },
      ],
      [
        "Codex-only map source",
        {
          upstream: {
            format: "reasoning_object",
            parameter: "reasoning.effort",
            effortMap: { low: "low", high: "high", max: "max", ultra: "max" },
          },
        },
      ],
    ] as Array<[string, Partial<CodexModelReasoningCapability>]>)(
      "does not preserve invalid verified metadata with %s",
      (_name, patch) => {
        const normalized = normalizeCodexReasoningCapabilityForProvider(
          model,
          evidence(patch),
          identity,
        );
        expect(normalized.supportedEfforts).toEqual(maintainedEfforts);
        expect(normalized.supportedEfforts).toContain(normalized.defaultEffort);
        expect(Object.keys(normalized.upstream.effortMap ?? {})).not.toContain(
          "ultra",
        );
      },
    );
  });

  it("reconciles the Ultra target from the normalized Sublyx capability", () => {
    const normalized = normalizeCodexCatalogReasoningForProvider(
      {
        model: "gpt-6.1-sol",
        reasoning: {
          schemaVersion: 2,
          supportStatus: "confirmed_supported",
          controlKind: "graded",
          supportedEfforts: ["low", "medium", "high", "xhigh"],
          defaultEffort: "high",
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
        },
        codexUltra: { enabled: true, providerEffort: "max" },
      },
      { baseUrl: "https://api.sublyx.org/v1" },
    );
    expect(normalized.reasoning?.supportedEfforts).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(normalized.codexUltra).toEqual({
      enabled: true,
      providerEffort: "xhigh",
    });
  });

  it.each([true, false])(
    "reconciles a legacy Sublyx catalog Ultra overlay when enabled=%s",
    (enabled) => {
      const normalized = normalizeCodexCatalogReasoningForProvider(
        {
          model: "gpt-6.1-sol",
          reasoning: {
            schemaVersion: 2,
            supportStatus: "confirmed_supported",
            controlKind: "graded",
            supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
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
                max: "max",
              },
            },
            source: "sublyx",
            codexUltraOrchestration: { enabled, providerEffort: "xhigh" },
          },
          codexUltra: { enabled, providerEffort: "xhigh" },
        },
        { baseUrl: "https://api.sublyx.org/v1" },
      );
      expect(normalized.reasoning?.upstream.effortMap?.max).toBe("max");
      expect(normalized.codexUltra).toEqual({
        enabled,
        providerEffort: enabled ? "max" : "xhigh",
      });
    },
  );

  it.each([
    [["low", "high", "max"], "max", "max"],
    [["low", "high", "max"], "high", "high"],
    [["low", "high"], "high", "high"],
  ] as const)(
    "keeps verified Sublyx native efforts %j and default %s for a model outside the maintained max list",
    (efforts, defaultEffort, expected) => {
      const capability: CodexModelReasoningCapability = {
        schemaVersion: 2,
        supportStatus: "confirmed_supported",
        controlKind: "graded",
        supportedEfforts: [...efforts],
        defaultEffort,
        disableAllowed: false,
        upstream: {
          format: "reasoning_object",
          parameter: "reasoning.effort",
          effortMap: Object.fromEntries(
            efforts.map((effort) => [effort, effort]),
          ),
        },
        source: "detection",
        confidence: "verified",
        providerKey: "sublyx",
        evidenceScope: {
          transportFingerprint: "a".repeat(64),
          model: "gpt-6-future",
        },
      };
      const before = structuredClone(capability);
      const normalized = normalizeCodexReasoningCapabilityForProvider(
        "gpt-6-future",
        capability,
        { baseUrl: "https://api.sublyx.org/v1" },
      );
      expect(normalized.supportedEfforts).toEqual(efforts);
      expect(normalized.defaultEffort).toBe(expected);
      expect(normalized.upstream.effortMap?.max).toBe(
        new Set<string>(efforts).has("max") ? "max" : undefined,
      );
      expect(capability).toEqual(before);
    },
  );

  it("does not generalize Sublyx native max to an unprobed GPT row", () => {
    const normalized = normalizeCodexReasoningCapabilityForProvider(
      "gpt-6-future",
      {
        supported: true,
        supportedEfforts: ["high"],
        defaultEffort: "max",
        disableAllowed: false,
        upstream: { format: "string", parameter: "reasoning_effort" },
        source: "user",
      },
      { baseUrl: "https://api.sublyx.org/v1" },
    );
    expect(normalized.supportedEfforts).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(normalized.defaultEffort).toBe("xhigh");
    expect(normalized.upstream.effortMap?.max).toBeUndefined();
  });

  it.each([
    [undefined, "medium"],
    ["minimal", "medium"],
    ["high", "high"],
    ["max", "max"],
  ] as const)(
    "normalizes Sublyx default %s and restores maintained Ultra",
    (defaultEffort, expected) => {
      const capability: CodexModelReasoningCapability = {
        supported: true,
        supportedEfforts: ["high"],
        defaultEffort,
        disableAllowed: true,
        upstream: { format: "string", parameter: "reasoning_effort" },
        source: "sublyx",
      };
      const normalized = normalizeCodexReasoningCapabilityForProvider(
        "gpt-6.1-sol",
        capability,
        {
          baseUrl: "https://api.sublyx.org/v1",
        },
      );
      expect(normalized.defaultEffort).toBe(expected);
      expect(normalized.codexUltraOrchestration).toEqual({
        enabled: true,
        providerEffort: "max",
      });
    },
  );

  it.each([undefined, "user", "user_confirmed_detection"] as const)(
    "preserves explicit %s Sublyx native Max overrides without adding Ultra",
    (source) => {
      const capability: CodexModelReasoningCapability = {
        schemaVersion: 2,
        supportStatus: "confirmed_supported",
        controlKind: "graded",
        supportedEfforts: ["low", "high", "max"],
        defaultEffort: "max",
        disableAllowed: false,
        upstream: {
          format: "reasoning_object",
          parameter: "reasoning.effort",
          effortMap: { low: "low", high: "high", max: "max" },
        },
        source,
        confidence: "verified",
        codexUltraOrchestration: { enabled: false, providerEffort: "max" },
      };
      const normalized = normalizeCodexReasoningCapabilityForProvider(
        "gpt-6.1-sol",
        capability,
        { baseUrl: "https://api.sublyx.org/v1" },
      );
      expect(normalized).toBe(capability);
      expect(normalized.supportedEfforts).toEqual(["low", "high", "max"]);
      expect(normalized.defaultEffort).toBe("max");
      expect(normalized.upstream.effortMap).toEqual({
        low: "low",
        high: "high",
        max: "max",
      });
      expect(normalized.codexUltraOrchestration).toEqual({
        enabled: false,
        providerEffort: "max",
      });
    },
  );

  it.each(["detection", "openrouter_api"] as const)(
    "does not treat unscoped automatic %s Max metadata as a manual override",
    (source) => {
      const capability = {
        schemaVersion: 2,
        supportStatus: "confirmed_supported",
        controlKind: "graded",
        supportedEfforts: ["low", "max"],
        defaultEffort: "max",
        disableAllowed: false,
        upstream: {
          format: "reasoning_object",
          parameter: "reasoning.effort",
          effortMap: { low: "low", max: "max" },
        },
        source,
        confidence: "verified",
      } as unknown as CodexModelReasoningCapability;
      // Imported legacy source names still need the same runtime guard; they
      // are not new writable members of the canonical source enum.
      const normalized = normalizeCodexReasoningCapabilityForProvider(
        "gpt-6.1-sol",
        capability,
        { baseUrl: "https://api.sublyx.org/v1" },
      );
      expect(normalized).not.toBe(capability);
      expect(normalized.supportedEfforts).toEqual([
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]);
      expect(normalized.codexUltraOrchestration).toEqual({
        enabled: true,
        providerEffort: "max",
      });
      expect(capability.supportedEfforts).toEqual(["low", "max"]);
    },
  );

  it.each([
    "gpt-5.6-sol",
    "gpt-5.6-luna",
    "gpt-5.6-terra",
    "gpt-6-sol",
    "gpt-6.2-sol",
    "gpt-6-astra",
    "gpt-6-luna",
    "gpt-6.1-sol",
    "gpt-6.1-terra",
  ])(
    "keeps native Max selectable for the maintained/audited row %s",
    (model) => {
      const normalized = normalizeCodexReasoningCapabilityForProvider(
        model,
        {
          supported: true,
          supportedEfforts: ["high"],
          disableAllowed: false,
          upstream: { format: "string", parameter: "reasoning_effort" },
          source: "provider",
        },
        { baseUrl: "https://api.sublyx.org/v1" },
      );
      expect(normalized.supportedEfforts).toEqual([
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]);
      expect(normalized.upstream.effortMap?.max).toBe("max");
      expect(normalized.codexUltraOrchestration).toEqual({
        enabled: true,
        providerEffort: "max",
      });
    },
  );

  it("does not let a manual Max shortcut retain contradictory legacy support state", () => {
    const capability: CodexModelReasoningCapability = {
      schemaVersion: 2,
      supportStatus: "confirmed_supported",
      supported: false,
      controlKind: "graded",
      supportedEfforts: ["low", "high", "max"],
      defaultEffort: "high",
      disableAllowed: false,
      upstream: {
        format: "reasoning_object",
        parameter: "reasoning.effort",
        effortMap: { low: "low", high: "high", max: "max" },
      },
      source: "user",
    };
    const normalized = normalizeCodexReasoningCapabilityForProvider(
      "gpt-6.1-sol",
      capability,
      { baseUrl: "https://api.sublyx.org/v1" },
    );
    expect(normalized).not.toBe(capability);
    expect(normalized).not.toHaveProperty("supported");
    expect(normalized.supportStatus).toBe("confirmed_supported");
    expect(normalized.supportedEfforts).toContain("max");
    expect(capability.supported).toBe(false);
  });

  it.each(["user", "provider"] as const)(
    "keeps a valid native Max default independent of an explicit Ultra High target for %s metadata",
    (source) => {
      const capability: CodexModelReasoningCapability = {
        schemaVersion: 2,
        supportStatus: "confirmed_supported",
        controlKind: "graded",
        supportedEfforts: ["low", "high", "max"],
        defaultEffort: "max",
        disableAllowed: false,
        upstream: {
          format: "reasoning_object",
          parameter: "reasoning.effort",
          effortMap: { low: "low", high: "high", max: "max" },
        },
        source,
        codexUltraOrchestration: { enabled: true, providerEffort: "high" },
      };
      const normalized = normalizeCodexReasoningCapabilityForProvider(
        "gpt-6.1-sol",
        capability,
        { baseUrl: "https://api.sublyx.org/v1" },
      );
      expect(normalized.defaultEffort).toBe("max");
      expect(normalized.upstream.effortMap?.max).toBe("max");
      expect(normalized.codexUltraOrchestration).toEqual({
        enabled: true,
        providerEffort: "high",
      });
      expect(capability.defaultEffort).toBe("max");
    },
  );

  it("preserves valid explicit native max evidence before missing identity mappings are completed", () => {
    const capability: CodexModelReasoningCapability = {
      supported: true,
      supportedEfforts: ["low", "high", "max"],
      defaultEffort: "max",
      disableAllowed: false,
      upstream: {
        format: "reasoning_object",
        parameter: "reasoning.effort",
        effortMap: { max: "max" },
      },
      source: "user",
    };
    expect(
      normalizeCodexReasoningCapabilityForProvider("gpt-6.1-sol", capability, {
        baseUrl: "https://api.sublyx.org/v1",
      }),
    ).toBe(capability);
  });

  it.each([
    { target: undefined, expected: "max" },
    { target: "ultra", expected: "max" },
    { target: "high", expected: "high" },
    { target: "max", expected: "max" },
  ] as const)(
    "repairs malformed native efforts while retaining explicit Ultra target $target as $expected",
    ({ target, expected }) => {
      for (const enabled of [false, true]) {
        const capability: CodexModelReasoningCapability = {
          supported: true,
          supportedEfforts: ["high", "max", "ultra"],
          defaultEffort: "ultra",
          disableAllowed: false,
          upstream: {
            format: "string",
            parameter: "reasoning_effort",
            effortMap: { high: "high", max: "max", ultra: "ultra" },
          },
          source: "user",
          codexUltraOrchestration: { enabled, providerEffort: target },
        };
        const normalized = normalizeCodexReasoningCapabilityForProvider(
          "gpt-6.1-sol",
          capability,
          { baseUrl: "https://api.sublyx.org/v1" },
        );
        expect(normalized.supportedEfforts).toEqual([
          "low",
          "medium",
          "high",
          "xhigh",
          "max",
        ]);
        // A legacy literal Ultra default resolves through the exact same
        // validated native path as its saved overlay, even when disabled.
        const effectiveTarget =
          target === undefined && enabled ? "max" : expected;
        expect(normalized.defaultEffort).toBe(effectiveTarget);
        expect(normalized.codexUltraOrchestration).toEqual({
          enabled,
          // An enabled legacy overlay can declare its valid target through
          // max's compatibility mapping; absence of that overlay does not.
          providerEffort: effectiveTarget,
        });
      }
    },
  );

  it.each([
    { defaultEffort: "ultra", effortMap: { high: "high", max: "max" } },
    { defaultEffort: "max", effortMap: { high: "ultra", max: "max" } },
    { defaultEffort: "max", effortMap: { ultra: "high", max: "max" } },
    { defaultEffort: "max", effortMap: { high: "xhigh", max: "max" } },
  ] as const)(
    "repairs an invalid explicit default or mapping instead of treating max as validated evidence: %j",
    ({ defaultEffort, effortMap }) => {
      const capability: CodexModelReasoningCapability = {
        supported: true,
        supportedEfforts: ["high", "max"],
        defaultEffort,
        disableAllowed: false,
        upstream: {
          format: "reasoning_object",
          parameter: "reasoning.effort",
          effortMap,
        },
        source: "user",
      };
      const normalized = normalizeCodexReasoningCapabilityForProvider(
        "gpt-6.1-sol",
        capability,
        { baseUrl: "https://api.sublyx.org/v1" },
      );
      expect(normalized).not.toBe(capability);
      expect(normalized.supportedEfforts).not.toContain("ultra");
      expect(normalized.upstream.effortMap).toEqual({
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "max",
      });
    },
  );

  it.each([
    { format: "string", parameter: "reasoning_split" },
    { format: "unsupported_format", parameter: "reasoning.effort" },
  ])(
    "repairs an invalid explicit upstream wire declaration instead of treating max as validated evidence: %j",
    ({ format, parameter }) => {
      const capability = {
        supported: true,
        supportedEfforts: ["high", "max"],
        defaultEffort: "max",
        disableAllowed: false,
        upstream: {
          format,
          parameter,
          effortMap: { high: "high", max: "max" },
        },
        source: "user",
      } as unknown as CodexModelReasoningCapability;
      const normalized = normalizeCodexReasoningCapabilityForProvider(
        "gpt-6.1-sol",
        capability,
        { baseUrl: "https://api.sublyx.org/v1" },
      );
      expect(normalized).not.toBe(capability);
      expect(normalized.upstream.format).toBe("reasoning_object");
      expect(normalized.upstream.parameter).toBe("reasoning.effort");
      expect(normalized.upstream.effortMap?.max).toBe("max");
    },
  );

  it("projects maintained Ultra without inventing an explicit persisted overlay", () => {
    const row = { model: "gpt-6.1-sol" };
    expect(
      resolveCodexCatalogUltraDisplay(row, {
        codexUltraOrchestrationEnabled: true,
        effortMap: { ultra: "max" },
      }),
    ).toEqual({ enabled: true, providerEffort: "max" });
    expect(row).not.toHaveProperty("codexUltra");
  });

  it.each([
    { enabled: true, resolvedEffort: "max", expectedEffort: "max" },
    { enabled: true, resolvedEffort: "xhigh", expectedEffort: "max" },
    { enabled: true, resolvedEffort: undefined, expectedEffort: "max" },
    { enabled: false, resolvedEffort: "max", expectedEffort: "xhigh" },
  ] as const)(
    "uses the canonical $expectedEffort for a row-only Sublyx overlay with enabled=$enabled and resolved effort $resolvedEffort",
    ({ enabled, resolvedEffort, expectedEffort }) => {
      const row = {
        model: "public-model",
        upstreamModel: "gpt-6.2-sol-sublyx",
        codexUltra: { enabled, providerEffort: "xhigh" as const },
      };
      const identity = { baseUrl: "https://api.sublyx.org/v1" };
      const resolved = resolvedEffort
        ? {
            codexUltraOrchestrationEnabled: true,
            effortMap: { ultra: resolvedEffort },
          }
        : undefined;

      expect(resolveCodexCatalogUltraDisplay(row, resolved, identity)).toEqual({
        enabled,
        providerEffort: expectedEffort,
      });
      expect(
        normalizeCodexCatalogReasoningForProvider(row, identity).codexUltra
          ?.providerEffort,
      ).toBe(enabled ? "max" : "xhigh");
    },
  );

  it("persists the same maintained Sublyx Ultra target that the catalog displays", () => {
    const row = {
      model: "public-model",
      upstreamModel: "gpt-6.2-sol-sublyx",
      codexUltra: { enabled: true, providerEffort: "xhigh" as const },
    };
    const identity = { baseUrl: "https://api.sublyx.org/v1" };
    const normalized = normalizeCodexCatalogReasoningForProvider(row, identity);

    expect(normalized.codexUltra).toEqual({
      enabled: true,
      providerEffort: "max",
    });
    expect(
      resolveCodexCatalogUltraDisplay(
        row,
        {
          codexUltraOrchestrationEnabled: true,
          effortMap: { ultra: "xhigh" },
        },
        identity,
      ),
    ).toEqual(normalized.codexUltra);
  });

  it("keeps an explicit row-only Sublyx Ultra target while the backend resolution is stale", () => {
    const row = {
      model: "gpt-6.2-sol-sublyx",
      codexUltra: {
        enabled: true,
        providerEffort: "xhigh",
        providerEffortSource: "user",
      } as const,
    };
    expect(
      resolveCodexCatalogUltraDisplay(
        row,
        {
          codexUltraOrchestrationEnabled: true,
          effortMap: { ultra: "max" },
        },
        { baseUrl: "https://api.sublyx.org/v1" },
      ),
    ).toEqual(row.codexUltra);
    expect(
      normalizeCodexCatalogReasoningForProvider(
        row,
        { baseUrl: "https://api.sublyx.org/v1" },
      ).codexUltra,
    ).toEqual(row.codexUltra);
  });

  it("uses the canonical reasoning Ultra target when the runtime projection is stale", () => {
    const row = {
      model: "gpt-6.2-sol-sublyx",
      reasoning: {
        schemaVersion: 2,
        supportStatus: "confirmed_supported" as const,
        controlKind: "graded" as const,
        supportedEfforts: [
          "low",
          "medium",
          "high",
          "xhigh",
          "max",
        ] as CodexReasoningEffort[],
        defaultEffort: "medium" as const,
        disableAllowed: false,
        upstream: {
          format: "reasoning_object" as const,
          parameter: "reasoning.effort" as const,
          effortMap: {
            low: "low" as const,
            medium: "medium" as const,
            high: "high" as const,
            xhigh: "xhigh" as const,
            max: "max" as const,
          },
        },
        source: "sublyx" as const,
        codexUltraOrchestration: {
          enabled: true,
          providerEffort: "max" as const,
        },
      },
    };

    expect(
      resolveCodexCatalogUltraDisplay(
        row,
        {
          codexUltraOrchestrationEnabled: true,
          effortMap: { ultra: "xhigh" },
        },
        { baseUrl: "https://api.sublyx.org/v1" },
      ),
    ).toEqual({ enabled: true, providerEffort: "max" });
  });

  it("keeps a row-only Ultra target on a different provider", () => {
    const row = {
      model: "gpt-6.2-sol-sublyx",
      codexUltra: { enabled: true, providerEffort: "xhigh" as const },
    };
    expect(
      resolveCodexCatalogUltraDisplay(
        row,
        {
          codexUltraOrchestrationEnabled: true,
          effortMap: { ultra: "max" },
        },
        { baseUrl: "https://openrouter.ai/api/v1" },
      ),
    ).toEqual(row.codexUltra);
  });

  it.each(["xhigh", "max", undefined] as const)(
    "migrates the legacy maintained Sublyx Ultra xhigh overlay with Max mapped to %s",
    (maxMapping) => {
      const normalized = normalizeCodexReasoningCapabilityForProvider(
        "gpt-6.1-sol",
        {
          schemaVersion: 2,
          supportStatus: "confirmed_supported",
          controlKind: "graded",
          supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
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
              ...(maxMapping ? { max: maxMapping } : {}),
            },
          },
          source: "sublyx",
          codexUltraOrchestration: { enabled: true, providerEffort: "xhigh" },
        },
        { baseUrl: "https://api.sublyx.org/v1" },
      );
      expect(normalized.upstream.effortMap?.max).toBe("max");
      expect(normalized.codexUltraOrchestration).toEqual({
        enabled: true,
        providerEffort: "max",
      });
    },
  );

  it("migrates a source-less legacy Sublyx capability with an enabled Ultra xhigh overlay", () => {
    const normalized = normalizeCodexReasoningCapabilityForProvider(
      "gpt-6.2-sol",
      {
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
        codexUltraOrchestration: { enabled: true, providerEffort: "xhigh" },
      },
      { baseUrl: "https://api.sublyx.org/v1" },
    );

    expect(normalized.supportedEfforts).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(normalized.upstream.effortMap?.max).toBe("max");
    expect(normalized.codexUltraOrchestration).toEqual({
      enabled: true,
      providerEffort: "max",
    });
  });

  it("repairs a legacy builtin Sublyx capability before applying its stale Ultra overlay", () => {
    const normalized = normalizeCodexCatalogReasoningForProvider(
      {
        model: "gpt-6.2-sol",
        reasoning: {
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
          source: "builtin",
          codexUltraOrchestration: { enabled: true, providerEffort: "xhigh" },
        },
        codexUltra: { enabled: true, providerEffort: "xhigh" },
      },
      { baseUrl: "https://api.sublyx.org/v1" },
    );

    expect(normalized.reasoning?.supportedEfforts).toContain("max");
    expect(normalized.reasoning?.codexUltraOrchestration).toEqual({
      enabled: true,
      providerEffort: "max",
    });
    expect(normalized.codexUltra).toEqual({
      enabled: true,
      providerEffort: "max",
    });
  });

  it("keeps a user-owned Sublyx xhigh Ultra override intact", () => {
    const normalized = normalizeCodexReasoningCapabilityForProvider(
      "gpt-6.1-sol",
      {
        schemaVersion: 2,
        supportStatus: "confirmed_supported",
        controlKind: "graded",
        supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
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
            max: "xhigh",
          },
        },
        source: "user",
        codexUltraOrchestration: { enabled: true, providerEffort: "xhigh" },
      },
      { baseUrl: "https://api.sublyx.org/v1" },
    );
    expect(normalized.codexUltraOrchestration).toEqual({
      enabled: true,
      providerEffort: "xhigh",
    });
  });

  it.each([false, true])(
    "preserves explicit Sublyx Ultra native max target when enabled=%s",
    (enabled) => {
      expect(
        resolveCodexCatalogUltraDisplay(
          {
            model: "gpt-6.1-sol",
            codexUltra: { enabled, providerEffort: "max" },
          },
          {
            codexUltraOrchestrationEnabled: true,
            effortMap: { ultra: "xhigh" },
          },
          {
            baseUrl: "https://api.sublyx.org/v1",
          },
        ),
      ).toEqual({ enabled, providerEffort: "max" });
    },
  );

  it("reconciles a literal synthetic Sublyx Ultra target without enabling it", () => {
    expect(
      resolveCodexCatalogUltraDisplay(
        {
          model: "gpt-6.1-sol",
          codexUltra: { enabled: false, providerEffort: "ultra" },
        },
        { codexUltraOrchestrationEnabled: true, effortMap: { ultra: "max" } },
        { baseUrl: "https://api.sublyx.org/v1" },
      ),
    ).toEqual({ enabled: false, providerEffort: "max" });
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
        normalizeCodexReasoningCapabilityForProvider(
          "gpt-6.1-sol",
          capability,
          {
            baseUrl: "https://api.sublyx.org/v1",
          },
        ),
      ).toBe(capability);
    },
  );
});

describe("explicit Sublyx native subset authority", () => {
  it.each([
    undefined,
    "user",
    "user_confirmed_detection",
    "provider_config",
  ] as const)(
    "preserves valid %s declarations without requiring native Max",
    (source) => {
      const capability: CodexModelReasoningCapability = {
        schemaVersion: 2,
        supportStatus: "confirmed_supported",
        controlKind: "graded",
        supportedEfforts: ["low", "high"],
        defaultEffort: "high",
        disableAllowed: false,
        upstream: {
          format: "reasoning_object",
          parameter: "reasoning.effort",
          effortMap: { low: "low", high: "high", max: "high" },
        },
        source,
        confidence: source === "provider_config" ? "authoritative" : undefined,
        codexUltraOrchestration: { enabled: false },
      };
      const normalized = normalizeCodexReasoningCapabilityForProvider(
        "gpt-6.1-sol",
        capability,
        { baseUrl: "https://api.sublyx.org/v1" },
      );
      expect(normalized).toBe(capability);
      expect(normalized.supportedEfforts).toEqual(["low", "high"]);
      expect(normalized.upstream.effortMap?.max).toBe("high");
    },
  );
});
