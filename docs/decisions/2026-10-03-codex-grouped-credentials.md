# Adapt Codex grouped credentials into request-policy compilation

- Date: 2026-10-03
- Approval: approved
- Implementation: complete-for-slice
- Verification: passed-focused
- Runtime freshness: not-checked
- Disposition: active
- Requested by / approval reference: User message on 2026-10-03 approving the fresh refork as the replacement foundation and directing the full legacy feature port.
- Parent decision: `docs/decisions/2026-10-03-bigstrongsun-refork-foundation.md`

## Goal and evidence

Retain the legacy fork's model-scoped API-key groups without copying its old forwarder orchestration into the fresh BigStrongSun foundation.

The legacy implementation provides isolated catalog aliases, fixed/random/round-robin selection, pooled round-robin mode, fail-closed handling for damaged scoped aliases, and restoration of scoped catalog bindings after MultiRouter materialization. The fresh foundation already owns third-party Codex request transformation, authentication headers, fingerprints, protocol probes, and finalized retry payloads in `CodexThirdPartyRequestPolicy`.

The current BigStrongSun and farion reference trees do not expose a competing grouped-key contract. Their relevant newer work is the provider-set/request-policy architecture itself, which this port preserves.

## Decision

`CodexThirdPartyRequestPolicy` remains the single request preparation owner. It gains model-aware compilation and asks `CodexAdapter` for the credential selected for the visible request model and resolved upstream model. Existing model-agnostic compilation remains a compatibility wrapper for callers without a model.

Isolated mode binds generated catalog aliases to exactly one group and fails closed when the alias is orphaned, duplicated, disabled, missing, or empty. Pooled mode selects the most specific enabled group match (exact model before longest prefix), combines its keys with the fallback provider credential, and rotates across the deduplicated pool.

Frontend state persists `codexApiKeyGroups` and `codexApiKeyGroupMode` in the existing provider settings object. A pure projection helper removes stale generated rows and rebuilds isolated aliases. The existing Provider Form and Provider Set workflow remain the save and protocol-evidence owners.

Route materialization restores group bindings from the target provider when a projected MultiRouter catalog retained the scoped alias but omitted its binding fields.

## Alternatives and tradeoffs

- Copy the legacy forwarder and retry changes: rejected because the fresh request policy and streaming retry already own those boundaries.
- Select credentials after request preparation: rejected because protocol fingerprints, probes, and retry headers could disagree with production.
- Fall back to the provider key when a scoped alias is damaged: rejected because it silently changes credential identity.
- Store one provider per key group: rejected because it loses the existing grouped editing and rotation behavior and creates redundant provider records.

## Ownership and affected files

- Credential resolution and route binding restoration: `src-tauri/src/proxy/providers/codex.rs`.
- Request authentication and fingerprints: `src-tauri/src/proxy/providers/codex_request.rs`.
- Forwarder call site: compile the policy with request model context; do not add auth selection logic there.
- Frontend contracts and projection: `src/types.ts` and `src/components/providers/forms/codexApiKeyGroupRouting.ts`.
- Editing and persistence: existing Codex Provider Form and Provider Set workflow.
- Protocol probes: existing protocol-lab adapter, using the same model-aware policy compilation.

## Verification plan

- Rust unit tests for isolated fixed groups, pooled rotation, exact-versus-prefix specificity, fail-closed scoped aliases, route binding restoration, and selected-credential fingerprints.
- Frontend unit tests for alias projection, stale-row removal, disabled groups, and mode normalization.
- Focused Provider Form/save tests for persistence and restoration.
- `cargo check`, `pnpm typecheck`, targeted formatting checks, and `git diff --check` after the slice.
- Full frontend/backend suites remain reserved for the final migration delivery boundary.

## Status history (append-only)

- 2026-10-03: Approved as part of the explicitly requested fresh-refork migration; implementation started after auditing both reference foundations and the legacy grouped-key behavior.
- 2026-10-03: Completed the first migration slice. Fresh state now owns grouped-key persistence and editing; catalog aliases are projected once at save; request policy, forwarder, protocol probes, and route materialization share model-aware credential selection. Evidence: `cargo fmt` passed; isolated, pooled, route-restoration, grouped fingerprint/header, and full-URL credential-retention tests passed; grouped projection frontend tests passed (3); related provider-form tests passed (16); `pnpm typecheck` passed; `git diff --check` passed. Runtime freshness remains unchecked until the user restarts the normal development process.
