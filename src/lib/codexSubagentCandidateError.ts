/**
 * Diagnostic parsing for `validate_codex_subagent_v2_provider_candidate`
 * failures.
 *
 * The backend appends offending catalog model names after the stable error
 * code. Only catalog model names cross this UI boundary.
 */
export const CODEX_SUBAGENT_UNKNOWN_REASONING_CODE =
  "unknown_reasoning_capability_requires_declaration";

export type CodexSubagentCandidateError =
  | { kind: "incomplete"; models: string | null }
  | { kind: "other" };

export function parseCodexSubagentCandidateError(
  detail: string,
): CodexSubagentCandidateError {
  if (!detail.includes(CODEX_SUBAGENT_UNKNOWN_REASONING_CODE)) {
    return { kind: "other" };
  }
  const suffix = detail.split(CODEX_SUBAGENT_UNKNOWN_REASONING_CODE)[1];
  const models = suffix?.replace(/^\)\s*:?\s*/, "").trim();
  return { kind: "incomplete", models: models || null };
}
