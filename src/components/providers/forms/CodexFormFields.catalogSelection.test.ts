import { describe, expect, it } from "vitest";
import {
  capabilityFromReasoningDetection,
  selectOnlyDiscoveredCodexCatalogRows,
  updateCodexCatalogRowModelBinding,
} from "./CodexFormFields";
import type { CodexCatalogModel, CodexModelReasoningCapability } from "@/types";

describe("selectOnlyDiscoveredCodexCatalogRows", () => {
  it("enables discovered upstream IDs and preserves row metadata", () => {
    const rows = [
      {
        rowId: "old-model",
        model: "gpt-5.4",
        enabled: true,
        contextWindow: 128000,
      },
      {
        rowId: "terra-alias",
        model: "Terra",
        upstreamModel: " gpt-6.1-terra ",
        enabled: false,
        contextWindow: 256000,
      },
    ];

    expect(
      selectOnlyDiscoveredCodexCatalogRows(rows, [" GPT-6.1-TERRA "]),
    ).toEqual([
      { ...rows[0], enabled: false },
      { ...rows[1], enabled: true },
    ]);
  });
});

const automaticReasoning: CodexModelReasoningCapability = {
  schemaVersion: 2,
  supportStatus: "confirmed_supported",
  controlKind: "graded",
  supportedEfforts: ["low", "high"],
  defaultEffort: "high",
  disableAllowed: false,
  upstream: { format: "reasoning_object", parameter: "reasoning.effort" },
  source: "detection",
};

const boundRow: CodexCatalogModel = {
  model: "favorite",
  upstreamModel: "wire-a",
  displayName: "My model",
  reasoning: automaticReasoning,
};

describe("updateCodexCatalogRowModelBinding", () => {
  it("replaces automatic reasoning with the selected upstream's declaration", () => {
    const nextReasoning: CodexModelReasoningCapability = {
      ...automaticReasoning,
      supportedEfforts: ["medium"],
      defaultEffort: "medium",
    };
    const result = updateCodexCatalogRowModelBinding(
      boundRow,
      { upstreamModel: "wire-b" },
      { id: "wire-b", ownedBy: null, reasoning: nextReasoning },
    );
    expect(result.reasoning).toEqual(nextReasoning);
    expect(result.model).toBe("favorite");
    expect(result.displayName).toBe("My model");
  });

  it.each([undefined, null])(
    "removes automatic reasoning when the selected upstream has no declaration (%s)",
    (reasoning) => {
      const result = updateCodexCatalogRowModelBinding(
        boundRow,
        { upstreamModel: "wire-b" },
        { id: "wire-b", ownedBy: null, reasoning },
      );
      expect(result).not.toHaveProperty("reasoning");
    },
  );

  it("invalidates automatic reasoning on a manual upstream edit", () => {
    expect(
      updateCodexCatalogRowModelBinding(boundRow, { upstreamModel: "wire-b" }),
    ).not.toHaveProperty("reasoning");
  });

  it.each([undefined, "user", "user_confirmed_detection"] as const)(
    "preserves an explicit declaration with source %s during rebinding",
    (source) => {
      const explicit = {
        ...automaticReasoning,
        source,
      } as CodexModelReasoningCapability;
      const result = updateCodexCatalogRowModelBinding(
        { ...boundRow, reasoning: explicit },
        { upstreamModel: "wire-b" },
        { id: "wire-b", ownedBy: null, reasoning: null },
      );
      expect(result.reasoning).toEqual(explicit);
    },
  );

  it("keeps reasoning when only the menu alias changes", () => {
    const result = updateCodexCatalogRowModelBinding(
      { ...boundRow, model: "wire-a", upstreamModel: undefined },
      { model: "favorite" },
    );
    expect(result.upstreamModel).toBe("wire-a");
    expect(result.reasoning).toEqual(automaticReasoning);
  });

  it("does not clear metadata for a no-op or case-only wire edit", () => {
    const result = updateCodexCatalogRowModelBinding(boundRow, {
      upstreamModel: " WIRE-A ",
    });
    expect(result.reasoning).toEqual(automaticReasoning);
  });
});

describe("capabilityFromReasoningDetection", () => {
  it("records explicit adoption without dropping provider identity or evidence scope", () => {
    const evidenceScope = {
      transportFingerprint: "test-transport-fingerprint",
      model: "provider/wire-model",
    };
    const adopted = capabilityFromReasoningDetection({
      found: {
        providerKey: "openrouter",
        model: "provider/wire-model",
        fetchedAt: 1,
        source: "openrouter_api",
        evidenceScope,
        reasoning: {
          supportedEfforts: ["low", "high"],
          defaultEffort: "high",
          mandatory: false,
        },
      },
    });
    expect(adopted).toMatchObject({
      supportedEfforts: ["low", "high"],
      defaultEffort: "high",
      source: "user_confirmed_detection",
      providerKey: "openrouter",
      evidenceScope,
    });
  });

  it("preserves the backend snapshot wire and output contract during explicit adoption", () => {
    const adopted = capabilityFromReasoningDetection({
      found: {
        providerKey: "openrouter",
        model: "provider/wire-model",
        fetchedAt: 1,
        source: "openrouter_api",
        reasoning: {
          supportedEfforts: ["low", "high"],
          defaultEffort: "high",
          mandatory: false,
          upstreamFormat: "string",
          upstreamParameter: "reasoning_effort",
          outputFormat: "reasoning_content",
        },
      },
    });
    expect(adopted?.upstream).toEqual({
      format: "string",
      parameter: "reasoning_effort",
      effortMap: { low: "low", high: "high" },
    });
    expect(adopted?.outputFormat).toBe("reasoning_content");
  });

  it.each([
    { supportedEfforts: [] },
    { supportedEfforts: ["none"] },
    { supportedEfforts: ["unadvertised-provider-effort"] },
  ])(
    "does not invent an effort ladder for metadata-only reasoning $supportedEfforts",
    ({ supportedEfforts }) => {
      expect(
        capabilityFromReasoningDetection({
          found: {
            providerKey: "openrouter",
            model: "provider/wire-model",
            fetchedAt: 1,
            source: "openrouter_api",
            reasoning: { supportedEfforts, mandatory: false },
          },
        }),
      ).toBeUndefined();
    },
  );
});
