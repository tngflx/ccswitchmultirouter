# Recovery and canonical-ownership re-audit — November 17, 2026

## Scope and evidence boundary

This source audit followed the reported P1 about the Rust production watchdog
and legacy scheduled JavaScript guardian. It examined source ownership boundaries
across Rust startup/settings/recovery, Node development launch/recovery,
frontend settings, packaging/autostart/hooks, proxy transport/turn recovery, and
model catalog/default-effort/Sub-Agent projections. Repository-wide source searches
were used to locate callers; bounded subsystem reviews checked their behavior.
This is not a promise that every duplicate-looking implementation is a bug or
that an arbitrary whole repository has no undiscovered race.

No Computer Use, live provider request, application restart, installation, release
export, scheduled-task mutation, branch/remote change, or push was performed.
Process/loopback/lock fixtures used by tests are disposable and do not control the
installed app. Source/tests do not prove that a previously installed old guardian
is absent on this computer.

## Answer to the original dual-owner report

Current source already rejected production recovery in the JavaScript CLI,
imported runner and policy, and rejected new guardian installations. That was
not enough to justify a blanket installed-environment claim. An older task can
still reference its private copy under its configured guardian root outside
this repository. Startup/packaging does not automatically unregister that task.

The source cleanup now removes dormant production restart/crash-marker/budget
algorithms and installed-process mutation capabilities from the JS guardian,
along with unused staging/registration/start helpers. The old `watchdog:run`
and `watchdog:install` package aliases are removed. Legacy exact action/path/
user/process-creation recognition remains solely for safe inspection/uninstall.
Truthiness cannot opt an imported runner into development or read-only mode;
these flags must be actual booleans.

Supported commands:

- `pnpm watchdog:legacy:inspect` — structured owned-task/process removal preview,
  implemented as uninstall dry-run; no removal occurs.
- `pnpm watchdog:uninstall` — explicitly remove the verified owned legacy task
  and exact processes; it does not recursively delete the guardian directory.
- `node scripts/watch-ccswitchmulti.mjs --plan-only` — compatibility argument
  preview without monitoring/native queries.

The repository's read-only inspector was run on November 17, 2026 with the
default current-user task name and guardian root. It returned exit code 0,
`taskPresent: false`, `matchingProcesses: []`, and `dryRun: true`.
No task was removed and no process was stopped. This is evidence for the default
`CCSwitchMulti-Watchdog` / `CCSwitchMultiGuardian` installation only; custom
task names, custom roots, other users, and the contents of external copies were
not inventoried. No uninstall command was run. The inspection does not establish
that the installed application contains the new source changes.

## Intended ownership diagram

```text
watchdogEnabled (one device-local saved preference)
  ├─ release app ── Rust ensure/retained child receipt
  │                  └─ exact-parent native singleton ── Rust restart ledger
  └─ pnpm dev ──── Node supervisor + detached monitor
                     └─ one launch mutex + canonical dev-session restartTimesMs

legacy scheduled guardian ── inspect / explicit owned uninstall only
old deployed external copy ── default owned task/process absent in read-only check
                              custom locations/users remain unverified
Codex picker guardian ─────── renderer readiness/catalog compatibility (not app recovery)
proxy retry/turn recovery ─── request protocol ownership (not another app watchdog)
```

## Findings and changes

1. **Rust spawn authority:** bounded, best-effort watchdog logs are not a reliable
   live-child registry. A missing/unreadable/displaced receipt can authorize a
   second supervisor. Native receipts and a held exact-parent singleton must be
   authoritative; logs remain observational.
2. **Rust parent liveness:** unreadable identity must not mean dead. Confirmed
   absence/exact different identity may authorize exit handling; unknown native
   state must not charge a restart budget or launch a replacement.
3. **Clean exit contract:** an exact clean-exit event and failed marker removal
   must not be interpreted differently by startup recovery and the watchdog.
   Existing canonical exit classification should be shared, preserving identity
   and panic/crash precedence rather than inventing a second tombstone.
4. **Development stale claim:** a detached monitor could overwrite a newer or
   stopping canonical session. Recovery now uses the existing launch mutex,
   rereads full canonical state before and after absence checks, charges the
   current ledger and spawns under that ownership gate, and releases it before
   waiting for the child to publish.
5. **Model-order async ownership:** an older plan save/preflight can overwrite a
   new plan's UI or a newer same-plan provider. Scoped operations plus canonical
   expected-provider compare-and-set are required for all ModelOrderTab writers.
6. **Catalog identity shadowing:** an explicit public ID must not also resolve
   a sibling's wire alias, or fall through to that sibling when the public row
   is excluded. Full-inventory identity precedence precedes enabled filtering;
   ambiguous wire identities fail closed. Frontend/backend must agree.
7. **Ambiguous transport replay:** hyper fallback errors after a POST may have
   been consumed cannot use the connection-failure retry class. Only confirmed
   connect failures remain transparently retryable; ambiguous sends are pending.

8. **Recovery toggle race:** a disabled supervisor used to exit while a rapid
   re-enable could still see it alive and skip arming a replacement. The same
   owner now remains a passive observer while its parent lives; disabled/unknown
   policy after confirmed parent exit never permits recovery.
