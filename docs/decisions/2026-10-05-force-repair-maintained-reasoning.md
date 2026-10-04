# Preserve maintained reasoning metadata during force repair

- Date: 2026-10-05
- Approval: approved
- Implementation: in-progress
- Verification: not-run
- Runtime freshness: not-applicable
- Disposition: active
- Requested by / approval reference: user-approved fresh-refork migration in the current task
- Related journal entry: none

## Goal and evidence

The fresh refork's Codex catalog normalizer intentionally repairs an invalid
reasoning default to the first declared effort. A force-repair recovery test
then observed a maintained DeepSeek capability persisted as `low` instead of
the maintained default `high`, because the later recovery step no longer saw an
invalid declaration.

## Decision

Keep ordinary catalog normalization unchanged. During the explicit Codex
force-repair workflow, restore the maintained capability only for exact model
IDs whose persisted declaration is marked `source: builtin`, then run the
existing invalid-metadata repair for all remaining rows.

## Alternatives and tradeoffs

- Change general catalog normalization to preserve invalid defaults: rejected;
  it would break the existing normalization contract and leave ordinary writes
  non-canonical.
- Always overwrite maintained model rows: rejected; explicit user-authored
  declarations must remain authoritative outside the force-repair recovery path.

## Ownership and affected areas

- `src-tauri/src/proxy/providers/codex_reasoning.rs`: force-repair-only
  maintained capability restoration helper and regression coverage.
- `src-tauri/src/services/provider/mod.rs`: invoke the helper before persistence
  in the explicit force-repair workflow.

## Verification

- Not run yet.

## Open approval or runtime gaps

No runtime freshness check is required for this backend-only recovery behavior.

## Current status (2026-10-05)

- Approval: approved (unchanged)
- Implementation: complete
- Verification: passed; force-repair regression coverage is included in the full Rust suite
- Runtime freshness: not-applicable
- Disposition: active

## Status history (append-only)

- 2026-10-05: approved by the user's explicit instruction to continue the
  fresh-refork migration; implementation started.
- 2026-10-05: force-repair implementation and regression tests completed. Full
  Rust verification passed after rerunning serially with one Cargo build job
  because the initial parallel run exhausted the Windows paging file.
