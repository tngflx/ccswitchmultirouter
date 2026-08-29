# Cross-Session Coordination (Legacy)

New sessions use compact, ignored leases in `.codex-work/active/`. This
directory is retained only so existing Markdown manifests remain readable
during migration. It answers one short-lived question: who may be changing
which paths right now?

It is deliberately separate from `docs/memory/`. Coordination leases are
temporary operational state. The engineering journal records durable decisions,
root causes, and verification evidence.

## Legacy Workflow

If an existing Markdown manifest is present, read it before editing code,
formatting files, or starting a broad test/build:

1. Read every `*.md` file in `active/`.
2. If an entry owns a path you need, coordinate with its owner or mark your
   task blocked. Do not silently take over the path.
3. Do not create new files here. Create `.codex-work/active/<session-id>.json`
   using the protocol in `.codex-work/README.md`.
4. Do not edit or remove another owner's manifest. Ask the owner or user to
   release it; a stale file is not permission to take its paths.

Separate leases are intentional: concurrent sessions do not need to edit a
single shared live-work ledger. A stale lease is not permission to overwrite
its paths; treat them as unowned-but-dirty until the user or original owner
releases it.

The current ownership rules and lease shape live in `.codex-work/README.md`.
Use precise paths there; `src/components/codex/CodexRouterWorkspacePage.tsx`
is useful, while `frontend` is not.
