# Stale-behavior and BigStrongSun assimilation audit — November 2, 2026

## Scope and status

This is a fresh source-level audit, not a copy of the October 28 acceptance
record. The reported Model order effort mismatch triggered a wider comparison
with the configured BigStrongSun upstream. The scope is a targeted cross-layer
review of capability retrieval, provider forms, wizard/routing identity, usage
accounting, and retry safety, plus the complete 38-commit upstream-only matrix.
It is not an assertion that every file or feature in the codebase is stale-free.
Commit ancestry is classified below before importing anything: a different commit identity is not proof that its
behavior is missing.

**Implementation and source/build verification are complete.** Final combined
checks below ran after the implementation freeze on November 2, 2026. Earlier
uncommitted Ultra/shared-resolver changes were preserved, then verified together
with this audit's additional fixes. All required gates passed; no guard was
removed or weakened. The checkout remains on `main` with uncommitted changes:
no merge-for-ancestry, commit, push, desktop installation or live-provider audit
is implied by these results.

## Source identity and freshness

- Local branch remains `main`; its starting revision and `origin/main` were both
  `6ed3feebe4d74db3259e3ea233de40dddcefd4f6` (committed October 30, 2026,
  10:54:33 +08:00).
- After the coordinating session fetched the configured `upstream`, its `main`
  was still `46398018f5e6810eaf69901f228f3191deeb4c4e`, committed October 20,
  2026, 11:08:35 +01:00. This is the same product main revision reviewed on
  October 28, not a newly published November product commit.
- `git rev-list --left-right --count main...upstream/main` reported **59 local-only
  / 38 upstream-only** commits at the starting revision. The upstream-only set
  consists of **34 non-merge commits and four PR merge commits**. These numbers
  describe ancestry, not 38 missing features.
- `origin` remains the fork `tngflx/ccswitchmultirouter`. The BigStrongSun remote
  remains fetch-only. This review does not repoint a remote, switch branches,
  fabricate a merge for ancestry, or authorize a push.
- The fetched remote-tracking inventory contains 148 refs including symbolic
  `upstream/HEAD`. Only two branch tips are newer than upstream main, and both
  are unmerged dependency proposals:

| Fetched branch                                              | Tip                                        | Committed                      | Meaning                                                                      |
| ----------------------------------------------------------- | ------------------------------------------ | ------------------------------ | ---------------------------------------------------------------------------- |
| `upstream/dependabot/npm_and_yarn/frontend-deps-75c2d8edd2` | `596bf91630b74dfe7e04118c55b7b9bc0033dcb5` | October 25, 2026, 16:56:55 UTC | Proposal for 56 frontend dependency updates; not a merged UI/product change. |
| `upstream/dependabot/cargo/src-tauri/cargo-deps-e1ac7862cf` | `b35e83ddd05a60af0be877edaf6d5a73fbc38da4` | October 25, 2026, 16:48:35 UTC | Proposal for 38 Cargo dependency updates; not a merged backend change.       |

Other fetched branch tips are older than October 20. Their presence does not
make them newer mainline work. Unmerged dependency batches are not silently
installed as part of behavioral assimilation; they require their own dependency
compatibility and frozen-lockfile validation.

Freshness here means the fetched configured source refs. It is not a claim about
the newest release artifact, the installed application, or live provider behavior.

## Complete upstream-only commit classification

Categories:

- **Adapted**: behavior already has a local implementation; preserve stronger
  local catalog, account-trust, routing, retry, and persistence boundaries.
- **Partial / gap**: earlier adaptation did not cover the complete upstream
  behavior; new source/test work is required.
- **Safety adaptation / configurable alternative**: retain upstream fail-closed
  safety boundaries through the existing configurable local owner rather than
  introducing a competing or unconditional retry policy.
- **Intentional alternative**: upstream policy conflicts with the fork's
  canonical ownership model; preserve its safety invariant without importing the
  conflicting policy or a superseded intermediate implementation.
- **Housekeeping**: upstream release identity or historical acceptance notes;
  do not copy these as this fork's version or pretend their validation applies.

