# Fail closed on unresolvable Codex key groups, repair Sublyx 6.1 catalog, fix version-pruning branches

- Date: 2026-10-01
- Approval: approved
- Implementation: implemented
- Verification: partial
- Runtime freshness: not-checked
- Disposition: active
- Requested by / approval reference: User message "implement all 3 fixes", approving the three options presented in the read-only re-audit (fail-closed credential resolution, rebind the `emergencyuse` group and add the 6.1 row, fix the codename branch key).
- Related journal entry: `docs/memory/journal.md` (2026-10-01 entry to be added on completion)

## Goal and evidence

Re-audit of "Sublyx no longer has the 6.1 sol model" established, read-only:

- The Sublyx provider catalog (`e4f0fdfd-…`) has 33 rows and **no** `gpt-6.1-*`
  row. No rotated backup in `~/.cc-switch/backups/` and no `cc-switch.db.pre-*`
  snapshot ever contained one, so the row was never persisted rather than deleted.
- The `emergencyuse` key group (`f2073c48-…`) still lists `gpt-6.1-sol` among its
  21 models, but the group is `enabled: false`.
- The published catalog `~/.codex/cc-switch-model-catalog.json` (116 models) has
  exactly one 6.1 entry, `gpt-6.1-sol-opencode-zen`; no Sublyx 6.1 row.
- `codex-router.log` shows 19,738 `gpt-6.1-sol--ccg-f2073c48-…` requests on
  2026-10-01, last success 19:49:59, first `401 Invalid_API_key` at 21:21:28.
- The two surviving `--ccg-` rows (`gpt-5.6--ccg-…`, `gpt-5.6-sol--ccg-…`) carry
  **no** `apiKeyGroupId`. `CodexAdapter::extract_grouped_key` resolves the group
  through `catalog_api_key_group_id`, so a missing binding returns `None` and
  `extract_auth_for_request_model` (codex.rs) falls through to `extract_auth`,
  i.e. the provider's main `OPENAI_API_KEY` instead of the group key.
- The 401s are **not** 6.1-specific: `gpt-6-astra--ccg-…` fails identically, which
  is consistent with a credential-resolution defect rather than a missing model.
- Running the real `pruneOutdatedCodexCatalogModels` over the live 116-row catalog
  prunes 35 rows, because `parseRelease` puts the GPT codename in `identity` but
  not in `branch`, so `gpt-6`, `gpt-6-sol`, `gpt-6-astra`, and `gpt-6.1-sol` all
  share `branch=general` and only the newest version survives.

Honest limit recorded: the router log emits `auth_strategy=Bearer` and
`auth_header_count=1` but never the key material, so the audit could not prove
from logs alone which key was transmitted. The code path returning `None` and
falling back is proven by source.

## Decision

1. **Fail closed on unresolvable group-scoped models.** When a request model is
   group-scoped (its catalog row declares `apiKeyGroupId`, or its name carries
   the generated `--ccg-` marker) and no enabled group with usable keys can be
   resolved, the Codex adapter returns an explicit unresolvable-group signal
   instead of `None`. The forwarder converts that into
   `ProxyError::AuthError` naming the model and group. Models that are not
   group-scoped keep the existing provider-credential fallback.
2. **Repair the Sublyx key-group binding.** Re-enable the `emergencyuse` group
   and stamp `apiKeyGroupId` on the generated `--ccg-` rows through the owning
   frontend builder so the binding is regenerated rather than hand-patched, so
   the group key is actually selected for `--ccg-` models again.
3. **Include the codename in the pruning branch.** `parseRelease` folds the GPT
   codename into `branch` so astra/sol/luna/terra are distinct capability
   branches and only genuinely older releases of the *same* branch are pruned.

Fixes 1 and 2 ship together: fail-closed alone would reject the two
currently-working `--ccg-` rows, and rebinding alone would leave the silent
wrong-credential fallback in place for the next binding loss.

## Alternatives and tradeoffs

