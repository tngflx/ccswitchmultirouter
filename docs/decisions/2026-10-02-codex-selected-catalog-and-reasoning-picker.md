# Codex Selected Catalog and Reasoning Picker

- Date: 2026-10-02
- Approval: not-approved
- Implementation: implemented
- Verification: partial
- Runtime freshness: not-checked
- Disposition: active
- Requested by / approval reference: user request in current conversation; no separate approval
- Related journal entry: 2026-10-02 - Selected catalog stays bounded and reasoning metadata reaches picker

## Goal and evidence

The Codex MultiRouter wizard was observed writing a provider's full discovered
model inventory into the routable catalog even when the provider form had an
explicit subset selected. The same audit reported that Codex Desktop model
selection no longer exposed adjustable reasoning effort choices.

## Decision

Treat model discovery as inventory refresh. An empty provider catalog adopts its
first fetched inventory as the initial selection; once a catalog exists, newly
discovered rows remain disabled until explicitly selected. Generated routes must
use `include` for a strict subset and preserve reasoning capability aliases
through the Codex Desktop projection.

## Alternatives and tradeoffs

- Mark every fetched model disabled: rejected because first-time discovery would
  produce no selected catalog.
- Keep route mode `all`: rejected because it re-expands disabled inventory rows.
- Invent a default reasoning effort for unknown models: rejected because it
  falsely advertises unsupported controls.

## Ownership and affected areas

- `src/lib/codexMultiRouterWizard.ts`
- `src-tauri/src/codex_multirouter/compiler.rs`
- `src-tauri/src/codex_config.rs`
- `src-tauri/src/codex_desktop.rs`
- `src-tauri/src/resources/codex_model_picker_core.js`

## Verification

- `pnpm exec vitest run tests/lib/codexMultiRouterWizard.test.ts src/lib/codexMultiRouterWizard.test.ts`: passed, 2 files / 68 tests.
- Large-inventory regression: passed, 34 fetched rows persisted with 9 enabled rows and an explicit 9-model `include` route.
- Focused frontend suite: passed, 6 files / 311 tests.
- `cargo check --manifest-path src-tauri/Cargo.toml`: passed.
- `cargo test --manifest-path src-tauri/Cargo.toml codex_multirouter::compiler::tests:: --lib`: passed, 28 tests.
- Codex Desktop picker tests: passed, 11 tests.
- Codex Desktop catalog projection tests: passed, 10 tests.
- Codex config inline-model tests: passed, 2 tests.
- `pnpm typecheck`: passed.
- `pnpm test:unit`: passed, 198 files / 1,657 tests.
- `git diff --check`: passed.

## Open approval or runtime gaps

The user's requested behavior change is implemented in the working tree but has
not received separate approval. Runtime verification still requires the normal
development process to rebuild from the current source; no live runtime claim
has been made because the existing debug processes predate this source.

## Status history (append-only)

- 2026-10-02: created during root-cause audit; implementation not yet complete.
- 2026-10-02: implementation and focused verification completed; live runtime remains not-checked pending a user restart of the normal development process.
- 2026-10-02: full frontend suite passed; full Rust suite was attempted but stopped at the existing locked `target\debug\cc-switch.exe` with Windows `Access is denied`, so backend full-suite verification remains partial.
