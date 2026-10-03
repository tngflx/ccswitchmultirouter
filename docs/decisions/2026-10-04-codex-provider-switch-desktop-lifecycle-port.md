# Codex Provider Switch Desktop Lifecycle Port

## Goal

Restore the legacy explicit Codex provider-switch action that stops and relaunches
Codex Desktop, adapted to the BigStrongSun refork's current provider, takeover,
runtime refresh, and model-picker ownership.

## Evidence

The fresh refork already serializes provider and takeover mutations through the
per-app switch lock and owns Codex Desktop injection in `codex_desktop.rs`. It
lacks the dedicated stop/switch/relaunch transaction and its frontend API
entrypoint. The legacy implementation stopped verified Desktop processes,
reused the normal switch path, then relaunched from the resulting takeover state.

## Decision

Add one dedicated Tauri command and typed API method. The command will validate
the target through the existing provider switch path, stop only verified Codex
Desktop processes, read takeover state after switching, and use the existing
Codex Desktop launcher/injection path for relaunch. It will report switch and
relaunch failures together when both occur. No second provider mutation,
takeover persistence, catalog refresh, or restart owner will be introduced.

## Alternatives

- Reuse generic switch plus a separate UI restart: rejected because stop/switch/
  relaunch can race and leave the Desktop app-server holding stale routing.
- Bulk-port the legacy lifecycle module and forwarder: rejected because the
  refork already owns launcher, takeover, and provider mutation boundaries.

## Ownership Boundary

- Provider mutation: `ProviderService::switch`.
- Takeover state: `ProxyService` and its per-app switch lock.
- Codex Desktop process discovery/launch/injection: `codex_desktop.rs`.
- IPC wiring: `commands/provider.rs`, `lib.rs`, and `src/lib/api/providers.ts`.

## Approval

Approved by the user in the migration request to make the fresh BigStrongSun
refork the foundation and port distinctive legacy features incrementally.

## Status

- Approval: approved
- Implementation: complete
- Verification: verified-with-unrelated-format-failures
- Runtime freshness: not-checked

## Verification Evidence

- `cargo check --manifest-path src-tauri/Cargo.toml` passed.
- `cargo test --manifest-path src-tauri/Cargo.toml codex_desktop --lib` passed
  (49 tests).
- `cargo test --manifest-path src-tauri/Cargo.toml switch_provider_ --test
  provider_commands` passed (4 tests).
- `pnpm typecheck` passed.
- `pnpm exec vitest run src/lib/codexCatalogReconciliation.test.ts` passed (3
  tests).
- `git diff --check` passed.
- `cargo fmt --check --manifest-path src-tauri/Cargo.toml` remains failing only
  in pre-existing formatting differences in `src-tauri/src/codex_config.rs` and
  `src-tauri/src/services/proxy.rs`; the files changed by this decision are
  formatted.
- Runtime freshness was not checked because no rebuilt desktop process was
  requested.

The implementation was also corrected to hold the existing per-app switch lock
across Desktop stop, provider mutation, and relaunch. The provider service now
has a lock-held switch entrypoint rather than reacquiring the mutex or creating
a second lifecycle owner.

## Verification Plan

Run focused Rust tests for process selection and lifecycle result handling,
`cargo fmt --check`, `cargo check`, `pnpm typecheck`, focused frontend tests,
and `git diff --check`. Full suites remain reserved for final migration
delivery.
