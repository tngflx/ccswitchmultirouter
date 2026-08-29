# Release cleanup session

- session_id: rerelease-english-docx-purge-2026-08-29
- owner: current Codex task `Rerelease with English notes`
- started: 2026-08-29 Asia/Singapore
- owned_paths:
  - `docs/list of stupid bugs.docx`
  - `.git/refs/heads/main` (latest-commit rewrite only)
  - release tag/ref for the current GitHub release
  - GitHub release metadata/assets for the same version
  - `docs/coordination/active/rerelease-english-docx-purge-2026-08-29.md`
- watch_paths:
  - all currently dirty frontend/i18n files
  - `docs/memory/journal.md`
- out_of_scope:
  - `src/App.tsx`
  - `src/components/codex/CodexRouterWorkspacePage.test.ts`
  - `src/components/codex/CodexRouterWorkspacePage.tsx`
  - `src/components/providers/forms/CodexFormFields.tsx`
  - `src/i18n/locales/*.json`
  - `tests/components/CodexFormFields.test.tsx`
  - pre-existing edits in `docs/memory/journal.md`
- long_running_commands: none
- note: Release/history operations must preserve all unrelated uncommitted work byte-for-byte.

- verification_worktree: `H:\repos\ccswitchmulti-release-verify-20260829` at `aee4ae47eb9dd0810fa9b05aa1c8db3cf2806842`
- long_running_commands: `pnpm install --frozen-lockfile`, final `cargo check`, full `cargo test`, `pnpm typecheck`, full `pnpm test:unit` in isolated verification worktree
