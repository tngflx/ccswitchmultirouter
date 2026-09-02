# AGENTS.md — MANDATORY RULES

## NEVER TAKE SHORTCUTS

1. **NEVER use `--theirs` or `--ours` blindly during merge conflicts.** Read EVERY conflict hunk. Understand what each side changed and WHY before resolving.

2. **NEVER skip relevant tests after a merge, cherry-pick, or code change.** During active development, run targeted tests for the changed behavior plus tests for plausible dependents and shared contracts. Do not run the full frontend and backend suites after every incremental edit. Run the full suites only for final verification as defined in rule 9.

3. **NEVER claim something is "done" or "verified" without actually running the verification command and reading its output.**

4. **NEVER dismiss a commit as "too large" without auditing every file inside it.** Large commits may contain small, independently useful changes (e.g., a 20-line schema migration buried in a 10K-line feature).

5. **NEVER assume auto-merge succeeded correctly.** Git can auto-merge textually while producing semantically broken code. Always compile + test after merge.

6. **NEVER hallucinate results.** If you did not run a command, do not say you did. If a test failed, say it failed. If you are unsure, say so.

6-A. **Fix root causes before symptoms.** For every bug, error, warning storm, retry loop, or recovery failure, trace the producing path to the violated invariant and fix that invariant at its owning layer. Do not merely suppress logs, increase retries/timeouts, clear persisted state, special-case one observed input, or add UI masking while the producer remains wrong. A containment measure is allowed only when the root cause is external or cannot yet be fixed safely; label it as containment, preserve diagnostic evidence, document the unresolved cause, and add a regression test for the closest owned boundary.

6-B. **Request-size growth requires a four-point accounting audit.** For any suspected
request inflation, measure and compare the client body, the post-transformation body,
the exact retry/replay body, and the upstream wire body. Trace every append/restore/
conversion boundary and identify the producer of each added byte or semantic item.
Do not “fix” growth by truncating context, suppressing retries, clearing history,
or adding a size cap unless the owning invariant is proven and the containment is
explicitly documented. Retries of one logical request must reuse an immutable,
already-finalized payload; history restoration must be idempotent; and any
client-versus-proxy growth must have a regression test at the owning boundary.
When no proxy inflation exists, state that clearly and preserve the evidence rather
than changing unrelated request logic.

## ALWAYS RECHECK

7. **After ANY upstream merge:** grep for every function/field/import that our custom code depends on (`resolve_reasoning_content_mode`, `ReasoningContentMode`, `normalize_third_party_responses_reasoning_content_for_strict_schema`, `reasoning_content_mode` on ProviderMeta, LanguageSwitcher, etc.). Upstream may silently remove or rename them.

8. **After ANY cherry-pick:** run `cargo check` AND `pnpm typecheck` immediately. Then run the specific tests related to the changed files.

9. **Run the full frontend and backend test suites only at a final verification boundary:** when the user says the current feature/coding batch is finished, before pushing to origin, before a release, or before declaring a merge/cherry-pick batch ready for delivery. Do not infer that every assistant response is the end of the coding session. Do not push if any previously-passing test now fails.

10. **When reporting status:** list exactly what passed, what failed, and what was not tested. Never round up or omit failures.

10-A. **Concurrent work uses Git boundaries, not local lease files.** Before editing or
starting broad verification, inspect `git status --short` and `git diff --name-only`.
Use a separate Codex task/worktree or branch for parallel work. Do not edit the same
checkout concurrently unless the other task has explicitly agreed to the overlap.
Treat unexplained dirty files as user or another-task work: do not overwrite,
format, revert, or attribute them. If a shared checkout is unavoidable, coordinate
in the task conversation and verify against the moving tree; do not create
local lease files, lock files, or ad-hoc coordination artifacts.

10-B. **NEVER create an isolated or alternate build target directory.** Do not set
`CARGO_TARGET_DIR`, `RUSTFLAGS`-based output roots, custom `target-dir` values, or
equivalent per-task build/cache paths to work around a lock or live `pnpm dev`
process. Use the repository's normal target directory only. If the normal target
is locked, report the exact lock/error and continue with source-level checks or
wait for the existing development process; never create a second build tree.

