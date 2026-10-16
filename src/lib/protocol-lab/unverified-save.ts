import type { Provider, UniversalProvider } from "@/types";
import { readCodexCatalogSettings } from "@/lib/codexCatalogSchema";
import { readCodexModelProtocolCapability } from "@/lib/codexProtocolCapability";
import { normalizeCodexPublicModelKey } from "./codex-overrides";

type ManualCodexApiFormat = "openai_chat" | "openai_responses";

function declaredCodexApiFormat(provider: Provider): ManualCodexApiFormat {
  const value = provider.meta?.apiFormat ?? provider.settingsConfig.apiFormat;
  if (value === "openai_chat" || value === "openai_responses") return value;
  throw new Error("codex_provider_set_unverified_protocol_required");
}

export function prepareUnverifiedCodexProvider(provider: Provider): Provider {
  const apiFormat = declaredCodexApiFormat(provider);
  const savedOverrides = new Map(
    Object.entries(provider.meta?.codexProtocolOverrides ?? {})
      .filter(
        ([model, transport]) =>
          normalizeCodexPublicModelKey(model) &&
          (transport === "openai_chat" || transport === "openai_responses"),
      )
      .map(([model, transport]) => [
        normalizeCodexPublicModelKey(model),
        transport,
      ]),
  );
  const catalog = readCodexCatalogSettings(provider.settingsConfig);
  // Only a loaded catalog can establish which existing overrides are stale.
  const protocolOverrides = catalog
    ? new Map<string, ManualCodexApiFormat>()
    : new Map(savedOverrides);
  const rows: unknown[] = Array.isArray(catalog?.models) ? catalog.models : [];
  for (const value of rows) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      continue;
    const row = value as Record<string, unknown>;
    const publicModel = [row.model, row.id, row.slug].find(
      (value) => typeof value === "string",
    );
    if (row.enabled === false || typeof publicModel !== "string") continue;
    const model = normalizeCodexPublicModelKey(publicModel);
    if (!model || protocolOverrides.has(model)) continue;
    const configuredFormat = [
      row.apiFormat,
      row.api_format,
      row.wireApi,
      row.wire_api,
    ]
      .find((value) => typeof value === "string")
      ?.trim()
      .toLowerCase();
    protocolOverrides.set(
      model,
      savedOverrides.get(model) ??
        (configuredFormat === "openai_chat" ||
        configuredFormat === "open_ai_chat" ||
        configuredFormat === "chat"
          ? "openai_chat"
          : configuredFormat === "openai_responses" ||
              configuredFormat === "open_ai_responses" ||
              configuredFormat === "responses"
            ? "openai_responses"
            : (readCodexModelProtocolCapability(provider, {
                ...row,
                model: publicModel,
              }) ?? apiFormat)),
    );
  }
  const meta = {
    ...provider.meta,
    apiFormat,
    codexProtocolMode: "manual" as const,
  };
  delete meta.codexProtocolOverrides;
  if (protocolOverrides.size > 0)
    meta.codexProtocolOverrides = Object.fromEntries(protocolOverrides);
  return {
    ...provider,
    meta,
  };
}

export function prepareUnverifiedUniversalProvider(
  provider: UniversalProvider,
): UniversalProvider {
  if (!provider.apps.codex) return provider;
  const configuredFormat = provider.meta?.apiFormat;
  const apiFormat: ManualCodexApiFormat =
    configuredFormat === "openai_chat" ||
    configuredFormat === "openai_responses"
      ? configuredFormat
      : "openai_responses";
  return {
    ...provider,
    meta: {
      ...provider.meta,
      apiFormat,
      codexProtocolMode: "manual",
    },
  };
}
