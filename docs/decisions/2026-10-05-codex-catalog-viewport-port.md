# Codex Catalog Viewport Port

## Goal

Bound Codex catalog rendering and reasoning-capability resolution to the
visible catalog page while preserving the refork's existing row-edit,
selection, disabled-inventory, protocol-override, and input-capability
semantics.

## Evidence

The fresh refork rendered every catalog row directly in both the reasoning
editor and the catalog editor. The legacy fork had a tested viewport with
stable row IDs, explicit expansion, ten-row pagination, and a visible-items
callback. Large catalogs therefore performed unnecessary DOM work and
resolved reasoning for every row.

## Decision

Adapt the viewport as a shared renderer in the fresh forms architecture. Use
it in both catalog sections and resolve reasoning only for the rows reported
as visible. Keep catalog reconciliation, persistence, row mutation, protocol
override migration, and input-capability metadata in their existing fresh
owners.

## Alternatives

- Keep direct `catalogRows.map` rendering: rejected because a 431-model
  catalog creates avoidable DOM work and reasoning requests.
- Copy the legacy `CodexFormFields` wholesale: rejected because it would
  reintroduce legacy filtering and ownership boundaries into the refork.
- Add a second virtualization library: deferred; fixed-page rendering is the
  established local behavior and is sufficient for the current catalog size.

## Ownership Boundary

`CodexCatalogViewport` owns page selection, explicit row expansion, and the
visible-items callback. `CodexFormFields` owns catalog data, mutations,
selection semantics, persistence callbacks, and reasoning resolution.

## Affected Files

- `src/components/providers/forms/CodexCatalogViewport.tsx`
- `src/components/providers/forms/CodexFormFields.tsx`
- `tests/components/CodexCatalogViewport.test.tsx`

## Approval

- status: approved
- source: user instruction to continue the fresh-refork port

## Implementation

- status: implemented
- date: 2026-10-05
- details: added the shared viewport, wrapped both Codex catalog surfaces, and
  limited reasoning resolution to visible rows.

## Verification

- status: pending
- date: 2026-10-05
- runtime freshness: not-checked; the desktop app has not been rebuilt and restarted