9. **Crash-loop budget I/O:** malformed/unreadable history or failed writes must
   not silently reset the limit. Runtime uses strict canonical parsing and a
   required atomic commit before launch; a missing first-run file may initialize
   empty. A permissive UI count is diagnostic only, never restart authority.
10. **Status ownership:** matching the executable path alone does not prove that
    this app owns the listener. The status projection now requires the exact
    current PID/path/start identity, consistent with the recovery readiness gate.

The feature-retirement tests for the old standalone JS production engine are
replaced by explicit absence/refusal contracts. Native identity, uninstall
ownership, maintenance and development-recovery safety coverage is retained;
no guard or build gate is disabled to get a green run.

## Checked boundaries with no additional competing owner found

- Frontend crash recovery uses one persisted `watchdogEnabled` field and the
  existing serialized settings writer. Its status requests are read-only, scoped
  and event/manual driven, not an endless polling restart loop.
- Remote access has its own bounded operation/refresh lifecycle and does not
  write the crash-recovery setting.
- OS autostart is a one-shot Run entry; normal installer completion is a one-shot
  launch, not a crash-restart service. Packaging/hooks do not start another
  scheduled guardian. Elevated updater-task generation remains disabled.
- Sub-Agent reasoning controls remain High/Max with High as the omitted-field
  and new fixed-profile default. Explicit saved Profile settings, Max, and legacy
  values are preserved without rewriting them. This does not restrict the full
  provider/model-picker effort vocabulary for GPT/OpenRouter.
- Request-level retry/continuation is distinct from whole-process watchdog
  ownership; only redacted activity signals reach development supervision.

## Verification

All results below are from the final combined source tree, not isolated agent
branches. Focused regressions were observed failing before their fixes, then
passing after them. Existing disabled/ambiguous catalog, ownership, identity,
maintenance, explicit include-selection, and native GPT/OpenRouter effort guards
were preserved.

| Command / scope                                                             | Result                                                                |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `pnpm typecheck`                                                            | Passed                                                                |
| `pnpm test:unit`                                                            | 306 files, **4,258 passed**                                           |
| `pnpm catalog:verify`                                                       | Reader/contract guards passed; 18 catalog test files, **852 passed**  |
| `pnpm test:dev-recovery`                                                    | **243 passed**, no skips                                              |
| `pnpm test:lifecycle`                                                       | **210 passed**, 1 skipped, 0 failed                                   |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib watchdog::`          | **42 passed**                                                         |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib app_exit_monitor::`  | **14 passed**                                                         |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib process_identity::`  | **18 passed**                                                         |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib proxy::`             | **2,454 passed**                                                      |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib codex_multirouter::` | **188 passed**                                                        |
| `cargo fmt --check --manifest-path src-tauri/Cargo.toml`                    | Passed                                                                |
| `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`          | Passed                                                                |
| `pnpm format:check`                                                         | Passed                                                                |
| Scoped Prettier for changed lifecycle scripts/package/docs                  | Passed                                                                |
| `pnpm scripts:check`                                                        | Passed; no repository-owned PowerShell script files                   |
| `pnpm build:renderer`                                                       | Passed through the gated build path                                   |
| `git diff --check` and `git diff --cached --check`                          | Passed                                                                |
| `pnpm watchdog:legacy:inspect`                                              | Passed; default task absent, no matching owned processes; no mutation |

The lifecycle skip is `refuses a linked post-commit file instead of overwriting
its target`: this Windows session lacks file-symlink creation privilege. Native
directory-junction refusal fixtures passed. No assertion or guard was disabled.
The renderer build reports existing dependency annotation, static/dynamic import,
and large-chunk warnings; they are not failing gates and have not been represented
as resolved performance findings.

Local receipts (under `C:/Users/Felix/AppData/Local/Temp/`):

- `ccsm-recovery-owner-typecheck-20261117.log`
- `ccsm-recovery-owner-frontend-final-20261117.log`
- `ccsm-recovery-owner-catalog-final-20261117.log`
- `ccsm-recovery-owner-dev-recovery-final-20261117.log`
- `ccsm-recovery-owner-lifecycle-final-20261117.log`
- `ccsm-recovery-owner-rust-final-20261117.log`
- `ccsm-recovery-owner-format-final-20261117.log`
- `ccsm-recovery-owner-renderer-final-20261117.log`
- `ccsm-recovery-owner-legacy-inspect-20261117.log`
- `ccsm-recovery-owner-final-hygiene-20261117.log`

The gated renderer build is not a desktop release build or installed-app update.
No live Codex model-picker rendering, provider request, deliberate installed-app
crash/relaunch, or before/after scroll-latency measurement was performed in this
re-audit. Max/High source contracts passing does not establish a measured task
quality/cost comparison. Existing unrelated dirty/untracked work was preserved.

The existing native development launch mutex is Windows-specific. Windows
fixture results do not establish macOS/Linux cross-process exclusion. Existing
inline Windows identity/task probes remain; this change introduces no PS1 files
or hidden migrated PowerShell scripts.
