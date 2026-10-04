# Reasoning compatibility adapters

## Goal

Preserve the fork's public reasoning compatibility identifiers while using the
fresh refork's canonical `HistoryReplay` request-preparation owner.

## Evidence

The legacy fork exposes `ReasoningContentMode`,
`resolve_reasoning_content_mode`, and
`normalize_third_party_responses_reasoning_content_for_strict_schema`.
The fresh refork already owns equivalent behavior through protocol
compatibility resolution and `codex_request.rs`, with separate text-content and
summary-only normalizers. The BigStrongSun history shows the request policy was
deliberately centralized before this refork was created; the original
repository's current work is also focused on catalog/schema correctness rather
than restoring the old forwarder branch.

## Decision

Add thin compatibility adapters that map the legacy mode enum to the canonical
fresh `HistoryReplay` policy and delegate strict-schema normalization to the
existing OpenAI compatibility implementation. Export the identifiers from the
provider module for downstream compatibility and cover the mapping and
normalizer behavior with focused tests. Do not copy the legacy forwarder
branching or create a second request finalizer.

## Alternatives

- Copy the legacy `forwarder.rs` reasoning branch: rejected because it would
  create a second request-body owner and diverge from retry-safe preparation.
- Remove the legacy identifiers: rejected because fork integrations and tests
  depend on their stable names.

## Approval / implementation / verification

- Approval: user-approved fresh-refork migration; no separate approval was
  required for this scoped compatibility port.
- Implementation: complete (2026-10-04). Added the thin mode resolver and
  strict-schema normalizer adapter; request preparation remains owned by the
  fresh `HistoryReplay` path.
- Verification: complete (2026-10-04). `cargo check --manifest-path
  src-tauri/Cargo.toml`, the three focused reasoning-mode Rust tests, the
  focused strict-schema adapter Rust test, and `pnpm typecheck` passed.
- Runtime freshness: not checked; no rebuilt desktop process was requested.

## 2026-10-04 Status Transition

The compatibility names remain intentionally dormant rather than becoming a
second production request-policy path. Narrow `allow(dead_code)` annotations
now document the adapter functions and enum, and an isolated
`allow(unused_imports)` documents their provider-module re-export. A subsequent
`cargo check --manifest-path src-tauri/Cargo.toml` passed without library
warnings.
