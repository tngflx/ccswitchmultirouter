# All-disabled Automatic Catalogue Refresh

- Date: 2026-10-02
- Approval: approved
- Implementation: implemented
- Verification: verified
- Runtime freshness: not-checked
- Disposition: active
- Requested by / approval reference: User: "Skip automatic discovery for an all-disabled saved catalogue"
- Related journal entry: docs/memory/journal.md

## Goal and evidence

The wizard, route workspace, and ProviderForm automatic refresh all omit the
requested-ID argument when the enabled catalogue scope is empty. That confuses
an intentionally all-disabled saved catalogue with an empty bootstrap catalogue
and performs unrestricted discovery.

## Decision

Skip standard-provider automatic discovery when a nonempty saved catalogue has
no enabled rows. Preserve every saved row unchanged. Empty catalogues retain
bootstrap discovery, manual Sync Models remains unrestricted, and the existing
authoritative Codex/xAI OAuth discovery paths are unchanged.

## Alternatives and tradeoffs

- Retain unrestricted all-disabled discovery: rejected by the user's approval.
- Pass an empty ID array to fetch: rejected because the fetch API interprets it
  as unrestricted discovery; the owning caller must not start the request.
- Delete disabled inventory: rejected because disabled rows are persisted user
  exclusions, not permission to clear the catalogue.

## Ownership and affected areas

- `src/lib/codexMultiRouterWizard.ts`: distinguish all-disabled from empty.
- Wizard, route workspace, and ProviderForm automatic request producers.
- Direct component and helper regression tests; four locale skip messages.

## Reference-repository verdict

Rechecked GitHub current heads: BigStrongSun/ccswitchmulti `b4741adea` and
farion1231/cc-switch `b9e962026`. Read nearby form/wizard history and current
implementations, recent open/closed PR listings, BigStrongSun PRs #75/#99, and
farion1231 PRs #7641/#7811. The tombstone-preservation work in #75 is consistent
with keeping excluded rows. The official catalogue PRs concern a different
account-authoritative HTTP boundary. Neither reference provides this fork's
scoped automatic-refresh/all-disabled caller contract to port. No merge or
cherry-pick was performed.

## Verification

Dependent wizard/helper/form suites passed 324/324 tests; the full frontend
suite passed 198 files / 1,678 tests; `pnpm typecheck`, `git diff --check`,
`cargo check --manifest-path src-tauri/Cargo.toml`, and the 108-test
`codex_multirouter` Rust unit boundary passed. The full Rust suite remains
blocked by the user-owned running `cc-switch.exe` lock, and live runtime
freshness still requires restarting the normal `pnpm dev` process.

## Open approval or runtime gaps

Exact live request contents remain unverified; tests use mocked model-fetch IPC.

## Status history (append-only)

- 2026-10-02: Approved with the exact user response above; implementation started.
- 2026-10-02: The initial three reproductions failed (3 failed / 234 skipped).
  Producer guards are now implemented. The first targeted rerun passed the
  wizard and ProviderForm cases; the workspace made no request but its text
  assertion failed because its test translation resources are empty. Add
  disable/re-enable lifecycle coverage before declaring the contract tested.
  Workspace scope transitions must release prior deduplication identities and
  use a fresh request instance, so an earlier request with identical bindings
  cannot become current again after re-enabling. This is required to preserve
  the approved skipped-catalogue boundary under in-flight transitions.
- 2026-10-02: Implemented guards in the wizard, route workspace, and ProviderForm
  automatic callers. Focused dependent Vitest passed 6 files / 324 tests;
  the full frontend suite passed 198 files / 1,678 tests; `pnpm typecheck`,
  `git diff --check`, `cargo check`, and all 108 `codex_multirouter` Rust
  tests passed. The full Rust suite remains blocked because the normal
  `src-tauri\\target\\debug\\cc-switch.exe` is locked by running PIDs 20760
  and 45100. Runtime freshness remains pending a user restart.
