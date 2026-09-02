# 2026-09-03 Upstream cherry-pick audit

## Scope

Refreshed and audited:

- `BigStrongSun/ccswitchmulti` main through `aab9dd685` (`v3.19.2-25`)
- open BigStrongSun pull requests, including #75, #85, #69, #70, and #61
- `farion1231/cc-switch` main through `c58a25b2a`

The primary checkout gained concurrent uncommitted changes during the audit, including
`src-tauri/src/protocol_compatibility/runner.rs`. Integration was therefore performed
and verified in the separate worktree branch
`codex/upstream-integration-2026-09-03`.

## Integrated

| Local commit | Source | Verdict |
|---|---|---|
| `90867d59b` | BigStrongSun `cc7a7b176` | Cherry-picked with one audited conflict. Preserved this fork's normalized model identity filtering and `modelDisplayStyle`, while adding old alias -> upstream identity -> rebuilt alias rekeying for Sub-Agent V2 profiles and spawn candidates. |
| `9bf3a5a99` | BigStrongSun `b493737b1` | Manually adapted because the source parent included a newer, unrelated probe rewrite. Responses tool extraction now ignores in-progress `response.output_item.added` items and uses only terminal `response.completed.response.output` or `response.output_item.done`. |
| `6bc7f02ae` | original `b1250dc7a` | Cherry-picked cleanly. Hermes latest-version detection now prefers GitHub Releases, rejects calendar tags as semantic versions, uses bounded request timeouts, and keeps PyPI only as a conservative fallback. |
| `9633e8e10` | original `e4b03a38c` | Manually adapted to this fork's newer rollout filename parser. Physical rollout IDs remain in request dedup keys, while imported usage now stores the stable root thread ID as `session_id`. |

## Already applied or superseded

- BigStrongSun `cc52141a8` schema-v2 route sanitization was already present under
  local commits `3739b8927` and `b7bef632c`, with broader persistence and migration
  tests.
- BigStrongSun PR #69/#61 plugin registration repair is already present in
  `services/codex_plugin_registry.rs` and its command/UI integrations.
- BigStrongSun PR #70 active profile synchronization is already present through
  `sync_active_profile_provider_snapshot`.
- BigStrongSun `2f351b487` clean takeover recovery was previously adapted and recorded
  in the August 30 journal entry.
- Original `d8065cc62` mid-conversation system-message preservation is already present
  in `proxy/providers/transform.rs`.

## Deferred

- BigStrongSun PR #85 is superseded by safer mainline commit `e3927dba2`, but that
  ownership-ledger feature spans 19 files and overlaps active settings/i18n work.
  It needs a dedicated batch.
- BigStrongSun PR #75 model hide/restore is useful, but its direct pick conflicts with
  this fork's newer display-style controls, sorting modes, protocol warnings, and model
  ordering tests. Its user-facing strings are also Chinese-only. Port it as a localized
  feature against the current workspace rather than resolving either side wholesale.
- Original xAI native Responses commits `b7da894b3` through `054673e0b` form a dependent
  series and overlap this fork's independently expanded xAI sanitizer. Audit and port
  invariants as a unit; do not cherry-pick the terminal integer guard alone.
- Original preset, pricing, Pi, and broad UI/a11y commits were not mixed into this
  focused correctness batch.

## Verification

Passed:

- `cargo check --manifest-path src-tauri/Cargo.toml`
- `pnpm typecheck`
- `pnpm exec vitest run src/lib/codexMultiRouterWizard.test.ts --maxWorkers=1 --minWorkers=1`
  - 8 passed
- focused protocol terminal-item regression
  - 1 passed
- focused Hermes GitHub release parser tests
  - 3 passed
- focused Hermes fallback test
  - 1 passed
- focused resumed-rollout identity test
  - 1 passed
- `git diff --check 50e966b1b..HEAD`

Final suite results:

- `pnpm test:unit`: 160 files passed, 1 failed; 1,352 tests passed, 1 failed.
  The failure is the unchanged baseline
  `tests/components/ProviderPresetSelector.test.tsx` placeholder assertion; the primary
  checkout already contains an uncommitted correction.
- `cargo test --manifest-path src-tauri/Cargo.toml`: 3,670 passed, 4 failed, 6 ignored.
  The four failures are unchanged baseline tests in `codex_config.rs`,
  `proxy/providers/codex_reasoning.rs`, and `services/proxy.rs`; none of the integration
  commits touches those files.
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` failed on pre-existing
  formatting in `protocol_compatibility/provider.rs`, `protocol_compatibility/runner.rs`,
  and `proxy/forwarder.rs`. Unrelated formatting was not rewritten.

## Do not repeat

- Do not land these commits into a moving dirty checkout without coordinating the
  overlapping `runner.rs` edit.
- Do not cherry-pick PR #75 or the xAI series wholesale across this fork's newer
  routing and protocol ownership boundaries.
- Do not report the batch as fully green while the exact baseline suite failures above
  remain.
