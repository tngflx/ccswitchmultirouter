# Codex Stream Retry Main-Page Observability

## Goal

Restore the visible stream-retry control on the provider main page in the
refork, while preserving the existing Off/Safe/Aggressive policy and bounded
attempt slider. Expose sanitized live retry transitions so the user can see
when a stream is scheduled for retry, reconnects, fails to reconnect, or
exhausts its budget.

## Evidence

- `src/components/settings/ProxyTabContent.tsx` already mounts the controlled
  `StreamRetryToggle`, so persistence and the settings workflow exist.
- `src-tauri/src/proxy/providers/streaming_retry.rs` already implements bounded
  reconnects for native Responses and converted Anthropic streams, including
  separate capacity retry handling.
- `src-tauri/src/usage_events.rs` already owns app-wide best-effort frontend
  events, but has no stream-retry activity event.
- `src/App.tsx` provider header mounts proxy and failover controls but no stream
  retry control.

## Decision

1. Keep retry policy and retry budgets in the existing backend implementation.
2. Reuse the existing settings query/mutation path for a compact main-page
   control; keep the full segmented control in Settings.
3. Add a bounded, sanitized `stream-retry-activity` Tauri event. Payloads may
   include stage, bounded attempt counters, and local session/model/provider
   identifiers, but never request bodies, headers, tokens, or raw upstream
   messages.
4. Show the in-memory activity feed on the Codex usage/status surface and make
   it reachable from the main-page control.
5. Emit activity at retry scheduling, successful reconnect, reconnect failure,
   and retry exhaustion boundaries for both transport and capacity retry paths.
6. Complete the runtime wiring at both Codex Chat entry paths: direct
   OpenAI-compatible Chat Completions streams and the OAuth
   Chat-to-Responses-to-Chat adapter must receive the finalized replay factory
   from the forwarder before any stream conversion occurs. The forwarder may
   create that factory for Codex Chat and Responses endpoints, while preserving
   the existing safe pre-semantic-output boundary.

## Alternatives Rejected

- Leaving the control only in Settings: technically functional but does not
  match the established main-page workflow and hides an active proxy behavior.
- Replacing the retry engine or increasing retry budgets: outside this request
  and would change runtime semantics.
- Forwarding raw retry errors to the UI: risks leaking upstream response data
  and creates an unstable public event contract.

## Ownership And Affected Files

- Backend event contract: `src-tauri/src/usage_events.rs`
- Backend lifecycle emission: `src-tauri/src/proxy/providers/streaming_retry.rs`
- Runtime wiring: `src-tauri/src/proxy/forwarder.rs`,
  `src-tauri/src/proxy/handlers.rs`
- Main-page control: `src/components/proxy/StreamRetryToggle.tsx`,
  `src/App.tsx`
- Activity view and types: `src/components/codex/StreamRetryActivityPanel.tsx`,
  `src/types/proxy.ts`, Codex usage surface
- Localization: all four `src/i18n/locales/*.json` files
- Focused frontend/backend tests for the event contract and control behavior

## Approval And Status

- Approval: user-requested behavior in the 2026-10-06 conversation; no
  additional approval pause required for this routine, reversible UI and
  observability change.
- Implementation: complete. The forwarder now hands the finalized replay
  factory to direct Codex Chat streams and the OAuth
  Chat-to-Responses-to-Chat path; native Responses and Claude/Anthropic
  conversion paths retain their existing reconnect boundaries. The main-page
  header owns the switch, mode selector, and aggressive-mode attempt slider;
  the Codex workspace status surface owns the sanitized live activity feed.
- Verification: focused frontend retry tests passed: 3 files, 5 tests
  (`StreamRetryToggle`, `StreamRetryHeaderToggle`, and
  `useStreamRetryActivity`). Rust streaming retry tests passed: 48 passed, 0
  failed. `pnpm typecheck` passed.
  `cargo check --manifest-path src-tauri/Cargo.toml` passed with three dead-code
  warnings in `streaming_retry.rs`.
  `cargo fmt --manifest-path src-tauri/Cargo.toml --check` passed.
  `git diff --check` passed; Git only reported CRLF-to-LF
  normalization notices for several pre-existing files, not whitespace
  errors. Those files were not changed here.
  The existing `tests/integration/App.test.tsx` suite remains outside this
  feature's focused verification and has known English-vs-Chinese assertions
  and missing mocked Tauri handlers from the prior localization batch.
