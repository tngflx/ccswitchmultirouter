# Codex continuation delivery investigation

## Observed runtime failure

The scoped `codex-router.log` snapshot contained 407 scheduled recoveries and
12 readiness deadline failures, with no confirmed `submitted` or
`outcome_unknown` event. Scheduling was not evidence of delivery.

The verified installed Codex Desktop shell was running without a
`--remote-debugging-port` argument. IPv4 loopback target discovery on the
repository's candidate ports (9222, 9223, 9229, 9230, 9231) was unreachable.
`launchCodexDesktopWithCcswitch` was false. The configured background audit
automation/tool was unavailable; no Computer Use or broad workspace UI audit
was substituted.

A running Electron shell cannot acquire its startup debugging flag through a
retry loop. Its parent app-server owns this investigation's running agent, so
fully exiting that shell also terminates this agent. The existing managed
launch path is **fully exit Codex, then use CCSwitchMulti's Unlock model menu**.
The startup launch setting affects future launches and cannot retrofit the
current process. No settings were silently changed, and no active chats were
restarted or submitted to by the verifier.

## Reproduced code defects

- Continuation preparation sampled app-server clients before the existing
  asynchronous discovery promise settled. The fix waits with a deadline and
  rechecks installation and newer user actions before using a discovered
  client. Discovery remains nonblocking for unrelated renderer heartbeats.
- A first renderer could prevent a later usable renderer from being
  considered. Transport and evaluation errors, missing preparation jobs, and
  preparation timeouts now use bounded cancellation before trying another
  renderer. This applies only before a possible commit. User stops, active
  turns, changed threads/models, authorization refusal, terminal errors, and
  uncertain submissions retain their stop behavior.
- Transport/discovery failures from actual CDP producer messages were reduced
  to `desktop_readiness_unknown`. Known producer messages now map to finite
  diagnostic codes without exposing arbitrary error text or request data.
- The continuation bridge could invoke stale runtime methods before periodic
  reinjection updated the renderer. Bridge calls must verify the embedded
  runtime fingerprint for start, poll, commit, and cancel. A lost runtime after
  a possible commit remains uncertain.
- Start, cancel, commit, and job reads previously interpreted mutation evidence
  differently. One shared predicate now derives that evidence from the
  canonical job state, including retained jobs after runtime reinjection.
  Retrying or cancelling a malformed completed job cannot erase uncertainty.
  Cancellation reports `submitted` only for the boolean value `true`.
- A reused submitting job must remain uncertain, while a submission started
  by the current invocation must keep polling for its acknowledgement. The
  backend distinguishes those cases and does not try another renderer after
  either may have submitted a turn.
- Missing or malformed commit and completion acknowledgements could be
  mistaken for proof that no mutation occurred. Only an explicit refusal or
  an explicit non-mutating completion releases the committing reservation.
  Ambiguous acknowledgements preserve uncertainty and duplicate protection.

The existing canonical recovery policy and Desktop runtime diagnostics now
produce an actionable warning when Aggressive continuation lacks its launch
prerequisite. Launch flags alone are not reported as verified delivery. Settings
copy explains that the existing plain Codex process must be fully exited.

## Final source verification

The final frozen source passed these checks:

| Check                                        | Result                                         |
| -------------------------------------------- | ---------------------------------------------- |
| Focused renderer continuation suite          | 69 passed                                      |
| Complete Rust library suite                  | 5,013 passed, zero failed, 10 existing ignored |
| Required Rust `codex_multirouter::` scope    | 156 passed                                     |
| Exact production continuation helper harness | 18 passed; 14 failed before the unified fix    |
| Rust formatting                              | Passed                                         |
| Strict Clippy with warnings denied           | Passed                                         |

The complete Rust suite includes native websocket regressions for preparation
transport/evaluation failures, missing jobs, bounded cancellation and
deadlines, inherited and current submissions, malformed acknowledgements, and
post-commit uncertainty. The Windows close fixture now completes its bounded
close handshake; its exact graceful-close, authorization, expression-count,
and no-fallback assertions remain intact. The four restoration tests use the
repository's serial home isolation, and the installer-path test uses an
explicit fixture instead of depending on the ambient Windows profile.

The final exact commands were:

