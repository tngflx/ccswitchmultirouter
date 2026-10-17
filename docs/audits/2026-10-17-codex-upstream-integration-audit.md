# Codex Upstream Integration Audit, 2026-10-17

## Git Evidence

Both configured remotes were fetched on October 17, 2026. The reviewed tips were:

- `origin/main`: `36dba822` (`tngflx/ccswitchmultirouter`).
- `ccswitchmulti-upstream/main`: `8e92a7d1` (`BigStrongSun/ccswitchmulti`).
- Upstream fork point: `b4741ade`.
- Local integration commits before this audit: `42552a18` and `d17743d6`.

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
- Catalog loading uses one live config snapshot and an owned catalog pointer;
  provider-bound cache markers reject cross-provider fallback. Valid canonical
  empty catalogs remain authoritative.
- Direct-provider empty catalogs retain managed ownership instead of restoring
  stale official cache rows. Projection readback verifies actual ordered rows,
  metadata, active config, and cache ownership/dependency bindings, not just an
  unchanged fingerprint or filename. Cached Ready status requires fresh proof.
- Generated cache and inline projection data are not reused as canonical
  reasoning/context declarations while computing expected router artifacts.
- Renderer reloads are detected even when CDP target IDs are unchanged. Every
  discovered renderer is verified; generic Electron pages on port 9229 are not
  accepted as Codex merely because they use an `app://` URL.
- Fallback-discovered query clients and retained caches are reprojected. Modern
  observer wrappers are restored when disposed. Legacy entries without retained
  originals are reused rather than recursively wrapped during reinjection.
- CCSwitch mounts visible startup status before awaiting backend initialization,
  and offers reload after a bounded timeout without bypassing initialization.
  Pi-only application visibility now selects Pi instead of a hidden fallback.
- Vitest preserves default exclusions and ignores copied `.kilo` worktrees.
  A slow form test scopes its queries without weakening assertions or timeouts.

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

## Verification

Final commands and outcomes are recorded after the final source/merge checks.
