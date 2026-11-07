# Duplication, Codex schema compatibility and CC Switch logs — November 4, 2026

## Historical evidence cleanup — November 8, 2026

The `.tmp/` paths below are historical scratch locations removed during the
user-authorized cleanup on November 8, 2026. Structured findings and verification
conclusions remain in this audit; those paths are no longer retained artifacts.
This cleanup provides no new live-runtime or UI verification, and the audit's
existing live-verification limitations remain unchanged.

## Scope and status

Read-only investigation of source revision
`f2d9ef921169965b8d41b914c24893ee9d0b88a3` on `main`. The source working tree
was clean at the start. No application, Codex config, provider state, billing
ledger, dependency, or production source was changed. This report is the only
tracked addition.

This is a bounded clone/ownership audit, not a claim that all semantic duplication
or every historical client compatibility issue has been found. Source inspection,
offline generated schemas and existing logs are reported separately.

## Findings in brief

1. There is function-level duplication and repeated identity/compatibility logic;
   there is no evidence from this scan that whole production files are broadly
   duplicated.
2. Updating the globally installed Codex CLI on every CC Switch update is not a
   demonstrated requirement. CC Switch-owned persisted schemas and the schemas
   consumed by an actual Codex binary are different contracts.
3. Two different local Codex installations exist, but their exported app-server
   schemas are structurally identical in this snapshot.
4. The inspected CC Switch logs show provider overload/transport failures and
   usage-import safety deferrals, not a schema/config parsing failure. The last
   recorded renderer compatibility installation was incomplete; this is not a
   fresh UI verification.

## 1. Duplication audit

### Scan results and limitations

- Checked **775** production `.ts`, `.tsx`, `.js`, and `.rs` files under `src`
  and `src-tauri/src`, excluding separate `.test.ts/.test.tsx` files and
  resource bundles. Normalized CRLF/LF before comparing full-file SHA256 values.
  **Zero exact duplicate file groups** of at least 250 bytes were found.
- Parsed TypeScript/TSX source with the installed TypeScript AST, examining
  **4,020 block-bodied functions/methods/arrows**. Compared exact nontrivia token
  bodies with at least 90 tokens and ten lines. Found **one cross-file exact
  function-body clone group**.
- These are exact-copy checks, not a percentage-based near-clone detector.
  Renamed variables, partial copies, Rust function bodies, cross-language
  equivalents, tests, and generated/resource data are not established as
  duplicate-free. Inline Rust tests remain part of their source files for the
  file-level check.

### Concrete duplicates and ownership risks

| Area                                        | Evidence                                                                                                                                                            | Assessment / appropriate consolidation                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model-fetch callback                        | `src/components/providers/forms/GeminiFormFields.tsx:79–104` and `src/components/providers/forms/OpenClawFormFields.tsx:155–180` contain the same 142-token body.   | Confirmed exact copy: URL/key preflight, fetch, success/empty/error notifications and loading cleanup. Candidate for a shared fetch hook; not proof of a current functional defect.                                                                                                                                                                                                                       |
| Generated credential-group recognition      | `src/components/providers/forms/codexApiKeyGroupRouting.ts:28`, `src/lib/codexMultiRouterWizard.ts:524`, `src/lib/codexConfigSanitizer.ts:72`.                      | Repeated semantic rule. Form/wizard detection accepts the `--ccg-` name marker as well as explicit metadata; the sanitizer's index uses explicit metadata. Existing callers have contextual normalization, so the difference is a contract/drift risk, not a newly demonstrated end-to-end bug. A single per-language predicate with an explicit legacy-name policy would make the distinction auditable. |
| Public-row/alias projection                 | `src/components/codex/CodexRouterWorkspacePage.tsx:2347`, `src/lib/codexMultiRouterWizard.ts:1360`, `src-tauri/src/codex_multirouter/compiler.rs:329,447`.          | Multiple implementations of related ownership rules. TS preview and Rust runtime boundaries are legitimate, but should share fixtures and exact precedence/disabled/include cases. Do not replace them with global upstream-name matching or a second persisted catalog. This area already caused the prior shared-wire regressions.                                                                      |
| CLI lifecycle command definitions           | `src/components/settings/AboutSection.tsx:134–154` and `src-tauri/src/commands/misc.rs:766–775` repeat install-command knowledge, including `@openai/codex@latest`. | A real duplicated maintenance surface, though the frontend copy is explanatory/copyable and the backend is lifecycle execution. Prefer authoritative backend-generated plans or contract fixtures. The presence of an `@latest` install command is not a runtime schema-compatibility requirement.                                                                                                        |
| Consumer detection/template/cache ownership | `src-tauri/src/codex_config.rs:78–80,2166,2323,2594,2644,3095,3205`.                                                                                                | Highest-value compatibility review target. Shared cache/template discovery, CLI candidates and Desktop package-version gates do not identify every actual consumer by the same executable/schema fingerprint. More detail below. This is an identified architecture risk, not proof of today's request failures.                                                                                          |

