# Routing Activation Brand Port

## Goal

Restore the legacy header feedback that makes a newly activated proxy takeover
visibly distinct without introducing a second proxy-status owner.

## Evidence

The fresh `App.tsx` already owns proxy status and takeover state but rendered a
static brand link. The legacy fork had a focused `RoutingActivationBrand`
component with regression tests for activation transitions and initial-load
behavior.

## Decision

Port the component and its focused tests. Keep activation state in `App.tsx`,
pass the active app as the context key, and suppress the animation until both
status queries have resolved. Keep the existing repository link and color
semantics.

## Alternatives

- Keep the static link: rejected because it loses a useful state transition
  signal already implemented and tested in the legacy fork.
- Reimplement animation inside `App.tsx`: rejected because it would add
  presentation state to the application shell and duplicate the component
  boundary.
- Port the legacy global-loading stack at the same time: deferred because it is
  cross-cutting and has no direct fresh consumer yet.

## Ownership Boundary

`App.tsx` owns proxy/takeover status and readiness. `RoutingActivationBrand`
owns only visual transition state. It performs no IPC, persistence, or proxy
mutation.

## Affected Files

- `src/App.tsx`
- `src/components/proxy/RoutingActivationBrand.tsx`
- `tests/components/RoutingActivationBrand.test.tsx`

## Approval

- status: approved
- source: user instruction to continue the fresh-refork port

## Implementation

- status: implemented
- date: 2026-10-05
- details: added the focused brand component and wired it into `App.tsx` with
  proxy/takeover readiness gating.

## Verification

- status: passed
- date: 2026-10-05
- `pnpm exec vitest run tests/components/RoutingActivationBrand.test.tsx`
  passed (2/2)
- `pnpm typecheck` passed
- targeted Prettier check passed
- `git diff --check` passed
- runtime freshness: not-checked; the desktop app has not been rebuilt and restarted
