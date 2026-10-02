# Close the Sub-Agent V2 capability gap and make catalog inclusion explicit

- Date: 2026-10-01
- Approval: approved
- Implementation: implemented
- Verification: partial
- Runtime freshness: not-checked
- Disposition: active
- Requested by / approval reference: User asked "are u sure u fixed at root??";
  after evidence of a live failure was presented, the user approved with
  "do all a b c" for options A (capability alias fallback), B (backfill for
  unmarked persisted rows), and C (error names the offending models).
- Related journal entry: `docs/memory/journal.md` (2026-10-01 root-cause
  re-audit entry)

## Goal and evidence

Re-audit showed the earlier fetch-selection fix
(`2026-10-01-provider-catalog-inclusion.md`) does not close the reported
`unknown_reasoning_capability_requires_declaration` failure:

- `~/.cc-switch/logs/cc-switch.log` records the same provider-save failure at
  `2026-10-01 19:58:01` and again at `21:17:30`, after the selection fix was
  saved (20:16) and the backend rebuilt (21:04).
- Read-only inspection of `cc-switch.db`: provider `codex-multirouter` has
  **114/114** catalog rows without an `enabled` field. The selection fix only
  affects rows appended by future fetches; there is no repair for persisted
  state.
- Exactly three enabled DeepSeek-alias profiles are routable via those rows:
  `deepseek-v4-pro-opencode-go`, `deepseek-v4-flash-opencode-go`,
  `deepseek-flash-opencode-go`. Read-only `ccsm reasoning inspect` reports
  `supportKind=unknown, source=unknown` for each; their rows carry no
  `reasoning` metadata; `builtin_reasoning_capability_for_model` is an
  exact-match allowlist (`codex_reasoning.rs`) with no alias coverage.
- `validate_codex_subagent_reasoning_completeness` keys capability lookups by
  exact `profile.model`, so canonical DeepSeek declarations never reach alias
  slugs even though `deepseek_role_identity_for_model` already maps them.

## Decision

- **A — capability root:** consult `deepseek_role_identity_for_model` in both
  the catalog projection fallback (`codex_catalog_model_specs`) and the
  validate-path maintained fallback, so DeepSeek family alias slugs inherit the
  canonical maintained declaration. Scope stays narrow: only the DeepSeek role
  families that the canonical builtin list already covers; everything else
  (for example `deepseek-v4.1-*`) remains strictly rejected.
- **B — backfill:** stamp explicit `enabled: true` for catalog rows that lack
  the field at the provider save boundary
  (`ProviderService::prepare_provider_for_mutation`, Codex only). Policy:
  legacy omission has always behaved as *included*
  (`enabled !== false`), and those rows are the user's live routed inventory,
  so the non-destructive reading is explicit inclusion. Rows with explicit
  `enabled: false` are preserved. No direct database surgery; rows become
  explicit on the next successful save.
- **C — diagnostics:** the validation error lists the offending catalog model
  names after the stable error code, never profile keys. `ProviderForm`
  surfaces the list via a new localized message in all four locales.

## Alternatives and tradeoffs

- Exclude (default-disable) all unmarked persisted rows: rejected because it
  would disable the user's actively routed inventory and subagent roles.
- Suppress the strict capability check: rejected; it hides a real contract
  failure for genuinely unknown models.
- Extend `resolve_codex_model_capability_core` (shared request-time resolver):
  rejected for this scope — approval covered the validate/lookup path; the
  shared resolver has a wider blast radius.

## Ownership and affected areas

- `src-tauri/src/codex_config.rs`: projection fallback, validate fallback,
  error assembly, Rust regression tests.
- `src-tauri/src/services/provider/mod.rs`: save-boundary backfill + test.
- `src/lib/codexSubagentCandidateError.ts` (new), `ProviderForm.tsx`, and the
  four locale files: diagnostics surface.

## Verification

Ran on 2026-10-01 after implementation:

- `cargo test --lib codex_subagent_v2_`: **114 passed / 0 failed** (includes the
  four new A/C tests plus the preserved redaction and strict-rejection tests).
- `cargo test --lib codex_subagent`: **154 passed / 0 failed**.
- `cargo test --lib provider_save_backfills_explicit_catalog_enabled`: **passed**
  (B; exercised through `ProviderService::update` because the `add` path in this
  environment trips the live `CODEX_DESKTOP_ACTIVE` guard).
- Focused frontend (parser test + ProviderForm preset/catalog/reasoning +
  catalog sync + CodexFormFields): **6 files / 123 tests passed**.
- `pnpm typecheck`: passed. `cargo check --manifest-path src-tauri/Cargo.toml`:
  passed. Prettier check on all touched frontend files: passed.
  `git diff --check`: passed.
- `pnpm test:unit` (full): **198 files / 1,650 tests passed**.
- `cargo test --lib` (full): **3,953 passed / 21 failed / 6 ignored**. None of
  the 21 are attributable to this A/B/C scope:
  - 18 × `CODEX_DESKTOP_ACTIVE (processes: [38272])` — environmental; Codex
    Desktop was running during the run (same class as the documented baseline).
  - 1 × `updating_current_subagent_v2_returns_verified_role_file_readback`
    (`PendingRetry` vs `Applied`) — pre-existing, reproduced in isolation in an
    earlier session and recorded in `docs/memory/journal.md` with root cause
    not established.
  - 2 × failures owned by the earlier batch's reasoning/official-model work,
    proven independent of this change: `snapshot_preserves_provider_effort_map`
    (its own test+code come from the earlier unstaged `reasoning_capabilities`
    diff; `capability.validate()` at `mod.rs:565` rejects the mapped snapshot)
    and `model_catalog_syncs_codex_models_cache_for_custom_provider_picker`
    (seeded `gpt-5.5` entry carries no `supported_reasoning_levels`; this
    change's fallback is unreachable for non-DeepSeek models and strictly
    additive).
- Full `cargo test` (bins + integration): attempted, blocked — Windows denied
  replacing the live `src-tauri\target\debug\cc-switch.exe` (os error 5).

## Open approval or runtime gaps

- Runtime freshness requires a user rebuild/restart of the normal development
  process; the 21:17:30 log failure predates this implementation and cannot be
  re-tested live until then.
- B applies on the next successful save; until then the database rows remain
  unmarked (behaviorally included either way).
- The two earlier-batch test failures above are outside this approved scope
  and remain open.

## Status history (append-only)

- 2026-10-01: Approved via user message "do all a b c" after the re-audit
  evidence was presented. Implementation started.
- 2026-10-01: Implementation complete for A, B, and C. Targeted and full
  frontend verification passed; targeted Rust verification passed; full Rust
  lib run executed with only the documented environmental and earlier-batch
  failures listed above. Verification recorded as `partial` because the full
  backend suite has out-of-scope failures and the full `cargo test` remains
  blocked by the live binary lock; runtime freshness remains not checked.
