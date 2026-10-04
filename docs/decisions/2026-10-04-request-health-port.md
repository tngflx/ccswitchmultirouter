# Request-health subsystem port

## Goal

Restore the fork-specific Codex request-health diagnostics, conservative JSON
cleanup, pre-dispatch review, and optional summarize/restart handoff in the
fresh refork without creating a second request-finalization or retry owner.

## Evidence

The legacy fork contains a dedicated `src-tauri/src/proxy/request_health.rs`
(about 66 KB), settings/types/API/UI wiring, and forwarder integration. The
fresh refork has none of that module or wiring. Neither `upstream/main`
(`BigStrongSun/ccswitchmulti`) nor `original/main` (`farion1231/cc-switch`)
contains `request_health.rs`, so this is custom behavior rather than an
upstream change to merge blindly.

The legacy module is designed to inspect the final JSON body immediately before
upstream dispatch. Its integration points must be adapted to the fresh
forwarder's current body lifecycle and retry helpers.

## Four-point request-size accounting audit

Before implementation is considered complete, record and test these four
values for one logical request:

1. Client body: bytes received at the local proxy boundary.
2. Post-transformation body: bytes after protocol/provider conversion and
   request-health optimization, before dispatch.
3. Exact retry/replay body: bytes reused by stream/rejection retries; retries
   must use the immutable finalized payload rather than rebuilding history.
4. Upstream wire body: bytes passed to the HTTP client request builder.

The audit must identify each append/restore/conversion boundary and prove that
history restoration is idempotent. No truncation, retry suppression, or size
cap is acceptable as a substitute for identifying an owning producer.

## Decision

Port the subsystem in layers:

- settings and shared serialized types;
- typed Tauri API and diagnostics panel;
- request-health module with focused unit tests;
- one fresh-forwarder integration at the finalized request body boundary;
- explicit retry/replay accounting tests before enabling any preflight action.

Keep protocol conversion, retry payload construction, and Codex session history
owned by their existing fresh modules. Request-health may observe and safely
clean the finalized body, but it must not reimplement those owners.

## Alternatives

- Copy the legacy `forwarder.rs` wholesale: rejected because the fresh
  forwarder has diverged retry and provider-routing ownership.
- Port only the UI/settings: rejected because diagnostics without the backend
  producer would be misleading.
- Add a request-size cap or truncate history first: rejected because it would
  hide the producing boundary and violate the required accounting audit.

## Approval / implementation / verification

- Approval: user-approved fresh-refork migration; no separate approval was
  required for this scoped compatibility port.
- Implementation: pending.
- Verification: pending. Required evidence includes focused Rust request-health
  tests, forwarder retry/replay accounting tests, frontend panel tests,
  `cargo check`, and `pnpm typecheck`.
- Runtime freshness: not checked; a rebuilt desktop process was not requested.

## 2026-10-04 implementation transition

- Implementation: complete for the scoped request-health port and four-point
  accounting boundary.
- Client body ownership: each JSON handler records the exact decoded byte length
  in request extensions before parsing. Equivalent compact and whitespace-heavy
  JSON therefore retain different client byte counts.
- Post-transformation ownership: provider conversion, provider policy, and
  request-health mutation finish before one serialization into the finalized
  payload.
- Retry/replay ownership: initial transport, safe transport retry, rejection
  retry, and stream reconnect clone the same immutable finalized wire bytes.
  They do not restore history or re-run conversion. Responses-Lite fallback is
  a separate finalized payload, and all retries after fallback use that fallback
  payload and its headers.
- Upstream wire ownership: optional zstd encoding happens once while finalizing
  the payload. Accounting records the exact wire length and SHA-256 hash; review
  policy reads semantic transformed JSON separately from the exact wire bytes.
- Request-inflation verdict: the source audit found no retry or replay append
  boundary after finalization. Runtime traffic was not captured in this pass, so
  no claim is made yet about the size delta of a real production request.
- Verification: `cargo check --manifest-path src-tauri/Cargo.toml` passed;
  request-health tests passed 17/17; OpenAI compatibility tests passed 38/38;
  Codex request-policy tests passed 36/36; forwarder tests passed 183/183;
  focused request-health/stream-retry frontend tests passed 5/5; and
  `pnpm typecheck` passed. The first broad targeted `cargo test` invocation
  failed before running the test because stale multi-target artifacts produced
  `E0460`/`E0463`; the library-scoped rerun passed, and the full Rust suite
  remains pending for the final migration boundary.
- Runtime freshness: not checked. The running development process belongs to
  the legacy checkout, and no refork rebuild was requested.
