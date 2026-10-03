# Auto Model Refresh Port

## Goal

Restore the fork-specific shared model refresh primitive in the fresh refork
without creating a second owner for provider form fetching.

## Evidence

- The legacy checkout contains `useAutoModelRefresh`, credential-scoped cache
  keys, in-flight request deduplication, invalidation epochs, and local-storage
  snapshots for non-destructive model-list diff reporting.
- The fresh refork has independent manual fetch handlers but no equivalent
  shared cache or deduplication utility.
- The legacy hook is consumed by specialized form callers and is not wired
  through the common `ProviderForm`, so blindly copying all legacy form edits
  would add stale or duplicate ownership.

## Decision

Port the hook and its pure helper behavior as a shared utility. Keep provider
  forms as the owners of fetched model state for this slice; later integrations
  must opt in through existing props and preserve the single fetch/state owner.
  Empty fetches must never report removals, and invalidation must prevent stale
  requests from repopulating the cache or UI.

## Alternatives

- Copy every legacy form change: rejected because the fresh forms have a
  different architecture and would gain duplicate fetch/state paths.
- Defer the utility entirely: rejected because it would leave the known
  stale-result and duplicate-request behavior unaddressed for future callers.

## Ownership Boundary

`src/hooks/useAutoModelRefresh.ts` owns cache, deduplication, invalidation, and
snapshot diff mechanics. Provider forms remain responsible for fetch endpoints,
loading state, user notifications, and applying fetched models.

## Approval / Implementation / Verification / Runtime

- Approval: approved by the user's fresh-refork migration request; no separate
  approval pause required for this reversible utility port.
- Implementation: complete in `src/hooks/useAutoModelRefresh.ts` with focused
  regression coverage in `tests/hooks/useAutoModelRefresh.test.tsx`.
- Verification: `pnpm exec vitest run tests/hooks/useAutoModelRefresh.test.tsx`
  (4 passed), `pnpm typecheck`, Prettier checks for both new files, and
  `git diff --check` passed.
- Runtime freshness: not checked
