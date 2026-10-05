# Fresh-refork final frontend regressions

## Goal

Close the two failures exposed by the final cutover verification without copying
legacy settings orchestration or changing Accordion mounting/accessibility
behavior to satisfy an implementation-specific assertion.

## Evidence

The October 6 full frontend run reported 222/224 files and 1,742/1,744 tests
passing. The settings reset payload was overwritten by the old query snapshot.
The installed react-i18next 16.6.6 returns a new i18n wrapper when language
changes, invalidating callbacks used by the initialization effect even when its
query snapshot is unchanged. Legacy commit `e72f8770` already guards this owner.

Installed Radix Collapsible 1.1.20 sets `aria-controls` only on expanded triggers;
the test required it on an initially collapsed trigger. Keyboard behavior must
still be verified, as must actual panel identity and accessible labeling.

Reference audit: fetched and inspected BigStrongSun `b4741ade` and original
farion1231 `bf2fe0d0b`, including nearby settings/Accordion history and open/closed
PR searches. BigStrongSun has no equivalent reset guard; its Accordion matches
the current primitive wrapper. Original open PR #7850 addresses directory drafts
and queued autosaves, a broader ownership change than this reset bug. Defer that
PR rather than importing its new state machine here. Radix's installed primitive
source confirms conditional `aria-controls`; do not override that owner.

## Decision

- Track the last query snapshot applied by `useSettingsForm`. Re-rendering for
  language changes cannot reapply that same snapshot. Explicit reset establishes
  the currently observed snapshot as consumed; a genuinely new query snapshot
  still applies.
- Add regressions for reset before initial query hydration, local language drafts,
  and application of a newer server snapshot.
- Assert expanded Accordion trigger-to-panel IDs and panel-to-trigger labels
  before and after keyboard activation. Preserve keyboard navigation and adjacent
  Switch independence assertions. Do not require a closed trigger to advertise
  an unmounted panel.

## Alternatives

Loosening the settings assertion, suppressing language events, force-mounting all
Accordion panels, assigning fake panel IDs, or copying the legacy hook wholesale
are rejected: they mask the cause or introduce another owner.

## Ownership boundary and affected files

`src/hooks/useSettingsForm.ts` owns query-to-form initialization and explicit
reset. Its tests own the snapshot regression contract. The Sub-Agent editor test
owns behavioral accessibility checks; Radix remains the Accordion owner.

## Independent status

- Approval: not-approved; no separate approval is required for these routine,
  reversible regressions within the user's approved fresh-refork migration.
  Parent approval: "the github repo main branch [should] have these fresh refork
  codebase with our own flavours".
- Implementation: in-progress.
- Verification: pending; initial full-run failures are preserved above.
- Runtime freshness: not-checked for these changes.
- Cutover: not-started. Full Rust testing is blocked by the running
  `src-tauri/target/debug/cc-switch.exe` (Access is denied, exit 101). The user was
  asked to stop their normal fresh-checkout `pnpm dev`; no process was killed.

Unexplained dependency/lock/workspace updates remain untouched and uncommitted.
They are not approved or included by this decision.

## October 6 investigation correction

The first targeted rerun passed 171/173 tests, but still failed two assertions.
The reset payload now survives; its test must change language through
`updateSettings` (the real user path), not mutate the global instance behind the
hook's language-specific wrapper. This is also how legacy `e72f8770` repaired
that fixture. The Accordion intentionally labels each region with its own
model-specific text, not the trigger ID. Verify that accessible region and
trigger-to-panel ID relationship rather than requiring a different label owner.
These are test-contract corrections; no primitive or panel-mounting code changes.

## October 6 final source results

- Approval: not-approved for a separate approval; these scoped regression fixes
  remain routine work within the approved migration.
- Implementation: complete for the settings snapshot guard and Accordion test
  correction, not for the overall migration/cutover.
- Verification: targeted frontend run passed (7 files, 173 tests); final full
  frontend run passed (224 files, 1,747 tests), and `pnpm typecheck` passed.
  Prettier 3.6.2, the version in the committed lockfile, passed the full source
  check and the three edited-file check. `git diff --check` passed.
- Runtime freshness: not-checked for these edits. The current fresh-refork app
  started at 00:53 on October 6, before these fixes; it is not runtime evidence
  for them.
- Cutover: not-started. Full Cargo testing exited 101 before executing tests
  because the running app locks `src-tauri/target/debug/cc-switch.exe`.
  The separate library-only run exited 0: 4,364 passed, 0 failed, 9 ignored.
  Integration tests have not been rerun successfully at this boundary.

The frontend results above used the installed, uncommitted dependency upgrades.
`pnpm format:check` with their Prettier 3.9.9 still reports 46 existing files.
Passing the committed formatter is not a pass for that upgraded toolchain.
Dependency ownership/disposition and reproducible verification of the publication
tree remain open; do not stage those changes or bulk-format unrelated files.

Exact logs:

- Targeted: `C:/Users/Felix/AppData/Local/Temp/ccswitchmulti-refork-targeted-frontend-20261006-rerun.log`
- Full frontend: `C:/Users/Felix/AppData/Local/Temp/ccswitchmulti-refork-vitest-20261006-final.log`
- Library: `C:/Users/Felix/AppData/Local/Temp/ccswitchmulti-refork-lib-tests-20261006.log`
- Blocked full backend: `C:/Users/Felix/AppData/Local/Temp/ccswitchmulti-refork-cargo-test-20261006-010833.log`
