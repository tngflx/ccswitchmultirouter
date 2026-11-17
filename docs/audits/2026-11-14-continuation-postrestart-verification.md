# Post-restart continuation verification — November 14, 2026

## Result and proof scope

The running CCSwitch **development executable was rebuilt and activated**, and the current renderer bridge passed six controlled tests in the real Codex Desktop instance, **without source injection**. This is live Desktop submission/refusal evidence, not a claim that the native automatic scheduler's production timers were exercised.

All four recoverable scenarios produced exactly one literal `continue` request and a completed continued turn. Both terminal scenarios produced zero continuations. All six confirmed fixture threads were archived, and fixture prompts were restricted to those owned threads.

Machine-readable sanitized receipts: `H:\repos\ccswitchmulti-refork\docs\audits\2026-11-14-continuation-postrestart-verification.json`.

## Confirmed restart defect and correction

After the user's restart, Windows reported an obsolete owner (PID 27368) for `127.0.0.1:9229`, while the live packaged Codex Desktop shell (PID 82520) listened on `[::1]:9229`. The old port-wide ownership check rejected the usable IPv6 endpoint, and the renderer bridge was not installed. The stale IPv4 listener still exists; it has not been removed or authorized.

Production discovery now independently authorizes the exact loopback endpoint before contacting it, binds WebSocket transport to that same HTTP origin, and rechecks ownership when accepting targets. Every covering owner—including conservative wildcard/mapped-address coverage—must be a verified Desktop shell. Partial native queries, forged provenance, redirects, cross-address WebSockets, and title-only authorization are rejected. Source endpoint provenance is transient and cannot be supplied through JSON.

Files changed for this restart fix:

- `H:\repos\ccswitchmulti-refork\src-tauri\src\codex_desktop.rs`
- `H:\repos\ccswitchmulti-refork\scripts\verify-codex-desktop-continuation.mjs`
- `H:\repos\ccswitchmulti-refork\scripts\verify-codex-desktop-continuation.node-test.mjs`

The new Rust regressions demonstrated two failures before the fix (IPv6 literal handling and title-based ownership bypass). New verifier regressions also failed before the transport/terminal/diagnostic fixes. Existing mixed-owner and declared-port-only guards were retained.

## Activated runtime

- Verified repository dev handoff restarted CCSwitch only, from PID **41584** to **46912**.
- New executable write time: **2026-11-14 19:41:06.847 +08:00**.
- New CCSwitch process start: **2026-11-14 19:41:07.095683 +08:00**.
- Codex remained PID **82520**, started at **19:02:13.796545 +08:00**; it was not restarted by this handoff.
- Proxy listener: `127.0.0.1:15721`, owned by the new CCSwitch process.
- Selected verified Desktop endpoint: `[::1]:9229`.
- Binary SHA-256: `6a8fd12b3fd6b9e9b6e124e51fb01acaac85ce206e2e2d4ce5c9f6ee4c6153ff`.
- Renderer fingerprint: `sha256-f9ff21ffd178c7f8d34220170d8f25a3596d9fe30e720bbc2feef12b863b520d`.
- Readiness passed at **19:41:37.259 +08:00**, before any fixture thread was created.

No packaged release installer was produced or installed. The gated renderer build passed; no direct UI automation or visual button inspection was used.

## Installed-runtime test matrix

| Controlled error                         | Initial requests | Continue requests | Observed result                                     | Confirmed thread archived |
| ---------------------------------------- | ---------------: | ----------------: | --------------------------------------------------- | ------------------------- |
| Overload                                 |                1 |                 1 | Literal continue accepted; continued turn completed | Yes                       |
| Concurrent limit                         |                1 |                 1 | Literal continue accepted; continued turn completed | Yes                       |
| Temporary usage limit with retry wording |                1 |                 1 | Literal continue accepted; continued turn completed | Yes                       |
| Connection drop                          |                1 |                 1 | Literal continue accepted; continued turn completed | Yes                       |
| Explicit no-retry signal and wording     |                1 |                 0 | Terminal policy refused; commit not invoked         | Yes                       |
| Hard quota/billing/credits               |                1 |                 0 | Terminal policy refused; commit not invoked         | Yes                       |

