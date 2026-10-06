# Decision: localize user-visible defaults and consolidate root engineering notes

- **Date:** 2026-10-06
- **Goal:** Make the fresh-refork UI English-first when the selected locale is English, while preserving the four-locale i18n contract; reduce root-level internal documentation sprawl without deleting evidence.
- **Evidence:** A source audit found user-facing Chinese literals in `src/` (mostly `t(..., { defaultValue: ... })`, toast/dialog fallbacks, and `src/index.html`), while repository documentation already defines `docs/memory/journal.md` and structured `docs/{audits,decisions,guides,memory}` ownership. Root contains dozens of dated `memory-*.md` files plus `memory.md` and ad-hoc debugging notes.
- **Decision:** Replace user-visible Chinese fallback/default strings with English equivalents and add/update locale-key parity coverage only where keys are introduced. Keep provider/product names and comments unchanged. Move internal root notes into one preserved `docs/memory/root-notes-archive.md` with source headings, and move stable topic notes into canonical docs locations; retain standard GitHub files at root. Native Codex memory may supplement but cannot replace repository evidence because it is not versioned or reviewable by collaborators/CI.
- **Alternatives rejected:** mass-replace all CJK (would alter comments, proper names, and non-UI data); delete historical notes (loses audit evidence); rely exclusively on Codex-native memory (not durable project history).
- **Approval:** approved by user in this task message.
- **Implementation:** complete for this batch. English fallback/default text was updated across
  the audited Codex/provider/session/proxy/settings surfaces; locale files remain parity-safe;
  root notes were consolidated into the archive and stale references were updated. The separate
  reasoning-effort schema work was not changed.
- **Verification:** targeted Vitest passed: `CodexFormFields` 40/40 and the focused five-file
  batch 64/64 (re-run after formatting). `pnpm typecheck` passed (re-run after formatting).
  `git diff --check` passed. A docs-reference scan found and then removed the two remaining
  references to deleted root filenames. `pnpm format:check` now reports only four files:
  `CodexFormFields.tsx` and the three `CodexModelReasoning*.tsx` files, which were intentionally
  left untouched because they are owned by the concurrent reasoning-effort schema task. Full
  frontend/backend suites and runtime freshness were not tested.

## 2026-10-06 — Continuation correction and verification scope

- **Approval status:** approved for the requested localization/docs work by
  “finish up the prompt before the latest one!!! then only contineu on”.
  The ordinary wizard-close regression fix below is `not-approved` separately;
  it needs no additional approval under rule 33 and does not change acceptance
  criteria or persist new configuration.
- **Implementation status:** in-progress. Earlier completion evidence did not
  cover the entire wizard/workspace or the leftover full-width punctuation.
- **Verification status:** pending for this continuation. An archive audit
  checked all 91 unique source headings against `git show HEAD:<source>` and
  found all 91 original note contents preserved with no mismatch.
- **Runtime freshness:** not-checked. Do not infer live Tauri behavior from
  source or component tests.
- **Goal/evidence:** preserve the existing four-locale contract, finish the
  English-first cleanup, and retain meaningful behavioral tests. Two wizard
  assertions had been weakened: “Accept later” accepted `completed`, and the
  automatic-model progress test no longer asserted its denominator.
- **Decision/ownership:** wizard dismissal must not dispatch completion without
  real-request acceptance evidence. Remove that invalid local transition and
  restore the enabled-state assertion. Restore the progress test against the
  owning dialog's actual `Validating models 0/2` text. Keep protocol selection,
  reasoning schemas, provider persistence, and stream retry unchanged.
- **Alternatives:** rejected changing tests to accommodate false completion or
  checking only that a probe button is busy. Deferred unrelated historical
  release-note links (14 pre-existing relative-link failures).
- **Affected files:** wizard component/tests; already-owned localization
  surfaces; i18n regression tests; this record and the memory journal.
- **Reference verdict:** public GitHub API history for BigStrongSun's wizard
  shows manual-protocol and evidence-restoration ownership; farion1231 has no
  wizard file history. Relevant open/closed PR searches found no matching
  wizard acceptance or drag-order fix to port. Preserve the fresh owners rather
  than copying legacy orchestration.
- **Native memory:** official documentation retrieval returned no usable page,
  so native-memory availability is unverified. Keep the versioned journal and
  decision records; do not claim they have been replaced by assistant memory.

### 2026-10-06 — Comment preservation correction

The earlier mechanical translation also modified Chinese comments into mixed-language
fragments, contrary to this record's stated boundary. Restore only attributable
comment replacements in the owned localization files, using parsed comment positions
and the original Git contents; do not revert executable code or concurrent work.
Normalize leftover full-width punctuation only inside UI string/template/JSX tokens,
repair malformed English, and use the existing `common.refresh` locale key for the
remaining Usage refresh label. Remove the unused wizard `completed` state so dismissal
cannot later be mistaken for acceptance. Approval remains scoped as above; implementation
is in-progress, verification pending, and runtime freshness not-checked.

### 2026-10-06 — Child-panel coverage and native-memory correction

