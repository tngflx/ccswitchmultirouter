# Anthropic Upstream Stream Retry Completion

## Goal

Finish the stream-retry port for the Codex Responses to native Anthropic
Messages adapter in the refork. A replay factory was already passed into this
handler, but only explicit capacity SSE errors were intercepted; a transport
drop before semantic output still became a terminal conversion error.

## Evidence

- `handle_codex_anthropic_to_responses_transform` receives
  `StreamReconnector`.
- Its raw upstream stream was wrapped only by
  `create_capacity_resilient_upstream_sse_stream`.
- That wrapper yielded transport `Err` immediately, while the Anthropic
  converter turns such an error into `response.failed`.
- The native Responses, direct Chat, and Responses-to-Anthropic paths already
  have bounded pre-semantic reconnect behavior.

## Decision

Extend the raw Chat/Anthropic upstream SSE wrapper with the same conservative
transport retry boundary: reconnect only before semantic upstream output has
been forwarded, preserve separate capacity retry handling, and surface a
terminal stream error after the configured retry budget or after semantic
output. Reuse the finalized immutable replay factory supplied by the forwarder.

## Alternatives Rejected

- Retrying inside the Anthropic-to-Responses converter: the converter owns
  protocol state and cannot safely recreate raw upstream framing after it has
  consumed an error.
- Retrying after semantic content: the proxy cannot retract bytes already sent
  to Codex, so replay would duplicate visible output or tool state.
- Removing the existing capacity wrapper: capacity retry is a separate policy
  with its own budget and must remain observable.

## Ownership And Affected Files

- `src-tauri/src/proxy/providers/streaming_retry.rs`
- `src-tauri/src/proxy/handlers.rs` (call-site selection only if needed)
- Focused unit coverage in `streaming_retry.rs`

## Approval And Status

- Approval: user-requested continuation of the unfinished stream-retry port;
  no additional approval pause required.
- Implementation: complete. The raw Chat/Anthropic SSE wrapper now retries
  pre-semantic transport interruptions, keeps capacity and transport budgets
  separate, emits keepalive comments during the retry window, and continues
  through failed reconnect attempts until the selected budget is exhausted.
  Clean EOF after semantic output remains passthrough behavior.
- Verification: complete for source-level checks. The focused Rust module suite
  passed 49/49 tests, including the regression that exercises
  `message_start` -> transport drop -> failed reconnect -> successful replay
  through the Anthropic-to-Responses converter. Focused frontend retry tests
  passed 3 files/5 tests; `pnpm typecheck`, `cargo check`,
  `cargo fmt --manifest-path src-tauri/Cargo.toml --check`, and
  `git diff --check` passed. Rust emitted only pre-existing dead-code and
  invalid-UTF-8-literal warnings.
- Runtime freshness: pending; a fresh `pnpm dev` restart is still required
  before desktop runtime behavior can be claimed.

## 2026-10-06 Warning Attribution Correction

The earlier statement that the dead-code warnings were "pre-existing" was
incorrect. The reported unused Chat protocol variant and two unused
Responses-to-Anthropic delegates became obsolete when the preceding production
retry paths were rewired to dedicated/context-aware wrappers. They were left
behind by that port, not evidence that stream retry had become unnecessary.

Related decision: `docs/decisions/2026-10-06-stream-retry-warning-cleanup.md`.
That cleanup specializes the raw wrapper as
`create_resilient_anthropic_upstream_sse_stream`, removes the obsolete selector
and intermediate delegate, and moves the convenience delegate into tests.
The transport reconnect-failure loop and the separate capacity budget from
this decision remain in production.

- Approval: unchanged; the warning cleanup is the routine scope recorded in
  its own decision.
- Implementation: complete for the scoped warning cleanup.
- Verification: 240 targeted Rust tests passed (50 retry, 67 Codex converter,
  29 Responses converter, 94 handler tests); `cargo check` exited 0 without
  warnings. Formatting and diff checks passed. Two unrelated warnings remain
  in untouched test-only code, as recorded in the cleanup decision.
- Runtime freshness: still pending; source checks do not refresh the running
  desktop binary. No user process was stopped.

## 2026-10-06 Follow-Up Verification Transition

- Approval and implementation: unchanged.
- Verification: additional forwarder and event-contract tests passed 2/2
  each; focused retry frontend tests passed 3 files / 10 tests. The 240 passing
  retry/converter/handler tests and warning-free production `cargo check`
  cover this port and its cleanup. The latest shared-tree typecheck failed in
  the concurrent Model order tests, as recorded in the observability decision;
  earlier passing typecheck evidence is historical, not a green current gate.
- Runtime freshness: pending; full suites and live-app verification remain
  with the coordinated final delivery boundary. No process was stopped.

## 2026-10-06 Continuation Verification Transition

- Approval and implementation: unchanged.
- Verification: fresh streaming tests passed 172/172, including the 50 retry
  regressions and the dependent Anthropic, Chat, and Responses converters.
  Production `cargo check` exited 0 without warnings; direct formatting checks
  on the four retry-owned Rust files passed. Focused frontend retry tests
  passed 3 files / 10 tests.
- The earlier typecheck-array failure was resolved, but the latest moving-tree
  typecheck now fails on the concurrent Model order control's `ultra` type at
  workspace lines 4956 and 4958. Global Rust formatting also fails in its
  concurrent config/compiler/projection scope. Neither failure is claimed as
  a passing delivery gate; see the warning-cleanup decision's appended record.
- Runtime freshness: pending. Full suites and live behavior are not verified,
  and the user's existing development process remains untouched.

## 2026-10-06 Pre-Commit Evidence Transition

- Approval, implementation, and runtime freshness: unchanged.
- Pending handler tests completed with 94 passed, 0 failed; fresh frontend
  retry/App/workspace tests passed 147/147. The latest shared typecheck fails
  on concurrent projection fixtures at workspace test lines 910 and 911
  (`generatedAt: null` versus string), not the earlier `ultra` control error.
- Exact indexed syntax and diff checks passed. Full suites and fresh runtime
  remain pending. Details and remaining test warnings are recorded in
  `docs/decisions/2026-10-06-stream-retry-warning-cleanup.md`.
