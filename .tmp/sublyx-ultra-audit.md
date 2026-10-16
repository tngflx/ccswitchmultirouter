# Sublyx Ultra Audit

Audit date: October 16, 2026.

## Findings

The configured Sublyx model inventory request returned HTTP 200. Entries
contained identity/display fields only: `created`, `display_name`, `id`,
`object`, `owned_by`, and `type`. They did not declare reasoning levels.
This response cannot establish that an Ultra capability was removed.

All seven included Sublyx models agree across the managed catalog, models
cache, running local router's raw catalog, and a fresh read-only `model/list`
call to the installed Codex executable.

| Model | Highest Catalog/RPC Level |
| --- | --- |
| gpt-6.1-sol-sublyx | ultra |
| gpt-6-astra-sublyx | ultra |
| gpt-6-sol-sublyx | ultra |
| gpt-5.6-sol-sublyx | ultra |
| gpt-5.6-terra-sublyx | ultra |
| gpt-6-luna-sublyx | max |
| gpt-5.6-luna-sublyx | max |

The configured current model was `gpt-6.1-sol-sublyx`, and the active router
used Sub-Agent V2. Both snake_case and Desktop camelCase catalog fields
included Ultra for the five listed models.

## Evidence

- `sublyx-reasoning-audit.jsonlog`: allowlisted upstream inventory metadata.
- `sublyx-local-catalog-audit.json`: saved models and local projection.
- `sublyx-picker-rpc-audit.jsonlog`: installed Codex executable's model list.
- Cross-surface comparison: seven models, zero mismatches.

## Boundaries

The initial audit made no inference requests, deep protocol probes, production
source edits, provider database changes, application restart, or installation.
The already-open Desktop window's in-memory picker state was not inspected.
The subsequent screenshots establish that the visible slider still stopped at
Extra High. The catalog/RPC results above did not validate that renderer.

## Renderer Root Cause And Source Fix

Read-only static inspection of the installed package
`OpenAI.Codex_26.1007.9446.0_x64__2p2nqsd0c76g0` found:

- The `enabled-reasoning-efforts` default omits `max`.
- The model-list selection also removes `ultra` unless the separate
  `1186680773` feature flag permits it.
- This filtering happens after the app-server model-list response, explaining
  why correct catalog/RPC metadata can still produce a four-stop slider.

The source compatibility bridge now reprojects reasoning efforts from the
current managed catalog after this renderer selection. It is restricted to
local model queries for the current custom provider and rows already admitted
by the original selector. Official, remote, Copilot, excluded, and unrelated
rows are not granted additional capabilities. It does not change global
settings, feature flags, raw query data, or upstream reasoning wire mappings.

Regression coverage includes cached QueryObserver results, optimistic
re-renders, replaced selectors, new observers, catalog capability changes,
unknown capabilities, and host/provider scoping.

The configured live monitor is unavailable. This is a static-source diagnosis
and regression-tested source fix, not a completed live renderer audit.
The running Desktop window has not been updated, restarted, or reinjected.

## Verification

- `pnpm typecheck`: passed.
- `pnpm catalog:verify`: passed, 366 catalog tests plus the reader guard.
- `pnpm test:unit --maxWorkers=4 --minWorkers=1`: 252 files, 2,268 tests passed.
  An initial unrestricted run hit three failures under concurrent load; all
  passed on focused rerun and on the bounded full run without assertion changes.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib codex_multirouter::`:
  130 passed.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib codex_desktop::`:
  73 passed. All picker tests also passed in the subsequent broader Rust run.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib reasoning_capabilities::`:
  29 passed.
- `pnpm format:check`, focused test-file Prettier checking,
  `cargo fmt --check --manifest-path src-tauri/Cargo.toml`,
  `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`, and
  `git diff --check`: passed.

All Rust tests used the isolated `CC_SWITCH_TEST_HOME`.

The broader command
`cargo test --manifest-path src-tauri/Cargo.toml --lib codex_` was not clean:
1,782 passed, two failed, four ignored. These failures are outside the new
picker projection:

- `codex_config::tests::openrouter_catalog_uses_platform_specific_reasoning_library_entries`
  also fails when run alone. The current library returns `xhigh, high`; the
  assertion expects `max, high, low`. No library data or assertion was changed
  for this picker fix.
- `commands::provider::universal_codex_protocol_preflight_tests::universal_projection_failure_reports_committed_warning_without_rolling_back_data`
  failed with a different projection error code in the broad run, but passed
  unchanged when run alone.

No renderer or desktop release artifact was built or installed.
