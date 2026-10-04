# Codex session deletion coordination port

## Goal

Restore the legacy fork's Codex persisted-thread cleanup and archived-session
purge behavior in the fresh refork without replacing the refork's current
multi-provider session manager or its newer Pi support.

## Evidence

The fresh refork validates and removes Codex rollout files, but does not notify
the Codex app-server through `thread/delete`. That can leave Codex's persisted
thread catalog inconsistent with Session Manager after deletion. The legacy
fork contains a focused stdio app-server client, best-effort single-session
coordination, and an all-items-attempted archived purge flow with unit and UI
tests.

The current BigStrongSun and farion1231 reference repositories were audited on
2026-10-04. Neither contains newer work that supersedes this behavior. The
fresh refork's session manager has evolved independently, including Pi session
support, so copying the legacy session manager wholesale would regress current
architecture.

## Decision

Adapt the feature at the current session-manager owner:

- keep provider-specific validation and local deletion in
  `session_manager/providers/*`;
- add one Codex-only coordination module that owns app-server startup and
  `thread/delete` RPCs;
- perform local rollout deletion even when Codex index cleanup fails, reporting
  the latter as a best-effort warning;
- restore the explicit, confirmed archived-session purge command and UI, and
  attempt every archived rollout even after individual failures;
- retain the fresh refork's Pi provider, Pi discovery notices, and all current
  session-manager behavior unrelated to Codex deletion.

## Alternatives

- Replace the refork session manager with the legacy file: rejected because it
  would remove newer provider support and duplicate evolved ownership.
- Delete only local rollout files: rejected because it preserves the known
  Codex catalog inconsistency.
- Fail local deletion whenever app-server cleanup fails: rejected because the
  local rollout is the user-selected deletion target and the external index
  cleanup is best effort.
- Mutate Codex SQLite state directly: rejected because `thread/delete` is the
  owning application contract.

## Ownership boundary and affected files

- App-server transport: `src-tauri/src/codex_session_coordination.rs`
- Local deletion and purge orchestration: `src-tauri/src/session_manager/`
- IPC: `src-tauri/src/commands/session_manager.rs`, `src-tauri/src/lib.rs`
- Typed frontend API and confirmed purge UI: `src/lib/api/sessions.ts`,
  `src/components/sessions/SessionManagerPage.tsx`
- Four-locale text and focused backend/frontend tests

## Approval / implementation / verification

- Approval: approved by the user's request to carry out the fresh-refork port
  and replace the legacy foundation, reaffirmed by the instruction to continue
  after the coverage/ETA estimate in this task.
- Implementation: pending.
- Verification: pending. Required evidence is focused Rust coordination,
  session-manager, and provider tests; focused Session Manager component tests;
  `cargo check`; and `pnpm typecheck`.
- Runtime freshness: not checked. Runtime verification requires a rebuilt
  refork development app.

### 2026-10-04 status transition

- Implementation: implemented. The fresh provider-specific deletion path now
  delegates Codex catalog cleanup to one app-server coordination owner, exposes
  an all-items-attempted archived purge over IPC, and adds the confirmed Codex
  purge action without removing Pi discovery or current session behavior.
- Verification: focused backend tests passed: coordination 1/1, session manager
  6/6, and Codex provider 21/21. `cargo check --manifest-path
  src-tauri/Cargo.toml` and `pnpm typecheck` passed. The focused Session Manager
  component suite passed 18/18 after one initial assertion failure was corrected
  to match the test harness's English default-value fallback. Locale JSON parsing,
  targeted Prettier, targeted Rust formatting, and `git diff --check` passed.
  Whole-tree `cargo fmt --check` remains failed on known formatting differences
  in untouched upstream files as well as older dirty migration regions; the
  files owned by this port pass targeted Rust formatting.
- Runtime freshness: still not checked. The current development app must be
  rebuilt from the refork before runtime behavior can be attributed to this
  source.
