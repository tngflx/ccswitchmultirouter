# Codex Picker Boundary Review, 2026-10-19

## Accountability And Scope

The previous scope-sync change was insufficiently validated. Its tests proved
that a graded model could recover Max, but did not exercise that restoration
against a mixed inventory containing models with no efforts. It also tested
multiple scopes without testing hundreds of aliases of one cache.

The earlier empty-descriptor normalization removed supportedReasoningEfforts
entirely. Once the broader discovery reached more model selectors, a native
select could throw before the post-filter restoration ran. A successful raw
query or a matching payload fingerprint could not detect that failure.

The subsequent correction in model_picker_core.js is retained: every projected
row exposes an effort array, and the managed native-selector boundary supplies
an empty array for missing fields before native code runs. No effort or default
is invented for models whose canonical declaration is empty.

This review changes tests and the catalog build gate only. It does not change
runtime resources, Rust code, provider state, preferences, or installed binaries,
and does not restart or inject into any application.

## Added Acceptance Coverage

- The mixed graded/no-effort regression checks both native filter and some
  reads, successful observers, all six declared efforts, Max/Ultra aggregate
  flags, and an empty array without an invented default for the plain model.
- Both the fixture and actual structurally shared cache value are frozen.
  The managed projection must leave the cached input unchanged and avoid
  unnecessary selected-result replacements over repeated patch passes.
- A mixed inventory is carried through reinjection, native release/refetch,
  and reactivation under a different provider. The new provider's current
  efforts replace the earlier list rather than inheriting Ultra.
- A 691-scope fixture verifies one shared-cache patch per discovery pass,
  one getter read per discovered alias, and one retained representative in
  the current registry-free discovery case. Five later passes remain bounded.

Both desktop picker test files are now included in
scripts/verify-codex-catalog.mjs. The existing build:renderer path therefore
executes these acceptance tests instead of leaving them to an optional focused
or full-unit run. No existing check or assertion is removed.

## Separate Open Finding

Independent read-only review reproduced a narrower request-registry ownership
gap in client_discovery.js. Two dependency scopes can share one query client
while resolving different local request managers. Deduplicating retained scopes
by query-client identity discards the second scope. If its request client is
replaced, the next discovery call can miss that replacement until a full scan
after the 30-second retained-scope interval.

Reproduction output:

    initial: patched [first, second], retained scopeCount 1
    after second manager replacement: patched [first], missedSecond true

Relevant boundaries: deduplication at lines 286-290, registry resolution at
299-314, retained-state publication at 320-321, and reuse at 167-176.

This is a source-level P2 replacement gap, not evidence that this topology
exists in the current renderer and not the evidenced cause of the native-select
crash. It is not repaired in this review. A future correction must retain
independent registry ownership while deduplicating cache work; simply restoring
hundreds of cache patches would reintroduce the observed performance regression.

## Deployment Evidence Boundary

The existing crash audit records deployment and post-deployment diagnostics.
A passive read of the configured application log independently confirms the
October 19, 2026 00:08:28 injection of runtime fingerprint:

    sha256-30bea5ac1b7bba87f427c5dd2450463b5f57292e6428e07df5a18f199d0792e3

Thus the earlier quoted statement that the crash correction was still
undeployed is outdated. The previous recorded CDP evidence is not rerun or
represented as a fresh live audit here. Current visible-picker behavior is not
proven by source tests, payload counts, or this deployment log alone.

## Verification

- Focused desktop picker/discovery tests: 49 passed.
- Typecheck: passed.
- Explicit Rust MultiRouter scope: 153 passed.
- Formatting and diff checks: passed.
- Full frontend suite: 2,430 passed across 258 files.
- Expanded catalog gate: 442 passed across 13 test files, plus the existing
  reader and discovery guards, executed by the gated renderer build.
- Gated renderer production build: passed.

The initial new immutability assertion compared the cache directly with the
fixture and failed because TanStack structurally shares data when accepting it.
The test now freezes and retains the actual cache value before running the
selector, then requires both reference identity and exact fixture equality
afterward. This changed test setup, not runtime behavior or an existing guard.
An explicit format check also caught the verification script's formatting;
formatting was applied and the check passed on rerun.

No guard, assertion, timeout, or build gate was weakened. Existing unrelated
dirty files and staged build artifacts are preserved.
