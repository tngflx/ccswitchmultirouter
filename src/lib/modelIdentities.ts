/** Shared identity contract for fetched model responses and catalog rows. */
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

/** Preserve searchable catalog identities through form load, editing, and save. */
export function normalizeModelIdentityMetadata(item: ModelIdentityShape): {
  canonicalSlug?: string;
  slug?: string;
  aliases?: string[] | Record<string, string>;
  name?: string;
} {
  const trimmed = (value: unknown): string =>
    typeof value === "string" ? value.trim() : "";
  const canonicalSlug =
    trimmed(item.canonicalSlug) || trimmed(item.canonical_slug);
  const slug = trimmed(item.slug);
  const name = trimmed(item.name);
  const aliases = Array.isArray(item.aliases)
    ? [...new Set(item.aliases.map(trimmed).filter(Boolean))]
    : item.aliases && typeof item.aliases === "object"
      ? Object.fromEntries(
          Object.entries(item.aliases)
            .map(([alias, target]) => [alias.trim(), trimmed(target)])
            .filter(([alias, target]) => alias && target),
        )
      : undefined;
  return {
    ...(canonicalSlug ? { canonicalSlug } : {}),
    ...(slug ? { slug } : {}),
    ...(name ? { name } : {}),
    ...(aliases && Object.keys(aliases).length > 0 ? { aliases } : {}),
  };
}

function normalizedIdentity(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function addIdentity(values: string[], value: unknown): void {
  const normalized = normalizedIdentity(value);
  if (normalized && !values.includes(normalized)) values.push(normalized);
}

/** Return all stable identities advertised by a fetched model or catalog row. */
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

/** Identities that bind a catalog row to a fetched upstream model. */
export function modelBindingIdentityValues(item: ModelIdentityShape): string[] {
  const values: string[] = [];
  const explicitUpstream =
    normalizedIdentity(item.upstreamModel) ||
    normalizedIdentity(item.upstream_model);
  if (explicitUpstream) {
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
