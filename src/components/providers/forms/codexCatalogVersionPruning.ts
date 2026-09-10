import type { CodexCatalogModel } from "@/types";

type Release = {
  family: string;
  branch: string;
  version: number[];
  identity: string;
  revision?: string;
};

export function parseRelease(model: CodexCatalogModel): Release | undefined {
  const name = (
    model.upstreamModel?.trim() ||
    model.upstream_model?.trim() ||
    model.model.trim()
  ).toLowerCase();
  const slash = name.lastIndexOf("/");
  const namespace = name.slice(0, slash + 1);
  // Offering suffixes do not represent additional model choices.
  const id = name
    .slice(slash + 1)
    .replace(/_/g, "-")
    .replace(/(?:(?::|-)(?:free|batch|contributor))+$/, "");
  let family: string;
  let version: number[];
  let suffix: string;
  const claude = id.match(
    /^claude-(?:(opus|sonnet|haiku|fable)-(\d+)(?:[.-](\d{1,2}))?|(\d+)(?:[.-](\d{1,2}))?-(opus|sonnet|haiku|fable))(?=$|-)/,
  );
  if (claude) {
    family = `claude-${claude[1] || claude[6]}`;
    version = [
      Number(claude[2] || claude[4]),
      Number(claude[3] || claude[5] || 0),
    ];
    suffix = id.slice(claude[0].length);
  } else {
    // Only known version positions: never interpret parameter sizes as releases.
    const match = id.match(
      /^(gpt-|glm-|deepseek-(?:chat-)?[vr]|qwen-?|kimi-k|minimax-m|gemini-|llama-?|grok-(?:build-)?|muse-spark-|ling-|nemotron-|mimo-v|longcat-|hy)(\d{1,2}(?:\.\d+)*)(?=$|-|v(?:-|$))/,
    );
    if (!match) return undefined;
    family = match[1]
      .replace(/-$/, "")
      .replace("deepseek-chat-v", "deepseek-v");
    version = match[2].split(".").map(Number);
    suffix = id.slice(match[0].length);
  }
  const date = suffix.match(/-(\d{4}-\d{2}-\d{2}|\d{8}|\d{2}-\d{2}|\d{4})$/);
  const revision = date?.[1].replace(/-/g, "");
  if (date) suffix = suffix.slice(0, -date[0].length);
  const codename =
    family === "gpt"
      ? suffix.match(/^-(astra|sol|luna|terra)(?=-|$)/)?.[1]
      : undefined;
  if (codename) suffix = suffix.slice(codename.length + 1);
  // Keep all other suffixes as branch boundaries, including unknown specialties.
  // Grok 4.20 is a named series, not semver minor 20; keep it independent.
  const branch =
    (family === "grok" && version[0] === 4 && version[1] === 20
      ? "4.20:"
      : "") + (suffix || "general");
  while (version.length > 1 && version.at(-1) === 0) version.pop();
  const scope = JSON.stringify([
    model.providerName || model.provider_name || "",
    model.apiKeyGroupId || model.api_key_group_id || "",
    namespace + family,
  ]);
  const identity = JSON.stringify([branch, version, codename || ""]);
  return { family: scope, branch, version, identity, revision };
}

function compareVersion(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

export type CatalogPruningDecision = {
  model: CodexCatalogModel;
  release?: Release;
  keep: boolean;
  reason:
    | "unclassified"
    | "recent-release"
    | "family-minimum"
    | "older-release"
    | "older-snapshot";
};

export function pruneOutdatedCodexCatalogModels(models: CodexCatalogModel[]): {
  kept: CodexCatalogModel[];
  pruned: CodexCatalogModel[];
  decisions: CatalogPruningDecision[];
} {
  const decisions: CatalogPruningDecision[] = models.map((model) => ({
    model,
    release: parseRelease(model),
    keep: true,
    reason: "unclassified",
  }));
  const families = new Map<string, CatalogPruningDecision[]>();
  for (const decision of decisions) {
    if (!decision.release) continue;
    const key = decision.release.family;
    const rows = families.get(key) ?? [];
    rows.push(decision);
    families.set(key, rows);
  }
  for (const rows of families.values()) {
    const branches = new Map<string, number[][]>();
    const snapshots = new Map<string, string>();
    for (const { release: r } of rows) {
      if (!r) continue;
      const versions = branches.get(r.branch) ?? [];
      if (!versions.some((v) => compareVersion(v, r.version) === 0))
        versions.push(r.version);
      branches.set(r.branch, versions);
      if (r.revision) {
        const key = JSON.stringify([r.identity, r.revision.length]);
        const previous = snapshots.get(key);
        if (!previous || r.revision > previous) snapshots.set(key, r.revision);
      }
    }
    for (const versions of branches.values())
      versions.sort((a, b) => compareVersion(b, a));
    for (const row of rows) {
      const r = row.release!;
      const recent = branches
        .get(r.branch)!
        .slice(0, 2)
        .some((v) => compareVersion(v, r.version) === 0);
      const oldSnapshot =
        r.revision &&
        r.revision <
          snapshots.get(JSON.stringify([r.identity, r.revision.length]))!;
      row.keep = recent && !oldSnapshot;
      row.reason = oldSnapshot
        ? "older-snapshot"
        : recent
          ? "recent-release"
          : "older-release";
    }
    const identities = new Set(
      rows.filter((r) => r.keep).map((r) => r.release!.identity),
    );
    // Backfill whole release tiers, so endpoint ordering cannot change selection.
    const candidates = rows
      .filter((r) => !r.keep && r.reason !== "older-snapshot")
      .sort((a, b) => compareVersion(b.release!.version, a.release!.version));
    let boundary: number[] | undefined;
    for (const row of candidates) {
      const r = row.release!;
      if (
        identities.size >= 4 &&
        (!boundary || compareVersion(r.version, boundary) !== 0)
      )
        break;
      row.keep = true;
      row.reason = "family-minimum";
      identities.add(r.identity);
      boundary = r.version;
    }
  }
  return {
    kept: decisions.filter((r) => r.keep).map((r) => r.model),
    pruned: decisions.filter((r) => !r.keep).map((r) => r.model),
    decisions,
  };
}
