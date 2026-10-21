# BigStrongSun ports and deduplication — October 21, 2026

This audit compares the current working tree with the configured
`ccswitchmulti-upstream` remote (`BigStrongSun/ccswitchmulti`). The live
`refs/heads/main` value was `46398018f5e6810eaf69901f228f3191deeb4c4e`, dated
October 20, 2026. It is the same revision as the cached remote-tracking ref.
The local branch is `d90a59d1`; the graph reports 51 local-only and 38
upstream-only commits. The comparison used source and tests from the current
working tree, including the existing uncommitted stream-retry work.

## Ports applied as focused adaptations

| Upstream change                                      | Local adaptation                                                                                                                                                                                                                                                                                                                | Evidence and boundary                                                                                                                                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `d3751f4e` / `9ade80ca` official catalog persistence | `ProviderForm.tsx` now preserves a configured canonical official `modelCatalog` when authentication changes. Native official TOML remains byte-preserving; default-model alias reconciliation stays owned by the local-config path.                                                                                             | RED official-catalog scope failed 2/3 because `modelCatalog` was dropped. GREEN provider preset 31/31 and adjacent catalog/auth 34/34.                                                                    |
| `d79c4d7d` local transport identity                  | `ProxyError::apply_local_transport_error_metadata` is shared by generic, Chat, Codex Responses, and image error builders. Locally generated transport 502s carry `ccsm_upstream_transport_error`, `source: ccsm`, and null upstream status; real upstream 502 bodies retain their own code/status/message.                      | RED transport identity tests failed in all three builder paths. GREEN `cargo test ... transport_502`: 3/3. Existing 502 preservation and `ResponsePending` guards also passed from the built test binary. |
| `bc8ae927` safety invariant                          | The global upstream policy was not copied because it disables the configurable proxy stream-retry behavior. The safe part was isolated: `ResponsePending` is never replayed by the pre-response transport wrapper. `ForwardFailed` retains its bounded transport retry.                                                         | The RED regression made six sends for an ambiguous pending operation. The replacement regression requires one send and preserves bounded safe-connect retry tests.                                        |
| `f78cbedd` stream terminal semantics                 | The stream converter changes stop consumption after an established terminal event, ignore a later transport error after successful completion, and still surface transport failure when the stream ended before a required terminal. The runtime capture path uses a bounded `[DONE]` scanner and guards done/overflowed state. | The tests-only terminal-boundary run failed 9/14 before the fix and passed 14/14 afterward. The final full suite also covers the strengthened overflow-followup assertion.                                |

These are adaptations into the existing request/recovery ownership model. No
upstream file was copied wholesale, and no upstream change was allowed to
create a second catalog, retry, or terminal-policy owner.

The terminal-boundary scope subsequently passed 14/14 after a tests-only RED
run failed 9/14. An independent source review found no blocker. The overflow
regression was then strengthened to include a later `[DONE]` chunk, preserving
both passthrough chunks with no callback or scanner re-entry; the final full
Rust run covers that last test-only change.

## All six remaining candidates implemented

The user requested implementation of the remaining candidates and completion
of the structural deduplication. These are focused adaptations in the current
working tree, with final combined verification recorded separately below.

- `b4469a51` TOML scanning now respects parsed quoted/commented headers,
  escaped/dotted provider IDs, array-table boundaries, and multiline strings.
  Top-level model/integer updates and blank-line normalization use the same
  multiline-aware boundaries. The stronger local parser-based removal guard
  remains. Focused tests passed 69/69 after the new boundary cases failed
  against the previous scanner.
- `b4469a51` native CSS dragging is macOS-only. Windows keeps the Tauri drag
  attribute; Linux omits it. Four platform regressions pass, including two
  cases that failed before the fix. A real WebView2 freeze reproduction was
  not available, so this is source/test validation of the platform boundary.
- `ea606246` / `fdf008b9` five-minute input/output rates are implemented with
  a fresh rolling window on every fetch, cache-inclusive input, separate
  output, current app/provider/model filters, polling controls, and unavailable
  state after failures. Dashboard layout and all four locales were updated.
  Focused usage tests passed 36/36.
- `d649eb5d`, `eb2ed239`, `b70dec33`, and `024677b4` provider-owned official
  context controls, selected-account discovery, validation, and reversible
  native projection are implemented. Defaults, context maxima, and input/output
  budgets remain separate. Only backend discovery for the selected account
  authorizes enlargement; published API references and editable catalog maxima
  cannot grant account capacity. Default-account changes invalidate editor
  metadata. Native projection and routing use consistent override precedence,
  and live cleanup preserves canonical source preferences on backfill.
  The unverified fixed 500K fallback and superseded global setting were not
  imported: the shared verified-account-default registry is deliberately empty.
