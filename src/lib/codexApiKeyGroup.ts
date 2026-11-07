import type { CodexCatalogModel } from "@/types";

/** Reserved suffix used for generated isolated API-key-group picker rows. */
export const CODEX_API_KEY_GROUP_ALIAS_MARKER = "--ccg-";

/**
 * Identify a generated credential-group catalog row across legacy and current
 * persisted shapes. Marker-only aliases remain generated when their optional
 * metadata is absent, so inherited base identities cannot leak into lookups.
 */
export function isGeneratedCodexApiKeyGroupModel(
  model: Pick<
    CodexCatalogModel,
    | "model"
    | "apiKeyGroupGenerated"
    | "api_key_group_generated"
    | "apiKeyGroupId"
    | "api_key_group_id"
  >,
): boolean {
  return (
    model.apiKeyGroupGenerated === true ||
    model.api_key_group_generated === true ||
    Boolean(model.apiKeyGroupId || model.api_key_group_id) ||
    model.model.toLowerCase().includes(CODEX_API_KEY_GROUP_ALIAS_MARKER)
  );
}