- **Evidence:** The token audit found direct Chinese labels in the external API
  source picker/helper, hosted-tools panel, global Codex settings, recovery
  boundaries, provider dialogs/actions, and wizard result helpers. Earlier
  coverage of parent pages did not cover these child owners.
- **Decision:** Localize the existing owners with shared locale keys, including
  interpolation for counts and errors; retain raw backend identifiers, protocol
  selection, persistence, diagnostic logs, comments, and proper names. Add all
  new keys in English, Chinese, Traditional Chinese, and Japanese together.
  Do not modify the concurrent reasoning/schema or retry implementation.
- **Approval:** approved within the existing requested English-UI cleanup.
- **Implementation:** in-progress. **Verification:** pending.
  **Runtime freshness:** not-checked.

- **Native-memory correction:** Official Codex memory documentation was retrieved
  at `https://learn.chatgpt.com/docs/customization/memories`. It documents local
  memories and Off, Read-only, and Auto settings. This corrects the earlier
  unsuccessful retrieval; it does not establish this installation's availability
  or configured setting. No memory setting was changed. Native memory can reduce
  disposable session notes, not replace versioned decisions or verification
  evidence. Keep one root-note archive and the concise journal.

### 2026-10-06 — Remaining preset labels and save-warning owners

- **Evidence:** The renewed token audit found untranslated universal-preset
  names/descriptions and two TE publish-failure warnings. Diagnostic strings,
  protocol-error matching, provider names, and the concurrent validation schemas
  are not translation targets.
- **Decision:** Render universal-preset labels through one shared helper with
  four-locale keys. Localize only the initial/new preset display-name suggestion;
  preserve existing provider names and unsaved drafts across locale changes.
  Translate TE warnings without changing the stored/published outcome, retries,
  or notification severity. Keep schemas and the reasoning task untouched.
- **Approval:** approved within the requested English-UI cleanup.
- **Implementation:** in-progress. **Verification:** pending.
  **Runtime freshness:** not-checked.

### 2026-10-06 — Scoped cleanup outcome and remaining shared gate

- **Approval:** unchanged; the requested English-UI/docs cleanup is approved.
  No native-memory setting, live user configuration, or reasoning schema was changed.
- **Implementation:** complete for the audited localization/docs batch. Shared
  preset helpers require an explicit translator, preserve unknown metadata and
  existing names, and do not reset unsaved drafts on locale changes. TE warning
  translations preserve the saved/published status and notification severity.
  Removed nine known generated root test reports, not historical evidence.
- **Verification:** the combined targeted frontend run exited 0 with 37 files /
  611 tests passed and zero failures. A fresh `pnpm typecheck` and
  `git diff --check` both exited 0. The archive comparison against
  `git show HEAD:<source>` confirmed 91 sources, 91 unique headings, all 91
  contents preserved, and zero mismatches (normalizing line endings and trailing
  newlines only). Earlier stale assertions/import failures are superseded by
  this passing combined run, not omitted or accommodated by weakening behavior.
- **Shared formatting:** `pnpm format:check` still fails on exactly
  `CodexFormFields.tsx`, `CodexModelReasoningCard.tsx`,
  `CodexModelReasoningEditor.tsx`, and `CodexModelReasoningSummary.tsx`.
  These are protected concurrent-task files; they were not reformatted here.
  This is not a green repository-wide delivery gate.
- **Deferred:** concurrent reasoning/schema translations, 14 pre-existing
  historical release-note link failures, and any production Model order changes
  until the shared formatting gate is resolved. A read-only/test-only audit of
  the existing drag sensors may proceed without starting another ordering owner.
- **Runtime freshness:** not-checked. Component tests do not establish live Tauri
  behavior. Full frontend/backend suites, Rust checks, release artifacts, GitHub
  publication, and checkout cutover were not performed in this continuation.
  Existing React act, localStorage, and mocked-network diagnostics remain.

### 2026-10-06 — Full-suite localization integration audit

- **Evidence:** The final frontend run exited 1: 17 failed files, 216 passed
  files; 54 failed and 1,775 passed tests. Three files failed collection because
  their complete `react-i18next` mocks omitted `initReactI18next`, now imported
  by localized shared utilities. Other failures include stale Chinese fallback
  assertions on translated owners. Protected reasoning/form files also have
  failing assertions and remain unformatted.
- **Decision:** Repair test mocks with `importOriginal`, preserving existing
  translators and behavioral assertions. Audit each failed assertion against its
  producing owner; update language-specific expectations without weakening
  persistence, evidence, cancellation, or unknown-usage invariants. Do not modify
  or silently accept unexplained protected reasoning/form edits.
- **Approval:** unchanged for this chat's localization integration; no approval
  is inferred for overlapping reasoning-schema work.
- **Implementation:** in-progress. **Verification:** failed at the full-suite
  gate; targeted reruns pending. **Runtime freshness:** not-checked.

### 2026-10-06 — Four-locale presentation correction

