import { describe, expect, it } from "vitest";
import {
  buildCodexInputCapabilityReferenceMap,
  codexInputCapabilityPatch,
  hydrateCodexInputCapabilities,
  normalizeCodexInputCapability,
} from "@/components/providers/forms/codexInputCapability";
import { reconcileFetchedCodexCatalogRows } from "@/components/providers/forms/codexCatalogSync";

describe("catalog input metadata preservation", () => {
  it("retains other modalities when toggling images and respects explicit exclusions during sync", () => {
    expect(
      codexInputCapabilityPatch("text_only", {
        model: "audio",
        inputModalities: ["text", "image", "audio"],
      }).inputModalities,
    ).toEqual(["text", "audio"]);
    const result = reconcileFetchedCodexCatalogRows(
      [{ model: "override", supportsImage: false, enabled: false }],
      [
        {
          id: "override",
          inputModalities: ["text", "image"],
          supportsImage: true,
        },
      ],
      {},
      {
        appendNew: true,
        createRow: (row) =>
          row as { model: string; supportsImage: boolean; enabled: boolean },
      },
    );
    expect(result.rows[0]).toMatchObject({
      supportsImage: false,
      enabled: false,
    });
    expect(result.rows[0]).not.toHaveProperty("inputModalities");
  });
  it("preserves file, audio and video declarations during normalization and hydration", () => {
    const model = {
      model: "multimodal",
      inputModalities: ["text", "image", "file", "audio", "video"],
    };
    expect(normalizeCodexInputCapability(model).inputModalities).toEqual(
      model.inputModalities,
    );
    const references = buildCodexInputCapabilityReferenceMap([[model]]);
    expect(
      hydrateCodexInputCapabilities([{ model: "multimodal" }], references)[0],
    ).toMatchObject(model);
  });
  it("keeps contradictory explicit declarations unknown instead of replacing them with a preset", () => {
    const model = {
      model: "conflict",
      inputModalities: ["text"],
      supportsImage: true,
    };
    const references = buildCodexInputCapabilityReferenceMap([
      [{ model: "conflict", supportsImage: false }],
    ]);
    expect(hydrateCodexInputCapabilities([model], references)[0]).toEqual(
      model,
    );
  });
});
