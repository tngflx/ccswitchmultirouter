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
  it.each([
    "glm-",
    "minimax-m",
    "kimi-k",
    "grok-",
    "muse-spark-",
    "claude-fable-",
  ])("keeps the newest %s release regardless of input order", (prefix) => {
    const names = ["1", "2", "3", "4", "5"].map(
      (version) => `${prefix}${version}`,
    );
    expect(kept(...names)).toEqual([names[4]]);
    expect(kept(...[...names].reverse())).toEqual([names[4]]);
  });

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

  it("compares numeric components instead of model-name text", () => {
    expect(
      kept("glm-5.9", "glm-5.10", "glm-5.8", "glm-5.7", "glm-5.6"),
    ).toEqual(["glm-5.10"]);
  });

  it("keeps GPT codename snapshots isolated while pruning older snapshots", () => {
    expect(
      kept(
        "gpt-5.6-sol-20260801",
        "gpt-5.6-luna-20260901",
        "gpt-5.6-sol-20260701",
      ),
    ).toEqual(["gpt-5.6-sol-20260801", "gpt-5.6-luna-20260901"]);
  });

  it("keeps the newest release in specialized and image branches", () => {
    expect(
      kept(
        "glm-5.3",
        "glm-5.2",
        "glm-5.3-flash",
        "glm-4.7-flash",
        "gpt-5.4-image-2",
        "gpt-5-image",
        "gpt-4-image",
        "gpt-image-2",
        "gpt-image-1",
        "gpt-image-1-mini",
      ),
    ).toEqual([
      "glm-5.3",
      "glm-5.3-flash",
      "gpt-5.4-image-2",
      "gpt-5-image",
      "gpt-image-2",
      "gpt-image-1-mini",
    ]);
  });

  it("normalizes Claude role-first and version-first release syntax", () => {
    expect(
      kept(
        "claude-opus-4-1",
        "claude-4.2-opus",
        "claude-sonnet-4.1",
        "claude-4-2-sonnet",
        "claude-haiku-3.5",
      ),
    ).toEqual(["claude-4.2-opus", "claude-4-2-sonnet", "claude-haiku-3.5"]);
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
    expect(pruneOutdatedCodexCatalogModels([])).toEqual({
      kept: [],
      pruned: [],
      decisions: [],
    });
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

  it("retains complete endpoint rows with selection and capability metadata", () => {
    const old = {
      model: "alias-old",
      upstreamModel: "vendor/glm-4",
      enabled: true,
      aliases: ["legacy"],
      inputModalities: ["text"],
    };
    const latest = {
      model: "alias-latest",
      upstreamModel: "vendor/glm-5",
      enabled: false,
      aliases: ["preferred"],
      inputModalities: ["text", "image"],
      contextWindow: 256000,
    };
    const result = pruneOutdatedCodexCatalogModels([old, latest]);
    expect(result.kept).toEqual([latest]);
    expect(result.kept[0]).toBe(latest);
    expect(result.kept[0]).toMatchObject({
      enabled: false,
      aliases: ["preferred"],
      inputModalities: ["text", "image"],
      contextWindow: 256000,
    });
  });
});
