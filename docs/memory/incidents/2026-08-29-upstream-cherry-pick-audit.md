# 2026-08-29 — Upstream cherry-pick audit (BigStrongSun/ccswitchmulti + farion1231/cc-switch)

## What happened

Full upstream-sync audit requested: list every incoming commit from `upstream`
(BigStrongSun/ccswitchmulti) and `original` (farion1231/cc-switch), plus GitHub PRs on
both repos, and classify each as cherry-pick / already-applied / ignore / defer.

- Audit base: `main@aee4ae47` (v3.19.2-20 line). `git fetch upstream --prune` +
  `git fetch original --prune` + `git fetch original pull/6908/head pull/6909/head`.
- Rule 26 satisfied: full `git log HEAD..{upstream,original}/main --oneline` reviewed,
  no filtering.

## Verdict table

### upstream (BigStrongSun) main — 13 incoming commits

| Commit | Subject | Verdict |
|---|---|---|
| `a7e87d1d`, `584a1834`, `1a3ccd1a`, `8b38cba4`, `23a3df8e`, `b5395d80` | Codex fixes | **Already ported** — trailers verified in our log (`c67d1623`, `1e70517e`, `a6fee714`, `801588a7`, `aa08c50d`, `522d6f05`) |
| `e470fff4`, `128aaf4d` | v3.19.2-18 release + memory | Ignore (their release line; ours diverged) |
| `ad3086ac`, `60850970`, `0dee0edd`, `8ce6cc99`, `92478954` | docs(memory) | Ignore (their journal, not ours) |

→ **Nothing new to take from BigStrongSun main.**

### upstream (BigStrongSun) feature branches

| Branch | Ahead | Verdict | Evidence |
|---|---|---|---|
| `bigstrongsun/fix-wizard-provider-subagent-ux` | 3 | **Contained** (0 unique non-merge commits) | `git log HEAD..branch --no-merges` empty |
| `bigstrongsun/ccsm-agent-mesh`, `fix-portable-third-party-reasoning`, `fix-qwen38-tool-loop-streaming-v30` | 0 | Contained | rev-list count 0 |
| `bigstrongsun/fix-responses-commentary-tool-calls` (tip `246a475f`) | 60* | **Already applied** — `attach_unique_pending_reasoning_to_assistant` exists at `transform_codex_chat.rs:1557/1698` | *count inflated by ancient shared history |
| `bigstrongsun/fix-unsupported-responses-tools` (tip `68c42605`) | 73* | **Already applied (adapted).** Our tree has the same fail-loudly guard — `unsupported_response_tools` tracked in `CodexToolContext` (`transform_codex_chat.rs:265/538-545`), rejected in the `…_text_only_and_cache` funnel (`:613-621`) that every conversion entry delegates to — WITH the fork adaptation upstream lacks: hosted `web_search` variants + `image_generation` are whitelisted (`:533-536`) instead of rejected. Verbatim cherry-pick would still have broken hosted tools. Pinned by `unsupported_responses_tool_type_fails_loudly_instead_of_being_dropped` (file_search → TransformError) + 27 hosted-tool tests green (2026-08-29). | diff reviewed + tests run |
| `bigstrongsun/fix-responses-lite-additional-tools` (`31d8a937`) | 2 | Ignore — superseded by our 2026-08-26 protocol rework (audit doc 2026-08-14) | journal + audit |
| `bigstrongsun/fix-v29-codex-force-repair` | 17 | Ignore — stale v3.19.0-29 release line, tip is docs(release) | tip subject |
| `bigstrongsun/subagent-v1-v2` (1), `subagent-v2-capability-injection` (22) | — | Ignore — docs/memory + academic courseware/design assets only (prior audit verdict) | journal 2026-08-14 |

### original (farion1231/cc-switch) main — 33 incoming since merge-base `43eaf073` (v3.19.2)

