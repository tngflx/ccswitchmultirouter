# Codex routed reasoning capability inheritance

## Goal

Populate the Codex Desktop reasoning-effort picker for routed provider rows whose
catalog entry identifies an official upstream model but omits an inline
`reasoning` declaration, without inventing capabilities for arbitrary custom
models.

## Evidence

Fresh-refork catalog normalization is already the single schema owner, and the
shared reasoning resolver is already used by Codex config/request paths. The
MultiRouter compiler only copied `modelCatalog.models[].reasoning` and provider
settings; it never resolved the declared `upstreamModel` through that resolver.
As a result, Sublyx rows such as `gpt-5.6-sol-sublyx -> gpt-5.6-sol` reached the
Desktop projection without supported efforts even when Codex's official cache
advertised them.

## Decision

At the MultiRouter compiler boundary, after explicit model/provider declarations
and before projection, resolve only an explicit `upstreamModel` alias through the
existing shared resolver using the official cache. Accept the result only when
its source is `official`; unknown/custom models remain fail-closed. Keep the
canonical `reasoning` object and camelCase projection unchanged. Do not add a
second parser or infer from arbitrary model-name substrings.

## Alternatives

- Populate every provider row by copying official capabilities: rejected because
  custom endpoints may not implement the upstream contract.
- Add UI-only defaults: rejected because request conversion and Desktop metadata
  would diverge.
- Treat `codexRouting.defaultReasoningEffort` as capability evidence: rejected;
  it is a preference, not a supported-efforts declaration.

## Approval / implementation / verification

- Approval: user-approved root fix; no separate approval was required for this
  scoped bug fix.
- Implementation: complete (2026-10-05); compiler-side official upstream alias
  resolution now fills routed reasoning capabilities without enriching unknown
  custom models.
- Verification: focused reasoning compiler test passed, followed by `cargo
  clippy -D warnings`, `cargo check`, the full Rust suite (4,373 unit tests plus
  all integration tests), `pnpm typecheck`, and full Vitest (224 files, 1,744
  tests).
- Runtime freshness: requires user to rebuild/restart the normal refork `pnpm dev`
  process before live Desktop verification.

## October 6 evidence correction

The prior "4,373 unit tests" wording counts the current library suite's total,
not its passed tests: the latest library run passed 4,364, failed 0, and ignored
9. Current full backend/integration verification is blocked by the running
fresh-refork executable (Access is denied, exit 101).

The final frontend rerun passed 224 files / 1,747 tests, and typecheck passed.
No comprehensive live reasoning-picker verification is claimed. Newer
uncommitted legacy catalog/alias work remains owned by the separate reasoning
chat and has not been automatically ported or overwritten.
