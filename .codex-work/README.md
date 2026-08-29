# Codex Work Leases

`.codex-work/active/` contains short-lived, per-session JSON leases. The
directory is gitignored because ownership is live coordination, not project
history. Each lease claims precise paths and lists only processes started by
that session.

Before editing or running broad verification, inspect `git status --short`,
`git diff --name-only`, active Codex tasks, and every lease. Create one file
named `<session-id>.json` before the first edit. Update it only when paths or
owned processes change. Remove it at handoff, cancellation, or confirmed
abandonment. Never remove another lease merely because it is old: check for a
matching process and ask the user before releasing it.

Legacy Markdown manifests under `docs/coordination/active/` remain readable
during migration. Do not create new manifests there.

Lease shape:

```json
{
  "owner": "task id",
  "updated_at": "2026-08-29T02:15:00+08:00",
  "paths": ["src/example.ts"],
  "processes": []
}
```
