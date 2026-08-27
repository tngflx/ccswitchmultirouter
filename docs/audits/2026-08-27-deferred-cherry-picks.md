# Deferred Cherry-Pick Deep Dive (2026-08-27)

This audit covers the commits previously deferred or rejected from
`farion1231/cc-switch` (`upstream/main`) and the related BigStrongSun release
chain. The working tree contains deliberate fork changes, so the verdicts are
about behavior, not whether a textual cherry-pick happens to apply.

## Scope Boundary

This is a completed deep dive for the deferred/rejected set identified in the
initial upstream review, plus all 13 commits in the current
`HEAD..bigstrongsun/main` release chain. It is not a verdict for every commit
in the current `HEAD..upstream/main` range: that range contains 93 commits as
of 2026-08-28, including earlier features and fixes not part of the deferred
set. A future complete upstream synchronization audit must inventory all 93
commits, inspect every changed file per commit, and record a verdict before
claiming full `upstream/main` coverage.

## Method

For every commit we inspected the complete file list and patch, searched the
fork for the affected symbols and call paths, and checked the relevant tests.
No commit was applied wholesale when it touched OAuth ownership, Codex live
projection, or the MultiRouter schema. A narrow port was made only where the
invariant was independent of those fork contracts.

## Upstream 0.149 configuration chain

These nine commits form one interdependent migration series. Their shared goal
is to make Codex 0.149 provider tables loadable, migrate stale reserved IDs,
backfill display names, and avoid committing a switch before preflight passes.
The fork already has a later, fork-specific implementation of the same
pipeline, including MultiRouter projection and takeover preservation.

| Commit | Upstream change | Fork parity | Verdict | Benefit / risk of including upstream |
| --- | --- | --- | --- | --- |
| `58687bd6` | Moves a stranded legacy-reroute doc comment back above its function. | The fork's `normalize_codex_legacy_openai_reroute` has its own complete comment and additional safety notes. | **Reject wholesale; no code needed.** | No runtime benefit. Cherry-picking only creates comment churn and can move documentation away from fork-specific helpers. |
| `877df74f` | Backfills provider names on official writes and rejects 0.149-invalid table combinations before writing. | `preflight_codex_provider_table_conflicts`, provider-name backfill, and projection preflight already run in the fork's customized writer. | **Reject wholesale; superseded.** | The invariant is valuable, but the upstream implementation does not know the fork's managed facade, OAuth preservation, or router tables. Porting it would risk rejecting valid fork-generated tables or bypassing projection. |
| `798602c3` | Extends name backfill to custom tables while excluding Bedrock. | The fork already distinguishes official/custom/Bedrock tables and preserves user-authored names through catalog projection. | **Reject wholesale; superseded.** | Bedrock exclusion and name hygiene are useful, but the fork's resolver and catalog metadata are richer. The upstream replacement logic could erase aliases and route-owned fields. |
| `93bb91aa` | Makes migrated tables loadable, follows non-fallback routes, and unreserves `oss`/`ollama-chat`. | Reserved IDs, legacy migration, route matching, and provider-specific fallback rules are already encoded in `CODEX_RESERVED_MODEL_PROVIDER_IDS` and the MultiRouter resolver. | **Reject wholesale; superseded.** | The upstream reserved-ID list is not compatible with the fork's exact-match and router facade rules. Selective ID additions require a separate compatibility decision, not a cherry-pick. |
| `bb54e87a` | Makes migration credential-aware, uses an exact shared-provider predicate, and migrates all reserved IDs. | The fork has credential-aware auth gates, exact reserved-ID matching, and provider-context-aware projection. | **Reject wholesale; superseded.** | The security intent is good, but replacing the fork predicate could route preserved OAuth to third-party endpoints or alter grouped/API-key behavior. |
| `43818101` | Renames stale reserved tables losslessly, handles inline tables, and matches reserved IDs exactly. | The fork's TOML merge/replace and migration code handles inline/table-like forms and protects user-owned fields. | **Reject wholesale; superseded.** | Lossless migration is desirable, but upstream assumes a simpler single-provider writer and can overwrite the managed MultiRouter facade. |
| `9a1a6b83` | Migrates stale `openai` tables, suffixes collisions, and surfaces auth-cleanup failures. | The fork has stale reserved-provider migration, suffixing, explicit auth cleanup, and takeover recovery warnings. | **Reject wholesale; superseded.** | Error surfacing is useful, but the upstream cleanup path is not takeover-aware and could delete the live ChatGPT login that the fork deliberately preserves. |
| `97a7425f` | Preflights before committing the current provider and shares normalization with proxy paths. | The fork preflights before current-provider commit and uses the same normalization in direct, proxy, and MultiRouter paths. | **Reject wholesale; superseded.** | The ordering invariant is already present. Cherry-picking would duplicate writer state and risk a partial switch that skips projection read-back. |
| `cbb79127` | Unifies provider switching around config-only auth writes and adds broad service tests. | The fork's `write_codex_live_for_provider`, config-only restore path, OAuth preservation, bearer projection, and takeover writer are intentionally split by ownership. | **Reject wholesale; superseded.** | Config-only writes protect OAuth, but the upstream refactor collapses distinctions the fork needs: official account switching, third-party bearer ownership, proxy takeover, and router projection. |

