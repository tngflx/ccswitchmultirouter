# Failed-chat continuation re-audit — completed 2026-10-26

## Verdict and scope

**Corrected source: regression and full-suite checks pass. Current live
auto-continuation: not verified.** Earlier successful renderer-fixture evidence
is historical, not proof of the current native scheduler or dev crash chain.

Scope: recent dirty recovery/proxy, Desktop bridge, dev lifecycle, retry UI,
Request Health and build-pipeline changes at HEAD
`0532ee16d52aa01abd14745b9e257cd6bb86c3c0`. This is not a whole-codebase live audit or a claim
of identical upstream UI parity.

No application/release build, install, app restart, settings change, existing
chat operation or disposable live-chat fixture was performed in this re-audit.
Windows integration tests operated only disposable processes they owned.
Existing audit files were consolidated; unrelated dirty work/deletions remain.

## Current live evidence

At **October 25, 2026, 23:32:32 Singapore time**, the supported read-only
background verifier could not observe a listening Codex debug-port owner on the
**one tested port, 9229**. Its receipt reports:

```json
{
  "verified": false,
  "desktopCdpVerified": false,
  "stage": "readiness",
  "failure": "desktop_debug_port_unavailable",
  "temporaryDurableTestThread": false,
  "existingThreadsTouched": false,
  "verifiedAtUtc": "2026-10-25T15:32:32.223Z"
}
```

Receipt: `C:/Users/Felix/AppData/Local/Temp/ccswitchmulti-reaudit-20261025/readiness-current-source.json`.

This establishes neither bridge readiness nor delivery. It does not prove Codex
is closed or all debug ports are unavailable: suppressed listener-query errors
can also yield an empty result. No UI automation, injection, broad runtime scan
or chat RPC was substituted.

Current source renderer fingerprint:
`sha256-84d91ba9fd3efa1271bb68a8a94e7edc16b62b15061c97cbc1622a7284db46e0`.
Production Rust assembly helpers and all 15 embedded resources generated this
identity; final SHA-256 checks reconfirmed all 16 inputs. This is source identity,
not proof the native app, supervisor or renderer has loaded the fixes.

## Defects fixed, with RED → GREEN regressions

1. **Incremental tool follow-ups reset the retry budget (P1).** A request
   containing only `previous_response_id` plus tool output was treated as a new
   user turn, potentially returning to attempt 1/five minutes. The Responses
   handler now distinguishes actual nonempty user input before history enrichment.
   Tool-only/assistant-only/empty/unknown inputs preserve the budget; literal
   injected `continue` remains strict. RED: two
   `incremental_recovery_follow` tests failed. GREEN: both pass, with separate
   new-user reset and literal-match tests. Assertions cover max-1 exhaustion over
   eight non-user shapes and attempt 2 retaining **600 seconds** after tool output.

2. **Unverified Desktop activity hooks were accepted (P2).** Frozen/non-writable
   clients could silently refuse installation yet remain retained; marker-only
   and raw-request fallback could bypass observation of a newer user action.
   Runtime selection, thread reads, final commit and verifier now share
   descriptor-verified ownership of the exact wrapper/client/original/version.
   Failed installation evicts retention; there is no raw continuation fallback.
   Mutable inherited methods and legacy rewrapping still work without stacking.
   RED: the assembled-renderer frozen-client test submitted, and the verifier
   incorrectly reported ready. GREEN: **127 Desktop Rust tests** and **8 verifier
   Node tests** pass, including replaced-hook refusal with no request or marker.

3. **Planned dev cleanup lost config-root and exact process identity (P2).**
   The ready identity now carries the actual marker path through worker IPC,
   persisted roots, reload, requested/manual stop and recorded cleanup. Modern
   mismatch never falls back; legacy default takeover requires positive
   PID/path/native-time/config-scope proof. Unverifiable old custom-config apps
   require graceful exit instead of guessed termination.

   Independent review also caught native/CIM precision and rounded-Number errors.
   Ready packets, markers and persisted identities now preserve exact FILETIME
   strings. An app-only retained-handle query binds the native identity to the
   CIM row. Matching uses exact native equality, not tolerance. When
   `requireMarker: true`, the native mutation boundary requires and compares the
   earlier exact proof against its retained handle **before termination**.

   RED covered the wrong marker, lossy parsing, native/CIM rounding and stale
   one-tick proof. GREEN: final **160 dev lifecycle/exit/watchdog tests** pass.
   They prove native 9/CIM 0 compatibility, distinct native 17/18 refusal within
   the same CIM/Number bins, and stale-proof refusal with the fixture still alive
   before valid-proof success. Unplanned crashes do not get planned receipts;
   unique native exit-code confirmation and complete cleanup remain mandatory.
   Negative native results never fall back to an unsafe PID kill.

4. **Aggressive guidance overstated restart requirements (P3).** Four real
   locale resources now name **Unlock model picker**, prefer in-place repair
   when a port exists, and make save/exit/managed-relaunch conditional on a
   missing port. Prerequisites are explicitly not delivery proof. RED: five
   production-locale cases failed. GREEN: the focused locale/panel/toggle run
   passes **15 tests**; the full frontend suite also passes.

Independent read-only reviews checked the settled recovery, bridge, precision
and native-mutation boundaries and found no further concrete source defect in
this scope. RED/GREEN evidence is in the directory above, including:

