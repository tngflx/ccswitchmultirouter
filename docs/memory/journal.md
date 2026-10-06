## 2026-10-06 - Four-hour dev runner checks pass; runtime awaits restart

What happened: rechecked the delayed dev lifecycle before its separate scoped
commit, preserving the retry commit and unrelated shared-checkout changes.

Root cause: direct Tauri watching bypassed the requested delay; missing Cargo
dev/test profile bounds and mismatched process-plugin minors caused the earlier
target growth and startup rejection.

What we did: retained the old supervised no-watch lifecycle with a four-hour
quiet period, bounded dev/test artifact settings, guarded 5 GB maintenance
threshold, and aligned plugin versions. Initial startup still builds normally.

Evidence: fresh runner/prune tests passed 50/50; production `cargo check` passed
without warnings; `pnpm typecheck` passed, superseding the previous shared
fixture failure. Scoped script/manifest/decision formatting passed. Earlier
offline lockfile metadata and baseline lockfile formatting failures remain;
full suites and live runtime were not verified. No push, app restart,
active-target cleanup, competing dev launch, or release build.

What NOT to do again: do not leave Tauri's own watcher active alongside a delayed
scheduler, treat 5 GB as a hard size cap, or verify new source with an old binary.
Related: `docs/decisions/2026-10-06-delayed-dev-runner-port.md`.

## 2026-10-06 — Refork dev target bloat traced to missing Cargo profile bounds

What happened: the freshly ported delayed runner correctly measured and cleaned
the refork target at 44.39 GB, but the next startup still rebuilt a 7.39 GB
debug target and then stopped on a Tauri plugin-version mismatch.

Root cause: the refork had omitted the old checkout's `[profile.dev]` and
`[profile.test]` settings (`incremental = false`, `debug = 0`), allowing Windows
debug dependency/PDB generations to accumulate. Separately,
`@tauri-apps/plugin-process` was materialized at 2.4.0 while the Rust crate was
2.3.1.

What we did: restored the old profile bounds, kept the guarded 5 GB Cargo
target maintenance, and aligned `package.json` plus `pnpm-lock.yaml` to
`@tauri-apps/plugin-process` 2.3.1. Stream-retry files were left untouched in
this pass.

Evidence: old checkout target measured 4.33 GiB; refork post-clean breakdown was
`debug/deps` 5.75 GiB, `debug/build` 1.07 GiB, and `cc_switch.pdb` 0.48 GiB.
`cargo metadata` passed; delayed-runner and cleanup tests passed 50/50; syntax
and diff checks passed. Offline pnpm verification was blocked by missing local
metadata for `@vitejs/plugin-react`.

What NOT to do again: do not treat a size-threshold cleaner as the size-control
itself; restore the Cargo profile bounds before repeated local Tauri builds, and
do not run the refork until the JS and Rust Tauri plugin minor versions align.

Related decision: `docs/decisions/2026-10-06-delayed-dev-runner-port.md`.

## 2026-10-06 - Retry consumer checks pass; shared fixture typecheck remains open

What happened: finished the pending handler run and refreshed the retry's
App/workspace consumer checks before its scoped commit.

Root cause: the retry warnings came from obsolete production delegates; the
remaining shared typecheck failure is a concurrent projection test fixture
using null for a required timestamp string.

What we did: retained the retry cleanup and main-page activity integration;
selected only owned source, translations, and evidence for the index.

Evidence: handlers passed 94/94; frontend retry/App/workspace tests passed
5 files / 147 tests. Indexed syntax, locale parsing, and cached diff checks
passed. `pnpm typecheck` failed at workspace test lines 910 and 911 on
`generatedAt`; test-environment warnings remain. Full suites and runtime are
not verified. No push, app restart, active-target cleaning, or release build.

What NOT to do again: do not conflate scoped test passes with shared delivery
readiness. Related:
`docs/decisions/2026-10-06-stream-retry-warning-cleanup.md`.

## 2026-10-06 - Retry continuation checks pass; shared delivery gates remain open

What happened: completed the pending warning-cleanup test run and rechecked the
retry source while another chat continued Model order changes in the checkout.

Root cause: the three reported production warnings were stale retry helpers,
not missing retry behavior. Concurrent unrelated edits change the shared
typecheck and formatting gates between checks.

What we did: preserved the warning cleanup, main-page controls, sanitized
activity feed, and four-hour dev runner; isolated only retry-owned changes for
the retry commit without overwriting shared source.

Evidence: retry tests passed 50/50; the broader dependent streaming run passed
172/172, including those 50 cases. Focused frontend retry tests passed 3 files /
10 tests. Production `cargo check` passed without warnings; direct formatting
checks on the four retry-owned Rust files passed. The latest typecheck failed
on the concurrent Model order control's `ultra` type at workspace lines 4956
and 4958; global Rust formatting failed in its config/compiler/projection
files. Two untouched test-only Rust warnings remain. Full suites and live
runtime were not verified; no push, release build, or process stop occurred.

What NOT to do again: do not report a historical green gate as current in a
moving shared tree, suppress stale-helper warnings, or use the old running
binary to verify newer source. Related:
`docs/decisions/2026-10-06-stream-retry-warning-cleanup.md`.

## 2026-10-06 - Retry port dead-code warnings corrected

What happened: the user reported three Rust dead-code warnings left by the
refork retry port. Earlier records incorrectly described them as pre-existing.

Root cause: production Chat handling had moved to its dedicated retry wrapper,
and Responses-to-Anthropic handling to the context-aware wrapper, leaving an
obsolete protocol variant and two unused production delegates.

What we did: specialized the raw wrapper to Anthropic Messages, moved the
two-argument convenience delegate into tests, removed the unused intermediate
delegate, and routed Chat capacity/no-replay regressions through the production
Chat wrapper and converter. Preserved retry budgets, semantic-output guards,
reconnect-failure recovery, diagnostic labels and prior UI/dev-runner fixes.
Appended the attribution correction without rewriting the earlier evidence.

