# MultiRouter Fetch Draft Boundary

- Date: 2026-10-01
- Approval: approved
- Implementation: implemented
- Verification: partial
- Runtime freshness: not-checked
- Disposition: active
- Requested by / approval reference: User approved the metadata/inclusion fix and explicitly requested that fetch not write automatically.
- Related journal entry: docs/memory/journal.md

## Goal and evidence

The MultiRouter setup wizard fetches provider model inventories on an explicit
user action. The current implementation writes each fetched source provider
immediately, despite the wizard save handler documenting that the draft should
be written only when the user saves. Newly fetched rows also omit `enabled`,
which means the existing `enabled !== false` convention promotes a gateway's
entire `/models` inventory into the active routed catalog.

The follow-up audit found a second producer: even after the draft-only fix,
the wizard still passed the complete upstream response into the merge function.
That made a 486-model OpenRouter response become 486 draft inventory rows.

## Decision

Treat wizard model fetch as draft-only. Do not call the provider persistence API
from the fetch loop. New fetched catalog rows are explicit inventory rows with
`enabled: false`; existing rows retain their user selection and metadata.
Source-provider and MultiRouter-plan persistence happens only at the existing
save boundary. When a provider already has enabled canonical model IDs, pass
those IDs through the typed fetch command and filter the parsed response before
context/reasoning enrichment and IPC. This is a response-scope contract, not a
generic `/models?model=` wire parameter: standard `/models` endpoints do not
promise server-side filtering. An empty selection preserves explicit discovery.

## Alternatives and tradeoffs

- Keep immediate source writes: rejected because it violates the wizard's
  save-only contract and makes cancel/back navigation mutate SQLite.
- Mark fetched rows enabled: rejected because generic gateways commonly return
  hundreds of models and discovery must not imply routing approval.
- Drop fetched rows entirely: rejected because users need the inventory in the
  wizard to explicitly include models later.
- Add a generic query parameter to every upstream `/models` request: rejected
  because OpenAI-compatible gateways do not define a portable filtering query.

## Ownership and affected areas

- `src/lib/codexMultiRouterWizard.ts`
- `src/components/codex/CodexMultiRouterWizard.tsx`
- `src/lib/codexMultiRouterWizard.test.ts`
- `tests/components/CodexMultiRouterWizard.test.tsx`
- `src/lib/api/model-fetch.ts`
- `src-tauri/src/commands/model_fetch.rs`
- `src-tauri/src/services/model_fetch.rs`

## Verification

- `pnpm exec vitest run src/lib/codexMultiRouterWizard.test.ts --reporter=verbose` — 21/21 passed.
- `pnpm exec vitest run tests/components/CodexMultiRouterWizard.test.tsx --reporter=dot` — 37/37 passed.
- `pnpm exec vitest run src/lib/codexMultiRouterWizard.test.ts tests/components/CodexMultiRouterWizard.test.tsx --reporter=dot` — 58/58 passed.
- `pnpm typecheck` — passed.
- `git diff --check` — passed.
- `cargo test --manifest-path src-tauri/Cargo.toml codex_multirouter::compiler::tests --lib` — 28/28 passed.
- `cargo test --manifest-path src-tauri/Cargo.toml codex_multirouter::projection::tests --lib` — 19/19 passed.
- `cargo test --manifest-path src-tauri/Cargo.toml services::model_fetch::tests --lib` — 54/54 passed, including requested-ID filtering and OpenRouter reasoning metadata tests.
- `cargo test --manifest-path src-tauri/Cargo.toml services::provider::tests --lib` — 53 passed, 10 blocked by the live `CODEX_DESKTOP_ACTIVE` guard because Codex Desktop process 33440 is running.

## Open approval or runtime gaps

The normal `pnpm dev` process must be restarted by the user before live UI
freshness can be verified.

The provider-service result is partial rather than a pass: the blocked tests
exercise guarded mutations that cannot run while Codex Desktop is active.
Full final-suite verification remains outstanding.

## Status history (append-only)

- 2026-10-01: Approved and implementation started from the user's explicit
  request to stop automatic fetch/write behavior and preserve accurate model
  inclusion semantics.
- 2026-10-01: Implemented the draft-only fetch boundary, explicit disabled
  inventory rows, and route generation that emits `include` when disabled
  inventory exists. Focused frontend and MultiRouter/model-fetch Rust tests
  passed; provider-service verification is partial because Codex Desktop is
  running and blocks guarded mutations.