Not all repeated data should be deleted. Provider `modelCatalog` is canonical;
`cc-switch-model-catalog.json`, `models_cache.json`, inline compatibility rows and
renderer payloads are derived projections for different consumers. The correct
fix is controlled ownership and invalidation, not removing a projection because
it resembles another file. `pnpm catalog:check` passed during this investigation.

## 2. Does Codex CLI always have to be upgraded?

### Separate the contracts

| Contract                                                                     | Owner / consumer                                                                                                               | Consequence                                                                                                                                                                                         |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modelCatalog`, capability `schemaVersion`, `codexRouting.schemaVersion = 2` | CC Switch persistence/frontend/Rust. See `src/lib/codexCatalogSchema.ts` and `src-tauri/src/codex_multirouter/schema.rs:1–38`. | An internal CC Switch schema change is not itself a demand to upgrade Codex. CC Switch must migrate/validate its persisted state.                                                                   |
| `config.toml` and external `model_catalog_json` content                      | The particular Codex process loading them.                                                                                     | A parser-breaking change or newly requested feature may require a compatible client or a CC Switch adapter change. That is feature/version-specific, not automatically “install latest every time.” |
| App-server JSON-RPC schema                                                   | The actual app-server binary.                                                                                                  | Generate the schema with that binary; a globally installed CLI and a Desktop-owned binary are not automatically the same installation.                                                              |
| Provider Responses/Chat/Anthropic request schema                             | The selected upstream provider and CC Switch's protocol adapter.                                                               | A provider rejection, overload or transport failure is a separate boundary; a CLI upgrade does not repair gateway capacity.                                                                         |

Official OpenAI documentation states that generated app-server schema artifacts
match the version of the executable that generated them. References consulted:
[Codex app-server](https://developers.openai.com/codex/app-server/) and
[configuration reference](https://developers.openai.com/codex/config-reference/).
The exported app-server schema is not, by itself, validation of external catalog
files or the entire TOML configuration.

### Local version and offline schema evidence

| Consumer                                                                                                                                     | Observed installed version  |
| -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Terminal/npm CLI, `C:\Users\Felix\AppData\Roaming\npm\codex.ps1`                                                                             | `codex-cli 0.166.0`         |
| Codex app-owned executable referenced by active `CODEX_CLI_PATH`, `C:\Users\Felix\AppData\Local\OpenAI\Codex\bin\a159911ff70742e9\codex.exe` | `codex-cli 0.166.0-alpha.6` |

Both were invoked offline with:

```text
<actual binary> app-server generate-json-schema --out <separate temporary directory>
```

Both exited zero and exported **321 JSON files**. Parsing and comparing each
matching file found **zero structural differences**, with no filenames unique
to either side. In both exports, app-server `ReasoningEffort` is a nonempty
string, not a closed enum capped at `max`. This does not grant a provider native
Ultra support or bypass CC Switch's V1/V2/orchestration validation.

Historical evidence location:
`H:/repos/ccswitchmulti-refork/.tmp/continuation-schema-audit-20261104/schema-comparison.sanitized.json`.
The report recorded versions, generation exit codes, schema hashes and comparison
scope. No update/install, inference request or config edit was performed.

Therefore **there is no exported app-server-schema reason, for these two
observed builds, to force an npm CLI update**. This says nothing about all past
or future versions. Updating npm also need not update the app-owned executable.

### Why an upgrade might appear to help, and the real code risk

The model-template loader currently prefers shared `models_cache.json`, then
tries CLI candidates (PATH/common package-manager locations), then uses static
fallback templates (`codex_config.rs:2644–2660`). Source comments at
`:2587–2593` explicitly acknowledge that different installations serialize
different `ModelInfo` shapes into the same cache. Parser-required compatibility
fields are backfilled, which is already an adapter—not an always-latest policy.

Template and bundled-model caches use process-wide `OnceCell`s
(`:78–80,2402,2676`) rather than a key for every consuming executable/schema.
The inline-model compatibility gate is based on the detected Desktop package
version (`:3095,3205`), while the template probe tries CLI candidates (`:2323`).
Consequently, “the CLI that supplied metadata” and “the process consuming the
projection” are not guaranteed to be the same.

An upgrade accompanied by a restart/cache rewrite could therefore look like a
schema fix, even when invalidation or consumer selection was the real issue.
That is a source-supported hypothesis, **not proof of what caused a particular
past incident**. Running model managers may also retain startup snapshots; a
refresh/restart and an upgrade are different operations.

Recommended direction: one derived compatibility profile keyed by actual
consumer executable/version/schema fingerprint, with bounded validation of
config keys/catalog shape, explicit feature minimums, and per-consumer cache
invalidation. Preserve one canonical provider catalog. Do not solve this by
adding another persistent schema snapshot or by requiring unknown “latest”
versions indiscriminately.

## 3. CC Switch log findings

No local Codex automation registry was present. The repository's existing
structured diagnostics script was used instead; no direct UI/CDP automation or
paid provider probe was substituted.

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/codex-oauth-diagnostics.ps1 -LogTailLines 300 -SinceMinutes 180
```

