# Windows taskbar icon port

## Goal

Restore the explicit large Windows taskbar icon assignment from the legacy fork
without changing the refork's existing AppUserModelID or window lifecycle.

## Evidence

The legacy checkout installs a Windows Tauri plugin that loads the embedded
application icon and sends `WM_SETICON` with `ICON_BIG` when a window is ready.
The refork already sets `AppUserModelID`, but has no equivalent large-icon
assignment. Tauri's default icon path only reliably sets the small window icon,
so shell/taskbar rendering can still fall back to a cached or inferred icon.

## Decision

Port the small Windows-only plugin as `windows_window_icon.rs`, register it at
builder creation, and retain the refork's AppUserModelID setup unchanged. Keep
the small icon untouched and add a Windows-gated test that verifies the large
icon assignment does not show a hidden test window or replace its small icon.

## Alternatives

- Copy the legacy `lib.rs` wholesale: rejected because the refork has newer
  startup and window lifecycle code.
- Replace AppUserModelID handling: rejected because identity and icon assignment
  solve different shell behaviors.
- Add renderer/CSS icon logic: rejected because taskbar icon ownership is native
  Windows window state, not frontend state.

## Approval / implementation / verification

- Approval: user-approved fresh-refork migration; no separate approval was
  required for this isolated platform port.
- Implementation: completed (2026-10-05). Added the Windows-only plugin and
  registered it before the existing startup plugins.
- Verification: `cargo test --manifest-path src-tauri/Cargo.toml --lib
  windows_window_icon` passed (1/1); `cargo check --manifest-path
  src-tauri/Cargo.toml` passed; `git diff --check` passed.
- Runtime freshness: not checked; a rebuilt and restarted refork app is required
  for live taskbar verification.