- Runtime freshness: pending. The source is newer than the currently running
  Tauri process; runtime verification requires the user to stop the existing
  `pnpm dev` process and restart it from `H:\repos\ccswitchmulti-refork`.

## 2026-10-06 Scoped Commit Verification Transition

- Approval: unchanged user-requested retry control and observability scope.
- Implementation: complete for source. The compact control is
  `StreamRetryHeaderToggle`; the existing Settings control remains intact.
  `useStreamRetryActivityBridge` subscribes once at the App boundary and the
  workspace status surface renders the bounded activity feed.
- Verification: the latest retry frontend run passed 3 files / 10 tests,
  including legacy Off behavior, Safe enablement, Aggressive persistence,
  bounded attempt-slider persistence, activity navigation, and pending controls.
  The event-contract tests passed 2/2, checking camelCase and nullable fields;
  forwarder reconnect-factory tests passed 2/2. Retry/converter/handler tests
  passed 240/240 (50/67/29/94), and `cargo check` exited 0 without warnings.
  Scoped Prettier, Rust formatting, and diff checks passed. The earlier
  workspace/App consumer run passed 123 tests before the other chat's subsequent
  Model order changes; that is not fresh verification of its moving scope.
- Latest shared-tree failure: `pnpm typecheck` reported object arrays where
  `readonly string[]` is expected in
  `tests/lib/codexModelCatalogOrder.test.ts:16,35,47,61`. The Model order owner
  was notified; this retry commit does not modify those files. Earlier passing
  typecheck evidence does not supersede this failure.
- Not tested: full frontend/backend suites and live Tauri runtime.
  No push or release build was performed.
- Runtime freshness: pending. Refork PIDs 7264 and 50172 started at 17:58 on
  October 6, 2026 and have not been stopped. Ask the user to stop the existing
  `pnpm dev`, restart it in `H:\repos\ccswitchmulti-refork`, and confirm the
  rebuild before runtime checks.

## 2026-10-06 Continuation Verification Transition

- Approval and implementation: unchanged.
- Verification: focused retry frontend tests freshly passed 3 files / 10
  tests. Fresh dependent Rust streaming tests passed 172/172, including
  50 retry cases; production `cargo check` exited 0 without warnings. Direct
  formatting checks passed for the retry-owned Rust and frontend files.
- Shared gates: the earlier Model order test-array type errors were resolved,
  and an intermediate typecheck passed. The latest typecheck fails in the
  concurrent Model order control at workspace lines 4956 and 4958 (`ultra`
  is outside its accepted tier union). Global Rust formatting fails in the
  concurrent config/compiler/projection files. No unrelated source was
  rewritten to hide those gates.
- Delivery scope: select only retry integration, retry translations, and
  retry journal entries into this commit. Keep Model order/localization work
  unstaged and preserve all shared working files.
- Runtime freshness: pending. Full suites and the live desktop app remain
  unverified; no push, production build, or process termination occurred.

## 2026-10-06 Pre-Commit Evidence Transition

- Approval, implementation, and runtime freshness: unchanged.
- Fresh frontend retry/App/workspace consumer tests passed 5 files / 147
  tests (10 focused retry cases, 23 App cases, 114 workspace cases).
  Handler tests completed with 94 passed, 0 failed. Test-environment warnings
  remain; see the warning-cleanup decision for details.
- Current shared `pnpm typecheck` fails at workspace test lines 910 and 911
  on concurrent projection fixtures with `generatedAt: null` versus string.
  No unrelated fixtures were changed or staged here.
- Indexed retry integration parses without syntax errors; all four indexed
  locales include retry translations, and the cached diff check passed.
  Full suites and live runtime remain pending. No push or dev restart.
