# Repository Guardrails

This is the repository-specific contract for agent work. `CONTRIBUTING.md`
covers general contribution style, branching, and i18n; do not duplicate those
rules here. A more-specific nested `AGENTS.md` may add constraints for its
subtree, but must not silently weaken these repository invariants.

## Git Remote Ownership

- This checkout belongs to `tngflx/ccswitchmultirouter`. `origin` is the only
  writable named remote; BigStrongSun and other upstream remotes are fetch-only.
  Never repoint `origin` while checking or assimilating upstream work.
- Stay on the user's current branch (`main` by default here). Do not create a
  feature branch/worktree or switch branches unless the user explicitly asks.
- Before any push, run `pnpm git:remotes:check` and verify the intended same-name
  `origin` branch. Use an explicit `git push origin <branch>:<branch>`; do not
  force-push, publish to another remote, or silently change tracking targets.
- Install the local safeguard with `pnpm git:remotes:install` after cloning.
  It pins push defaults/tracking and installs a fail-closed pre-push guard.
  Never bypass it with `--no-verify`, replace existing hooks, or disable it to
  make a push succeed. If another hook setup exists, preserve it and report the
  integration requirement rather than overwriting it.
- `pnpm upstream:check` is read-only with respect to existing remote ownership:
  a mismatching remote must fail, not be silently rewritten. Upstream updates
  do not authorize changing this repository's push destination.

## Change Discipline

- Inspect `git status --short`, the relevant implementation, and existing
  regression tests before changing behavior.
- Preserve unrelated dirty or untracked work. Never use destructive cleanup or
  rollback commands such as `git reset --hard`, `git checkout --`, or broad
  `git clean` unless the user explicitly requests that exact operation.
- Keep a feature's state ownership singular: define one canonical persisted
  representation, derive projections from current canonical state, and update
  every reader, writer, migration, and runtime boundary when the contract
  changes. Do not repair one screen by adding another competing source of
  truth.
- For every bug fix, add a regression test that fails before the fix and passes
  after it. For a contract change, update the affected frontend and backend
  tests explicitly rather than weakening an existing assertion or guard.
- Keep credentials and other secrets out of fixtures, logs, diagnostics, and
  serialized previews. Redact test data when exercising error paths.
- Do not remove, bypass, or weaken an ordinary guard or test to make a change
  pass. If a check cannot run, report the exact command and reason.

## Source-First Verification and Outputs

- Do not run a resource-intensive compile, link, bundle, rebuild, or
  build-producing test without the user's explicit approval in the current
  conversation. This includes native Rust or C++ builds, renderer builds,
  Tauri builds, release builds, and commands that implicitly rebuild a locked
  or stale target. Delegation, an earlier approval for a different command, a
  repository-required check, or an existing watcher does not provide approval.
- Lightweight checks may run without approval when they should finish quickly
  and do not create substantial artifacts. A small isolated compile is allowed
  only when its low resource use and short duration are clear in advance and it
  will not replace or launch a user-owned artifact. Source inspection,
  `git diff --check`, formatting checks, and metadata-only validation are
  examples. If resource use, duration, or artifact impact is uncertain, ask
  the user before running the command and treat it as resource-intensive.
- Investigate the root cause and finish the fix across all affected layers,
  including regressions, before asking the user for an app rebuild. During
  source iteration, use source review, no-emit checks, formatting checks, and
  tests that can run without recompiling.
- Defer checks that compile code until the complete source change is ready.
  The main agent coordinates one final verification pass for the task, using
  the repository's normal commands and existing cache. Reuse valid results
  for unchanged sources and count focused tests covered by a broader run.
  Include these rules in every delegation.
- Request a single user-owned app rebuild once the complete fix is ready for
  live verification. Summarize the checks already passed and the behavior
  that still needs to be verified in the running app.
- Keep ad hoc intermediates, fixtures, and verification logs in one unique
  directory under `%TEMP%` per run. Set output paths explicitly, put requested
  deliverables in their intended location, and remove the run's resolved
  scratch directory on success or failure. Use the normal cache maintenance
  tools for shared caches. Preserve release artifacts, project data, and Codex
  chat and recovery files. Run noninteractive Windows test commands, compilers,
  and background helpers with hidden console windows.
- Keep repository changes limited to the implementation, required regressions,
  and requested deliverables. Use the existing checkout, cache, and output
  locations.

## Resource Usage Regression Tests

- Changes to session collection, request forwarding, or stream inspection must
  preserve deterministic work-count regressions alongside correctness tests.
  Count parsed or scanned bytes, serialization passes, digest computations, and
  retained records where relevant. Use small and large inputs and repeated polls
  or retries so redundant whole-history work fails a test.
- Cover unchanged imported sessions and locally rejected session prefixes without
  full-history replay. Keep recovery tests for appends, replacement, same-size and
  same-timestamp rewrites, and newly available parent history.
- Cover shared request finalization across retries and compressed fallback bodies,
  disabled diagnostics, and streaming delimiters split into tiny fragments.
  Preserve accounting, protocol handling, redaction, and reasoning-effort policy
  while reducing work.
- Run `pnpm performance:verify` in the final pass for these changes. It checks
  deterministic work bounds through scoped library tests without starting
  the application.
  Keep the runner fail-closed when an expected test is absent or skipped; run
  `pnpm performance:test` and `pnpm scripts:check` when changing the runner.
  This is source regression coverage, not a live CPU or memory audit.

## Sub-Agent Delegation and Shared Runtime Ownership

