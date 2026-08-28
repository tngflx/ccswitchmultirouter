import type { CodexCatalogModel } from "@/types";

type RemoteBoundCatalogRow = Pick<
  CodexCatalogModel,
  "upstreamModel" | "upstream_model"
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
>(rows: T[], fetchedModels: Fetched[]): { rows: T[]; removed: number } {
  const fetchedIdentities = new Set(
    fetchedModels.map((model) => normalizedModelId(model.id)).filter(Boolean),
  );
  const retained = rows.filter((row) => {
    const upstream = explicitUpstreamModel(row);
    return !upstream || fetchedIdentities.has(upstream);
  });
  return { rows: retained, removed: rows.length - retained.length };
}
