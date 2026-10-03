import type { CodexCatalogModel } from "@/types";
import { modelIdentityValues, type ModelIdentityShape } from "@/lib/modelIdentities";

export type CodexCatalogRowLike = CodexCatalogModel & { rowId?: string };

export interface FetchedCodexCatalogModel extends ModelIdentityShape {
  id: string;
  canonicalSlug?: string | null;
  slug?: string | null;
  name?: string | null;
  aliases?: string[] | null;
  contextWindow?: number | null;
  inputModalities?: string[] | null;
  supportsImage?: boolean | null;
  reasoning?: CodexCatalogModel["reasoning"] | null;
}

export interface CodexCatalogSyncSource {
  providerId?: string;
  providerName?: string;
  baseUrl?: string;
  websiteUrl?: string;
}

export interface CatalogSyncResult<T extends CodexCatalogRowLike> {
  rows: T[];
  added: number;
  hydrated: number;
  updated: string[];
}

type MetadataMode = "fill-missing" | "refresh";

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const identity = (value: unknown): string => text(value).toLowerCase();

function rowIdentities(row: CodexCatalogRowLike): string[] {
  return modelIdentityValues(row);
}

function explicitUpstream(row: CodexCatalogRowLike): string {
  return identity(row.upstreamModel ?? row.upstream_model);
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function fetchedModelName(fetched: FetchedCodexCatalogModel): string {
  return (
    text(fetched.id) ||
    text(fetched.canonicalSlug) ||
    text(fetched.slug) ||
    text(fetched.name) ||
    text(fetched.aliases?.find((alias) => text(alias)))
  );
}

function identityPatch(
  row: CodexCatalogRowLike,
  fetched: FetchedCodexCatalogModel,
  refresh: boolean,
): Partial<CodexCatalogRowLike> {
  const patch: Partial<CodexCatalogRowLike> = {};
  for (const [key, value] of [
    ["canonicalSlug", fetched.canonicalSlug],
    ["slug", fetched.slug],
    ["name", fetched.name],
  ] as const) {
    const normalized = text(value);
    if (normalized && (refresh || !hasValue(row[key]))) patch[key] = normalized;
  }
  if (Array.isArray(fetched.aliases) && fetched.aliases.length > 0) {
    const aliases = fetched.aliases.map(text).filter(Boolean);
    if (aliases.length > 0 && (refresh || !Array.isArray(row.aliases) || row.aliases.length === 0)) {
      patch.aliases = aliases;
    }
  }
  return patch;
}

function capabilityPatch(
  row: CodexCatalogRowLike,
  fetched: FetchedCodexCatalogModel,
  refresh: boolean,
): Partial<CodexCatalogRowLike> {
  const patch: Partial<CodexCatalogRowLike> = {};
  const modalities = Array.isArray(fetched.inputModalities) && fetched.inputModalities.length > 0
    ? [...fetched.inputModalities]
    : undefined;
  const supportsImage = typeof fetched.supportsImage === "boolean"
    ? fetched.supportsImage
    : modalities?.some((modality) => modality.toLowerCase() === "image");

  if (refresh || !hasValue(row.inputModalities ?? row.input_modalities)) {
    if (modalities) patch.inputModalities = modalities;
  }
  if (typeof supportsImage === "boolean" && (refresh || !hasValue(row.supportsImage ?? row.supports_image ?? row.vision))) {
    patch.supportsImage = supportsImage;
  }
  if (!hasValue(row.textOnly ?? row.text_only) && typeof supportsImage === "boolean") {
    patch.textOnly = !supportsImage;
  }
  if (fetched.reasoning && (refresh ? row.reasoning?.source !== "user" : !row.reasoning)) {
    patch.reasoning = fetched.reasoning;
  }
  return patch;
}

/** Merge a fetched inventory while preserving user-owned catalog decisions. */
export function reconcileFetchedCodexCatalogRows<T extends CodexCatalogRowLike>(
  rows: T[],
  fetchedModels: FetchedCodexCatalogModel[],
  source: CodexCatalogSyncSource,
  options: {
    appendNew: boolean;
    createRow: (seed: CodexCatalogRowLike) => T;
    existingMetadataMode?: MetadataMode;
  },
): CatalogSyncResult<T> {
  void source;
  const next = [...rows];
  const identityToIndex = new Map<string, number>();
  next.forEach((row, index) => {
    for (const value of rowIdentities(row)) {
      if (!identityToIndex.has(value)) identityToIndex.set(value, index);
    }
  });

  let added = 0;
  let hydrated = 0;
  const updated: string[] = [];
  const refresh = options.existingMetadataMode === "refresh";

  for (const fetched of fetchedModels) {
    const model = fetchedModelName(fetched);
    if (!model) continue;
    const fetchedIdentities = modelIdentityValues(fetched);
    const existingIndex = fetchedIdentities
      .map((value) => identityToIndex.get(value))
      .find((value): value is number => value !== undefined);
    if (existingIndex !== undefined) {
      const row = next[existingIndex];
      const patch: Partial<CodexCatalogRowLike> = {
        ...identityPatch(row, fetched, refresh),
        ...capabilityPatch(row, fetched, refresh),
      };
      if (fetched.contextWindow && (refresh || !hasValue(row.contextWindow ?? row.context_window))) {
        patch.contextWindow = String(fetched.contextWindow);
      }
      if (!hasValue(explicitUpstream(row)) && !fetchedIdentities.includes(identity(row.model))) {
        patch.upstreamModel = model;
      }
      const changed = Object.entries(patch).filter(
        ([key, value]) => JSON.stringify(row[key as keyof CodexCatalogRowLike]) !== JSON.stringify(value),
      );
      if (changed.length > 0) {
        const updatedRow = { ...row, ...Object.fromEntries(changed) } as T;
        next[existingIndex] = updatedRow;
        for (const value of rowIdentities(updatedRow)) identityToIndex.set(value, existingIndex);
        hydrated += 1;
        updated.push(model);
      }
      continue;
    }
    if (!options.appendNew) continue;
    const created = options.createRow({
      model,
      upstreamModel: model,
      displayName: model,
      enabled: false,
      ...(fetched.contextWindow ? { contextWindow: String(fetched.contextWindow) } : {}),
      ...identityPatch({ model } as CodexCatalogModel, fetched, true),
      ...capabilityPatch({ model } as CodexCatalogModel, fetched, true),
    });
    next.push(created);
    for (const value of rowIdentities(created)) identityToIndex.set(value, next.length - 1);
    added += 1;
  }

  return { rows: next, added, hydrated, updated };
}