Evidence: targeted library tests passed 240/240 (50 retry, 67 Codex converter,
29 Responses converter, 94 handler). `cargo check --manifest-path
src-tauri/Cargo.toml` exited 0 without warnings; Rust formatting and diff checks
passed. Initial formatting failures were corrected; an initial 49-pass/1-fail
retry run was fixed with a valid Anthropic visible-text-delta fixture and
rerun 50/50. Two warnings remain in untouched test code: an unused protocol
fixture variant and an intentional invalid-UTF-8 literal. Frontend/full suites
and live runtime were not tested in this cleanup; runtime freshness remains
pending the user's refork `pnpm dev` restart.

What NOT to do again: do not call port-introduced dead code pre-existing,
suppress warnings to hide stale ownership, or treat unused helper warnings as
a reason to remove retry. Related:
`docs/decisions/2026-10-06-stream-retry-warning-cleanup.md` and
`docs/decisions/2026-10-06-anthropic-upstream-stream-retry.md`.

## 2026-10-06 — Anthropic raw-stream retry loop completed and verified

What happened: the remaining refork stream-retry gap was in the raw
Anthropic-to-Responses upstream wrapper. A transport drop before semantic
content could be observed, but a failed reconnect incorrectly returned to the
outer stream loop with no current stream, so the remaining retry budget was
never used.

Root cause: reconnect failure handling was structured as an outer-loop
`continue` even though `current` was still `None`. The same wrapper also
classified clean EOF after already-forwarded semantic content as a
pre-semantic failure.

What we did: added an inner reconnect loop that consumes bounded transport or
capacity attempts, updates the diagnostic reason after each failed reconnect,
emits retry activity for scheduled/failed/exhausted states, and only resumes
the outer stream loop after a successful response. Preserved clean post-content
EOF passthrough behavior. Added a regression covering Anthropic
`message_start`, transport drop, failed reconnect, successful replay, one
`response.created`, and recovered text.

Evidence: `cargo test --manifest-path src-tauri/Cargo.toml --lib
proxy::providers::streaming_retry -- --nocapture` passed 49/49; the initial
non-library command was blocked by the live app holding
`src-tauri\\target\\debug\\cc-switch.exe` open (`Access is denied`). Focused
frontend retry tests passed 3 files/5 tests; `pnpm typecheck` passed; `cargo
check --manifest-path src-tauri/Cargo.toml` passed with only existing
warnings; `cargo fmt --manifest-path src-tauri/Cargo.toml --check` and
`git diff --check` passed with only pre-existing CRLF normalization notices.
Runtime freshness remains pending until the user stops and restarts the
current `pnpm dev` process.

What NOT to do again: do not jump out of the reconnect loop while `current` is
empty, and do not claim desktop runtime behavior from the stale development
binary. Related: `docs/decisions/2026-10-06-anthropic-upstream-stream-retry.md`.

## 2026-10-06 — Completed refork stream-retry port and main-page observability

What happened: continued the unfinished stream-retry port in the fresh refork
after the first pass had left direct Codex Chat and the OAuth
Chat-to-Responses-to-Chat path without the finalized replay factory, and had
not yet recorded verification evidence.

Root cause: the retry engine already owned bounded reconnect behavior, but the
forwarder only created the replay handoff for the native Responses path.
Separately, the main-page control and event feed had been implemented but
runtime freshness was still blocked by the user's running Tauri process.

What we did: completed forwarder wiring for direct Codex Chat streams and the
OAuth conversion path, retained the safe pre-semantic-output boundary, kept
capacity retry separate, and preserved the sanitized app-wide activity event.
The header now exposes the retry switch, Off/Safe/Aggressive mode, and
aggressive attempt slider beside the proxy controls; the Codex workspace
status surface shows the latest 50 retry transitions and can be opened from
that header control.

Evidence: focused frontend retry tests passed (3 files, 5 tests); Rust
streaming retry tests passed (48 passed, 0 failed); `pnpm typecheck` passed;
`cargo check --manifest-path src-tauri/Cargo.toml` passed with only dead-code
warnings; `cargo fmt --manifest-path src-tauri/Cargo.toml --check` passed.
`git diff --check` passed with only CRLF-to-LF normalization notices for
pre-existing files. Runtime freshness remains pending because the existing
`pnpm dev`/Tauri process was not interrupted.

What NOT to do again: do not hide the retry control only in Settings, do not
create a second replay owner, and do not claim runtime behavior from a stale
desktop binary. Related:
`docs/decisions/2026-10-06-codex-stream-retry-observability.md`.

## 2026-10-06 — Committed dependency tree passes frontend gates; backend lock remains

What happened: the approved dependency upgrades and formatter-compatible source
tree were committed on the fresh-refork `main`; the first final frontend run
caught and fixed a stale pnpm 9.15.0 installer pin in the supplemental Linux
workflow.

Root cause: three release workflows independently owned pnpm versions, and the
Linux workflow was not included in the initial edit.

What we did: removed competing pins so all release workflows consume
`package.json`'s pnpm 12.9.1 declaration, regenerated the policy-valid lockfile
with PostCSS 8.5.28, and applied Prettier 3.9.9 only to the 46 AST-audited
files.

Evidence: direct workflow/identity tests passed (2 files / 6 tests); full
frontend passed (225 files / 1,752 tests); `pnpm typecheck`, `pnpm format:check`,
workflow-test formatting, and `git diff --check` passed. Full Cargo testing
exited 101 before tests because Windows denied removal of the running normal
target `cc-switch.exe`. The remote `origin/main` is still
`641d53c8113ddb5564b3154dd6f75c17570a450e`; publication has not occurred.

What NOT to do again: do not infer a clean publication gate from library-only
Cargo results, and do not bypass the running app with a process kill or
alternate target directory.

Related decisions: `docs/decisions/2026-10-06-refork-dependency-publication.md`
and `docs/decisions/2026-10-06-github-main-refork-cutover.md`.

## 2026-10-06 — Final frontend regressions fixed; GitHub cutover still gated

- **What happened:** Final verification initially exposed two frontend failures;
  after scoped fixes, all 224 files / 1,747 tests passed. The requested GitHub
  main replacement still has not occurred.
