# Reasoning, picker and recovery authority reconciliation

> Historical audit: retained PowerShell helper/wrapper descriptions below record the state at that time. The script-file retirement and new verification boundaries are documented in [the November 17 migration audit](2026-11-17-no-powershell-script-migration.md).

Date: November 16, 2026 (Asia/Singapore).

## Scope and upstream references

Reviewed fetched BigStrongSun `upstream/main` at `6640e2778`, selectively adapting
compatible fixes instead of cherry-picking over this fork's dirty working tree.
Work remained on `main`; `origin` ownership was checked and no push was made.

Relevant upstream foundations:

| Commit                   | Applied principle                                                       |
| ------------------------ | ----------------------------------------------------------------------- |
| `157482857`              | Built-in Rust watchdog is the production recovery owner.                |
| `0c9b82e7e`, `759f8498a` | Reuse the watchdog settings/status foundation.                          |
| `617e0b977`, `79bdae477` | Preserve provider-native reasoning mappings and GPT Max.                |
| `6f9d39727`              | Separate explicit product Ultra orchestration from native effort.       |
| `1d26d00e7`              | Validate disable contracts and fixed-capability boundaries.             |
| `08df18a52`              | Respect per-model catalog reasoning declarations.                       |
| `f1ee177fa`              | Preserve official picker metadata rather than overriding native effort. |
| `12567b322`              | Retain settings-tab scroll reset.                                       |

## Corrected authority boundaries

### Sub-Agent reasoning and provider validation

- Plan UI, API patch, persisted schema validation and runtime parsing accept the
  same canonical effort vocabulary plus reversible `profile` policy. Saved
  invalid values are not treated as valid merely because TypeScript has a union.
- Explicit Ultra is V2-only; V1 does not forward it as an override.
- New Sub-Agent fixed-profile defaults expose only Max then High among supported
  choices. If neither is supported, no fixed effort is fabricated. Existing
  profile policy is preserved; the canonical parser/runtime still accepts saved
  lower, XHigh, Ultra and other legacy values.
- A concurrent edit reintroduced High-first defaults during verification. Only
  those conflicting default hunks were reconciled to the latest requested
  Max-first, Max/High-only preference; explicit saved High policies were left
  unchanged. A two-case frontend/backend preference parity and fresh-template
  isolation guard now prevents silent drift. This does not change the main-agent
  effort or provider-native model-picker vocabulary.
- Frontend capability validation now covers legitimate `none` disable contracts,
  control kinds and provider wire mappings consistently with Rust.
- Provider-family implementation data still exists in TS and Rust. A new
  34-case parity guard checks the native-Max family list, suffix/case handling,
  effort defaults, Ultra target and provider ownership; this is guarded
  duplication, not a claim that the two implementations were removed.

### Picker projection and readiness

- Unknown descriptor effort tokens cannot survive projection while disappearing
  from diagnostics. Native Max/XHigh and explicit product Ultra are preserved,
  as are fixed/Boolean metadata and canonical catalog payload ownership.
- Required native-visibility readers that are missing or throw remain Unverified;
  they can no longer silently certify Ready.
- Node audit assembly derives fragment resources and replacement order from the
  Rust injector, eliminating its competing hand-maintained fragment manifest.
- Installation is still distinct from readiness. No guard was relaxed to make
  the status page look green.

### Recovery ownership and status

- JavaScript production restart entry points fail closed at CLI and direct-import
  boundaries. The runtime factory no longer exposes an installed-product launcher.
  Production diagnostics require `--no-restart`.
- Explicit development recovery cannot fall through to installed-app recovery,
  including missing, malformed and nonrecoverable dev-session evidence.
- New legacy scheduled-guardian installs are refused; owned-task uninstall
  remains available. Production uses the existing Rust watchdog switch.
- Dev/compatibility restart budgets follow the canonical five-per-30-minute
  policy, with a Rust/JSON parity guard.
- Status derives the dev ledger directory from device-local settings, not a
  relocated database directory. It uses the Node ledger, effective environment
  policy and verified supervisor identity, rather than release-only state.
