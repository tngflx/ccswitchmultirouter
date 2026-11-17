# Reasoning authority and log re-audit — 2026-11-17

## Scope and evidence boundaries

This audit follows Sublyx/OpenRouter capabilities through editing, normalization,
selected-provider configuration, shared resolution, route/request conversion,
Sub-Agent policy compilation, and native picker options. It also reads only the
configured CCSwitch diagnostic directory and the two named providers using a
read-only database connection. Catalog inventory is read through the shared
canonical catalog helper; excluded rows are counted but not probed.

The accompanying sanitized receipt is
`2026-11-17-reasoning-authority-evidence.json`. It contains no credentials,
response bodies, raw errors, session IDs, or session filenames. Observations are
snapshots, not an assertion that every warning is an application defect.

No configured Codex automation directory or MCP monitoring resource was found.
The repository's existing bounded, read-only Desktop verifier was subsequently
run with `--inspect-picker`, the exact CCSwitch executable/log, three samples,
and a 60-second wait. No disposable test thread, source injection, UI interaction,
explicit provider probe, provider/database update, installed-app restart/install,
or desktop release was performed. Existing threads were untouched. Library test
compilation is not an installed application update.

## Confirmed reasoning conflicts repaired in source

### 1. Sublyx explicit capability was widened unless it contained native Max

Both frontend normalization and the Rust normalizer treated a valid manual
capability as authoritative only if its effort map contained exact
`max -> max`. Low/High subsets, intentional custom mappings, and current
selected-provider TOML could therefore be replaced by the maintained contract.
The editor also made those replaced declarations effectively uneditable.

Valid explicit declarations now preserve their exact subset, default, mapping,
and Ultra target without requiring Max. Sources covered are manual/absent,
`user`, `user_confirmed_detection`, and authoritative active
`provider_config`. Invalid declarations still take the maintained repair path;
automatic evidence still requires the existing confidence/model/provider scope.

Files: `src/lib/codexReasoningProviderIdentity.ts`,
`src/components/providers/forms/CodexModelReasoningEditor.tsx`,
`src-tauri/src/proxy/providers/codex_reasoning.rs`, and scoped tests in
`src-tauri/src/reasoning_capabilities/mod.rs`.

### 2. OpenRouter control-mode edits invented the wrong wire transport

Changing a Boolean/non-graded declaration to graded used generic
`string / reasoning_effort`, even for a verified OpenRouter endpoint.
It now defaults to `reasoning_object / reasoning.effort`. Existing explicit
contracts remain preserved. A model advertising only Boolean/budget/no graded
control is not automatically granted a fabricated effort ladder.

### 3. Actual requests bypassed shared resolver precedence

`resolve_codex_chat_reasoning_config` honored only `UserConfig` before
legacy `meta.codex_chat_reasoning`. The legacy transport map could override
current selected TOML, detection/library/builtin evidence, or a maintained
Sublyx fallback, even though projection used the shared resolver.

Every concrete shared-resolver capability now wins at the request boundary.
Legacy metadata remains a fallback for genuinely unknown models. Qwen/vLLM
budget safety minimums and unknown-model legacy transport merging are retained.
Regression coverage checks selected OpenRouter TOML, library, builtin, and
Sublyx fallback sources and their actual native Max request mapping.

File: `src-tauri/src/proxy/providers/codex.rs`.

### 4. Native picker options competed with the current per-model catalog

The native power-selection patch retained stale same-model levels, counted
other models' levels as present, and did not consistently reject foreign
provider ownership. Its catalog-wide visibility union could keep stale options
visible after a selected model's capability narrowed. Empty graded lists also
bypassed pruning, especially for Boolean/budget/no-control transitions.

Reconciliation now follows the current exact model/provider descriptor,
including an authoritative empty graded list. It preserves foreign/unscoped
rows, rejects ambiguous ownership and accessor identities, retains the true
original native array for restoration, and does not invoke selection callbacks.
Boolean aliases remain owned by the separate binary adapter: existing valid
aliases survive, but another model's visibility cannot fabricate them.

Files: `src-tauri/src/resources/codex_desktop/native_reasoning_visibility.js`
and `tests/lib/codexDesktopNativeReasoningVisibility.test.ts`.

### 5. Sub-Agent compilation disagreed with real resolved capabilities

- Disabled policy required `None` in the positive picker effort list, although
  the resolver intentionally excludes it. Compilation now uses the separate
  confirmed disable contract for graded/Boolean models; unknown, unsupported,
  and mandatory reasoning remain rejected.
