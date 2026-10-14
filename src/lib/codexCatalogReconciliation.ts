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

/** A single key's model list cannot describe a provider with independent key groups. */
export function isCompleteCodexCatalogFetch(apiKeyGroups: unknown): boolean {
  return (
    !Array.isArray(apiKeyGroups) ||
    !apiKeyGroups.some(
      (group) =>
        Array.isArray(group?.apiKeys) &&
        group.apiKeys.some(
          (key: unknown) => typeof key === "string" && key.trim(),
        ),
    )
  );
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
  if (patch.inputModalities) patch.input_modalities = patch.inputModalities;
  if (typeof patch.supportsImage === "boolean")
    patch.supports_image = patch.supportsImage;
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
  options?: {
    maxRemovalRatio?: number;
    /** Treat rows without an explicit upstream binding as remote inventory too. */
    includeUnboundRows?: boolean;
    /** Keep the row for editing, but make an absent remote model non-routable. */
    markMissingDisabled?: boolean;
  },
): Pick<
  CatalogSyncResult<T>,
  "rows" | "removed" | "removedModels" | "removalSuppressed"
> {
  const fetchedIdentities = new Set(
    fetchedModels.flatMap((model) => modelIdentityValues(model)),
  );
  const consideredRows = rows.filter(
    (row) =>
      options?.includeUnboundRows === true || rowExplicitUpstreamModel(row),
  );
  const missingRows = new Set(
    consideredRows.filter(
      (row) =>
        !rowIdentities(row).some((identity) => fetchedIdentities.has(identity)),
    ),
  );
  const removedModels = [...missingRows]
    .filter((row) => !options?.markMissingDisabled || row.enabled !== false)
    .map((row) => row.model);
  const consideredCount = options?.markMissingDisabled
    ? consideredRows.filter((row) => row.enabled !== false).length
    : consideredRows.length;
  const maxRemovalRatio = options?.maxRemovalRatio ?? 0;
  const removalSuppressed =
    maxRemovalRatio > 0 &&
    consideredCount > 0 &&
    removedModels.length > 0 &&
    removedModels.length / consideredCount > maxRemovalRatio;
  if (removalSuppressed) {
    return { rows, removed: 0, removedModels, removalSuppressed: true };
  }
  if (options?.markMissingDisabled) {
    return {
      rows: rows.map((row) =>
        missingRows.has(row) && row.enabled !== false
          ? ({ ...row, enabled: false } as T)
          : row,
      ),
      removed: 0,
      removedModels,
      removalSuppressed: false,
    };
  }
  return {
    rows: rows.filter((row) => !missingRows.has(row)),
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
    includeUnboundRemoteRows?: boolean;
    markMissingRemoteDisabled?: boolean;
    newRowEnabled?: boolean;
    contextWindowFormat?: "number" | "string";
    inferContextWindow?: boolean;
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
  const resolveContextWindow = (fetched: FetchedCodexCatalogModel) =>
    options.inferContextWindow === false
      ? (fetched.contextWindow ?? undefined)
      : resolveFetchedCodexModelContextWindow(fetched, {
          ...source,
          existingModels: rows,
        });

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
      const contextWindow = resolveContextWindow(fetched);
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
        patch.contextWindow =
          options.contextWindowFormat === "number"
            ? contextWindow
            : String(contextWindow);
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
    const contextWindow = resolveContextWindow(fetched);
    const seed: CodexCatalogRowSeed = {
      model,
      upstreamModel: model,
      displayName: model,
      ...(options.newRowEnabled !== undefined
        ? { enabled: options.newRowEnabled }
        : { enabled: false }),
      ...(contextWindow
        ? {
            contextWindow:
              options.contextWindowFormat === "number"
                ? contextWindow
                : String(contextWindow),
          }
        : {}),
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
      ...(refresh
        ? refreshedCapabilityPatch(seed as CodexCatalogRowLike, fetched)
        : missingCapabilityPatch(seed as CodexCatalogRowLike, fetched)),
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
        includeUnboundRows: options.includeUnboundRemoteRows,
        markMissingDisabled: options.markMissingRemoteDisabled,
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
