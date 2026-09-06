import { describe, expect, it } from "vitest";
import {
  baseCodexCatalogModels,
  buildCodexApiKeyGroupCatalog,
  normalizeCodexApiKeyGroupMode,
} from "./codexApiKeyGroupRouting";

const catalog = [
  {
    model: "gpt-5.6-sol",
    upstreamModel: "gpt-5.6-sol",
    displayName: "GPT-5.6 Sol",
    contextWindow: 272000,
  },
];

describe("Codex API key group routing", () => {
  it("defaults legacy configurations to isolated sources", () => {
    expect(normalizeCodexApiKeyGroupMode(undefined)).toBe("isolated");
    expect(normalizeCodexApiKeyGroupMode("unexpected")).toBe("isolated");
    expect(normalizeCodexApiKeyGroupMode("round_robin")).toBe("round_robin");
  });

  it("creates a distinct visible model carrying the isolated group identity", () => {
    const models = buildCodexApiKeyGroupCatalog(
      catalog,
      [
        {
          id: "astra",
          label: "Astra",
          apiKeys: ["astra-key"],
          models: ["gpt-5.6-sol"],
          strategy: "fixed",
        },
      ],
      "isolated",
    );

    expect(models).toEqual([
      catalog[0],
      {
        ...catalog[0],
        model: "gpt-5.6-sol--ccg-astra",
        upstreamModel: "gpt-5.6-sol",
        displayName: "GPT-5.6 Sol [Astra]",
        apiKeyGroupId: "astra",
        apiKeyGroupGenerated: true,
        sortIndex: undefined,
      },
    ]);
  });

  it("does not create aliases for a shared round-robin pool", () => {
    expect(
      buildCodexApiKeyGroupCatalog(
        catalog,
        [
          {
            id: "astra",
            apiKeys: ["astra-key"],
            models: ["gpt-5.6-sol"],
          },
        ],
        "round_robin",
      ),
    ).toEqual(catalog);
  });

  it("removes generated projections before rebuilding the editable catalog", () => {
    expect(
      baseCodexCatalogModels([
        ...catalog,
        {
          model: "gpt-5.6-sol--ccg-astra",
          upstreamModel: "gpt-5.6-sol",
          apiKeyGroupId: "astra",
          apiKeyGroupGenerated: true,
        },
      ]),
    ).toEqual(catalog);
  });
});
