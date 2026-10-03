# Port Stream Retry Setting Into Fresh Proxy Ownership

- Date: 2026-10-03
- Approval: approved
- Implementation: in-progress
- Verification: not-run
- Runtime freshness: not-checked
- Disposition: active
- Requested by / approval reference: User instruction to port distinctive legacy behavior into the fresh BigStrongSun refork.
- Parent decision: `docs/decisions/2026-10-03-bigstrongsun-refork-foundation.md`

## Goal and evidence

The legacy fork exposes `enable_stream_retry` so users can disable proxy-side
Responses stream reconnection. The fresh refork already owns bounded reconnects
inside `streaming_retry` and has a device settings IPC surface, but no setting
controls that owner.

## Decision

Add the compatibility setting with a default of `true`, expose it in the fresh
proxy settings UI, and gate only the existing Responses reconnection factory.
Capacity rejection replay and transport retries remain independently owned by
their existing policies. Do not port the legacy aggressive continuation tier:
the fresh architecture has no matching client-session continuation owner.

## Alternatives and tradeoffs

- Copy the legacy tiered recovery implementation: rejected because it would add
  a second continuation owner without the fresh lifecycle contracts.
- Gate all retries globally: rejected because capacity and transport policies
  have separate safety invariants and user intent here is stream reconnection.
- Omit the setting: rejected because the fresh default currently gives users no
  escape hatch for providers that do not tolerate replay after a dropped stream.

## Ownership and affected files

- `src-tauri/src/settings.rs`: persisted setting and default/serde behavior.
- `src-tauri/src/proxy/forwarder.rs`: existing Responses reconnect gate.
- `src/types.ts`, `src/hooks/useSettingsForm.ts`, and
  `src/components/settings/ProxyTabContent.tsx`: typed UI setting.
- Four locale files and focused Rust/UI coverage.

## Verification plan

Run focused settings and proxy tests, `cargo check`, `pnpm typecheck`, Prettier,
and `git diff --check`. Full suites remain reserved for the final migration
boundary.

## Status history

- 2026-10-03: decision recorded before implementation; approval is covered by
  the user's explicit fresh-refork migration instruction.
- 2026-10-03: implementation verified; the focused Rust settings test passed,
  `cargo check`, `cargo fmt --check`, `pnpm typecheck`, frontend Prettier, and
  `git diff --check` passed. Runtime freshness was not checked because no
  rebuilt desktop process was requested.
