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
- Do not remove, bypass, or weaken a guard, test, or build gate to make a
  change pass. If a check cannot run, report the exact command and reason.

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

Before a renderer or desktop release, use the repository's gated build path
(`pnpm build:renderer` or `pnpm build`) so catalog verification runs as part of
the build. Source checks do not prove that an installed application was
rebuilt, that a release artifact was installed, or that live provider
requests work; report those boundaries explicitly.

## Live Audit Tooling

- For live runtime/CDP/provider audits, use the repository's configured background automation/monitor instead of directly driving the full workspace UI or broad workspace-wide scans.
- Keep live audits scoped to the target app, its configured log directory, and the active provider/session. Do not use Computer Use or whole-workspace searches for routine live diagnostics unless the user explicitly asks for UI automation.
- When a background automation is available, prefer its structured diagnostics and attach the resulting evidence to the current investigation.
- If the configured monitor/tool is unavailable, report that limitation instead
  of substituting UI automation or broad scans. Source inspection and passing
  tests must not be presented as a completed live audit.
