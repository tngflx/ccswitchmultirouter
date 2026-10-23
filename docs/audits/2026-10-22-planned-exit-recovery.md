# Planned development exits and configuration recovery, 2026-10-22

The user reported the notification, "The previous run did not exit cleanly;
review the configuration recovery result," after development replacement.

## Reproduced causes

The two manual `pnpm dev` takeovers from the preceding audit both left the
old app-run marker after force-stopping the exact owned app. Neither stop
recorded a clean or planned shutdown event. Startup therefore classified the
old process as `unclean_exit`, recorded a warning, and performed crash recovery.
This was a missing lifecycle handoff in the replacement implementation.

The real before-fix records are:

| New startup, Singapore time | Previous app PID | Classification |
| --------------------------- | ---------------: | -------------- |
| October 22, 13:17:26        |            48812 | `unclean_exit` |
| October 22, 13:18:35        |            18064 | `unclean_exit` |

Current generation 57 did not record a failed configuration recovery. It
recorded the unclean warning followed by healthy live-configuration restoration,
successful startup crash recovery, and successful Codex takeover restoration.
All three restoration outcomes were informational and had no lost fields.
The frontend hides informational outcomes while displaying the warning, which
made the exit-condition warning appear to be a configuration-recovery failure.

A separate source audit identified a destructive crash-recovery ordering:
`recover_from_crash` restored every supported app, and the shared restore helper
preferred a healthy saved backup before checking whether that app's live
configuration was already valid and no longer under CCSwitch takeover. A stale
backup could therefore replace newer valid live settings after an unrelated
app's crash. Explicit restore/disable operations and automatic crash recovery
need distinct intent at this boundary.

The title now reports only its actual evidence: "The previous run ended without
a clean shutdown record." English, Japanese, Simplified Chinese, and Traditional
Chinese regressions failed before the copy correction and pass afterward
(eight tests). Warning severity and acknowledgment behavior are unchanged.

## Implemented corrections

Development cleanup now records `planned_restart` only after successful native
termination of the retained app process and completion of its tree/listener
cleanup. The receipt reuses `app-exit-events.jsonl`; it does not introduce a
second persisted run marker. PID, executable, exact 100 ns process start,
configuration scope, and marker start time must match. A negative native result
does not fall back to a PID-based kill. Missing markers permit owned-process
cleanup without inventing a planned-exit receipt.

The canonical development session carries the verified manual handoff intent
and worker readiness. After native owner validation, the still-live supervisor
asks its worker to retire monitoring through existing IPC. Only the exact
current worker can acknowledge readiness. The new launcher cleans the app and
commits the planned receipt while that supervisor stays parked, then stops the
old supervisor last. A bounded, revalidated refresh repairs queued old writes
only while the same canonical owner remains running; it cannot overwrite an
ordinary stop or a new owner. Older runtimes without this protocol undergo one
unplanned transition. Ordinary Ctrl+C and an unexpected parent crash do not
qualify as a manual handoff. Panic, forced-exit, and crash-log evidence still
outrank a planned receipt.

Crash configuration recovery now preserves a readable, structurally valid
current Live configuration with no canonical takeover markers, under the
existing per-app switch lock. Missing, malformed, invalid-container, and
taken-over Live configurations retain the existing restore path. Explicit
restore remains backup-first. A successful preservation does not claim that a
backup was restored; the misleading aggregate success outcome was removed
because each app already records its actual restoration action.

The destructive backup preference was reproduced before implementation: all
three Claude/Codex/Gemini preservation tests failed because the stale backup
replaced newer current settings. Additional controls cover Grok official
configuration, Codex auth-only/config-only files, missing/malformed/taken-over
Live, explicit restore, and malformed backup retention.

Final review also reproduced two validity gaps in that new preservation gate:
the normal permissive Gemini env reader silently accepted a malformed line as
an empty environment, and valid Grok TOML syntax did not prove that its selected
custom model existed. Both failed the new recovery regressions before the
correction (two failures with the existing restore control passing). Gemini
preservation now reads and strictly parses the candidate once, then checks
ownership against that same content without logging raw parser errors. Grok
uses its canonical official/custom configuration validators. Empty and
comment-only native configurations remain covered preservation cases.

Broad Rust verification also exposed process-wide test-home races in four
existing continuation-ledger restoration tests. All five restoration call
sites now acquire the repository's shared serial lock and an isolated test
home. The acknowledged-continuation regression also checks the restored spent
budget immediately, before observing the next request. Runtime scope checks
and existing assertions remain intact.

## Verification

- Recovery copy and App integration: 32/32 passed.
- Development recovery: final 188/188 passed, including the complete native
  topology, child-loss, exact timestamp, and refresh-boundary regressions.
- Lifecycle: 129/129 passed.
- Gated renderer build: passed, including 476/476 catalog tests.
- TypeScript, frontend/script formatting, and Rust formatting: passed.
- Final complete Rust library run: 4,997 passed, zero failed, 10 existing ignored.
- Required Rust multirouter scope: 156/156 passed.
- Strict Clippy: passed after removing an unused restore wrapper and directing
  all 11 explicit-restore test calls to the canonical policy method. The wrapper
  became test-only after the policy refactor; no lint suppression was added.
- The first full Rust run passed 4,993 cases and failed one test-message casing
  assertion compiled immediately before its correction was saved. Two later
  runs each exposed a different continuation-ledger test-home race, with 4,993
  cases passing in each. All four affected restoration tests are now isolated.
  A second complete Rust run after the mechanical wrapper cleanup also passed
  4,997 cases with 10 existing ignored, followed by 156/156 multirouter cases.
  No guard was weakened.

