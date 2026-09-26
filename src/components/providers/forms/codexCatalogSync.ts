import type { CodexCatalogModel } from "@/types";
import { pruneMissingRemoteCodexCatalogRows } from "@/lib/codexCatalogReconciliation";
import { resolveFetchedCodexModelContextWindow } from "@/utils/codexModelContext";

export { pruneMissingRemoteCodexCatalogRows } from "@/lib/codexCatalogReconciliation";

export type CodexCatalogRowLike = CodexCatalogModel & { rowId?: string };

interface RemoteModelMetadata {
  contextWindow?: number | null;
}

export interface FetchedCodexCatalogModel extends RemoteModelMetadata {
  id: string;
  inputModalities?: string[] | null;
  supportsImage?: boolean | null;
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
  /** Visible row names that the authoritative remote list no longer offers. */
  removedModels: string[];
  /**
   * True when a large one-sided drop was declined as a truncated response.
   * The catalog is kept intact and `removed` is reported as 0.
   */
  removalSuppressed: boolean;
}

export type ExistingCatalogMetadataMode = "fill-missing" | "refresh";

export function catalogModelIdentity(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase();
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
  const upstreamModel = catalogModelIdentity(rowExplicitUpstreamModel(row));
  const identity = upstreamModel || catalogModelIdentity(row.model);
  return identity ? [identity] : [];
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function missingCapabilityPatch(
  row: CodexCatalogRowLike,
  fetched: FetchedCodexCatalogModel,
): Partial<CodexCatalogRowLike> {
  const patch: Partial<CodexCatalogRowLike> = {};
  const existingModalities =
    row.inputModalities ?? row.input_modalities ?? undefined;
  const existingSupportsImage =
    row.supportsImage ?? row.supports_image ?? row.vision ?? undefined;
  const textOnly = row.textOnly ?? row.text_only;
  const declaredImage =
    typeof existingSupportsImage === "boolean"
      ? existingSupportsImage
      : typeof textOnly === "boolean"
        ? !textOnly
        : undefined;
  const fetchedImage = fetched.inputModalities?.length
    ? fetched.inputModalities.some((value) => value.toLowerCase() === "image")
    : fetched.supportsImage;
  if (
    declaredImage !== undefined &&
    typeof fetchedImage === "boolean" &&
    declaredImage !== fetchedImage
  )
    return patch;

  if (!Array.isArray(existingModalities) || existingModalities.length === 0) {
    if (
      Array.isArray(fetched.inputModalities) &&
      fetched.inputModalities.length > 0
    ) {
      patch.inputModalities = [...fetched.inputModalities];
    }
  }
  if (
    !hasValue(existingSupportsImage) &&
    typeof fetched.supportsImage === "boolean"
  ) {
    patch.supportsImage = fetched.supportsImage;
  }

  // Keep textOnly aligned only when it is absent; never contradict a user choice.
  if (!hasValue(row.textOnly ?? row.text_only)) {
    const nextModalities =
      (patch.inputModalities as string[] | undefined) ?? existingModalities;
    if (Array.isArray(nextModalities) && nextModalities.length > 0) {
      patch.textOnly = !nextModalities.some(
        (modality) => modality.toLowerCase() === "image",
      );
    } else if (typeof patch.supportsImage === "boolean") {
      patch.textOnly = !patch.supportsImage;
    }
  }

  return patch;
}

function refreshedCapabilityPatch(
  fetched: FetchedCodexCatalogModel,
): Partial<CodexCatalogRowLike> {
  const patch: Partial<CodexCatalogRowLike> = {};
  const fetchedModalities =
    Array.isArray(fetched.inputModalities) && fetched.inputModalities.length > 0
      ? [...fetched.inputModalities]
      : undefined;
  const fetchedSupportsImage =
    typeof fetched.supportsImage === "boolean"
      ? fetched.supportsImage
      : fetchedModalities
        ? fetchedModalities.some(
            (modality) => modality.toLowerCase() === "image",
          )
        : undefined;

  if (fetchedModalities) {
    patch.inputModalities = fetchedModalities;
  } else if (fetchedSupportsImage !== undefined) {
    patch.inputModalities = fetchedSupportsImage ? ["text", "image"] : ["text"];
  }
  if (fetchedSupportsImage !== undefined) {
    patch.supportsImage = fetchedSupportsImage;
    patch.textOnly = !fetchedSupportsImage;
  }

  return patch;
}

/**
 * Reconcile remote /models results without destroying user intent.
 *
 * Disabled rows are persistent exclusions/tombstones: they are hydrated but
 * never re-enabled, and their identities block duplicate appends. Existing
 * non-empty fields win over discovered metadata.
 */
export function reconcileFetchedCodexCatalogRows<T extends CodexCatalogRowLike>(
  rows: T[],
  fetchedModels: FetchedCodexCatalogModel[],
  source: CodexCatalogSyncSource,
  options: {
    appendNew: boolean;
    createRow: (seed: CodexCatalogRowLike) => T;
    existingMetadataMode?: ExistingCatalogMetadataMode;
    removeMissingRemote?: boolean;
    maxRemovalRatio?: number;
  },
): CatalogSyncResult<T> {
  const next = [...rows];
  const identityByIndex = new Map<number, string[]>();
  const identityToIndex = new Map<string, number>();
  next.forEach((row, index) => {
    const identities = rowIdentities(row);
    identityByIndex.set(index, identities);
    for (const identity of identities) {
      // First row wins on legacy duplicates, preserving current order.
      if (!identityToIndex.has(identity)) identityToIndex.set(identity, index);
    }
  });

  let hydrated = 0;
  let added = 0;
  const updated: string[] = [];

  for (const fetched of fetchedModels) {
    const model = fetched.id.trim();
    if (!model) continue;
    const identity = catalogModelIdentity(model);
    const existingIndex = identityToIndex.get(identity);

    if (existingIndex !== undefined) {
      const row = next[existingIndex];
      const refreshExisting = options.existingMetadataMode === "refresh";
      const contextWindow = resolveFetchedCodexModelContextWindow(fetched, {
        ...source,
        existingModels: rows,
      });
      const patch: Partial<CodexCatalogRowLike> = {};
      // Only persist an upstream binding when it carries information the
      // visible name does not already have. Writing `upstreamModel` for a row
      // whose `model` already equals the remote id looks like a harmless
      // no-op, but it reclassifies a manually maintained row as remotely
      // bound, and `pruneMissingRemoteCodexCatalogRows` then deletes it on the
      // next refresh that omits it. That silent second-pass deletion is what
      // made a saved catalog lose models after an otherwise routine sync.
      if (
        !hasValue(rowExplicitUpstreamModel(row)) &&
        catalogModelIdentity(row.model) !== identity
      ) {
        patch.upstreamModel = model;
      }
      if (
        contextWindow &&
        (refreshExisting ||
          !hasValue(row.contextWindow ?? row.context_window)) &&
        String(row.contextWindow ?? row.context_window ?? "") !==
          String(contextWindow)
      ) {
        patch.contextWindow = String(contextWindow);
      }
      Object.assign(
        patch,
        refreshExisting
          ? refreshedCapabilityPatch(fetched)
          : missingCapabilityPatch(row, fetched),
      );

      const patchRecord = patch as Record<string, unknown>;
      const rowRecord = row as Record<string, unknown>;
      for (const [key, value] of Object.entries(patchRecord)) {
        if (JSON.stringify(rowRecord[key]) === JSON.stringify(value)) {
          delete patchRecord[key];
        }
      }

      if (Object.keys(patch).length > 0) {
        next[existingIndex] = { ...row, ...patch };
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
    const seed: CodexCatalogRowLike = {
      model,
      upstreamModel: model,
      displayName: model,
      ...(contextWindow ? { contextWindow: String(contextWindow) } : {}),
      ...(Array.isArray(fetched.inputModalities) &&
      fetched.inputModalities.length > 0
        ? { inputModalities: [...fetched.inputModalities] }
        : {}),
      ...(typeof fetched.supportsImage === "boolean"
        ? { supportsImage: fetched.supportsImage }
        : {}),
    };
    const capabilityPatch = missingCapabilityPatch(seed, fetched);
    const created = options.createRow({ ...seed, ...capabilityPatch });
    const newIndex = next.length;
    next.push(created);
    added += 1;
    const identities = rowIdentities(created);
    identityByIndex.set(newIndex, identities);
    for (const createdIdentity of identities) {
      if (!identityToIndex.has(createdIdentity)) {
        identityToIndex.set(createdIdentity, newIndex);
      }
    }
  }

  const authoritativeResult = options.removeMissingRemote
    ? pruneMissingRemoteCodexCatalogRows(next, fetchedModels, {
        maxRemovalRatio: options.maxRemovalRatio,
      })
    : {
        rows: next,
        removed: 0,
        removedModels: [] as string[],
        removalSuppressed: false,
      };
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
