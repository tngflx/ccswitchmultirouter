# Codex Catalog Reconciliation Port

## Goal

Adapt the legacy fork's safe model-list reconciliation behavior to the fresh
BigStrongSun Provider form without introducing a second catalog owner.

## Evidence

The refork already owns Codex model fetching and persistence in
`CodexFormFields.tsx`, but its merge helper compares only one visible/upstream
string, always appends fetched rows, and can overwrite discovered metadata on
subsequent refreshes. The legacy implementation has a tested identity-aware
reconciliation contract that preserves disabled rows and avoids mass deletion
after truncated responses.

## Decision

Add a standalone `reconcileFetchedCodexCatalogRows` utility under `src/lib/`
and make the existing Codex form merge helper delegate to it. The utility owns
identity matching and conservative metadata hydration; the form remains the
owner of row state, user inclusion, and persistence. No background refresh hook
or second persistence path is added in this slice.

## Alternatives

- Copy the legacy Codex form and related components: rejected because it would
  create duplicate UI and save ownership.
- Keep the current inline merge: rejected because it cannot preserve the
  remote/manual distinction or stable aliases.
- Add automatic refresh now: deferred; it is a separate lifecycle concern and
  will be audited after this focused contract is verified.

## Approval / Implementation / Verification

- Approval: user-approved fresh-refork migration (2026-10-03 conversation).
- Implementation: complete for the pure reconciliation contract; automatic refresh
  lifecycle remains a separate deferred slice.
- Verification: `pnpm typecheck`,
  `pnpm exec vitest run src/lib/codexCatalogReconciliation.test.ts`, and
  `git diff --check` passed on 2026-10-03.
- Runtime freshness: not checked; no rebuilt desktop process was requested.

## Ownership

`CodexFormFields.tsx` owns state and persistence. `codexCatalogReconciliation.ts`
owns pure identity and metadata reconciliation only.
