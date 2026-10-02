# Approval Threshold for Routine Fixes

- Date: 2026-10-02
- Approval: approved
- Implementation: implemented
- Verification: not-run
- Runtime freshness: not-applicable
- Disposition: active
- Requested by / approval reference: User: "no do it now!"
- Related journal entry: docs/memory/journal.md

## Goal and evidence

The prior repository guidance required an approval pause whenever more than one
reasonable behavioral implementation existed, including routine low-risk fixes.
That caused unnecessary interruption for common-sense changes such as the
approved Follow all models fix.

## Decision

Proceed directly with routine, low-risk, reversible fixes clearly implied by a
request. Reserve an approval pause for materially ambiguous or high-impact
decisions, including destructive or irreversible changes, data migrations,
security/privacy behavior, public contracts, release or policy changes, and
materially different user workflows.

## Alternatives and tradeoffs

- Keep approval for every behavioral ambiguity: rejected because it blocks
  routine engineering work and was explicitly rejected by the user.
- Remove approval entirely: rejected because high-impact and irreversible
  decisions still need explicit scope confirmation.

## Ownership and affected areas

- `AGENTS.md`: Change Authorization & Decision Records rule 33.

## Verification

- Reviewed the updated rule text for the requested threshold; no executable
  verification applies.

## Open approval or runtime gaps

None.

## Status history (append-only)

- 2026-10-02: Replaced universal ambiguity approval with a high-impact-change
  threshold at the user's explicit request.