- **Evidence:** The subsequent full frontend run exited 1 with 229 passed /
  4 failed files and 1,834 passed / 9 failed tests. All remaining failures are
  in protected reasoning/form consumers; their ownership has not been released.
  The unprotected probe/wizard consumer run passed 7 files / 97 tests after
  repairing an assertion to check the actual unselected partial-protocol button.
- **Root cause / correction:** Removing Chinese literals is not equivalent to
  localization. Earlier edits translated direct JSX/helper labels to hardcoded
  English, including protocol progress and session traffic. These strings do
  not respond to the selected locale. Supersede the earlier completion claim
  for these presentation owners; preserve its test evidence.
- **Decision:** Audit the attributable direct translations and route display
  text through the existing i18n owner, with English source keys and matching
  Chinese, Traditional Chinese and Japanese translations. Keep raw protocol
  identifiers, diagnostics, persisted data, accounting, and selection behavior
  unchanged. Test actual locale switching as well as the existing behavioral
  consumers. Do not edit protected reasoning/form/schema owners.
- **Approval:** unchanged within the requested localization scope.
- **Implementation:** in-progress. **Verification:** partial; fresh
  `pnpm typecheck`, `cargo check`, `cargo fmt -- --check` and
  `git diff --check` passed. `pnpm format:check` still fails on the four
  protected reasoning/form files.
- **Runtime freshness:** not-checked. Both observed refork app processes
  predate these source changes. No publication or checkout replacement occurred.

### 2026-10-06 — Probe language-switch evidence and session presentation boundary

- **Evidence:** The corrected probe/compatibility owners and wizard consumers
  passed 6 files / 100 tests. Additional production-resource locale-switch
  regressions and interpolation checks passed 2 files / 10 tests. They preserve
  raw model/provider/protocol IDs, exact selection payloads, expanded mappings,
  missing-usage caveats and the disabled running-probe close control.
- **Decision:** Correct the already-attributable hardcoded session-traffic
  presentation at its existing component/helpers. Translate complete sentences
  with named interpolation parameters in all four resources. Do not change
  observed/missing accounting, cost predicates, parent-child attribution,
  filters, sorting, sync callbacks, DTOs, proxy traffic or backend behavior.
- **Ownership:** `CodexSessionTrafficPanel.tsx`, its direct/localized consumer
  tests, the four locale files and locale-contract coverage. Protected
  reasoning/form/schema and concurrent retry/backend sources remain excluded.
- **Approval:** unchanged within the requested localization work.
  **Implementation:** in-progress. **Verification:** partial as above; session
  regressions and current typecheck pending. **Runtime freshness:** not-checked.

### 2026-10-06 — Timezone presentation-owner correction

- **Evidence:** The existing egress status/settings components were mechanically
  translated to English but their status helpers, privacy disclosures, controls,
  comparison messages and runtime-result summaries bypass i18n. Session traffic
  now has 107 matching source keys, real translations and locale-switch tests;
  the consumer rerun is still pending at this transition.
- **Decision:** Route timezone presentation through the existing translation
  owner, preserving raw IPs, IANA identifiers, offsets, diagnostics, interval
  values, API calls, explicit apply/save actions, consent/privacy behavior and
  refresh workflow. Do not change probes, CDP, backend settings or user data.
  Local validation/fallback errors should translate at render time without
  changing upstream error text or triggering operations on a language change.
- **Ownership:** The two existing egress frontend components and their tests,
  four locale resources, locale contracts and this outcome record. Protected
  reasoning/form/schema and retry/backend work remain excluded.
- **Approval:** unchanged within the requested four-locale UI cleanup.
  **Implementation:** in-progress. **Verification:** pending for timezone.
  **Runtime freshness:** not-checked; current processes predate source fixes.

### 2026-10-06 — Timezone verification and shared-gate status

- **Implementation status:** the timezone presentation-owner correction is complete.
  The two components now render status, privacy, controls, comparison results and
  runtime summaries through the four-locale translation resources. The missing
  `providerForm.codexConfigInvalidNotSaved` key was also added to all four locale
  files so the save-warning owner has no Chinese fallback under English.
- **Verification:** the timezone targeted run passed **4 files / 18 tests**;
  `pnpm typecheck`, `cargo check`, `cargo fmt -- --check`, and `git diff --check`
  passed in the current checkout. The latest full frontend run remains **229
  passed files / 4 failed files; 1,834 passed tests / 9 failed tests**, with all
  failures confined to the protected reasoning/form consumers. `pnpm format:check`
  remains blocked by those same four protected files. The backend library tests
  passed **4,379 / 4,379** with **9 ignored**; the full Cargo suite is blocked by
  existing `cc-switch.exe` processes holding the normal target binary.
- **Runtime freshness:** not-checked. The user must stop the existing `pnpm dev`
  process and restart it from this checkout before runtime verification. No
  release build or GitHub publication has occurred.
- **Cutover status:** the fresh refork remains the local foundation, but `origin/main`
  has not yet been replaced. Publication is deferred until the protected reasoning
  task releases its files and the final verification boundary is green.
