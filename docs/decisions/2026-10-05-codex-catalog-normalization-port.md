# Codex catalog normalization port

## Goal

Restore the legacy Codex catalog canonicalization contract in the fresh refork
without creating a second owner for catalog reconciliation, route projection,
or provider persistence.

## Evidence

The legacy fork normalizes camelCase/snake_case aliases, context-window token
strings, cache metadata, input capability fields, and reasoning declarations
before catalog values reach SQLite or the MultiRouter compiler. The refork has
the shared JSON contract and renderer adapters, but its Rust DAO currently only
normalizes non-object settings. This leaves imported aliases and legacy
reasoning declarations noncanonical in persistence and compiler inputs.

## Decision

Port the pure Rust catalog normalizer into `codex_multirouter::catalog` and
invoke it at the existing Codex provider DAO write/read boundaries. Normalize
cloned provider values before compiler validation and mutation planning. Keep
the TypeScript adapter at the renderer/form boundary, keep route schema-v2
cleanup in `schema.rs`, and leave non-Codex providers untouched. The normalizer
must be idempotent and must not own remote reconciliation or route pruning.

## Alternatives

- Normalize only in React: rejected because imported, persisted, and compiler
  inputs would still diverge.
- Normalize in every caller: rejected because duplicate logic would drift.
- Merge the legacy DAO wholesale: rejected because the refork has a different
  transaction and provider-set architecture.

## Approval / implementation / verification

- Approval: user-approved fresh-refork migration; no separate approval was
  required for this scoped compatibility port.
- Implementation: complete (2026-10-05). The pure Rust normalizer is owned by
  `codex_multirouter::catalog`; Codex DAO read/write/update boundaries and
  MultiRouter compiler/mutation/provider-set inputs now use it without adding a
  second reconciliation owner.
- Verification: complete (2026-10-05). `cargo check --manifest-path
  src-tauri/Cargo.toml` passed; focused Rust suites passed (catalog 1,
  compiler 20, provider DAO 7, provider-set 23); `pnpm typecheck` passed; and
  affected Vitest suites passed (7 files, 52 tests).
- Runtime freshness: not checked; a rebuilt and restarted refork app is
  required for live UI verification.
