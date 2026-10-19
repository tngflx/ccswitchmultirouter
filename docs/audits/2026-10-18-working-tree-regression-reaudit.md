# Working-Tree Regression Re-Audit, 2026-10-18

## Scope

Reviewed the complete tracked diff and the new Desktop runtime resources,
OpenCode fetched-model helper, and associated regression tests. The starting
worktree contained 39 changed tracked files plus untracked resources, tests,
and audit records. Existing unrelated work was retained.

The review covered catalog publication/readback, provider discovery and
metadata normalization, provider form persistence, V2 routing and reasoning
preferences, Desktop injection/release/reinstallation, history compatibility,
Request Health persistence, and test isolation.

The earlier projection correction remains necessary: manual resync and normal
takeover must use the same compiled-router projection contract. This review
does not treat that single correction as proof that the other changes are
regression-free.

## Reproduced Findings

### Provider Metadata Boundaries

1. Unknown OpenCode API paths compared equal because both scope lookups
   returned `None`. Unknown paths could inherit trusted catalog facts from
   another unknown path. Matching now requires two recognized, equal scopes;
   URL discovery and metadata matching share the same scope enumeration.
2. A namespaced suffix encountered before an exact model without context could
   supply its context window. The new exact-identity flag did not invalidate
   an earlier suffix candidate. Exact identity now blocks suffix fallback
   regardless of inventory order.
3. OpenRouter's special off-by-default interpretation removed a generic
   provider's valid explicit `none` default. That interpretation is now scoped
   to the OpenRouter contract; generic declarations retain their default.

All three new Rust regressions failed before their corrections.

### OpenCode Editing And Refresh

4. An explicit empty fetched input-modality array was treated as absent,
   retaining stale text/audio support from the same model. Empty declarations
   now replace the old input array while preserving unrelated output facts.
5. The fetched-model validator rejected a valid graded declaration containing
   `none`, dropping its entire reasoning configuration. It now accepts `none`
   only when disabling is explicitly allowed. A separate negative assertion
   retains the guard for declarations that forbid disabling.
6. An explicit parallel-tool declaration could coexist with conflicting stale
   option aliases, including nested body options. For a supported SDK binding,
   the old parallel-tool options are removed before its known spelling is
   applied. Unrelated options remain intact.
7. Rejecting a duplicate manual model ID left the input displaying the rejected
   value. The replacement helper now reports rejection to the input so it
   restores the actual model ID without overwriting either model.

All four new frontend regressions failed before their corrections.

### Desktop Background Work

8. History refresh was made nonblocking, but its rejection handler still
   rethrew into an unobserved promise. An executable QuickJS regression of the
   actual assembled runtime observed one unhandled rejection. The optional
   task now records the failure and clears its retry state without rethrowing.
   The same test verifies that the picker heartbeat remains installed and a
   subsequent discovery pass retries successfully.

9. A paused old renderer discovery could resume after a replacement runtime
   finished and overwrite its request hook with the old content fingerprint.
   The assembled-runtime regression failed with `old-runtime` instead of
   `new-runtime`. Superseded DOM/object/scope discovery now stops before
   publishing hooks or caches. Promise cleanup checks ownership so an old job
   cannot clear a newer job. Every installation starts its own scheduler and
   discovery jobs; existing same-fingerprint request hooks remain reusable.

The lifecycle regression also repeats installation with the same fingerprint
and verifies an actual mocked `model/list` response still receives the managed
model. A second discovery test covers a scope scan superseded at an idle yield,
before it can publish a query cache or replace the retained scope.

## Reviewed Invariants

- Valid empty canonical catalogs remain authoritative; excluded models do not
  enter routed pickers or candidates.
- Managed catalog read failures preserve existing renderer state. Unmanaged
  release remains distinct from an intentionally empty managed catalog.
- Compiled-router writer profiles are normalized at the shared boundary;
  standalone providers keep their profile selection and model transport
  policy remains provider-derived.
- Provider declarations remain credential-free and bound to their endpoint
  and upstream model. Explicit negative evidence is not promoted to readiness.
- Native cache restoration preserves valid official bytes and backfills only
  missing parser-required instruction sources for legacy rows.
- Codex-only Ultra orchestration is not persisted as a provider-native default.
- Dedicated Request Health writes remain serialized with General saves and
  acknowledge only their canonical fields, preserving unrelated drafts.
- Automatic Desktop side effects remain disabled in isolated tests. No tests
  were permitted to substitute live UI/CDP activity for isolated verification.

Formatting-normalized comparisons confirmed that continuation, payload
selection, model-list scope, Guardian compatibility, history-lineage hydration,
warning UI, and summary handoff were relocations/extractions without behavioral
changes. The request marker, query-cache/prototype lifecycle, picker core,
client discovery, and renderer scheduler changes received separate review.

## Verification

Final complete runs after all nine corrections:

- `pnpm typecheck`: passed.
- `pnpm catalog:verify`: passed guards and all 393 catalog tests.
- `pnpm test:unit --reporter=dot --silent`: 2,424 passed across 258 files.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib -- --test-threads=4 --quiet`:
  4,851 passed, zero failed, 10 existing ignored tests.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib reaudit_ -- --test-threads=4`:
  all five focused Rust regressions passed.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib codex_multirouter::`:
  all 153 passed.
- `pnpm format:check`: passed after formatting the earlier resync assertion.
- `cargo fmt --check --manifest-path src-tauri/Cargo.toml`: passed.
- `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`: passed.
- `pnpm build:renderer`: passed the catalog gate and production renderer build.
- Explicit Prettier checks for the new audit and changed frontend test files:
  passed.
- `git diff --check`: passed.

Each of the nine findings has a regression observed failing before its
correction and passing afterward. The final suites also cover the additional
negative-disable guard and superseded scope-discovery case. Existing
Node/React warnings, test-only Rust warnings, and non-fatal renderer
dependency/import/bundle warnings were not suppressed. No timeout, assertion,
or build gate was relaxed.

## Limits

This is source and isolated-test verification, not a live provider or installed
application audit. No native application executable was rebuilt or installed,
no running app was restarted, and no user configuration was manually changed.
The configured live monitor was unavailable; no UI automation or direct live
CDP injection was substituted.

These checks reduce regression risk for the reviewed workflows. They do not
establish that every possible workflow or external provider is defect-free.
