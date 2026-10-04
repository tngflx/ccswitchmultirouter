import { describe, expect, it } from "vitest";
import {
  CODEX_SUBAGENT_UNKNOWN_REASONING_CODE,
  parseCodexSubagentCandidateError,
} from "@/lib/codexSubagentCandidateError";

describe("parseCodexSubagentCandidateError", () => {
  it("extracts the offending model list from the backend diagnostic", () => {
    const detail =
      "Invalid input: Codex subagent V2 configuration is incomplete " +
      `(${CODEX_SUBAGENT_UNKNOWN_REASONING_CODE}): ` +
      "deepseek-v4-pro-opencode-go, deepseek-flash-opencode-go";

    expect(parseCodexSubagentCandidateError(detail)).toEqual({
      kind: "incomplete",
      models: "deepseek-v4-pro-opencode-go, deepseek-flash-opencode-go",
    });
  });

  it("keeps code-only diagnostics working without a model list", () => {
    const detail = `Codex subagent V2 configuration is incomplete (${CODEX_SUBAGENT_UNKNOWN_REASONING_CODE})`;

    expect(parseCodexSubagentCandidateError(detail)).toEqual({
      kind: "incomplete",
      models: null,
    });
  });

  it("passes unrelated validation errors through untouched", () => {
    expect(
      parseCodexSubagentCandidateError(
        "Codex subagent V2 configuration is invalid (profile_key_model_mismatch)",
      ),
    ).toEqual({ kind: "other" });
    expect(parseCodexSubagentCandidateError("")).toEqual({ kind: "other" });
  });
});
