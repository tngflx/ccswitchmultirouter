# AGENTS Policy Consistency Corrections

- Date: 2026-10-03
- Approval: approved
- Implementation: implemented
- Verification: passed
- Runtime freshness: not-applicable
- Disposition: active
- Requested by / approval reference: User: "ok correct everything then! remove that handoff rule we no longer needs it!"
- Related journal entry: docs/memory/journal.md

## Goal and evidence

The full `AGENTS.md` audit found an impossible tool-free handoff requirement,
an approval-state contradiction, an ambiguous production-artifact inspection
path, an over-broad reference-repository audit trigger, stale runtime-specific
evidence in the policy file, an incomplete production-rule range, and an
approval trigger that treated ordinary ambiguity as sufficient reason to pause.

## Decision

Remove the obsolete handoff/compaction rule. Clarify that routine changes
authorized by the request do not become blocked merely because they lack a
separate approval record; retain escalation for high-impact or irreversible
changes. Make artifact verification explicitly download-only, scope upstream
audits to changes where they are relevant, remove historical window-handle
evidence from the policy, and correct the production-rule reference.

## Alternatives and tradeoffs

- Keep the handoff rule and add a separate test later: rejected because the
  rule itself forbids the tools needed to add that test and the user removed
  the requirement.
- Require approval for every implemented decision record: rejected because it
  conflicts with the approved routine-fix threshold and the decision-record
  schema's independent approval/implementation fields.

## Ownership and affected areas

- `AGENTS.md`: policy rules 6-C, 20, 22-F, 27-A, 36, and the production-rule reference.
- `docs/decisions/README.md`: no schema change; its independent status fields
  remain authoritative.

## Verification

- `rg` confirmed the obsolete rule 6-C handoff/compaction text and stale rule
  22-F evidence are absent, the production reference ends at 22-E, the
  narrowed rule 27-A and rule 36 wording are present, and multiline matching
  confirms ambiguity alone is not an approval trigger.
- `git diff --check -- AGENTS.md docs/memory/journal.md` passed, and a targeted
  trailing-whitespace scan passed for `AGENTS.md`, this decision record, and
  `docs/memory/journal.md`.
- No executable or application tests were run; this change only updates
  repository guidance and its audit records.

## Open approval or runtime gaps

None.

## Status history (append-only)

- 2026-10-03: User explicitly approved all audit corrections and removal of
  the obsolete handoff rule.
- 2026-10-03: Implemented the approved documentation corrections; targeted
  text checks and `git diff --check` passed.
- 2026-10-03: Removed ambiguity alone as an approval trigger; ordinary work
  now follows the conservative existing pattern unless a high-impact or
  irreversible decision is involved.
