# Codex Summarize + New Session

## What it does

On Windows, CCSwitchMulti can pause an oversized Codex request, ask the
current Codex Desktop session for a concise handoff summary, and start a new
root session containing only that summary.

The old conversation is not forked, recovered, compacted, deleted, or copied
into the new session. Native Codex compaction endpoints are not used by this
workflow.

## Enable it

Open **Settings > Codex Router Workspace > Request health** and enable
**Offer Summarize + new session**.

When request health detects an oversized request, choose **Summarize + new
session** from the review action. The source turn must be stopped before the
summary turn can begin.

## What happens

1. CCSwitchMulti identifies the active turn in the source thread.
2. It interrupts that turn once and waits for the thread to become idle.
3. Codex Desktop creates a manual summary turn. The summary request asks for
   the goal, decisions, changed areas, current state, failures, tests, and
   next action, and forbids tools or file changes. CCSwitchMulti rejects the
   result if any required section is missing or if the turn contains a tool or
   file action.
4. CCSwitchMulti creates an independent root thread and sends only the returned
   summary in its first turn. It verifies the source task identity, preserves
   the workspace, project assignment (including a projectless source), model,
   provider, reasoning effort, history mode, and environment roots. It refuses
   a response that reuses the source task ID or creates a fork.
5. The new session acknowledges the handoff and waits for your next
   instruction. An existing readable title is preserved; a bounded
   `Handoff — …` fallback is assigned only when the new task has no title.

If interruption, summary generation, or the fresh-session turn fails, the
request-health job reports the failure instead of claiming that a new session
was created.

Repeated bridge calls for the same source task reuse the pending fresh-session
job instead of starting another root.

The internal summary marker bypasses Request Health only while CCSwitchMulti
holds the active handoff guard for that exact source session. Copying the marker
into an ordinary prompt does not grant a bypass.

When a Windows Request Health review is pending, Codex Desktop may also show a
non-interactive in-app advisory banner injected by the compatibility layer. The
Windows notification remains the only approval surface; the banner has no
buttons and cannot resolve or bypass the backend review. It expires with the
pending review and is removed when the review is resolved, dismissed, or times
out.

## Important limitations

- This integration requires a running Codex Desktop app-server with the
  CCSwitchMulti compatibility layer installed.
- The source session must be reachable through Codex Desktop's local CDP
  endpoint.
- The first turn in the new session is intentionally acknowledgement-only.
  Give the new session its next instruction after the handoff completes.
- The feature is currently implemented and covered by focused tests, but live
  acceptance requires restarting the normal `pnpm dev` process after source
  changes so the rebuilt renderer is loaded.

## Troubleshooting

If the action reports that the compatibility layer or request client is not
ready, restart `pnpm dev` from the current checkout and restart Codex Desktop.
Do not retry repeatedly while the original turn is still active; the workflow
deliberately refuses to summarize or compact an active source turn.
