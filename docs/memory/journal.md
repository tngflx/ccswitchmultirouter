## 2026-10-23 - Preserve development recovery output after launcher exit

Detached watchdog and replacement launches discarded stdout and stderr, so a
full development supervisor recovery silently rebuilt the app. Do not solve
this by inheriting Windows TTY handles or removing detachment: native installed
Node/libuv probes reproduced `EBADF` for inherited detached console writes and
job termination of a non-detached child after its parent exited.

The canonical JavaScript recovery output helper now opens one append handle
for both streams at `dev-recovery.log` beside the session marker, closes the
parent's descriptor after spawn, and retains detached survival. The watchdog,
replacement supervisor, and external development guardian all use it. The
living supervisor prints the path and PowerShell 7 follow command; worker
restarts under that living supervisor retain its console. Full supervisor
recovery does not promise attachment to an exited console. Include the helper
in the installed guardian's runtime file set. Production launch behavior stays
under its existing executable policy.

Regression checks passed 195 development recovery cases and 130 lifecycle
cases, including native output after launcher exit, the default production
handoff adapter, descriptor cleanup, preserved args/environment, and no
development output changes in production. The old ignored-output adapter
failed the native regression. TypeScript, formatting, syntax, and diff checks
passed. No live application activation occurred for this change; a fresh
`pnpm dev` must load the updated launcher. See the
[console investigation](../audits/2026-10-23-development-recovery-console.md).

## 2026-10-22 - Verify automatic continuation against installed Codex

The scoped recovery log contained 407 schedules and 12 readiness deadline
failures without a confirmed submission. The active verified Codex Desktop
shell had no startup debugging port; scheduling cannot retrofit that flag.
Aggressive recovery now explains this prerequisite in existing settings and
diagnostics, without treating a launch flag as proof of delivery or silently
changing the launch setting.

The continuation investigation also reproduced asynchronous client-discovery
readiness, renderer starvation, stale injected runtime calls, and incomplete
preparation lifecycle boundaries. Keep preparation read-only and bounded;
cancel abandoned jobs before trying another usable renderer. Preserve semantic
user stops and all submission uncertainty, including an existing submitting
job. A newly authorized submission must still wait for its acknowledgement.
All bridge calls use the current embedded runtime fingerprint. Known CDP
failures produce finite diagnostic categories, never raw exception contents.

Use one canonical mutation-evidence predicate across start, cancel, commit,
and job reads, including jobs retained after runtime reinjection. Cancellation
must preserve uncertain evidence and report submission only for boolean
`true`. Missing or malformed commit/completion acknowledgements remain
uncertain; only explicit refusal or explicit non-mutating completion can
release the committing reservation. An inherited submitting job must not be
resubmitted, while a submission started by this invocation keeps polling for
its acknowledgement. Every possible-commit exit prevents renderer fallback.

Final source verification passed 69 renderer continuation tests, 5,013 Rust
library tests with zero failures and 10 existing ignored, and the exact
required 156-test multirouter scope. The exact production helper harness passed
18 cases after reproducing 14 failures before the unified fix. Rust formatting
and strict Clippy passed. Native websocket coverage includes bounded
preparation abandonment, cancellation, malformed acknowledgements, submission
uncertainty, and the complete Windows close handshake without weakening its
authorization or no-fallback assertions.

The new `pnpm verify:codex-continuation --executable <installed codex path>`
verifier uses the real installed app-server and production continuation source
with isolated configuration and a local fixture provider. HTTP overload, SSE
overload, and premature stream closure each produced one accepted literal
`continue` and a completed next turn; daily quota produced no submission.
Duplicate recovery tokens did not replay. The verifier uses a client shim;
its receipt explicitly does not claim Desktop CDP delivery. Do not replace
the renderer-owned client with a separate app-server that cannot observe the
user's canonical stop/action ledger.

The existing installed protocol receipt and its recorded hashes remain
unchanged. Active Desktop delivery is still unverified; the Desktop verifier
has no completed live result recorded here.

Evidence and the remaining managed Desktop relaunch boundary are recorded in
[the continuation delivery audit](../audits/2026-10-22-continuation-delivery.md)
and its linked sanitized runtime receipt. Source tests and installed protocol
acceptance must not be presented as verified delivery through the currently
open Desktop process.

## 2026-10-22 - Distinguish planned development exits from crash recovery

The recurring unclean-exit notification came from real missing planned-stop
evidence during manual development replacement. Generation 57 restored Codex
successfully with no lost fields; the warning described missing exit evidence,
not a failed restore. Development replacement now correlates exact retained
Windows process termination with the canonical run marker and exit journal.

Source review separately reproduced stale backups overwriting newer valid
unowned Claude/Codex/Gemini settings during crash recovery. Recovery now preserves
valid current unowned Live under the existing per-app lock; explicit restore
still uses its requested backup. Gemini preservation strictly parses one raw
snapshot; Grok uses canonical official/custom validation. Missing, malformed,
or taken-over configurations keep the restore path, and failures retain backups.

The first post-build live proof still failed: generation 59 was unclean with
no planned receipt. A native regression then reproduced child-first teardown
making an app exit before its planned native termination was established.
Cleanup now verifies app termination first, then cleans retained child handles.
A separate worker regression catches a failed disconnect-time identity probe;
verified startup identity avoids that dependency. Native integration also
reproduced PowerShell rewriting timestamp strings. The new native roundtrips
preserve strings, while shared exact 100 ns parsing compares process identities.
Do not replace those guards with millisecond or raw timestamp-string equality.

Final Rust verification passed twice with 4,997 library tests, 10 existing
ignored, plus 156 multirouter tests and strict Clippy. Four continuation-ledger
restore tests now use the existing serial test-home guard after broad runs
exposed environment races; production scope checks remain intact.

The second real restart proof also failed: terminating a retained Windows
supervisor killed its worker/app before disconnect callbacks could run. A
disposable full topology reproduced that boundary under both Node and pnpm.
Planned cleanup and receipt commit must precede supervisor termination, after
the old worker acknowledges monitor retirement over existing IPC. The old
supervisor must stay parked and preserve the canonical handoff during cleanup.
The final development gate passed 188/188 with unchanged deadlines and native
files serialized. Two consecutive actual updated-worker takeovers then passed
in generations 64 and 65: exact planned receipts, informational planned startup,
zero current warning/crash outcomes, and no startup crash-backup recovery. At
20:52:42 Singapore time the final four native process identities, full app-marker
FILETIME, one anchored watchdog, and app-owned loopback port 15721 still matched.
Evidence is in
[the sanitized runtime receipt](../audits/2026-10-22-planned-exit-recovery-runtime.json)
and
[the planned-exit recovery audit](../audits/2026-10-22-planned-exit-recovery.md).

## 2026-10-22 - Replace manual development sessions and finish retry audit

The user reported that `pnpm dev` refused an existing owned supervisor. The
session-launch helper was present but not wired into the primary entry point.
Manual launches now serialize replacement, validate retained Windows identities,
stop the old watcher before its supervisor, clean old workers/listeners, and
publish the replacement's first worker before releasing startup ownership.
Manual commands reset the restart budget; internal automatic recovery preserves
history and cannot preempt a healthy, newer, or intentionally stopping session.

Regression review caught reserved argument forms, lost legacy history,
incomplete child observations, serialization loss, and stopped-session recovery.
The final isolated development suite passed 164 tests, including real Windows
fixture takeovers and failed replacement recovery; all 213 Pester compatibility
tests also passed. Fixtures do not prove a live app crash or provider failover.

The stream audit reproduced renderer refusal of interrupted network errors,
backend omission of HTTP 408/425, and renderer status-only HTTP gaps. Backend
reconnect and continuation now share transient HTTP status classification; the
renderer accepts the same statuses with numeric-boundary guards. Its 59 focused
tests exercise preparation and authorized commit with exactly one mocked
`turn/start`. Readiness deadlines now retain a static redacted blocker, including
when a later preparation hangs. Quota/authentication/cancellation and ambiguous
submission protections remain.

The official-contract CLI now trims signature whitespace consistently with Rust.
Its 13 tests and the 47 Request Health panel tests passed. A read-only live check
correctly detected a real optional cache-breakpoint TTL addition in the official
declarations. The baseline remains pending review, and runtime inspection
preserves that additive nested field. Official drift checks are explicit UI/CLI
actions, not automatic schema polling.

The scoped logs prove scheduling followed by a readiness deadline, with no
confirmed submitted `continue` in the inspected sample. The background provider
monitor was unavailable; do not turn source tests or a planned dev reload into
claims of live continuation delivery. See
[the takeover and retry audit](../audits/2026-10-22-dev-takeover-and-retry-audit.md)
and [the scoped log review](../audits/2026-10-22-ccswitch-log-review.md).

Final source gates passed: 4,981 Rust library tests (10 existing ignored), 156
multirouter, strict Clippy, TypeScript, formatting, and the gated renderer build
with 476 catalog tests. The broad frontend run executed 2,639 cases with three
timeouts. Single-worker reruns passed 160/161 affected-file tests, but the
unchanged Sub-Agent "removes description alone" case still exceeded five
seconds, including an exact-name rerun. Record that nonzero full-suite boundary;
do not call the full frontend run green or weaken the test to do so.

Two real manual `pnpm dev` takeovers then passed. The first rebuilt the debug
binary at 05:17:25 UTC; the second left supervisor 43604, worker 58508, watchdog
33368, and app 42436. At 05:21:11 UTC all four native creation identities still
matched, app-marker FILETIME and ancestry were exact, one watchdog remained,
the app owned loopback port 15721, and the detached observer had exited.
[The sanitized runtime receipt](../audits/2026-10-22-dev-takeover-runtime.json)
records both manual command ancestries and fresh restart histories. Subsequent
scoped logs still show scheduling without a confirmed live `continue` submission.

## 2026-10-21 - Apply permanent plaintext errors at every retry boundary

When asked to confirm crash and stream recovery, source inspection found a
remaining quota gap: reconnect HTTP/transport errors parsed JSON only, while
initial HTTP retries used six separate quota strings and checked OpenCode
admission first. Plaintext daily quota could therefore send another request.
Both paths were reproduced RED with two requests instead of one; the genuine
temporary 429 control remained retryable.

Added shared `terminal_error_code_from_body` over the canonical policy and
used it in reconnect, initial HTTP, and Desktop forward-error eligibility.
Permanent classification precedes admission/capacity retries, quota retains
its structured envelope, and authentication/category precedence is preserved.
Regressions cover four stream adapters, raw transport errors, loopback HTTP
429/503 and capacity on/off, mixed admission/quota, and transient controls.

Final validation passed 4,977 Rust library tests (10 existing ignored), 156
multirouter, strict Clippy, Rust formatting, typecheck, 476 catalog tests,
frontend formatting, and diff checks. A guarded dev reload rebuilt the app;
the follow-up current-session receipt verifies exactly one owned watcher,
exact app-marker identity, and worker/supervisor ancestry. It does not claim
live provider interruption or automatic failover from that manual activation.
See [the plaintext-error audit](../audits/2026-10-21-stream-retry-plaintext-errors.md).

## 2026-10-21 - Move external watchdog and local production build to JavaScript

The user explicitly requested the JavaScript migration after the PS7-only
recovery fix. `pnpm build`, `watchdog:run`, `watchdog:install`, and
`watchdog:uninstall` now invoke Node directly. The old entry-point PS1 files
only forward arguments and exit status; transaction/release-maintenance tools
remain PowerShell. Windows identity, native exclusive lock, and task APIs use
inline PS7 boundaries. Guardian execution requires Node 22.12 or newer for raw
JSON FILETIME parsing with exact 100 ns BigInt identity checks.

Preserved production/dev separation, canonical restart policy/history and
maintenance leases, retained-handle stop guards, and build staging/rollback.
Review found and fixed cleanup-error masking, lock-loss budget-write races,
and stale-lock installer startup proof, with regression coverage. Startup now
requires a post-lock event tied to the exact fresh guardian identity.

