# Codex Reasoning Picker Identity Contract

- Date: 2026-10-01
- Approval: not-approved
- Implementation: implemented
- Verification: partial
- Runtime freshness: not-checked
- Disposition: active
- Requested by / approval reference: user request in current conversation; no separate approval
- Related journal entry: pending verification

## Goal and evidence

Codex Desktop model rows stopped exposing the adjustable reasoning-effort
selector after the model-list compatibility work. The current injected-row
descriptor only synthesized `model` and omitted the stable `id`, `slug`, and
`name` aliases used by the renderer's model identity contract.

## Decision

For a routed model that is absent from the upstream response, inject the
visible route name as the stable `id`, `slug`, and `name` aliases while
preserving any richer upstream identity fields when a row already exists.
Reasoning metadata remains opt-in: do not invent supported efforts or a
default for a model whose catalog does not declare them.

## Alternatives and tradeoffs

- Keep only `model`: rejected because the renderer can discard the row before
  reading its reasoning metadata.
- Invent reasoning levels for every injected model: rejected because that
  falsely advertises unsupported controls.
- Rewrite the global `model_reasoning_effort`: rejected because it is a
  default/config value, not the model-row identity boundary.

## Ownership and affected areas

- `src-tauri/src/resources/codex_model_picker_core.js`
- `src-tauri/src/codex_desktop.rs`

## Verification

- `cargo test --manifest-path src-tauri/Cargo.toml codex_desktop::tests:: --lib`: passed, 58 tests.
- `pnpm typecheck`: passed.
- `pnpm exec vitest run tests/lib/codexMultiRouterWizard.test.ts src/lib/codexMultiRouterWizard.test.ts`: passed, 69 tests.
- `node --check src-tauri/src/resources/codex_model_picker_core.js`: passed.
- `git diff --check`: passed.

## Open approval or runtime gaps

The live Codex process must be stopped and `pnpm dev` restarted by the user
before runtime verification can prove that the rebuilt compatibility script is
loaded. Existing debug processes are older than this source tree.

## Status history (append-only)

- 2026-10-01: created before implementing the picker identity fix; approval remains not-approved.
- 2026-10-01: implemented the identity restoration and passed focused source-level verification; live runtime remains not-checked pending a fresh development-process restart.
