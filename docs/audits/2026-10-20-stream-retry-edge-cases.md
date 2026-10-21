# Stream retry edge-case audit — October 20, 2026

This follow-up audits retry behavior beyond the settings persistence defect in
`2026-10-20-stream-retry-policy-persistence.md`. Passing the prior suite did not
establish that every retry path was correct. The audit uses source inspection,
deterministic simulated clients, virtual-time proxy tests, and regression tests.
The configured background monitor remains unavailable; no real provider request,
Desktop continuation, or live CDP audit is used for verification.

## Confirmed defects repaired

| Boundary                  | Failure                                                                                                                                           | Required behavior                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Pending continuation      | An attempt limit lowered during recovery was compared only with the captured old budget.                                                          | Recheck the current policy before each attempt and before submission.                                                     |
| Desktop preparation       | Turning retry off while thread reads were pending did not prevent a later `continue`.                                                             | Prepare without mutating, then obtain backend authorization immediately before committing.                                |
| Crash ledger              | Acknowledged or uncertain continuation submissions dropped their binding before the next proxy request, losing the consumed budget on a crash.    | Persist an explicit waiting phase and restore its budget without resending the old failed turn.                           |
| Initial capacity response | Capacity retries could run in Off mode because the initial and Responses-Lite paths bypassed the effective retry mode.                            | Apply the same effective capacity policy at both boundaries.                                                              |
| Long capacity wait        | A cold error produced no heartbeat; Chat/Anthropic converters also discarded heartbeat comments during a warm wait.                               | Preserve protocol heartbeats through the converters without synthesizing assistant content or duplicate lifecycle events. |
| Failed JSON response      | A streaming request receiving a failed JSON response was marked complete at the final boundary.                                                   | Observe bounded JSON terminal evidence and apply the existing recovery classifier while preserving the response bytes.    |
| Reconnect rejection       | Permanent HTTP authentication/request/quota failures could consume more retries and hide the actionable error; reconnect Retry-After was ignored. | Stop permanent failures and respect bounded retry timing for transient responses.                                         |
| Retry control             | A failed header settings patch produced an unhandled rejection with no visible error.                                                             | Keep the prior policy, show the save failure, and permit a later attempt.                                                 |
| Managed credentials       | Long retry waits retained an old OAuth authorization header.                                                                                      | Refresh credentials for the originally selected account before each send; reject workspace drift.                         |
| Replay evidence           | Comment-prefixed semantic blocks and multiline Anthropic data could leave the replay gate open after output.                                      | Require strict comment-only heartbeats; use converter-aligned event classification and close the replay gate on output.   |
| Stream framing            | SSE transformations retained an upstream Content-Length even when retries or keepalives changed the downstream byte count.                        | Remove Content-Length at the transforming response boundaries.                                                            |
| Unknown upstream outcome  | A still-pending upstream operation could become eligible for automatic continuation.                                                              | Emit and preserve a dedicated response_pending failure that excludes replay and Desktop continuation.                     |

## State and submission ownership

The backend settings store remains the policy authority. Renderer preparation
retains only the request method and failed-turn binding; it cannot submit until
the backend authorizes a commit. The commit still checks newer user actions,
runtime replacement, and the existing persisted per-turn deduplication marker.
Authorization cannot revoke a request already sent to the app-server.

The recovery ledger remains the persisted source for per-turn recovery state.
Its phase records whether a request is active, a recovery is being prepared,
a commit has been authorized, or an acknowledged/uncertain continuation is
awaiting its next proxy request. Read-only preparation does not consume an
attempt. An acknowledgement failure after commit authorization consumes one
attempt conservatively; a definitive refusal without a mutation does not.
Restoring
a waiting phase must preserve the budget without initiating another submission.
Older ledgers without a phase remain readable.

Turning retry Off is rechecked before transparent stream reconnect dispatch,
including after a managed token refresh. The existing initial HTTP
rate-limit/admission loop retains the policy captured when that request began;
this audit does not redefine those separate admission retries.

## Regression evidence

The new failures were exercised before their corresponding fixes. The replay
audit initially produced 11 intended failing regressions. Later focused checks
proved the cold post-reconnect idle gap and an Anthropic replay after multiline
text output. The four managed-credential tests failed against frozen headers
and absent policy checks. Recovery acknowledgement loss made 120 simulated
submission calls instead of one; a definitive refusal left the phase committing.
Framing tests demonstrated an SSE body growing from 72 to 86 bytes while its
original Content-Length remained.

The first complete integration run passed 4,907 tests and exposed three remaining
issues: quota precedence in the capacity classifier, an unintended change to
generic HTTP 502 retries, and a regression harness that did not collect raw
Anthropic's expected I/O error. The classifier fixes retain permanent-error
precedence and ordinary bounded transport retries. The corrected budget test
still requires exactly four reconnects and 180 seconds of total delay and now
also checks the propagated I/O error explicitly.

## Verification

Latest frontend verification passed with a fresh completion receipt: 263 files,
2,507 tests. Type checking, formatting, and the gated renderer build also
passed. Catalog verification passed independently with 23 reader-guard tests,
six discovery tests, and 470 feature tests across 15 files. The renderer build
also ran the offline Responses contract gate.

