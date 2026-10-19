# BigStrongSun functional and UI parity review, 2026-10-19

## Scope and repository evidence

This is a fresh review of the configured `upstream` remote,
`BigStrongSun/ccswitchmulti`, against this checkout. The review uses the current
working tree, not only committed HEAD. The 57 dirty/untracked status entries
present before this review were preserved. No application source, fixtures,
package manifest, lockfile, or existing audit was changed by this review.

Evidence collected on October 19, 2026 (Asia/Singapore):

- `git fetch upstream --prune` completed successfully.
- `git ls-remote upstream refs/heads/main` independently returned
  `8e92a7d12341a3a426e1f80fcb5d9d8adb51855a`.
- Local HEAD is `aaa90fb0c`; the merge base is `b4741adea`.
- `git log HEAD..upstream/main` contains exactly two commits, below.
- `git diff b4741ade..upstream/main -- src` is empty: neither post-fork
  upstream commit changes the application frontend.

Git author/committer dates for the two upstream commits are October 15 in
UTC+01:00; both are October 16 in the user's Asia/Singapore timezone.

## Port decision

| Upstream change                                                                           | Current-tree evidence                                                                                                                                                                                         | Decision                                                                                |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `6bab67468`: bounded retry of native Codex streaming Responses disconnects before headers | `src-tauri/src/proxy/forwarder.rs` has the scoped predicate, opt-in retry parameter, transformed/raw request callsites, and upstream regressions. It also covers the fork's Responses-Lite fallback callsite. | Already ported. Do not apply the same patch again or replace the forwarder.             |
| `6bab67468`: release metadata and release note                                            | Frontend package, Rust package, lockfile package entry, and Tauri application version are `3.20.4-3`; the release note has no diff against upstream.                                                          | Already present. This does not demonstrate a rebuilt or installed desktop application.  |
| `8e92a7d12`: upstream publication memory                                                  | Only `memory-2026-10-16-v3.20.4-3-ccswitchmulti-release.md` changes.                                                                                                                                          | Do not copy upstream publication claims into this fork. No executable behavior to port. |

The retry remains opt-in for native Codex streaming Responses endpoints; Chat
Completions, image requests, non-streaming requests, and other applications do
not gain `ResponsePending` replay. Pre-header retry does not establish whether
the upstream processed the earlier request. It is bounded, not a guarantee of
exactly-once delivery. Post-header behavior remains separate.

The two upstream commits are not ancestors of local HEAD because the functional
change was adapted into the fork rather than merged verbatim. A commit-count
comparison alone therefore overstates the outstanding port work. The existing
October 17 integration audit records the earlier port; this review independently
rechecked the implementation and current tests.

## UI review

No new UI patch exists in the post-fork upstream range. Recent upstream UI fixes
were checked separately rather than assuming every local difference is a missing
upstream feature. All seven commits listed below are ancestors of local HEAD.
The inspected controls and regression assertions remain in the working tree.

| Upstream UI commits                   | Preserved behavior and evidence                                                                                                                                                                                      |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `d219f9692`, `15280eada`, `e056d60a8` | Explicit official-model-catalog refresh and accurate applied/no-op/failure feedback in `src/components/codex/CodexRouterWorkspacePage.tsx`; regressions in the adjacent test file.                                   |
| `1b2b20c6a`, `c98d28a73`              | Invalid drafts fail closed; save errors preserve the draft and distinguish pre-submit rejection from an unconfirmed backend save. Add/Edit cancellation and provider-form behavior remain covered by existing tests. |
| `212cadcf5`                           | Paginated-history provider payload preservation is described as a compatibility behavior rather than an overall failure in `CodexHistoryRepairPanel`, with regression coverage.                                      |
| `5922f4871`                           | The editor preserves database-only third-party credentials when live auth is empty while retaining official logout semantics; both cases are asserted in `tests/components/EditProviderDialog.test.tsx`.             |

Replacing whole frontend files with upstream copies would remove intentional
fork additions, including Request Health/plugin diagnostics, language switching,
stream-retry activity controls, routing/orchestration preferences, and canonical
catalog safeguards. Those were left intact. This is a review of source and tested
UI behavior, not a claim that the entire fork is pixel-identical to upstream.

## Newer unmerged branches

The only upstream branch tips newer than main in the fetched inventory are
Dependabot proposals dated October 18, 2026:

- `c4adc58a6`: frontend dependency group, 56 updates; only `package.json` and
  `pnpm-lock.yaml` differ from main.
- `52d4ebd7d`: Cargo dependency group, 37 updates; only `src-tauri/Cargo.toml`
  and `src-tauri/Cargo.lock` differ from main.

Neither branch contains application UI changes. They were intentionally not
ported as part of a minimal-risk mainline parity review. Their broad dependency
changes need a separate compatibility review against this fork's existing pins.

## Fresh verification

All commands below passed against the current working tree on October 19, 2026.

| Command                                                                                                       | Result                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                                                                                              | Passed.                                                                                                                                 |
| `pnpm catalog:verify`                                                                                         | Passed: reader guard, 23 reader regressions, 6 discovery/config regressions, and 470 catalog tests across 15 files.                     |
| `pnpm test:unit --maxWorkers=2 --minWorkers=1`                                                                | Passed: 2,458 tests across 260 files, including the reviewed editor, save-feedback, history-repair, and catalog-refresh UI regressions. |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib proxy::forwarder::tests:: -- --test-threads=4 --quiet` | Passed: 202 tests, including native Responses retry scoping and opt-in/out recovery regressions.                                        |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib codex_multirouter:: -- --test-threads=4 --quiet`       | Passed: 153 tests.                                                                                                                      |
| `pnpm format:check`                                                                                           | Passed.                                                                                                                                 |
| `cargo fmt --check --manifest-path src-tauri/Cargo.toml`                                                      | Passed.                                                                                                                                 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`                                            | Passed.                                                                                                                                 |
| `git diff --check`                                                                                            | Passed.                                                                                                                                 |
| `pnpm exec prettier --check docs/audits/2026-10-19-bigstrongsun-parity-review.md`                             | Passed after formatting this new audit only.                                                                                            |

Catalog verification and the full frontend suite overlap; the counts above must
not be summed as unique coverage. Test runs emitted non-fatal React `act`, Node
localStorage, and Rust test-compilation warnings; strict production Clippy passed.
No assertion, timeout, guard, or build gate was changed to obtain these results.

## Boundaries

No merge, cherry-pick, dependency upgrade, commit, push, renderer/desktop build, or installation was
performed. No source edit was needed for the reviewed upstream mainline range.
This audit is the only new tracked-scope file created by this review.

No live provider/CDP audit or visual desktop comparison was attempted. A source
review and passing isolated tests do not prove live requests, pixel parity, or
which desktop binary is installed. The repository's configured background audit
tooling must be used for any future live validation; this review did not replace
it with UI automation.