Final checks: 129 lifecycle Node, 145 dev recovery, 213 Pester, 2,607 frontend
tests across 269 files, 476 catalog, 28 CI Python, typecheck, formatting, and
diff checks. No Rust source changed in this migration. The Windows CI lifecycle
gate was added; remote Actions were not run. The read-only live install preview
refused because the default installed production executable is absent; no
task/runtime installation or production build was performed. See
[the migration audit](../audits/2026-10-21-javascript-lifecycle.md).

## 2026-10-21 - Keep the dev watchdog alive after a failed supervisor replacement

The user reported that `pnpm dev` still exited without recovery. The earlier
suite covered worker crashes and publication checks separately, leaving the
outer watcher launch/failure path untested. A direct loop regression failed:
the first replacement died before publication, the watcher logged failure,
reported success anyway, and retired instead of starting the second attempt.
The fix returns an explicit retry outcome and retains the same persisted
five-attempt/thirty-minute budget. Budget exhaustion now records its reason.
The completed-session marker-deletion hypothesis was rejected: normal nonzero
returns are explicit disabled/budget stops; exceptions already retain ownership.

The combined Node verification passed 145/145, including an isolated Windows
integration with real Node fixture processes, PowerShell 7 CIM identity probes,
a failed first replacement, and an owned second publication. The integration
did not start Vite, Cargo, providers, or the target application. Its exact
launch metadata is checked against the real JavaScript dev entry point.

Development queries and Cargo cleanup now share `windows-json-query.mjs`:
PowerShell 7 only, UTF-8, ten-second timeout, redacted diagnostics, WMI errors
terminating, incomplete ownership blocking cleanup. Package build/release
commands, task/upgrade/hook launchers, and history tooling also moved to
PowerShell 7. App-side probes and terminal launches now share the Rust PS7
factory, and history migration fails closed when its offline guard cannot
complete. Final checks passed: 221 Pester, 2 history Python, 27 CI Python,
12 About, 4,970 Rust library (10 existing ignored), 156 multirouter, strict
Clippy, typecheck, formatting, and the gated renderer build with 476 catalog
tests. The 145-test recovery command also runs in Windows backend CI;
remote Actions were not run.

A guarded planned dev reload rebuilt the debug application and activated the
new JavaScript supervisor/watchdog. The runtime receipt verifies one owned
watchdog, the fresh app marker/OS creation identity, and worker/supervisor
ancestry. The helper exited and released maintenance ownership. This activates
the fix; the isolated failed-replacement integration proves automatic retry.
No production build/install or live provider interruption audit was performed.
The configured provider monitor was unavailable. See
[the watchdog audit](../audits/2026-10-21-dev-watchdog-recovery.md).

Do not call a rebuilt app proof of watcher handoff. Exercise the actual outer
monitor loop with a failed replacement, not only successful publication or a
fake worker exit. Do not add a competing restart owner to stream retry.

## 2026-10-21 - Finish structural deduplication and the remaining upstream ports (earlier phase)

What happened: the user asked whether the earlier duplication audit had really
finished and requested all six remaining upstream candidates. The first phase
had fixed concrete bugs but left repeated retry orchestration, renderer marker
policy, OAuth setup, and watchdog policy. These now share a reconnect driver,
pinned credential helpers, a terminal-policy JSON consumed by Rust/renderer,
and a development recovery policy consumed by Node/PowerShell.

The remaining ports add source-preserving TOML boundaries, macOS-only native
drag CSS, rolling usage rates, official native image forwarding, provider-owned
official context controls, and conservative docs-only CI classification. Review
also found raw image aliases bypassed by forwarding and several context trust
boundaries: default/max conflation, top-level override aliases, stale account
metadata, ordinary OAuth account switching, per-route auth overrides, native
projection precedence, and source settings lost during live backfill. The
fixes preserve canonical inventory and reuse existing auth owners. Published
API limits remain display references; no unverified fixed account default was
imported.

Evidence: focused Node recovery tests passed 118/118, Windows Pester 126/126,
CI Python 27/27, TOML 69/69, usage 36/36, and renderer terminal policy 27/27.
The Pi timeouts were profiled and 114 positive queries were scoped to their
existing rendered sections; assertions, event flows, global absence guards,
discovery, and the five-second timeout were preserved. The final Pi file
passed 46/46.

Final combined verification: the full frontend command
`pnpm test:unit --maxWorkers=1 --minWorkers=1` passed 269 files and 2,606 tests
with a fresh completion receipt on current global Node 26.2.0. The full Rust
library passed 4,965 tests with ten existing ignored; the required multirouter
scope passed 156/156. Catalog verification passed its reader guard,
reader/configuration checks, and all 476 feature tests across 15 files.
Strict Clippy, typecheck, frontend formatting, and Rustfmt passed.

An earlier Node 26.2.0 broad attempt exited after 91 passing files without a
completion report and was correctly rejected by the guard. A checksum-verified
portable Node 22.12.0, matching `.node-version`, was then attempted without
changing global Node. That run encountered real five-second timeouts; its
owned process tree was cancelled. The cause of the runtime/run differences
remains unproven. No guards, assertions, timeouts, or build gates were weakened.

The gated `pnpm build:renderer` then passed its Responses contract, catalog
gate, and Vite build, producing `dist/assets/index-VEWzU_ZV.js` (5,928,349
bytes). The detached watcher was hardened after recurring Windows PowerShell
process-probe failures (`3221225794` / `0xC0000142`): development now requires
PowerShell 7 (`pwsh.exe`) for JSON probes, with 113/113 focused Node recovery tests
passing. Creation dates from ISO, `/Date(ms)/`, and native WMI formats are
normalized to UTC before process identity comparison, with malformed dates
failing closed. The final guarded reload replaced the prior session with
supervisor 59132, exactly one owned watcher 52748, worker 10232, Vite 10536,
Tauri 36296, and rebuilt app 30016. The app start marker matches its
executable identity and ancestry through Cargo, Tauri, the worker, supervisor,
and `pnpm dev`; selected watchdog/aggressive stream-retry settings remained
enabled. Runtime evidence is saved in
`%TEMP%\ccswitch-allports-runtime-20261021.json`.

The configured live provider/CDP monitor was unavailable, so these checks do
not establish a real interrupted provider conversation or automatic
`continue`, and no production artifact was built or installed. The combined
results are recorded in
[the port audit](../audits/2026-10-21-bigstrongsun-port-candidates.md).

What NOT to do again: call structural duplication finished after only fixing
symptoms, trust editable/public model maxima as account permission, project
account A's limits under account B's route, normalize invalid limits into a
different value, or accept a zero test-process exit without its completion
receipt. Refresh the long-lived supervisor and detached watcher together when
their imported modules change; restarting only the app worker is insufficient.

## 2026-10-21 - Consolidate retry policy and adapt focused BigStrongSun fixes (earlier phase)

What happened: the user requested a deeper duplication audit and a comparison
with BigStrongSun. The audit found repeated frontend retry-policy/cache writes,
terminal marker extraction, a test-only recovery transition, duplicate first
OAuth fetches, and a raw passthrough retry path with stale managed credentials.
These now use the shared policy/transition/replay owners. Node/PowerShell dev
watchdog coordination and four protocol retry loops remain maintenance debt;
no development/production boundary failure was established by the audit.

The live upstream main ref matched cached `46398018f5e6810eaf69901f228f3191deeb4c4e`.
Focused adaptations preserve official catalogs during authentication saves,
centralize local transport-error identity, stop converters/capture at explicit
terminal boundaries, and remove ambiguous `ResponsePending` replay. The global
upstream client-only retry policy was not copied: it changes Codex retry
ownership in both development and production and conflicts with the requested
configurable proxy recovery. Native TOML, canonical empty catalogs, disabled
models, actual upstream error identity, and safe-connect retry budgets remain
covered by explicit guards.

Evidence: regression failures were recorded before the official catalog,
transport identity, pending-replay, and terminal-boundary fixes. Focused suites
and combined verification are recorded in
[the port audit](../audits/2026-10-21-bigstrongsun-port-candidates.md) and
[the retry audit](../audits/2026-10-20-stream-retry-edge-cases.md). The full UI
suite has unresolved Pi provider timeouts; no timeout or guard was weakened.
The configured live audit monitor was unavailable, so no real interrupted
provider turn or `continue` submission was claimed as verified.

Final combined evidence: Rust 4,928 passed, ten ignored; multirouter 153 passed;
catalog 473 passed; TypeScript, production Clippy, formatting, and gated
renderer build passed. Full frontend 2,511 passed / seven Pi provider timeouts.
The development supervisor rebuilt the app after stopping the verified old
instance: new worker 13060, app 45584, executable written 13:06:46.799 +08:00,
identity/ancestry verified at 13:08:04. Saved policy stayed Aggressive/three.
No production installer was built or installed.

What NOT to do again: treat pre-header silence as proof an upstream request was
not executed, copy upstream retry ownership over the user's policy, replace
whole provider files and lose canonical catalog guards, or equate source tests
with a production installation/live provider acceptance.

## 2026-10-20 - Audit retry boundaries and preserve recovery ownership

What happened: the user asked whether additional stream retry bugs remained
after the overload/settings repair. A deeper source and regression audit found
missed final JSON failures, retry waits killed by outer timeouts, stale OAuth
headers, permanent errors entering retry paths, unsafe SSE evidence, and gaps
in continuation accounting across preparation, acknowledgement loss, and crash.

Root cause: recovery state did not distinguish read-only preparation from an
authorized mutation, body observation assumed EOF would always be polled, and
retry wrappers did not consistently preserve heartbeat, framing, credential,
and permanent-error contracts at their boundaries.

What we did: introduced canonical persisted recovery phases and live budget
checks; separated renderer preparation from backend-authorized commit; retained
spent budgets without replaying uncertain submissions; observed bounded final
JSON using the shared classifier; preserved strict heartbeats across adapters;
removed stale SSE Content-Length; stopped permanent and pending-operation
errors; honored bounded Retry-After; and refreshed pinned managed-account
credentials before sends. Header policy-save errors now remain actionable.

Evidence: confirmed defects have before/after regressions. The final Rust
library passed 4,910 tests with ten existing ignored; the required multirouter
scope passed 153. The full frontend passed 2,507 tests across 263 files with a
fresh receipt. Typecheck, catalog verification, gated renderer build, Rust and
frontend formatting, Clippy with warnings denied, and diff checks passed.
Runtime freshness and the unavailable live-monitor boundary are recorded in
`docs/audits/2026-10-20-stream-retry-edge-cases.md`.
The existing development supervisor rebuilt the app; executable write time was
23:47:04 +08:00 and the verified new startup PID was 30880 at 23:47:05.
Aggressive mode, enabled state, and three-attempt policy were preserved.

What NOT to do again: infer complete retry correctness from one passing suite,
charge a read-only preparation, repeat an uncertain mutation, treat generic
server errors as capacity without considering permanent codes, or preserve an
upstream byte count after changing a stream body. No bug-free guarantee or live
provider/continuation audit is claimed.

## 2026-10-20 - Preserve stream retry policy across unrelated settings saves

What happened: Codex reported the exact server-overload disconnect again, while
the device settings had returned to Safe mode. Safe has a zero post-output
continuation budget even when the configured attempt count is three.

Root cause: the header patched retry policy, but unrelated full settings saves
did not preserve those independently updated fields. A stale Safe snapshot could
overwrite a newer Aggressive policy. The Advanced retry control also used the
full-save path. The incident logs do not identify which historical action reset
this device; the stale-save defect was reproduced independently.

What we did: preserve the three canonical retry fields under the backend write
lock and route explicit Advanced/manual retry updates through patch_settings.
Added durable backend and frontend stale-save regressions, including intentional
Off/Safe/Aggressive changes, mixed updates, and failed patches. Restored this
device to Aggressive with three attempts and rebuilt the development backend.

Evidence: regression failed before the fix and passed afterward. Full Rust
library tests passed 4,864 with 10 existing ignored; focused frontend passed
63 tests and the complete frontend passed 2,501 tests across 262 files with a
fresh completion receipt. Typecheck, formatting, Clippy with warnings denied, gated renderer
build/catalog verification, and diff checks passed. Rebuilt dev app startup
marker recorded PID 39156 at 22:28:30 +08:00; the recorded recovery ledger now
contains Desktop-eligible turns with budget three. No test continuation or
provider request was sent.
The configured background monitor was unavailable; no live Desktop audit was
claimed. See `docs/audits/2026-10-20-stream-retry-policy-persistence.md`.

