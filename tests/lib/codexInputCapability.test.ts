import { describe, expect, it } from "vitest";
import {
  buildCodexInputCapabilityReferenceMap,
  codexInputCapabilityPatch,
  codexInputCapabilityState,
  hydrateCodexInputCapabilities,
  normalizeCodexInputCapability,
} from "@/components/providers/forms/codexInputCapability";

describe("codex input capability metadata", () => {
  it("retains non-image modalities when applying a text-only patch", () => {
    expect(
      codexInputCapabilityPatch("text_only", {
        model: "audio-file",
        inputModalities: ["text", "image", "audio", "file"],
      }).inputModalities,
    ).toEqual(["text", "audio", "file"]);
  });

  it("preserves file, audio, and video declarations during normalization", () => {
    const model = {
      model: "multimodal",
      inputModalities: ["text", "image", "file", "audio", "video"],
    };
    expect(normalizeCodexInputCapability(model).inputModalities).toEqual(
      model.inputModalities,
    );
  });

  it("keeps contradictory declarations unknown", () => {
    expect(
      codexInputCapabilityState({
        model: "conflict",
        inputModalities: ["text"],
        supportsImage: true,
      }),
    ).toBe("unknown");
    expect(
      codexInputCapabilityState({
        model: "conflict",
        supportsImage: true,
        supports_image: false,
      }),
    ).toBe("unknown");
    expect(
      codexInputCapabilityState({
        model: "conflict",
        textOnly: true,
        text_only: false,
      }),
    ).toBe("unknown");
  });

  it("hydrates missing metadata only from an unambiguous reference", () => {
    const references = buildCodexInputCapabilityReferenceMap([
      [
        {
          model: "vision-model",
          upstreamModel: "provider/vision-model",
          inputModalities: ["text", "image"],
        },
      ],
    ]);
    expect(
      hydrateCodexInputCapabilities(
        [{ model: "provider/vision-model" }],
        references,
      )[0],
    ).toMatchObject({
      model: "provider/vision-model",
      inputModalities: ["text", "image"],
      supportsImage: true,
      textOnly: false,
    });
  });

  it("does not hydrate an identity with conflicting reference states", () => {
    const references = buildCodexInputCapabilityReferenceMap([
      [
        { model: "shared", supportsImage: true },
        { model: "shared", supportsImage: false },
      ],
    ]);
    expect(
      hydrateCodexInputCapabilities([{ model: "shared" }], references)[0],
    ).toEqual({ model: "shared" });
  });

  it("does not overwrite explicit metadata during hydration", () => {
    const references = buildCodexInputCapabilityReferenceMap([
      [{ model: "explicit", supportsImage: true }],
    ]);
    const model = { model: "explicit", supportsImage: false };
    expect(hydrateCodexInputCapabilities([model], references)[0]).toMatchObject(
      model,
    );
  });
});
