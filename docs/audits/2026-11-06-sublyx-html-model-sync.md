# Sublyx HTML errors and model-sync re-audit — November 6–7, 2026

## Historical evidence cleanup — November 8, 2026

The `.tmp/` paths below are historical scratch locations removed during the
user-authorized cleanup on November 8, 2026. Structured findings and verification
conclusions remain in this audit; those paths are no longer retained artifacts.
This cleanup provides no new live-runtime or UI verification, and the audit's
existing live-verification limitations remain unchanged.

## Scope and safety

Read the configured CCSwitch logs, the established read-only local provider audit,
and the configured desktop continuation monitor. No UI automation, authenticated
upstream requests, paid probes, provider changes, installation, or restart was
performed. The checkout remains on `main`; pre-existing dirty/untracked work was
preserved. No branch, commit, push, or destructive cleanup was performed.

## Confirmed live evidence

- The restarted process began at **19:54:38 SGT on November 6, 2026**, using
  `src-tauri/target/debug/cc-switch.exe`, not a packaged production executable.
  The debug and prior production artifacts both report `3.20.4-3`, but their
  SHA-256 hashes differ. A matching display version does not establish matching
  code or resources.
- As of 20:24 SGT, the retained scoped proxy-error journals contain **32 Sublyx
  HTML upstream error records**: 29 HTTP 524, two HTTP 502, and one HTTP 520.
  All are `upstream_http_error` records with an HTML content type and gateway
  metadata. The latest event is **20:18:49.721 SGT**, HTTP 520, after the restart.
  No 2xx HTML record was found in those retained error journals. The journals
  do not establish that every successful upstream response is valid.
- Saved Sublyx canonical catalog: **37 inventory rows, 10 included, 27 excluded**.
  Primary credential exists; no API-key groups are configured.
- The active schema-v2 route uses **`mode: "all"`**, not an explicit closed include
  selection. Its seven aliases are presentation/request bindings, not a catalog
  whitelist. Current managed catalog/cache files expose only seven matching
  Sublyx rows; three enabled source rows are missing from those projections.
- The persisted projection receipt says `ready`, but is dated **October 28, 2026,
  08:59:34 SGT**, not this run. It is not evidence of current readiness.
- Focused post-restart logs contain no publication/read-back/model-fetch error
  event explaining the 10-source versus 7-projected discrepancy. Absence of a
  log entry is not proof that a sync was never attempted.

Sanitized evidence was saved in `.tmp/sublyx-html-redacted-evidence-20261106.json`
and `.tmp/sublyx-live-*-20261106.json`. These reports omitted credentials, request
prompts, and raw upstream HTML bodies. Original logs were not modified.

## Reproduced defects and source repairs

### Upstream HTML error presentation

CCSwitch previously echoed upstream HTML inside JSON error messages. Its Codex
forward-error path could prefix that upstream failure with "CC Switch local
proxy failed", incorrectly attributing it to local routing.

The shared upstream error mapper now replaces HTML documents with bounded,
non-verbatim upstream guidance. Generic proxy errors and both Codex protocol
conversion directions retain the upstream HTTP status. Existing Retry-After and
gateway headers are preserved by the converted response path; obsolete entity
headers are removed. Valid upstream JSON errors remain unchanged. No retry or
request replay policy was changed.

Two HTML regressions failed before implementation. Four HTML regressions now
pass, with additional proxy error/journal and Codex error-path scopes passing.

### Model refresh ownership and stale UI projection

Two frontend regressions failed before implementation:

1. An in-flight model discovery used its launch-time Provider snapshot and could
   overwrite newer same-credential provider/catalog edits.
2. A completed optimistic catalog overlay could continue hiding a later
   canonical provider update indefinitely.

Refresh completion now reconciles against the latest committed canonical source,
checks request ownership, and binds a temporary overlay to the exact parent
baseline. Later canonical state wins immediately. Late completion and provider
removal cannot recreate or publish stale UI data. A conditional backend update
compares the expected canonical persisted provider inside the same database
transaction as the write; a conflict preserves the newer state without an
unconditional retry. Normal manual updates retain their existing behavior.

Six workspace regressions cover rebase/expected ownership, newer canonical
state after completion, late completion, conflict, removal, and the mixed-version backend boundary. New user-visible
status messages are translated in all four current locale files.

### Follow-all contract checked, not weakened

An additive Rust fixture mirrors seven Sublyx aliases, a `gpt` prefix, and three
newly included source rows. The unchanged current compiler correctly projects
**7 → 10** models and changes its dependency fingerprint while preserving excluded
inventory. This test was initially GREEN: it does not reproduce a compiler bug,
and is not a justification to alter alias or selection semantics.

No catalog exclusions were cleared, no explicit include selection was broadened,
and no stale legacy catalog was promoted over a valid canonical catalog.

## Verification and deployment boundary