10-C. **Ask for a user rebuild when the normal development process must load a
source fix.** If a live `cc-switch.exe` predates the changed source, the normal
target is locked, or runtime verification requires a rebuilt process, state the
exact rebuild action needed and ask the user to perform it. Pause runtime
verification until they confirm the rebuild completed; do not kill their process,
create an alternate build target, or present an older binary as evidence for the
new source.

## MERGE PROTOCOL

11. Before merging, list ALL files changed between HEAD and the remote.
12. For each conflicting file, show the diff hunk to yourself and explain why you chose each resolution.
13. After resolving conflicts, `cargo check` + `pnpm typecheck` BEFORE committing the merge.
14. After resolving or committing a merge, run compile/type checks and targeted tests for the merged areas immediately. Run the full suites once at the final verification boundary in rule 9, before pushing or final delivery.

## HONESTY

15. If you broke something, say "I broke X" not "X has an issue."
16. If you skipped a step, say "I skipped Y" not "Y was not needed."
17. If you do not know something, say "I do not know" instead of guessing.

## PRODUCTION BUILD — MANDATORY

18. **NEVER use plain `cargo build --release` for production.** Without `--features tauri/custom-protocol`, the binary embeds `devUrl` (localhost:3000) instead of the built frontend assets. This causes the "This site can't be reached / localhost refused to connect" error.

19. **Production and release artifacts MUST be built entirely by GitHub Actions.** Agents must never run `pnpm build`, `pnpm build:exe`, `pnpm release:local`, `pnpm tauri build`, or any release-mode Cargo build on a developer workstation for a release. This prohibition includes binaries, installers, bundles, signatures, checksums, and updater artifacts. Local `cargo check`, `cargo test`, frontend type checks, and frontend tests remain allowed because they do not produce release artifacts. Trigger the repository's release workflow and use only artifacts produced by that GitHub Actions run.

20. **Before declaring a GitHub Actions production build successful, download or inspect the workflow-produced binary and verify that it embeds frontend assets:**
    ```powershell
    $bytes = [System.IO.File]::ReadAllBytes("src-tauri\target\release\cc-switch.exe")
    $text = [System.Text.Encoding]::ASCII.GetString($bytes)
    # Must return True — proves custom-protocol is active:
    $text.Contains("index-") # matches Vite hashed asset names embedded in binary
    ```
    If this returns False, the build is broken (dev-protocol only).

21. **NEVER kill a running `cc-switch.exe` or `cc-switch2.exe` process without explicit user permission.** The coding agent may be using it as an active proxy. Always ask first.

22. **The `localhost:3000` string appearing in a production binary is normal** — it is the compiled-in `devUrl` from `tauri.conf.json` used only by `tauri dev`. Its presence does NOT indicate a broken build. What matters is whether the Vite asset hashes are also embedded.

22-A. **Desktop UI inspection must be non-disruptive by default.** Do not call `SetForegroundWindow`, restore/minimize/maximize a user window, move the cursor, send foreground keystrokes, or perform coordinate clicks merely to inspect or test a running desktop application. Prefer this capture order: locate the Tauri WebView renderer child without activation, capture that child with `PrintWindow`, then fall back to top-level `PrintWindow` only if the child is unavailable. A localhost renderer in a separate browser is not the live Tauri window and must never be reported as such.

22-B. **Desktop automation has a strict attempt budget.** Make one primary non-disruptive attempt. One evidence-based recovery is allowed only for a concrete transient condition such as a stale WebView handle or hot reload. If the target state is still missing, wrong, blank, or unreachable, stop immediately and ask the user to open the exact screen manually. Never loop coordinate guesses, repeatedly enumerate or click renderer handles, or navigate through speculative intermediate screens. After the user confirms that the target screen is open, perform exactly one read-only capture and do not manipulate it again unless the user explicitly asks.

22-C. **Escalate before disruption.** If verification truly requires focus changes, visible navigation, window-state changes, or foreground input, explain the exact action and ask for permission immediately before doing it. A failed stealth attempt does not grant permission to become disruptive.

## CODEBASE STRUCTURE

### Backend (Rust — `src-tauri/`)

