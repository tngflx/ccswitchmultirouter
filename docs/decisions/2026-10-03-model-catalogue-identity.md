# Unify MultiRouter model catalogue identity matching

- Date: 2026-10-03
- Approval: approved
- Implementation: implemented
- Verification: partial
- Runtime freshness: not-checked
- Disposition: active
- Requested by / approval reference: User request to fix the root model catalogue propagation and routing-rule bug in this conversation
- Related journal entry: none

## Goal and evidence

`gpt-6.1-sol` can appear in the MultiRouter wizard but be reported as missing or omitted by the routing workspace when a Provider row exposes a visible alias such as `gpt-6.1-sol-sublyx` with `upstreamModel: gpt-6.1-sol`. The current database and Provider catalogue retain the row; the inconsistent behavior is produced by separate projections and raw visible-string comparisons in the workspace. Schema-v2 `modelSelection.mode = "include"` is also an intentional fixed whitelist, so a route containing five selected models must not silently expand to all nine.

## Decision

Keep explicit `include` routes as fixed whitelists and keep disabled Provider catalogue rows out of runtime projections. Centralize matching through the existing model identity contract (`model`, upstream binding, canonical slug, and aliases) for route catalogue projection, Provider sync counts, checkbox state/toggle behavior, alias validation, and visibility synchronization. Preserve the stored spelling of selected models unless the user changes the selection.

## Alternatives and tradeoffs

- Convert existing `include` routes to `all`: rejected because it would re-enable models the user explicitly excluded.
- Add a special case for `gpt-6.1-sol`: rejected because the defect affects every visible/upstream alias pair.
- Keep raw visible-ID checks in the workspace: rejected because the wizard/compiler and workspace would continue to disagree.

## Ownership and affected areas

- `src/lib/modelIdentities.ts`: shared identity matching contract.
- `src/components/codex/CodexRouterWorkspacePage.tsx`: route projection, picker state, sync summaries, validation, and Provider visibility updates.
- `src/components/codex/CodexRouterWorkspacePage.test.ts`: workspace regression coverage.
- `src/lib/codexMultiRouterWizard.test.ts`: wizard reconciliation regression coverage where applicable.

## Verification

- `pnpm exec vitest run src/components/codex/CodexRouterWorkspacePage.test.ts src/lib/codexMultiRouterWizard.test.ts tests/lib/codexMultiRouterWizard.test.ts --maxWorkers=1 --minWorkers=1` — passed, 3 files / 196 tests.
- `pnpm exec tsc --noEmit --pretty false` — passed.
- `pnpm test:unit` — passed, 198 files / 1,680 tests.
- `pnpm exec prettier --check src/components/codex/CodexRouterWorkspacePage.tsx src/components/codex/CodexRouterWorkspacePage.test.ts src/lib/codexMultiRouterWizard.ts docs/decisions/2026-10-03-model-catalogue-identity.md` — passed.
- `cargo check --manifest-path src-tauri/Cargo.toml` — passed.
- `cargo test --manifest-path src-tauri/Cargo.toml` — blocked before test execution because the live debug process could not be replaced (`Access is denied`, OS error 5).
- `git diff --check` — passed.

## Open approval or runtime gaps

The full Rust test suite remains blocked while the live `cc-switch.exe` processes hold the normal debug executable. Live UI behavior remains unverified until the user stops and restarts the normal `pnpm dev` process from this checkout.

## Status history (append-only)

- 2026-10-03: decision recorded before implementation; approval is based on the explicit fix request in this conversation.
- 2026-10-03: implementation and focused verification completed; runtime freshness remains not-checked until the normal development process is restarted.
- 2026-10-03: final frontend verification passed (198 files / 1,680 tests), TypeScript, formatting, diff, and `cargo check` passed; full `cargo test` was blocked before test execution by the live development process locking `src-tauri/target/debug/cc-switch.exe` (`Access is denied`). Runtime freshness remains not-checked.
- 2026-10-03: corrected the current Verification field from `passed` to `partial`; the recorded frontend, TypeScript, formatting, diff, and `cargo check` evidence remains valid, while the full Rust suite is still blocked by the live process lock.