- **Root cause:** A language-specific i18n wrapper changed effect dependencies,
  allowing the unchanged settings query snapshot to overwrite a reset/draft.
  The Accordion test assumed a collapsed Radix trigger exposed `aria-controls`,
  although the installed primitive only does so while expanded.
- **What we did:** Guarded query-to-form initialization by snapshot identity and
  marked the observed snapshot consumed on reset. Added three regression tests
  and checked actual expanded trigger/panel IDs and accessible regions without
  changing the production primitive. Recorded the exact-lease main replacement
  decision; preserved the dirty legacy checkout and unrelated dependency edits.
- **Evidence:** Targeted frontend passed (7 files / 173 tests); full frontend
  passed (224 / 1,747); typecheck and diff check passed. Committed Prettier 3.6.2
  passed source formatting, but upgraded 3.9.9 `pnpm format:check` failed on 46
  existing files. Library-only Cargo testing passed 4,364, failed 0, ignored 9.
  **Correction to October 5 entries:** 4,373 is total library tests, not 4,373
  passed. Current full Cargo testing exited 101 before tests because the running
  app locks `src-tauri/target/debug/cc-switch.exe`; integration verification is
  not complete at this boundary. Refork foundation ancestry check passed, but
  freshly fetched remote main is still `641d53c8113ddb5564b3154dd6f75c17570a450e`.
- **What NOT to do again:** Do not equate library-only results with full backend
  verification, silently publish unowned dependency updates, kill the running
  app, bypass its lock with another target directory, or infer 100% migration
  coverage from green tests.

Related decisions:
`docs/decisions/2026-10-06-refork-final-frontend-regressions.md`,
`docs/decisions/2026-10-06-github-main-refork-cutover.md`.

## 2026-10-05 — Final source verification for refork foundation and public identity

- **What happened:** The fresh BigStrongSun-based refork completed the source-level
  migration boundary, including routed reasoning inheritance, clippy root fixes,
  and the public identity cutover to `tngflx/ccswitchmultirouter`.
- **Root cause:** The remaining failures were not broad migration gaps: the
  compiler did not resolve explicit official `upstreamModel` aliases for routed
  reasoning, two clippy findings exposed dead/overloaded ownership, and the fresh
  tree still pointed release/update links at the upstream repository.
- **What we did:** Reused the shared official reasoning resolver at the compiler
  boundary, removed the dead parser and consolidated transform context, restored
  the matching MultiRouter updater endpoint/public key, updated public links and
  release metadata, and kept upstream attribution separate from release identity.
- **Evidence:** `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check`,
  `cargo clippy --manifest-path src-tauri/Cargo.toml -j 1 -- -D warnings`, and
  `cargo check --manifest-path src-tauri/Cargo.toml` passed. Full Rust tests passed
  with `CARGO_BUILD_JOBS=1 cargo test --manifest-path src-tauri/Cargo.toml --
  --test-threads=1` (4,373 unit tests plus all integration tests, 0 failures).
  `pnpm format:check`, `pnpm typecheck`, and `pnpm test:unit` passed (224 files,
  1,744 tests). Targeted updater/identity tests passed (3/3), and `git diff --check`
  passed. Fork-specific identifier audit found all required identifiers.
- **What NOT to do again:** Do not claim 100% completion from source tests alone.
  The fresh runtime still needs a user-authorized stop/restart of `pnpm dev` from
  `H:\repos\ccswitchmulti-refork` before non-disruptive runtime inspection, and
  the guarded remote `main` replacement must wait until that freshness check and
  final diff/remote audit are complete.

## 2026-10-05 — routed Codex reasoning picker root fix

- **What happened:** Fresh-refork routed provider rows (for example Sublyx aliases) reached Codex Desktop with an empty reasoning-effort list.
- **Root cause:** MultiRouter copied only inline `modelCatalog.models[].reasoning`; it never resolved an explicit `upstreamModel` through the existing shared capability resolver. Router `defaultReasoningEffort` was only a preference and did not provide capability evidence.
- **What we did:** At the compiler boundary, reused the shared resolver and official cache only for explicit upstream aliases, preserving canonical schema and fail-closed behavior for unknown custom models. Added regression coverage.
- **Evidence:** `cargo check --manifest-path src-tauri/Cargo.toml -j 1` passed; `pnpm typecheck` passed. Targeted cargo test was attempted but could not execute because Windows paging-file exhaustion corrupted/made metadata unloadable (OS error 1455); no test result was claimed.
- **What NOT to do again:** Do not add UI-only defaults or generic model-name inference; do not make custom providers inherit official capabilities without an explicit upstream alias and resolver source.

# Engineering Journal

## 2026-10-05 Completed source verification for the fresh refork migration

What happened: the approved fresh-refork port batch reached its source-level
verification boundary. The initial parallel full Rust command could not finish
because Windows exhausted the paging file while compiling tests (`os error
1455`), producing invalid metadata and cascading crate-load errors.

Root cause: verification parallelism exceeded the available Windows paging
capacity; the compiler diagnostics did not identify a source failure.

What we did: reran the unchanged full Rust suite with one Cargo build job and
one test thread, then retained the existing frontend and targeted verification
results. We did not weaken or skip tests, create an alternate target directory,
or change source to mask the environment failure.

Evidence: `cargo test --manifest-path src-tauri/Cargo.toml -- --test-threads=1`
with `CARGO_BUILD_JOBS=1` exited 0 across the full unit and integration suite;
`cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check`, `cargo check
--manifest-path src-tauri/Cargo.toml`, `pnpm format:check`, and `pnpm typecheck`
passed; full Vitest passed (1,744 tests); and `git diff --check` passed. The
fresh desktop runtime was not rebuilt or inspected, and the remote/physical
cutover was not performed.

What NOT to do again: do not interpret paging-file exhaustion as a source test
failure, do not bypass the full suite with a second build target, and do not
claim runtime freshness or replacement cutover from source-only evidence.

Related decision: `docs/decisions/2026-10-03-bigstrongsun-refork-foundation.md`.

## 2026-10-05 Classified remaining legacy-only candidates

What happened: the fresh refork still had no direct counterparts for the
legacy global-loading/deferred-render layer, the generic common-config loader,
or the monolithic Codex compatibility template.