- Supervisor creation checks saved timestamps at the Node writer's documented
  millisecond precision, retaining PID/path/start-time checks. Native sub-ms
  ticks no longer create false-dead status; different-ms starts are rejected.
- Status exposes configured and effective policies separately. The existing
  Connections & recovery panel explains an explicit environment override in
  English, Simplified Chinese, Traditional Chinese and Japanese.
- Production diagnostics ignore development-only environment overrides.
- Rust supervisor check/spawn/publication is serialized across startup/settings
  calls; the unused compatibility spawn wrapper was removed.
- Retired the duplicate PowerShell recovery implementation. Sixteen original
  path/time/process/maintenance-lease/wait/hash helper bodies remain unchanged
  for the existing upgrade transaction caller. Legacy recovery names fail closed;
  they cannot execute launch callbacks. Policy tests use the canonical JS suite,
  and retained transaction/helper assertions remain in Pester.

### Connections and navigation

- Failed remote mutations do not issue reconciliation IPC after leaving the tab.
- Reactivating during an older status read queues one fresh read without overlap.
- Repeated same-destination settings links carry a request revision.
- Unknown settings tabs normalize to General; the legacy proxy alias is retained.
- Current and historical documentation distinguishes implemented Owner Remote
  controls and the superseded external production-guardian behavior.

### Sub-Agent scrolling review

The current editor has content-keyed 120 ms debounced diagnostics, immediately
invalidates stale work and previews only the open profile. Search/filter/scroll
are not diagnostic-effect dependencies; closed accordion bodies are not forced
mounted. A fresh scoped diagnostics regression run passed seven tests.

No new high-confidence infinite-loop or fetch-loop bug was found in that scoped
source review. Sticky backdrop blur and unvirtualized summaries remain performance
hypotheses, not measured causes or a claim of live scroll-performance repair.

## Verification

