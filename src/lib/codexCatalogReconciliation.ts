import type { CodexCatalogModel } from "@/types";
import { resolveFetchedCodexModelContextWindow } from "@/utils/codexModelContext";
import {
  modelBindingIdentityValues,
  modelIdentityValues,
  normalizeModelIdentityMetadata,
  type ModelIdentityShape,
} from "@/lib/modelIdentities";

export type CodexCatalogRowLike = CodexCatalogModel &
  ModelIdentityShape & { rowId?: string };
export type CodexCatalogRowSeed = Partial<CodexCatalogModel> &
  Record<string, unknown>;

export interface FetchedCodexCatalogModel extends ModelIdentityShape {
  id: string;
  upstreamModel?: string | null;
  displayName?: string | null;
  canonicalSlug?: string | null;
  slug?: string | null;
  name?: string | null;
  aliases?: string[] | Record<string, string> | null;
  contextWindow?: number | null;
  inputModalities?: string[] | null;
  supportsImage?: boolean | null;
  supportsParallelToolCalls?: boolean | null;
  protocolCapability?: CodexCatalogModel["protocolCapability"] | null;
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
  refreshModalities = false,
): Partial<CodexCatalogRowLike> {
  const patch: Partial<CodexCatalogRowLike> = {};
  const fetchedModalities = fetched.inputModalities?.length
    ? [...fetched.inputModalities]
    : undefined;
  const currentModalities = row.inputModalities ?? row.input_modalities;
  const currentImage = row.supportsImage ?? row.supports_image ?? row.vision;
  const fetchedImage =
    typeof fetched.supportsImage === "boolean"
      ? fetched.supportsImage
      : fetchedModalities?.some((value) => value.toLowerCase() === "image");
  if (
    fetchedModalities &&
    (refreshModalities ||
      (!Array.isArray(currentModalities) &&
        (typeof currentImage !== "boolean" ||
          currentImage ===
            fetchedModalities.some(
              (value) => value.toLowerCase() === "image",
            ))))
  ) {
    patch.inputModalities = fetchedModalities;
  }
  if (
    typeof fetchedImage === "boolean" &&
    (refreshModalities ||
      (typeof currentImage !== "boolean" &&
        (!Array.isArray(currentModalities) ||
          fetchedImage ===
            currentModalities.some(
              (value) => value.toLowerCase() === "image",
            ))))
  ) {
    patch.supportsImage = fetchedImage;
  }
  if (
    typeof fetched.supportsParallelToolCalls === "boolean" &&
    typeof (
      row.supportsParallelToolCalls ?? row.supports_parallel_tool_calls
    ) !== "boolean"
  ) {
    patch.supportsParallelToolCalls = fetched.supportsParallelToolCalls;
  }
  if (fetched.protocolCapability) {
    patch.protocolCapability = fetched.protocolCapability;
  }
  // Provider metadata is authoritative for automatic/built-in declarations,
  // but an explicit user declaration remains the single source of truth.
  if (fetched.reasoning && row.reasoning?.source !== "user") {
    patch.reasoning = fetched.reasoning;
  }
  return patch;
}

