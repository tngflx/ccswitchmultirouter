import type {
  CodexCatalogModel,
  CodexProtocolOverride,
  Provider,
} from "@/types";
import { readCodexCatalogSettings } from "@/lib/codexCatalogSchema";
import { normalizeCodexPublicModelKey } from "@/lib/protocol-lab/codex-overrides";
import {
  codexApiFormatFromWireApi,
  extractCodexBaseUrl,
  extractCodexWireApi,
} from "@/utils/providerConfigUtils";

type ProtocolProvider = Pick<Provider, "settingsConfig" | "meta">;
export type CodexModelProtocolDeclarationStatus =
  "supported" | "unsupported" | "unavailable";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const trimmedString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

export function normalizeCodexProtocolCapabilityBaseUrl(
  value: unknown,
): string | null {
  const text = trimmedString(value);
  if (!text || /\s/.test(text) || text.includes("?") || text.includes("#")) {
    return null;
  }
  try {
    const url = new URL(text);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      /^[a-z][a-z\d+.-]*:\/\/[^/?#]*@/i.test(text)
    ) {
      return null;
    }
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/** Select a declared transport without claiming authentication or deep verification. */
export function readCodexModelProtocolCapability(
  provider: ProtocolProvider,
  model: CodexCatalogModel | string,
): CodexProtocolOverride | null {
  const inspection = inspectCodexModelProtocolCapability(provider, model);
  return inspection.status === "supported" ? inspection.transport : null;
}

/**
 * Classify a bound provider API declaration without collapsing explicit
 * negative capability metadata into "missing".  A negative declaration is
 * known evidence that the automatic Codex route cannot be used, so callers
 * can avoid opening a paid deep-probe flow while still refusing to route it.
 */
export function codexModelProtocolDeclarationStatus(
  provider: ProtocolProvider,
  model: CodexCatalogModel | string,
): CodexModelProtocolDeclarationStatus {
  return inspectCodexModelProtocolCapability(provider, model).status;
}

function inspectCodexModelProtocolCapability(
  provider: ProtocolProvider,
  model: CodexCatalogModel | string,
): {
  status: CodexModelProtocolDeclarationStatus;
  transport: CodexProtocolOverride | null;
} {
  const row =
    typeof model === "string" ? findCatalogModel(provider, model) : model;
  if (!row || row.enabled === false || !trimmedString(row.model))
    return { status: "unavailable", transport: null };
  const capability: unknown = row.protocolCapability;
  if (
    !isRecord(capability) ||
    capability.schemaVersion !== 1 ||
    capability.source !== "provider_api" ||
    !Array.isArray(capability.supportedEndpoints) ||
    capability.supportedEndpoints.length === 0 ||
    capability.supportedEndpoints.some(
      (endpoint) =>
        endpoint !== "openai_chat" && endpoint !== "openai_responses",
    )
  ) {
    return { status: "unavailable", transport: null };
  }
  let explicitlyUnsupported = false;
  for (const key of [
    "supportsTools",
    "supportsStreaming",
    "supportsToolContinuation",
  ]) {
    if (capability[key] === undefined) continue;
    if (typeof capability[key] !== "boolean") {
      return { status: "unavailable", transport: null };
    }
    explicitlyUnsupported ||= capability[key] === false;
  }
  const currentBaseUrl = normalizeCodexProtocolCapabilityBaseUrl(
    providerBaseUrl(provider),
  );
  if (
    !currentBaseUrl ||
    normalizeCodexProtocolCapabilityBaseUrl(capability.baseUrl) !==
      currentBaseUrl
  ) {
    return { status: "unavailable", transport: null };
  }
  const upstreamModel =
    trimmedString(row.upstreamModel) ||
    trimmedString(row.upstream_model) ||
    trimmedString(row.model);
  if (trimmedString(capability.upstreamModel) !== upstreamModel) {
    return { status: "unavailable", transport: null };
  }

  const configured = configuredTransport(provider);
  let transport: CodexProtocolOverride | null = null;
  if (provider.meta?.isFullUrl === true) {
    const path = new URL(currentBaseUrl).pathname;
    const fullUrlTransport = path.endsWith("/chat/completions")
      ? "openai_chat"
      : path.endsWith("/responses")
        ? "openai_responses"
        : configured;
    transport =
      fullUrlTransport &&
      capability.supportedEndpoints.includes(fullUrlTransport)
        ? fullUrlTransport
        : null;
  } else if (configured && capability.supportedEndpoints.includes(configured)) {
    transport = configured;
  } else {
    transport = capability.supportedEndpoints.includes("openai_responses")
      ? "openai_responses"
      : "openai_chat";
  }
  if (!transport) return { status: "unavailable", transport: null };
  return {
    status: explicitlyUnsupported ? "unsupported" : "supported",
    transport,
  };
}

function findCatalogModel(
  provider: ProtocolProvider,
  publicModel: string,
): CodexCatalogModel | undefined {
  const catalog = readCodexCatalogSettings(provider.settingsConfig);
  const key = normalizeCodexPublicModelKey(publicModel);
  if (!key || !Array.isArray(catalog?.models)) return undefined;
  const models = catalog.models.filter(
    (row) =>
      isRecord(row) &&
      typeof row.model === "string" &&
      normalizeCodexPublicModelKey(row.model) === key,
  );
  return models.length === 1 ? (models[0] as CodexCatalogModel) : undefined;
}

function providerBaseUrl(provider: ProtocolProvider): string | undefined {
  const config = provider.settingsConfig;
  const direct =
    trimmedString(config.base_url) ||
    trimmedString(config.baseURL) ||
    trimmedString(config.baseUrl);
  if (direct) return direct;
  if (isRecord(config.config)) {
    return trimmedString(config.config.base_url) || undefined;
  }
  return extractCodexBaseUrl(config.config);
}

function configuredTransport(
  provider: ProtocolProvider,
): CodexProtocolOverride | undefined {
  const config = provider.settingsConfig;
  for (const value of [
    provider.meta?.apiFormat,
    config.apiFormat,
    config.api_format,
    extractCodexWireApi(config.config),
  ]) {
    const format = codexApiFormatFromWireApi(trimmedString(value));
    if (format === "openai_chat" || format === "openai_responses") {
      return format;
    }
  }
  return undefined;
}