Configured logs: `C:/Users/Felix/.cc-switch/logs`.
Structured snapshot: **November 4, 2026, 10:50:43 Singapore time**. Follow-up was
bounded to existing app/router/proxy logs and one rotated proxy file, with fixed
cutoff **11:04:12 Singapore time**; active conversation traffic was not followed
indefinitely.

### Observed events

- **Zero observed schema/config parse failures** or unknown-field rejections in
  the scoped checks. Absence in these logs is not proof that every Codex console
  or app log is error-free.
- Initial 300-event router snapshot: 28 upstream HTTP 200 statuses and 28
  response-ready statuses; no capacity/error candidates. HTTP 200/readiness
  does not prove a stream completed successfully.
- **Two actual overload SSE failures** at **10:56:11** and **10:57:33**: HTTP 200,
  then `response.failed`, `service_unavailable_error` / `server_error`.
- **Three 120-second stream-idle timeouts**: **10:53:38, 10:58:37, 11:00:15**.
- **Two remote connection resets**, `os error 10054`, at **11:02:41, 11:03:20**;
  classified as potentially pending rather than safe-to-replay connect failure.
- **One stream-body EOF** at **11:04:12** while reading a chunk-size line.
- 387 `sse_inspection_limit` and 103 `response_consumption_stopped` diagnostic
  records in the bounded proxy-log scope. Inspection bounds and a consumer
  stopping reads are not, by themselves, upstream failures.

These observations do not establish that upgrading Codex would fix the errors.
The directly observed problems are upstream capacity/transport and stream
silence, not incompatible schema parsing.

### Other warnings requiring separate treatment

- Latest recorded renderer compatibility installation had not finished at
  **10:12:25**. At **10:12:26**, payload installation logged 33 models,
  15 Max models and eight Ultra models, but status **Pending** and
  `app_server_ready=false`. This is a recorded installation/observation gap,
  not proof that the currently visible UI is still failing. Earlier 09:48:47
  Ready/zero-mismatch evidence must not be reused as current acceptance.
- History provider migration refused to rewrite compressed `.jsonl.zst`
  byte-addressed history. This is a safe stop, not permission to decompress or
  rewrite files in place.
- The day's log counters included 30 legacy billed-pagination deferrals and
  668 copied-fork-prefix-proof mismatch warnings. Latest sync before cutoff,
  **11:02:53**, reported **217 deferred / 228 scanned**. These concern usage
  import/accounting, not live inference routing. Do not remove the guards or
  replay billed history merely to clear warnings.
- App marker: version `3.20.4-3`, started **10:11:54.511**, PID 45696,
  `H:/repos/ccswitchmulti-refork/src-tauri/target/debug/cc-switch.exe`.
  No source commit is recorded; app version alone cannot prove which source
  revision was built into the running executable.

Sanitized evidence:
`H:/repos/ccswitchmulti-refork/scripts/logs/codex-oauth-diagnostics/20261104-105042/log-audit.summary.sanitized.json`.
The diagnostics directory is ignored by Git. No raw credentials or provider
request bodies are included in this report.

## 4. Verification boundary and next priorities

- `pnpm catalog:check` — passed.
- Both installed binary version commands and offline schema generations —
  passed; 321 versus 321 files, zero structural differences.
- Source-only exact duplicate scans — completed, with limits above.
- No production source was changed, so the previous feature suites were not
  rerun or claimed as fresh verification for this read-only audit.
- No upgrade, app restart, renderer repair, history rebuild, paid request,
  commit or push was performed.

Highest-value follow-up order: identify the actual running consumer and build;
verify the recorded incomplete renderer installation through the configured
monitor; consolidate consumer-aware schema/cache selection with regression
fixtures; handle history accounting only through controlled repair; then extract
low-risk form/helper copies. Do not use a blanket latest-CLI upgrade as the
first diagnostic step.
