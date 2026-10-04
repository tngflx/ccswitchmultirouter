# Usage Relative-Time Consolidation

## Goal

Make one formatter own the relative-time thresholds used by usage and quota
footers in the fresh refork.

## Evidence

`UsageFooter`, `CopilotQuotaFooter`, and `SubscriptionQuotaFooter` each contain
the same timestamp-to-translation logic for seconds, minutes, hours, and days.
The legacy fork already exposes a tested `formatRelativeTime` utility, and the
fresh refork uses the same `usage.*` translation keys.

## Decision

Add `src/utils/usageRelativeTime.ts` and replace all three local implementations
with imports. Preserve the existing function signature and thresholds exactly;
this is an ownership consolidation, not a display-policy change.

## Alternatives

- Keep local copies: rejected because threshold fixes would need three edits and
  can drift.
- Move the helper into one footer component: rejected because it would make
  unrelated UI modules depend on each other.
- Change the threshold policy while consolidating: deferred; this port keeps
  current behavior stable.

## Ownership Boundary

The utility owns only relative-time calculation and translation-key selection.
Each footer retains its data fetching, refresh state, and layout ownership.

## Affected Files

- `src/utils/usageRelativeTime.ts`
- `src/components/UsageFooter.tsx`
- `src/components/CopilotQuotaFooter.tsx`
- `src/components/SubscriptionQuotaFooter.tsx`
- `tests/lib/usageRelativeTime.test.ts`

## Status

- Approval: not-approved (routine consolidation within the user's explicit
  porting request)
- Implementation: complete (2026-10-05)
- Verification: complete (2026-10-05)
- Runtime freshness: not-checked; no rebuilt desktop process requested

## Status Transitions

<!-- Append dated transitions; do not erase prior evidence. -->

2026-10-05: Added the shared formatter and replaced the three local footer
implementations without changing thresholds. `pnpm exec vitest run
tests/lib/usageRelativeTime.test.ts` (7 tests), `pnpm typecheck`, Prettier,
and `git diff --check` passed. Runtime freshness remains not-checked because
no rebuilt desktop process was requested.
