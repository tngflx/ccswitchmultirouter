# Stream Retry Warning Cleanup

## Goal

Resolve the three reported dead-code warnings in the refork without hiding
warnings, changing retry policy, or reverting the completed retry/UI/dev-runner
work.

## Evidence

- Production Chat streams use
  `create_resilient_chat_sse_stream_with_context` in the direct Chat handler,
  the Chat-to-Responses handler, and the OAuth adapter. Its capacity handling
  is controlled by the supplied `StreamReconnector`.
- The generic raw upstream wrapper has only one production caller, for
  Anthropic Messages. Its `ChatCompletions` variant is constructed only by
  tests, so those tests no longer exercise the production Chat retry owner.
- Production Responses-to-Anthropic conversion calls the context-aware helper
  directly. The two shorter delegates have no production callers; the
  two-argument delegate is only needed by unit tests.
- `streaming_retry` is crate-private. These helpers are not an external API.

## Decision

1. Specialize the raw upstream wrapper to Anthropic Messages, removing the
   obsolete protocol selector and Chat classifier. Preserve its transport and
   capacity budgets, semantic-output boundary, and existing diagnostic labels.
2. Route Chat capacity regressions through the dedicated production Chat
   wrapper, including the Responses converter.
3. Move the two-argument Responses-to-Anthropic convenience helper into the
   test module and remove the unused intermediate delegate. Keep the
   context-aware production implementation and all handler options intact.

## Alternatives Rejected

- `allow(dead_code)` or warning flags: would conceal the stale ownership.
- Switch production Chat back to the older generic wrapper: would remove the
  dedicated wrapper's scaffold suppression and protocol-aware terminal errors.
- Remove retry functionality: the warnings concern unused dispatch/delegates,
  not the production reconnect implementation.

## Ownership And Affected Files

- `src-tauri/src/proxy/providers/streaming_retry.rs`: internal wrapper,
  test-only delegate, and regressions.
- `src-tauri/src/proxy/handlers.rs`: Anthropic wrapper name/signature only.
- This is local, behavior-preserving internal cleanup; no external protocol,
  settings, replay payload, event contract, or upstream policy change is
  proposed, so the reference-repository audit exemption applies.

## Approval And Status

- Approval: not-approved. No separate approval is required for this routine,
  reversible cleanup implied by the user's warning report and continuation
  request under rule 33.
- Implementation: not-started.
- Verification: pending. Run the retry module, dependent converter/handler
  tests, `cargo check`, formatting and diff checks in the normal target.
- Runtime freshness: pending. Do not restart or kill the user's live app.
  A source check is not proof that its current binary contains the change.

## 2026-10-06 Implementation And Verification Transition

- Approval: not-approved; unchanged routine-cleanup boundary under rule 33.
- Implementation: complete. The production raw wrapper is Anthropic-specific;
  Chat regressions now exercise the dedicated production Chat retry owner.
  The two-argument Responses-to-Anthropic delegate is test-only, and its unused
  intermediate delegate is removed. Retry budgets, semantic-output guards,
  diagnostic labels and production context/web-search options are preserved.
  Existing frontend controls, activity logging and the delayed runner were not
  reverted or changed by this cleanup.
- Verification: complete for the scoped source checks:
  - `cargo test --manifest-path src-tauri/Cargo.toml --lib proxy::providers::streaming_retry -- --nocapture`:
    50 passed, 0 failed.
  - `cargo test --manifest-path src-tauri/Cargo.toml --lib proxy::providers::streaming_codex -- --nocapture`:
    67 passed, 0 failed.
  - `cargo test --manifest-path src-tauri/Cargo.toml --lib proxy::providers::streaming_responses -- --nocapture`:
    29 passed, 0 failed.
  - `cargo test --manifest-path src-tauri/Cargo.toml --lib proxy::handlers::tests -- --nocapture`:
    94 passed, 0 failed.
  - `cargo check --manifest-path src-tauri/Cargo.toml`: exited 0 without warnings.
  - `cargo fmt --manifest-path src-tauri/Cargo.toml --check`: passed.
  - `git diff --check`: passed, with CRLF normalization notices only.
  - Source/test search found no references to the removed enum, generic wrapper
    or intermediate delegate.
