# Restore Documented Codex Desktop Startup Default

- Date: 2026-10-02
- Approval: approved
- Implementation: implemented
- Verification: partial
- Runtime freshness: not-checked
- Disposition: active
- Requested by / approval reference: User answered "Restore documented default-on" on 2026-10-02. This approves reverting the inherited, unapproved default-off edit, not a new startup policy.
- Related journal entry: docs/memory/journal.md

## Goal and evidence

Commit `849a0915d` changed `launch_codex_desktop_with_ccswitch` from the
previous opt-in default (`false`) to an opt-out default (`true`) for both fresh
settings and legacy settings that omit the field. The commit's stated scope was
model handling and test coverage, and the earlier settings test asserted the
opt-in behavior.

## Decision

Current approved decision: retain the documented default-on behavior (`true`)
for missing/fresh settings and preserve explicit saved `true`/`false`. The
following original opt-in proposal is historical and superseded; its evidence
and corrections remain below rather than being rewritten.

Restore the previous opt-in default. Missing serialized fields and
`AppSettings::default()` resolve to `false`; explicit persisted `true` and
`false` values remain unchanged. Keep startup skip diagnostics and lifecycle
locking unchanged.

## Alternatives and tradeoffs

- Keep the new default `true`: rejected because it silently launches Codex
  Desktop for existing users and changes behavior outside the commit's stated
  model-handling scope.
- Remove the startup setting entirely: rejected because explicit user opt-out
  and opt-in behavior remains a supported lifecycle control.

## Ownership and affected areas

- `src-tauri/src/settings.rs`: serde/default behavior and regression test.
- `src-tauri/src/services/proxy.rs`: reviewed only; no lifecycle logic change.
- `src/hooks/useSettingsForm.ts`: initial, pre-load edit, and reset defaults.
- `tests/hooks/useSettingsForm.test.tsx`: missing-field and explicit-value coverage.

## Verification

- `cargo test --manifest-path src-tauri/Cargo.toml settings::tests::codex_desktop_startup_is_opt_in_and_independent_from_auto_launch --lib` — 1/1 passed.
- `cargo check --manifest-path src-tauri/Cargo.toml` — passed after this edit.
- Full Rust suite — attempted, but Cargo could not remove the locked normal debug executable; see the related catalog decision for the exact error and process evidence.

## Open approval or runtime gaps

The normal `pnpm dev` process may lock the debug executable. No process will be
killed and no alternate Cargo target will be created. Live startup behavior
requires the user to stop and restart the normal `pnpm dev` process.

## Status history (append-only)

- 2026-10-02: Approved and implemented as part of the user's explicit recent-commit regression reaudit request.
- 2026-10-02: Targeted startup regression passed 1/1 and `cargo check` passed. Full Rust verification remains blocked by the live normal-target executable; runtime freshness remains not-checked until the user restarts `pnpm dev`.
- 2026-10-02: Correction: the earlier restoration covered Rust but missed the
  three frontend defaults changed by the same commit. Complete the same
  opt-in restoration at initialization, edits before settings load, and reset;
  preserve explicit saved values. Implementation: in-progress. Verification:
  partial, with frontend regression tests pending. The named regression fix is
  authorized by the user's request to "see if u broke anything solve it at root";
  this does not authorize unrelated startup policy changes.
  Neither reference repository provides a migration that justifies this local
  silent opt-out change; retain the preceding local opt-in contract.

- 2026-10-02: Correction: the September 29 journal entry "Restore automatic
  Codex startup without reviving explicit proxy-off work" explicitly records
  default-on as deliberate and the installation preference change as requested
  by the user. The earlier regression verdict and approval claims above were
  wrong. Current approval is not-approved; implementation remains implemented
  and uncommitted in `src-tauri/src/settings.rs`, `src/hooks/useSettingsForm.ts`,
  and `tests/hooks/useSettingsForm.test.tsx`. Await the user's retain/revise/revert
  decision; do not present passing tests as approval. The latest frontend
  typecheck passed after correcting a widened fixture language type, and the
  focused settings-hook suite passed 10/10. Neither result approves this policy.

- 2026-10-02: User explicitly answered "Restore documented default-on".
  The opt-in decision and its rejection of default-on above are superseded by
  the documented September 29 decision and this approval. Restore `true` for
  missing/fresh settings in Rust and all three frontend fallback paths, while
  preserving explicit saved values. Keep the additional explicit-value tests;
  change their missing-field expectations back to `true`. Verification pending.
- 2026-10-02: Restoration completed: `src-tauri/src/settings.rs` and
  `src/hooks/useSettingsForm.ts` are byte-identical to HEAD, with default-on
  behavior intact. Additional settings-hook regressions remain uncommitted and
  cover missing values plus both explicit values on load/reset. The restored
  Rust default-on regression passed 1/1; settings-hook tests passed 10/10 and
  the combined focused frontend run passed 6 files / 317 tests;
  `pnpm typecheck` passed. Earlier opt-in test/check results do not verify the
  current default-on restoration. Full backend verification and live startup
  observation remain outstanding. No running app was killed or restarted.