- A nearest-native runtime fallback map could accidentally authorize a Fixed
  Ultra policy even when the product selector was unavailable. Ultra now needs
  an advertised orchestration selector. Ordinary legacy effort mapping and the
  legacy-Unknown compatibility branch remain unchanged.

The regressions construct real resolver projections rather than hand-built
fixtures that accidentally included impossible positive None selections.
File: `src-tauri/src/codex_subagent_profiles.rs`.

## Additional diagnostic/import bugs repaired

### Oversized SSE blocks flooded diagnostics and hid later errors

`src-tauri/src/proxy/error_journal.rs` generated another inspection-limit
record for every additional oversized body portion. Clearing its buffer also
lost partial LF/CRLF event delimiters, so discard mode could swallow the next
real error. Oversized named completion events lost their terminal boundary and
could produce misleading consumption-stopped diagnostics.

The observer now emits one limit event per oversized block, retains only the
possible delimiter suffix (at most three bytes), preserves the next event, and
recognizes existing allowlisted terminal event names only after their complete
block delimiter. It does not guess success from unparsed oversized JSON.
Memory caps, stream bytes, redaction, distinct-block warnings, and unknown EOF
diagnostics remain intact.

### Usage discovery retained the first configured Codex directory forever

`src-tauri/src/services/session_usage_codex.rs` initialized process-global
discovery roots once. A settings change could move `codex_config_dir` while
usage collection kept scanning the old directory. Discovery now owns one
canonical current root; a real root change replaces its inventory/schedule and
clears derived replay caches, while same-root calls retain bounded scans.
The regression proves historical session/archive discovery on A -> B -> A and
ensures ordinary ticks do not become repeated full scans.

### Explicit gateway concurrency codes were missed by capacity classification

The follow-up journal snapshot contained **23** `response.failed` errors with
code `gateway_concurrency_limit`, plus one stream-transport error and one
request failure. These are not reasoning-effort validation errors. Their messages
did not match the classifier's fixed English concurrency phrases, and the typed
code was absent from its affirmative capacity evidence.

A regression failed before the fix. The exact typed code now identifies
concurrency pressure and uses the existing long-wait capacity policy without
relying on English wording. Authentication, permission, hard quota, explicit
`retryable: false`, and do-not-retry checks still win. Unrelated/suffixed codes
are not accepted. No retry/concurrency setting was changed; this does not remove
the upstream service's concurrency limit.

File: `src-tauri/src/proxy/providers/streaming_retry.rs`. All nine capacity
classifier tests, including the new positive and permanent-guard regressions,
passed after the fix.

## What the existing runtime evidence does and does not show

At the read-only snapshot:

- Sublyx had 13 included catalog rows out of 41. Its included rows had no
  individual reasoning declaration to exercise the manual-subset bug.
- OpenRouter had 19 included rows out of 446. Its rows had differing graded,
  Boolean, budget, or no-control metadata; empty effort lists are not all bugs.
- The generated catalog, written at `2026-11-17T00:58:58.586Z`, already
  exposed Low/Medium/High/Extra high/Max/Ultra for the maintained Sublyx GPT
  models and the corresponding model-specific OpenRouter effort lists.
- Current Codex configuration selected `gpt-6.1-sol-sublyx` with `ultra`.
  The observed CCSwitch development session started at
  `2026-11-17T00:58:11.687Z`, before this audit's source edits.
- Across the three structured journal snapshots, 8,569 records comprised
  6,508 inspection-limit diagnostics, 2,055 consumption-stopped diagnostics,
  five stream-transport errors, and one request failure. The current rotation's
  1,085 records all carried HTTP 200. Diagnostic records are not equivalent to
  rejected inference requests.
- The application log still contains stream/transport failures, guardian
  injection warnings, and a historical usage backlog. There were 11,084
  deferred lines across 1,345 hashed historical paths in the inspected log,
  with up to 13 recurrences per path over November 15–17. Existing unchanged-
  reason warning deduplication is sound; process restarts can repeat warnings.
  This volume is not causally attributed to the directory-switch bug.

The source defects above are reproduced. They are **not proof of the current
visible picker incident's exact cause**, nor proof that the running process
contains these repairs. A configured, ownership-verified live picker/proxy audit
is still required after an explicitly authorized runtime update.

## Fresh read-only picker result: still not verified

Receipt: `2026-11-17-picker-readonly-reaudit.json`, observed at
`2026-11-17T02:01:36.087Z` (10:01:36 Singapore time).

- `pickerInspectionPerformed: true`, but `verified: false`,
  `desktopCdpVerified: false`, and `renderedMenuVerified: false`.
- Declared catalog rows contain the Sublyx GPT effort ladder, including native
  Max and product Ultra, and the per-model OpenRouter declarations.
