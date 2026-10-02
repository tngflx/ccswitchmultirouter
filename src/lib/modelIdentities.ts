/**
 * Stable model identifiers shared by fetched model responses and catalog rows.
 *
 * A provider may expose the same model under an id, canonical slug, alias, or
 * a provider-specific upstream binding. All comparisons must use the same
 * normalized identity set so refreshes cannot create duplicate rows or match
 * an alias to the wrong upstream model.
 */
export interface ModelIdentityShape {
  model?: unknown;
  id?: unknown;
  upstreamModel?: unknown;
  upstream_model?: unknown;
  canonicalSlug?: unknown;
  canonical_slug?: unknown;
  slug?: unknown;
  aliases?: unknown;
  name?: unknown;
}

function normalizedIdentity(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function addIdentity(values: string[], value: unknown): void {
  const normalized = normalizedIdentity(value);
  if (normalized && !values.includes(normalized)) values.push(normalized);
}

/** Return every stable identity advertised by a fetched model or catalog row. */
export function modelIdentityValues(item: ModelIdentityShape): string[] {
  const values: string[] = [];
  for (const value of [
    item.model,
    item.id,
    item.upstreamModel,
    item.upstream_model,
    item.canonicalSlug,
    item.canonical_slug,
    item.slug,
  ]) {
    addIdentity(values, value);
  }

  if (Array.isArray(item.aliases)) {
    for (const alias of item.aliases) addIdentity(values, alias);
  } else if (item.aliases && typeof item.aliases === "object") {
    for (const [alias, target] of Object.entries(item.aliases)) {
      addIdentity(values, alias);
      addIdentity(values, target);
    }
  }

  if (values.length === 0) addIdentity(values, item.name);
  return values;
}

/**
 * Return identifiers that bind a catalog row to a fetched upstream model.
 * Display names are intentionally excluded: a friendly label is not a stable
 * provider identity and must never cause a refresh to overwrite another row.
 */
export function modelBindingIdentityValues(item: ModelIdentityShape): string[] {
  const values: string[] = [];
  const explicitUpstream =
    normalizedIdentity(item.upstreamModel) ||
    normalizedIdentity(item.upstream_model);
  if (explicitUpstream) {
    // Once a row has an explicit upstream binding, its visible model name is
    // only a local alias. Do not let that alias match another fetched model.
    addIdentity(values, explicitUpstream);
    return values;
  }
  for (const value of [
    item.model,
    item.canonicalSlug,
    item.canonical_slug,
    item.slug,
  ]) {
    addIdentity(values, value);
  }
  return values;
}