| Commit | Subject | Verdict |
|---|---|---|
| `4549d290` | grant `process:allow-exit` | **Already applied** — present in `src-tauri/capabilities/default.json:19` |
| `9a596158` | TeamoRouter → teamorouter.cn | **Already applied** — `.cn` primary + `.com` fallback present in 7/9 preset files (the misses are files we don't have or upstream didn't touch) |
| `6243e20a`, `bbe8bb93`, `c5e4f705`, `c911c7e3`, `270a4ff3`, `bd15ea11` | — | Already ported (journal 2026-08-27 mapping) |
| `926af949`, `0ae561b8`, `5ca9459d`, `c2ec78dd`, `97a7425f`, `cbb79127`, `9a1a6b83`, `43818101`, `bb54e87a`, `93bb91aa`, `798602c3`, `877df74f` | 0.149 migration chain / OAuth rewrite / WSL2 / Pi | Ignore — rejected by 2026-08-27 audit; symbol check confirms `normalize_codex_legacy_openai_reroute` etc. absent from our tree |
| `bcee61be` → `f8d97348` → `f05e2033` → `5ff199b5` + `092ea1f3` | **session-scan series** | **DEFERRED as a unit** — see below |
| `58687bd6` | reunite legacy-reroute doc comment | Ignore — documents functions absent from our tree |
| `0b5da510`, `18ca2da0`, `3217f725`, `9485cf2f`, `af31a87b` | release chores/notes | Ignore |

### original (farion1231) GitHub PRs

- **#6908 `mask_url` UTF-8 panic** — **PORTED 2026-08-29** (see below).
- **#6909 symlink test skip** — **Already applied**: our `codex_config.rs:15943` and
  `session_usage_grokbuild.rs:1220` already use the graceful `if let Err(error) = …
  symlink_dir` pattern.
- Reviewed, left open (feature-scale, need dedicated ports): #6950 configurable home
  page, #6859 usage trend series, #6519 Cursor app, #6878 Cherry Studio import, #6937
  Anthropic format for Claude models endpoint, #6934 Gemini thought signatures, #5644 ZCode.

## What we did

**One code fix ported: PR #6908 — `mask_url` multibyte panic.** Our
`src-tauri/src/proxy/http_client.rs` had the identical unguarded `&url[..20]` byte slice
(reachable from 7 call sites that mask unparseable proxy URLs in error messages → panic
on multibyte input). Applied the char-boundary fallback + regression test as a
working-tree edit (no commit — see coordination note).

- Evidence: `cargo test --lib mask_url` → **2 passed, 0 failed** (3,614 filtered);
  `pnpm typecheck` → clean (exit 0).

## Deferred: session-scan series (original `bcee61be` chain)

Dependency chain: `bcee61be` (byte-cursor scan; +700 lines across `session_usage*.rs` +
schema; **touches `session_usage_pi.rs` which our tree does not have**) → `f8d97348`
(tail-fingerprint rewrite detection; new `last_tail_fingerprint` column + migration) →
`f05e2033` → `5ff199b5`/`092ea1f3` (frontend pair; `092ea1f3` also blocked by dirty
i18n locales during this audit).

Our `session_log_sync` (our v7→v8 lineage; SCHEMA_VERSION 18) has **no**
`last_byte_offset`/`last_tail_fingerprint` — picking the later commits without the
foundation references columns that don't exist. Our importers were independently hardened
(single-flight lock, once-per-pass notify, blocking-thread parse). Porting = schema
migration v18→v19 in OUR numbering + manual reconciliation of ~700 diverged lines +
dropping Pi hunks. **Do not cherry-pick these shas directly.**

## Coordination note

During this audit two sessions were active: the release session
(`rerelease-english-docx-purge-2026-08-29`, legacy manifest, owns main-ref rewrite) and
the docs-policy session (landed `7354a3f1` mid-audit, released its lease afterward). A
first cherry-pick attempt (`4549d290`) was started and **aborted cleanly** when main moved
mid-pick; all ports were then applied as unstaged working-tree edits instead of commits.
Lease: `.codex-work/active/upstream-cherry-pick-audit-2026-08-29.json`.

## What NOT to do again

1. Do not cherry-pick `68c42605` verbatim — its guard has no hosted-tool whitelist; our
   adapted version (hosted `web_search`/`image_generation`) is already in the tree.
2. Do not cherry-pick the session-scan series out of order (`f8d97348`/`f05e2033`
   without `bcee61be`'s schema foundation).
3. Before picking a "new" upstream commit, grep our tree for its signature symbols AND
   test names — 5 of 8 candidates were already applied in some form. (The 68c42605
   adaptation was initially misclassified as unported because only impl symbols were
   grepped; the rejection test `unsupported_responses_tool_type_fails_loudly…` was found
   by searching behavior strings and test names.)
4. Branch "ahead" counts on BigStrongSun's fix-* branches are inflated by ancient shared
   cc-switch history; judge by the tip commit's diff, not the count.
5. Grep result truncation at 100 hits can hide decisive matches in large files
   (`transform_codex_chat.rs` is 6.7k+ lines); re-run with narrower patterns before
   concluding a symbol is absent.
