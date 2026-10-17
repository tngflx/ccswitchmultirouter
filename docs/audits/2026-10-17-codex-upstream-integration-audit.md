# Codex Upstream Integration Audit, 2026-10-17

## Git Evidence

Both configured remotes were fetched on October 17, 2026. The reviewed tips were:

- `origin/main`: `36dba822` (`tngflx/ccswitchmultirouter`).
- `ccswitchmulti-upstream/main`: `8e92a7d1` (`BigStrongSun/ccswitchmulti`).
- Upstream fork point: `b4741ade`.
- Local integration commits: `42552a18`, `d17743d6`, and `0f90fb78`.
- Incoming `origin/main` was merged as `8a2b32ba`; its tree matches the reviewed
  local integration, preserving the stronger local safeguards.
- Endpoint/deletion follow-ups: `71ac1bb5` and `48c04fef`.
- Final verified source HEAD: `f9ceffa7`, including authoritative cache release,
  unavailable-provider preservation, renderer release/reactivation, and their
  regressions. The subsequent audit commit changes documentation only.

Both remotes were fetched again after integration, with unchanged tips. The
reviewed source HEAD contains `origin/main`; there are no remaining incoming
commits from that remote. No commits were pushed.

The complete post-fork BigStrongSun range contains two commits. No post-fork
upstream commit changes the model picker, catalog projection, or renderer patch.

## BigStrongSun Parity

| Commit | Changed Surface | Result |
| --- | --- | --- |
| `6bab6746` | `proxy/forwarder.rs`: retry predicate, transformed/raw request callsites, bounded transport retry, regressions | Ported, including the fork's additional Lite-fallback callsite. Only native Codex streaming `/responses` and `/responses/compact` opt into pre-header `ResponsePending` replay. Non-Codex, Chat Completions, non-streaming, and post-header paths are not broadened. |
| `6bab6746` | `package.json`, `Cargo.toml`, `Cargo.lock`, `tauri.conf.json`, release note | Version fields are `3.20.4-3`; release note matches upstream. This is source parity, not evidence of a local release/install. |
| `8e92a7d1` | Upstream publication memory document only | Intentionally not copied: it records upstream publication, not publication of this fork. No executable feature is missing. |

## Incoming Origin Commit

Every changed file and hunk in `36dba822` was compared with the local integration.
The metadata/protocol improvements are retained across these surfaces:

- Backend catalog, protocol declaration classification, Provider Set planning,
  protocol commands, model fetch, provider service, reasoning metadata, external
  OpenAI model enumeration, and handlers.
- Frontend catalog reconciliation, Codex form fetch handling, protocol capability
  classification/adapters, Provider Set preview, and OpenAI-compatible snippets.
- Their corresponding protocol, adapter, picker, and metadata regressions.

The incoming exception that retained unmatched native picker rows was deliberately
rejected. A managed local picker must expose only enabled entries from the current
canonical projected catalog. Remote/non-managed queries remain outside that filter.

The incoming implementation was not a drop-in replacement: it omitted local
recovery fixes and introduced additional cross-layer inconsistencies found below.

## Follow-Up Corrections

- Complete model refresh reconciles image/modalities/text-only/vision aliases as
  one capability. Partial refresh preserves explicit declarations; existing
  reasoning-user and parallel-tool override contracts remain intact.
- Explicitly unsupported API declarations no longer become wizard-ready merely
  because they do not require a paid probe. Saved failed evidence cannot re-add
  them to the automatic probe queue. Explicit manual/current verified evidence
  retains its existing precedence.
- Request-time unsupported-capability checks apply only to Responses, compact,
  and Chat Completions endpoints, including `/v1` and query-string variants.
  JSON image, audio, embeddings, and raw request behavior is unchanged.
- Catalog loading uses one live config snapshot and an owned catalog pointer;
  provider-bound cache markers reject cross-provider fallback. Valid canonical
  empty catalogs remain authoritative.
- Direct-provider empty catalogs retain managed ownership instead of restoring
  stale official cache rows. Projection readback verifies actual ordered rows,
  metadata, active config, and cache ownership/dependency bindings, not just an
  unchanged fingerprint or filename. Cached Ready status requires fresh proof.
- Removing a catalog declaration during takeover now runs the authoritative
  provider lifecycle and restores the original official cache. This differs
  from an unavailable provider: a snapshot without a loaded provider or inline
  catalog preserves its pointer, cache, backup, catalog, and managed agents.
  The existing integration regression caught the cache-release defect, and a
  separate regression covers unavailable-provider preservation.
- Split-provider deletion uses the restored logical facade catalog only to
  enumerate removed alias/include candidates. Surviving route targets still
  require their current valid provider catalog; validation fails before writes.
- Generated cache and inline projection data are not reused as canonical
  reasoning/context declarations while computing expected router artifacts.
- Renderer reloads are detected even when CDP target IDs are unchanged. Every
  discovered renderer is verified; generic Electron pages on port 9229 are not
  accepted as Codex merely because they use an `app://` URL.
- Deliberately releasing the managed catalog makes an existing renderer's model
  projection inert, clears old request scopes, and refetches formerly managed
  native cached queries without touching remote queries. Missing, malformed,
  unreadable, or changing config snapshots remain load failures, preserving the
  last usable catalog instead of signaling release. Malformed-config errors do
  not include config source or credential values.
- Release retains history synchronization and request normalization, including
  provider changes between unmanaged configurations. Reactivation does not nest
  legacy selector wrappers. Renderer scheduler/request revisions are `10`/`13`.
