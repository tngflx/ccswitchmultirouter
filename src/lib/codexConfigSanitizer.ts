import {
  modelIdentityValues,
  type ModelIdentityShape,
} from "@/lib/modelIdentities";
import type {
  CodexApiKeyGroup,
  CodexCatalogModel,
  CodexProtocolOverride,
  CodexRoutingConfig,
} from "@/types";

type ModelReferenceRecord = Record<string, unknown>;

export interface CodexModelReferenceIndex {
  resolve(value: unknown): string | undefined;
  upstreamFor(value: unknown): string | undefined;
}

export type CodexRouteModelIndexResolver = (
  targetProviderId: string,
) => CodexModelReferenceIndex | undefined;

const normalized = (value: unknown): string =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

const trimmed = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const sameIdentity = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

/**
 * Build a single source of truth for model references.
 *
 * Only enabled rows should be passed here. If two rows advertise the same
 * alias, it is deliberately treated as ambiguous and pruned rather than
 * silently routing traffic to the wrong model.
 */
export function buildCodexModelReferenceIndex(
  models: CodexCatalogModel[],
): CodexModelReferenceIndex {
  const canonicalByIdentity = new Map<string, string>();
  const canonicalIdentities = new Set<string>();
  const ambiguousIdentities = new Set<string>();
  const upstreamByCanonical = new Map<string, string>();

  // A catalog's own picker IDs take precedence over another row's aliases
  // or shared upstream name.
  for (const model of models) {
    const canonical = trimmed(model.model);
    if (!canonical || model.enabled === false) continue;
    const key = normalized(canonical);
    canonicalByIdentity.set(key, canonical);
    canonicalIdentities.add(key);
  }

  for (const model of models) {
    const canonical = trimmed(model.model);
    if (!canonical || model.enabled === false) continue;
    const canonicalKey = normalized(canonical);
    if (!canonicalKey) continue;

    const upstream =
      trimmed(model.upstreamModel) ||
      trimmed(model.upstream_model) ||
      canonical;
    upstreamByCanonical.set(canonicalKey, upstream);

    // Credential-group rows inherit the base row's slug/alias metadata but
    // have their own generated picker id. Re-indexing inherited identities
    // would make the base model look ambiguous and prune valid references.
    const isGeneratedGroupModel =
      model.apiKeyGroupGenerated === true ||
      model.api_key_group_generated === true ||
      Boolean(model.apiKeyGroupId || model.api_key_group_id);
    const identities = isGeneratedGroupModel
      ? [canonical]
      : modelIdentityValues(model as ModelIdentityShape);

    for (const identity of identities) {
      if (canonicalIdentities.has(identity)) continue;
      if (ambiguousIdentities.has(identity)) continue;
      const existing = canonicalByIdentity.get(identity);
      if (existing && !sameIdentity(existing, canonical)) {
        canonicalByIdentity.delete(identity);
        ambiguousIdentities.add(identity);
        continue;
      }
      canonicalByIdentity.set(identity, canonical);
    }
  }

  const resolve = (value: unknown): string | undefined => {
    const key = normalized(value);
    return key && !ambiguousIdentities.has(key)
      ? canonicalByIdentity.get(key)
      : undefined;
  };

  return {
    resolve,
    upstreamFor(value: unknown): string | undefined {
      const canonical = resolve(value);
      return canonical
        ? (upstreamByCanonical.get(normalized(canonical)) ?? canonical)
        : undefined;
    },
  };
}

export function canonicalizeCodexModelReferences(
  values: unknown,
  index: CodexModelReferenceIndex,
  limit?: number,
): string[] {
  if (!Array.isArray(values)) return [];
  const result: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const canonical = index.resolve(value);
    const key = normalized(canonical);
    if (!canonical || !key || seen.has(key)) continue;
    seen.add(key);
    result.push(canonical);
    if (limit !== undefined && result.length >= limit) break;
  }
  return result;
}

/** Resolve historical route-visible names only through a current source row. */
export function resolveCodexRouteModelReference(
  value: unknown,
  index: CodexModelReferenceIndex,
  aliases?: ModelReferenceRecord,
): string | undefined {
  const direct = index.resolve(value);
  if (direct) return direct;
  const key = normalized(value);
  if (!key || !aliases) return undefined;
  const targets = new Set(
    Object.entries(aliases)
      .filter(([alias]) => normalized(alias) === key)
      .map(([, target]) => index.resolve(target))
      .filter((target): target is string => Boolean(target)),
  );
  return targets.size === 1 ? targets.values().next().value : undefined;
}

