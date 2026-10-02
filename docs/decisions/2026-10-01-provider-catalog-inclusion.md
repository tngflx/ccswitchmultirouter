# Keep discovered provider models excluded until explicitly included

- Date: 2026-10-01
- Approval: approved
- Implementation: implemented
- Verification: passed
- Runtime freshness: not-checked
- Disposition: active
- Requested by / approval reference: User request to stop ProviderForm from selecting non-included models and fix the resulting Sub-Agent V2 validation error.
- Related journal entry: `docs/memory/journal.md` (2026-10-01 entry)

## Goal and evidence

The recent `80ce178c1` change removed `enabled: false` from newly fetched
ProviderForm catalog rows. The runtime contract treats a missing `enabled` field
as included (`enabled !== false`), so every discovered `/models` result became a
provider-selected model. Unknown newly discovered models then entered the
Sub-Agent V2 compiler and failed with
`unknown_reasoning_capability_requires_declaration`.

## Decision

Treat fetching as inventory discovery only. Every newly appended fetched model
is persisted with `enabled: false` in both ProviderForm merge paths and shared
catalog reconciliation. Existing rows retain their explicit inclusion state;
the existing user action that includes selected rows remains the only way to
enable a new model. Backend catalog/spec generation also excludes explicit
disabled rows, making the invariant safe even if a malformed or stale caller
submits an excluded row.

## Alternatives and tradeoffs

- Default fetched rows to included: rejected because it silently changes the
  user's provider selection and makes unknown models routable.
- Suppress the unknown-reasoning validation: rejected because it hides a real
  capability contract failure for models that are actually enabled.
- Delete fetched-but-excluded rows: rejected because the ProviderForm needs
  persistent exclusions and metadata for explicit later inclusion.

## Ownership and affected areas

- `src/components/providers/forms/CodexFormFields.tsx` and
  `src/components/providers/forms/codexCatalogSync.ts`: discovery/inclusion
  boundary.
- `src-tauri/src/codex_config.rs`: backend Sub-Agent V2 catalog boundary.
- `src/lib/modelIdentities.ts`: shared fetched/catalog identity contract.
- ProviderForm and catalog-sync regression tests.

## Verification

- `pnpm exec vitest run src/components/providers/forms/codexCatalogSync.test.ts tests/components/CodexFormFields.test.tsx tests/components/ProviderForm.codexPreset.test.tsx src/lib/codexCatalogReconciliation.test.ts tests/components/CodexMultiRouterWizard.test.tsx tests/lib/codexMultiRouterWizard.test.ts src/components/codex/CodexRouterWorkspacePage.test.ts --reporter=verbose`: passed, 7 files / 303 tests.
- `pnpm typecheck`: passed.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib codex_subagent_v2_ -- --nocapture`: passed, 110 tests.
- `cargo check --manifest-path src-tauri/Cargo.toml`: passed.
- `pnpm test:unit -- --run`: passed, 197 files / 1,647 tests.
- `cargo test --manifest-path src-tauri/Cargo.toml`: blocked while Cargo attempted to replace the normal debug executable; Windows returned `Access is denied (os error 5)` because two live `cc-switch.exe` processes held `src-tauri\\target\\debug\\cc-switch.exe`.
- `git diff --check`: passed.

## Open approval or runtime gaps

The normal development process must be rebuilt/restarted before runtime behavior
can be claimed. Existing persisted catalogs are not migrated by this fix; rows
already incorrectly saved as enabled require the user to exclude them once. The
full Rust suite remains to be rerun after the live `cc-switch.exe` processes are
stopped by the user.

## Status history (append-only)

- 2026-10-01: User approved root-cause implementation through the direct fix
  request. Implementation started; verification pending.
- 2026-10-01: Corrected the pending status without removing its historical
  evidence. Implementation is complete; targeted frontend/Rust checks,
  `cargo check`, full frontend tests, and `git diff --check` passed. The full
  Rust suite is blocked by two live `cc-switch.exe` processes holding the normal
  target binary; runtime freshness remains not checked.
- 2026-10-01: Re-audit correction — this record's claim to have fixed the
  reported `unknown_reasoning_capability_requires_declaration` failure was
  incomplete. The error was reproduced in the live log at 21:17:30 after this
  fix, and the affected provider's 114 catalog rows were all persisted without
  an `enabled` field, which this fix never repairs (it only affects rows
  appended by future fetches). The fetch-as-discovery decision itself remains
  active and correct; the capability-declaration root cause, the legacy-row
  backfill, and model-naming diagnostics are owned by
  `2026-10-01-subagent-capability-alias-explicit-catalog.md`.
- 2026-10-01: User approved restoring explicit/manual model fetching. The
  repeated OpenRouter inventory requests were traced to the shared
  `ProviderForm` boundary: edit mode passed `autoRefreshModels=true` to every
  provider form, while Codex used a zero-TTL refresh effect. Removed those
  implicit props so form mount/edit no longer fetches or writes inventories;
  manual fetch controls remain unchanged. Added a regression assertion for an
  edited Codex provider. Focused frontend tests (3 files / 101 tests),
  `pnpm typecheck`, and `git diff --check` passed. Runtime freshness still
  requires the user to restart the normal `pnpm dev` process.