- Fallback-discovered query clients and retained caches are reprojected. Modern
  observer wrappers are restored when disposed. Legacy entries without retained
  originals are reused rather than recursively wrapped during reinjection.
- CCSwitch mounts visible startup status before awaiting backend initialization,
  and offers reload after a bounded timeout without bypassing initialization.
  Pi-only application visibility now selects Pi instead of a hidden fallback.
- Vitest preserves default exclusions and ignores copied `.kilo` worktrees.
  Slow form tests scope their queries without weakening assertions or timeouts;
  the readiness identity regression still performs all eight validations.

## Diagnosis Boundaries

The earlier claim that a missing `modelProvider` field alone explained loading
was not established: historical code already accepted the empty provider list
because `[].every(...)` returns true. The explicit new expression codifies that
behavior; it is not proof of the installed failure's root cause.

The startup hang is a confirmed source-level mechanism, not a confirmed diagnosis
of the currently installed blank window. No configured live audit monitor was
available in this session. No Computer Use or broad UI automation was substituted.
Fake CDP, local HTTP fixtures, and source tests are not live provider validation.

Complete model sync may replace image/text capability choices because the current
persisted schema does not distinguish user capability provenance from provider
metadata. This audit preserves that existing complete-sync contract; it does not
introduce a second persisted source of truth.

Automatic workspace inventory refresh remains scoped to enabled route targets on
the routes tab. This was not changed into broad provider inventory enumeration.

New source, passing checks, and generated renderer assets do not prove that the
installed desktop executable was rebuilt or installed. A rebuilt CCSwitch and a
fresh Codex renderer are required to eliminate preexisting injected closures.

Current revisions track original whitelist values/getters and restore only
unchanged owned overrides. True legacy v8/v9 sessions may already contain
whitelist changes whose original values were never recorded. Release does not
guess or delete those native fields; restoring that legacy baseline may require
a Codex renderer reload. Native model queries are refetched, and stale catalog
rows are no longer projected by the released compatibility layer.

## Verification

Final source gates passed:

| Command | Outcome |
| --- | --- |
| `pnpm typecheck` | Passed. |
| `pnpm catalog:verify` | Reader guard, 23 reader regressions, 6 discovery/config regressions, and 392 catalog tests passed. |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib codex_ -- --test-threads=1` | 1,856 passed, zero failed, 4 diagnostic tests intentionally ignored. |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib codex_multirouter:: -- --test-threads=1` | 149 passed. This scope overlaps the broad Rust run. |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib commands::protocol_compatibility:: -- --test-threads=1` | 54 passed. |
| `pnpm exec vitest run tests/lib/codexDesktopReasoningProjection.test.ts --maxWorkers=1 --minWorkers=1` | 25 passed, including current/v8 release, native refetch, remote isolation, reactivation, and override ownership. |
| `pnpm format:check` | Passed. Edited test/resource files were also formatted individually. |
| `cargo fmt --check --manifest-path src-tauri/Cargo.toml` | Passed. |
| `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` | Passed. |
| `git diff --check` and staged whitespace check | Passed. |
| `pnpm build:renderer` | Passed, including the catalog gate. Vite emitted large-chunk and dependency-comment warnings, not build errors. |

The broad Rust run includes both formerly failing integration cases, the new
unavailable-provider snapshot test, and the release/history/config regressions.
The ignored diagnostics require live network, real local history, or installed
CLI/session evidence; they were not substituted with claims of live validation.

### Remaining Frontend Gate

The complete frontend suite is **not green**. The earlier serial command
`pnpm test:unit --maxWorkers=1 --minWorkers=1` finished with 2,331 passed and six
5,000ms timeouts, all in `tests/components/PiProviderForm.test.tsx`:

- `uses structured Pi-native capabilities and limits in collapsed model details`
- `stores Pi-native request headers without mixing them with API-key auth`
- `keeps unknown fetched models on Pi defaults when the endpoint changes`
- `uses a fetched model ID without inferring its capabilities`
- `keeps a preset thinking map when the user changes the API`
- `edits Pi thinking-map missing, null, and string states from the collapsed capability area`

The isolated command
`pnpm exec vitest run tests/components/PiProviderForm.test.tsx --maxWorkers=1 --minWorkers=1`
finished with 45 passed and the last thinking-map test timing out at 5,910ms.
The Pi implementation, test, helpers, and shared controls are unchanged from
`36dba822`. No functional defect was identified in its synchronous map-update
path, but unchanged source does not prove historical baseline timing. No Pi
assertions or timeouts were weakened, and these failures are not counted as
passing checks. All Codex suites passed in the serial full run; the final newly
added release tests passed separately in the 25-test focused run above.

An intermediate concurrent catalog run also hit the slow Codex readiness test's
5,000ms limit. Its queries were scoped to the readiness region and real dialogs,
retaining every assertion and all eight validation cycles. The subsequent
standalone catalog gate passed all 392 tests; that case took 2,448ms. The final
gated renderer build passed the catalog suite again.

Local command logs are under `.local/verification/`, including
`rust-codex-final.log`, `rust-multirouter-final.log`, `rust-protocol-final.log`,
`model-picker-release-final.log`, `build-renderer-final.log`,
`test-unit-serial.log`, and `pi-form-isolated.log`.

An additional historical whitespace scan of `b4741ade..HEAD` reported inherited
extra EOF blank lines in `docs/memory/README.md` and
`docs/memory/root-notes-archive.md`. Those files are unchanged by this integration.
The integration-only `origin/main..HEAD` whitespace check passed.
