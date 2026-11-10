import { describe, expect, it } from "vitest";
import type { CodexCatalogModel, CodexModelReasoningCapability } from "@/types";

import {
  CodexCatalogValidationError,
  normalizeCodexCatalogModelsForSave,
} from "./ProviderForm";
import {
  applyCodexReasoningCapabilitySource,
  validateCodexReasoningCapabilityDraft,
} from "./CodexFormFields";
import { completeCodexReasoningEffortMap } from "./codexReasoningCapability";

describe("Codex catalog reasoning capability persistence", () => {
  it("separates automatic, maintained and manual capability sources", () => {
    const maintained: CodexModelReasoningCapability = {
      supported: true,
      supportedEfforts: ["low", "high", "max"],
      defaultEffort: "high" as const,
      disableAllowed: true,
      upstream: {
        format: "string" as const,
        parameter: "reasoning_effort" as const,
        effortMap: {
          low: "low" as const,
          high: "high" as const,
          max: "max" as const,
        },
      },
      source: "builtin" as const,
    };

    expect(
      applyCodexReasoningCapabilitySource("automatic", undefined, maintained),
    ).toBeUndefined();
    expect(
      applyCodexReasoningCapabilitySource("builtin", undefined, maintained),
    ).toEqual(maintained);
    expect(
      applyCodexReasoningCapabilitySource("manual", maintained, maintained),
    ).toEqual(expect.objectContaining({ source: "user" }));
  });

  it("requires a selected Provider effort when Ultra is unlocked", () => {
    let caught: unknown;
    try {
      normalizeCodexCatalogModelsForSave([
        { model: "deepseek", codexUltra: { enabled: true } },
      ]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CodexCatalogValidationError);
    expect(caught).toHaveProperty("model", "deepseek");
    expect((caught as Error).message).toContain(
      "none of the changes were saved",
    );

    expect(
      normalizeCodexCatalogModelsForSave([
        {
          model: "deepseek",
          codexUltra: { enabled: true, providerEffort: "high" },
        },
      ]),
    ).toEqual([
      {
        model: "deepseek",
        codexUltra: { enabled: true, providerEffort: "high" },
      },
    ]);
  });

  it("classifies non-Ultra reasoning validation as a structured catalog error", () => {
    expect(() =>
      normalizeCodexCatalogModelsForSave([
        {
          model: "invalid-default",
          reasoning: {
            supported: true,
            supportedEfforts: ["low"],
            defaultEffort: "high",
            disableAllowed: false,
            upstream: {
              format: "string",
              parameter: "reasoning_effort",
            },
          },
        },
      ]),
    ).toThrow(CodexCatalogValidationError);
  });

  it("preserves a valid user model reasoning override", () => {
    const [model] = normalizeCodexCatalogModelsForSave([
      {
        model: "private-model",
        reasoning: {
          supported: true,
          supportedEfforts: ["low", "high"],
          defaultEffort: "high",
          disableAllowed: false,
          upstream: {
            format: "string",
            parameter: "reasoning_effort",
            effortMap: { low: "low", high: "high" },
          },
          source: "user",
        },
      },
    ]);
    expect(model.reasoning).toEqual(
      expect.objectContaining({
        supportedEfforts: ["low", "high"],
        defaultEffort: "high",
        source: "user",
      }),
    );
  });

  it("accepts schema v2 expert JSON without the legacy supported field", () => {
    expect(() =>
      validateCodexReasoningCapabilityDraft({
        schemaVersion: 2,
        supportStatus: "confirmed_supported",
        controlKind: "graded",
        supportedEfforts: ["low", "medium", "xhigh"],
        defaultEffort: "medium",
        disableAllowed: false,
        upstream: {
          format: "string",
          parameter: "reasoning_effort",
          effortMap: {
            low: "low",
            medium: "medium",
            xhigh: "xhigh",
          },
        },
        outputFormat: "reasoning_content",
        source: "user",
      }),
    ).not.toThrow();
  });

  it("rejects a default effort outside the supported list", () => {
    expect(() =>
      normalizeCodexCatalogModelsForSave([
        {
          model: "broken-model",
          reasoning: {
            supported: true,
            supportedEfforts: ["low"],
            defaultEffort: "high",
            disableAllowed: false,
            upstream: { format: "string", parameter: "reasoning_effort" },
          },
        },
      ]),
    ).toThrow(/The default reasoning effort must be included/);
  });

  it("rejects expert JSON mappings before they can mutate the draft", () => {
    expect(() =>
      validateCodexReasoningCapabilityDraft({
        supported: true,
        supportedEfforts: ["low", "high"],
        defaultEffort: "high",
        disableAllowed: false,
        upstream: {
          format: "string",
          parameter: "reasoning_effort",
          effortMap: { medium: "max" },
        },
        source: "user",
      }),
    ).toThrow(/Mapping target max is not supported by the provider/);
  });

  it("automatically fills identity mappings for every Provider-native effort", () => {
    expect(
      completeCodexReasoningEffortMap({
        supportedEfforts: ["low", "medium", "high"],
        effortMap: { xhigh: "high" },
      }),
    ).toEqual({
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "high",
    });
  });

  it("rejects incomplete expert JSON but completes identity mappings on save", () => {
    expect(() =>
      validateCodexReasoningCapabilityDraft({
        schemaVersion: 2,
        supportStatus: "confirmed_supported",
        controlKind: "graded",
        supportedEfforts: ["low", "medium", "high"],
        defaultEffort: "medium",
        disableAllowed: false,
        upstream: {
          format: "string",
          parameter: "reasoning_effort",
        },
        source: "user",
      }),
    ).toThrow(/Reasoning-effort mapping is missing low, medium, high/);

    const [saved] = normalizeCodexCatalogModelsForSave([
      {
        model: "qwen3.8",
        reasoning: {
          schemaVersion: 2,
          supportStatus: "confirmed_supported",
          controlKind: "graded",
          supportedEfforts: ["low", "medium", "high"],
          defaultEffort: "medium",
          disableAllowed: false,
          upstream: {
            format: "string",
            parameter: "reasoning_effort",
          },
          source: "user",
        },
      },
    ]);
    expect(saved.reasoning?.upstream.effortMap).toEqual({
      low: "low",
      medium: "medium",
      high: "high",
    });
  });

  it("does not require effort mappings for boolean controls", () => {
    expect(() =>
      validateCodexReasoningCapabilityDraft({
        schemaVersion: 2,
        supportStatus: "confirmed_supported",
        controlKind: "boolean",
        supportedEfforts: [],
        disableAllowed: true,
        upstream: {
          format: "boolean",
          parameter: "enable_thinking",
        },
        source: "user",
      }),
    ).not.toThrow();
  });

  it("accepts Codex Ultra orchestration with an explicit Provider-native target", () => {
    expect(() =>
      validateCodexReasoningCapabilityDraft({
        schemaVersion: 2,
        supportStatus: "confirmed_supported",
        controlKind: "graded",
        supportedEfforts: ["low", "medium", "high", "xhigh"],
        defaultEffort: "medium",
        disableAllowed: false,
        upstream: {
          format: "reasoning_object",
          parameter: "reasoning.effort",
          effortMap: {
            low: "low",
            medium: "medium",
            high: "high",
            xhigh: "xhigh",
          },
        },
        source: "user",
        codexUltraOrchestration: {
          enabled: true,
          providerEffort: "xhigh",
        },
      }),
    ).not.toThrow();
  });

  it("rejects Codex Ultra orchestration when the Provider cannot receive its target", () => {
    expect(() =>
      validateCodexReasoningCapabilityDraft({
        supported: true,
        supportedEfforts: ["low", "high"],
        defaultEffort: "high",
        disableAllowed: false,
        upstream: {
          format: "string",
          parameter: "reasoning_effort",
          effortMap: { low: "low", high: "high" },
        },
        source: "user",
        codexUltraOrchestration: { enabled: true },
      } as unknown as CodexModelReasoningCapability),
    ).toThrow(/Ultra.*provider/i);
  });

  it("rejects Ultra as a Provider-native effort", () => {
    expect(() =>
      validateCodexReasoningCapabilityDraft({
        supported: true,
        supportedEfforts: ["high", "ultra"],
        defaultEffort: "high",
        disableAllowed: false,
        upstream: {
          format: "string",
          parameter: "reasoning_effort",
          effortMap: { high: "high", ultra: "high" },
        },
        source: "user",
      }),
    ).toThrow(/unknown or Codex-only level/);
  });
  it("normalizes retired Sublyx GPT efforts on save without touching the editor", () => {
    const row: CodexCatalogModel = {
      model: "public-model",
      upstreamModel: "gpt-6.1-sol",
      reasoning: {
        schemaVersion: 2,
        supportStatus: "confirmed_supported",
        controlKind: "graded",
        supportedEfforts: ["low", "high", "max", "ultra"],
        defaultEffort: "ultra",
        disableAllowed: true,
        upstream: {
          format: "string",
          parameter: "reasoning_effort",
          effortMap: { low: "low", high: "max", max: "max", ultra: "ultra" },
        },
        source: "user",
        codexUltraOrchestration: { enabled: true, providerEffort: "max" },
      },
      codexUltra: { enabled: false, providerEffort: "max" },
    };
    const snapshot = JSON.stringify(row);
    const [saved] = normalizeCodexCatalogModelsForSave([row], {
      baseUrl: "https://api.sublyx.com/v1",
    });
    expect(saved.reasoning).toMatchObject({
      schemaVersion: 2,
      supportStatus: "confirmed_supported",
      controlKind: "graded",
      source: "user",
      providerKey: "sublyx",
      disableAllowed: false,
      upstream: { format: "reasoning_object", parameter: "reasoning.effort" },
      supportedEfforts: ["low", "medium", "high", "xhigh"],
      defaultEffort: "xhigh",
      codexUltraOrchestration: { enabled: true, providerEffort: "xhigh" },
    });
    expect(saved.reasoning?.upstream.effortMap).toEqual({
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    });
    expect(saved.codexUltra).toEqual({
      enabled: false,
      providerEffort: "xhigh",
    });
    expect(JSON.stringify(row)).toBe(snapshot);
  });

  it("normalizes a legacy Sublyx Ultra overlay even without a manual capability", () => {
    expect(
      normalizeCodexCatalogModelsForSave(
        [
          {
            model: "gpt-6.1",
            codexUltra: { enabled: true, providerEffort: "max" },
          },
        ],
        { baseUrl: "https://api.sublyx.com/v1" },
      )[0].codexUltra,
    ).toEqual({ enabled: true, providerEffort: "xhigh" });
  });

  it.each([
    {
      model: "gpt-6.1-sublyx",
      baseUrl: "https://openrouter.ai/api/v1",
      source: "sublyx" as const,
    },
    {
      model: "claude-sonnet",
      baseUrl: "https://api.sublyx.com/v1",
      source: "sublyx" as const,
    },
    {
      model: "gpt-6.1-sublyx",
      baseUrl: "https://generic.example/v1",
      source: "user" as const,
    },
    {
      model: "gpt-6.1-sublyx",
      baseUrl: "https://generic.example/v1",
      source: "sublyx" as const,
    },
  ])(
    "preserves native max for $model through $baseUrl",
    ({ model, baseUrl, source }) => {
      const [saved] = normalizeCodexCatalogModelsForSave(
        [
          {
            model,
            reasoning: {
              supported: true,
              supportedEfforts: ["high", "max"],
              defaultEffort: "max",
              disableAllowed: false,
              source,
              upstream: {
                format: "string",
                parameter: "reasoning_effort",
                effortMap: { high: "high", max: "max" },
              },
            },
            codexUltra: { enabled: true, providerEffort: "max" },
          },
        ],
        { baseUrl },
      );
      expect(saved.reasoning?.supportedEfforts).toEqual(["high", "max"]);
      expect(saved.reasoning?.defaultEffort).toBe("max");
      expect(saved.codexUltra?.providerEffort).toBe("max");
    },
  );

  it("saves a GPT-looking public alias for a non-GPT wire model without Sublyx GPT normalization", () => {
    const [saved] = normalizeCodexCatalogModelsForSave(
      [
        {
          model: "gpt-public-alias",
          upstreamModel: "claude-sonnet",
          reasoning: {
            supported: true,
            supportedEfforts: ["max"],
            defaultEffort: "max",
            disableAllowed: false,
            source: "user",
            upstream: {
              format: "string",
              parameter: "reasoning_effort",
              effortMap: { max: "max" },
            },
          },
          codexUltra: { enabled: true, providerEffort: "max" },
        },
      ],
      { baseUrl: "https://api.sublyx.com/v1" },
    );
    expect(saved.reasoning?.supportedEfforts).toEqual(["max"]);
    expect(saved.codexUltra?.providerEffort).toBe("max");
  });
});