What NOT to do again: treat an enabled retry switch or max-attempt setting as
proof that post-output continuation is enabled, or let stale full settings
snapshots own policy fields that have a dedicated patch writer.

## 2026-10-13 - Development and production recovery have separate owners

What happened: the user required development crashes to restart the complete
`pnpm dev` build, production crashes to relaunch the installed executable, and
interrupted Codex Desktop work to resume through the existing `continue` policy.

Root cause: the installed guardian could interpret development markers; release
Rust code trusted the dev supervisor environment variable. Stream continuation
was disabled by the user's Safe mode and missed provider-selection errors,
pre-stream failures, outer idle timeouts, and app crashes. The Desktop bridge
also submitted to whichever composer was visible, and current Desktop builds
had moved the real request client into the app-shared scoped registry.

What we did: gated Node recovery behind explicit PowerShell DevelopmentMode
and Rust debug builds, kept installed app monitoring in production, preserved
local production artifacts under `output/production`, and documented manual
build/release commands. Added exact-thread continuation, a bounded crash ledger,
provider identity validation, latest-user continuation budget preservation,
final response observation, and cancellation/newer-request ownership checks.
Added descriptor-based local client discovery, scheduler replacement, stale
client read timeouts, and a total 60-second recovery readiness deadline.
Fixed a keepalive deadline that could repeatedly emit pings instead of waiting
for the idle timeout. Current user settings now select Aggressive with three
continuation attempts; other installations retain the Safe default.

Evidence: Node runner/cache tests 70/70, Windows PowerShell guardian/build/release
tests 92/92, initial recovery/handler tests 104/104, latest Desktop/recovery tests
88/88, transparent stream retry tests 51/51, and non-test Cargo checking passed.
TypeScript, Rust formatting, scoped Prettier, and diff checks passed.
The actual watchdog function was also
compiled with debug assertions enabled and disabled to verify the release gate.
A final rebuilt development app (PID 49108, compiled 21:38:01 +08:00) returned
health HTTP 200. Live read-only Desktop validation confirmed scheduler 4,
one real local client patched at version 10, and exact native thread/read with
turn metadata available. Continuation submission was tested with simulated
clients; no real continue was sent for validation.
No production installer build or publication was run.

What NOT to do again: infer development mode from a stale file in an installed
guardian, erase a newer request's recovery state from an older stream, reset the
continuation budget on a tool result, submit into an unrelated chat, or claim
Desktop recovery works based solely on mocked client discovery.

## 2026-10-13 - Dev watchdog recovers the complete pnpm dev session

What happened: improved the existing root dev runner so application, worker,
and launcher crashes recover through the full Vite and Cargo/Tauri lifecycle.

Root cause: the previous Node wrapper only restarted its Tauri child, while
`CC_SWITCH_DEV_SUPERVISOR=1` disabled Rust recovery. Wrapper death therefore
had no survivor. The PowerShell guardian also selected the installed executable
without a dev-session ownership contract.

What we did: retained the four-hour edit gate and guarded target maintenance;
added a supervised dev worker, a detached launcher watchdog, process identity
and listener cleanup, atomic session ownership, persisted restart options, and
dev-aware guardian recovery. Clean exits and the watchdog toggle remain honored.
Crash recovery runs the normal Cargo/Tauri build immediately; it does not wait
for the edit quiet period. Launcher events live in `logs/dev-watchdog.jsonl`.

Evidence: runner tests 61/61 and Cargo maintenance tests 7/7 passed. Windows
PowerShell watchdog tests 20/20 and adjacent guardian tests 19/19 passed.
Syntax, scoped Prettier, and diff checks passed. Real Windows app-process death
changed worker 32176 to 21148, reran Cargo/Tauri, and restored health HTTP 200.
Launcher death changed supervisor 35848 to 42816; the final-source recovery
changed 42816 to 64060 with worker 54048 and dev app 65440, again HTTP 200.
The new runner is active. Unrelated provider-form work was preserved; no commit
or publication was made. Other operating systems were not exercised live.

What NOT to do again: treat Tauri-child relaunch as supervision of the complete
dev command, recover a dev-owned session with the installed binary, or start a
new worker before the previous session's processes and listeners are released.

## 2026-10-06 - Refork parity and English-first UI continuation committed

What happened: committed the remaining non-protected refork adaptation batch as
`4ad51756` (`feat(refork): complete port parity and localization`).

Root cause: the fresh BigStrongSun foundation still needed the legacy router
projection/model-order behavior, drag-and-drop workspace parity, localized
provider/proxy/session/settings surfaces, and regression coverage adapted to the
new ownership boundaries.

What we did: finalized router-owned catalog projection and model-order
preferences, preserved pointer and keyboard drag/drop behavior, localized the
remaining user-facing fallback strings across the four locales, and added
contract/regression tests. The concurrent reasoning/schema files and their
consumer test remain intentionally unstaged.

Evidence: `pnpm typecheck` passed; `cargo check --manifest-path
src-tauri/Cargo.toml` passed; `cargo fmt --manifest-path src-tauri/Cargo.toml --
--check` passed; `git diff --cached --check` passed before commit. The full
frontend suite currently reports 231 passed / 5 failed files and 1,843 passed /
13 failed tests, all in the protected reasoning/schema task. `pnpm
format:check` reports only the four protected reasoning sources. The full Cargo
suite was attempted and failed only because running `cc-switch.exe` processes
held `src-tauri/target/debug/cc-switch.exe`; no process was killed. `origin/main`
is still `641d53c8113ddb5564b3154dd6f75c17570a450e`; publication is pending the
protected task and final gates.

What NOT to do again: do not stage or reformat the protected reasoning files,
kill the user's running development binaries, or force-publish before the full
frontend/backend gates and remote SHA verification are green.

## 2026-10-06 - Current full frontend gate narrowed to protected reasoning task

What happened: reran the full frontend suite on the latest adapted refork tree
after the model-order, retry, and localization continuations.

Root cause: the remaining failures are in the concurrent reasoning/form schema
work, not in the newly ported model-order, retry, or timezone paths. The current
tree also leaves the four protected reasoning sources unformatted while that task
is active.

What we did: preserved the protected files unchanged, recorded the exact
current gate result, and did not weaken assertions or translate tests around the
active schema task.

Evidence: `pnpm test:unit` exited 1 with 231 passed / 5 failed files and
1,843 passed / 13 failed tests. `pnpm format:check` exited 1 only for
`CodexFormFields.tsx`, `CodexModelReasoningCard.tsx`,
`CodexModelReasoningEditor.tsx`, and `CodexModelReasoningSummary.tsx`.
The targeted model-order and egress runs passed 2 files / 118 tests;
`pnpm typecheck`, `cargo check`, `cargo fmt -- --check`, and `git diff --check`
passed. The full normal-target Cargo suite and runtime freshness remain blocked
by the two running refork `cc-switch.exe` processes. `origin/main` remains
`641d53c8113ddb5564b3154dd6f75c17570a450e`; no publication occurred.

What NOT to do again: do not edit, format, stage, or claim green coverage for
the protected reasoning files while their concurrent task is active, and do not
publish until the actual final tree passes the full gates.

## 2026-10-06 - Status observability placement corrected

What happened: the dedicated Status subviews were correct, but the MultiRouter
workspace header still mounted a second stream-retry toggle.

Root cause: the retry control had been added both to the global Providers header
and to the workspace header, while the live activity feed was intended to remain
only in the dedicated Stream retry status subview.

What we did: removed the workspace-header duplicate, kept the global main-page
control, and added a test assertion that Link status contains no retry activity
or workspace retry toggle while Stream retry contains exactly one activity panel.

Evidence: targeted placement test passed; stream-retry/settings dependents passed
3 files / 21 tests; `pnpm typecheck`, scoped Prettier, and `git diff --check`
passed. The full workspace file was 115 passed / 1 failed on an unrelated
localization assertion for `Codex egress environment monitoring`. Runtime
freshness still requires the user to restart `pnpm dev`; full suites were not run.

