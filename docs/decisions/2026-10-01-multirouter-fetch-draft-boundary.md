# MultiRouter Fetch Draft Boundary

- Date: 2026-10-01
- Approval: approved
- Implementation: implemented
- Verification: verified
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

The live recheck then found a third, separate producer: `CodexFormFields`'
automatic metadata refresh called the same fetch API without the persisted
ProviderForm catalog IDs. The wizard-side filter therefore could not constrain
that path, and the ProviderForm catalog still displayed the full upstream
inventory during automatic refresh.

## Decision

Treat wizard model fetch as draft-only. Do not call the provider persistence API
from the fetch loop. New fetched catalog rows are explicit inventory rows with
`enabled: false`; existing rows retain their user selection and metadata.
Source-provider and MultiRouter-plan persistence happens only at the existing
save boundary. When a provider already has enabled canonical model IDs, pass
those IDs through the typed fetch command and filter the parsed response before
context/reasoning enrichment and IPC. This is a response-scope contract, not a
generic `/models?model=` wire parameter: standard `/models` endpoints do not
promise server-side filtering. The ProviderForm automatic standard-provider
refresh now passes every persisted catalog binding, including disabled rows
used as refresh tombstones; an empty catalog preserves unrestricted bootstrap
discovery. The separate manual “Sync Models” action remains unrestricted and
continues to discover inventory by explicit user action. OAuth catalog endpoints
remain authoritative for their own provider-specific inventory.

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
- `src/components/providers/forms/CodexFormFields.tsx`
- `tests/components/CodexFormFields.test.tsx`

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
- `pnpm exec vitest run tests/components/CodexFormFields.test.tsx --reporter=dot` — 74/74 passed, including alias, disabled-tombstone, and empty-catalog automatic-refresh cases.
- `cargo check --manifest-path src-tauri/Cargo.toml` — passed.
- `git diff --check` — passed.

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
- 2026-10-02: User reported that automatic wizard refresh still showed the
  full upstream inventory (for example, a 6-row ProviderForm catalog becoming
  21/30 fetched rows). Approval: the user's request to fetch only the model
  catalog passed from ProviderForm. Implementation: standard automatic
  fetches now use every persisted catalog upstream identity, including
  disabled tombstones; an empty catalog still permits bootstrap discovery.
  The separate OAuth catalog endpoint remains authoritative and may append
  newly published official models. Verification is pending.
- 2026-10-02: Focused verification completed after the catalog-boundary
  regression fixture was corrected: frontend wizard tests passed 61/61,
  Rust model-fetch tests passed 54/54, `pnpm typecheck`, targeted Prettier,
  and `git diff --check` passed. Full suites remain deferred until the final
  verification boundary, and runtime freshness is still not-checked because
  the user must restart the normal `pnpm dev` process.
- 2026-10-02: Final verification completed. The affected frontend files passed
  178/178 focused tests; the full frontend suite passed 198 files / 1,678
  tests; `cargo check --manifest-path src-tauri/Cargo.toml` passed. The full
  Rust suite could not start because the normal target binary was locked by the
  running app (`failed to remove ...\\src-tauri\\target\\debug\\cc-switch.exe`;
  `Access is denied`, OS error 5). No alternate target was created and no
  process was killed. Runtime freshness remains unverified until the user
  stops and restarts the normal `pnpm dev` process.
- 2026-10-02: Correction: the prior wizard-side catalog boundary did not cover
  the separate `CodexFormFields` automatic refresh producer. The source fix now
  derives request IDs from all persisted ProviderForm bindings, preserves the
  unrestricted empty-catalog bootstrap, and leaves manual inventory sync
  unchanged. The focused ProviderForm suite passed 74/74, model-fetch Rust
  tests passed 54/54, `pnpm typecheck`, `cargo check`, and `git diff --check`
  passed. Runtime freshness remains not-checked until the user restarts the
  normal `pnpm dev` process.

## 2026-10-02 Catalogue-scope correction

The prior statements endorsing disabled rows as automatic refresh targets are
superseded. Disabled rows are retained for persistence and editing, not requested
as part of the active ProviderForm catalogue. The user's exact request was to
retrieve "just model catalogues that's passed from ... providerform".

The wizard also reported the raw inventory size after refresh (21/30 rows)
instead of the active catalogue size (6 rows). Fix both boundaries: automatic
standard-provider requests use enabled upstream bindings; a nonempty saved
catalogue does not append unsolicited response models; refresh card counts and
diffs describe the enabled catalogue. Preserve disabled rows in source storage
and keep manual Sync Models discovery and official OAuth behavior unchanged.
The all-disabled nonempty-catalogue case requires explicit user approval and
is not yet changed by this correction.

Reference audit: fetched both verified reference remotes on 2026-10-02,
reviewed recent commits and 50 open/closed PRs from each repository.
`BigStrongSun/ccswitchmulti` at `b4741adea` uses active wizard catalogue counts
and `preserveExistingSelection: true` for standard-provider merges without
forcing append; adapt that invariant, not its complete component. Original
`farion1231/cc-switch` at `b9e962026` has manual model discovery but no matching
MultiRouter automatic catalogue ownership boundary. Header-override PRs
7759/7760 do not solve this scope regression and are deferred.

- Approval: approved for the named catalogue-only regression fix.
- Implementation: in-progress.
- Verification: partial; inherited focused run passed 4 files / 252 tests,
  but did not exercise the misleading raw-inventory count.
- Runtime freshness: not-checked for this correction.

- 2026-10-02: Append-only correction of the disabled-tombstone decision above;
  preserve its original evidence, which was insufficient to prove the intended
  catalogue-only behavior. A live read-only capture at 15:16 showed 21/30 model
  counts alongside 6-model catalogues; this does not establish request contents.

## 2026-10-02 Automatic request identity correction

ProviderForm's automatic request now has a response scope, but its in-flight
cache and observation snapshot still identify only the endpoint/credentials.
Changing enabled upstream bindings can therefore reuse an older request, and
an unrestricted manual-sync snapshot can be compared against a scoped automatic
response as if models disappeared upstream.

Keep request IDs, in-flight identity, availability evidence, and membership
snapshots bound to the same immutable enabled-upstream scope. Sort and deduplicate
scope IDs so order, local aliases, and metadata-only hydration do not refetch.
Keep manual discovery snapshots and authoritative xAI OAuth discovery unchanged;
do not compare unrestricted discovery with a scoped refresh. Do not migrate or
clear old snapshots: they remain valid only for their original scope.

This is part of the user's named catalogue-only regression fix, not permission
to change the pending all-disabled case. Neither reference main contains an
equivalent scoped automatic ProviderForm request/cache contract to port.
Regression coverage will exercise changing scope in flight, unrelated manual
snapshots, and stable identity under metadata hydration.

- 2026-10-02: Implementation in-progress; add reproductions before changing the
  producer. The inherited pending frontend run completed: 6 files / 272 tests
  passed. Runtime freshness remains not-checked; earlier captures establish
  displayed counts only, not exact request contents.
- 2026-10-02: Scoped enabled-binding request/cache/snapshot identities and
  active-catalogue counts are implemented. A focused frontend run passed
  6 files / 317 tests, including scope changes while a request is in flight,
  separation from manual discovery snapshots, metadata-only identity stability,
  and six active models with 24 preserved disabled rows. `pnpm typecheck`, the
  targeted Prettier recheck, and `git diff --check` passed. This does not resolve
  the pending all-disabled behavior decision, prove upstream wire filtering,
  or establish live exact request contents. Standard `/models` still downloads
  the endpoint response; the owned response/IPC scope is filtered.
