import { describe, expect, it } from "vitest";
import {
  hasCodexCatalog,
  normalizeCodexCatalogSettings,
  readCodexCatalogSettings,
} from "@/lib/codexCatalogSchema";

describe("Codex catalog authority", () => {
  it("treats an explicit empty canonical catalog as authoritative", () => {
    const settings = {
      modelCatalog: { models: [] },
      model_catalog: { models: [{ model: "stale-model" }] },
    };

    expect(readCodexCatalogSettings(settings)).toEqual({ models: [] });
    expect(hasCodexCatalog(settings)).toBe(true);
    expect(normalizeCodexCatalogSettings(settings)).toMatchObject({
      modelCatalog: { models: [] },
    });
  });

  it("uses legacy data only when the canonical catalog is malformed", () => {
    const settings = {
      modelCatalog: { models: "not-an-array" },
      model_catalog: { models: [{ model: "legacy-model" }] },
    };

    expect(readCodexCatalogSettings(settings)).toEqual({
      models: [{ model: "legacy-model" }],
    });
    expect(normalizeCodexCatalogSettings(settings)).toMatchObject({
      modelCatalog: { models: [{ model: "legacy-model" }] },
    });
  });
});