const normalizedProfileKey = (value: string): string =>
  value.trim().normalize("NFKC").toLowerCase();

function sanitizeSubagentV2(
  value: unknown,
  index: CodexModelReferenceIndex,
): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const source = value as ModelReferenceRecord;
  const profiles =
    source.profiles && typeof source.profiles === "object"
      ? (source.profiles as ModelReferenceRecord)
      : undefined;
  if (!profiles) return { ...source };

  const nextProfiles: ModelReferenceRecord = {};
  for (const [profileKey, rawProfile] of Object.entries(profiles)) {
    if (
      !rawProfile ||
      typeof rawProfile !== "object" ||
      Array.isArray(rawProfile)
    )
      continue;
    const profile = rawProfile as ModelReferenceRecord;
    const canonical = index.resolve(profile.model) ?? index.resolve(profileKey);
    if (!canonical) continue;
    const key = normalizedProfileKey(canonical);
    if (!key || nextProfiles[key]) continue;
    nextProfiles[key] = { ...profile, model: canonical };
  }

  return { ...source, profiles: nextProfiles };
}

function sanitizeLegacyRoute(
  route: ModelReferenceRecord,
  index: CodexModelReferenceIndex,
  upstreamIndex: CodexModelReferenceIndex = index,
): ModelReferenceRecord {
  const next = { ...route };
  const legacyUpstream =
    route.upstream &&
    typeof route.upstream === "object" &&
    !Array.isArray(route.upstream)
      ? (route.upstream as ModelReferenceRecord)
      : undefined;
  const modelMap =
    legacyUpstream?.modelMap &&
    typeof legacyUpstream.modelMap === "object" &&
    !Array.isArray(legacyUpstream.modelMap)
      ? (legacyUpstream.modelMap as ModelReferenceRecord)
      : undefined;
  const canonicalModelForRouteAlias = (value: unknown): string | undefined => {
    const direct = index.resolve(value);
    if (direct) return direct;
    const rawAlias = trimmed(value);
    if (!rawAlias || !modelMap) return undefined;
    const mapping = Object.entries(modelMap).find(([alias]) =>
      sameIdentity(alias, rawAlias),
    );
    return mapping && upstreamIndex.resolve(mapping[1])
      ? mapping[0].trim()
      : undefined;
  };
  const match =
    route.match &&
    typeof route.match === "object" &&
    !Array.isArray(route.match)
      ? (route.match as ModelReferenceRecord)
      : undefined;
  if (match) {
    next.match = {
      ...match,
      ...(Array.isArray(match.models)
        ? {
            models: Array.from(
              new Set(
                match.models
                  .map(canonicalModelForRouteAlias)
                  .filter((model): model is string => Boolean(model)),
              ),
            ),
          }
        : {}),
    };
  }

  const upstream =
    route.upstream &&
    typeof route.upstream === "object" &&
    !Array.isArray(route.upstream)
      ? (route.upstream as ModelReferenceRecord)
      : undefined;
  if (upstream) {
    if (modelMap) {
      const nextModelMap: ModelReferenceRecord = {};
      for (const [rawKey, rawValue] of Object.entries(modelMap)) {
        const key = index.resolve(rawKey) ?? trimmed(rawKey);
        const value = upstreamIndex.upstreamFor(rawValue);
        if (!key || !value) continue;
        const duplicate = Object.keys(nextModelMap).some((existing) =>
          sameIdentity(existing, key),
        );
        if (!duplicate) nextModelMap[key] = value;
      }
      next.upstream = { ...upstream, modelMap: nextModelMap };
    }
  }
  return next;
}

