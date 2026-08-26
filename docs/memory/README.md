# ⚠️ AGENT MEMORY — READ BEFORE CODING

This folder is the **engineering decision journal** for this fork, maintained by AI coding agents (Codex) and humans alike.

## Why this exists

AI agents have **no memory between sessions**. Code shows *what* was done; this journal records **why** — root causes, rejected approaches, and verification evidence — so future sessions (and human reviewers) don't re-diagnose solved problems or accidentally revert deliberate decisions.

## Files

| File | Purpose |
|------|---------|
| `journal.md` | Chronological log, **newest first**. One entry per significant event. |
| `incidents/YYYY-MM-DD-<topic>.md` | Deep-dive post-mortems for investigations too large for one journal entry (create only when needed). |

## Rules for agents (mandatory)

1. **Log only significant events:** root causes of non-obvious bugs, deliberate design decisions + rationale, upstream cherry-pick/merge verdicts, release evidence.
2. **Entry format:** `What happened → Root cause → What we did → Evidence (exact test/verification results) → What NOT to do again`.
3. **Never rewrite history.** Corrections are **new** entries that reference the old one.
4. **Keep it tight.** No trivia — not every commit is a memory. If a fix is obvious from the commit message alone, skip it.
5. **Newest first.** Date every entry (`## YYYY-MM-DD Title`).

## Rules for human developers

- Before reverting or "cleaning up" something odd, **search this folder first** — it may be deliberate.
- When you solve something non-obvious, add an entry. Future-you will thank you.
- This folder is **documentation, not dead weight**: pruning it destroys institutional knowledge.
