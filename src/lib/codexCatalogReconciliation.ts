import type { CodexCatalogModel } from "@/types";

type RemoteBoundCatalogRow = Pick<
  CodexCatalogModel,
  "model" | "upstreamModel" | "upstream_model"
>;

function normalizedModelId(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function explicitUpstreamModel(row: RemoteBoundCatalogRow): string {
  return normalizedModelId(row.upstreamModel || row.upstream_model);
}

/**
 * Prune remote-bound rows after a complete authoritative model-list fetch.
 * Rows without an explicit upstream binding are manually maintained and stay.
 */
export function pruneMissingRemoteCodexCatalogRows<
  T extends RemoteBoundCatalogRow,
  Fetched extends { id: string },
>(
  rows: T[],
  fetchedModels: Fetched[],
  options?: {
    /**
     * Refuse to treat a large one-sided drop as an authoritative deletion.
     *
     * Upstream model endpoints intermittently return a truncated list (a
     * partial page, a filtered plan, a degraded gateway). Deleting on that
     * signal is unrecoverable from the user's point of view, so when the fetch
     * would remove an implausible share of the bound rows we keep the catalog
     * and report nothing. `removedModels` still lists them so the UI can tell
     * the user what was *not* deleted.
     */
    maxRemovalRatio?: number;
  },
): {
  rows: T[];
  removed: number;
  removedModels: string[];
  removalSuppressed: boolean;
} {
  const fetchedIdentities = new Set(
    fetchedModels.map((model) => normalizedModelId(model.id)).filter(Boolean),
  );
  const removedModels: string[] = [];
  const boundRows = rows.filter((row) => explicitUpstreamModel(row));
  const candidates = rows.filter((row) => {
    const upstream = explicitUpstreamModel(row);
    if (!upstream || fetchedIdentities.has(upstream)) return true;
    removedModels.push(row.model);
    return false;
  });
  // Opt-in: an explicit user-initiated sync stays authoritative, while the
  // silent background refresh passes a ratio and refuses mass deletion.
  const maxRemovalRatio = options?.maxRemovalRatio ?? 0;
  const removalSuppressed =
    maxRemovalRatio > 0 &&
    boundRows.length > 0 &&
    removedModels.length > 0 &&
    removedModels.length / boundRows.length > maxRemovalRatio;
  if (removalSuppressed) {
    return {
      rows,
      removed: 0,
      removedModels,
      removalSuppressed: true,
    };
  }
  return {
    rows: candidates,
    removed: removedModels.length,
    removedModels,
    removalSuppressed: false,
  };
}
