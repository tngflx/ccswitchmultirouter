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

6-C. **Summarize means manual coding-agent summarization; never use compaction for handoff.**
When the user requests “summarize”, “summarize + new session”, or passover, do not
call `thread/compact/start`, `/responses/compact`, native context compaction, or any
other compaction endpoint as the summarization mechanism. Interrupt the blocked source
turn only when necessary, wait for the source to become idle, then start one ordinary
coding-agent turn with tools and file mutation explicitly forbidden. Require that turn
to return a plain-text handoff summary containing the goal, decisions, changed areas,
current state, failures, tests, and next action. Only after that summary text is
successfully returned may the system create a fresh root session and pass the summary
into it. A missing, empty, failed, or ambiguous summary must stop the handoff and
must never fall back to compaction. Add a regression test that proves no compaction
method or compaction endpoint is called.

## ALWAYS RECHECK

7. **After ANY upstream merge:** grep for every function/field/import that our custom code depends on (`resolve_reasoning_content_mode`, `ReasoningContentMode`, `normalize_third_party_responses_reasoning_content_for_strict_schema`, `reasoning_content_mode` on ProviderMeta, LanguageSwitcher, etc.). Upstream may silently remove or rename them.

8. **After ANY cherry-pick:** run `cargo check` AND `pnpm typecheck` immediately. Then run the specific tests related to the changed files.

9. **Run the full frontend and backend test suites only at a final verification boundary:** when the user says the current feature/coding batch is finished, before pushing to origin, before a release, or before declaring a merge/cherry-pick batch ready for delivery. Do not infer that every assistant response is the end of the coding session. Do not push if any previously-passing test now fails.

10. **When reporting status:** list exactly what passed, what failed, and what was not tested. Never round up or omit failures.

10-A. **NEVER create a new Git branch, worktree, clone, or alternate checkout without
the user's explicit permission for that specific action.** A request to audit,
implement, fix, or test does NOT grant this permission. Work in the user's current
checkout and branch by default. Dirty files, concurrent tasks, build locks, and a
running app do NOT authorize creating another branch or worktree. Before editing or
starting broad verification, inspect `git status --short` and `git diff --name-only`.
Do not edit the same checkout concurrently unless the other task has explicitly
agreed to the overlap. If overlap prevents progress, coordinate or pause the
affected work and ask the user; do not create Git isolation as a workaround.
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
verification until they confirm the rebuild completed. For the normal development
app, ask the user to stop their existing `pnpm dev` process and restart `pnpm dev`
from the current checkout when needed. Do not kill their process, create a new
branch/worktree/checkout or alternate build target to bypass the blocker, or
present an older binary as evidence for the new source.

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

22-A. **Desktop UI inspection must not disturb the user's workspace.** Never call `SetForegroundWindow`, steal keyboard focus, move the user's cursor, send foreground keystrokes, or use foreground coordinate clicks unless the user explicitly permits that exact disruptive action. Background automation is allowed and encouraged: agents may inspect and navigate the live Tauri application page by page using UI Automation controls, CDP/DOM targets, window messages, or other semantic background mechanisms that do not activate the app or redirect user input. A localhost renderer in a separate browser is not the live Tauri window and must never be reported as such.

22-B. **Use evidence-driven background exploration, not blind clicking.** Agents may enumerate windows and renderer handles, inspect UI Automation trees, navigate through semantically identified tabs/buttons, and capture as many relevant pages as needed for a systematic audit, provided the app remains in the background and the user's cursor/focus are untouched. Retries are allowed for concrete transient conditions such as stale handles, hot reload, or a delayed WebView compositor. Never loop coordinate guesses, repeatedly invoke the same control without checking the resulting state, or navigate through unidentified controls. Keep a record of which page/state each capture represents.

22-C. **Background window-state changes are allowed when they remain non-activating.** For a hidden-to-tray window, agents may show it with no-activate APIs (for example `ShowWindow` with a non-activating mode or equivalent) and keep it behind the user's active window. For a minimized window, rule 22-E takes precedence: use UIA without restoring it. Do not move, resize, maximize, minimize, or foreground the window merely for inspection. Ask permission only when verification truly requires activation, foreground input, visible repositioning, or another action that could interrupt the user.

