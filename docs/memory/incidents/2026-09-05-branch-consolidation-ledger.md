# 2026-09-05 — Branch consolidation ledger (single-branch `main`)

**What happened:** User directed that the repository carry exactly one branch: `main`.
All other local branches, fork-side remote branches, duplicate remotes, and stale
worktrees were removed. This file records every deleted tip SHA **before** deletion
so nothing is unrecoverable.

**Recoverability:** local reflog keeps every tip ≥90 days; GitHub can restore a
deleted branch short-term (restore via API/UI) if it had an associated PR. The
`original` (farion1231/cc-switch) and `upstream` (BigStrongSun/ccswitchmulti)
remotes are read-only third-party repos — their branches were never ours to delete;
their fetch refspecs were narrowed to `main` only so their branches stop mirroring
into `git branch -a`.

## Deleted local branches

| Branch | Tip SHA | Why safe to delete |
|---|---|---|
| `codex/integrated-fixes-2026-09-01` | `2ebc22694` | Only unique commit is `sdfa` (AGENTS.md-only scratch, +33/−8). Its base `0be342e92` is an ancestor of origin/main. |
| `codex/pre-consolidation-backup` | `680a09a37` | Documented backup (journal ~line 308) from the squash→16-commit rewrite; rewrite was verified byte-identical and pushed as `da53d93c`. Content lives in main. |
| `codex/upstream-integration-2026-09-03` | `63c25e7a9` | Its 5 unmerged commits were cherry-picked onto origin/main first (see below), then verified. |

## Deleted fork remote branches (origin = tngflx/ccswitchmultirouter)

| Branch | Tip SHA | Why safe to delete |
|---|---|---|
| `codex/integrated-fixes-2026-09-01` | `0be342e92` | Fully merged into origin/main. |
| `codex/sublyx-responses-review-20260902` | `125f971b6` | Stale pre-consolidation history line (diverged ~601k lines); superseded by rewritten main. Tip recorded here as insurance. |
| `dependabot/cargo/src-tauri/cargo-deps-4551006812` | `e08d016c0` | Dependabot-generated dependency PR branch. |
| `dependabot/cargo/src-tauri/cargo-deps-8df82cb881` | `b19473f3e` | Dependabot-generated dependency PR branch. |
| `dependabot/cargo/src-tauri/cargo-deps-a0d2cb1e20` | `3913ccab9` | Dependabot-generated dependency PR branch. |
| `dependabot/npm_and_yarn/frontend-deps-8adff5d522` | `bc58ea5c0` | Dependabot-generated dependency PR branch. |
| `dependabot/npm_and_yarn/frontend-deps-b471f83d5e` | `4b5aec642` | Dependabot-generated dependency PR branch. |

## Removed remotes

| Remote | URL | Note |
|---|---|---|
| `multirouter` | https://github.com/tngflx/ccswitchmultirouter.git | Byte-identical duplicate of `origin`; stale refs only (multirouter/main @ `719b2d24b`). No script/CI references found. |

## Removed worktrees

| Worktree | State | Note |
|---|---|---|
| `H:/repos/ccswitchmulti-release-verify-20260829` | clean, detached @ `19e2800fa` | Commit contained in main; stale release verification dir. |
| `H:/repos/ccswitchmulti-upstream-20260903` | directory already gone | `git worktree prune` removed stale registration (held `codex/upstream-integration-2026-09-03`). |

## Preserved work (cherry-picked onto origin/main)

The 5 commits from `codex/upstream-integration-2026-09-03`, cherry-picked onto
origin/main `2ae19e4d3` in a detached temp worktree and pushed:

- [x] `90867d59b` → `31e63ea55` fix(wizard): rekey sub-agent profiles after model alias changes
- [x] `9bf3a5a99` → `016f7ceeb` fix(protocol): wait for terminal Responses tool items
- [x] `6bc7f02ae` → `a83655279` fix(tools): read Hermes latest version from GitHub Releases instead of PyPI
- [x] `9633e8e10` → `04c50fdeb` fix(usage): attach resumed Codex usage to the root thread
- [x] `63c25e7a9` → `87306b2ef` docs(memory): record September upstream integration audit (journal conflict resolved by re-inserting the audit entry in chronological position; incident doc brought over as new file)

**Verification evidence (temp worktree @ `87306b2ef`):**

- `cargo check --manifest-path src-tauri/Cargo.toml` → exit 0 (1m21s)
- `cargo test --manifest-path src-tauri/Cargo.toml --lib -- protocol_compatibility session_usage hermes` → **250 passed, 0 failed, 1 ignored**
- `pnpm exec vitest run src/lib/codexMultiRouterWizard.test.ts` → **8/8 passed**
- `pnpm typecheck` (`tsc --noEmit`) → exit 0

**What NOT to do again:** do not let scratch commits (`sdfa`) and pre-rewrite backup
branches accumulate; record tip SHAs in this ledger before any deletion; do not add a
second remote for the same URL.