Root cause: these files came from the legacy fork's incremental UI and CDP
patches, while the fresh architecture uses app-specific config hooks and a
standalone model-picker core. BigStrongSun's current history also removed dead
common-config plumbing.

What we did: rejected the generic common-config hook and compatibility
template as duplicate owners; deferred global loading/deferred rendering
because the fresh tree has no consumers or upstream equivalent; and recorded
the rationale in `docs/decisions/2026-10-05-legacy-only-audit.md`.

Evidence: fresh-tree searches confirmed none of the four legacy source modules
are referenced; `git show upstream/main:src/components/providers/forms/hooks/useLoadCommonConfigSnippet.ts`
confirmed the helper is absent upstream; and the reference history inspection
found the deliberate common-config cleanup in commit `69ff69dd7`.

What NOT to do again: do not copy legacy-only files solely because their paths
are missing. First establish a current fresh consumer and a single ownership
boundary, then port only the behavior that remains required.

## 2026-10-05 Added visible-only Codex catalog rendering

What happened: the fresh refork's Codex form rendered every catalog row in the
reasoning and model-mapping editors and resolved reasoning for the entire
catalog. Root cause: the fresh architecture had not yet adopted the legacy
viewport's explicit page and expansion boundary.

What we did: added `CodexCatalogViewport` with stable row-ID pagination,
explicit expansion, visible-row callbacks, and disabled-inventory controls;
wrapped both catalog surfaces; and limited reasoning resolution to visible
rows. Existing catalog reconciliation, persistence, protocol overrides, and
input-capability ownership remain in `CodexFormFields` and its current helpers.

Evidence: `pnpm exec vitest run
tests/components/CodexCatalogViewport.test.tsx` passed (2/2);
`pnpm exec vitest run tests/components/CodexFormFields.test.tsx
tests/components/CodexCatalogViewport.test.tsx` passed (42/42);
`pnpm typecheck` passed; targeted Prettier checks passed; and `git diff --check`
passed. Runtime freshness was not checked because the refork desktop process
has not been rebuilt and restarted. Related decision:
`docs/decisions/2026-10-05-codex-catalog-viewport-port.md`.

What NOT to do again: do not reintroduce direct full-catalog maps or move
catalog persistence and reasoning policy into the viewport renderer.

## 2026-10-05 Restored takeover activation feedback in the refork header

What happened: the fresh refork kept the proxy/takeover state and color change
but had lost the legacy header's one-shot activation feedback. Root cause: the
visual transition component was not ported even though `App.tsx` already owned
all required state.

What we did: added `RoutingActivationBrand`, gated its transition on resolved
proxy/takeover status, keyed it by active app context, and kept all IPC and
state ownership in `App.tsx`.

Evidence: `pnpm exec vitest run
tests/components/RoutingActivationBrand.test.tsx` passed (2/2);
`pnpm typecheck` passed; targeted Prettier checks passed; and `git diff
--check` passed. Runtime freshness was not checked because the refork desktop
process has not been rebuilt and restarted. Related decision:
`docs/decisions/2026-10-05-routing-activation-brand-port.md`.

What NOT to do again: do not move proxy status ownership into a visual header
component or animate the initial resolved state as though it were a new
activation.

## 2026-10-05 Consolidated auto-sync coordination and restored Windows taskbar icon

What happened: the fresh refork had duplicate suppression, debounce, dirty-signal,
and worker-loop implementations in WebDAV and S3 auto-sync, and it lacked the
legacy fork's explicit large Windows taskbar icon assignment. Root cause: the
refork port retained transport modules as independent copies instead of separating
shared coordination mechanics from transport-specific upload behavior; AppUserModelID
alone did not restore the native `ICON_BIG` assignment.

What we did: added a transport-neutral `services::auto_sync::AutoSyncState` with
one static instance per transport, preserving independent suppression and status
contracts while removing duplicated queue/worker logic. Added and registered the
Windows-only `WM_SETICON(ICON_BIG)` plugin without changing AppUserModelID setup.

Evidence: `cargo test --manifest-path src-tauri/Cargo.toml --lib auto_sync` passed
(13/13); `cargo test --manifest-path src-tauri/Cargo.toml --lib windows_window_icon`
passed (1/1); `cargo check --manifest-path src-tauri/Cargo.toml` passed; and
`git diff --check` passed. Runtime freshness was not checked because the refork
desktop process has not been rebuilt and restarted. Related decisions:
`docs/decisions/2026-10-05-auto-sync-coordination-port.md` and
`docs/decisions/2026-10-05-windows-taskbar-icon-port.md`.

What NOT to do again: do not duplicate coordination mechanics inside each sync
transport, merge transport suppression state globally, or add a second Codex
compatibility injector when the refork already owns equivalent inline cores.

## 2026-10-05 Ported Codex catalog normalization into the refork

What happened: the fresh refork accepted the shared Codex catalog contract at
the renderer boundary, but imported or persisted legacy aliases could still
reach SQLite and MultiRouter compilation in noncanonical form. Root cause: the
normalization owner stopped at the frontend adapter, leaving provider DAO and
compiler inputs inconsistent.

What we did: added the pure idempotent normalizer under
`codex_multirouter::catalog`; applied it only to Codex provider DAO
read/write/direct-update boundaries; and normalized cloned provider inputs
before compiler validation, mutation planning, and provider-set planning. The
normalizer covers catalog aliases, context-window token strings, modalities,
reasoning metadata, and cache metadata. Non-Codex settings, remote
reconciliation, route pruning, and route projection remain owned by their
existing layers.

Evidence: `cargo check --manifest-path src-tauri/Cargo.toml` passed; focused
Rust tests passed (catalog 1/1, compiler 20/20, provider DAO 7/7,
provider-set 23/23); `pnpm typecheck` passed; affected Vitest suites passed
(7 files, 52/52 tests); and `git diff --check` passed. Runtime freshness was
not checked because the refork desktop process has not been rebuilt and
restarted.

What NOT to do again: do not normalize only in React, copy the legacy DAO into
every caller, or create a second owner for reconciliation, route projection,
or pruning. Related:
`docs/decisions/2026-10-05-codex-catalog-normalization-port.md`.

