# Agent approval and decision-record protocol

- Date: 2026-10-01
- Approval: approved
- Implementation: implemented
- Verification: passed
- Runtime freshness: not-applicable
- Disposition: active
- Requested by / approval reference: "then can you update the agents.md to take note on this? and also reaudit the whole agents.md changes as well"
- Related journal entry: `docs/memory/journal.md` (2026-10-01 entry)

## Goal and evidence

The prior audit changed application behavior while investigating a bug, without
separating the user's request from additional behavioral choices. The repository
already required a memory journal but did not explicitly require approval gates
or a durable record for each substantive decision.

## Decision

Treat audits and reaudit requests as read-only by default. Require explicit
approval for ambiguous behavior, record substantive decisions under
`docs/decisions/`, and keep approval, implementation, verification, and runtime
freshness as separate statuses.

## Alternatives and tradeoffs

- Journal-only: rejected because the journal is intentionally concise and does
  not provide a complete decision template or approval state.
- Automatic approval from tests or a user bug report: rejected because evidence
  does not establish authorization for extra behavior.
- Separate decision records linked from the journal: accepted because it keeps
  the audit trail detailed without turning the journal into a transcript.

## Ownership and affected areas

- `AGENTS.md`: mandatory agent workflow and approval rules.
- `docs/decisions/README.md`: decision-record template.
- `scripts/validate-agents-md.ps1`: validates the current schema/path facts and
  the new policy markers.
- `scripts/tests/validate-agents-md-statuses.ps1`: in-memory positive and negative
  regression cases for independent statuses; no fixture checkout or build tree.

## Verification

- `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/validate-agents-md.ps1`
  passed after the edits.
- `git diff --check` passed after the edits.

Final documentation/workflow scope:

- `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/validate-agents-md.ps1`:
  **164 passed, 0 failed**, including all 42 source-table rows and 49 rule IDs.
- `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/tests/validate-agents-md-statuses.ps1`:
  **8 passed, 0 failed**.
- PowerShell AST parsing: **2 scripts passed, 0 parse errors**.
- `git diff --check`: passed. Git reports an LF-to-CRLF conversion warning for
  the validator; it is not a whitespace-check failure.
- Application tests, type checks, builds, and live runtime verification were
  **not run in this documentation turn**. `Verification: passed` applies only
  to the documentation/workflow scope, not the existing application edits.

## Open approval or runtime gaps

The earlier unapproved application edits remain separate dirty-tree changes and
are not approved by this documentation update. They require an explicit retain,
revise, or revert decision before commit.

## Re-audit findings and scope

All sections of `AGENTS.md` and its working-tree diff were reread. Rules for
root-cause fixes, request accounting, manual handoff, testing boundaries, Git
isolation, normal Cargo targets, release builds, process ownership, and live
config writes were retained. No application behavior was edited during this
documentation re-audit.

Corrections:

- Rule 33 now requires waiting for explicit approval, not merely presenting a plan.
- Rule 35 and the template replace the original combined `Status` field with
  independent approval, implementation, verification, freshness, and disposition.
- Decision status history is append-only; completed tests cannot supply approval.
- Source tables use repository-root paths; the backend test row identifies
  `src-tauri/tests/`, and `ReasoningContentMode` identifies its actual owning file.
- IPC command names are snake_case; wrapper names and argument keys are camelCase.
- Rule 22-E takes precedence for minimized windows. The PowerShell helper captures
  the top-level window, does not restore/show it, and cannot establish freshness.
- Rule 26 requires verifying remote identity: `bigstrongsun` and `upstream`
  currently refer to different reference repositories, not interchangeable ones.
- The validator was extended to check actual documented paths, rule coverage,
  independent decision fields, and schema agreement rather than only policy markers.

Reference-repository verdict (2026-10-01): GitHub API reads found current heads
`b4741ade` for `BigStrongSun/ccswitchmulti` and `7c0d0fc6` for
`farion1231/cc-switch`; recent open/closed PR listings were inspected. Neither
repository exposes root `AGENTS.md` or `docs/memory/README.md` at its default
branch (404 responses and empty path histories). No equivalent approval policy
was found in those inspected paths, and none was ported. This is not a claim
that every document or PR in either repository was audited.

## Existing application edits awaiting approval

This is a retrospective inventory, not authorization. For both groups below:
approval `not-approved`, implementation `implemented`, verification `not-run`
in this documentation turn, and runtime freshness `not-checked`. Earlier
verification claims remain in their original journal entries; they were not
rerun or promoted to current runtime evidence here.

- Startup diagnostics: `src-tauri/src/lib.rs` and
  `src-tauri/src/services/proxy.rs`.
- Catalog inclusion, wizard persistence, and regressions:
  `src/components/codex/CodexMultiRouterWizard.tsx`,
  `src/components/providers/forms/CodexFormFields.tsx`,
  `src/components/providers/forms/codexCatalogSync.ts`,
  `src/components/providers/forms/codexCatalogSync.test.ts`,
  `src/lib/codexMultiRouterWizard.ts`,
  `src/lib/codexMultiRouterWizard.test.ts`,
  `tests/components/CodexFormFields.test.tsx`,
  `tests/components/CodexMultiRouterWizard.test.tsx`, and
  `tests/lib/codexMultiRouterWizard.test.ts`.

## Status history (append-only)

- 2026-10-01: Documentation update requested explicitly by the quoted message
  above. The initial record used `Status: approved`; the re-audit replaces that
  ambiguous field with independent fields. This approval covers instructions
  and documentation only, not the pre-existing application edits.
- 2026-10-01: Initial validator rerun passed 47/47 checks and `git diff --check`
  passed. Follow-up corrections are implemented; final scoped verification is
  pending. Application tests and live runtime verification were not run here.
- 2026-10-01: The first expanded validator run had **163 passed, 1 failed** because
  the validator incorrectly treated the module filename `codexCatalogSync` as
  an exported identifier. Changed the check to the actual exported
  `reconcileFetchedCodexCatalogRows`. Final rerun passed **164/164**; retained
  status regressions passed **8/8**, and both PowerShell scripts parsed cleanly.
  Verification changed from `partial` to `passed` for documentation/workflow only.
  The first reference-history query mishandled an empty API array; the corrected
  query confirmed zero entries for the inspected governance paths in both repos.
- 2026-10-01: After the pending application edits and origin/main merge scope
  were disclosed, the user instructed: "that's why im asking u to merge
  intelligently u fuck! then only push!". The earlier awaiting-approval inventory
  remains historical; current application authorization is recorded in
  2026-10-01-catalog-merge-publication.md and
  2026-10-01-startup-skip-diagnostics.md. This does not approve the proposed
  relaxation of the decision-record policy; that policy remains unchanged.
- 2026-10-01: Merge-batch documentation validation passed 172/172 after adding
  the catalog and startup decision records; status regressions remain 8/8 and
  both scripts parse cleanly. The later application verification is separate:
  full frontend passed 197 files / 1,639 tests, full Rust execution was blocked
  by a running executable, and focused startup tests returned 18 passed / 1
  failed at the active Desktop guard. Documentation approval and scoped passed
  verification do not override that push gate.
