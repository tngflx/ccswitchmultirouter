# Model-specific key-group editor port

## Goal

Restore the legacy fork's per-key-group model discovery and prefix targeting in
the fresh refork without creating a second catalog or credential-routing owner.

## Evidence

The fresh `CodexFormFields` owns grouped credentials and the shared catalog
reconciliation helper, but its inline group editor only edits exact model IDs.
The legacy fork adds a reusable `CodexKeyGroupModels` editor that fetches models
for the group's keys, deduplicates results, and supports exact models plus
prefixes. The fresh `CodexApiKeyGroup` type and `fetchModelsForConfig` API are
compatible with that behavior.

## Decision

Port the reusable group editor and connect its successful fetch to the existing
fresh catalog reconciliation helper. Keep group mutation in `CodexFormFields`
and keep catalog persistence in the existing `catalogRows` state owner. Do not
introduce another fetch cache, routing resolver, or catalog store.

## Alternatives

- Copy the legacy `CodexFormFields` wholesale: rejected because it would
  reintroduce legacy lifecycle and catalog ownership into the fresh form.
- Keep the inline exact-model input: rejected because it loses prefix targeting
  and per-group model discovery.
- Add a second catalog merge path: rejected because reconciliation already has a
  single owner in `mergeFetchedModelsIntoCatalogRows`.

## Approval / implementation / verification

- Approval: user-approved fresh-refork migration; no separate approval was
  required for this focused compatibility slice.
- Implementation: complete. Added `CodexKeyGroupModels` and wired it into the
  fresh `CodexFormFields` catalog reconciliation owner.
- Verification: `pnpm exec vitest run
  src/components/providers/forms/CodexKeyGroupModels.test.tsx` (5 passed),
  `pnpm typecheck`, `pnpm exec prettier --check` on all changed files, and
  `git diff --check` passed.
- Runtime freshness: not checked; no rebuilt desktop process was requested.
