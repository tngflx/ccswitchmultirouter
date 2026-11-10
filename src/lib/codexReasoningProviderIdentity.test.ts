import type { CodexModelReasoningCapability } from "@/types";
import { describe, expect, it } from "vitest";
import {
  codexReasoningProviderIdentity,
  isSublyxReasoningProvider,
  normalizeCodexReasoningCapabilityForProvider,
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
        baseUrl: "https://api.sublyx.org/v1",
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
          baseUrl: "https://api.sublyx.org/v1",
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
          baseUrl: "https://api.sublyx.org/v1",
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
          baseUrl: "https://api.sublyx.org/v1",
        }),
      ).toBe(capability);
    },
  );
});
