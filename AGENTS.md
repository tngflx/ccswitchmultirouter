# AGENTS.md — MANDATORY RULES

## NEVER TAKE SHORTCUTS

1. **NEVER use `--theirs` or `--ours` blindly during merge conflicts.** Read EVERY conflict hunk. Understand what each side changed and WHY before resolving.

2. **NEVER skip running tests after any merge, cherry-pick, or code change.** Full test suite (frontend + backend) must pass before declaring success.

3. **NEVER claim something is "done" or "verified" without actually running the verification command and reading its output.**

4. **NEVER dismiss a commit as "too large" without auditing every file inside it.** Large commits may contain small, independently useful changes (e.g., a 20-line schema migration buried in a 10K-line feature).

5. **NEVER assume auto-merge succeeded correctly.** Git can auto-merge textually while producing semantically broken code. Always compile + test after merge.

6. **NEVER hallucinate results.** If you did not run a command, do not say you did. If a test failed, say it failed. If you are unsure, say so.

## ALWAYS RECHECK

7. **After ANY upstream merge:** grep for every function/field/import that our custom code depends on (`resolve_reasoning_content_mode`, `ReasoningContentMode`, `normalize_third_party_responses_reasoning_content_for_strict_schema`, `reasoning_content_mode` on ProviderMeta, LanguageSwitcher, etc.). Upstream may silently remove or rename them.

8. **After ANY cherry-pick:** run `cargo check` AND `pnpm typecheck` immediately. Then run the specific tests related to the changed files.

9. **Before pushing to origin:** run the full test suite one final time. Do not push if any previously-passing test now fails.

10. **When reporting status:** list exactly what passed, what failed, and what was not tested. Never round up or omit failures.

## MERGE PROTOCOL

11. Before merging, list ALL files changed between HEAD and the remote.
12. For each conflicting file, show the diff hunk to yourself and explain why you chose each resolution.
13. After resolving conflicts, `cargo check` + `pnpm typecheck` BEFORE committing the merge.
14. After committing the merge, run FULL test suite before pushing.

## HONESTY

15. If you broke something, say "I broke X" not "X has an issue."
16. If you skipped a step, say "I skipped Y" not "Y was not needed."
17. If you do not know something, say "I do not know" instead of guessing.

## PRODUCTION BUILD — MANDATORY

18. **NEVER use plain `cargo build --release` for production.** Without `--features tauri/custom-protocol`, the binary embeds `devUrl` (localhost:3000) instead of the built frontend assets. This causes the "This site can't be reached / localhost refused to connect" error.

19. **Correct production build commands (use one of these):**
    - Full Tauri bundle: `pnpm build` (runs `pnpm tauri build`)
    - Raw exe only: `pnpm build:exe` (runs `pnpm build:renderer && cargo build --manifest-path src-tauri/Cargo.toml --bin cc-switch --release --features tauri/custom-protocol`)
    - Full release pipeline with artifacts: `pnpm release:local`

20. **Before declaring a production build successful, verify the binary embeds frontend assets:**
    ```powershell
    $bytes = [System.IO.File]::ReadAllBytes("src-tauri\target\release\cc-switch.exe")
    $text = [System.Text.Encoding]::ASCII.GetString($bytes)
    # Must return True — proves custom-protocol is active:
    $text.Contains("index-") # matches Vite hashed asset names embedded in binary
    ```
    If this returns False, the build is broken (dev-protocol only).

21. **NEVER kill a running `cc-switch.exe` or `cc-switch2.exe` process without explicit user permission.** The coding agent may be using it as an active proxy. Always ask first.

22. **The `localhost:3000` string appearing in a production binary is normal** — it is the compiled-in `devUrl` from `tauri.conf.json` used only by `tauri dev`. Its presence does NOT indicate a broken build. What matters is whether the Vite asset hashes are also embedded.

## CODEBASE STRUCTURE

### Backend (Rust — `src-tauri/`)