function refreshedCapabilityPatch(
  row: CodexCatalogRowLike,
  fetched: FetchedCodexCatalogModel,
): Partial<CodexCatalogRowLike> {
  const patch = missingCapabilityPatch(row, fetched, true);
  if (patch.inputModalities) patch.input_modalities = patch.inputModalities;
  if (typeof patch.supportsImage === "boolean")
    patch.supports_image = patch.supportsImage;
  if (typeof patch.supportsParallelToolCalls === "boolean") {
    patch.supports_parallel_tool_calls = patch.supportsParallelToolCalls;
  }
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
  const identity = normalizeModelIdentityMetadata(fetched);
  for (const key of ["canonicalSlug", "slug", "name"] as const) {
    const value = identity[key];
    if (value && (refresh || !hasValue(row[key]))) patch[key] = value;
  }
  if (identity.aliases) {
    if (!row.aliases || Object.keys(row.aliases).length === 0) {
      patch.aliases = identity.aliases;
    }
  }
  const displayName =
    nonEmptyString(fetched.displayName) || nonEmptyString(fetched.name);
  const currentDisplayName =
    nonEmptyString(row.displayName) || nonEmptyString(row.display_name);
  if (
    displayName &&
    (!currentDisplayName ||
      currentDisplayName === nonEmptyString(row.model) ||
      currentDisplayName === nonEmptyString(row.upstreamModel))
  ) {
    patch.displayName = displayName;
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
  const requestIdentityOwners = new Map<string, number | null>();
  const identityOwners = new Map<string, number | null>();
  // Resolve ownership from the complete inventory before any row is changed.
  // Exact request IDs win; overlapping aliases never choose an arbitrary model.
  const registerIdentity = (
    owners: Map<string, number | null>,
    identity: string,
    index: number,
  ) => {
    if (!owners.has(identity)) {
      owners.set(identity, index);
    } else if (owners.get(identity) !== index) {
      owners.set(identity, null);
    }
  };
  fetchedModels.forEach((fetched, index) => {
    const requestIdentity =
      catalogModelIdentity(fetched.id) ||
      catalogModelIdentity(fetched.upstreamModel) ||
      catalogModelIdentity(fetched.upstream_model);
    if (!requestIdentity) return;
    registerIdentity(requestIdentityOwners, requestIdentity, index);
    for (const identity of modelIdentityValues(fetched)) {
      registerIdentity(identityOwners, identity, index);
    }
  });
  const existingIndicesByFetchedIndex = new Map<number, number[]>();
  rows.forEach((row, index) => {
    const requestIdentity = catalogModelIdentity(
      rowExplicitUpstreamModel(row) || row.model,
    );
    let fetchedIndex = requestIdentityOwners.get(requestIdentity);
    if (fetchedIndex === undefined) {
      const owners = new Set(
        rowIdentities(row)
          .map((identity) =>
            requestIdentityOwners.has(identity)
              ? requestIdentityOwners.get(identity)
              : identityOwners.get(identity),
          )
          .filter((owner) => owner !== undefined),
      );
      if (owners.size === 1) fetchedIndex = owners.values().next().value;
    }
    if (typeof fetchedIndex !== "number") return;
    const indices = existingIndicesByFetchedIndex.get(fetchedIndex) ?? [];
    indices.push(index);
    existingIndicesByFetchedIndex.set(fetchedIndex, indices);
  });
  let hydrated = 0;
  let added = 0;
  const updated: string[] = [];
  const updatedIndices = new Set<number>();
  const protocolDeclarationIndices = new Set<number>();
  const refresh = options.existingMetadataMode === "refresh";
  const resolveContextWindow = (fetched: FetchedCodexCatalogModel) =>
    options.inferContextWindow === false
      ? (fetched.contextWindow ?? undefined)
      : resolveFetchedCodexModelContextWindow(fetched, {
          ...source,
          existingModels: rows,
        });

  for (const [fetchedIndex, fetched] of fetchedModels.entries()) {
    const wireModel =
      nonEmptyString(fetched.upstreamModel) ||
      nonEmptyString(fetched.upstream_model) ||
      nonEmptyString(fetched.id);
    const model = nonEmptyString(fetched.id) || wireModel;
    const fetchedIdentities = modelIdentityValues(fetched);
    if (!wireModel || !model || fetchedIdentities.length === 0) continue;
    const existingIndices = existingIndicesByFetchedIndex.get(fetchedIndex);
    for (const existingIndex of existingIndices ?? []) {
      const row = next[existingIndex];
      if (fetched.protocolCapability) {
        protocolDeclarationIndices.add(existingIndex);
      }
      const contextWindow = resolveContextWindow(fetched);
      const patch: Partial<CodexCatalogRowLike> = {};
      const currentUpstream = rowExplicitUpstreamModel(row);
      const fetchedWireIdentities = modelIdentityValues({
        id: fetched.id,
        upstreamModel: fetched.upstreamModel,
        upstream_model: fetched.upstream_model,
        aliases: fetched.aliases,
      });
      if (
        (!currentUpstream &&
          catalogModelIdentity(wireModel) !==
            catalogModelIdentity(row.model)) ||
        (refresh &&
          currentUpstream &&
          catalogModelIdentity(currentUpstream) !==
            catalogModelIdentity(wireModel) &&
          fetchedWireIdentities.includes(catalogModelIdentity(currentUpstream)))
      ) {
        patch.upstreamModel = wireModel;
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
        hydrated += 1;
        updated.push(model);
        updatedIndices.add(existingIndex);
      }
    }
    if (existingIndices?.length) continue;
    if (!options.appendNew) continue;
    const contextWindow = resolveContextWindow(fetched);
    const seed: CodexCatalogRowSeed = {
      model,
      upstreamModel: wireModel,
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
      ...(typeof fetched.supportsParallelToolCalls === "boolean"
        ? { supportsParallelToolCalls: fetched.supportsParallelToolCalls }
        : {}),
      ...(fetched.reasoning ? { reasoning: fetched.reasoning } : {}),
      ...(fetched.protocolCapability
        ? { protocolCapability: fetched.protocolCapability }
        : {}),
    };
    const created = options.createRow({
      ...seed,
      ...(refresh
        ? refreshedCapabilityPatch(seed as CodexCatalogRowLike, fetched)
        : missingCapabilityPatch(seed as CodexCatalogRowLike, fetched)),
    });
    next.push(created);
    if (fetched.protocolCapability) {
      protocolDeclarationIndices.add(next.length - 1);
    }
    added += 1;
  }

  // A complete successful refresh owns API declarations too. Partial key-group
  // fetches and failures must not erase the last usable capability snapshot.
  if (options.removeMissingRemote) {
    next.forEach((row, index) => {
      if (
        row.protocolCapability === undefined ||
        protocolDeclarationIndices.has(index)
      ) {
        return;
      }
      const { protocolCapability: _capability, ...updatedRow } = row;
      next[index] = updatedRow as T;
      if (!updatedIndices.has(index)) {
        hydrated += 1;
        updated.push(row.model);
      }
    });
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
