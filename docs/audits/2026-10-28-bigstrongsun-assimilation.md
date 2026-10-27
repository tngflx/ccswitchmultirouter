# BigStrongSun assimilation — October 28, 2026

## Source identity and approach

- Fetched the configured `upstream` remote (`BigStrongSun/ccswitchmulti`) with
  pruning. Its `main` remains `46398018f5e6810eaf69901f228f3191deeb4c4e`,
  committed October 20, 2026. The newer October 25 remote branch tips are
  Dependabot proposals, not merged UI/product changes.
- Local starting revision: `b943924aa2077e6a1352cbc9ebbf8a4406b81ea6`.
  Starting graph divergence was 54 local-only / 38 upstream-only commits.
  That count is not a count of missing features: much of the upstream behavior
  was already adapted in local commits with different identities.
- Integration branch: `codex/assimilate-bigstrongsun-ui-backend`.
- Applied focused adaptations rather than a wholesale merge or file replacement.
  The backend ports are in `032aff66d`; no upstream ancestry-only merge was
  manufactured and no remote push was performed.

## UI parity retained

The latest upstream UI behavior is already present locally. No production
frontend component, style, locale, or resource script was changed in this pass.

| Upstream work                                                                | Current local implementation / decision                                                                                                                                                    |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Official context editor (`d649eb5dc`, `eb2ed2397`, `b70dec331`, `024677b46`) | `CodexOfficialContextRow.tsx` and `CodexFormFields.tsx` already expose the editor. Retain local selected-account trust, safe-integer, explicit-empty catalog, and editable-maximum guards. |
| Five-minute token rates (`ea606246c`, `fdf008b9b`)                           | `UsageHero.tsx` already displays separate input/output rates. Retain cache-inclusive input, normalized dashboard filters, and loading/error unavailability.                                |
| Catalog preservation across official-auth changes (`d3751f4e1`)              | `ProviderForm.tsx` and its preset regressions already preserve canonical catalogs, including explicit emptiness, without fabricating absent catalogs.                                      |
| Windows drag reliability (`b4469a516`)                                       | Native CSS dragging is already macOS-only; Windows retains Tauri event dragging and Linux omits drag regions.                                                                              |
| Wizard failure rendering (`143b0887a`)                                       | Local asynchronous wizard regressions already cover the save-failure path; do not replace them with older upstream tests.                                                                  |

Prior integration context is in
`docs/audits/2026-10-21-bigstrongsun-port-candidates.md`. The fresh comparison
found the small backend omissions below despite that earlier broad parity work.

## Newly assimilated backend fixes

### `b4469a516`: usage timing and explicit compaction preference

- OpenCode imports derive elapsed message latency only from positive, strictly
  increasing `time.created` / `time.completed` timestamps, with checked
  subtraction and invalid/missing timing falling back to zero.
- The derived value is written to the existing canonical
  `proxy_request_logs.latency_ms`; offline history does not invent a first-token
  measurement. Tokens, costs, deduplication, and existing persisted rows are
  unchanged. This does not retroactively backfill already imported sessions.
- Codex takeover preserves only the active source provider's explicit TOML
  `capabilities.remote_compaction`, not other providers' capabilities or a stale
  previous live projection. Repeated projection remains stable and a source
  switch without an explicit declaration clears the old capability.
- Existing provider-name, authentication, routing, and history-alias policies
  remain owned by their current helpers. No catalog reader/writer was added.

### `f78cbeddd`: reasoning and optional tool schema compatibility

- Grok 4.x numeric minor versions at least 5, including multi-digit minors such
  as `grok-4.10-build`, retain reasoning-effort conversion. Legacy `grok-build-*`
  remains supported; malformed/overflowing numeric minors are not accepted.
- Exact GPT-6 Sol/Luna IDs retain explicit `max`, case-insensitively, in Chat
  and Responses conversions. Arbitrary/custom suffixes do not inherit that
  permission and keep the existing `xhigh` fallback.
- Anthropic function tools explicitly emit Responses `strict: false` so
  optional input-schema fields are not silently made required. The input
  schema and missing-description behavior remain unchanged for API-key and
  OAuth conversion paths.

## Intentional upstream differences

- Do not import the global client-only retry ownership policy from `bc8ae9274`:
  it conflicts with this fork's configurable proxy retry controls. Its safety
  invariant is retained: ambiguous `ResponsePending` requests are not replayed.
  The older `6bab67468` pending-request replay opt-in is not imported; upstream
  later removed it too. Local transport-error identity from `d79c4d7db` is
  already shared across generic, Chat, Responses, and image error paths.
- Do not copy the fixed GPT-6.1 Sol 500K account-default entry over the local
  account-authoritative context contract. Published API metadata is display
  information, not proof of a selected account's usable capacity.
