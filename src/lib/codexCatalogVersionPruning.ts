import type { CodexCatalogModel } from "@/types";

type CatalogReleaseModel = CodexCatalogModel & {
  providerName?: string;
  provider_name?: string;
};

export type CatalogRelease = {
  family: string;
  branch: string;
  version: number[];
  identity: string;
  revision?: string;
};

export function parseCodexCatalogRelease(
  model: CatalogReleaseModel,
): CatalogRelease | undefined {
  const name = (
    model.upstreamModel?.trim() ||
    model.upstream_model?.trim() ||
    model.model.trim()
  ).toLowerCase();
  const slash = name.lastIndexOf("/");
  const namespace = name.slice(0, slash + 1);
  const id = name
    .slice(slash + 1)
    .replace(/_/g, "-")
    .replace(/(?:(?::|-)(?:free|batch|contributor))+$/, "");

  let family: string;
  let version: number[];
  let suffix: string;
  const gptImage = id.match(/^gpt-image-(\d+(?:\.\d+)*)(?=$|-)/);
  if (gptImage) {
    family = "gpt-image";
    version = gptImage[1].split(".").map(Number);
    suffix = id.slice(gptImage[0].length);
  } else {
    const claude = id.match(
      /^claude-(?:(opus|sonnet|haiku|fable)-(\d+)(?:[.-](\d{1,2}))?|([\d]+)(?:[.-](\d{1,2}))?-(opus|sonnet|haiku|fable))(?=$|-)/,
    );
    if (claude) {
      family = `claude-${claude[1] || claude[6]}`;
      version = [
        Number(claude[2] || claude[4]),
        Number(claude[3] || claude[5] || 0),
      ];
      suffix = id.slice(claude[0].length);
    } else {
      // Only known release positions are parsed; parameter sizes such as 72b
      // and dated custom aliases remain unclassified.
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
  }

  const date = suffix.match(/-(\d{4}-\d{2}-\d{2}|\d{8}|\d{2}-\d{2}|\d{4})$/);
  const revision = date?.[1].replace(/-/g, "");
  if (date) suffix = suffix.slice(0, -date[0].length);
  const codename =
    family === "gpt"
      ? suffix.match(/^-(astra|sol|luna|terra)(?=-|$)/)?.[1]
      : undefined;
  if (codename) suffix = suffix.slice(codename.length + 1);

  // Codenames and specialties are capability branches. Folding them into the
  // release identity alone would let a newer branch delete a sibling branch.
  const branch =
    (family === "grok" && version[0] === 4 && version[1] === 20
      ? "4.20:"
      : "") +
    (codename ? `${codename}:` : "") +
    (suffix || "general");
  while (version.length > 1 && version.at(-1) === 0) version.pop();
  const scope = JSON.stringify([
    model.providerName || model.provider_name || "",
    model.apiKeyGroupId || model.api_key_group_id || "",
    namespace + family,
  ]);
  const identity = JSON.stringify([branch, version, codename || ""]);
  return { family: scope, branch, version, identity, revision };
}

function compareVersions(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

export type CatalogPruningReason =
  | "unclassified"
  | "recent-release"
  | "older-release"
  | "older-snapshot";

export type CatalogPruningDecision<
  T extends CodexCatalogModel = CodexCatalogModel,
> = {
  model: T;
  release?: CatalogRelease;
  keep: boolean;
  reason: CatalogPruningReason;
};

export function pruneOutdatedCodexCatalogModels<T extends CodexCatalogModel>(
  models: readonly T[],
): {
  kept: T[];
  pruned: T[];
  decisions: CatalogPruningDecision<T>[];
} {
  const decisions: CatalogPruningDecision<T>[] = models.map((model) => ({
    model,
    release: parseCodexCatalogRelease(model),
    keep: true,
    reason: "unclassified",
  }));
  const families = new Map<string, CatalogPruningDecision<T>[]>();
  for (const decision of decisions) {
    if (!decision.release) continue;
    const rows = families.get(decision.release.family) ?? [];
    rows.push(decision);
    families.set(decision.release.family, rows);
  }

  for (const rows of families.values()) {
    const branches = new Map<string, number[][]>();
    const snapshots = new Map<string, string>();
    for (const { release } of rows) {
      if (!release) continue;
      const versions = branches.get(release.branch) ?? [];
      if (
        !versions.some(
          (version) => compareVersions(version, release.version) === 0,
        )
      ) {
        versions.push(release.version);
      }
      branches.set(release.branch, versions);
      if (release.revision) {
        const key = JSON.stringify([release.identity, release.revision.length]);
        const previous = snapshots.get(key);
        if (!previous || release.revision > previous) {
          snapshots.set(key, release.revision);
        }
      }
    }
    for (const versions of branches.values()) {
      versions.sort((left, right) => compareVersions(right, left));
    }
    for (const row of rows) {
      const release = row.release!;
      const recent = branches
        .get(release.branch)!
        .slice(0, 1)
        .some((version) => compareVersions(version, release.version) === 0);
      const newestSnapshot = snapshots.get(
        JSON.stringify([release.identity, release.revision?.length]),
      );
      const oldSnapshot =
        Boolean(release.revision) &&
        Boolean(newestSnapshot) &&
        release.revision! < newestSnapshot!;
      row.keep = recent && !oldSnapshot;
      row.reason = oldSnapshot
        ? "older-snapshot"
        : recent
          ? "recent-release"
          : "older-release";
    }
  }

  return {
    kept: decisions
      .filter((decision) => decision.keep)
      .map((decision) => decision.model),
    pruned: decisions
      .filter((decision) => !decision.keep)
      .map((decision) => decision.model),
    decisions,
  };
}
