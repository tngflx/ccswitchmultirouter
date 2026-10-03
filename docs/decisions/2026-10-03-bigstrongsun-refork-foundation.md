# Adopt BigStrongSun as the replacement foundation

- Date: 2026-10-03
- Approval: approved
- Implementation: in-progress
- Verification: partial
- Runtime freshness: not-checked
- Disposition: active
- Requested by / approval reference: User message on 2026-10-03: "ok carry it all out then i agree fresh refork as foundation then slowly portover this codebase features, but then in the end this main branch will be replaced by the reworked fresh refork!!"
- Related journal entry: `docs/memory/journal.md`

## Goal and evidence

Replace the highly divergent `tngflx/ccswitchmultirouter` foundation with a fresh checkout of `BigStrongSun/ccswitchmulti`, then adapt the existing fork's distinctive behavior to the newer provider-set and protocol-lab architecture without preserving competing implementations.

The legacy checkout at migration start was `641d53c8113ddb5564b3154dd6f75c17570a450e` on `main`, with user-owned modified and untracked catalog/MultiRouter work. The fresh foundation is `BigStrongSun/ccswitchmulti` `b4741adeac9b5da84bffe2b75c18c9bb234c5e72` on `main`.

Patch-identity and symbol audits show that the fresh foundation has newer provider-set, protocol-lab, egress-timezone, and history-integrity architecture, but does not expose the legacy fork contracts named `ReasoningContentMode`, `reasoning_content_mode`, `enable_stream_retry`, `CodexApiKeyGroup`, `codex_traffic_policy`, `LanguageSwitcher`, or `codexCatalogSync`.

## Decision

The fresh BigStrongSun checkout is the implementation target and eventual replacement foundation. The legacy checkout remains read-only migration evidence until parity and data-compatibility gates pass.

Each retained behavior must be adapted to one authoritative owner in the fresh architecture. A port is complete only when its replacement path is tested and no competing legacy orchestration is introduced.

Port order:

1. Provider metadata, serialization, and request-adapter contracts.
2. Provider-set save, protocol evidence, and projection integration.
3. Traffic admission, retry, grouped credentials, and request accounting.
4. MultiRouter catalog, routing, reasoning, and sub-agent behavior.
5. Frontend controls through shared provider-set/protocol-lab hooks.
6. Settings, i18n, history/recovery, updater, and operational tooling gaps.
7. Existing database/config import and cutover verification.

## Alternatives and tradeoffs

- Merge current BigStrongSun into the legacy tree: rejected because it would preserve two ownership models and require resolving broad semantic conflicts.
- Cherry-pick all legacy-only commits: rejected because many commits assume the old save/probe and projection boundaries.
- Copy legacy modules wholesale: rejected because it would recreate duplicate orchestration inside the fresh foundation.
- Drop all distinctive behavior: rejected because replacement requires intentional feature and data compatibility.

## Ownership and affected areas

- Provider save planning: `src-tauri/src/codex_multirouter/provider_set.rs` and provider service.
- Protocol evidence: `src-tauri/src/protocol_compatibility/` plus `src/lib/protocol-lab/`.
- Live configuration: the existing atomic Codex writer and projection boundary.
- Request transformation: provider adapters and shared request policy.
- Traffic and retry: proxy traffic-policy and retry owners.
- UI orchestration: shared hooks; forms and wizards remain consumers.
- Migration source: `H:/repos/ccswitchmulti-fork`.
- Migration target: `H:/repos/ccswitchmulti-refork`.

## Verification

- `cargo check --manifest-path src-tauri/Cargo.toml`: passed on the clean fresh foundation on 2026-10-03.
- `pnpm install --frozen-lockfile`: passed on 2026-10-03.
- `pnpm typecheck`: passed on the clean fresh foundation on 2026-10-03.
- Feature parity, data migration, targeted tests, full suites, and live runtime verification: not yet run.

## Open approval or runtime gaps

No additional approval is required for the requested fresh-refork migration. Destructive replacement of the legacy checkout, force-push, release, or production-data migration remains gated on final verification and an explicit cutover step. The legacy dirty working tree must not be overwritten.

## Status history (append-only)

- 2026-10-03: Decision approved by the user's explicit fresh-refork and replacement instruction. Fresh target cloned and clean baseline compile/type checks passed; implementation marked in-progress and verification partial.

