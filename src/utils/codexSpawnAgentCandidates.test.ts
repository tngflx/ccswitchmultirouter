import { describe, expect, it } from "vitest";
import type { Provider } from "@/types";
import { readCodexModelCatalog } from "./codexSpawnAgentCandidates";

describe("readCodexModelCatalog", () => {
  it("reads the legacy snake_case catalog key", () => {
    const provider: Provider = {
      id: "legacy-catalog-provider",
      name: "Legacy Catalog Provider",
      category: "custom",
      settingsConfig: {
        model_catalog: {
          models: [{ model: "catalog-model" }],
          spawn_agent_models: ["catalog-model"],
        },
      },
    };

    expect(readCodexModelCatalog(provider)).toEqual({
      models: [{ model: "catalog-model" }],
      spawnAgentModels: ["catalog-model"],
    });
  });
});
