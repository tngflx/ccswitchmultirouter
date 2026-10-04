# Codex catalog version-pruning port

## Goal

Restore the legacy Codex catalog reset behavior in the fresh refork without
duplicating catalog reconciliation or moving compiler responsibilities into a
form component.

## Evidence

The legacy fork keeps the newest recognized release per model branch, keeps
GPT codenames and specialized offerings independent, compares dated snapshots
only within the same release identity/date width, and preserves unknown model
aliases. The fresh refork already owns route catalog projection in
`CodexRouterWorkspacePage.tsx`; its model-order reset currently consumes that
projection without pruning.

## Decision

Port the release parser and pruning decision into a pure shared utility under
`src/lib/`. Add an optional `pruneOutdatedModels` compiler option and apply it
only when the user explicitly resets model order. Keep ordinary projections,
remote reconciliation, and provider catalog persistence unchanged. The utility
will preserve object identity and input order and will not mutate its inputs.

## Alternatives

- Copy the legacy helper into `components/providers/forms`: rejected because
  version pruning belongs to route projection, not form state or fetch
  reconciliation.
- Prune every projection automatically: rejected because it would silently
  remove user-visible catalog choices and change existing routing behavior.
- Reimplement parsing inside the compiler: rejected because it would create a
  second, untestable parsing owner.

## Approval / implementation / verification

- Approval: user-approved fresh-refork migration; no separate approval was
  required for this scoped compatibility port.
- Implementation: completed (2026-10-05). The pruning utility and explicit
  model-order-reset integration were added without creating a second catalog
  reconciliation owner.
- Verification: targeted pruning/compiler tests, `pnpm typecheck`, formatting,
  and `git diff --check` passed (2026-10-05).
- Runtime freshness: not checked; a rebuilt and restarted refork app is
  required for live UI verification.

### Status transition (2026-10-05)

Implementation moved from in progress to completed after the focused tests and
static checks passed. Runtime freshness remains not checked by design until the
normal refork development process is rebuilt and restarted.
