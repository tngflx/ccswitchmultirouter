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

  it("preserves canonical API protocol declarations without promoting old format snapshots", () => {
    const protocolCapability = {
      schemaVersion: 1,
      source: "provider_api",
      baseUrl: "https://relay.example/v1",
      upstreamModel: "wire-model",
      supportedEndpoints: ["openai_chat"],
    };
    expect(
      normalizeCodexCatalogSettings({
        modelCatalog: {
          models: [
            {
              model: "public-model",
              upstream_model: "wire-model",
              protocolCapability,
            },
            {
              model: "legacy-model",
              api_format: "openai_responses",
              api_format_source: "probe",
            },
          ],
        },
      }),
    ).toMatchObject({
      modelCatalog: {
        models: [
          {
            model: "public-model",
            upstreamModel: "wire-model",
            protocolCapability,
          },
          {
            model: "legacy-model",
            apiFormat: "openai_responses",
            apiFormatSource: "probe",
          },
        ],
      },
    });
    const normalized = normalizeCodexCatalogSettings({
      modelCatalog: {
        models: [{ model: "legacy-model", api_format: "openai_responses" }],
      },
    });
    const catalog = readCodexCatalogSettings(normalized);
    expect((catalog?.models as unknown[])[0]).not.toHaveProperty(
      "protocolCapability",
    );
  });
});
