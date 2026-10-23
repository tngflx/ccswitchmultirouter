# Development replacement and stream recovery audit, 2026-10-22

The user reported that a new `pnpm dev` refused to start while the previous
supervisor was alive. The manual launch now replaces the verified development
session for the same repository and configuration. Automatic recovery remains
a separate launch mode and cannot preempt a healthy or newer manual session.

## Development ownership

`dev-tauri-delayed.mjs` now calls the existing session-launch helper before
claiming ownership. A configuration-scoped startup mutex stays held through
old-session cleanup and publication of the replacement's first worker identity.
The native Windows boundary validates retained process handles and exact
creation identities before marking the old session as stopping. It stops and
awaits the old watchdog before the old supervisor, then the launcher cleans
the previous worker, recorded roots, and listeners.

A manual command uses its new arguments and starts a fresh crash budget.
Automatic launches use the internal recovery flag and previous supervisor PID,
retain the canonical restart history (including the legacy migration fallback),
and refuse intentionally stopping or superseded sessions. Reserved recovery
flag variants and unsafe PIDs are rejected. The automatic restart policy remains
five attempts in thirty minutes, conditional on the persisted watchdog setting.
Intentional quits and Ctrl+C stop recovery. Production keeps its executable
relaunch path; it does not run the development build supervisor.

Full development supervisor recovery now preserves stdout and stderr through
the shared detached launch helper, which appends both streams to
`<config-dir>/logs/dev-recovery.log`. The previous `stdio: "ignore"` discarded
all rebuilt Vite, Cargo, and Tauri output. Native Windows probes also proved
that merely inheriting TTY handles and unhiding a detached child yields
`EBADF`; removing detachment lets libuv's job kill the child at parent exit.
The living launcher prints the log path and follow command. Worker restarts
under that living supervisor keep its existing console. Lifecycle records
remain in `dev-watchdog.jsonl`. See the
[native console investigation](2026-10-23-development-recovery-console.md).

Regression evidence includes real Windows fixture processes and mutexes for
manual replacement, watcher retirement, concurrent launches, recovery refusing
a healthy owner, foreign/reused PID protection, failed identity probes, mutex
keeper loss, and an outer watchdog surviving a failed replacement. The final
isolated `pnpm test:dev-recovery` run passed **164/164**. The earlier concurrent
run had one five-second CIM fixture-query timeout; the unchanged isolated run
passed. Fixtures did not start the target application, Vite, Cargo, or providers.

## Additional stream recovery defects

The renderer's interrupted-turn matcher omitted network/socket/fetch errors
and common transport error codes. Preparation could therefore refuse a turn
that the backend had scheduled for recovery. Regression tests exercise the
actual renderer preparation and authorized commit, checking exactly one mocked
`turn/start` while preserving quota, cancellation, identity, and user-action
guards.

The backend's request-failure recovery also omitted HTTP 408 and 425, despite
the stream reconnect path treating them as transient. Both backend boundaries
now use one HTTP status helper. The renderer accepts the same 408/425/429 and
all 5xx statuses, including status-only error objects. Numeric identifiers and
decimal values cannot accidentally match HTTP status codes; normal sentence
punctuation is accepted. Permanent error bodies still take precedence.
The HTTP 408 backend regression and eleven renderer boundary cases failed
before their implementation changes. The final focused renderer suite passed
**59/59**.

Readiness deadlines previously reported only `desktop_ready_deadline`. They
now include a static, redacted `readiness_blocker`, retaining the last completed
preparation refusal if a later preparation hangs. The diagnostic distinguishes
request-client, compatibility-runtime, connection, target, terminal-state,
identity, model, and permanent-error blockers. Arbitrary renderer or transport
messages are excluded from these recovery logs. A paused-time regression
exercises the real deadline loop and verifies that read-only preparation does
not spend a continuation attempt.

Unexpected stream failures and missing terminal EOF can schedule recovery
without matching a particular overload sentence. Actual `continue` submission
requires aggressive recovery, the exact failed thread/model, a remaining
budget, no newer user action, and an available Desktop bridge. A lost
acknowledgement after authorized submission consumes the attempt to prevent a
duplicate turn. Permanent quota/authentication errors and user cancellation
remain terminal.

The selected current settings were `watchdogEnabled: true`,
`enableStreamRetry: true`, `streamRetryMode: aggressive`, and
`streamRetryMaxAttempts: 3`. No setting was changed for this audit.

## Request Health and log boundaries

The JavaScript official-contract checker retained leading/trailing whitespace
that the Rust checker removed. The CLI now trims consistently. Its regression
reconstructs the reviewed schema with formatting changes and confirms no drift,
then changes an actual field type and confirms drift remains detected.
`pnpm contract:check`, all **13** contract tests, and all **47** focused Request
Health panel tests passed.

A read-only `pnpm contract:drift` on October 22 fetched the official reference
and correctly exited 1 for genuine `declarations_sha256` drift: three nested
`prompt_cache_breakpoint` declarations gained optional `ttl` values `30m` and
`12h` (twelve added declaration lines, three removed). Top-level signatures and
input/tool/tool-choice sets did not change. This is positive live drift-detection
evidence, not a failed offline baseline validation. The versioned baseline was
not refreshed or silently accepted. The receipt is
`%TEMP%/ccswitch-final-audit-contract-live-20261022.log`.