The explicit-no-retry fixture includes both `retryable: false` and denial wording. It does not independently prove that the Desktop app-server preserves an isolated boolean field without that wording; the shared policy's exact structured-field behavior is covered by source regressions.

### Failed attempts retained, not hidden

1. The original post-restart readiness monitor failed native ownership inspection, with zero requests and no test thread.
2. Address-aware readiness reached Codex but found the renderer runtime absent. After the native fix was built and activated, readiness passed.
3. The first overload fixture failed at final commit verification: one initial request, zero continuation requests, owned thread archived. Its receipt lacked precise commit diagnostics, so the failure is **not attributed to a proven cause**. The receipt observed generation 2; the later instrumented successful run observed stable generation 3. The verifier now captures only finite acknowledgement/job/reason/generation fields, projected inside the renderer. Production continuation guards were not relaxed.
4. The first hard-quota setup failed with `client_missing` before any fixture request. No thread creation acknowledgement was obtained. Its directory was conservatively retained because thread creation was uncertain; no unowned thread scan or speculative deletion was performed. A fresh owned retry then passed hard-quota refusal and archived its confirmed thread. Do not infer either confirmed creation or confirmed absence from that failed setup.

## Automatic native scheduler boundary

The disposable verifier points an owned thread at a local fixture and directly calls the production renderer's prepare/commit APIs. It does **not** route the failed request through CCSwitch's proxy or exercise the native **5 / 10 / 20-minute** timers. Every successful receipt explicitly sets `automaticNativeSchedulingVerified: false`.

Persisted settings were `aggressive`, maximum attempts **3**. At **20:00:09.893 +08:00**, there were zero post-reload native recovery events in the configured router log. No safe configured automatic-scheduler fixture was found. Existing chats were not deliberately failed and the active provider was not changed to manufacture such evidence.

Source regressions do cover native policy, definite refusal/reprepare without spending budget, and ambiguous acknowledgement consuming once without blind resubmission. Same-fingerprint reinjection deliberately invalidates prepared closures. Native scheduling already retries a positively confirmed no-mutation refusal within its readiness window, preserving ownership and attempt guards. This was not changed to make the direct verifier pass.

## Verification

| Check                                                                    | Result                                                      |
| ------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `pnpm typecheck`                                                         | Passed                                                      |
| `pnpm catalog:verify`                                                    | Reader guards; 18 files / 722 tests passed                  |
| `pnpm build:renderer`                                                    | Passed through catalog and offline Responses contract gates |
| Rust `codex_desktop::`                                                   | 151 tests passed                                            |
| Rust `codex_guardian::`                                                  | 16 tests passed                                             |
| Rust `codex_multirouter::`                                               | 173 tests passed                                            |
| Rust `proxy::`                                                           | 2,418 tests passed                                          |
| Final endpoint regressions after equivalent Clippy simplification        | 18 tests + declared-port-only regression passed             |
| Desktop verifier Node suite                                              | 49 tests passed                                             |
| Production Clippy with `-D warnings`                                     | Passed; no lint suppression                                 |
| Cargo format, frontend format, verifier Prettier, diff whitespace checks | Passed                                                      |

Rust scopes ran with one test thread. Two previously documented test-only compilation warnings remain; production Clippy passed with warnings denied. Existing frontend test/build advisories remain. No check, timeout, guard, or assertion was weakened.

The previously completed catalog toolbar/reasoning-effort changes remain in place. Remote device pairing, inference relay configuration, and screen sharing were not performed. CDP remained loopback-only. The branch remains `main`; no branch, worktree, commit, or push was created.

### Final unchanged test rerun

A final combined-check invocation had one native-mock subprocess regression fail (48/49 passed). The exact focused test then passed, followed by the complete 49/49 suite, with no source or timeout changes between reruns. The initial failure cause was not conclusively established; its subprocess acceptance assertion failed. The existing two-second controlled PowerShell fixture deadline and all production identity guards were retained. Final typecheck and both source/verifier formatting checks also passed.