- `bb4acf32` native DesktopCurrentLogin qualifies as an image target, and local
  official generations use original-byte forwarding. Explicit image aliases
  still map to their upstream model; only a changed mapping re-encodes JSON.
  One shared catalog lookup rejects disabled/ambiguous identities, and v2
  fallback uses the current target instead of stale route catalog snapshots.
  The expanded image scope contains 17 tests; its initial RED had three
  intended failures before implementation.
- `7479f785` CI classifies complete raw Git diffs conservatively and preserves
  successful required job names for docs-only changes. Standalone Rustfmt and
  frontend success gate backend work. Local catalog, test-runner, offline
  Responses contract, canary, and test gates remain. Malformed or uncertain
  diffs run the full checks, including submodule changes despite local Git
  ignore settings. All 27 Python classifier/workflow tests passed. No remote
  GitHub Actions run or actionlint result is claimed.

## Structural deduplication completed

The four protocol-specific stream adapters now share one reconnect driver for
backoff, connection waiting, keepalives, cancellation, activity, and failure
accounting. Protocol framing and replay/terminal boundaries remain explicit.
Managed credential initialization and Codex pinned token/workspace callbacks
also have one implementation; the initial credential is consumed once before
later refreshes of the same selected account.

Rust and the injected renderer consume one declarative terminal-error policy
for extraction paths, separators, marker vocabulary, precedence, and
cancellation events. Twenty-one shared fixtures exercise exact category and
continuation eligibility parity, including transient metadata false positives.
The focused renderer tests passed 27/27.

Development Node and PowerShell recovery consume the same policy JSON for
limits, settings precedence, environment overrides, and saved environment
allowlist. JavaScript app/worker restart classification and restart-history
filtering are shared. Concrete null/legacy precedence, malformed history,
recorded override, and removed-constant callback defects have regressions.
Node tests passed 118/118; Windows watchdog/guardian Pester tests passed 126/126.
Independent process identity checks remain at each authority boundary.

## Additional defects found while reviewing the ports

The image review caught raw forwarding bypassing an explicit public-to-upstream
alias. The final payload helper shares the same catalog entry lookup as the
exclusion guard and retains original bytes for native/no-op mappings.

Context review caught defaults conflated with maxima, top-level override
aliases bypassing row validation, inconsistent native/router precedence,
category-only cleanup missing recognized OAuth providers, and live backfill
accidentally removing saved source preferences. It also caught ordinary OAuth
account bindings and per-route account overrides escaping the special Official
provider's account checks. Runtime and compiler now share route-auth
materialization; effective context validation follows the selected account
without mutating the saved target inventory. There are 28 new backend context
regressions plus strengthened parser/snapshot assertions.

Frontend review caught a second preset rendering path reintroducing rejected
1M options, invalid context input being silently normalized away, and implicit
default-account changes retaining old trusted metadata. The editor now uses
one eligibility path, rejects malformed/unsafe values at save, and invalidates
limits and pending requests when the effective account changes. The final
focused default-account run passed 83/83.

The initial combined typecheck found an unsupported `String.replaceAll` call;
it was replaced with the compatible regex form without changing TypeScript's
target. Final typecheck results are recorded with the combined gates below.

The earlier Pi timeouts were investigated with a scoped CPU profile and
controlled query benchmarks. Whole-document accessible-label/role queries
dominated the sampled work. Positive model queries now target the existing
model section with the same labels/roles. Global absence checks, portal
queries, event sequences, assertions, discovery, and the five-second timeout
remain unchanged. Reversing the query receiver edits and removing the helper
restores the original file exactly after formatting. The full Pi file passed
46/46; final combined-run results are recorded below.

Already present locally and therefore not port candidates are the explicit
official catalog refresh (`d219f969`) and settings-language draft preservation
(`135c7d20`).

## What was not ported

The upstream transport-owner commit `bc8ae927` changes Codex
`request_max_retries` semantics by making Codex the only transport retry owner.
Its owner predicate checks app type only and applies in both development and
production; it is not a development/production switch.
That conflicts with the user-controlled proxy stream-retry policy and
the existing capacity/reconnect recovery phases, so a wholesale cherry-pick
would reintroduce the behavior the current audit fixed. The local change keeps
the policy switch, refreshes managed credentials, and rejects ambiguous
replays at the narrow transport boundary.

