import { describe, expect, it } from "vitest";
import type { Provider } from "@/types";
import {
  findModelSource,
  readUnknownReasoningBlocker,
  readUnknownReasoningModels,
  unknownReasoningBlockerDetail,
} from "@/utils/codexSubagentReasoningBlocker";

const CODE = "unknown_reasoning_capability_requires_declaration";

function provider(model: string): Provider {
  return {
    id: `provider-${model}`,
    name: `Provider ${model}`,
    settingsConfig: { modelCatalog: { models: [{ model }] } },
  };
}

describe("codexSubagentReasoningBlocker", () => {
  it("parses and deduplicates models appended to the stable error code", () => {
    expect(
      readUnknownReasoningModels(`(${CODE}): Qwen3.8、qwen3.8, glm-5.3`),
    ).toEqual(["Qwen3.8", "glm-5.3"]);
  });

  it("keeps legacy errors actionable when no model list is present", () => {
    const message = `configuration is incomplete (${CODE})`;
    expect(readUnknownReasoningBlocker(message)).toEqual({
      models: [],
      message,
    });
    expect(unknownReasoningBlockerDetail([])).toContain(
      "provider catalog",
    );
  });

  it("finds the provider that owns a blocked catalog model", () => {
    expect(
      findModelSource([provider("deepseek-flash"), provider("Qwen3.8")], "qwen3.8")
        ?.id,
    ).toBe("provider-Qwen3.8");
  });
});