function sanitizeV2Route(
  route: ModelReferenceRecord,
  index: CodexModelReferenceIndex,
  preserveUpstreamReferences: boolean,
): ModelReferenceRecord {
  const next = { ...route };
  const aliases =
    route.aliases &&
    typeof route.aliases === "object" &&
    !Array.isArray(route.aliases)
      ? (route.aliases as ModelReferenceRecord)
      : undefined;
  const resolveSelection = (value: unknown): string | undefined =>
    resolveCodexRouteModelReference(value, index, aliases);
  const referenceForSave = (value: unknown): string | undefined => {
    const canonical = resolveSelection(value);
    if (!canonical) return undefined;
    const upstream = index.upstreamFor(canonical);
    return preserveUpstreamReferences &&
      upstream &&
      sameIdentity(trimmed(value), upstream)
      ? trimmed(value)
      : canonical;
  };
  const selection =
    route.modelSelection &&
    typeof route.modelSelection === "object" &&
    !Array.isArray(route.modelSelection)
      ? (route.modelSelection as ModelReferenceRecord)
      : undefined;
  const selectionModels = selection?.models;
  const selectedModels =
    selection?.mode === "include"
      ? canonicalizeCodexModelReferences(
          Array.isArray(selection.models)
            ? selection.models.map(resolveSelection)
            : [],
          index,
        )
      : undefined;
  if (selection?.mode === "include") {
    next.modelSelection = {
      ...selection,
      models:
        preserveUpstreamReferences && Array.isArray(selectionModels)
          ? selectedModels?.map((canonical) =>
              referenceForSave(
                selectionModels.find(
                  (value) => resolveSelection(value) === canonical,
                ),
              ),
            )
          : selectedModels,
    };
    // Empty include selections are rejected for enabled routes. Keep the
    // route editable without turning a now-empty allowlist into "follow all".
    if (selectedModels?.length === 0) next.enabled = false;
  }

  if (aliases) {
    const nextAliases: ModelReferenceRecord = {};
    for (const [alias, target] of Object.entries(aliases)) {
      const cleanAlias = alias.trim();
      const canonicalTarget = index.resolve(target);
      if (
        cleanAlias &&
        canonicalTarget &&
        (!selectedModels || selectedModels.includes(canonicalTarget))
      ) {
        nextAliases[cleanAlias] = referenceForSave(target);
      }
    }
    next.aliases = nextAliases;
  }
  return next;
}

/** Remove stale model references from either legacy or schema-v2 routing. */
export function sanitizeCodexRoutingConfig(
  routing: CodexRoutingConfig | undefined,
  index: CodexModelReferenceIndex,
  resolveRouteIndex?: CodexRouteModelIndexResolver,
  options?: { preserveUpstreamReferences?: boolean },
): CodexRoutingConfig | undefined {
  if (!routing || typeof routing !== "object") return routing;
  const source = routing as unknown as ModelReferenceRecord;
  const next: ModelReferenceRecord = { ...source };

  if (Array.isArray(source.routes)) {
    const schemaVersion = source.schemaVersion;
    next.routes = source.routes
      .filter(
        (route): route is ModelReferenceRecord =>
          Boolean(route) && typeof route === "object" && !Array.isArray(route),
      )
      .map((route) => {
        const targetProviderId = trimmed(route.targetProviderId);
        const routeIndex =
          targetProviderId && resolveRouteIndex
            ? resolveRouteIndex(targetProviderId)
            : index;
        // An unloaded target is not an empty catalog. Preserve its policy and
        // let backend validation report the missing dependency.
        if (!routeIndex) return { ...route };
        return schemaVersion === 2
          ? sanitizeV2Route(
              route,
              routeIndex,
              options?.preserveUpstreamReferences === true,
            )
          : sanitizeLegacyRoute(route, index, routeIndex);
      });
  }

  if (Array.isArray(source.modelOrder)) {
    next.modelOrder = canonicalizeCodexModelReferences(
      source.modelOrder,
      index,
    );
  }
  if (Array.isArray(source.spawnAgentModels)) {
    next.spawnAgentModels = canonicalizeCodexModelReferences(
      source.spawnAgentModels,
      index,
      5,
    );
  }
  if (source.subagentV2 !== undefined) {
    next.subagentV2 = sanitizeSubagentV2(source.subagentV2, index);
  }

  return next as unknown as CodexRoutingConfig;
}

/** Keep credential-group matching aligned with the current catalog identities. */
export function sanitizeCodexApiKeyGroups(
  groups: CodexApiKeyGroup[],
  index: CodexModelReferenceIndex,
): CodexApiKeyGroup[] {
  return groups.map((group) => ({
    ...group,
    ...(group.models
      ? {
          models: group.models
            .map((model) => index.upstreamFor(model))
            .filter((model): model is string => Boolean(model)),
        }
      : {}),
  }));
}

/** Drop protocol overrides for removed models and migrate aliases/renames. */
export function sanitizeCodexProtocolOverrides(
  overrides: Record<string, CodexProtocolOverride> | undefined,
  index: CodexModelReferenceIndex,
): Record<string, CodexProtocolOverride> {
  const result: Record<string, CodexProtocolOverride> = {};
  for (const [model, override] of Object.entries(overrides ?? {})) {
    const canonical = index.resolve(model);
    if (canonical && !Object.prototype.hasOwnProperty.call(result, canonical)) {
      result[canonical] = override;
    }
  }
  return result;
}