The final full Rust library suite passed 4,910 tests with zero failures and ten
existing ignored tests. The separate required `codex_multirouter::` scope passed
153 tests. Rust formatting and `git diff --check` also passed. The complete run
includes the 37 recovery tests, all replay protocols, JSON/framing boundaries,
Desktop authorization, managed-credential refresh, and policy persistence.

`cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` passed.

The verified development app was stopped at 23:45:44 +08:00 to let its existing
supervisor run the complete development rebuild. Supervisor PID 40964 remained
the owner; worker PID changed from 60360 to 19508. The executable was written
at 23:47:04.696 +08:00 and the new app started at 23:47:05.057 as PID 30880.
Its executable path, start FILETIME ticks, startup marker, and ancestry back to
the recorded worker/supervisor matched. Saved retry policy remained Aggressive,
enabled, with three attempts. No unrelated settings were changed.

Evidence logs are in the local temporary directory:

- `ccswitch-streamretry-final-rust-20261020.log`
- `ccswitch-streamretry-final-catalog-rust-20261020.log`
- `ccswitch-streamretry-final-clippy-20261020.log`
- `ccswitch-streamretry-final-frontend-20261020.log`
- `ccswitch-streamretry-final-renderer-20261020.log`
- `ccswitch-streamretry-integration-red-20261020.log`

This proves the checked source was rebuilt into the running development app.
It does not prove a real provider request or interrupted Desktop conversation
recovers end to end. The configured live monitor was unavailable, and no live
CDP/provider audit was substituted. No production installer was built or
installed in this follow-up. No claim of a bug-free implementation is made.

## Follow-up duplication audit — October 21, 2026

The follow-up audit found two concrete runtime duplications and removed them.
Managed OAuth previously fetched credentials once to construct the initial
authorization headers and again before the first network send. The initial
credential is now consumed once by the first send, while later retries refresh
the pinned account. Raw Codex passthrough transport retries now use the same
pinned-account callback instead of replaying stale static headers. A callback
count regression covers the first-send/next-refresh sequence.

At that earlier stage, the audit consolidated frontend policy/cache writes into
`src/lib/streamRetryPolicy.ts`, centralized backend terminal marker extraction
and codes in `codex_terminal.rs`, and made recovery tests delegate to the
production ownership-aware transition. The renderer kept a deliberately
mirrored permanent-error guard because it must reject a continuation before
calling the backend; its marker table and parity tests then covered canonical
raw forms.

At that stage, remaining duplication was maintenance debt with no confirmed
runtime failure: four protocol-specific loops repeated orchestration around
protocol output, provider OAuth setup differed by manager/workspace semantics,
and development Node/PowerShell watchdogs retained parallel guarded
restart authorities. The watchdog audit passed 114/114 tests and found no
development/production boundary violation.

The post-audit Rust suite passed 4,911 tests with zero failures and ten existing
ignored tests. Frontend typecheck, formatting, catalog verification, and the
gated renderer build passed. The full UI run passed 2,510/2,515 tests; five
unrelated `PiProviderForm` tests timed out under the long run, and an isolated
rerun passed 42/46 with four of the same capability-detail tests exceeding the
fixed five-second timeout. No retry-related test failed in those runs. These
failures were an unresolved limitation of that earlier run; their cause was not
established by the isolated rerun.

The subsequent BigStrongSun comparison found additional, narrowly portable
reliability changes. The pre-header transport wrapper still allowed a native
Responses opt-in to replay `ResponsePending`, contradicting the shared
recovery guard. Its regression made six sends before the fix; the wrapper now
rejects the ambiguous operation after one send. The upstream local transport
error metadata, explicit stream terminal handling, and official catalog save
fix were also adapted. See
[the October 21 port audit](2026-10-21-bigstrongsun-port-candidates.md) for
the exact upstream revisions, file boundaries, all six subsequent ports, and
combined verification results. The earlier October 20 all-green results and
development app identity above do not validate these later ports.

The earlier October 21 reliability batch, before the six additional ports and
structural cleanup, passed 4,928 Rust library
tests (ten existing ignored), the separate 153-test multirouter scope,
production Clippy with warnings denied, TypeScript, formatting, the 473-test
catalog gate, and the gated renderer build. The full frontend completed with
2,511 passed and seven Pi provider timeouts. That earlier development app was
verified as PID 45584 with worker 13060 under supervisor 35144 at 13:08:04
+08:00; its binary was written at 13:06:46.799. See the port audit for the exact
rebuild evidence and limitations. These are historical results, not verification
of the subsequent six ports and completed structural deduplication.

## Structural follow-up and all six remaining ports

The later follow-up removes the repeated reconnect driver, managed-auth setup,
manual renderer/Rust marker tables, and independently specified Node/PowerShell
recovery policy. Protocol parsing, replay safety, process identity, and
continuation authorization remain explicit guarded boundaries. It also applies
all six candidates from the first upstream comparison, with additional image
alias and account/route context regressions. The Pi tests now use scoped
positive model queries while preserving all assertions and time limits.

Current combined results and refreshed development process evidence are kept
in [the port audit](2026-10-21-bigstrongsun-port-candidates.md). The older
counts and process IDs above describe their named historical stage.
