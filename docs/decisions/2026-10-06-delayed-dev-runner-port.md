# Delayed Development Runner Port

## Goal

Restore the old checkout's supervised `pnpm dev` lifecycle in
`ccswitchmulti-refork` without launching a direct rebuild from this task.

## Evidence

- The old checkout used `scripts/dev-tauri-delayed.mjs` for `dev`,
  `dev:delayed`, and `dev:immediate`.
- The runner provides immediate Vite HMR, backend content fingerprinting,
  quiet-period rebuild scheduling, verified Windows process-tree cleanup,
  listener-release barriers, normal Cargo-target enforcement, and guarded
  Cargo-target maintenance.
- The refork had only `"dev": "pnpm tauri dev"` and did not contain the runner
  or its maintenance helper.
- The old checked-in default was 2 hours (`7,200,000 ms`); the user explicitly
  requested a 4-hour delay for this refork.
- The old checkout also disables Cargo dev/test incremental artifacts and debug
  symbols (`[profile.dev]` / `[profile.test]` with `incremental = false` and
  `debug = 0`). The refork omitted that block; its target reached 44.39 GB
  before cleanup, and the post-clean target rebuilt to 7.39 GB with
  `debug/deps` at 5.75 GB, `debug/build` at 1.07 GB, and a 0.48 GB PDB.
- The refork's `@tauri-apps/plugin-process` was `2.4.0` while the Rust crate
  resolved to `2.3.1`, causing Tauri startup to reject the dependency tree.

## Decision

1. Port the runner, its node tests, the Cargo-target maintenance helper, and
   its node tests into the refork.
2. Route `pnpm dev` through the delayed runner and expose the old
   `dev:delayed` and `dev:immediate` aliases.
3. Set the refork default backend quiet period to 4 hours
   (`14,400,000 ms`), while retaining the CLI and environment overrides.
4. Port the old Cargo dev/test profile bounds so normal development does not
   accumulate multi-gigabyte debug generations.
5. Align the JS process plugin to `^2.3.1` and update the lockfile to match the
   Rust `2.3.1` crate.
6. Preserve the refork's existing build and release scripts; this change does
   not run or replace a production build.

## Alternatives Rejected

- Keeping `pnpm dev` as direct `pnpm tauri dev`: loses the requested delayed
  rebuild and verified lifecycle.
- Copying the old 2-hour default verbatim: conflicts with the user's explicit
  4-hour requirement.
- Starting `pnpm dev` during implementation: would launch a build/runtime
  process and violate the request not to straight rebuild.

## Ownership And Affected Files

- `package.json`
- `scripts/dev-tauri-delayed.mjs`
- `scripts/dev-tauri-delayed.node-test.mjs`
- `scripts/prune-cargo-target.mjs`
- `scripts/prune-cargo-target.node-test.mjs`
- `src-tauri/Cargo.toml`
- `pnpm-lock.yaml`

## Approval And Status

- Approval: user-requested behavior in the 2026-10-06 conversation; no
  additional approval pause required for this reversible development workflow
  change.
- Implementation: complete on 2026-10-06; profile bounds and dependency
  alignment added after the first refork startup.
- Verification: `cargo metadata` passed; runner syntax checks passed; delayed
  runner and cleanup tests passed (50/50); `git diff --check` passed. Offline
  pnpm lockfile verification was blocked by missing local registry metadata for
  `@vitejs/plugin-react`, not by a reported lock mismatch.
- Runtime freshness: pending. The user must stop the current `pnpm dev`, run
  normal `pnpm install` once to replace the materialized `2.4.0` JS plugin with
  `2.3.1`, then restart `pnpm dev` from
  `H:\repos\ccswitchmulti-refork`.

## 2026-10-06 Follow-Up Verification And Runtime Correction

- Approval and implementation: unchanged. Removed the obsolete one-hour
  comment and formatted only the two owned Cargo-target helper files.
- Verification: the fresh delayed-runner/prune test run passed 50/50 with
  0 failures. Scoped Prettier and diff checks passed. Tests cover the
  four-hour default, quiet-period reset/coalescing, content fingerprints,
  no-watch lifecycle, normal target enforcement, and guarded cleanup.
- Dependency evidence: reading
  `node_modules/@tauri-apps/plugin-process/package.json` now reports `2.3.1`.
  The previous instruction to reinstall for a materialized `2.4.0` plugin is
  superseded; another reinstall is not currently necessary. The earlier
  offline registry-metadata failure is preserved above, not called a pass.
- Runtime freshness: still pending. Stop the existing `pnpm dev` process,
  restart `pnpm dev` from `H:\repos\ccswitchmulti-refork`, and confirm the
  fresh build before runtime verification. This task did not launch a dev
  rebuild, stop the live proxy, clean an active target, or build a release.
- The 5 GB maintenance threshold is a guarded cleanup trigger, not a hard
  guarantee that compiled dependencies can never exceed 5 GB.

## 2026-10-06 Continuation Verification Transition

- Approval, implementation, and runtime freshness: unchanged.
- Verification: a fresh runner/prune run passed 50/50 with zero failures.
  Comparing all four scripts to the old checkout with whitespace ignored
  found only the requested 2-hour-to-4-hour default, matching test assertion,
  and explanatory/help text changes. Both pruning files otherwise match.
- Scoped script and manifest formatting passed. An additional explicit
  Prettier check of `pnpm-lock.yaml` failed; the same check also fails on the
  committed HEAD lockfile, so this generated file was not rewritten for
  unrelated formatting. The repository's `format:check` targets `src/`, not
  the generated lockfile. The earlier offline metadata failure remains
  unresolved evidence, not a claimed install-validation pass.
- No development runner was launched and no active target was cleaned.
  Restart of the user's normal refork `pnpm dev` remains the runtime gate.

## 2026-10-06 Scoped Commit Verification Transition

- Approval and implementation: unchanged; the dev lifecycle remains separate
  from the stream-retry commit.
- Verification: the latest runner/prune tests passed 50/50 with zero failures.
  `cargo check --manifest-path src-tauri/Cargo.toml` exited 0 without warnings;
  `pnpm typecheck` exited 0. Scoped Prettier checks passed for all four scripts,
  `package.json`, and this record. The previous shared fixture typecheck failure
  was superseded by this passing run, not erased from its retry records.
- The earlier offline lockfile-metadata failure and baseline lockfile formatting
  failure remain unresolved; full frontend/backend suites were not run at this
  scoped continuation boundary.
- Runtime freshness: pending the user's normal refork `pnpm dev` restart and
  confirmation. No app process was stopped, active target cleaned, competing
  development runner launched, production artifact built, or commit pushed.