- `recovery-request-boundary-red-green.json`;
- `dev-custom-config-red.log` / `dev-custom-config-green.log`;
- `dev-filetime-native-red.log` / `dev-filetime-native-green.log`;
- `watchdog-lossless-ready-red.log` / `watchdog-lossless-ready-green.log`;
- `dev-native-mutation-proof-red.log`, `dev-native-sameprocess-red.log`,
  `dev-native-mutation-proof-green.log`, `dev-filetime-full-unit-final.log`.

## Request-schema checker and UI

Source review confirms inspection runs on the **final outgoing wire body** after
provider/protocol transformations and replay repair. The shared reviewed
Responses structural/tool/replay contract is partial: unknown extensions remain
informational and unchanged; upstream acceptance/all semantic constraints are not
proven.

The existing **Codex → Status → Request Health** UI shows redacted paths,
severity and remediation. Sustained request growth gets size guidance, not a
false payload-invalid claim. Official drift/document-fetch status is separate.
Safe optimization does not rewrite prompts/tool semantics; byte-based token
sizing is approximate diagnostics, not a tokenizer. Redaction fixtures cover
prompt/tool content and endpoint query data.

Retry activity validates delay values, uses static reason classes and canonical
settings patch/readback, and retains the latest 50 in-memory entries—not durable
audit history. Component tests do not constitute live visual/provider validation.

## Final checks

| Check                                      | Result                                      |
| ------------------------------------------ | ------------------------------------------- |
| `pnpm typecheck`                           | Passed                                      |
| `pnpm catalog:verify`                      | Passed; 476 frontend tests plus guards      |
| `pnpm test:unit`                           | **2,668 passed**, 271 files                 |
| Full Rust library                          | **5,032 passed**, 10 existing ignored       |
| Rust recovery / Desktop / multirouter      | **50 / 127 / 156 passed**                   |
| Final full Node scripts                    | **405 passed**, 21 files; no skips/failures |
| Final dev lifecycle / exit / watchdog      | **160 passed**                              |
| `pnpm format:check`, changed-file Prettier | Passed                                      |
| Cargo fmt / strict production Clippy       | Passed                                      |
| `git diff --check`                         | Passed                                      |

Command/timestamp/exit/log receipts: `final-rust-results.jsonl`,
`final-frontend-results.jsonl`, `final-other-gates.jsonl`, and
`final-node-sealed-results.json`. The final Node run hashes 31 changed source
inputs before/after; all stayed unchanged. Rust test compilation retains three
baseline test-only warnings; strict production Clippy passes. No guard, assertion
or gate was weakened. No release/renderer build was rerun.

## Behavior and remaining live boundary

- Continuation waits **5 / 10 / 20 minutes**, within the saved 1–3 attempt budget,
  plus a separate Desktop-readiness window. Live cooldowns refresh their lease;
  restored pending recovery starts a fresh cooldown. Without heartbeat, the
  crash ledger can expire after 15 minutes of downtime/builds.
- Aggressive continuation is separate from dev `watchdogEnabled`. Unexpected
  dev exit can recover the full Vite + Cargo/Tauri lifecycle only while a valid
  recovery owner survives, limited to **5 restarts / 30 minutes**. The one-second
  wait is after cleanup—not total recovery time. Capacity errors do not justify
  dev rebuild escalation. Planned/clean exit intentionally does not replay;
  killing every recovery owner cannot self-relaunch.
- At an agreed safe point, activate corrected native/supervisor code using the
  supported dev lifecycle; existing processes do not hot-reload these fixes.
  Recheck the target Desktop instance with the scoped verifier/current fingerprint.
  Prefer in-place repair for an existing verified port; only if missing, save
  work and fully exit/managed-relaunch Desktop.
- Final live proof needs an explicitly authorized disposable failure long enough
  to observe the native cooldown, one continuation, completion, duplicate guards
  and cleanup; separately test dev crash/relaunch. Never use existing user chats.
  The obsolete D-drive continuation watcher was not started and is unsuitable
  for this checkout.

## Historical evidence and prior cleanup

The **October 25, 2026, 02:43:21 Singapore** receipt at
`H:/repos/ccswitchmulti-refork/.tmp/continuation-20261025-postrestart-20261025-024312/disposable-verifier.json`
proved one literal `continue`, completion, exactly-once delivery and archival
for native owner PID **31256** in that earlier session. It directly invoked
renderer prepare/commit, not elapsed native scheduling or dev crash recovery.
It does not supersede the separate 23:32 readiness failure.

The earlier gated build was hash-verified, never installed/launched, then removed:

- EXE: 47,227,904 bytes; SHA-256 `5746CD4BD10326056625D6B4CAA6F59E48365BCE9C742F97118333E22D81D863`.
- NSIS: 14,674,930 bytes; SHA-256 `7078EB3C7A7858C21E5BB6AFB59C995A40D4E335C469CB3E18110FDFDC32C258`.

Prior cleanup reclaimed about 10.6 GiB of generated targets/extractions/output,
preserving active `src-tauri/target/debug`, source/tests, unrelated outputs,
`.tmp/continuation-20261023` and successful post-restart receipts. The accompanying
JSON retains cleanup path history, historical receipt references and hashes.
Those historical binaries are not a deployment of this re-audit's final source.
