# Engineering Journal

## 2026-10-04 Centralized packaged Codex launcher identity

What happened: the fresh refork's runtime refresh selected the first matching
`Get-StartApps` AUMID and duplicated COM activation, so stable and Preview MSIX
packages could launch the wrong shell. Root cause: launcher identity was not
bound to the selected executable's manifest application. What we did: ported
manifest-specific executable-to-AUMID matching into the existing Codex Desktop
owner, reused that owner from runtime refresh, and retained executable fallback
for standalone installs. Evidence: `cargo test --manifest-path
src-tauri/Cargo.toml codex_desktop --lib` (51 passed), `cargo test
--manifest-path src-tauri/Cargo.toml codex_runtime_refresh --lib` (42 passed, 1
ignored), `cargo check --manifest-path src-tauri/Cargo.toml`, `pnpm typecheck`,
and `git diff --check` passed. `cargo fmt --check` still reports the known
pre-existing formatting differences in `codex_config.rs`, `services/proxy.rs`,
and `services/provider/mod.rs`;
no runtime freshness check was performed. What NOT to do again: do not select
the first Start-menu AUMID when the executable identity is available, and do
not add a second COM launcher owner. Related:
`docs/decisions/2026-10-04-packaged-codex-launcher-port.md`.

## 2026-10-04 Ported shared auto model refresh primitive

What happened: the fresh refork had independent manual model fetch handlers but
no shared cache, request deduplication, or stale-result guard. Root cause: the
legacy fork's reusable `useAutoModelRefresh` utility and its tests were absent
from the new foundation. What we did: ported one shared hook with
credential-scoped fingerprint support, TTL caching, in-flight request
deduplication, invalidation epochs, optional local-storage snapshots, and
non-destructive membership diff reporting. Provider forms remain the owners of
fetch state; no duplicate fetch path was added. Evidence: `pnpm exec vitest run
tests/hooks/useAutoModelRefresh.test.tsx` (4 passed), `pnpm typecheck`, focused
Prettier checks, and `git diff --check` passed. Runtime freshness was not
checked because no rebuilt desktop process was requested. What NOT to do again:
do not copy legacy form integrations wholesale before confirming the fresh
form's state owner, and do not treat an empty model response as proof that all
saved models were removed. Related:
`docs/decisions/2026-10-04-auto-model-refresh-port.md`.

## 2026-10-04 Restored atomic Codex provider switch Desktop lifecycle

What happened: the fresh BigStrongSun refork lacked the legacy explicit Codex
provider action that stops Desktop, switches routing, and relaunches the shell.
Root cause: the fresh foundation had separate provider, takeover, and Desktop
launcher owners but no transaction joining them, and the catalog reconciliation
port also exposed an incomplete shared row identity type. What we did: added a
typed IPC command and API method, verified Desktop process filtering and safe
termination, reused the existing takeover/injection launcher, and added a
lock-held `ProviderService` switch entrypoint so the stop -> mutation -> relaunch
sequence cannot race proxy toggles or reacquire its own mutex. The catalog row
contract now includes shared identity fields and a stable seed type. Evidence:
`cargo check --manifest-path src-tauri/Cargo.toml`; `cargo test
--manifest-path src-tauri/Cargo.toml codex_desktop --lib` (49 passed);
`cargo test --manifest-path src-tauri/Cargo.toml switch_provider_ --test
provider_commands` (4 passed); `pnpm typecheck`; `pnpm exec vitest run
src/lib/codexCatalogReconciliation.test.ts` (3 passed); and `git diff --check`
passed. `cargo fmt --check --manifest-path src-tauri/Cargo.toml` still reports
only pre-existing formatting differences in `codex_config.rs` and
`services/proxy.rs`. Runtime freshness was not checked because no rebuilt
desktop process was requested. What NOT to do again: do not call the normal
lock-taking switch method from inside a lifecycle lock, do not terminate by
process name without verified Desktop identity, and do not duplicate catalog
identity or row-seed contracts. Related:
`docs/decisions/2026-10-04-codex-provider-switch-desktop-lifecycle-port.md`.

## 2026-10-03 Centralized Codex catalog reconciliation