## Other upstream deferred/rejected commits

| Commit | Upstream change | Fork parity | Verdict | Benefit / risk of including upstream |
| --- | --- | --- | --- | --- |
| `c5e4f705` | Stamps `requires_openai_auth` to match whether the official login is preserved during a third-party switch, but only for bearer/env-key tables. | **Narrow subset now manually ported.** The fork writes the bearer first, then aligns the active custom table; keyless header-auth tables remain untouched. Takeover writes bypass the stamp as intended. | **Include the narrow manual port; reject the commit.** | Prevents Codex 0.149 from showing the login UI when `auth.json` was intentionally removed, while keeping a preserved login visible when requested. Whole-commit risk is replacing fork-specific write planning. |
| `926af949` | Always projects provider edits to live files, adding broad locks/outcome handling. | `sync_live_for_provider_respecting_takeover`, `LiveSyncOutcome`, per-app locks, stale-backup handling, universal child reprojection, and projection warnings already cover this. | **Reject wholesale; superseded.** | The upstream reliability goal is already implemented. Its simpler live ownership model can overwrite takeover state or omit MultiRouter child reprojection. |
| `0ae561b8` | Runs the WSL2 contract test from a prebuilt Windows test binary compiled with native `TEMP`/`TMP`, avoiding MSVC manifest failures on UNC paths. | Current `.github/workflows/ci.yml` has no `backend-windows-wsl2` job; it only has frontend and backend matrix jobs. | **Defer as inapplicable.** | Valuable if a WSL2 job is restored. Adding the missing job is a separate CI feature requiring runner validation; cherry-picking this patch alone changes nothing useful. |
| `5ca9459d` | Indexes Pi session files to deduplicate usage lookups. | `src-tauri/src/services/session_usage_pi.rs` does not exist in this fork and Pi session usage is not implemented. | **Reject as inapplicable.** | No reachable code path or test target exists. Porting it would add an orphan implementation without the Pi session model. |
| `c2ec78dd` | Reworks OAuth/account isolation across config, commands, forwarder, managed-auth hooks, and tests. | The fork already has managed OAuth markers, account pools, credential generations, takeover preservation, and MultiRouter auth routing. | **Reject wholesale.** | Account isolation is important, but this 13-file rewrite assumes upstream ownership semantics and would regress managed takeover/account-pool behavior. Port only a separately demonstrated invariant. |
| `6243e20a` | Validates JWT protected headers and adjusts identity tests/service wiring. | The fork retained its own identity/account architecture. The independent security invariant is now manually ported in `parse_jwt_claims`: exactly three segments, valid header JSON, non-empty `alg`. | **Include the narrow JWT validation; reject the commit.** | Prevents malformed three-segment strings from becoming OAuth identities or workspace bindings. The rest of the commit conflicts with fork-specific OAuth and proxy service contracts. |
| `bbe8bb93` | Reconciles the edit form's displayed API key with the live provider-scoped bearer. | The fork now reconciles only Codex live snapshots, skips official providers, preserves stored auth templates, and avoids converting OAuth-only providers. | **Include the narrow UI reconciliation; reject the commit.** | Eliminates stale shared `auth.json` keys in the edit form without changing SSOT or OAuth ownership. Upstream's full form/hook rewrite would remove fork live/takeover/MultiRouter semantics. |

## BigStrongSun release-chain commits

These were not safe cherry-pick candidates because this fork already contains
the feature work in adapted form. They are recorded here to make the “defer”
decisions explicit.

| Commit | Behavior | Verdict |
| --- | --- | --- |
| `a7e87d1d` | Sync verified protocol profiles into dependent routes. | **Already adapted.** Current projection/compiler synchronizes verified profiles while preserving route overrides. |
| `584a1834` | Inherit verified provider profiles at route runtime. | **Already adapted.** Runtime resolution uses provider-aware profile inheritance and fork classification. |
| `1a3ccd1a` | Backend deep protocol probe with staged progress. | **Already adapted.** The fork has the backend probe runner, progress dialog, i18n, and catalog ownership checks. |
| `8b38cba4` | Render raw reasoning in Desktop. | **Superseded by `23a3df8e`.** The final reasoning semantics are present; no obsolete `CodexReasoningClient` path remains. |
| `23a3df8e` | Preserve reasoning field semantics across transformations. | **Already adapted.** Strict reasoning normalization and `ReasoningContentMode` behavior are present. |
| `b5395d80` | Distinguish probe outages from unsupported reasoning. | **Already adapted.** Probe classification preserves retryable outage versus capability failure. |
| `128aaf4d` | Release version bump. | **Reject as release metadata.** Version changes are made by this fork's release process. |
| `ad3086ac`, `60850970`, `8ce6cc99`, `0dee0edd`, `92478954`, `e470fff4` | Memory/release publication notes. | **Reject as historical documentation.** The fork keeps its own journal and audit evidence. |

## Final decision

The only deferred upstream work with an independently safe runtime benefit was
ported as narrow invariants: JWT header validation, live bearer reconciliation,
and `requires_openai_auth` alignment. The 0.149 migration and live-projection
commits are behaviorally superseded by the fork's richer implementation; the
OAuth rewrite is too coupled to upstream ownership assumptions; WSL2 and Pi
commits have no applicable target in this tree.
