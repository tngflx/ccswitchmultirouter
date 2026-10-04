# Codex Sub-Agent Candidate Error Parser Port

## Goal

Remove inline parsing of the stable Sub-Agent V2 validation error from the
fresh provider form and reuse one tested diagnostic parser at the UI boundary.

## Evidence

`ProviderForm` currently checks the backend error-code substring directly and
hardcodes the incomplete/validation messages. The legacy fork has a focused
parser that also preserves the backend's optional offending-model suffix. The
fresh refork already contains the four `providerForm.subagent*` translation
keys, so extracting the parser does not add a second validation path or a
locale migration.

## Decision

Add `src/lib/codexSubagentCandidateError.ts` as the sole parser for the
`validate_codex_subagent_v2_provider_candidate` diagnostic. Adapt the provider
form catch block to use the parser and existing translated messages. Keep
backend validation authoritative; this change only formats the error at the
frontend boundary.

## Alternatives

- Keep the inline substring check: rejected because it is an untested parser
  embedded in a large form and cannot surface model-specific diagnostics.
- Move validation into the parser: rejected because command/API validation
  ownership belongs to the existing backend and typed API wrapper.
- Copy the legacy form: rejected because it would overwrite fresh form
  ownership and unrelated architecture.

## Ownership Boundary

The parser owns diagnostic classification and suffix extraction. The API and
backend own validation; the form owns when to invoke validation and how to
toast the translated result.

## Affected Files

- `src/lib/codexSubagentCandidateError.ts`
- `src/components/providers/forms/ProviderForm.tsx`
- `tests/lib/codexSubagentCandidateError.test.ts`

## Status

- Approval: not-approved (routine extraction within the user's explicit
  porting request)
- Implementation: complete (2026-10-05)
- Verification: complete (2026-10-05)
- Runtime freshness: not-checked; no rebuilt desktop process requested

## Status Transitions

<!-- Append dated transitions; do not erase prior evidence. -->

2026-10-05: Added the shared parser, adapted `ProviderForm` to the existing
translated messages, and added focused parser coverage. The parser and
`ProviderForm.codexPreset` suites passed (23 tests), `pnpm typecheck`,
Prettier, and `git diff --check` passed. Runtime freshness remains not-checked
because no rebuilt desktop process was requested.