What happened: the fresh refork's Codex form had an inline merge that matched
only one visible/upstream string and treated every fetched model as appendable.
Root cause: identity aliases and remote metadata had no shared reconciliation
owner, so refreshes could fail to hydrate equivalent rows or create duplicate
inventory. What we did: added a pure identity-aware reconciliation utility and
delegated the existing form merge helper to it; disabled/manual rows remain
user-owned, metadata hydration is conservative, and newly discovered models are
added as disabled inventory. Automatic refresh remains a separate lifecycle
decision. Evidence: `pnpm typecheck`,
`pnpm exec vitest run src/lib/codexCatalogReconciliation.test.ts` (3 tests), and
`git diff --check` passed. Runtime freshness was not checked because no rebuilt
desktop process was requested. What NOT to do again: do not copy the legacy
Codex form or add a second persistence path when the fresh form already owns
state and save behavior. Related:
`docs/decisions/2026-10-03-codex-catalog-reconciliation-port.md`.

## 2026-10-03 Kept official Codex proxy sessions in stable history buckets

What happened: the fresh refork still projected official Codex takeover through
the legacy `cc-switch-official` provider, while the migration target requires
native `openai` history when unified history is disabled and the shared
`custom` bucket when it is enabled. Root cause: route projection and auth-facade
classification assumed every official takeover had a named provider table;
the built-in `openai` route has only a top-level `openai_base_url`. What we did:
made `codex_config` the sole owner of projection/detection/cleanup, removed only
CC Switch-owned legacy residue, adapted service projection for native versus
managed official auth, and taught account-pool reprojection to recognize the
built-in route. Evidence: official-route tests (6), projection tests (2),
account-pool reprojection (1), and takeover false-positive test (1) passed;
`cargo check --manifest-path src-tauri/Cargo.toml`, `pnpm typecheck`, and
`git diff --check` passed. `pnpm format:check` failed only on six pre-existing
provider-form files outside this change. Runtime freshness was not checked
because no rebuilt desktop process was requested. What NOT to do again: do not
restore a second legacy route builder or classify a missing
`[model_providers.openai]` table as managed without checking the top-level route
marker. Related: `docs/decisions/2026-10-03-codex-official-history-bucket-port.md`.

## 2026-10-03 Restored the refork language quick switcher

What happened: the fresh refork had a Settings-page language control but had
lost the legacy header quick switcher, and unknown or missing language values
fell back to Chinese. Root cause: language parsing was duplicated between the
i18n bootstrap and settings form, while the header had no owner in the fresh
shell. What we did: added one shared supported-language parser with English as
the default, adapted the header switcher to the existing settings mutation,
and made optimistic language changes roll back i18n and local storage when the
save fails. Existing Settings ownership remains unchanged. Evidence: focused
language/parser/settings tests passed (17), dependent App and Settings tests
passed (38), `pnpm typecheck`, Prettier checks, and `git diff --check` passed.
Runtime freshness was not checked because no rebuilt desktop process was
requested. What NOT to do again: do not add another language normalization or
independent persistence API beside the shared contract. Related:
`docs/decisions/2026-10-03-language-switcher-port.md`.

## 2026-10-03 Ported the stream retry setting into the refork

What happened: the fresh refork already had bounded Responses stream reconnection, but users could not disable that replay behavior. Root cause: the retry owner existed without the fork's persisted `enable_stream_retry` control. What we did: added the default-on compatibility setting, typed frontend state and all four locale strings, a proxy settings toggle, and a gate around only the existing Responses reconnect factory. Capacity replay and transport retry remain separate. Deliberately did not port legacy aggressive continuation because the fresh architecture has no matching client-session owner. Evidence: focused Rust settings test passed (1), `cargo check`, `cargo fmt --check`, `pnpm typecheck`, frontend Prettier, and `git diff --check` passed. Runtime freshness was not checked because no rebuilt desktop process was requested. What NOT to do again: do not gate unrelated retry policies with this setting or add a second continuation owner. Related: `docs/decisions/2026-10-03-stream-retry-setting-port.md`.

## 2026-10-03 Adapted shared MultiRouter model identities in the refork

