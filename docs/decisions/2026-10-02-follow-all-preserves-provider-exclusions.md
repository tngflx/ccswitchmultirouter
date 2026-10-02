# Follow All Preserves Provider Exclusions

- Date: 2026-10-02
- Approval: approved
- Implementation: implemented
- Verification: passed
- Runtime freshness: not-checked
- Disposition: active
- Requested by / approval reference: User: "confirm just fucking fix it then!!!"
- Related journal entry: docs/memory/journal.md

## Goal and evidence

The Codex MultiRouter wizard's "Follow all models" action re-enabled every
persisted catalog row, including rows deliberately disabled in ProviderForm.
The screenshot showed 98 kept models out of a 585-row catalog, and the handler
converted all 585 raw rows to `enabled: true` before switching to automatic
follow mode.

## Decision

Make "Follow all models" switch the route to automatic follow mode without
mutating provider catalog rows. Automatic follow will therefore include only
models whose ProviderForm catalog row is currently enabled.

## Alternatives and tradeoffs

- Re-enable every catalog row: rejected because it destroys explicit ProviderForm exclusions.
- Rename the existing behavior to indicate re-enabling: rejected because the
  requested workflow is to follow the currently enabled provider catalog.

## Ownership and affected areas

- `src/components/codex/CodexMultiRouterWizard.tsx`: follow-all handler.
- `tests/components/CodexMultiRouterWizard.test.tsx`: regression coverage.

## Verification

- `pnpm vitest run tests/components/CodexMultiRouterWizard.test.tsx -t
  "preserves disabled source rows when following all models"`: passed (1/1).
- `pnpm vitest run tests/components/CodexMultiRouterWizard.test.tsx
  src/lib/codexMultiRouterWizard.test.ts`: passed (66/66).
- `pnpm typecheck`: passed.

## Open approval or runtime gaps

Live runtime freshness requires restarting the user's normal `pnpm dev` process
after the source change.

## Status history (append-only)

- 2026-10-02: User explicitly approved implementation after diagnosis.
- 2026-10-02: Removed catalog-row mutation from the follow-all handler and
  updated the regression test; focused Vitest suites and typecheck passed.
