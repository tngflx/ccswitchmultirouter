import type {
  CodexApiKeyGroup,
  CodexApiKeyGroupMode,
  CodexCatalogModel,
} from "@/types";
import {
  CODEX_API_KEY_GROUP_ALIAS_MARKER,
  isGeneratedCodexApiKeyGroupModel,
} from "@/lib/codexApiKeyGroup";

const normalized = (value: string | undefined) =>
  value?.trim().toLowerCase() ?? "";

const modelUpstreamName = (model: CodexCatalogModel) =>
  model.upstreamModel?.trim() ||
  model.upstream_model?.trim() ||
  model.model.trim();

const groupMatchesModel = (group: CodexApiKeyGroup, model: string) => {
  const candidate = normalized(model);
  if (!candidate) return false;
  if ((group.models ?? []).some((item) => normalized(item) === candidate))
    return true;
  return (group.prefixes ?? []).some((prefix) => {
    const value = normalized(prefix);
    return Boolean(value) && candidate.startsWith(value);
  });
};

export function normalizeCodexApiKeyGroupMode(
  value: unknown,
): CodexApiKeyGroupMode {
  return value === "round_robin" ? "round_robin" : "isolated";
}

export function baseCodexCatalogModels(models: CodexCatalogModel[]) {
  return models.filter((model) => !isGeneratedCodexApiKeyGroupModel(model));
}

export function buildCodexApiKeyGroupCatalog(
  models: CodexCatalogModel[],
  groups: CodexApiKeyGroup[],
  mode: CodexApiKeyGroupMode,
) {
  const baseModels = baseCodexCatalogModels(models);
  if (mode !== "isolated") return baseModels;

  const result = [...baseModels];
  const seen = new Set(baseModels.map((model) => normalized(model.model)));
  groups.forEach((group, groupIndex) => {
    if (group.enabled === false || !group.id.trim()) return;
    if (!group.apiKeys.some((key) => key.trim())) return;
    const label = group.label?.trim() || `Group ${groupIndex + 1}`;
    baseModels.forEach((baseModel) => {
      const upstreamModel = modelUpstreamName(baseModel);
      if (!groupMatchesModel(group, upstreamModel)) return;
      const alias = `${baseModel.model.trim()}${CODEX_API_KEY_GROUP_ALIAS_MARKER}${group.id.trim()}`;
      const identity = normalized(alias);
      if (!identity || seen.has(identity)) return;
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
    });
  });
  return result;
}
