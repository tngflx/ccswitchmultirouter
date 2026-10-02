# Route Selection Identity Normalization

- Date: 2026-10-02
- Approval: approved
- Implementation: implemented
- Verification: partial
- Runtime freshness: not-checked
- Disposition: active
- Requested by / approval reference: User approved fixing the duplicate upstream-name error at its root after the audit reproduced the save/validation path.
- Related journal entry: docs/memory/journal.md

## Goal and evidence

The schema error `include_models_duplicate_or_empty` can be produced by a
route include list containing the same upstream identity with different case
or surrounding whitespace. The frontend serializer preserved include lists
verbatim, while the Rust validator only trimmed whitespace and compared
case-sensitively. The two boundaries therefore disagreed about model identity.

## Decision

Normalize route include selections at serialization and validation boundaries:
trim entries, discard empty entries, and deduplicate case-insensitively while
preserving the first non-empty spelling. Keep the existing validation error for
an actually empty include selection. Alias targets continue to resolve through
the provider's case-insensitive model identity rules.

## Alternatives and tradeoffs

- Suppress the validation error: rejected; it would leave an invalid route
  contract in persisted state.
- Deduplicate only in the UI control: rejected; imported and legacy drafts can
  bypass that control.
- Lowercase persisted model names: rejected; preserve the user's/provider's
  canonical spelling while comparing identities case-insensitively.

## Ownership and affected areas

- `src/components/codex/CodexRouterWorkspacePage.tsx`: v2 route serializer.
- `src/components/codex/CodexRouterWorkspacePage.test.ts`: serializer regression.
- `src-tauri/src/codex_multirouter/schema.rs`: v2 validation identity contract.
- `src-tauri/src/codex_multirouter/schema.rs` tests: backend regression.

## Verification

- Pending: targeted frontend and Rust tests, typecheck, formatting, and final
  full-suite verification.

## Open approval or runtime gaps

Exact live save/runtime behavior remains unverified until the user restarts the
normal `pnpm dev` process from this checkout.

## Status history (append-only)

- 2026-10-02: Approved scope recorded before implementation.
- 2026-10-02: Implemented matching case-insensitive trim/dedupe at the frontend
  serializer and Rust validator boundaries. The affected frontend suite passed
  6 files / 324 tests; `pnpm typecheck`, targeted Prettier, and
  `git diff --check` passed. The Rust regression test remains pending because
  the normal debug executable is locked by the running app; runtime save
  verification is pending a user restart.
