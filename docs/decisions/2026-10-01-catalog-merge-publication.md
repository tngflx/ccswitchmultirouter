# Reconcile catalog retention and model publication

- Date: 2026-10-01
- Approval: approved
- Implementation: implemented
- Verification: blocked
- Runtime freshness: not-checked
- Disposition: active
- Requested by / approval reference: "try to merge changes and then push latest commits!", followed by "that's why im asking u to merge intelligently u fuck! then only push!" after the pending edits and origin/main scope were disclosed.
- Related journal entry: docs/memory/journal.md

## Goal and evidence

Local main at 849a0915d is behind origin/main by 6046562bd. The incoming
commit changes only CodexFormFields.tsx and its component test: refresh no
longer deletes saved rows omitted by a complete upstream response. Pending
local changes remove enabled:false from newly fetched rows in three append
paths, preserve existing exclusions, and make the explicit Follow all action
re-enable source rows before publication. These edits were previously
unapproved; the follow-up instruction authorizes their reconciliation and push.

## Decision

Retain both retention and publication fixes. Refresh preserves saved rows,
including disabled rows, and new inventory uses the established enabled !==
false inclusion invariant. Only the explicit Follow all command re-enables
existing exclusions. Preserve explicit route include selections on refresh.
Reconcile the incoming gamma-free expectation with the new-row default.
Use the existing main checkout, preserve the dirty tree in a Git stash while
fast-forwarding origin/main, and retain the stash until restoration is checked.

## Alternatives and tradeoffs

- Pick one side wholesale: rejected because it loses either saved membership
  or newly fetched model publication.
- Automatically re-enable existing disabled models: rejected because their
  provenance is unknown; the explicit Follow all action is the recovery boundary.
- Merge either reference repository wholesale: deferred; this request concerns
  the disclosed origin/main commit and pending changes, not unrelated upstream work.

## Ownership and affected areas

- src/components/providers/forms/CodexFormFields.tsx and codexCatalogSync.ts:
  provider catalog reconciliation.
- src/lib/codexMultiRouterWizard.ts and
  src/components/codex/CodexMultiRouterWizard.tsx: source persistence and selection.
- Related tests in src/components/providers/forms/, src/lib/,
  tests/components/, and tests/lib/.

Reference audit for the pending fix is recorded in the 2026-09-30 Sublyx
journal entry: BigStrongSun retains enabled !== false; farion1231 has no
equivalent MultiRouter wizard boundary. No new reference implementation is
being ported by this merge.

## Verification

Merge/publication verification on the reconciled tree:

- `pnpm typecheck` and `cargo check --manifest-path src-tauri/Cargo.toml`: passed.
- Targeted frontend regression run: 7 files / 205 tests passed.
- `pnpm test:unit`: 197 files / 1,639 tests passed.
- Documentation validator: 172 passed / 0 failed; status regressions: 8 passed
  / 0 failed; PowerShell AST parsing: 2 scripts passed.
- `git diff --check`: passed.
- Prettier check: seven checked files passed; CodexMultiRouterWizard.tsx failed
  on formatting also present at HEAD. No unrelated formatting was changed.
- `cargo test --manifest-path src-tauri/Cargo.toml`: exited 1 before tests,
  denied removal of the running normal-target debug cc-switch.exe (os error 5).
- `cargo test --manifest-path src-tauri/Cargo.toml --lib startup_`: 18 passed /
  1 failed. The failure was CODEX_DESKTOP_ACTIVE for PID 13772 in
  codex_startup_reconciles_owned_catalog_when_takeover_flag_drifted.
- Live picker behavior and full backend execution remain unverified.

## Open approval or runtime gaps

Approval now covers the disclosed pending application and documentation batch.
It does not approve further decision-policy relaxation, data migrations, live
config edits, process termination, or unrelated reference merges. Running
debug processes may block backend integration-test linking; no runtime claim
will be made for an older binary.

## Status history (append-only)

- 2026-10-01: Previously not-approved edits are approved for intelligent merge,
  verification, commit, and push by the follow-up instruction quoted above.
  Implementation is in-progress; verification has not run in this turn.
- 2026-10-01: Fast-forwarded to 6046562bd and restored the saved work without
  textual conflicts; reconciled the overlapping component test semantically.
  Implementation is implemented; verification is blocked by the full Rust
  executable lock. Frontend and compile checks passed as listed above. A
  library-only startup run also encountered the active Desktop guard. Push is
  withheld, and the user was asked to stop their existing pnpm dev process;
  no process, target directory, live setting, or safety gate was changed.