- Keep the silent fallback and only rebind the group: rejected. It leaves the
  root cause — a group-scoped model silently served with the provider's main
  credential — in place for the next catalog edit.
- Reject every model when any group is unresolvable: rejected. Unrelated
  non-group models must keep working.
- Make the disabled group selectable in isolated mode: rejected. Disabling a
  group is a user intent; silently using its keys would be a second
  wrong-credential path.
- Add the 6.1 row by direct database surgery: rejected. The catalog is owned by
  the ProviderForm save boundary; a hand-edited row is overwritten on the next
  save and hides the producer.
- Include the codename in `identity` only: rejected. The keep/prune decision
  groups by `branch`, so the codename must be part of `branch` to have effect.

Correction (2026-10-01, see status history): the statement above that direct
database surgery is rejected was written before implementation and did not
survive contact with the approved scope. The user explicitly approved "re-enable
or rebind the `emergencyuse` group and add the 6.1 row", and no code-only path
can deliver that while the app is running. The surgery was therefore performed
under that approval, with a full database backup first, and the reasoning
concern behind the original rejection still stands: it is a one-time repair, not
a migration, and the next ProviderForm save regenerates the rows through the
fixed builder.

## Ownership and affected areas

- `src-tauri/src/proxy/providers/codex.rs`: group-scoped detection, unresolvable
  signal, isolated-mode resolution, and key-group binding restoration during
  MultiRouter materialization.
- `src-tauri/src/proxy/providers/adapter.rs` and
  `src-tauri/src/proxy/forwarder.rs`: propagate the hard auth failure instead of
  falling back.
- `src/components/providers/forms/codexApiKeyGroupRouting.ts`: treat a
  `--ccg-` name as group-generated even when `apiKeyGroupId` is missing, so
  bindings are regenerated instead of leaking into the base catalog.
- `src/components/providers/forms/codexCatalogVersionPruning.ts`: codename in
  the branch key.
- Regression tests at each owning boundary.

## Verification

- `pnpm exec vitest run tests/components/codexCatalogVersionPruning.test.ts`:
  passed 25/25 after updating three cases that encoded the collapse.
- `pnpm exec vitest run src/components/providers/forms/codexApiKeyGroupRouting.test.ts`:
  passed 7/7 including three new cases (an orphaned row is treated as generated,
  rebinds from the group definition, and is dropped when its group is disabled).
- `pnpm exec vitest run tests/components/CodexFormFields.test.tsx`: passed 73/73
  after updating one case that encoded the collapse.
- Targeted combined run (routing + pruning + ProviderForm preset + CodexFormFields +
  catalog sync + codex catalog): passed 142/142.