| Path | Purpose |
|------|---------|
| `src/main.rs` | Tauri app entry point |
| `src/lib.rs` | Library root, module declarations |
| `src/provider.rs` | Provider metadata types (`ProviderMeta`, `ReasoningContentMode`) |
| `src/config.rs` | App config, provider settings schema |
| `src/settings.rs` | User settings (stream retry toggle, language, etc.) |
| `src/codex_config.rs` | Codex config file parsing/writing |
| `src/codex_desktop.rs` | CDP integration with Codex desktop app (model picker injection) |
| `src/codex_multirouter/` | Multi-router compiler, mutation, projection logic |
| `src/proxy/` | HTTP proxy server (axum) |
| `src/proxy/codex_traffic_policy.rs` | Codex admission + rejection retry policy (max in-flight, queue wait, 429/503 replay) |
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
- `CodexApiKeyGroup` — grouped API keys for different model tiers (Sublyx); backend logic in `proxy/providers/codex.rs`, type in `src/types.ts`
- `codex_traffic_policy` — admission control + rejection retry policy (backend: `proxy/codex_traffic_policy.rs`; frontend form helper: `codexTrafficPolicy.ts`)
- `LanguageSwitcher` — i18n language selection component


## ARCHITECTURE & CONVENTIONS

### Project Overview

**CCSwitchMulti** is a fork of cc-switch: a cross-platform Tauri 2 desktop app managing
configurations for AI coding CLIs (Claude Code, Codex, Gemini CLI, OpenCode, OpenClaw).
Fork-specific additions: **Codex MultiRouter** (multi-provider routing with verified
protocol profiles), **Sub-Agent V2** profile editor, **deep protocol probe** (backend-driven
Responses/Chat verification with stage events), **Codex traffic policy** (admission
control + rejection retry), **Sub-Agent V2 selection policy** (official_first /
third_party_first), **grouped API keys** (`CodexApiKeyGroup`), per-provider
**reasoning content mode**, and **full i18n** (en/zh/zh-TW/ja, **English default**).

### Architecture

```text
Frontend (React 18 + TS + Vite + Tailwind + shadcn/ui)
  Components → Hooks → TanStack Query v5
       │  src/lib/api/* (typed invoke wrappers — never call invoke in components)
       ▼ Tauri IPC (camelCase commands)
Backend (Rust, Tauri 2.8, rusqlite)
  src-tauri/src/commands/*   (thin #[tauri::command] layer)
       ▼
  src-tauri/src/services/*   (business logic: provider, proxy, skill, presets, sync)
       ▼
  src-tauri/src/database/dao/* → Mutex<Connection> (lock_conn!)
  + codex_multirouter/ (compiler, mutation, projection)
  + proxy/ (axum forwarder, provider adapters, traffic policy, streaming retry, usage)
  + protocol_compatibility/ (deep probe runner + selection)
  + codex_desktop.rs (CDP model-picker injection)
```

### Core Design Principles

- **SSOT** — SQLite at `~/.cc-switch/cc-switch.db` (schema v18) holds providers, MCP,
  prompts, skills, settings. Device UI prefs live in `~/.cc-switch/settings.json`.
- **Live-file sync** — switching writes the active provider into real CLI configs
  (`~/.codex/config.toml`, `~/.claude/settings.json`, …); editing the active provider
  backfills from the live file first.
- **Atomic writes** — temp file + rename, always, via the per-app writer modules.
- **Concurrency** — `Database` wraps the connection in a `Mutex`; use the `lock_conn!`
  macro (`database/mod.rs`). Never hold a DB lock across `.await`.
- **Layered backend** — `commands → services → dao`. Commands stay thin; DAOs own SQL.
- **Auto backups** — `~/.cc-switch/backups/` keeps rotated DB snapshots.

### Development Workflow

```bash
pnpm install               # deps
pnpm dev                   # tauri dev (hot reload)
pnpm dev:renderer          # Vite only, no Tauri shell
# Production/release builds are GitHub Actions-only (see rule 19).
pnpm typecheck             # tsc --noEmit (strict)
pnpm format:check          # prettier check
pnpm test:unit             # vitest run
cargo test --manifest-path src-tauri/Cargo.toml   # backend + integration tests
```

Verification scope and reporting are governed by rules 2, 8, 9, and 10. In practice:

