# Reasoning / picker / logging conflict re-audit — November 17, 2026

## Base and scope

- User-authorized fast-forward pull: main, 55fba0ff6 -> 88366c5d9.
- origin remains tngflx/ccswitchmultirouter; no branch/worktree, commit, push, stash, or destructive cleanup.
- Existing unrelated owner-remote source/locales/tests and earlier audit receipts preserved.
- Source compilation and local/mock regression tests are not proof of installed backend behavior or provider acceptance.
- No install, restart, release build, explicit runtime injection, provider configuration mutation, or manual live provider probe was performed by this investigation. Existing development/runtime owners may independently reload edited source.

## Confirmed conflicting authorities addressed

| Boundary                     | Defect                                                                                              | Canonical repair / regression                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Reasoning editor             | Manual Sublyx no-default capability displayed phantom xhigh                                         | Omitted default remains Not declared across callback/rerender                                       |
| Provider persistence         | Form whitelist dropped reasoning summary/source metadata                                            | Exact typed canonical source fields + alias precedence retained; malformed strings omitted          |
| Wizard / compiler connection | Competing base URL readers disagreed on blanks, types and baseURL alias                             | Delegate established shared provider URL readers                                                    |
| Compiler platform inference  | Raw host substring could infer DeepSeek on lookalike/path/query URLs                                | Strict shared platform identity; explicit metadata preserved                                        |
| Native Chat                  | Already-mapped controls re-entered Responses mapper                                                 | Native Chat model identity preparation does not remap reasoning; nonidentity Ultra->xhigh test      |
| Native reasoning aliases     | Responses ignored flat alias; contradictory Boolean/effort intent could be lost                     | Shared logical ingress normalization, conflict validation and one native control projection         |
| Non-graded native Responses  | Stale controls survived or declared vendor Boolean controls were discarded                          | Same declared control conversion/projection as Chat, preserving ancillary native fields             |
| Provider overrides           | Post-conversion body policy could undo main-request reasoning                                       | Shared request-local derived control projection verified after overrides; no second persisted state |
| Native picker ownership      | Capped/unreadable inventory could be treated complete; retained bindings/timers could outlive owner | Fail-closed complete proof + exact retained owner revalidation and restoration; no fabricated Ready |
| Error journal                | Encoded SSE transport failure journaled twice                                                       | Outer transport observation owns fault; nested decoded inspection retains terminal semantics        |
| Retry policy                 | Hardcoded 429 cap ignored configured retries; broad OpenCode 503 branch swallowed capacity retry    | Read configured budget; only recognized admission rejection intercepted                             |
| Stream usage records         | Header200 survived late transport/timeout, including four custom transformed collectors             | Shared outcome-aware collector logs safe502/504, retaining usage and existing failing statuses      |

## Read-only runtime/log evidence

The configured bounded monitor was used (no UI automation). At 2026-11-17 23:04:38 Asia/Singapore, it observed source/renderer fingerprint equality, but readiness was still unverified. That invalidates an earlier explanation based solely on an old installed renderer fingerprint. It does not certify the backend binary.

Receipt: 2026-11-17-new-base-picker-wait20s-readonly.json.

- 3 successful query observers; 0 query errors; native visibility still unverified on all3.
- 9 Boolean controls unverified; no Boolean control certified ready.
- Broad scope scan capped after34 fibers with5 scope candidates; native ownership unverified.
- No test thread created, existing threads not prompted/touched, no provider request sent by the monitor.
- Query arrays listing Max/Ultra are not proof of native rendered menu controls or active agent selection.

Bounded existing-log summary: 2026-11-17-new-base-log-summary-readonly.json. The recent512KiB journal sample contained922 inspection-limit notices,35 consumer-stop notices and1 genuine upstream429. Inspection limit and consumer stop are explicitly incomplete-observation evidence, not proof of upstream failure. Event status200 is the response header, not proof that body consumption completed.

The latest sampled usage import was4 imported,674 deferred,703 scanned. Deferred counts represent unresolved session lineage/import candidates, not provider request failures. Existing exact fork-prefix guards intentionally refuse unproven usage attribution. Audit chats/Sub-Agents can add ordinary dispatch traffic and new child sessions; the supplied09:50 lines cannot be uniquely attributed to this audit from the snippet alone.

