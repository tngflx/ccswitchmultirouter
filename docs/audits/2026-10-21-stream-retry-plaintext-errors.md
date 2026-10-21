# Stop permanent plaintext errors at every retry boundary

The user asked whether unexpected development exits relaunch automatically
and whether overloaded/disconnected streams recover while daily quota errors
stop. Selected settings were `watchdogEnabled: true`, `enableStreamRetry:
true`, `streamRetryMode: aggressive`, and `streamRetryMaxAttempts: 3`.
The active development session had an owned supervisor and detached watcher,
with no recent automatic restarts charged to its five-per-thirty-minute budget.

## Confirmed gaps

The canonical terminal policy already recognized daily quota and billing as
permanent. Renderer continuation applied it correctly. Two backend boundaries
could nevertheless retry a permanent response:

- Reconnect response and transport-error classification attempted JSON parsing
  only. A plaintext `Daily quota limit reached` response with HTTP 429 or 503
  could fall through to a generic reconnect even though capacity classification
  rejected it. The regression observed two reconnect requests instead of one.
- Initial HTTP retry used a separate six-string quota detector. It missed
  plaintext `Daily quota exhausted`, and the OpenCode admission branch ran
  before quota classification. Both initial-HTTP regressions likewise observed
  two requests instead of one. The temporary HTTP 429 control still retried.

## Change

`terminal_error_code_from_body` in `codex_terminal.rs` decodes JSON or treats
plaintext as a string, then uses the existing `terminal_error_code` policy.
It adds no second vocabulary. Both reconnect failure paths and Desktop forward
error recovery use this helper. Initial HTTP classification now runs before
capacity and admission retry branches. Quota uses the existing structured quota
error envelope; other permanent errors retain their original body and policy
precedence. The separate six-string detector was removed.

The reconnect regression exercises all four existing protocol adapters. Tests
also cover plaintext `ProxyError::UpstreamError`, JSON/plaintext classifier
parity, temporary overload controls, and Desktop recovery eligibility. Initial
HTTP tests use an isolated real loopback server for quota/billing under 429/503,
capacity on/off, mixed admission/quota, a genuine temporary 429, and
authentication taking precedence over a simultaneous quota message.

No configured provider, API credential, installed task, or full workspace UI
was used for those regressions.

## Expected behavior

Unexpected development exits relaunch the same JavaScript entry point as
`pnpm dev`, including Vite and Cargo/Tauri, while the detached owner remains
alive and the canonical budget permits. Ctrl+C, clean app quits, disabled
recovery, and exhausted budgets stop recovery.

Transient connection failures, premature EOF, timeout, temporary rate limits,
and overload remain recoverable within their budgets. Transparent reconnects
allow up to five attempts. Aggressive recovery can submit `continue` to the
bound Codex Desktop chat; its current configured budget is three submissions.
Explicit overload can wait five minutes before its first retry when no
`Retry-After` is supplied, then uses exponential backoff.

Daily quota and billing failures stop. Authentication, permission, invalid
request/model, context limit, cancellation, and unknown still-running
`response_pending` operations also stop. A missing or unrecognized provider
error description cannot establish that a response means daily quota.

## Evidence

RED receipts:

```text
%TEMP%/ccswitch-plaintext-quota-red-20261021.log
%TEMP%/ccswitch-initial-http-quota-red-20261021.log
```

Final checks passed: 4,977 Rust library tests with zero failures and ten
existing ignored tests, 156 separate multirouter tests, strict Clippy, Rust
formatting, typecheck, catalog verification with 476 tests, frontend formatting,
and diff checks. The full Rust run includes the regressions that failed above.

A guarded development reload rebuilt the executable at 13:19:32 UTC and
published a ready app with one owned watcher at 13:19:39 UTC. The helper exited
and released maintenance ownership. The session later changed; a separate
read-only verification at 13:22:37 UTC checked the current supervisor 34508,
worker 40268, watcher 35336, and app 32656. There was exactly one owned watcher,
the app marker matched its exact OS creation identity, and ancestry included
the current worker and supervisor. The executable's write time remained
13:19:32 UTC, so the current app runs the rebuilt fix. The session change is
not presented as evidence of automatic failover; that behavior has its isolated
real-process regression. Selected runtime evidence is in
[the runtime receipt](2026-10-21-stream-retry-runtime.json).

Final receipts:

```text
%TEMP%/ccswitch-quota-retry-rust-final-20261021.log
%TEMP%/ccswitch-quota-retry-multirouter-final-20261021.log
%TEMP%/ccswitch-quota-retry-clippy-final-20261021.log
%TEMP%/ccswitch-quota-retry-rustfmt-final-20261021.log
%TEMP%/ccswitch-quota-retry-typecheck-20261021.log
%TEMP%/ccswitch-quota-retry-catalog-20261021.log
%TEMP%/ccswitch-quota-retry-format-20261021.log
%TEMP%/ccswitch-quota-retry-activation-20261021.json
```

Source checks, loopback regressions, and a rebuilt app do not constitute a
live provider interruption audit. No production binary was built or installed.
