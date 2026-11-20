import { parse as parseToml } from "smol-toml";
import type {
  CodexCatalogModel,
  CodexModelReasoningCapability,
  CodexReasoningEffort,
  Provider,
} from "@/types";
import type { CodexSubagentReasoningCapability } from "@/types/codexSubagentV2";
import { normalizeTomlText } from "@/utils/textNormalization";

/** Transient transport identity, deliberately independent of model names. */
export interface CodexReasoningProviderIdentity {
  providerKind?: string | null;
  providerKey?: string | null;
  providerId?: string | null;
  providerName?: string | null;
  baseUrl?: string | null;
}

type Gateway = "openrouter" | "sublyx";
type KnownPlatform = Gateway | "vllm" | "deepseek" | "zhipu" | "dashscope";

/** Match actual transports, never URL paths, queries, userinfo, or model names. */
function transportPlatform(baseUrl: unknown): KnownPlatform | undefined {
  if (typeof baseUrl !== "string") return undefined;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  // A terminal DNS dot is the same host, not a different provider. Keep this
  // allowlist aligned with reasoning_capabilities/provider_metadata.rs.
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  const hostMatches = (root: string) =>
    host === root || (host.endsWith(`.${root}`) && !host.startsWith("."));
  if (hostMatches("openrouter.ai")) return "openrouter";
  if (hostMatches("sublyx.org")) return "sublyx";
  if (host === "api.deepseek.com") return "deepseek";
  if (host === "api.z.ai" || host === "open.bigmodel.cn") return "zhipu";
  if (
    host === "dashscope.aliyuncs.com" ||
    host === "dashscope-intl.aliyuncs.com" ||
    (host.endsWith(".maas.aliyuncs.com") && !host.startsWith("."))
  )
    return "dashscope";
  const firstLabel = host.split(".")[0];
  if (
    firstLabel === "vllm" ||
    (firstLabel.startsWith("vllm-") && firstLabel.length > "vllm-".length)
  )
    return "vllm";
  return undefined;
}

function gateway(...values: unknown[]): Gateway | undefined {
  const identity = values
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  if (identity.includes("openrouter")) return "openrouter";
  if (identity.includes("sublyx")) return "sublyx";
  return undefined;
}

