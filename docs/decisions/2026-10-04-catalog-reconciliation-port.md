# Catalog reconciliation port

## Goal

Restore the legacy Codex catalog synchronization safeguards in the fresh
refork without retaining two reconciliation implementations.

## Evidence

The legacy fork's `codexCatalogSync.ts` handles binding-aware identity matching,
context-window inference, normalization, metadata refresh, and conservative
authoritative removal. The fresh refork already has a shared
`codexCatalogReconciliation.ts` consumed by the Codex form, but its current
implementation only merges inventory and does not own removal or context
inference. The BigStrongSun and original repository histories both treat model
catalog identity and generated catalog shape as cross-layer contracts.

## Decision

Extend `src/lib/codexCatalogReconciliation.ts` with the missing safeguards and
make the existing form-path module a thin re-export compatibility shim. Keep
normalization in the existing catalog schema owner, identity matching in
`modelIdentities.ts`, and context inference in `codexModelContext.ts`. Add
focused tests for alias binding, metadata refresh, safe removal, and truncated
response suppression.

## Alternatives

- Copy the legacy form helper into the fresh form: rejected because it would
  leave duplicate reconciliation owners.
- Remove remote rows unconditionally: rejected because partial `/models`
  responses can otherwise delete user-visible catalog entries.

## Approval / implementation / verification

- Approval: user-approved fresh-refork migration; no separate approval was
  required for this scoped compatibility port.
- Implementation: complete (2026-10-04). Central reconciliation now owns
  identity binding, normalization, context inference, capability hydration,
  metadata modes, and conservative missing-row removal. The form-path helper
  is a re-export shim only.
- Verification: complete (2026-10-04). The focused reconciliation Vitest file
  passed 6 tests, `pnpm typecheck` passed, and `git diff --check` passed.
- Runtime freshness: not checked; no rebuilt desktop process was requested.
