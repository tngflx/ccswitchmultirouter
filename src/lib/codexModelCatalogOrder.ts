/** Global picker order belongs to the router, never to source catalog ranks. */
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

export function applyCodexCatalogModelOrder<
  T extends CodexOrderableCatalogModel,
>(models: readonly T[], savedOrder: readonly string[]): T[] {
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
  return models
    .map((model, index) => ({ model, index }))
    .sort(
      (left, right) =>
        (ranks.get(key(left.model.model)) ?? Number.MAX_SAFE_INTEGER) -
          (ranks.get(key(right.model.model)) ?? Number.MAX_SAFE_INTEGER) ||
        left.index - right.index,
    )
    .map(({ model }, index) => {
      const { sortIndex: _sourceRank, ...rest } = model;
      return (custom ? { ...rest, sortIndex: index } : rest) as T;
    });
}