/** Match backend name/key platforms; official vendor identity requires a URL. */
function namedPlatform(...values: unknown[]): Gateway | "vllm" | undefined {
  return (
    gateway(...values) ??
    (values.some(
      (value) =>
        typeof value === "string" && value.toLowerCase().includes("vllm"),
    )
      ? "vllm"
      : undefined)
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstString(
  value: Record<string, unknown> | null | undefined,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const candidate = value?.[key];
    if (typeof candidate === "string" && candidate.trim())
      return candidate.trim();
  }
  return undefined;
}

function parsedTomlSettings(settings: Record<string, unknown>) {
  if (typeof settings.config !== "string") return undefined;
  try {
    return parseToml(normalizeTomlText(settings.config));
  } catch {
    // An incomplete editor draft must not replace otherwise usable identity.
    return undefined;
  }
}

function selectedTomlProvider(settings: Record<string, unknown>) {
  const config = parsedTomlSettings(settings);
  if (!config) return undefined;
  const selected = firstString(config, ["model_provider"]);
  const selectedProvider = selected
    ? record(record(config.model_providers)?.[selected])
    : undefined;
  return selectedProvider
    ? { key: selected, settings: selectedProvider }
    : undefined;
}

/** Same endpoint precedence as the Codex runtime; never inspect inactive tables. */
export function readCodexProviderBaseUrl(
  settingsConfig: Record<string, unknown> | null | undefined,
): string | undefined {
  if (!settingsConfig) return undefined;
  const endpointKeys = ["base_url", "baseURL", "baseUrl"];
  const topLevel = firstString(settingsConfig, endpointKeys);
  if (topLevel) return topLevel;
  const config = parsedTomlSettings(settingsConfig);
  if (!config) return undefined;
  const selected = firstString(config, ["model_provider"]);
  if (!selected || selected === "openai") {
    const openaiBaseUrl = firstString(config, ["openai_base_url"]);
    if (openaiBaseUrl) return openaiBaseUrl;
  }
  const selectedProvider = selected
    ? record(record(config.model_providers)?.[selected])
    : undefined;
  return (
    firstString(selectedProvider, endpointKeys) ??
    firstString(config, endpointKeys)
  );
}

/**
 * Resolve the actual transport before display identity. Inactive TOML tables
 * never contribute identity; a stale Sublyx label cannot change OpenRouter's
 * native reasoning contract (or vice versa).
 */
export function codexReasoningProviderIdentity(
  provider: Pick<Provider, "id" | "name" | "settingsConfig">,
): CodexReasoningProviderIdentity {
  const settings = provider.settingsConfig;
  const selected = selectedTomlProvider(settings);
  const baseUrl = readCodexProviderBaseUrl(settings);
  const targetId = firstString(settings, ["codexResolvedTargetProviderId"]);
  const targetName = firstString(settings, ["codexResolvedTargetProviderName"]);
  const hasTargetIdentity =
    Object.prototype.hasOwnProperty.call(
      settings,
      "codexResolvedTargetProviderId",
    ) ||
    Object.prototype.hasOwnProperty.call(
      settings,
      "codexResolvedTargetProviderName",
    );
  const providerId = hasTargetIdentity ? targetId : provider.id;
  const providerName = hasTargetIdentity
    ? targetName
    : (firstString(settings, ["providerName", "provider_name", "name"]) ??
      provider.name);
  const providerKind =
    transportPlatform(baseUrl) ??
    namedPlatform(
      selected?.key,
      firstString(selected?.settings, [
        "name",
        "providerName",
        "provider_name",
      ]),
    ) ??
    namedPlatform(providerName, providerId) ??
    // A complete current provider context is authoritative even when unknown.
    // Do not revive stale capability provenance or synthetic wrapper labels.
    "unknown";
  return { providerKind, providerId, providerName, baseUrl };
}

function explicitPlatform(
  identity?: CodexReasoningProviderIdentity | null,
): KnownPlatform | "other" | undefined {
  if (!identity) return undefined;
  return (
    transportPlatform(identity.baseUrl) ??
    (identity.providerKind?.trim()
      ? (gateway(identity.providerKind) ?? "other")
      : undefined) ??
    gateway(identity.providerKey, identity.providerId, identity.providerName) ??
    (Object.values(identity).some(
      (value) => typeof value === "string" && value.trim(),
    )
      ? "other"
      : undefined)
  );
}

/** Manual wire defaults require the actual API transport, never a display label. */
export function isOpenRouterReasoningTransport(
  identity?: CodexReasoningProviderIdentity | null,
): boolean {
  return transportPlatform(identity?.baseUrl) === "openrouter";
}

/** Explicit transport takes priority over stale capability provenance. */
export function isSublyxReasoningProvider(
  source?: string | null,
  identity?: CodexReasoningProviderIdentity | null,
  capabilityProviderKey?: string | null,
): boolean {
  return (
    (explicitPlatform(identity) ?? gateway(capabilityProviderKey, source)) ===
    "sublyx"
  );
}

/** Model family narrows an already-established provider contract, never identity. */
export function usesSublyxGptReasoningContract(
  model: string,
  identity?: CodexReasoningProviderIdentity | null,
  capability?: Pick<CodexModelReasoningCapability, "source" | "providerKey">,
): boolean {
  return (
    model.trim().toLowerCase().startsWith("gpt-") &&
    isSublyxReasoningProvider(
      capability?.source,
      identity,
      capability?.providerKey,
    )
  );
}

/** Explicit manual overrides are distinct from scoped automatic detections. */
export function hasExplicitSublyxNativeEvidence(
  capability: CodexModelReasoningCapability,
): boolean {
  if (
    !(
      capability.source == null ||
      ["user", "user_confirmed_detection"].includes(capability.source) ||
      (capability.source === "provider_config" &&
        capability.confidence === "authoritative")
    ) ||
    (capability.supportStatus !== undefined &&
      capability.supported !== undefined &&
      capability.supportStatus !==
        (capability.supported
          ? "confirmed_supported"
          : "confirmed_unsupported"))
  )
    return false;

  // The backend validates native declarations before preserving their
  // evidence. Do not let an old native `ultra` or orphaned mapping bypass
  // maintained repair merely because its source is manual. Missing
  // identity entries remain valid here; save/runtime boundaries complete them.
  const nativeEfforts: CodexReasoningEffort[] = [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ];
  const upstreamFormat = capability.upstream.format.trim();
  const upstreamParameter = capability.upstream.parameter.trim();
  if (
    ![
      "auto",
      "text",
      "summary",
      "object",
      "reasoning_object",
      "string",
      "boolean",
      "none",
      "budget",
    ].includes(upstreamFormat) ||
    !(
      (upstreamFormat === "none" && upstreamParameter === "") ||
      [
        "reasoning",
        "reasoning.effort",
        "reasoning_effort",
        "enable_thinking",
        "thinking",
        "thinking_budget",
        "max_tokens",
        "reasoning.max_tokens",
        "none",
      ].includes(upstreamParameter)
    ) ||
    capability.supportedEfforts.length === 0 ||
    capability.supportedEfforts.some(
      (effort) => !nativeEfforts.includes(effort),
    ) ||
    (capability.defaultEffort !== undefined &&
      !capability.supportedEfforts.includes(capability.defaultEffort)) ||
    (!capability.disableAllowed &&
      capability.supportedEfforts.includes("none")) ||
    Object.entries(capability.upstream.effortMap ?? {}).some(
      ([source, target]) =>
        !nativeEfforts.includes(source as CodexReasoningEffort) ||
        !nativeEfforts.includes(target as CodexReasoningEffort) ||
        !capability.supportedEfforts.includes(target as CodexReasoningEffort),
    )
  )
    return false;
  const ultraTarget =
    capability.codexUltraOrchestration?.providerEffort ??
    capability.upstream.effortMap?.max;
  return (
    !capability.codexUltraOrchestration?.enabled ||
    (ultraTarget !== undefined &&
      capability.supportedEfforts.includes(ultraTarget))
  );
}

/** The provider-scoped fallback also owns legacy overlay migration. */
function maintainedSublyxNativeEfforts(model: string): CodexReasoningEffort[] {
  const canonicalModel = model
    .trim()
    .toLowerCase()
    .replace(/-sublyx$/, "");
  // Exact accepted-and-echoed audit rows plus the maintained native models.
  // An unknown GPT slug does not inherit Max merely from the family name.
  const knownNativeMaxModels = [
    "gpt-5.6-terra",
    "gpt-5.6-sol",
    "gpt-5.6-luna",
    "gpt-6-astra",
    "gpt-6-luna",
    "gpt-6-sol",
    "gpt-6.1-sol",
    "gpt-6.1-terra",
    "gpt-6.2-sol",
  ];
  const supportsNativeMax = knownNativeMaxModels.some(
    (known) =>
      canonicalModel === known || canonicalModel.startsWith(`${known}-`),
  );
  return [
    "low",
    "medium",
    "high",
    "xhigh",
    ...(supportsNativeMax ? (["max"] as CodexReasoningEffort[]) : []),
  ];
}

/**
 * Preserve only the validated native evidence accepted by the Rust resolver.
 * Catalog reads normalize the wire tokens and complete identity mappings before
 * that check; provider labels or a higher-looking confidence are not substitutes
 * for a verified detection bound to the exact current wire model.
 */
function verifiedSublyxNativeEvidence(
  model: string,
  capability: CodexModelReasoningCapability,
): CodexModelReasoningCapability | undefined {
  const format = capability.upstream.format.trim().toLowerCase();
  const parameter = capability.upstream.parameter.trim().toLowerCase();
  if (
    capability.source !== "detection" ||
    capability.confidence !== "verified" ||
    capability.evidenceScope?.model?.toLowerCase() !==
      model.trim().toLowerCase() ||
    format !== "reasoning_object" ||
    parameter !== "reasoning.effort"
  )
    return undefined;

  const nativeEfforts = new Set<CodexReasoningEffort>([
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  const efforts = capability.supportedEfforts;
  const effortMap = { ...capability.upstream.effortMap };
  for (const effort of efforts) {
    if (effort !== "none" && effortMap[effort] === undefined)
      effortMap[effort] = effort;
  }
  const ultra = capability.codexUltraOrchestration;
  const declaredUltraTarget = ultra?.providerEffort ?? effortMap.max;
  // Match the backend's validation boundary before preserving a detection.
  // Invalid drafts may still use the existing maintained-contract migration,
  // but must never masquerade as authoritative native evidence.
  if (
    efforts.length === 0 ||
    efforts.some((effort) => !nativeEfforts.has(effort)) ||
    (capability.supportStatus !== undefined &&
      capability.supported === false) ||
    (capability.defaultEffort !== undefined &&
      !efforts.includes(capability.defaultEffort)) ||
    (!capability.disableAllowed && efforts.includes("none")) ||
    Object.entries(effortMap).some(
      ([source, target]) =>
        !nativeEfforts.has(source as CodexReasoningEffort) ||
        !nativeEfforts.has(target) ||
        !efforts.includes(target),
    ) ||
    (ultra?.enabled &&
      (!declaredUltraTarget || !efforts.includes(declaredUltraTarget)))
  )
    return undefined;

  // Older scoped Sublyx probes could advertise native `max` while retaining
  // the pre-Max compatibility mapping. Once the verified row proves Max is
  // accepted, native Max must route to Max too. Catalog Ultra ownership is a
  // separate overlay and is preserved below.
  if (efforts.includes("max") && effortMap.max === "xhigh")
    effortMap.max = "max";

  // Ultra is a separate product overlay, not an alias for native Max.
  const defaultUltraTarget: CodexReasoningEffort | undefined = efforts.includes(
    "max",
  )
    ? "max"
    : efforts.includes("xhigh")
      ? "xhigh"
      : undefined;
  const normalizedUltra: CodexModelReasoningCapability["codexUltraOrchestration"] =
    ultra
      ? {
          ...ultra,
          ...(ultra.enabled &&
          ultra.providerEffort === "xhigh" &&
          efforts.includes("max")
            ? { providerEffort: "max" as const }
            : {}),
        }
      : defaultUltraTarget
        ? { enabled: true, providerEffort: defaultUltraTarget }
        : undefined;
  return {
    ...capability,
    supportedEfforts: [...efforts],
    upstream: {
      ...capability.upstream,
      format: "reasoning_object",
      parameter: "reasoning.effort",
      effortMap,
    },
    ...(normalizedUltra ? { codexUltraOrchestration: normalizedUltra } : {}),
  };
}

/**
 * Match the backend's maintained, provider-scoped Sublyx GPT wire contract.
 * Repair native shape without changing evidence provenance or explicit opt-outs.
 */
export function normalizeCodexReasoningCapabilityForProvider(
  model: string,
  capability: CodexModelReasoningCapability,
  identity?: CodexReasoningProviderIdentity | null,
): CodexModelReasoningCapability {
  const confirmedSupported =
    capability.supportStatus !== undefined
      ? capability.supportStatus === "confirmed_supported"
      : capability.supported === true;
  const graded =
    capability.controlKind !== undefined
      ? capability.controlKind === "graded"
      : capability.supportedEfforts.length > 0;
  if (
    !confirmedSupported ||
    !graded ||
    !usesSublyxGptReasoningContract(model, identity, capability)
  )
    return capability;
  // A current scoped detection is validated before any manual migration.
  // Automatic evidence must never bypass its model/confidence checks merely
  // because their source once matched a provider label.
  const verifiedEvidence = verifiedSublyxNativeEvidence(model, capability);
  if (verifiedEvidence) return verifiedEvidence;
  const legacyUnownedUltra =
    capability.source == null &&
    capability.codexUltraOrchestration?.enabled === true &&
    capability.codexUltraOrchestration.providerEffort === "xhigh" &&
    maintainedSublyxNativeEfforts(model).includes("max");
  if (hasExplicitSublyxNativeEvidence(capability) && !legacyUnownedUltra)
    return capability;

  const savedDefault = capability.defaultEffort?.trim().toLowerCase();
  const nativeEfforts = maintainedSublyxNativeEfforts(model);
  // Only the maintained migration path uses the family allowlist; verified
  // native evidence returned above is never broadened or downgraded by it.
  const acceptsNativeMax = nativeEfforts.includes("max");
  const defaultUltraTarget = acceptsNativeMax ? "max" : "xhigh";
  const savedUltraTarget =
    capability.codexUltraOrchestration?.providerEffort ??
    (capability.codexUltraOrchestration?.enabled
      ? capability.upstream.effortMap?.max
      : undefined);
  // Older maintained Sublyx capabilities targeted xhigh even after learning
  // native max. The legacy Ultra target is independent of effortMap.max.
  const migratesLegacySublyxUltra =
    capability.codexUltraOrchestration?.enabled === true &&
    acceptsNativeMax &&
    savedUltraTarget === "xhigh";
  const ultraTarget = migratesLegacySublyxUltra
    ? "max"
    : savedUltraTarget && nativeEfforts.includes(savedUltraTarget)
      ? savedUltraTarget
      : defaultUltraTarget;
  const normalizedSavedDefault: CodexReasoningEffort | undefined =
    savedDefault === "ultra"
      ? ultraTarget
      : savedDefault === "max" && !acceptsNativeMax
        ? "xhigh"
        : (savedDefault as CodexReasoningEffort | undefined);
  const defaultEffort: CodexReasoningEffort =
    normalizedSavedDefault &&
    nativeEfforts.includes(normalizedSavedDefault as CodexReasoningEffort)
      ? (normalizedSavedDefault as CodexReasoningEffort)
      : nativeEfforts.includes("medium")
        ? "medium"
        : nativeEfforts[0];
  const effortMap = Object.fromEntries(
    nativeEfforts.map((effort) => [effort, effort]),
  ) as Partial<Record<CodexReasoningEffort, CodexReasoningEffort>>;

  const canonical = { ...capability };
  delete canonical.supported;
  return {
    ...canonical,
    schemaVersion: 2,
    supportStatus: "confirmed_supported",
    controlKind: "graded",
    providerKey: "sublyx",
    supportedEfforts: nativeEfforts,
    defaultEffort,
    disableAllowed: false,
    upstream: {
      format: "reasoning_object",
      parameter: "reasoning.effort",
      effortMap,
    },
    codexUltraOrchestration: {
      enabled: capability.codexUltraOrchestration?.enabled ?? true,
      providerEffort: ultraTarget,
    },
  };
}

/** Shared editor/save projection; explicitly disabled Ultra remains disabled. */
export function normalizeCodexCatalogReasoningForProvider<
  T extends CodexCatalogModel,
>(row: T, identity?: CodexReasoningProviderIdentity | null): T {
  const model =
    row.upstreamModel?.trim() || row.upstream_model?.trim() || row.model;
  if (!usesSublyxGptReasoningContract(model, identity, row.reasoning))
    return row;
  const normalizedReasoning = row.reasoning
    ? normalizeCodexReasoningCapabilityForProvider(
        model,
        row.reasoning,
        identity,
      )
    : undefined;
  const nativeEfforts =
    normalizedReasoning?.supportedEfforts ??
    maintainedSublyxNativeEfforts(model);
  const migratedRowUltra =
    row.codexUltra?.enabled === true &&
    row.codexUltra.providerEffort === "xhigh" &&
    row.codexUltra.providerEffortSource !== "user" &&
    nativeEfforts.includes("max") &&
    (normalizedReasoning
      ? normalizedReasoning.codexUltraOrchestration?.enabled === true &&
        normalizedReasoning.codexUltraOrchestration.providerEffort === "max"
      : true)
      ? { ...row.codexUltra, providerEffort: "max" as const }
      : row.codexUltra;
  return {
    ...row,
    ...(normalizedReasoning ? { reasoning: normalizedReasoning } : {}),
    ...(migratedRowUltra?.providerEffort &&
    !nativeEfforts.includes(migratedRowUltra.providerEffort) &&
    (nativeEfforts.includes("xhigh") || nativeEfforts.includes("max"))
      ? {
          codexUltra: {
            ...migratedRowUltra,
            providerEffort: nativeEfforts.includes("max") ? "max" : "xhigh",
          },
        }
      : migratedRowUltra && migratedRowUltra !== row.codexUltra
        ? { codexUltra: migratedRowUltra }
        : {}),
  };
}

/** Show the catalog overlay with any target migration resolved by the backend. */
export function resolveCodexCatalogUltraDisplay(
  row: CodexCatalogModel,
  resolved:
    | Pick<
        CodexSubagentReasoningCapability,
        "codexUltraOrchestrationEnabled" | "effortMap"
      >
    | undefined,
  identity?: CodexReasoningProviderIdentity | null,
): NonNullable<CodexCatalogModel["codexUltra"]> {
  const normalized = normalizeCodexCatalogReasoningForProvider(row, identity);
  const codexUltra =
    normalized.codexUltra ?? normalized.reasoning?.codexUltraOrchestration;
  return (
    codexUltra ?? {
      enabled: resolved?.codexUltraOrchestrationEnabled === true,
      ...(resolved?.effortMap.ultra
        ? { providerEffort: resolved.effortMap.ultra }
        : {}),
    }
  );
}
