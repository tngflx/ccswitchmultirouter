/** Router-owned provider blocks contain model ranks, never source catalog ranks. */
export interface CodexOrderableCatalogModel {
  model?: string;
  sortIndex?: number;
  upstreamModel?: string;
  upstream_model?: string;
  canonicalSlug?: string;
  canonical_slug?: string;
  providerName?: string;
  provider_name?: string;
  targetProviderId?: string;
}

/** Stable provider identity wins over mutable display names. */
export function codexCatalogModelProviderKey(
  model: CodexOrderableCatalogModel,
): string {
  const id = model.targetProviderId?.trim();
  if (id) return `id:${id}`;
  const name = (model.providerName || model.provider_name)
    ?.trim()
    .toLowerCase();
  return name ? `name:${name}` : "unknown";
}

function providerRanks(
  models: readonly CodexOrderableCatalogModel[],
  referenceModels: readonly CodexOrderableCatalogModel[],
): Map<string, number> {
  const ranks = new Map<string, number>();
  for (const model of [...referenceModels, ...models]) {
    const provider = codexCatalogModelProviderKey(model);
    if (!ranks.has(provider)) ranks.set(provider, ranks.size);
  }
  return ranks;
}

/** Normalize arbitrary UI ranks against the current route-owned provider blocks. */
export function groupCodexCatalogModelsByProvider<
  T extends CodexOrderableCatalogModel,
>(
  models: readonly T[],
  referenceModels: readonly CodexOrderableCatalogModel[] = models,
): T[] {
  const groups = providerRanks(models, referenceModels);
  return models
    .map((model, index) => ({ model, index }))
    .sort(
      (left, right) =>
        groups.get(codexCatalogModelProviderKey(left.model))! -
          groups.get(codexCatalogModelProviderKey(right.model))! ||
        left.index - right.index,
    )
    .map(({ model }) => model);
}

export function applyCodexCatalogModelOrder<
  T extends CodexOrderableCatalogModel,
>(
  models: readonly T[],
  savedOrder: readonly string[],
  referenceModels: readonly CodexOrderableCatalogModel[] = models,
): T[] {
  const key = (value?: string) => value?.trim().toLowerCase() ?? "";
  const visible = new Set(models.map((model) => key(model.model)));
  const ranks = new Map<string, number>();
  // Exact visible IDs take precedence over recovered identities, regardless of
  // where the old identity occurs in the saved order. First duplicate wins.
  savedOrder.forEach((id, rank) => {
    const idKey = key(id);
    if (visible.has(idKey) && !ranks.has(idKey)) ranks.set(idKey, rank);
  });
  savedOrder.forEach((id, rank) => {
    const idKey = key(id);
    if (!idKey || visible.has(idKey)) return;
    const identities = models.filter((model) =>
      [
        model.upstreamModel,
        model.upstream_model,
        model.canonicalSlug,
        model.canonical_slug,
      ].some((identity) => key(identity) === idKey),
    );
    const suffixMatches = models.filter((model) => {
      const suffix =
        key(model.providerName || model.provider_name || model.targetProviderId)
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "") || "provider";
      if (suffix.length < 2 || !idKey.endsWith(`-${suffix}`)) return false;
      const stem = idKey.slice(0, -suffix.length - 1);
      return [
        model.model,
        model.upstreamModel,
        model.upstream_model,
        model.canonicalSlug,
        model.canonical_slug,
      ].some((identity) => key(identity) === stem);
    });
    const matches = identities.length === 1 ? identities : suffixMatches;
    if (matches.length !== 1) return;
    const recovered = key(matches[0].model);
    if (!ranks.has(recovered)) ranks.set(recovered, rank);
  });
  const custom = ranks.size > 0;
  const groups = providerRanks(models, referenceModels);
  return models
    .map((model, index) => ({ model, index }))
    .sort(
      (left, right) =>
        groups.get(codexCatalogModelProviderKey(left.model))! -
          groups.get(codexCatalogModelProviderKey(right.model))! ||
        (ranks.get(key(left.model.model)) ?? Number.MAX_SAFE_INTEGER) -
          (ranks.get(key(right.model.model)) ?? Number.MAX_SAFE_INTEGER) ||
        left.index - right.index,
    )
    .map(({ model }, index) => {
      const { sortIndex: _sourceRank, ...rest } = model;
      return (custom ? { ...rest, sortIndex: index } : rest) as T;
    });
}