What NOT to do again: do not mount stream-retry controls in both the global
header and the MultiRouter workspace, or treat the Link status view as the live
retry event feed. Related:
[retained journal record](#2026-10-06---status-observability-placement-corrected).

## 2026-10-06 - Timezone localization verified; refork cutover still gated

What happened: completed the timezone presentation-owner correction and closed the
remaining locale-key gap found by the parity audit.

Root cause: the egress status/settings owners had been translated mechanically but
still bypassed i18n for status helpers, privacy text, controls, comparison messages,
runtime summaries, and one Codex save-warning fallback.

What we did: routed both timezone components through the four-locale resources and
added `providerForm.codexConfigInvalidNotSaved` to `en`, `zh`, `zh-TW`, and `ja`.
Preserved raw IPs, IANA identifiers, offsets, diagnostics, interval values, API
calls, explicit save/apply behavior, and the protected reasoning/schema task.

Evidence: timezone targeted run passed 4 files / 18 tests; `pnpm typecheck`,
`cargo check`, `cargo fmt -- --check`, and `git diff --check` passed. Backend
library tests passed 4,379 / 4,379 with 9 ignored. The current full frontend
baseline remains 229 passed files / 4 failed files and 1,834 passed / 9 failed
tests, all in protected reasoning/form consumers; `pnpm format:check` remains
blocked by those same four files. Full Cargo and runtime freshness were not
verified because existing `cc-switch.exe` processes hold the normal target and
the user has not restarted `pnpm dev`. `origin/main` was not changed.

What NOT to do again: do not stage or reformat the protected reasoning/form files,
claim the refork cutover is published before the final green gate, or treat a
targeted locale run as proof of full-suite readiness. Related:
[retained journal record](#2026-10-06---timezone-localization-verified-refork-cutover-still-gated).

## 2026-10-06 - Four-hour dev runner checks pass; runtime awaits restart

What happened: rechecked the delayed dev lifecycle before its separate scoped
commit, preserving the retry commit and unrelated shared-checkout changes.

Root cause: direct Tauri watching bypassed the requested delay; missing Cargo
dev/test profile bounds and mismatched process-plugin minors caused the earlier
target growth and startup rejection.

What we did: retained the old supervised no-watch lifecycle with a four-hour
quiet period, bounded dev/test artifact settings, guarded 5 GB maintenance
threshold, and aligned plugin versions. Initial startup still builds normally.

Evidence: fresh runner/prune tests passed 50/50; production `cargo check` passed
without warnings; `pnpm typecheck` passed, superseding the previous shared
fixture failure. Scoped script/manifest/decision formatting passed. Earlier
offline lockfile metadata and baseline lockfile formatting failures remain;
full suites and live runtime were not verified. No push, app restart,
active-target cleanup, competing dev launch, or release build.

What NOT to do again: do not leave Tauri's own watcher active alongside a delayed
scheduler, treat 5 GB as a hard size cap, or verify new source with an old binary.
Related: [retained journal record](#2026-10-06---four-hour-dev-runner-checks-pass-runtime-awaits-restart).

## 2026-10-06 - Retry consumer checks pass; shared fixture typecheck remains open

What happened: finished the pending handler run and refreshed the retry's
App/workspace consumer checks before its scoped commit.

Root cause: the retry warnings came from obsolete production delegates; the
remaining shared typecheck failure is a concurrent projection test fixture
using null for a required timestamp string.

What we did: retained the retry cleanup and main-page activity integration;
selected only owned source, translations, and evidence for the index.

Evidence: handlers passed 94/94; frontend retry/App/workspace tests passed
5 files / 147 tests. Indexed syntax, locale parsing, and cached diff checks
passed. `pnpm typecheck` failed at workspace test lines 910 and 911 on
`generatedAt`; test-environment warnings remain. Full suites and runtime are
not verified. No push, app restart, active-target cleaning, or release build.

What NOT to do again: do not conflate scoped test passes with shared delivery
readiness. Related:
[retained journal record](#2026-10-06---retry-consumer-checks-pass-shared-fixture-typecheck-remains-open).

## 2026-10-06 - Retry continuation checks pass; shared delivery gates remain open

What happened: completed the pending warning-cleanup test run and rechecked the
retry source while another chat continued Model order changes in the checkout.

Root cause: the three reported production warnings were stale retry helpers,
not missing retry behavior. Concurrent unrelated edits change the shared
typecheck and formatting gates between checks.

What we did: preserved the warning cleanup, main-page controls, sanitized
activity feed, and four-hour dev runner; isolated only retry-owned changes for
the retry commit without overwriting shared source.

Evidence: retry tests passed 50/50; the broader dependent streaming run passed
172/172, including those 50 cases. Focused frontend retry tests passed 3 files /
10 tests. Production `cargo check` passed without warnings; direct formatting
checks on the four retry-owned Rust files passed. The latest typecheck failed
on the concurrent Model order control's `ultra` type at workspace lines 4956
and 4958; global Rust formatting failed in its config/compiler/projection
files. Two untouched test-only Rust warnings remain. Full suites and live
runtime were not verified; no push, release build, or process stop occurred.

What NOT to do again: do not report a historical green gate as current in a
moving shared tree, suppress stale-helper warnings, or use the old running
binary to verify newer source. Related:
[retained journal record](#2026-10-06---retry-continuation-checks-pass-shared-delivery-gates-remain-open).

## 2026-10-06 - Retry port dead-code warnings corrected

What happened: the user reported three Rust dead-code warnings left by the
refork retry port. Earlier records incorrectly described them as pre-existing.

Root cause: production Chat handling had moved to its dedicated retry wrapper,
and Responses-to-Anthropic handling to the context-aware wrapper, leaving an
obsolete protocol variant and two unused production delegates.

What we did: specialized the raw wrapper to Anthropic Messages, moved the
two-argument convenience delegate into tests, removed the unused intermediate
delegate, and routed Chat capacity/no-replay regressions through the production
Chat wrapper and converter. Preserved retry budgets, semantic-output guards,
reconnect-failure recovery, diagnostic labels and prior UI/dev-runner fixes.
Appended the attribution correction without rewriting the earlier evidence.

Evidence: targeted library tests passed 240/240 (50 retry, 67 Codex converter,
29 Responses converter, 94 handler). `cargo check --manifest-path
src-tauri/Cargo.toml` exited 0 without warnings; Rust formatting and diff checks
passed. Initial formatting failures were corrected; an initial 49-pass/1-fail
retry run was fixed with a valid Anthropic visible-text-delta fixture and
rerun 50/50. Two warnings remain in untouched test code: an unused protocol
fixture variant and an intentional invalid-UTF-8 literal. Frontend/full suites
and live runtime were not tested in this cleanup; runtime freshness remains
pending the user's refork `pnpm dev` restart.

What NOT to do again: do not call port-introduced dead code pre-existing,
suppress warnings to hide stale ownership, or treat unused helper warnings as
a reason to remove retry. Related:
[retained journal record](#2026-10-06---retry-port-dead-code-warnings-corrected) and
[retained journal record](#2026-10-06---retry-port-dead-code-warnings-corrected).

## 2026-10-06 — Existing Model order drag owner verified with real sensor tests

What happened: after the cleanup, audited the requested Model order page against
the old checkout. The refork already has real pointer and keyboard dragging;
the previous tests did not exercise those interaction paths.

Root cause: missing sensor-level regression evidence made the existing port easy
to mistake for a missing feature. No absent drag handler was found in the tested
source. Live Tauri behavior is still unknown.

What we did: added eight actual-sensor regressions without mocking dnd-kit or
calling drag handlers directly. Covered pointer/keyboard reorder, cancel/no-op,
Save failure/retry and reload through the existing source-Provider contract.
Kept one `sortIndex` owner and preserved route/default/Sub-Agent policy and model
metadata; did not add duplicate production code.

Evidence: sensor-only run passed 8/8; the related seven-file run passed 294/294,
including all 100 workspace tests. Typecheck, owned-test formatting and diff
check exited 0. Global formatting remains red in four protected concurrent-task
files. Full suites, Rust checks and live runtime were not tested; no commit,
push or cutover occurred.

What NOT to do again: do not assume visible drag handles prove working sensors,
copy the old workspace wholesale, or call mocked Save/remount evidence a real
database or desktop-runtime test. Related:
[retained journal record](#2026-10-06--existing-model-order-drag-owner-verified-with-real-sensor-tests).

## 2026-10-06 — English-UI/docs cleanup source batch completed

What happened: finished the preceding cleanup before continuing the Model order
request, including universal-preset suggestions and TE saved-but-not-published
warnings. Consolidated historical root notes remain in one archive.

Root cause: parent-page localization had missed child owners; changing the
translation function in form initialization could also overwrite unsaved drafts.

What we did: used shared, explicitly scoped translators, preserved existing names,
metadata, drafts and save outcomes, restored meaningful consumer assertions, and
removed nine known generated root reports. Protected reasoning/schema files and
other concurrent-task work were not edited.

Evidence: combined targeted frontend run exited 0 (37 files / 611 tests passed,
0 failed); fresh typecheck and diff check exited 0; archive comparison preserved
91/91 unique source contents with 0 mismatches. Repository formatting still fails
on the four protected Codex form/reasoning files. Full suites, Rust checks and live
Tauri freshness were not tested here; no commit, push or checkout cutover occurred.

What NOT to do again: do not equate scoped source completion with a green shared
delivery gate, reset form drafts on locale changes, or claim 100% migration from
component tests. Continue only a test-only audit of the already-present Model
order sensors while the concurrent formatting gate remains red; production drag
changes remain deferred. Related:
[retained journal record](#2026-10-06--english-uidocs-cleanup-source-batch-completed).

## 2026-10-06 — Anthropic raw-stream retry loop completed and verified

What happened: the remaining refork stream-retry gap was in the raw
Anthropic-to-Responses upstream wrapper. A transport drop before semantic
content could be observed, but a failed reconnect incorrectly returned to the
outer stream loop with no current stream, so the remaining retry budget was
never used.

Root cause: reconnect failure handling was structured as an outer-loop
`continue` even though `current` was still `None`. The same wrapper also
classified clean EOF after already-forwarded semantic content as a
pre-semantic failure.

What we did: added an inner reconnect loop that consumes bounded transport or
capacity attempts, updates the diagnostic reason after each failed reconnect,
emits retry activity for scheduled/failed/exhausted states, and only resumes
the outer stream loop after a successful response. Preserved clean post-content
EOF passthrough behavior. Added a regression covering Anthropic
`message_start`, transport drop, failed reconnect, successful replay, one
`response.created`, and recovered text.

Evidence: `cargo test --manifest-path src-tauri/Cargo.toml --lib
proxy::providers::streaming_retry -- --nocapture` passed 49/49; the initial
non-library command was blocked by the live app holding
`src-tauri\\target\\debug\\cc-switch.exe` open (`Access is denied`). Focused
frontend retry tests passed 3 files/5 tests; `pnpm typecheck` passed; `cargo
check --manifest-path src-tauri/Cargo.toml` passed with only existing
warnings; `cargo fmt --manifest-path src-tauri/Cargo.toml --check` and
`git diff --check` passed with only pre-existing CRLF normalization notices.
Runtime freshness remains pending until the user stops and restarts the
current `pnpm dev` process.

What NOT to do again: do not jump out of the reconnect loop while `current` is
empty, and do not claim desktop runtime behavior from the stale development
binary. Related: [retained journal record](#2026-10-06--anthropic-raw-stream-retry-loop-completed-and-verified).

## 2026-10-06 — Completed refork stream-retry port and main-page observability

What happened: continued the unfinished stream-retry port in the fresh refork
after the first pass had left direct Codex Chat and the OAuth
Chat-to-Responses-to-Chat path without the finalized replay factory, and had
not yet recorded verification evidence.

Root cause: the retry engine already owned bounded reconnect behavior, but the
forwarder only created the replay handoff for the native Responses path.
Separately, the main-page control and event feed had been implemented but
runtime freshness was still blocked by the user's running Tauri process.

What we did: completed forwarder wiring for direct Codex Chat streams and the
OAuth conversion path, retained the safe pre-semantic-output boundary, kept
capacity retry separate, and preserved the sanitized app-wide activity event.
The header now exposes the retry switch, Off/Safe/Aggressive mode, and
aggressive attempt slider beside the proxy controls; the Codex workspace
status surface shows the latest 50 retry transitions and can be opened from
that header control.

Evidence: focused frontend retry tests passed (3 files, 5 tests); Rust
streaming retry tests passed (48 passed, 0 failed); `pnpm typecheck` passed;
`cargo check --manifest-path src-tauri/Cargo.toml` passed with only dead-code
warnings; `cargo fmt --manifest-path src-tauri/Cargo.toml --check` passed.
`git diff --check` passed with only CRLF-to-LF normalization notices for
pre-existing files. Runtime freshness remains pending because the existing
`pnpm dev`/Tauri process was not interrupted.

What NOT to do again: do not hide the retry control only in Settings, do not
create a second replay owner, and do not claim runtime behavior from a stale
desktop binary. Related:
[retained journal record](#2026-10-06--completed-refork-stream-retry-port-and-main-page-observability).

## 2026-10-06 — Localization/docs batch verification completed with formatting follow-up

What happened: finished the previous batch before starting the requested model-order
drag-and-drop port. The remaining Codex form assertions were adapted to the rendered
English labels, two stale references to deleted root note filenames were rewritten,
and temporary scan/test artifacts were removed.

Root cause: the UI intentionally renders model/provenance labels with nested
formatting and a capability-source prefix, so exact-text assertions no longer
matched the accessible text; the documentation consolidation left two textual
references to old root filenames.

What we did: changed the assertions to whitespace-tolerant/complete accessible-text
matchers and kept the fresh-refork architecture untouched. The reasoning-effort
schema task was not edited.

Evidence: `tests/components/CodexFormFields.test.tsx` passed 40/40; the focused
five-file component batch passed 64/64; `pnpm typecheck` passed; `git diff --check`
passed; the stale-reference scan returned no remaining references outside the
archive. `pnpm format:check` failed and listed 23 changed frontend files with
Prettier differences. Full suites and runtime freshness were not tested.

What NOT to do again: do not claim the localization/docs batch is fully verified
while the repository-wide formatting gate is red. The remaining four formatting
failures are in the concurrent reasoning-effort task and must be resolved by that
task owner before final delivery; do not reformat those files here or begin the
drag-and-drop port until the shared gate is green. Related:
[retained journal record](#2026-10-06--localizationdocs-batch-verification-completed-with-formatting-follow-up).

## 2026-10-06 — Refork dev target bloat traced to missing Cargo profile bounds

What happened: the freshly ported delayed runner correctly measured and cleaned
the refork target at 44.39 GB, but the next startup still rebuilt a 7.39 GB
debug target and then stopped on a Tauri plugin-version mismatch.

Root cause: the refork had omitted the old checkout's `[profile.dev]` and
`[profile.test]` settings (`incremental = false`, `debug = 0`), allowing Windows
debug dependency/PDB generations to accumulate. Separately,
`@tauri-apps/plugin-process` was materialized at 2.4.0 while the Rust crate was
2.3.1.

What we did: restored the old profile bounds, kept the guarded 5 GB Cargo
target maintenance, and aligned `package.json` plus `pnpm-lock.yaml` to
`@tauri-apps/plugin-process` 2.3.1. Stream-retry files were left untouched in
this pass.

Evidence: old checkout target measured 4.33 GiB; refork post-clean breakdown was
`debug/deps` 5.75 GiB, `debug/build` 1.07 GiB, and `cc_switch.pdb` 0.48 GiB.
`cargo metadata` passed; delayed-runner and cleanup tests passed 50/50; syntax
and diff checks passed. Offline pnpm verification was blocked by missing local
metadata for `@vitejs/plugin-react`.

What NOT to do again: do not treat a size-threshold cleaner as the size-control
itself; restore the Cargo profile bounds before repeated local Tauri builds, and
do not run the refork until the JS and Rust Tauri plugin minor versions align.

Related decision: [retained journal record](#2026-10-06--refork-dev-target-bloat-traced-to-missing-cargo-profile-bounds).

## 2026-10-06 — Committed dependency tree passes frontend gates; backend lock remains

## 2026-10-08 — Search-history replay repaired without disabling web search

What happened: Sublyx native GPT Responses requests repeatedly failed during
automatic context compaction with `response protection is unavailable`.
The original HTTP status was 200 with a `response.failed` SSE event; early-stream
priming mapped that failure to the misleading logged upstream HTTP 503.
The affected local rollout contained completed hosted `web_search_call` items.

Root cause: tool-free compaction replays search history without declaring its
hosted search tool. Sub2API PR #7939 documents upstream reproduction and a
transport-specific declaration repair. A small synthetic request through the
running local Sublyx route reproduced the exact protection error before reload.

What we did: added one gated final-wire repair for Codex native GPT/Codex
Responses after model mapping, provider overrides, and cached Lite fallback.
It preserves all search history and existing search options, adds only a missing
replay declaration, and keeps originally tool-free requests at tool_choice=none.
Lite declares the tool in additional_tools before a trailing compaction_trigger;
standard fallback restores that declaration to tools. Other apps, converted
Chat/Anthropic requests, unrelated native models, and standalone compact are
unchanged. A sanitized web_search_history_declared event records repair use.

Evidence: the forwarder wire regression failed before production wiring and
passed afterwards; 12 focused search-history tests passed. Broader suites passed:
OpenAI compatibility 38, third-party request policy 36, streaming retry 50, and
forwarder 187. Rustfmt and git diff --check passed. Rebuilt and restarted only
the verified repo-owned development tree; Codex was not restarted. The same
synthetic live request then completed with OK. Two further real Sublyx canaries
completed: live web search emitted web_search_call and a cited answer; compaction
with search history emitted a compaction item. A third Responses Lite compaction
canary also completed with a compaction item. None returned protection errors.
Previous binary and a consistent database/config snapshot are retained outside
the checkout under the user's LocalAppData CCSwitchMulti/local-hotfix-backups/
web-search-history-hotfix-20261008-225427. No release or commit was made.

What NOT to do again: do not disable web search, delete session history, or add
unbounded retries to repair a deterministic missing tool declaration. Do not
claim the original user thread has completed merely from synthetic canaries;
the user should retry that conversation against the now-patched runtime.

## 2026-10-09 - Live-search toggle and native error delivery verified

What happened: continued the search-history repair with save-to-live-config
coverage and truthful native Responses errors. The user also asked whether
request-schema checks could catch similar failures before transmission.

Root cause: the router projection cache did not include the effective hosted
search toggle, so saving the toggle could leave a stale projected search mode.
Native Codex stream priming also replaced an HTTP 200 terminal SSE failure with
a synthetic 503 before the existing Responses handler could preserve its cause.

What we did: reused the existing toggle, config projection, short-value hash,
Request Health inspector, Responses retry/error handler, and wire-test helpers.
Enabled supported native search projects live; disabled or unsupported search
projects disabled. The projection fingerprint includes the effective toggle.
Final-body diagnostics share the replay repair's missing-search invariant and
run after overrides and repair. Native Codex early SSE failures retain the real
status and error fields; converted transports retain their existing behavior.
No recurring documentation scraper or blanket public-schema validator was added.

Evidence: full Rust library suite passed sequentially (4,420 passed, 10 ignored).
The first parallel run had one Universal-provider projection failure; that test
passed alone and the full sequential rerun passed. Shared settings/home-state
interference is suspected, not established. The workspace frontend suite passed
(139 tests). The final pending pnpm typecheck exited 0. Rustfmt, locale formatting,
and diff checks passed. New regressions cover toggle persistence/projection,
cache invalidation, standard/Lite/cached-fallback wire bodies, unchanged live
search options, split SSE failures, and the full Responses endpoint. The existing
hosted-search canary against gpt-6.1-sol-sublyx returned HTTP 200, completed its
response, and emitted actual web_search_call searching/completed events.

Runtime read-back: config.toml contains web_search=live and model
gpt-6.1-sol-sublyx. The verified repo binary was built at 00:41:23 and its app
started at 00:41:24 local time, after the relevant source edits. A newer dev tree
appeared during lifecycle work; its launch provenance was not established.
Codex was not restarted. No commit or release was made.

Read-only reference check: GitHub's latest published BigStrongSun release is
v3.20.4-2 (September 30, 2026, Singapore time); current main is b4741adeac9b5da84bffe2b75c18c9bb234c5e72.
That revision's forwarder still maps an early non-capacity SSE error to HTTP 503.
Sub2API PR #7939 was opened October 8, 2026 and remains open at this check.
This does not establish when the third-party backend's replay behavior changed
or verify the latest upstream release end to end.
Sources: [latest upstream release](https://api.github.com/repos/BigStrongSun/ccswitchmulti/releases/latest),
[upstream main](https://api.github.com/repos/BigStrongSun/ccswitchmulti/commits/main),
[upstream forwarder](https://raw.githubusercontent.com/BigStrongSun/ccswitchmulti/b4741adeac9b5da84bffe2b75c18c9bb234c5e72/src-tauri/src/proxy/forwarder.rs),
and [replay repair PR](https://github.com/Wei-Shaw/sub2api/pull/7939).
Official [Codex configuration](https://developers.openai.com/codex/config-reference/)
and [Responses request reference](https://developers.openai.com/api/reference/resources/responses/methods/create)
were fetched directly after web search returned no usable results. They establish
the public search settings and request shapes, not the selected third-party
route's complete behavioral contract.

What NOT to do again: do not call this exhaustive replay coverage or verified
Codex UI rendering. The original user conversation was not retried. Public
Responses schemas do not establish private Codex/Lite or third-party gateway
semantics; any broader checker should extend existing Request Health/probe
owners, use versioned contract fixtures, and avoid sending private history to
validation probes or scraping documentation on each production request.

## 2026-10-08 — Third-party replay canary kept provider-agnostic

What happened: the rebuilt three-stage replay canary initially stopped at its
first hosted-search request with HTTP 400. The redacted upstream diagnostic
identified `Unsupported parameter: max_tool_calls` from the selected Sublyx
route. Request Health had approved the body because `max_tool_calls` is a valid
public Responses field; this was a provider capability mismatch, not a checker
false positive or a replay-repair failure.

What we did: added the versioned official Responses declaration fixture and
shared final-wire checker to Request Health, including selected field/item/tool
types, replay invariants, redacted findings, and informational pass-through for
unknown extensions. The offline/live drift script and weekly read-only workflow
check the public reference without fetching documentation on production
requests. Protocol probes classify known local contract failures as invalid
requests. Separately, removed the optional `max_tool_calls` limit from the
synthetic canary because it does not exercise the hosted-search replay
invariant, and added a regression test. Provider-specific unsupported fields
remain informational/diagnostic rather than being silently stripped from
ordinary traffic.

Evidence: the redacted error was observed without printing request or response
content; offline contract, canary, and Rust checks remained green before the
live rerun. The corrected live search passed with HTTP 200, completed terminal
status, an actual completed `web_search_call`, and the fixed marker. The full
three-stage replay suite then passed: search, standard compaction replay, and
Lite compaction replay each returned HTTP 200 with a completed compaction item.
No protection error occurred.

## 2026-10-08 — Windows CLI probe no longer mislabels working Codex as broken

What happened: About displayed Codex as installed but unable to run, with
"The system cannot find the path specified." The npm launcher actually ran
and reported 0.160.0; the Desktop app's separate bundled runtime reported
0.162.0-alpha.2. Neither installation required reinstalling.

Root cause: PATH resolution canonicalized codex.cmd to a verbatim Windows
path with the \\?\ prefix. Passing that path to cmd CALL broke script dispatch
and npm-style sibling resolution. The probe truthfully reported its failed
child process, but the failure was in CC Switch's launcher, not Codex.

What we did: adapt filesystem verbatim drive/UNC paths only at the command-script
execution boundary. Native EXE paths and canonical identity/deduplication remain
unchanged. Version checks and bounded captured commands now use the same command
builder; PATH, cwd, extra environment, deadline, no-window flags, and exit status
are retained. Added Windows regression fixtures for npm-style sibling launchers,
spaces/parentheses, drive/UNC paths, and real nonzero exit propagation.

Evidence: both script-execution tests failed before the fix with the reported
path error, then all three regression tests passed. Misc command tests passed
83/83; the opt-in installed-Codex smoke test invoked the actual About backend
command and diagnostics, returning version=0.160.0, error=null, and
installed_but_broken=false. TypeScript, rustfmt, and diff checks passed.
The optional frontend About test run encountered an existing React invalid-hook
call failure in both tests; no frontend or dependency changes were made here.
Rebuilt and restarted only the verified repo dev tree, without reinstalling
Codex or restarting its app-server. Private rollback artifacts are in LocalAppData
CCSwitchMulti/local-hotfix-backups/codex-cli-probe-20261008-231744.

What NOT to do again: do not strip canonical prefixes globally or replace a
working npm installation because a GUI command wrapper rejected its path.
Keep the npm CLI version separate from the Desktop-bundled runtime version.

What happened: the approved dependency upgrades and formatter-compatible source
tree were committed on the fresh-refork `main`; the first final frontend run
caught and fixed a stale pnpm 9.15.0 installer pin in the supplemental Linux
workflow.

Root cause: three release workflows independently owned pnpm versions, and the
Linux workflow was not included in the initial edit.

What we did: removed competing pins so all release workflows consume
`package.json`'s pnpm 12.9.1 declaration, regenerated the policy-valid lockfile
with PostCSS 8.5.28, and applied Prettier 3.9.9 only to the 46 AST-audited
files.

Evidence: direct workflow/identity tests passed (2 files / 6 tests); full
frontend passed (225 files / 1,752 tests); `pnpm typecheck`, `pnpm format:check`,
workflow-test formatting, and `git diff --check` passed. Full Cargo testing
exited 101 before tests because Windows denied removal of the running normal
target `cc-switch.exe`. The remote `origin/main` is still
`641d53c8113ddb5564b3154dd6f75c17570a450e`; publication has not occurred.

What NOT to do again: do not infer a clean publication gate from library-only
Cargo results, and do not bypass the running app with a process kill or
alternate target directory.

Related decisions: [retained journal record](#2026-10-06--committed-dependency-tree-passes-frontend-gates-backend-lock-remains)
and [retained journal record](#2026-10-06--committed-dependency-tree-passes-frontend-gates-backend-lock-remains).

## 2026-10-06 — Final frontend regressions fixed; GitHub cutover still gated

- **What happened:** Final verification initially exposed two frontend failures;
  after scoped fixes, all 224 files / 1,747 tests passed. The requested GitHub
  main replacement still has not occurred.
- **Root cause:** A language-specific i18n wrapper changed effect dependencies,
  allowing the unchanged settings query snapshot to overwrite a reset/draft.
  The Accordion test assumed a collapsed Radix trigger exposed `aria-controls`,
  although the installed primitive only does so while expanded.
- **What we did:** Guarded query-to-form initialization by snapshot identity and
  marked the observed snapshot consumed on reset. Added three regression tests
  and checked actual expanded trigger/panel IDs and accessible regions without
  changing the production primitive. Recorded the exact-lease main replacement
  decision; preserved the dirty legacy checkout and unrelated dependency edits.
- **Evidence:** Targeted frontend passed (7 files / 173 tests); full frontend
  passed (224 / 1,747); typecheck and diff check passed. Committed Prettier 3.6.2
  passed source formatting, but upgraded 3.9.9 `pnpm format:check` failed on 46
  existing files. Library-only Cargo testing passed 4,364, failed 0, ignored 9.
  **Correction to October 5 entries:** 4,373 is total library tests, not 4,373
  passed. Current full Cargo testing exited 101 before tests because the running
  app locks `src-tauri/target/debug/cc-switch.exe`; integration verification is
  not complete at this boundary. Refork foundation ancestry check passed, but
  freshly fetched remote main is still `641d53c8113ddb5564b3154dd6f75c17570a450e`.
- **What NOT to do again:** Do not equate library-only results with full backend
  verification, silently publish unowned dependency updates, kill the running
  app, bypass its lock with another target directory, or infer 100% migration
  coverage from green tests.

Related decisions:
[retained journal record](#2026-10-06--final-frontend-regressions-fixed-github-cutover-still-gated),
[retained journal record](#2026-10-06--final-frontend-regressions-fixed-github-cutover-still-gated).

## 2026-10-05 — Final source verification for refork foundation and public identity

- **What happened:** The fresh BigStrongSun-based refork completed the source-level
  migration boundary, including routed reasoning inheritance, clippy root fixes,
  and the public identity cutover to `tngflx/ccswitchmultirouter`.
- **Root cause:** The remaining failures were not broad migration gaps: the
  compiler did not resolve explicit official `upstreamModel` aliases for routed
  reasoning, two clippy findings exposed dead/overloaded ownership, and the fresh
  tree still pointed release/update links at the upstream repository.
- **What we did:** Reused the shared official reasoning resolver at the compiler
  boundary, removed the dead parser and consolidated transform context, restored
  the matching MultiRouter updater endpoint/public key, updated public links and
  release metadata, and kept upstream attribution separate from release identity.
- **Evidence:** `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check`,
  `cargo clippy --manifest-path src-tauri/Cargo.toml -j 1 -- -D warnings`, and
  `cargo check --manifest-path src-tauri/Cargo.toml` passed. Full Rust tests passed
  with `CARGO_BUILD_JOBS=1 cargo test --manifest-path src-tauri/Cargo.toml --
--test-threads=1` (4,373 unit tests plus all integration tests, 0 failures).
  `pnpm format:check`, `pnpm typecheck`, and `pnpm test:unit` passed (224 files,
  1,744 tests). Targeted updater/identity tests passed (3/3), and `git diff --check`
  passed. Fork-specific identifier audit found all required identifiers.
- **What NOT to do again:** Do not claim 100% completion from source tests alone.
  The fresh runtime still needs a user-authorized stop/restart of `pnpm dev` from
  `H:\repos\ccswitchmulti-refork` before non-disruptive runtime inspection, and
  the guarded remote `main` replacement must wait until that freshness check and
  final diff/remote audit are complete.

## 2026-10-05 — routed Codex reasoning picker root fix

- **What happened:** Fresh-refork routed provider rows (for example Sublyx aliases) reached Codex Desktop with an empty reasoning-effort list.
- **Root cause:** MultiRouter copied only inline `modelCatalog.models[].reasoning`; it never resolved an explicit `upstreamModel` through the existing shared capability resolver. Router `defaultReasoningEffort` was only a preference and did not provide capability evidence.
- **What we did:** At the compiler boundary, reused the shared resolver and official cache only for explicit upstream aliases, preserving canonical schema and fail-closed behavior for unknown custom models. Added regression coverage.
- **Evidence:** `cargo check --manifest-path src-tauri/Cargo.toml -j 1` passed; `pnpm typecheck` passed. Targeted cargo test was attempted but could not execute because Windows paging-file exhaustion corrupted/made metadata unloadable (OS error 1455); no test result was claimed.
- **What NOT to do again:** Do not add UI-only defaults or generic model-name inference; do not make custom providers inherit official capabilities without an explicit upstream alias and resolver source.

# Engineering Journal

## 2026-10-05 Completed source verification for the fresh refork migration

What happened: the approved fresh-refork port batch reached its source-level
verification boundary. The initial parallel full Rust command could not finish
because Windows exhausted the paging file while compiling tests (`os error
1455`), producing invalid metadata and cascading crate-load errors.

Root cause: verification parallelism exceeded the available Windows paging
capacity; the compiler diagnostics did not identify a source failure.

What we did: reran the unchanged full Rust suite with one Cargo build job and
one test thread, then retained the existing frontend and targeted verification
results. We did not weaken or skip tests, create an alternate target directory,
or change source to mask the environment failure.

Evidence: `cargo test --manifest-path src-tauri/Cargo.toml -- --test-threads=1`
with `CARGO_BUILD_JOBS=1` exited 0 across the full unit and integration suite;
`cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check`, `cargo check
--manifest-path src-tauri/Cargo.toml`, `pnpm format:check`, and `pnpm typecheck`
passed; full Vitest passed (1,744 tests); and `git diff --check` passed. The
fresh desktop runtime was not rebuilt or inspected, and the remote/physical
cutover was not performed.

What NOT to do again: do not interpret paging-file exhaustion as a source test
failure, do not bypass the full suite with a second build target, and do not
claim runtime freshness or replacement cutover from source-only evidence.

Related decision: [retained journal record](#2026-10-05-completed-source-verification-for-the-fresh-refork-migration).

## 2026-10-05 Classified remaining legacy-only candidates

What happened: the fresh refork still had no direct counterparts for the
legacy global-loading/deferred-render layer, the generic common-config loader,
or the monolithic Codex compatibility template.

Root cause: these files came from the legacy fork's incremental UI and CDP
patches, while the fresh architecture uses app-specific config hooks and a
standalone model-picker core. BigStrongSun's current history also removed dead
common-config plumbing.

What we did: rejected the generic common-config hook and compatibility
template as duplicate owners; deferred global loading/deferred rendering
because the fresh tree has no consumers or upstream equivalent; and recorded
the rationale in [retained journal record](#2026-10-05-classified-remaining-legacy-only-candidates).

Evidence: fresh-tree searches confirmed none of the four legacy source modules
are referenced; `git show upstream/main:src/components/providers/forms/hooks/useLoadCommonConfigSnippet.ts`
confirmed the helper is absent upstream; and the reference history inspection
found the deliberate common-config cleanup in commit `69ff69dd7`.

What NOT to do again: do not copy legacy-only files solely because their paths
are missing. First establish a current fresh consumer and a single ownership
boundary, then port only the behavior that remains required.

## 2026-10-05 Added visible-only Codex catalog rendering

What happened: the fresh refork's Codex form rendered every catalog row in the
reasoning and model-mapping editors and resolved reasoning for the entire
catalog. Root cause: the fresh architecture had not yet adopted the legacy
viewport's explicit page and expansion boundary.

What we did: added `CodexCatalogViewport` with stable row-ID pagination,
explicit expansion, visible-row callbacks, and disabled-inventory controls;
wrapped both catalog surfaces; and limited reasoning resolution to visible
rows. Existing catalog reconciliation, persistence, protocol overrides, and
input-capability ownership remain in `CodexFormFields` and its current helpers.

Evidence: `pnpm exec vitest run
tests/components/CodexCatalogViewport.test.tsx` passed (2/2);
`pnpm exec vitest run tests/components/CodexFormFields.test.tsx
tests/components/CodexCatalogViewport.test.tsx` passed (42/42);
`pnpm typecheck` passed; targeted Prettier checks passed; and `git diff --check`
passed. Runtime freshness was not checked because the refork desktop process
has not been rebuilt and restarted. Related decision:
[retained journal record](#2026-10-05-added-visible-only-codex-catalog-rendering).

What NOT to do again: do not reintroduce direct full-catalog maps or move
catalog persistence and reasoning policy into the viewport renderer.

## 2026-10-05 Restored takeover activation feedback in the refork header

What happened: the fresh refork kept the proxy/takeover state and color change
but had lost the legacy header's one-shot activation feedback. Root cause: the
visual transition component was not ported even though `App.tsx` already owned
all required state.

What we did: added `RoutingActivationBrand`, gated its transition on resolved
proxy/takeover status, keyed it by active app context, and kept all IPC and
state ownership in `App.tsx`.

Evidence: `pnpm exec vitest run
tests/components/RoutingActivationBrand.test.tsx` passed (2/2);
`pnpm typecheck` passed; targeted Prettier checks passed; and `git diff
--check` passed. Runtime freshness was not checked because the refork desktop
process has not been rebuilt and restarted. Related decision:
[retained journal record](#2026-10-05-restored-takeover-activation-feedback-in-the-refork-header).

What NOT to do again: do not move proxy status ownership into a visual header
component or animate the initial resolved state as though it were a new
activation.

## 2026-10-05 Consolidated auto-sync coordination and restored Windows taskbar icon

What happened: the fresh refork had duplicate suppression, debounce, dirty-signal,
and worker-loop implementations in WebDAV and S3 auto-sync, and it lacked the
legacy fork's explicit large Windows taskbar icon assignment. Root cause: the
refork port retained transport modules as independent copies instead of separating
shared coordination mechanics from transport-specific upload behavior; AppUserModelID
alone did not restore the native `ICON_BIG` assignment.

What we did: added a transport-neutral `services::auto_sync::AutoSyncState` with
one static instance per transport, preserving independent suppression and status
contracts while removing duplicated queue/worker logic. Added and registered the
Windows-only `WM_SETICON(ICON_BIG)` plugin without changing AppUserModelID setup.

Evidence: `cargo test --manifest-path src-tauri/Cargo.toml --lib auto_sync` passed
(13/13); `cargo test --manifest-path src-tauri/Cargo.toml --lib windows_window_icon`
passed (1/1); `cargo check --manifest-path src-tauri/Cargo.toml` passed; and
`git diff --check` passed. Runtime freshness was not checked because the refork
desktop process has not been rebuilt and restarted. Related decisions:
[retained journal record](#2026-10-05-consolidated-auto-sync-coordination-and-restored-windows-taskbar-icon) and
[retained journal record](#2026-10-05-consolidated-auto-sync-coordination-and-restored-windows-taskbar-icon).

What NOT to do again: do not duplicate coordination mechanics inside each sync
transport, merge transport suppression state globally, or add a second Codex
compatibility injector when the refork already owns equivalent inline cores.

## 2026-10-05 Ported Codex catalog normalization into the refork

What happened: the fresh refork accepted the shared Codex catalog contract at
the renderer boundary, but imported or persisted legacy aliases could still
reach SQLite and MultiRouter compilation in noncanonical form. Root cause: the
normalization owner stopped at the frontend adapter, leaving provider DAO and
compiler inputs inconsistent.

What we did: added the pure idempotent normalizer under
`codex_multirouter::catalog`; applied it only to Codex provider DAO
read/write/direct-update boundaries; and normalized cloned provider inputs
before compiler validation, mutation planning, and provider-set planning. The
normalizer covers catalog aliases, context-window token strings, modalities,
reasoning metadata, and cache metadata. Non-Codex settings, remote
reconciliation, route pruning, and route projection remain owned by their
existing layers.

Evidence: `cargo check --manifest-path src-tauri/Cargo.toml` passed; focused
Rust tests passed (catalog 1/1, compiler 20/20, provider DAO 7/7,
provider-set 23/23); `pnpm typecheck` passed; affected Vitest suites passed
(7 files, 52/52 tests); and `git diff --check` passed. Runtime freshness was
not checked because the refork desktop process has not been rebuilt and
restarted.

What NOT to do again: do not normalize only in React, copy the legacy DAO into
every caller, or create a second owner for reconciliation, route projection,
or pruning. Related:
[retained journal record](#2026-10-05-ported-codex-catalog-normalization-into-the-refork).

## 2026-10-05 Ported Codex catalog version pruning

What happened: the fresh refork preserved the full reconciled Codex catalog
when users explicitly reset model order, while the legacy fork removed stale
recognized releases from each model branch. Root cause: version pruning was a
projection concern that had been omitted when catalog reconciliation was
centralized in the refork.

What we did: added a pure shared pruning utility and made the route compiler
apply it only for explicit model-order reset. The utility keeps the newest
release per capability branch, treats GPT codenames and specialized offerings
independently, compares dated snapshots only within the same release identity
and date width, preserves unknown aliases, provider namespaces, input order,
and object identity, and filters spawn-agent candidates against the pruned
model set. Ordinary projection and persistence remain unchanged.

Evidence: `pnpm exec vitest run tests/lib/codexCatalogVersionPruning.test.ts
--reporter=dot` passed (6/6); the focused compiler/reset run passed (22/22);
the combined pruning/compiler assertions passed (8/8); `pnpm typecheck` and
`git diff --check` passed; and targeted Prettier formatting was applied and
checked. Runtime freshness was not checked because the refork desktop process
has not been rebuilt and restarted.

What NOT to do again: do not prune every catalog projection, copy pruning into
the provider form, or introduce a second reconciliation owner. Related:
[retained journal record](#2026-10-05-ported-codex-catalog-version-pruning).

## 2026-10-04 Ported Codex plugin/browser health diagnostics

What happened: the fresh refork exposed Codex personal-plugin registration
repair but had no browser integration health report or Settings panel. Root
cause: the legacy fork bundled browser/plugin checks beside registration
detection, while the refork already had a newer registration owner that should
not be duplicated. What we did: added a read-only browser diagnostics service
that delegates registration detection to `codex_plugin_registry`, probes the
bundled Browser plugin scripts, exposes typed IPC/API contracts, adds an
Advanced Settings panel with explicit repair actions, and localizes all new
strings in `en`, `zh`, `zh-TW`, and `ja`.

Evidence: `pnpm exec vitest run
tests/components/CodexPluginHealthPanel.test.tsx` passed (2/2); `cargo test
--manifest-path src-tauri/Cargo.toml --lib
services::codex_plugin_health::tests` passed (2/2); `cargo check
--manifest-path src-tauri/Cargo.toml` passed; `pnpm typecheck` passed;
targeted Prettier checks, new-module `rustfmt --check`, and `git diff --check`
passed. The Rust test build emitted two unrelated existing warnings. Whole
crate `cargo fmt --check` still reports known formatting differences outside
this feature. No rebuilt runtime was inspected.

What NOT to do again: do not copy the legacy plugin registry into the refork,
automatically install browser extensions/native hosts, or claim live health
without rebuilding and restarting the refork app. Related:
[retained journal record](#2026-10-04-ported-codex-pluginbrowser-health-diagnostics).

## 2026-10-04 Ported Codex session deletion coordination

What happened: the fresh refork deleted local Codex rollout files but did not
notify the Codex app-server, and it lacked the legacy confirmed purge for
archived rollouts. Root cause: local provider deletion and Codex's persisted
thread catalog are separate ownership boundaries. What we did: retained the
fresh multi-provider Session Manager and Pi discovery, added one focused
`thread/delete` app-server coordinator, kept catalog cleanup best effort after
validated local deletion, and restored an all-items-attempted archived purge
through typed IPC and a confirmed Codex-only UI action. Evidence: coordination
tests passed 1/1, session-manager tests 6/6, Codex provider tests 21/21, the
Session Manager component suite 18/18, `cargo check` and `pnpm typecheck`
passed, and targeted formatting checks passed. One initial frontend assertion
failed because the test i18n harness used the English default-value fallback;
the assertion was corrected and the suite rerun. Whole-tree `cargo fmt --check`
still reports known upstream/toolchain formatting drift outside this port. No
rebuilt runtime was inspected. What NOT to do again: do not treat rollout-file
deletion as sufficient catalog cleanup, mutate Codex state databases directly,
or replace the fresh Session Manager with the legacy component. Related:
[retained journal record](#2026-10-04-ported-codex-session-deletion-coordination).

## 2026-10-04 Finalized four-point request-body accounting

What happened: the request-health port initially observed parsed/transformed
JSON but did not prove what exact client bytes arrived, what immutable bytes
each retry replayed, or what compressed bytes reached the upstream transport.
Root cause: request measurement and retry construction were distributed across
handlers, provider transforms, Responses-Lite fallback, rejection retry, and
stream reconnect. What we did: attached exact decoded byte counts before JSON
parsing; introduced one finalized payload owning transformed JSON and optional
zstd wire bytes; made ordinary, rejection, transport, and stream retries clone
that payload; separately finalized Responses-Lite fallback; and kept semantic
review independent from wire-byte approval/hash accounting. This also fixed the
fallback reconnect path so it replays the accepted fallback variant rather than
the rejected primary body. Evidence: `cargo check` passed; request-health tests
passed 17/17; OpenAI compatibility tests 38/38; Codex request-policy tests 36/36;
forwarder tests 183/183; focused frontend tests 5/5; and `pnpm typecheck` passed.
One initial unscoped targeted Cargo invocation failed before tests with stale
multi-target `E0460`/`E0463` artifacts; library-scoped verification passed, and
the full Rust suite remains for the final migration boundary. No live refork
runtime was rebuilt or inspected. What NOT to do again: do not reserialize or
restore request history inside a retry, hash semantic JSON while sending a
different compressed entity, or let fallback reconnect retain the rejected
primary variant. Related:
[retained journal record](#2026-10-04-finalized-four-point-request-body-accounting).

## 2026-10-04 Ported bounded Codex Desktop turn recovery

What happened: the fresh refork already reconnected Responses streams before
semantic output but lacked the legacy fork's bounded Desktop continuation after
an interrupted turn. Root cause: transparent HTTP replay and semantic Desktop
continuation are different recovery layers, and copying the legacy handler
would have created duplicate retry ownership. What we did: kept immutable
pre-semantic replay in `streaming_retry.rs`; added a session-scoped final-stream
observer for verified Codex Desktop requests; excluded compaction; added a CDP
composer submission operation to the existing Desktop owner; and replaced the
Boolean UI with one SettingsPage-controlled Off/Safe/Aggressive selector that
also persists the legacy compatibility flag. Evidence: `cargo check
--manifest-path src-tauri/Cargo.toml` passed without library warnings; recovery
tests passed 8/8; Codex Desktop tests passed 51/51; the two focused retry-policy
tests passed; the prior handler identity test passed 1/1 and streaming retry
tests passed 45/45; focused frontend tests passed 12/12; and `pnpm typecheck`
passed. The full suites and live Desktop runtime remain untested at this stage.
What NOT to do again: do not merge semantic continuation into transparent
stream replay, accept External API identity spoofing, or give a settings widget
its own full-object save path. Related:
[retained journal record](#2026-10-04-ported-bounded-codex-desktop-turn-recovery).

## 2026-10-04 Ported reasoning and catalog compatibility into fresh refork

What happened: the fresh foundation had the canonical Codex request and
catalog owners, but lacked the legacy compatibility names and several catalog
sync safeguards. Root cause: the legacy fork exposed adapters and form-local
reconciliation while the fresh architecture had already centralized those
responsibilities under `HistoryReplay`, OpenAI compatibility normalization,
and `codexCatalogReconciliation.ts`.

What we did: added thin `ReasoningContentMode` and strict-schema normalizer
adapters over the existing request owners; moved catalog schema normalization,
identity binding, context inference, capability hydration, refresh policy, and
safe missing-row removal into the central reconciliation module; and reduced
`codexCatalogSync.ts` to re-exports so there is one owner.

Evidence: `cargo check --manifest-path src-tauri/Cargo.toml` passed;
three reasoning-mode Rust tests and one strict-schema adapter Rust test passed;
`pnpm vitest run src/lib/codexCatalogReconciliation.test.ts` passed (6 tests);
`pnpm typecheck` passed; and `git diff --check` passed. Runtime freshness was
not checked because no rebuilt desktop process was requested. Related decisions:
[retained journal record](#2026-10-04-ported-reasoning-and-catalog-compatibility-into-fresh-refork) and
[retained journal record](#2026-10-04-ported-reasoning-and-catalog-compatibility-into-fresh-refork).

What NOT to do again: do not copy legacy request branches or form helpers into
the fresh refork when the new architecture already has a canonical owner.

## 2026-10-04 Ported model-specific key-group editor

What happened: the fresh refork's grouped Codex credential UI could edit exact
model IDs but could not discover models per group or target model prefixes.
Root cause: the fresh form retained a simplified inline editor while the
legacy fork had a reusable group model editor.

What we did: recorded the ownership boundary and ported one reusable editor
that delegates successful model discovery to the fresh form's existing catalog
reconciliation owner. No second routing or catalog store was added.

Evidence: `pnpm exec vitest run
src/components/providers/forms/CodexKeyGroupModels.test.tsx` (5 passed),
`pnpm typecheck`, Prettier checks on all changed files, and `git diff --check`
passed. Runtime freshness was not checked because no rebuilt desktop process
was requested.
What NOT to do again: do not copy the legacy Codex form wholesale when the
fresh form already owns catalog state and reconciliation. Related:
[retained journal record](#2026-10-04-ported-model-specific-key-group-editor).

## 2026-10-04 Centralized packaged Codex launcher identity

What happened: the fresh refork's runtime refresh selected the first matching
`Get-StartApps` AUMID and duplicated COM activation, so stable and Preview MSIX
packages could launch the wrong shell. Root cause: launcher identity was not
bound to the selected executable's manifest application. What we did: ported
manifest-specific executable-to-AUMID matching into the existing Codex Desktop
owner, reused that owner from runtime refresh, and retained executable fallback
for standalone installs. Evidence: `cargo test --manifest-path
src-tauri/Cargo.toml codex_desktop --lib` (51 passed), `cargo test
--manifest-path src-tauri/Cargo.toml codex_runtime_refresh --lib` (42 passed, 1
ignored), `cargo check --manifest-path src-tauri/Cargo.toml`, `pnpm typecheck`,
and `git diff --check` passed. `cargo fmt --check` still reports the known
pre-existing formatting differences in `codex_config.rs`, `services/proxy.rs`,
and `services/provider/mod.rs`;
no runtime freshness check was performed. What NOT to do again: do not select
the first Start-menu AUMID when the executable identity is available, and do
not add a second COM launcher owner. Related:
[retained journal record](#2026-10-04-centralized-packaged-codex-launcher-identity).

## 2026-10-04 Ported shared auto model refresh primitive

What happened: the fresh refork had independent manual model fetch handlers but
no shared cache, request deduplication, or stale-result guard. Root cause: the
legacy fork's reusable `useAutoModelRefresh` utility and its tests were absent
from the new foundation. What we did: ported one shared hook with
credential-scoped fingerprint support, TTL caching, in-flight request
deduplication, invalidation epochs, optional local-storage snapshots, and
non-destructive membership diff reporting. Provider forms remain the owners of
fetch state; no duplicate fetch path was added. Evidence: `pnpm exec vitest run
tests/hooks/useAutoModelRefresh.test.tsx` (4 passed), `pnpm typecheck`, focused
Prettier checks, and `git diff --check` passed. Runtime freshness was not
checked because no rebuilt desktop process was requested. What NOT to do again:
do not copy legacy form integrations wholesale before confirming the fresh
form's state owner, and do not treat an empty model response as proof that all
saved models were removed. Related:
[retained journal record](#2026-10-04-ported-shared-auto-model-refresh-primitive).

## 2026-10-04 Restored atomic Codex provider switch Desktop lifecycle

What happened: the fresh BigStrongSun refork lacked the legacy explicit Codex
provider action that stops Desktop, switches routing, and relaunches the shell.
Root cause: the fresh foundation had separate provider, takeover, and Desktop
launcher owners but no transaction joining them, and the catalog reconciliation
port also exposed an incomplete shared row identity type. What we did: added a
typed IPC command and API method, verified Desktop process filtering and safe
termination, reused the existing takeover/injection launcher, and added a
lock-held `ProviderService` switch entrypoint so the stop -> mutation -> relaunch
sequence cannot race proxy toggles or reacquire its own mutex. The catalog row
contract now includes shared identity fields and a stable seed type. Evidence:
`cargo check --manifest-path src-tauri/Cargo.toml`; `cargo test
--manifest-path src-tauri/Cargo.toml codex_desktop --lib` (49 passed);
`cargo test --manifest-path src-tauri/Cargo.toml switch_provider_ --test
provider_commands` (4 passed); `pnpm typecheck`; `pnpm exec vitest run
src/lib/codexCatalogReconciliation.test.ts` (3 passed); and `git diff --check`
passed. `cargo fmt --check --manifest-path src-tauri/Cargo.toml` still reports
only pre-existing formatting differences in `codex_config.rs` and
`services/proxy.rs`. Runtime freshness was not checked because no rebuilt
desktop process was requested. What NOT to do again: do not call the normal
lock-taking switch method from inside a lifecycle lock, do not terminate by
process name without verified Desktop identity, and do not duplicate catalog
identity or row-seed contracts. Related:
[retained journal record](#2026-10-04-restored-atomic-codex-provider-switch-desktop-lifecycle).

## 2026-10-05 Consolidated usage relative-time formatting

What happened: three fresh-refork quota/usage footers each implemented the
same relative-time thresholds. Root cause: the display formatter had no shared
utility owner. What we did: added `utils/usageRelativeTime.ts`, switched
`UsageFooter`, `CopilotQuotaFooter`, and `SubscriptionQuotaFooter` to import it,
and ported boundary tests. Evidence: `pnpm exec vitest run
tests/lib/usageRelativeTime.test.ts` (7 tests), `pnpm typecheck`, Prettier,
and `git diff --check` passed. Runtime freshness was not checked because no
rebuilt desktop process was requested. What NOT to do again: do not duplicate
the `usage.*` threshold logic in another footer; keep session-specific labels
in the session formatter. Related:
[retained journal record](#2026-10-05-consolidated-usage-relative-time-formatting).

## 2026-10-05 Extracted Codex Sub-Agent validation diagnostics

What happened: the fresh provider form parsed the Sub-Agent V2 validation code
inline and discarded optional offending-model details. Root cause: the backend
diagnostic boundary had no reusable parser in the refork. What we did: added
the tested parser from the legacy feature, adapted the form to existing
translated incomplete/validation messages, and kept backend validation as the
authority. Evidence: focused parser and `ProviderForm.codexPreset` suites (23
tests), `pnpm typecheck`, Prettier, and `git diff --check` passed. Runtime
freshness was not checked because no rebuilt desktop process was requested.
What NOT to do again: do not move validation into UI parsing or hardcode a
second error-code check in another form. Related:
[retained journal record](#2026-10-05-extracted-codex-sub-agent-validation-diagnostics).

## 2026-10-05 Consolidated models.dev catalog ownership

What happened: the fresh refork's automatic-sync dialog and manual pricing
picker duplicated the same models.dev query, flattening, provider sorting,
filtering, and visible-row bounds. Root cause: the catalog view contract had no
shared hook, so two dialogs independently owned one cache key and matching
behavior. What we did: added `useModelsDevCatalog` with caller-specific row
limits and an `enabled` gate, then adapted both dialogs while retaining their
selection and persistence ownership. Evidence: `pnpm exec vitest run
tests/components/ModelsDevPickerDialog.test.ts tests/components/ModelsDevAutoSyncPanel.test.tsx
tests/hooks/useModelsDevCatalog.test.tsx` (24 tests), `pnpm typecheck`,
Prettier checks, and `git diff --check` passed. Runtime freshness was not
checked because no rebuilt desktop process was requested. What NOT to do again:
do not copy either dialog wholesale or add another models.dev query/filter
owner. Related: [retained journal record](#2026-10-05-consolidated-modelsdev-catalog-ownership).

## 2026-10-03 Centralized Codex catalog reconciliation

What happened: the fresh refork's Codex form had an inline merge that matched
only one visible/upstream string and treated every fetched model as appendable.
Root cause: identity aliases and remote metadata had no shared reconciliation
owner, so refreshes could fail to hydrate equivalent rows or create duplicate
inventory. What we did: added a pure identity-aware reconciliation utility and
delegated the existing form merge helper to it; disabled/manual rows remain
user-owned, metadata hydration is conservative, and newly discovered models are
added as disabled inventory. Automatic refresh remains a separate lifecycle
decision. Evidence: `pnpm typecheck`,
`pnpm exec vitest run src/lib/codexCatalogReconciliation.test.ts` (3 tests), and
`git diff --check` passed. Runtime freshness was not checked because no rebuilt
desktop process was requested. What NOT to do again: do not copy the legacy
Codex form or add a second persistence path when the fresh form already owns
state and save behavior. Related:
[retained journal record](#2026-10-03-centralized-codex-catalog-reconciliation).

## 2026-10-03 Kept official Codex proxy sessions in stable history buckets

What happened: the fresh refork still projected official Codex takeover through
the legacy `cc-switch-official` provider, while the migration target requires
native `openai` history when unified history is disabled and the shared
`custom` bucket when it is enabled. Root cause: route projection and auth-facade
classification assumed every official takeover had a named provider table;
the built-in `openai` route has only a top-level `openai_base_url`. What we did:
made `codex_config` the sole owner of projection/detection/cleanup, removed only
CC Switch-owned legacy residue, adapted service projection for native versus
managed official auth, and taught account-pool reprojection to recognize the
built-in route. Evidence: official-route tests (6), projection tests (2),
account-pool reprojection (1), and takeover false-positive test (1) passed;
`cargo check --manifest-path src-tauri/Cargo.toml`, `pnpm typecheck`, and
`git diff --check` passed. `pnpm format:check` failed only on six pre-existing
provider-form files outside this change. Runtime freshness was not checked
because no rebuilt desktop process was requested. What NOT to do again: do not
restore a second legacy route builder or classify a missing
`[model_providers.openai]` table as managed without checking the top-level route
marker. Related: [retained journal record](#2026-10-03-kept-official-codex-proxy-sessions-in-stable-history-buckets).

## 2026-10-03 Restored the refork language quick switcher

What happened: the fresh refork had a Settings-page language control but had
lost the legacy header quick switcher, and unknown or missing language values
fell back to Chinese. Root cause: language parsing was duplicated between the
i18n bootstrap and settings form, while the header had no owner in the fresh
shell. What we did: added one shared supported-language parser with English as
the default, adapted the header switcher to the existing settings mutation,
and made optimistic language changes roll back i18n and local storage when the
save fails. Existing Settings ownership remains unchanged. Evidence: focused
language/parser/settings tests passed (17), dependent App and Settings tests
passed (38), `pnpm typecheck`, Prettier checks, and `git diff --check` passed.
Runtime freshness was not checked because no rebuilt desktop process was
requested. What NOT to do again: do not add another language normalization or
independent persistence API beside the shared contract. Related:
[retained journal record](#2026-10-03-restored-the-refork-language-quick-switcher).

## 2026-10-03 Ported the stream retry setting into the refork

What happened: the fresh refork already had bounded Responses stream reconnection, but users could not disable that replay behavior. Root cause: the retry owner existed without the fork's persisted `enable_stream_retry` control. What we did: added the default-on compatibility setting, typed frontend state and all four locale strings, a proxy settings toggle, and a gate around only the existing Responses reconnect factory. Capacity replay and transport retry remain separate. Deliberately did not port legacy aggressive continuation because the fresh architecture has no matching client-session owner. Evidence: focused Rust settings test passed (1), `cargo check`, `cargo fmt --check`, `pnpm typecheck`, frontend Prettier, and `git diff --check` passed. Runtime freshness was not checked because no rebuilt desktop process was requested. What NOT to do again: do not gate unrelated retry policies with this setting or add a second continuation owner. Related: [retained journal record](#2026-10-03-ported-the-stream-retry-setting-into-the-refork).

## 2026-10-03 Adapted shared MultiRouter model identities in the refork

What happened: the fresh refork could retain a visible alias in a Provider catalog while refresh, route projection, or picker selection compared only the visible string and treated the upstream model as missing. Root cause: model identity was reconstructed independently at each boundary; canonical slugs and aliases were not part of the matching contract. What we did: added a shared normalized identity helper and adapted refresh deduplication, route catalog projection, fixed-route summaries, alias validation, picker state, and wizard selection matching. Kept fresh ownership, fixed include semantics, and disabled inventory rows. Evidence: `pnpm typecheck`; focused Vitest suites with 104 tests passed; Prettier check; `git diff --check`; `cargo check --manifest-path src-tauri/Cargo.toml`. Runtime freshness was not checked because no rebuilt desktop process was requested. What NOT to do again: do not copy the legacy workspace wholesale or hide identity mismatches by converting explicit include routes to all-model routes. Related: [retained journal record](#2026-10-03-adapted-shared-multirouter-model-identities-in-the-refork).

## 2026-10-03 Ported Codex traffic admission policy

What happened: adapted the legacy Codex traffic-policy behavior to the fresh refork. Root cause: the fresh architecture had provider routing and request retry ownership, but no bounded per-route admission gate or explicit OpenCode endpoint-unavailable replay policy. What we did: added policy resolution and provider metadata, shared router semaphores with response-lifetime permits, recognized rejection replay in the existing Codex retry loop, typed frontend controls, and all locale keys. Kept generic `503` responses non-retryable and preserved existing capacity retry behavior. Evidence: `cargo check --manifest-path src-tauri/Cargo.toml`; focused Rust tests for `codex_traffic_policy` (3 passed), `codex_rate_limit_retry` (3 passed), and `error_mapper` (9 passed); `pnpm typecheck`; focused Vitest policy tests (2 passed); `git diff --check`. What NOT to do again: do not add a second generic retry system or copy the legacy forwarder wholesale; admission belongs to `ProviderRouter`, and explicit rejection replay belongs in the existing Codex retry function.

## 2026-10-03 Codex grouped credentials adapted to fresh request policy

What happened: the first distinctive legacy feature was ported into the BigStrongSun foundation. Root cause: the fresh foundation has one request-policy owner, while the legacy grouped-key implementation selected credentials across older forwarder paths. What we did: added model-aware grouped credential resolution, fail-closed scoped aliases, pooled selection, persisted frontend group editing, one-time catalog projection, and shared policy compilation for runtime and protocol probes. Evidence: focused Rust grouped-key, route restoration, fingerprint/header, and full-URL retention tests passed; grouped projection and related provider-form frontend tests passed; `pnpm typecheck` and `git diff --check` passed. What NOT to do again: do not copy legacy forwarder/retry orchestration or allow a second credential-selection owner.

## 2026-10-03 Legacy reasoning replay adapted to the fresh request policy

What happened: legacy providers used `reasoningContentMode` to choose DeepSeek-style `reasoning_text` replay or strict summary-only replay. Root cause: the fresh foundation already owned replay through `HistoryReplay`, so copying the legacy forwarder branch would create conflicting request mutation. What we did: added a canonical summary-only replay dialect, translated imported legacy metadata at compatibility resolution, and made canonical saves discard the legacy field. Evidence: 33 request-policy tests passed; 2 focused Rust metadata/resolver tests passed; 12 focused frontend tests passed; `cargo check` and `pnpm typecheck` passed. What NOT to do again: do not restore a separate forwarder-level reasoning mode or let both legacy and canonical settings control one request.

## 2026-10-03 BigStrongSun replacement foundation started

What happened: the user approved replacing the legacy fork foundation with a fresh BigStrongSun refork and adapting distinctive behavior incrementally. Root cause: the legacy branch had diverged across hundreds of files and retained older save/probe ownership, while BigStrongSun now provides provider-set and protocol-lab boundaries. What we did: cloned `BigStrongSun/ccswitchmulti` at `b4741ade`, retained the dirty legacy checkout at `641d53c8` as read-only migration evidence, and recorded a single-owner, deletion-gated port strategy in [retained journal record](#2026-10-03-bigstrongsun-replacement-foundation-started). Evidence: clean-foundation `cargo check` passed, `pnpm install --frozen-lockfile` passed, and `pnpm typecheck` passed. What NOT to do again: do not bulk replay legacy commits or create parallel save/probe orchestration in the fresh foundation.

# 2026-10-06 — English-first bootstrap and root-note consolidation

What happened: the fresh-refork frontend still exposed Chinese metadata and
could start in the host OS locale on a first run; 91 internal Markdown notes
also remained at repository root.

Root cause: the HTML shell and i18n bootstrap retained legacy Chinese defaults,
while historical notes had accumulated outside the repository's structured
`docs/` ownership model.

What we did: changed the shell metadata to English, made persisted language the
only non-default startup override, filled the seven missing `zh-TW`/`ja`
locale keys, and consolidated all 91 root engineering notes into
`docs/memory/root-notes-archive.md`. A small root `memory.md` compatibility
pointer preserves historical links. Standard README/license/release files were
left at root.

Evidence: archive contains all 91 former note files and is 1,747,281 bytes;
locale parity audit is expected to report zero missing keys after the edits.
UI-wide Chinese fallback cleanup remains in progress and has not been claimed
complete.

What NOT to do again: do not mass-replace CJK in comments, provider names,
locale data, or tests; do not use Codex-native memory as a substitute for
versioned project evidence.

## 2026-10-06 — Committed dependency tree passes frontend gates; backend lock remains