- Initial failures, subsequently resolved: the first formatting check failed
  on three changed hunks; manual corrections passed the rerun. The first retry
  test run passed 49 and failed 1 because the Anthropic fixture put text only
  in `content_block_start`, which the converter buffers. The fixture now uses
  `message_start`, an empty block start, and a visible text delta before the
  capacity error; the original no-replay/visible-text assertions remain.
- Remaining diagnostics: test compilation emits an unused
  `GenericMoonshotToolSchemaIncompleteContinuation` variant at
  `src-tauri/src/protocol_compatibility/runner_tests.rs:57`, and an intentional
  invalid-UTF-8 literal warning at
  `src-tauri/src/services/session_usage_codex.rs:2579`. Both files have no
  working-tree diff and are outside this fix; this is not a claim that all
  repository test builds are warning-free.
- Not tested in this cleanup: frontend checks/tests, full Rust/frontend suites,
  and live desktop runtime. No release artifacts were built.
- Runtime freshness: pending. The live app was not restarted or killed.
  Ask the user to stop the existing `pnpm dev` process and restart `pnpm dev`
  from `H:\repos\ccswitchmulti-refork`, then wait for confirmation before
  verifying the new source in the live app.

## 2026-10-06 Follow-Up Source Verification Transition

- Approval and implementation: unchanged.
- Verification: the follow-up event-contract tests passed 2/2 and forwarder
  reconnect-factory tests passed 2/2; focused frontend retry tests now pass
  3 files / 10 tests. Scoped Prettier, Rust formatting, and diff checks passed.
  The latest warning-free `cargo check` remains the production warning evidence.
- Failed gate: the latest shared-tree `pnpm typecheck` failed in the other
  chat's active `codexModelCatalogOrder` test scope, at lines 16, 35, 47, and
  61 (object arrays supplied where `readonly string[]` is expected).
  Its owner was notified; no unrelated Model order source was changed here.
- Full suites and live runtime remain untested. A source-only scoped commit
  does not establish publication readiness or refresh the user's running app.

## 2026-10-06 Continuation Verification Transition

- Approval, implementation, and runtime freshness: unchanged.
- Verification: the pending retry run finished with 50 passed, 0 failed. A
  fresh dependent streaming run passed 172/172, including those 50 retry
  cases. Production `cargo check` exited 0 without warnings. A direct
  `rustfmt --edition 2021 --check` on the four retry-owned Rust files passed.
  Focused retry frontend tests passed 3 files / 10 tests.
- Shared gates: a passing typecheck earlier in this continuation superseded
  the historical Model order test-array failure. The next typecheck, against
  the moving shared tree, failed at workspace lines 4956 and 4958 because
  `CodexReasoningEffort` includes `ultra` and the new Model order control's
  accepted tier union does not. Repository-wide `cargo fmt --check` now also
  fails in the concurrent `codex_config.rs`, compiler, and projection edits.
  Those files and controls were not changed by this cleanup.
- Two untouched test-only Rust warnings remain as recorded above. Full
  suites and a fresh live runtime remain unverified; no process was stopped,
  release artifact built, or push performed.

## 2026-10-06 Pre-Commit Evidence Transition

- Approval, implementation, and runtime freshness: unchanged.
- The pending handler run completed: 94 passed, 0 failed. The fresh frontend
  retry/App/workspace consumer run passed 5 files / 147 tests, including the
  10 focused retry cases. It still emits test-environment Tauri mock/MSW and
  React act warnings; passing assertions do not mean warning-free tests.
- The latest `pnpm typecheck` failed at
  `CodexRouterWorkspacePage.test.ts:910,911`: concurrent projection fixtures
  use `generatedAt: null`, while the shared type requires a string. This
  supersedes the earlier Model order `ultra` failure as current gate evidence.
  These test fixtures were not edited or staged by the retry task.
- Exact indexed retry TS/TSX files parsed without syntax errors; all four
  indexed locale files contain the retry keys. `git diff --cached --check`
  passed. Scoped commits are source checkpoints, not final delivery gates;
  full suites and live-app verification remain pending.
- A new production `cargo check` again exited 0 without warnings. Indexed
  retry source and locale Prettier comparisons all passed. The additional
  markdown comparison found formatting in the historical journal that also
  fails on HEAD; it was preserved. Formatting in the new observability record
  was corrected without changing the recorded evidence.