| Command/scope                                                      | Final result                                                                             |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `pnpm test:unit --maxWorkers=2`                                    | 306 files, 4,193 passed; completion receipt verified after the Max/High-only UI change.  |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib`            | 5,563 passed, 12 ignored, 0 failed.                                                      |
| Required Rust `codex_multirouter::` scope                          | 184 passed.                                                                              |
| `pnpm catalog:verify`                                              | Reader guards plus 787 tests / 18 files passed.                                          |
| `pnpm typecheck`                                                   | Passed.                                                                                  |
| `pnpm format:check`                                                | Passed.                                                                                  |
| `git diff --check`                                                 | Passed after the final test-helper and audit changes.                                    |
| `cargo fmt --check --manifest-path src-tauri/Cargo.toml`           | Passed.                                                                                  |
| `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` | Passed.                                                                                  |
| `pnpm build:renderer`                                              | Gated build passed, including repeated catalog checks after the Max/High-only UI change. |
| `pnpm test:dev-recovery`                                           | Final run: 232 passed.                                                                   |
| `pnpm test:lifecycle`                                              | Final run after PS1 removal: 191 passed.                                                 |
| Renderer assembler + continuation monitor Node tests               | 104 passed.                                                                              |
| JavaScript lifecycle/release/cache/diagnostic migration suites     | 52 passed, 0 failed.                                                                     |

An initial dev-recovery run failed during temporary-fixture teardown with Windows
`EPERM` after the owned process-exit wait. The fixture now checks its exact
owned temporary directory and uses bounded filesystem removal retries; it still
waits for owned exits and still fails on persistent cleanup errors. A new
regression failed before the fix and passes after it. No recovery/runtime guard
or assertion was removed to bypass the failure. The complete dev suite passed
on the final run.

Build warnings remain for large chunks, an existing static/dynamic import and
dependency comment annotations. Tests also emit existing React act/localStorage
warnings. None was suppressed to make a gate pass.

### Verification failures investigated

A four-worker frontend run, contending with Rust compilation, timed out waiting
for a settings-navigation element. No assertion or timeout was relaxed. The
complete final suite was rerun with two workers and passed all 4,188 tests.

A broad Rust run exposed two atomic Sub-Agent policy tests returning `Applied`
instead of `NotRequired`. The shared test helper created a fresh home/database
but leaked the global cached current-provider selection. Reusing the same fixture
ID reactivated the stale selection. A deterministic regression reproduced
`Some("policy-router")` versus expected `None` before the fix. The helper now
reuses the canonical `TestHomeGuard` to reload settings on entry/exit, with
unwind-safe HOME restoration in the correct drop order. A second regression
checks environment and cache restoration after a panic. Production projection
logic and the original `NotRequired` assertions were not changed. The focused
policy suite passed 11/11 and the new helper regressions passed 2/2; the full
final Rust suite then passed 5,563 with 12 ignored.

### Final evidence and independent review

- The critical frontend/backend Max-default source hashes were checked again
  after the final verification: no drift.
- Independent source review found no additional high-confidence defect in the
  assigned reasoning/picker, recovery ownership, effective-status and retained
  maintenance-helper contracts. All sixteen retained PowerShell helper bodies were also checked
  against HEAD by AST extraction. These are source-review results, not live proof.
- Frontend completion receipt for the final Max/High-only change:
  `C:\Users\Felix\AppData\Local\Temp\ccsm-two-efforts-full-frontend-20261116.log`.
- Focused Max/High regression receipt: 396 tests passed across the workspace,
  profile editor and defaults parity suites:
  `C:\Users\Felix\AppData\Local\Temp\ccsm-two-efforts-focused-20261116.log`.
- Frontend completion receipt from the preceding authority reconciliation:
  `C:\Users\Felix\AppData\Local\Temp\ccsm-authority-final-frontend-2workers-20261116.log`.
- Required frontend/build gates:
  `C:\Users\Felix\AppData\Local\Temp\ccsm-authority-final-gates-20261116.log`.
- Final broad Rust and required gates after the Max/High-only default change:
  `C:\Users\Felix\AppData\Local\Temp\ccsm-two-efforts-final-rust-20261116.log`.
- Earlier authority-reconciliation Rust receipt (including the test-isolation fix):
  `C:\Users\Felix\AppData\Local\Temp\ccsm-authority-final-rust-fixture-fixed-20261116.log`.
- Node recovery/lifecycle/monitor receipt:
  `C:\Users\Felix\AppData\Local\Temp\ccsm-authority-node-final-20261116.log`.
- Pester receipt:
  `C:\Users\Felix\AppData\Local\Temp\ccsm-authority-pester-20261116.log`.

## Live verification and deployment boundary

The configured read-only monitor was invoked without source injection, fixture
threads, continuation submissions or provider requests:

```text
node scripts/verify-codex-desktop-continuation.mjs --inspect-picker
  --ccswitch-log <configured app log>
  --ccswitch-binary <current debug executable>
  --sample-count 3 --sample-interval-ms 1000
  --output <this audit directory>/2026-11-16-picker-readonly.json
```

It exited 1 with `picker_inspection_unavailable` / `picker_target_unavailable`.
One eligible target was reported, but no target inspection or sample completed;
`desktopCdpVerified`, `pickerInspectionPerformed` and `renderedMenuVerified` are
false. The structured evidence is in `2026-11-16-picker-readonly.json`.

This is a failed/unavailable live proof, not a passing live audit and not proof
that Max is absent. No UI automation was substituted. Existing threads were not
touched and no provider requests were made by this monitor invocation.

The earlier configured-monitor audit found an active development session, while
the expected installed release executable and production guardian evidence were
absent. That distinction is not repaired by pretending an installed target exists.

No application restart, desktop installation, provider-setting mutation or Git
push was performed in this fix phase. The renderer build and Rust tests/Clippy
do not replace or reload the running native app. **Live Max/OpenRouter menu
visibility and end-to-end deployed behavior remain unverified.** High-versus-Max
model-completion quality was not statistically benchmarked; Max remains the
requested preference, not a new empirical quality claim.
