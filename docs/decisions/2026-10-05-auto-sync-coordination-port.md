# Shared auto-sync coordination port

## Goal

Remove duplicated suppression, debounce, dirty-signal, and worker-loop mechanics
from the WebDAV and S3 auto-sync services while preserving independent transport
settings, upload locks, status events, and worker state.

## Evidence

The fresh refork currently contains two near-identical modules:
`services/webdav_auto_sync.rs` and `services/s3_auto_sync.rs`. Both implement
the same suppression depth, one-slot channel, table filtering, debounce/max-wait
calculation, and worker loop. The legacy fork has a transport-neutral
`AutoSyncState` helper that owns those mechanics while each transport retains its
own static state and upload closure.

## Decision

Adapt the shared coordination helper into the fresh refork as
`services/auto_sync.rs`. Keep one `AutoSyncState` static in each transport module
so WebDAV and S3 remain independently suppressible and independently started.
Expose thin transport wrappers for existing callers and retain transport-specific
upload/error/event handling in their current modules.

## Alternatives

- Keep both implementations: rejected because fixes to suppression/debounce
  invariants would continue to drift.
- Use one global state for both transports: rejected because a manual download
  for one transport must not suppress the other transport's notifications.
- Move upload/status logic into the helper: rejected because it would couple
  unrelated transport settings and event contracts.

## Ownership boundary

`services/auto_sync.rs` owns coordination mechanics only. `webdav_auto_sync.rs`
and `s3_auto_sync.rs` own settings eligibility, upload execution, sync locks,
status persistence, and status events.

## Approval / implementation / verification

- Approval: user-approved fresh-refork migration; no separate approval was
  required for this scoped deduplication port.
- Implementation: completed (2026-10-05). Added `services/auto_sync.rs`, kept
  one static state per transport, and reduced both transport modules to thin
  wrappers around the shared coordination owner.
- Verification: `cargo test --manifest-path src-tauri/Cargo.toml --lib auto_sync`
  passed (13/13); `cargo check --manifest-path src-tauri/Cargo.toml` passed;
  `git diff --check` passed.
- Runtime freshness: not checked; a rebuilt and restarted refork app is required
  for live sync verification.
