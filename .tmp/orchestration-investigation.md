# CCSwitch orchestration investigation — October 16, 2026

**Profile cleanup/publication status: complete.** The canonical profile list was
consolidated, the local debug CCSwitch process was rebuilt/restarted, and the
new profile is visible through the live picker audit. This does not certify the
whole application bug-free or prove every upstream provider path.

## Cleanup and main-page completion — October 16, 2026, 02:20 SGT

- Removed the older `profile-1791855841117-0` from canonical SQLite after a
  second backup:
  `C:\Users\Felix\.cc-switch\backups\before-orchestration-cleanup-20261016-020053.db`.
- Kept exactly one profile: `research-ensemble` / **Research Ensemble**.
- Set it as the active profile while leaving both default app modes `direct`;
  this makes the profile available without silently changing normal routing.
- Restarted the local debug CCSwitch process and allowed its normal projection
  lifecycle to regenerate the managed catalog. No generated catalog file was
  hand-edited.
- Background picker audit now reports exactly:
  `ccsm-orch/research-ensemble` and
  `ccsm-role/research-ensemble/worker`; both agree across the managed catalog,
  Codex cache, local models endpoint, and installed `model/list`.
- Added `OrchestrationSummaryCard` to the Codex provider main page. It shows
  the saved profile, planner/worker models, publication state, and a direct
  **Configure** button. Settings remain in the canonical orchestration editor;
  the main-page card is a projection/status surface, not a second store.
- The settings flow now explains draft/enabled state, active-default selection,
  model roles, budgets, fallback policy, and publication status.

## Earlier completion recheck — October 16, 2026, 00:44 SGT

- Re-ran the repository background picker audit successfully. It still sees
  only the old profile's orchestration aliases.
- Re-read the canonical database read-only: **Research Ensemble exists and is
  enabled**, but `ccsm-orch/research-ensemble` is **absent from the managed
  catalog**. This is a confirmed publication gap, not completed publication.
- The active profile remains the original `profile-1791855841117-0`.
- The repository error-capture control reports **Capture disabled**. This does
  not establish that every possible monitoring mechanism is disabled, but it
  provides no fresh captured error evidence.
- That earlier check predated the cleanup/rebuild documented above.

Recheck evidence:

- `H:\repos\ccswitchmulti-refork\.tmp\orchestration-background-picker-recheck.json`
- `H:\repos\ccswitchmulti-refork\.tmp\orchestration-canonical-recheck.json`

## Changes

- Separated the profile being edited from the active default-routing profile.
  Browsing, adding, or saving a draft no longer implicitly activates it or
  enables orchestration.
- Added an explicit default-profile action. Deleting an inactive profile
  preserves the active profile. Deleting the active profile returns default
  routing to direct instead of silently choosing another policy.
- Made disabled profiles real persisted drafts. Incomplete role references
  are accepted only for disabled profiles; enabled-profile completeness,
  recursion protection, scope, and execution-budget guards remain enforced.
- Extracted provider selection and whole-settings validation from the editor.
  Defaults use actual included inventory, never a fabricated model ID.
  Recursive/router/protocol-set providers are excluded consistently with
  the backend. Authoritative empty catalogs stay empty.
- Fixed orchestration projection to use the shared catalog authority reader,
  retain ordinary legacy-only catalog rows, remove the legacy field on output,
  and clean stale aliases across supported model-row shapes.
- Renamed the entry to **Manage orchestration profiles**, added draft/enabled
  labels and routing/publication explanations, and localized changed UI text.
- Retained the terminal-quota normalization fix: a provider's plain-text daily
  quota 429 becomes a structured usage-limit response. Ordinary transient 429s
  retain bounded retry behavior.
- Bounded diagnostics reads to the newest 2 MiB / 500 lines, including an
  unterminated last line. Router logging reuses its file handle, rotates at
  16 MiB with three backups, and does not hide events in a buffer until another
  request arrives.
- Added the mandatory background-audit rule to AGENTS.md, including the rule
  that unavailable live tooling is a limitation, not permission to substitute
  workspace UI driving or to call source checks a live audit.

## New canonical profile

Created `research-ensemble` (**Research Ensemble**) in
`C:\Users\Felix\.cc-switch\cc-switch.db`, after a SQLite backup at:

`C:\Users\Felix\.cc-switch\backups\before-research-ensemble-20261016-003054.db`