- Frontend changes: direct tests, plausible consumer tests, then `pnpm typecheck`.
- Rust changes: direct tests, plausible consumer tests, then `cargo check`.
- Cross-layer contracts: verify both affected sides and the serialization or IPC boundary.
- Final boundary only: `cargo check`, full `cargo test`, `pnpm typecheck`, and full `pnpm test:unit`.

### Testing

- **Frontend**: vitest + jsdom + Testing Library. Tauri `invoke` is mocked via
  `tests/msw/tauriMocks.ts`; network via MSW; state resets in `tests/setupTests.ts`.
  Use `tests/utils/testQueryClient.ts` (retries/cache disabled) instead of the app client.
- **Backend**: integration tests in `src-tauri/tests/`; unit tests co-located in modules.
  The `test-hooks` cargo feature gates test-only instrumentation.

### Conventions

- **IPC**: command names camelCase on the JS side; Rust `#[tauri::command]` fns are
  snake_case behind the crate boundary. Payloads crossing IPC carry
  `#[serde(rename_all = "camelCase")]`. Never call `invoke` directly in components —
  add a typed wrapper in `src/lib/api/<domain>.ts` and re-export from `index.ts`.
- **Frontend**: `@/` alias → `src/`. Prefer TanStack Query hooks from `src/lib/query/`.
  Forms: react-hook-form + zod schemas in `src/lib/schemas/`. UI: shadcn primitives in
  `src/components/ui/`, icons from lucide-react, `cn()` from `@/lib/utils`.
- **Backend**: return `Result<T, AppError>`; no `unwrap()` outside tests; live-file IO
  only through the per-app writer modules; use `database::to_json_string` for DB JSON.
- **i18n**: FOUR locales — `en.json` (source of truth for keys, default language),
  `zh.json`, `zh-TW.json`, `ja.json`. Never hardcode user-visible strings; when adding,
  renaming, or removing a key, update **all four** files in the same commit.
- **New Tauri command checklist**: service logic → thin command in `commands/<domain>.rs`
  → register in `generate_handler!` (`lib.rs`) → typed wrapper in `lib/api/<domain>.ts`
  → DB schema change ⇒ bump `SCHEMA_VERSION` + migration in `database/schema.rs`.

### Things to Avoid

- Don't bypass the service/DAO layers; don't call `invoke` in components.
- Don't mutate live CLI config files outside the dedicated writer modules.
- Don't add IPC fields without `rename_all = "camelCase"`.
- Don't add an i18n key to only one locale file — CI won't catch it; users will.
- Follow production and release rules 18-22; do not restate or weaken them in local workflow notes.

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

### Additional Documentation

- [Retry Architecture](docs/architecture/retry-model.md) — Consolidated two-layer resilience model (proxy reconnect + Codex client retry)
- [Codex config schema troubleshooting](docs/guides/codex-config-schema-troubleshooting.md) — Fast diagnosis for `FeatureToml`/`features.guardianv2` resume failures, including backup-replay evidence and required writer boundaries.

### Codex Config Schema Incident Shortcut

When Codex reports `FeatureToml` in `features.guardianv2`, read
`docs/guides/codex-config-schema-troubleshooting.md` before changing the live
file. Check both `codex --version` and CCSwitch's `cc-switch.log`: a Codex
Desktop/CLI schema mismatch is the likely trigger, while repeated CCSwitch
`UncleanExit` plus `codex Live config restored from backup` lines explain why
the error recurs intermittently. Every CCSwitch write or restore of
`~/.codex/config.toml` must use
`codex_config::write_codex_live_config_atomic`; do not add a raw
`write_text_file` call for that file.

## AGENT MEMORY PROTOCOL

28. **Maintain `docs/memory/journal.md`** (newest first, dated entries) per the rules in `docs/memory/README.md`. Log only significant events: root causes of non-obvious bugs, deliberate design decisions + rationale, upstream cherry-pick/merge verdicts, release evidence.

29. **Entry format:** What happened → Root cause → What we did → Evidence (exact test/verification results) → What NOT to do again. Never rewrite old entries; corrections are new entries referencing the old one.

30. **Before reverting or "cleaning up" anything unusual, search `docs/memory/` first** — the oddity may be a deliberate, documented decision.

31. **Deep investigations** that exceed one entry go to `docs/memory/incidents/YYYY-MM-DD-<topic>.md`, linked from the journal entry.