The following table enumerates all 34 non-merge commits in topological order.
Adaptation identities locate prior work; final current-source verification is
tracked separately and must not be inferred solely from this table.

| Upstream commit | Work                                                                                                                        | Classification and local decision                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `d3751f4e1`     | Preserve catalog when switching official authentication                                                                     | **Adapted** in `d90a59d15` / `8a50cb02f`: preserve canonical `modelCatalog`, including explicit emptiness, without inventing an absent catalog; retain local native-TOML and alias behavior.                                                                                                                                                                                                                                                |
| `bb4acf327`     | Desktop-login image-generation routing                                                                                      | **Adapted** in `8a50cb02f`: native DesktopCurrentLogin image targets, original-byte forwarding for no-op mappings, explicit alias remapping, disabled/ambiguous identity guards, and current v2 target ownership.                                                                                                                                                                                                                           |
| `6bab67468`     | Pre-response Responses disconnect retry and 3.20.4-3 version                                                                | **Intentional alternative**: do not restore replay of ambiguous `ResponsePending`. Safe bounded connect/forward retry and fork-configurable recovery have current local owners (`d90a59d15`, `8a50cb02f`, `b943924aa`); upstream later replaced this policy too. Do not import its release identity.                                                                                                                                        |
| `8e92a7d12`     | 3.20.4-3 publication evidence                                                                                               | **Housekeeping**: upstream historical release evidence, not local build/install proof.                                                                                                                                                                                                                                                                                                                                                      |
| `f78cbeddd`     | Stream terminal semantics, Grok reasoning, max effort, optional tool schemas                                                | **Adapted** across `8a50cb02f` and `032aff66d`: explicit terminal boundaries and bounded capture scanner; numeric Grok minor handling; exact GPT-6 Sol/Luna max preservation; Responses `strict: false` for optional tool schemas. Retain protocol-specific replay guards.                                                                                                                                                                  |
| `b4469a516`     | Reliability batch: paginated session usage, TOML boundaries, platform drag, path deduplication, compaction, OpenCode timing | **Adapted; omitted importer gap closed in this pass**: TOML, drag, CLI search deduplication and related reliability were adapted in `8a50cb02f`; active-source compaction and OpenCode elapsed latency in `032aff66d`. This review adds validated page-baseline accounting, restart/checkpoint migration and reset/exact-last guards, with 15 pagination regressions and the full importer/copied-fork scope passing.                       |
| `a57abfe84`     | V2 contribution draft boundaries                                                                                            | **Housekeeping**: preserve as upstream provenance, not production code.                                                                                                                                                                                                                                                                                                                                                                     |
| `c2f925e87`     | V2 contribution provenance correction                                                                                       | **Housekeeping**: no product behavior to port.                                                                                                                                                                                                                                                                                                                                                                                              |
| `143b0887a`     | Wait for full asynchronous wizard save-failure rendering                                                                    | **Adapted**: local wizard regressions already await the complete failure path. Retain stronger asynchronous assertions instead of replacing them with an older fixture.                                                                                                                                                                                                                                                                     |
| `7479f7850`     | Docs-only CI classification and backend gating                                                                              | **Adapted** in `8a50cb02f`: conservative complete raw-diff classification, successful required job identities, frontend/Rustfmt prerequisites, and local catalog/contract/test gates. Retain `--ignore-submodules=none` fail-closed hardening.                                                                                                                                                                                              |
| `ead9246f7`     | Global bounded 1M preference and reversible official projection                                                             | **Intentional alternative / adapted outcome**: provider-owned per-model context and reversible native projection are implemented in `8a50cb02f`; do not reintroduce a superseded global preference or static-catalog authority over selected-account capacity.                                                                                                                                                                              |
| `d649eb5dc`     | Official per-model context editor                                                                                           | **Adapted** in `8a50cb02f`: selected-account discovery, safe-integer validation, explicit-empty catalog preservation, and provider-owned canonical values.                                                                                                                                                                                                                                                                                  |
| `5ab3e514c`     | Prepare 3.20.4-4 local build                                                                                                | **Housekeeping**: do not overwrite this fork's manifests with upstream version fields.                                                                                                                                                                                                                                                                                                                                                      |
| `5c6ffbe9f`     | 3.20.4-4 local artifact evidence                                                                                            | **Housekeeping**: upstream artifacts are not local rebuild/install evidence.                                                                                                                                                                                                                                                                                                                                                                |
| `ea606246c`     | Rolling five-minute token rate                                                                                              | **Adapted** in `8a50cb02f`: fresh rolling window, current normalized filters, polling controls, cache-inclusive input, and loading/error unavailability.                                                                                                                                                                                                                                                                                    |
| `a4df25110`     | Prepare 3.20.4-5 release                                                                                                    | **Housekeeping**: upstream release metadata only.                                                                                                                                                                                                                                                                                                                                                                                           |
| `385a2b823`     | 3.20.4-5 package evidence                                                                                                   | **Housekeeping**: do not import upstream acceptance as local acceptance.                                                                                                                                                                                                                                                                                                                                                                    |
| `eb2ed2397`     | Separate official context maxima and token budgets                                                                          | **Adapted** in `8a50cb02f`: defaults, maxima, input budgets and output limits remain separate; retain selected-account trust. Version-only fields are not ported.                                                                                                                                                                                                                                                                           |
| `0af078ea6`     | 3.20.4-6 package and metadata-limit evidence                                                                                | **Housekeeping**: historical upstream results, not local runtime results.                                                                                                                                                                                                                                                                                                                                                                   |
| `b70dec331`     | Separate API specs from account limits, update provider manuals                                                             | **Newly adapted documentation gap**: production references/limits were adapted in `8a50cb02f`, but the English and Chinese provider manuals still described the obsolete unconditional 1M toggle. This review updates that guidance to current provider-owned, selected-account-bounded behavior.                                                                                                                                           |
| `f0da84742`     | Subscription context research and artifact evidence                                                                         | **Housekeeping**: reference research does not authorize account capacity or prove local installation.                                                                                                                                                                                                                                                                                                                                       |
| `d778876be`     | Recent-month 1M configuration research                                                                                      | **Housekeeping**: no new product implementation.                                                                                                                                                                                                                                                                                                                                                                                            |
| `769b4dc38`     | Static-catalog 1M semantics research                                                                                        | **Housekeeping**: preserve local account-authoritative gate; no standalone product patch.                                                                                                                                                                                                                                                                                                                                                   |
| `024677b46`     | Published GPT-6.1 Sol 500K default                                                                                          | **Intentional alternative / adapted presentation** in `8a50cb02f`: published references can be displayed separately; do not copy a fixed 500K entry into the local verified-account-default registry or elevate static metadata over the selected account.                                                                                                                                                                                  |
| `fdf008b9b`     | Separate input/output five-minute rates                                                                                     | **Adapted** in `8a50cb02f`: both rates are present with normalized dashboard scope, cache-inclusive input, and unavailable-state handling.                                                                                                                                                                                                                                                                                                  |
| `7f48b3ef7`     | Prepare public 3.20.4-8 release                                                                                             | **Housekeeping**: do not import upstream manifests, release notes, or release identity.                                                                                                                                                                                                                                                                                                                                                     |
| `dec0b5cc6`     | 3.20.4-8 publication evidence                                                                                               | **Housekeeping**: upstream publication is not local publication.                                                                                                                                                                                                                                                                                                                                                                            |
| `844ca809d`     | Contributor PR triage and dependency blockers                                                                               | **Housekeeping**: provenance/triage context, not additional product behavior.                                                                                                                                                                                                                                                                                                                                                               |
| `bc8ae9274`     | Give Codex sole retry ownership                                                                                             | **Safety adaptation / configurable alternative**: retain the fork's canonical configurable retry policy, never replay ambiguous `ResponsePending`, and preserve local transport-error identity. The current adaptation requires positive capacity evidence for native recovery and makes Codex Retry Off disable hidden pre-header transport retries rather than globally disabling all proxy recovery. Final combined verification passed. |
| `5d5f0209c`     | Prepare 3.20.4-9 transport-repair candidate                                                                                 | **Housekeeping**: candidate version and upstream release notes are not imported.                                                                                                                                                                                                                                                                                                                                                            |
| `7ea5663ef`     | Merged PR / three-platform CI evidence                                                                                      | **Housekeeping**: prior upstream CI is not current fork CI.                                                                                                                                                                                                                                                                                                                                                                                 |
| `d2a04a310`     | Correct concurrent push and validation identity                                                                             | **Housekeeping**: historical provenance correction, no product patch.                                                                                                                                                                                                                                                                                                                                                                       |
| `d79c4d7db`     | Shared local transport-error identity                                                                                       | **Adapted** in `d90a59d15` / `8a50cb02f`: shared `ProxyError` metadata across generic, Chat, Responses and image paths; retain real upstream 502 bodies/status and distinguish locally generated transport failures.                                                                                                                                                                                                                        |
| `46398018f`     | Close contributor PR / transport acceptance                                                                                 | **Housekeeping**: upstream acceptance notes, not new runtime logic.                                                                                                                                                                                                                                                                                                                                                                         |

