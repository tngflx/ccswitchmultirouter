# Codex model-picker patch core port

## Goal

Restore the fork-specific Codex renderer model identity and reasoning metadata
behavior in the fresh refork without replacing its newer CDP lifecycle or
adding a second compatibility injector.

## Evidence

The refork owns model-picker injection in `codex_desktop.rs`, but its inline
model patch only matches the visible model string and copies basic descriptors.
The legacy core additionally matches canonical slugs and aliases, normalizes
reasoning effort aliases, preserves provider/group labels, and keeps the
renderer model identity stable for routed and grouped-key rows.

## Decision

Move the pure model-picker patch core into a resource loaded by the existing
`codex_desktop` owner. Keep the refork's current compatibility wrapper,
Guardian V2 repair, history hydration, request normalization, request-health,
and summary-handoff cores unchanged. The resource is a single source for the
CDP payload and QuickJS regression tests.

## Alternatives

- Copy the legacy `codex_desktop` module wholesale: rejected because the refork
  has newer lifecycle, history, and request-health ownership.
- Add alias/reasoning rewrites in each React caller: rejected because the
  renderer patch and catalog compiler would drift.
- Keep the reduced inline core: rejected because canonical and grouped model
  identities are lost in the Desktop renderer.

## Approval / implementation / verification

- Approval: user-approved fresh-refork migration; no separate approval was
  required for this scoped compatibility port.
- Implementation: in progress (2026-10-05).
- Verification: pending focused `codex_desktop` Rust tests, `cargo check`, and
  affected frontend checks.
- Runtime freshness: not checked; a rebuilt and restarted refork app is
  required for live Desktop verification.
