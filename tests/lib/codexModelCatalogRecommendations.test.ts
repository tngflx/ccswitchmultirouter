import { describe, expect, it } from "vitest";
import {
  codexCatalogModelUsage,
  defaultCodexCatalogModelOrder,
} from "@/lib/codexModelCatalogRecommendations";
import type { CodexCatalogModel } from "@/types";
import type { ModelStats } from "@/types/usage";

const stat = (
  model: string,
  providerName: string,
  requestCount = 10,
): ModelStats => ({
  model,
  providerName,
  requestCount,
  totalTokens: requestCount * 100,
  totalCost: "0",
  avgCostPerRequest: "0",
});

describe("default Codex catalog model order", () => {
  it("groups providers in route order and sorts GPT generations numerically", () => {
    const models = [
      {
        model: "gpt-5.6-luna-sublyx",
        upstreamModel: "gpt-5.6-luna",
        providerName: "Subly",
      },
      { model: "gpt-5.9", providerName: "Official" },
      {
        model: "gpt-6-astra-sublyx",
        upstreamModel: "gpt-6-astra",
        providerName: "Subly",
      },
      {
        model: "gpt-6.1-sol-sublyx",
        upstreamModel: "gpt-6.1-sol",
        providerName: "Subly",
      },
      { model: "gpt-5.10", providerName: "Official" },
    ];
    const snapshot = JSON.stringify(models);
    const sorted = defaultCodexCatalogModelOrder(models);
    expect(sorted.map((model) => model.model)).toEqual([
      "gpt-6.1-sol-sublyx",
      "gpt-6-astra-sublyx",
      "gpt-5.6-luna-sublyx",
      "gpt-5.10",
      "gpt-5.9",
    ]);
    expect(sorted[0]).toBe(models[3]);
    expect(defaultCodexCatalogModelOrder(sorted)).toEqual(sorted);
    expect(JSON.stringify(models)).toBe(snapshot);
  });

  it("does not mistake parameter sizes or custom dates for model generations", () => {
    const models = ["qwen-72b", "gpt-oss-120b", "custom-2026", "unknown"].map(
      (model) => ({ model }),
    );
    expect(defaultCodexCatalogModelOrder(models)).toEqual(models);
  });

  it("sorts each known family without comparing unrelated version numbers", () => {
    const models = [
      "gpt-5.6",
      "qwen3.5",
      "claude-opus-4-5",
      "qwen3.6",
      "gpt-6.1-sol",
      "claude-opus-4-6",
    ].map((model) => ({ model, providerName: "Gateway" }));
    expect(
      defaultCodexCatalogModelOrder(models).map((model) => model.model),
    ).toEqual([
      "gpt-6.1-sol",
      "gpt-5.6",
      "qwen3.6",
      "qwen3.5",
      "claude-opus-4-6",
      "claude-opus-4-5",
    ]);
  });

  it("sorts snapshots and generations across credential groups without dropping rows", () => {
    const models = [
      { model: "old", upstream_model: "gpt-5.6-sol", apiKeyGroupId: "a" },
      {
        model: "snapshot",
        upstreamModel: "gpt-6.1-sol-2026-08-01",
        apiKeyGroupId: "b",
      },
      {
        model: "current",
        upstreamModel: "gpt-6.1-sol-2026-10-01",
        api_key_group_id: "c",
      },
      { model: "rolling", upstreamModel: "gpt-6.1-sol" },
    ];
    expect(
      defaultCodexCatalogModelOrder(models).map((model) => model.model),
    ).toEqual(["current", "snapshot", "rolling", "old"]);
  });
});

describe("Codex catalog usage attribution", () => {
  const models: CodexCatalogModel[] = [
    {
      model: "gpt-6.1-sol-sublyx",
      upstreamModel: "gpt-6.1-sol",
      providerName: "Subly",
    },
    {
      model: "gpt-6.1-sol-gateway",
      upstream_model: "gpt-6.1-sol",
      provider_name: "Gateway",
    },
  ];

  it("matches provider-qualified wire IDs and visible Codex session aliases", () => {
    const usage = codexCatalogModelUsage(models, {
      codex: [
        stat("GPT-6.1-SOL", "subly", 3),
        stat("gpt-6.1-sol-sublyx", "Codex (Session)", 7),
      ],
      providers: [stat("gpt-6.1-sol", "Gateway", 20)],
    });
    expect(usage.get(models[0].model)?.codexRequests).toBe(10);
    expect(usage.get(models[1].model)?.codexRequests).toBe(0);
    expect(usage.get(models[1].model)?.providerRequests).toBe(20);
    expect(usage.get(models[0].model)?.providerRequests).toBe(0);
  });

  it("does not attribute ambiguous session wire IDs or another provider's traffic", () => {
    expect(
      codexCatalogModelUsage(models, {
        codex: [stat("gpt-6.1-sol", "Codex (Session)")],
        providers: [
          stat("gpt-6.1-sol", "Unselected"),
          stat("gpt-6.1-sol-sublyx", "Gateway"),
        ],
      }).size,
    ).toBe(0);
  });

  it("recovers unique canonical slugs and advertised aliases", () => {
    const model = {
      model: "favorite",
      canonical_slug: "openai/gpt-6.1-sol",
      aliases: ["gpt-6.1-sol"],
      providerName: "Subly",
    };
    expect(
      codexCatalogModelUsage([model], {
        codex: [stat("openai/gpt-6.1-sol", "Codex (Session)", 2)],
        providers: [stat("gpt-6.1-sol", "Subly", 8)],
      }).get("favorite"),
    ).toMatchObject({
      codexRequests: 2,
      providerRequests: 8,
    });
  });

  it("prefers an exact visible ID to another model's overlapping alias", () => {
    expect(
      codexCatalogModelUsage(
        [
          { model: "wire", providerName: "Subly" },
          { model: "alias", upstreamModel: "wire", providerName: "Subly" },
        ],
        {
          codex: [stat("wire", "Subly", 4)],
          providers: [],
        },
      ).get("wire")?.codexRequests,
    ).toBe(4);
  });

  it("ignores zero, negative, nonfinite and unavailable model usage", () => {
    expect(
      codexCatalogModelUsage(models, {
        codex: [],
        providers: [
          stat("gpt-6.1-sol", "Subly", 0),
          stat("gpt-6.1-sol", "Subly", -1),
          stat("gpt-6.1-sol", "Subly", Number.NaN),
          stat("removed", "Subly"),
        ],
      }).size,
    ).toBe(0);
  });
});