What happened: the fresh refork could retain a visible alias in a Provider catalog while refresh, route projection, or picker selection compared only the visible string and treated the upstream model as missing. Root cause: model identity was reconstructed independently at each boundary; canonical slugs and aliases were not part of the matching contract. What we did: added a shared normalized identity helper and adapted refresh deduplication, route catalog projection, fixed-route summaries, alias validation, picker state, and wizard selection matching. Kept fresh ownership, fixed include semantics, and disabled inventory rows. Evidence: `pnpm typecheck`; focused Vitest suites with 104 tests passed; Prettier check; `git diff --check`; `cargo check --manifest-path src-tauri/Cargo.toml`. Runtime freshness was not checked because no rebuilt desktop process was requested. What NOT to do again: do not copy the legacy workspace wholesale or hide identity mismatches by converting explicit include routes to all-model routes. Related: `docs/decisions/2026-10-03-model-identity-port.md`.

## 2026-10-03 Ported Codex traffic admission policy

What happened: adapted the legacy Codex traffic-policy behavior to the fresh refork. Root cause: the fresh architecture had provider routing and request retry ownership, but no bounded per-route admission gate or explicit OpenCode endpoint-unavailable replay policy. What we did: added policy resolution and provider metadata, shared router semaphores with response-lifetime permits, recognized rejection replay in the existing Codex retry loop, typed frontend controls, and all locale keys. Kept generic `503` responses non-retryable and preserved existing capacity retry behavior. Evidence: `cargo check --manifest-path src-tauri/Cargo.toml`; focused Rust tests for `codex_traffic_policy` (3 passed), `codex_rate_limit_retry` (3 passed), and `error_mapper` (9 passed); `pnpm typecheck`; focused Vitest policy tests (2 passed); `git diff --check`. What NOT to do again: do not add a second generic retry system or copy the legacy forwarder wholesale; admission belongs to `ProviderRouter`, and explicit rejection replay belongs in the existing Codex retry function.

## 2026-10-03 Codex grouped credentials adapted to fresh request policy

What happened: the first distinctive legacy feature was ported into the BigStrongSun foundation. Root cause: the fresh foundation has one request-policy owner, while the legacy grouped-key implementation selected credentials across older forwarder paths. What we did: added model-aware grouped credential resolution, fail-closed scoped aliases, pooled selection, persisted frontend group editing, one-time catalog projection, and shared policy compilation for runtime and protocol probes. Evidence: focused Rust grouped-key, route restoration, fingerprint/header, and full-URL retention tests passed; grouped projection and related provider-form frontend tests passed; `pnpm typecheck` and `git diff --check` passed. What NOT to do again: do not copy legacy forwarder/retry orchestration or allow a second credential-selection owner.

## 2026-10-03 Legacy reasoning replay adapted to the fresh request policy

What happened: legacy providers used `reasoningContentMode` to choose DeepSeek-style `reasoning_text` replay or strict summary-only replay. Root cause: the fresh foundation already owned replay through `HistoryReplay`, so copying the legacy forwarder branch would create conflicting request mutation. What we did: added a canonical summary-only replay dialect, translated imported legacy metadata at compatibility resolution, and made canonical saves discard the legacy field. Evidence: 33 request-policy tests passed; 2 focused Rust metadata/resolver tests passed; 12 focused frontend tests passed; `cargo check` and `pnpm typecheck` passed. What NOT to do again: do not restore a separate forwarder-level reasoning mode or let both legacy and canonical settings control one request.

## 2026-10-03 BigStrongSun replacement foundation started

What happened: the user approved replacing the legacy fork foundation with a fresh BigStrongSun refork and adapting distinctive behavior incrementally. Root cause: the legacy branch had diverged across hundreds of files and retained older save/probe ownership, while BigStrongSun now provides provider-set and protocol-lab boundaries. What we did: cloned `BigStrongSun/ccswitchmulti` at `b4741ade`, retained the dirty legacy checkout at `641d53c8` as read-only migration evidence, and recorded a single-owner, deletion-gated port strategy in `docs/decisions/2026-10-03-bigstrongsun-refork-foundation.md`. Evidence: clean-foundation `cargo check` passed, `pnpm install --frozen-lockfile` passed, and `pnpm typecheck` passed. What NOT to do again: do not bulk replay legacy commits or create parallel save/probe orchestration in the fresh foundation.
