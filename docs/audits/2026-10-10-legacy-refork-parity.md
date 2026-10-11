# Legacy-to-refork parity audit (2026-10-10)

## Scope and conclusion boundary

This audit covers the 145 non-merge commits authored by Felix Tang in
`18873582bd3f7ef56cb91e813f16985863cf9ca3..641d53c8113ddb5564b3154dd6f75c17570a450e`.
The refork inspected here is based on `b4741adeac9b5da84bffe2b75c18c9bb234c5e72`.
The inventory was generated with:

```powershell
$base = git merge-base 641d53c8 b4741ade
git log --no-merges --reverse --format="%h|%ad|%s" --date=short `
  "$base..641d53c8" --author="Felix Tang"
```

The previous `4ad51756` wording, "complete port parity", was not supported by a
commit ledger or a fresh runtime audit. The cutover decision itself explicitly
said, "Neither feature parity nor cutover is called 100%." This document replaces
the unsupported wording with commit-level source and test evidence.

Statuses mean:

- **Present**: the current tree has the same behavior and an identifiable owner.
- **Adapted**: the intent exists under current ownership or was restored during
  this audit; it is not necessarily patch-identical.
- **Intentionally retired**: the commit only repaired or documented the legacy
  tree, or its owner no longer exists and a current owner supersedes it.
- **Missing**: no current owner or justified retirement was found.

There are no `Missing` rows after the restorations recorded below. That is a
source-level audit result, not a claim of 100% runtime parity. Unit tests,
compile checks, and source inspection do not prove a fresh packaged desktop
workflow, and macOS-only Otty launching cannot be executed on this Windows host.

## Omissions restored in this audit

| Gap | Restored owner and regression evidence |
| --- | --- |
| Deselecting every model disabled the wizard model page and blocked **Follow all models automatically** | `src/lib/codexMultiRouterWizardFlow.ts`; `src/components/codex/CodexMultiRouterWizard.test.tsx`; `src/lib/codexMultiRouterWizardFlow.test.ts` |
| Request Health save had no reliable acknowledgement or feedback | `src/components/settings/RequestHealthPanel.tsx`; `tests/components/RequestHealthPanel.test.tsx` covers success, false/null/undefined/malformed acknowledgement, rejection, retry, toast, and inline status |
| Catalog toolbar exposed duplicate matching and selected include/exclude actions | `src/components/providers/forms/CodexCatalogViewport.tsx`; `tests/components/CodexCatalogViewport.test.tsx` keeps one selected-row scope and verifies the removed duplicates |
| **Keep latest versions** was hidden in overflow | `src/components/providers/forms/CodexCatalogViewport.tsx`; `tests/components/CodexCatalogViewport.test.tsx`; `tests/lib/codexCatalogVersionPruning.test.ts` covers 17 pruning scenarios |
| Otty support and documentation were absent | `src/components/settings/TerminalSettings.tsx`; `src-tauri/src/commands/misc.rs`; `src-tauri/src/session_manager/terminal/mod.rs`; four locale files; six user-manual pages; macOS-gated argument/candidate tests |
| The original-repository update checker was absent | `.github/workflows/check-upstream-updates.yml`; `scripts/check-upstream-updates.ps1`; `pnpm upstream:check`; exercised against `BigStrongSun/ccswitchmulti` on 2026-10-10 |

The wizard format matrix additionally covers `base_url`, `baseURL`, `baseUrl`,
embedded TOML `config`, `auth.OPENAI_API_KEY`, `apiKey`, `api_key`,
`experimental_bearer_token`, missing/empty/malformed/mixed catalogs, and alias
precedence in `tests/lib/codexMultiRouterWizard.test.ts`.

## Evidence registry

Each ledger row cites one or more of these current owners. Test references are
included where a focused regression owner exists.

| ID | Current owner and test evidence |
| --- | --- |
| E01 | Provider schema/forms: `src/types.ts`, `src-tauri/src/settings.rs`, `src/components/providers/forms/CodexFormFields.tsx`, `tests/components/CodexFormFields.test.tsx` |
| E02 | Traffic policy and stream recovery: `src-tauri/src/proxy/codex_traffic_policy.rs`, `src-tauri/src/proxy/providers/streaming_retry.rs`, their Rust tests |
| E03 | Usage/accounting/routing: `src-tauri/src/commands/usage.rs`, `src-tauri/src/services/session_usage_codex.rs`, `src-tauri/src/proxy/codex_router_log.rs` |
| E04 | Wizard/workspace: `src/components/codex/CodexMultiRouterWizard.tsx`, `src/components/codex/CodexRouterWorkspacePage.tsx`, `src/lib/codexMultiRouterWizard.ts`, component/lib wizard tests |
| E05 | Catalog lifecycle: `src/components/providers/forms/CodexCatalogViewport.tsx`, `src/components/providers/forms/codexCatalogSync.ts`, `src/lib/codexCatalogReconciliation.ts`, catalog viewport/reconciliation tests |
| E06 | Deep/light protocol probes: `src-tauri/src/protocol_compatibility/runner.rs`, `src/components/providers/forms/CodexProtocolProbeProgressDialog.tsx`, dialog and Rust runner tests |
| E07 | Grouped API keys: `src/components/providers/forms/CodexKeyGroupModels.tsx`, `src/components/providers/forms/codexApiKeyGroupRouting.ts`, their focused tests |
| E08 | Automatic model refresh/change reporting: `src/hooks/useAutoModelRefresh.ts`, wizard change summary, `tests/hooks/useAutoModelRefresh.test.tsx`, wizard tests |
| E09 | Config/runtime consistency: `src-tauri/src/codex_config_consistency.rs`, `src-tauri/src/codex_runtime_refresh.rs`, `src/hooks/useCodexConfigConsistency.ts`, consistency dialog/hook tests |
| E10 | Desktop switch/restart/relaunch: `src-tauri/src/codex_desktop.rs`, `src-tauri/src/codex_windows_launch.rs`, `src-tauri/src/commands/provider.rs`, workspace tests |
| E11 | Error journal and compatibility summary: `src-tauri/src/proxy/error_journal.rs`, `src/components/providers/forms/CodexCompatibilitySummary.tsx`, focused tests |
| E12 | CLI auto-update: `src/components/settings/AboutSection.tsx`, `src-tauri/src/commands/misc.rs`, `src-tauri/src/settings.rs`, `tests/components/AboutSection.test.tsx`, Rust settings/command tests |
| E13 | Request health and summary handoff: `src-tauri/src/proxy/request_health.rs`, `src/components/settings/RequestHealthPanel.tsx`, request-health and summary-handoff tests |
| E14 | Reasoning/projection/model picker: `src-tauri/src/reasoning_capabilities`, `src-tauri/src/codex_multirouter/projection.rs`, `src-tauri/src/resources/codex_model_picker_core.js`, reasoning tests |
| E15 | Model identity/order/version pruning: `src/lib/modelIdentities.ts`, `src/lib/codexModelCatalogOrder.ts`, `src/lib/codexCatalogVersionPruning.ts`, focused tests |
| E16 | Official/manual model fetch: `src-tauri/src/services/model_fetch.rs`, `src/lib/api/model-fetch.ts`, `CodexFormFields` fetch tests |
| E17 | Guardian compatibility: `src-tauri/src/codex_guardian.rs`, Guardian/config tests |
| E18 | History/session resilience: `src-tauri/src/codex_paginated_history_repair.rs`, `src-tauri/src/codex_history_migration.rs`, integrity/history tests |
| E19 | UI/settings/session surfaces: `src/App.tsx`, `src/components/settings`, `src/components/sessions`, component tests |
| E20 | Presets/localization: `src/lib/presetCatalog.ts`, `src/config`, four `src/i18n/locales/*.json` files, locale/preset tests |
| E21 | Subagent V2: `src/components/codex/CodexSubagentProfileEditor.tsx`, `src-tauri/src/codex_subagent_profiles.rs`, `CodexSubagentV2ProfileEditor.test.tsx` |
| E22 | Startup/dev tooling: `scripts/dev-tauri-delayed.mjs`, `scripts/prune-cargo-target.mjs`, capture and cleanup scripts plus node tests |
| E23 | Provider icon/dashboard behavior: provider icon helpers/list components and their component tests |
| E24 | Otty: terminal settings, both Rust launch paths, locale/manual entries, macOS-gated argument/candidate tests |
| E25 | Upstream tracking: `.github/workflows/check-upstream-updates.yml`, `scripts/check-upstream-updates.ps1`, `pnpm upstream:check` |
| E26 | Verified profile propagation: current protocol compatibility profile/runtime owners; legacy `c67d1623` and `1e70517e` are patch-equivalent according to `git cherry` |
| E27 | Hermes loading lifecycle: `src/components/providers/forms/HermesFormFields.tsx` sets local fetch state and clears it in `finally` |
| E28 | Retired global loaders: `DeferredContent`, `GlobalLoadingContext`, `PagedModelList`, and `useLoadCommonConfigSnippet` have no current consumers; local owners supersede them |
| E29 | Repository/release ownership: current `.github/workflows`, local build/release scripts, package scripts, and maintained audit/release docs |
| E30 | Updater status: `src/lib/updater.ts`, update context/badge, and updater/context tests |
| E31 | Database/schema reliability: `src-tauri/src/database`, migrations, and migration regression tests |
| E32 | Sync/backup/store reliability: current sync, backup, database, provider service owners and backend tests |
| E33 | Save/reset contracts: provider mutations/settings hooks and their focused form/hook tests |

## Commit ledger

| # | Legacy commit | Status | Current evidence / disposition |
| ---: | --- | --- | --- |
| 001 | `95444c0b` provider reasoning mode, API key groups, schema | Adapted | E01, E07, E14 |
| 002 | `255f53a5` Codex traffic policy and stream retry | Present | E02 |
| 003 | `b25568aa` usage tracking and provider routing commands | Adapted | E03 |
| 004 | `a3808d85` routing projection, Desktop integration, picker | Adapted | E10, E14 |
| 005 | `7510f7bf` sync, backup, and store reliability | Adapted | E32 |
| 006 | `9fa387f8` skill, plan, preset, and usage services | Adapted | E03, E20, E32 |
| 007 | `92da9f5a` backend integration tests and installer config | Adapted | E29, E31, E32 |
| 008 | `e49c7011` UI types, schemas, and shared hooks | Adapted | E01, E19 |
| 009 | `a917bdc6` router workspace and multi-router wizard | Present | E04 |
| 010 | `730b494a` subagent profile editor V2 | Adapted | E21 |
| 011 | `125c1649` Codex form reasoning and catalog sync | Adapted | E01, E05, E14 |
| 012 | `c582f46c` provider list, usage, sessions, settings, shell | Adapted | E03, E19 |
| 013 | `b75835c0` provider presets | Adapted | E20 |
| 014 | `3662d8f9` Chinese strings migrated to four-locale i18n | Present | E20 |
| 015 | `da8c880d` original repository update checker | Adapted | E25; restored and exercised in this audit. Legacy sponsor URL and one-off cache edits were not carried forward. |
| 016 | `da53d93c` frontend tests for the feature batch | Adapted | E01, E04, E05, E19 |
| 017 | `c67d1623` sync verified profiles into dependent routes | Present | E26 |
| 018 | `1e70517e` inherit verified profiles at route runtime | Present | E26 |
| 019 | `a6fee714` deep protocol probe progress and dialog | Adapted | E06 |
| 020 | `801588a7` raw reasoning rendering in Desktop | Adapted | E10, E14 |
| 021 | `aa08c50d` reasoning field semantics | Present | E14 |
| 022 | `522d6f05` outage vs unsupported-reasoning distinction | Present | E06, E11 |
| 023 | `a1433af5` v3.19.2-18 release bump | Intentionally retired | E29; obsolete version-only state on the fresh base. |
| 024 | `fa8fba61` compilation repairs after legacy cherry-pick | Intentionally retired | The failed legacy merge state does not exist on the fresh base; current owners are covered by E06, E14. |
| 025 | `5b6d4145` react-i18next test mock repair | Adapted | E20; current locale/component suites own the mock contract. |
| 026 | `960261bb` remaining i18n migration and release lockfile | Adapted | E20; the old release lockfile state is retired under E29. |
| 027 | `47e18b20` deep probe flow and enabled-row persistence | Present | E06 |
| 028 | `bf1aac18` engineering journal entries | Intentionally retired | Historical coordination record, no runtime behavior; superseded by this ledger. |
| 029 | `3d3b8e44` sync active profile after switch | Adapted | E09, E10 |
| 030 | `2136c7b0` AGENTS architecture guide and validator | Intentionally retired | Legacy repository policy; current source/test owners are recorded directly here. |
| 031 | `131c4304` Guardian v2 compatibility override | Present | E17 |
| 032 | `754e380f` fork attribution and support links | Adapted | E29; current README/package identity owns attribution. |
| 033 | `8f4fa78d` model label styles and sorting | Adapted | E14, E15 |
| 034 | `043c739d` tiered Codex turn recovery | Present | E02 |
| 035 | `24b4df72` grouped API-key model sync | Present | E07 |
| 036 | `ee0fff19` commits-behind update reporting | Adapted | E30 |
| 037 | `db7f7b77` trailing-line formatting cleanup | Intentionally retired | Formatting-only legacy delta. |
| 038 | `3dea953f` memory release evidence | Intentionally retired | Historical coordination record. |
| 039 | `84595b4a` OpenCode Go quota reset initialization | Adapted | E03, E20 |
| 040 | `022ccf54` Otty tab-aware launching and docs | Adapted | E24; code and all six manual references restored in this audit. |
| 041 | `2295f3e2` Otty locale labels | Present | E24 |
| 042 | `6febc62a` catalog sync, probe skip, and fixes | Adapted | E05, E06 |
| 043 | `6bc7136a` authoritative catalog reconciliation | Present | E05 |
| 044 | `51a33dd9` v3.19.2-20 release bump | Intentionally retired | E29; obsolete version-only state. |
| 045 | `719b2d24` model display, catalog, and lite API fixes | Adapted | E05, E14 |
| 046 | `d2308ad8` follow-up model/catalog/lite API fixes | Adapted | E05, E14 |
| 047 | `aee4ae47` concise legacy release notes | Intentionally retired | E29; release-specific documentation for an obsolete version. |
| 048 | `7354a3f1` GitHub Actions release-build policy | Adapted | E29 |
| 049 | `6f05f009` local memory cleanup and coordination docs | Intentionally retired | Repository housekeeping with no product behavior. |
| 050 | `5fdce983` keep provider saves off deep-probe path | Present | E01, E06, E33 |
| 051 | `7437059d` persistence-only provider saves | Present | E01, E33 |
| 052 | `870a295c` Tauri native backend watcher | Adapted | E22 |
| 053 | `f16a6292` retire markdown leases | Intentionally retired | Legacy coordination policy. |
| 054 | `99d0c37a` bound incremental Cargo cache growth | Present | E22 |
| 055 | `fc4558f0` fork rollout identities | Adapted | E03, E18 |
| 056 | `22d9547f` hand proxy listeners over before relaunch | Adapted | E02, E22 |
| 057 | `147c51f5` cancellable light protocol checks | Present | E06 |
| 058 | `04f1bedb` native Responses prompt-cache routing | Present | E02, E14 |
| 059 | `1faf6c31` default gpt-5.6-sol reasoning to medium | Present | E14 |
| 060 | `fd5743d1` exclude disabled catalog models from routing | Present | E05 |
| 061 | `67c72b3d` conservative upstream capability projection | Present | E14 |
| 062 | `6d7fb9b8` preserve picker reasoning schema aliases | Present | E14 |
| 063 | `646b2cf0` compact model picker labels | Present | E14 |
| 064 | `fb265197` stop retrying terminal daily quota errors | Present | E02 |
| 065 | `ceee2277` label upstream conversion formats | Present | E11, E14 |
| 066 | `715f60a5` prompt-cache routing scope documentation | Adapted | E14; current code/tests are the maintained contract. |
| 067 | `19e2800f` recovery/routing memory entry | Intentionally retired | Historical coordination record. |
| 068 | `d8a97485` filter ultra from reasoning aliases | Present | E14 |
| 069 | `84a10d31` consolidated proxy/session resilience | Adapted | E02, E03, E13, E18 |
| 070 | `85588107` expanded provider and diagnostics workflows | Adapted | E01, E06, E11, E19 |
| 071 | `3bd5386d` repository docs and development tooling | Adapted | E22, E29; obsolete legacy notes are retired. |
| 072 | `dd6b9c1f` inferred icons and open-only dashboard | Present | E23 |
| 073 | `72a73a06` dashboard contract coverage | Adapted | E19, E23 |
| 074 | `9e03eb34` persist inferred favicons across forms | Present | E23, E33 |
| 075 | `ccbe0569` coordination and Cargo target safeguards | Adapted | E22; coordination-only markdown is retired. |
| 076 | `a9e0977d` Guardian v2 live-config compatibility | Present | E17 |
| 077 | `06fec03e` probe catalog models on assigned transports | Present | E06 |
| 078 | `89f18bb1` bounded history and request accounting | Present | E03, E18 |
| 079 | `50e966b1` require protocol groups before verification | Present | E01, E06, E07 |
| 080 | `c32182c9` router health and runtime compatibility | Adapted | E09, E11, E13 |
| 081 | `c5ab3c15` sanitize orphan tool outputs | Present | E02, E18 |
| 082 | `94ed28f3` merge paginated parent rollouts | Present | E18 |
| 083 | `0be342e9` delayed Tauri dev script and cache script tests | Present | E22 |
| 084 | `3d81dc37` light-probe dialog interaction test alignment | Adapted | E06 |
| 085 | `5d30ae4b` full subagent override interaction tests | Adapted | E21 |
| 086 | `bd1c95de` canonical branch memory entry | Intentionally retired | Historical coordination record. |
| 087 | `77fa09e4` isolate development auto-launch ownership | Present | E22 |
| 088 | `165dca04` request-health summary handoff lifecycle | Present | E13 |
| 089 | `e883528b` centralized curated icon resolution | Present | E23 |
| 090 | `7ac19a33` open router choices directly in editor | Present | E04 |
| 091 | `79326b52` schema migration regression | Present | E31 |
| 092 | `2ae19e4d` startup/handoff root-cause memory | Intentionally retired | Historical coordination record. |
| 093 | `87306b2e` September upstream audit memory | Intentionally retired | Historical coordination record. |
| 094 | `fd28a900` single-main consolidation memory | Intentionally retired | Historical coordination record. |
| 095 | `d0003611` concurrent probe transports and target queue | Present | E06 |
| 096 | `d5067c2e` concurrent-probe formatting | Intentionally retired | Formatting-only delta; behavior is covered by E06. |
| 097 | `5250e267` catalog viewport and key-group components | Present | E05, E07 |
| 098 | `ce7e3156` catalog and vendor compatibility fixes | Adapted | E05, E11, E14 |
| 099 | `b3458592` API-key group routing and version pruning | Present | E07, E15 |
| 100 | `2145e181` competing-writers audit | Intentionally retired | Historical audit; current runtime ownership is E09 and E10. |
| 101 | `2d4dc218` Hermes loading-state management | Adapted | E27; local fetch state supersedes the removed global loader. |
| 102 | `71ed3931` catalog management and config loading | Adapted | E01, E05 |
| 103 | `75a380f0` reasoning capabilities and provider handling | Adapted | E01, E14 |
| 104 | `ae4f7c16` avoid repeated renderer graph scans | Adapted | E09, E14; current runtime/model-picker ownership supersedes the legacy scan path. |
| 105 | `0e5e2fdd` prevent deferred loaders from sticking | Intentionally retired | E28; the affected global/deferred loader owners no longer exist. |
| 106 | `e72f8770` preserve explicit form resets | Present | E33 |
| 107 | `91e5f0de` reasoning source contract alignment | Present | E14 |
| 108 | `9219d879` accordion accessibility test contract | Adapted | E19; current component tests own the accessibility contract. |
| 109 | `97acea3e` reference-audit memory verdict | Intentionally retired | Historical coordination record. |
| 110 | `2d5da310` compatibility template formatting | Intentionally retired | E28; `codex_app_compat_template.js` is superseded by current inline/core compatibility owners. |
| 111 | `1a71f3a2` automatic model refresh and Codex UI changes | Present | E08 |
| 112 | `d55d7212` model ranking and search | Present | E14, E15 |
| 113 | `8fbf4a84` automatic CLI update and restart confirmation | Present | E12 |
| 114 | `dc1d92d3` readability/structure refactor | Adapted | No standalone behavior; affected current owners are E09, E14, E19. |
| 115 | `c0a5dc5d` non-disruptive Tauri capture playbook | Present | E22 |
| 116 | `026725b2` live Tauri page audit and capture helper | Adapted | E22; prior screenshots are historical, helper/tests remain current. |
| 117 | `ffce727c` preserve model rank across visible renames | Present | E15 |
| 118 | `0df9e2e1` reconcile active router projection on startup | Present | E09, E14 |
| 119 | `4692e23e` recover provider-suffixed order names | Present | E15 |
| 120 | `f13fd415` config consistency and runtime refresh | Present | E09 |
| 121 | `a5b8f223` recover OAuth pool from temporary avoidance | Present | E02 |
| 122 | `d5a38ae4` localized session traffic status and mocks | Adapted | E03, E19, E20 |
| 123 | `50b8d22d` summary handoff aligned with CLI 0.155 | Present | E13 |
| 124 | `fa058fa9` snooze request-health reminders | Present | E13 |
| 125 | `9ba7af37` authenticated summary prompt envelope | Present | E13 |
| 126 | `3a4e5fd9` startup port ownership retries and verification | Present | E22 |
| 127 | `5a967788` preserve reasoning fallback in catalog projection | Present | E14 |
| 128 | `11c0f762` 5 GB Cargo cleanup threshold and docs | Adapted | E22 |
| 129 | `973a0c94` model-list change dialog and refresh tests | Adapted | E08; change reporting is integrated into the current wizard rather than the old shared dialog. |
| 130 | `29c351f2` Desktop proxy management and catalog sync | Adapted | E05, E09, E10 |
| 131 | `af372abd` switch Codex provider with Desktop restart | Present | E10 |
| 132 | `5f79e5e3` error journaling and compatibility summary | Present | E11 |
| 133 | `49e26ab5` deferred Codex relaunch and proxy commands | Present | E10 |
| 134 | `849a0915` model handling and component coverage | Adapted | E05, E14, E16 |
| 135 | `6046562b` preserve catalog selections during refresh | Present | E05, E15 |
| 136 | `80ce178c` include fetched models without losing selections | Present | E05, E16 |
| 137 | `e2de7a61` precise startup launch-skip reasons | Present | E10 |
| 138 | `21359b83` approval and verification record policy | Intentionally retired | Legacy coordination policy, no product behavior. |
| 139 | `49572219` user-directed delivery exception record | Intentionally retired | Historical delivery record, no product behavior. |
| 140 | `2c551bb3` manual official-model catalog refresh | Present | E16 |
| 141 | `e880d248` Codex model handling and reasoning picker | Adapted | E14, E16 |
| 142 | `1ea62238` wizard collision and OAuth test coverage | Present | E04 |
| 143 | `4d9319b1` Codex service refactor and behavior fixes | Adapted | E02, E04, E09, E13, E14 |
| 144 | `1ef05d20` AGENTS approval-policy corrections | Intentionally retired | Legacy repository policy, no product behavior. |
| 145 | `dac5094a` unified model-catalog identity propagation | Present | E04, E15 |

## Verification requirements

The ledger is complete only when a mechanical check finds exactly 145 numbered
rows and zero `Missing` statuses. The implementation must also pass the focused
wizard/catalog/request-health suites, TypeScript typecheck, renderer build,
format/diff checks, and suitable Rust checks. A future fresh desktop audit should
exercise the rebuilt wizard and settings workflows, and a macOS audit should
exercise Otty tab launch plus window fallback in the actual application.

## Follow-up workflow audit (2026-10-11)

The renderer audit found and fixed a wizard gate mismatch: disabled catalog
rows are retained for recovery, but they must not count as routeable models.
The Models page remains editable after deselecting every model, while Next,
route preview, and save gates require at least one enabled model. Disabled
recovery rows render unchecked under automatic-follow mode. Regression coverage
now exercises deselect, blocked Next, and automatic-follow recovery.

Evidence from the follow-up run:

- Wizard, flow, catalog viewport, version pruning, and Request Health suites:
  74 focused tests passed; Request Health/catalog subset: 45 tests passed.
- Focused wizard coverage is 84.76% statements and 84.86% branches for the
  component, with 92.92% statements for the flow module. The remaining lines
  are mostly migration/readback and late error/render branches, so this is
  strong workflow coverage rather than a claim of 100% branch coverage.
- Renderer typecheck passed.
- Renderer production build passed.
- Rust library suite passed: 4,459 passed, 0 failed, 10 ignored.
- The default parallel Vitest run reached 1,962 passing tests but had 10
  failures in four unrelated suites. Each failed suite passed alone: Pi form
  46/46, Codex preset 20/20, Sub-Agent V2 127/127, and Provider Actions 5/5.
  The deterministic one-worker run then passed all 237 files and 1,977 tests
  (`--pool=forks --maxWorkers=1 --minWorkers=1`) in 898.97 seconds. The parallel
  failures are therefore test-harness isolation noise, not product failures.

These are source, renderer, and native-library checks. A fresh interactive
Tauri desktop session was not completed in this follow-up, so native window
interaction and upstream live model/protocol requests remain runtime evidence
to collect separately.