The old worker first needed replacement to load the handoff logic. That
transition is excluded from fix evidence. The final observer required two
consecutive actual `pnpm dev` replacements using updated workers, both
classified as planned with no current-generation unclean/crash warning or
startup crash-recovery operation.

The first local activation attempt did not satisfy that requirement. The new
binary started at 16:52 Singapore time (generation 58, transitional and excluded
from evidence), but the first updated-worker replacement at 16:56 (generation 59) still recorded `unclean_exit`. The canonical exit journal contained no
planned receipt for the old app, so the classifier correctly rejected the
attempt as proof of the fix. Both generations successfully restored Codex
configuration and takeover without a recovery error. The failed observer
receipt was retained during investigation of the missing JavaScript receipt.

That investigation reproduced the missing-receipt bug with a native fixture:
an app which exits when its child exits returned `terminated: false` because
the helper killed app-owned children before terminating the retained app. Real
WebView teardown can therefore erase the intended-stop proof. The helper now
retains and validates child handles first, confirms the retained app's unique
planned termination code, then cleans its children. Journal commit still waits
for the complete cleanup. The old helper failed the parent-exits-on-child-loss
regression; all eight native helper tests pass after the correction.

A second regression reproduced a disconnected worker's competing cleanup when
its one-time CIM identity query failed despite an exact canonical handoff.
The worker now captures its own verified identity before launching app roots
and uses that snapshot during handoff; missing snapshots permit bounded retry
of the identity query. Static lifecycle breadcrumbs record only PIDs, planned
reasons, cleanup stages, and handoff decisions for subsequent scoped diagnosis.

The repeated combined native gate then exposed implicit PowerShell date
normalization in the new handoff writer: a canonical `.620Z` could become
`.62Z`, or a seven-digit fractional string could lose trailing zeros. The new
native JSON roundtrips now preserve date strings with `-DateKind String`;
strict canonical-session assertions stay intact. Worker process-identity
comparison reuses the shared 100 ns `utcTicks` parser, accepting equivalent
offset/fraction spellings while still rejecting one-tick mismatches. Both the
equivalent-identity case and deterministic native timestamp rewrite failed
before the correction. The host uses PowerShell 7.6.7; the new native JSON
option requires PowerShell 7.5 or later.

The second live attempt still failed its first strict proof (generation 62 at
20:17 Singapore time), with no new planned-stop or worker-disconnect breadcrumb.
A disposable complete supervisor/IPC-worker/app topology then reproduced the
actual Windows boundary: terminating the retained supervisor also destroyed its
worker and app before the disconnect handler ran, both under plain Node and
under the installed pnpm executable. Post-parent-exit handoff was therefore too
late even with the identity/cache/child-order corrections. The final sequencing
change moves monitor retirement and its exact acknowledgement before parent
termination, performs planned app cleanup and journal commit while the supervisor
is still alive, and stops the supervisor last under the existing launch mutex.

The new mandatory native integration fixture passes with a real supervisor,
IPC worker, child-dependent app, child process, and detached watchdog. It
checks monitor retirement before acknowledgement, unique app termination and
child cleanup, journal commit while the supervisor is alive, worker removal
while the supervisor remains parked, and final owner termination after the
watchdog has voluntarily retired. Pure tests also cover missing/changed-owner
acknowledgements, cleanup failure preventing owner stop, phase preservation,
and bounded republishing after a stale old write. The canonical development
gate now includes this fixture and serializes native test files; assertions and
process deadlines are unchanged.

## Final local activation

The third observer run succeeded with two consecutive actual updated-worker
takeovers. Its transitional generation 63 is explicitly excluded from proof.

| Generation | Startup, Singapore time | Previous-run classification | Current warning/crash outcomes | Startup crash-recovery operations |
| ---------- | ----------------------- | --------------------------- | -----------------------------: | --------------------------------: |
| 64         | October 22, 20:48:19    | `planned_restart_or_update` |                              0 |                                 0 |
| 65         | October 22, 20:50:09    | `planned_restart_or_update` |                              0 |                                 0 |

Both runs matched the exact old-app `planned_restart` receipt with reason
`development_manual_restart`, recorded informational `plannedRestartOrUpdate`,
restored Codex takeover, and owned loopback port 15721. The observer also
verified actual pnpm ancestry, source freshness, retired old owners, one
anchored watchdog, and a fresh manual restart budget in each run.

At 20:52:42 Singapore time, an independent scoped post-check matched exact
native creation times and executable paths for supervisor 49200, worker 31400,
watchdog 19496, and app 2480. The app marker's full FILETIME matched, exactly one
anchored watchdog remained, the app still owned 127.0.0.1:15721, and generation
65 contained zero warnings or errors. The rebuilt debug binary includes all
Rust changes; both workers postdate the final JavaScript changes. Evidence is
saved in [the sanitized runtime receipt](./2026-10-22-planned-exit-recovery-runtime.json).

## Verification boundaries

The original log evidence is a real before-fix reproduction of the false
classification; successful process takeover alone did not verify startup
classification. Final verification inspected startup classification and recovery
outcomes as well as exact process ownership. Planned launches skipped crash
backup restoration. Genuine dead processes without verified planned-stop
evidence remain recoverable. No production release was built or installed.

The configured live provider/CDP monitor is unavailable. No provider request or
UI automation is used to substitute for it. Local source tests and planned
application activation cannot prove delivery of a live Codex continuation.
