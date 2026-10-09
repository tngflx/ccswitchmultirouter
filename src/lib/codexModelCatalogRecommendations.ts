import type { CodexCatalogModel } from "@/types";
import type { ModelStats } from "@/types/usage";
import { parseCodexCatalogRelease } from "@/lib/codexCatalogVersionPruning";
import { modelIdentityValues } from "@/lib/modelIdentities";

const key = (value?: string) => value?.trim().toLowerCase() ?? "";
const providerKey = (model: CodexCatalogModel) =>
  key(model.providerName || model.provider_name);

/** Provider and family groups retain their source order; releases sort newest first. */
export function defaultCodexCatalogModelOrder<T extends CodexCatalogModel>(
  models: readonly T[],
): T[] {
  const providers = new Map<string, number>();
  const families = new Map<string, number>();
  const ranked = models.map((model, index) => {
    const provider = providerKey(model);
    const release = parseCodexCatalogRelease({
      ...model,
      providerName: provider,
      provider_name: provider,
      apiKeyGroupId: undefined,
      api_key_group_id: undefined,
    });
    const family = JSON.stringify([
      provider,
      release?.family ?? key(model.model),
    ]);
    if (!providers.has(provider)) providers.set(provider, providers.size);
    if (!families.has(family)) families.set(family, families.size);
    return { model, index, provider, family, release };
  });
  return ranked
    .sort((left, right) => {
      const group =
        providers.get(left.provider)! - providers.get(right.provider)! ||
        families.get(left.family)! - families.get(right.family)!;
      if (group) return group;
      const a = left.release;
      const b = right.release;
      if (a && b) {
        for (
          let index = 0;
          index < Math.max(a.version.length, b.version.length);
          index++
        ) {
          const version = (b.version[index] ?? 0) - (a.version[index] ?? 0);
          if (version) return version;
        }
        if (a.revision || b.revision) {
          // Prefer dated snapshots, comparing like date formats first.
          const revision =
            (b.revision?.length ?? 0) - (a.revision?.length ?? 0) ||
            (b.revision ?? "").localeCompare(a.revision ?? "");
          if (revision) return revision;
        }
      }
      return left.index - right.index;
    })
    .map(({ model }) => model);
}

export interface CodexCatalogUsageHistory {
  codex: readonly ModelStats[];
  providers: readonly ModelStats[];
}

export interface CodexCatalogModelUsage {
  codexRequests: number;
  codexTokens: number;
  providerRequests: number;
  providerTokens: number;
}

/** Attribute each aggregate once, preferring visible IDs over shared wire identities. */
export function codexCatalogModelUsage(
  models: readonly CodexCatalogModel[],
  history?: CodexCatalogUsageHistory,
): Map<string, CodexCatalogModelUsage> {
  const result = new Map<string, CodexCatalogModelUsage>();
  if (!history) return result;
  const visible = new Map<string, CodexCatalogModel[]>();
  const identities = new Map<string, CodexCatalogModel[]>();
  for (const model of models) {
    const id = key(model.model);
    visible.set(id, [...(visible.get(id) ?? []), model]);
    for (const identity of modelIdentityValues(model)) {
      identities.set(identity, [...(identities.get(identity) ?? []), model]);
    }
  }
  const collect = (
    rows: readonly ModelStats[],
    scope: "codex" | "provider",
  ) => {
    for (const row of rows) {
      if (!Number.isFinite(row.requestCount) || row.requestCount <= 0) continue;
      const provider = key(row.providerName);
      const session =
        scope === "codex" &&
        (provider === "codex (session)" || provider === "_codex_session");
      const eligible = (candidates: CodexCatalogModel[]) =>
        candidates.filter(
          (model) => session || providerKey(model) === provider,
        );
      const exact = eligible(visible.get(key(row.model)) ?? []);
      const matches = exact.length
        ? exact
        : eligible(identities.get(key(row.model)) ?? []);
      // A bare session wire ID cannot identify one of several routed providers.
      if (matches.length !== 1) continue;
      const id = key(matches[0].model);
      const usage = result.get(id) ?? {
        codexRequests: 0,
        codexTokens: 0,
        providerRequests: 0,
        providerTokens: 0,
      };
      usage[scope === "codex" ? "codexRequests" : "providerRequests"] +=
        row.requestCount;
      usage[scope === "codex" ? "codexTokens" : "providerTokens"] +=
        Number.isFinite(row.totalTokens) ? Math.max(0, row.totalTokens) : 0;
      result.set(id, usage);
    }
  };
  collect(history.codex, "codex");
  collect(history.providers, "provider");
  return result;
}
