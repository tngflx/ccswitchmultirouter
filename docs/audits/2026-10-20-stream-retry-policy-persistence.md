# Stream retry policy persistence — October 20, 2026

## Incident evidence

The reported message was:

> stream disconnected before completion: Our servers are currently overloaded. Please try again later.

Scoped recorded diagnostics contained this exact upstream `response.failed`
error, including a recorded HTTP 200 stream with 47,822 bytes consumed before
the failure. The device settings were `streamRetryMode: safe`,
`enableStreamRetry: true`, and `streamRetryMaxAttempts: 3`; the Codex proxy's
capacity retry switch was enabled. No `turn_recovery` events appeared in the
inspected current router log.

Safe mode has a zero Desktop continuation budget. It can replay a request before
semantic output, but cannot submit the new `continue` turn required after output
has been delivered. The configured maximum of three applies only in Aggressive
mode. The exact overload wording is already covered by the pre-output capacity
retry tests and accepted by the Desktop failed-turn classifier.

The configured background monitor was unavailable through the tools and local
automation configuration exposed to this session. This investigation inspected
recorded app diagnostics and source; it did not drive Desktop/CDP, send a live
provider request, or submit a test continuation. The recorded stream byte count
alone does not establish whether semantic output had been delivered.

## Persistence defect

The header changes stream retry through `patch_settings`, while the Advanced
settings control used a full settings save. General settings saves preserve
other independently owned fields under the backend settings lock, but omitted
the three stream retry fields. Consequently, a form opened while the mode was
Safe could overwrite a newer Aggressive patch when saving an unrelated setting.

This is a reproducible path that loses the user's policy. The incident logs do
not identify the historical writer that changed this device back to Safe.

## Fix and verification

Stream retry mode, enabled state, and attempt budget share the existing canonical
settings store. Explicit policy changes use `patch_settings`; unrelated full
saves preserve the latest policy under the same lock. Frontend form/cache updates
use the backend's current values after saving.

The backend regression failed before the fix: a persisted Aggressive policy
became Safe after an unrelated stale save. It now passes across disk reloads,
and verifies deliberate Off, Safe, and Aggressive patches still work. Frontend
regressions cover dedicated retry writes, mixed/manual saves, preservation of
unrelated drafts, and failed patches preventing further writes.

Verification completed:

- Full Rust library: 4,864 passed, 10 existing ignored, 0 failed.
- Focused frontend: 63 tests across 7 files passed.
- Full frontend: `pnpm test:unit --maxWorkers=2 --minWorkers=1` passed with a
  fresh completion receipt for 262 files and 2,501 tests.
- `pnpm typecheck`, `pnpm format:check`, and `git diff --check` passed.
- `cargo fmt --check --manifest-path src-tauri/Cargo.toml` passed.
- `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` passed.
- Gated `pnpm build:renderer`, including catalog verification and the offline
  Responses contract gate, passed.

The requested device policy was restored to Aggressive with three attempts.
Only the three retry settings changed; unrelated device settings were preserved.
The development application was then reloaded to rebuild the backend and load
the policy into its in-memory settings store. The new executable was written
at 22:28:29 +08:00 and its startup marker recorded PID 39156 at 22:28:30.
The subsequent recorded recovery ledger contained two Desktop-eligible turns,
each with a continuation budget of three. This does not constitute a live
Desktop continuation or provider audit.
