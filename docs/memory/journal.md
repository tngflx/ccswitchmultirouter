# Engineering Journal (newest first)

## 2026-08-27 - Production executable and NSIS installer verification

- **What happened:** Rebuilt the production executable and the author-style NSIS installer after adding source-commit update detection and grouped Codex API-key UX. The default all-bundles Tauri build reached WiX and failed in `light.exe`; the NSIS-only build generated the installer, then returned nonzero because updater signing has a public key configured but `TAURI_SIGNING_PRIVATE_KEY` was unavailable.
- **Root cause:** A plain release Cargo build can embed Tauri's development URL without bundling the Vite frontend. Separately, `pnpm build` requests MSI as well as NSIS on this machine, and updater artifact signing cannot finish without the private key.
- **What we did:** Built the raw executable with `pnpm build:exe` (`tauri/custom-protocol` enabled), built the installer with the repository author's `pnpm tauri build --bundles nsis` method, and inspected the resulting executable bytes for the hashed Vite `index-` asset marker. Kept the configured `localhost:3000` string because it is normal compiled `devUrl` metadata and is not used when embedded assets are present.
- **Evidence:** `pnpm typecheck` passed; `pnpm test:unit` passed (155 files, 1,263 tests); `cargo test --manifest-path src-tauri/Cargo.toml` passed with exit code 0; `pnpm build:exe` passed; `cc-switch.exe` contains `index-` (`True`), SHA-256 `A4722875D7298BC190A3079D5A2A1C98EB3866E2F671E2186330AC2FA3C543E9`; NSIS installer generated at `src-tauri/target/release/bundle/nsis/CCSwitchMulti_3.19.2-18_x64-setup.exe`, SHA-256 `B9BC1FC55ED085F5AA726170341F594A7066265B97A3CBA509A24F50E69B13FD`. Both Windows Authenticode statuses are `NotSigned`; no updater signature was produced because the private key was unavailable.
- **Don't again:** never ship a production executable from plain `cargo build --release`; require `tauri/custom-protocol` and verify the embedded `index-` marker. Do not describe a signing-key failure as an installer-generation failure when the NSIS artifact was already produced, and do not publish it as an updater release without the private signing key.

## 2026-08-27 - Source commit update detection and grouped Codex key UX

- **What happened:** Added a GitHub compare check against `BigStrongSun/ccswitchmulti` in addition to release updates, reporting the exact number of commits behind and opening the compare page for cherry-picking. Codex provider forms now have an explicit single-key/grouped-key toggle; grouped model sync fetches each key and merges unique models.
- **Root cause:** Release metadata does not surface unreleased upstream commits, and the previous grouped-key panel left the single-key field visible, making credential mode ambiguous. Model sync only queried one credential even when groups were configured.
- **What we did:** Embedded the build commit via `build.rs`, added a proxy-aware `check_github_commits_behind` Tauri command and frontend update metadata, and hid the single key field while grouped mode is enabled. Grouped fetches run concurrently across all non-empty keys, deduplicate model IDs, and preserve existing catalog reconciliation.
- **Evidence:** `cargo check --manifest-path src-tauri/Cargo.toml` passed; `pnpm typecheck` passed; `pnpm vitest run src/lib/updater.test.ts` passed (3 tests). A nonexistent `CodexFormFields.test.tsx` path was attempted and correctly reported no test files; no full suite run yet.
- **Don't again:** do not treat a release-only check as proof the fork is current; always compare the embedded commit to the fork main branch and keep grouped credentials distinct when fetching model catalogs.


> Rules: see [README.md](./README.md). Corrections are new entries — never rewrite old ones.

## 2026-08-26 - Retry tiers separate safe replay from bounded Desktop continuation

- **What happened:** The main-page stream retry switch only controlled transparent pre-semantic proxy reconnects, so its broad label implied turn recovery that it did not provide. The requested behavior was to keep safe reconnects by default and optionally submit literal `continue` after a recoverable failed or truncated Codex Desktop turn, stopping after a user-selected bounded attempt count.
- **Root cause:** Replaying a stream after semantic output is unsafe, while starting another turn requires Desktop conversation authority. A single boolean conflated those different ownership and safety boundaries.
- **What we did:** Replaced the boolean UI with compact Off/Safe/Aggressive tiers; Safe and Aggressive allow five pre-semantic reconnects, while Aggressive observes the final client-facing Responses SSE stream and submits `continue` through CDP up to 1-3 times. Recovery is limited to verified local Desktop requests, excludes compaction and valid tool calls, suppresses permanent/cancelled failures, preserves state only for the exact injected continuation turn, and does not charge failed CDP submissions against the attempt budget. Legacy `enableStreamRetry` settings remain compatible.
- **Evidence:** `cargo check --manifest-path src-tauri/Cargo.toml` passed; `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` passed; focused Rust tests passed: recovery coordinator 8/8, streaming retry 38/38, handlers 94/94; `pnpm typecheck` passed; retry selector Vitest 2/2 passed; retry-related frontend files passed focused Prettier; full `cargo test --manifest-path src-tauri/Cargo.toml` passed (3,607 library tests plus every integration test binary); full `pnpm test:unit` passed (155 files, 1,262 tests). Repository-wide `pnpm format:check` still fails only on the unrelated pre-existing `src/components/universal/UniversalProviderFormModal.tsx`. No live failure was injected into the active Codex Desktop/proxy processes, so real CDP composer submission was not destructively exercised in-session.
- **Don't again:** do not call pre-semantic stream reconnect a complete turn retry, do not replay post-semantic output, and do not let generic Codex or external API traffic drive the Desktop composer.

