import contract from "@/config/codexCatalogContract.json";
import type { CodexCatalogModel } from "@/types";

type RecordValue = Record<string, unknown>;
const isRecord = (value: unknown): value is RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * `model_catalog` is a read-only compatibility alias.  A catalog is
 * authoritative only when it has the contract's model array; this lets us
 * recover from malformed legacy data while preserving an explicit `models: []`
 * as a deliberate empty catalog.
 */
function isCodexCatalogContainer(value: unknown): value is RecordValue {
  return (
    isRecord(value) && Array.isArray((value as { models?: unknown }).models)
  );
}

function normalizeAliases(
  value: unknown,
  aliases: Record<string, string[]>,
): unknown {
  if (!isRecord(value)) return value;
  const result = { ...value };
  for (const [canonical, legacy] of Object.entries(aliases)) {
    const keys = [canonical, ...legacy];
    const key = keys.find(
      (candidate) =>
        result[candidate] !== undefined &&
        result[candidate] !== null &&
        !(typeof result[candidate] === "string" && !result[candidate].trim()),
    );
    if (key) result[canonical] = result[key];
    for (const candidate of legacy) delete result[candidate];
  }
  return result;
}

export function normalizeCodexReasoning(value: unknown): unknown {
  const result = normalizeAliases(value, contract.reasoning);
  if (!isRecord(result)) return result;
  result.upstream = normalizeAliases(result.upstream, contract.upstream);
  if (!isRecord(result.upstream)) return result;
  if (result.upstream.format === "object")
    result.upstream.format = "reasoning_object";
  result.supportStatus ??=
    result.supported === true
      ? "confirmed_supported"
      : result.supported === false
        ? "confirmed_unsupported"
        : "unknown";
  delete result.supported;
  const efforts = Array.isArray(result.supportedEfforts)
    ? result.supportedEfforts
    : [];
  result.controlKind ??= efforts.length
    ? "graded"
    : result.upstream.format === "boolean"
      ? "boolean"
      : result.upstream.format === "none"
        ? "none"
        : "unknown";
  result.schemaVersion = 2;
  result.disableAllowed ??= false;
  if (
    typeof result.defaultEffort === "string" &&
    !efforts.includes(result.defaultEffort)
  ) {
    if (efforts.length) result.defaultEffort = efforts[0];
    else delete result.defaultEffort;
  }
  if (
    result.supportStatus === "confirmed_supported" &&
    result.controlKind === "graded" &&
    !["none", "boolean"].includes(String(result.upstream.format))
  ) {
    const map = isRecord(result.upstream.effortMap)
      ? { ...result.upstream.effortMap }
      : {};
    for (const effort of efforts) {
      if (typeof effort === "string" && effort !== "none")
        map[effort] ??= effort;
    }
    result.upstream.effortMap = map;
  }
  return result;
}

export function normalizeCodexCatalogModel<T extends CodexCatalogModel>(
  model: T,
): T {
  const result = normalizeAliases(model, contract.model) as RecordValue;
  normalizeCapabilityFields(result);
  return result as T;
}

function normalizeCapabilityFields(result: RecordValue): void {
  const context = parseCodexContextWindow(result.contextWindow);
  if (context !== undefined) result.contextWindow = context;
  if ("reasoning" in result)
    result.reasoning = normalizeCodexReasoning(result.reasoning);
  if ("codexCache" in result)
    result.codexCache = normalizeAliases(result.codexCache, contract.cache);
}

export function normalizeCodexCatalogSettings(
  settings: RecordValue,
): RecordValue {
  const canonicalCatalog = settings.modelCatalog;
  const legacyCatalog = settings.model_catalog;
  const selectedCatalog = isCodexCatalogContainer(canonicalCatalog)
    ? canonicalCatalog
    : isCodexCatalogContainer(legacyCatalog)
      ? legacyCatalog
      : undefined;
  const result = normalizeAliases(settings, contract.settings) as RecordValue;
  normalizeCapabilityFields(result);
  const catalog = normalizeAliases(
    selectedCatalog ?? result.modelCatalog,
    contract.catalog,
  );
  if (!isRecord(catalog)) return result;
  if (Array.isArray(catalog.models)) {
    catalog.models = catalog.models.map((model) =>
      isRecord(model)
        ? normalizeCodexCatalogModel(model as unknown as CodexCatalogModel)
        : model,
    );
  }
  return {
    ...result,
    ...(selectedCatalog || isRecord(result.modelCatalog)
      ? { modelCatalog: catalog }
      : {}),
  };
}

/**
 * Read the one authoritative Codex catalog representation.
 *
 * New writes must use `modelCatalog`; `model_catalog` is accepted only when
 * the canonical key is absent or malformed.  Never use `??` at call sites:
 * an old duplicate can otherwise reintroduce removed models into routing.
 */
export function readCodexCatalogSettings(
  settings: unknown,
): RecordValue | undefined {
  if (!isRecord(settings)) return undefined;
  const canonical = settings.modelCatalog;
  const legacy = settings.model_catalog;
  const selected = isCodexCatalogContainer(canonical)
    ? canonical
    : isCodexCatalogContainer(legacy)
      ? legacy
      : undefined;
  return selected;
}

export function hasCodexCatalog(settings: unknown): boolean {
  return readCodexCatalogSettings(settings) !== undefined;
}

export function parseCodexContextWindow(value: unknown): number | undefined {
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  if (typeof value !== "string") return undefined;
  const match = value.trim().match(/^(\d+)\s*(k|m|tokens)?$/i);
  if (!match) return undefined;
  const multiplier =
    match[2]?.toLowerCase() === "k"
      ? 1000
      : match[2]?.toLowerCase() === "m"
        ? 1000000
        : 1;
  const result = Number(match[1]) * multiplier;
  return Number.isSafeInteger(result) && result > 0 ? result : undefined;
}
