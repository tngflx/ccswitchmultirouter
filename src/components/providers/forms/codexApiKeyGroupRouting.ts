import type {
  CodexApiKeyGroup,
  CodexApiKeyGroupMode,
  CodexCatalogModel,
} from "@/types";

const GROUP_ALIAS_MARKER = "--ccg-";

function normalized(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function modelUpstreamName(model: CodexCatalogModel): string {
  return (
    model.upstreamModel?.trim() ||
    model.upstream_model?.trim() ||
    model.model.trim()
  );
}

function groupMatchesModel(group: CodexApiKeyGroup, model: string): boolean {
  const candidate = normalized(model);
  if (!candidate) return false;
  if ((group.models ?? []).some((item) => normalized(item) === candidate)) {
    return true;
  }
  return (group.prefixes ?? []).some((prefix) => {
    const value = normalized(prefix);
    return Boolean(value) && candidate.startsWith(value);
  });
}

function isGeneratedGroupModel(model: CodexCatalogModel): boolean {
  return (
    model.apiKeyGroupGenerated === true ||
    model.api_key_group_generated === true ||
    Boolean(model.apiKeyGroupId || model.api_key_group_id)
  );
}

export function normalizeCodexApiKeyGroupMode(
  value: unknown,
): CodexApiKeyGroupMode {
  return value === "round_robin" ? "round_robin" : "isolated";
}

export function baseCodexCatalogModels(
  models: CodexCatalogModel[],
): CodexCatalogModel[] {
  return models.filter((model) => !isGeneratedGroupModel(model));
}

export function buildCodexApiKeyGroupCatalog(
  models: CodexCatalogModel[],
  groups: CodexApiKeyGroup[],
  mode: CodexApiKeyGroupMode,
): CodexCatalogModel[] {
  const baseModels = baseCodexCatalogModels(models);
  if (mode !== "isolated") return baseModels;

  const result = [...baseModels];
  const seen = new Set(baseModels.map((model) => normalized(model.model)));

  groups.forEach((group, groupIndex) => {
    if (group.enabled === false || !group.id.trim()) return;
    if (!group.apiKeys.some((key) => key.trim())) return;
    const label = group.label?.trim() || `Group ${groupIndex + 1}`;

    for (const baseModel of baseModels) {
      const upstreamModel = modelUpstreamName(baseModel);
      if (!groupMatchesModel(group, upstreamModel)) continue;

      const alias = `${baseModel.model.trim()}${GROUP_ALIAS_MARKER}${group.id.trim()}`;
      const identity = normalized(alias);
      if (!identity || seen.has(identity)) continue;
      seen.add(identity);

      result.push({
        ...baseModel,
        model: alias,
        upstreamModel,
        displayName: `${baseModel.displayName?.trim() || baseModel.model.trim()} [${label}]`,
        apiKeyGroupId: group.id.trim(),
        apiKeyGroupGenerated: true,
        sortIndex: undefined,
      });
    }
  });

  return result;
}
