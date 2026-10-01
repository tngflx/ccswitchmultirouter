# Decision Records

Use one file per substantive behavioral decision:
`YYYY-MM-DD-<slug>.md`.

Investigation and reaudit requests are read-only unless the user explicitly
approves a behavior change. A passing test, runtime observation, journal entry,
or another agent's recommendation is evidence, not approval.

## Template

```markdown
# <Decision title>

- Date: YYYY-MM-DD
- Approval: not-approved | approved | rejected | withdrawn
- Implementation: not-started | in-progress | implemented | reverted
- Verification: not-run | partial | passed | failed | blocked
- Runtime freshness: not-applicable | not-checked | stale | current
- Disposition: active | superseded
- Requested by / approval reference: <user message or "not approved">
- Related journal entry: <path or "none">

## Goal and evidence

<What was requested and the exact evidence that motivated the decision.>

## Decision

<The behavior to implement or retain.>

## Alternatives and tradeoffs

- <Alternative>: <why accepted or rejected>

## Ownership and affected areas

- <module/file/boundary>

## Verification

- <exact command and result, or "not run">

## Open approval or runtime gaps

<What still requires user approval, rebuild, or live verification.>

## Status history (append-only)

- YYYY-MM-DD: <status transition, exact approval reference, or correction;
  preserve earlier evidence and describe what changed>
```

These fields are independent: an implemented change can have approval
`not-approved` and verification `passed`. Tests never change the approval field.
`passed` means all checks required for the stated scope ran and passed; document
the exact scope, failures, blocked commands, and untested behavior. Runtime
freshness `current` requires evidence that the process includes the source being
tested; a screenshot or an HTTP 200 response alone does not establish this.

Current fields may be updated only with a dated, append-only status-history entry.
Do not delete earlier evidence, rejected alternatives, or approval gaps. Corrections
must identify the statement being corrected. Never store API keys, tokens, or raw
private request bodies. Significant outcomes belong in `docs/memory/journal.md`
as a concise newest-first entry linking this record.