## 2026-10-05 Ported Codex catalog version pruning

What happened: the fresh refork preserved the full reconciled Codex catalog
when users explicitly reset model order, while the legacy fork removed stale
recognized releases from each model branch. Root cause: version pruning was a
projection concern that had been omitted when catalog reconciliation was
centralized in the refork.

What we did: added a pure shared pruning utility and made the route compiler
apply it only for explicit model-order reset. The utility keeps the newest
release per capability branch, treats GPT codenames and specialized offerings
independently, compares dated snapshots only within the same release identity
and date width, preserves unknown aliases, provider namespaces, input order,
and object identity, and filters spawn-agent candidates against the pruned
model set. Ordinary projection and persistence remain unchanged.

Evidence: `pnpm exec vitest run tests/lib/codexCatalogVersionPruning.test.ts
--reporter=dot` passed (6/6); the focused compiler/reset run passed (22/22);
the combined pruning/compiler assertions passed (8/8); `pnpm typecheck` and
`git diff --check` passed; and targeted Prettier formatting was applied and
checked. Runtime freshness was not checked because the refork desktop process
has not been rebuilt and restarted.

What NOT to do again: do not prune every catalog projection, copy pruning into
the provider form, or introduce a second reconciliation owner. Related:
`docs/decisions/2026-10-05-codex-catalog-version-pruning-port.md`.

## 2026-10-04 Ported Codex plugin/browser health diagnostics

What happened: the fresh refork exposed Codex personal-plugin registration
repair but had no browser integration health report or Settings panel. Root
cause: the legacy fork bundled browser/plugin checks beside registration
detection, while the refork already had a newer registration owner that should
not be duplicated. What we did: added a read-only browser diagnostics service
that delegates registration detection to `codex_plugin_registry`, probes the
bundled Browser plugin scripts, exposes typed IPC/API contracts, adds an
Advanced Settings panel with explicit repair actions, and localizes all new
strings in `en`, `zh`, `zh-TW`, and `ja`.

Evidence: `pnpm exec vitest run
tests/components/CodexPluginHealthPanel.test.tsx` passed (2/2); `cargo test
--manifest-path src-tauri/Cargo.toml --lib
services::codex_plugin_health::tests` passed (2/2); `cargo check
--manifest-path src-tauri/Cargo.toml` passed; `pnpm typecheck` passed;
targeted Prettier checks, new-module `rustfmt --check`, and `git diff --check`
passed. The Rust test build emitted two unrelated existing warnings. Whole
crate `cargo fmt --check` still reports known formatting differences outside
this feature. No rebuilt runtime was inspected.

What NOT to do again: do not copy the legacy plugin registry into the refork,
automatically install browser extensions/native hosts, or claim live health
without rebuilding and restarting the refork app. Related:
`docs/decisions/2026-10-04-codex-plugin-health-port.md`.

## 2026-10-04 Ported Codex session deletion coordination

What happened: the fresh refork deleted local Codex rollout files but did not
notify the Codex app-server, and it lacked the legacy confirmed purge for
archived rollouts. Root cause: local provider deletion and Codex's persisted
thread catalog are separate ownership boundaries. What we did: retained the
fresh multi-provider Session Manager and Pi discovery, added one focused
`thread/delete` app-server coordinator, kept catalog cleanup best effort after
validated local deletion, and restored an all-items-attempted archived purge
through typed IPC and a confirmed Codex-only UI action. Evidence: coordination
tests passed 1/1, session-manager tests 6/6, Codex provider tests 21/21, the
Session Manager component suite 18/18, `cargo check` and `pnpm typecheck`
passed, and targeted formatting checks passed. One initial frontend assertion
failed because the test i18n harness used the English default-value fallback;
the assertion was corrected and the suite rerun. Whole-tree `cargo fmt --check`
still reports known upstream/toolchain formatting drift outside this port. No
rebuilt runtime was inspected. What NOT to do again: do not treat rollout-file
deletion as sufficient catalog cleanup, mutate Codex state databases directly,
or replace the fresh Session Manager with the legacy component. Related:
`docs/decisions/2026-10-04-codex-session-deletion-coordination.md`.

## 2026-10-04 Finalized four-point request-body accounting

What happened: the request-health port initially observed parsed/transformed
JSON but did not prove what exact client bytes arrived, what immutable bytes
each retry replayed, or what compressed bytes reached the upstream transport.
Root cause: request measurement and retry construction were distributed across
handlers, provider transforms, Responses-Lite fallback, rejection retry, and
stream reconnect. What we did: attached exact decoded byte counts before JSON
parsing; introduced one finalized payload owning transformed JSON and optional
zstd wire bytes; made ordinary, rejection, transport, and stream retries clone
that payload; separately finalized Responses-Lite fallback; and kept semantic
review independent from wire-byte approval/hash accounting. This also fixed the
fallback reconnect path so it replays the accepted fallback variant rather than
the rejected primary body. Evidence: `cargo check` passed; request-health tests
passed 17/17; OpenAI compatibility tests 38/38; Codex request-policy tests 36/36;
forwarder tests 183/183; focused frontend tests 5/5; and `pnpm typecheck` passed.
One initial unscoped targeted Cargo invocation failed before tests with stale
multi-target `E0460`/`E0463` artifacts; library-scoped verification passed, and
the full Rust suite remains for the final migration boundary. No live refork
runtime was rebuilt or inspected. What NOT to do again: do not reserialize or
restore request history inside a retry, hash semantic JSON while sending a
different compressed entity, or let fallback reconnect retain the rejected
primary variant. Related:
`docs/decisions/2026-10-04-request-health-port.md`.

## 2026-10-04 Ported bounded Codex Desktop turn recovery

