import { describe, expect, it } from "vitest";
import type {
  CodexCatalogModel,
  CodexModelReasoningCapability,
  CodexReasoningEvidenceScope,
} from "@/types";
import {
  normalizeCodexCatalogSettings,
  normalizeCodexReasoning,
  readCodexCatalogSettings,
} from "./codexCatalogSchema";
import {
  reconcileFetchedCodexCatalogRows,
  type CodexCatalogRowLike,
} from "./codexCatalogReconciliation";
import { normalizeCodexCatalogReasoningForProvider } from "./codexReasoningProviderIdentity";

const scope: CodexReasoningEvidenceScope = {
  transportFingerprint: "a".repeat(64),
  model: "gpt-wire-model",
};

function capability(
  source: CodexModelReasoningCapability["source"] = "detection",
): CodexModelReasoningCapability {
  return {
    schemaVersion: 2,
    supportStatus: "confirmed_supported",
    controlKind: "graded",
    supportedEfforts: ["high", "max"],
    defaultEffort: "max",
    disableAllowed: false,
    upstream: {
      format: "reasoning_object",
      parameter: "reasoning.effort",
      effortMap: { high: "high", max: "max" },
    },
    source,
    evidenceScope: structuredClone(scope),
  };
}

function roundtripModels(models: CodexCatalogModel[]): CodexCatalogModel[] {
  const normalized = normalizeCodexCatalogSettings({
    modelCatalog: { models },
  });
  const saved = JSON.parse(JSON.stringify(normalized));
  return readCodexCatalogSettings(saved)?.models as CodexCatalogModel[];
}

describe("Codex reasoning evidence scope preservation", () => {
  it("roundtrips canonical validated evidence without regenerating or stripping it", () => {
    const reasoning = capability("user_confirmed_detection");
    const before = structuredClone(reasoning);
    const normalized = normalizeCodexReasoning(reasoning);
    expect(normalized).toMatchObject({
      source: "user_confirmed_detection",
      evidenceScope: scope,
    });
    const [row] = roundtripModels([
      {
        model: "Visible catalog alias",
        upstreamModel: "gpt-wire-model",
        reasoning,
      },
    ]);
    expect(row.reasoning?.evidenceScope).toEqual(scope);
    expect(row.reasoning?.source).toBe("user_confirmed_detection");
    expect(reasoning).toEqual(before);
  });

  it("preserves fetched scope through both refreshed and appended catalog rows", () => {
    const reasoning = capability();
    const staleReasoning = capability();
    staleReasoning.evidenceScope = {
      transportFingerprint: "b".repeat(64),
      model: "gpt-wire-model",
    };
    const newScope = { ...scope, model: "new-wire-model" };
    const fetched = [
      { id: "gpt-wire-model", reasoning },
      {
        id: "new-wire-model",
        reasoning: { ...capability(), evidenceScope: newScope },
      },
    ];
    const before = structuredClone(fetched);
    const result = reconcileFetchedCodexCatalogRows(
      [
        {
          model: "Visible catalog alias",
          upstreamModel: "gpt-wire-model",
          enabled: false,
          reasoning: staleReasoning,
        },
      ],
      fetched,
      {},
      {
        appendNew: true,
        createRow: (seed) => seed as CodexCatalogRowLike,
        existingMetadataMode: "refresh",
      },
    );
    const [refreshed, appended] = roundtripModels(result.rows);
    expect(refreshed.reasoning?.evidenceScope).toEqual(scope);
    expect(refreshed.reasoning?.source).toBe("detection");
    expect(refreshed.enabled).toBe(false);
    expect(appended.reasoning?.evidenceScope).toEqual(newScope);
    expect(appended.reasoning?.source).toBe("detection");
    expect(fetched).toEqual(before);
  });

  it.each([
    "provider",
    "detection",
    "user_confirmed_detection",
    "user",
  ] as const)(
    "preserves %s scope while normalizing the maintained Sublyx GPT contract",
    (source) => {
      const row: CodexCatalogModel = {
        model: "Visible catalog alias",
        upstreamModel: "gpt-wire-model",
        reasoning: capability(source),
      };
      const before = structuredClone(row);
      const normalized = normalizeCodexCatalogReasoningForProvider(row, {
        baseUrl: "https://api.sublyx.org/v1",
      });
      expect(normalized.reasoning?.supportedEfforts).toEqual([
        "low",
        "medium",
        "high",
        "xhigh",
      ]);
      const [saved] = roundtripModels([normalized]);
      expect(saved.reasoning?.evidenceScope).toEqual(scope);
      expect(saved.reasoning?.source).toBe(source);
      expect(saved.reasoning?.providerKey).toBe("sublyx");
      expect(row).toEqual(before);
    },
  );

  it("does not rewrite known-other transport evidence from stale Sublyx provenance", () => {
    const reasoning = capability("sublyx");
    reasoning.providerKey = "sublyx";
    const row: CodexCatalogModel = {
      model: "gpt-visible-sublyx",
      upstreamModel: "gpt-wire-model",
      reasoning,
    };
    const normalized = normalizeCodexCatalogReasoningForProvider(row, {
      baseUrl: "https://api.deepseek.com/v1",
      providerKind: "sublyx",
    });
    expect(normalized).toBe(row);
    const [saved] = roundtripModels([normalized]);
    expect(saved.reasoning?.supportedEfforts).toEqual(["high", "max"]);
    expect(saved.reasoning?.evidenceScope).toEqual(scope);
    expect(saved.reasoning?.source).toBe("sublyx");
  });
});
