# Restore Maintained Codex Catalogue Reasoning Contract

- Date: 2026-10-02
- Approval: approved
- Implementation: implemented
- Verification: partial
- Runtime freshness: not-checked
- Disposition: active
- Requested by / approval reference: user's request to restore the previous
  working behaviour and fix regressions introduced in the audited commits
- Related journal entry: `docs/memory/journal.md` (2026-10-02 entry)

## Goal and evidence

The recent commit audit found that `e880d2482` removed the fallback reasoning
metadata used when projecting maintained OpenAI catalogue models into Codex
provider TOML. The generated `gpt-5.5` entry then omitted
`supported_reasoning_levels`, breaking the existing official picker contract.
A separate snapshot fixture mapped `max` to `xhigh` without declaring `xhigh`
as supported, which correctly failed the production validation invariant.

## Decision

Restore the standard default effort and four maintained OpenAI reasoning levels
only for models explicitly classified by the existing service-tier predicate.
Keep unknown third-party models fail-closed. Correct the test fixture to declare
every mapped effort as supported; do not weaken production validation.

## Alternatives and tradeoffs

- Add generic reasoning levels for every GPT-shaped ID: rejected because model
  naming is not evidence of an upstream capability contract.
- Remove validation of effort-map targets: rejected because snapshots must remain
  internally consistent at their owning boundary.

## Ownership and affected areas

- `src-tauri/src/codex_config.rs`
- `src-tauri/src/reasoning_capabilities/mod.rs` test fixture

## Verification

- Maintained picker regression test: passed 1/1.
- Provider effort-map snapshot test: passed 1/1.
- Unknown third-party reasoning guard tests: passed 1/1 each.
- `cargo check --manifest-path src-tauri/Cargo.toml`: passed.
- `pnpm typecheck`: passed.
- `pnpm test:unit`: passed, 198 files / 1,678 tests.
- Full `cargo test --manifest-path src-tauri/Cargo.toml`: blocked before test
  execution while replacing the normal `src-tauri\\target\\debug\\cc-switch.exe`
  (`Access is denied`, OS error 5); no process was killed.
- `rustfmt --edition 2021 --check` on the touched Rust files: reports existing
  repository formatting differences outside this change; it did not modify
  files.

## Open approval or runtime gaps

The normal development process must be restarted by the user before live Codex
Desktop picker behaviour can be considered current. The full Rust suite has
historically been process-gated by running `cc-switch.exe`; no process is to be
killed to bypass that lock.

## Status history (append-only)

- 2026-10-02: created after the commit audit isolated the maintained-model
  catalogue regression and the invalid snapshot fixture; implementation and
  focused checks completed.
- 2026-10-02: frontend final suite passed 198/1,678; full Rust suite remained
  blocked by the existing process-held executable, with no bypass used.