| Path | Purpose |
|------|---------|
| `src/main.rs` | Tauri app entry point |
| `src/lib.rs` | Library root, module declarations |
| `src/provider.rs` | Provider metadata types (`ProviderMeta`, `ReasoningContentMode`, `CodexApiKeyGroup`) |
| `src/config.rs` | App config, provider settings schema |
| `src/settings.rs` | User settings (stream retry toggle, language, etc.) |
| `src/codex_config.rs` | Codex config file parsing/writing |
| `src/codex_desktop.rs` | CDP integration with Codex desktop app (model picker injection) |
| `src/codex_multirouter/` | Multi-router compiler, mutation, projection logic |
| `src/proxy/` | HTTP proxy server (axum) |
| `src/proxy/codex_traffic_policy.rs` | Codex traffic routing policy (official vs third-party) |
| `src/proxy/forwarder.rs` | Request forwarding, retry, streaming |
| `src/proxy/provider_router.rs` | Provider selection and routing |
| `src/proxy/providers/` | Per-provider adapters (Claude, Codex, OpenAI-compatible) |
| `src/proxy/providers/streaming_retry.rs` | Stream retry on failure |
| `src/proxy/usage/` | Token usage parsing and logging |
| `src/resources/` | JS templates injected via CDP (model picker, app compat) |
| `src/commands/` | Tauri IPC command handlers |
| `src/services/` | Business logic (provider sync, proxy management, skills, presets) |
| `src/database/` | SQLite schema, migrations, backup |
| `src/store.rs` | Persistent state store |
| `tests/` | Integration tests |

### Frontend (TypeScript/React — `src/`)

| Path | Purpose |
|------|---------|
| `App.tsx` | Root component, routing |
| `components/codex/` | Codex-specific UI (router workspace, wizard, subagent editor, usage) |
| `components/providers/` | Provider list, cards, forms |
| `components/providers/forms/` | Provider form fields, reasoning editor, catalog sync, traffic policy |
| `components/settings/` | Settings page, language switcher, global config |
| `components/sessions/` | Session manager, history repair |
| `components/openai/` | OpenAI-compatible API page |
| `components/proxy/` | Proxy controls (stream retry toggle) |
| `config/` | Provider preset definitions (per-app: Claude, Codex, Gemini, etc.) |
| `i18n/` | Internationalization (index.ts + locales/en.json, zh.json, zh-TW.json, ja.json) |
| `icons/extracted/` | Provider icons (SVG/PNG + metadata) |
| `lib/schemas/` | Zod schemas for provider and settings validation |
| `lib/openai/` | External profile handling |
| `hooks/` | React hooks (provider actions, settings form) |
| `types.ts` | Shared TypeScript type definitions |

### Tests

| Path | Purpose |
|------|---------|
| `tests/components/` | Frontend component tests (Vitest + Testing Library) |
| `tests/config/` | Provider preset tests |
| `tests/hooks/` | Hook tests |
| `tests/integration/` | App-level integration tests |
| `tests/lib/` | Library/utility tests |
| `src-tauri/tests/` | Rust integration tests |

### Key Custom Fields (fork-specific — upstream may not have these)

- `reasoning_content_mode` on `ProviderMeta` — controls reasoning text injection per provider
- `enable_stream_retry` on settings — toggles stream retry behavior
- `CodexApiKeyGroup` — grouped API keys for different model tiers (Sublyx)
- `codex_traffic_policy` — official_first / third_party_first routing
- `LanguageSwitcher` — i18n language selection component

## COMMIT GUIDELINES

23. **Each commit must represent one coherent feature, fix, or test change.** Do not squash unrelated features into one commit. Do not split a single feature across many trivial commits.

24. **Commit message format:** `type(scope): description` — e.g., `feat(proxy): add stream retry`, `fix(ui): preserve reasoning fallback`, `test(backend): update integration tests`.

25. **Before force-pushing rewritten history, verify the final tree is byte-identical to the tested state:** `git diff <old-tested-sha>..HEAD` must be empty.

## UPSTREAM SYNC PROTOCOL

26. **Before merging upstream, fetch and list ALL incoming commits:** `git log HEAD..upstream/main --oneline`
27. **After upstream merge, verify these fork-specific identifiers still exist:**
    - `resolve_reasoning_content_mode`
    - `ReasoningContentMode`
    - `normalize_third_party_responses_reasoning_content_for_strict_schema`
    - `reasoning_content_mode` field on `ProviderMeta`
    - `enable_stream_retry` on settings
    - `CodexApiKeyGroup`
    - `LanguageSwitcher` component
    - `codex_traffic_policy` module
    - `codexCatalogSync` module

## AGENT MEMORY PROTOCOL

28. **Maintain `docs/memory/journal.md`** (newest first, dated entries) per the rules in `docs/memory/README.md`. Log only significant events: root causes of non-obvious bugs, deliberate design decisions + rationale, upstream cherry-pick/merge verdicts, release evidence.

29. **Entry format:** What happened → Root cause → What we did → Evidence (exact test/verification results) → What NOT to do again. Never rewrite old entries; corrections are new entries referencing the old one.

30. **Before reverting or "cleaning up" anything unusual, search `docs/memory/` first** — the oddity may be a deliberate, documented decision.

31. **Deep investigations** that exceed one entry go to `docs/memory/incidents/YYYY-MM-DD-<topic>.md`, linked from the journal entry.
