# Decision: verify the existing Model order owner before porting drag behavior

- **Date:** 2026-10-06
- **Goal:** Fulfil the requested pointer drag-and-drop behavior on the Codex
  workspace Model order page without duplicating ordering or persistence logic.
- **Evidence:** The supplied screenshot is of Model order, not Sub-Agent order.
  Both checkouts contain `ModelOrderTab` and `SortableCatalogModel`. The refork
  already connects PointerSensor and KeyboardSensor to handle listeners and
  `handleDragEnd`, with an explicit Save action. Existing tests cover projection
  precedence, hide/restore and invalid aliases but do not drive real drag sensors.
- **Decision:** Retain the refork's existing DndContext, draft state and target
  Provider catalog `sortIndex` owner. First add scoped jsdom geometry and actual
  pointer/keyboard interaction regressions, without mocking dnd-kit or calling
  handlers directly. Verify cancel/no-op, persistence, reload and save-failure
  behavior, including unchanged route/default/Sub-Agent policy and model metadata.
  Do not copy the old workspace or add another model-order storage layer.
- **Alternatives:** Rejected wholesale legacy replacement and a second sortable
  implementation. Defer production changes until a failing invariant is identified
  and the concurrent protected-file formatting gate is resolved.
- **Ownership boundary / affected files:** Test-only changes in
  `src/components/codex/CodexRouterWorkspacePage.test.ts`; this record and the
  concise journal. No reasoning/schema, retry, dependency or development-runner
  edits. No foreground UI inspection.
- **Reference verdict:** This step audits existing local behavior and adds
  regression coverage, rather than changing a public contract or porting upstream
  architecture. No reference-repository merge or cherry-pick is proposed.
- **Approval:** approved for requested Model order work by the user's message:
  “and the model ordering page in image should have drag and drop as coded in old
  codebase”. Test-only continuation follows the requested cleanup-first ordering.
- **Implementation:** in-progress (test-only audit).
- **Verification:** pending for actual sensor regressions.
- **Runtime freshness:** not-checked; the screenshot and jsdom tests are not live
  Tauri verification.

## 2026-10-06 — Actual sensor regression outcome

- **Approval:** unchanged; scoped test-only work is complete.
- **Implementation:** complete for the source audit. Added eight regressions
  exercising the existing pointer/keyboard sensors, pointer cancellation and
  Escape cancellation, same-position drops, repeated keyboard movement,
  explicit Save, saved-source reload, and rejected Save followed by retry.
  No production drag handler, storage layer or ordering mode was added.
- **Ownership evidence:** pointer Save makes exactly one update to the target
  Provider, preserving its alias/upstream identity, credentials and catalog
  metadata except `sortIndex`. The Router, default route and Sub-Agent policy
  remain byte-for-byte unchanged in the fixture. Reload obtains the saved
  Provider through the mocked existing API and remounts the workspace; this
  verifies the frontend persistence contract, not a real database write.
- **Verification:** the sensor-only run exited 0 (8 passed, 92 existing tests
  deliberately excluded by its name filter). The subsequent related run exited
  0 with 7 files / 294 tests passed, including all 100 workspace tests and all
  127 Sub-Agent V2 editor tests. `pnpm typecheck`, Prettier check of the owned
  workspace test, and `git diff --check` each exited 0.
- **Harness corrections:** initial sensor tests exposed two incorrect new
  assertions, not production failures: inactive dnd-kit handles omit
  `aria-pressed` rather than setting it to false, and the existing workspace
  error boundary sanitizes arbitrary error text. Assert actual inactive
  semantics and an exact structured error-code message; keep the error
  sanitization and all draft/source invariants unchanged.
- **Retain/defer verdict:** the tested refork already supports drag-and-drop.
  Retain its single owner rather than copying the old implementation. Shared
  `pnpm format:check` still fails on the four protected reasoning/form files;
  production changes there and final repository delivery remain deferred.
- **Runtime freshness:** not-checked. jsdom supplies only PointerEvent/layout
  primitives; it does not prove live Tauri composition, scrolling or touch
  behavior. Full frontend/backend suites, Rust checks, release artifacts,
  publication and checkout cutover were not performed in this continuation.
  Existing localStorage/React act diagnostics remain.

## 2026-10-06 — Parity audit correction and adapted implementation

- **Goal:** Restore the legacy ranked/available Model order workspace and its
  actual router-owned persistence, adapted to the refork compiler and projection.
- **Evidence / correction:** The earlier sensor tests proved the simpler
  refork implementation works, not parity. The legacy UI includes first-eight
  ranking, exact ranks, favorites, recommendations, search, provider presentation
  and protocol provenance. Its global ordering belongs to the router;
  source-provider sort indexes incorrectly couple separate routers and make
  stale aliases block unrelated saves. Supersede the earlier retain-owner verdict,
  preserving the earlier sensor evidence.
- **Decision:** Use one router `modelOrder` owner throughout read/serialize,
  compiler, projection and catalog output. Keep source identity/capability
  normalization in the refork's existing catalog owner. Adapt only the selected
  legacy presentation/interaction behavior; preserve refork hide/restore.
  Display-only changes must not alter source catalogs or router default model.
  Explicit order changes update the router default model as the legacy UI did.
  Default effort is limited to declared supported metadata, not inferred tiers.