22-D. **Use the reusable capture helper as the first capture mechanism, not as an exploration limit.** For any live Tauri UI audit on Windows, start with:
    `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\capture-tauri-window.ps1`
    The helper locates the `cc-switch` process and renderer handle, captures the selected top-level window with read-only `PrintWindow` (`PW_RENDERFULLCONTENT`), and exits non-zero when the result is blank. `PrintWindow` success alone is not proof of page content; a hidden or minimized WebView2 compositor can return a uniform surface. For minimized windows, follow rule 22-E without restoring them; for hidden-to-tray windows, rule 22-C permits non-activating show plus semantic background automation. The helper itself does not restore/show windows, and its suggestion to ask the user is not a prohibition on these background fallbacks. Capture each audited page and verify its text/state through OCR, UI Automation, or DOM/CDP inspection; if only pixels were checked, say so. A blank capture means the window is not compositing, not that the page is empty.

22-E. **Background UI Automation fallback for minimized WebView2.** When the capture helper reports that a minimized `cc-switch.exe` has no visible candidate, do not restore or activate it. Bind the existing top-level window through `System.Windows.Automation.AutomationElement::FromHandle` using the returned `MainWindowHandle`, locate the WebView2 `RootWebArea` (`AutomationId=RootWebArea`), and read its descendant controls and text. Navigate only with semantic `InvokePattern` or `SelectionItemPattern` actions on safe page/navigation controls, reacquiring the root and descendants after every action. This works while the window remains minimized and does not move focus or the user's cursor. Record each page and state observed. Do not use coordinate clicks, guessed indexes, or invoke destructive controls during an audit.

22-F. **Live audit evidence (2026-09-23).** The minimized-window UIA path above was verified against `CCSwitchMulti` window handle `788824`: Settings General, Routing, Auth, Advanced, Usage Statistics, Skills, Prompts, Session Manager, and MCP Management were read without foregrounding. Opening Usage Statistics exposed and then, after the source fix, cleared a real `UsageTrendChart` hook-order crash. The root cause was a `useMemo` placed after the component's `isLoading` early return; hooks differed between loading and loaded renders. Keep all hooks before conditional returns and retain a regression test when changing this component.

## CODEBASE STRUCTURE

### Backend (Rust — `src-tauri/`)

| Path | Purpose |
|------|---------|
| `src-tauri/src/main.rs` | Tauri app entry point |
| `src-tauri/src/lib.rs` | Library root, module declarations |
| `src-tauri/src/provider.rs` | Provider metadata types (`ProviderMeta`); `ReasoningContentMode` lives in `src-tauri/src/proxy/providers/codex.rs` |
| `src-tauri/src/config.rs` | App config, provider settings schema |
| `src-tauri/src/settings.rs` | User settings (stream retry toggle, language, etc.) |
| `src-tauri/src/codex_config.rs` | Codex config file parsing/writing |
| `src-tauri/src/codex_desktop.rs` | CDP integration with Codex desktop app (model picker injection) |
| `src-tauri/src/codex_multirouter/` | Multi-router compiler, mutation, projection logic |
| `src-tauri/src/proxy/` | HTTP proxy server (axum) |
| `src-tauri/src/proxy/codex_traffic_policy.rs` | Codex admission + rejection retry policy (max in-flight, queue wait, 429/503 replay) |
| `src-tauri/src/proxy/forwarder.rs` | Request forwarding, retry, streaming |
| `src-tauri/src/proxy/provider_router.rs` | Provider selection and routing |
| `src-tauri/src/proxy/providers/` | Per-provider adapters (Claude, Codex, OpenAI-compatible) |
| `src-tauri/src/proxy/providers/streaming_retry.rs` | Stream retry on failure |
| `src-tauri/src/proxy/usage/` | Token usage parsing and logging |
| `src-tauri/src/resources/` | JS templates injected via CDP (model picker, app compat) |
| `src-tauri/src/commands/` | Tauri IPC command handlers |
| `src-tauri/src/services/` | Business logic (provider sync, proxy management, skills, presets) |
| `src-tauri/src/database/` | SQLite schema, migrations, backup |
| `src-tauri/src/store.rs` | Persistent state store |
| `src-tauri/tests/` | Rust integration tests |

### Frontend (TypeScript/React — `src/`)