## 2026-08-26 - Codex model picker labels remain source-owned routing preferences

- **What happened:** Long provider-prefixed picker labels made it difficult to identify the actual model. The router workspace now offers compact model labels, two provider-inclusive formats, and model/provider sorting without changing stable model IDs.
- **Root cause:** Persisting a label preference into `modelCatalog` would be incorrect because the catalog is a projection regenerated from schema-v2 routing configuration and is intentionally removed during router-save cleanup.
- **What we did:** Kept `modelDisplayStyle` in `codexRouting`, added it to the compiler fingerprint and projection, and applied it at the Desktop picker boundary. The UI restores custom drag ordering on a drag operation and shows the stable ID below a differing friendly label.
- **Evidence:** `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` passed; `cargo check --manifest-path src-tauri/Cargo.toml` passed before unrelated in-progress turn-recovery edits; focused Rust tests `catalog_projection_labels_and_groups_provider_models_without_changing_ids` and `schema_v2_router_save_removes_legacy_derived_catalog_storage` each passed; `pnpm typecheck` passed; `pnpm test:unit -- src/components/codex/CodexRouterWorkspacePage.test.ts --run` passed (77 tests); full frontend `pnpm test:unit` passed (155 files, 1262 tests).
- **Don't again:** do not persist a UI-only display option into the derived model catalog or restore automatic `[Provider]` prefixes by default; retain model identifiers independently of the rendered label.

## 2026-08-26 — Documentation overhaul: README, LICENSE, retry architecture doc, credits

- **What happened:** Cleaned up inherited cc-switch branding (sponsor section with 15+ ads, Trendshift/Star History badges pointing to farion1231), added proper fork attribution chain in LICENSE and README Acknowledgments, created `docs/architecture/retry-model.md` consolidating the two-layer resilience explanation.
- **Root cause:** README was inherited wholesale from cc-switch upstream without cleanup — sponsor content, badges, and issue links all pointed to the wrong repo. No consolidated retry architecture doc existed despite the two-layer model being a critical design boundary.
- **What we did:** (1) Replaced sponsor section with Acknowledgments table crediting farion1231 and BigStrongSun; (2) Updated badges to point to tngflx/ccswitchmultirouter; (3) Added fork-specific features list to header and Features section; (4) Added copyright chain to LICENSE; (5) Created retry-model.md documenting proxy reconnect vs Codex client retry layers; (6) Updated CONTRIBUTING.md and SUPPORT.md issue links; (7) Added retry-model reference to AGENTS.md.
- **Evidence:** README reduced from ~600 to ~453 lines (removed ~180 lines of inherited sponsor ads). All files verified by reading back content after edit.
- **Don'"'"'t again:** never inherit upstream README without auditing every badge, link, and sponsor block for correctness against the fork'"'"'s own repository.

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

## 2026-08-26 — Adopted author-style AGENTS.md codebase guide; validation caught 3 real errors

- **What happened:** enriched AGENTS.md with an author-style "Architecture & Conventions" guide (upstream's AGENTS.md `4c2f6485` was never merged to their main; adapted it to our fork). Added `scripts/validate-agents-md.ps1` to verify every documented path/command/identifier.
- **Root cause of errors found:** wrote docs from memory instead of verifying — three claims were wrong: (1) `codex_traffic_policy.rs` is admission/rejection retry policy, NOT official-vs-third-party routing; (2) `official_first`/`third_party_first` is the Sub-Agent V2 selection policy (`types/codexSubagentV2.ts`, `forwarder.rs`); (3) `CodexApiKeyGroup` backend logic lives in `proxy/providers/codex.rs` (settings key `codexApiKeyGroups`), not `provider.rs`.
- **Evidence:** validator 44/44 PASS after fixes.
- **Don't again:** never document a module's purpose from its name alone — read the module header first; and always run the validator after editing AGENTS.md.
