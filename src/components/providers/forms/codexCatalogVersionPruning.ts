import type { CodexCatalogModel } from "@/types";

const VARIANT_ORDER = ["astra", "sol", "terra", "luna"];
const VERSION_RE = /(?:^|[-_])v?(\d+(?:\.\d+)+)(?=$|[-_])/i;

function parsedVersion(model: string): number[] {
  const match = model.match(VERSION_RE);
  return match ? match[1].split(".").map(Number) : [];
}

function familyKey(model: string): string {
  return model
    .toLowerCase()
    .replace(/(?:^|[-_])v?\d+(?:\.\d+)+(?=$|[-_])/g, "")
    .replace(/[-_](?:astra|sol|terra|luna)(?:[-_].*)?$/g, "")
    .replace(/[-_](?:free|instruct|chat)(?:[-_].*)?$/g, "")
    .replace(/[-_]+/g, "-")
    .replace(/^-|-$/g, "");
}

function compareVersion(a: CodexCatalogModel, b: CodexCatalogModel): number {
  const av = parsedVersion(a.model);
  const bv = parsedVersion(b.model);
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    const diff = (av[i] ?? 0) - (bv[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

export function pruneOutdatedCodexCatalogModels(
  models: CodexCatalogModel[],
  keepPerFamily = 5,
): { kept: CodexCatalogModel[]; pruned: CodexCatalogModel[] } {
  const groups = new Map<string, CodexCatalogModel[]>();
  const manual: CodexCatalogModel[] = [];
  for (const model of models) {
    const name = model.model.trim();
    if (!name || !parsedVersion(name).length) {
      manual.push(model);
      continue;
    }
    const key = familyKey(name);
    const group = groups.get(key) ?? [];
    group.push(model);
    groups.set(key, group);
  }
  const kept = [...manual];
  const pruned: CodexCatalogModel[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => compareVersion(b, a));
    const latest = parsedVersion(group[0].model).join(".");
    const latestGroup = group.filter((m) => parsedVersion(m.model).join(".") === latest);
    const free = group.filter((m) => /(?:^|[-_])free(?:$|[-_])/i.test(m.model));
    const ordered = [...latestGroup].sort((a, b) => {
      const av = VARIANT_ORDER.findIndex((v) => a.model.toLowerCase().includes(v));
      const bv = VARIANT_ORDER.findIndex((v) => b.model.toLowerCase().includes(v));
      return (av < 0 ? 99 : av) - (bv < 0 ? 99 : bv);
    });
    const selected = new Set([...ordered.slice(0, keepPerFamily), ...free]);
    group.forEach((m) => (selected.has(m) ? kept : pruned).push(m));
  }
  return { kept, pruned };
}
