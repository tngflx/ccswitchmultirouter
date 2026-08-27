# Cross-Session Coordination

This directory is the shared operational handoff surface for Codex sessions
and human developers working in the same checkout. It answers one short-lived
question: who may be changing which paths right now?

It is deliberately separate from `docs/memory/`. Coordination manifests are
temporary operational state. The engineering journal records durable decisions,
root causes, and verification evidence.

## Workflow

Before editing code, formatting files, or starting a broad test/build:

1. Read every `*.md` file in `active/`.
2. If an entry owns a path you need, coordinate with its owner or mark your
   task blocked. Do not silently take over the path.
3. Create `active/<session-id>.md` from `ACTIVE-WORK.template.md`. Use a stable,
   readable ID such as `codex-router-catalog-2026-08-28`.
4. Update your own manifest when your scope changes, a broad test becomes
   inconclusive, or a long-running process starts/stops.
5. At handoff, put durable findings in `docs/memory/journal.md`, then remove
   your manifest. Never delete or rewrite another owner's manifest.

Separate manifests are intentional: concurrent sessions do not need to edit a
single shared ledger just to announce independent work. A stale manifest is
not permission to overwrite its paths; treat it as unowned-but-dirty until the
user or original owner releases it.

## Ownership Rules

- `owned_paths` are the files or directories the owner may edit.
- `watch_paths` are dependencies whose changes can invalidate the owner's tests.
- `out_of_scope` are explicit no-touch areas for that session.
- An overlapping `owned_paths` entry means the later session must coordinate or
  stay blocked. Watching a path does not grant edit permission.
- A full-suite failure in an active owner's path is **inconclusive** unless it
  reproduces after that owner declares the worktree stable.
- Only stop processes recorded in your own manifest. Never stop another
  session's test, build, development server, or application process.

Use precise paths. `src/components/codex/CodexRouterWorkspacePage.tsx` is useful;
`frontend` is not.