The four remaining commits are merge ancestry for the already classified PRs.
They do not create four additional code patches:

| Merge commit | PR                                | Behavioral owner / decision                                                |
| ------------ | --------------------------------- | -------------------------------------------------------------------------- |
| `be1e4f6a8`  | #119 CI workload                  | `7479f7850`; preserve adapted local fail-closed classifier and gates.      |
| `478c7e20c`  | #117 wizard failure rendering     | `143b0887a`; preserve existing complete asynchronous regression.           |
| `9ade80ca0`  | #113 official catalog persistence | `d3751f4e1`; preserve canonical/explicit-empty catalog tests.              |
| `21f56b613`  | #108 desktop image route          | `bb4acf327`; preserve current-target lookup and original-byte/alias tests. |

## Current implementation findings and newly found omissions

These are findings and source changes in the targeted review, not a declaration
of repository-wide stale-free behavior. Regression evidence and final combined
results belong in the verification section; the presence of new tests alone is
not a passing result.

### Model order Ultra and shared capability ownership

The Top model default control had two explicit `effort !== "ultra"` filters:
one on declared provider efforts, another on the shared resolver's
`codexSelectableEfforts`. The first filter arrived with `4ad517564` on
October 7; the second survived the capability-query introduction in `b10cfdc48`
on October 9. Backend support for a valid router Ultra default was subsequently
added in `d90a59d15`, but those frontend filters were not reconciled.