- Scope: Codex, matching the worker's tool protocol.
- Planner/verifier: `claude-official` / `claude-sonnet-4-20250514`.
- Worker: `codex-official` / `gpt-6.1-sol`.
- Limits: three rounds, three worker calls, one concurrent worker,
  600 seconds, 8,192 output tokens.
- Client approvals; fail closed.
- Enabled intentionally for this requested profile. Newly created UI drafts
  remain disabled by default.

The old profile was deliberately removed during cleanup. The active profile is
now `research-ensemble`; both default app modes remain `direct`, so saving it
does not silently change ordinary routing. Generated picker files were not
manually edited.

## Background runtime evidence

Used `H:\repos\ccswitchmulti-refork\scripts\audit-orchestration-picker.mjs` with
the installed Codex executable. This runs in the background without workspace
UI automation or creating a chat.

Structured result:
`H:\repos\ccswitchmulti-refork\.tmp\orchestration-background-picker-audit.json`.

The cleanup audit reports exactly two aliases for the one remaining profile:
`ccsm-orch/research-ensemble` and
`ccsm-role/research-ensemble/worker`. They agree across the managed catalog,
Codex cache, local models endpoint, and installed Codex `model/list`; neither is
missing. Both are visible rather than hidden.

This script proves picker/catalog agreement, not a successful upstream
inference request.

Earlier investigation evidence traced the old profile to a task on
October 13, 2026. It was already persisted, not spontaneously created by the
current process.

## Verification results

The focused orchestration/main-page checks passed after cleanup:

- `src/components/agents/OrchestrationSummaryCard.test.tsx`: 2 passed.
- `src/components/agents/AgentsPanel.test.tsx`: 9 passed.
- `tests/integration/App.test.tsx`: 23 passed.
- `pnpm typecheck`: pass.
- `pnpm build:renderer`: pass, with the existing large-bundle warning.

The earlier focused and broad checks recorded before the cleanup also passed,
but the latest full-suite rerun exposed unrelated workspace drift:

| Command | Result |
| --- | --- |
| Check | Latest result |
| --- | --- |
| `pnpm typecheck` | Pass |
| `pnpm catalog:verify` | Pass |
| focused Prettier check for changed files | Pass |
| focused Rust format check for changed Rust files | Pass |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib orchestration` | 28 passed |
| `pnpm build:renderer` | Pass; bundle-size warning remains |
| `git diff --check` | Pass |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib codex_multirouter::` | **3 unrelated existing failures** |
| `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` | **3 unrelated existing errors** |
| `pnpm test:unit` | **1 unrelated PiProviderForm timeout** |
| repository-wide `pnpm format:check` | **1 unrelated pre-existing file** |

The three MultiRouter failures concern capability-summary/default-effort
expectations in existing dirty code. Clippy flags existing code in
`commands/xai_oauth.rs`, `reasoning_capabilities/provider_metadata.rs`, and
`services/codex_oauth_models.rs`. The full unit run timed out in an existing
Pi thinking-map test. None of these failures involve the profile cleanup or
the new main-page card.

Regression evidence was captured before fixes: six editor-contract failures,
three orchestration validation/projection failures, and two logging failures.
After corrections, all affected suites pass.

Detailed command outputs are in
`H:\repos\ccswitchmulti-refork\.tmp\orchestration-*.log`; final Rust exit codes
for the earlier passing run are in
`H:\repos\ccswitchmulti-refork\.tmp\orchestration-rust-exit-codes.json`; the
latest rerun summary is in
`H:\repos\ccswitchmulti-refork\.tmp\orchestration-final-verification.json`.

## Verification boundaries

- The local debug executable was rebuilt and restarted so the canonical cleanup
  could pass through the normal projection lifecycle. No release installer was
  built or installed.
- No paid/live provider inference request was made.
- No fresh CDP/log-monitor capture establishes that every lag or runtime error
  is gone. This is not a bug-free certification.
- The gated renderer build retains a large-bundle warning (approximately
  5.87 MB main JavaScript before gzip). This is a remaining performance-review
  candidate, not proof of the reported runtime lag's cause.
- The precise Codex-update change responsible for the observed presentation
  was not independently established. The verified fix is CCSwitch's upstream
  error-envelope handling.
- Unrelated dirty/untracked work was preserved.
