# Keep Official Codex Proxy Sessions in a Stable History Bucket

- Date: 2026-10-03
- Approval: approved
- Implementation: complete-for-slice
- Verification: passed-focused
- Runtime freshness: not-checked
- Disposition: active
- Requested by / approval reference: User message on 2026-10-03 approving the fresh refork as the replacement foundation and directing the legacy feature port.
- Parent decision: `docs/decisions/2026-10-03-bigstrongsun-refork-foundation.md`

## Goal and evidence

Adapt legacy commit `619c315b8` to the fresh BigStrongSun architecture so official Codex proxy sessions remain resumable in the same history bucket as direct official sessions. The legacy implementation stopped writing `cc-switch-official`; the fresh refork still projects that provider id from `codex_config::apply_codex_official_proxy_route_with_system_proxy_policy`.

The fresh refork already owns unified-history injection, takeover backup/restore, WebSocket `426` handling, version-header stripping, and modern native/managed auth-facade classification. Those parts must remain single-owner implementations.

## Decision

Keep `codex_config` as the sole owner of official route projection and adapt its existing helper:

- unified history disabled: use Codex's built-in `openai` route with top-level `openai_base_url` and remove only the legacy `cc-switch-official` table;
- unified history enabled: use the existing shared `custom` provider bucket as an official mirror pointed at the local proxy;
- recognize and clean old `cc-switch-official` projections as migration residue;
- recognize new address-based official takeover only when the active route points at the configured local proxy;
- preserve native-login, managed OAuth, account-pool, and MultiRouter auth-facade behavior through the existing service classifier.

No wholesale cherry-pick of `619c315b8` or upstream PR `#7154` is appropriate because those changes target a different live-projection architecture and would create competing ownership for history migration, route projection, or auth facade behavior.

## Ownership and affected files

- Official route projection, detection, and cleanup: `src-tauri/src/codex_config.rs`.
- Runtime takeover detection and proxy-address matching: `src-tauri/src/services/proxy.rs`.
- Focused regression tests remain adjacent to those owners.

## Verification plan

- Rust tests for unified-official, unified-disabled, legacy-route cleanup, false custom-route detection, and auth-facade preservation.
- `cargo check --manifest-path src-tauri/Cargo.toml`, `pnpm typecheck`, `pnpm format:check`, and `git diff --check`.
- Full frontend/backend suites remain reserved for the final migration delivery boundary.

## Status history (append-only)

- 2026-10-03: Approved as part of the explicitly requested fresh-refork migration; implementation started after auditing BigStrongSun, farion1231, and legacy commit `619c315b8`.
- 2026-10-03: Implemented the projection adaptation. Unified history now uses the shared `custom` bucket; disabled history uses built-in `openai` with top-level `openai_base_url`; legacy `cc-switch-official` residue is removed only when owned; managed OAuth retains the named route needed for `PROXY_MANAGED`. Added native, unified, cleanup, false-positive, and account-pool regression coverage. Targeted Rust tests passed (6 official-route, 2 projection, 1 account-pool, 1 takeover); `cargo check`, `pnpm typecheck`, and `git diff --check` passed. `pnpm format:check` remains failing on six pre-existing provider-form files outside this slice. Runtime freshness remains not-checked because no rebuilt desktop process was requested.
