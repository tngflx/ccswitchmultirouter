# Codex Picker Select Crash, 2026-10-18

## Symptom

After the scope-sync fix was deployed, the Codex Desktop model picker showed a
loading state and listed no models at all, even after "Unlock model picker"
reported a successful injection.

## Live Evidence

Read-only CDP evaluation against the running Codex renderer
(`ws://127.0.0.1:9229/devtools/page/0EAA090A5C672792C6C85DE62F2F5C1B`) reported:

    runtime sha256-7c7fb990b57d2dcdcd9c0826498426858c83799d7e3703689703275f062b9dd1
    models list query: status "success", 36 rows, dataUpdatedAt present
    observers: status "error" (both)

The observer error was:

    TypeError: Cannot read properties of undefined (reading 'filter')
      at lvo (app://-/assets/app-initial-*.js)
      at Object.select
      at Object.ccSwitchCatalogReasoningSelection
      at EH.createResult
      at EH.ccSwitchCatalogReasoningResult
      at EH.setOptions
      at Object.read

Four managed rows in the cached `model/list` response had no
`supportedReasoningEfforts` field at all:

    claude-fable-5-1-zmhub, claude-fable-5-1-s1a, claude-opus-5-5, claude-sonnet-5-5

Their catalog rows declare `supported_reasoning_levels: []` (explicitly no
efforts). Codex's native `select` reads `row.supportedReasoningEfforts.filter`
and `.some` without a guard, so one row without the field throws, the whole
select fails, and the picker renders an error/loading state instead of models.

## Root Cause

The canonical projection deleted the camelCase `supportedReasoningEfforts`
field whenever a managed catalog row declared no efforts:

- `normalizeReasoningDescriptor` removed every reasoning field when the
  normalized effort list was empty.
- `clearStaleReasoningFields` then deleted the same field from the raw response
  row because the descriptor no longer carried the key.

The native renderer contract is that every row exposes the array (an empty
array is valid; a missing field is not). The projection therefore produced
structurally invalid rows for models without declared efforts.

A second, independent regression from the scope-sync change was visible in the
same snapshot: `scopedAppServerDiscovery` reported `scopeCount: 691` while all
691 scope objects resolved to one query client. The heartbeat loop then
re-patched the same cache 691 times every 1.5 s, each pass walking the whole
renderer query cache.

## Correction

- `model_picker_core.js`: a descriptor with no declared efforts now keeps the
  canonical empty `supportedReasoningEfforts` array instead of dropping the
  field. No effort level is invented and `defaultReasoningEffort` stays absent.
- `model_picker_core.js`: the wrapped native select guarantees the array on
  every row before native code runs, covering responses that bypass the
  response patcher (for example when the app-server request client is not
  discoverable in a given Codex build).
- `client_discovery.js`: retained scopes are deduplicated by query client, and
  each distinct client is patched once per discovery pass, so heartbeats patch
  one cache instead of hundreds of aliases of the same store. Each scope's
  `queryClient` getter is still read exactly once per pass.

## Regression Tests

All three new assertions fail on the pre-fix resources and pass after the fix:

- `codexDesktopReasoningProjection.test.ts` — "keeps the native model select
  alive when a managed row declares no efforts": the harness select mirrors the
  native `.filter` contract; the observer reported `status: "error"` before the
  fix and `"success"` after it.
- `codexDesktopReasoningProjection.test.ts` — "clears stale raw reasoning
  aliases...": the camelCase array is now asserted to be `[]` while stale
  aliases and defaults are still cleared.
- `codexDesktopClientDiscovery.test.ts` — "collapses duplicate scopes that
  resolve to the same query client": three scope objects, two clients, one
  retained scope per client and exactly two cache patches.

Two Rust probes were updated for the same contract change rather than weakened:

- `model_picker_fallback_descriptor_does_not_invent_reasoning_capability` now
  asserts the descriptor exposes `supportedReasoningEfforts: []` and still no
  default effort.
- `model_picker_clears_stale_effort_defaults_when_provider_advertises_no_levels`
  now asserts `hasEfforts: true` with an empty array and no default effort.

## Verification

- Focused picker/discovery suite: 47 passed.
- Frontend unit suite: 2,428 passed across 258 files.
- Full Rust library suite: 4,852 passed, 0 failed, 10 ignored.
- `cargo test --lib codex_multirouter::`: 153 passed.
- `cargo test --lib codex_desktop::`: 109 passed.
- `pnpm typecheck`, `pnpm catalog:verify` (393 tests), `pnpm format:check`,
  `cargo fmt --check`, `cargo clippy -D warnings`, and `git diff --check` all
  passed.

One full-suite run reported
`codex_config_consistency::tests::later_persists_an_acknowledgement_for_the_same_evidence`
failing on a fingerprint comparison. It passes in isolation and the complete
suite passes on rerun; the test shares a temporary home directory across serial
tests and does not touch renderer resources. It was not modified.

## Native Deployment

`cargo build --manifest-path src-tauri/Cargo.toml --bin cc-switch` linked the
updated executable but Windows refused to replace the running debug executable
(`Access is denied`, os error 5). The linked artifact was staged at
`output/picker-crash-fix-20261018/cc-switch.exe` (SHA-256
`94a302bbe1b31859804ab8cc3420552cda496f3fb1bea21db555557344a2894f`).

With approval, the dev session was stopped, the binary was replaced, and
`pnpm dev:immediate` relaunched the app. The install log then recorded:

    [00:08:28] Codex picker catalog payload installed: models=36, ... runtime_fingerprint=sha256-30bea5ac...
    [00:08:28] Codex 守护: 模型菜单已注入 target=Some("0EAA090A5C672792C6C85DE62F2F5C1B"), models=36

The fingerprint changed from `sha256-7c7fb990…` to `sha256-30bea5ac…`, so the
new renderer resources are live.

## Live Post-Deployment Verification

Read-only CDP evaluation of the same target after the restart reported:

    models list query: 36 rows
    observers: status "success" (both), models 36
    selected model efforts: low, medium, high, xhigh, max, ultra
    scopedAppServerDiscovery: { scopeCount: 1, registryCount: 0, clientCount: 0, queryClientCount: 1 }
    scopedAppServerScopes: 1

The four Claude rows still omit `supportedReasoningEfforts` in the cached raw
response; the select-boundary guard supplies the canonical empty array at read
time, which is why the native select no longer throws. The scope explosion is
gone: one retained scope and one cache patch instead of 691.

This is a scoped renderer diagnostic, not a UI automation pass. A visual check
of the picker dropdown is still the user's confirmation step.
