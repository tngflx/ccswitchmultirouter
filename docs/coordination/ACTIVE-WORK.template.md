# <Session title>

- session: <stable-session-id>
- owner: <person or Codex task id>
- status: active
- started: <YYYY-MM-DDTHH:MM:SS+08:00>
- last_updated: <YYYY-MM-DDTHH:MM:SS+08:00>
- owned_paths:
  - <precise file or directory>
- watch_paths:
  - <dependency or test area that can invalidate this work>
- out_of_scope:
  - <path another session owns or this task must not edit>
- commands:
  - <long-running command, PID/session id, or `none`>
- handoff: <current scope, overlap/blocker, and release condition>

Keep this file current while the task is active. Remove it when the task ends;
record lasting technical decisions and exact verification outcomes in
`docs/memory/journal.md`.