The current change derives both displayed efforts and the saved preference from
resolved capabilities for the model's current route/provider. It does not infer
capability from a provider-shared wire name or fall back to a stale router
catalog. Provider-accepted efforts remain separate from Codex-selectable
orchestration; the v1 Ultra gate and valid native `none`/disable contract remain
explicit. Ultra is not appended to every model, and a router preference does
not rewrite a provider-native default.

The backend reasoning path now shares public-row identity, upstream evidence
fallback, validated provider fallback, and product-level Ultra overlay across
model capability retrieval, static catalog projection, routing, and Sub-Agent
capabilities. Excluded or ambiguous identities fail closed rather than being
revived by a recognized upstream model or provider-wide declaration. Static
projection does not turn time-limited detection cache data into persisted
catalog evidence.

### Provider forms: public/wire identity and asynchronous context ownership

Provider-form resolution is keyed by the public catalog row ID so row-owned
reasoning and Ultra settings survive aliases. Read-only capability detection
uses the wire ID, then resolves the public row again. Wire evidence is therefore
not allowed to replace the row's independent product settings or mix two public
rows sharing one upstream model.

Resolution and redetection results are scoped to current provider/settings
context and request ownership. Changing the provider context invalidates old
results; late responses cannot reattach a previous provider's efforts or
complete a new provider's loading/error state. The Ultra checkbox overlay does
not temporarily evict the native capability snapshot needed to select its
provider effort. Resolver failures remain unknown/fail closed, not a reason to
expose raw catalog tiers. Error diagnostics identify the affected model without
serializing raw provider exception data.

### Official discovery and authoritative capability refresh

