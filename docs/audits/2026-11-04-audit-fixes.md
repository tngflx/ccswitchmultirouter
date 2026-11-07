# Audit fixes — November 4, 2026

## Historical evidence cleanup — November 8, 2026

The `.tmp/` paths below are historical scratch locations removed during the
user-authorized cleanup on November 8, 2026. Structured findings and verification
conclusions remain in this audit; those paths are no longer retained artifacts.
This cleanup provides no new live-runtime or UI verification, and the audit's
existing live-verification limitations remain unchanged.

## Scope

Implementation follow-up to `2026-11-04-duplication-cli-schema-log-audit.md`,
starting from `f2d9ef921169965b8d41b914c24893ee9d0b88a3` on `main`.
The existing audit document was preserved. No branch/worktree, commit, push,
CLI upgrade, application restart, history rebuild, or live provider probe was
performed. This fixes the concrete audited defects; it is not a claim that all
semantic duplication or every compatibility issue in the repository is gone.

## Changes

### Consumer-aware Codex compatibility and caches

- Prefer explicit `CODEX_CLI_PATH`, then the runtime declared in the incoming
  effective Codex config, rather than silently using another PATH installation.
- Reject invalid/relative explicit paths without probing another installation.
  Plugin/session CLI candidates share that fail-closed boundary.
- Replace process-lifetime assembled-template and bundled-result caches with a
  transient selected-consumer probe keyed by canonical executable/file stamps,
  bounded npm/package manifest stamps, home/CODEX_HOME and paired app-version
  hint. Failed probes can retry after a bounded delay; successful metadata is
  invalidated when the consumer inputs change.
- Use the selected consumer's bundled template before other template sources.
  Do not borrow the unbound shared `models_cache.json` as a known consumer's
  parser shape. Static fallback remains best-effort, not compatibility proof.
- Bind the existing Desktop inline-config compatibility rule to the same
  declared executable. Remove the unrelated highest-installed Desktop gate and
  its now-unused version-detection entrypoints. Use lexicographic version
  comparison and accept subsequent Desktop release trains.
- Neither app-server JSON schema equality nor a CLI help flag is used as proof
  of external model-catalog compatibility. No blanket latest-version requirement
  or automatic CLI update was added. A declared runtime is a hint, not live
  per-process negotiation for concurrently running different Codex clients.

### Generated API-key-group model identity

- Share one TypeScript generated-row predicate and reserved marker across the
  form, wizard, writer, and sanitizer.
- Fix marker-only legacy rows claiming inherited base aliases/upstream IDs,
  which could make valid base references ambiguous and prune routing choices.
- Apply the same ownership rule at the Rust catalog lookup boundary: generated
  rows retain exact public model/id ownership, but do not claim inherited base
  identities for reasoning, product, protocol or image settings.
- Add a shared TS/Rust classification fixture, including metadata-only rows,
  mixed flags, marker-only rows, ordinary models, disabled/excluded exact
  identity authority and canonical-empty authority. The compiler's intentional
  selected-upstream alias path is unchanged. No credential-switching incident
  is inferred from this lookup defect.

### Renderer readiness, not just script installation

- Keep runtime installation/currentness separate from fresh picker readiness.
  Pending diagnostics never force a reinjection that cancels discovery.
- Guardian reports `pickerStatus` and `pickerReadyTargetCount` from existing
  renderer diagnostics. Partial, stale, failed, missing or unknown evidence
  cannot produce aggregate Ready.
- UI is green only for complete fresh Ready evidence. Older native responses
  without readiness fields fail closed. Manual installed-only results are
  neutral, not a claim of readiness, and no longer suggest an unnecessary reload.
- Authoritative empty catalogs are distinct from unavailable catalogs; old
  rows are cleared without treating unavailable state as a successful refresh.

### Confirmed duplication

- Gemini/OpenClaw API-key discovery callbacks now use one shared hook, with
  before/after component parity tests. OAuth and Token Exchange paths retain
  their existing owners and credential requirements.
- About install snippets now come from the backend lifecycle-command authority
  through a read-only IPC. The stale Grok npm-only snippet was removed.
  Loading/errors/invalid results disable copy; retry and stale-response handling
  are covered. Windows batch fallback syntax is wrapped for PowerShell paste
  safety. Reading/copying a snippet does not run an installer.
- Canonical catalogs and their consumer-specific projections were not removed
  as duplicates; those are intentionally different representations.

