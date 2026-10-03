# Adapt MultiRouter Model Identity Matching

- Date: 2026-10-03
- Approval: approved
- Implementation: in-progress
- Verification: not-run
- Runtime freshness: not-checked
- Disposition: active
- Requested by / approval reference: User instruction to port distinctive legacy behavior into the fresh BigStrongSun refork and make it the eventual foundation.
- Parent decision: `docs/decisions/2026-10-03-bigstrongsun-refork-foundation.md`

## Goal and evidence

The fresh refork already owns MultiRouter catalog refresh, route projection, and
route editing, but several boundaries compared only one visible model string or
one upstream field. The legacy reference fix demonstrates that visible aliases,
upstream bindings, canonical slugs, and aliases must share one normalized
identity contract or refreshes and fixed route selections can disagree.

## Decision

Add one TypeScript identity helper and adapt the existing fresh refresh,
projection, sync-summary, alias-validation, and picker-selection boundaries to
consume it. Preserve the fresh refork's fixed `include` whitelist semantics and
its explicit disabled-row behavior. Do not copy the legacy workspace or create a
second catalog owner.

## Alternatives and tradeoffs

- Copy the legacy workspace implementation: rejected because it would duplicate
  the fresh refork's provider-set and projection ownership.
- Match only `model` and `upstreamModel`: rejected because canonical slugs and
  aliases are already persisted by provider/catalog integrations.
- Convert fixed selections to `all`: rejected because it silently re-enables
  models users excluded.

## Ownership and affected files

- `src/lib/modelIdentities.ts`: normalized identity and binding contract.
- `src/lib/codexMultiRouterWizard.ts`: wizard refresh and selection matching.
- `src/components/codex/CodexRouterWorkspacePage.tsx`: catalog refresh,
  projection, route sync, alias validation, and picker state.
- `src/types.ts`: catalog identity metadata compatibility fields.
- Focused Vitest regression suites for the helper and workspace refresh.

## Verification plan

Run the helper/workspace/wizard Vitest suites, `pnpm typecheck`, Prettier on
changed files, `git diff --check`, and `cargo check`. Full suites remain reserved
for the final migration boundary.

## Status history

- 2026-10-03: decision recorded before implementation; approval is covered by
  the user's explicit fresh-refork migration instruction.
- 2026-10-03: implementation verified; `pnpm typecheck`, 104 focused Vitest
  tests, Prettier check, `git diff --check`, and `cargo check` passed. Runtime
  freshness was not checked because no rebuilt desktop process was requested.