What happened: the fresh refork already reconnected Responses streams before
semantic output but lacked the legacy fork's bounded Desktop continuation after
an interrupted turn. Root cause: transparent HTTP replay and semantic Desktop
continuation are different recovery layers, and copying the legacy handler
would have created duplicate retry ownership. What we did: kept immutable
pre-semantic replay in `streaming_retry.rs`; added a session-scoped final-stream
observer for verified Codex Desktop requests; excluded compaction; added a CDP
composer submission operation to the existing Desktop owner; and replaced the
Boolean UI with one SettingsPage-controlled Off/Safe/Aggressive selector that
also persists the legacy compatibility flag. Evidence: `cargo check
--manifest-path src-tauri/Cargo.toml` passed without library warnings; recovery
tests passed 8/8; Codex Desktop tests passed 51/51; the two focused retry-policy
tests passed; the prior handler identity test passed 1/1 and streaming retry
tests passed 45/45; focused frontend tests passed 12/12; and `pnpm typecheck`
passed. The full suites and live Desktop runtime remain untested at this stage.
What NOT to do again: do not merge semantic continuation into transparent
stream replay, accept External API identity spoofing, or give a settings widget
its own full-object save path. Related:
`docs/decisions/2026-10-04-codex-desktop-turn-recovery-port.md`.

## 2026-10-04 Ported reasoning and catalog compatibility into fresh refork

What happened: the fresh foundation had the canonical Codex request and
catalog owners, but lacked the legacy compatibility names and several catalog
sync safeguards. Root cause: the legacy fork exposed adapters and form-local
reconciliation while the fresh architecture had already centralized those
responsibilities under `HistoryReplay`, OpenAI compatibility normalization,
and `codexCatalogReconciliation.ts`.

What we did: added thin `ReasoningContentMode` and strict-schema normalizer
adapters over the existing request owners; moved catalog schema normalization,
identity binding, context inference, capability hydration, refresh policy, and
safe missing-row removal into the central reconciliation module; and reduced
`codexCatalogSync.ts` to re-exports so there is one owner.

Evidence: `cargo check --manifest-path src-tauri/Cargo.toml` passed;
three reasoning-mode Rust tests and one strict-schema adapter Rust test passed;
`pnpm vitest run src/lib/codexCatalogReconciliation.test.ts` passed (6 tests);
`pnpm typecheck` passed; and `git diff --check` passed. Runtime freshness was
not checked because no rebuilt desktop process was requested. Related decisions:
`docs/decisions/2026-10-04-reasoning-compatibility-adapters.md` and
`docs/decisions/2026-10-04-catalog-reconciliation-port.md`.

What NOT to do again: do not copy legacy request branches or form helpers into
the fresh refork when the new architecture already has a canonical owner.

## 2026-10-04 Ported model-specific key-group editor

What happened: the fresh refork's grouped Codex credential UI could edit exact
model IDs but could not discover models per group or target model prefixes.
Root cause: the fresh form retained a simplified inline editor while the
legacy fork had a reusable group model editor.

What we did: recorded the ownership boundary and ported one reusable editor
that delegates successful model discovery to the fresh form's existing catalog
reconciliation owner. No second routing or catalog store was added.

Evidence: `pnpm exec vitest run
src/components/providers/forms/CodexKeyGroupModels.test.tsx` (5 passed),
`pnpm typecheck`, Prettier checks on all changed files, and `git diff --check`
passed. Runtime freshness was not checked because no rebuilt desktop process
was requested.
What NOT to do again: do not copy the legacy Codex form wholesale when the
fresh form already owns catalog state and reconciliation. Related:
`docs/decisions/2026-10-04-key-group-model-editor-port.md`.

## 2026-10-04 Centralized packaged Codex launcher identity

What happened: the fresh refork's runtime refresh selected the first matching
`Get-StartApps` AUMID and duplicated COM activation, so stable and Preview MSIX
packages could launch the wrong shell. Root cause: launcher identity was not
bound to the selected executable's manifest application. What we did: ported
manifest-specific executable-to-AUMID matching into the existing Codex Desktop
owner, reused that owner from runtime refresh, and retained executable fallback
for standalone installs. Evidence: `cargo test --manifest-path
src-tauri/Cargo.toml codex_desktop --lib` (51 passed), `cargo test
--manifest-path src-tauri/Cargo.toml codex_runtime_refresh --lib` (42 passed, 1
ignored), `cargo check --manifest-path src-tauri/Cargo.toml`, `pnpm typecheck`,
and `git diff --check` passed. `cargo fmt --check` still reports the known
pre-existing formatting differences in `codex_config.rs`, `services/proxy.rs`,
and `services/provider/mod.rs`;
no runtime freshness check was performed. What NOT to do again: do not select
the first Start-menu AUMID when the executable identity is available, and do
not add a second COM launcher owner. Related:
`docs/decisions/2026-10-04-packaged-codex-launcher-port.md`.

## 2026-10-04 Ported shared auto model refresh primitive

What happened: the fresh refork had independent manual model fetch handlers but
no shared cache, request deduplication, or stale-result guard. Root cause: the
legacy fork's reusable `useAutoModelRefresh` utility and its tests were absent
from the new foundation. What we did: ported one shared hook with
credential-scoped fingerprint support, TTL caching, in-flight request
deduplication, invalidation epochs, optional local-storage snapshots, and
non-destructive membership diff reporting. Provider forms remain the owners of
fetch state; no duplicate fetch path was added. Evidence: `pnpm exec vitest run
tests/hooks/useAutoModelRefresh.test.tsx` (4 passed), `pnpm typecheck`, focused
Prettier checks, and `git diff --check` passed. Runtime freshness was not
checked because no rebuilt desktop process was requested. What NOT to do again:
do not copy legacy form integrations wholesale before confirming the fresh
form's state owner, and do not treat an empty model response as proof that all
saved models were removed. Related:
`docs/decisions/2026-10-04-auto-model-refresh-port.md`.

## 2026-10-04 Restored atomic Codex provider switch Desktop lifecycle