- Native discovery reports `object_limit`; samples report 12,533 visited
  fibers and 2,432 scopes, not a verified owner snapshot.
- Reconciliation refuses with `renderer_scope_snapshot_unverified`;
  no verified native query rows are available.
- Runtime status is `expected_fingerprint_unavailable`. That means current
  runtime authority was not established; it is not a proven version mismatch.
- No test thread was created; existing threads were neither touched nor prompted.

This is a concrete remaining native-picker verification/ownership blocker.
Editing a correct declared catalog does not prove that native rendering uses it.
No discovery cap, ownership guard, or verification assertion was bypassed to
claim the picker works. The visible incident is **not certified fixed**.

## Concurrent ownership conflict found during verification

Another active chat, **Fix model picker reasoning effort**, uses this exact
checkout and branch. Its current human request asks for actual High-effort
Sub-Agents. It is changing the default/omission contract while this audit is
running. This is not assumed to be a malicious or unauthorized edit.

The original tree mixed High-first frontend defaults with Max-first backend
initialization. Those in-progress edits later aligned new-profile defaults on
High. This audit did not reverse those changes or migrate saved Max profiles.

Separately, at the start of this audit the existing persisted omission contract
was Profile. A narrow workspace fix and new immutable V1/V2 tests reproduced
High-on-omission, corrected the display to Profile, and passed all **272**
workspace tests. The shared workspace fallback was then changed back to High
while the other chat changed runtime/compiler defaults. The new Profile
regressions consequently failed in later full runs. The shared files and tests
continued changing between verification commands.

The issue is now a cross-layer contract/ownership integration task, not grounds
to keep overwriting the other chat or silently relax old assertions. One owner
must explicitly reconcile omission, explicit Profile opt-out, saved overrides,
new High defaults, fingerprints, projections, and request behavior together.
This audit asked the human for authorization to coordinate with that chat; no
message or stop request was sent to it without authorization.

## Verification — not a fully green combined tree

Failing-before regressions were observed for the confirmed source defects;
new Rust authority/journal/import/capacity regressions passed after their fixes.
Focused native visibility/Boolean/adapter coverage passed **70 + 37 + 10** tests.
The V2/default focused run passed **160** tests. Earlier full Rust verification
passed **5,597** tests, with 12 ignored, before later shared default-contract edits.

Last completed runs in this chat (different snapshots of an actively changing
shared checkout, **not** one immutable green tree):

| Command                                                                     | Last completed observation                                                                                                            |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                                                            | Passed                                                                                                                                |
| `pnpm catalog:verify`                                                       | **850 passed, 4 failed** in workspace tests; an earlier sequential run passed all **854**                                             |
| `pnpm test:unit`                                                            | **4,273 passed, 4 failed** across 306 files; failures include the changed omission contract and workspace locking/protocol assertions |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib`                     | **5,593 passed, 6 failed, 12 ignored** after the concurrent omission/default changes                                                  |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib codex_multirouter::` | Later run **188 passed** after additional shared compiler/test edits                                                                  |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib capacity_classifier` | **9 passed**                                                                                                                          |
| `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`          | Passed on the later tree                                                                                                              |
| `pnpm format:check`                                                         | Failed on concurrently edited `src/components/codex/CodexRouterWorkspacePage.tsx`                                                     |
| `cargo fmt --check --manifest-path src-tauri/Cargo.toml`                    | Failed on a later edit in `src-tauri/src/codex_config.rs`                                                                             |
| `pnpm scripts:check`                                                        | Passed; no script-policy exception added                                                                                              |
| Working/staged `git diff --check`                                           | Passed; existing Git EOL notices remain                                                                                               |

The last full Rust failures were default/omission assertions in
`codex_config`, `codex_multirouter::compiler`, and
`proxy::codex_subagent_reasoning`. None was disabled. The later 188-test
routing pass does not retroactively turn the earlier full run green.

No renderer/desktop release was built or installed as part of this audit.
The branch remains `main`; no remote, branch, worktree, hook, host sandbox,
permission, or live provider configuration was changed by this audit.
Unrelated dirty/untracked work was preserved.

Receipts are under
`C:/Users/Felix/AppData/Local/Temp/ccsm-reasoning-reaudit-`, including:
`red-20261117.log`, `gateway-red-20261117.log`,
`rust-final-20261117.log`, `capacity-final-20261117.log`,
`multirouter-final-20261117.log`, `clippy-final-20261117.log`,
`unit-final-green-20261117.log` (the name is not a pass claim), and
`final-shared-tree-gates-20261117.log`.