The comparison did not perform a live provider/CDP audit, production install,
merge, cherry-pick, commit, or push. Source review and focused tests do not
prove an interrupted real provider conversation or a rebuilt production
installer. The configured live monitor was unavailable during this audit.

## Manual production build and environment ownership

From the repository root on Windows, `pnpm build` runs
`scripts/local-build-pipeline.ps1`. Tauri calls `pnpm build:renderer` first,
which runs the offline Responses contract and catalog gates before bundling
the renderer. The pipeline builds the Rust release executable and NSIS
installer in an isolated Cargo target, exports them to `output/production`,
and cleans its own temporary build target. `cc-switch.exe` is at that output
root and the installer is under `bundle/nsis`. No CI is required.

`pnpm release:local` is the separate release-export path; it requires a clean
tracked working tree and adds source identity/checksum metadata. Neither command
installs or publishes the result automatically. `pnpm build:renderer` alone
does not produce the desktop executable or installer.

Development crash recovery belongs to the `pnpm dev` supervisor and reruns the
complete development worker. Production monitors/relaunches the installed
executable; it must never invoke pnpm, Vite, or Cargo to rebuild. Stream retry
and authorized `continue` recovery are runtime features in both environments,
subject to the current policy and replay-safety guards.

## Historical verification before the six additional ports

These results belong to the earlier reliability ports, before the six
additional ports and structural cleanup above. They do not validate the final
working tree.

The exact final Rust library run passed 4,928 tests with zero failures and ten
existing ignored tests. This includes the strengthened capture overflow test,
pending-replay guard, transport identity, recovery ownership, OAuth refresh,
and terminal semantics. The required separate `codex_multirouter::` run also
passed 153/153. Rust formatting and `git diff --check` passed.
The exact production Clippy command
`cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` passed.

`pnpm typecheck` and `pnpm format:check` passed. The full frontend command
`pnpm test:unit --maxWorkers=1 --minWorkers=1` completed all 264 files:
263 passed, one failed; 2,511 tests passed and seven timed out. All seven were
in the untouched `PiProviderForm.test.tsx`, exceeded the existing 5,000 ms limit,
and concerned model detail/header/fetch/thinking-map flows. Their cause was not
established. No timeout, assertion, discovery rule, or build gate was weakened.

An initial `pnpm catalog:verify` attempt passed its reader/config guards and
471/473 feature tests, with two five-second timeouts in existing Codex form
cases. Those cases passed inside the full frontend run. The subsequent exact
`pnpm catalog:verify` rerun passed its reader guard, 23 reader tests, six
configuration/discovery tests, and all 473 feature tests across 15 files.

Evidence logs are in the local temporary directory:

- `ccswitch-upstream-pending-red-20261021.log`
- `ccswitch-port-full-rust-20261021.log`
- `ccswitch-port-catalog-rust-20261021.log`
- `ccswitch-port-full-ui-20261021.log`
- `ccswitch-port-catalog-20261021.log` (initial failed attempt)
- `ccswitch-port-catalog-final-20261021.log`
- `ccswitch-port-typecheck-20261021.log`
- `ccswitch-port-format-20261021.log`
- `ccswitch-port-clippy-20261021.log`

`pnpm build:renderer` passed the offline Responses contract, the complete
catalog gate, and the renderer bundle build (`index-C8cxZvqV.js`). Its log is
`ccswitch-port-renderer-20261021.log`.

## Historical development rebuild before the six additional ports

The verified old development app (PID 44704) was stopped at
13:03:04.883 +08:00. Its executable path, process-start FILETIME, and ancestry
were checked before the stop. The existing supervisor PID 35144 remained in
charge and replaced worker PID 38104 with 13060. The rebuilt executable was
written at 13:06:46.799 +08:00, and the new app startup marker records
13:06:47.878 as PID 45584. Process start ticks and ancestry back through the
new worker to the supervisor matched at 13:08:04 +08:00.

The active path is
`D:/repos/ccswitchmultirouter/src-tauri/target/debug/cc-switch.exe`. Saved retry
policy remained enabled, Aggressive, with three attempts. The selected,
credential-free process/policy evidence is saved as
`ccswitch-port-runtime-20261021.json` in the local temporary directory.

This establishes a rebuilt running development app. It does not establish
real provider recovery, a real automatic `continue` submission, or a production
installation. No production executable/installer was built or installed.

## Final current verification after all six ports and structural deduplication

These results cover the combined working tree after all six additional ports,
the shared retry/credential/terminal/watchdog owners, and the subsequent review
fixes. They supersede the historical verification counts above.

