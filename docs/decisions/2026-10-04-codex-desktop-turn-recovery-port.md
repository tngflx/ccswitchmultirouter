# Codex Desktop Turn Recovery Port

## Goal

Restore the legacy fork's Codex Desktop semantic turn recovery on the fresh refork without creating a second proxy retry owner.

## Evidence

- The refork already owns transparent Responses reconnection in `proxy/providers/streaming_retry.rs`.
- The legacy fork adds a separate session-scoped observer that reacts only after a terminal/incomplete Responses outcome and submits a literal `continue` through Codex Desktop CDP.
- The refork currently has only the legacy-compatible `enable_stream_retry` boolean, so it cannot express the legacy Safe/Aggressive distinction.

## Decision

Port the behavior as a separate `proxy/codex_turn_recovery.rs` observer. Keep `streaming_retry.rs` responsible for pre-semantic stream replay; the observer is opt-in through an Aggressive stream policy and is restricted to verified Codex Desktop identities. Add bounded, session-scoped recovery state, exact continuation detection, permanent-error filtering, and focused tests. Reuse the existing Codex Desktop CDP target discovery and add the continuation submission helper to `codex_desktop.rs`.

## Alternatives

- Do not port it: rejected because it is a distinctive Desktop recovery feature and leaves interrupted turns unrecoverable.
- Add recovery logic inside `streaming_retry.rs`: rejected because it would conflate transparent replay with semantic user-turn continuation and risk duplicate retries.
- Copy the legacy handler wholesale: rejected because the refork has different transform and stream ownership boundaries.

## Ownership Boundary

- `settings.rs`: policy and compatibility serialization.
- `proxy/providers/streaming_retry.rs`: transparent reconnect only.
- `proxy/codex_turn_recovery.rs`: semantic Desktop recovery observation and session budget.
- `proxy/handlers.rs`: verified Desktop eligibility and stream wrapping at response ownership boundaries.
- `codex_desktop.rs`: CDP continuation submission only.
- `SettingsPage` and `StreamRetryToggle`: one controlled frontend persistence path for Off, Safe, and Aggressive policy; no independent settings query or mutation.

## Status

- Approval: user-approved migration batch (2026-10-04)
- Implementation: complete (2026-10-04). Native and converted final Responses streams are observed after their final client-facing transformation. Compaction requests are excluded. Aggressive recovery is restricted to verified Codex Desktop identities, while transparent pre-semantic reconnect remains in `streaming_retry.rs`. The settings UI writes both the new policy and the legacy compatibility boolean through `SettingsPage`.
- Verification: targeted verification complete (2026-10-04). `cargo check --manifest-path src-tauri/Cargo.toml` passed without library warnings; `cargo test --manifest-path src-tauri/Cargo.toml proxy::codex_turn_recovery --lib` passed 8 tests; `cargo test --manifest-path src-tauri/Cargo.toml codex_desktop --lib` passed 51 tests; the `stream_retry` and `aggressive_retry` settings filters each passed 1 test; the handler continuation-identity test passed 1 test; the streaming retry module passed 45 tests; `pnpm exec vitest run tests/components/StreamRetryToggle.test.tsx tests/hooks/useSettingsForm.test.tsx` passed 12 tests; and `pnpm typecheck` passed. The full frontend and backend suites remain pending for the final migration boundary.
- Runtime freshness: not-run