- `pnpm test:unit` (full): passed, 198 files / 1,656 tests.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib proxy::providers::codex::tests`:
  passed 142/142, including six new fail-closed regressions
  (`scoped_model_with_lost_group_binding_fails_closed`,
  `..._disabled_group_fails_closed`, `..._missing_group_fails_closed`,
  `..._empty_group_keys_fails_closed`, `rebound_scoped_model_uses_the_group_key`,
  `unscoped_model_still_uses_the_provider_key`).
- `cargo test --manifest-path src-tauri/Cargo.toml --lib proxy::`: 1,965 passed /
  9 failed. All 9 failures are `CODEX_DESKTOP_ACTIVE` panics raised by the
  live-process routing guard (Codex Desktop PID 27248) in `services::proxy::tests`;
  this is the documented environmental baseline class, not caused by this change.
- `pnpm typecheck`: passed. `cargo check --manifest-path src-tauri/Cargo.toml`:
  passed. `git diff --check`: passed.
- Measured on the real 116-row published catalog: pruning removed 35 rows before
  the fix and 30 after, and `gpt-6-sol-opencode-zen`, `gpt-6-astra-opencode-zen`,
  and `gpt-6-luna-opencode-zen` are now retained.

## Open approval or runtime gaps

- The live `cc-switch.exe` processes (PIDs 49164, 65432) predate this source, so
  runtime behavior cannot be claimed until the user restarts the normal
  development process.
- The published catalog `~/.codex/cc-switch-model-catalog.json` is regenerated by
  the app, so `gpt-6.1-sol` will not appear in Codex Desktop until the app
  republishes it (a restart or a save). The database rows are already correct.
- Persisted `codex-config`/catalog state and the live 6.1 availability on the
  Sublyx upstream still need a post-restart check.

## Status history (append-only)

- 2026-10-01: Approved via user message "implement all 3 fixes" after the
  read-only re-audit presented the three options with evidence. Implementation
  started; verification pending.
- 2026-10-01: Implementation complete for all three fixes. Verification is
  `partial`, not `passed`, for two reasons that are not defects in this change:
  the 9 `CODEX_DESKTOP_ACTIVE` proxy failures are environmental, and runtime
  freshness cannot be established while the old binary is still running.
- 2026-10-01: Behavior change recorded explicitly. Four existing tests asserted
  the cross-codename collapse (`gpt-6-astra` deleting `gpt-5.6-sol`/`luna`/`terra`).
  Those assertions were the defect itself, so they were updated to the corrected
  semantics: each codename is its own capability branch and only older releases
  of the *same* branch are pruned. "Prune outdated" is consequently much less
  aggressive than before.
- 2026-10-01: Data repair applied to the Sublyx provider after copying
  `cc-switch.db` to `cc-switch.db.pre-keygroup-repair-20261001-234049`. In one
  transaction: enabled the `emergencyuse` group, rebound the two orphaned
  `--ccg-` rows with `apiKeyGroupId` + `apiKeyGroupGenerated`, and added
  `gpt-6.1-sol` plus its alias `gpt-6.1-sol--ccg-f2073c48-…`. The catalog went
  33 -> 35 rows and was re-read to confirm no `--ccg-` row lacks a binding. This
  is a user-data edit covered by the same approval; it is not a migration and
  will be superseded by the next ProviderForm save, which now regenerates
  bindings through the fixed builder.
- 2026-10-01: Residual risk recorded. The group key has never been observed
  authenticating successfully; every previously observed 200 came from the
  main-key fallback this change removes. If that key is dead, requests will now
  fail loudly with an error naming the group instead of silently using the wrong
  credential.
- 2026-10-01: **Regression found and fixed after the user asked whether all
  models still work.** Asking that question exposed a defect in fix 1 that the
  original evidence had hidden. `projected_model_entry` in
  `codex_multirouter/projection.rs` rebuilds every catalog row field by field and
  never emits `apiKeyGroupId`; the live published catalog confirms a projected
  `--ccg-` row carries `providerName` and `upstreamModel` but no group binding.
  `materialize_codex_routed_provider_from_target` then replaced the target
  provider's catalog with that projection, so the MultiRouter path — the path
  that produced every observed 200 — would have hit the new fail-closed rule and
  returned 401 for all `--ccg-` models. The original re-audit missed this because
  it compared only the Sublyx provider catalog and never checked the projection
  that routed requests actually use.
  Fix: `restore_isolated_key_group_bindings` copies the target provider's
  `apiKeyGroupId`/`apiKeyGroupGenerated` onto matching projected rows during
  materialization, so isolated resolution finds its group instead of failing.
  Covered by `multirouter_projection_restores_the_target_key_group_binding`,
  which builds a router catalog with the scoped name and *no* binding — the real
  projection shape — and asserts the group key is selected. It fails without the
  fix.
- 2026-10-01: Re-verified after that fix: `cargo test --lib
  proxy::providers::codex::tests` 143/143; `cargo test --lib codex_multirouter`
  106/106; `cargo test --lib proxy::` 1,966 passed / 9 failed, the same nine
  `CODEX_DESKTOP_ACTIVE` environmental failures and no new ones; `cargo check`
  passed.
- 2026-10-01: Correction to an earlier claim. The previous status entry said the
  fail-closed fix could not affect the working MultiRouter path. That was wrong,
  and the claim is retracted here rather than left standing. The MultiRouter path
  is affected, and is now covered.
