# Codex input capability port

## Goal

Restore the legacy Codex catalog input-capability safeguards in the fresh
refork while keeping one owner for catalog reconciliation and one owner for
input-capability semantics.

## Evidence

The legacy fork has a dedicated `codexInputCapability.ts` contract that reads
camelCase and snake_case declarations, preserves modalities beyond text/image,
detects contradictory declarations as unknown, and hydrates missing metadata
only from unambiguous maintained or saved catalog references. The fresh refork
currently duplicates a boolean-only patch and image detector inside
`CodexFormFields.tsx`; that loses extra modalities and can silently interpret
contradictory declarations.

## Decision

Port the dedicated helper into the refork and make the form use it for state
resolution, user patches, preset restoration, and external catalog hydration.
Expose the existing maintained/saved Codex catalog inventory through an
optional `knownCatalogModels` prop. Keep remote model merging in
`codexCatalogReconciliation.ts`; the capability helper will not own fetching,
identity reconciliation, or persistence.

## Alternatives

- Keep the local boolean helpers: rejected because they duplicate the legacy
  contract and discard non-image modalities.
- Copy the legacy viewport or catalog sync layer: deferred; the refork's
  simpler catalog UI and centralized reconciliation are separate owners.
- Make contradictory declarations prefer a preset: rejected because explicit
  conflicting metadata must remain visible and unknown for user review.

## Approval / implementation / verification

- Approval: user-approved fresh-refork migration; no separate approval was
  required for this scoped compatibility port.
- Implementation: in progress (2026-10-05).
- Verification: pending targeted Vitest tests, `pnpm typecheck`, formatting,
  and `git diff --check`.
- Runtime freshness: not checked; a rebuilt and restarted refork app is
  required for live UI verification.