### BigStrongSun upstream assimilation

Safeguarded upstream fetch on November 4, 2026 found main at
`6c3e9d8d66b1c408690ad3db3c5e332358066e5a`, after new commits
`842da210eaf9d29fc1e4c8e0ea7887507f5a57d5` and
`e4b073f524336b7b37b5ab258f0a1af73a03a737`.
Ported the missing functional delta narrowly: external API profiles whose
Provider target is an enabled Codex router now resolve the concrete current
route before protocol/OAuth selection. Ordinary/disabled providers preserve
pass-through behavior. V2 current-target and authoritative-empty tests cover
the fork-specific contract. Upstream release notes/version changes were not
imported. `origin` ownership and upstream push protection are unchanged.

## Executed regression evidence

Each behavioral fix was tested against its unfixed implementation before the
fix, then rerun after it. The pure model-fetch extraction had parity tests
passing both before and after the move.

- Initial consumer compatibility regressions: 5 failed before the fix.
- Frontend legacy-group identity: 2 failed before, then 2 passed.
- Shared Rust catalog lookup parity: 5 passed/2 failed before, then 7 passed.
- Renderer bootstrap-versus-readiness and explicit-empty diagnostics: failing
  regressions reproduced, then focused suites passed.
- About backend-command/loading/error tests: 3 new failures on old constants,
  then focused About/API suite passed 22 tests.
- Upstream external-router resolution: 1 passed/2 failed before; 3 passed after;
  broader handlers scope passed 140 tests.

## Final verification

All required source gates passed on Windows:

| Command                                                                     | Result                                                          |
| --------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `pnpm typecheck`                                                            | Passed, including final rerun                                   |
| `pnpm catalog:verify`                                                       | Guards and focused catalog suite passed: 15 files / 507 tests   |
| `pnpm test:unit`                                                            | 276 files / 2,778 tests passed, completion receipt verified     |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib codex_multirouter::` | 165 passed                                                      |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib`                     | 5,144 passed / 0 failed / 10 existing ignored                   |
| `pnpm format:check`                                                         | Passed, including final rerun                                   |
| `cargo fmt --check --manifest-path src-tauri/Cargo.toml`                    | Passed, including final rerun                                   |
| `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`          | Passed without weakening the gate                               |
| `git diff --check`                                                          | Passed                                                          |
| `pnpm build:renderer`                                                       | Gated catalog verification and production renderer build passed |
| `pnpm git:remotes:check`                                                    | Only the fork's `origin` remains writable                       |

Final selected-consumer compatibility scope passed 17/17, including an actual
projection-writer snapshot-gate regression. Renderer observation and guardian
Rust scopes passed 4/4 and 10/10; focused frontend readiness/real-cache suites
passed 69/69. The full Rust suite also covers the four new manual-install-command
authority/shell tests. No new test ignores or warning suppressions were added.
The Unix execute-permission regression is present but was not run on this
Windows host; this is not a three-platform/live compatibility certification.

Nonfatal existing diagnostics included Node localStorage experimental notices,
the renderer chunk-size advisory, and test-only Rust warnings. Strict production
Clippy passed. No gate was disabled or an assertion relaxed to obtain a pass.

Verification logs and exit receipts were saved at:
`H:/repos/ccswitchmulti-refork/.tmp/continuation-20261104-audit-fixes/`.
Focused red/green evidence was also saved in the related ignored
`.tmp/continuation-20261104-*` directories and the recorded tool outputs.

## Log follow-up and runtime boundary

A read-only repository diagnostic snapshot at **November 4, 2026, 12:36:13 SGT**
inspected a 150-event router-log tail over a 30-minute window. Its structured
summary reported zero capacity/error candidates. This bounded sample does not
prove semantic request completion, current picker readiness, or which source
revision the running app contains.

Sanitized evidence:
`H:/repos/ccswitchmulti-refork/scripts/logs/codex-oauth-diagnostics/20261104-123613/fix-followup.summary.sanitized.json`.

The earlier overloads, idle timeouts, connection resets and usage-import safety
deferrals were not recast as schema failures. No retries of potentially billed
operations, compressed-history rewrites or accounting-guard bypasses were added.
Source checks and a renderer build are not installation or live-runtime
acceptance: the running native app still needs a deliberate rebuild/restart to
load native changes. No running conversation was interrupted.