Source review confirmed that Request Health tolerates and preserves this
additive nested TTL field. Its conservative diagnostics do not reject nested
cache-breakpoint contents, and safe optimization does not remove them. The new
TTL enum is not yet enforced by the reviewed embedded contract; upstream
acceptance of a request using it was not exercised.

Runtime Request Health inspects final outgoing JSON and the selected Responses
transport, including reinspection after fallback. Official contract checks are
explicit UI/CLI actions; detected changes remain pending review. This is not
automatic schema polling or a complete arbitrary-provider schema validator.

The [scoped log review](2026-10-22-ccswitch-log-review.md) found overload events
and a concrete scheduled recovery followed by a readiness deadline. Its bounded
sample contains no confirmed `submitted` or `outcome_unknown` event. Earlier
scheduled recoveries may be superseded by new requests and cannot all be counted
as failures. The new diagnostic cannot retroactively identify the old blocker.
The configured background provider/CDP monitor was unavailable; no UI automation
or live provider request was substituted. Tests do not prove delivery of a live
`continue`.

## Verification receipts

Two actual manual `pnpm dev` launches completed successfully through the
installed package-manager executable, using the package's real development
entry point. The first launch replaced supervisor 23996/watchdog 27864 and
rebuilt the debug executable at **05:17:25 UTC**. The second replaced that new
session and was verified complete at **05:19:28 UTC**. The final supervisor
43604, worker 58508, watchdog 33368, and app 42436 had matching native creation
identities, exact app-marker FILETIME, and verified process ancestry. Each
takeover had exactly one anchored watchdog, retired both previous owner
identities, and started with an empty restart history.

A further check at **05:21:11 UTC** confirmed all four identities still matched,
the canonical marker still named the final supervisor, the observer had exited,
the app owned the loopback listener on port 15721, and the current Vite process
owned ports 3000/5678. See the
[sanitized runtime receipt](2026-10-22-dev-takeover-runtime.json).

These were planned replacements that activate the current source. Automatic
crash recovery is covered by the real-process fixture regressions; a live
provider interruption was not deliberately triggered. The scoped postactivation
logs show one crash-turn recovery schedule and no confirmed submission, new
upstream error, panic, or watchdog failure in their bounded sample.

The final full Rust library run passed **4,981 tests**, with zero failures and
ten existing ignored tests. Its separate multirouter scope passed **156/156**.
Strict Clippy (`-D warnings`), TypeScript, frontend formatting, and Rust formatting
passed. The lifecycle
Node suite passed **129/129**, the development recovery suite **164/164**, and
the six Windows Pester suites **213/213**.
The isolated `pnpm build:renderer` completed successfully, including its offline
contract check, catalog reader/discovery guards, and all **476** catalog tests.

The full frontend rerun with two workers executed all **269 files / 2,639
tests**: 2,636 passed and three existing UI cases timed out at their unchanged
five-second limit, in `CodexSubagentV2ProfileEditor.test.tsx` and
`ProviderForm.codexPreset.test.tsx`. All 59 updated continuation tests passed
in that run. The earlier run with several heavy checks in parallel had twenty
UI timing failures; it is not counted as a successful full-suite run.

The two affected files were rerun with one worker and their original limits:
**160/161 passed**. The provider cancellation and Sub-Agent reload cases passed;
`removes description alone after all five overrides were established` still
exceeded five seconds. A further exact-name one-worker run also timed out.
Neither that unchanged test nor its UI implementation was modified to obtain
a green result. The full frontend check therefore remains nonzero; these
receipts must not be presented as a clean full-suite pass:

```text
pnpm test:unit --maxWorkers=2
pnpm test:unit src/components/codex/CodexSubagentV2ProfileEditor.test.tsx tests/components/ProviderForm.codexPreset.test.tsx --maxWorkers=1
pnpm test:unit src/components/codex/CodexSubagentV2ProfileEditor.test.tsx --maxWorkers=1 --testNamePattern 'removes description alone after all five overrides were established'
```

Receipts are under `%TEMP%`:

- `ccswitch-final-audit-rust-20261022.log`
- `ccswitch-final-audit-multirouter-20261022.log`
- `ccswitch-final-audit-clippy-20261022.log`
- `ccswitch-final-audit-renderer-isolated-20261022.log`
- `ccswitch-final-audit-unit-isolated-20261022.log`
- `ccswitch-final-audit-ui-timeout-rerun-20261022.log`
- `ccswitch-final-audit-ui-single-case-20261022.log`
- `ccswitch-dev-recovery-final-isolated-20261022.log`
- `ccswitch-lifecycle-pester-final-isolated-20261022.log`
- `ccswitch-takeover-lifecycle-final-20261022.log`
- `ccswitch-final-audit-typecheck-final-20261022.log`
- `ccswitch-final-audit-format-final-20261022.log`
- `ccswitch-final-audit-rustfmt-20261022.log`
