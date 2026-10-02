# Restore Inline Provider Reasoning Metadata in MultiRouter

- Date: 2026-10-02
- Approval: approved
- Implementation: implemented
- Verification: partial
- Runtime freshness: not-checked
- Disposition: active
- Requested by / approval reference: user's current request to fix the picker and trace the reasoning-effort data path
- Related journal entry: `docs/memory/journal.md` (2026-10-02 entry)

## Goal and evidence

Codex Desktop's reasoning-effort control disappears for routed aliases when the
persisted model-catalog row is sparse even though the active Codex TOML contains
an authoritative inline model declaration. The MultiRouter compiler currently
reads only persisted nested `reasoning` metadata or provider-level metadata, so
it projects no reasoning object. The downstream Codex config writer then
correctly emits an empty `supported_reasoning_levels` array for that missing
capability.

## Decision

At the MultiRouter compiler boundary, retain existing model-row and
provider-level precedence, then resolve inline `model_providers.*.models[]`
declarations through the existing shared reasoning-capability resolver using
the visible, canonical, and upstream model identities. Project only validated
capabilities returned by that resolver. Unknown or malformed declarations stay
fail-closed; official OpenAI metadata remains restricted to explicitly
classified OpenAI providers.

## Alternatives and tradeoffs

- Add a picker-only fallback: rejected because it would leave the compiler and
  request-path capability contracts divergent.
- Invent `low`/`medium`/`high` for every GPT-shaped alias: rejected because a
  model ID is not evidence of an upstream reasoning contract.
- Replace the compiler's existing precedence wholesale: rejected because it
  would change persisted user declarations and provider-level overrides.

## Ownership and affected areas

- `src-tauri/src/codex_multirouter/compiler.rs`
- MultiRouter model-catalog projection and the shared
  `reasoning_capabilities` resolver

## Verification

- `cargo check --manifest-path src-tauri/Cargo.toml`: passed.
- `pnpm typecheck`: passed.
- `rustfmt --check src-tauri/src/codex_multirouter/compiler.rs`: passed.
- `git diff --check`: passed.
- Focused Rust test was attempted, compiled the crate, then failed before test
  execution because Cargo could not replace the locked normal-target
  `src-tauri\\target\\debug\\cc-switch.exe` (`Access is denied`, two running
  `cc-switch.exe` processes); no process was killed.

## Open approval or runtime gaps

The normal debug executable is currently locked by running `cc-switch.exe`
processes. Source-level tests and checks can run only after the lock is
released; live UI verification requires the user to stop and restart the normal
`pnpm dev` process so it loads this source change.

## Status history (append-only)

- 2026-10-02: created with approval from the user's direct request to fix the
  missing reasoning-effort picker behavior; implementation not yet verified.
- 2026-10-02: implemented the compiler fallback and empty-placeholder guard;
  source checks passed, while the focused test remains blocked by the running
  normal debug executable.
- 2026-10-02: corrected the stale pre-lock evidence. The focused compiler and
  catalog tests each passed 1/1, and `pnpm typecheck` passed. Runtime freshness
  remains not-checked pending a normal `pnpm dev` restart.