- **Alternatives:** Reject wholesale workspace/backend copying, duplicate source
  and router rank writers, and pretending a cosmetic UI port completes cutover.
- **Reference verdict:** BigStrongSun nearby history owns projection status,
  partial projection and official catalog refresh. The original Farion repo does
  not contain this fork-specific workspace. No equivalent parity port was found
  in the reviewed history/open PR search. The original repo's closed-PR REST
  query was rate-limited; do not treat stale search output as closed-PR evidence.
  No merge/cherry-pick is proposed; retain the new projection/status architecture.
- **Ownership:** Workspace Model order/read/serialize/catalog helpers and tests;
  shared ordering/presentation types; compiler/projection; catalog presentation
  boundary; four locales; this record and outcome journal. Do not touch the
  ongoing reasoning schema/form work or proxy/retry/usage.
- **Coordination:** Retry chat explicitly agreed to distinct concurrent source
  edits and reserved shared-index staging until its scoped commits finish.
- **Approval:** approved by “yes don't just restore but make sure it works with
  the new fresh refork codebase! don't just blindly port over then complete the
  main replacement!!”
- **Implementation:** in-progress.
- **Verification:** pending targeted interaction/persistence/serialization and
  compiler/projection/catalog tests; final full suites before publication.
- **Runtime freshness:** pending; never claim jsdom or an old binary proves the
  new live Tauri behavior.

## 2026-10-06 — Default-model configuration invariant

- **Evidence:** An order save updates the router's top-level `model` but could
  retain the previous model's `model_reasoning_effort` in its stored TOML.
  Removing only the routing preference is insufficient when the newly first
  model has no declared efforts: projection then has no valid replacement.
- **Decision:** On explicit order save/reset only, remove the previous
  top-level effort with the existing TOML field helper before updating `model`.
  The validated router preference and refork catalog writer remain the sole
  effort-projection path. Preserve nested provider fields, comments, source
  catalogs, and display-only/effort-only save behavior. Do not change any
  reasoning schema or infer supported tiers.
- **Approval:** unchanged; this is part of making the approved adapted ordering
  work with the refork's projection, not a new reasoning feature.
- **Implementation:** pending. **Verification:** pending regression for stale
  top-level effort, declared reset defaults, and recommendation Save/remount.
  **Runtime freshness:** not-checked.

## 2026-10-06 — Scalar-removal helper root cause

- **Evidence:** The rerun passed all Sub-Agent contracts but failed three
  ordering/reset/recommendation assertions: `removeCodexTopLevelField` delegates
  to an integer-only matcher, so the previous string effort remained.
- **Decision:** Correct that existing helper, not the ordering UI or schemas.
  Remove a single-line assignment only when read-only TOML parsing confirms
  the named top-level property existed and is absent after removal. Preserve
  malformed documents, nested assignments, and assignment-looking text inside
  multiline strings; never parse/stringify the document or duplicate the writer.
  Keep existing integer-removal consumers covered.
- **Ownership:** Add the helper and its direct regression tests to this port's
  affected files. Their current localization edits belong to this chat; the
  concurrent reasoning form/schema files remain untouched.
- **Approval:** unchanged. **Implementation:** pending.
  **Verification:** pending direct helper, Model order and form consumers.
  **Runtime freshness:** not-checked.

## 2026-10-06 — Dependent preview contract correction

- **Evidence:** The broader nine-file consumer run passed 369 tests and failed
  two exact Sub-Agent preview/status payload assertions. Both omitted the new
  catalog presentation and provider-provenance fields produced by the shared
  route catalog owner; profile, routing, capabilities and request keys were
  unchanged.
- **Decision:** Retain exact payload assertions and explicitly include the
  additive `displayNameStyle`, `providerName` and `apiFormatSource` metadata.
  Do not weaken them to partial matches, change the Sub-Agent profile schema,
  or add another catalog builder. Add an actual recommendation-button
  Save/remount regression across the ranked/available columns.
- **Approval:** unchanged. **Implementation:** in-progress.
  **Verification:** pending rerun, including the top-level effort cleanup.
  **Runtime freshness:** not-checked.

## 2026-10-06 — Adapted ordering verification outcome

- **Approval:** unchanged for the requested adapted Model order port.
- **Implementation:** complete for the scoped ordering/helper adaptation.
  The sole ranking owner is router `modelOrder`; display-only saves preserve
  defaults, effort, routes and source catalogs. Explicit reorder/reset clears
  stale top-level effort before projecting declared preferences. The validated
  scalar-removal helper preserves nested, multiline and malformed TOML.
- **Verification:** direct frontend tests passed 2 files / 76 tests;
  dependent contracts passed 9 files / 443 tests; backend router tests passed
  130 tests and configuration/catalog tests passed 245 tests. The later
  normal-target backend library run passed 4,379 tests, failed 0 and ignored 9.
  Its two existing test-fixture warnings remain. This is not the full backend
  integration suite. Fresh Cargo check/format, frontend typecheck and diff
  checks passed.
- **Remaining gates:** full frontend currently fails 9 tests in protected
  reasoning/form consumers, and repository formatting fails on four protected
  files. Full backend integration remains blocked by the running executable.
  The localization correction and final actual-tree gates precede publication.
- **Runtime freshness:** not-checked; no rebuilt live Tauri workflow is claimed.
