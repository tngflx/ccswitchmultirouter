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

function selectedTomlProvider(settings: Record<string, unknown>) {
  if (typeof settings.config !== "string") return undefined;
  try {
    const config = parseToml(normalizeTomlText(settings.config));
    const selected = firstString(config, ["model_provider"]);
    const selectedProvider = selected
      ? record(record(config.model_providers)?.[selected])
      : undefined;
    return selectedProvider
      ? { key: selected, settings: selectedProvider }
      : undefined;
  } catch {
    // An incomplete editor draft must not replace otherwise usable identity.
    return undefined;
  }
}

/** Same endpoint precedence as the Codex runtime: top-level, then active TOML. */
export function readCodexProviderBaseUrl(
  settingsConfig: Record<string, unknown> | null | undefined,
): string | undefined {
  if (!settingsConfig) return undefined;
  return (
    firstString(settingsConfig, ["base_url", "baseURL", "baseUrl"]) ??
    firstString(selectedTomlProvider(settingsConfig)?.settings, [
      "base_url",
      "baseURL",
      "baseUrl",
    ])
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
  const hasTargetIdentity = Boolean(targetId || targetName);
  const providerId = hasTargetIdentity ? targetId : provider.id;
  const providerName = hasTargetIdentity
    ? targetName
    : (firstString(settings, ["providerName", "provider_name", "name"]) ??
      provider.name);
  const providerKind =
    gateway(baseUrl) ??
    namedPlatform(
      selected?.key,
      firstString(selected?.settings, [
        "name",
        "providerName",
        "provider_name",
      ]),
    ) ??
    gateway(providerName, providerId);
  return { providerKind, providerId, providerName, baseUrl };
}

function explicitGateway(
  identity?: CodexReasoningProviderIdentity | null,
): Gateway | "other" | undefined {
  if (!identity) return undefined;
  return (
    gateway(identity.baseUrl) ??
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

/** Explicit transport takes priority over stale capability provenance. */
export function isSublyxReasoningProvider(
  source?: string | null,
  identity?: CodexReasoningProviderIdentity | null,
  capabilityProviderKey?: string | null,
): boolean {
  return (
    (explicitGateway(identity) ?? gateway(capabilityProviderKey, source)) ===
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

  const nativeEfforts: CodexReasoningEffort[] = [
    "low",
    "medium",
    "high",
    "xhigh",
  ];
  const savedDefault = capability.defaultEffort?.trim().toLowerCase();
  const defaultEffort: CodexReasoningEffort =
    savedDefault === "max" || savedDefault === "ultra"
      ? "xhigh"
      : nativeEfforts.includes(savedDefault as CodexReasoningEffort)
        ? (savedDefault as CodexReasoningEffort)
        : "medium";
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
      effortMap: { low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
    },
    codexUltraOrchestration: {
      enabled: capability.codexUltraOrchestration?.enabled ?? true,
      providerEffort: "xhigh",
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
  return {
    ...row,
    ...(row.reasoning
      ? {
          reasoning: normalizeCodexReasoningCapabilityForProvider(
            model,
            row.reasoning,
            identity,
          ),
        }
      : {}),
    ...(row.codexUltra &&
    ["max", "ultra"].includes(row.codexUltra.providerEffort ?? "")
      ? {
          codexUltra: { ...row.codexUltra, providerEffort: "xhigh" },
        }
      : {}),
  };
}

/** The explicit catalog overlay wins; otherwise show the shared resolved Ultra. */
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
  return (
    normalizeCodexCatalogReasoningForProvider(row, identity).codexUltra ?? {
      enabled: resolved?.codexUltraOrchestrationEnabled === true,
      ...(resolved?.effortMap.ultra
        ? { providerEffort: resolved.effortMap.ultra }
        : {}),
    }
  );
}
