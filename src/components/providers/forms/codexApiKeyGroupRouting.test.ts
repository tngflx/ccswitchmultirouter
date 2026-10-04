import { describe, expect, it } from "vitest";
import {
  baseCodexCatalogModels,
  buildCodexApiKeyGroupCatalog,
  normalizeCodexApiKeyGroupMode,
} from "./codexApiKeyGroupRouting";

const catalog = [{ model: "gpt-5.6-sol", upstreamModel: "gpt-5.6-sol" }];

describe("Codex API key group routing", () => {
  it("normalizes the persisted mode", () => {
    expect(normalizeCodexApiKeyGroupMode(undefined)).toBe("isolated");
    expect(normalizeCodexApiKeyGroupMode("round_robin")).toBe("round_robin");
  });

  it("projects isolated aliases and removes stale projections", () => {
    const group = { id: "astra", apiKeys: ["key"], models: ["gpt-5.6-sol"] };
    const projected = buildCodexApiKeyGroupCatalog(
      catalog,
      [group],
      "isolated",
    );
    expect(projected[1]).toMatchObject({
      model: "gpt-5.6-sol--ccg-astra",
      apiKeyGroupId: "astra",
      apiKeyGroupGenerated: true,
    });
    expect(baseCodexCatalogModels(projected)).toEqual(catalog);
  });

  it("does not project aliases for pooled mode or disabled groups", () => {
    const group = { id: "astra", apiKeys: ["key"], models: ["gpt-5.6-sol"] };
    expect(
      buildCodexApiKeyGroupCatalog(catalog, [group], "round_robin"),
    ).toEqual(catalog);
    expect(
      buildCodexApiKeyGroupCatalog(
        catalog,
        [{ ...group, enabled: false }],
        "isolated",
      ),
    ).toEqual(catalog);
  });
});