The broad final verification results are recorded below. Focused
RED/GREEN results and baseline logs were saved in `.tmp/sublyx-sync-20261106-*.log`.

The configured read-only runtime verifier was attempted twice. It reported
`runtime_fingerprint_not_observed`, then `desktop_bridge_not_ready` with blocker
`desktop_request_client_unavailable` when supplied the latest current-process
startup fingerprint. Both reports explicitly say verification is false. No
existing or disposable chat was changed.

**Source fixes and tests are not live acceptance.** The final native executable
has not been rebuilt, installed, or restarted in this investigation. A current
authenticated upstream model inventory and the final running application's picker
have not been verified through the configured monitor. The actual live
10-source/7-projection discrepancy must remain open until that boundary is
available; passing compiler tests do not repair or certify those existing files.

## Mixed renderer/native safety

The conditional writer uses the distinct required command
`update_provider_if_unchanged`, not an optional argument to the old unconditional
command. An older native backend must reject the unknown command: the frontend
never falls back to an unconditional save. The UI translates that failure into
an update/rebuild-and-restart instruction. This matters for the observed
`dev --no-watch` native process alongside a Vite renderer capable of hot reload.

The guarded source-update transaction rejects stale or deleted provider
snapshots before any provider/profile writes. Effective-current cleanup and
active-profile snapshot writes are deferred until a successful guarded commit.
Real Protocol Set facades remain valid logical sources, while user routing plans
are not repurposed as background discovery sources. Null/disabled-empty routing
metadata follows the frontend's source classification. The focused backend
ownership/edge scope passed 9 tests; the API boundary scope passed 6 tests.

## Final verification results

| Command                                                                     | Result                                                  |
| --------------------------------------------------------------------------- | ------------------------------------------------------- |
| `pnpm typecheck`                                                            | Passed; repeated November 7 after final source freeze.  |
| `pnpm catalog:verify`                                                       | Passed: 15 files / 526 tests; repeated November 7.      |
| `pnpm test:unit`                                                            | Passed: 282 files / 2,928 tests.                        |
| `pnpm format:check`                                                         | Passed; repeated November 7.                            |
| `pnpm build:renderer`                                                       | Passed through the gated catalog checks and Vite build. |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib codex_multirouter::` | Passed: 166 tests.                                      |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib -- --test-threads=1` | Passed: 5,194 tests / 0 failed / 10 existing ignored.   |
| `cargo fmt --check --manifest-path src-tauri/Cargo.toml`                    | Passed.                                                 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`          | Passed.                                                 |
| `git diff --check`                                                          | Passed; repeated November 7.                            |

The default parallel full Rust run was **not clean**: it intermittently failed
`codex_config_consistency::tests::apply_ccsm_uses_compare_and_swap_and_creates_a_drift_backup`
with `codex_config_consistency_stale_fingerprint` (5,193 passed / 1 failed / 10
ignored). The subsequent whole-library single-threaded run passed all tests. No
CAS assertion or production guard was relaxed; the parallel test-isolation issue
remains recorded rather than being presented as a passing parallel run.

Earlier whole-suite failures exposed two stale reasoning-library integration
assertions. Those tests were strengthened to assert the current canonical library
and wire mappings; no production capability-library change was made to satisfy
them. A separate image-handler self-loop test used the real machine-wide 15721
port and could reach the running local proxy when another test changed the
in-process port guard. Its test-only fixture now reserves a dynamic local port
and binds both the effective upstream and guard to it; the strict rejection and
official-authentication assertions remain intact. The focused fixture and final
serial whole-library suite both pass. This was test isolation, not a provider
probe or proof of live provider success.

Final frontend logs were saved under
`.tmp/sublyx-sync-20261106-final-boundary-afterux-*.log`;
final native scope/fmt/Clippy logs were saved under
`.tmp/sublyx-sync-20261106-final-rust2-*.log`;
the full serial result was saved in
`.tmp/sublyx-sync-20261107-final-rust-lib-serial.log`.
Earlier RED/failure logs were preserved until the authorized cleanup. Existing non-fatal warnings include
two library-test-only Rust warnings and Vite's large-chunk advisory; no warning
or build gate was disabled.

## November 7 closeout recheck

At **00:24 SGT on November 7, 2026**, read-only process/run-marker inspection
still found PID 69956, started November 6 at 19:54:38 SGT, using the same debug
executable. The established canonical-catalog audit still reports 37 Sublyx rows,
10 included, versus seven Sublyx entries in both the managed catalog and cache.
Evidence:

- `.tmp/sublyx-live-closeout-provenance-20261107.json`
- `.tmp/sublyx-live-closeout-local-catalog-20261107.json`

The native fixes have not been loaded by that running process. Rebuilding and
fully restarting the native backend, then verifying model publication through
the configured monitor, remains required. Restarting the existing executable
alone cannot load newly changed Rust code. The monitor's prior blocker and the
live catalog discrepancy remain open; this audit does not claim all live issues
are resolved.