What happened: the fresh BigStrongSun refork lacked the legacy explicit Codex
provider action that stops Desktop, switches routing, and relaunches the shell.
Root cause: the fresh foundation had separate provider, takeover, and Desktop
launcher owners but no transaction joining them, and the catalog reconciliation
port also exposed an incomplete shared row identity type. What we did: added a
typed IPC command and API method, verified Desktop process filtering and safe
termination, reused the existing takeover/injection launcher, and added a
lock-held `ProviderService` switch entrypoint so the stop -> mutation -> relaunch
sequence cannot race proxy toggles or reacquire its own mutex. The catalog row
contract now includes shared identity fields and a stable seed type. Evidence:
`cargo check --manifest-path src-tauri/Cargo.toml`; `cargo test
--manifest-path src-tauri/Cargo.toml codex_desktop --lib` (49 passed);
`cargo test --manifest-path src-tauri/Cargo.toml switch_provider_ --test
provider_commands` (4 passed); `pnpm typecheck`; `pnpm exec vitest run
src/lib/codexCatalogReconciliation.test.ts` (3 passed); and `git diff --check`
passed. `cargo fmt --check --manifest-path src-tauri/Cargo.toml` still reports
only pre-existing formatting differences in `codex_config.rs` and
`services/proxy.rs`. Runtime freshness was not checked because no rebuilt
desktop process was requested. What NOT to do again: do not call the normal
lock-taking switch method from inside a lifecycle lock, do not terminate by
process name without verified Desktop identity, and do not duplicate catalog
identity or row-seed contracts. Related:
`docs/decisions/2026-10-04-codex-provider-switch-desktop-lifecycle-port.md`.

## 2026-10-05 Consolidated usage relative-time formatting

What happened: three fresh-refork quota/usage footers each implemented the
same relative-time thresholds. Root cause: the display formatter had no shared
utility owner. What we did: added `utils/usageRelativeTime.ts`, switched
`UsageFooter`, `CopilotQuotaFooter`, and `SubscriptionQuotaFooter` to import it,
and ported boundary tests. Evidence: `pnpm exec vitest run
tests/lib/usageRelativeTime.test.ts` (7 tests), `pnpm typecheck`, Prettier,
and `git diff --check` passed. Runtime freshness was not checked because no
rebuilt desktop process was requested. What NOT to do again: do not duplicate
the `usage.*` threshold logic in another footer; keep session-specific labels
in the session formatter. Related:
`docs/decisions/2026-10-05-usage-relative-time-consolidation.md`.

## 2026-10-05 Extracted Codex Sub-Agent validation diagnostics

What happened: the fresh provider form parsed the Sub-Agent V2 validation code
inline and discarded optional offending-model details. Root cause: the backend
diagnostic boundary had no reusable parser in the refork. What we did: added
the tested parser from the legacy feature, adapted the form to existing
translated incomplete/validation messages, and kept backend validation as the
authority. Evidence: focused parser and `ProviderForm.codexPreset` suites (23
tests), `pnpm typecheck`, Prettier, and `git diff --check` passed. Runtime
freshness was not checked because no rebuilt desktop process was requested.
What NOT to do again: do not move validation into UI parsing or hardcode a
second error-code check in another form. Related:
`docs/decisions/2026-10-05-codex-subagent-error-parser-port.md`.

## 2026-10-05 Consolidated models.dev catalog ownership

What happened: the fresh refork's automatic-sync dialog and manual pricing
picker duplicated the same models.dev query, flattening, provider sorting,
filtering, and visible-row bounds. Root cause: the catalog view contract had no
shared hook, so two dialogs independently owned one cache key and matching
behavior. What we did: added `useModelsDevCatalog` with caller-specific row
limits and an `enabled` gate, then adapted both dialogs while retaining their
selection and persistence ownership. Evidence: `pnpm exec vitest run
tests/components/ModelsDevPickerDialog.test.ts tests/components/ModelsDevAutoSyncPanel.test.tsx
tests/hooks/useModelsDevCatalog.test.tsx` (24 tests), `pnpm typecheck`,
Prettier checks, and `git diff --check` passed. Runtime freshness was not
checked because no rebuilt desktop process was requested. What NOT to do again:
do not copy either dialog wholesale or add another models.dev query/filter
owner. Related: `docs/decisions/2026-10-05-models-dev-catalog-hook-port.md`.

## 2026-10-03 Centralized Codex catalog reconciliation

What happened: the fresh refork's Codex form had an inline merge that matched
only one visible/upstream string and treated every fetched model as appendable.
Root cause: identity aliases and remote metadata had no shared reconciliation
owner, so refreshes could fail to hydrate equivalent rows or create duplicate
inventory. What we did: added a pure identity-aware reconciliation utility and
delegated the existing form merge helper to it; disabled/manual rows remain
user-owned, metadata hydration is conservative, and newly discovered models are
added as disabled inventory. Automatic refresh remains a separate lifecycle
decision. Evidence: `pnpm typecheck`,
`pnpm exec vitest run src/lib/codexCatalogReconciliation.test.ts` (3 tests), and
`git diff --check` passed. Runtime freshness was not checked because no rebuilt
desktop process was requested. What NOT to do again: do not copy the legacy
Codex form or add a second persistence path when the fresh form already owns
state and save behavior. Related:
`docs/decisions/2026-10-03-codex-catalog-reconciliation-port.md`.

## 2026-10-03 Kept official Codex proxy sessions in stable history buckets

What happened: the fresh refork still projected official Codex takeover through
the legacy `cc-switch-official` provider, while the migration target requires
native `openai` history when unified history is disabled and the shared
`custom` bucket when it is enabled. Root cause: route projection and auth-facade
classification assumed every official takeover had a named provider table;
the built-in `openai` route has only a top-level `openai_base_url`. What we did:
made `codex_config` the sole owner of projection/detection/cleanup, removed only
CC Switch-owned legacy residue, adapted service projection for native versus
managed official auth, and taught account-pool reprojection to recognize the
built-in route. Evidence: official-route tests (6), projection tests (2),
account-pool reprojection (1), and takeover false-positive test (1) passed;
`cargo check --manifest-path src-tauri/Cargo.toml`, `pnpm typecheck`, and
`git diff --check` passed. `pnpm format:check` failed only on six pre-existing
provider-form files outside this change. Runtime freshness was not checked
because no rebuilt desktop process was requested. What NOT to do again: do not
restore a second legacy route builder or classify a missing
`[model_providers.openai]` table as managed without checking the top-level route
marker. Related: `docs/decisions/2026-10-03-codex-official-history-bucket-port.md`.

## 2026-10-03 Restored the refork language quick switcher

