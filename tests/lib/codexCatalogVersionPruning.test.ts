import { describe, expect, it } from "vitest";
import {
  parseCodexCatalogRelease,
  pruneOutdatedCodexCatalogModels,
} from "@/lib/codexCatalogVersionPruning";

const prune = (...names: string[]) =>
  pruneOutdatedCodexCatalogModels(names.map((model) => ({ model })));
const kept = (...names: string[]) =>
  prune(...names).kept.map((row) => row.model);

describe("Codex catalog version pruning", () => {
  it("keeps the newest release for each capability branch", () => {
    expect(
      kept(
        "grok-4.20",
        "grok-4.20-multi-agent",
        "grok-4.3",
        "grok-4.5",
        "grok-4.6",
      ),
    ).toEqual(["grok-4.20", "grok-4.20-multi-agent", "grok-4.6"]);
  });

  it("keeps GPT codenames as independent branches", () => {
    expect(
      kept("gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna", "gpt-6-terra"),
    ).toEqual(["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna", "gpt-6-terra"]);
    expect(kept("gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol")).toEqual([
      "gpt-6.1-sol",
    ]);
  });

  it("normalizes offerings while retaining each endpoint row", () => {
    const names = ["1.0", "1.1", "1.2", "1.3", "1.4"].flatMap((version) => [
      `muse-spark-${version}`,
      `muse-spark-${version}-contributor-free`,
    ]);
    expect(kept(...names)).toEqual([
      "muse-spark-1.4",
      "muse-spark-1.4-contributor-free",
    ]);
    expect(
      parseCodexCatalogRelease({ model: "ling-3.0-flash-fin-free" }),
    ).toEqual(parseCodexCatalogRelease({ model: "ling-3.0-flash-fin:free" }));
  });

  it("compares dated snapshots only within the same identity and date width", () => {
    const names = [
      "deepseek-v4-pro-0731",
      "deepseek-v4-pro-0813",
      "deepseek-v4-pro",
      "deepseek-v4-flash-0731",
      "deepseek-v4-flash-vision-exp",
      "deepseek-v3.2",
      "deepseek-v4-pro-2026-08-01",
    ];
    const result = prune(...names);
    expect(result.pruned.map((row) => row.model)).toEqual([names[0]]);
    expect(result.decisions[0].reason).toBe("older-snapshot");
  });

  it("preserves unknown aliases, input order, identity, and idempotence", () => {
    const rows = Object.freeze(
      [5, 4, 3, 2, 1].map((version) =>
        Object.freeze({
          model: `alias-${version}`,
          upstreamModel: `glm-${version}`,
        }),
      ),
    );
    const result = pruneOutdatedCodexCatalogModels([...rows]);
    expect(result.kept[0]).toBe(rows[0]);
    expect(result.pruned[0]).toBe(rows[1]);
    expect(result.kept).toEqual([rows[0]]);
    expect(pruneOutdatedCodexCatalogModels(result.kept).pruned).toEqual([]);
    expect(
      prune(
        "custom-2026",
        "qwen-72b",
        "gpt-oss-120b",
        "openrouter/free",
      ).decisions.every((decision) => decision.reason === "unclassified"),
    ).toBe(true);
  });

  it("keeps provider namespaces and API-key groups independent", () => {
    const rows = [5, 4, 3, 2, 1].map((version) => ({
      model: `a/glm-${version}`,
      apiKeyGroupId: "primary",
    }));
    const isolated = {
      model: "alias",
      upstream_model: "a/glm-1",
      api_key_group_id: "isolated",
    };
    const other = { model: "b/glm-1" };
    expect(
      pruneOutdatedCodexCatalogModels([...rows, isolated, other]).pruned,
    ).toEqual(rows.slice(1));
  });
});