The official discovery path previously skipped existing rows and appended new
rows with only a subset of discovered metadata. The current path refreshes
explicit metadata for existing and new rows through canonical catalog
reconciliation while preserving explicit user context overrides, edited labels,
inclusion choices, ordering, aliases/upstream bindings, user-declared reasoning,
and product Ultra settings. Discovered default context is display-only metadata,
not an automatically persisted context override. An existing visible alias with
an unrelated wire binding is not duplicated when a directory also advertises
that visible name.

Metadata refresh includes authoritative parallel-tool-call booleans in both
directions: fresh `true` can replace stale `false` and fresh `false` can replace
stale `true`, with persisted aliases kept consistent. Image/modalities,
protocol declarations and non-user reasoning follow the shared refresh rules.
Official account maxima remain subject to the selected-account backend trust
gate; API references or editable catalog maxima do not unlock account capacity.
This refresh path preserves current rows and does not treat an unsuccessful or
partial refresh as permission to delete inventory.

### Wizard capability presentation and reasoning editor normalization

The wizard now requests the same resolved capability contract instead of
rendering raw `supportedEfforts` as though it were the selectable contract.
Unresolved, unsupported and boolean-only models do not acquire invented effort
levels. V1 excludes Ultra; native `none` appears only when the provider accepts
it and disabling is allowed. Capability requests are scoped to the current
wizard provider/model/settings context rather than reusing a previous draft's
result.

The reasoning editor writes canonical v2 `supportStatus` and removes the legacy
`supported` flag so later control-mode changes cannot leave contradictory
support states. Selecting Unknown writes `unknown`, not
`confirmed_supported`. Removing a native max mapping or changing controls also
removes an Ultra-orchestration declaration whose validated provider max path no
longer exists. These changes preserve backend validation rather than weakening
it to accommodate stale editor state.

### Provider-scoped Sub-Agent/profile and key-group identity

Wizard route rebuilding previously redirected historical aliases through a
global upstream map. Providers can intentionally expose the same wire model
with different credentials, capabilities and roles, so a global map could move
a profile to the wrong source. Redirection is now scoped by owning target
provider and current route alias. An alias still present on its owning route is
preserved; removed or ambiguous source/model identities fail closed rather than
selecting the first wire match from another provider. Stable profile IDs and
unrelated profiles remain preserved while model references are reconciled.

Generated API-key-group models retain their generated public model identity
rather than collapsing all rows onto a shared upstream name. Persisted include
selections and collision-alias targets use the original provider public row ID;
the provider row alone owns its wire ID and credential-group metadata. Ordinary
public rows sharing a wire receive the same closed-selection treatment.
Unchanged public IDs do not need self-aliases.

Candidate membership now comes from the exact selected, route-visible
projection: a generated draft alias cannot coexist with a persisted route alias
that replaces it. Saving an explicit group selection no longer widens it to all
shared-wire siblings. A shared transient source-identity mapping serves both
the builder and the reopen reader, so save → reopen → rebuild preserves the
same groups, routes and candidates even across provider-name collisions.
Touched source catalog writes remove stale `model_catalog` without mutating the
input objects or introducing a second persisted representation.

### Runtime/compiler alias ownership matches the frontend

The projection fix exposed an actual backend gap, not merely an invalid UI
fixture: mode-all validation and the compiler's found-wire set allowed each
alias to fan out across every shared-wire sibling. The first deduplicated row
could then supply another group's reasoning/context/credential identity.

Both layers now resolve each alias once: exact visible public identity, then
exact target public identity, then a unique selected upstream identity. Exact
public identities are checked against full canonical inventory before route
eligibility: disabled or unselected rows cannot fall through and borrow a
sibling. Ambiguous upstream-only aliases fail closed at runtime and strict
save; unavailable exact targets produce the existing warning/strict-rejection
boundary. This is ephemeral projection ownership, not a new persisted catalog
or alias source of truth. Four backend regressions and matching frontend
selected/disabled/outside-include cases cover the contract.

### Retry policy: native capacity recovery and Retry Off

This review retains configurable local retry ownership instead of importing
upstream `bc8ae9274` as a blanket ban on proxy recovery. Its safety boundary is
adapted: native Responses capacity recovery continues only after another
readable, positively classified capacity response. A reconnect transport
failure, unclassified HTTP/body, unreadable/overflowing body, or permanent
terminal does not turn capacity recovery into a generic replay loop. The stream
ends through its explicit terminal path and releases retry activity.