- Builds, desktop runs, release exports, and backend-source rebuilds are
  user-owned operations. Agents and Sub-Agents must not invoke `pnpm build`,
  `pnpm build:renderer`, `pnpm tauri build`, `pnpm tauri dev`, `pnpm dev`,
  `pnpm release:local`, release exports, or backend-source rebuilds. They must
  not add approval flags, wrappers, or gates, or select, redirect, copy,
  replace, or rebuild into alternate Cargo targets, renderer output folders,
  release roots, bundle folders, or installed-app folders. The user chooses
  the target and output folder and runs these operations.
- Apply source changes directly in the current checkout, including when a
  user-started dev watcher is active. Rebuilds scheduled by that watcher may
  proceed under the user's existing dev settings.
- The retired build-confirmation mechanism stays removed. Agents and
  Sub-Agents must not reintroduce a build-confirmation flag, approval module,
  approval-only test, or persisted approval marker in source, scripts, tests,
  documentation, workflows, templates, or session state.
- These guardrails apply to the main agent and every Sub-Agent. Each delegation
  must repeat the applicable repository/user restrictions, assigned files or
  read-only scope, allowed verification, shared-resource owner, and forbidden
  side effects; do not rely on the child receiving the full parent history.
- Delegate bounded source work and scoped tests, not independent ownership of
  the running application, providers, deployment, or release. One main agent
  coordinates shared runtime and artifact lifecycle changes. A child reports
  the need for such a change instead of independently starting another app,
  server, container, deployment, or release build.
- Delegation and parent approval do not create human authorization. Respect
  any requirement for an explicit user request before image/build/tag/pull,
  deployment, installation, restart, cleanup, publishing, or permission changes.
  Routine source compilation and the verification commands required below are
  not authorization to replace an installed app or mutate a live provider.
- Keep selected scope and ownership rules in generated instructions even when
  custom role text is supplied. Describe instruction guidance honestly: it is
  not an OS sandbox, Docker access restriction, or guaranteed tool lock.
  Preserve user-owned host sandbox, approval, and tool configuration.

## Tooling Language Policy

- Repository-owned PowerShell script files (`.ps1`, `.psm1`, `.psd1`,
  case-insensitive) are prohibited. Implement new tooling in Rust or JavaScript;
  do not hide a migrated script in an embedded PowerShell string.
- The installed application's recovery lifecycle remains Rust-owned. Node owns
  development supervision and build/release tooling; legacy scheduled guardians
  may only be inspected or uninstalled, not installed as a second owner.
- Run `pnpm scripts:check` after tooling changes. The guard includes non-ignored
  untracked sources and bundle/workflow entry points. It also runs before renderer
  builds. Do not remove generated dependency launch shims under node_modules.
- Existing inline Windows API probes are not equivalent to migrated script-file
  entry points. Preserve their identity/ownership guards until replaced by a
  tested native Rust boundary; do not claim a zero-PowerShell-process runtime.

## Codex Catalog Authority

Treat these as cross-layer invariants, not UI-only behavior:

- Read catalogs through `readCodexCatalogSettings` in
  `src/lib/codexCatalogSchema.ts`, or `read_catalog`, `read_catalog_mut`, and
  `catalog_models` in `src-tauri/src/codex_multirouter/catalog.rs`. If a new
  reader is needed, extend the shared helper and its guard instead of reading
  persisted fields directly.
- A structurally valid `modelCatalog` is authoritative, including
  `{ models: [] }`. Use `model_catalog` only when the canonical catalog is
  absent or malformed. Never merge or fall back to stale legacy fields when
  the canonical catalog is valid. New writes use only `modelCatalog` and
  remove `model_catalog`.
- Catalog inventory and routable models are different. Preserve excluded rows
  for editing; `enabled: false` models must not enter routes, protocol probes,
  model pickers, or Sub-Agent candidates.
- Schema-v2 routes derive models from their current target provider, never a
  saved router catalog snapshot. `mode: "all"` follows current included rows.
  Explicit include selections remain closed; an emptied include selection must
  not become "follow all".
- Reconcile removed or renamed model references, aliases, candidate
  selections, protocol overrides, and key-group selections at save and runtime
  boundaries. Do not delete unrelated profiles or treat an unloaded provider
  as an empty catalog.
- Refresh failures preserve the last usable catalog. Only a successful,
  complete refresh may disable upstream models that are no longer present.

## Required Verification

Apply the timing and output rules under Source-First Verification and Outputs
to these checks. A scoped or broader Rust test run that covers the required
filters satisfies the corresponding test command.

When changing a catalog, provider form, wizard, routing, protocol probe,
projection, Sub-Agent behavior, or their shared helpers, run all of these:

```text
pnpm typecheck
pnpm catalog:verify
cargo test --manifest-path src-tauri/Cargo.toml --lib codex_multirouter::
pnpm format:check
git diff --check
```

Also run the focused tests for the affected feature. When a change crosses
shared frontend/backend contracts, persistence, projections, or release
behavior, run the broader relevant suite (`pnpm test:unit`, the appropriate
Rust test scope, or both) in addition to the commands above.

When Rust files change, also run:

```text
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

Before a renderer or desktop release, the user runs the repository's release
build path (`pnpm build:renderer` or `pnpm build`) so catalog verification runs
as part of the build. Source checks do not prove that an installed application
was rebuilt, that a release artifact was installed, or that live provider
requests work; report those boundaries explicitly.

## Live Audit Tooling

- For live runtime/CDP/provider audits, use the repository's configured background automation/monitor instead of directly driving the full workspace UI or broad workspace-wide scans.
- Keep live audits scoped to the target app, its configured log directory, and the active provider/session. Do not use Computer Use or whole-workspace searches for routine live diagnostics unless the user explicitly asks for UI automation.
- When a background automation is available, prefer its structured diagnostics and attach the resulting evidence to the current investigation.
- If the configured monitor/tool is unavailable, report that limitation instead
  of substituting UI automation or broad scans. Source inspection and passing
  tests must not be presented as a completed live audit.
