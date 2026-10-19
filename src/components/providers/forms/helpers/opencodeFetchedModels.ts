import type { FetchedModel } from "@/lib/api/model-fetch";
import {
  normalizeCodexModelProtocolCapability,
  normalizeCodexProtocolCapabilityBaseUrl,
} from "@/lib/codexProtocolCapability";
import type {
  CodexModelReasoningCapability,
  CodexReasoningEffort,
  OpenCodeModel,
} from "@/types";

const MODEL_FACT_KEYS = new Set([
  "name",
  "id",
  "family",
  "release_date",
  "attachment",
  "reasoning",
  "temperature",
  "tool_call",
  "interleaved",
  "cost",
  "limit",
  "modalities",
  "experimental",
  "status",
  "provider",
  "variants",
  "capabilities",
  "package",
  "supportsImage",
  "supportsParallelToolCalls",
]);
const REASONING_OPTION_KEYS = new Set([
  "thinking",
  "enableThinking",
  "enable_thinking",
  "reasoning",
  "reasoningEffort",
  "reasoning_effort",
  "reasoningSummary",
  "reasoning_split",
  "thinkingBudget",
  "thinkingConfig",
  "effort",
]);
const PARALLEL_OPTION_KEYS = new Set([
  "parallelToolCalls",
  "parallel_tool_calls",
  "disableParallelToolUse",
]);
const EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
const INPUT_MODALITIES = new Set(["text", "image", "audio", "video", "pdf"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function withoutOptions(
  options: unknown,
  keys: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  if (!isRecord(options)) return undefined;
  const entries = Object.entries(options).flatMap(([key, value]) => {
    if (keys.has(key)) return [];
    if (["body", "extraBody", "chat_template_kwargs"].includes(key)) {
      const nested = withoutOptions(value, keys);
      return nested && Object.keys(nested).length > 0 ? [[key, nested]] : [];
    }
    return [[key, value]];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function clearReasoningOptions(model: OpenCodeModel): void {
  const options = withoutOptions(model.options, REASONING_OPTION_KEYS);
  if (options) model.options = options;
  else delete model.options;
}

function setOption(model: OpenCodeModel, key: string, value: unknown): void {
  model.options = { ...model.options, [key]: value };
}

function validatedReasoning(
  value: unknown,
): CodexModelReasoningCapability | undefined {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 2 ||
    !["confirmed_supported", "confirmed_unsupported", "unknown"].includes(
      String(value.supportStatus),
    ) ||
    !Array.isArray(value.supportedEfforts) ||
    !value.supportedEfforts.every(
      (effort) => typeof effort === "string" && EFFORTS.has(effort),
    ) ||
    typeof value.disableAllowed !== "boolean" ||
    !isRecord(value.upstream) ||
    !["none", "boolean", "graded", "budget", "unknown"].includes(
      String(value.controlKind),
    ) ||
    !["none", "boolean", "string", "reasoning_object"].includes(
      String(value.upstream.format),
    ) ||
    ![
      "none",
      "thinking",
      "enable_thinking",
      "reasoning_split",
      "reasoning_effort",
      "reasoning.effort",
    ].includes(String(value.upstream.parameter))
  ) {
    return undefined;
  }
  if (
    value.defaultEffort !== undefined &&
    !value.supportedEfforts.includes(value.defaultEffort)
  ) {
    return undefined;
  }
  if (value.supportedEfforts.includes("none") && !value.disableAllowed) {
    return undefined;
  }
  if (
    value.upstream.effortMap !== undefined &&
    (!isRecord(value.upstream.effortMap) ||
      !Object.entries(value.upstream.effortMap).every(
        ([key, mapped]) =>
          EFFORTS.has(key) && typeof mapped === "string" && EFFORTS.has(mapped),
      ))
  ) {
    return undefined;
  }
  if (
    value.supportStatus === "confirmed_unsupported" &&
    (value.controlKind !== "none" ||
      value.supportedEfforts.length > 0 ||
      value.disableAllowed ||
      value.upstream.format !== "none" ||
      value.upstream.parameter !== "none")
  ) {
    return undefined;
  }
  if (
    value.controlKind === "graded" &&
    (value.supportedEfforts.length === 0 ||
      !(
        (value.upstream.format === "string" &&
          value.upstream.parameter === "reasoning_effort") ||
        (value.upstream.format === "reasoning_object" &&
          value.upstream.parameter === "reasoning.effort")
      ))
  ) {
    return undefined;
  }
  return value as unknown as CodexModelReasoningCapability;
}

function applyReasoning(
  model: OpenCodeModel,
  value: unknown,
  npm: string,
): void {
  const reasoning = validatedReasoning(value);
  if (!reasoning || reasoning.supportStatus === "unknown") return;
  model.reasoning = reasoning.supportStatus === "confirmed_supported";
  delete model.variants;
  clearReasoningOptions(model);
  if (
    !model.reasoning ||
    reasoning.controlKind !== "graded" ||
    reasoning.supportedEfforts.length === 0
  ) {
    return;
  }

  const { format, parameter, effortMap } = reasoning.upstream;
  // Native SDK option names are not the HTTP parameter names. Only translate
  // bindings whose SDK spelling is known; arbitrary providers retain no controls.
  const optionsForEffort =
    (npm === "@ai-sdk/openai" || npm === "@ai-sdk/openai-compatible") &&
    ((format === "string" && parameter === "reasoning_effort") ||
      (npm === "@ai-sdk/openai" &&
        format === "reasoning_object" &&
        parameter === "reasoning.effort"))
      ? (effort: string) => ({ reasoningEffort: effort })
      : (npm === "@ai-sdk/openai-compatible" ||
            npm === "@openrouter/ai-sdk-provider") &&
          format === "reasoning_object" &&
          parameter === "reasoning.effort"
        ? (effort: string) => ({ reasoning: { effort } })
        : undefined;
  if (!optionsForEffort) return;
  const efforts: CodexReasoningEffort[] = [
    ...(reasoning.disableAllowed ? (["none"] as const) : []),
    ...reasoning.supportedEfforts,
  ];
  model.variants = Object.fromEntries(
    [...new Set(efforts)].map((effort) => [
      effort,
      optionsForEffort(effortMap?.[effort] ?? effort),
    ]),
  );
  if (reasoning.defaultEffort) {
    model.options = {
      ...model.options,
      ...optionsForEffort(
        effortMap?.[reasoning.defaultEffort] ?? reasoning.defaultEffort,
      ),
    };
  }
}

/**
 * A fetched selection changes the target, unlike a deliberate manual alias
 * rename. Keep user headers/custom options, never another model's capability facts.
 */
export function applyFetchedOpenCodeModel(
  previous: OpenCodeModel,
  fetched: FetchedModel,
  npm: string,
  targetChanged: boolean,
  baseUrl: string,
): OpenCodeModel {
  const model = targetChanged
    ? ({
        ...Object.fromEntries(
          Object.entries(previous).filter(([key]) => !MODEL_FACT_KEYS.has(key)),
        ),
        name: fetched.id,
      } as OpenCodeModel)
    : { ...previous };
  if (targetChanged) {
    const options = withoutOptions(
      model.options,
      new Set([...REASONING_OPTION_KEYS, ...PARALLEL_OPTION_KEYS]),
    );
    if (options) model.options = options;
    else delete model.options;
  }
  const name = fetched.displayName?.trim() || fetched.name?.trim();
  if (name) model.name = name;
  if (fetched.upstreamModel?.trim()) model.id = fetched.upstreamModel.trim();
  if (
    typeof fetched.contextWindow === "number" &&
    Number.isSafeInteger(fetched.contextWindow) &&
    fetched.contextWindow > 0
  ) {
    // Output limits are absent from the fetch contract; never borrow the old target's.
    model.limit = { ...model.limit, context: fetched.contextWindow };
  }

  let input =
    Array.isArray(fetched.inputModalities) &&
    fetched.inputModalities.every((value) => INPUT_MODALITIES.has(value))
      ? [...new Set(fetched.inputModalities)]
      : undefined;
  if (typeof fetched.supportsImage === "boolean") {
    if (!input && isRecord(model.modalities)) {
      const existing = model.modalities.input;
      if (
        Array.isArray(existing) &&
        existing.every((value) => INPUT_MODALITIES.has(value))
      ) {
        input = [...existing];
      }
    }
    input ??= ["text"];
    input = fetched.supportsImage
      ? [...new Set([...input, "image"])]
      : input.filter((value) => value !== "image");
  }
  if (input) {
    model.modalities = {
      ...(isRecord(model.modalities) ? model.modalities : {}),
      input,
    };
  }
  const effectiveNpm =
    isRecord(model.provider) && typeof model.provider.npm === "string"
      ? model.provider.npm
      : npm;
  const protocol = normalizeCodexModelProtocolCapability(
    fetched.protocolCapability,
  );
  if (
    protocol &&
    protocol.baseUrl === normalizeCodexProtocolCapabilityBaseUrl(baseUrl) &&
    protocol.upstreamModel === (fetched.upstreamModel?.trim() || fetched.id) &&
    typeof protocol.supportsTools === "boolean"
  ) {
    model.tool_call = protocol.supportsTools;
  }
  applyReasoning(model, fetched.reasoning, effectiveNpm);
  if (typeof fetched.supportsParallelToolCalls === "boolean") {
    const parallelOption =
      effectiveNpm === "@ai-sdk/openai-compatible"
        ? "parallel_tool_calls"
        : effectiveNpm === "@ai-sdk/openai" ||
            effectiveNpm === "@openrouter/ai-sdk-provider"
          ? "parallelToolCalls"
          : null;
    if (parallelOption) {
      const options = withoutOptions(model.options, PARALLEL_OPTION_KEYS);
      if (options) model.options = options;
      else delete model.options;
      setOption(model, parallelOption, fetched.supportsParallelToolCalls);
    }
  }
  return model;
}