Codex Retry Off now reaches the pre-header transport wrapper, including initial,
follow-up and raw-forward sends. A disabled retry budget sends once on a
transport failure instead of performing hidden connect retries outside the
user's configured policy. The enabled path remains bounded, non-Codex behavior
retains its existing policy, and ambiguous `ResponsePending` is never replayed.
No local transport marker replaces a genuine upstream HTTP error identity.

### Paginated Codex session usage

The earlier `b4469a516` assimilation covered much of the batch but missed the
paginated-history importer behavior. At the start of this review, the local
importer had no `history_base` / `history_mode` accounting path or page-baseline
resolver. A double-UUID page could bill its first cumulative snapshot as
all-new usage, or be incorrectly deferred when a fork ancestor was present.
The corresponding upstream pagination regressions were absent locally.

The adaptation adds a distinct validated page-boundary/baseline path, reusing
the existing exact ordinal/byte-cutoff validator. It verifies physical versus
logical identity, predecessor uniqueness, timestamp order and cycles. It does
not weaken strict copied-fork proof or treat a single-UUID fork marker as
continuation authority.

- Inherited totals come from a validated current predecessor cutoff. An older
  ancestor's total cannot replace an immediate page containing usage but no
  cumulative baseline.
- A first-page counter reset realigns the baseline even when the first event
  supplies exact `last_token_usage`; exact last usage remains the billing
  authority. A later stale lower snapshot is not mistaken for a fresh reset.
- Exact-last-only usage invalidates cumulative authority until a later exact
  total/last snapshot reestablishes it. Unknown total-only accounting defers
  before committing any append events or cursor, avoiding partial billing.
- Serde-default provenance distinguishes old/unverified checkpoints from new
  certified exact-only checkpoints, so safe last-only append/restart remains
  usable. Billed legacy checkpoints preserve their ledger and require a
  controlled rebuild; empty old checkpoints reinitialize transactionally.

The 15 pagination tests and the broader importer/copied-fork scope pass. The
`cfg(test)` compatibility reader still calls snapshot parsing without a page
baseline; continuation parity for that test-only reader is not claimed.
Production usage aggregation remains DB-only and the incremental importer path
is the verified runtime boundary.

### Provider-manual context guidance

Both `docs/user-manual/en/2-providers/2.1-add.md` and its Chinese counterpart
previously described a toggle that unconditionally wrote a one-million context
and 900,000 compaction threshold. That did not describe the local per-model
editor or selected-account trust contract. `b70dec331` updated those upstream
manuals while its production UI was adapted locally; the manual change was
missed.

Both sections now describe the per-model control, clearing overrides,
rediscovery after account changes, selected-account-only enlargement authority,
display-only API references, and shared token/output-budget semantics. No
blanket 1M support or fixed model capacity is asserted, and no context guard is
changed. Upstream release metadata and unmerged dependency proposals remain
explicitly outside this behavioral port.

## Verification

Final results below are from the frozen combined working tree, not historical
October acceptance notes. Logs and exit receipts are retained locally under
`.tmp/continuation-upstream-assimilation-ee64670c/`, with the `acceptance-`
prefix. Every listed final command exited zero.