What happened: the fresh refork had a Settings-page language control but had
lost the legacy header quick switcher, and unknown or missing language values
fell back to Chinese. Root cause: language parsing was duplicated between the
i18n bootstrap and settings form, while the header had no owner in the fresh
shell. What we did: added one shared supported-language parser with English as
the default, adapted the header switcher to the existing settings mutation,
and made optimistic language changes roll back i18n and local storage when the
save fails. Existing Settings ownership remains unchanged. Evidence: focused
language/parser/settings tests passed (17), dependent App and Settings tests
passed (38), `pnpm typecheck`, Prettier checks, and `git diff --check` passed.
Runtime freshness was not checked because no rebuilt desktop process was
requested. What NOT to do again: do not add another language normalization or
independent persistence API beside the shared contract. Related:
`docs/decisions/2026-10-03-language-switcher-port.md`.

## 2026-10-03 Ported the stream retry setting into the refork

What happened: the fresh refork already had bounded Responses stream reconnection, but users could not disable that replay behavior. Root cause: the retry owner existed without the fork's persisted `enable_stream_retry` control. What we did: added the default-on compatibility setting, typed frontend state and all four locale strings, a proxy settings toggle, and a gate around only the existing Responses reconnect factory. Capacity replay and transport retry remain separate. Deliberately did not port legacy aggressive continuation because the fresh architecture has no matching client-session owner. Evidence: focused Rust settings test passed (1), `cargo check`, `cargo fmt --check`, `pnpm typecheck`, frontend Prettier, and `git diff --check` passed. Runtime freshness was not checked because no rebuilt desktop process was requested. What NOT to do again: do not gate unrelated retry policies with this setting or add a second continuation owner. Related: `docs/decisions/2026-10-03-stream-retry-setting-port.md`.

## 2026-10-03 Adapted shared MultiRouter model identities in the refork

What happened: the fresh refork could retain a visible alias in a Provider catalog while refresh, route projection, or picker selection compared only the visible string and treated the upstream model as missing. Root cause: model identity was reconstructed independently at each boundary; canonical slugs and aliases were not part of the matching contract. What we did: added a shared normalized identity helper and adapted refresh deduplication, route catalog projection, fixed-route summaries, alias validation, picker state, and wizard selection matching. Kept fresh ownership, fixed include semantics, and disabled inventory rows. Evidence: `pnpm typecheck`; focused Vitest suites with 104 tests passed; Prettier check; `git diff --check`; `cargo check --manifest-path src-tauri/Cargo.toml`. Runtime freshness was not checked because no rebuilt desktop process was requested. What NOT to do again: do not copy the legacy workspace wholesale or hide identity mismatches by converting explicit include routes to all-model routes. Related: `docs/decisions/2026-10-03-model-identity-port.md`.

## 2026-10-03 Ported Codex traffic admission policy

What happened: adapted the legacy Codex traffic-policy behavior to the fresh refork. Root cause: the fresh architecture had provider routing and request retry ownership, but no bounded per-route admission gate or explicit OpenCode endpoint-unavailable replay policy. What we did: added policy resolution and provider metadata, shared router semaphores with response-lifetime permits, recognized rejection replay in the existing Codex retry loop, typed frontend controls, and all locale keys. Kept generic `503` responses non-retryable and preserved existing capacity retry behavior. Evidence: `cargo check --manifest-path src-tauri/Cargo.toml`; focused Rust tests for `codex_traffic_policy` (3 passed), `codex_rate_limit_retry` (3 passed), and `error_mapper` (9 passed); `pnpm typecheck`; focused Vitest policy tests (2 passed); `git diff --check`. What NOT to do again: do not add a second generic retry system or copy the legacy forwarder wholesale; admission belongs to `ProviderRouter`, and explicit rejection replay belongs in the existing Codex retry function.

## 2026-10-03 Codex grouped credentials adapted to fresh request policy

What happened: the first distinctive legacy feature was ported into the BigStrongSun foundation. Root cause: the fresh foundation has one request-policy owner, while the legacy grouped-key implementation selected credentials across older forwarder paths. What we did: added model-aware grouped credential resolution, fail-closed scoped aliases, pooled selection, persisted frontend group editing, one-time catalog projection, and shared policy compilation for runtime and protocol probes. Evidence: focused Rust grouped-key, route restoration, fingerprint/header, and full-URL retention tests passed; grouped projection and related provider-form frontend tests passed; `pnpm typecheck` and `git diff --check` passed. What NOT to do again: do not copy legacy forwarder/retry orchestration or allow a second credential-selection owner.

## 2026-10-03 Legacy reasoning replay adapted to the fresh request policy

What happened: legacy providers used `reasoningContentMode` to choose DeepSeek-style `reasoning_text` replay or strict summary-only replay. Root cause: the fresh foundation already owned replay through `HistoryReplay`, so copying the legacy forwarder branch would create conflicting request mutation. What we did: added a canonical summary-only replay dialect, translated imported legacy metadata at compatibility resolution, and made canonical saves discard the legacy field. Evidence: 33 request-policy tests passed; 2 focused Rust metadata/resolver tests passed; 12 focused frontend tests passed; `cargo check` and `pnpm typecheck` passed. What NOT to do again: do not restore a separate forwarder-level reasoning mode or let both legacy and canonical settings control one request.

## 2026-10-03 BigStrongSun replacement foundation started

What happened: the user approved replacing the legacy fork foundation with a fresh BigStrongSun refork and adapting distinctive behavior incrementally. Root cause: the legacy branch had diverged across hundreds of files and retained older save/probe ownership, while BigStrongSun now provides provider-set and protocol-lab boundaries. What we did: cloned `BigStrongSun/ccswitchmulti` at `b4741ade`, retained the dirty legacy checkout at `641d53c8` as read-only migration evidence, and recorded a single-owner, deletion-gated port strategy in `docs/decisions/2026-10-03-bigstrongsun-refork-foundation.md`. Evidence: clean-foundation `cargo check` passed, `pnpm install --frozen-lockfile` passed, and `pnpm typecheck` passed. What NOT to do again: do not bulk replay legacy commits or create parallel save/probe orchestration in the fresh foundation.
