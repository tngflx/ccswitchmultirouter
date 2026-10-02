# Wizard Visible Name Collision Detector

- Date: 2026-10-02
- Approval: approved
- Implementation: implemented
- Verification: partial
- Runtime freshness: not-checked
- Disposition: active
- Requested by / approval reference: User answered "Apply the detector fix" to treating distinct visible aliases for the same upstream as resolved while warning about actual visible-name conflicts.
- Related journal entry: docs/memory/journal.md

## Goal and evidence

The live Tauri window's Prepare page reports one duplicate upstream-name group
even though `glm-5.3-flash-opencode-go` and `glm-5.3-flash-opencode-zen` already
have distinct visible names pointing at `glm-5.3-flash`. Read-only PrintWindow
capture and UI Automation text agree. The current detector groups by upstream
identity, which the resolver must preserve for correct routing; recomputing
aliases therefore cannot resolve the reported condition.

## Decision

Detect conflicts at the visible picker-identity boundary, case-insensitively and
with surrounding whitespace ignored. Shared upstream names behind distinct
visible aliases are valid. Count each provider once; disabled rows do not
participate. Continue detecting a shared visible name even when its upstream
targets differ. Preserve resolver behavior, catalogue selection, upstream IDs,
and route persistence. Update the warning in all four locales to describe
visible-name conflicts accurately.

## Alternatives and tradeoffs

- Rename real upstream IDs: rejected; it breaks requests and alias mappings.
- Hide all duplicate warnings: rejected; unresolved visible conflicts still need review.
- Keep raw upstream-sharing warnings: rejected by the user's selected scope.

## Ownership and affected areas

- `src/lib/codexMultiRouterWizard.ts`: collision detector and internal result type.
- `tests/lib/codexMultiRouterWizard.test.ts`: resolved/unresolved identity coverage.
- `tests/components/CodexMultiRouterWizard.test.tsx`: live-state warning reproduction.
- `src/i18n/locales/{en,zh,zh-TW,ja}.json`: warning text.

## Reference verdict

BigStrongSun main `b4741adea` retains the same raw-upstream detector and does not
provide this fix. Its nearby alias history and 20 recent open/closed PRs were
inspected; no detector correction is present. Original cc-switch main
`b9e962026` has no equivalent MultiRouter collision detector; its 20 recent
open/closed PRs do not own this boundary. Fix the local invariant, do not port
unrelated model-fetch or header changes.

## Verification

- Pending: focused helper/component/consumer tests, typecheck, formatting, diff check.
- Pending: background inspection of the existing Tauri Prepare page after HMR.

## Open approval or runtime gaps

The dev server serves current scoped-fetch code from `/components/...`, not
`/src/components/...`; the latter returns fallback HTML because Vite root is
`src`. Server freshness alone is not renderer freshness. Verify the actual
Tauri window after editing; do not restart or kill the user's process.

## Status history (append-only)

- 2026-10-02: User explicitly approved the detector fix. Implementation started
  after background observation of the actual duplicate warning and aliases.
- 2026-10-02: Implemented the visible-identity detector and all four locale
  corrections. Focused Vitest passed 6 files / 317 tests (both wizard helper
  suites, wizard component, workspace, ProviderForm, settings hook);
  `pnpm typecheck` passed. The targeted Prettier check initially failed three
  files; formatting and the subsequent check passed. `git diff --check` passed.
  Background UIA of the actual Tauri Prepare page showed the distinct Go/Zen
  aliases, the shared upstream ID, and no false warning. No fetch/save/publish
  action was invoked during this observation. The accompanying
  `capture-20261002-163507.png` showed the provider list, not Prepare: it is not
  screenshot evidence for that page. Runtime freshness remains not-checked for
  exact request contents; the observation establishes displayed detector state
  only. Full final-boundary suites remain outstanding.
- 2026-10-02: Reaudited the four-day functional commit range
  (`af372abd3` through `e880d2482`). No additional root-cause regression was
  found beyond the scoped automatic-catalogue and route-identity issues fixed
  in this batch. The repository-wide Prettier check still reports three
  pre-existing committed files outside this change; touched files pass the
  targeted check. Runtime freshness remains pending restart.