| Command                                                                                     | Final result                                                                             |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `pnpm git:remotes:check`                                                                    | Passed; only the tngflx origin is writable; final upstream main ref remained `46398018f` |
| `python -B -m unittest discover -s scripts/ci -p 'test_*.py'`                               | Passed; 28 tests                                                                         |
| `pnpm typecheck`                                                                            | Passed                                                                                   |
| `pnpm catalog:verify`                                                                       | Passed; reader guards 23/23, bounds guards 6/6, 15 files / 504 tests                     |
| `pnpm test:unit`                                                                            | Passed; 271 files / 2,725 tests, verified-completion receipt                             |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib`                                     | Passed; 5,113 passed, 10 pre-existing ignored, zero failures                             |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib codex_multirouter::`                 | Passed; 161 tests                                                                        |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib codex_multirouter::compiler::`       | Passed; 45 tests                                                                         |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib services::session_usage_codex::`     | Passed; 111 passed, one pre-existing ignored                                             |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib proxy::providers::streaming_retry::` | Passed; 77 tests                                                                         |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib upstream_transport_retry_`           | Passed; five tests                                                                       |
| `cargo fmt --check --manifest-path src-tauri/Cargo.toml`                                    | Passed                                                                                   |
| `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`                          | Passed                                                                                   |
| `pnpm format:check`                                                                         | Passed, unchanged repository gate                                                        |
| Prettier over all changed TS/TSX files and this new audit                                   | Passed                                                                                   |
| `pnpm build:renderer`                                                                       | Passed through the catalog and Responses-contract gated build path                       |
| `git diff --check`                                                                          | Passed; Git reports existing CRLF-to-LF normalization notices, not whitespace failures   |

Focused frontend coverage includes 185 router tests, 93 wizard helper tests,
42 wizard component tests, 16 reasoning-editor tests, and the provider/discovery
and reconciliation suites. The frontend full suite includes all of these.
No ignored Rust test was newly introduced or silently enabled by this change.

### Regression evidence

- Wizard reasoning parity was backtested against the HEAD component in memory:
  **two RED → two GREEN**. Provider public/wire/context cases were similarly
  backtested: **four RED → four GREEN**; generated-group projection:
  **one RED → one GREEN**. Temporary Vite load plugins replaced only component
  source for the RED run, never working files. SHA256 source/test snapshots
  before and after matched. See `wizard-head-red.log`,
  `provider-form-head-red.log`, `router-group-head-red.log` and corresponding
  working-green logs. The provider detection case's baseline failure is partly
  coupled to the prior public/wire bug; the separate pending-context test fails
  its stale-action assertion directly.
- Official discovery had **two failed pre-fix regressions**; authoritative
  parallel-tool refresh had **two failed pre-fix regressions**. The reasoning
  editor had **five pre-fix failures** for Unknown/legacy support and another
  **five** for invalid orchestration transitions. These executed results were
  retained in the coordinating tool transcript.
- Wizard route-visible membership and closed public/group selections produced
  **two RED regressions**, then 92 helper tests passed. A later save/reopen
  regression failed with an empty restored selection, then the final **93**
  helper tests passed with shared builder/reader identity resolution.
- Disabled/outside-include group aliases each failed before inventory-aware
  frontend resolution. The backend shared-wire ownership tests reproduced
  **three pre-fix failures**, then all **four** new regression tests and the
  complete **45-test** compiler suite passed.
- Pagination's additional edge batch recorded **11 passed / four failed**
  before the reset/authority/checkpoint fixes, then **15 passed**. The retained
  `pagination-edge-batch-red-all.log`,
  `pagination-edge-batch-green-final.log`, and
  `importer-edge-green-final.log` contain the corresponding exit receipts.
- Retry coverage includes one-send Off mode, enabled bounded transport recovery,
  no `ResponsePending` replay, native capacity positive-evidence continuation,
  unclassified/unreadable reconnect stops, and permanent terminal identities.

### Build and formatting caveats

The renderer build retains its existing large-chunk advisory; the size warning
was not suppressed and is not a failed gate. No dependency batch or lockfile
update was used to make verification pass.

An optional whole-file Markdown formatting check also found legacy style issues
in the two existing provider manuals. The same failure was reproduced against
HEAD copies with ignores disabled (`baseline-manual-prettier.log`). Only the
new context section is changed in those manuals; unrelated table/whitespace
normalization was not retained. No repository formatting rule, ignore file,
required check or test was weakened to hide this diagnostic.

## Deployment and live-audit boundary

No claim is made here that source changes rebuilt the installed application,
that a release was published or installed, or that a paid/live provider request
succeeded. No UI automation or broad live-workspace scan substitutes for the
configured monitor. The renderer was built with the gated `pnpm build:renderer` path. A later
desktop release must still use gated `pnpm build`. No desktop executable was
rebuilt or installed by this investigation. Remote fetch/ref inspection,
source/tests and a renderer bundle are not a completed live runtime audit.