## Remaining proven/unverified boundaries — do not mark fixed

1. **Global success/provider health finality:** several forwarder success blocks record success after headers/prewarm, before final stream or nonstream decode/transform completion. Corrected billing logs can therefore disagree with ProxyStatus/circuit/provider/account health. A second compensating write would race asynchronous success, mishandle half-open permits/cancellation, and count recoverable intermediate stream failures. This needs one final request completion owner outside reconnect/transform wrappers, independent of billing logging. It is not fixed by the collector change.
2. **Native readiness:** successful query data and a matching renderer fingerprint do not establish unique mounted native ownership or rendered Boolean controls. Current broad/canonical proof can still be incomplete; preserve fail-closed Unverified rather than hide it.
3. **Forked session usage backlog:** prefix mismatch/missing evidence remains unresolved. Do not guess lineage from token similarity or weaken exact ownership checks.
4. **Saved profile vs global High preference:** saved profile policy can be dormant under the global overlay; UI explanation and dormant-profile validation still need a coherent explicit product contract. Do not bypass canonical profile validation as a cosmetic fix.
5. **Legacy generic effort mappings / local OpenCode Ultra validator:** differing vocabularies remain defense-in-depth/test drift unless a reachable production bypass is demonstrated. Do not mechanically merge product logical and provider-native vocabularies.
6. **Operational log noise needing separate owners:** bounded tails also contain checkpoint metadata/file decode failures, snapshot-mutated-during-decode retries, takeover-recovery remnants, missing injectable CDP targets, and archived-thread delete RPC failures. These are not evidence that the reasoning mapper is wrong and were not changed in this pass.
7. **Provider capacity/quota:** sampled Sublyx traffic includes real 429/daily-limit exhaustion and 120-second stream idle timeouts. These are upstream capacity/runtime conditions, not an effort-map conflict; no provider probe or live mutation was performed.
8. **Provider-wide reasoning fallback review:** the resolver intentionally accepts a validated top-level provider declaration when a catalog row has no capability. This remains a compatibility fallback, not a second persisted catalog; tightening it would require a separate contract decision and regression coverage.

## Verification (completed November 18, 2026)

- `git pull --ff-only origin main`: already up to date at `88366c5d9`.
- `pnpm typecheck`: PASS.
- `pnpm catalog:verify`: PASS (23 catalog-reader checks, 6 discovery checks, 18 Vitest files / 859 tests).
- `pnpm format:check`: PASS.
- `pnpm scripts:check`: PASS.
- `node --test scripts/verify-codex-desktop-continuation.node-test.mjs`: PASS (108/108).
- `pnpm test:unit`: PASS (306 files, 4,359 tests).
- `cargo test --manifest-path src-tauri/Cargo.toml --lib proxy::`: PASS (2,495 tests).
- `cargo test --manifest-path src-tauri/Cargo.toml --lib codex_multirouter::`: PASS (191 tests).
- `cargo test --manifest-path src-tauri/Cargo.toml --lib reasoning_capabilities::`: PASS (116 tests).
- Focused reasoning, final-body-policy, Sub-Agent, and transformed-stream suites: PASS, including the native Chat flat-wire regression and stream failure-status regressions.
- `cargo fmt --check --manifest-path src-tauri/Cargo.toml`: PASS.
- `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`: PASS.
- `git diff --check`: PASS.

The fixed native Chat regression was real: a graded capability's declared flat `reasoning_effort` parameter was being overwritten to nested `reasoning.effort` even on the native Chat path. The mapper now forces nested controls only for native Responses; native Chat honors the declared provider wire parameter. Temporary `DBG` instrumentation was removed. A serializer gap discovered during final verification was also fixed: picker receipts now preserve only bounded fixed-enum scope-cap and canonical-owner diagnostics; the picker remains fail-closed.

RED evidence already captured includes native Chat Ultra mapped twice (xhigh expected, high actual), contradictory enabled/effort accepted, and provider override restoring literal Ultra. The passing source gates do not certify the installed backend binary, installed renderer, live Sublyx/OpenRouter acceptance, or native picker ownership. No install, restart, release build, provider mutation, or live provider probe was performed.
