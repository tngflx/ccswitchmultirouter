# Scoped CCSwitch log review, 2026-10-22

This review read the configured CCSwitch log directory,
`C:/Users/felix/.cc-switch/logs`, and inspected the current development
supervisor's direct Node children. It did not drive the application UI, submit
provider requests, modify scheduled tasks, stop processes, or read credentials.
Only event categories, counts, timestamps, counters, and selected process
identity fields are reported here. Provider error bodies and request content
are omitted.

## Monitor availability

The configured Codex automation root was unavailable:
`C:/Users/felix/.codex/automations` did not exist, and the repository's preceding
audit notes also record that its live provider/CDP monitor was unavailable.
No UI automation or broad workspace scan was substituted. The user explicitly
requested log inspection; the findings below are a read-only log review, not
an end-to-end live provider interruption audit.

## Current development runtime

At **2026-10-22 12:26:29 Singapore time** (04:26:29 UTC), the development
session marker reported `running` with an empty recent automatic-restart
history. PID-scoped CIM queries found all three recorded processes alive:

| Role       | PID   | OS creation time, UTC        |
| ---------- | ----- | ---------------------------- |
| Supervisor | 23996 | 2026-10-22T03:49:32.3485880Z |
| Worker     | 56712 | 2026-10-22T03:49:40.6583640Z |
| Debug app  | 48812 | 2026-10-22T03:50:19.5267980Z |

There was exactly one direct-child Node process matching the recorded Node
executable, exact watchdog script, `--ccsm-dev-watchdog` argument, and supervisor
PID: watchdog **27864**. This observation establishes that the watcher process
was alive; it does not prove that a live crash had just been recovered.

## Error-journal snapshot

The first bounded snapshot of the current `proxy-errors.jsonl` contained
**1,549 records**, spanning **2026-10-21T12:57:11Z through
2026-10-22T04:20:15Z**. The log continued to receive records during the review.

| Event kind                     | HTTP status | Count | Interpretation                                                                                            |
| ------------------------------ | ----------- | ----- | --------------------------------------------------------------------------------------------------------- |
| `sse_inspection_limit`         | 200         | 1,204 | A bounded diagnostic inspector skipped an oversized SSE frame. This alone is not a connection failure.    |
| `response_consumption_stopped` | 200         | 292   | The consumer stopped reading. The journal explicitly does not treat this as proof of an upstream failure. |
| `upstream_sse_error`           | 200         | 43    | The upstream delivered an explicit SSE error inside an HTTP-success stream.                               |
| `upstream_http_error`          | 403         | 5     | Historical daily-limit-related HTTP failures on October 21.                                               |
| `upstream_http_error`          | 429         | 5     | Historical daily-limit-related HTTP failures on October 21.                                               |

The recent SSE errors had the same redacted evidence hash and matched the
overload/server/try-again category. The latest two occurred at
**2026-10-22T04:14:14Z and 04:14:28Z**. The HTTP 403/429 cluster occurred around
**2026-10-21T13:34Z** and must not be represented as a newly reproduced quota
retry bug after the subsequent classifier fixes.

The inspection-limit events account for most journal entries. The current
observer caps only its diagnostic buffer; it forwards the original stream
items. These records should be separated from actual upstream error counts
when assessing stream reliability.

## Codex continuation evidence

The complete current `codex-router.log` file, approximately 2 MiB, contained
these continuation-status events at the review snapshot:

| Status and reason                         | Count |
| ----------------------------------------- | ----- |
| `scheduled`, `response_failed`            | 99    |
| `scheduled`, `app_crash_interrupted_turn` | 2     |
| `submit_failed`, `desktop_ready_deadline` | 1     |
| `submitted`                               | 0     |
| `outcome_unknown`                         | 0     |

The latest concrete sequence was:

1. **12:14:14.824 Singapore time:** recovery scheduled for `response_failed`,
   budget three, attempt one.
2. **12:14:28.895:** another recovery scheduled for `response_failed`, budget
   three, attempt one.
3. **12:15:28.923:** recovery reported `submit_failed` with
   `desktop_ready_deadline`, attempt one.

The persisted recovery ledger held eight contexts at the snapshot; all were
Desktop-eligible and had `submitted: 0`. The ledger is live state, not a
historical proof that all scheduled attempts failed. New user requests can
supersede a scheduled recovery, so the earlier scheduled records without an
outcome must not all be counted as failed submissions.

The latest deadline event is material: scheduling happened, but the log does
not demonstrate a successful `continue` submission. This was reported to the
stream-recovery investigation for bridge/readiness analysis. A static
readiness-failure category in the structured router event would make this
boundary easier to diagnose without serializing arbitrary exception text.

## Watchdog and exit history

`dev-watchdog.jsonl` recorded a transient PowerShell query timeout at
**2026-10-22T04:22:07Z**. The detached watchdog's iteration loop catches query
failures and continues; a timeout entry alone does not show that it stopped.
The later process observation above found that watchdog alive. Earlier entries
include legacy PowerShell startup failures on October 13, 14, and 20, plus a
status failure on October 21. They predate the current review and must not be
presented as newly reproduced failures of the JavaScript takeover work.

`app-exit-events.jsonl` contained three panic records, all from **October 13**
and all attributed to `fern 0.7.1`'s logging implementation. No new October 22
panic appeared in that file. The remaining 54 records were prior-run marker
detections. A marker left at startup can follow a planned forceful development
reload, so those records alone do not establish 54 application defects.

No request-health schema event was identified in the scoped router-log
snapshot. Its absence cannot establish whether schema detection works;
request-health source and regression checks are a separate verification path.

## After the manual development replacements

A second read-only review restricted entries to **2026-10-22T05:15:00Z onward**
(13:15 Singapore time), covering the two explicit `pnpm dev` replacement
commands. At the **05:19:49 UTC** log snapshot, the router had 66 new records:
eight sends, eight upstream statuses, eight response-ready events, and one
continuation event among the normal routing/preparation records.

The continuation event at **13:18:39.426 Singapore time** was `scheduled` for
`app_crash_interrupted_turn`, with budget three and attempt one. A repeat
outcome-only check at **05:20:25 UTC** still showed no new `submitted`,
`outcome_unknown`, `submit_failed`, or `readiness_blocker` event. The schedule
alone does not establish that `continue` was sent; a later user request may
also supersede it.

The new proxy-journal window contained **36 entries**: 30
`sse_inspection_limit` events and six `response_consumption_stopped` events,
all under HTTP 200. It contained no new `upstream_sse_error` or
`upstream_http_error`. The watchdog log had no new entries in this window.
The main application log had no new `ERROR` or panic entry in the inspected
window and no continuation-submission or readiness-blocker message. Its
warnings included session-usage synchronization and startup/history migration
categories; their presence is not proof of an application crash.

There were two new prior-run marker detections, at **13:17:26.307** for the
first replacement app and **13:18:35.149** for the second. These coincide with
the deliberate development replacements and are expected evidence of the
old marker remaining after those planned stops. Neither was a panic record.

The separately produced [development replacement receipt](2026-10-22-dev-takeover-runtime.json)
records completion of both actual `pnpm dev` takeovers and final identity and
listener checks at 05:21:11 UTC. This log review did not run additional
provider, CDP, UI, process-control, or watcher actions. The new log window
contains no concrete new app/watchdog failure, while successful live Codex
continuation remains unproven by the available outcome records.
