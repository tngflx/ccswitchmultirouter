/** Compatibility surface for callers that historically imported catalog sync from the form layer. */
export {
  catalogModelIdentity,
  reconcileFetchedCodexCatalogRows,
  pruneMissingRemoteCodexCatalogRows,
} from "@/lib/codexCatalogReconciliation";
export type {
  CatalogSyncResult,
  CodexCatalogRowLike,
  CodexCatalogSyncSource,
  ExistingCatalogMetadataMode,
  FetchedCodexCatalogModel,
} from "@/lib/codexCatalogReconciliation";
export {
  normalizeCodexCatalogModel,
  normalizeCodexCatalogSettings,
  normalizeCodexReasoning,
  parseCodexContextWindow,
} from "@/lib/codexCatalogSchema";
