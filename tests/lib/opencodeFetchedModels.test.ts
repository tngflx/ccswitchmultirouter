import { describe, expect, it } from "vitest";
import { applyFetchedOpenCodeModel } from "@/components/providers/forms/helpers/opencodeFetchedModels";
import type { FetchedModel } from "@/lib/api/model-fetch";
import type { CodexModelReasoningCapability, OpenCodeModel } from "@/types";

const baseUrl = "https://api.example.com/v1";
const reasoning: CodexModelReasoningCapability = {
  schemaVersion: 2,
  supportStatus: "confirmed_supported",
  controlKind: "graded",
  supportedEfforts: ["low", "max", "ultra"],
  defaultEffort: "max",
  disableAllowed: false,
  upstream: { format: "reasoning_object", parameter: "reasoning.effort" },
};
const apply = (
  fetched: Partial<FetchedModel>,
  previous: OpenCodeModel = { name: "Old Model" },
  npm = "@ai-sdk/openai",
  targetChanged = true,
) =>
  applyFetchedOpenCodeModel(
    previous,
    { id: "new-model", ownedBy: null, ...fetched },
    npm,
    targetChanged,
    baseUrl,
  );

describe("native OpenCode fetched model projection", () => {
  it("maps Responses efforts to native SDK options without dropping max or ultra", () => {
    expect(apply({ reasoning })).toEqual({
      name: "new-model",
      reasoning: true,
      options: { reasoningEffort: "max" },
      variants: {
        low: { reasoningEffort: "low" },
        max: { reasoningEffort: "max" },
        ultra: { reasoningEffort: "ultra" },
      },
    });
  });

  it("uses OpenRouter's reasoning object for an OpenAI-compatible SDK", () => {
    expect(
      apply(
        { reasoning: { ...reasoning, disableAllowed: true } },
        undefined,
        "@ai-sdk/openai-compatible",
      ),
    ).toEqual({
      name: "new-model",
      reasoning: true,
      options: { reasoning: { effort: "max" } },
      variants: {
        none: { reasoning: { effort: "none" } },
        low: { reasoning: { effort: "low" } },
        max: { reasoning: { effort: "max" } },
        ultra: { reasoning: { effort: "ultra" } },
      },
    });
  });

  it("does not invent an effort default or variants for unknown control bindings", () => {
    expect(apply({ reasoning }, undefined, "@ai-sdk/anthropic")).toEqual({
      name: "new-model",
      reasoning: true,
    });
    expect(
      apply({
        reasoning: {
          ...reasoning,
          controlKind: "unknown",
          supportedEfforts: [],
          defaultEffort: undefined,
          upstream: { format: "none", parameter: "none" },
        },
      }),
    ).toEqual({ name: "new-model", reasoning: true });
  });

  it.each([
    { schemaVersion: 99 },
    { supportedEfforts: ["unexpected"] },
    { defaultEffort: "high" },
    { supportedEfforts: ["none", "max"], disableAllowed: false },
    { controlKind: "unexpected" },
    { upstream: { format: "string", parameter: "reasoning.effort" } },
    {
      upstream: {
        format: "reasoning_object",
        parameter: "reasoning.effort",
        effortMap: { max: "unexpected" },
      },
    },
  ])("does not publish malformed reasoning declarations: %o", (override) => {
    const malformed = {
      ...reasoning,
      ...override,
    } as unknown as CodexModelReasoningCapability;
    expect(apply({ reasoning: malformed })).toEqual({ name: "new-model" });
  });

  it("replaces explicit unsupported reasoning and clears stale same-model controls only", () => {
    expect(
      apply(
        {
          reasoning: {
            schemaVersion: 2,
            supportStatus: "confirmed_unsupported",
            controlKind: "none",
            supportedEfforts: [],
            disableAllowed: false,
            upstream: { format: "none", parameter: "none" },
          },
        },
        {
          name: "Custom Name",
          limit: { context: 128000, output: 32000 },
          reasoning: true,
          variants: { max: { reasoningEffort: "max" } },
          options: {
            reasoningEffort: "max",
            timeout: 12345,
            parallelToolCalls: false,
          },
        },
        "@ai-sdk/openai",
        false,
      ),
    ).toEqual({
      name: "Custom Name",
      limit: { context: 128000, output: 32000 },
      reasoning: false,
      options: { timeout: 12345, parallelToolCalls: false },
    });
  });

  it("preserves missing same-model facts while applying explicit text-only evidence", () => {
    const previous = {
      name: "Custom Name",
      limit: { context: 128000, output: 32000 },
      modalities: { input: ["text", "image", "audio"], output: ["audio"] },
      reasoning: true,
    };
    expect(apply({}, previous, undefined, false)).toEqual(previous);
    expect(
      apply(
        { contextWindow: 64000, supportsImage: false },
        previous,
        undefined,
        false,
      ),
    ).toEqual({
      ...previous,
      limit: { context: 64000, output: 32000 },
      modalities: { input: ["text", "audio"], output: ["audio"] },
    });
  });

  it("honors an explicit empty input declaration instead of retaining same-model modalities", () => {
    expect(
      apply(
        { inputModalities: [], supportsImage: false },
        {
          name: "Custom Name",
          modalities: { input: ["text", "image", "audio"], output: ["text"] },
        },
        undefined,
        false,
      ),
    ).toEqual({
      name: "Custom Name",
      modalities: { input: [], output: ["text"] },
    });
  });

  it("projects a valid provider-native none effort without dropping the complete declaration", () => {
    expect(
      apply({
        reasoning: {
          ...reasoning,
          supportedEfforts: ["none", "high"],
          defaultEffort: "none",
          disableAllowed: true,
        },
      }),
    ).toEqual({
      name: "new-model",
      reasoning: true,
      options: { reasoningEffort: "none" },
      variants: {
        none: { reasoningEffort: "none" },
        high: { reasoningEffort: "high" },
      },
    });
  });

  it("replaces conflicting parallel-tool aliases when refreshing the same model", () => {
    expect(
      apply(
        { supportsParallelToolCalls: false },
        {
          name: "Custom Name",
          options: {
            parallel_tool_calls: true,
            body: { parallel_tool_calls: true, region: "test" },
            timeout: 12345,
          },
        },
        "@ai-sdk/openai",
        false,
      ),
    ).toEqual({
      name: "Custom Name",
      options: {
        parallelToolCalls: false,
        body: { region: "test" },
        timeout: 12345,
      },
    });
  });

  it("keeps unrelated nested options but removes old model controls and output facts on target change", () => {
    expect(
      apply(
        {},
        {
          name: "Old",
          limit: { context: 1000000, output: 200000 },
          options: {
            body: {
              reasoning: { effort: "max" },
              chat_template_kwargs: {
                enable_thinking: true,
                custom_template: "local",
              },
              custom_flag: "keep",
            },
            timeout: 12345,
          },
          headers: { "X-Region": "test" },
          aliases: { "local-alias": "my-name" },
        },
      ),
    ).toEqual({
      name: "new-model",
      options: {
        body: {
          chat_template_kwargs: { custom_template: "local" },
          custom_flag: "keep",
        },
        timeout: 12345,
      },
      headers: { "X-Region": "test" },
      aliases: { "local-alias": "my-name" },
    });
  });

  it("retains all supported native input modalities and ignores malformed limits", () => {
    expect(
      apply({
        name: "Full Input",
        contextWindow: Number.NaN,
        inputModalities: ["text", "image", "audio", "video", "pdf"],
      }),
    ).toEqual({
      name: "Full Input",
      modalities: { input: ["text", "image", "audio", "video", "pdf"] },
    });
  });

  it("maps an explicit upstream binding but does not substitute a canonical slug", () => {
    expect(
      apply({
        canonicalSlug: "canonical-identity",
        upstreamModel: "wire-model",
      }),
    ).toEqual({ name: "new-model", id: "wire-model" });
    expect(apply({ canonicalSlug: "canonical-identity" })).toEqual({
      name: "new-model",
    });
  });

  it("applies only tool evidence bound to this provider endpoint and upstream model", () => {
    const protocolCapability = {
      schemaVersion: 1 as const,
      source: "provider_api" as const,
      baseUrl,
      upstreamModel: "new-model",
      supportedEndpoints: ["openai_chat" as const],
      supportsTools: false,
    };
    expect(apply({ protocolCapability })).toEqual({
      name: "new-model",
      tool_call: false,
    });
    expect(
      apply({
        protocolCapability: {
          ...protocolCapability,
          baseUrl: "https://other.example.com/v1",
        },
      }),
    ).toEqual({ name: "new-model" });
    expect(
      apply({
        protocolCapability: { ...protocolCapability, upstreamModel: "other" },
      }),
    ).toEqual({ name: "new-model" });
  });

  it.each([
    ["@ai-sdk/openai", { parallelToolCalls: false }],
    ["@ai-sdk/openai-compatible", { parallel_tool_calls: false }],
    ["@ai-sdk/anthropic", undefined],
  ])("uses only known parallel-tool spellings for %s", (npm, options) => {
    expect(
      apply({ supportsParallelToolCalls: false }, undefined, npm).options,
    ).toEqual(options);
  });
});
