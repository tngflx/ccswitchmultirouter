# Codex Plugin Health Diagnostics Port

## Goal

Restore the legacy Codex plugin/browser health diagnostics in the fresh
BigStrongSun-based refork without duplicating plugin registration or repair
logic.

## Evidence

- The refork already owns registration detection and repair in
  `services/codex_plugin_registry.rs` and exposes typed registration commands.
- The legacy fork adds browser integration checks for the bundled Browser
  plugin, installed Chromium browser, extension, and native messaging host,
  plus a Settings panel and localized status messages.
- The legacy health report duplicated registration detection, which would
  conflict with the refork's newer marketplace semantics.

## Decision

Add a focused `codex_plugin_health` service that calls the refork's existing
`detect_codex_plugin_registration` owner and separately probes browser health
through the bundled plugin's diagnostic scripts. Expose one read-only health
command, typed frontend API, and an Advanced Settings panel. Keep repair
actions delegated to the existing registration command and preserve all
existing marketplace entries and repair behavior.

## Alternatives

- Copy the legacy registry wholesale: rejected because it duplicates and would
  regress the refork's current marketplace/repair contract.
- Omit browser diagnostics: rejected because this is a distinctive user-facing
  feature and its failure modes are otherwise opaque.
- Add automatic repair: rejected; browser installation and native-host changes
  require explicit user action outside CCSwitchMulti's ownership boundary.

## Ownership Boundary

- `codex_plugin_registry.rs`: enabled-plugin registration detection and
  marketplace repair.
- `codex_plugin_health.rs`: diagnostic report assembly and browser script
  probes only.
- `commands/codex_plugin.rs`: thin IPC command layer.
- `CodexPluginHealthPanel.tsx`: display, refresh, and explicit registration
  repair requests.

## Affected Files

- `src-tauri/src/services/codex_plugin_health.rs`
- `src-tauri/src/services/mod.rs`
- `src-tauri/src/commands/codex_plugin.rs`
- `src-tauri/src/commands/mod.rs`
- `src-tauri/src/lib.rs`
- `src/lib/api/settings.ts`, `src/lib/api/index.ts`
- `src/components/settings/CodexPluginHealthPanel.tsx`
- `src/components/settings/SettingsPage.tsx`
- all four locale files and focused tests

## Status

- Approval: approved by user request to port distinctive features into the
  fresh refork.
- Implementation: complete for the browser/plugin health slice described
  above.
- Verification: focused component tests 2/2, Rust service tests 2/2,
  `cargo check --manifest-path src-tauri/Cargo.toml`, `pnpm typecheck`,
  targeted Prettier checks, new-module `rustfmt --check`, and `git diff
  --check` passed. Whole-crate `cargo fmt --check` still reports known
  pre-existing formatting drift in `codex_config.rs`, `services/proxy.rs`, and
  `services/provider/mod.rs`.
- Runtime freshness: not tested; requires a rebuilt/restarted refork dev app.
