import { describe, expect, it } from "vitest";
import {
  parseRelease,
  pruneOutdatedCodexCatalogModels,
} from "@/components/providers/forms/codexCatalogVersionPruning";

const prune = (...names: string[]) =>
  pruneOutdatedCodexCatalogModels(names.map((model) => ({ model })));
const keep = (...names: string[]) =>
  prune(...names).kept.map((row) => row.model);

describe("recent catalog retention", () => {
  it("does not let the Grok 4.20 series displace Grok 4.5", () => {
    const names = [
      "grok-4.20",
      "grok-4.20-multi-agent",
      "grok-4.3",
      "grok-4.5",
      "grok-4.6",
    ];
    expect(keep(...names)).toEqual([names[0], names[1], names[3], names[4]]);
  });
  it("keeps GPT 5.6 even when GPT 6 has four offerings", () => {
    const names = [
      "gpt-6-astra",
      "gpt-6-astra:batch",
      "gpt-6-astra-pro",
      "gpt-6-astra-pro:batch",
      "gpt-5.6-sol",
      "gpt-5.6-luna",
      "gpt-5.6-terra",
      "gpt-5.5",
      "gpt-5.4",
    ];
    expect(keep(...names)).toEqual(names.slice(0, 7));
  });

  it.each([
    "glm-",
    "minimax-m",
    "kimi-k",
    "grok-",
    "muse-spark-",
    "claude-fable-",
  ])("backfills four distinct models for %s", (prefix) => {
    const names = ["1", "2", "3", "4", "5"].map((v) => prefix + v);
    expect(keep(...names)).toEqual(names.slice(1));
    expect(keep(...names.slice().reverse())).toEqual(names.slice(1).reverse());
  });

  it("keeps all available choices in small families", () => {
    const names = [
      "grok-4.5",
      "grok-4.6",
      "muse-spark-1.2",
      "muse-spark-1.3",
      "claude-fable-5",
      "claude-fable-5-1",
    ];
    expect(keep(...names)).toEqual(names);
    expect(
      prune(...names).decisions.every((d) => d.reason === "recent-release"),
    ).toBe(true);
  });

  it("does not let offerings or aliases fill the minimum", () => {
    const names = [
      "glm-5",
      "glm-5.0",
      "glm-5:batch",
      "glm-5:free",
      "glm-4",
      "glm-4-free",
      "glm-3",
      "glm-2",
      "glm-1",
    ];
    expect(keep(...names)).toEqual(names.slice(0, -1));
    const result = pruneOutdatedCodexCatalogModels([
      ...["a", "b", "c", "d"].map((model) => ({
        model,
        upstreamModel: "glm-5",
      })),
      ...[4, 3, 2, 1].map((v) => ({ model: `glm-${v}` })),
    ]);
    expect(result.pruned.map((r) => r.model)).toEqual(["glm-1"]);
  });

  it.each([
    [
      "qwen3.8",
      "qwen3.7",
      "qwen3.6",
      "qwen3.5",
      "qwen3-coder",
      "qwen2.5-coder",
      "qwen3-vl-8b",
      "qwen2.5-vl-72b",
    ],
    [
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.6-luna",
      "gpt-5.6-terra",
      "gpt-5.4-image-2",
      "gpt-5-image",
      "gpt-5.3-codex",
      "gpt-5.2-codex",
    ],
    [
      "gemini-3.8-flash",
      "gemini-3.7-flash",
      "gemini-3.6-flash",
      "gemini-3.5-flash",
      "gemini-3.1-pro",
      "gemini-2.5-pro",
      "gemini-3.1-flash-image",
      "gemini-3-pro-image",
    ],
    [
      "glm-5.3",
      "glm-5.2",
      "glm-5.1",
      "glm-5",
      "glm-5.3-flash",
      "glm-4.7-flash",
      "glm-5v-turbo",
      "glm-4.6v",
    ],
  ])("preserves specialized branches: %s", (...names) => {
    const retained = keep(...names);
    for (const name of names.slice(4)) expect(retained).toContain(name);
  });

  it("keeps two releases in each branch even when the family already has four", () => {
    expect(
      keep(
        "glm-5.3",
        "glm-5.2",
        "glm-5.1",
        "glm-5.3-flash",
        "glm-4.7-flash",
        "glm-4.6-flash",
      ),
    ).toEqual(["glm-5.3", "glm-5.2", "glm-5.3-flash", "glm-4.7-flash"]);
  });

  it("compares versions numerically and backfills complete ties", () => {
    expect(
      keep("glm-5.9", "glm-5.10", "glm-5.8", "glm-5.7", "glm-5.6"),
    ).toEqual(["glm-5.9", "glm-5.10", "glm-5.8", "glm-5.7"]);
    const names = [
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.5",
      "gpt-5.5-pro",
      "gpt-5.4-pro",
      "gpt-5",
    ];
    expect(keep(...names)).not.toContain("gpt-5");
  });

  it("compares snapshots only within the same model and date format", () => {
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
    expect(result.pruned.map((r) => r.model)).toEqual([names[0]]);
    expect(result.decisions[0].reason).toBe("older-snapshot");
  });

  it("does not compare GPT codename snapshots with each other", () => {
    const names = [
      "gpt-5.6-sol-20260801",
      "gpt-5.6-luna-20260901",
      "gpt-5.6-sol-20260701",
    ];
    expect(keep(...names)).toEqual(names.slice(0, 2));
  });

  it("normalizes contributor/free offerings without losing endpoint IDs", () => {
    const names = ["1.0", "1.1", "1.2", "1.3", "1.4"].flatMap((v) => [
      `muse-spark-${v}`,
      `muse-spark-${v}-contributor-free`,
    ]);
    expect(keep(...names)).toEqual(names.slice(2));
    expect(parseRelease({ model: "ling-3.0-flash-fin-free" })).toEqual(
      parseRelease({ model: "ling-3.0-flash-fin:free" }),
    );
  });

  it("preserves unknown aliases and never treats parameter counts as versions", () => {
    const names = [
      "custom-2026",
      "qwen-72b",
      "gpt-oss-120b",
      "openrouter/free",
      "~z-ai/glm-latest",
      "unknown:free",
    ];
    expect(keep(...names)).toEqual(names);
    expect(
      prune(...names).decisions.every((d) => d.reason === "unclassified"),
    ).toBe(true);
  });

  it("keeps provider namespaces and API key groups independent", () => {
    const rows = [5, 4, 3, 2, 1].map((v) => ({
      model: `a/glm-${v}`,
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
    ).toEqual([rows[4]]);
  });

  it("preserves row identity, input order and idempotence", () => {
    const rows = Object.freeze(
      [5, 4, 3, 2, 1].map((v) =>
        Object.freeze({ model: `alias-${v}`, upstreamModel: `glm-${v}` }),
      ),
    );
    const result = pruneOutdatedCodexCatalogModels([...rows]);
    expect(result.kept[0]).toBe(rows[0]);
    expect(result.pruned[0]).toBe(rows[4]);
    expect(result.kept).toEqual(rows.slice(0, 4));
    expect(pruneOutdatedCodexCatalogModels(result.kept).pruned).toEqual([]);
    expect(keep()).toEqual([]);
  });
});