- `pnpm test:unit --maxWorkers=1 --minWorkers=1` passed all 269 files and
  2,606 tests, with the required fresh completion receipt. This completed run
  used the current global Node 26.2.0 runtime.
- The full Rust library suite passed 4,965 tests with zero failures and ten
  existing ignored tests.
- The separate required `codex_multirouter::` scope passed 156/156.
- `pnpm catalog:verify` passed the catalog reader guard, reader tests,
  configuration/discovery checks, and all 476 feature tests across 15 files.
- `pnpm typecheck`, `pnpm format:check`, and
  `cargo fmt --check --manifest-path src-tauri/Cargo.toml` passed.
- `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` passed.

The earlier broad Node 26.2.0 attempt exited after 91 passing files without
a completion report. The test-runner guard rejected that incomplete result;
it was not counted as a full pass. A checksum-verified portable Node 22.12.0
runtime, matching `.node-version`, was then attempted without changing the
global runtime. That run encountered real five-second test timeouts, and its
owned process tree was cancelled. The cause of the different outcomes has not
been established. The subsequent complete Node 26.2.0 run is the final
frontend evidence above.

The Pi form review scoped 114 positive queries to their existing rendered
sections. Assertions, user event sequences, global absence guards, discovery,
and the existing five-second test timeout were preserved. The final Pi file
passed all 46 tests. No assertion, timeout, completion check, or build gate was
weakened to obtain the combined pass.

Current evidence logs are in the local temporary directory:

- `ccswitch-allports-full-ui-node26-final-20261021.log`
- `ccswitch-allports-full-rust-final-20261021.log`
- `ccswitch-allports-multirouter-20261021.log`
- `ccswitch-allports-typecheck-final-20261021.log`
- `ccswitch-allports-clippy-final-20261021.log`
- `ccswitch-allports-format-final-20261021.log`
- `ccswitch-allports-rustfmt-final-20261021.log`
- `ccswitch-allports-catalog-20261021.log`

The incomplete first attempt and the cancelled pinned-runtime attempt are
retained as `ccswitch-allports-full-ui-20261021.log` and
`ccswitch-allports-full-ui-node22-20261021.log`, respectively.

The gated `pnpm build:renderer` command then passed its offline Responses
contract, catalog gate, and Vite build. The resulting bundle was
`dist/assets/index-VEWzU_ZV.js` (5,928,349 bytes); the complete output is in
`ccswitch-allports-renderer-20261021.log`. The expected Vite chunk-size and
third-party annotation warnings remained warnings only.

The guarded development reload terminated the verified old supervisor PID
35144 and its detached watcher identity (the old numeric PID 4876 was later
reused by an unrelated WebView process, so PID absence alone is not treated as
evidence). At the end of the upstream port phase, the replacement session
was running with supervisor PID 59132, exactly one owned watcher PID 52748,
worker PID 10232, Vite PID 10536, Tauri launcher PID 36296, and app PID 30016.
The app is `src-tauri/target/debug/cc-switch.exe`; its run marker's
process-start FILETIME matches the OS process identity, and its ancestry is
`app -> cargo -> Tauri -> worker -> supervisor -> pnpm dev`. The old supervisor
identity and prior watcher identity are gone, the canonical restart history is
empty, and the selected settings remain watchdog-enabled with aggressive
stream retry and three attempts. Credential-free evidence is saved in
`%TEMP%\ccswitch-allports-runtime-20261021.json`.

The port-phase regression suite covered process host fallback, redacted host
diagnostics, equivalent ISO, `/Date(ms)/`, and native WMI creation timestamps,
and malformed dates. A subsequent user report prompted a separate investigation
of the outer supervisor handoff and a PowerShell 7-only migration. That follow-up
is recorded in [the dev watchdog audit](2026-10-21-dev-watchdog-recovery.md).
Historical watchdog logs showed recurring Windows PowerShell host status
`3221225794` (`0xC0000142`, DLL initialization failure). Requiring the current
PowerShell 7 host removes that legacy dependency without relaxing process
identity or ownership checks. Completed-session marker cleanup was reviewed:
unexpected worker failures retry internally, while a normal nonzero completion
means disabled recovery or exhausted budget. Marker deletion was not the
confirmed handoff defect.

This confirms the final renderer and backend are loaded by the rebuilt
development session. It does not establish a production artifact or install,
or a real interrupted provider conversation with an automatic `continue`.
The configured live provider/CDP monitor was unavailable, so no live recovery
claim is made.
