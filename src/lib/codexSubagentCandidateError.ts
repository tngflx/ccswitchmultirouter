/**
 * Diagnostic parsing for `validate_codex_subagent_v2_provider_candidate`
 * failures.
 *
 * The backend appends the offending catalog model names after the stable
 * error code so the UI can tell the user exactly which models to fix. Raw
 * profile keys never cross this boundary — only catalog model names do.
 */
export const CODEX_SUBAGENT_UNKNOWN_REASONING_CODE =
  "unknown_reasoning_capability_requires_declaration";

export type CodexSubagentCandidateError =
  { kind: "incomplete"; models: string | null } | { kind: "other" };

export function parseCodexSubagentCandidateError(
  detail: string,
): CodexSubagentCandidateError {
  if (!detail.includes(CODEX_SUBAGENT_UNKNOWN_REASONING_CODE)) {
    return { kind: "other" };
  }
  const suffix = detail.split(CODEX_SUBAGENT_UNKNOWN_REASONING_CODE)[1];
  // Backend format: "...(unknown_reasoning_capability_requires_declaration): model-a, model-b"
  const models = suffix?.replace(/^\)\s*:?\s*/, "").trim();
  return { kind: "incomplete", models: models ? models : null };
}