- Do not import upstream version/release metadata or unmerged dependency
  proposals as part of these product fixes.

## Regression evidence

- OpenCode persistence regression failed before the fix with latency `0`
  instead of `1500`; first-token `None`, tokens/cost, and one-row idempotency
  remained identical. The focused suite subsequently passed 8 tests.
- Active-provider compaction projection failed before the fix with no value
  instead of `v2`; active-only, idempotence, and stale-source clearing pass.
- A separate regression backtest retained the new transformation tests while
  substituting only the pre-port production branches. Both Chat transformation
  tests and both Responses tests failed for the expected old Grok/max/strict
  behavior. Final sources were restored byte-for-byte before GREEN verification.

## Existing continuation test-fixture repair

The first full frontend run found 34 failures in the unchanged
`tests/lib/codexDesktopContinuation.test.ts`, and an isolated rerun reproduced
the same 34 failures / 35 passes. The fixture predated the October 26
verified-client hardening: it supplied a raw request client without the
client/original/version hook ownership required by the existing production
client-discovery predicate. It was rejected before any thread read with
`Codex Desktop request client was not found`.

Only the test harness was updated to model the existing activity-tracking
wrapper and exact ownership metadata. Production discovery, authorization,
continuation logic, assertions, guards, and timeouts were not weakened or
changed. Two additional regressions require unverified and stale-version
clients to perform no reads, mutations, or marker writes. The focused suite
then passed all 71 tests; the complete frontend suite passed on the final
combined checkout.

## Verification

Required gates and broader checks on the combined checkout:

| Command                                                                                                                                                                          | Result                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                                                                                                                                                                 | Passed.                                                                                                                 |
| `pnpm catalog:verify`                                                                                                                                                            | Passed: catalog reader guard, 23 guard regressions, 6 discovery regressions, and 476 focused frontend tests / 15 files. |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib codex_multirouter::`                                                                                                      | 156 passed.                                                                                                             |
| `pnpm format:check`                                                                                                                                                              | Passed.                                                                                                                 |
| `git diff --check`                                                                                                                                                               | Passed.                                                                                                                 |
| `cargo fmt --check --manifest-path src-tauri/Cargo.toml`                                                                                                                         | Passed.                                                                                                                 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`                                                                                                               | Passed with the required production/default-target scope.                                                               |
| `pnpm test:unit`                                                                                                                                                                 | 2,670 passed / 271 files; verified completion receipt.                                                                  |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib`                                                                                                                          | 5,077 passed, 10 ignored, no failures. Repeated after restoring the production code from the RED backtest.              |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib proxy::providers::transform::tests -- --nocapture`                                                                        | 73 passed.                                                                                                              |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib proxy::providers::transform_responses::tests -- --nocapture`                                                              | 92 passed.                                                                                                              |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib services::proxy::tests::codex_proxy_ -- --nocapture`                                                                      | 2 passed.                                                                                                               |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib services::session_usage_opencode::tests -- --nocapture`                                                                   | 8 passed.                                                                                                               |
| `pnpm test:unit tests/lib/codexDesktopContinuation.test.ts`                                                                                                                      | 71 passed / 1 file; verified completion receipt.                                                                        |
| `pnpm exec vitest run tests/components/ProviderForm.codexPreset.test.tsx tests/components/UsageHero.test.tsx src/lib/platform.test.ts tests/components/CodexFormFields.test.tsx` | 105 passed / 4 files.                                                                                                   |
| `pnpm exec prettier --check tests/lib/codexDesktopContinuation.test.ts`                                                                                                          | Passed (this path is outside the standard formatting glob).                                                             |

One additional, stricter test-target lint audit remains red:
`cargo clippy --manifest-path src-tauri/Cargo.toml --lib --tests -- -D warnings`
reported 54 existing test-target lints outside this integration, including
`await_holding_lock`, `question_mark`, `needless_return`, `unused_io_amount`,
`field_reassign_with_default`, and `invalid_from_utf8` in the pre-existing dirty
Codex session test. The required production/default-target Clippy command
passes. No lint, assertion, build gate, or security guard was suppressed to
obtain that result. Rust tests still emit three pre-existing warnings.

An independent read-only review of `032aff66d` found no actionable issue.

## Preservation and deployment boundary

The pre-existing modified `session_usage_codex.rs` / `usage_stats.rs` and
untracked `session_usage_codex_fork.rs` / `session_usage_codex_fork_tests.rs`
were not included in the integration commit. Their SHA-256 hashes were checked
before and after this work and remained unchanged.

No paid provider call, UI automation, live-runtime audit, desktop packaging,
release publication, installation, or provider/session mutation was performed.
These source/test checks do not prove the installed application was rebuilt or
that live provider requests succeed. A later build/release must use the
repository's gated `pnpm build:renderer` or `pnpm build` path.
