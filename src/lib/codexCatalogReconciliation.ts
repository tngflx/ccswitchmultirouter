import type { CodexCatalogModel } from "@/types";
import { resolveFetchedCodexModelContextWindow } from "@/utils/codexModelContext";
import {
  modelBindingIdentityValues,
  modelIdentityValues,
  type ModelIdentityShape,
} from "@/lib/modelIdentities";

export type CodexCatalogRowLike = CodexCatalogModel &
  ModelIdentityShape & { rowId?: string };
export type CodexCatalogRowSeed = Partial<CodexCatalogModel> &
  Record<string, unknown>;

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
  removed: number;
  removedModels: string[];
  removalSuppressed: boolean;
}

export type ExistingCatalogMetadataMode = "fill-missing" | "refresh";

export function catalogModelIdentity(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function nonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function rowExplicitUpstreamModel(row: CodexCatalogRowLike): string {
  return (
    nonEmptyString(row.upstreamModel) || nonEmptyString(row.upstream_model)
  );
}

function rowIdentities(row: CodexCatalogRowLike): string[] {
  return modelBindingIdentityValues(row);
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function missingCapabilityPatch(
  row: CodexCatalogRowLike,
  fetched: FetchedCodexCatalogModel,
): Partial<CodexCatalogRowLike> {
  const patch: Partial<CodexCatalogRowLike> = {};
  const fetchedModalities = fetched.inputModalities?.length
    ? [...fetched.inputModalities]
    : undefined;
  const fetchedImage =
    typeof fetched.supportsImage === "boolean"
      ? fetched.supportsImage
      : fetchedModalities?.some((value) => value.toLowerCase() === "image");
  if (fetchedModalities) patch.inputModalities = fetchedModalities;
  if (typeof fetchedImage === "boolean") patch.supportsImage = fetchedImage;
  if (!row.reasoning && fetched.reasoning) patch.reasoning = fetched.reasoning;
  return patch;
}

function refreshedCapabilityPatch(
  row: CodexCatalogRowLike,
  fetched: FetchedCodexCatalogModel,
): Partial<CodexCatalogRowLike> {
  const patch = missingCapabilityPatch(row, fetched);
  if (fetched.reasoning && row.reasoning?.source !== "user") {
    patch.reasoning = fetched.reasoning;
  }
  return patch;
}

function fetchedIdentityPatch(
  row: Partial<CodexCatalogRowLike>,
  fetched: FetchedCodexCatalogModel,
  refresh: boolean,
): Partial<CodexCatalogRowLike> {
  const patch: Partial<CodexCatalogRowLike> = {};
  for (const [key, value] of [
    ["canonicalSlug", fetched.canonicalSlug],
    ["slug", fetched.slug],
    ["name", fetched.name],
  ] as const) {
    const normalized = nonEmptyString(value);
    if (normalized && (refresh || !hasValue(row[key]))) patch[key] = normalized;
  }
  if (fetched.aliases?.length) {
    const aliases = fetched.aliases.map(nonEmptyString).filter(Boolean);
    if (
      aliases.length > 0 &&
      (refresh || !Array.isArray(row.aliases) || row.aliases.length === 0)
    ) {
      patch.aliases = aliases;
    }
  }
  return patch;
}

/** Remove explicitly remote-bound rows absent from a complete authoritative fetch. */
export function pruneMissingRemoteCodexCatalogRows<
  T extends CodexCatalogRowLike,
  Fetched extends ModelIdentityShape,
>(
  rows: T[],
  fetchedModels: Fetched[],
  options?: { maxRemovalRatio?: number },
): Pick<
  CatalogSyncResult<T>,
  "rows" | "removed" | "removedModels" | "removalSuppressed"
> {
  const fetchedIdentities = new Set(
    fetchedModels.flatMap((model) => modelIdentityValues(model)),
  );
  const boundRows = rows.filter((row) => rowExplicitUpstreamModel(row));
  const removedModels: string[] = [];
  const candidates = rows.filter((row) => {
    const upstream = catalogModelIdentity(rowExplicitUpstreamModel(row));
    if (!upstream || fetchedIdentities.has(upstream)) return true;
    removedModels.push(row.model);
    return false;
  });
  const maxRemovalRatio = options?.maxRemovalRatio ?? 0;
  const removalSuppressed =
    maxRemovalRatio > 0 &&
    boundRows.length > 0 &&
    removedModels.length > 0 &&
    removedModels.length / boundRows.length > maxRemovalRatio;
  return removalSuppressed
    ? { rows, removed: 0, removedModels, removalSuppressed: true }
    : {
        rows: candidates,
        removed: removedModels.length,
        removedModels,
        removalSuppressed: false,
      };
}

/** Reconcile remote /models results without destroying user intent. */
export function reconcileFetchedCodexCatalogRows<T extends CodexCatalogRowLike>(
  rows: T[],
  fetchedModels: FetchedCodexCatalogModel[],
  source: CodexCatalogSyncSource,
  options: {
    appendNew: boolean;
    createRow: (seed: CodexCatalogRowSeed) => T;
    existingMetadataMode?: ExistingCatalogMetadataMode;
    removeMissingRemote?: boolean;
    maxRemovalRatio?: number;
  },
): CatalogSyncResult<T> {
  // Preserve the row-layer representation (notably string context windows) while
  // matching identities through the shared model identity contract.
  const next = [...rows];
  const identityToIndex = new Map<string, number>();
  next.forEach((row, index) => {
    for (const identity of rowIdentities(row)) {
      if (!identityToIndex.has(identity)) identityToIndex.set(identity, index);
    }
  });
  let hydrated = 0;
  let added = 0;
  const updated: string[] = [];
  const refresh = options.existingMetadataMode === "refresh";

  for (const fetched of fetchedModels) {
    const model =
      nonEmptyString(fetched.id) ||
      nonEmptyString(fetched.canonicalSlug) ||
      nonEmptyString(fetched.slug) ||
      nonEmptyString(fetched.name) ||
      nonEmptyString(fetched.aliases?.[0]);
    const fetchedIdentities = modelIdentityValues(fetched);
    if (!model || fetchedIdentities.length === 0) continue;
    const existingIndex = fetchedIdentities
      .map((identity) => identityToIndex.get(identity))
      .find((index): index is number => index !== undefined);
    if (existingIndex !== undefined) {
      const row = next[existingIndex];
      const contextWindow = resolveFetchedCodexModelContextWindow(fetched, {
        ...source,
        existingModels: rows,
      });
      const patch: Partial<CodexCatalogRowLike> = {};
      if (
        !hasValue(rowExplicitUpstreamModel(row)) &&
        !fetchedIdentities.includes(catalogModelIdentity(row.model))
      ) {
        patch.upstreamModel = model;
      }
      if (
        contextWindow &&
        (refresh || !hasValue(row.contextWindow ?? row.context_window)) &&
        String(row.contextWindow ?? row.context_window ?? "") !==
          String(contextWindow)
      ) {
        patch.contextWindow = String(contextWindow);
      }
      Object.assign(
        patch,
        refresh
          ? refreshedCapabilityPatch(row, fetched)
          : missingCapabilityPatch(row, fetched),
      );
      Object.assign(patch, fetchedIdentityPatch(row, fetched, refresh));
      const patchRecord = patch as Record<string, unknown>;
      const rowRecord = row as Record<string, unknown>;
      for (const [key, value] of Object.entries(patchRecord)) {
        if (JSON.stringify(rowRecord[key]) === JSON.stringify(value))
          delete patchRecord[key];
      }
      if (Object.keys(patch).length > 0) {
        const updatedRow = { ...row, ...patch } as T;
        next[existingIndex] = updatedRow;
        for (const identity of rowIdentities(updatedRow))
          identityToIndex.set(identity, existingIndex);
        hydrated += 1;
        updated.push(model);
      }
      continue;
    }
    if (!options.appendNew) continue;
    const contextWindow = resolveFetchedCodexModelContextWindow(fetched, {
      ...source,
      existingModels: rows,
    });
    const seed: CodexCatalogRowSeed = {
      model,
      upstreamModel: model,
      displayName: model,
      enabled: false,
      ...(contextWindow ? { contextWindow: String(contextWindow) } : {}),
      ...fetchedIdentityPatch({}, fetched, true),
      ...(fetched.inputModalities?.length
        ? { inputModalities: [...fetched.inputModalities] }
        : {}),
      ...(typeof fetched.supportsImage === "boolean"
        ? { supportsImage: fetched.supportsImage }
        : {}),
      ...(fetched.reasoning ? { reasoning: fetched.reasoning } : {}),
    };
    const created = options.createRow({
      ...seed,
      ...missingCapabilityPatch(seed as CodexCatalogRowLike, fetched),
    });
    next.push(created);
    for (const identity of rowIdentities(created)) {
      if (!identityToIndex.has(identity))
        identityToIndex.set(identity, next.length - 1);
    }
    added += 1;
  }

  const authoritativeResult = options.removeMissingRemote
    ? pruneMissingRemoteCodexCatalogRows(next, fetchedModels, {
        maxRemovalRatio: options.maxRemovalRatio,
      })
    : { rows: next, removed: 0, removedModels: [], removalSuppressed: false };
  return {
    rows: authoritativeResult.rows,
    added,
    hydrated,
    updated,
    removed: authoritativeResult.removed,
    removedModels: authoritativeResult.removedModels,
    removalSuppressed: authoritativeResult.removalSuppressed,
  };
}
