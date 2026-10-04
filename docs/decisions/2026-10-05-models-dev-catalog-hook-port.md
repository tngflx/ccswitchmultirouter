# Models.dev Catalog Hook Port

## Goal

Remove duplicated models.dev catalog query and filtering logic from the fresh
refork's auto-sync and manual picker dialogs while preserving each caller's
visible-row limits and the picker's lazy loading behavior.

## Evidence

`ModelsDevAutoSyncPanel` and `ModelsDevPickerDialog` each independently own the
same query key, fetch function, flattening, provider extraction, search/filter
matching, and bounded visible rows. The legacy fork already has focused tests
for a reusable `useModelsDevCatalog` hook. The fresh refork's pricing parser
(`src/lib/modelsDevPricing.ts`) is compatible, so only the reusable query/view
boundary needs to be adapted.

## Decision

Add `src/hooks/useModelsDevCatalog.ts` as the single owner for catalog loading,
provider sorting, filtering, and row limits. Keep `defaultRows` and `maxRows`
as caller parameters because auto-sync and manual import intentionally expose
different amounts of the catalog. Keep common-model selection and import/save
state in the consuming dialogs. Use the existing `models-dev-pricing` query
key so both dialogs share the TanStack Query cache, and preserve `enabled` for
the picker so closed dialogs do not fetch.

## Alternatives

- Copy the legacy dialogs wholesale: rejected because it would replace fresh
  UI ownership and reintroduce unrelated legacy behavior.
- Add a single fixed row limit: rejected because the two workflows have
  different interaction needs.
- Keep the duplicated local queries: rejected because it leaves two owners for
  the same cache and filtering contract.

## Ownership Boundary

The hook owns catalog retrieval and derived catalog views. Dialogs own workflow
state, selection semantics, translations, and mutations. No new persistence or
IPC boundary is introduced.

## Affected Files

- `src/hooks/useModelsDevCatalog.ts`
- `src/components/usage/ModelsDevAutoSyncPanel.tsx`
- `src/components/usage/ModelsDevPickerDialog.tsx`
- `tests/hooks/useModelsDevCatalog.test.tsx`

## Status

- Approval: not-approved (routine consolidation within the user's explicit
  porting request)
- Implementation: complete (2026-10-05)
- Verification: complete (2026-10-05)
- Runtime freshness: not-checked; no rebuilt desktop process requested

## Status Transitions

<!-- Append dated transitions; do not erase prior evidence. -->

2026-10-05: Added the shared catalog hook, adapted both dialogs to use it,
and ported focused cache/filter/row-limit tests. Targeted component and hook
tests passed; `pnpm typecheck` and Prettier checks passed. Runtime freshness
remains not-checked because no rebuilt desktop process was requested.
