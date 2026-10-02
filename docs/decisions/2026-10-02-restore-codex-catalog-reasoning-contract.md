# Restore Maintained Codex Catalogue Reasoning Contract

- Date: 2026-10-02
- Approval: approved
- Implementation: implemented
- Verification: passed
- Runtime freshness: not-checked
- Disposition: active
- Requested by / approval reference: user's request to restore the previous
  working behaviour and fix regressions introduced in the audited commits
- Related journal entry: `docs/memory/journal.md` (2026-10-02 entry)

## Goal and evidence

The model-picker audit found four contract violations: malformed persisted
declarations could mask valid inline TOML metadata, empty capability resolution
could leave stale camelCase aliases, inline TOML could write a default effort
that was absent from the final effort list, and the renderer projection could
select an empty alias before a later populated alias. The maintained-model
fallback restoration remains scoped to the existing service-tier predicate;
unknown third-party models stay fail-closed.

## Decision

Use the strict capability parser as the effective-resolution boundary and fall
through to the next authoritative source when a declaration is malformed.
When no selectable effort resolves, clear every reasoning alias that could keep
a stale picker slider visible. When inline TOML emits a default, validate it
against the final supported-effort list and choose the first authoritative valid
fallback; omit the default when no effort is selectable. Retain the maintained
OpenAI fallback only for models recognized by the existing service-tier
predicate and keep unknown third-party models fail-closed. At the renderer
boundary, normalize all supported-effort aliases with the same precedence,
skip empty/invalid arrays, deduplicate entries in order, reconcile the default,
and clear stale aliases when no effort remains. Keep the wire aliases because
the catalog and renderer consume different schemas, but derive them from one
normalized semantic list per boundary.

## Alternatives and tradeoffs

- Add generic reasoning levels for every GPT-shaped ID: rejected because model
  naming is not evidence of an upstream capability contract.
- Remove validation of effort-map targets: rejected because snapshots must remain
  internally consistent at their owning boundary.

## Ownership and affected areas

- `src-tauri/src/codex_multirouter/compiler.rs`
- `src-tauri/src/codex_config.rs`
- `src-tauri/src/codex_desktop.rs`
- `src-tauri/src/resources/codex_model_picker_core.js`
- `src-tauri/src/proxy/providers/codex_reasoning.rs` (shared strict parser)

## Verification

- `cargo test --manifest-path src-tauri/Cargo.toml codex_multirouter::compiler --lib`: passed 30/30.
- `cargo test --manifest-path src-tauri/Cargo.toml codex_config::tests::codex_provider_inline_models --lib`: passed 3/3.
- `cargo test --manifest-path src-tauri/Cargo.toml codex_config::tests::codex_model_catalog_projects_spawn_agent_model_info_fields --lib`: passed 1/1.
- `cargo test --manifest-path src-tauri/Cargo.toml codex_reasoning --lib`: passed 29/29.
- `cargo test --manifest-path src-tauri/Cargo.toml codex_desktop::tests::catalog_projection --lib`: passed 10/10.
- `cargo check --manifest-path src-tauri/Cargo.toml`: passed.
- `pnpm typecheck`: passed.
- `git diff --check`: passed.
- `cargo test --manifest-path src-tauri/Cargo.toml codex_desktop::tests::catalog_projection --lib`: passed 12/12.
- `cargo test --manifest-path src-tauri/Cargo.toml codex_desktop::tests::model_picker --lib`: passed 14/14.
- `cargo check --manifest-path src-tauri/Cargo.toml`: passed after the renderer projection change.
- `pnpm typecheck`: passed after the renderer projection change.
- `pnpm test:unit`: passed 198 files / 1,678 tests.
- Full `cargo test --manifest-path src-tauri/Cargo.toml`: blocked before test
  execution because the live debug app holds
  `src-tauri\\target\\debug\\cc-switch.exe` (`Access is denied`, os error 5).

- Maintained picker regression test: passed 1/1.
- Provider effort-map snapshot test: passed 1/1.
- Unknown third-party reasoning guard tests: passed 1/1 each.
- `cargo check --manifest-path src-tauri/Cargo.toml`: passed.
- `pnpm typecheck`: passed.
- `pnpm test:unit`: passed, 198 files / 1,678 tests.
- Full `cargo test --manifest-path src-tauri/Cargo.toml`: blocked before test
  execution while replacing the normal `src-tauri\\target\\debug\\cc-switch.exe`
  (`Access is denied`, OS error 5); no process was killed.
- `rustfmt --edition 2021 --check` on the touched Rust files: reports existing
  repository formatting differences outside this change; it did not modify
  files.
- The full frontend suite is now verified in this turn. The full Rust suite
  remains unverified until the normal debug app and its watchdog release the
  executable; no process was killed and no alternate target was created.

## Open approval or runtime gaps

The normal development process must be restarted by the user before live Codex
Desktop picker behaviour can be considered current. The full Rust suite has
historically been process-gated by running `cc-switch.exe`; no process is to be
killed to bypass that lock.

## Status history (append-only)

- 2026-10-03: implemented the approved malformed-fallback, stale-alias-clear,
  and default-reconciliation invariants. Focused Rust tests, `cargo check`,
  `pnpm typecheck`, and `git diff --check` passed. Live picker freshness still
  requires the user to restart `pnpm dev`.

- 2026-10-03: final frontend verification passed 198 files / 1,678 tests.
  Full Rust verification was attempted and blocked before execution by the
  running debug executable; runtime picker freshness still requires a normal
  `pnpm dev` restart.

- 2026-10-02: created after the commit audit isolated the maintained-model
  catalogue regression and the invalid snapshot fixture; implementation and
  focused checks completed.
- 2026-10-02: frontend final suite passed 198/1,678; full Rust suite remained
  blocked by the existing process-held executable, with no bypass used.