| Path | Purpose |
|------|---------|
| `src/App.tsx` | Root component, routing |
| `src/components/codex/` | Codex-specific UI (router workspace, wizard, subagent editor, usage) |
| `src/components/providers/` | Provider list, cards, forms |
| `src/components/providers/forms/` | Provider form fields, reasoning editor, catalog sync, traffic policy |
| `src/components/settings/` | Settings page, language switcher, global config |
| `src/components/sessions/` | Session manager, history repair |
| `src/components/openai/` | OpenAI-compatible API page |
| `src/components/proxy/` | Proxy controls (stream retry toggle) |
| `src/config/` | Provider preset definitions (per-app: Claude, Codex, Gemini, etc.) |
| `src/i18n/` | Internationalization (index.ts + locales/en.json, zh.json, zh-TW.json, ja.json) |
| `src/icons/extracted/` | Provider icons (SVG/PNG + metadata) |
| `src/lib/schemas/` | Zod schemas for provider and settings validation |
| `src/lib/openai/` | External profile handling |
| `src/hooks/` | React hooks (provider actions, settings form) |
| `src/types.ts` | Shared TypeScript type definitions |

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

- **SSOT** — SQLite at `~/.cc-switch/cc-switch.db` (schema v19) holds providers, MCP,
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

- **IPC**: invoke command names match the registered Rust snake_case names
  (for example `get_providers`); JS wrapper methods and argument keys are camelCase.
  Structured payloads crossing IPC carry
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

26. **Before merging a reference repository, verify its remote URL, fetch, and list ALL incoming commits:** use `git remote -v` and `git log HEAD..<verified-remote>/<branch> --oneline`. Do not infer repository identity from the name `upstream`: in this checkout `bigstrongsun` points to `BigStrongSun/ccswitchmulti` and `upstream` points to `farion1231/cc-switch`; recheck before every sync.
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

27-A. **Before proposing or implementing a new feature or fix, audit both reference repositories for relevant work:** inspect the current `BigStrongSun/ccswitchmulti` upstream and the original `farion1231/cc-switch` repository, including recent commits, open/closed pull requests, and nearby implementation history. Treat them as reference material, not automatic authority: understand the problem, ownership boundary, behavioral tradeoffs, and tests on each side before deciding whether to port, adapt, reject, or defer the change. Record the reference-repo verdict when it materially affects the design.

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

## CHANGE AUTHORIZATION & DECISION RECORDS

32. **Investigation is read-only by default.** A request to audit logs, inspect
    commits, reaudit a document, or explain a failure does not authorize source,
    configuration, database, or user-data changes. A request to implement a
    named fix authorizes that stated fix only; do not infer approval for extra
    behavior, migrations, recovery actions, cleanup, or policy changes.

33. **Ask and wait before making an ambiguous behavioral decision.** Before editing code
    when more than one reasonable behavior satisfies the request, present the
    proposed behavior, affected boundary, alternatives, risks, and verification
    plan. Wait for explicit user approval of that scope before implementing it;
    silence, a progress update, or a prior broad approval is not consent for an
    expanded scope. Do not use urgency, an existing dirty tree, passing tests,
    or a model harness recommendation as implied approval.

34. **Record every substantive decision.** Create or update
    `docs/decisions/YYYY-MM-DD-<slug>.md` before implementing a non-trivial
    behavior change, including deliberate retain/reject/defer choices that
    materially affect the design. Record the goal, evidence, decision, alternatives,
    ownership boundary, affected files, approval status, and verification. Use
    the template in `docs/decisions/README.md`. Routine commands and mechanical
    formatting do not need separate records. Link related incidents and journal
    entries rather than duplicating them. Never include API keys, tokens, or raw
    private request bodies in these records.

35. **Keep approval, implementation, verification, and runtime freshness separate.**
    Use the independent fields and allowed values in `docs/decisions/README.md`;
    a single `verified` status must never conceal missing approval. Include the
    user's exact approval or the approving message reference when available.
    Tests, runtime observations, a journal entry, or another agent's recommendation
    are evidence, not approval. Append dated status transitions and corrections;
    preserve prior evidence, approval boundaries, and rejected alternatives.
    Never rewrite a record to make an unapproved decision appear approved.

36. **Journal the outcome, not the permission.** Add a concise newest-first
    entry to `docs/memory/journal.md` for significant incidents, rejected or
    superseded decisions, and verification evidence, linking the decision
    record. If an unapproved edit already exists, say so plainly, keep it
    uncommitted, and ask whether to retain, revise, or revert it; do not claim
    that application work is complete until the user decides. Inventory the
    affected files and decisions with approval `not-approved` and implementation
    `implemented`; do not invent approval from an earlier bug report. A request
    to update these instructions does not approve earlier application edits.
