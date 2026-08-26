# Engineering Journal (newest first)

> Rules: see [README.md](./README.md). Corrections are new entries — never rewrite old ones.

## 2026-08-26 — Deep protocol probe adopted from upstream (1a3ccd1a) without losing fork features

- **What happened:** Upstream rewrote Codex protocol probing from a browser-side shallow check (one non-streaming request per protocol) to a backend-driven deep probe (baseline → SSE → reasoning → forced-tool → tool-continuation) with a live per-model progress dialog. Their `CodexFormFields.tsx` rewrite would have deleted our i18n, traffic policy, catalog sync, and API-key-group UI.
- **Root cause of the conflict:** upstream's file never contained our fork additions; adopting it wholesale = silent feature reversion.
- **What we did:** transplanted the feature, not the file — backend (`protocol_compatibility/*`, byte-identical to upstream) + new dialog (i18n-wrapped, logic-identical `failureLabel`/`reasoningLabel`) + rewired our form's `handleProtocolProbe` to the preflight command; deleted all old shallow-probe helpers (zero references remain).
- **Bonus bug found:** our `createCatalogRow` dropped the `enabled` flag (upstream carries it), so disabled catalog rows silently re-enabled on load. Fixed; covered by ported test "omits disabled catalog models from the deep-probe request".
- **Evidence:** `pnpm typecheck` ✅; targeted 36/36; full frontend 154 files / 1251 tests ✅; commit `47e18b20`.
- **Don't again:** never adopt an upstream UI file wholesale when the fork has diverged — diff their function-level core and transplant that instead.

## 2026-08-26 — Upstream v3.19.2-18 cherry-pick audit (7 code commits)

- **Verdicts:** `a7e87d1d` (route profile sync), `584a1834` (runtime inheritance), `1a3ccd1a` (deep probe), `23a3df8e` (reasoning semantics), `b5395d80` (521 outage classification), `128aaf4d` (version bump) all applied with core logic verified byte-identical or logic-identical; `8b38cba4` was intentionally superseded by upstream's own `23a3df8e` — final state matches upstream final (no `CodexReasoningClient` leftovers anywhere).
- **Evidence:** per-commit symbol checks + byte-identity diffs for `protocol_compatibility/*`, `dao/providers.rs`, `handler_context.rs`, `lib/api/protocol-compatibility.ts`; full Rust 3572/0, frontend 1251/1251.
- **Don't again:** intermediate self-reverting commit pairs (8b38cba4→23a3df8e) must be audited against upstream's *final* state, not per-commit.

## 2026-08-26 — Commit history consolidation: 4 commits was too coarse

- **What happened:** squashing ~27 fork commits into 4 mega-commits hid feature boundaries and was rejected in review.
- **Fix:** rebuilt as 16 coherent feature commits (provider schema → proxy policy → usage → codex routing → infra sync → services → backend tests → UI layers → presets → i18n → CI → frontend tests), verifying `git diff old-tested..HEAD` was empty so all prior test results stayed valid.
- **Evidence:** pushed as `da53d93c` after byte-identity check; backup branch `codex/pre-consolidation-backup` retained.
- **Don't again:** force-pushing rewritten history without the tree-identity check invalidates every previously-run test result.