```text
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo test --manifest-path src-tauri/Cargo.toml --lib codex_multirouter::
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

Source verification does not establish delivery through the active Desktop.
That boundary remains unverified; the Desktop verifier has no completed live
result in this audit.

## Installed Codex protocol evidence

Run the bounded verifier against an explicitly selected installed executable:

```text
pnpm verify:codex-continuation --executable C:/path/to/installed/codex.exe
```

The verifier uses a temporary isolated `CODEX_HOME`, a loopback fixture
provider, newly created threads, and the exact production continuation and
terminal-error policy sources. It starts the real installed Codex app-server;
the provider failures are controlled fixtures. Existing configuration,
credentials, providers, and chats are not copied or altered. The child process
and temporary directory belong exclusively to the verifier and are cleaned up.

The captured [runtime receipt](2026-10-22-continuation-delivery-runtime.json)
records executable and source hashes. This source-verification update leaves
that receipt and its recorded hashes unchanged. Its captured scenarios verify:

| Failure                                  | Real failed turn | Literal `continue` accepted and received upstream | Continued turn completed | Duplicate token prevented |
| ---------------------------------------- | ---------------- | ------------------------------------------------- | ------------------------ | ------------------------- |
| HTTP 503 overload                        | Yes              | Yes, once                                         | Yes                      | Yes                       |
| SSE overload failure                     | Yes              | Yes, once                                         | Yes                      | Yes                       |
| Stream ended before `response.completed` | Yes              | Yes, once                                         | Yes                      | Yes                       |
| Daily quota exhaustion                   | Yes              | No submission                                     | Not applicable           | No replay                 |

This verifies real installed app-server acceptance through the production
continuation core with a client shim. The receipt explicitly records
`desktopCdpVerified: false`. It does not prove delivery through the currently
open Desktop renderer, a real provider request, an installed release rebuild,
or the entire live proxy scheduler. That final Desktop verification requires
the managed Codex relaunch described above.

## Scoped Desktop verification

The separate Desktop verifier uses the existing installed renderer runtime and
its real request client. It verifies the native owner of one explicitly chosen
debug port before any CDP request. It requires a matching runtime fingerprint
from a newly appended CCSwitch installation record, with the selected debug
binary held unchanged throughout verification.

After rebuilding and activating CCSwitch, start the verifier before the full
managed Codex relaunch:

```text
pnpm verify:codex-desktop-continuation --port 9229 --ccswitch-log C:/Users/felix/.cc-switch/logs/cc-switch.log --ccswitch-binary D:/repos/ccswitchmultirouter/src-tauri/target/debug/cc-switch.exe --wait-ms 900000 --run-disposable-test --output D:/repos/ccswitchmultirouter/docs/audits/2026-10-22-desktop-continuation-runtime.json
```

The output path must be unused. Run it independently of the Codex process tree
so it survives the full quit. Readiness is bounded to 15 minutes; the subsequent
test and cleanup are also bounded. Omitting `--run-disposable-test` checks
readiness only and cannot establish delivery.

The actual test creates one fresh durable thread with a per-thread loopback
fixture provider, observes an SSE overload failure, invokes production
continuation preparation and commit, and requires a completed turn whose
upstream request contains literal `continue` exactly once. It archives only its
own thread after checking every observed turn ID against its acknowledged
turns. An unexpected turn or uncertain active work prevents archival. Existing
threads are never used. Ephemeral threads are unsuitable because this installed
app-server rejects their `thread/read` with `includeTurns: true`.

Five guard regressions pass: native wrong-app rejection before HTTP or WS,
bounded missing-port refusal, installation-log freshness and rotation,
exclusive evidence preservation, and archival refusal for unexpected turns.
These guard tests do not establish live Desktop delivery. Only a successful
runtime receipt with `desktopCdpVerified: true` and confirmed cleanup can do so.

The rebuilt development binary was then activated through the normal native
`pnpm dev` path. The [activation receipt](2026-10-22-continuation-dev-activation-runtime.json)
records generation 66, a fresh app binary and marker, one anchored watchdog,
the new owner of proxy port 15721, all four previous process identities gone,
and a planned `development_manual_restart` classification with zero current
warning or error outcomes. The launch adapter uses the resolved native
`pnpm.exe`; a detached PowerShell shim was rejected by a version-only RED
probe because it exited silently, while the native executable passed the same
probe. This is development lifecycle evidence and does not establish Desktop
continuation delivery.

Before the required managed Codex relaunch, an independent WMI-owned Node
watcher was started with a fresh lease. Its disposable parent/child self-test
proved that the watcher remains alive after its requesting parent exits. The
watcher is bounded and refuses existing receipts; it is waiting for the real
Codex debug port and will write the Desktop receipt only after its own durable
fixture thread receives literal `continue`, completes, and is safely archived.
