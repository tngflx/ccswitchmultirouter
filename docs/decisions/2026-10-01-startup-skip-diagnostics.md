# Retain precise startup skip diagnostics

- Date: 2026-10-01
- Approval: approved
- Implementation: implemented
- Verification: failed
- Runtime freshness: not-checked
- Disposition: active
- Requested by / approval reference: "that's why im asking u to merge intelligently u fuck! then only push!" following explicit disclosure of the pending startup diagnostics.
- Related journal entry: docs/memory/journal.md

## Goal and evidence

The earlier startup audit found a generic message attributing every skipped
launch to cancellation or disabled proxy. Pending edits distinguish recovery
supersession, lifecycle ownership, global proxy off, and Desktop launch opt-out.
These diagnostics were previously inventoried as unapproved.

## Decision

Retain the pending diagnostic helper and regression test in the proxy service,
and replace the misleading library-root info message with a debug reference
to the service-owned reason. Preserve launch policy, lifecycle locking, and
all explicit off/opt-out boundaries.

## Alternatives and tradeoffs

- Force launch despite a skip: rejected because this changes lifecycle policy
  and may undo an explicit user opt-out.
- Keep the generic reason: rejected because it prevents identifying the actual
  gate; logging belongs at the service that evaluates it.

## Ownership and affected areas

- src-tauri/src/services/proxy.rs: skip-reason evaluation and unit coverage.
- src-tauri/src/lib.rs: startup result logging.

## Verification

- `cargo check --manifest-path src-tauri/Cargo.toml`: passed.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib startup_`: 18 passed,
  1 failed, including a pass for startup_launch_skip_reason_reports_the_actual_gate.
  codex_startup_reconciles_owned_catalog_when_takeover_flag_drifted failed with
  CODEX_DESKTOP_ACTIVE for the running PID 13772; no guard was bypassed.
- `cargo test --manifest-path src-tauri/Cargo.toml`: exited 1 before executing
  tests because Windows denied removal of the running normal-target
  src-tauri/target/debug/cc-switch.exe (os error 5).
- Full backend and live startup verification remain outstanding. Library-only
  checks are not a substitute for the required full suite before push.

## Open approval or runtime gaps

The current process has not been established to include these edits. No live
startup verification, process termination, settings change, or launch-policy
change is included in this batch.

## Status history (append-only)

- 2026-10-01: Approval changed from not-approved to approved for retaining the
  disclosed pending diagnostics in the requested merge/push batch. Earlier
  unapproved-state evidence remains in the approval-protocol record.
- 2026-10-01: Verification changed to failed for the mixed focused startup
  run (18 passed / 1 failed due to active Desktop). Compile check and the new
  diagnostic regression passed; full suite execution is separately blocked by
  the running executable. Runtime freshness remains not-checked; no process
  was stopped and no live startup claim is made.
- 2026-10-01: The user explicitly requested finishing delivery without
  stopping the active apps after the verification blockers were disclosed;
  the exact message and one-batch push exception are recorded in
  2026-10-01-catalog-merge-publication.md. Verification remains failed for
  the focused run, full execution remains blocked, and runtime freshness is
  not-checked. The other side must complete backend and fresh-runtime checks.
